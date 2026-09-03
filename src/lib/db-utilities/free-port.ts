import { readFileSync } from "fs";
import getPort from "get-port";

/**
 * Picking a port that will still be free when a postmaster binds it.
 *
 * `getPort()` on its own asks the operating system for a free port, which it
 * takes from the ephemeral range, and then closes the socket it probed with
 * and hands back the number. Until something binds it, that number is only a
 * suggestion. The ephemeral range is also where the kernel draws the local
 * port for every OUTGOING connection, and a PostgreSQL that is being started
 * makes plenty of those on its own account: readiness polls, setup queries,
 * status probes. One of them taking the number in the gap leaves the
 * postmaster to fail with "could not bind IPv4 address 127.0.0.1: Address
 * already in use", which reads as a database that would not start rather than
 * as a port that was taken.
 *
 * The gap is as wide as whatever runs between the two. For a caller that
 * initdbs a fresh cluster first, that is seconds.
 *
 * So the range here sits outside the ephemeral one, which narrows the window
 * to programs that bind a port deliberately rather than to every outgoing
 * connection the machine makes. Narrows rather than closes: a deliberate
 * binder can still take the number, and getPort probes each candidate before
 * offering it but cannot hold it.
 */

/** Where the search starts when the ephemeral range is out of the way. */
const PREFERRED_FIRST = 20_000;
const PREFERRED_LAST = 30_000;

/** Lowest port a process can bind without privileges, and the highest at all. */
const FIRST_UNPRIVILEGED_PORT = 1024;
const LAST_PORT = 65_535;

/**
 * How many candidates a window has to offer before it is worth moving to.
 *
 * A window is only useful if getPort can walk past the ports that are already
 * taken, and a handful of numbers would run out and fall through to the
 * operating system's own suggestion, which is the ephemeral pick this exists
 * to avoid.
 */
const MIN_WINDOW_PORTS = 1000;

/**
 * The ephemeral range a host actually has, where it can be read.
 *
 * @internal Exported because it names the argument of the exported helpers
 * below, not because a consumer has any use for it.
 */
export interface EphemeralRange {
  low: number;
  high: number;
}

/**
 * Reads a `net.ipv4.ip_local_port_range` value, or null when it says nothing.
 *
 * @internal Exported only so the parse can be checked from any platform. The
 * file it reads exists on Linux alone, but this is where a misread would move
 * the search window on the strength of a bad value.
 */
export function parseEphemeralRange(raw: string | null): EphemeralRange | null {
  const match = (raw ?? "").match(/^\s*(\d+)\s+(\d+)\s*$/);

  if (!match) {
    return null;
  }

  const low = Number(match[1]);
  const high = Number(match[2]);

  // A pair that does not describe real ports says nothing, and treating it as
  // though it did would move the window on the strength of a bad read.
  if (
    !Number.isSafeInteger(low) ||
    !Number.isSafeInteger(high) ||
    low < 1 ||
    high > LAST_PORT ||
    low > high
  ) {
    return null;
  }

  return { low, high };
}

/**
 * The host's configured ephemeral range, or null where it cannot be read.
 *
 * Linux only, and read rather than assumed. `net.ipv4.ip_local_port_range` is
 * a sysctl, so the 32768 the kernel ships is a default and not a guarantee:
 * hosts tuned for large numbers of outbound connections routinely widen it to
 * `10000 65535` or `1024 65535`, and either of those swallows the preferred
 * window whole. A window chosen against the default would then sit inside the
 * ephemeral range on exactly the busy machines where the race matters most.
 *
 * A plain read of a few bytes from /proc, deliberately not a spawn. The
 * synchronous probes in ./pid-file are bounded because a hung spawn blocks the
 * event loop with nothing able to rescue it, and a sysctl file has no such
 * failure mode. macOS and Windows expose the same setting
 * (`net.inet.ip.portrange.first`, `netsh int ipv4 set dynamicport`) but only
 * through a subprocess, so they are left on their defaults of 49152, which is
 * well clear of the preferred window, and both are far less often retuned than
 * a Linux container host.
 *
 * Not cached. It is one small read per database started, which is nothing
 * beside an initdb, and caching would hold a value a host can change under us.
 */
function readEphemeralRange(): EphemeralRange | null {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    return parseEphemeralRange(
      readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8"),
    );
  } catch {
    // No /proc, or no permission to read it. Unknown rather than absent, and
    // the preferred window is the same best-effort answer it always was.
    return null;
  }
}

/**
 * The window to search, given what the host says about its ephemeral range.
 *
 * Above the ephemeral range first, because the ports below it are where a
 * developer machine actually runs things: 3000, 5432, 8080 and their
 * neighbors are far more likely to be bound, or about to be, than anything up
 * near 60000. Below it only when there is no room above.
 *
 * Where the ephemeral range covers everything a process may bind, which
 * `1024 65535` does, there is no window outside it to move to. That falls
 * back to the preferred one and accepts the race, which is what asking the
 * operating system for a port did in the first place, so such a host is no
 * worse off than before rather than newly broken.
 *
 * @internal Exported so the choice can be tested against ranges this machine
 * does not have.
 */
export function chooseSearchWindow(ephemeral: EphemeralRange | null): {
  first: number;
  last: number;
} {
  const preferred = { first: PREFERRED_FIRST, last: PREFERRED_LAST };

  if (ephemeral === null) {
    return preferred;
  }

  // Disjoint, so the preferred window is already outside it.
  if (ephemeral.low > PREFERRED_LAST || ephemeral.high < PREFERRED_FIRST) {
    return preferred;
  }

  const span = PREFERRED_LAST - PREFERRED_FIRST;

  if (ephemeral.high < LAST_PORT) {
    const first = ephemeral.high + 1;
    const last = Math.min(LAST_PORT, first + span);

    if (last - first + 1 >= MIN_WINDOW_PORTS) {
      return { first, last };
    }
  }

  if (ephemeral.low > FIRST_UNPRIVILEGED_PORT) {
    const last = ephemeral.low - 1;
    const first = Math.max(FIRST_UNPRIVILEGED_PORT, last - span);

    if (last - first + 1 >= MIN_WINDOW_PORTS) {
      return { first, last };
    }
  }

  return preferred;
}

/**
 * The window, opened at a random point and wrapped, rather than in order.
 *
 * get-port walks whatever it is given from the front, and remembers what it
 * has handed out only within the process that asked. Two processes are two
 * sets of that bookkeeping, so an ascending range has both of them open at the
 * first port and race for it. Test runners are exactly where this is used and
 * exactly where several processes start at once, which is the case a fixed
 * starting point gets wrong. Starting somewhere random spreads them across the
 * range instead, and wrapping keeps every port reachable rather than shrinking
 * the pool for whoever starts high.
 */
function* candidatePorts(first: number, last: number): Generator<number> {
  const span = last - first + 1;
  const opening = Math.floor(Math.random() * span);

  for (let offset = 0; offset < span; offset++) {
    yield first + ((opening + offset) % span);
  }
}

/**
 * A free port, chosen so it is still free when the caller gets round to
 * binding it.
 *
 * Should every port in the window be taken, get-port falls back to asking the
 * operating system, which is the behavior this replaced. That is a worse
 * answer than a port from the window and a better one than refusing to start.
 *
 * @internal Not part of the published API. Exported so the dev server's tests
 * and {@link TestDatabaseInstance} pick ports the same way, since they hit the
 * same race for the same reason.
 */
export async function findFreePort(): Promise<number> {
  const { first, last } = chooseSearchWindow(readEphemeralRange());

  return getPort({ port: candidatePorts(first, last) });
}
