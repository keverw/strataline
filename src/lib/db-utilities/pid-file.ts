import { execFileSync } from "child_process";
import { readFileSync, realpathSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { isAbsolute, join, resolve } from "path";
import { Client } from "pg";
// Imported rather than re-exported. ./local-dev-db-server names what it
// re-exports from here, so an export added to this file is not public by
// itself — but it is one line away from being, and a name that reads as part
// of this module's API is the likeliest thing for that list to grow by. These
// two are filesystem plumbing rather than PID identification, and they have
// their own module for that reason. See ./file-presence.
import { fileExists, getFilePresence } from "./file-presence";

/**
 * Identifying the process behind a PID record.
 *
 * Four rules run through everything below. They are stated once here, and the
 * code points back rather than restating them.
 *
 * **A number proves nothing.** A PID identifies a process only while that
 * process lives; the moment it exits the number is free, and after a reboot
 * every number is. Neither PID file is removed when a server is killed or the
 * machine restarts, so "something is alive at that number" is the start of the
 * question and never the answer.
 *
 * **"Cannot tell" is not "no".** Every check has three outcomes, and the third
 * is reported as `indeterminate` rather than folded into either other one.
 * `running: false` means no server was verified, not that nothing is running.
 * A caller about to do something destructive refuses on `running ||
 * indeterminate`.
 *
 * **Only positive disproof licenses destruction.** Verifying a PID authorizes
 * signaling it; calling a record `recycled` authorizes deleting it, which for
 * postmaster.pid means removing one of PostgreSQL's two interlocks against a
 * second postmaster on one data directory. Both directions are destructive, so
 * both need evidence: a command line naming another cluster, a uid that cannot
 * have changed. A tolerance window is not proof, and an absent reading is not
 * disproof.
 *
 * A boot that does not match is not in that company, though it reads like it.
 * No platform has a boot id, so every probe derives an epoch by subtracting
 * uptime from the current time, and a clock corrected since the record was
 * written moves that reading and leaves the recorded one. What it disagrees
 * with then is the correction rather than the boot. So it never licenses
 * destruction alone: something the same shift cannot have manufactured has to
 * say the same thing, which is what `liveServerVerdict` is for.
 *
 * **Two readings of one PID are two processes until proven otherwise.** The
 * number can change hands between any two observations, so anything combining
 * a command line with a timestamp — or comparing a timestamp with a later one
 * — brackets them with start-time samples and gives up if those differ. A
 * fingerprint only describes the process it was taken from while identifying.
 *
 * One platform note recurs with them: macOS reports a flat command line, so an
 * argument containing a space cannot be recovered by parsing. See
 * {@link ParsedDataDir} for what that costs and how it is signaled.
 */

/**
 * Structured contents of the PID file written by {@link LocalDevDBServer}.
 *
 * Older versions of strataline wrote the bare PID integer and nothing else,
 * which made it impossible to tell a live server apart from a recycled PID
 * after a reboot. Readers should use {@link readDevDBPidFile}, which accepts
 * both the structured and the legacy form.
 */
export interface DevDBPidRecord {
  /** PID of the postmaster process strataline spawned. */
  pid: number;
  /** Epoch milliseconds at which strataline spawned the process. */
  startedAt: number;
  /** Absolute data directory the server was started against. */
  dataDir: string;
  /** Port the server was started on. */
  port: number;
  /**
   * Epoch milliseconds of the system boot that the process belongs to, when
   * strataline could determine it. A record whose bootTime differs from the
   * current boot describes a process from a previous boot and is stale, no
   * matter what is living at that PID now.
   */
  bootTime: number | null;
  /**
   * Effective user ID that owned the process, when strataline could determine
   * it. The postmaster inherits the uid of the process that spawned it, and a
   * process cannot change uid after exec, so a live PID running as a DIFFERENT
   * uid cannot be the recorded server whatever else it looks like.
   *
   * Used only to disprove. A matching uid says almost nothing — every process
   * a user runs shares it — so it never contributes to verifying.
   *
   * Null on Windows, where there is no uid, and on records written before this
   * field existed.
   */
  uid: number | null;
  /**
   * Which on-disk shape this came from, decided by the file itself rather than
   * inferred from what the fields ended up holding.
   *
   * `legacy` is the bare PID integer written by strataline 4.0.3 and earlier,
   * which carries no metadata at all. That is worth knowing directly: a
   * structured record can also be missing a start time, so an absent field is
   * not evidence of an old file, and the two want to be told apart when
   * explaining to a person what was found.
   */
  format: "structured" | "legacy";
}

/** How a {@link DevDBServerStatus} was determined. */
export type DevDBStatusSource =
  | "pid-file"
  | "postmaster"
  | "connection"
  | "none";

/**
 * Why a record failed to verify. The distinction matters for callers gating
 * destructive work: the first three are positive evidence that the recorded
 * server is gone, while `indeterminate` is an absence of evidence and must not
 * be read as "nothing is running".
 */
export type DevDBStaleKind =
  /** Nothing at all is alive at that PID. The server is definitively gone. */
  | "process-gone"
  /** Something is alive there, but it demonstrably is not the recorded server. */
  | "recycled"
  /** The record belongs to a different cluster, so it says nothing about ours. */
  | "different-cluster"
  /**
   * A process is alive at that PID and there was not enough evidence to decide
   * either way. The recorded server may well still be running.
   */
  | "indeterminate";

/**
 * The outcome of probing for a running dev server.
 */
export interface DevDBServerStatus {
  /**
   * True only when a process was found AND positively verified as belonging to
   * this cluster and this boot. Callers gating destructive work (dropping a
   * data directory, for example) should treat this as the authoritative answer.
   */
  running: boolean;
  /** PID that was found, whether or not it verified. */
  pid: number | null;
  /** Epoch milliseconds the server started, when known. */
  startedAt: number | null;
  /** Data directory recorded alongside the PID, when known. */
  dataDir: string | null;
  /** Port recorded alongside the PID, when known. */
  port: number | null;
  /** Which file the answer came from. */
  source: DevDBStatusSource;
  /**
   * True when a PID record was found but could not be verified — a leftover
   * file from a killed server or a previous boot. A stale record must never be
   * signaled; it is safe only to delete.
   */
  stale: boolean;
  /**
   * Why the record failed to verify, or null when it verified or when no
   * record was found at all.
   */
  staleKind: DevDBStaleKind | null;
  /**
   * True when a process is alive at the recorded PID but could not be tied to
   * this server either way.
   *
   * This is deliberately separate from `running`. `running: false` means "no
   * server was verified"; it does NOT mean "nothing is running". A caller
   * about to do something destructive — deleting the data directory, say —
   * should refuse on `running || indeterminate` rather than on `running`
   * alone, and show `reason` to explain why. Proceeding on an indeterminate
   * answer risks deleting a data directory out from under a live server,
   * which is both the expensive failure and the silent one.
   */
  indeterminate: boolean;
  /**
   * The operating system's own start time for `pid`, as observed while that
   * PID was being verified — not read again afterwards.
   *
   * A caller that intends to signal the process should carry this rather than
   * sampling the start time itself. A later sample is a fresh observation that
   * can describe a different process: it only fingerprints the thing that was
   * identified if it was taken while identifying it.
   *
   * Null on every result that did not verify a PID, and on a verified one
   * whose identification consulted no clock — a command line naming this data
   * directory settles it without one — or where the platform could supply
   * none. As with {@link VerifyPidResult.startTime}, null does not say which
   * of those applies; the guarantee is the other way round, that a non-null
   * value was compared against something during the verification.
   */
  observedStartTime: number | null;
  /**
   * Probes that tried to answer and could not, phrased for a person.
   *
   * Empty on the ordinary path. A non-empty list means this answer rests on
   * less evidence than it normally would, and says which evidence is missing
   * and why. It is already appended to {@link reason}, so a caller that only
   * shows the reason loses nothing; this is here for a caller that wants to
   * branch on it or log it as a field.
   */
  probeFailures: string[];
  /**
   * Human-readable explanation, phrased for a person and suitable for putting
   * straight into a log line or a refusal message.
   */
  reason: string;
}

/** Options for {@link getLocalDevDBServerStatus}. */
export interface DevDBStatusOptions {
  /** Path to the PID file strataline writes. */
  pidFile: string;
  /** Data directory of the cluster being probed. */
  dataDir: string;
  /** Override the platform probes. Intended for tests. */
  probes?: ProcessProbes;
  /**
   * Connection details for the tiebreaker. When supplied, and ONLY when the
   * cheap checks come back indeterminate, the server is asked to identify
   * itself. Omit to skip that step entirely.
   */
  connection?: DevDBConnectionProbe;
  /** Override the connection probe. Intended for tests. */
  connectionProbe?: (
    connection: DevDBConnectionProbe,
  ) => Promise<DevDBConnectionResult>;
}

/** A memo that remembers settled answers and retries unsettled ones. */
export interface RetryingMemo<T> {
  /** The answer, probing only if none has settled yet. */
  get(): T;
  /** Offers an answer obtained elsewhere; ignored if one has settled. */
  seed(value: T): void;
}

/**
 * Memoizes a probe, remembering only the answers that will not change.
 *
 * The distinction the boot-time probe needs: a real reading, and a platform
 * that has no probe at all, both settle for the life of the process. A probe
 * that merely FAILED does not — and caching that failure would disable the
 * check permanently on the strength of one unreadable file.
 *
 * @internal Exported so the retry rule can be tested without a real probe.
 */
export function createRetryingMemo<T>(
  probe: () => { value: T; cacheable: boolean },
): RetryingMemo<T> {
  // Boxed, so a settled answer of `null` is still recognizably settled.
  let settled: { value: T } | undefined;

  return {
    get() {
      if (settled) {
        return settled.value;
      }

      const detected = probe();

      if (detected.cacheable) {
        settled = { value: detected.value };
      }

      return detected.value;
    },
    seed(value: T) {
      settled ??= { value };
    },
  };
}

const bootTimeMemo = createRetryingMemo(detectBootTime);

/**
 * Best-effort system boot time in epoch milliseconds, or null when the
 * platform is not supported.
 *
 * A real reading is remembered, and so is a platform having no probe at all; a
 * probe that merely FAILED is not — see {@link createRetryingMemo}.
 */
export function getSystemBootTime(): number | null {
  return bootTimeMemo.get();
}

/**
 * How long a probe may block before it is treated as unavailable.
 *
 * Every probe here is a SYNCHRONOUS spawn, so one that hangs does not merely
 * delay its own answer: it blocks the event loop, and nothing scheduled can
 * run to rescue it. A timer cannot, an abort cannot, and the shutdown backstop
 * in local-dev-db-server cannot either. So the bound has to be on the spawn
 * itself, which is the one place it still works.
 *
 * Generous rather than tight, because these are the normal path and a probe
 * that gives up early is not free. Timing out is reported as no reading, which
 * takes the decision resting on it to `indeterminate` — start() refusing over
 * its own healthy server. `ps` and `sysctl` answer in milliseconds; PowerShell
 * gets its own budget because its startup alone runs to seconds.
 */
const PROBE_TIMEOUT_MS = 5000;
const POWERSHELL_TIMEOUT_MS = 15_000;

/** Queries locale-independent process metadata through PowerShell CIM. */
function powershellQuery(script: string): string | null {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: POWERSHELL_TIMEOUT_MS,
      },
    ).trim();

    return out || null;
  } catch (e) {
    noteProbeFailure("PowerShell process query", e);

    return null;
  }
}

