/**
 * Recovery script: remove leaked SysV IPC objects left behind by PostgreSQL
 * instances that were terminated without a clean shutdown (an interrupted
 * `bun test`, a crash, or a `kill -9`).
 *
 * PostgreSQL releases both kinds on a clean exit and neither on a hard kill,
 * so the two leak together and are cleaned together.
 *
 * **Shared memory.** macOS has a very low default SHMMNI (max number of
 * segments, ~32), so a handful of leaked segments is enough to break the
 * embedded test database with:
 *   FATAL: could not create shared memory segment: No space left on device
 *
 * **Semaphores.** The same story with a much larger budget and a much longer
 * fuse, which makes it the more confusing of the two. A dev-server test run
 * leaks on the order of 50 sets, every one of them 17 semaphores, against a
 * kern.sysv.semmns of 87381. So nothing goes wrong for dozens of runs and then
 * everything does at once:
 *   FATAL: could not create semaphores: No space left on device
 *   DETAIL: Failed system call was semget(...)
 *
 * That surfaces as initdb failing across unrelated tests, naming a full disk
 * in a message that has nothing to do with disks, so it is worth knowing that
 * this script is the answer.
 *
 * Safety differs between the two, because macOS reports different things about
 * them. A shared memory segment carries its creator's PID, so a leaked one can
 * be identified exactly: owned by this user, creator no longer running. A
 * semaphore set carries no PID at all — `ipcs -sa` reports owner, creator user,
 * and size, and nothing that ties it to a process. So semaphores are matched on
 * PostgreSQL's own signature, a set of exactly 17, and skipped entirely while
 * any postgres is running, since there would be no way to tell that server's
 * sets from an abandoned one.
 */

import { execFileSync, execSync } from "child_process";
import * as os from "os";

/** PostgreSQL allocates its semaphores in sets of exactly this size. */
const POSTGRES_SEMAPHORES_PER_SET = 17;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Live PostgreSQL postmasters, by executable name rather than command line.
 *
 * A command-line match would count this script, and anything else that merely
 * mentions postgres, as a running server and refuse to clean when it is safe.
 */
function livePostgresCount(): number {
  try {
    const out = execFileSync("ps", ["-Ao", "comm="], { encoding: "utf8" });

    return out
      .split("\n")
      .map((line) => line.trim().split("/").pop() ?? "")
      .filter((name) => name === "postgres" || name === "postmaster").length;
  } catch {
    // Cannot tell, so assume one is running and clean no semaphores. The
    // cautious direction: leaving a leak costs a later re-run, removing a live
    // server's semaphores costs that server.
    return 1;
  }
}

const user = os.userInfo().username;

function cleanSharedMemory(): void {
  let output: string;

  try {
    // macOS columns: T ID KEY MODE OWNER GROUP CPID LPID
    output = execSync("ipcs -mp", { encoding: "utf8" });
  } catch (err) {
    console.error("clean-ipc: failed to list shared memory segments:", err);
    process.exitCode = 1;

    return;
  }

  let removed = 0;
  let kept = 0;
  let failed = 0;

  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);

    if (parts[0] !== "m") {
      continue;
    }

    const id = parts[1];
    const owner = parts[4];
    const cpid = parseInt(parts[6], 10);

    if (owner !== user || Number.isNaN(cpid)) {
      continue;
    }

    if (isAlive(cpid)) {
      kept++; // creator still running — leave it alone
      continue;
    }

    try {
      execSync(`ipcrm -m ${id}`);
      removed++;
    } catch {
      failed++;
    }
  }

  console.log(
    `clean-ipc: removed ${removed} leaked shared memory segment(s), kept ${kept} (live creator)` +
      (failed > 0 ? `, ${failed} failed to remove` : "") +
      ".",
  );
}

