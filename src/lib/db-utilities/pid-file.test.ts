import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
} from "fs";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDevDBPidRecord,
  createRetryingMemo,
  serializeDevDBPidRecord,
  getLocalDevDBServerStatus,
  getProcessCommand,
  getProcessStartTime,
  getSystemBootTime,
  isProcessAlive,
  dataDirFromCommand,
  parseWindowsProcessInfo,
  readDevDBPidFile,
  readPostmasterPidFile,
  verifyPid,
  type DevDBStaleKind,
  type ProcessProbes,
} from "./pid-file";

let dir: string;
let pidFile: string;
let dataDir: string;
let spawned: ChildProcess[] = [];

/** A PID that is essentially certain not to be in use. */
const DEAD_PID = 999999;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "strataline-pid-"));
  pidFile = join(dir, ".pg_pid");
  dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  for (const child of spawned) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }

  spawned = [];
  removeWhenWindowsLetsGo(dir);
});

/**
 * Removes a directory, retrying while Windows still holds a handle in it.
 *
 * A killed process is not immediately a released handle there: the kernel
 * keeps the object until every reference goes, and a directory holding one
 * cannot be removed, so this fails with EPERM on exactly the tests that spawn
 * stand-ins. Waiting a moment and asking again is what makes it work, and
 * `force` does not cover it because the file is not absent, it is busy.
 *
 * Best effort, and deliberately silent at the end. This is teardown of a
 * temporary directory, and failing the test that just passed because the
 * operating system was slow to let go would report a problem that is not
 * there. The runner reclaims the directory either way.
 */
function removeWhenWindowsLetsGo(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });

      return;
    } catch {
      // Synchronous by necessity: this runs in an afterEach that other
      // teardown depends on having finished.
      const until = Date.now() + 100;

      while (Date.now() < until) {
        // Spin briefly rather than sleep, so the retry stays synchronous.
      }
    }
  }
}

/**
 * Starts a stand-in process that presents the same command line shape as a
 * real server (`postgres -D <dataDir>`), so identification can be exercised
 * without booting PostgreSQL.
 */
async function spawnFakePostgres(servingDir: string | null): Promise<number> {
  // The EXECUTABLE itself must be named postgres: identification reads the
  // first token of the command line, so a shebang script would not do — its
  // argv[0] is the interpreter — and copied system binaries will not run on
  // macOS, being code-signed. Copying the current runtime works everywhere and
  // gives the copy the name a real server would have.
  const executable = join(
    dir,
    process.platform === "win32" ? "postgres.exe" : "postgres",
  );
  const keepAlive = join(dir, "keepalive.js");

  copyFileSync(process.execPath, executable);

  if (process.platform !== "win32") {
    chmodSync(executable, 0o755);
  }

  writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

  // A null servingDir stands for a server inheriting PGDATA, whose command
  // line names no cluster and so cannot be identified from it.
  const dataDirArgs = servingDir === null ? [] : ["-D", servingDir];
  const child = spawn(executable, [keepAlive, ...dataDirArgs, "-p", "5433"], {
    stdio: "ignore",
  });

  spawned.push(child);

  // Give the exec a moment so the command line is readable.
  await new Promise((resolve) => setTimeout(resolve, 300));

  if (!child.pid) {
    throw new Error("failed to spawn stand-in process");
  }

  return child.pid;
}

describe("readDevDBPidFile", () => {
  test("returns null when the file is absent", async () => {
    expect(await readDevDBPidFile(pidFile)).toBeNull();
  });

  test("reads the structured format", async () => {
    writeFileSync(
      pidFile,
      JSON.stringify(buildDevDBPidRecord(4242, dataDir, 5433)),
    );

    const read = await readDevDBPidFile(pidFile);

    expect(read?.pid).toBe(4242);
    expect(read?.port).toBe(5433);
    expect(read?.startedAt).toBeGreaterThan(0);
  });

  test("does not write the format into the file", async () => {
    // The shape of the file already says which format it is, and readers
    // derive it from that. Writing it as a field too would put something on
    // disk that looks authoritative and is ignored on the way back in.
    const written = serializeDevDBPidRecord(
      buildDevDBPidRecord(4242, dataDir, 5433),
    );

    expect(JSON.parse(written)).not.toHaveProperty("format");

    writeFileSync(pidFile, written);

    const record = await readDevDBPidFile(pidFile);

    expect(record?.pid).toBe(4242);
    expect(record?.format).toBe("structured");
  });

  test("reports which on-disk format a record came from", async () => {
    // Grounded in the file's own shape, so nothing downstream has to infer it
    // from which fields happened to come back empty — a structured record can
    // be missing a start time too.
    writeFileSync(pidFile, "4242");
    expect((await readDevDBPidFile(pidFile))?.format).toBe("legacy");

    writeFileSync(
      pidFile,
      JSON.stringify({ pid: 4242, startedAt: 0, dataDir: "", port: 0 }),
    );
    expect((await readDevDBPidFile(pidFile))?.format).toBe("structured");
  });

  test("rejects a bare-integer file that is not wholly a number", async () => {
    // Nothing strataline writes reaches this branch any more, so whatever does
    // is either genuinely old or not ours at all — and it ends up as a signal
    // target. parseInt would take a prefix and call each of these a PID.
    for (const content of ["12abc", "42 43", "+42", "4.2"]) {
      writeFileSync(pidFile, content);

      expect(await readDevDBPidFile(pidFile)).toBeNull();
    }
  });

  test("cannot tell a truncated legacy record from a real one", async () => {
    // The limit of the above, stated so it is not mistaken for more than it
    // is: a half-written 4242 is a perfectly valid 42, and no parsing
    // distinguishes them. This is why a legacy record is never verified from
    // its own contents — identity comes from the live process instead.
    writeFileSync(pidFile, "42");

    const record = await readDevDBPidFile(pidFile);

    expect(record?.pid).toBe(42);
    expect(record?.format).toBe("legacy");
    // Carries nothing that could confirm or refute it.
    expect(record?.startedAt).toBe(0);
    expect(record?.bootTime).toBeNull();
    expect(record?.dataDir).toBe("");
  });

  test("still reads the legacy bare-integer format", async () => {
    writeFileSync(pidFile, "4242\n");

    const read = await readDevDBPidFile(pidFile);

    expect(read?.pid).toBe(4242);
    // Legacy records carry no metadata of their own.
    expect(read?.startedAt).toBe(0);
    expect(read?.bootTime).toBeNull();
    expect(read?.dataDir).toBe("");
  });

  test("returns null for unparseable content", async () => {
    writeFileSync(pidFile, "not a pid");

    expect(await readDevDBPidFile(pidFile)).toBeNull();
  });

  test("returns null for an empty file", async () => {
    writeFileSync(pidFile, "   \n");

    expect(await readDevDBPidFile(pidFile)).toBeNull();
  });
});

describe("a PID record's number must be usable as one", () => {
  test("rejects a non-positive PID in the structured format", async () => {
    // A negative number reaching process.kill names a process GROUP, not a
    // process. The legacy branch has always demanded a positive integer; the
    // structured one only checked that it was an integer.
    writeFileSync(pidFile, JSON.stringify({ pid: -1, dataDir, port: 5433 }));

    expect(await readDevDBPidFile(pidFile)).toBeNull();

    writeFileSync(pidFile, JSON.stringify({ pid: 0, dataDir, port: 5433 }));

    expect(await readDevDBPidFile(pidFile)).toBeNull();
  });

  test("reads a corrupt timestamp as unknown rather than as evidence", async () => {
    // The number is the only field that has to be refused outright, since a
    // record without one describes nothing. The rest are evidence, and evidence
    // that cannot be true is not the same as evidence against.
    writeFileSync(
      pidFile,
      JSON.stringify({ pid: 4242, startedAt: -1, bootTime: -1, uid: -1 }),
    );

    const record = await readDevDBPidFile(pidFile);

    expect(record?.pid).toBe(4242);
    expect(record?.startedAt).toBe(0);
    expect(record?.bootTime).toBeNull();
    expect(record?.uid).toBeNull();
  });

  test("does not let a corrupt boot time rule a live server out", async () => {
    // Read as written, a bootTime of -1 disagrees with this boot by more than
    // the tolerance, which is the decisive `recycled` that authorizes deleting
    // the record. A live process nothing else can identify has to stay
    // undecidable instead.
    const pid = await spawnFakePostgres(null);

    writeFileSync(
      pidFile,
      JSON.stringify({ pid, startedAt: -1, bootTime: -1, dataDir, port: 5433 }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("indeterminate");
    expect(status.indeterminate).toBe(true);
  });
});

describe("readPostmasterPidFile", () => {
  test("parses the documented line layout", async () => {
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [
        "73354",
        dataDir,
        "1787799588",
        "5433",
        "/tmp",
        "127.0.0.1",
        "321814218   1441792",
        "ready",
      ].join("\n"),
    );

    const record = await readPostmasterPidFile(dataDir);

    expect(record?.pid).toBe(73354);
    expect(record?.dataDir).toBe(dataDir);
    expect(record?.port).toBe(5433);
    // Line 3 is epoch seconds; we normalize to milliseconds.
    expect(record?.startedAt).toBe(1787799588 * 1000);
  });

  test("returns null when absent", async () => {
    expect(await readPostmasterPidFile(dataDir)).toBeNull();
  });

  test("rejects a PID line that is not wholly a number", async () => {
    // parseInt takes a prefix, so "73354abc" used to read as PID 73354, a
    // number nothing in the file actually vouches for, which then became a
    // verification subject and a signal target.
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      ["73354abc", dataDir, "1787799588", "5433"].join("\n"),
    );

    expect(await readPostmasterPidFile(dataDir)).toBeNull();
  });

  test("ignores a start time or port that is not wholly a number", async () => {
    // Same prefix problem, one field along. A start time invented from
    // "1787799588x" is evidence in the recycled/verified decision, so a
    // corrupt line has to read as absent rather than as a plausible number.
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      ["73354", dataDir, "1787799588x", "5433 "].join("\n"),
    );

    const record = await readPostmasterPidFile(dataDir);

    expect(record?.pid).toBe(73354);
    expect(record?.startedAt).toBe(0);
    // Surrounding whitespace is still fine; only trailing junk is not.
    expect(record?.port).toBe(5433);
  });

  test("rejects a non-positive PID line", async () => {
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      ["-1", dataDir, "1787799588", "5433"].join("\n"),
    );

    expect(await readPostmasterPidFile(dataDir)).toBeNull();
  });
});

