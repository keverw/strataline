import { describe, expect, it } from "bun:test";
import { readOsUsername } from "../src/lib/os-user";
import {
  cleanSemaphores,
  cleanSharedMemory,
  type SemaphoreProbes,
  type SharedMemoryProbes,
} from "./clean-ipc";

/**
 * The semaphore pass, tested for the ORDER it takes its two readings in.
 *
 * That order is the whole safety argument and nothing about a real `ipcs` can
 * demonstrate it: the window is a few milliseconds wide, so a test against the
 * live system passes either way and says nothing. Injected probes make the
 * order observable, which is the only thing that distinguishes the two.
 */

/** One `ipcs -sa` row. macOS columns: T ID KEY MODE OWNER GROUP CREATOR CGROUP NSEMS OTIME CTIME */
function semaphoreRow(id: string, owner: string, nsems: number): string {
  return `s ${id} 0x0b1193e2 --ra-ra-ra- ${owner} staff ${owner} staff ${nsems} 15:38:16 15:01:45`;
}

// The real one: the pass only ever touches sets this user owns, so a made-up
// name would be filtered out and every assertion below would pass vacuously.
//
// Null where the operating system has no passwd entry for this uid, which a
// container run as an unmapped uid produces routinely. Read through the same
// guard the script uses rather than a bare `userInfo()`, which THROWS in that
// case and would take this whole file down before a single test ran.
const OS_USER = readOsUsername();

// Never reached: the pass declines to act at all when the user is unknown, so
// there is no behavior left for these to exercise and the block below is
// skipped. The placeholder exists only so the rows are typed as strings.
const OWNER = OS_USER ?? "no-such-user";
const LEAKED = "111111";
const LIVE_SERVERS = "222222";

function table(ids: string[]): string {
  return [
    "IPC status from <running system> as of Wed Sep  2 00:21:44 MDT 2026",
    "T     ID     KEY        MODE       OWNER    GROUP  CREATOR   CGROUP NSEMS   OTIME    CTIME",
    "Semaphores:",
    ...ids.map((id) => semaphoreRow(id, OWNER, 17)),
    "",
  ].join("\n");
}

/**
 * A machine where a postmaster comes up between the first probe and the
 * second, whichever probe each of those turns out to be.
 *
 * State is read before the counter moves, so the first probe to run sees the
 * machine as it was and every later one sees the server. That is what makes
 * the fake sensitive to the order rather than to the names of the calls.
 */
function machineWherePostgresStartsMidRun(removed: string[]): {
  probes: SemaphoreProbes;
  calls: string[];
} {
  const calls: string[] = [];
  let probesRun = 0;

  /** Up from the second probe onward. */
  const serverIsUpNow = (): boolean => probesRun >= 1;

  return {
    calls,
    probes: {
      listSemaphores(): string {
        const up = serverIsUpNow();

        probesRun++;
        calls.push("list");

        // A running postmaster's sets are in the table; before it started they
        // were not there to list.
        return up ? table([LEAKED, LIVE_SERVERS]) : table([LEAKED]);
      },
      countLivePostgres(): number {
        const up = serverIsUpNow();

        probesRun++;
        calls.push("count");

        return up ? 1 : 0;
      },
      removeSet(id: string): void {
        removed.push(id);
      },
    },
  };
}

// A machine that cannot name its own user cannot arrange the premise these
// need: every row is matched on the owner column, and the pass stops before
// reading any of them. Skipped rather than failed, the same as any other test
// whose fixture the host will not build.
describe.skipIf(OS_USER === null)("cleanSemaphores", () => {
  it("lists the sets before asking whether PostgreSQL is running", () => {
    // The ordering itself, asserted directly. Everything below follows from
    // it, and a reordering is the one way to reintroduce the race.
    const removed: string[] = [];
    const { probes, calls } = machineWherePostgresStartsMidRun(removed);

    cleanSemaphores(probes);

    expect(calls).toEqual(["list", "count"]);
  });

  it("removes nothing when PostgreSQL starts between the two readings", () => {
    // Asked first and listed second, the new server is not counted and its
    // brand new sets are in the snapshot by the time it is read, so the guard
    // that exists to protect a running server removes that server's
    // semaphores. PostgreSQL does not survive losing them.
    const removed: string[] = [];
    const { probes } = machineWherePostgresStartsMidRun(removed);

    cleanSemaphores(probes);

    expect(removed).not.toContain(LIVE_SERVERS);
    // Nothing at all: a live postmaster stops the pass outright, because a
    // semaphore set carries no creator PID to tell its sets from the leak.
    expect(removed).toEqual([]);
  });

  it("removes leaked sets when no PostgreSQL is running", () => {
    // The other half, so the caution above is not just a pass that never does
    // anything. Same table, no server anywhere.
    const removed: string[] = [];

    cleanSemaphores({
      listSemaphores: () => table([LEAKED, LIVE_SERVERS]),
      countLivePostgres: () => 0,
      removeSet: (id) => {
        removed.push(id);
      },
    });

    expect(removed).toEqual([LEAKED, LIVE_SERVERS]);
  });

  it("leaves sets that are not PostgreSQL-shaped", () => {
    // A set of some other size belongs to something else on this machine, and
    // nothing here knows what.
    const removed: string[] = [];

    cleanSemaphores({
      listSemaphores: () =>
        [
          "Semaphores:",
          semaphoreRow(LEAKED, OWNER, 17),
          semaphoreRow("333333", OWNER, 2),
          "",
        ].join("\n"),
      countLivePostgres: () => 0,
      removeSet: (id) => {
        removed.push(id);
      },
    });

    expect(removed).toEqual([LEAKED]);
  });
});