/**
 * The two readings the semaphore pass rests on, and the removal itself.
 *
 * Injectable because the ORDER these are taken in is the whole safety
 * argument, and nothing about a real `ipcs` can demonstrate that an order is
 * wrong — the window is a few milliseconds wide and closing it is a matter of
 * which call comes first, not of what either one returns.
 *
 * The shared memory pass needs no equivalent. Each segment carries its
 * creator's PID, so that pass decides about every segment individually from
 * the same snapshot it read the PID out of, and no separate reading has to
 * line up with it.
 */
export interface SemaphoreProbes {
  /** Raw `ipcs -sa` output. */
  listSemaphores(): string;
  /** How many PostgreSQL postmasters and backends are alive right now. */
  countLivePostgres(): number;
  /** Removes one semaphore set by id. */
  removeSet(id: string): void;
}

const systemSemaphoreProbes: SemaphoreProbes = {
  // macOS columns: T ID KEY MODE OWNER GROUP CREATOR CGROUP NSEMS OTIME CTIME
  listSemaphores: () => execSync("ipcs -sa", { encoding: "utf8" }),
  countLivePostgres: livePostgresCount,
  removeSet: (id) => {
    execSync(`ipcrm -s ${id}`);
  },
};

/**
 * @internal Exported for the ordering test. The entry point at the bottom
 * calls this with the real probes.
 */
export function cleanSemaphores(
  probes: SemaphoreProbes = systemSemaphoreProbes,
): void {
  let output: string;

  // The snapshot FIRST and the liveness check second, which is the whole of
  // what makes this safe. Every set listed here existed at the moment of the
  // listing, so if no PostgreSQL is alive afterwards, any server that owned
  // one of them has since exited and its sets really are abandoned.
  //
  // Asking first and listing second admits exactly the case this guard is for.
  // A postmaster that starts in between is not counted, and by the time the
  // table is read its brand new sets are in it — so the check that exists to
  // protect a running server would have this remove that server's semaphores,
  // which is the one thing it must never do. The window is small and the
  // consequence is not: PostgreSQL does not survive losing them.
  try {
    output = probes.listSemaphores();
  } catch (err) {
    console.error("clean-ipc: failed to list semaphore sets:", err);
    process.exitCode = 1;

    return;
  }

  const live = probes.countLivePostgres();

  if (live > 0) {
    console.log(
      `clean-ipc: skipped semaphores, ${live} PostgreSQL process(es) are running. ` +
        "A semaphore set carries no creator PID on macOS, so a live server's sets cannot be told from an abandoned one. " +
        "Stop them and run this again.",
    );

    return;
  }

  let removed = 0;
  let skipped = 0;
  let failed = 0;

  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);

    if (parts[0] !== "s") {
      continue;
    }

    const id = parts[1];
    const owner = parts[4];
    const nsems = parseInt(parts[8], 10);

    if (owner !== user) {
      continue;
    }

    // Anything that is not PostgreSQL-shaped belongs to something else on this
    // machine, and nothing here knows what.
    if (nsems !== POSTGRES_SEMAPHORES_PER_SET) {
      skipped++;
      continue;
    }

    try {
      probes.removeSet(id);
      removed++;
    } catch {
      failed++;
    }
  }

  console.log(
    `clean-ipc: removed ${removed} leaked semaphore set(s), left ${skipped} that are not PostgreSQL-shaped` +
      (failed > 0 ? `, ${failed} failed to remove` : "") +
      ".",
  );
}

// Under the entry-point guard rather than at module scope, so importing this
// for a test neither exits the process on a non-macOS host nor reaches for a
// real `ipcs`.
if (import.meta.main) {
  // This is a macOS-only problem in practice: Linux defaults to a high SHMMNI
  // and SEMMNS, so neither exhausts, and the `ipcs` column layout differs.
  if (os.platform() !== "darwin") {
    console.log("clean-ipc: only needed on macOS; nothing to do.");
  } else {
    cleanSharedMemory();
    cleanSemaphores();
  }
}