describe("isProcessAlive", () => {
  test("is true for this process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("is false for a dead PID", () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });

  test("is false for nonsense input", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe("getProcessCommand", () => {
  test("reads the command line of a live process", async () => {
    const pid = await spawnFakePostgres(dataDir);
    const command = getProcessCommand(pid);

    expect(command).toContain("postgres");
    expect(command).toContain(dataDir);
  });

  test("returns null for a dead PID", () => {
    expect(getProcessCommand(DEAD_PID)).toBeNull();
  });
});

describe("verifyPid", () => {
  test("verifies a process serving this data directory", async () => {
    const pid = await spawnFakePostgres(dataDir);
    const result = verifyPid(pid, {
      startedAt: null,
      bootTime: null,
      dataDir,
    });

    // The command line alone is enough — no timestamps required.
    expect(result.verifiedBy).not.toBeNull();
    expect(result.kind).toBeNull();
  });

  test("rejects a dead PID as positively gone, not indeterminate", () => {
    const result = verifyPid(DEAD_PID, {
      startedAt: Date.now(),
      bootTime: getSystemBootTime(),
      dataDir,
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("process-gone");
  });

  test("rejects a live PID held by an unrelated program", () => {
    // This test process is demonstrably not a PostgreSQL server, so the number
    // has been reused. That is a decisive answer, not an indeterminate one.
    const result = verifyPid(process.pid, {
      startedAt: null,
      bootTime: null,
      dataDir,
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("recycled");
  });

  test("rejects a record from a previous boot", async () => {
    const bootTime = getSystemBootTime();

    // Skip where boot time is unavailable; the check cannot apply there.
    if (bootTime === null) {
      return;
    }

    // Naming no data directory, so identification falls through to the
    // boot-time check rather than being settled by the command line.
    const pid = await spawnFakePostgres(null);
    const result = verifyPid(pid, {
      startedAt: Date.now(),
      bootTime: bootTime - 86_400_000,
      dataDir,
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("recycled");
    expect(result.reason).toContain("previous boot");
  });

  test("rejects a live PID whose start time does not match the record", async () => {
    const pid = await spawnFakePostgres(null);
    const result = verifyPid(pid, {
      startedAt: Date.now() - 86_400_000,
      bootTime: getSystemBootTime(),
      dataDir,
    });

    expect(result.verifiedBy).toBeNull();
    // Positive evidence of a different process, so not merely indeterminate.
    expect(result.kind).toBe("recycled");
  });

  test("is indeterminate for a postgres process that cannot be tied to us", async () => {
    // A live PostgreSQL naming no data directory, with no metadata to check
    // against. We must not claim it is dead.
    const pid = await spawnFakePostgres(null);
    const result = verifyPid(pid, {
      startedAt: null,
      bootTime: null,
      dataDir,
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("indeterminate");
  });
});

describe("getLocalDevDBServerStatus", () => {
  test("reports not running when nothing is present", async () => {
    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.stale).toBe(false);
    expect(status.source).toBe("none");
    expect(status.pid).toBeNull();
    expect(status.staleKind).toBeNull();
    // An absent file is a definite answer, so destructive callers may proceed.
    expect(status.indeterminate).toBe(false);
  });

  test("treats an existing malformed PID file as indeterminate", async () => {
    writeFileSync(pidFile, "not a pid");

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.source).toBe("pid-file");
    expect(status.pid).toBeNull();
    expect(status.staleKind).toBe("indeterminate");
    expect(status.indeterminate).toBe(true);
    expect(status.reason).toContain("could not be read");
  });

  test("treats an existing malformed postmaster.pid as indeterminate", async () => {
    writeFileSync(join(dataDir, "postmaster.pid"), "partially written");

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.source).toBe("postmaster");
    expect(status.pid).toBeNull();
    expect(status.staleKind).toBe("indeterminate");
    expect(status.indeterminate).toBe(true);
    expect(status.reason).toContain("could not be read");
  });

  test("treats an inaccessible PID path as indeterminate", async () => {
    if (process.platform === "win32") {
      return;
    }

    writeFileSync(join(dataDir, "postmaster.pid"), "73354\n");
    chmodSync(dataDir, 0);

    try {
      const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

      expect(status.running).toBe(false);
      expect(status.source).toBe("postmaster");
      expect(status.pid).toBeNull();
      expect(status.staleKind).toBe("indeterminate");
      expect(status.indeterminate).toBe(true);
      expect(status.reason).toContain("inaccessible");
    } finally {
      chmodSync(dataDir, 0o755);
    }
  });

  test("reports running for a verified PID file", async () => {
    const pid = await spawnFakePostgres(dataDir);
    writeFileSync(
      pidFile,
      JSON.stringify(buildDevDBPidRecord(pid, dataDir, 5433)),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.source).toBe("pid-file");
    expect(status.pid).toBe(pid);
  });

  test("reports stale, not running, for a dead PID", async () => {
    writeFileSync(
      pidFile,
      JSON.stringify(buildDevDBPidRecord(DEAD_PID, dataDir, 5433)),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.pid).toBe(DEAD_PID);
    expect(status.staleKind).toBe("process-gone");
    expect(status.indeterminate).toBe(false);
  });

  test("reports stale for a live PID recorded on a previous boot", async () => {
    const bootTime = getSystemBootTime();

    if (bootTime === null) {
      return;
    }

    // The reboot case: the file survived, and the number now belongs to
    // somebody else. This must never be reported as running.
    //
    // Not `recycled` either, though, which is the stronger claim that the
    // record is safe to delete. Nothing here can tell a reboot from a clock
    // adjustment: the recorded boot time and the current one are both the
    // wall clock minus uptime, so a step moves the second and leaves the
    // first, and this process names no data directory to settle it either
    // way. See the test below for the version that does settle it.
    const pid = await spawnFakePostgres(null);
    writeFileSync(
      pidFile,
      JSON.stringify({
        ...buildDevDBPidRecord(pid, dataDir, 5433),
        bootTime: bootTime - 86_400_000,
      }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.staleKind).toBe("indeterminate");
    expect(status.indeterminate).toBe(true);
  });

  test("reports recycled when the number demonstrably changed hands", async () => {
    const bootTime = getSystemBootTime();

    if (bootTime === null) {
      return;
    }

    // The same reboot, with the live process saying enough about itself to
    // settle it: it serves another cluster, so it is not ours whatever the
    // clocks have been doing. Detection survives for every reboot where the
    // number is dead or its holder can be identified, which is all of them
    // bar the one above.
    const pid = await spawnFakePostgres(join(dir, "somebody-elses-cluster"));

    writeFileSync(
      pidFile,
      JSON.stringify({
        ...buildDevDBPidRecord(pid, dataDir, 5433),
        bootTime: bootTime - 86_400_000,
      }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("recycled");
    expect(status.indeterminate).toBe(false);
  });

  test("identifies a legacy bare-integer file by command line alone", async () => {
    // The old format carries no metadata, but the running process still names
    // the data directory, so this is decidable rather than indeterminate.
    const pid = await spawnFakePostgres(dataDir);
    writeFileSync(pidFile, String(pid));

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(true);
    expect(status.indeterminate).toBe(false);
  });

  test("a legacy file pointing at an unrelated program is decisively stale", async () => {
    writeFileSync(pidFile, String(process.pid));

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("recycled");
    expect(status.indeterminate).toBe(false);
  });

  test("a legacy file pointing at a dead PID is not indeterminate", async () => {
    writeFileSync(pidFile, String(DEAD_PID));

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("process-gone");
    expect(status.indeterminate).toBe(false);
  });

  test("an indeterminate PID file wins over a stale postmaster.pid", async () => {
    // The safe answer must survive the fallback, otherwise a destructive
    // caller would see the confident "process-gone" from postmaster.pid.
    const pid = await spawnFakePostgres(null);
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(DEAD_PID), dataDir, "1787799588", "5433"].join("\n"),
    );
    writeFileSync(pidFile, String(pid));

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.indeterminate).toBe(true);
    expect(status.source).toBe("pid-file");
  });

  test("an indeterminate postmaster.pid wins over another cluster's PID file", async () => {
    // The fallback describes a different (and dead) server, so it cannot settle
    // whether the live postmaster PID belongs to this cluster. Replacing the
    // indeterminate result would let cleanup delete postmaster.pid and start a
    // second server against a data directory that may already be in use.
    const livePid = 4242;
    const bootTime = 1_787_799_000_000;
    const probes: ProcessProbes = {
      isAlive: (pid) => pid === livePid,
      command: () => null,
      startTime: () => null,
      bootTime: () => bootTime,
      uid: () => null,
    };

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(livePid), dataDir, String(bootTime / 1000), "5433"].join("\n"),
    );
    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: DEAD_PID,
        startedAt: bootTime,
        dataDir: join(dir, "some-other-cluster"),
        port: 5599,
        bootTime,
      }),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes,
    });

    expect(status.indeterminate).toBe(true);
    expect(status.source).toBe("postmaster");
    expect(status.pid).toBe(livePid);
  });

  test("a verified PID file does not clear an indeterminate postmaster.pid", async () => {
    // Tempting to call the fallback the stronger evidence — it is positively
    // tied to this data directory and the primary is not tied to anything.
    // But the two records name DIFFERENT numbers, and verifying 4343 says
    // nothing whatever about 4242, which PostgreSQL's own record names as the
    // postmaster for this cluster and which is alive right now.
    //
    // Answering `running` would have cleanup stop the one it can see, delete
    // both records, and start a second server against a data directory 4242
    // may still be serving. An indeterminate primary is the ceiling for
    // everything the fallback can say.
    const unresolvedPid = 4242;
    const verifiedPid = 4343;
    const bootTime = 1_787_799_000_000;
    const probes: ProcessProbes = {
      isAlive: (pid) => pid === unresolvedPid || pid === verifiedPid,
      command: (pid) =>
        pid === verifiedPid ? `postgres -D "${dataDir}"` : null,
      startTime: () => null,
      bootTime: () => bootTime,
      uid: () => null,
    };

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(unresolvedPid), dataDir, String(bootTime / 1000), "5433"].join(
        "\n",
      ),
    );
    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: verifiedPid,
        startedAt: bootTime,
        dataDir,
        port: 5433,
        bootTime,
      }),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes,
    });

    expect(status.running).toBe(false);
    expect(status.indeterminate).toBe(true);
    expect(status.source).toBe("postmaster");
    expect(status.pid).toBe(unresolvedPid);
  });

  test("rejects a postmaster.pid belonging to a different cluster", async () => {
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [
        String(process.pid),
        "/some/other/cluster/data",
        String(Math.floor(Date.now() / 1000)),
        "5433",
      ].join("\n"),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.source).toBe("postmaster");
    expect(status.staleKind).toBe("different-cluster");
    expect(status.indeterminate).toBe(false);
    expect(status.reason).toContain("different data directory");
  });

  test("prefers a verified postmaster.pid for this cluster", async () => {
    const pid = await spawnFakePostgres(dataDir);
    const startTime = getProcessStartTime(pid);

    if (startTime === null) {
      return;
    }

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(pid), dataDir, String(Math.floor(startTime / 1000)), "5433"].join(
        "\n",
      ),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(true);
    expect(status.source).toBe("postmaster");
    expect(status.port).toBe(5433);
  });

  /**
   * A record from the real writer, with only the owner forced.
   *
   * Built rather than hand-written because the reachability of the owner check
   * depends on the other fields: a record carrying a start time takes a
   * different route through verifyPid than one without, and every record
   * strataline writes carries one. A literal invented here could describe a
   * shape readDevDBPidFile never produces, and then pass against a branch
   * nothing can reach.
   */
  const OWNER_BOOT = 1_787_799_000_000;

  const recordOwnedBy = (pid: number, uid: number | null): string =>
    JSON.stringify({
      ...buildDevDBPidRecord(pid, dataDir, 5433),
      uid,
      // Pinned alongside the probe below, so the boot check stays out of the
      // way. startedAt is left as the writer produced it, since that is the
      // field the owner check's reachability turns on.
      bootTime: OWNER_BOOT,
    });

  test("a different owner is disproof where nothing else could decide", async () => {
    // The case the owner check exists for: alive, but no readable command line
    // and no readable start time. That was indeterminate, which makes start()
    // refuse on every run until somebody removes the file by hand.
    writeFileSync(pidFile, recordOwnedBy(4242, 501));

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes: {
        isAlive: () => true,
        command: () => null,
        startTime: () => null,
        bootTime: () => OWNER_BOOT,
        uid: () => 1234,
      },
    });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("recycled");
    expect(status.indeterminate).toBe(false);
    expect(status.reason).toContain("uid 1234");
  });

  test("a matching owner verifies nothing on its own", async () => {
    // Every process a user runs shares their uid, so a match is not evidence.
    // If it could verify, any of that user's processes holding a recycled
    // number would authorize signaling it.
    writeFileSync(pidFile, recordOwnedBy(4242, 501));

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes: {
        isAlive: () => true,
        command: () => null,
        startTime: () => null,
        bootTime: () => OWNER_BOOT,
        uid: () => 501,
      },
    });

    expect(status.running).toBe(false);
    expect(status.indeterminate).toBe(true);
  });

  test("root is not read as a different owner", async () => {
    // Linux reports the owner of /proc/<pid> as root for any task it will not
    // describe, which is indistinguishable from one genuinely running as root.
    // Taken as proof it would mark a live postmaster of this cluster recycled,
    // and a recycled record has its postmaster.pid deleted.
    writeFileSync(pidFile, recordOwnedBy(4242, 501));

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes: {
        isAlive: () => true,
        command: () => null,
        startTime: () => null,
        bootTime: () => OWNER_BOOT,
        uid: () => 0,
      },
    });

    expect(status.staleKind).toBe("indeterminate");
  });

  test("leaves the check switched off where neither side has an owner", async () => {
    // Windows has no uid, and a legacy record carries none. Neither absence
    // may be read as a mismatch.
    writeFileSync(pidFile, recordOwnedBy(4242, null));

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes: {
        isAlive: () => true,
        command: () => null,
        startTime: () => null,
        bootTime: () => OWNER_BOOT,
        uid: () => 1234,
      },
    });

    expect(status.staleKind).toBe("indeterminate");
  });

  test("the writer records an owner on platforms that have one", () => {
    // Guards the other half: a check that cannot be reached and a record that
    // never carries the field both fail the same way, silently.
    const record = buildDevDBPidRecord(4242, dataDir, 5433);

    expect(record.uid).toBe(
      process.platform === "win32" ? null : (process.geteuid?.() ?? null),
    );
  });

  test("falls back to the PID file when postmaster.pid is stale", async () => {
    const pid = await spawnFakePostgres(dataDir);
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(DEAD_PID), dataDir, "1787799588", "5433"].join("\n"),
    );
    writeFileSync(
      pidFile,
      JSON.stringify(buildDevDBPidRecord(pid, dataDir, 5433)),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(true);
    expect(status.source).toBe("pid-file");
  });
});