/** What one PowerShell round trip returns about a process and the host. */
export interface WindowsProcessInfo {
  bootTime: number | null;
  startTime: number | null;
  command: string | null;
}

/**
 * Why a probe could not answer, kept so a refusal can say more than that it
 * could not decide.
 *
 * A null reading takes every decision resting on it to `indeterminate`, which
 * is start() refusing over what may be a perfectly healthy server. The reason
 * it read null is the difference between "this platform cannot tell" and "`ps`
 * is not installed" or "PowerShell is blocked by execution policy" — one is
 * the design and the other is a five-minute fix, and the errno that tells them
 * apart used to be discarded at the catch.
 *
 * Bounded, because a probe called outside any verification pass appends here
 * with nothing to clear it, and this must not become a leak that grows for the
 * life of a long-running process.
 */
const MAX_RECORDED_PROBE_FAILURES = 20;

let probeFailures: string[] = [];

/**
 * Runs something with a collector of its own, and reports what it could not
 * probe.
 *
 * A swap rather than an index into a shared array, which is what this
 * replaced and which was wrong in two ways at once. Dedup is global, so a
 * failure already recorded by an EARLIER probe — the boot-time read that
 * statusFromPidFile makes before it verifies anything — suppressed the
 * identical push from inside the verification, and the slice then reported
 * nothing: the one reading that pushed the answer to `indeterminate` was the
 * one dropped. And the cap shifts from the front, which renumbers an index
 * taken before it.
 *
 * A fresh array has neither problem. Nested collectors do not see each
 * other's failures, which is the property the mark was reaching for, and
 * dedup is now per collector, which is what "the same probe failed four
 * times in one command read" actually means.
 */
function collectProbeFailures<T>(fn: () => T): {
  value: T;
  failures: string[];
} {
  const outer = probeFailures;

  probeFailures = [];

  try {
    return { value: fn(), failures: probeFailures };
  } finally {
    probeFailures = outer;
  }
}

/** Formats the part of an error worth carrying: what it was, not the stack. */
function describeProbeError(error: unknown): string {
  // `signal` is not on ErrnoException: it is what execFileSync adds when it
  // kills a child at its timeout, so it is spelled out here rather than
  // assumed away.
  const errno = error as
    | (NodeJS.ErrnoException & { signal?: NodeJS.Signals })
    | null;

  // A spawn killed at its timeout reports the signal rather than a code, and
  // that distinction is the whole diagnosis: a probe that timed out says the
  // machine is wedged, while ENOENT says the binary is missing.
  if (errno?.code) {
    return errno.code;
  }

  if (errno?.signal) {
    return `killed by ${errno.signal}`;
  }

  return getProbeErrorMessage(error);
}

function getProbeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Records why one probe could not answer.
 *
 * Deduplicated, because a single command read calls `ps` four times and a
 * missing binary would otherwise be reported four times over.
 */
function noteProbeFailure(probe: string, error: unknown): void {
  const note = `${probe}: ${describeProbeError(error)}`;

  if (probeFailures.includes(note)) {
    return;
  }

  probeFailures.push(note);

  if (probeFailures.length > MAX_RECORDED_PROBE_FAILURES) {
    probeFailures.shift();
  }
}

const windowsInfoCache = new Map<number, WindowsProcessInfo>();

let probePassActive = false;

/** Shares Windows metadata only within one verification pass. */
function withProbePass<T>(fn: () => T): T {
  if (probePassActive) {
    return fn();
  }

  probePassActive = true;

  try {
    return fn();
  } finally {
    probePassActive = false;
    windowsInfoCache.clear();
  }
}

/**
 * Parses the labeled output of the Windows metadata query.
 *
 * @internal Exported only so the parse can be checked from any platform. The
 * query runs on Windows alone, but this is where a missing field would shift
 * the others and turn a process creation time into the system boot time.
 */
export function parseWindowsProcessInfo(
  out: string | null,
): WindowsProcessInfo {
  const lines = (out ?? "").split(/\r?\n/);

  /** Reads a labeled field; `rest` takes every remaining line with it. */
  const field = (label: string, rest = false): string | null => {
    const index = lines.findIndex((line) => line.startsWith(label));

    if (index === -1) {
      return null;
    }

    const value = rest
      ? lines.slice(index).join("\n").slice(label.length)
      : lines[index].slice(label.length);

    return value.trim() || null;
  };

  return {
    bootTime: parseIsoTimestamp(field("B=")),
    startTime: parseIsoTimestamp(field("P=")),
    command: field("C=", true),
  };
}

/** Collects process and boot metadata in one PowerShell invocation. */
function getWindowsProcessInfo(pid: number): WindowsProcessInfo {
  const cached = probePassActive ? windowsInfoCache.get(pid) : undefined;

  if (cached) {
    return cached;
  }

  // Fields are labeled rather than positional: an empty line would be
  // swallowed by the trim in powershellQuery, shifting every field after it so
  // a process creation time read as the system boot time. The command line is
  // emitted last, so it runs from its label to the end and needs no delimiter.
  //
  // Written through [Console]::Out rather than returned to the pipeline, which
  // would hand each string to PowerShell's formatter and have it hard-wrapped
  // at the host buffer width, 80 or 120 columns when stdout is a pipe. A real
  // PostgreSQL command line is longer than that, so the wrap would land inside
  // the path. Quoted, it becomes a literal newline in the token and the server
  // reads as a DIFFERENT cluster, which authorizes deleting its postmaster.pid
  // and starting a second postmaster against the same data directory.
  const out = powershellQuery(
    [
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
      "$o=Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue",
      "[Console]::Out.WriteLine('B=' + $(if($o){$o.LastBootUpTime.ToUniversalTime().ToString('o')}else{''}))",
      "[Console]::Out.WriteLine('P=' + $(if($p){$p.CreationDate.ToUniversalTime().ToString('o')}else{''}))",
      "[Console]::Out.WriteLine('C=' + $(if($p){$p.CommandLine}else{''}))",
    ].join("; "),
  );

  const info = parseWindowsProcessInfo(out);

  if (probePassActive) {
    windowsInfoCache.set(pid, info);
  }

  // Boot time is a property of the host, not of the process, so whichever
  // query obtains it first satisfies getSystemBootTime and saves a spawn.
  if (info.bootTime !== null) {
    bootTimeMemo.seed(info.bootTime);
  }

  return info;
}

/**
 * Parses a PowerShell round-trip ("o") timestamp into epoch milliseconds.
 *
 * The "o" format is culture-invariant, which matters because a default
 * DateTime.ToString() would render differently on a non-English Windows and
 * silently fail to parse here.
 */
function parseIsoTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A boot time and whether the answer is worth remembering.
 *
 * `cacheable` separates "this platform has no probe" — which will not start
 * working later — from "the probe failed this time", which may well.
 */
interface DetectedBootTime {
  value: number | null;
  cacheable: boolean;
}

/** Wraps a probe result, treating a null as a failure worth retrying. */
function probed(value: number | null): DetectedBootTime {
  return { value, cacheable: value !== null };
}

function detectBootTime(): DetectedBootTime {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync("/proc/stat", "utf8");
      const match = stat.match(/^btime\s+(\d+)$/m);

      return probed(match ? parseInt(match[1], 10) * 1000 : null);
    }

    if (process.platform === "darwin") {
      const out = execFileSync("sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
      });
      // Format: { sec = 1787547616, usec = 298181 } Sun Aug 23 23:00:16 2026
      const match = out.match(/sec\s*=\s*(\d+)/);

      return probed(match ? parseInt(match[1], 10) * 1000 : null);
    }

    if (process.platform === "win32") {
      // Shares the round trip with the per-process probes. If one of those has
      // already run, this is satisfied from cache without spawning at all.
      return probed(getWindowsProcessInfo(process.pid).bootTime);
    }
  } catch (e) {
    noteProbeFailure("system boot time", e);

    return { value: null, cacheable: false };
  }

  // Unknown platform: skip the check rather than guess. Verification falls
  // back to the command line and the data directory match. Nothing will change
  // that within this process, so remember it and stop asking.
  return { value: null, cacheable: true };
}

/**
 * Reads one `ps` output field for a process, or null when it is unavailable.
 *
 * Each call is a separate snapshot, so anything that combines two of them has
 * to establish for itself that they describe the same process.
 *
 * The environment is pinned rather than inherited, because `ps` renders
 * `lstart` through strftime `%c` in the caller's locale and timezone, and the
 * reader here is a fixed parser. `LC_ALL=C` keeps the format the one that
 * parser understands: under a French locale the same field comes back as
 * "Lun 31 aoû 20:33:11 2026", which does not parse at all, and a start time
 * that is silently unavailable takes every decision that rests on it to
 * `indeterminate` — which is start() refusing over its own healthy server.
 * `TZ=UTC` pins the other half; see {@link getProcessStartTime}.
 */
function psField(pid: number, field: string): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", field], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: PROBE_TIMEOUT_MS,
    }).trim();

    return out || null;
  } catch (e) {
    noteProbeFailure(`ps -o ${field}`, e);

    return null;
  }
}

/**
 * Best-effort start time of a specific process, in epoch milliseconds, or null
 * when it cannot be determined (including when the process does not exist).
 */
