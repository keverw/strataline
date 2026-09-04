import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
import {
  LocalDevDBServer,
  getLocalDevDBServerStatus,
  getProcessStartTime,
  getSystemBootTime,
  identifyViaConnection,
  type LocalDevDBServerConfig,
  type ProcessProbes,
  postgresOutputLevel,
  sameDataDir,
} from "./local-dev-db-server";
import { EventEmitter } from "events";
import { Pool } from "pg";
import * as tmp from "tmp";
import { join } from "path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  copyFileSync,
  symlinkSync,
  lstatSync,
} from "fs";
import { spawn, execFileSync } from "child_process";
import { createServer, type Socket } from "net";
import { pathToFileURL } from "url";
import { findFreePort } from "./free-port";
import {
  PostgresLineAssembler,
  PostgresOutputReader,
  postgresSeverity,
} from "./postgres-output";
import {
  createConsoleLogger,
  type LogDataInput,
  type LogLevel,
  type Logger,
} from "../logger";

/**
 * Records lines as "tag:message", the shape the assertions here were written
 * against when the logger took a tag. The tag is rebuilt from the two axes it
 * used to be: the source where there is one, the level otherwise.
 */
function captureLogger(logs: string[]): Logger {
  const record = (level: LogLevel) => (data: LogDataInput) => {
    logs.push(`${data.source ?? level}:${data.message}`);
  };

  return {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/** One SysV shared memory segment, as `ipcs` reports it. */
interface ShmSegment {
  id: string;
  /** Derived by PostgreSQL from the data directory, so it identifies one. */
  key: number;
  attached: number;
}

/**
 * Lists SysV shared memory segments, or nothing where there are none to list.
 *
 * macOS only, deliberately, and on the same reasoning as scripts/clean-ipc.ts.
 * Linux defaults SHMMNI to 4096 rather than 32, so it does not exhaust and
 * there is nothing to reclaim, and its `ipcs` prints different columns than
 * the BSD one parsed below. Windows PostgreSQL does not use SysV shared memory
 * at all. It takes named objects that the operating system frees with the last
 * handle, so nothing leaks there to begin with.
 *
 * Never throws. This backs housekeeping rather than an assertion, so an `ipcs`
 * that fails should leave the suite running rather than fail tests over
 * cleanup.
 */
function listShmSegments(): ShmSegment[] {
  if (process.platform !== "darwin") {
    return [];
  }

  try {
    const out = execFileSync("ipcs", ["-mo"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    // BSD layout: "m <id> <key> <mode> <owner> <group> <nattch>" per segment.
    return out
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[0] === "m" && fields.length >= 7)
      .map((fields) => ({
        id: fields[1],
        // Printed as hex here and recorded in decimal by PostgreSQL, so both
        // are read as numbers rather than compared as text.
        key: Number(fields[2]),
        attached: Number(fields[fields.length - 1]),
      }))
      .filter(
        (segment) =>
          Number.isFinite(segment.attached) && Number.isFinite(segment.key),
      );
  } catch {
    return [];
  }
}

/**
 * The shared memory segment PostgreSQL created for a data directory, taken
 * from PostgreSQL's own record of it, or null when there is none to read.
 *
 * Line 7 of postmaster.pid holds the segment's key and its id. That file is
 * the only thing that ever ties a segment back to a cluster: the key is
 * derived from the data directory's inode, so once the directory is gone there
 * is no way left to work out which segment belonged to it. Read while the
 * record is still there and the answer is exact, which is what allows the
 * reclaim below to name its segments rather than sweep for them.
 */
function shmSegmentForDataDir(
  dataDir: string,
): { id: string; key: number } | null {
  try {
    const shmemLine = readFileSync(join(dataDir, "postmaster.pid"), "utf8")
      .split("\n")[6]
      ?.trim();
    const [key, id] = shmemLine?.split(/\s+/) ?? [];

    if (id === undefined || !/^\d+$/.test(id) || !/^\d+$/.test(key ?? "")) {
      return null;
    }

    return { id, key: Number(key) };
  } catch {
    // No record, or none readable. Nothing identifiable to reclaim.
    return null;
  }
}

/**
 * A stand-in for a spawned child whose lifecycle event this test fires by
 * hand.
 *
 * What these tests need is an exit that lands LATE: after the stop it belonged
 * to gave up waiting, and after the restart that followed took over the
 * instance. Driving the listener directly is how a test reaches that lag
 * without a wedged postmaster and an orphaned backend holding the pipes.
 *
 * Registered under whichever event the handler asks for rather than a name
 * this file picks. That is not defensive tidiness: the lifecycle used to hang
 * off `close` and now hangs off `exit`, and a fake that captured only `close`
 * silently stored nothing when it moved. `exit()` below then called an
 * undefined listener and every test using it passed without running any of the
 * code it names. Matching whatever is registered cannot go stale that way, and
 * the throw makes a fake that captured nothing say so instead of quietly
 * asserting about a handler that never ran.
 */
function fakeChild(pid: number): {
  proc: unknown;
  exit: (code: number | null) => void;
  stdout: { destroyed: boolean };
  stderr: { destroyed: boolean };
  stdin: { destroyed: boolean };
} {
  let listener: ((code: number | null) => void) | undefined;

  const pipe = () => {
    const state = { destroyed: false };

    return {
      state,
      handle: {
        get destroyed() {
          return state.destroyed;
        },
        destroy: () => {
          state.destroyed = true;
        },
      },
    };
  };

  const stdout = pipe();
  const stderr = pipe();
  const stdin = pipe();

  return {
    proc: {
      pid,
      exitCode: null,
      signalCode: null,
      stdout: stdout.handle,
      stderr: stderr.handle,
      stdin: stdin.handle,
      on(event: string, fired: (code: number | null) => void) {
        if (event === "exit" || event === "close") {
          listener = fired;
        }
      },
      // Whatever waits on this gets nothing, which is the case a stand-in is
      // standing in for: the pipes are held open and the event never comes.
      once() {},
    },
    exit: (code) => {
      if (!listener) {
        throw new Error(
          "fakeChild captured no lifecycle listener, so nothing would have run",
        );
      }

      listener(code);
    },
    stdout: stdout.state,
    stderr: stderr.state,
    stdin: stdin.state,
  };
}

/** The private state the superseded-child tests below drive and inspect. */
interface ChildLifecycleInternals {
  attachExitHandler(proc: unknown): void;
  pgProcess: unknown;
  stoppingProc: unknown;
  startingUp: boolean;
  startupFailure: Error | null;
  pgProcessLifecycle: { finalize(): Promise<void> } | null;
  releasePidRecord(): Promise<void>;
}

/**
 * Reproduces the state a stop() that outran its `close` leaves behind: the
 * child is confirmed gone and its cleanup has been run by the shutdown itself,
 * but the event has not arrived and the next start() has already attached its
 * own child.
 *
 * @returns The superseded child, whose exit is still to come.
 */
async function supersedeAChild(
  internals: ChildLifecycleInternals,
  fresh: unknown,
): Promise<{ exit: (code: number | null) => void }> {
  // Nothing on disk to release. What these tests are about is which child the
  // close handler then speaks for.
  internals.releasePidRecord = async () => {};

  const superseded = fakeChild(999001);

  internals.pgProcess = superseded.proc;
  internals.attachExitHandler(superseded.proc);

  // Aimed at by a deliberate shutdown, which then confirmed it gone and ran
  // the lifecycle cleanup itself rather than wait out an event the pipes may
  // hold back indefinitely.
  internals.stoppingProc = superseded.proc;

  const lifecycle = internals.pgProcessLifecycle;

  if (lifecycle === null) {
    throw new Error("attachExitHandler recorded no lifecycle to finalize");
  }

  await lifecycle.finalize();

  expect(internals.pgProcess).toBeNull();

  // The restart that follows, which takes over the instance.
  internals.pgProcess = fresh;
  internals.attachExitHandler(fresh);

  return superseded;
}

describe("LocalDevDBServer", () => {
  let server: LocalDevDBServer;
  let tempDir: tmp.DirResult;
  let pidFile: string;
  let serverPort: number;
  let exitCalled = false;

  let lastExitCode: number | undefined;

  /**
   * Segments this suite created and then abandoned, named individually.
   *
   * PostgreSQL keys its interlock segment off the data directory and reclaims
   * it on the next start against that same directory. Every test here gets a
   * fresh temporary one that is deleted when it finishes, so a postmaster that
   * was killed rather than shut down leaves a segment nothing will ever go
   * back for. macOS ships SHMMNI at 32, which a handful of suite runs is
   * enough to reach, and past it initdb fails with a "No space left on device"
   * that has nothing to do with the disk.
   *
   * Killing is the point of several of these tests, so the fix is to account
   * for the segments rather than to stop producing them.
   *
   * Each one is named rather than searched for. postmaster.pid records the
   * segment PostgreSQL created, so reading it before the directory goes gives
   * this exactly the ids it is responsible for, and nothing here can reach a
   * segment belonging to anything else on the machine. scripts/clean-ipc.ts
   * stays the blunt instrument for a run interrupted before it could tidy up,
   * where these hooks never execute at all.
   *
   * The key is kept alongside the id because an id on its own is a slot that
   * the kernel hands out again. One reclaimed and reissued before this runs
   * would name somebody else's segment, and nothing about the id itself would
   * say so. The key is derived from the data directory, so requiring both to
   * match is what makes the name mean the segment rather than the slot.
   */
  const abandonedShm = new Map<string, number>();

  afterAll(() => {
    const live = new Map(
      listShmSegments().map((segment) => [segment.id, segment]),
    );

    for (const [id, key] of abandonedShm) {
      const segment = live.get(id);

      // Gone already, or the slot has been handed to a different segment since
      // and the key says so, or something is attached to it after all. None of
      // the three is ours to force.
      if (
        segment === undefined ||
        segment.key !== key ||
        segment.attached !== 0
      ) {
        continue;
      }

      try {
        execFileSync("ipcrm", ["-m", id], { stdio: "ignore" });
      } catch {
        // Already gone, or not ours to remove. Nothing to do either way.
      }
    }
  });

  beforeEach(async () => {
    // Reset exit tracking
    exitCalled = false;
    lastExitCode = undefined;

    // Create a temporary directory for each test
    tempDir = tmp.dirSync({
      unsafeCleanup: true,
      prefix: "local-dev-db-test-",
    });

    pidFile = join(tempDir.name, ".pg_pid");

    // Get an available port for this test
    serverPort = await findFreePort();

    // Create server instance with test configuration
    server = new LocalDevDBServer({
      port: serverPort,
      user: "test_dev_user",
      password: "test_dev_password",
      database: "test_dev_database",
      dataDir: join(tempDir.name, "pgdata"),
      pidFile: pidFile,
      // No logger for silent tests
      onExit: (exitCode) => {
        // In tests, track exit calls instead of actually exiting
        exitCalled = true;
        lastExitCode = exitCode;
      },
    });
  });

  afterEach(async () => {
    // Clean up the server
    if (server) {
      // Nothing to release afterwards. One shared `exit` hook serves every
      // instance and the shutdown takes it off with the last child, so a
      // stopped server holds no process listener of its own.
      await server.stop();
    }

    // Clean up PID file if it exists
    if (existsSync(pidFile)) {
      try {
        unlinkSync(pidFile);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Before the directory goes, and with it the only record of which segment
    // PostgreSQL made for it. A server that shut down cleanly took its own
    // segment with it and has no postmaster.pid left, so this finds nothing
    // and there is nothing to find.
    //
    // Every data directory under the temp directory, not just the one the
    // shared `server` uses. Tests that need a second server of their own build
    // it beside that one — "orphan-pgdata", "exit-pgdata", and the rest — and
    // killing such a server is the whole point of several of them, so those
    // are exactly the directories that leave a segment behind. Naming only
    // "pgdata" here recorded none of them, and the one from the orphan test
    // leaked a segment on every run until macOS ran out at SHMMNI and initdb
    // began failing with "No space left on device" in whichever test happened
    // to run first.
    //
    // Still named rather than searched for: this reads the segment ids out of
    // postmaster.pid files inside this suite's own temp directory, so it
    // cannot reach a segment belonging to anything else on the machine.
    // Entries that are not data directories, the PID files among them, simply
    // have no postmaster.pid to read.
    for (const entry of readdirSync(tempDir.name)) {
      const abandoned = shmSegmentForDataDir(join(tempDir.name, entry));

      if (abandoned !== null) {
        abandonedShm.set(abandoned.id, abandoned.key);
      }
    }

    // Clean up temporary directory
    try {
      tempDir.removeCallback();
    } catch {
      // Ignore cleanup errors - the directory might have already been removed
      // by the PostgreSQL server process or other cleanup mechanisms
    }
  });

  it("should create a LocalDevDBServer instance", () => {
    expect(server).toBeDefined();
    expect(exitCalled).toBe(false);
    expect(lastExitCode).toBeUndefined();
  });

  it("should start and stop the server", async () => {
    // Start the server
    await server.start();

    // Verify PID file was created
    expect(existsSync(pidFile)).toBe(true);

    // Stop the server
    await server.stop();

    // stop() resolves only after the close handler has finished its lifecycle
    // cleanup, so PID-file removal needs no extra wait — and it resolves
    // rather than exiting. The default exit handler is process.exit(), so a
    // stop() that routed through it would take the host process down with the
    // server and never return to the line below.
    expect(existsSync(pidFile)).toBe(false);
    expect(exitCalled).toBe(false);
    expect(lastExitCode).toBeUndefined();
  }, 30000); // Timeout for server operations

  it("reports a server that died unasked, and does not end the process", async () => {
    // Deliberately no onExit. Under the old contract this path called
    // process.exit() when nothing intercepted it, so this test would take the
    // whole runner down with it rather than fail — which is the point: a
    // library that exits has taken a decision no caller can get back.
    const logs: string[] = [];

    const orphaned = new LocalDevDBServer({
      port: await findFreePort(),
      user: "orphan_user",
      password: "orphan_password",
      database: "orphan_database",
      dataDir: join(tempDir.name, "orphan-pgdata"),
      pidFile: join(tempDir.name, ".orphan_pg_pid"),
      logger: captureLogger(logs),
    });

    await orphaned.start();

    type Internals = { pgProcess: { pid: number } | null };
    const pid = (orphaned as unknown as Internals).pgProcess?.pid;

    expect(pid).toBeGreaterThan(0);

    // Something outside stops it: the case the report exists for.
    process.kill(pid as number, "SIGKILL");

    // Polled rather than slept: `close` waits on the stdio pipes as well as
    // the process, so how long it takes is a function of machine load and a
    // fixed wait makes this test fail on a busy one.
    const deadline = Date.now() + 30_000;

    while (
      Date.now() < deadline &&
      !logs.some((line) => line.includes("without being asked to"))
    ) {
      await Bun.sleep(100);
    }

    expect(logs.some((line) => line.includes("without being asked to"))).toBe(
      true,
    );

    // Said out loud, because with no handler this is where a dev script
    // silently keeps running with no database behind it.
    expect(logs.some((line) => line.includes("No onExit handler is set"))).toBe(
      true,
    );
  }, 60000);

  // Both shapes a failing handler can take, because only one of them is a
  // throw. The report runs inside an `async` close listener, so a synchronous
  // throw never surfaces as the uncaughtException a host could trap: it
  // rejects a promise nothing holds, and Node ends the process over it. An
  // `async` handler satisfies the `=> void` signature — TypeScript admits one
  // — and rejects the same way while sailing straight through a try/catch.
  // Either one is this library exiting, decided by a handler it only meant to
  // call, and past every path that would otherwise have a say.
  for (const [shape, onExit] of [
    [
      "throws",
      (): void => {
        throw new Error("onExit blew up");
      },
    ],
    ["rejects", async (): Promise<void> => Promise.reject(new Error("nope"))],
  ] as const) {
    it(`survives an onExit handler that ${shape}`, async () => {
      // Listened for rather than left to fire, because unhandled is exactly
      // what it would be: with no listener this does not fail the test, it
      // takes the runner down.
      const rejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        rejections.push(reason);
      };

      process.on("unhandledRejection", onUnhandled);

      const logs: string[] = [];
      const slug = `failing_${shape}`;

      const failing = new LocalDevDBServer({
        port: await findFreePort(),
        user: `${slug}_user`,
        password: `${slug}_password`,
        database: `${slug}_database`,
        dataDir: join(tempDir.name, `${slug}-pgdata`),
        pidFile: join(tempDir.name, `.${slug}_pg_pid`),
        logger: captureLogger(logs),
        onExit,
      });

      try {
        await failing.start();

        type Internals = { pgProcess: { pid: number } | null };
        const pid = (failing as unknown as Internals).pgProcess?.pid;

        expect(pid).toBeGreaterThan(0);

        // Something outside stops it: the case the report exists for.
        process.kill(pid as number, "SIGKILL");

        // Polled for the reason the unasked-exit test polls: `close` waits on
        // the stdio pipes too, so how long it takes is a function of load.
        const deadline = Date.now() + 30_000;

        while (
          Date.now() < deadline &&
          !logs.some((line) => line.includes("The onExit handler failed"))
        ) {
          await Bun.sleep(100);
        }

        // Reported rather than swallowed: unlike a logger that fails, there is
        // somewhere for this one to go.
        expect(
          logs.some((line) => line.includes("The onExit handler failed")),
        ).toBe(true);

        // And the exit it was being told about was still announced.
        expect(
          logs.some((line) => line.includes("without being asked to")),
        ).toBe(true);

        // Nothing escaped. This is the assertion that fails without callHost,
        // and the process-ending behavior it stands in for.
        await Bun.sleep(100);
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    }, 60000);
  }

  it("stops without exiting when a host forwards it a signal", async () => {
    // The whole shape of the contract now: the host traps the signal, this
    // stops the server and hands control back. Exiting from in here would take
    // a decision that belongs to the program, and a caller cannot get it back
    // once a library has made it.
    let exitCode: number | undefined;

    const signaled = new LocalDevDBServer({
      port: await findFreePort(),
      user: "signal_user",
      password: "signal_password",
      database: "signal_database",
      dataDir: join(tempDir.name, "signal-pgdata"),
      pidFile: join(tempDir.name, ".signal_pg_pid"),
      onExit: (code) => {
        exitCode = code;
      },
    });

    await signaled.start();
    await signaled.shutdown("SIGINT");

    expect(exitCode).toBeUndefined();
    expect(existsSync(join(tempDir.name, ".signal_pg_pid"))).toBe(false);
  }, 60000);
  it("can stop and start again on the same instance", async () => {
    // stop() leaves the instance usable: the shutdown state is cleared once it
    // has fully settled, so a second cycle is not refused as already-cleaning.
    await server.start();
    await server.stop();

    await server.start();
    await server.stop();

    expect(exitCalled).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  }, 30000);

  it("rejects calling start() while stopping", async () => {
    await server.start();

    const stopping = server.stop();
    await expect(server.start()).rejects.toThrow(/currently stopping/);
    await stopping;
  }, 30000);

  it("refuses overlapping lifecycle calls and reports which one is running", async () => {
    // The refusals throw, so getLifecycleState() is the only way to tell a
    // shutdown already in flight from a start that is about to reject.
    expect(server.getLifecycleState()).toBe("stopped");

    const starting = server.start();

    expect(server.getLifecycleState()).toBe("starting");
    await expect(server.start()).rejects.toThrow(/already starting/);
    await expect(server.stop()).rejects.toThrow(/currently starting/);
    await expect(server.shutdown("SIGTERM")).rejects.toThrow(
      /currently starting/,
    );

    await starting;

    expect(server.getLifecycleState()).toBe("running");

    const stopping = server.stop();

    expect(server.getLifecycleState()).toBe("stopping");
    // A start still refuses, but a second stop joins rather than throwing: a
    // stop that refused would leave the server running, which is the failure
    // the call exists to prevent.
    await expect(server.start()).rejects.toThrow(/currently stopping/);
    await Promise.all([stopping, server.stop(), server.shutdown("SIGINT")]);

    expect(server.getLifecycleState()).toBe("stopped");
    expect(exitCalled).toBe(false);
  }, 60000);

  it("rejects a failed shutdown rather than reporting success", async () => {
    // The caller owns what a failed shutdown means, so it has to reach them.
    // This used to settle through .finally, which runs on rejection too, and a
    // shutdown that failed exited 0 before anything could report it.
    let failExitCode: number | undefined;

    const failing = new LocalDevDBServer({
      port: await findFreePort(),
      user: "failing_user",
      password: "failing_password",
      database: "failing_database",
      dataDir: join(tempDir.name, "failing-pgdata"),
      pidFile: join(tempDir.name, ".failing_pg_pid"),
      onExit: (code) => {
        failExitCode = code;
      },
    });

    await failing.start();

    type Internals = { terminateProcess(): Promise<"gone" | "failed"> };
    const internals = failing as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(failing);

    // Only the kill outcome is faked; the surrounding logic is the real thing.
    internals.terminateProcess = async () => "failed";

    await expect(failing.shutdown("SIGINT")).rejects.toThrow(
      /could not be stopped/,
    );

    // Nothing exited over it, in either direction.
    expect(failExitCode).toBeUndefined();
    expect(exitCalled).toBe(false);

    internals.terminateProcess = originalTerminate;

    await failing.stop();
  }, 90000);
  it("notices a child that dies while the PID record is being written", async () => {
    // `close` fires once and is not replayed, so the handler has to be
    // attached before the first await. Attached after writePidRecord, a child
    // dying in that window left startupFailure empty and startup waited out
    // all thirty seconds instead of failing fast.
    type Internals = {
      writePidRecord(pid: number): Promise<void>;
    };

    const internals = server as unknown as Internals;
    const original = internals.writePidRecord.bind(server);

    internals.writePidRecord = async (pid: number) => {
      await original(pid);

      process.kill(pid, "SIGKILL");

      // Long enough for `close` to land inside this await, and far short of
      // the thirty seconds the generic timeout would take.
      await new Promise((resolve) => setTimeout(resolve, 500));
    };

    await expect(server.start()).rejects.toThrow(/before it was ready/i);
  }, 60000);

  it("does not treat a slow close after a timed-out stop() as a crash", async () => {
    // stop() gives the close handler two seconds and then finishes the
    // lifecycle cleanup itself. It used to reject instead, and to clear
    // shutdownInFlight, which was the only record that anybody had asked for
    // the shutdown — so when close finally landed the handler read it as the
    // server dying on its own and exited the host process, which is exactly
    // what an explicit stop() must never do.
    await server.start();

    type Internals = {
      pgProcess: { pid?: number } | null;
      terminateProcess(): Promise<"gone" | "failed">;
    };

    const internals = server as unknown as Internals;
    const pid = internals.pgProcess?.pid;

    expect(pid).toBeDefined();

    // Report the stop as successful without actually killing anything, so the
    // lifecycle wait times out with the child still alive and `close` still
    // to come.
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => "gone";

    // Resolves rather than rejecting: the escalation said the process was
    // gone, so a `close` that has not arrived is a late event and not a failed
    // shutdown. The PID record is released here rather than left for it.
    await server.stop();

    expect(existsSync(pidFile)).toBe(false);
    expect(internals.pgProcess).toBeNull();

    internals.terminateProcess = originalTerminate;

    // Now let close arrive, well after the shutdown promise has settled.
    // Tolerating ESRCH: the timeout path destroys the stdio pipes, so the
    // postmaster may already have gone of its own accord. Either way the point
    // is what the close handler does with the exit, not who caused it.
    try {
      process.kill(pid as number, "SIGKILL");
    } catch {
      // Already gone.
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(exitCalled).toBe(false);
  }, 60000);

  it("reports what initdb said when it fails", async () => {
    // runPgCommand captures initdb's stderr and nothing else reads it, so a
    // generic "failed to initialize" used to be the whole story. On macOS an
    // exhausted SysV shared-memory table surfaces exactly here, and without
    // initdb's own words it looks like a broken change rather than a host
    // that needs `bun run test:clean-ipc`.
    type Internals = {
      runPgCommand(
        command: string,
        args: string[],
        options?: { user?: string; silent?: boolean },
      ): Promise<{ stdout: string; stderr: string; code: number | null }>;
    };

    const internals = server as unknown as Internals;

    internals.runPgCommand = async () => ({
      stdout: "",
      stderr:
        "initdb: error: could not create shared memory segment: No space left on device\n",
      code: 1,
    });

    await expect(server.start()).rejects.toThrow(/No space left on device/);
  }, 60000);

  it("strands nothing in the data directory when initdb is interrupted", async () => {
    // initdb is the one unbounded step in a start, and the step a first run
    // spends nearly all of its time in, so it is where a Ctrl+C lands. Run in
    // place, an interrupted one left a directory holding part of a cluster and
    // no postgresql.conf. That is neither a cluster nor absent: the config
    // check sees no config and runs initdb again, and initdb refuses a
    // directory that is not empty, so every later start failed the same way
    // until somebody deleted the directory by hand.
    type Internals = {
      runPgCommand(
        command: string,
        args: string[],
        options?: { user?: string; silent?: boolean; timeoutMs?: number },
      ): Promise<{ stdout: string; stderr: string; code: number | null }>;
    };

    const internals = server as unknown as Internals;
    const realRunPgCommand = internals.runPgCommand.bind(server);
    const dataDir = join(tempDir.name, "pgdata");

    // Part of the tree written and then killed, which is what a signal during
    // initdb leaves behind. `code: null` is how runPgCommand reports a command
    // that produced no exit code of its own.
    internals.runPgCommand = async (command, args, options) => {
      if (!command.includes("initdb")) {
        return realRunPgCommand(command, args, options);
      }

      const target = args[args.indexOf("-D") + 1];

      mkdirSync(join(target, "base"), { recursive: true });
      writeFileSync(join(target, "PG_VERSION"), "18\n");

      return { stdout: "", stderr: "", code: null };
    };

    await expect(server.start()).rejects.toThrow(/Failed to initialize/);

    // The half-written tree went with the failure rather than into the data
    // directory, so the next start has nothing to trip over.
    expect(existsSync(dataDir)).toBe(false);

    internals.runPgCommand = realRunPgCommand;

    await server.start();

    expect(existsSync(join(dataDir, "postgresql.conf"))).toBe(true);
  }, 180000);

  it("initializes a data directory that is a symlink to somewhere else", async () => {
    // Creating one needs SeCreateSymbolicLinkPrivilege on Windows, which an
    // ordinary account does not hold unless Developer Mode is on. The
    // behavior under test is real there, but the fixture cannot be built, and
    // a test that cannot arrange its own premise is not a failure.
    if (process.platform === "win32") {
      return;
    }

    // Parking pgdata on another volume through a symlink is an ordinary thing
    // to do, and initdb handles it by simply following the link. rename() does
    // not: it refuses to replace a symlink's final component, so publishing a
    // staged cluster onto one fails with ENOTDIR however good the directory
    // behind it is, and fails again on every later start because no
    // postgresql.conf ever appears.
    const realDataDir = join(tempDir.name, "elsewhere");
    const linkedDataDir = join(tempDir.name, "linked-pgdata");

    mkdirSync(realDataDir, { recursive: true });
    symlinkSync(realDataDir, linkedDataDir);

    const linkedServer = new LocalDevDBServer({
      port: await findFreePort(),
      user: "test_dev_user",
      password: "test_dev_password",
      database: "test_dev_database",
      dataDir: linkedDataDir,
      pidFile: join(tempDir.name, ".pg_pid_linked"),
    });

    try {
      await linkedServer.start();

      // Through the link, and in the directory it points at rather than in
      // place of the link.
      expect(existsSync(join(linkedDataDir, "postgresql.conf"))).toBe(true);
      expect(existsSync(join(realDataDir, "postgresql.conf"))).toBe(true);
      expect(lstatSync(linkedDataDir).isSymbolicLink()).toBe(true);
    } finally {
      await linkedServer.stop();
    }
  }, 180000);

  it("initializes a data directory that already exists and is empty", async () => {
    // A `mkdir -p` in a setup script, a volume mounted at that path, or the
    // directory an earlier version's in-place initdb was pointed at. All
    // ordinary, and all of them a FIRST start, since nothing has initialized
    // anything yet.
    //
    // The publish-by-rename this start does is where that can go wrong, and
    // only on Windows: POSIX rename() replaces an empty destination directory,
    // while MoveFileEx's replace flag does not apply to directories at all, so
    // any existing destination fails with EPERM whether it holds anything or
    // not. Read as "the name is taken" that becomes a start refused on the
    // grounds that a directory holds files it does not have, permanently and
    // on the ordinary path. So this passes on POSIX either way and is the
    // regression guard on Windows, where CI runs it.
    const dataDir = join(tempDir.name, "pgdata");

    mkdirSync(dataDir, { recursive: true });

    await server.start();

    expect(existsSync(join(dataDir, "postgresql.conf"))).toBe(true);
  }, 180000);

  it("initializes a data directory that is a mount point of its own", async () => {
    // The one shape the staged-and-renamed publish cannot serve: a `dataDir`
    // that is a filesystem of its own. A volume mounted there in a container
    // or a devcontainer, or a second disk parked at that path, puts the
    // staging sibling — which lives in the PARENT directory — on the other
    // side of a filesystem boundary, and rename() will not cross one. macOS
    // reports EXDEV and Linux EBUSY, and `rmdir` reports EBUSY for a mount
    // point either way, so neither publishing nor clearing the name works and
    // the fallback to an in-place initdb is the whole of what makes this run.
    //
    // Not a hypothetical, and not Windows-only: the in-place initdb this
    // replaced handled it by construction, so failing here would be a
    // regression on every platform.
    //
    // macOS alone, for want of a way to build the premise elsewhere. `hdiutil`
    // needs no privileges, while a loopback mount on Linux and a mounted VHD
    // on Windows both need root or an administrator, which CI's non-admin
    // account deliberately is not. A test that cannot arrange its own premise
    // is not a failure.
    if (process.platform !== "darwin") {
      return;
    }

    const dataDir = join(tempDir.name, "pgdata");
    const image = join(tempDir.name, "volume");

    mkdirSync(dataDir, { recursive: true });

    execFileSync(
      "hdiutil",
      ["create", "-size", "128m", "-fs", "APFS", "-volname", "pgvol", image],
      { stdio: "ignore" },
    );

    execFileSync(
      "hdiutil",
      ["attach", `${image}.dmg`, "-mountpoint", dataDir, "-nobrowse"],
      { stdio: "ignore" },
    );

    try {
      await server.start();

      expect(existsSync(join(dataDir, "postgresql.conf"))).toBe(true);

      // In the mounted volume rather than in the directory underneath it,
      // which is what an in-place initdb gets right and a rename onto the
      // mount point could not have done at all.
      const pool = new Pool({
        host: "127.0.0.1",
        port: serverPort,
        user: "test_dev_user",
        password: "test_dev_password",
        database: "test_dev_database",
      });

      try {
        expect((await pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
      } finally {
        await pool.end();
      }
    } finally {
      // Ahead of the unmount, since the postmaster has the volume open and a
      // busy volume does not detach.
      await server.stop();

      execFileSync("hdiutil", ["detach", dataDir, "-force"], {
        stdio: "ignore",
      });
    }
  }, 180000);

  it("leaves a mounted data directory alone when the in-place initdb fails", async () => {
    // The hazard the in-place fallback brings with it, and the reason it
    // cleans up after nothing. Unlike the staging sibling, whose name is a
    // uuid nothing else knows, the destination is the name EVERY start against
    // this dataDir is aiming at. Two first-time starts can both find it empty
    // and both initdb into it, and initdb refuses a directory that is not
    // empty — so the loser is the one that fails, and it fails with the
    // WINNER's freshly initialized cluster sitting in the directory.
    //
    // Tidying up there would delete that cluster out from under a start that
    // is about to spawn a postmaster against it. It is the read-then-unlink
    // the claim protocol exists to rule out, reached from the one path that
    // cannot use the claim protocol, since renaming a mount point is what does
    // not work here to begin with.
    //
    // So this stands in for the winner directly: the in-place initdb reports
    // failure with a cluster already in the directory, and what has to survive
    // is every byte of it.
    if (process.platform !== "darwin") {
      return;
    }

    type Internals = {
      runPgCommand(
        command: string,
        args: string[],
        options?: { user?: string; silent?: boolean; timeoutMs?: number },
      ): Promise<{ stdout: string; stderr: string; code: number | null }>;
    };

    const dataDir = join(tempDir.name, "pgdata");
    const image = join(tempDir.name, "volume");

    mkdirSync(dataDir, { recursive: true });

    execFileSync(
      "hdiutil",
      ["create", "-size", "128m", "-fs", "APFS", "-volname", "pgvol", image],
      { stdio: "ignore" },
    );

    execFileSync(
      "hdiutil",
      ["attach", `${image}.dmg`, "-mountpoint", dataDir, "-nobrowse"],
      { stdio: "ignore" },
    );

    const internals = server as unknown as Internals;
    const realRunPgCommand = internals.runPgCommand.bind(server);

    try {
      internals.runPgCommand = async (command, args, options) => {
        const target = args[args.indexOf("-D") + 1];

        // The staged one still has to succeed, since publishing it is what
        // fails with EXDEV and sends the start down the in-place path at all.
        if (!command.includes("initdb") || target !== dataDir) {
          return realRunPgCommand(command, args, options);
        }

        // What another start finished writing while this one was working.
        writeFileSync(join(dataDir, "postgresql.conf"), "# theirs\n");
        writeFileSync(join(dataDir, "PG_VERSION"), "18\n");

        return {
          stdout: "",
          stderr:
            'initdb: error: directory "' +
            dataDir +
            '" exists but is not empty',
          code: 1,
        };
      };

      await expect(server.start()).rejects.toThrow(/Failed to initialize/);

      // Left exactly as it was found, which for the race this stands in for is
      // another server's whole data directory.
      expect(existsSync(join(dataDir, "postgresql.conf"))).toBe(true);
      expect(readFileSync(join(dataDir, "postgresql.conf"), "utf8")).toBe(
        "# theirs\n",
      );
      expect(existsSync(join(dataDir, "PG_VERSION"))).toBe(true);
    } finally {
      // In the finally with the unmount rather than after the assertions. A
      // failing expect() above skips whatever follows it, and the stub writes
      // into a data directory that is about to be detached, so leaving it
      // installed lets one broken assertion here reach the tests that run
      // next.
      internals.runPgCommand = realRunPgCommand;

      execFileSync("hdiutil", ["detach", dataDir, "-force"], {
        stdio: "ignore",
      });
    }
  }, 180000);

  it("says what is in the way when the data directory holds something else", async () => {
    // The remains of an interrupted first run under an older strataline, or a
    // directory the caller pointed `dataDir` at by mistake. Nothing can tell
    // those apart and only one is safe to remove, so this reports rather than
    // deletes — and it must not surface as initdb's own "not empty", which
    // says nothing about which directory or why strataline was looking at it.
    const dataDir = join(tempDir.name, "pgdata");

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "notes.txt"), "not a cluster\n");

    await expect(server.start()).rejects.toThrow(
      /is not an initialized PostgreSQL cluster/,
    );

    // Left exactly as it was found.
    expect(existsSync(join(dataDir, "notes.txt"))).toBe(true);
  }, 180000);

  it("reports what the postmaster said when it refuses to start", async () => {
    // The counterpart for the server itself. PostgreSQL writes the one line
    // that diagnoses a failed start to its own stderr, which used to go
    // nowhere at all without a logger, so the rejection was a bare "exited
    // with code 1 before it was ready" and the caller had to reproduce the
    // failure by hand to learn anything.
    //
    // Reproduced with the everyday case rather than a contrived one: a data
    // directory an older PostgreSQL initialized, which is what every user has
    // the first time strataline bumps a PostgreSQL major.
    await server.start();
    await server.stop();

    // Initialized by this version a moment ago. Say it was a previous one.
    writeFileSync(join(tempDir.name, "pgdata", "PG_VERSION"), "17\n");

    await expect(server.start()).rejects.toThrow(
      /database files are incompatible with server/i,
    );
  }, 120000);

  it("refuses startup when an existing PID record is malformed", async () => {
    writeFileSync(pidFile, "partially written");

    type Internals = {
      cleanupExistingProcess(): Promise<void>;
    };

    const internals = server as unknown as Internals;

    await expect(internals.cleanupExistingProcess()).rejects.toThrow(
      /could not be read/i,
    );
    expect(readFileSync(pidFile, "utf8")).toBe("partially written");
  });

  it("does not pause when there is no previous process to clean up", async () => {
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
    };

    const internals = server as unknown as Internals;
    const scheduledDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      scheduledDelays.push(delay ?? 0);

      // Keep this focused test fast even when run against the regression. The
      // assertion is about scheduling the fixed delay, not wall-clock speed.
      return originalSetTimeout(callback, delay === 2000 ? 0 : delay, ...args);
    }) as typeof globalThis.setTimeout;

    try {
      await internals.cleanupExistingProcess();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // This path only checks two absent PID files. A fixed two-second delay is
    // not synchronization because there is no process whose state can change.
    expect(scheduledDelays).not.toContain(2000);
  });

  it("leaves signal listeners it did not register alone", async () => {
    // Constructing a server used to call removeAllListeners("SIGINT") to
    // "have full control", which silently unhooked the host process's own
    // handler — and the previous LocalDevDBServer's.
    const other = (): void => {};

    process.on("SIGINT", other);

    try {
      new LocalDevDBServer({
        port: await findFreePort(),
        user: "handler_user",
        password: "handler_password",
        database: "handler_database",
        dataDir: join(tempDir.name, "unused-pgdata"),
        pidFile: join(tempDir.name, ".unused_pg_pid"),
        onExit: () => {},
      });

      expect(process.listeners("SIGINT")).toContain(other);
    } finally {
      process.off("SIGINT", other);
    }
  });

  it("does not exit the process when stopping a server that never started", async () => {
    // stop() used to route an idle shutdown through cleanupAndExit(0), so a
    // consumer calling it defensively — a test teardown, a finally block —
    // killed its own process over a server that was never running. A signal
    // still has to exit; an explicit stop() does not.
    await server.stop();

    expect(exitCalled).toBe(false);
    expect(lastExitCode).toBeUndefined();
  });

  it("joins an explicit stop() when a signal arrives during it", async () => {
    // A host that traps SIGINT while a stop() is already running. The second
    // caller waits for the same shutdown rather than starting a second one,
    // and rather than being refused: a stop is the one call that must not
    // leave a server running because it was asked for twice.
    const instance = new LocalDevDBServer({
      port: await findFreePort(),
      user: "late_signal_user",
      password: "late_signal_password",
      database: "late_signal_database",
      dataDir: join(tempDir.name, "late-signal-pgdata"),
      pidFile: join(tempDir.name, ".late_signal_pg_pid"),
      onExit: () => {},
    });

    await instance.start();

    const stopping = instance.stop();

    await Promise.all([stopping, instance.shutdown("SIGINT")]);

    expect(existsSync(join(tempDir.name, ".late_signal_pg_pid"))).toBe(false);
    expect(exitCalled).toBe(false);
  }, 60000);
  it("registers no process listeners until start()", async () => {
    // The handlers exist to keep a signal from stranding a running
    // PostgreSQL, so they are scoped to the window where there is one.
    // Registering on construction made a merely-constructed instance answer
    // signals on behalf of a server it did not have, which is how an idle
    // instance reached process.exit() while a sibling was still shutting its
    // own server down — and the "exit" hook then SIGKILLed that server
    // mid-shutdown.
    const events = [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "uncaughtException",
      "exit",
    ] as const;
    // Awaited before the counts are captured, so nothing registers a listener
    // between the two readings.
    const port = await findFreePort();
    const before = new Map(
      events.map((event) => [event, process.listenerCount(event)]),
    );

    const idle = new LocalDevDBServer({
      port,
      user: "bystander_user",
      password: "bystander_password",
      database: "bystander_database",
      dataDir: join(tempDir.name, "bystander-pgdata"),
      pidFile: join(tempDir.name, ".bystander_pg_pid"),
      onExit: () => {},
    });

    for (const event of events) {
      expect(process.listenerCount(event)).toBe(before.get(event) ?? 0);
    }

    // And a stop() on something that never started leaves it that way.
    await idle.stop();

    for (const event of events) {
      expect(process.listenerCount(event)).toBe(before.get(event) ?? 0);
    }
  });

  it("takes its process listeners off again once the server is stopped", async () => {
    // The other half of scoping them to a running server. Without this a
    // program that builds servers over its lifetime accumulates five
    // listeners per cycle, trips Node's MaxListenersExceededWarning past ten,
    // and has one signal run the shutdown of every instance ever built.
    // Only the `exit` hook is this library's; it traps no signals at all.
    const events = ["exit"] as const;
    const untouched = [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "uncaughtException",
    ] as const;
    const before = new Map(
      [...events, ...untouched].map((event) => [
        event,
        process.listenerCount(event),
      ]),
    );

    await server.start();

    for (const event of untouched) {
      expect(process.listenerCount(event)).toBe(before.get(event) ?? 0);
    }

    for (const event of events) {
      expect(process.listenerCount(event)).toBe((before.get(event) ?? 0) + 1);
    }

    await server.stop();

    for (const event of events) {
      expect(process.listenerCount(event)).toBe(before.get(event) ?? 0);
    }

    // A second cycle re-arms rather than leaving the new child unmanaged.
    await server.start();

    for (const event of events) {
      expect(process.listenerCount(event)).toBe((before.get(event) ?? 0) + 1);
    }

    await server.stop();

    for (const event of events) {
      expect(process.listenerCount(event)).toBe(before.get(event) ?? 0);
    }
  }, 120000);

  it("re-registers for the exit hook at the spawn, not only on the way in", async () => {
    // performStart arms on the way in, and everything from there to the spawn
    // is awaited: resolving the binaries, stopping a previous server, initdb.
    // The registration is a shared Set that other paths take an instance out
    // of, finalize() among them, so an arm that happens only before all that
    // is an arm that something else can undo before there is a child.
    //
    // A child spawned while this instance is out of the set is one the `exit`
    // hook does not know about, and an ordinary host exit then leaves a
    // postmaster holding the port and the data directory. So the arm beside
    // the spawn is what makes the child's protection structural rather than a
    // property of whatever ran during the start.
    //
    // Driven through the private release, which is the same seam
    // "keeps the listeners until the last server lets go" uses to arm without
    // the cost of a real server. Nothing public drops the registration
    // mid-start today, so this asserts the guarantee rather than reproducing a
    // caller's mistake.
    type Internals = { releaseProcessHandlers(): void };

    const port = await findFreePort();
    // Awaited before the count is captured, so nothing registers a listener
    // between the two readings.
    const before = process.listenerCount("exit");

    let releasedDuringStart = false;
    // Recorded rather than asserted in the callback, which runs inside the
    // guarded logger: a throw from an expect() there is absorbed as a failed
    // log line and the test would pass regardless.
    //
    // A number the count can never be, rather than null. TypeScript does not
    // reset a `let`'s narrowing for an assignment made inside a closure, so a
    // `number | null` initialized to null reads as `null` at the assertion
    // below and the comparison will not compile.
    let hookAfterRelease = -1;

    const starting = new LocalDevDBServer({
      port,
      user: "rearm_user",
      password: "rearm_password",
      database: "rearm_database",
      dataDir: join(tempDir.name, "rearm-pgdata"),
      pidFile: join(tempDir.name, ".rearm_pg_pid"),
      onExit: () => {},
      logger: {
        info: (data) => {
          // The first line start() logs once the binaries resolve, and well
          // ahead of the spawn: cleanupExistingProcess and initdb both still
          // have to run.
          if (
            !releasedDuringStart &&
            data.message.includes("Using PostgreSQL binaries")
          ) {
            releasedDuringStart = true;
            (starting as unknown as Internals).releaseProcessHandlers();
            hookAfterRelease = process.listenerCount("exit");
          }
        },
        warn: () => {},
        error: () => {},
      },
    });

    try {
      await starting.start();

      // The release really did land, and really did take the hook off. Both
      // halves matter: without them the assertion below would pass for an
      // instance that was never released at all.
      expect(releasedDuringStart).toBe(true);
      expect(hookAfterRelease).toBe(before);

      // Armed again beside the spawn, so the child this start created is still
      // force-killed if the host exits.
      expect(process.listenerCount("exit")).toBe(before + 1);
    } finally {
      await starting.stop();
    }

    expect(process.listenerCount("exit")).toBe(before);
  }, 120000);

  it("does not let a throwing logger keep the listeners on", async () => {
    // The logger belongs to the caller, so calling it runs somebody else's
    // code. start()'s catch logs before cleanupFailedStart, which is the only
    // thing that takes this instance's process listeners back off on a
    // refusal, so a throw from that one line leaked the shared `exit` hook —
    // the same leak as resolving the binaries outside the try. It also
    // replaced the reason the start refused with the logger's own error.
    const events = [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "uncaughtException",
      "exit",
    ] as const;
    const before = new Map(
      events.map((event) => [event, process.listenerCount(event)]),
    );

    const noisy = new LocalDevDBServer({
      port: await findFreePort(),
      user: "noisy_user",
      password: "noisy_password",
      database: "noisy_database",
      dataDir: join(tempDir.name, "noisy-pgdata"),
      pidFile: join(tempDir.name, ".noisy_pg_pid"),
      onExit: () => {},
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {
          throw new Error("logger blew up");
        },
      },
    });

    // This logger fails at the level the escalation would report through, so
    // the failure runs out of rungs and leaves the logger. Both out-of-band
    // destinations are taken over so neither the host's own reporting nor a
    // console line surfaces here: the reporter prefers dispatching where an
    // EventTarget exists and this runtime has one.
    const scope = globalThis as unknown as Record<string, unknown>;
    const saved = ["reportError", "dispatchEvent"].map((name) => ({
      name,
      had: name in scope,
      value: scope[name],
    }));

    delete scope.dispatchEvent;
    scope.reportError = () => {};

    try {
      // Refuses in cleanupExistingProcess, which is what reaches the catch.
      writeFileSync(join(tempDir.name, ".noisy_pg_pid"), "partially written");

      // The reason the start refused, not the logger's error.
      await expect(noisy.start()).rejects.toThrow(/could not be read/i);

      for (const event of events) {
        expect(process.listenerCount(event)).toBe(before.get(event) ?? 0);
      }
    } finally {
      for (const entry of saved) {
        if (entry.had) {
          scope[entry.name] = entry.value;
        } else {
          delete scope[entry.name];
        }
      }
    }
  });

  it("names the cause when PostgreSQL runs out of SysV IPC objects", async () => {
    // PostgreSQL reports both exhaustions as "No space left on device", which
    // reads as a full disk and sends the reader to check their disk. It also
    // surfaces on an unrelated start, long after the run that leaked the
    // objects, so the message is all anyone has to go on.
    const failing = new LocalDevDBServer({
      port: await findFreePort(),
      user: "ipc_user",
      password: "ipc_password",
      database: "ipc_database",
      dataDir: join(tempDir.name, "ipc-pgdata"),
      pidFile: join(tempDir.name, ".ipc_pg_pid"),
    });

    type Internals = {
      serverOutput: { append(chunk: string): void; clear(): void };
      withServerOutput(message: string): string;
    };
    const internals = failing as unknown as Internals;

    // Fed as two chunks that split the word the hint matches on, which is what
    // a pipe flushing mid-message does and what a buffer that reassembled
    // trimmed lines could not survive. See PostgresOutputBuffer.
    internals.serverOutput.append("FATAL:  could not create sema");
    internals.serverOutput.append(
      "phores: No space left on device\nDETAIL:  Failed system call was semget(345485937, 17, 03600).",
    );

    const message = internals.withServerOutput("PostgreSQL failed to start");

    expect(message).toContain("could not create semaphores");
    expect(message).toContain("kernel limit");
    expect(message).toContain("ipcrm");

    // Only for that failure. Every other startup error keeps its own wording
    // rather than being told to go clearing IPC objects.
    internals.serverOutput.clear();
    internals.serverOutput.append("FATAL:  database files are incompatible");

    expect(
      internals.withServerOutput("PostgreSQL failed to start"),
    ).not.toContain("ipcrm");
  });

  it("registers no signal handlers of its own", async () => {
    // Trapping SIGINT or SIGTERM inside a library takes a decision that
    // belongs to the program: the listener suppresses Node's default
    // termination for the whole process, so a library that installs one
    // silently changes how its host dies. RunStratalineCLI has always said
    // the same about itself. Only the `exit` hook goes on, which decides
    // nothing and only stops a postmaster outliving its parent.
    const before = new Map(
      (
        ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "exit"] as const
      ).map((event) => [event, process.listenerCount(event)]),
    );

    let exitedWith: number | undefined;

    const owned = new LocalDevDBServer({
      port: await findFreePort(),
      user: "owned_user",
      password: "owned_password",
      database: "owned_database",
      dataDir: join(tempDir.name, "owned-pgdata"),
      pidFile: join(tempDir.name, ".owned_pg_pid"),
      onExit: (code) => {
        exitedWith = code;
      },
    });

    await owned.start();

    for (const event of [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "uncaughtException",
    ] as const) {
      expect(process.listenerCount(event)).toBe(before.get(event) ?? 0);
    }

    expect(process.listenerCount("exit")).toBe((before.get("exit") ?? 0) + 1);

    // The seam a host drives from its own handler. It stops the server and
    // resolves; the exit stays theirs.
    await owned.shutdown("SIGTERM");

    expect(exitedWith).toBeUndefined();
    expect(existsSync(join(tempDir.name, ".owned_pg_pid"))).toBe(false);
    expect(process.listenerCount("exit")).toBe(before.get("exit") ?? 0);
  }, 60000);
  it("does not signal a child that has already exited when the process exits", () => {
    // pgProcess is only cleared by the close handler, and `close` can stay
    // pending long after the child is gone when it left an inherited stdio
    // handle open. By then the number is free, so the exit hook must go by
    // what Node reports on the handle rather than by the PID still being set.
    type Internals = {
      pgProcess: unknown;
      killProcess(pid: number, signal?: NodeJS.Signals): boolean;
      armProcessHandlers(): void;
    };

    const before = new Set(process.listeners("exit"));

    const instance = new LocalDevDBServer({
      port: 65000,
      user: "exit_user",
      password: "exit_password",
      database: "exit_database",
      dataDir: join(tempDir.name, "exit-pgdata"),
      pidFile: join(tempDir.name, ".exit_pg_pid"),
      onExit: () => {},
    });

    const internals = instance as unknown as Internals;

    // The hook goes on at start(), and this test drives it against a stand-in
    // child rather than a real server, so arm it the way start() would.
    internals.armProcessHandlers();

    const added = process
      .listeners("exit")
      .filter((listener) => !before.has(listener));

    expect(added).toHaveLength(1);
    const signaled: number[] = [];

    internals.killProcess = (pid) => {
      signaled.push(pid);

      return true;
    };

    try {
      internals.pgProcess = { pid: 4242, exitCode: 0, signalCode: null };
      added[0](0);

      expect(signaled).toEqual([]);

      internals.pgProcess = {
        pid: 4242,
        exitCode: null,
        signalCode: "SIGKILL",
      };
      added[0](0);

      expect(signaled).toEqual([]);

      internals.pgProcess = { pid: 4242, exitCode: null, signalCode: null };
      added[0](0);

      expect(signaled).toEqual([4242]);
    } finally {
      internals.pgProcess = null;
      process.off("exit", added[0]);
    }
  });

  it("starts a server when the previous child has exited but its close is still pending", async () => {
    // The same lag the exit hook guards against, reached from start() instead.
    // pgProcess is cleared by the close handler, and `close` waits on the
    // stdio pipes as well as the process: a postmaster killed without
    // signaling its children leaves orphaned backends holding those pipes and
    // the reference standing indefinitely. Answering "already running" from
    // the reference alone would resolve start() for a database that is not
    // there — and the caller is told by no other route either, since
    // reportServerExit lives in the very handler that has not run.
    type Internals = {
      pgProcess: unknown;
      pgProcessLifecycle: {
        proc: unknown;
        closed: Promise<void>;
        finalize(): Promise<void>;
      } | null;
    };

    const internals = server as unknown as Internals;
    const stale = fakeChild(999002);

    // Gone as far as Node is concerned, with a `close` that never arrives.
    (stale.proc as { exitCode: number | null }).exitCode = 0;

    let finalized = false;

    internals.pgProcess = stale.proc;
    internals.pgProcessLifecycle = {
      proc: stale.proc,
      closed: new Promise<void>(() => {}),
      finalize: async () => {
        finalized = true;
      },
    };

    await server.start();

    // The stale child's cleanup was run here rather than waited out, and a
    // real server came up rather than a resolved promise with nothing behind
    // it.
    expect(finalized).toBe(true);

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir: join(tempDir.name, "pgdata"),
    });

    expect(status.running).toBe(true);
  }, 60000);

  it("rejects when PostgreSQL exits at the very end of startup", async () => {
    // Startup has done everything it was going to do, so nothing is left
    // watching. The close handler records the failure rather than exiting —
    // start() owns it while start() is still running — which only helps if
    // start() asks once more before reporting success.
    type Internals = {
      setupUsersAndDatabases(): Promise<void>;
      pgProcess: { pid?: number } | null;
    };

    const internals = server as unknown as Internals;
    const original = internals.setupUsersAndDatabases.bind(server);

    internals.setupUsersAndDatabases = async () => {
      await original();

      const pid = internals.pgProcess?.pid;

      if (pid) {
        process.kill(pid, "SIGQUIT");
      }

      // Wait for the close handler to run, which is what start() then has to
      // notice. Polling the reference it clears rather than a fixed sleep.
      for (let i = 0; i < 100 && internals.pgProcess !== null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    await expect(server.start()).rejects.toThrow(/before it was ready/i);
    expect(existsSync(pidFile)).toBe(false);
  }, 60000);

  it("resolves when there is nothing to stop", async () => {
    // A host may forward a signal before start() ever spawned, or after a
    // stop(). Neither is an error, and neither exits.
    let exitCode: number | undefined;

    const idle = new LocalDevDBServer({
      port: await findFreePort(),
      user: "idle_user",
      password: "idle_password",
      database: "idle_database",
      dataDir: join(tempDir.name, "unused-pgdata"),
      pidFile: join(tempDir.name, ".unused_pg_pid"),
      onExit: (code) => {
        exitCode = code;
      },
    });

    await idle.shutdown("SIGTERM");
    await idle.stop();

    expect(exitCode).toBeUndefined();
  });
  it("fails fast when the server binary cannot be spawned", async () => {
    // A spawn that fails emits "error" and never "close". With no listener
    // that is an unhandled event, which throws out of the event loop instead
    // of rejecting start(), so the documented start().catch(...) never sees
    // it — and waiting the failure out took the full thirty seconds.
    type Internals = {
      startPostgresServer(binaries: {
        postgres: string;
        pg_ctl: string;
        initdb: string;
      }): Promise<void>;
      waitForServerReady(maxAttempts?: number): Promise<boolean>;
      startingUp: boolean;
    };

    const internals = server as unknown as Internals;
    const missing = join(tempDir.name, "no-such-postgres");

    // start() sets this for the window in which it owns the failure; the
    // child's close handler defers to it rather than exiting the process.
    internals.startingUp = true;

    try {
      await internals.startPostgresServer({
        postgres: missing,
        pg_ctl: missing,
        initdb: missing,
      });

      // Let the failed spawn's "error" event land.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const began = Date.now();

      await expect(internals.waitForServerReady()).rejects.toThrow();

      // The point of recording the failure: no waiting out 30 attempts for a
      // server that was never going to appear.
      expect(Date.now() - began).toBeLessThan(5000);
      expect(exitCalled).toBe(false);
    } finally {
      internals.startingUp = false;
    }
  }, 45000);

  describe("writing the PID record", () => {
    // The record is written to a sibling and renamed into place. Writing the
    // path directly would truncate it first, so a failure part-way through
    // would leave a file that is neither a valid record nor known to be this
    // invocation's — and every later start would refuse it as unreadable.
    type PidWriter = {
      writePidRecord(pid: number): Promise<void>;
      releasePidRecord(): Promise<void>;
      pidRecordIsOurs(path: string, ownRecord: string): Promise<boolean>;
      readClaimedRecord(
        path: string,
      ): Promise<{ raw: string } | { error: unknown }>;
      pidRecord: string | null;
    };

    const siblings = (): string[] =>
      readdirSync(tempDir.name).filter((name) => name.endsWith(".tmp"));

    const claims = (): string[] =>
      readdirSync(tempDir.name).filter((name) => name.endsWith(".claim"));

    /** A complete record for somebody else's server. */
    const foreignRecord = (pid: number): string =>
      JSON.stringify({
        pid,
        startedAt: Date.now(),
        dataDir: tempDir.name,
        port: serverPort,
        bootTime: null,
      });

    it("leaves a complete record and no sibling behind", async () => {
      const writer = server as unknown as PidWriter;

      await writer.writePidRecord(process.pid);

      const record = JSON.parse(readFileSync(pidFile, "utf8"));

      expect(record.pid).toBe(process.pid);
      expect(record.port).toBe(serverPort);
      expect(typeof record.startedAt).toBe("number");
      expect(writer.pidRecord).toBe(readFileSync(pidFile, "utf8"));
      expect(siblings()).toEqual([]);
    });

    it("refuses to overwrite a record that arrived after startup accounted for the last one", async () => {
      // The window a rename could not see. cleanupExistingProcess accounts for
      // what is at this name and removes it or refuses, but the spawn and the
      // readiness wait sit between that and the write, and a second cluster
      // sharing this pidFile can write its own record in between. Renamed into
      // place, that live record is replaced silently — around every refusal
      // written to stop exactly this — and the other server goes on running
      // with nothing recording it.
      const writer = server as unknown as PidWriter;
      const arrived = foreignRecord(9999);

      writeFileSync(pidFile, arrived);

      await expect(writer.writePidRecord(4242)).rejects.toThrow(
        /taken this pidFile/,
      );

      // Left exactly as it was, and this invocation claims to own nothing, so
      // a later release has no record here to delete either.
      expect(readFileSync(pidFile, "utf8")).toBe(arrived);
      expect(writer.pidRecord).toBeNull();
      expect(siblings()).toEqual([]);
    });

    it("does not truncate an existing record when the write fails", async () => {
      // The property the rename buys: a write that cannot complete never
      // reaches the real path at all. A read-only directory blocks creating
      // the sibling while leaving the record itself readable, so a direct
      // write would have truncated it to nothing by now.
      const holder = join(tempDir.name, "readonly");
      const heldPidFile = join(holder, ".pg_pid");

      mkdirSync(holder);
      writeFileSync(
        heldPidFile,
        '{"pid":123,"startedAt":1,"dataDir":"/x","port":2}',
      );
      chmodSync(holder, 0o500);

      // Windows does not enforce directory modes this way, and root ignores
      // them everywhere. Confirm the block is real before asserting on it.
      let enforced = false;

      try {
        writeFileSync(join(holder, "probe"), "x");
      } catch {
        enforced = true;
      }

      if (!enforced) {
        chmodSync(holder, 0o700);

        return;
      }

      const held = new LocalDevDBServer({
        port: await findFreePort(),
        user: "held_user",
        password: "held_password",
        database: "held_database",
        dataDir: join(tempDir.name, "unused-pgdata"),
        pidFile: heldPidFile,
        onExit: () => {},
      });

      const writer = held as unknown as PidWriter;

      await expect(writer.writePidRecord(process.pid)).rejects.toThrow();

      // Untouched: still the record that was there before, not an empty file.
      expect(JSON.parse(readFileSync(heldPidFile, "utf8")).pid).toBe(123);
      expect(writer.pidRecord).toBeNull();

      chmodSync(holder, 0o700);
    });

    it("clears the sibling when the rename fails", async () => {
      // Nothing else knows the sibling's name, so a rename that fails has to
      // clear it or it lingers forever.
      const pidFileAsDirectory = join(tempDir.name, "pid-as-directory");

      mkdirSync(pidFileAsDirectory);

      const blocked = new LocalDevDBServer({
        port: await findFreePort(),
        user: "blocked_user",
        password: "blocked_password",
        database: "blocked_database",
        dataDir: join(tempDir.name, "unused-pgdata"),
        pidFile: pidFileAsDirectory,
        onExit: () => {},
      });

      const writer = blocked as unknown as PidWriter;

      await expect(writer.writePidRecord(process.pid)).rejects.toThrow();

      expect(writer.pidRecord).toBeNull();
      expect(siblings()).toEqual([]);
    });

    it("does not remove a record that replaced its own", async () => {
      // A child's `close` can fire long after the process died, because an
      // inherited stdio handle keeps it pending. By then another server may
      // have written its own record over ours. Releasing on the strength of
      // having once written one would delete that live server's record.
      const writer = server as unknown as PidWriter;

      await writer.writePidRecord(4242);

      // Somebody else takes the file over while our release is still pending.
      writeFileSync(pidFile, foreignRecord(9999));

      await writer.releasePidRecord();

      expect(JSON.parse(readFileSync(pidFile, "utf8")).pid).toBe(9999);
      expect(writer.pidRecord).toBeNull();
      expect(claims()).toEqual([]);
    });

    it("does not remove a replacement record that names the same PID", async () => {
      // The number is not the token. Our child exits, the OS hands its PID to
      // a replacement server, and that server writes its own record before our
      // delayed `close` runs. Matching on the PID alone recognizes that live
      // record as ours and deletes it, leaving a running server unrecorded.
      const writer = server as unknown as PidWriter;

      await writer.writePidRecord(4242);

      const replacement = foreignRecord(4242);

      writeFileSync(pidFile, replacement);

      await writer.releasePidRecord();

      expect(readFileSync(pidFile, "utf8")).toBe(replacement);
      expect(claims()).toEqual([]);
    });

    it("does not delete a record that replaced its own inside the gap", async () => {
      // Reading the shared path and then unlinking the shared path are two
      // steps. Another server renaming its own record into place between them
      // used to have the unlink delete that live record after all. The record
      // is claimed with a rename first, so the delete decision is made on a
      // path nothing else can reach.
      const writer = server as unknown as PidWriter;

      await writer.writePidRecord(4242);

      // Stands in for that other server, landing in the window that used to
      // be unguarded: after our own record has been recognized, before it is
      // taken out of the way.
      const realPidRecordIsOurs = writer.pidRecordIsOurs.bind(writer);
      let replaced = false;

      writer.pidRecordIsOurs = async (path: string, ownRecord: string) => {
        const answer = await realPidRecordIsOurs(path, ownRecord);

        if (!replaced) {
          replaced = true;
          writeFileSync(pidFile, foreignRecord(9999));
        }

        return answer;
      };

      await writer.releasePidRecord();

      // Put back rather than deleted, and the claim tidied away.
      expect(existsSync(pidFile)).toBe(true);
      expect(JSON.parse(readFileSync(pidFile, "utf8")).pid).toBe(9999);
      expect(claims()).toEqual([]);
    });

    it("leaves the newest record alone when one arrives during the claim", async () => {
      // The restore must never overwrite: by the time it runs, a third record
      // may hold the name, and it is newer than the one being put back.
      const writer = server as unknown as PidWriter;

      await writer.writePidRecord(4242);

      const realPidRecordIsOurs = writer.pidRecordIsOurs.bind(writer);
      const realReadClaimedRecord = writer.readClaimedRecord.bind(writer);

      // Recognized as ours, and then another server replaces it, so the claim
      // picks up theirs rather than ours.
      writer.pidRecordIsOurs = async (path: string, ownRecord: string) => {
        const answer = await realPidRecordIsOurs(path, ownRecord);

        writeFileSync(pidFile, foreignRecord(9999));

        return answer;
      };

      // Reading the claimed record is the one step between the rename that
      // takes the name and the link that gives it back, so a third writer
      // lands here or nowhere.
      writer.readClaimedRecord = async (path: string) => {
        const held = await realReadClaimedRecord(path);

        writeFileSync(pidFile, foreignRecord(7777));

        return held;
      };

      await writer.releasePidRecord();

      expect(JSON.parse(readFileSync(pidFile, "utf8")).pid).toBe(7777);
      expect(claims()).toEqual([]);
    });

    it("removes its own record, and only once", async () => {
      const writer = server as unknown as PidWriter;

      await writer.writePidRecord(4242);
      await writer.releasePidRecord();

      expect(existsSync(pidFile)).toBe(false);

      // A second release must not reach the unlink at all: by then the file
      // may belong to somebody else.
      writeFileSync(pidFile, JSON.stringify({ pid: 9999 }));
      await writer.releasePidRecord();

      expect(existsSync(pidFile)).toBe(true);
      expect(claims()).toEqual([]);
    });
  });

  it("should not delete a PID file it did not write when startup refuses", async () => {
    // Startup can refuse before spawning anything — here because a live
    // process at the recorded PID cannot be identified. The failed-start
    // cleanup must not then remove the PID file, since it describes somebody
    // else's server and is the only record of it.
    const otherPidFile = join(tempDir.name, ".other_pg_pid");
    // A stand-in that looks like PostgreSQL but names no data directory, so it
    // cannot be tied to this cluster or ruled out. Identification reads the
    // executable name, so the copy must BE the executable — a shebang script
    // would report its interpreter instead.
    const standIn = join(
      tempDir.name,
      process.platform === "win32" ? "postgres.exe" : "postgres",
    );
    const keepAlive = join(tempDir.name, "keepalive.js");

    copyFileSync(process.execPath, standIn);

    if (process.platform !== "win32") {
      chmodSync(standIn, 0o755);
    }

    writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

    const child = spawn(standIn, [keepAlive, "-p", "5433"], {
      stdio: "ignore",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(otherPidFile, String(child.pid));

    // A file where the data directory should be. Scaffolding rather than the
    // thing under test: it guarantees this start cannot succeed by any route,
    // so a passing assertion below is the identity refusal and not a server
    // that happened to come up. Nothing here reaches initdb at all.
    const brokenDataDir = join(tempDir.name, "not_a_directory");

    writeFileSync(brokenDataDir, "not a data directory");

    const blocked = new LocalDevDBServer({
      port: await findFreePort(),
      user: "blocked_user",
      password: "blocked_password",
      database: "blocked_database",
      dataDir: brokenDataDir,
      pidFile: otherPidFile,
      onExit: () => {},
    });

    // The refusal happens before anything is spawned: a process is alive at
    // the recorded PID and cannot be identified, so it is neither safe to
    // signal nor safe to forget.
    await expect(blocked.start()).rejects.toThrow(/could not be identified/i);

    expect(existsSync(otherPidFile)).toBe(true);
    // Startup must not have written its own record over the preserved one.
    expect(readFileSync(otherPidFile, "utf8").trim()).toBe(String(child.pid));

    child.kill("SIGKILL");
  }, 60000);

  it("refuses rather than orphan a live server for another cluster", async () => {
    // One pidFile path shared across two data directories — what you get by
    // leaving pidFile at its default and changing dataDir. The record names
    // the OLD cluster, and a process is still alive at that PID. Carrying on
    // would either delete that record or overwrite it with ours the moment we
    // spawn, and either way nothing on disk would say what is holding that
    // server's port. One file cannot describe two clusters, so startup has to
    // refuse — and must leave the record it refused over intact.
    const sharedPidFile = join(tempDir.name, ".shared_pg_pid");
    const otherDataDir = join(tempDir.name, "pgdata-previous");

    // Genuinely that cluster's server: a postgres naming its data directory.
    // A bare process holding the number is not enough to refuse over, and
    // should not be — after a reboot that is an ordinary thing for a
    // low-numbered PID, with no server anywhere to protect.
    const standIn = join(
      tempDir.name,
      process.platform === "win32" ? "postgres.exe" : "postgres",
    );
    const keepAlive = join(tempDir.name, "orphan-keepalive.js");

    copyFileSync(process.execPath, standIn);

    if (process.platform !== "win32") {
      chmodSync(standIn, 0o755);
    }

    writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

    const child = spawn(standIn, [keepAlive, "-D", otherDataDir], {
      stdio: "ignore",
    });

    await new Promise((resolve) => setTimeout(resolve, 400));

    const record = {
      pid: child.pid,
      startedAt: Date.now(),
      dataDir: otherDataDir,
      port: 5599,
      // Written during this boot; a record predating it describes a server
      // that is gone, and is deliberately not protected.
      bootTime: getSystemBootTime(),
    };

    writeFileSync(sharedPidFile, JSON.stringify(record));

    const moved = new LocalDevDBServer({
      port: await findFreePort(),
      user: "moved_user",
      password: "moved_password",
      database: "moved_database",
      dataDir: join(tempDir.name, "pgdata-current"),
      pidFile: sharedPidFile,
      onExit: () => {},
    });

    try {
      await expect(moved.start()).rejects.toThrow(
        /another data directory|orphan/i,
      );

      // The other cluster's record must have survived byte for byte.
      expect(readFileSync(sharedPidFile, "utf8")).toBe(JSON.stringify(record));
    } finally {
      child.kill("SIGKILL");
    }
  }, 60000);

  it("checks the start-time fingerprint before each signal", async () => {
    // Identity is rechecked before every signal, and a start time is what
    // makes that possible. Re-deriving identity from the command line is
    // ambiguous in both directions — undecidable both for a server that IS
    // ours and for a replacement nothing can be read about — and those need
    // opposite answers. A PID cannot be reused without the process behind it
    // changing, so the start time captured when the escalation was authorized
    // separates the two.
    type Internals = {
      confirmSignalTarget(
        pid: number,
        target: {
          kind: "recorded";
          startedAt: number | null;
          fingerprint: number | null;
        },
      ): "ours" | "gone" | "pid-reused" | "unknown";
    };

    const internals = server as unknown as Internals;

    // A stand-in named postgres that names no data directory, so it can be
    // neither confirmed as this cluster nor ruled out by the command line.
    const standIn = join(
      tempDir.name,
      process.platform === "win32" ? "postgres.exe" : "postgres",
    );
    const keepAlive = join(tempDir.name, "recheck-keepalive.js");

    copyFileSync(process.execPath, standIn);

    if (process.platform !== "win32") {
      chmodSync(standIn, 0o755);
    }

    writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

    const undecidable = spawn(standIn, [keepAlive], { stdio: "ignore" });

    await new Promise((resolve) => setTimeout(resolve, 400));

    const pid = undecidable.pid as number;
    const fingerprint = getProcessStartTime(pid);

    if (fingerprint === null) {
      undecidable.kill("SIGKILL");

      return;
    }

    try {
      // Unreadable command line, matching fingerprint: still ours. Without
      // this the escalation would abandon a live server it was already
      // authorized to stop.
      expect(
        internals.confirmSignalTarget(pid, {
          kind: "recorded",
          startedAt: null,
          fingerprint,
        }),
      ).toBe("ours");

      // A nearby timestamp is still a different process. Liveness only says
      // the PID is occupied, and allowing clock tolerance here would signal a
      // replacement that acquired the number soon after PostgreSQL exited.
      expect(
        internals.confirmSignalTarget(pid, {
          kind: "recorded",
          startedAt: null,
          fingerprint: fingerprint - 500,
        }),
      ).toBe("pid-reused");

      // The same PID, but the process behind it is not the one authorized —
      // which is what PID reuse looks like from here.
      expect(
        internals.confirmSignalTarget(pid, {
          kind: "recorded",
          startedAt: null,
          fingerprint: fingerprint - 600_000,
        }),
      ).toBe("pid-reused");

      expect(
        internals.confirmSignalTarget(999999, {
          kind: "recorded",
          startedAt: null,
          fingerprint,
        }),
      ).toBe("gone");
    } finally {
      undecidable.kill("SIGKILL");
    }
  }, 30000);

  it("takes the fingerprint from the verification, not a later read", async () => {
    // The fingerprint has to be the value identity was established from. A
    // read taken afterwards is a fresh observation of whatever holds the
    // number then, and if it changed hands in between no timestamp test
    // separates the replacement from the original — they can fall arbitrarily
    // close together.
    type Internals = {
      captureSignalFingerprint(
        pid: number,
        observedStartTime: number | null,
      ): { fingerprint: number | null } | null;
    };

    const internals = server as unknown as Internals;

    // A live stand-in named postgres serving THIS data directory, so its
    // command line alone identifies it — the one way a PID is verified
    // without a clock being consulted at all.
    const dataDir = join(tempDir.name, "pgdata");
    const standIn = join(
      tempDir.name,
      process.platform === "win32" ? "postgres.exe" : "postgres",
    );
    const keepAlive = join(tempDir.name, "capture-keepalive.js");

    copyFileSync(process.execPath, standIn);

    if (process.platform !== "win32") {
      chmodSync(standIn, 0o755);
    }

    writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

    const serving = spawn(standIn, [keepAlive, "-D", dataDir], {
      stdio: "ignore",
    });
    // An ordinary process, standing in for one that took a recycled number.
    const unrelated = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 1e6)"],
      { stdio: "ignore" },
    );

    await new Promise((resolve) => setTimeout(resolve, 400));

    const servingPid = serving.pid as number;

    try {
      // An observed value is carried straight through — it is not re-read, and
      // it is not compared against the record. Comparing would only bound the
      // gap between two timestamps, which is not identity.
      expect(internals.captureSignalFingerprint(servingPid, 4242)).toEqual({
        fingerprint: 4242,
      });

      // Nothing observed means the PID was verified without a clock, by its
      // command line naming this data directory. The bracketed recheck proves
      // that observation was coherent, but later checks must keep using the
      // command line instead of promoting a coarse timestamp to identity.
      expect(internals.captureSignalFingerprint(servingPid, null)).toEqual({
        fingerprint: null,
      });

      // The same, but the number is held by something that is not serving this
      // cluster: nothing ties it to the reported server, so nothing may be
      // signaled.
      expect(
        internals.captureSignalFingerprint(unrelated.pid as number, null),
      ).toBeNull();

      // A process that has gone away during the check is a stop, not a number
      // changing hands, and must not fail startup.
      expect(internals.captureSignalFingerprint(999999, null)).toEqual({
        fingerprint: null,
      });
    } finally {
      serving.kill("SIGKILL");
      unrelated.kill("SIGKILL");
    }
  }, 30000);

  it("does not refuse over another cluster's record whose number was reused", async () => {
    // The different-cluster refusal is a hard stop, so it needs evidence that
    // the other cluster's server is actually there — not merely that its
    // number is in use. After a reboot a low-numbered PID is very likely held
    // by something unrelated, and a bare liveness check would refuse on every
    // run with no server anywhere to protect.
    type Internals = {
      otherClusterStillLive(pid: number, otherDataDir: string | null): boolean;
    };

    const internals = server as unknown as Internals;
    const otherDataDir = join(tempDir.name, "pgdata-previous");

    const standIn = join(
      tempDir.name,
      process.platform === "win32" ? "postgres.exe" : "postgres",
    );
    const keepAlive = join(tempDir.name, "other-keepalive.js");

    copyFileSync(process.execPath, standIn);

    if (process.platform !== "win32") {
      chmodSync(standIn, 0o755);
    }

    writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

    // Genuinely that cluster's server.
    const live = spawn(standIn, [keepAlive, "-D", otherDataDir], {
      stdio: "ignore",
    });
    // Merely holding a number the record happens to name.
    const unrelated = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 1e6)"],
      { stdio: "ignore" },
    );

    await new Promise((resolve) => setTimeout(resolve, 400));

    try {
      expect(
        internals.otherClusterStillLive(live.pid as number, otherDataDir),
      ).toBe(true);

      expect(
        internals.otherClusterStillLive(unrelated.pid as number, otherDataDir),
      ).toBe(false);

      expect(internals.otherClusterStillLive(999999, otherDataDir)).toBe(false);
    } finally {
      live.kill("SIGKILL");
      unrelated.kill("SIGKILL");
    }
  }, 30000);

  it("will not confirm a target on a timestamp when it has no fingerprint", async () => {
    // With no fingerprint, the command line naming this data directory is what
    // authorized the escalation, so it is what has to hold again. Offering a
    // recorded start time as well would let the recheck succeed on the
    // timestamp branch, which accepts a PostgreSQL naming no data directory at
    // all — a replacement that inherited PGDATA.
    type Internals = {
      confirmSignalTarget(
        pid: number,
        target: {
          kind: "recorded";
          startedAt: number | null;
          fingerprint: number | null;
        },
      ): "ours" | "gone" | "pid-reused" | "unknown";
    };

    const internals = server as unknown as Internals;
    const standIn = join(
      tempDir.name,
      process.platform === "win32" ? "postgres.exe" : "postgres",
    );
    const keepAlive = join(tempDir.name, "timestamp-keepalive.js");

    copyFileSync(process.execPath, standIn);

    if (process.platform !== "win32") {
      chmodSync(standIn, 0o755);
    }

    writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

    // A PostgreSQL that names NO data directory — the PGDATA-inheriting shape.
    const inherited = spawn(standIn, [keepAlive], { stdio: "ignore" });

    await new Promise((resolve) => setTimeout(resolve, 400));

    const pid = inherited.pid as number;

    try {
      // Its real start time, offered as the record's, is exactly what the
      // timestamp branch would accept. It must not be enough — and the answer
      // is `unknown` rather than `reused`, because nothing here ruled the
      // process out either, so it is no basis for calling the server stopped.
      expect(
        internals.confirmSignalTarget(pid, {
          kind: "recorded",
          startedAt: getProcessStartTime(pid),
          fingerprint: null,
        }),
      ).toBe("unknown");
    } finally {
      inherited.kill("SIGKILL");
    }
  }, 30000);

  it("aborts the escalation when nothing can confirm the target", async () => {
    // No fingerprint means the platform cannot read a start time, so reuse
    // cannot be detected at all. The authorization must then have come from
    // the command line naming this data directory — so require exactly that
    // again, and abort on anything less.
    type Internals = {
      confirmSignalTarget(
        pid: number,
        target: {
          kind: "recorded";
          startedAt: number | null;
          fingerprint: number | null;
        },
      ): "ours" | "gone" | "pid-reused" | "unknown";
    };

    const internals = server as unknown as Internals;
    const unrelated = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 1e6)"],
      { stdio: "ignore" },
    );

    await new Promise((resolve) => setTimeout(resolve, 400));

    try {
      // Positively ruled out rather than merely unconfirmed: a live PID that
      // is demonstrably some other program is how PID reuse looks from here.
      expect(
        internals.confirmSignalTarget(unrelated.pid as number, {
          kind: "recorded",
          startedAt: null,
          fingerprint: null,
        }),
      ).toBe("pid-reused");
    } finally {
      unrelated.kill("SIGKILL");
    }
  }, 30000);

  it("settles runPgCommand when the binary cannot be spawned", async () => {
    // A spawn failure emits "error" and never emits "close". Without an error
    // listener the promise never settles, so terminateProcess() hangs instead
    // of falling back to signals — and on the startup path there is no
    // backstop timer to rescue it.
    type Internals = {
      runPgCommand(
        command: string,
        args: string[],
        options?: { silent?: boolean },
      ): Promise<{ stdout: string; stderr: string; code: number | null }>;
    };

    const internals = server as unknown as Internals;

    const result = await Promise.race([
      internals.runPgCommand(join(tempDir.name, "definitely_not_here"), [], {
        silent: true,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("runPgCommand never settled")), 5000),
      ),
    ]);

    expect((result as { code: number | null }).code).not.toBe(0);
  }, 15000);

  it("should keep the PID record when a failed start cannot be cleaned up", async () => {
    // A process surviving even SIGKILL cannot be provoked with one we own, so
    // only the kill outcome is faked; the surrounding logic is the real thing.
    type Internals = {
      cleanupFailedStart(): Promise<boolean>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    await server.start();

    expect(existsSync(pidFile)).toBe(true);

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => "failed";

    const cleanedUp = await internals.cleanupFailedStart();

    expect(cleanedUp).toBe(false);
    // The server may still be holding the port, so its record must survive.
    expect(existsSync(pidFile)).toBe(true);

    internals.terminateProcess = originalTerminate;

    // A later stop() must still complete the lifecycle. The close handler was
    // detached during the failed cleanup, so if it was not reattached the
    // process would be stopped while the PID file and the keep-alive interval
    // were both left hanging — and stop() would time out waiting for a
    // lifecycle that never finished.
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(existsSync(pidFile)).toBe(false);
    expect(exitCalled).toBe(false);
  }, 60000);

  it("does not report a running server after a spawn that never got a PID", async () => {
    // A spawn that fails emits "error" and never "close", and the handle it
    // leaves has no PID at all, so the escalation in cleanupFailedStart has
    // nothing to signal and skips the block that drops the reference. Left on
    // the instance, that handle is exactly what start() reads as "already
    // running" — so a retry resolved with nothing behind it, and stop() found
    // nothing to stop either.
    type Internals = {
      pgProcess: ReturnType<typeof spawn> | null;
      cleanupFailedStart(): Promise<boolean>;
    };

    const internals = server as unknown as Internals;
    const failed = spawn(join(tempDir.name, "no-such-postgres"), []);

    await new Promise<void>((resolve) => failed.once("error", () => resolve()));

    expect(failed.pid).toBeUndefined();

    internals.pgProcess = failed;

    expect(await internals.cleanupFailedStart()).toBe(true);
    expect(internals.pgProcess).toBeNull();

    // The consequence the stale reference was hiding: the retry has to start a
    // server rather than report the failed spawn as one.
    await server.start();

    const status = await getLocalDevDBServerStatus({
      pidFile,
      dataDir: join(tempDir.name, "pgdata"),
    });

    expect(status.running).toBe(true);
  }, 90000);

  it("should not exit the host when a failed start's leftover server later dies", async () => {
    // The other half of the case above. start() has already rejected and the
    // caller has handled it, so when the server that outlived SIGKILL finally
    // goes, that is not an unrequested crash — a shutdown was asked for here
    // and merely could not be completed. Reading it as a crash routes through
    // cleanupAndExit, which calls onExit and, by default, process.exit: the
    // host process dies asynchronously over a failure it already dealt with.
    type Internals = {
      cleanupFailedStart(): Promise<boolean>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
      pgProcess: { pid?: number } | null;
    };

    await server.start();

    const internals = server as unknown as Internals;
    const pid = internals.pgProcess?.pid;

    expect(pid).toBeDefined();

    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => "failed";

    expect(await internals.cleanupFailedStart()).toBe(false);

    internals.terminateProcess = originalTerminate;

    // Nobody calls stop(). The server dies on its own, the way the stubborn
    // one this path exists for eventually would.
    process.kill(pid as number, "SIGKILL");

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(internals.pgProcess).toBeNull();
    expect(existsSync(pidFile)).toBe(false);
    expect(exitCalled).toBe(false);
  }, 60000);

  it("should refuse a restart while a failed start's leftover server is held", async () => {
    // cleanupFailedStart deliberately puts the process reference back when the
    // child outlives even SIGKILL, so a later stop() can try again. That same
    // reference is what the "already running" guard reads, and it used to take
    // it at face value: the caller handled start()'s rejection, called start()
    // again, and got a RESOLVED promise reporting a server that had never come
    // up. Refusing is the only honest answer while that child is still held.
    type Internals = {
      cleanupFailedStart(): Promise<boolean>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
      pgProcess: { pid?: number } | null;
    };

    await server.start();

    const internals = server as unknown as Internals;
    const pid = internals.pgProcess?.pid;

    expect(pid).toBeDefined();

    // A process that survives SIGKILL cannot be provoked with one we own, so
    // only the kill outcome is faked; the surrounding logic is the real thing.
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => "failed";

    expect(await internals.cleanupFailedStart()).toBe(false);

    internals.terminateProcess = originalTerminate;

    // Reported as its own state rather than through the child's exit status,
    // which cannot tell this apart from a healthy server or an absent one:
    // both of those rows promise a start() that in fact throws.
    expect(server.getLifecycleState()).toBe("unstoppable");

    await expect(server.start()).rejects.toThrow(/could not be stopped/i);

    // And the refusal is specific to that held child rather than a permanent
    // wedge: once it is genuinely stopped, the instance works again.
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));

    await server.start();

    expect(internals.pgProcess).not.toBeNull();
    expect(exitCalled).toBe(false);
  }, 90000);

  it("should not delete a PID record that was replaced mid-cleanup", async () => {
    // cleanupExistingProcess decides from a status read taken before the
    // escalation, and the escalation takes seconds. A postmaster that claimed
    // this data directory inside that window is described by the very files
    // the cleanup then deletes, and postmaster.pid is PostgreSQL's own
    // interlock against two postmasters on one data directory, so deleting a
    // live one removes the last thing standing between a second server and
    // these files.
    //
    // A real second postmaster cannot be conjured at that instant, but what
    // identifies one can be: taking the directory means writing its own
    // record, so replacing the record is the thing the guard actually looks
    // for.
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    const dataDir = join(tempDir.name, "pgdata");
    const postmasterPidFile = join(dataDir, "postmaster.pid");

    await server.start();

    expect(existsSync(postmasterPidFile)).toBe(true);

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => {
      // Somebody else's record, in the window between the decision and the
      // deletion. Only the PID line changes, so the file stays a well-formed
      // postmaster.pid and it is the record's identity being recognized rather
      // than a parse failure.
      const lines = readFileSync(postmasterPidFile, "utf8").split("\n");

      lines[0] = String(Number(lines[0]) + 1);
      writeFileSync(postmasterPidFile, lines.join("\n"));

      return "gone";
    };

    await expect(internals.cleanupExistingProcess()).rejects.toThrow(
      /was not there when the previous server/i,
    );

    // The point of the refusal: the record that replaced ours is still there.
    expect(existsSync(postmasterPidFile)).toBe(true);

    internals.terminateProcess = originalTerminate;

    await server.stop();

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should still remove a stale record the escalation accounted for", async () => {
    // The other half. An unchanged record describes the server just stopped,
    // whatever has become of the number it names, so it is the cleanup's to
    // remove. Recognizing the record rather than re-probing that number is
    // what keeps this case from refusing: a PID recycled to something
    // unidentifiable would make a provably stale file look undecidable.
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    const dataDir = join(tempDir.name, "pgdata");
    const postmasterPidFile = join(dataDir, "postmaster.pid");

    await server.start();

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    // Stops nothing and changes nothing, so the records are exactly the ones
    // the cleanup set out to account for.
    internals.terminateProcess = async () => "gone";

    await internals.cleanupExistingProcess();

    expect(existsSync(postmasterPidFile)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);

    internals.terminateProcess = originalTerminate;

    await server.stop();

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should claim a PID record before deciding whether to delete it", async () => {
    // Reading a path and then unlinking that path are two steps, and a record
    // written between them is the one that gets deleted. The rename closes
    // that: whatever comes back is held by this call alone, so the decision is
    // made about the record in hand rather than about whatever the shared name
    // points at by the time the unlink lands. A record that turns out not to
    // be ours has to survive the round trip intact.
    type Internals = {
      removeRecordIfUnchanged(
        path: string,
        accounted: string,
        identify: (raw: string) => string,
      ): Promise<{ outcome: string }>;
    };

    const internals = server as unknown as Internals;
    const record = join(tempDir.name, "claimed-record");

    writeFileSync(record, "the record that is actually there");

    // Somebody else's. It has to go back exactly as it was.
    expect(
      (
        await internals.removeRecordIfUnchanged(
          record,
          "a different record",
          (raw) => raw,
        )
      ).outcome,
    ).toBe("restored");
    expect(existsSync(record)).toBe(true);
    expect(readFileSync(record, "utf8")).toBe(
      "the record that is actually there",
    );

    // No claim file left beside it either way.
    expect(
      readdirSync(tempDir.name).filter((name) => name.endsWith(".claim")),
    ).toEqual([]);

    // Ours, so it goes.
    expect(
      (
        await internals.removeRecordIfUnchanged(
          record,
          "the record that is actually there",
          (raw) => raw,
        )
      ).outcome,
    ).toBe("removed");
    expect(existsSync(record)).toBe(false);

    // A claim that cannot be READ is undecidable, not disproof. Reported as
    // `restored`, the callers read it as another server having taken this data
    // directory and refuse a start saying so — over bytes that never changed.
    const unreadable = server as unknown as Internals & {
      readClaimedRecord(
        path: string,
      ): Promise<{ raw: string } | { error: unknown }>;
    };

    writeFileSync(record, "the record that is actually there");

    const originalRead = unreadable.readClaimedRecord.bind(server);
    const readFailure = Object.assign(new Error("EIO"), { code: "EIO" });

    unreadable.readClaimedRecord = async () => ({ error: readFailure });

    const undecidable = (await unreadable.removeRecordIfUnchanged(
      record,
      "the record that is actually there",
      (raw) => raw,
    )) as { outcome: string; error?: unknown };

    unreadable.readClaimedRecord = originalRead;

    expect(undecidable.outcome).toBe("unclaimable");
    expect(undecidable.error).toBe(readFailure);

    // Back exactly as it was, with no claim left beside it.
    expect(readFileSync(record, "utf8")).toBe(
      "the record that is actually there",
    );
    expect(
      readdirSync(tempDir.name).filter((name) => name.endsWith(".claim")),
    ).toEqual([]);

    // Ours again, so it goes.
    expect(
      (
        await internals.removeRecordIfUnchanged(
          record,
          "the record that is actually there",
          (raw) => raw,
        )
      ).outcome,
    ).toBe("removed");

    // Nothing there at all is not a failure, just nothing to do.
    expect(
      (
        await internals.removeRecordIfUnchanged(
          record,
          "anything",
          (raw) => raw,
        )
      ).outcome,
    ).toBe("absent");

    expect(
      readdirSync(tempDir.name).filter((name) => name.endsWith(".claim")),
    ).toEqual([]);
  }, 30000);

  it("should discard a claimed record a third one has already replaced", async () => {
    // Putting a record back fails when a THIRD one took the name meanwhile,
    // and that one is newer than the one in hand, so there is nowhere for this
    // to go. Keeping it would leave a claim file nothing ever reads, one per
    // attempt, under a name nothing looks for. Reported apart from a record
    // that went back, since releasing this instance's own record has a line to
    // log here and nothing to say there.
    type Internals = {
      removeRecordIfUnchanged(
        path: string,
        accounted: string,
        identify: (raw: string) => string,
      ): Promise<{ outcome: string }>;
      readClaimedRecord(
        path: string,
      ): Promise<{ raw: string } | { error: unknown }>;
    };

    const internals = server as unknown as Internals;
    const originalReadClaimedRecord = internals.readClaimedRecord.bind(server);
    const record = join(tempDir.name, "displaced-record");

    writeFileSync(record, "the record that was claimed");

    // The read of the claimed file is the one step between the rename that
    // takes the name and the link that gives it back, so a third writer lands
    // here or nowhere.
    internals.readClaimedRecord = async (path: string) => {
      const held = await originalReadClaimedRecord(path);

      if (path !== record) {
        writeFileSync(record, "a third server's newer record");
      }

      return held;
    };

    try {
      // Not the accounted bytes, so it takes the restore path — and the name
      // is taken by then.
      expect(
        (
          await internals.removeRecordIfUnchanged(
            record,
            "the record this start accounted for",
            (raw) => raw,
          )
        ).outcome,
      ).toBe("discarded");
    } finally {
      internals.readClaimedRecord = originalReadClaimedRecord;
    }

    // The newer record keeps the name, untouched.
    expect(readFileSync(record, "utf8")).toBe("a third server's newer record");

    // And the displaced one is gone rather than stranded beside it.
    expect(
      readdirSync(tempDir.name).filter((name) => name.endsWith(".claim")),
    ).toEqual([]);
  }, 30000);

  it("should report a claim that vanished mid-put-back as an absence", async () => {
    // A temp reaper, or somebody clearing the directory, can take the claim
    // file away between the rename that made it and the put-back. The record
    // then exists nowhere: not at `path`, which this call renamed away, and
    // not at the claim, which something else removed. That is the end state a
    // clean shutdown leaves.
    //
    // Reported as `stranded` it read as a live record standing in the way, and
    // cleanupExistingProcess refused the start over two paths that were both
    // empty, sending a person to look at a claim file that was not there.
    type Internals = {
      removeRecordIfUnchanged(
        path: string,
        accounted: string,
        identify: (raw: string) => string,
      ): Promise<{ outcome: string }>;
      readClaimedRecord(
        path: string,
      ): Promise<{ raw: string } | { error: unknown }>;
    };

    const internals = server as unknown as Internals;
    const originalReadClaimedRecord = internals.readClaimedRecord.bind(server);
    const record = join(tempDir.name, "vanishing-record");

    // Both ways round, because they take different routes out. A claim removed
    // BEFORE the read comes back as the empty string readClaimedRecord maps
    // ENOENT to, so the put-back is the bare `link`; removed AFTER it, there
    // are bytes in hand and the put-back goes through publishWithoutReplacing.
    // Both end at the same ENOENT and both used to be stranded.
    for (const removeBeforeRead of [true, false]) {
      writeFileSync(record, "the record that was claimed");

      internals.readClaimedRecord = async (path: string) => {
        if (path === record) {
          return originalReadClaimedRecord(path);
        }

        if (removeBeforeRead) {
          unlinkSync(path);

          return originalReadClaimedRecord(path);
        }

        const held = await originalReadClaimedRecord(path);

        unlinkSync(path);

        return held;
      };

      try {
        expect(
          (
            await internals.removeRecordIfUnchanged(
              record,
              "the record this start accounted for",
              (raw) => raw,
            )
          ).outcome,
        ).toBe("absent");
      } finally {
        internals.readClaimedRecord = originalReadClaimedRecord;
      }

      // And the name really is free, which is what "absent" promised.
      expect(existsSync(record)).toBe(false);
      expect(
        readdirSync(tempDir.name).filter((name) => name.endsWith(".claim")),
      ).toEqual([]);
    }
  }, 30000);

  it("should not read a vanished claim as an absence while the name is taken", async () => {
    // `link` resolves its source before its destination, so a claim that has
    // gone reports ENOENT even where a third record already holds the name —
    // the same errno as the case above, over a data directory that is anything
    // but free. Calling that an absence would let the start proceed against
    // files something else is using, so it has to come back as the discard it
    // is.
    type Internals = {
      removeRecordIfUnchanged(
        path: string,
        accounted: string,
        identify: (raw: string) => string,
      ): Promise<{ outcome: string }>;
      readClaimedRecord(
        path: string,
      ): Promise<{ raw: string } | { error: unknown }>;
    };

    const internals = server as unknown as Internals;
    const originalReadClaimedRecord = internals.readClaimedRecord.bind(server);
    const record = join(tempDir.name, "overtaken-record");

    writeFileSync(record, "the record that was claimed");

    internals.readClaimedRecord = async (path: string) => {
      if (path === record) {
        return originalReadClaimedRecord(path);
      }

      // The reaper and the third server, in the one window either can land in.
      unlinkSync(path);
      writeFileSync(record, "a third server's newer record");

      return originalReadClaimedRecord(path);
    };

    try {
      expect(
        (
          await internals.removeRecordIfUnchanged(
            record,
            "the record this start accounted for",
            (raw) => raw,
          )
        ).outcome,
      ).toBe("discarded");
    } finally {
      internals.readClaimedRecord = originalReadClaimedRecord;
    }

    // The newer record keeps the name, untouched.
    expect(readFileSync(record, "utf8")).toBe("a third server's newer record");
  }, 30000);

  it("should not delete another cluster's live record it never examined", async () => {
    // probeStatusFromFiles answers from postmaster.pid and returns without
    // reading strataline's own record at all, so a start whose own cluster
    // verifies forms no view of that file whatsoever. The removal at the end
    // used to delete it anyway on the strength of its bytes not having changed
    // across the probe, which is not the same thing as having been looked at.
    //
    // Point two data directories at one pidFile and that is the record of
    // somebody else's running server, erased on the way past by a start that
    // never considered it. statusFromPidFile has refused exactly this since
    // the different-cluster rule went in; it simply never ran here.
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    const dataDir = join(tempDir.name, "pgdata");
    const postmasterPidFile = join(dataDir, "postmaster.pid");
    const otherDataDir = join(tempDir.name, "pgdata-other");

    // A stand-in rather than a real second cluster: what makes it that
    // cluster's server is its command line naming that directory, which is
    // the only thing verifyPid reads here.
    const standIn = join(
      tempDir.name,
      process.platform === "win32" ? "postgres.exe" : "postgres",
    );
    const keepAlive = join(tempDir.name, "other-cluster-keepalive.js");

    copyFileSync(process.execPath, standIn);

    if (process.platform !== "win32") {
      chmodSync(standIn, 0o755);
    }

    writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

    await server.start();

    const other = spawn(standIn, [keepAlive, "-D", otherDataDir], {
      stdio: "ignore",
    });

    // Long enough for the process to be there to observe.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const foreignRecord = JSON.stringify({
      pid: other.pid,
      startedAt: Date.now(),
      dataDir: otherDataDir,
      port: serverPort + 1,
      bootTime: getSystemBootTime(),
      uid: process.geteuid?.() ?? null,
    });

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    // Stops nothing and changes nothing, so the records reaching the removal
    // are exactly the ones the cleanup set out to account for.
    internals.terminateProcess = async () => "gone";

    try {
      // The shared pidFile now holds that server's live record.
      writeFileSync(pidFile, foreignRecord);

      await expect(internals.cleanupExistingProcess()).rejects.toThrow(
        /another data directory/,
      );

      // Left exactly as it was. Deleting it would leave that server running
      // with nothing recording it.
      expect(existsSync(pidFile)).toBe(true);
      expect(readFileSync(pidFile, "utf8")).toBe(foreignRecord);

      // And nothing half-done beside it: a record put back has to leave no
      // claim behind.
      expect(
        readdirSync(tempDir.name).filter((name) => name.endsWith(".claim")),
      ).toEqual([]);

      // postmaster.pid still goes. It is this cluster's, this start examined
      // it, and removing it before a later refusal loses nothing.
      expect(existsSync(postmasterPidFile)).toBe(false);
    } finally {
      other.kill("SIGKILL");
      internals.terminateProcess = originalTerminate;

      // Tolerant, so that a regression is reported by the assertion above
      // rather than by the teardown tripping over the very file it deleted.
      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
      }

      await server.stop();
    }

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should not delete a live foreign server's old-format record", async () => {
    // A legacy record is the bare PID and nothing else, so unlike the
    // structured form it names no data directory and cannot be told apart from
    // this cluster's own by reading it. That must not make it the one record
    // that reaches the removal unexamined. What the record cannot say, the
    // live process can: strataline starts PostgreSQL with an absolute -D.
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    const otherDataDir = join(tempDir.name, "pgdata-legacy-other");
    const standIn = join(
      tempDir.name,
      process.platform === "win32" ? "postgres.exe" : "postgres",
    );
    const keepAlive = join(tempDir.name, "legacy-keepalive.js");

    copyFileSync(process.execPath, standIn);

    if (process.platform !== "win32") {
      chmodSync(standIn, 0o755);
    }

    writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

    await server.start();

    const other = spawn(standIn, [keepAlive, "-D", otherDataDir], {
      stdio: "ignore",
    });

    await new Promise((resolve) => setTimeout(resolve, 400));

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => "gone";

    try {
      // Exactly what strataline 4.0.3 and earlier wrote.
      writeFileSync(pidFile, String(other.pid));

      await expect(internals.cleanupExistingProcess()).rejects.toThrow(
        /another data directory/,
      );

      expect(readFileSync(pidFile, "utf8")).toBe(String(other.pid));
    } finally {
      other.kill("SIGKILL");
      internals.terminateProcess = originalTerminate;

      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
      }

      await server.stop();
    }

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should keep the command snapshot that identified an old-format record", async () => {
    // The verifier's command read is the evidence that this bare PID belongs
    // to a live foreign server. A second read can fail transiently, and that
    // failure must not erase the evidence and license deleting its record.
    // This PID is deliberately absent, so the old second OS read returned
    // null even though the injected verification snapshot was decisive.
    type Internals = {
      otherClusterStillLive(pid: number, dataDir: string | null): boolean;
      pidVerificationProbes: ProcessProbes;
      refuseUnexaminedPidRecord(accounted: string): Promise<void>;
    };

    const internals = server as unknown as Internals;
    const originalOtherClusterStillLive = internals.otherClusterStillLive;
    const originalProbes = internals.pidVerificationProbes;
    const absentPid = 2_147_483_647;
    const otherDataDir = join(tempDir.name, "snapshot-other");
    let commandReads = 0;

    internals.pidVerificationProbes = {
      isAlive: () => true,
      command: () => {
        commandReads++;

        return `postgres -D ${otherDataDir}`;
      },
      startTime: () => null,
      bootTime: () => null,
      uid: () => null,
    };
    internals.otherClusterStillLive = () => true;

    try {
      await expect(
        internals.refuseUnexaminedPidRecord(String(absentPid)),
      ).rejects.toThrow(/another data directory/i);

      expect(commandReads).toBe(1);
    } finally {
      internals.pidVerificationProbes = originalProbes;
      internals.otherClusterStillLive = originalOtherClusterStillLive;
    }
  });

  it("removes a foreign record whose owner proves its server is gone", async () => {
    // The refusal is a hard stop that stands until somebody deletes the file
    // by hand, so it takes evidence that the other server is actually there.
    // A uid mismatch is evidence it is not: a process cannot change uid after
    // exec, so whatever holds the number now was never that server, whichever
    // directory the record named.
    //
    // The owner is all there is to go on here. A readable command line would
    // settle it without the uid — and settle it the other way if it named that
    // directory, since a live server for it is a live server whoever owns it —
    // so the case where the uid decides anything is the one where nothing else
    // could be read. Withheld, that leaves the PID undecidable and the start
    // refuses, on every run, over a number it had proof was somebody else's.
    type Internals = {
      pidVerificationProbes: ProcessProbes;
      refuseUnexaminedPidRecord(accounted: string): Promise<void>;
    };

    const internals = server as unknown as Internals;
    const originalProbes = internals.pidVerificationProbes;
    const otherDataDir = join(tempDir.name, "owned-by-somebody-else");

    internals.pidVerificationProbes = {
      isAlive: () => true,
      command: () => null,
      startTime: () => null,
      bootTime: () => null,
      // Running as a different user than the record says started it.
      uid: () => 501,
    };

    const record = JSON.stringify({
      pid: 4242,
      startedAt: Date.now(),
      dataDir: otherDataDir,
      port: 5599,
      bootTime: null,
      uid: 502,
    });

    // Returning rather than throwing IS the outcome: refuseUnexaminedPidRecord
    // either refuses or lets the removal that follows it go ahead, so a start
    // that gets past here is one that will delete the record.
    let refused: unknown = null;

    try {
      await internals.refuseUnexaminedPidRecord(record);
    } catch (e) {
      refused = e;
    } finally {
      internals.pidVerificationProbes = originalProbes;
    }

    expect(refused).toBeNull();
  });

  it("keeps refusing a foreign record when only the clock says its server is gone", async () => {
    // The refusal that protects another cluster's live record may not rest on
    // a clock. Both the recorded start time and the recorded boot time are
    // readings an adjustment moves on the live side and leaves on the recorded
    // side, so a host whose clock stepped back since the record was written
    // disagrees with a server that is running right now — and reading that as
    // proof the server is gone deletes the only thing recording it.
    //
    // Nothing else can be read here, which is what makes the clock decisive if
    // it is consulted at all: a flat command line on macOS, a postmaster that
    // inherited PGDATA and names no -D, or a `ps` that simply would not answer
    // all reach this state, and the uid matches because it is the same user's
    // server either way.
    type Internals = {
      pidVerificationProbes: ProcessProbes;
      refuseUnexaminedPidRecord(accounted: string): Promise<void>;
    };

    const internals = server as unknown as Internals;
    const originalProbes = internals.pidVerificationProbes;
    const otherDataDir = join(tempDir.name, "clock-stepped-other");
    const now = Date.now();

    internals.pidVerificationProbes = {
      isAlive: () => true,
      command: () => null,
      // Two minutes BEFORE the record claims its server started, which is what
      // a clock stepped back after the record was written looks like from
      // here. Nothing about it says the process changed.
      startTime: () => now - 120_000,
      bootTime: () => now - 600_000,
      // The same user, so the one check a clock cannot move says nothing.
      uid: () => 501,
    };

    const record = JSON.stringify({
      pid: 4243,
      startedAt: now,
      dataDir: otherDataDir,
      port: 5598,
      bootTime: now - 600_000,
      uid: 501,
    });

    let refused: unknown = null;

    try {
      await internals.refuseUnexaminedPidRecord(record);
    } catch (e) {
      refused = e;
    } finally {
      internals.pidVerificationProbes = originalProbes;
    }

    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/another data directory/i);
  });

  it("should refuse an old-format record with a relative data directory", async () => {
    // Strataline 4.0.x passed dataDir through as configured, so an old server
    // can legitimately have a relative -D. That path belongs to the target
    // process's working directory rather than ours and is indeterminate in
    // both directions. Treating it as safe to remove recreates the legacy
    // hole on exactly the compatibility path this check exists to protect.
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    const standIn = join(
      tempDir.name,
      process.platform === "win32" ? "postgres.exe" : "postgres",
    );
    const keepAlive = join(tempDir.name, "legacy-relative-keepalive.js");

    copyFileSync(process.execPath, standIn);

    if (process.platform !== "win32") {
      chmodSync(standIn, 0o755);
    }

    writeFileSync(keepAlive, "setTimeout(() => {}, 1e6);\n");

    await server.start();

    const other = spawn(standIn, [keepAlive, "-D", "relative-legacy-pgdata"], {
      stdio: "ignore",
    });

    await new Promise((resolve) => setTimeout(resolve, 400));

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => "gone";

    try {
      writeFileSync(pidFile, String(other.pid));

      await expect(internals.cleanupExistingProcess()).rejects.toThrow(
        /could not be tied|relative data directory/i,
      );

      expect(readFileSync(pidFile, "utf8")).toBe(String(other.pid));
    } finally {
      other.kill("SIGKILL");
      internals.terminateProcess = originalTerminate;

      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
      }

      await server.stop();
    }

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should still remove an old-format record whose number is dead", async () => {
    // The counterweight. After a reboot every legacy record names a number
    // that is either gone or held by something unrelated, and refusing on
    // either would refuse on every run with no server anywhere to protect.
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    await server.start();

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => "gone";

    // Nothing is running at this number, so the record describes a server that
    // is gone and there is nothing to protect.
    writeFileSync(pidFile, "999999");

    await internals.cleanupExistingProcess();

    expect(existsSync(pidFile)).toBe(false);

    internals.terminateProcess = originalTerminate;

    await server.stop();

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should refuse an unreadable record whichever file settled the question", async () => {
    // "refuses startup when an existing PID record is malformed" covers the
    // path where strataline's own record is what gets probed. This is the same
    // record on the path where postmaster.pid answered first, so the record is
    // never read by the probe at all. Which file happened to settle what is
    // running says nothing about whose record this one is, so the answer has
    // to be the same on both.
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    const postmasterPidFile = join(tempDir.name, "pgdata", "postmaster.pid");

    await server.start();

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => "gone";

    try {
      writeFileSync(pidFile, "partially written");

      await expect(internals.cleanupExistingProcess()).rejects.toThrow(
        /could not be read/i,
      );

      expect(readFileSync(pidFile, "utf8")).toBe("partially written");

      // postmaster.pid is this cluster's own and was examined, so it still
      // goes: the refusal is about the record nothing formed a view of.
      expect(existsSync(postmasterPidFile)).toBe(false);
    } finally {
      internals.terminateProcess = originalTerminate;

      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
      }

      await server.stop();
    }

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should distinguish an inaccessible record from an absent one", async () => {
    // A verified postmaster.pid makes the status probe return before it reads
    // strataline's record. The accounting reads are therefore the only thing
    // preventing an unreadable existing file from being mistaken for absence
    // and overwritten by the next atomic PID-record write.
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    await server.start();

    chmodSync(pidFile, 0o000);

    try {
      await expect(
        (
          server as unknown as { cleanupExistingProcess(): Promise<void> }
        ).cleanupExistingProcess(),
      ).rejects.toThrow(/exists or is inaccessible/i);

      expect(existsSync(pidFile)).toBe(true);
    } finally {
      chmodSync(pidFile, 0o600);
      await server.stop();
    }

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should still remove its own cluster's record on the same path", async () => {
    // The other half of the rule above, and the ordinary case: a record naming
    // THIS data directory is the one this start is there to clean up, and
    // withholding it would leave a stale file behind after every run.
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    const postmasterPidFile = join(tempDir.name, "pgdata", "postmaster.pid");

    await server.start();

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => "gone";

    await internals.cleanupExistingProcess();

    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(postmasterPidFile)).toBe(false);

    internals.terminateProcess = originalTerminate;

    await server.stop();

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should refuse when a stale record cannot be claimed for removal", async () => {
    // A rename that fails is two different answers, and only one of them is
    // "the record is gone". Reporting the other as absent reads an unclaimable
    // postmaster.pid as a data directory that is free, and the start then goes
    // on to fail against PostgreSQL's own lock file instead — a message about
    // the wrong thing, in place of a refusal that names the actual cause.
    type Internals = {
      removeRecordIfUnchanged(
        path: string,
        accounted: string,
        identify: (raw: string) => string,
      ): Promise<{ outcome: string }>;
    };

    // Permissions are what makes a rename fail here, and root does not have
    // any. Windows does not enforce a read-only directory the same way.
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    const internals = server as unknown as Internals;
    const locked = join(tempDir.name, "locked");
    const record = join(locked, "record");

    mkdirSync(locked);
    writeFileSync(record, "a stale record");

    // No write permission on the directory, so the record cannot be renamed
    // out of it — while remaining perfectly readable, which is what separates
    // this from a record that is simply gone.
    chmodSync(locked, 0o500);

    try {
      expect(
        (
          await internals.removeRecordIfUnchanged(
            record,
            "a stale record",
            (raw) => raw,
          )
        ).outcome,
      ).toBe("unclaimable");

      // Untouched, and still there to be found by hand.
      expect(existsSync(record)).toBe(true);
      expect(readFileSync(record, "utf8")).toBe("a stale record");
    } finally {
      chmodSync(locked, 0o700);
    }

    // Genuinely absent stays absent: the distinction only exists because the
    // two used to be reported as one.
    unlinkSync(record);

    expect(
      (
        await internals.removeRecordIfUnchanged(
          record,
          "anything",
          (raw) => raw,
        )
      ).outcome,
    ).toBe("absent");
  }, 30000);

  it("should still remove a record PostgreSQL rewrote while shutting down", async () => {
    // PostgreSQL owns line 8 of postmaster.pid and flips it from "ready" to
    // "stopping" the moment a shutdown begins. A postmaster wedged badly
    // enough to need SIGKILL never reaches the point of removing the file, so
    // what survives carries that changed line. Comparing every byte would read
    // the server's own last act as somebody else having taken the data
    // directory, and refuse the start on the one rung the escalation exists
    // for. Only lines 1 to 7 identify a postmaster, and PostgreSQL writes
    // those once at startup.
    type Internals = {
      cleanupExistingProcess(): Promise<void>;
      terminateProcess(pid: number, label: string): Promise<"gone" | "failed">;
    };

    const dataDir = join(tempDir.name, "pgdata");
    const postmasterPidFile = join(dataDir, "postmaster.pid");

    await server.start();

    const internals = server as unknown as Internals;
    const originalTerminate = internals.terminateProcess.bind(server);

    internals.terminateProcess = async () => {
      // Exactly what a shutdown that then had to be killed leaves behind.
      const lines = readFileSync(postmasterPidFile, "utf8").split("\n");

      expect(lines[7]).toBe("ready   ");
      lines[7] = "stopping";
      writeFileSync(postmasterPidFile, lines.join("\n"));

      return "gone";
    };

    await internals.cleanupExistingProcess();

    expect(existsSync(postmasterPidFile)).toBe(false);

    internals.terminateProcess = originalTerminate;

    await server.stop();

    expect(exitCalled).toBe(false);
  }, 90000);

  it("should stop cleanly even while a client is connected", async () => {
    // The case that used to leave a stale data directory. SIGTERM is smart
    // shutdown, which waits for clients to disconnect, so an open connection
    // made it hang until the timeout forced a SIGKILL. A clean shutdown
    // removes postmaster.pid; an abrupt kill leaves it behind.
    const dataDir = join(tempDir.name, "pgdata");

    await server.start();

    const pool = new Pool({
      host: "localhost",
      port: serverPort,
      user: "test_dev_user",
      password: "test_dev_password",
      database: "test_dev_database",
    });
    // A fast shutdown disconnects live clients with 57P01 (admin_shutdown),
    // which arrives as an error event. That is the expected outcome here, so
    // swallow it rather than letting it surface as an unhandled error.
    pool.on("error", () => {});

    const client = await pool.connect();

    client.on("error", () => {});

    await client.query("SELECT 1");

    // Deliberately hold the connection open across the shutdown.
    await server.stop();

    expect(existsSync(join(dataDir, "postmaster.pid"))).toBe(false);

    try {
      client.release();
      await pool.end();
    } catch {
      // The server is gone; tearing down the pool may well fail.
    }
  }, 60000);

  it("should identify a real running server over a connection", async () => {
    // Exercises the actual SQL and the pg round trip, which the unit tests
    // deliberately stub out. Without this the query string itself is unverified.
    const dataDir = join(tempDir.name, "pgdata");

    await server.start();

    const result = await identifyViaConnection({
      port: serverPort,
      user: "test_dev_user",
      password: "test_dev_password",
      database: "test_dev_database",
    });

    expect(result.responded).toBe(true);
    expect(result.error).toBeNull();
    // Through sameDataDir rather than as a string, which is the whole reason
    // that function is exported. PostgreSQL reports data_directory with
    // forward slashes on Windows, so "D:/a/.../pgdata" and "D:\\a\\...\\pgdata"
    // are the same directory spelled two ways, and a caller comparing them by
    // hand would read its own cluster as somebody else's.
    expect(sameDataDir(result.dataDir ?? "", dataDir)).toBe(true);
    expect(result.startedAt).toBeGreaterThan(0);

    await server.stop();
  }, 30000);

  it("should report a connection refused when nothing is listening", async () => {
    // The other half of the classification: a closed port must come back as
    // not responding, so the tiebreaker leaves the cautious answer alone.
    const closedPort = await findFreePort();
    const result = await identifyViaConnection({
      port: closedPort,
      user: "test_dev_user",
      password: "test_dev_password",
      database: "test_dev_database",
      timeoutMs: 2000,
    });

    expect(result.responded).toBe(false);
    expect(result.dataDir).toBeNull();
  }, 30000);

  it("should not report a connect timeout as a response", async () => {
    // pg's own connect timeout throws a bare Error with no `code`, so a check
    // that only reads `code` calls it a response. The reason string built from
    // this goes into a refusal, and telling somebody a server answered on a
    // port sends them looking for one that is not there.
    // Kept so they can be destroyed by hand below. `server.close()` stops the
    // listener and then waits for every connection it accepted to end, and the
    // one this test makes never does: pg's connect timeout destroys the CLIENT
    // side, and a handler that says nothing never closes the server side. So
    // closing waits forever, and the wait is in a `finally` after the
    // assertions, which is a test that passes and then hangs.
    //
    // Bun 1.3 returned from close() without waiting, so this only ever showed
    // up somewhere running 1.4.
    const accepted: Socket[] = [];

    const silent = createServer((socket) => {
      // Accept the socket and then say nothing, so the connection attempt can
      // only end in pg's timeout.
      accepted.push(socket);
    });

    const silentPort = await findFreePort();

    await new Promise<void>((resolve) => silent.listen(silentPort, resolve));

    try {
      const result = await identifyViaConnection({
        port: silentPort,
        user: "test_dev_user",
        password: "test_dev_password",
        database: "test_dev_database",
        timeoutMs: 500,
      });

      expect(result.responded).toBe(false);
      expect(result.dataDir).toBeNull();
      expect(result.startedAt).toBeNull();
    } finally {
      // Before the close, which is what waits on them.
      for (const socket of accepted) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 30000);

  it("should report a real running server as running", async () => {
    // End to end through the status function against genuine PostgreSQL,
    // rather than the stand-in process the unit tests spawn.
    const dataDir = join(tempDir.name, "pgdata");

    await server.start();

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(true);
    expect(status.indeterminate).toBe(false);
    expect(status.pid).toBeGreaterThan(0);

    await server.stop();
  }, 30000);

  it("should report not running once the server has stopped", async () => {
    const dataDir = join(tempDir.name, "pgdata");

    await server.start();
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const status = await getLocalDevDBServerStatus({ pidFile, dataDir });

    expect(status.running).toBe(false);
    // A clean stop removes the PID file, which consumers treat as
    // authoritative, so this must not come back indeterminate.
    expect(status.indeterminate).toBe(false);
  }, 30000);

  it("should create the specified user, password, and database", async () => {
    // Start the server
    await server.start();

    // Try to connect with the created credentials
    const pool = new Pool({
      host: "localhost",
      port: serverPort, // Use the dynamically assigned port
      user: "test_dev_user",
      password: "test_dev_password",
      database: "test_dev_database",
    });

    try {
      // Test the connection
      const client = await pool.connect();
      const result = await client.query("SELECT 1 as test_value");
      expect(result.rows[0].test_value).toBe(1);
      client.release();

      // Verify we're connected to the correct database
      const dbResult = await pool.query("SELECT current_database()");
      expect(dbResult.rows[0].current_database).toBe("test_dev_database");

      // Verify we're connected as the correct user
      const userResult = await pool.query("SELECT current_user");
      expect(userResult.rows[0].current_user).toBe("test_dev_user");
    } finally {
      await pool.end();
    }
  }, 30000);

  it("should handle custom port configuration", async () => {
    // Create a server with a dynamically assigned port
    const customPort = await findFreePort();

    const customServer = new LocalDevDBServer({
      port: customPort,
      user: "custom_user",
      password: "custom_password",
      database: "custom_database",
      dataDir: join(tempDir.name, "custom_pgdata"),
      pidFile: join(tempDir.name, ".custom_pg_pid"),
      // No logger for silent tests
      onExit: () => {},
    });

    try {
      await customServer.start();

      // Try to connect on the custom port
      const pool = new Pool({
        host: "localhost",
        port: customPort,
        user: "custom_user",
        password: "custom_password",
        database: "custom_database",
      });

      try {
        const client = await pool.connect();
        const result = await client.query("SELECT 1 as test_value");
        expect(result.rows[0].test_value).toBe(1);
        client.release();
      } finally {
        await pool.end();
      }
    } finally {
      await customServer.stop();
    }
  }, 30000);

  it("should work without a logger", async () => {
    // Create a server without a logger
    const silentPort = await findFreePort();

    const silentServer = new LocalDevDBServer({
      port: silentPort,
      user: "silent_user",
      password: "silent_password",
      database: "silent_database",
      dataDir: join(tempDir.name, "silent_pgdata"),
      pidFile: join(tempDir.name, ".silent_pg_pid"),
      // No logger provided
      onExit: () => {},
    });

    try {
      // Should start without errors even without a logger
      await silentServer.start();

      // Verify it works
      const pool = new Pool({
        host: "localhost",
        port: silentPort,
        user: "silent_user",
        password: "silent_password",
        database: "silent_database",
      });

      try {
        const client = await pool.connect();
        const result = await client.query("SELECT 1 as test_value");
        expect(result.rows[0].test_value).toBe(1);
        client.release();
      } finally {
        await pool.end();
      }
    } finally {
      await silentServer.stop();
    }
  }, 30000);

  it("should handle data directory persistence", async () => {
    const dataDir = join(tempDir.name, "persistent_pgdata");
    const persistPort1 = await findFreePort();
    const persistPort2 = await findFreePort();

    // Create first server instance
    const server1 = new LocalDevDBServer({
      port: persistPort1,
      user: "persist_user",
      password: "persist_password",
      database: "persist_database",
      dataDir: dataDir,
      pidFile: join(tempDir.name, ".persist_pg_pid_1"),
      // No logger for silent tests
      onExit: () => {},
    });

    // Declared out here so the finally block can guarantee cleanup even if the
    // test throws before server2 is started.
    let server2: LocalDevDBServer | undefined;

    try {
      await server1.start();

      // Create a test table and insert data
      const pool1 = new Pool({
        host: "localhost",
        port: persistPort1,
        user: "persist_user",
        password: "persist_password",
        database: "persist_database",
      });

      try {
        await pool1.query(`
          CREATE TABLE test_persistence (
            id SERIAL PRIMARY KEY,
            message TEXT NOT NULL
          )
        `);
        await pool1.query(`
          INSERT INTO test_persistence (message) VALUES ('persistent data')
        `);
      } finally {
        await pool1.end();
      }

      await server1.stop();

      // Create second server instance using the same data directory
      server2 = new LocalDevDBServer({
        port: persistPort2,
        user: "persist_user",
        password: "persist_password",
        database: "persist_database",
        dataDir: dataDir,
        pidFile: join(tempDir.name, ".persist_pg_pid_2"),
        // No logger for silent tests
        onExit: () => {},
      });

      await server2.start();

      // Verify the data persisted
      const pool2 = new Pool({
        host: "localhost",
        port: persistPort2,
        user: "persist_user",
        password: "persist_password",
        database: "persist_database",
      });

      try {
        const result = await pool2.query(`
          SELECT message FROM test_persistence WHERE id = 1
        `);
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].message).toBe("persistent data");
      } finally {
        await pool2.end();
      }
    } finally {
      // Best-effort cleanup. Unlike the previous catch block, this does NOT
      // swallow errors thrown from the test body, so a failed assertion still
      // fails the test instead of passing silently.
      try {
        await server1.stop();
      } catch {
        // Ignore cleanup errors (server may already be stopped)
      }

      if (server2) {
        try {
          await server2.stop();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }, 45000);

  describe("accounting for the records a start decided about", () => {
    // The records are read before the status probe and confirmed after it.
    // Reading only afterwards let a record written while the probe was running
    // — it can wait out a three-second connection timeout — become the one the
    // start accounted for, without the decision having examined it at all. The
    // removals at the end then deleted a live postmaster.pid as unchanged.
    type Accounting = {
      accountedRecord(
        path: string,
        before: string | null,
        identify: (raw: string) => string,
      ): Promise<string | null>;
      cleanupExistingProcess(): Promise<void>;
      readAccountedPidFileBytes(path: string): Promise<string | null>;
    };

    const identity = (raw: string): string => raw;

    it("accounts for a record that did not change", async () => {
      const path = join(tempDir.name, "record");

      writeFileSync(path, "same");

      const internals = server as unknown as Accounting;

      expect(await internals.accountedRecord(path, "same", identity)).toBe(
        "same",
      );
    });

    it("accounts for nothing when the record went away", async () => {
      // What a clean shutdown looks like. There is nothing left to delete, and
      // a record that reappears is refused by the removal loop instead.
      const path = join(tempDir.name, "departed");

      const internals = server as unknown as Accounting;

      expect(
        await internals.accountedRecord(path, "gone", identity),
      ).toBeNull();
    });

    it("refuses a record that changed while the server was identified", async () => {
      const path = join(tempDir.name, "replaced");

      writeFileSync(path, "theirs");

      const internals = server as unknown as Accounting;

      await expect(
        internals.accountedRecord(path, "ours", identity),
      ).rejects.toThrow(/has taken this data directory since/i);
    });

    it("refuses a record that arrived while the server was identified", async () => {
      const path = join(tempDir.name, "arrived");

      writeFileSync(path, "theirs");

      const internals = server as unknown as Accounting;

      await expect(
        internals.accountedRecord(path, null, identity),
      ).rejects.toThrow(/has taken this data directory since/i);
    });

    it("leaves a postmaster.pid that appeared during the status probe", async () => {
      // The whole race, end to end: nothing is on disk when cleanup starts,
      // and another PostgreSQL claims the directory while the probe is out.
      // The record it wrote must survive, because deleting it would orphan
      // that server and let this start put a second postmaster on the same
      // data directory.
      const dataDir = join(tempDir.name, "pgdata");

      mkdirSync(dataDir, { recursive: true });

      const postmasterPidFile = join(dataDir, "postmaster.pid");
      const theirRecord = [
        "424242",
        dataDir,
        String(Math.floor(Date.now() / 1000)),
        String(serverPort),
        "/tmp",
        "127.0.0.1",
        "  5432001         12345678",
        "ready   ",
      ].join("\n");

      const internals = server as unknown as Accounting;
      const readBytes = internals.readAccountedPidFileBytes.bind(internals);
      const reads = new Map<string, number>();

      // Stands in for the claim landing mid-probe. cleanupExistingProcess
      // reads the PID file then postmaster.pid, probes, then reads each again
      // to account for it, so the PID file's SECOND read is the first thing
      // that happens after the probe. Writing there means the pre-probe reads
      // and the probe itself all saw an empty data directory, and the record
      // is present by the time postmaster.pid is accounted for. If that read
      // order changes, this injection point has to move with it.
      internals.readAccountedPidFileBytes = async (path: string) => {
        const seen = (reads.get(path) ?? 0) + 1;

        reads.set(path, seen);

        if (path === pidFile && seen === 2) {
          writeFileSync(postmasterPidFile, theirRecord);
        }

        return readBytes(path);
      };

      try {
        await expect(internals.cleanupExistingProcess()).rejects.toThrow(
          /has taken this data directory since/i,
        );
      } finally {
        internals.readAccountedPidFileBytes = readBytes;
      }

      expect(existsSync(postmasterPidFile)).toBe(true);
      expect(readFileSync(postmasterPidFile, "utf8")).toBe(theirRecord);
    }, 30000);
  });

  it("completes a shutdown whose close event never arrives", async () => {
    // `close` waits on the stdio pipes as well as the process, and PostgreSQL
    // backends inherit those pipes. A postmaster wedged badly enough to need
    // SIGKILL dies without signaling its children, which go on holding the
    // write ends, so the event can lag the exit indefinitely. That used to
    // reject after two seconds, reporting a failure for a shutdown that had
    // worked — exiting non-zero on a clean Ctrl+C — and leaving the PID record
    // behind, since releasing it lives in the close handler.
    type Lifecycle = {
      pgProcess: unknown;
      pgProcessLifecycle: {
        proc: unknown;
        closed: Promise<void>;
        finalize: () => Promise<void>;
      } | null;
    };

    // Already exited, which is what terminateProcess confirms for a child of
    // ours, so the escalation settles at once and only the wait is left.
    const proc = {
      pid: 999999,
      exitCode: 0,
      signalCode: null,
      stdout: null,
      stderr: null,
      stdin: null,
      kill: () => true,
    };

    let finalized = 0;

    const internals = server as unknown as Lifecycle;

    internals.pgProcess = proc;
    internals.pgProcessLifecycle = {
      proc,
      // Never resolves: the child is gone but Node has not reported it.
      closed: new Promise<void>(() => {}),
      finalize: async () => {
        finalized++;
        internals.pgProcess = null;
      },
    };

    const began = Date.now();

    await server.stop();

    // Bounded by the two-second wait rather than hanging, and the cleanup ran
    // here rather than being left to an event that is not coming.
    expect(Date.now() - began).toBeLessThan(10000);
    expect(finalized).toBe(1);
    expect(internals.pgProcess).toBeNull();
    expect(exitCalled).toBe(false);
  }, 30000);

  it("makes both finalizers wait for the one release", async () => {
    // Two callers reach the lifecycle cleanup: the shutdown that gave up
    // waiting for `close`, and `close` itself when it lands anyway. They can
    // land together. A flag that only stops the work running twice let the
    // second return while the first was still inside releasePidRecord, and
    // what the second does next is decide whether to end the process. Under
    // the default exit handler that is process.exit(), which would cut the
    // release off between the rename that claims the record and the link that
    // would put somebody else's back.
    type Internals = {
      attachExitHandler(proc: unknown): void;
      pgProcess: unknown;
      pgProcessLifecycle: { finalize(): Promise<void> } | null;
      releasePidRecord(): Promise<void>;
    };

    const internals = server as unknown as Internals;
    const proc = {
      pid: 999998,
      exitCode: null,
      signalCode: null,
      on: () => {},
      // A real ChildProcess has both, and attachExitHandler records the
      // stdio close through this one. Nothing here emits it: this test is
      // about the two finalizers, and the exit handler never runs.
      once: () => {},
    };

    internals.pgProcess = proc;
    internals.attachExitHandler(proc);

    const lifecycle = internals.pgProcessLifecycle;

    if (lifecycle === null) {
      throw new Error("attachExitHandler recorded no lifecycle to finalize");
    }

    let releaseFinished = false;

    internals.releasePidRecord = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      releaseFinished = true;
    };

    // Started together, the way the timeout path and a `close` arriving at the
    // same moment would.
    const first = lifecycle.finalize();
    const second = lifecycle.finalize();

    await second;

    // The second caller is only allowed to go on to its exit decision once the
    // release it shares has actually finished.
    expect(releaseFinished).toBe(true);

    await first;

    expect(internals.pgProcess).toBeNull();
  });

  it("does not fail a start with a superseded child's exit", async () => {
    // A `close` that arrives after the restart that followed its own stop()
    // used to be recorded as the new server failing to come up, because the
    // handler read this instance's state without first asking whether the
    // exit was still its to speak for. start() then rejected and
    // cleanupFailedStart killed a postmaster that was perfectly healthy.
    const internals = server as unknown as ChildLifecycleInternals;
    const fresh = fakeChild(999002);
    const superseded = await supersedeAChild(internals, fresh.proc);

    internals.startingUp = true;

    superseded.exit(null);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(internals.startupFailure).toBeNull();
    expect(internals.pgProcess).toBe(fresh.proc);

    // Nothing real to stop, and afterEach would otherwise wait out the close
    // this stand-in is never going to emit.
    internals.startingUp = false;
    internals.pgProcess = null;
    internals.pgProcessLifecycle = null;
  });

  it("does not exit the host over a superseded child's exit", async () => {
    // Same event, landing a moment later. Past the startup window the handler
    // used to read it as the current server having crashed, which is the one
    // outcome that ends the host process — while the server it was reporting
    // on was running normally.
    const internals = server as unknown as ChildLifecycleInternals;
    const fresh = fakeChild(999002);
    const superseded = await supersedeAChild(internals, fresh.proc);

    superseded.exit(null);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exitCalled).toBe(false);
    expect(internals.pgProcess).toBe(fresh.proc);

    internals.pgProcess = null;
    internals.pgProcessLifecycle = null;
  });

  it("keeps the listeners until the last server lets go", async () => {
    // One set of listeners serves every server, so arming a second adds
    // nothing and releasing one must not take them off under the other. They
    // come off when the last server leaves, and not before.
    //
    // Both halves are driven through the private pair rather than through a
    // real start and stop, which is the whole point of the seam: the sharing
    // is what is under test, not the lifecycle that happens to call them.
    type Internals = {
      armProcessHandlers(): void;
      releaseProcessHandlers(): void;
    };

    const events = ["exit"] as const;

    const config = (name: string): LocalDevDBServerConfig => ({
      port: 65000,
      user: `${name}_user`,
      password: `${name}_password`,
      database: `${name}_database`,
      dataDir: join(tempDir.name, `${name}-pgdata`),
      pidFile: join(tempDir.name, `.${name}_pg_pid`),
      onExit: () => {},
    });

    // Relative to whatever is armed already, never to zero. One set serves
    // every server in the process, so a server another test left running is
    // enough to have them on before this one starts — which is the very
    // sharing under test here, not interference with it.
    const before = new Map(
      events.map((event) => [event, process.listenerCount(event)]),
    );

    const one = new LocalDevDBServer(config("shared_hook_one"));
    const two = new LocalDevDBServer(config("shared_hook_two"));

    // Armed the way start() arms them, without the cost of a real server.
    (one as unknown as Internals).armProcessHandlers();

    const armed = new Map(
      events.map((event) => [event, process.listenerCount(event)]),
    );

    for (const event of events) {
      expect(armed.get(event) ?? 0).toBeGreaterThanOrEqual(1);
    }

    // A second server does not bring a second set with it.
    (two as unknown as Internals).armProcessHandlers();

    for (const event of events) {
      expect(process.listenerCount(event)).toBe(armed.get(event) ?? 0);
    }

    // Still needed by `two`, so releasing `one` leaves them alone.
    (one as unknown as Internals).releaseProcessHandlers();

    for (const event of events) {
      expect(process.listenerCount(event)).toBe(armed.get(event) ?? 0);
    }

    (two as unknown as Internals).releaseProcessHandlers();

    // Back to whatever this test found, which is none of its own.
    for (const event of events) {
      expect(process.listenerCount(event)).toBe(before.get(event) ?? 0);
    }

    // Idempotent, and an instance stays reusable afterwards.
    (two as unknown as Internals).releaseProcessHandlers();

    for (const event of events) {
      expect(process.listenerCount(event)).toBe(before.get(event) ?? 0);
    }
  });
  it("should create a logger", () => {
    const logger = createConsoleLogger();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("should handle different log types", () => {
    // Capture console output to prevent test noise
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    const logCalls: string[] = [];
    const errorCalls: string[] = [];
    const warnCalls: string[] = [];

    // Replace console methods to capture output silently
    console.log = (message: string) => logCalls.push(message);
    console.error = (message: string) => errorCalls.push(message);
    console.warn = (message: string) => warnCalls.push(message);

    try {
      const logger = createConsoleLogger({ pg: false, setup: false }); // Silent mode

      // These should not throw errors
      logger.info({ message: "Test info message" });
      logger.error({ message: "Test error message" });
      logger.warn({ message: "Test warning message" });
      logger.info({ source: "pg", message: "Test PostgreSQL message" });
      logger.info({ source: "setup", message: "Test setup message" });

      // Verify the console methods were called appropriately
      expect(logCalls).toContain("Test info message");
      expect(errorCalls).toContain("Test error message");
      expect(warnCalls).toContain("Test warning message");
      // pg and setup messages should not be logged in silent mode
      expect(logCalls).not.toContain("[PG] Test PostgreSQL message");
      expect(logCalls).not.toContain("[SETUP] Test setup message");
    } finally {
      // Restore original console methods
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
  });
});

describe("postgresOutputLevel", () => {
  // The real shape, captured from a running server: log_line_prefix defaults
  // to "%m [%p] ", so the severity is neither at the start of the line nor at
  // a fixed offset — the timestamp's length varies with the zone.
  const line = (severity: string, message: string) =>
    `2026-09-02 19:32:50.954 MDT [64506] ${severity}:  ${message}`;

  it("leaves routine output at info", () => {
    expect(postgresOutputLevel(line("LOG", "starting PostgreSQL 18.4"))).toBe(
      "info",
    );
    expect(postgresOutputLevel(line("NOTICE", "extension exists"))).toBe(
      "info",
    );
    expect(postgresOutputLevel(line("DEBUG1", "forked new backend"))).toBe(
      "info",
    );
  });

  it("raises the levels PostgreSQL raises", () => {
    expect(postgresOutputLevel(line("WARNING", "already a transaction"))).toBe(
      "warn",
    );
    expect(
      postgresOutputLevel(line("ERROR", 'relation "x" does not exist')),
    ).toBe("error");
    expect(postgresOutputLevel(line("FATAL", "files are incompatible"))).toBe(
      "error",
    );
    expect(postgresOutputLevel(line("PANIC", "could not write to file"))).toBe(
      "error",
    );
  });

  it("takes the highest severity in a chunk and keeps the chunk together", () => {
    // A FATAL arrives with its own DETAIL and HINT. Splitting them to level
    // each line separately would take the explanation away from the thing it
    // explains, so the whole chunk goes at the worst level in it.
    const chunk = [
      line("FATAL", "database files are incompatible with server"),
      line("DETAIL", "The data directory was initialized by version 17."),
      line("HINT", "You may need to initdb."),
    ].join("\n");

    expect(postgresOutputLevel(chunk)).toBe("error");
  });

  it("does not read a severity out of the middle of a message", () => {
    // log_statement echoes the query under STATEMENT, so a query mentioning
    // ERROR must not make a routine echo look like a failure. STATEMENT is
    // matched first and is not a raising severity, so the scan stops there.
    const echoed = line("STATEMENT", "SELECT 'ERROR: not really'");

    expect(postgresOutputLevel(echoed)).toBe("info");
  });

  it("treats anything it cannot read as routine", () => {
    // The `pg` source also carries this class's own lines, and an unreadable
    // chunk must be no worse off than it was when every line was info.
    expect(postgresOutputLevel("Running: /path/to/initdb -D /tmp/pgdata")).toBe(
      "info",
    );
    expect(postgresOutputLevel("")).toBe("info");
  });
});

describe("postgresSeverity", () => {
  const line = (severity: string, message: string) =>
    `2026-09-02 19:32:50.954 MDT [64506] ${severity}:  ${message}`;

  it("separates a routine info from having stated nothing", () => {
    // The distinction postgresOutputLevel cannot make, and the whole reason
    // this exists: both answer `info` there, and only one of them should let
    // a previous level carry across.
    expect(postgresSeverity(line("LOG", "database system is ready"))).toBe(
      "info",
    );
    expect(postgresSeverity("Running: /path/to/initdb")).toBeNull();
    expect(postgresSeverity("")).toBeNull();
  });

  it("reports no severity for the fields of the message above", () => {
    // DETAIL and HINT are not messages, they are the rest of one. Read as
    // fresh routine lines they log at info, which is what a `{ pg: false }`
    // filter drops -- so the sentence explaining a FATAL disappears while the
    // FATAL itself is shown.
    expect(
      postgresSeverity(line("DETAIL", "Failed system call was semget().")),
    ).toBeNull();
    expect(
      postgresSeverity(line("HINT", "You may need to initdb.")),
    ).toBeNull();
    expect(
      postgresSeverity(line("STATEMENT", "SELECT 'ERROR: not really'")),
    ).toBeNull();
  });

  it("keeps the highest severity when a group holds several", () => {
    const group = [
      line("LOG", 'could not bind IPv4 address "127.0.0.1"'),
      line("WARNING", "could not create listen socket"),
    ].join("\n");

    // The routine LOG must not overwrite the WARNING that followed it.
    expect(postgresSeverity(group)).toBe("warn");
    expect(
      postgresSeverity([group, line("FATAL", "no sockets")].join("\n")),
    ).toBe("error");
  });
});

describe("PostgresLineAssembler", () => {
  it("holds a chunk back until its line is whole", () => {
    const assembler = new PostgresLineAssembler();

    // The tear this exists for: neither half is a severity word, so a scan of
    // either one reads the FATAL as routine output.
    expect(assembler.take("2026-09-02 19:32:50.954 MDT [64506] FAT")).toBe("");
    expect(assembler.take("AL:  could not create semaphores\n")).toBe(
      "2026-09-02 19:32:50.954 MDT [64506] FATAL:  could not create semaphores\n",
    );
  });

  it("emits the complete lines and keeps only the partial one", () => {
    const assembler = new PostgresLineAssembler();

    expect(assembler.take("LOG:  one\nLOG:  two\nLOG:  thr")).toBe(
      "LOG:  one\nLOG:  two\n",
    );
    expect(assembler.take("ee\n")).toBe("LOG:  three\n");
  });

  it("gives up what it is holding when the stream ends", () => {
    const assembler = new PostgresLineAssembler();

    // A postmaster's last write is the reason it is exiting and need not end
    // in a newline, so holding it forever loses more than reading it early.
    assembler.take("FATAL:  could not create any TCP/IP sockets");

    expect(assembler.flush()).toBe(
      "FATAL:  could not create any TCP/IP sockets",
    );
    expect(assembler.flush()).toBe("");
  });
});

describe("PostgresOutputReader", () => {
  const p = "2026-09-02 19:32:50.954 MDT [64506] ";
  const line = (severity: string, message: string) =>
    `${p}${severity}:  ${message}`;

  it("reads a severity torn across two chunks", () => {
    const reader = new PostgresOutputReader();

    // Scanned per chunk, neither half contains a severity word, so both go at
    // `info` -- and `info` from source `pg` is exactly what
    // createConsoleLogger({ pg: false }) drops.
    expect(reader.take("2026-09-02 19:32:50.954 MDT [64506] FAT")).toEqual([]);
    expect(
      reader.take("AL:  database files are incompatible with server\n"),
    ).toEqual([
      {
        text: line("FATAL", "database files are incompatible with server"),
        level: "error",
      },
    ]);
  });

  it("splits a chunk at each message rather than levelling it as one", () => {
    const reader = new PostgresOutputReader();

    // The whole reason the boundary is taken from PostgreSQL's structure and
    // not from the pipe's. Levelled as one unit the routine LOG goes out at
    // `error` with the FATAL, and which lines shared a level would depend on
    // where the kernel happened to flush.
    expect(
      reader.take(
        [
          line("LOG", 'could not bind IPv4 address "127.0.0.1"'),
          line("FATAL", "could not create any TCP/IP sockets"),
          "",
        ].join("\n"),
      ),
    ).toEqual([
      {
        text: line("LOG", 'could not bind IPv4 address "127.0.0.1"'),
        level: "info",
      },
      {
        text: line("FATAL", "could not create any TCP/IP sockets"),
        level: "error",
      },
    ]);
  });

  it("keeps a message's own DETAIL and HINT with it", () => {
    const reader = new PostgresOutputReader();

    // Splitting per LINE would get the test above and lose this one: the
    // fields state no severity, so they belong to the message they explain
    // rather than standing alone at `info`.
    const detail = line("DETAIL", "Failed system call was semget().");
    const hint = line("HINT", "This does not mean you are out of disk space.");

    expect(
      reader.take(
        [line("FATAL", "could not create semaphores"), detail, hint, ""].join(
          "\n",
        ),
      ),
    ).toEqual([
      {
        text: [line("FATAL", "could not create semaphores"), detail, hint].join(
          "\n",
        ),
        level: "error",
      },
    ]);
  });

  it("carries the level across a message the pipe broke in half", () => {
    const reader = new PostgresOutputReader();

    expect(
      reader.take(line("FATAL", "could not create semaphores") + "\n"),
    ).toEqual([
      { text: line("FATAL", "could not create semaphores"), level: "error" },
    ]);

    // The continuation states no severity of its own. Read alone it is `info`,
    // which filters the explanation away from the failure it explains.
    const continuation = [
      line("DETAIL", "Failed system call was semget()."),
      "",
      line("HINT", "This does not mean you are out of disk space."),
    ];

    expect(reader.take(continuation.join("\n") + "\n")).toEqual([
      { text: continuation.join("\n"), level: "error" },
    ]);
  });

  it("stops carrying at the next message", () => {
    const reader = new PostgresOutputReader();

    reader.take(line("FATAL", "could not create any TCP/IP sockets") + "\n");

    // A primary severity word ends the previous message's reach, so one FATAL
    // does not make every routine line that follows it an error.
    expect(
      reader.take(line("LOG", "database system is shut down") + "\n"),
    ).toEqual([
      { text: line("LOG", "database system is shut down"), level: "info" },
    ]);
  });

  it("stops carrying a level once the stream has ended", () => {
    const reader = new PostgresOutputReader();

    reader.take(line("FATAL", "could not create any TCP/IP sockets") + "\n");
    reader.flush();

    // Both surfaces keep one reader for longer than one postmaster: a dev
    // server can be started again on the same instance, and a test database
    // that loses its port retries against a new child. A level carried across
    // that boundary puts the dead server's FATAL on the first unrecognized
    // line the live one writes.
    expect(reader.take("Running: /path/to/initdb -D /tmp/pgdata\n")).toEqual([
      { text: "Running: /path/to/initdb -D /tmp/pgdata", level: "info" },
    ]);
  });

  it("does not let a logged statement's own text start a message", () => {
    const reader = new PostgresOutputReader();

    // Captured from a real server, not invented. PostgreSQL logs the client's
    // SQL verbatim under STATEMENT, and append_with_tabs indents every line of
    // a message after the first -- which is the only thing separating the
    // server's severity on line one from the two the client put inside a
    // string literal. Without that, one error is delivered as three messages,
    // two of them fabricated out of SQL text and outranking the real one.
    const block = [
      `${p}ERROR:  division by zero`,
      `${p}STATEMENT:  SELECT 1/0, '`,
      "\tERROR:  not a real error",
      "\tWARNING:  nor this",
      "\t'",
      "",
    ].join("\n");

    expect(reader.take(block)).toEqual([
      { text: block.trim(), level: "error" },
    ]);
  });

  it("reads the severity only where the prefix says the message starts", () => {
    const reader = new PostgresOutputReader();

    // Defense in depth rather than a bug that was reachable: on well-formed
    // output the first severity-shaped token IS the severity, so the loose
    // scan agrees. What this pins down is the intent -- a severity counts only
    // in the one position PostgreSQL puts it, right after the prefix -- so a
    // prefixed line whose body starts with something else cannot have a level
    // read out of its middle.
    const odd = `${p}duration: 1.234 ms  ERROR: not the severity`;

    expect(reader.take(odd + "\n")).toEqual([{ text: odd, level: "info" }]);

    // And the ordinary prefixed line still reads exactly as before.
    expect(reader.take(line("FATAL", "no sockets") + "\n")).toEqual([
      { text: line("FATAL", "no sockets"), level: "error" },
    ]);
  });

  it("still reads a severity where log_line_prefix is empty", () => {
    const reader = new PostgresOutputReader();

    // The reason the continuation test above keys on the indent rather than on
    // a timestamp: log_line_prefix is configurable and may be empty, and such
    // a cluster writes an ordinary record starting at column zero. Requiring a
    // prefix would take every line from one back to `info`.
    expect(
      reader.take("FATAL:  could not create any TCP/IP sockets\n"),
    ).toEqual([
      { text: "FATAL:  could not create any TCP/IP sockets", level: "error" },
    ]);
  });

  it("says nothing for a chunk that completes nothing", () => {
    const reader = new PostgresOutputReader();

    expect(reader.take("LOG:  partial")).toEqual([]);
    expect(reader.take("\n\n")).toEqual([
      { text: "LOG:  partial", level: "info" },
    ]);
    expect(reader.flush()).toEqual([]);
  });
});

describe("getCurrentUser, through a started server", () => {
  it("connects as the account initdb named, not as USER or USERNAME", async () => {
    // initdb runs with no -U, so the cluster's bootstrap superuser is named
    // after the account the process actually runs as. Reading the name from
    // the environment instead lets the two disagree, and every start then
    // fails with `role "..." does not exist` against a database it had just
    // created. Windows CI found it, where a process launched under other
    // credentials inherits the parent's USERNAME.
    const originalUser = process.env.USER;
    const originalUsername = process.env.USERNAME;

    process.env.USER = "definitely-not-a-real-account";
    process.env.USERNAME = "definitely-not-a-real-account";

    // Its own directory, since this sits outside the suite's shared fixture.
    const scratch = tmp.dirSync({ unsafeCleanup: true, prefix: "pg-osuser-" });
    const misleading = new LocalDevDBServer({
      port: await findFreePort(),
      user: "test_dev_user",
      password: "test_dev_password",
      database: "test_dev_database",
      dataDir: join(scratch.name, "pgdata"),
      pidFile: join(scratch.name, "dev-db.pid"),
    });

    try {
      // Starts at all, which is the whole assertion: the environment is lying
      // about who this is and the server has to ignore it.
      await misleading.start();

      expect(misleading.getLifecycleState()).toBe("running");
    } finally {
      await misleading.stop().catch(() => {});
      scratch.removeCallback();

      // Restored rather than deleted, since an absent variable is not the same
      // as one that was never set for the rest of the suite.
      if (originalUser === undefined) {
        delete process.env.USER;
      } else {
        process.env.USER = originalUser;
      }

      if (originalUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalUsername;
      }
    }
  }, 60000);
});

describe("letting go of a child that exited unasked", () => {
  /**
   * A stdio pipe that records having been dropped.
   *
   * The real hazard is a PostgreSQL backend that inherited the write end and
   * outlived the postmaster, so the read end never sees EOF and Node never
   * destroys it by itself. That could not be provoked: a backend polls for
   * postmaster death and exits, so a real kill always closes the pipes and a
   * test against one passes whether or not this code drops them.
   *
   * What IS testable is the guarantee itself, which is about this instance
   * rather than about PostgreSQL: a child that has exited must not be left
   * holding pipes nobody will close. A fake child answers that directly, and
   * without it the assertions below pass on any implementation at all.
   */
  const spyPipe = () => {
    let destroyed = false;

    return {
      get destroyed() {
        return destroyed;
      },
      destroy: () => {
        destroyed = true;
      },
    };
  };

  /** Enough of a child process for the lifecycle handler to act on. */
  const fakeChild = () => {
    const proc = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
      stdout: ReturnType<typeof spyPipe>;
      stderr: ReturnType<typeof spyPipe>;
      stdin: ReturnType<typeof spyPipe>;
    };

    proc.pid = 424242;
    proc.exitCode = null;
    proc.signalCode = null;
    proc.stdout = spyPipe();
    proc.stderr = spyPipe();
    proc.stdin = spyPipe();

    return proc;
  };

  interface Internals {
    pgProcess: unknown;
    attachExitHandler(proc: unknown): void;
  }

  it("drops the read ends, and still reports the exit", async () => {
    let reported: number | undefined;

    const scratch = tmp.dirSync({ unsafeCleanup: true, prefix: "pg-letgo-" });
    const server = new LocalDevDBServer({
      port: 1,
      user: "u",
      password: "p",
      database: "d",
      dataDir: join(scratch.name, "pgdata"),
      pidFile: join(scratch.name, "dev-db.pid"),
      onExit: (code) => {
        reported = code;
      },
    });

    try {
      const internals = server as unknown as Internals;
      const proc = fakeChild();

      // Attached the way a real spawn attaches it, then told the instance this
      // is its child, so the handler treats the exit below as its own.
      internals.pgProcess = proc;
      internals.attachExitHandler(proc);

      // Nobody asked for this one: no stop() in flight and no start() owning
      // it, which is the path that used to report the death and walk away
      // leaving the pipes open.
      proc.exitCode = 3;
      proc.emit("exit", 3);

      // The handler drains before it drops them, so this waits rather than
      // asserting into the middle of that bound.
      const deadline = Date.now() + 5000;

      while (Date.now() < deadline && reported === undefined) {
        await Bun.sleep(25);
      }

      // A ref'd pipe with nothing left to close it keeps the event loop up, so
      // a host that wanted to wind down after its database died would never
      // exit. Every deliberate path already dropped these; this one did not.
      expect(proc.stdout.destroyed).toBe(true);
      expect(proc.stderr.destroyed).toBe(true);
      expect(proc.stdin.destroyed).toBe(true);

      // And the drop must not have cost the rest of the release: the child
      // reference goes, and the exit is reported, which is the only channel an
      // unrequested one has.
      expect(internals.pgProcess).toBeNull();
      expect(reported).toBe(3);
    } finally {
      scratch.removeCallback();
    }
  }, 30000);
});

describe("reporting an unasked-for exit whose stdio has already closed", () => {
  /**
   * Run in a child process, which is the whole of the assertion.
   *
   * The failure this covers is a process that ENDS early, so nothing inside
   * this suite can see it: a test runner always has a live event loop, so the
   * drain's fallback timer fires there whether or not anything is waiting on
   * it, and the report arrives late rather than never. Only a process with
   * nothing else pending — a dev-server script, which is the documented way to
   * use `onExit` — reaches the gap, so the scenario gets a process of its own
   * and the assertion is on what it printed before exiting.
   *
   * The ordering is the point and is arranged rather than hoped for. `close`
   * is emitted immediately after `exit`, by which time the handler is
   * suspended at its first `await` — which is where a real one sits while
   * `finalize()` does filesystem work, and ample time for two pipes to reach
   * EOF. `close` fires once and Node does not replay it, so a drain that
   * starts listening afterwards waits for an event that has already gone,
   * and the flush, the pipe drop, and the `onExit` call after it never run.
   */
  it("reports the exit rather than exiting silently", () => {
    const scratch = tmp.dirSync({ unsafeCleanup: true, prefix: "pg-drain-" });

    try {
      const moduleUrl = pathToFileURL(
        join(import.meta.dir, "local-dev-db-server.ts"),
      ).href;
      const script = join(scratch.name, "unasked-exit.ts");

      writeFileSync(
        script,
        `
import { LocalDevDBServer } from ${JSON.stringify(moduleUrl)};
import { EventEmitter } from "events";

const pipe = () => ({
  destroyed: false,
  destroy() {
    this.destroyed = true;
  },
});

const proc: any = new EventEmitter();

proc.pid = 424242;
proc.exitCode = null;
proc.signalCode = null;
proc.stdout = pipe();
proc.stderr = pipe();
proc.stdin = pipe();

const server: any = new LocalDevDBServer({
  port: 1,
  user: "u",
  password: "p",
  database: "d",
  dataDir: ${JSON.stringify(join(scratch.name, "pgdata"))},
  pidFile: ${JSON.stringify(join(scratch.name, "dev-db.pid"))},
  onExit: (code: number) => {
    console.log("REPORTED " + code);
  },
});

// The way a real spawn wires one up, so the handler treats what follows as
// its own child's exit rather than a superseded one's.
server.pgProcess = proc;
server.attachExitHandler(proc);

// Nobody asked for this: no stop() in flight and no start() owning it.
proc.exitCode = 3;
proc.emit("exit", 3);

// Synchronously after, which puts it inside the handler's first await —
// where the pipes really do reach EOF while finalize() is working.
proc.emit("close", 3);

// Deliberately nothing else pending. A dev-server script has nothing either
// once its database is gone, and that is what makes the gap reachable.
`,
      );

      const out = execFileSync(process.execPath, [script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Not merely eventually: this process had nothing to keep it alive, so
      // a report that depends on a timer nobody is holding never arrives at
      // all and a crashed database reads as a clean run.
      expect(out).toContain("REPORTED 3");
    } finally {
      scratch.removeCallback();
    }
  }, 30000);
});