/**
 * Builds a probe set describing a hypothetical platform's capabilities, so the
 * decision table can be exercised for any platform from any machine. A probe
 * returning null stands for a signal that platform cannot supply.
 */
function probesWith(overrides: Partial<ProcessProbes>): ProcessProbes {
  return {
    isAlive: () => true,
    command: () => null,
    startTime: () => null,
    bootTime: () => null,
    uid: () => null,
    ...overrides,
  };
}

describe("verification across platform capabilities", () => {
  const LIVE_PID = 4242;
  const NOW = 1_787_800_000_000;

  test("decides from the command line alone, as Windows and POSIX both can", () => {
    // This is the case that was broken on Windows: the probes existed on other
    // platforms but returned nothing there, so a running server was reported
    // as unidentifiable.
    const result = verifyPid(LIVE_PID, {
      startedAt: null,
      bootTime: null,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "/opt/pg/bin/postgres -D /srv/pgdata -p 5433",
      }),
    });

    expect(result.verifiedBy).not.toBeNull();
    expect(result.kind).toBeNull();
  });

  test("will not resolve another process's relative data directory", () => {
    // `-D pgdata` is relative to THAT process's working directory, which is
    // not readable from here. Resolving it against ours instead would verify a
    // PostgreSQL launched from a different directory that happens to use the
    // same relative path — and verifying is what authorizes stopping it.
    const result = verifyPid(LIVE_PID, {
      startedAt: null,
      bootTime: null,
      dataDir: `${process.cwd()}/pgdata`,
      probes: probesWith({
        command: () => "/opt/pg/bin/postgres -D pgdata -p 5433",
      }),
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("indeterminate");
    expect(result.reason).toContain("relative data directory");
  });

  test("a relative data directory is not disproof either", () => {
    // The other direction: unreadable is unreadable. A relative path that does
    // not look like ours must not be read as a different cluster and marked
    // recycled, because a recycled record has its postmaster.pid deleted.
    const result = verifyPid(LIVE_PID, {
      startedAt: null,
      bootTime: null,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "/opt/pg/bin/postgres -D ../elsewhere/data -p 5433",
      }),
    });

    expect(result.kind).toBe("indeterminate");
  });

  test("a command line naming this cluster outranks a different owner", () => {
    // Ordering matters more than it looks. A uid mismatch reaching the front
    // would call a PostgreSQL demonstrably serving this data directory
    // `recycled`, and a recycled record has its postmaster.pid deleted, which
    // is the interlock against a second postmaster on a live data directory.
    const result = verifyPid(LIVE_PID, {
      startedAt: null,
      bootTime: null,
      uid: 501,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "/opt/pg/bin/postgres -D /srv/pgdata",
        uid: () => 0,
      }),
    });

    expect(result.verifiedBy).not.toBeNull();
  });

  test("decides from timestamps when the command line is unavailable", () => {
    const result = verifyPid(LIVE_PID, {
      startedAt: NOW,
      bootTime: NOW - 3_600_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        startTime: () => NOW,
        bootTime: () => NOW - 3_600_000,
      }),
    });

    expect(result.verifiedBy).not.toBeNull();
  });

  test("does not splice one process's command onto another's start time", () => {
    let startReads = 0;
    const result = verifyPid(LIVE_PID, {
      startedAt: NOW,
      bootTime: NOW - 3_600_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "/opt/pg/bin/postgres -p 5433",
        startTime: () => (startReads++ === 0 ? NOW : NOW + 1000),
        bootTime: () => NOW - 3_600_000,
      }),
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("indeterminate");
    expect(result.startTime).toBeNull();
  });

  test("does not accept a changing PID from timestamps alone", () => {
    let startReads = 0;
    const result = verifyPid(LIVE_PID, {
      startedAt: NOW,
      bootTime: NOW - 3_600_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => null,
        startTime: () => (startReads++ === 0 ? NOW : NOW + 1000),
        bootTime: () => NOW - 3_600_000,
      }),
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("indeterminate");
    expect(result.startTime).toBeNull();
  });

  test("rejects an unrelated program even with no timestamps", () => {
    const result = verifyPid(LIVE_PID, {
      startedAt: null,
      bootTime: null,
      dataDir: "/srv/pgdata",
      probes: probesWith({ command: () => "nginx: master process" }),
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("recycled");
  });

  test("is indeterminate when a platform can supply no signal at all", () => {
    // The documented floor: with zero information about a live process we must
    // refuse to guess. Any supported platform reaching here is a bug — this is
    // what Windows did before its probes were implemented.
    const result = verifyPid(LIVE_PID, {
      startedAt: NOW,
      bootTime: null,
      dataDir: "/srv/pgdata",
      probes: probesWith({}),
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("indeterminate");
  });

  test("a dead PID is decisive regardless of platform capability", () => {
    const result = verifyPid(LIVE_PID, {
      startedAt: NOW,
      bootTime: null,
      dataDir: "/srv/pgdata",
      probes: probesWith({ isAlive: () => false }),
    });

    expect(result.kind).toBe("process-gone");
  });

  test("a previous boot is decisive even when the process looks like postgres", () => {
    const result = verifyPid(LIVE_PID, {
      startedAt: NOW,
      bootTime: NOW - 86_400_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "postgres -D /some/other/cluster",
        bootTime: () => NOW,
      }),
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("recycled");
  });
});

describe("connection tiebreaker", () => {
  const CONNECTION = {
    port: 5433,
    user: "dev",
    password: "dev",
    database: "dev",
  };

  /** Records whether the tiebreaker was reached at all. */
  function countingProbe(result: {
    dataDir: string | null;
    startedAt: number | null;
    responded: boolean;
    error: string | null;
  }) {
    let calls = 0;

    return {
      calls: () => calls,
      probe: async () => {
        calls++;

        return result;
      },
    };
  }

  test("is not consulted when the cheap checks already decided", async () => {
    // The whole point of a tiebreaker: no connection on the ordinary path.
    const pid = await spawnFakePostgres(dataDir);
    writeFileSync(
      pidFile,
      JSON.stringify(buildDevDBPidRecord(pid, dataDir, 5433)),
    );

    const probe = countingProbe({
      dataDir: null,
      startedAt: null,
      responded: false,
      error: null,
    });
    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: probe.probe,
    });

    expect(status.running).toBe(true);
    expect(probe.calls()).toBe(0);
  });

  test("is not consulted for a dead PID either", async () => {
    writeFileSync(
      pidFile,
      JSON.stringify(buildDevDBPidRecord(DEAD_PID, dataDir, 5433)),
    );

    const probe = countingProbe({
      dataDir: null,
      startedAt: null,
      responded: false,
      error: null,
    });

    await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: probe.probe,
    });

    expect(probe.calls()).toBe(0);
  });

  test("resolves an indeterminate PID when the server identifies itself", async () => {
    const pid = await spawnFakePostgres(null);
    writeFileSync(pidFile, String(pid));

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: async () => ({
        dataDir,
        startedAt: 1_787_800_000_000,
        responded: true,
        error: null,
      }),
    });

    expect(status.running).toBe(true);
    expect(status.indeterminate).toBe(false);
    expect(status.source).toBe("connection");
  });

  test("stays indeterminate when a different cluster answers on the port", async () => {
    // The probe identifies whatever is listening on the port, which is not
    // necessarily the process we could not identify. A foreign cluster
    // answering tells us nothing about our PID, so resolving to "safely
    // stale" here would license deleting this cluster's files while its
    // server may still be running.
    const pid = await spawnFakePostgres(null);
    writeFileSync(pidFile, String(pid));

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: async () => ({
        dataDir: "/somewhere/else",
        startedAt: null,
        responded: true,
        error: null,
      }),
    });

    expect(status.running).toBe(false);
    expect(status.indeterminate).toBe(true);
    expect(status.reason).toContain("different data directory");
  });

  test("names no PID when a foreign cluster answers and none was found", async () => {
    // An unreadable postmaster.pid yields an indeterminate result carrying no
    // PID at all. The reason ends up verbatim in the error start() throws, so
    // it must not tell the reader to go and deal with "PID null".
    writeFileSync(join(dataDir, "postmaster.pid"), "not a pid");

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: async () => ({
        dataDir: "/somewhere/else",
        startedAt: null,
        responded: true,
        error: null,
      }),
    });

    expect(status.pid).toBeNull();
    expect(status.reason).toContain("different data directory");
    expect(status.reason).not.toContain("PID null");
  });

  test("keeps the safe answer when the probe cannot identify anything", async () => {
    // A tiebreaker that fails must never downgrade the cautious answer.
    const pid = await spawnFakePostgres(null);
    writeFileSync(pidFile, String(pid));

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: async () => ({
        dataDir: null,
        startedAt: null,
        responded: false,
        error: "ECONNREFUSED",
      }),
    });

    expect(status.indeterminate).toBe(true);
    expect(status.reason).toContain("nothing answered on port 5433");
  });

  test("is skipped entirely when no connection details are given", async () => {
    const pid = await spawnFakePostgres(null);
    writeFileSync(pidFile, String(pid));

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.indeterminate).toBe(true);
  });
});

