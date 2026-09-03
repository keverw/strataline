import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "net";
import { TestDatabaseInstance } from "./test-db-instance";
import { findFreePort } from "./free-port";

/**
 * Drives the bind race that {@link TestDatabaseInstance} retries.
 *
 * The race cannot be provoked on demand: it needs something to take the port
 * in the gap between the port being confirmed free and the postmaster binding
 * it, which is a window of milliseconds nothing else can aim at. So the port
 * is handed over already taken, through the one seam that exists for it.
 *
 * Without this the retry loop was never executed by any test at all, which is
 * how it shipped unable to fire: the check that decides whether to retry read
 * only the LAST chunk PostgreSQL wrote, and the bind message is never last.
 */
class CollidingDatabase extends TestDatabaseInstance {
  private handedOut = 0;
  private built = 0;

  constructor(private readonly takenPort: number) {
    super({});
  }

  /** The taken port first, then real ones. */
  protected override async findPort(): Promise<number> {
    this.handedOut++;

    return this.handedOut === 1 ? this.takenPort : findFreePort();
  }

  /** Counted, not changed. See {@link CollidingDatabase.serversBuilt}. */
  protected override buildEmbeddedPostgres(
    port: number,
  ): ReturnType<TestDatabaseInstance["buildEmbeddedPostgres"]> {
    this.built++;

    return super.buildEmbeddedPostgres(port);
  }

  get portsHandedOut(): number {
    return this.handedOut;
  }

  get serversBuilt(): number {
    return this.built;
  }
}

/**
 * Holds a port against PostgreSQL on both address families.
 *
 * Both matters. EmbeddedPostgres does not pin `listen_addresses`, so the
 * postmaster tries `localhost`, which resolves to both. Holding only one leaves
 * it able to start on the other with nothing worse than a warning, and the
 * failure this is about never happens.
 *
 * Returns null where IPv6 is unavailable, which some CI networks are.
 */
async function holdPort(
  port: number,
): Promise<{ close: () => Promise<void> } | null> {
  // Anything that connects is dropped at once. A net.Server accepts a
  // connection whether or not anything is listening for one, and close() then
  // waits for it, so a server that merely holds a port can still be a close
  // that never returns. Nothing is expected to connect here, since PostgreSQL
  // fails at bind rather than reaching the listener, but the trap is cheap to
  // stay out of.
  const listen = (host: string): Promise<Server | null> =>
    new Promise((resolve) => {
      const server = createServer((socket) => socket.destroy());

      server.once("error", () => resolve(null));
      server.listen(port, host, () => resolve(server));
    });

  const v4 = await listen("127.0.0.1");
  const v6 = await listen("::1");

  if (!v4 || !v6) {
    await Promise.all(
      [v4, v6].map(
        (s) =>
          new Promise<void>((done) => (s ? s.close(() => done()) : done())),
      ),
    );

    return null;
  }

  return {
    close: async () => {
      await Promise.all(
        [v4, v6].map((s) => new Promise<void>((done) => s.close(() => done()))),
      );
    },
  };
}

describe("port retry", () => {
  let db: CollidingDatabase | null = null;
  let held: { close: () => Promise<void> } | null = null;

  afterEach(async () => {
    await db?.stop().catch(() => {});
    db = null;
    await held?.close();
    held = null;
  });

  test("takes another port when the first was claimed before PostgreSQL bound it", async () => {
    const taken = await findFreePort();

    held = await holdPort(taken);

    if (!held) {
      // No IPv6 on this host, so the postmaster would start on the family that
      // is free and the race being tested cannot be staged.
      return;
    }

    db = new CollidingDatabase(taken);

    await db.start();

    // It started, on a port that is not the one it was first given, and it
    // asked for exactly one replacement rather than burning the whole budget.
    const credentials = db.getCredentials();
    const pool = db.getPool();
    const { rows } = await (pool as NonNullable<typeof pool>).query<{
      ok: number;
    }>("SELECT 1 AS ok");

    expect(rows[0].ok).toBe(1);
    expect(credentials?.port).not.toBe(taken);
    expect(db.portsHandedOut).toBe(2);

    // And it took the second port on the server it already had, rather than
    // building another. embedded-postgres registers every instance it
    // CONSTRUCTS in a module-level set it never prunes, and stops all of them
    // from its own exit hook — a stop that never returns for one whose
    // postmaster has already exited. So an abandoned attempt is not litter,
    // it is ten seconds added to the exit of every run that retried. The count
    // is asserted rather than the stall because the stall happens after the
    // test framework is done, in a hook this process does not own: reaching it
    // takes a subprocess and a wall-clock threshold, which is a great deal of
    // machinery and flakiness to re-derive a number this reads directly.
    expect(db.serversBuilt).toBe(1);
  }, 120_000);

  test("does not retry a port the caller supplied", async () => {
    // An explicit port is the caller naming a number for a reason. Starting
    // somewhere else would hand back a database at an address they are not
    // going to connect to, so this must fail rather than move.
    const taken = await findFreePort();

    held = await holdPort(taken);

    if (!held) {
      return;
    }

    const explicit = new TestDatabaseInstance({ port: taken });

    let started = true;

    await explicit.start().catch(() => {
      started = false;
    });

    expect(started).toBe(false);
    // Nothing usable came back, rather than a database somewhere else.
    expect(explicit.getCredentials()).toBeNull();

    await explicit.stop().catch(() => {});
  }, 120_000);
});