export function getProcessStartTime(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const bootTime = getSystemBootTime();

      if (bootTime === null) {
        return null;
      }

      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The comm field can contain spaces and parentheses, so fields are only
      // reliably positional after the final ')'. What follows is field 3.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      // Field 22 (starttime), expressed in clock ticks since boot.
      const ticks = Number(fields[19]);

      if (!Number.isFinite(ticks)) {
        return null;
      }

      // USER_HZ is 100 on every mainstream Linux build; Node exposes no
      // sysconf(_SC_CLK_TCK) to read it properly.
      return bootTime + (ticks / 100) * 1000;
    }

    if (process.platform === "darwin") {
      const out = psField(pid, "lstart=");

      if (!out) {
        return null;
      }

      // macOS reports a formatted date rather than an epoch, and one that
      // carries no zone of its own: "Mon Aug 31 20:27:24 2026". Both ends are
      // pinned to UTC rather than left to agree by luck — psField runs `ps`
      // with TZ=UTC, and the zone is spelled out here — because the writer and
      // the reader are two different notions of "local". Date.parse resolves a
      // zone-less timestamp against the RUNTIME's zone, which is not always the
      // one `ps` printed in: `bun test` forces the JS timezone to UTC without
      // touching the environment its subprocesses inherit, and the result is a
      // start time off by the host's UTC offset. That is not a stale-looking
      // number, it is a wrong one, and verifyPid reads it as a live postmaster
      // whose start time does not match the record — `recycled`, which
      // authorizes deleting that server's postmaster.pid. A DST fall-back does
      // the same thing for an hour a year, since the repeated local hour names
      // two real instants and nothing in the string says which.
      const parsed = Date.parse(`${out} UTC`);

      return Number.isNaN(parsed) ? null : parsed;
    }

    if (process.platform === "win32") {
      return getWindowsProcessInfo(pid).startTime;
    }
  } catch (e) {
    noteProbeFailure("process start time", e);

    return null;
  }

  return null;
}

/**
 * Best-effort numeric owner of a process, or null when it cannot be read.
 *
 * A single snapshot, deliberately not bracketed the way a start time is. It is
 * compared against the record rather than against another live observation, so
 * there is nothing to splice: if the number changed hands first, the answer
 * describes the new owner and the conclusion drawn from it, that the recorded
 * server no longer holds this PID, is true of that case too.
 */
export function getProcessUid(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      // Owned by the task's EFFECTIVE uid, and by root for any task the kernel
      // will not describe. A stat rather than a spawn, so this is nearly free.
      return statSync(`/proc/${pid}`).uid;
    }

    if (process.platform === "darwin") {
      // `uid` is the effective uid here too; `ruid` would be the real one.
      const out = psField(pid, "uid=");

      if (out === null) {
        return null;
      }

      const parsed = Number(out);

      return Number.isInteger(parsed) ? parsed : null;
    }
  } catch (e) {
    noteProbeFailure("process owner", e);

    return null;
  }

  // Windows has no uid, and an unknown platform gets no guess. Both leave the
  // check switched off rather than inventing a mismatch.
  return null;
}

/**
 * Best-effort command line of a process, or null when it cannot be read.
 *
 * This is the strongest identification available without a lock, because
 * strataline starts PostgreSQL as `postgres -D <dataDir>`, so the data
 * directory the process is actually serving appears in its own command line.
 */
export function getProcessCommand(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      // Arguments are NUL-separated in /proc, and those boundaries are the only
      // thing distinguishing "-D /tmp/my db" from two arguments. Re-serialize
      // with quoting that tokenizeCommand can undo exactly.
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");

      if (!raw) {
        return null;
      }

      return raw.split("\0").filter(Boolean).map(quoteArgument).join(" ");
    }

    if (process.platform === "darwin") {
      // `command=` is flat, so an executable path containing a space cannot be
      // recovered by parsing alone. `comm=` holds exactly that path, so read it
      // separately and re-serialize with a real boundary. Separate reads are
      // separate snapshots, though, so bracket them with the start time — which
      // any PID reuse changes — rather than splice two processes together.
      const startedBefore = psField(pid, "lstart=");
      const out = psField(pid, "command=");
      const executable = psField(pid, "comm=");
      const startedAfter = psField(pid, "lstart=");

      if (!out) {
        return null;
      }

      if (
        startedBefore === null ||
        startedAfter === null ||
        startedBefore !== startedAfter
      ) {
        return null;
      }

      if (!executable) {
        return out;
      }

      // A process that rewrote its own title (PostgreSQL does this for its
      // children, though not for the postmaster) has a command line that no
      // longer starts with its executable. `comm` is still authoritative for
      // what is running, so keep it either way.
      const rest = out.startsWith(executable)
        ? out.slice(executable.length).trim()
        : out;

      return [quoteArgument(executable), rest].filter(Boolean).join(" ");
    }

    if (process.platform === "win32") {
      return getWindowsProcessInfo(pid).command;
    }
  } catch (e) {
    noteProbeFailure("process command line", e);

    return null;
  }

  return null;
}

/**
 * Classifies only the executable, never arguments that merely mention postgres.
 * Flat command lines with a possible space-containing executable are ambiguous.
 */
type ExecutableKind = "postgres" | "ambiguous" | "other";

function classifyExecutable(command: string): ExecutableKind {
  const tokens = tokenizeCommand(command);

  if (tokens.length === 0) {
    return "other";
  }

  if (isPostgresExecutable(tokens[0])) {
    return "postgres";
  }

  // Only a flat command line can have had its executable cut at a space, and
  // the one that produces one — macOS `ps command=` with no readable `comm=` —
  // reports argv[0] whole, so a path with a space in it is still a path. Demand
  // that shape before joining anything; without it `docker exec pg postgres`
  // joins its way to a postgres basename, and a definitively recycled number
  // reads as undecidable and has the caller refuse to start.
  if (!/[\\/]/.test(tokens[0])) {
    return "other";
  }

  // The executable path may have been cut at a space. Only tokens before the
  // first flag can be part of it; without that bound `/usr/bin/node worker.js
  // --label /opt/postgres` would join its way to a postgres basename.
  const joinable: string[] = [];

  for (const token of tokens) {
    if (token.startsWith("-")) {
      break;
    }

    joinable.push(token);
  }

  const couldBePostgres = joinable.some((_, index) =>
    isPostgresExecutable(joinable.slice(0, index + 1).join(" ")),
  );

  return couldBePostgres ? "ambiguous" : "other";
}

/** True when a path names the PostgreSQL server binary. */
function isPostgresExecutable(path: string): boolean {
  const basename = path.split(/[\\/]/).pop() ?? "";
  const name = basename.toLowerCase().replace(/\.exe$/, "");

  return name === "postgres" || name === "postmaster";
}

/** Quotes an argument without treating Windows path separators as escapes. */
function quoteArgument(argument: string): string {
  if (!/[\s"]/.test(argument)) {
    return argument;
  }

  return `"${argument.replace(/"/g, '""')}"`;
}

/** Tokenizes quoted arguments while preserving literal backslashes. */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let started = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (char === '"') {
      if (inQuotes && command[i + 1] === '"') {
        current += '"';
        started = true;
        i++;
        continue;
      }

      inQuotes = !inQuotes;
      started = true;
      continue;
    }

    if (!inQuotes && /\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }

      continue;
    }

    current += char;
    started = true;
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
}

/** A data directory read off a command line, and how far it can be trusted. */
interface ParsedDataDir {
  /** The value the flag names, or null when the command line names none. */
  value: string | null;
  /**
   * True when that value may have been cut short at a space.
   *
   * A PostgreSQL command line follows its data directory with another flag or
   * with nothing, so a bare token after it means the platform reported a flat
   * command line and the boundary is gone: the real directory may be the
   * parsed value plus that token. Linux re-serializes with quoting, so a path
   * containing a space stays one token and never lands here.
   *
   * This is what stops an equal-looking parse from being read as proof. A
   * server serving "/srv/pg data" parses as "/srv/pg" on macOS, which matches
   * a cluster at "/srv/pg" exactly, and verifying authorizes stopping it.
   *
   * The signature is sufficient rather than complete. A directory whose next
   * segment itself begins with a dash, "/srv/pg -data", is indistinguishable
   * from a flag and still reads as a clean parse. Nothing recovers that
   * without real argument boundaries, so Linux and Windows are exact here and
   * a flat command line is best effort.
   */
  mayBeTruncated: boolean;
}

/**
 * Extracts the data directory a PostgreSQL command line was started with,
 * alongside whether the parse could have lost a space.
 */
function parseDataDir(command: string): ParsedDataDir {
  const tokens = tokenizeCommand(command);

  /** A bare token after the value is the signature of a lost boundary. */
  const truncatedAfter = (index: number): boolean => {
    const next = tokens[index + 1];

    return next !== undefined && !next.startsWith("-");
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === "-D" || token === "--data-directory") {
      return {
        value: tokens[i + 1] ?? null,
        mayBeTruncated: truncatedAfter(i + 1),
      };
    }

    if (token.startsWith("--data-directory=")) {
      return {
        value: token.slice("--data-directory=".length) || null,
        mayBeTruncated: truncatedAfter(i),
      };
    }

    // The value may be joined to the flag, as in -D/srv/pgdata.
    if (token.startsWith("-D") && token.length > 2) {
      return { value: token.slice(2), mayBeTruncated: truncatedAfter(i) };
    }
  }

  return { value: null, mayBeTruncated: false };
}

/**
 * Extracts the data directory a PostgreSQL command line was started with, or
 * null when it does not name one (it may be inheriting PGDATA instead).
 */
export function dataDirFromCommand(command: string): string | null {
  return parseDataDir(command).value;
}

/**
 * Checks whether *some* process exists at this PID. This proves only that the
 * number is in use — never that the process is ours. Always pair it with
 * {@link verifyPid}.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    // Signal 0 performs the permission and existence checks without signaling.
    process.kill(pid, 0);

    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user, so it is
    // alive but definitely not a server we spawned.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Injectable platform probes used during PID verification. */
export interface ProcessProbes {
  isAlive(pid: number): boolean;
  command(pid: number): string | null;
  startTime(pid: number): number | null;
  bootTime(): number | null;
  uid(pid: number): number | null;
}

/**
 * Wraps a probe set so a throw from one becomes an absent reading it recorded.
 *
 * {@link systemProbes} never throws, since each of its members catches on the
 * way out. An injected one is somebody else's code: `probes` is on
 * {@link DevDBStatusOptions}, so a caller can supply its own, and a throw from
 * one used to escape verifyPid entirely and take LocalDevDBServer.start() with
 * it. That is the wrong failure for a probe, whose whole contract is that it
 * may not be able to answer.
 *
 * So a throw is treated as the null it should have returned, and recorded like
 * any other probe failure — which is also what makes the failure reporting
 * testable without a machine that is actually missing `ps`.
 *
 * `isAlive` is the one that cannot degrade to its falsy value. `false` there
 * means the process is definitively gone, which licenses deleting its record,
 * so a probe that could not tell must answer `true` and let the checks below
 * reach `indeterminate` instead. Absence of evidence is not evidence of
 * absence, and nowhere here more sharply than at that call.
 */