describe("remembering only settled answers", () => {
  // What the boot-time probe is memoized through. A reading, and a platform
  // with no probe at all, both settle for the life of the process; a probe
  // that merely failed does not.
  const probeReturning = (
    ...results: Array<{ value: number | null; cacheable: boolean }>
  ) => {
    let calls = 0;

    return {
      calls: () => calls,
      probe: () => results[Math.min(calls++, results.length - 1)],
    };
  };

  test("retries a failed probe rather than remembering the failure", () => {
    // The regression this guards: one unreadable /proc/stat, or one
    // PowerShell that would not spawn, used to disable the boot check for the
    // life of the process — and with it the one signal that catches a record
    // surviving a restart.
    const probe = probeReturning(
      { value: null, cacheable: false },
      { value: 1_787_547_616_000, cacheable: true },
    );
    const memo = createRetryingMemo(probe.probe);

    expect(memo.get()).toBeNull();
    expect(memo.get()).toBe(1_787_547_616_000);
    expect(probe.calls()).toBe(2);
  });

  test("stops probing once an answer settles", () => {
    const probe = probeReturning({ value: 1_787_547_616_000, cacheable: true });
    const memo = createRetryingMemo(probe.probe);

    expect(memo.get()).toBe(1_787_547_616_000);
    expect(memo.get()).toBe(1_787_547_616_000);
    expect(probe.calls()).toBe(1);
  });

  test("a settled null is still settled", () => {
    // An unsupported platform will not start having a probe later, so this
    // one must NOT be retried — otherwise every check pays for it again.
    const probe = probeReturning({ value: null, cacheable: true });
    const memo = createRetryingMemo(probe.probe);

    expect(memo.get()).toBeNull();
    expect(memo.get()).toBeNull();
    expect(probe.calls()).toBe(1);
  });

  test("a seeded answer is used instead of probing", () => {
    // How the Windows round trip pays for itself: it already learned the boot
    // time while asking about a process, so nothing needs to spawn again.
    const probe = probeReturning({ value: 999, cacheable: true });
    const memo = createRetryingMemo(probe.probe);

    memo.seed(1_787_547_616_000);

    expect(memo.get()).toBe(1_787_547_616_000);
    expect(probe.calls()).toBe(0);
  });

  test("a seed does not displace an answer already settled", () => {
    const probe = probeReturning({ value: 1_787_547_616_000, cacheable: true });
    const memo = createRetryingMemo(probe.probe);

    expect(memo.get()).toBe(1_787_547_616_000);

    memo.seed(1);

    expect(memo.get()).toBe(1_787_547_616_000);
  });

  test("a seed still lands after a failed probe", () => {
    // The failure settled nothing, so a value learned elsewhere is welcome.
    const probe = probeReturning({ value: null, cacheable: false });
    const memo = createRetryingMemo(probe.probe);

    expect(memo.get()).toBeNull();

    memo.seed(1_787_547_616_000);

    expect(memo.get()).toBe(1_787_547_616_000);
    expect(probe.calls()).toBe(1);
  });
});

describe("the Windows metadata query's output", () => {
  // The query returns three labeled fields in one round trip. Only Windows
  // runs it, but the parse is checked everywhere: a field the host cannot
  // supply must not shift the ones after it.
  const BOOT = "2026-08-23T23:00:16.0000000Z";
  const CREATED = "2026-08-27T09:14:02.0000000Z";

  test("reads all three fields when the host supplies them", () => {
    const info = parseWindowsProcessInfo(
      `B=${BOOT}\r\nP=${CREATED}\r\nC="C:\\pg\\bin\\postgres.exe" -D "C:\\pgdata"`,
    );

    expect(info.bootTime).toBe(Date.parse(BOOT));
    expect(info.startTime).toBe(Date.parse(CREATED));
    expect(info.command).toBe('"C:\\pg\\bin\\postgres.exe" -D "C:\\pgdata"');
  });

  test("a missing boot time does not shift the process fields", () => {
    // The label itself goes missing only if the boot-time statement fails
    // outright — a null LastBootUpTime whose ToUniversalTime() throws. An
    // empty Win32_OperatingSystem keeps the label and is the next test. Either
    // way the fields after it must not move: reading by line position would
    // take the creation date as the boot time, the record's real boot time
    // would then look like a previous boot, and a live server would be
    // reported as `recycled` — its PID files deleted and a second postmaster
    // started against the same data directory.
    const info = parseWindowsProcessInfo(
      `P=${CREATED}\r\nC="C:\\pg\\bin\\postgres.exe" -D "C:\\pgdata"`,
    );

    expect(info.bootTime).toBeNull();
    expect(info.startTime).toBe(Date.parse(CREATED));
    expect(info.command).toBe('"C:\\pg\\bin\\postgres.exe" -D "C:\\pgdata"');
  });

  test("keeps the boot time when the process is gone", () => {
    // The labels are emitted with empty values rather than omitted, which is
    // what keeps the surviving field findable.
    const info = parseWindowsProcessInfo(`B=${BOOT}\r\nP=\r\nC=`);

    expect(info.bootTime).toBe(Date.parse(BOOT));
    expect(info.startTime).toBeNull();
    expect(info.command).toBeNull();
  });

  test("takes the command line whole, labels inside it included", () => {
    // It is the last field precisely because it is free-form, so everything
    // from its label onwards belongs to it.
    const info = parseWindowsProcessInfo(
      `B=${BOOT}\r\nP=${CREATED}\r\nC=postgres -D "C:\\B=P=C=" -p 5433`,
    );

    expect(info.command).toBe('postgres -D "C:\\B=P=C=" -p 5433');
    expect(info.bootTime).toBe(Date.parse(BOOT));
  });

  test("keeps a command line that spans more than one line", () => {
    // What being the last field buys: everything from the label onwards is the
    // value, so a newline inside it needs no delimiter and loses nothing.
    const info = parseWindowsProcessInfo(
      `B=${BOOT}\r\nP=${CREATED}\r\nC=postgres -D "C:\\odd\nname"`,
    );

    expect(info.command).toBe('postgres -D "C:\\odd\nname"');
    expect(info.startTime).toBe(Date.parse(CREATED));
  });

  test("reports nothing when the query itself failed", () => {
    for (const out of [null, ""]) {
      const info = parseWindowsProcessInfo(out);

      expect(info.bootTime).toBeNull();
      expect(info.startTime).toBeNull();
      expect(info.command).toBeNull();
    }
  });

  test("ignores an unparseable timestamp rather than guessing", () => {
    const info = parseWindowsProcessInfo("B=not a date\r\nP=\r\nC=");

    expect(info.bootTime).toBeNull();
  });
});

describe("probes on the platform actually being tested", () => {
  // This is the test that would have caught the Windows defect. It makes no
  // assumption about which platform it runs on: a supported platform must be
  // able to answer all three questions about a live process, and any platform
  // that cannot will report every running server as unidentifiable.
  test("supply a command line, a start time, and a boot time", async () => {
    const pid = await spawnFakePostgres(dataDir);

    expect(getProcessCommand(pid)).toContain("postgres");
    expect(getProcessStartTime(pid)).toBeGreaterThan(0);
    expect(getSystemBootTime()).toBeGreaterThan(0);
  });

  // A start time is only evidence if it is on the same clock as the record it
  // is compared against. macOS reports one as a zone-less local timestamp, so
  // a reader that resolved it against a different zone than `ps` printed it in
  // would return a number that is wrong rather than merely missing — and
  // verifyPid reads a wrong start time as a live server whose number has been
  // reused, which authorizes deleting its postmaster.pid.
  //
  // This asserts the property rather than the parse, so it holds whatever the
  // platform reports: a process spawned moments ago started moments ago. It
  // fails by the size of the host's UTC offset, so it says nothing on a UTC
  // machine and everything on any other, `bun test` included — that forces the
  // JS timezone to UTC without touching the environment `ps` inherits.
  test("report a start time on the same clock as a record", async () => {
    const pid = await spawnFakePostgres(dataDir);
    const startTime = getProcessStartTime(pid);

    if (startTime === null) {
      return;
    }

    expect(Math.abs(startTime - Date.now())).toBeLessThan(60_000);
  });

  // The other half of the same reading. `ps` renders the start time through
  // strftime %c, which is the caller's locale: a French one prints "Lun 31 aoû
  // 20:33:11 2026", which parses to nothing at all. A start time that is
  // silently unavailable is not a wrong answer, but it is not a harmless one
  // either, since every decision resting on it goes indeterminate and start()
  // refuses over the caller's own healthy server.
  //
  // Run in a child process rather than by setting the variable here, because a
  // locale is inherited at startup: assigning process.env.LC_ALL mid-run does
  // not reach anything this process spawns afterwards, so the in-process
  // version of this test cannot fail and would assert nothing.
  test("read a start time whatever locale the caller is running in", async () => {
    const pid = await spawnFakePostgres(dataDir);
    const probeScript = join(dir, "probe-start-time.ts");
    const modulePath = new URL("./pid-file.ts", import.meta.url).pathname;

    writeFileSync(
      probeScript,
      `import { getProcessStartTime } from ${JSON.stringify(modulePath)};\n` +
        "console.log(getProcessStartTime(Number(process.argv[2])));\n",
    );

    const out = execFileSync(
      process.execPath,
      ["run", probeScript, String(pid)],
      {
        encoding: "utf8",
        // A host without this locale falls back to C and the reading succeeds
        // for the uninteresting reason, which is the right way round: the
        // claim is that the caller's locale cannot break it.
        env: { ...process.env, LC_ALL: "fr_FR.UTF-8" },
      },
    ).trim();

    expect(Number(out)).toBeGreaterThan(0);
  });

  test("identify a live server end to end on this platform", async () => {
    // The same claim expressed as the answer a consumer actually sees.
    const pid = await spawnFakePostgres(dataDir);
    writeFileSync(pidFile, String(pid));

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(true);
    expect(status.indeterminate).toBe(false);
  });
});

describe("data directory argument parsing", () => {
  test("reads the value from each accepted spelling", () => {
    expect(dataDirFromCommand("postgres -D /srv/pgdata -p 5433")).toBe(
      "/srv/pgdata",
    );
    expect(dataDirFromCommand("postgres --data-directory /srv/pgdata")).toBe(
      "/srv/pgdata",
    );
    expect(dataDirFromCommand("postgres --data-directory=/srv/pgdata")).toBe(
      "/srv/pgdata",
    );
    expect(dataDirFromCommand("postgres -D/srv/pgdata")).toBe("/srv/pgdata");
  });

  test("keeps quoted paths containing spaces intact", () => {
    expect(
      dataDirFromCommand(
        '"C:\\Program Files\\pg\\postgres.exe" -D "C:\\My Data\\pg"',
      ),
    ).toBe("C:\\My Data\\pg");
  });

  test("returns null when no data directory is given", () => {
    // A server inheriting PGDATA names no directory, which must not be
    // mistaken for naming ours.
    expect(dataDirFromCommand("postgres -p 5433")).toBeNull();
  });
});