/**
 * The shared memory pass, tested for its PARSE rather than for an order.
 *
 * It has no ordering to protect, but it does decide what to `ipcrm` from
 * `parts[4]` and `parts[6]` of an `ipcs -mp` row. A column layout that shifted
 * would not fail loudly, it would delete segments belonging to somebody else,
 * so the fixture below is the real header and row shape this machine prints.
 */

/** One `ipcs -mp` row. macOS columns: T ID KEY MODE OWNER GROUP CPID LPID */
function segmentRow(id: string, owner: string, cpid: string): string {
  return `m ${id} 0x00000000 --rw------- ${owner} staff ${cpid} 4242`;
}

function segmentTable(rows: string[]): string {
  return [
    "IPC status from <running system> as of Thu Sep  3 17:52:15 MDT 2026",
    "T     ID     KEY        MODE       OWNER    GROUP  CPID  LPID",
    "Shared Memory:",
    ...rows,
    "",
  ].join("\n");
}

const DEAD_CREATOR = 999001;
const LIVE_CREATOR = 999002;

function sharedMemoryProbes(
  table: string,
  removed: string[],
  onRemove?: (id: string) => void,
): SharedMemoryProbes {
  return {
    listSegments: () => table,
    // Keyed on the PID the parse pulled out, so a row read from the wrong
    // column reaches this with the wrong number and the assertions diverge.
    creatorIsAlive: (pid) => pid === LIVE_CREATOR,
    removeSegment: (id) => {
      onRemove?.(id);
      removed.push(id);
    },
  };
}

describe.skipIf(OS_USER === null)("cleanSharedMemory", () => {
  it("removes a segment whose creator has exited", () => {
    const removed: string[] = [];

    cleanSharedMemory(
      sharedMemoryProbes(
        segmentTable([segmentRow("65536", OWNER, String(DEAD_CREATOR))]),
        removed,
      ),
    );

    expect(removed).toEqual(["65536"]);
  });

  it("keeps a segment whose creator is still running", () => {
    const removed: string[] = [];

    cleanSharedMemory(
      sharedMemoryProbes(
        segmentTable([segmentRow("65537", OWNER, String(LIVE_CREATOR))]),
        removed,
      ),
    );

    expect(removed).toEqual([]);
  });

  it("leaves another user's segments alone even when their creator is gone", () => {
    const removed: string[] = [];

    // The owner column is the only thing standing between this and somebody
    // else's memory, so a shifted parse shows up here first.
    cleanSharedMemory(
      sharedMemoryProbes(
        segmentTable([
          segmentRow("65538", "someone-else", String(DEAD_CREATOR)),
          segmentRow("65539", OWNER, String(DEAD_CREATOR)),
        ]),
        removed,
      ),
    );

    expect(removed).toEqual(["65539"]);
  });

  it("ignores the header lines and anything that is not a segment row", () => {
    const removed: string[] = [];

    // The table carries three lines of preamble and the semaphore section can
    // follow in the same output. Only rows whose first column is `m` are ours.
    cleanSharedMemory(
      sharedMemoryProbes(
        segmentTable([
          `s 111111 0x0b1193e2 --ra-ra-ra- ${OWNER} staff ${OWNER} staff 17 15:38:16 15:01:45`,
        ]),
        removed,
      ),
    );

    expect(removed).toEqual([]);
  });

  it("skips a row whose creator PID is not a number", () => {
    const removed: string[] = [];

    // A truncated or reformatted row must not be read as PID zero and have its
    // liveness guessed at.
    cleanSharedMemory(
      sharedMemoryProbes(
        segmentTable([segmentRow("65540", OWNER, "-")]),
        removed,
      ),
    );

    expect(removed).toEqual([]);
  });

  it("carries on when one removal fails", () => {
    const removed: string[] = [];

    cleanSharedMemory(
      sharedMemoryProbes(
        segmentTable([
          segmentRow("65541", OWNER, String(DEAD_CREATOR)),
          segmentRow("65542", OWNER, String(DEAD_CREATOR)),
        ]),
        removed,
        (id) => {
          if (id === "65541") {
            throw new Error("ipcrm: permission denied");
          }
        },
      ),
    );

    // The first throws and is counted as failed rather than ending the pass,
    // so a segment this user cannot remove does not strand the ones it can.
    expect(removed).toEqual(["65542"]);
  });

  it("reports a listing it could not read rather than removing nothing quietly", () => {
    const removed: string[] = [];
    // Restored, because leaving it set would fail the whole run.
    const previousExitCode = process.exitCode;

    try {
      cleanSharedMemory({
        listSegments: () => {
          throw new Error("ipcs: command not found");
        },
        creatorIsAlive: () => false,
        removeSegment: (id) => removed.push(id),
      });

      expect(removed).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
