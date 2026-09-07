/**
 * Which lifecycle a database surface is in, as that surface's own object sees
 * it.
 *
 * About the instance, not about the machine: a server left behind by a
 * previous run reads as `stopped` here, because this object has never held it.
 * What is running on the host is a different question, answered from the PID
 * records by `getLocalDevDBServerStatus` in ./pid-file.
 *
 * A snapshot, and it does not survive an await. The answer can be stale by the
 * time it is read, so it belongs in a log line or a branch that tolerates
 * being wrong, not in a check that a subsequent call is relied on to pass.
 *
 * - `stopped` — nothing held. `start()` starts, `stop()` resolves with nothing
 *   to do.
 * - `starting` — `start()` and `stop()` both throw. Await the start.
 * - `running` — `stop()` stops it, `start()` logs and resolves.
 * - `stopping` — `start()` throws, `stop()` joins the teardown in flight.
 * - `unstoppable` — a stop gave up on a PostgreSQL it could not confirm gone,
 *   and the instance is still holding it. `start()` throws, `stop()` tries
 *   again. It is a state an instance LEAVES rather than rests in: once that
 *   server really is gone and its cleanup has run, the next reading is
 *   `stopped`.
 *
 * `stopping` is the one asymmetric row, and both surfaces say why: a stop that
 * refused would leave a server running, so it waits instead.
 *
 * Read from each surface's own fields and nothing else. That is what makes one
 * type answerable by both, including the one that mostly wraps somebody else's
 * library: what is being reported is which lifecycle call this object is in
 * the middle of, which it knows because it is the thing doing them. Whether a
 * postmaster that was up a moment ago is still alive is a different question,
 * and `TestDatabaseInstance` genuinely cannot answer that one without reaching
 * into embedded-postgres's private child handle.
 *
 * Its own module rather than either surface's, because both answer this and
 * neither should have to import the other to name the answer.
 * `LocalDevDBServer` is a whole process lifecycle manager and
 * `TestDatabaseInstance` has no use for one, which is the same reason
 * ./postgres-output and ./file-presence were split out. A type is erased at
 * build time, so this costs nothing at runtime either way, but the import
 * graph is what a reader follows to work out what depends on what.
 */
export type LifecycleState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "unstoppable";
