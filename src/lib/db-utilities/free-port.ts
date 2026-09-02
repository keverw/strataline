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
 * So the range here sits below the ephemeral one on every platform this runs
 * on: macOS and Windows start at 49152, Linux at 32768. Nothing draws an
 * outgoing port from 20000, so the only thing that can take one is a program
 * that binds it deliberately, and getPort probes each candidate before
 * offering it.
 */
const FIRST_PORT = 20_000;
const LAST_PORT = 30_000;

/**
 * The range, opened at a random point and wrapped, rather than in order.
 *
 * get-port walks whatever it is given from the front, and remembers what it
 * has handed out only within the process that asked. Two processes are two
 * sets of that bookkeeping, so an ascending range has both of them open at
 * FIRST_PORT and race for it. Test runners are exactly where this is used and
 * exactly where several processes start at once, which is the case a fixed
 * starting point gets wrong. Starting somewhere random spreads them across the
 * range instead, and wrapping keeps every port reachable rather than shrinking
 * the pool for whoever starts high.
 */
function* candidatePorts(): Generator<number> {
  const span = LAST_PORT - FIRST_PORT + 1;
  const opening = Math.floor(Math.random() * span);

  for (let offset = 0; offset < span; offset++) {
    yield FIRST_PORT + ((opening + offset) % span);
  }
}

/**
 * A free port, chosen so it is still free when the caller gets round to
 * binding it.
 *
 * Should every port in the range be taken, get-port falls back to asking the
 * operating system, which is the behavior this replaced. That is a worse
 * answer than a port from the range and a better one than refusing to start.
 *
 * @internal Not part of the published API. Exported so the dev server's tests
 * and {@link TestDatabaseInstance} pick ports the same way, since they hit the
 * same race for the same reason.
 */
export async function findFreePort(): Promise<number> {
  return getPort({ port: candidatePorts() });
}