describe("identity must be exact, not approximate", () => {
  const NOW = 1_787_800_000_000;

  test("a neighboring cluster with a prefix path is not us", () => {
    // "/srv/pgdata" is a substring of "/srv/pgdata-backup". A substring test
    // would verify this and license terminating somebody else's server.
    const result = verifyPid(4242, {
      startedAt: null,
      bootTime: null,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "postgres -D /srv/pgdata-backup -p 5433",
      }),
    });

    expect(result.verifiedBy).toBeNull();
    // The command line states which cluster it serves, so this is decisive.
    expect(result.kind).toBe("recycled");
  });

  test("a matching boot time alone does not verify a PID", () => {
    // The record was written this boot, but PIDs are recycled within a boot
    // too. Nothing here ties this process to the recorded one.
    const result = verifyPid(4242, {
      startedAt: null,
      bootTime: NOW - 3_600_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({ bootTime: () => NOW - 3_600_000 }),
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("indeterminate");
  });

  test("a matching start time still verifies", () => {
    // The check that was removed must not take the working one with it.
    const result = verifyPid(4242, {
      startedAt: NOW,
      bootTime: NOW - 3_600_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        startTime: () => NOW,
        bootTime: () => NOW - 3_600_000,
      }),
    });

    expect(result.verifiedBy).not.toBeNull();
  });
});

describe("binding a PID to a connection-confirmed server", () => {
  const CONNECTION = {
    port: 5433,
    user: "dev",
    password: "dev",
    database: "dev",
  };

  test("takes the PID from this cluster's own postmaster.pid", async () => {
    const pid = await spawnFakePostgres(null);
    const startTime = getProcessStartTime(pid);

    if (startTime === null) {
      return;
    }

    writeFileSync(pidFile, String(pid));
    // A start time on line 3 that does not match, so the cheap checks cannot
    // settle this and the connection tiebreaker is what decides.
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(pid), dataDir, "1787799588", "5433"].join("\n"),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: async () => ({
        dataDir,
        startedAt: startTime,
        responded: true,
        error: null,
      }),
    });

    expect(status.running).toBe(true);
    // postmaster.pid is written by the server the connection just confirmed,
    // and this PID's start time matches what that server reported.
    expect(status.pid).toBe(pid);
  });

  test("does not bind a postmaster.pid PID that cannot be tied to the server", async () => {
    // postmaster.pid is not exempt from the start-time bar. The cheap checks
    // may already have ruled its PID out as recycled — as here, where nothing
    // is alive at it — and taking it on trust would report a PID that is known
    // NOT to be the confirmed server, authorizing terminating whatever holds
    // that number next.
    const pid = await spawnFakePostgres(null);

    writeFileSync(pidFile, String(pid));
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(DEAD_PID), dataDir, "1787799588", "5433"].join("\n"),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: async () => ({
        dataDir,
        // Nowhere near when the live recorded process actually started, so
        // neither candidate clears the bar.
        startedAt: 1_600_000_000_000,
        responded: true,
        error: null,
      }),
    });

    expect(status.running).toBe(true);
    expect(status.pid).toBeNull();
  });

  test("reports no PID when the unidentified one cannot be bound", async () => {
    // The connection proves the CLUSTER is live, not that this PID belongs to
    // it. Reporting the PID anyway would authorize terminating an unrelated
    // process, so it must come back null instead.
    const pid = await spawnFakePostgres(null);
    writeFileSync(pidFile, String(pid));

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: async () => ({
        dataDir,
        // Nowhere near when the live process actually started.
        startedAt: 1_600_000_000_000,
        responded: true,
        error: null,
      }),
    });

    expect(status.running).toBe(true);
    expect(status.pid).toBeNull();
  });

  describe("a timestamp coincidence is not identity", () => {
    // These use injected probes because the hazard is a platform that cannot
    // read a command line: on macOS and Linux an unrelated process is ruled
    // out as `recycled` before the tiebreaker ever runs, so the dangerous
    // combination only exists where identity evidence is missing.
    const LIVE_PID = 4242;
    const SERVER_STARTED_AT = 1_787_800_000_000;

    const statusWith = (probes: ProcessProbes) => {
      writeFileSync(pidFile, String(LIVE_PID));

      return getLocalDevDBServerStatus({
        pidFile,
        dataDir,
        probes,
        connection: CONNECTION,
        connectionProbe: async () => ({
          dataDir,
          startedAt: SERVER_STARTED_AT,
          responded: true,
          error: null,
        }),
      });
    };

    test("refuses to bind a PID whose command line cannot be read", async () => {
      // The start time is a perfect match, and that is deliberately not
      // enough. Nothing here says this process is a PostgreSQL server at all,
      // so reporting the PID would authorize terminating whatever it is.
      const status = await statusWith(
        probesWith({
          command: () => null,
          startTime: () => SERVER_STARTED_AT,
        }),
      );

      expect(status.running).toBe(true);
      expect(status.pid).toBeNull();
    });

    test("refuses to bind a process that started after the server did", async () => {
      // The postmaster already exists when it records its start time, so a
      // genuine match never starts meaningfully after it. A PID recycled 45
      // seconds later always does — and a symmetric window would accept it.
      const status = await statusWith(
        probesWith({
          command: () => "/opt/pg/bin/postgres -p 5433",
          startTime: () => SERVER_STARTED_AT + 45_000,
        }),
      );

      expect(status.running).toBe(true);
      expect(status.pid).toBeNull();
    });

    test("still binds a PostgreSQL that started just before the server did", async () => {
      // The legitimate direction: the process exists first, then the server
      // records the time. Tightening the window must not lose this, and the
      // gap here is what probe precision alone can account for — `ps` reports
      // whole seconds, and /proc's boot time is rounded to them.
      const status = await statusWith(
        probesWith({
          command: () => "/opt/pg/bin/postgres -p 5433",
          startTime: () => SERVER_STARTED_AT - 3000,
        }),
      );

      expect(status.running).toBe(true);
      expect(status.pid).toBe(LIVE_PID);
    });

    test("refuses to bind a PostgreSQL that predates the server by too much", async () => {
      // `pg_postmaster_start_time()` is when the postmaster itself started,
      // not when we asked, so a real match is off by probe precision and no
      // more. Half a minute earlier is a different server — and one whose
      // command line omits `-D` has nothing else ruling it out.
      const status = await statusWith(
        probesWith({
          command: () => "/opt/pg/bin/postgres -p 5433",
          startTime: () => SERVER_STARTED_AT - 30_000,
        }),
      );

      expect(status.running).toBe(true);
      expect(status.pid).toBeNull();
    });

    test("refuses to bind observations spliced across PID reuse", async () => {
      let commandReads = 0;
      const status = await statusWith(
        probesWith({
          command: () => {
            commandReads++;
            return "/opt/pg/bin/postgres -p 5433";
          },
          startTime: () =>
            commandReads < 2 ? SERVER_STARTED_AT : SERVER_STARTED_AT + 1000,
        }),
      );

      expect(status.running).toBe(true);
      expect(status.pid).toBeNull();
      expect(status.observedStartTime).toBeNull();
    });

    test("does not retry one unstable PID from duplicate records", async () => {
      writeFileSync(
        join(dataDir, "postmaster.pid"),
        [String(LIVE_PID), dataDir, "0", "5433"].join("\n"),
      );

      // Both records name the same number, so the binder gets one candidate
      // and must take exactly one bracket around it. The clock is rigged to
      // move inside that bracket and to hold still afterwards: a retry would
      // read a stable pair and bind, which is the failure being guarded
      // against. The read count is asserted rather than assumed, so this stays
      // honest if the number of probes elsewhere changes.
      let startReads = 0;
      const status = await statusWith(
        probesWith({
          command: () => "/opt/pg/bin/postgres -p 5433",
          startTime: () =>
            ++startReads <= 1 ? SERVER_STARTED_AT - 1000 : SERVER_STARTED_AT,
        }),
      );

      expect(startReads).toBe(2);
      expect(status.running).toBe(true);
      expect(status.pid).toBeNull();
      expect(status.observedStartTime).toBeNull();
    });
  });

  describe("a command line naming another cluster is disproof", () => {
    // The candidates offered to the binder are this cluster's postmaster.pid
    // and the recorded PID, and postmaster.pid is tried first. Its PID may
    // never have been weighed against a command line — the cheap checks can
    // rule it out and fall through to strataline's own file — so the binder
    // has to do it. A start time landing inside the tolerance window must not
    // override a process that says outright which cluster it serves.
    const OTHER_PID = 500;
    const RECORDED_PID = 4242;
    const SERVER_STARTED_AT = 1_787_800_000_000;

    /** Probes answering per PID, so two candidates can differ. */
    const probesFor = (
      commands: Record<number, string | null>,
    ): ProcessProbes =>
      probesWith({
        command: (pid) => commands[pid] ?? null,
        startTime: () => SERVER_STARTED_AT,
      });

    const statusWithCandidates = (commands: Record<number, string | null>) => {
      writeFileSync(pidFile, String(RECORDED_PID));
      // A start time of 0 on line 3, so the cheap checks have only the command
      // line to go on and the tiebreaker is what decides.
      writeFileSync(
        join(dataDir, "postmaster.pid"),
        [String(OTHER_PID), dataDir, "0", "5433"].join("\n"),
      );

      return getLocalDevDBServerStatus({
        pidFile,
        dataDir,
        probes: probesFor(commands),
        connection: CONNECTION,
        connectionProbe: async () => ({
          dataDir,
          startedAt: SERVER_STARTED_AT,
          responded: true,
          error: null,
        }),
      });
    };

    test("skips the candidate serving another cluster for one that fits", async () => {
      const status = await statusWithCandidates({
        // Tried first, and a perfect start-time match — but it says it is
        // serving somebody else, so binding it would authorize terminating
        // another cluster's postmaster.
        [OTHER_PID]: "/opt/pg/bin/postgres -D /srv/other -p 5433",
        // Names no cluster, so nothing rules it out and the clock can decide.
        [RECORDED_PID]: "/opt/pg/bin/postgres -p 5433",
      });

      expect(status.running).toBe(true);
      expect(status.pid).toBe(RECORDED_PID);
    });

    test("binds nothing when every candidate is ruled out", async () => {
      const status = await statusWithCandidates({
        [OTHER_PID]: "/opt/pg/bin/postgres -D /srv/other -p 5433",
        // Unreadable, so this one cannot be bound either.
        [RECORDED_PID]: null,
      });

      // The cluster is live; no PID here is safe to signal.
      expect(status.running).toBe(true);
      expect(status.pid).toBeNull();
      expect(status.observedStartTime).toBeNull();
    });

    test("a path that may have been cut at a space is not disproof", async () => {
      // A flat command line splits "/tmp/my db" into "/tmp/my", which only
      // looks like another cluster. Rejecting on that would lose the PID of a
      // server that is genuinely ours, so it falls through to the clock.
      const spacedDataDir = join(dir, "my data");

      mkdirSync(spacedDataDir, { recursive: true });
      writeFileSync(pidFile, String(RECORDED_PID));

      const status = await getLocalDevDBServerStatus({
        pidFile,
        dataDir: spacedDataDir,
        probes: probesFor({
          [RECORDED_PID]: `/opt/pg/bin/postgres -D ${spacedDataDir}`,
        }),
        connection: CONNECTION,
        connectionProbe: async () => ({
          dataDir: spacedDataDir,
          startedAt: SERVER_STARTED_AT,
          responded: true,
          error: null,
        }),
      });

      expect(status.running).toBe(true);
      expect(status.pid).toBe(RECORDED_PID);
    });
  });

  test("keeps the PID when its start time matches the confirmed server", async () => {
    const pid = await spawnFakePostgres(null);
    const startTime = getProcessStartTime(pid);

    if (startTime === null) {
      return;
    }

    writeFileSync(pidFile, String(pid));

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      connection: CONNECTION,
      connectionProbe: async () => ({
        dataDir,
        startedAt: startTime,
        responded: true,
        error: null,
      }),
    });

    expect(status.running).toBe(true);
    expect(status.pid).toBe(pid);
  });
});