function guardProbes(probes: ProcessProbes): ProcessProbes {
  const guard = <T>(name: string, read: () => T, fallback: T): T => {
    try {
      return read();
    } catch (e) {
      noteProbeFailure(name, e);

      return fallback;
    }
  };

  return {
    isAlive: (pid) =>
      guard("process liveness", () => probes.isAlive(pid), true),
    command: (pid) =>
      guard("process command line", () => probes.command(pid), null),
    startTime: (pid) =>
      guard("process start time", () => probes.startTime(pid), null),
    bootTime: () => guard("system boot time", () => probes.bootTime(), null),
    uid: (pid) => guard("process owner", () => probes.uid(pid), null),
  };
}

/** The real probes, reading from the host operating system. */
export const systemProbes: ProcessProbes = {
  isAlive: isProcessAlive,
  command: getProcessCommand,
  startTime: getProcessStartTime,
  bootTime: getSystemBootTime,
  uid: getProcessUid,
};

/** What a verification concluded, and what it saw while concluding it. */
export interface VerifyPidResult {
  /**
   * What the verification rested on, or null when it did not verify. Null is
   * the whole of "not verified" — {@link kind} then says why not — so there is
   * no second flag that could disagree with this one.
   *
   * `command` is the process stating which cluster it serves, which is
   * identification: it cannot be true of a different process. `clock` is two
   * timestamps agreeing inside a tolerance, which is strong evidence and no
   * more — every process that started at about the right moment satisfies it.
   *
   * The difference matters wherever a heuristic about the past could otherwise
   * overrule what the live process says about itself; see
   * {@link probeStatusFromFiles}.
   */
  verifiedBy: "command" | "clock" | null;
  kind: DevDBStaleKind | null;
  reason: string;
  /** OS start time used by this verification, or null when it used no clock. */
  startTime: number | null;
  /**
   * Why a probe could not answer, for the probes that failed during this
   * verification. Empty on the ordinary path, where every probe answered or
   * the platform simply has none.
   *
   * A reading that is absent because the platform cannot supply it is not a
   * failure and does not appear here. What appears is a probe that tried and
   * could not: `ps` missing from PATH, PowerShell refused by execution policy,
   * a spawn killed at its timeout. Those all read as the same null everywhere
   * else, and the same `indeterminate`, so this is the only thing that tells
   * a person which of them they are looking at.
   */
  probeFailures: string[];
}

export interface VerifyPidOptions {
  /** Epoch ms the record claims the server started, if known. */
  startedAt: number | null;
  /** Epoch ms boot time the record belongs to, if known. */
  bootTime: number | null;
  /** Data directory the server should be serving, if known. */
  dataDir?: string;
  /** Numeric uid the record says owned the process, if known. */
  uid?: number | null;
  /** Override the platform probes. Intended for tests. */
  probes?: ProcessProbes;
}

export function verifyPid(
  pid: number,
  options: VerifyPidOptions,
): VerifyPidResult {
  // One pass, so the Windows probes may share a PowerShell round trip while
  // this decision is being made — and so nothing they learned survives it.
  return withProbePass(() => {
    // Collected rather than sliced out of a shared array, so this reports what
    // THIS verification could not probe and nothing else. See
    // collectProbeFailures.
    const { value, failures } = collectProbeFailures(() =>
      verifyPidInPass(pid, options),
    );

    // Attached in one place rather than at each of the ten returns above, so a
    // branch added later cannot forget to carry it.
    return { ...value, probeFailures: failures };
  });
}

/**
 * One list of what could not be probed, from every probe that fed a decision.
 *
 * Deduplicated, because the same probe failing is the same fact however many
 * readings needed it, and a status that names `ps` three times reads as three
 * problems.
 */
