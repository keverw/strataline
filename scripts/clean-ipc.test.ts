import { describe, expect, it } from "bun:test";
import * as os from "os";
import { cleanSemaphores, type SemaphoreProbes } from "./clean-ipc";

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
const OWNER = os.userInfo().username;
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

describe("cleanSemaphores", () => {
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