describe("a stale postmaster.pid beside another cluster's record", () => {
  test("keeps the different-cluster answer rather than the stale one", async () => {
    // One pidFile path shared across two data directories, and this cluster's
    // own postmaster.pid left behind by a killed server. The fallback is the
    // only thing that knows the PID file describes somebody else's cluster —
    // if it is dropped for not being running or indeterminate, the caller sees
    // the stale postmaster result alone and deletes a record it was never told
    // belonged to a live server elsewhere.
    const pid = await spawnFakePostgres(null);

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(DEAD_PID), dataDir, "1787799588", "5433"].join("\n"),
    );
    writeFileSync(
      pidFile,
      JSON.stringify({
        pid,
        startedAt: Date.now(),
        dataDir: join(dir, "some-other-cluster"),
        port: 5599,
        bootTime: null,
      }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.staleKind).toBe("different-cluster");
    expect(status.source).toBe("pid-file");
    expect(status.pid).toBe(pid);
  });

  test("keeps it when postmaster.pid predates the boot", async () => {
    // The same record, reached by a different route: postmaster.pid left over
    // from before a reboot. That exit returns before the PID file is read at
    // all unless it too consults the fallback — and a leftover postmaster.pid
    // after a restart is about the most ordinary state there is.
    const pid = await spawnFakePostgres(null);

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(DEAD_PID), dataDir, "1000000", "5433"].join("\n"),
    );
    writeFileSync(
      pidFile,
      JSON.stringify({
        pid,
        startedAt: Date.now(),
        dataDir: join(dir, "some-other-cluster"),
        port: 5599,
        bootTime: null,
      }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.staleKind).toBe("different-cluster");
    expect(status.pid).toBe(pid);
  });

  test("keeps it when postmaster.pid names a copied-from cluster", async () => {
    // And by the third route: a data directory copied from elsewhere, whose
    // postmaster.pid still names the original.
    const pid = await spawnFakePostgres(null);

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(DEAD_PID), join(dir, "copied-from"), "1787799588", "5433"].join(
        "\n",
      ),
    );
    writeFileSync(
      pidFile,
      JSON.stringify({
        pid,
        startedAt: Date.now(),
        dataDir: join(dir, "some-other-cluster"),
        port: 5599,
        bootTime: null,
      }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.staleKind).toBe("different-cluster");
    expect(status.pid).toBe(pid);
  });
});

describe("a record from a previous boot is gone whatever it named", () => {
  test("a different-cluster PID file predating the boot reads as recycled", async () => {
    // Otherwise the caller refuses on a process that inherited the number
    // across the restart — after a reboot, an ordinary thing for a
    // low-numbered PID — and refuses again every run until somebody deletes
    // the file by hand. The recorded boot proves the server is gone, and which
    // cluster it belonged to stops mattering at that point.
    //
    // The stand-in serves a THIRD directory, so the live process is positively
    // ruled out as the recorded one rather than merely unrecognized. That is
    // what the boot reading needs beside it: see the test below for the case
    // where the process cannot be identified either way.
    const pid = await spawnFakePostgres(join(dir, "whatever-took-the-number"));

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid,
        startedAt: Date.now(),
        dataDir: join(dir, "some-other-cluster"),
        port: 5599,
        bootTime: (getSystemBootTime() ?? Date.now()) - 86_400_000,
      }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.staleKind).toBe("recycled");
    expect(status.running).toBe(false);
  });

  test("a different-cluster PID file from this boot still reads as such", async () => {
    // The safeguard has to survive the fix: a record written during this boot
    // may well describe a server that is still running.
    const pid = await spawnFakePostgres(null);

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid,
        startedAt: Date.now(),
        dataDir: join(dir, "some-other-cluster"),
        port: 5599,
        bootTime: getSystemBootTime(),
      }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.staleKind).toBe("different-cluster");
  });

  test("a live server for the other cluster outranks a shifted boot reading", async () => {
    // The live process gets to answer before the clocks do. Neither boot value
    // is a boot id: every probe derives one by subtracting uptime from the
    // current time, so a correction to the clock after the record was written
    // moves the current reading without a reboot. Taken as proof, that calls a
    // server demonstrably alive for the other directory `recycled` — and a
    // stale record is documented as safe to delete, so the caller erases the
    // only record of a running server.
    const otherDir = join(dir, "live-other-cluster");

    mkdirSync(otherDir, { recursive: true });

    const pid = await spawnFakePostgres(otherDir);

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid,
        startedAt: Date.now(),
        dataDir: otherDir,
        port: 5599,
        // A day out, which is well past the tolerance and is what a stepped
        // clock looks like from here. Nothing rebooted.
        bootTime: (getSystemBootTime() ?? Date.now()) - 86_400_000,
      }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.staleKind).toBe("different-cluster");
    expect(status.running).toBe(false);
  });

  test("a live PID nothing can identify keeps its different-cluster record", async () => {
    // The gap a boolean left. A process that cannot be identified is not the
    // same as one ruled out: this one may well be the recorded server, with
    // only its command line unreadable — a PostgreSQL inheriting PGDATA names
    // no directory at all. Folded in with the ruled-out case, the boot reading
    // above reports it `recycled`, and a stale record is documented as safe to
    // delete, so the caller erases the only record of a running server.
    const pid = await spawnFakePostgres(null);

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid,
        startedAt: Date.now(),
        dataDir: join(dir, "some-other-cluster"),
        port: 5599,
        bootTime: (getSystemBootTime() ?? Date.now()) - 86_400_000,
      }),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.staleKind).toBe("different-cluster");
    expect(status.running).toBe(false);
  });

  test("a postmaster.pid predating the boot outranks its data directory", async () => {
    // Same ordering on the other path: pre-boot first, cluster second.
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [String(DEAD_PID), join(dir, "copied-from"), "1000000", "5433"].join(
        "\n",
      ),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.staleKind).toBe("recycled");
  });

  test("a clock step does not make a live postmaster predate its own boot", async () => {
    // The shape on macOS and Windows, where the two readings behave
    // differently: `ps lstart` and CIM CreationDate are absolute timestamps
    // stored at fork, so they do not move, while kern.boottime and
    // LastBootUpTime are recomputed from the current clock and do. Step the
    // clock forward an hour and a postmaster that has been up for one appears
    // to have started before the machine booted.
    //
    // Its own start time still matches what it wrote to postmaster.pid, so
    // this is a server that verifies. Reporting it `recycled` deletes the
    // interlock out from under it, and a second postmaster then starts against
    // the same data directory.
    const NOW = Date.now();
    const STARTED = Math.floor((NOW - 3_600_000) / 1000) * 1000;

    const probes = probesWith({
      isAlive: () => true,
      // Postgres, but naming no data directory — inheriting PGDATA — so the
      // command line cannot settle it and the clock is all there is.
      command: () => "/opt/pg/bin/postgres -p 5433",
      startTime: () => STARTED,
      bootTime: () => NOW,
    });

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      ["4242", dataDir, String(STARTED / 1000), "5433"].join("\n"),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes,
    });

    expect(status.running).toBe(true);
    expect(status.staleKind).toBeNull();
    expect(status.pid).toBe(4242);
  });

  test("a clock-only disagreement does not route around the boot refusal", async () => {
    // The Linux shape, where the two readings move TOGETHER: a start time
    // there is the /proc boot epoch plus monotonic ticks, so an adjusted clock
    // shifts the process start time exactly as it shifts the boot reading, and
    // a live postmaster stops matching the start time it wrote into its own
    // postmaster.pid.
    //
    // The shortcut above declines this one, since nothing beyond the clock
    // rules the PID out. Reporting `recycled` from the same clock immediately
    // afterwards would arrive at the deletion the refusal just prevented.
    const NOW = Date.now();
    const STARTED = Math.floor((NOW - 3_600_000) / 1000) * 1000;

    const probes = probesWith({
      isAlive: () => true,
      // Postgres inheriting PGDATA, so the command line names no cluster and
      // cannot rule the PID out either way.
      command: () => "/opt/pg/bin/postgres -p 5433",
      // Shifted with the boot reading, an hour past what the record says.
      startTime: () => STARTED + 3_600_000,
      bootTime: () => NOW,
    });

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      ["4242", dataDir, String(STARTED / 1000), "5433"].join("\n"),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes,
    });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("indeterminate");
    expect(status.indeterminate).toBe(true);
  });

  test("a clock step does not make this cluster's own record read as recycled", async () => {
    // No postmaster.pid at all, so strataline's own record is the only thing
    // describing the server, and it names THIS cluster. A uid it cannot
    // disprove, a live PID whose command line names no directory, and a boot
    // reading that moved: every disagreement here traces back to the clock.
    //
    // Reported `recycled`, the record is declared safe to delete and startup
    // proceeds, which puts a second postmaster on a data directory the first
    // may still be serving.
    const NOW = Date.now();
    const STARTED = Math.floor((NOW - 3_600_000) / 1000) * 1000;

    const probes = probesWith({
      isAlive: () => true,
      command: () => "/opt/pg/bin/postgres -p 5433",
      startTime: () => STARTED,
      // An hour ahead of the boot this record was written during.
      bootTime: () => NOW,
    });

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: 4242,
        startedAt: STARTED,
        dataDir,
        port: 5433,
        bootTime: NOW - 3_600_000,
        uid: null,
      }),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes,
    });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("indeterminate");
    expect(status.indeterminate).toBe(true);
  });

  test("a uid rules out a foreign record's PID after a reboot too", async () => {
    // The foreign-record half of the case below. Nothing can be read about the
    // process except who owns it, and that is enough: the recorded server ran
    // as another uid and a process cannot change uid after exec, so whatever
    // holds the number across the reboot is not it.
    //
    // Left to the boot reading alone this reads `different-cluster`, and the
    // caller then refuses on every run — until somebody deletes the file by
    // hand — over a number this had positive proof was no longer that server's.
    const NOW = Date.now();
    const otherDir = join(dir, "some-other-cluster");

    const probes = probesWith({
      isAlive: () => true,
      command: () => null,
      startTime: () => null,
      bootTime: () => NOW,
      uid: () => 501,
    });

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: 4242,
        startedAt: NOW - 86_400_000,
        dataDir: otherDir,
        port: 5599,
        bootTime: NOW - 86_400_000,
        uid: 502,
      }),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes,
    });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("recycled");
    expect(status.indeterminate).toBe(false);
  });

  test("a uid that cannot have changed still rules a PID out", async () => {
    // The other half: withholding the clocks must not withhold the owner too.
    // A process cannot change uid after exec, so a mismatch is disproof no
    // adjustment can manufacture and the record stays deletable.
    const NOW = Date.now();
    const STARTED = Math.floor((NOW - 3_600_000) / 1000) * 1000;

    const probes = probesWith({
      isAlive: () => true,
      command: () => "/opt/pg/bin/postgres -p 5433",
      startTime: () => STARTED,
      bootTime: () => NOW,
      uid: () => 501,
    });

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: 4242,
        startedAt: STARTED,
        dataDir,
        port: 5433,
        bootTime: NOW - 3_600_000,
        uid: 502,
      }),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes,
    });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("recycled");
    expect(status.indeterminate).toBe(false);
  });

  test("a postmaster.pid whose live PID cannot be identified stays undecided", async () => {
    // The same rule on the postmaster path, where the stakes are higher: this
    // file is PostgreSQL's own interlock against a second postmaster on one
    // data directory, and `recycled` is what authorizes deleting it. A start
    // time predating the boot is two wall-clock readings, so on its own it
    // cannot license that against a live PID nothing could identify.
    //
    // A platform that can see the number is in use and nothing else, which is
    // what every probe returning null stands for. Injected rather than spawned
    // because the real shape of this — a live PostgreSQL whose flat command
    // line was cut at a space — cannot be produced portably.
    const NOW = Date.now();
    const probes = probesWith({
      isAlive: () => true,
      bootTime: () => NOW,
    });

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [
        "4242",
        dataDir,
        // Epoch seconds, a day before the boot the probe reports.
        String(Math.floor((NOW - 86_400_000) / 1000)),
        "5433",
      ].join("\n"),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes,
    });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("indeterminate");
    expect(status.indeterminate).toBe(true);
  });
});