function mergeProbeFailures(...lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

/**
 * The verification's probe failures phrased for a person, or "" when none.
 *
 * Appended to a reason rather than replacing it: what was concluded still
 * comes first, and this says why the evidence for it was thin.
 */
function describeProbeFailures(failures: string[]): string {
  if (failures.length === 0) {
    return "";
  }

  return ` (some checks could not run: ${failures.join("; ")})`;
}

function verifyPidInPass(
  pid: number,
  options: VerifyPidOptions,
): Omit<VerifyPidResult, "probeFailures"> {
  const { startedAt: recordedStartedAt, bootTime: recordedBootTime } = options;
  const dataDir = options.dataDir ?? "";
  const probes = guardProbes(options.probes ?? systemProbes);

  if (!probes.isAlive(pid)) {
    return {
      kind: "process-gone",
      reason: `no process is running at PID ${pid}`,
      startTime: null,
      verifiedBy: null,
    };
  }

  // When the record has a timestamp, bracket the command read with a start-time
  // sample: any decision combining the command with a timestamp must first
  // prove both observations describe the same process, not two owners of a
  // rapidly reused PID.
  const startTimeBeforeCommand =
    recordedStartedAt === null ? null : probes.startTime(pid);
  const command = probes.command(pid);

  if (command !== null) {
    const executable = classifyExecutable(command);

    if (executable === "other") {
      return {
        kind: "recycled",
        reason: `PID ${pid} belongs to an unrelated process, not a PostgreSQL server, so the number has been reused`,
        startTime: null,
        verifiedBy: null,
      };
    }

    if (executable === "ambiguous") {
      // The leading tokens could be a PostgreSQL under a path containing a
      // space or an unrelated program — see classifyExecutable. Deciding
      // either way would be a destructive guess.
      return {
        kind: "indeterminate",
        reason: `PID ${pid} has a command line whose executable could not be read unambiguously on this platform (${command}), so it can neither be confirmed as a PostgreSQL server nor ruled out`,
        startTime: null,
        verifiedBy: null,
      };
    }

    const parsedDataDir = parseDataDir(command);
    const declaredDataDir = parsedDataDir.value;

    // A relative -D belongs to THAT process's working directory, not ours, so
    // resolving it here would let a PostgreSQL launched elsewhere verify as
    // this cluster — and verifying authorizes stopping it. Undecidable in both
    // directions: `recycled` would get its postmaster.pid deleted.
    if (declaredDataDir !== null && !isAbsolute(declaredDataDir)) {
      return {
        kind: "indeterminate",
        reason: `PID ${pid} is a PostgreSQL server whose command line names a relative data directory (${declaredDataDir}), which resolves against that process's own working directory rather than this one, so it can neither be confirmed as this cluster nor ruled out`,
        startTime: null,
        verifiedBy: null,
      };
    }

    if (dataDir && declaredDataDir !== null) {
      // The process states which cluster it serves, so this is decisive either
      // way. Falling through to the approximate start-time comparison here
      // would let a PID recycled to a DIFFERENT PostgreSQL within the
      // tolerance window verify as ours.
      if (sameDataDir(declaredDataDir, dataDir)) {
        // Equal only as far as the parse goes. A flat command line that lost a
        // space reads "/srv/pg data" as "/srv/pg", which matches a cluster at
        // "/srv/pg" exactly, and verifying authorizes stopping that server. So
        // a parse that could have been cut short is not proof of anything.
        if (parsedDataDir.mayBeTruncated) {
          return {
            kind: "indeterminate",
            reason: `PID ${pid} is a PostgreSQL server whose data directory could not be read unambiguously on this platform (parsed as ${declaredDataDir}, which a further argument may belong to), so it can neither be confirmed as this cluster nor ruled out`,
            startTime: null,
            verifiedBy: null,
          };
        }

        // No start time is reported, because none was consulted. Reading one
        // here would be an unchecked second snapshot, so a PID reused since the
        // command read would hand back the replacement's start time as a
        // fingerprint of the original. A caller wanting one brackets it itself,
        // as captureSignalFingerprint does.
        return {
          kind: null,
          reason: `PID ${pid} is a PostgreSQL server running against this data directory`,
          startTime: null,
          verifiedBy: "command",
        };
      }

      // A truncated parse is no more decisive when it disagrees with ours than
      // when it matches, so both signals are needed. They catch different
      // things: `looksTruncatedFrom` only recognizes a parse that is a prefix
      // of some spelling of our own path, and misses one that also went
      // through a symlink — "/tmp/pg", parsed from a server serving "/tmp/pg
      // data" which is a symlink to our "/Users/me/pg data", is a prefix of
      // neither — while `mayBeTruncated` is the command line reporting the
      // loss itself and needs no path recognition at all.
      if (
        parsedDataDir.mayBeTruncated ||
        looksTruncatedFrom(declaredDataDir, dataDir)
      ) {
        return {
          kind: "indeterminate",
          reason: `PID ${pid} is a PostgreSQL server whose data directory could not be read unambiguously on this platform (parsed as ${declaredDataDir}), so it can neither be confirmed as this cluster nor ruled out`,
          startTime: null,
          verifiedBy: null,
        };
      }

      return {
        kind: "recycled",
        reason: `PID ${pid} is a PostgreSQL server, but it is serving ${declaredDataDir} rather than this cluster, so the number has been reused`,
        startTime: null,
        verifiedBy: null,
      };
    }

    // PostgreSQL, but its command line names no data directory at all — it may
    // be inheriting PGDATA. Nothing decisive yet, so fall through to the
    // timestamp checks.
  }

  const currentBootTime = probes.bootTime();

  // A record from a previous boot cannot describe a live process, so whatever
  // holds the PID now is somebody else's.
  if (
    recordedBootTime !== null &&
    currentBootTime !== null &&
    // Boot time is derived from slightly different clocks per platform, so
    // allow a small tolerance rather than demanding an exact match.
    Math.abs(recordedBootTime - currentBootTime) > 5000
  ) {
    return {
      kind: "recycled",
      reason: `PID ${pid} is in use, but the record was written during a previous boot, so the number now belongs to a different process`,
      startTime: null,
      verifiedBy: null,
    };
  }

  // The owner, where the record carries one. Its placement between the
  // command line and the timestamps is the whole point. Ahead of the
  // timestamps because every path below returns, so a record with a start time
  // — which is every record strataline writes — would never reach a check
  // placed after them, and because a uid cannot change after exec while the
  // start-time window is a tolerance: a tolerance must not overrule proof.
  // Behind the command line because that is decisive in both directions, and a
  // uid mismatch pre-empting it would call a PostgreSQL demonstrably serving
  // this cluster `recycled`.
  const recordedUid = options.uid ?? null;

  if (recordedUid !== null) {
    const actualUid = probes.uid(pid);

    // Root is not taken as a mismatch. Linux reports the owner of /proc/<pid>
    // as root for any task it will not describe — one that is not dumpable,
    // which a process can become by its own prctl — and that is indistinguish-
    // able from a process genuinely running as root. Reading it as proof would
    // mark a live postmaster of this cluster `recycled` on the strength of the
    // kernel declining to answer. Nothing else here can be wrong in that
    // direction, so this one is held to the same bar.
    if (actualUid !== null && actualUid !== 0 && actualUid !== recordedUid) {
      return {
        kind: "recycled",
        reason: `PID ${pid} is in use, but that process runs as uid ${actualUid} while the recorded server was started by uid ${recordedUid}, and a process cannot change uid, so the number has been reused`,
        startTime: null,
        verifiedBy: null,
      };
    }
  }

  // Only the comparisons below read this, and only when the record carries a
  // start time of its own. Sampling unconditionally forks an extra `ps` on
  // macOS for a value nothing reads, once per signal during a shutdown.
  const actualStartTime =
    recordedStartedAt === null ? null : probes.startTime(pid);

  if (
    recordedStartedAt !== null &&
    (startTimeBeforeCommand === null ||
      actualStartTime === null ||
      startTimeBeforeCommand !== actualStartTime)
  ) {
    return {
      kind: "indeterminate",
      reason: `PID ${pid} changed or could not be observed consistently while it was being identified, so its start time could not be tied to one process`,
      startTime: null,
      verifiedBy: null,
    };
  }

  if (recordedStartedAt !== null && actualStartTime !== null) {
    // Both record formats capture their timestamp at or after the process
    // started, so the genuine process never started meaningfully AFTER its
    // record was written, while a recycled PID always did — the number only
    // becomes free once the original died. Hence the asymmetric window: a
    // symmetric one would verify a different PostgreSQL that inherited PGDATA
    // and picked up the PID moments after the recorded server exited.
    const startedAfterRecord = actualStartTime - recordedStartedAt > 2000;
    const startedLongBefore = recordedStartedAt - actualStartTime > 60_000;

    if (startedAfterRecord || startedLongBefore) {
      return {
        kind: "recycled",
        reason: `PID ${pid} is in use, but that process did not start when the recorded server did, so the number has been reused`,
        startTime: actualStartTime,
        verifiedBy: null,
      };
    }

    return {
      kind: null,
      reason: `PID ${pid} matches the recorded server`,
      startTime: actualStartTime,
      verifiedBy: "clock",
    };
  }

  // Absence of evidence rather than evidence of absence: something IS alive at
  // this PID and we cannot say whose it is. Neither a matching boot time nor a
  // matching uid is enough on its own — the first shows only that the record
  // was written during this boot, the second only that some process of this
  // user holds the number now.

  return {
    kind: "indeterminate",
    // Nothing here was compared against anything, so reporting a start time
    // would pass off an unchecked snapshot as an observation the decision
    // rested on.
    startTime: null,
    verifiedBy: null,
    reason: `PID ${pid} is in use, but there was not enough information to confirm it as this server or rule it out as another process (${
      command === null
        ? "its command line could not be read on this platform"
        : "it is a PostgreSQL process but not provably this cluster"
    })`,
  };
}

/**
 * A JSON field that must be a whole, non-negative number to mean anything, or
 * null when it is anything else.
 *
 * The counterpart of {@link parseWholeInteger} for the structured format: that
 * one refuses a string that merely starts with a number, this one refuses a
 * number that cannot describe what the field is for. Nothing here counts down
 * or fractions — an epoch, a port, a uid — so a negative or fractional value
 * is a corrupt record rather than an unusual server.
 */
function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Reads strataline's PID file, accepting both the structured form and the
 * legacy bare-integer form written by strataline 4.0.3 and earlier.
 *
 * @returns The record, or null when the file is absent or unparseable.
 */
export async function readDevDBPidFile(
  pidFile: string,
): Promise<DevDBPidRecord | null> {
  if (!(await fileExists(pidFile))) {
    return null;
  }

  try {
    return parseDevDBPidRecord(await readFile(pidFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Parses PID file contents, accepting both the structured form and the legacy
 * bare-integer form written by strataline 4.0.3 and earlier.
 *
 * Separate from {@link readDevDBPidFile} so a caller holding bytes it has
 * already read — and has established are the ones it is deciding about — can
 * ask whose record they are without opening the path again. A second read is a
 * second observation, and the record can be replaced between the two, so the
 * answer would be about a file the caller never examined.
 *
 * @returns The record, or null when the contents are empty or unparseable.
 */
export function parseDevDBPidRecord(contents: string): DevDBPidRecord | null {
  const raw = contents.trim();

  if (!raw) {
    return null;
  }

  // The file's own shape decides which format this is, and nothing downstream
  // has to infer it from which fields came back empty.
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<DevDBPidRecord>;

      // Positive, not merely integral: the legacy branch below has always
      // demanded that, and a non-positive number reaching process.kill would
      // name a process group rather than a process.
      if (
        typeof parsed.pid !== "number" ||
        !Number.isSafeInteger(parsed.pid) ||
        parsed.pid <= 0
      ) {
        return null;
      }

      return {
        pid: parsed.pid,
        // Absent and nonsensical are the same answer, and it is "unknown"
        // rather than the number as written. Every one of these fields is
        // evidence in the recycled/verified decision, and each is compared
        // against a reading that cannot be negative: an epoch from the clock,
        // an epoch from the kernel, an id from the process table. A record
        // saying startedAt -1 and bootTime -1 is not describing a server that
        // started before the epoch, it is corrupt — but read as written it
        // disagrees with this boot by more than the tolerance, and a live PID
        // nothing else can identify is then decisively `recycled`, which
        // authorizes deleting its record. Degrading to unknown leaves that
        // case indeterminate, which is what an unreadable field is.
        startedAt: nonNegativeInteger(parsed.startedAt) ?? 0,
        dataDir: typeof parsed.dataDir === "string" ? parsed.dataDir : "",
        port: nonNegativeInteger(parsed.port) ?? 0,
        bootTime: nonNegativeInteger(parsed.bootTime),
        uid: nonNegativeInteger(parsed.uid),
        format: "structured",
      };
    } catch {
      return null;
    }
  }

  // Legacy format: the bare PID and nothing else, so the whole file has to BE
  // the number. parseInt would take a prefix instead, and this is untrusted
  // content that ends up as a signal target. It does not make a legacy record
  // trustworthy — a truncated one is still all digits — which is why such a
  // record is confirmed against the live process rather than its own contents.
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const legacyPid = parseInt(raw, 10);

  if (!Number.isSafeInteger(legacyPid) || legacyPid <= 0) {
    return null;
  }

  return {
    pid: legacyPid,
    startedAt: 0,
    dataDir: "",
    port: 0,
    bootTime: null,
    uid: null,
    format: "legacy",
  };
}

/**
 * Parses a field that must BE a non-negative integer, not merely start with
 * one.
 *
 * parseInt takes a prefix, so a corrupted "123abc" would read as 123. These
 * numbers become signal targets and evidence in the recycled/verified
 * decision, so a malformed record has to stay unusable. That is the same bar
 * {@link readDevDBPidFile} already applies to the legacy format.
 */
function parseWholeInteger(value: string): number | null {
  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = parseInt(trimmed, 10);

  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parsed contents of PostgreSQL's own `postmaster.pid`. */
export interface PostmasterPidRecord {
  pid: number;
  dataDir: string;
  /** Epoch milliseconds; PostgreSQL records this in seconds on line 3. */
  startedAt: number;
  port: number;
}

/**
 * Parses PostgreSQL's `postmaster.pid` from a cluster's data directory.
 *
 * The layout is fixed: line 1 PID, line 2 data directory, line 3 start time in
 * epoch seconds, line 4 port. Unlike strataline's own file it names the data
 * directory, which is the only signal that distinguishes this cluster from
 * another PostgreSQL running on the same machine.
 *
 * PostgreSQL removes this file on clean shutdown but leaves it behind after a
 * kill or a reboot, so a record being present does not mean the server is up.
 */
export async function readPostmasterPidFile(
  dataDir: string,
): Promise<PostmasterPidRecord | null> {
  const path = join(dataDir, "postmaster.pid");

  if (!(await fileExists(path))) {
    return null;
  }

  try {
    const lines = (await readFile(path, "utf8")).split("\n");
    const pid = parseWholeInteger(lines[0] ?? "");

    if (pid === null || pid <= 0) {
      return null;
    }

    const startSeconds = parseWholeInteger(lines[2] ?? "");
    const port = parseWholeInteger(lines[3] ?? "");

    return {
      pid,
      dataDir: (lines[1] ?? "").trim(),
      startedAt: startSeconds === null ? 0 : startSeconds * 1000,
      port: port ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Canonicalizes a path, following symlinks where possible so that a symlinked
 * or bind-mounted data directory does not read as a different cluster.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // The path may not exist yet; a lexical resolve is the best available.
    return resolve(path);
  }
}

/**
 * Binds a PID to a connection-confirmed server using both executable identity
 * and an asymmetric start-time match.
 */
function canBindToServer(
  pid: number,
  startedAt: number | null,
  dataDir: string,
  rawProbes: ProcessProbes = systemProbes,
): number | null {
  if (startedAt === null) {
    return null;
  }

  // Guarded like every other probe read, so an injected probe that throws is
  // an answer this could not get rather than an exception out of a status
  // check. See guardProbes.
  const probes = guardProbes(rawProbes);

  const before = probes.startTime(pid);
  const command = probes.command(pid);

  // Only an unambiguous executable will do. This authorizes a signal, so a
  // command line that merely *could* be a PostgreSQL is not evidence.
  if (command === null || classifyExecutable(command) !== "postgres") {
    return null;
  }

  const declaredDataDir = dataDirFromCommand(command);

  // Not resolvable from here — see verifyPidInPass. Binding a PID authorizes
  // signaling it, so a claim we cannot resolve is not a candidate at all.
  if (declaredDataDir !== null && !isAbsolute(declaredDataDir)) {
    return null;
  }

  // A candidate naming a different cluster is positive disproof — see
  // verifyPidInPass — and a start time inside the tolerance window must not
  // override it.
  //
  // An ambiguous path is deliberately NOT rejected, and that is a real
  // concession rather than a free one: it suppresses a rejection that exact
  // boundaries would have made, leaving the start-time bracket as the only
  // gate. It buys the case that has no other rescue. Where our own data
  // directory contains a space, verifyPid can never do better than
  // indeterminate on a flat command line, so this is the one path that
  // identifies our own server at all. Rejecting here instead would have
  // start() refuse forever for every macOS user with a space in the path.
  if (
    dataDir &&
    declaredDataDir !== null &&
    !sameDataDir(declaredDataDir, dataDir) &&
    !looksTruncatedFrom(declaredDataDir, dataDir)
  ) {
    return null;
  }

  const actual = probes.startTime(pid);

  // Separate OS reads on POSIX, so only a stable bracket binds either
  // observation to one process — see verifyPidInPass.
  if (before === null || actual === null || before !== actual) {
    return null;
  }

  // Return the matched observation so callers do not resample after verification.
  return actual - startedAt <= 2000 && startedAt - actual <= 5000
    ? actual
    : null;
}

/**
 * True when `parsed` could be `dataDir` cut short at a space — the one way
 * splitting a flat command line on whitespace goes wrong. "/tmp/my" is a
 * possible truncation of "/tmp/my db"; "/srv/pgdata-backup" is not a
 * truncation of "/srv/pgdata", so a genuinely different cluster stays
 * decisive.
 */
function looksTruncatedFrom(parsed: string, dataDir: string): boolean {
  return [dataDir, canonicalPath(dataDir), resolve(dataDir)].some((candidate) =>
    candidate.startsWith(`${parsed} `),
  );
}

/**
 * True when two data directory paths refer to the same location.
 *
 * Exported because a caller deciding whether a record is its own cluster's
 * must not reimplement this: a lexical comparison would read a symlinked or
 * bind-mounted spelling of one directory as a different cluster, and the
 * decisions that comparison gates are destructive in both directions.
 */
export function sameDataDir(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }

  const left = canonicalPath(a);
  const right = canonicalPath(b);

  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Connection details used to ask a running server to identify itself.
 */
export interface DevDBConnectionProbe {
  port: number;
  user: string;
  password: string;
  database: string;
  host?: string;
  /** How long to wait before giving up. Defaults to 3 seconds. */
  timeoutMs?: number;
}

/** What asking the database directly told us. */
export interface DevDBConnectionResult {
  /** Data directory the live server reports serving, if it answered. */
  dataDir: string | null;
  /** Epoch ms the live server reports having started, if it answered. */
  startedAt: number | null;
  /** True when something on the port responded, even if it refused us. */
  responded: boolean;
  /** Why the probe could not identify the server, when it could not. */
  error: string | null;
}

/**
 * Asks a running PostgreSQL to identify itself.
 *
 * This is the only check that establishes identity outright rather than
 * inferring it: a server that answers tells us its own data directory. It is
 * also the most expensive, so it is used as a tiebreaker rather than on every
 * path — see {@link getLocalDevDBServerStatus}.
 */
export async function identifyViaConnection(
  connection: DevDBConnectionProbe,
): Promise<DevDBConnectionResult> {
  const timeoutMs = connection.timeoutMs ?? 3000;
  const client = new Client({
    host: connection.host ?? "127.0.0.1",
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    connectionTimeoutMillis: timeoutMs,
    // The connection timeout stops covering us once the socket is open. Apply
    // the same bound to both identification queries so an unresponsive server
    // cannot hang status checks or LocalDevDBServer.start() indefinitely.
    query_timeout: timeoutMs,
  });

  try {
    await client.connect();

    // pg_postmaster_start_time() is available to any user; data_directory
    // needs superuser or pg_read_all_settings. Ask for the start time first so
    // a restricted user still gets a useful answer.
    const base = await client.query<{ started_at: Date }>(
      "SELECT pg_postmaster_start_time() AS started_at",
    );
    const startedAt = base.rows[0]?.started_at
      ? new Date(base.rows[0].started_at).getTime()
      : null;

    try {
      const result = await client.query<{ data_directory: string }>(
        "SELECT current_setting('data_directory') AS data_directory",
      );

      return {
        dataDir: result.rows[0]?.data_directory ?? null,
        startedAt,
        responded: true,
        error: null,
      };
    } catch (e) {
      // Connected, but not permitted to see which cluster this is. That is
      // still worth reporting as a response: it cannot confirm identity, so
      // the cautious answer stands rather than being downgraded.
      return {
        dataDir: null,
        startedAt,
        responded: true,
        error: `connected, but could not read data_directory (${
          e instanceof Error ? e.message : String(e)
        }); grant pg_read_all_settings to this user to allow identification`,
      };
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    const message = e instanceof Error ? e.message : String(e);
    // A refusal still proves something is listening; it just will not talk to
    // us. That is worth reporting differently from nothing being there. pg's
    // own connect timeout carries no code at all, so it has to be recognized
    // by its message: a port that blackholes packets never answered, and
    // saying it did sends the reader looking for a server that is not there.
    const responded =
      code !== "ECONNREFUSED" &&
      code !== "ETIMEDOUT" &&
      !/timeout expired/i.test(message);

    return {
      dataDir: null,
      startedAt: null,
      responded,
      error: message,
    };
  } finally {
    try {
      await client.end();
    } catch {
      // Connection may never have opened.
    }
  }
}

/**
 * Determines whether a strataline dev database server is currently running.
 *
 * This is the supported way for other tools to ask the question. It verifies
 * rather than guesses: a PID is only reported as running once it has been
 * matched to this cluster and this boot, so a leftover file from a killed
 * server or a previous boot is reported as `stale` instead of `running`.
 *
 * PostgreSQL's own `postmaster.pid` is preferred because it names the data
 * directory, and strataline's PID file is consulted as a fallback.
 *
 * @example
 * ```ts
 * const status = await getLocalDevDBServerStatus({ pidFile, dataDir });
 *
 * if (status.running || status.indeterminate) {
 *   throw new Error(`Refusing to reset: ${status.reason}`);
 * }
 * ```
 */
export async function getLocalDevDBServerStatus(
  options: DevDBStatusOptions,
): Promise<DevDBServerStatus> {
  const status = await probeStatusFromFiles(options);

  // The cheap checks decided, so there is nothing to pay for.
  if (!status.indeterminate || !options.connection) {
    return status;
  }

  // Only here — where PIDs and timestamps could not settle it — is it worth
  // opening a connection. A server that answers names its own data directory,
  // which is identity rather than inference.
  const probe = options.connectionProbe ?? identifyViaConnection;

  // Guarded like every other probe, for the reason guardProbes gives: this is
  // an injectable option, so it is somebody else's code, and a probe's whole
  // contract is that it may not be able to answer. `identifyViaConnection`
  // reports a refusal rather than throwing, but a supplied one need not, and a
  // throw here used to escape this call, then cleanupExistingProcess, and
  // reject LocalDevDBServer.start() — which is start() failing over the
  // tiebreaker rather than falling back to the cautious answer the cheap
  // checks already reached.
  //
  // So a throw is the "could not identify" it should have been, and the
  // status it leaves standing is the indeterminate one that got us here. What
  // it adds is why, recorded as a probe failure like any other, since a
  // tiebreaker that could not run is exactly what a person reading a refusal
  // wants named.
  let answer: DevDBConnectionResult;

  try {
    answer = await probe(options.connection);
  } catch (e) {
    const failure = `connection identification: ${describeProbeError(e)}`;

    return {
      ...status,
      probeFailures: mergeProbeFailures(status.probeFailures, [failure]),
      reason: `${status.reason}; the server on port ${options.connection.port} could not be asked to identify itself (${getProbeErrorMessage(e)})`,
    };
  }

  if (answer.dataDir !== null) {
    if (sameDataDir(answer.dataDir, options.dataDir)) {
      const postmaster = await readPostmasterPidFile(options.dataDir);
      // The connection proves this CLUSTER is live, not that the unidentified
      // PID belongs to it — and reporting a PID here authorizes terminating
      // it. So bind one to the confirmed server or report none. postmaster.pid
      // is NOT exempt from that bar: the cheap checks may already have ruled
      // that exact PID out as recycled.
      const bound = withProbePass(() => {
        // The two records normally name the same postmaster. Probe each numeric
        // PID only once: retrying an unstable observation would let a replacement
        // settle between attempts and turn the failed bracket into a false match.
        const candidates = new Set([postmaster?.pid ?? null, status.pid]);

        for (const candidate of candidates) {
          if (candidate === null) {
            continue;
          }

          const observed = canBindToServer(
            candidate,
            answer.startedAt,
            options.dataDir,
            options.probes,
          );

          if (observed !== null) {
            return { pid: candidate, observedStartTime: observed };
          }
        }

        return null;
      });
      const boundPid = bound?.pid ?? null;

      return {
        ...status,
        running: true,
        stale: false,
        staleKind: null,
        indeterminate: false,
        pid: boundPid,
        observedStartTime: bound?.observedStartTime ?? null,
        startedAt: answer.startedAt ?? status.startedAt,
        dataDir: answer.dataDir,
        source: "connection",
        reason: `a running PostgreSQL on port ${options.connection.port} confirmed it is serving this data directory`,
      };
    }

    // A different cluster answering on that port says nothing about the
    // unidentified PID, so the cautious answer has to stand: resolving to
    // "safely stale" would license deleting this cluster's files.
    return {
      ...status,
      reason: `${status.reason}; a PostgreSQL on port ${
        options.connection.port
      } answered but is serving a different data directory (${answer.dataDir})${
        // Only when there is one. This lands in a refusal a person has to act
        // on, and "PID null" sends them looking for a process that was never
        // identified in the first place.
        status.pid === null ? "" : `, which does not identify PID ${status.pid}`
      }`,
    };
  }

  // The probe could not identify anything, so the safe answer stands. Say what
  // was tried, since this reason may end up in a refusal message.
  return {
    ...status,
    reason: answer.responded
      ? `${status.reason}; a server on port ${options.connection.port} responded but would not identify itself (${answer.error})`
      : `${status.reason}; nothing answered on port ${options.connection.port}`,
  };
}

/** What the live process at a PID says about a cluster it might be serving. */
type LiveServerVerdict =
  /** It names that data directory on its own command line. */
  | "serving"
  /** Nothing is there, or what is there demonstrably is not that server. */
  | "ruled-out"
  /** Something is alive and there was not enough evidence to decide. */
  | "indeterminate";

/**
 * Asks the live process at `pid` whether it is a server for `dataDir`.
 *
 * Three answers rather than two, and the middle one is the point. A caller
 * about to destroy a record on the strength of a clock reading needs positive
 * disproof about the PID as well — see the boot-time note in
 * {@link statusFromPidFile} — and a boolean would fold "cannot tell" into
 * whichever end it sat next to. Folded into `ruled-out`, a live server whose
 * command line simply could not be read this time has its record deleted,
 * which is the destruction the module's rules exist to refuse.
 *
 * What is withheld is what a clock can move, and only that. A recorded start
 * time would admit the timestamp comparison and a recorded boot time the boot
 * comparison, and those are the two readings an adjustment shifts, so neither
 * is offered and `serving` can only come from a command line. A uid is not one
 * of them — a process cannot change it after exec — so it is passed through
 * and may still rule a PID out.
 */
function liveServerVerdict(
  pid: number,
  dataDir: string,
  probes?: ProcessProbes,
  uid?: number | null,
): { verdict: LiveServerVerdict; probeFailures: string[] } {
  const check = verifyPid(pid, {
    startedAt: null,
    bootTime: null,
    dataDir,
    uid,
    probes,
  });

  // Carried out with the verdict rather than discarded. This is the probe that
  // decides whether a clock reading may license destruction, so an
  // `indeterminate` here is exactly where a person wants to know that `ps`
  // could not run rather than that the platform had nothing to say.
  const probeFailures = check.probeFailures;

  if (check.verifiedBy !== null) {
    return { verdict: "serving", probeFailures };
  }

  return {
    verdict:
      check.kind === "process-gone" || check.kind === "recycled"
        ? "ruled-out"
        : "indeterminate",
    probeFailures,
  };
}

/**
 * Prefers useful fallback evidence without discarding an unresolved live PID.
 * An indeterminate primary result is the safety ceiling: no other stale record
 * can prove that the process named by the primary is safe to ignore.
 */
async function preferInformativeFallback(
  stale: DevDBServerStatus,
  pidFile: string,
  dataDir: string,
  probes?: ProcessProbes,
): Promise<DevDBServerStatus> {
  // An indeterminate primary is the ceiling for everything the fallback can
  // say, a verified record included: where the two name different numbers,
  // verifying one says nothing about the other, and answering `running` would
  // start a second server against a data directory the other may still serve.
  //
  // Ahead of the probe rather than after it, because nothing the probe could
  // return survives this. Reading the record costs a full verifyPid — six
  // blocking `ps` spawns on macOS, on the path a start takes when the live
  // postmaster cannot be identified — for an answer discarded on the next
  // line.
  if (stale.indeterminate) {
    return stale;
  }

  const fallback = await statusFromPidFile(pidFile, dataDir, probes);

  if (
    fallback.running ||
    fallback.indeterminate ||
    fallback.staleKind === "different-cluster"
  ) {
    return fallback;
  }

  return stale;
}

async function probeStatusFromFiles(
  options: DevDBStatusOptions,
): Promise<DevDBServerStatus> {
  const { pidFile, dataDir, probes } = options;
  const postmasterPidPath = join(dataDir, "postmaster.pid");
  const initialPostmasterPresence = await getFilePresence(postmasterPidPath);

  if (initialPostmasterPresence === "inaccessible") {
    return unreadablePidStatus(
      "postmaster",
      postmasterPidPath,
      dataDir,
      "PostgreSQL",
    );
  }

  const postmaster = await readPostmasterPidFile(dataDir);

  if (!postmaster) {
    // Gone by the second look means it was removed between them — usually
    // PostgreSQL tidying up on a clean shutdown — which is an absence, not an
    // unreadable record. Anything still there stays undecidable.
    const finalPostmasterPresence = await getFilePresence(postmasterPidPath);

    if (finalPostmasterPresence !== "absent") {
      return unreadablePidStatus(
        "postmaster",
        postmasterPidPath,
        dataDir,
        "PostgreSQL",
      );
    }
  }

  if (postmaster) {
    // postmaster.pid has no boot id, but its start time cannot predate the
    // current boot if the process is genuinely still alive.
    //
    // Guarded and collected like every probe read inside verifyPid. Raw, this
    // was the one call an injected probe could throw out of and end the whole
    // status check with, which is the failure guardProbes exists to rule out,
    // and its failure was recorded where nothing would ever report it.
    const { value: bootTime, failures: bootProbeFailures } =
      collectProbeFailures(() =>
        guardProbes(probes ?? systemProbes).bootTime(),
      );

    // Asked once, here, and reused below. One view of the machine, and the
    // answer is needed before the boot check as well as after it.
    const verification = verifyPid(postmaster.pid, {
      startedAt: postmaster.startedAt || null,
      bootTime,
      dataDir,
      probes,
    });

    // Split out of the condition below so the check that corroborates it can
    // be named and its own probe failures reported, and so naming it still
    // costs no probe on the ordinary path: it runs only where this is true.
    const predatesThisBoot =
      bootTime !== null &&
      postmaster.startedAt > 0 &&
      postmaster.startedAt < bootTime - 5000;

    const postmasterLiveCheck = predatesThisBoot
      ? liveServerVerdict(postmaster.pid, dataDir, probes)
      : null;

    /**
     * Everything this path could not probe, from every probe that fed it.
     *
     * One function rather than a list per return, because the field and the
     * sentence appended to `reason` have to be the same thing. They were not:
     * one branch set the field empty while the reason named the failures, and
     * others did the reverse, so a caller branching on the field and a person
     * reading the message saw different machines.
     *
     * It takes no argument for the same reason, having briefly taken one. The
     * live check's failures were passed on the `ruled-out` return alone, so
     * every other return dropped them — including the undecidable one, which
     * is the single place they matter most: that answer is a refusal a person
     * has to act on, and "`ps` could not run" is exactly what tells them the
     * refusal is a five-minute fix rather than the design. A branch cannot
     * forget what it does not have to remember, so the reading is merged here
     * and the null it holds where the check never ran contributes nothing.
     */
    const postmasterProbeFailures = (): string[] =>
      mergeProbeFailures(
        bootProbeFailures,
        verification.probeFailures,
        postmasterLiveCheck?.probeFailures ?? [],
      );

    // A start time predating this boot otherwise proves the record survived a
    // restart. Decisive rather than merely unusable as evidence: leaving it to
    // the timestamp comparison would let a PID reused within the tolerance
    // window verify as this server.
    //
    // What it takes to be decisive is the whole of the condition below. This
    // compares two readings of DIFFERENT kinds — a process start time
    // PostgreSQL wrote from its own wall clock, against a boot epoch every
    // platform derives by subtracting uptime from the current time — so a
    // correction to the clock moves the second and leaves the first, and a
    // postmaster that has been up for an hour appears to predate its own boot.
    // (An RTC wrong at boot and a VM resumed from a snapshot do the same
    // thing.) Deciding `recycled` from that alone deletes the postmaster.pid
    // of a server that is running right now, and that file is the first of
    // PostgreSQL's two interlocks against a second postmaster here.
    //
    // So the PID has to be ruled out on evidence that the same shift cannot
    // have produced, and `verification` will not do: it was given a recorded
    // start time, so its `recycled` may rest on the very comparison in doubt —
    // a `clock` match is no better, being the same reading agreeing rather
    // than disagreeing. liveServerVerdict withholds the timestamps and asks
    // only what the process says about itself, which leaves a dead PID or a
    // command line naming another cluster as the only company this reading may
    // license destruction in. An unidentifiable live PID is not disproof of
    // anything and keeps the cautious answer.
    if (postmasterLiveCheck?.verdict === "ruled-out") {
      return preferInformativeFallback(
        {
          running: false,
          pid: postmaster.pid,
          startedAt: postmaster.startedAt,
          dataDir: postmaster.dataDir || dataDir,
          port: postmaster.port || null,
          source: "postmaster",
          observedStartTime: null,
          probeFailures: postmasterProbeFailures(),
          stale: true,
          staleKind: "recycled",
          indeterminate: false,
          reason:
            `stale postmaster.pid: it records a server started before the current boot, so PID ${postmaster.pid} now belongs to a different process` +
            describeProbeFailures(postmasterProbeFailures()),
        },
        pidFile,
        dataDir,
        probes,
      );
    }

    // Only now does it matter which cluster the file is about. A record that
    // predates the boot is gone whatever it named, and calling it
    // `different-cluster` first would have the caller refuse over a number
    // some unrelated process picked up across the restart.
    if (postmaster.dataDir && !sameDataDir(postmaster.dataDir, dataDir)) {
      return preferInformativeFallback(
        {
          running: false,
          pid: postmaster.pid,
          startedAt: postmaster.startedAt || null,
          dataDir: postmaster.dataDir,
          port: postmaster.port || null,
          source: "postmaster",
          observedStartTime: null,
          probeFailures: postmasterProbeFailures(),
          stale: true,
          staleKind: "different-cluster",
          indeterminate: false,
          reason:
            `postmaster.pid names a different data directory (${postmaster.dataDir}), so it describes another cluster rather than this one` +
            describeProbeFailures(postmasterProbeFailures()),
        },
        pidFile,
        dataDir,
        probes,
      );
    }

    const { verifiedBy, kind, reason, startTime } = verification;

    if (verifiedBy !== null) {
      return {
        running: true,
        pid: postmaster.pid,
        startedAt: postmaster.startedAt || null,
        dataDir: postmaster.dataDir || dataDir,
        port: postmaster.port || null,
        source: "postmaster",
        observedStartTime: startTime,
        probeFailures: postmasterProbeFailures(),
        stale: false,
        staleKind: null,
        indeterminate: false,
        reason:
          `PostgreSQL is running for this data directory (PID ${postmaster.pid})` +
          describeProbeFailures(postmasterProbeFailures()),
      };
    }

    // What disproved the PID matters as much as that something did, and the
    // verification says which: only the timestamp comparison reports the start
    // time it compared, so a `recycled` carrying one is the clock's verdict and
    // a `recycled` without one is the command line's. (The boot and uid checks
    // cannot produce either here. This path passes the current boot time as the
    // recorded one, so that comparison never fires, and postmaster.pid carries
    // no uid to check.)
    //
    // The clock's verdict alone will not do. It rests on the same wall clock
    // the shortcut above reads, and on Linux literally so: a start time there
    // is the current /proc boot epoch plus monotonic ticks, so an adjustment
    // moves it exactly as it moves the boot reading, and a live postmaster
    // stops matching the start time it wrote into its own postmaster.pid. The
    // shortcut declining to fire and this then reporting `recycled` anyway
    // would route around that refusal to the same destruction — deleting
    // PostgreSQL's own interlock from under a running server.
    //
    // So it degrades to what it is: something is alive at that PID and this
    // could not tell whose it is.
    const clockAlone = kind === "recycled" && startTime !== null;

    // postmaster.pid was stale. Fall through to strataline's own file, which
    // may still describe a live server if the two ever disagree.
    return preferInformativeFallback(
      {
        running: false,
        pid: postmaster.pid,
        startedAt: postmaster.startedAt || null,
        dataDir: postmaster.dataDir || dataDir,
        port: postmaster.port || null,
        source: "postmaster",
        observedStartTime: null,
        probeFailures: postmasterProbeFailures(),
        stale: true,
        staleKind: clockAlone ? "indeterminate" : kind,
        indeterminate: clockAlone || kind === "indeterminate",
        reason:
          (clockAlone
            ? `postmaster.pid could not be resolved: ${reason}, but only the clock says so, and a clock adjusted since that record was written produces the same disagreement for a server that is still running`
            : `stale postmaster.pid: ${reason}`) +
          describeProbeFailures(postmasterProbeFailures()),
      },
      pidFile,
      dataDir,
      probes,
    );
  }

  return statusFromPidFile(pidFile, dataDir, probes);
}

async function statusFromPidFile(
  pidFile: string,
  dataDir: string,
  probes?: ProcessProbes,
): Promise<DevDBServerStatus> {
  const initialPidFilePresence = await getFilePresence(pidFile);

  if (initialPidFilePresence === "inaccessible") {
    return unreadablePidStatus("pid-file", pidFile, null, "Strataline");
  }

  const record = await readDevDBPidFile(pidFile);

  if (!record) {
    // Gone by the second look means it was removed while we read, not that it
    // was unreadable — see probeStatusFromFiles.
    const finalPidFilePresence = await getFilePresence(pidFile);

    if (finalPidFilePresence !== "absent") {
      return unreadablePidStatus("pid-file", pidFile, null, "Strataline");
    }

    return {
      running: false,
      pid: null,
      startedAt: null,
      dataDir: null,
      port: null,
      source: "none",
      observedStartTime: null,
      probeFailures: [],
      stale: false,
      staleKind: null,
      indeterminate: false,
      reason: "no PID file is present, so no server is running",
    };
  }

  if (record.dataDir && !sameDataDir(record.dataDir, dataDir)) {
    // Guarded and collected, as on the postmaster path. See there.
    const { value: currentBootTime, failures: bootProbeFailures } =
      collectProbeFailures(() =>
        guardProbes(probes ?? systemProbes).bootTime(),
      );

    // Behind the boot reading rather than beside it, so the extra probe is
    // spent only once the reading it has to corroborate actually says
    // something. It is a full verifyPid, which on macOS is six `ps` spawns,
    // and the ordinary different-cluster path must not pay for it. Named
    // rather than inlined into the condition only so the branch can carry out
    // what could not be probed alongside the verdict.
    const bootDisagrees =
      record.bootTime !== null &&
      currentBootTime !== null &&
      Math.abs(record.bootTime - currentBootTime) > 5000;

    const recycledCheck = bootDisagrees
      ? liveServerVerdict(record.pid, record.dataDir, probes, record.uid)
      : null;

    // Which cluster it named stops mattering once the record is known to
    // predate this boot: the process it describes cannot still be alive, so
    // there is no other server here to protect. Saying `different-cluster`
    // anyway would have the caller refuse — on every run, until somebody
    // deletes the file by hand — over whatever inherited the number.
    //
    // "Known to" is doing real work there, and the live process gets to
    // answer first, the same way it does in probeStatusFromFiles. Neither
    // boot reading is a boot id: both are wall-clock epochs, and every probe
    // derives one by subtracting uptime from the current time, so a clock
    // correction after the record was written moves the current reading
    // without a reboot. A step past the tolerance would otherwise call a
    // live server for the other directory `recycled` — and a stale record is
    // documented as safe to delete, so that server would be left running
    // with nothing recording it.
    //
    // Which is why it takes `ruled-out` rather than merely "not serving".
    // Positive disproof licenses destruction and nothing else does, so a live
    // PID this cannot identify holds the cautious answer: an unreadable
    // command line is an absent reading, and the record it would authorize
    // deleting may be the only thing recording a server that is running.
    if (
      // The record's own owner goes with it, as on the same-cluster path
      // below. A uid cannot change after exec, so a live process running as
      // another one is not the server this record describes, whichever
      // directory that server was for — and withholding that here refuses
      // forever over a number this could have proved was gone.
      recycledCheck?.verdict === "ruled-out"
    ) {
      return {
        running: false,
        pid: record.pid,
        startedAt: record.startedAt || null,
        dataDir: record.dataDir,
        port: record.port || null,
        source: "pid-file",
        observedStartTime: null,
        probeFailures: mergeProbeFailures(
          bootProbeFailures,
          recycledCheck.probeFailures,
        ),
        stale: true,
        staleKind: "recycled",
        indeterminate: false,
        reason:
          `the PID file names a different data directory (${record.dataDir}) and was written during a previous boot, so the server it described is gone and PID ${record.pid} now belongs to something else` +
          describeProbeFailures(
            mergeProbeFailures(bootProbeFailures, recycledCheck.probeFailures),
          ),
      };
    }

    return {
      running: false,
      pid: record.pid,
      startedAt: record.startedAt || null,
      dataDir: record.dataDir,
      port: record.port || null,
      source: "pid-file",
      observedStartTime: null,
      probeFailures: mergeProbeFailures(
        bootProbeFailures,
        recycledCheck?.probeFailures ?? [],
      ),
      stale: true,
      staleKind: "different-cluster",
      indeterminate: false,
      reason:
        `the PID file names a different data directory (${record.dataDir}), so it describes another cluster rather than this one` +
        describeProbeFailures(
          mergeProbeFailures(
            bootProbeFailures,
            recycledCheck?.probeFailures ?? [],
          ),
        ),
    };
  }

  const { verifiedBy, kind, reason, startTime, probeFailures } = verifyPid(
    record.pid,
    {
      startedAt: record.startedAt || null,
      bootTime: record.bootTime,
      // Only strataline's own record carries one. postmaster.pid does not, so
      // that path leaves the check switched off rather than guessing an owner.
      uid: record.uid,
      dataDir,
      probes,
    },
  );

  // Two of the ways to reach `recycled` here read a clock: the record's boot
  // time against a current one, and its start time against the live process's.
  // Both readings are anchored to the wall clock — a boot epoch is the current
  // time minus uptime on every platform that has a probe — so an adjustment
  // between writing this record and reading it now shifts the current side of
  // each comparison and leaves the recorded side, and a server that is still
  // running disagrees with its own record by exactly the step. Which is why
  // the start time cannot tell them apart the way it can on the postmaster
  // path: the boot mismatch reports no start time either.
  //
  // So ask again with both withheld. What is left — the PID being gone, a
  // command line naming another cluster or another program, an owner that
  // cannot have changed — is disproof no adjustment can manufacture, and a
  // live PID that none of it settles keeps the cautious answer instead of
  // being declared safe to delete.
  //
  // Behind `kind === "recycled"`, so the ordinary paths spend no probe on it.
  // Named on the way past, so its failures reach the status. It is the check
  // that decides whether a clock reading may license destruction, which is
  // exactly where "`ps` could not run" is worth saying out loud.
  let clockAloneCheck: { probeFailures: string[] } | null = null;

  const clockAlone =
    kind === "recycled" &&
    (clockAloneCheck = liveServerVerdict(
      record.pid,
      dataDir,
      probes,
      record.uid,
    )).verdict !== "ruled-out";

  /**
   * Everything this path could not probe. See postmasterProbeFailures.
   *
   * No boot reading here: the one above belongs to the different-cluster
   * branch, which returns before this, and the same-cluster path hands the
   * record's own boot time to verifyPid rather than reading a second one.
   */
  const pidFileProbeFailures = (): string[] =>
    mergeProbeFailures(probeFailures, clockAloneCheck?.probeFailures ?? []);

  return {
    running: verifiedBy !== null,
    pid: record.pid,
    startedAt: record.startedAt || null,
    dataDir: record.dataDir || null,
    port: record.port || null,
    source: "pid-file",
    // Only meaningful for a verified PID. Carrying it on a stale or
    // undecidable result would hand a caller a fingerprint for a process this
    // never claimed to have identified.
    observedStartTime: verifiedBy === null ? null : startTime,
    probeFailures: pidFileProbeFailures(),
    stale: verifiedBy === null,
    staleKind: clockAlone ? "indeterminate" : kind,
    indeterminate: clockAlone || kind === "indeterminate",
    reason:
      (verifiedBy !== null
        ? `the PID file describes a live server (PID ${record.pid})`
        : clockAlone
          ? `the PID file could not be resolved: ${reason}, but only the clock says so, and a clock adjusted since that record was written produces the same disagreement for a server that is still running`
          : `stale ${
              record.format === "legacy" ? "old-format PID file" : "PID file"
            }: ${reason}`) + describeProbeFailures(pidFileProbeFailures()),
  };
}

function unreadablePidStatus(
  source: "postmaster" | "pid-file",
  path: string,
  dataDir: string | null,
  owner: "PostgreSQL" | "Strataline",
): DevDBServerStatus {
  return {
    running: false,
    pid: null,
    startedAt: null,
    dataDir,
    port: null,
    source,
    observedStartTime: null,
    probeFailures: [],
    stale: true,
    staleKind: "indeterminate",
    indeterminate: true,
    reason:
      path +
      " exists or is inaccessible and could not be read as a valid " +
      owner +
      " PID record",
  };
}

/** Serializes a record; `format` is derived from the on-disk shape. */
export function serializeDevDBPidRecord(record: DevDBPidRecord): string {
  return JSON.stringify({
    pid: record.pid,
    startedAt: record.startedAt,
    dataDir: record.dataDir,
    port: record.port,
    bootTime: record.bootTime,
    uid: record.uid,
  });
}

/**
 * Builds the record strataline writes to its PID file.
 */
export function buildDevDBPidRecord(
  pid: number,
  dataDir: string,
  port: number,
): DevDBPidRecord {
  return {
    pid,
    startedAt: Date.now(),
    dataDir: resolve(dataDir),
    port,
    bootTime: getSystemBootTime(),
    // The EFFECTIVE uid, because that is what both platform probes report: a
    // writer whose euid and ruid differ would otherwise record one and be
    // checked against the other, and the mismatch would read as a recycled
    // number for a live server of this very cluster. The child inherits it,
    // since the server is spawned without a uid option. Undefined on Windows,
    // where the check does not apply.
    uid: process.geteuid?.() ?? null,
    format: "structured",
  };
}