describe("what a verification reports having observed", () => {
  const LIVE_PID = 4242;
  const NOW = 1_787_800_000_000;

  test("reports nothing when identity came from the command line alone", () => {
    // The data directory settles this without a clock, so no start time is
    // reported even though the platform can read one. A value read here would
    // be a second snapshot after the command line with nothing comparing the
    // two: if the process exited between them and its number was reused, it
    // would describe the replacement.
    const result = verifyPid(LIVE_PID, {
      startedAt: null,
      bootTime: null,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "/opt/pg/bin/postgres -D /srv/pgdata",
        startTime: () => NOW,
      }),
    });

    expect(result.verifiedBy).not.toBeNull();
    expect(result.startTime).toBeNull();
  });

  test("reports the start time it actually compared", () => {
    // Here the decision turns on the timestamp, so the value is bound to it —
    // a replacement would have started later than the record and failed the
    // comparison rather than being reported.
    const result = verifyPid(LIVE_PID, {
      startedAt: NOW,
      bootTime: NOW - 3_600_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "/opt/pg/bin/postgres",
        startTime: () => NOW - 1000,
        bootTime: () => NOW - 3_600_000,
      }),
    });

    expect(result.verifiedBy).not.toBeNull();
    expect(result.startTime).toBe(NOW - 1000);
  });
});

describe("executable paths containing spaces", () => {
  const LIVE_PID = 4242;

  // Every case asks one question — what does this command line prove about PID
  // 4242, whose cluster is /srv/pgdata — so they are one table. The note on
  // each row is the case: a distinct way an executable can be misread, and
  // what it would cost to read it that way.
  const cases: {
    name: string;
    command: string;
    verifiedBy: "command" | "clock" | null;
    kind: DevDBStaleKind | null;
  }[] = [
    {
      // What the macOS probe actually produces: `ps -o comm=` supplies the
      // executable as one field, so it is re-serialized with a real boundary
      // and the path is read exactly rather than guessed at.
      name: "verifies when the executable boundary is known",
      command:
        '"/Users/me/Google Drive/pg/bin/postgres" -D /srv/pgdata -p 5433',
      verifiedBy: "command",
      kind: null,
    },
    {
      // The same server, but flat. This could be PostgreSQL under a path with
      // a space, or an unrelated program at "/Users/me/Google Drive/pg/bin/…"
      // — and both readings are destructive if wrong. Calling it PostgreSQL
      // lets the matching -D verify it and authorize a kill; calling it
      // unrelated makes it `recycled`, and startup deletes a recycled record's
      // postmaster.pid, the interlock against a second postmaster on the same
      // data directory.
      name: "refuses to guess when the boundary is missing",
      command: "/Users/me/Google Drive/pg/bin/postgres -D /srv/pgdata -p 5433",
      verifiedBy: null,
      kind: "indeterminate",
    },
    {
      // `/usr/bin/node /tmp/postgres -D /srv/pgdata` joins to a postgres
      // basename, so it must never reach `verified` — the -D would otherwise
      // match and the unrelated Node process would be signaled.
      name: "does not let an ambiguous prefix authorize a signal",
      command: "/usr/bin/node /tmp/postgres -D /srv/pgdata",
      verifiedBy: null,
      kind: "indeterminate",
    },
    {
      // An executable can only be cut at a space if it was a path to begin
      // with. Without that bound `docker exec pg postgres` joins its way to a
      // postgres basename, and a definitively recycled number reads as
      // undecidable — which has the dev server refuse to start on every run.
      name: "only joins a prefix that is shaped like a path",
      command: "docker exec pg postgres",
      verifiedBy: null,
      kind: "recycled",
    },
    {
      // The bound that makes the prefix scan safe: arguments after a flag are
      // not part of the executable path. Both details matter for the bound to
      // be under test at all — the executable is spelled as a path, or the
      // scan stops at the path-shape guard above, and so is the flagged
      // argument, or the joined candidate has no separator before `postgres`
      // and fails the basename check for an unrelated reason.
      name: "still rules out a process that merely mentions postgres",
      command: "/usr/bin/node worker.js --label /opt/postgres",
      verifiedBy: null,
      kind: "recycled",
    },
    {
      name: "still rules out an unrelated process with a plain path",
      command: "/usr/bin/redis-server /etc/redis.conf",
      verifiedBy: null,
      kind: "recycled",
    },
  ];

  for (const { name, command, verifiedBy, kind } of cases) {
    test(name, () => {
      const result = verifyPid(LIVE_PID, {
        startedAt: null,
        bootTime: null,
        dataDir: "/srv/pgdata",
        probes: probesWith({ command: () => command }),
      });

      expect(result.verifiedBy).toBe(verifiedBy);
      expect(result.kind).toBe(kind);
    });
  }
});

describe("data directories containing spaces", () => {
  // What the flag parser recovers from a command line whose boundaries are
  // intact, which is every platform but macOS.
  const parses: { name: string; command: string; dataDir: string }[] = [
    {
      name: "parses a quoted path as one argument",
      command: 'postgres -D "/tmp/my db" -p 5433',
      dataDir: "/tmp/my db",
    },
    {
      // A literal quote is escaped by doubling it, the one convention that
      // both our own /proc serialization and Windows command lines agree on.
      name: "recovers an escaped quote inside a path",
      command: 'postgres -D "/tmp/od""d" -p 5433',
      dataDir: '/tmp/od"d',
    },
    {
      // Windows command lines arrive verbatim and escape nothing, so a
      // backslash rule would collapse "\\\\server\\share" into a path that does
      // not exist and report a live server as recycled.
      name: "leaves backslashes alone so Windows UNC paths survive",
      command:
        '"C:\\pg\\bin\\postgres.exe" -D "\\\\server\\share\\pgdata" -p 5433',
      dataDir: "\\\\server\\share\\pgdata",
    },
  ];

  for (const { name, command, dataDir } of parses) {
    test(name, () => {
      expect(dataDirFromCommand(command)).toBe(dataDir);
    });
  }

  // What a command line proves about PID 4242 when a space may have been lost
  // from it. Both directions are destructive, so the table carries matches and
  // mismatches together: `verified` authorizes stopping that server, and
  // `recycled` authorizes deleting its postmaster.pid.
  const verdicts: {
    name: string;
    command: string;
    dataDir: string;
    verifiedBy: "command" | "clock" | null;
    kind: DevDBStaleKind | null;
  }[] = [
    {
      // A flat command line (macOS ps) splits "/tmp/my db" at the space, so
      // the parsed value looks like a different cluster. Claiming "recycled"
      // here would authorize terminating our own live server.
      name: "does not decisively reject when the parse may be truncated",
      command: "postgres -D /tmp/my db -p 5433",
      dataDir: "/tmp/my db",
      verifiedBy: null,
      kind: "indeterminate",
    },
    {
      // The mirror of the case above, and the dangerous direction. A flat
      // command line reads "/tmp/my db" as "/tmp/my", which matches a cluster
      // at "/tmp/my" exactly. Verifying would authorize stopping somebody
      // else's server, so the equal-looking parse must not count as proof.
      name: "does not verify when the running server's path is the longer one",
      command: "postgres -D /tmp/my db -p 5433",
      dataDir: "/tmp/my",
      verifiedBy: null,
      kind: "indeterminate",
    },
    {
      // The guard keys off a bare token after the data directory, so an
      // ordinary command line has to stay decisive or every start would refuse.
      name: "still verifies our own server, whose next token is a flag",
      command: "postgres -D /tmp/my -p 5433 -c listen_addresses=127.0.0.1",
      dataDir: "/tmp/my",
      verifiedBy: "command",
      kind: null,
    },
    {
      // -D/srv/pg data loses its boundary the same way the spaced form does.
      name: "does not verify a truncated value joined to the flag",
      command: "postgres -D/srv/pg data -p 5433",
      dataDir: "/srv/pg",
      verifiedBy: null,
      kind: "indeterminate",
    },
    {
      name: "catches a truncated value after the separated long flag",
      command: "postgres --data-directory /srv/pg data -p 5433",
      dataDir: "/srv/pg",
      verifiedBy: null,
      kind: "indeterminate",
    },
    {
      name: "catches a truncated value after the joined long flag",
      command: "postgres --data-directory=/srv/pg data -p 5433",
      dataDir: "/srv/pg",
      verifiedBy: null,
      kind: "indeterminate",
    },
    {
      // The boundary survives wherever argv is preserved, so the guard must
      // not cost spaced paths their decisive answer on Linux and Windows.
      // Without this the guard could be tightened into refusing them and no
      // test would notice.
      name: "still verifies a quoted path with a space, as Linux reports it",
      command: 'postgres -D "/tmp/my db" -p 5433',
      dataDir: "/tmp/my db",
      verifiedBy: "command",
      kind: null,
    },
    {
      // "/srv/pgdata-backup" is not a truncation of "/srv/pgdata", so the
      // caution above must not blunt the real check.
      name: "still rejects a genuinely different cluster decisively",
      command: "postgres -D /srv/pgdata-backup -p 5433",
      dataDir: "/srv/pgdata",
      verifiedBy: null,
      kind: "recycled",
    },
    {
      // The other spelling problem. Our cluster is reached through a symlink,
      // so a flat command line cuts "/tmp/pg data" down to "/tmp/pg", a prefix
      // of no spelling of "/Users/me/pg data", which leaves the prefix test
      // unable to rescue it. The command line still reports the lost boundary
      // itself, and it has to count on a mismatch as well as on a match: a
      // decisive "recycled" here has the caller delete the postmaster.pid of a
      // server still serving this very data directory, then start a second
      // postmaster against it.
      name: "does not decide when a truncated parse names an unrecognized path",
      command: "postgres -D /tmp/pg data -p 5433",
      dataDir: "/Users/me/pg data",
      verifiedBy: null,
      kind: "indeterminate",
    },
  ];

  for (const { name, command, dataDir, verifiedBy, kind } of verdicts) {
    test(name, () => {
      const result = verifyPid(4242, {
        startedAt: null,
        bootTime: null,
        dataDir,
        probes: probesWith({ command: () => command }),
      });

      expect(result.verifiedBy).toBe(verifiedBy);
      expect(result.kind).toBe(kind);
    });
  }

  test("never misclassifies a live server in a path with a space", async () => {
    // End to end against a real process, which is why it is not in the table:
    // the answer depends on what the platform can report. Linux preserves argv
    // boundaries so this verifies outright; macOS cannot, so it comes back
    // indeterminate. Either is safe — what must never happen is a decisive
    // "recycled".
    const spaced = join(dir, "my data");

    mkdirSync(spaced, { recursive: true });

    const pid = await spawnFakePostgres(spaced);
    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir: spaced,
    });

    writeFileSync(pidFile, String(pid));

    const result = verifyPid(pid, {
      startedAt: null,
      bootTime: null,
      dataDir: spaced,
    });

    expect(result.kind).not.toBe("recycled");
    expect(status.staleKind).not.toBe("recycled");
  });
});

describe("postmaster.pid predating the current boot", () => {
  test("still identifies a live server whose command line names this cluster", async () => {
    // Both sides of the boot comparison come off an adjustable wall clock. A
    // step backwards between boot and startup — an RTC wrong at boot, a VM
    // resumed from a snapshot, an NTP correction — leaves a live postmaster
    // recording a start time that predates its own boot. Read as proof of a
    // reboot, that is a decisive `recycled`, which has the caller delete the
    // postmaster.pid of a server running right now and start a second
    // postmaster against its data directory.
    //
    // The process says which cluster it serves on its own command line, and
    // that cannot be true of a process that is not serving it. Identification
    // outranks a heuristic about the past.
    const pid = await spawnFakePostgres(dataDir);
    const bootTime = getSystemBootTime();

    if (bootTime === null) {
      return;
    }

    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [
        String(pid),
        dataDir,
        String(Math.floor((bootTime - 60_000) / 1000)),
        "5433",
      ].join("\n"),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.staleKind).not.toBe("recycled");
    expect(status.running).toBe(true);
  });

  test("is decisively stale rather than left to timestamps", async () => {
    const bootTime = getSystemBootTime();

    if (bootTime === null) {
      return;
    }

    // A server cannot have started before the machine booted, so this record
    // survived a restart and its PID now belongs to somebody else. The live
    // PID here is this test process, standing in for whatever inherited it.
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      [
        String(process.pid),
        dataDir,
        String(Math.floor((bootTime - 86_400_000) / 1000)),
        "5433",
      ].join("\n"),
    );

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    expect(status.staleKind).toBe("recycled");
    expect(status.indeterminate).toBe(false);
    expect(status.reason).toContain("before the current boot");
  });
});

describe("only the executable identifies a PostgreSQL server", () => {
  const NOW = 1_787_800_000_000;

  test("a process merely mentioning postgres is not one", () => {
    // A recycled PID belonging to this would otherwise reach the timestamp
    // checks, verify, and be signaled.
    const result = verifyPid(4242, {
      startedAt: NOW,
      bootTime: NOW - 3_600_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "node worker.js --label postgres",
        startTime: () => NOW,
        bootTime: () => NOW - 3_600_000,
      }),
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("recycled");
  });

  test("accepts the real executable names", () => {
    for (const command of [
      "/opt/pg/bin/postgres -D /srv/pgdata",
      "/opt/pg/bin/postmaster -D /srv/pgdata",
      '"C:\\pg\\bin\\postgres.exe" -D /srv/pgdata',
    ]) {
      const result = verifyPid(4242, {
        startedAt: null,
        bootTime: null,
        dataDir: "/srv/pgdata",
        probes: probesWith({ command: () => command }),
      });

      expect(result.verifiedBy).not.toBeNull();
    }
  });
});

describe("a process cannot start after its own record", () => {
  const NOW = 1_787_800_000_000;

  test("rejects a PID reused shortly after the recorded server exited", () => {
    // Another PostgreSQL inheriting PGDATA picks up the number 30 seconds
    // later. A symmetric tolerance would call that a match.
    const result = verifyPid(4242, {
      startedAt: NOW,
      bootTime: NOW - 3_600_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "/opt/pg/bin/postgres -p 5433",
        startTime: () => NOW + 30_000,
        bootTime: () => NOW - 3_600_000,
      }),
    });

    expect(result.verifiedBy).toBeNull();
    expect(result.kind).toBe("recycled");
  });

  test("still accepts a process that started just before its record", () => {
    // Our own PID file is written a moment after the spawn, so the real
    // process always predates its record slightly.
    const result = verifyPid(4242, {
      startedAt: NOW,
      bootTime: NOW - 3_600_000,
      dataDir: "/srv/pgdata",
      probes: probesWith({
        command: () => "/opt/pg/bin/postgres -p 5433",
        startTime: () => NOW - 1500,
        bootTime: () => NOW - 3_600_000,
      }),
    });

    expect(result.verifiedBy).not.toBeNull();
  });
});

/**
 * A probe that fails the way a real one does, rather than the way an absent
 * reading does.
 *
 * The distinction these tests exist for: `null` is what both look like at
 * every later decision, so the only thing that tells "this platform has no
 * uid" apart from "`ps` is not installed" is what the probe recorded on its
 * way out. Every one of these runs on any platform, since the failure is
 * injected rather than provoked.
 */
function failingProbes(
  overrides: Partial<ProcessProbes>,
  error: unknown,
): ProcessProbes {
  const thrower = () => {
    throw error;
  };

  return {
    isAlive: () => true,
    command: thrower,
    startTime: thrower,
    bootTime: () => null,
    uid: () => null,
    ...overrides,
  };
}

describe("probe failure reporting", () => {
  test("says why a command-line read failed rather than only that it did", () => {
    // A missing `ps` and an unsupported platform produce the same null and the
    // same `indeterminate`. Only this tells them apart.
    const missingPs = Object.assign(new Error("spawnSync ps ENOENT"), {
      code: "ENOENT",
    });

    const result = verifyPid(4321, {
      startedAt: null,
      bootTime: null,
      dataDir: "/tmp/cluster",
      probes: failingProbes(
        {
          command: () => {
            throw missingPs;
          },
        },
        missingPs,
      ),
    });

    expect(result.kind).toBe("indeterminate");
    expect(result.probeFailures.length).toBeGreaterThan(0);
    expect(result.probeFailures.join(" ")).toContain("ENOENT");
  });

  test("reports a probe killed at its timeout as a signal, not a code", () => {
    // What execFileSync leaves behind when it kills a child at `timeout`. A
    // wedged machine and a missing binary want different fixes.
    const timedOut = Object.assign(new Error("spawnSync ps ETIMEDOUT"), {
      signal: "SIGTERM",
    });

    const result = verifyPid(4321, {
      startedAt: null,
      bootTime: null,
      dataDir: "/tmp/cluster",
      probes: failingProbes({}, timedOut),
    });

    expect(result.probeFailures.join(" ")).toContain("SIGTERM");
  });

  test("is empty when every probe answered", () => {
    const result = verifyPid(4321, {
      startedAt: null,
      bootTime: null,
      dataDir: "/tmp/cluster",
      probes: {
        isAlive: () => true,
        command: () => "/usr/bin/postgres -D /tmp/cluster",
        startTime: () => 1_700_000_000_000,
        bootTime: () => 1_600_000_000_000,
        uid: () => 501,
      },
    });

    expect(result.verifiedBy).toBe("command");
    expect(result.probeFailures).toEqual([]);
  });

  test("a platform with no probe at all is not a failure", () => {
    // getProcessUid returns null on Windows by design. An absent reading is
    // not a probe that tried and could not, and must not be reported as one.
    const result = verifyPid(4321, {
      startedAt: null,
      bootTime: null,
      dataDir: "/tmp/cluster",
      probes: {
        isAlive: () => true,
        command: () => null,
        startTime: () => null,
        bootTime: () => null,
        uid: () => null,
      },
    });

    expect(result.kind).toBe("indeterminate");
    expect(result.probeFailures).toEqual([]);
  });

  test("does not attribute a caller's earlier failures to a nested check", () => {
    // verifyPid runs inside its own pass, and a second call must report only
    // what its own probes could not do.
    const boom = Object.assign(new Error("nope"), { code: "EACCES" });
    const options = {
      startedAt: null,
      bootTime: null,
      dataDir: "/tmp/cluster",
    };

    const first = verifyPid(4321, {
      ...options,
      probes: failingProbes({}, boom),
    });
    const second = verifyPid(4321, {
      ...options,
      probes: {
        isAlive: () => true,
        command: () => null,
        startTime: () => null,
        bootTime: () => null,
        uid: () => null,
      },
    });

    expect(first.probeFailures.length).toBeGreaterThan(0);
    expect(second.probeFailures).toEqual([]);
  });

  test("carries the failures into the status a caller refuses on", async () => {
    const blocked = Object.assign(new Error("access is denied"), {
      code: "EACCES",
    });

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: 4321,
        startedAt: Date.now(),
        dataDir,
        port: 5599,
        bootTime: null,
        uid: null,
      }),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes: failingProbes({}, blocked),
    });

    expect(status.indeterminate).toBe(true);
    expect(status.probeFailures.join(" ")).toContain("EACCES");
    // Appended to the reason too, so a caller that only logs that still sees it.
    expect(status.reason).toContain("some checks could not run");
    expect(status.reason).toContain("EACCES");
  });
});

describe("probe failure reporting, regressions", () => {
  test("reports a boot-time probe failure rather than deduplicating it away", async () => {
    // The boot read happens before the verification, outside its collector.
    // With one shared array and a global dedup, the identical failure raised
    // inside the verification was suppressed and then sliced away, so the one
    // reading that pushes the answer to `indeterminate` was reported nowhere.
    const gone = Object.assign(new Error("no sysctl"), { code: "ENOENT" });
    const failing = () => {
      throw gone;
    };

    // postmaster.pid must be present: that is what makes the boot read happen
    // BEFORE the verification and outside its collector, which is the whole
    // shape of the bug. Without it the only boot read is inside verifyPid,
    // where it was always reported correctly.
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      `4321\n${dataDir}\n${Math.floor(Date.now() / 1000)}\n5599\n`,
    );

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: 4321,
        startedAt: Date.now(),
        dataDir,
        port: 5599,
        bootTime: Date.now(),
        uid: null,
      }),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes: {
        isAlive: () => true,
        command: failing,
        startTime: failing,
        bootTime: failing,
        uid: () => null,
      },
    });

    expect(status.probeFailures.join(" ")).toContain("system boot time");
    expect(status.reason).toContain("system boot time");
  });

  test("a bootTime probe that throws does not reject the status check", async () => {
    // guardProbes exists so an injected probe cannot end a status check by
    // throwing. Two boot reads sat outside it.
    const boom = Object.assign(new Error("denied"), { code: "EACCES" });

    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: 4321,
        startedAt: Date.now(),
        dataDir: "/somewhere/else",
        port: 5599,
        bootTime: Date.now(),
        uid: null,
      }),
    );

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir,
      probes: {
        isAlive: () => true,
        command: () => null,
        startTime: () => null,
        bootTime: () => {
          throw boom;
        },
        uid: () => null,
      },
    });

    expect(status.running).toBe(false);
    expect(status.probeFailures.join(" ")).toContain("EACCES");
  });

  test("the field and the reason never disagree", async () => {
    // The field is documented as what is already appended to the reason. Two
    // branches set one without the other, so a caller branching on the field
    // and a person reading the message saw different machines.
    const boom = Object.assign(new Error("denied"), { code: "EACCES" });
    const failing = () => {
      throw boom;
    };

    for (const recordDataDir of [dataDir, "/somewhere/else"]) {
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: 4321,
          startedAt: Date.now(),
          dataDir: recordDataDir,
          port: 5599,
          bootTime: 1,
          uid: null,
        }),
      );

      const status = await getLocalDevDBServerStatus({
        pidFile,
        dataDir,
        probes: {
          isAlive: () => true,
          command: failing,
          startTime: failing,
          bootTime: failing,
          uid: failing,
        },
      });

      for (const failure of status.probeFailures) {
        expect(status.reason).toContain(failure);
      }

      expect(status.reason.includes("some checks could not run")).toBe(
        status.probeFailures.length > 0,
      );
    }
  });
});
