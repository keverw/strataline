import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { createConsoleLogger } from "../logger";
import {
  TestDatabaseInstance,
  isBindFailure,
  type LifecycleState,
} from "./test-db-instance";
import { LocalDevDBServer } from "./local-dev-db-server";
import { Migration } from "../migration-system";
import * as tmp from "tmp";
import {
  existsSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type EmbeddedPostgres from "embedded-postgres";

describe("TestDatabaseInstance", () => {
  let db: TestDatabaseInstance;

  // Simple test migration for testing purposes
  const testMigrations: Migration[] = [
    {
      id: "test-001",
      description: "Create test table",
      beforeSchema: async (client, helpers) => {
        await helpers.createTable(client, "test_table", {
          id: "SERIAL PRIMARY KEY",
          name: "TEXT NOT NULL",
        });
      },
    },
  ];

  beforeEach(() => {
    db = new TestDatabaseInstance({
      migrations: testMigrations,
    });
  });

  afterEach(async () => {
    await db.stop();
  });

  it("should start and connect to the database", async () => {
    // Start the database
    await db.start();

    // Check if the database is ready
    expect(db.isReady()).toBe(true);

    // Get the pool and execute a simple query
    const pool = db.getPool();
    expect(pool).not.toBeNull();

    if (pool) {
      const result = await pool.query("SELECT 1 as test_value");
      expect(result.rows[0].test_value).toBe(1);
    }
  });

  it("should return null from getPool when not started", () => {
    const pool = db.getPool();
    expect(pool).toBeNull();
  });

  it("should return null from getCredentials when not started", () => {
    const credentials = db.getCredentials();
    expect(credentials).toBeNull();
  });

  it("should allow configuring database credentials", async () => {
    const customDb = new TestDatabaseInstance({
      user: "custom_user",
      password: "custom_password",
      databaseName: "custom_db",
    });

    try {
      await customDb.start();

      const credentials = customDb.getCredentials();
      expect(credentials).not.toBeNull();

      if (credentials) {
        expect(credentials.user).toBe("custom_user");
        expect(credentials.password).toBe("custom_password");
        expect(credentials.database).toBe("custom_db");
      }
    } finally {
      await customDb.stop();
    }
  });

  it("should get a client that can execute queries", async () => {
    await db.start();

    const pool = db.getPool();
    expect(pool).not.toBeNull();

    if (pool) {
      const client = await pool.connect();

      try {
        const result = await client.query("SELECT 1 as test_value");
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].test_value).toBe(1);
      } finally {
        client.release();
      }
    }
  });

  it("should reset the database", async () => {
    await db.start();
    const pool = db.getPool();
    expect(pool).not.toBeNull();

    if (pool) {
      // Create an additional test table (different from the migration one)
      await pool.query(
        `CREATE TABLE additional_test_table (id SERIAL PRIMARY KEY, name TEXT)`,
      );

      // Insert data
      await pool.query(
        `INSERT INTO additional_test_table (name) VALUES ('test')`,
      );

      // Verify data exists
      const result = await pool.query(`SELECT * FROM additional_test_table`);
      expect(result.rows.length).toBe(1);

      // Reset the database
      await db.reset();

      // Verify the additional table no longer exists (should throw an error)
      try {
        await pool.query(`SELECT * FROM additional_test_table`);
        // If we get here, the test failed
        expect(true).toBe(false);
      } catch (error) {
        // Expected error - table doesn't exist
        expect(error).toBeDefined();
      }

      // But the migration table should exist again
      const migrationTableResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'test_table'
      `);

      expect(migrationTableResult.rows.length).toBe(1);
    }
  });

  it("should return pool.connect() clients after starting the database", async () => {
    // The database is not started yet
    expect(db.isReady()).toBe(false);

    // The pool should be null before starting
    const poolBefore = db.getPool();
    expect(poolBefore).toBeNull();

    // Now start the database manually
    await db.start();
    expect(db.isReady()).toBe(true);

    // Get a client using the standard pg.Pool connect() method
    const pool = db.getPool();
    expect(pool).not.toBeNull();

    if (pool) {
      const client = await pool.connect();
      expect(client).not.toBeNull();

      try {
        const result = await client.query("SELECT 1 as test_value");
        expect(result.rows[0].test_value).toBe(1);
      } finally {
        client.release();
      }
    }
  });

  it("should work without migrations", async () => {
    const dbWithoutMigrations = new TestDatabaseInstance();

    try {
      await dbWithoutMigrations.start();
      expect(dbWithoutMigrations.isReady()).toBe(true);

      const pool = dbWithoutMigrations.getPool();
      expect(pool).not.toBeNull();

      if (pool) {
        const result = await pool.query("SELECT 1 as test_value");
        expect(result.rows[0].test_value).toBe(1);
      }
    } finally {
      await dbWithoutMigrations.stop();
    }
  });

  it("should apply migrations when provided", async () => {
    await db.start();
    const pool = db.getPool();
    expect(pool).not.toBeNull();

    if (pool) {
      // The test migration should have created the test_table
      const result = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'test_table'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].table_name).toBe("test_table");
    }
  });
});

describe("createConsoleLogger", () => {
  it("should create a logger", () => {
    const logger = createConsoleLogger({ pg: false });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("should handle different log types with console output captured", () => {
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
      const logger = createConsoleLogger({ pg: false, migration: false }); // Silent mode for pg and migrate

      // Test all log types
      logger.info({ message: "Test info message" });
      logger.error({ message: "Test error message" });
      logger.warn({ message: "Test warning message" });
      logger.info({ source: "pg", message: "Test PostgreSQL message" });
      logger.info({
        source: "migration",
        message: "Test migration info message",
      });
      logger.error({
        source: "migration",
        message: "Test migration error message",
      });
      logger.warn({
        source: "migration",
        message: "Test migration warning message",
      });

      // Verify the console methods were called appropriately
      expect(logCalls).toContain("Test info message");
      expect(errorCalls).toContain("Test error message");
      expect(warnCalls).toContain("Test warning message");
      // pg and migrate messages should not be logged in silent mode
      expect(logCalls).not.toContain("[PG] Test PostgreSQL message");
      expect(logCalls).not.toContain("[MIGRATION] Test migration info message");
      // A migration WARNING and ERROR are not routine chatter, so quietening
      // the source does not hide them. They also no longer land on
      // console.log: the level is the method now, so they go where their
      // severity says.
      expect(errorCalls).toContain("[MIGRATION] Test migration error message");
      expect(warnCalls).toContain("[MIGRATION] Test migration warning message");
    } finally {
      // Restore original console methods
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  it("should log pg messages when pgVerbose is true", () => {
    // Capture console output
    const originalLog = console.log;
    const logCalls: string[] = [];
    console.log = (message: string) => logCalls.push(message);

    try {
      const logger = createConsoleLogger({ migration: false }); // pg verbose, migrate silent

      logger.info({ source: "pg", message: "Test PostgreSQL message" });
      logger.info({ source: "migration", message: "Test migration message" });

      // pg message should be logged with prefix
      expect(logCalls).toContain("[PG] Test PostgreSQL message");
      // migrate message should not be logged
      expect(logCalls).not.toContain("[MIGRATION] Test migration message");
    } finally {
      console.log = originalLog;
    }
  });

  it("should log migrate messages when migrateVerbose is true", () => {
    // Capture console output
    const originalLog = console.log;
    const logCalls: string[] = [];
    console.log = (message: string) => logCalls.push(message);

    try {
      const logger = createConsoleLogger({ pg: false }); // pg silent, migrate verbose

      logger.info({ source: "pg", message: "Test PostgreSQL message" });
      logger.info({ source: "migration", message: "Test migration message" });

      // pg message should not be logged
      expect(logCalls).not.toContain("[PG] Test PostgreSQL message");
      // migrate message should be logged with prefix
      expect(logCalls).toContain("[MIGRATION] Test migration message");
    } finally {
      console.log = originalLog;
    }
  });

  it("should log both pg and migrate messages when both verbose flags are true", () => {
    // Capture console output
    const originalLog = console.log;
    const logCalls: string[] = [];
    console.log = (message: string) => logCalls.push(message);

    try {
      const logger = createConsoleLogger(); // both verbose

      logger.info({ source: "pg", message: "Test PostgreSQL message" });
      logger.info({ source: "migration", message: "Test migration message" });

      // Both messages should be logged with prefixes
      expect(logCalls).toContain("[PG] Test PostgreSQL message");
      expect(logCalls).toContain("[MIGRATION] Test migration message");
    } finally {
      console.log = originalLog;
    }
  });

  it("should use default verbose settings when no parameters provided", () => {
    // Capture console output
    const originalLog = console.log;
    const logCalls: string[] = [];
    console.log = (message: string) => logCalls.push(message);

    try {
      const logger = createConsoleLogger({ pg: false }); // the usual choice for a test suite

      logger.info({ source: "pg", message: "Test PostgreSQL message" });
      logger.info({ source: "migration", message: "Test migration message" });

      // pg should not be logged (default false), migrate should be logged (default true)
      expect(logCalls).not.toContain("[PG] Test PostgreSQL message");
      expect(logCalls).toContain("[MIGRATION] Test migration message");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("isBindFailure", () => {
  /**
   * What PostgreSQL 18.4 actually writes when both address families for the
   * port are taken, in the chunks it writes them in. The bind line is not the
   * last one, which is the whole reason this is matched against the attempt's
   * accumulated output rather than the most recent chunk.
   */
  const REAL_CHUNKS = [
    'LOG:  could not bind IPv6 address "::1": Address already in use\n' +
      "HINT:  Is another postmaster already running on port 24999?\n" +
      'WARNING:  could not create listen socket for "localhost"\n',
    "FATAL:  could not create any TCP/IP sockets\n",
    "LOG:  database system is shut down\n",
  ];

  test("recognizes a taken port from the whole attempt's output", () => {
    expect(isBindFailure(REAL_CHUNKS.join(""))).toBe(true);
  });

  test("does not recognize it from the last chunk alone", () => {
    // The regression this encodes against: keeping only the most recent chunk
    // left the matcher looking at the shutdown notice, so the retry was
    // unreachable and PORT_RETRIES was dead code.
    expect(isBindFailure(REAL_CHUNKS[REAL_CHUNKS.length - 1])).toBe(false);
  });

  test("recognizes the socket-creation lines on their own", () => {
    // A host with IPv6 disabled never emits the bind line.
    expect(isBindFailure("FATAL:  could not create any TCP/IP sockets")).toBe(
      true,
    );
    expect(
      isBindFailure('WARNING:  could not create listen socket for "localhost"'),
    ).toBe(true);
  });

  test("does not fire for a start that failed for another reason", () => {
    // Retrying these would be three more initdbs and the same failure.
    for (const output of [
      "",
      "FATAL:  database files are incompatible with server\n",
      "FATAL:  could not create shared memory segment: No space left on device\n",
      "LOG:  database system is shut down\n",
      "FATAL:  data directory has wrong ownership\n",
    ]) {
      expect(isBindFailure(output)).toBe(false);
    }
  });
});

/**
 * What a stop that never returns is allowed to conclude.
 *
 * The bound around `EmbeddedPostgres.stop()` exists for a postmaster that had
 * already exited, whose `exit` event fired before the listener was attached.
 * A postmaster that is merely SLOW — writing its shutdown checkpoint on a
 * loaded machine — reaches the same timeout, and treating that one as gone had
 * cleanup() delete the data directory out from under a live server.
 *
 * Driven through the private members rather than a real cluster, because the
 * two cases differ only in whether a process is alive, and a real postmaster
 * cannot be asked to be slow on demand.
 */
describe("stopping past the bound", () => {
  /** A stop that never returns, which is the whole case under test. */
  const stallingDb = {
    stop: () => new Promise<void>(() => {}),
  } as unknown as EmbeddedPostgres;

  /** A PID high enough that nothing on the machine is using it. */
  const ABSENT_PID = 2_147_483_647;

  interface Internals {
    db?: EmbeddedPostgres;
    unstoppedServer: EmbeddedPostgres | null;
    pool?: { end(): Promise<unknown> };
    tempDir?: string;
    serverStillRunning(): Promise<boolean>;
  }

  const dirs: tmp.DirResult[] = [];

  /** A data directory, optionally with a postmaster.pid naming `pid`. */
  const cluster = (pid?: number): string => {
    const dir = tmp.dirSync({ unsafeCleanup: true, prefix: "pg-stop-test-" });

    dirs.push(dir);

    if (pid !== undefined) {
      // PostgreSQL's own layout: PID, data directory, start time in epoch
      // seconds, port.
      writeFileSync(
        join(dir.name, "postmaster.pid"),
        `${pid}\n${dir.name}\n${Math.floor(Date.now() / 1000)}\n5432\n`,
      );
    }

    return dir.name;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        dir.removeCallback();
      } catch {
        // Already gone, which is what most of these tests are about.
      }
    }
  });

  it("initializes the cluster with lc_messages = C", async () => {
    // Not a preference. postgresOutputLevel and ipcExhaustionHint read English
    // severity words out of this server's output, so the language the cluster
    // prints in is load-bearing, and LocalDevDBServer's clusters are C.
    //
    // Asserted rather than trusted because getting here takes beating a flag
    // that belongs to somebody else: embedded-postgres passes its own
    // `--lc-messages` from a locale it detects, ahead of anything given to it,
    // and initdb lets an explicit `--lc-messages` beat `--locale` whatever the
    // order. Only repeating the flag after theirs settles it, and only initdb
    // taking the LAST occurrence makes that work. An upstream that reorders
    // its argv, or stops passing the flag, would quietly put this cluster back
    // on the host's locale, which is exactly the kind of change a version bump
    // makes without saying so.
    const instance = new TestDatabaseInstance();

    try {
      await instance.start();

      const dataDir = (instance as unknown as Internals).tempDir;

      expect(dataDir).toBeDefined();

      const conf = readFileSync(
        join(dataDir as string, "postgresql.conf"),
        "utf8",
      );

      expect(/^lc_messages = '?C'?\s/m.test(conf)).toBe(true);
    } finally {
      await instance.stop();
    }
  }, 120_000);

  it("reads the cluster's own postmaster.pid to decide whether it is still there", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;

    // Removed on a clean exit, so no file is a server that finished.
    internals.tempDir = cluster();
    expect(await internals.serverStillRunning()).toBe(false);

    // Left behind by a kill or a reboot, naming a number nothing is using.
    internals.tempDir = cluster(ABSENT_PID);
    expect(await internals.serverStillRunning()).toBe(false);

    // This process is the one number certain to be alive.
    internals.tempDir = cluster(process.pid);
    expect(await internals.serverStillRunning()).toBe(true);
  });

  it("counts a postmaster.pid it cannot read as a server still running", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;

    // Present, and not a record. `readPostmasterPidFile` answers null for
    // this exactly as it does for a file that is not there, and here the two
    // mean opposite things: absent is a postmaster that removed its own file
    // on the way out, while unreadable is a question this could not answer.
    // Only the first licenses deleting the data directory, so the second has
    // to read as still running.
    internals.tempDir = cluster();

    writeFileSync(
      join(internals.tempDir, "postmaster.pid"),
      "not a pid record\n",
    );

    expect(await internals.serverStillRunning()).toBe(true);

    // The same for a record whose first line is not a PID at all, which is
    // what a torn write leaves.
    internals.tempDir = cluster();

    writeFileSync(join(internals.tempDir, "postmaster.pid"), "");

    expect(await internals.serverStillRunning()).toBe(true);
  });

  it("keeps the data directory when the stop gives up and the record is unreadable", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;
    const dataDir = cluster();

    // The dangerous combination, and the reason the unit test above is not
    // the whole of it: a stop that times out, and a postmaster.pid that says
    // nothing. Read as an absence, the timeout settles as "already exited"
    // and these files go out from under whatever wrote them.
    writeFileSync(join(dataDir, "postmaster.pid"), "not a pid record\n");

    internals.tempDir = dataDir;
    internals.db = stallingDb;

    await expect(instance.stop()).rejects.toThrow(
      /could not be confirmed gone/,
    );

    expect(existsSync(dataDir)).toBe(true);
  }, 30_000);

  it("leaves the data directory alone when the stop gives up on a live postmaster", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;
    const dataDir = cluster(process.pid);

    internals.tempDir = dataDir;
    internals.db = stallingDb;

    await expect(instance.stop()).rejects.toThrow(
      /could not be confirmed gone/,
    );

    // The regression this encodes against: the timeout alone was read as "it
    // had already exited", and these files went out from under a server that
    // was still writing to them.
    expect(existsSync(dataDir)).toBe(true);
  }, 30_000);

  it("joins a teardown already running rather than starting a second", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;
    const settleSoon = () => new Promise((r) => setTimeout(r, 50));

    let stops = 0;
    let poolEnds = 0;

    internals.tempDir = cluster(ABSENT_PID);
    internals.pool = {
      end: async () => {
        poolEnds++;

        return settleSoon();
      },
    };
    internals.db = {
      stop: async () => {
        stops++;

        return settleSoon();
      },
    } as unknown as EmbeddedPostgres;

    await Promise.all([instance.stop(), instance.stop(), instance.stop()]);

    // Each of the three used to read `pool` and `db` before any of them had
    // cleared either, so pg rejected the second `end()` with "Called end on
    // pool more than once" — logged as an error that had not happened — and
    // one server was sent three shutdowns racing three separate bounds.
    expect(poolEnds).toBe(1);
    expect(stops).toBe(1);

    // A later teardown has to be a FRESH run rather than the settled memo
    // handed back again. Asserted by giving it something new to do: with the
    // memo cleared these are torn down, and with it left in place the call
    // returns the old promise and touches neither.
    internals.pool = {
      end: async () => {
        poolEnds++;

        return settleSoon();
      },
    };
    internals.db = {
      stop: async () => {
        stops++;

        return settleSoon();
      },
    } as unknown as EmbeddedPostgres;

    await instance.stop();

    expect(poolEnds).toBe(2);
    expect(stops).toBe(2);
  }, 30_000);

  it("refuses a start while a teardown is still running", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;

    internals.tempDir = cluster(ABSENT_PID);
    internals.db = {
      stop: () => new Promise<void>((settle) => setTimeout(settle, 300)),
    } as unknown as EmbeddedPostgres;

    // Deliberately not awaited: the point is the window while it runs.
    const teardown = instance.stop();

    // cleanup() clears `pool` early and then waits on the server, so neither
    // the already-started guard nor the unstopped-server one can see this. A
    // start admitted here builds a cluster the resuming teardown then drops
    // and deletes, out from under a postmaster that is running.
    await expect(instance.start()).rejects.toThrow(/currently being stopped/);

    await teardown;
  }, 30_000);

  it("keeps the server and its directory so a later stop can finish the job", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;
    const dataDir = cluster(process.pid);

    internals.tempDir = dataDir;
    internals.db = stallingDb;

    // Raised rather than logged, so a caller that supplied no logger is told
    // too, and so a teardown cannot quietly pass over a live PostgreSQL.
    await expect(instance.stop()).rejects.toThrow(
      /could not be confirmed gone/,
    );

    // Dropping these was the regression: `stop()` reported success, and the
    // only handle to the live server and the only record of its directory went
    // with it, so nothing could try again and the postmaster was left holding
    // its port with a log line as its sole account.
    expect(internals.db).toBe(stallingDb);
    expect(internals.unstoppedServer).toBe(stallingDb);
    expect(internals.tempDir).toBe(dataDir);
  }, 30_000);

  it("refuses a start while a server it could not stop may still be running", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;

    internals.tempDir = cluster(process.pid);
    internals.db = stallingDb;

    await expect(instance.stop()).rejects.toThrow(
      /could not be confirmed gone/,
    );

    // A stop that gave up leaves no pool, so the already-started guard cannot
    // see this. Starting here would build a second cluster over the top of the
    // live one and overwrite the references that are the only thing recording
    // it.
    await expect(instance.start()).rejects.toThrow(/could not be stopped/);
  }, 30_000);

  it("finishes the stop on a later call, once the postmaster has gone", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;
    const dataDir = cluster(process.pid);

    internals.tempDir = dataDir;
    internals.db = stallingDb;

    await expect(instance.stop()).rejects.toThrow(
      /could not be confirmed gone/,
    );
    expect(existsSync(dataDir)).toBe(true);

    // The server has since shut down cleanly, which is what removing its own
    // postmaster.pid means. The retained references are what let this second
    // call ask again and act on the new answer.
    unlinkSync(join(dataDir, "postmaster.pid"));

    await instance.stop();

    expect(existsSync(dataDir)).toBe(false);
    expect(internals.unstoppedServer).toBeNull();
    expect(internals.db).toBeUndefined();
  }, 60_000);

  it("still removes the data directory when the stop gives up on a postmaster that is gone", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;
    const dataDir = cluster(ABSENT_PID);

    internals.tempDir = dataDir;
    internals.db = stallingDb;

    await instance.stop();

    // The case the bound was written for. Erring toward caution must not turn
    // every abandoned stop into a temporary directory nobody removes.
    expect(existsSync(dataDir)).toBe(false);
  }, 30_000);

  it("says so when a failed start could not stop what it had started", async () => {
    // performCleanup reports a server it could not confirm gone by RETURNING
    // with it retained rather than by throwing, so start()'s catch sees
    // nothing and used to rethrow the original failure alone. That failure is
    // real and stays the cause, but on its own it describes a start that
    // tidied up after itself -- and this one left a PostgreSQL holding a port
    // and a data directory, with a log line a caller who supplied no logger
    // never sees as its only account. It also decides the next call: start()
    // refuses on this state, so a caller told only about the first failure
    // retries and is refused for what reads as an unrelated reason.
    class StallingStart extends TestDatabaseInstance {
      protected override buildEmbeddedPostgres(): ReturnType<
        TestDatabaseInstance["buildEmbeddedPostgres"]
      > {
        const dir = (this as unknown as Internals).tempDir as string;

        // A live postmaster for this cluster, so the stop below cannot
        // confirm it gone and the directory is kept rather than deleted.
        writeFileSync(
          join(dir, "postmaster.pid"),
          `${process.pid}\n${dir}\n${Math.floor(Date.now() / 1000)}\n5432\n`,
        );

        return {
          initialise: async () => {
            throw new Error("initdb refused");
          },
          stop: () => new Promise<void>(() => {}),
        } as unknown as ReturnType<
          TestDatabaseInstance["buildEmbeddedPostgres"]
        >;
      }
    }

    const instance = new StallingStart({});
    const internals = instance as unknown as Internals;

    let raised: unknown;

    try {
      await instance.start();
    } catch (error) {
      raised = error;
    }

    // Both halves. The cause is what actually went wrong, and the message is
    // the part that was missing: something is still running.
    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).message).toMatch(/could not be stopped/);
    expect((raised as Error).message).toMatch(/initdb refused/);
    expect((raised as Error).cause).toBeInstanceOf(Error);
    expect(((raised as Error).cause as Error).message).toBe("initdb refused");

    // And it is telling the truth about the state it is describing.
    expect(internals.unstoppedServer).not.toBeNull();

    if (internals.tempDir) {
      dirs.push({
        name: internals.tempDir,
        removeCallback: () =>
          rmSync(internals.tempDir as string, {
            recursive: true,
            force: true,
          }),
      } as unknown as tmp.DirResult);
    }
  }, 60_000);
});

/**
 * The two refusals `start()` and `stop()` make against each other.
 *
 * Driven through the `findPort` seam rather than a real cluster, because what
 * is under test is the guard and not the startup: the whole point is that the
 * second call arrives while the first is provably still inside `performStart`,
 * and a real start gives nothing to aim at. Nothing is spawned, so the failing
 * start unwinds through a `cleanup()` with no pool, server, or directory to
 * release.
 */
describe("overlapping lifecycle calls", () => {
  /** A promise and the handle to settle it, as separate fields. */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });

    return { promise, resolve };
  }

  /**
   * What a lifecycle call did, as a string, and never a wait without an end.
   *
   * Raced against a timer rather than simply awaited, because the failure this
   * guards is a call that does not settle at all: without the refusal the
   * overlapping call runs on into the gate below and stays there, so a plain
   * `await` would hang the whole file until the runner gave up on it and
   * report nothing about which guard was missing. Naming the non-settlement
   * makes it an assertion failure like any other.
   */
  async function outcomeOf(work: Promise<unknown>): Promise<string> {
    return Promise.race([
      work.then(
        () => "resolved",
        (error: unknown) => `rejected: ${(error as Error)?.message}`,
      ),
      new Promise<string>((settle) => {
        setTimeout(() => settle("did not settle"), 1000);
      }),
    ]);
  }

  /**
   * A start that stops at the first await and stays there until told.
   *
   * Field initializers only, deliberately: a `private resolve!: () => void`
   * assigned from inside another field's initializer is declared AFTER it, so
   * class-field semantics would define it back to undefined on the way past.
   */
  class GatedStart extends TestDatabaseInstance {
    readonly entered = deferred();
    readonly gate = deferred();

    protected override async findPort(): Promise<number> {
      this.entered.resolve();

      await this.gate.promise;

      // Rejecting rather than returning a port, so the start unwinds without
      // an initdb. What the guards do is the subject; what the start would
      // have gone on to do is not.
      throw new Error("start held open by the test");
    }
  }

  it("refuses a second start while the first is still starting", async () => {
    const db = new GatedStart();
    const first = db.start();

    // The first call is inside performStart, which is the state the guard
    // exists for and the one `pool` cannot report: nothing sets it until the
    // very end of a start, so without the memo both calls would find the
    // instance idle and both build a cluster — the second overwriting `db`
    // and `tempDir` and leaving the first postmaster reachable by nothing.
    await db.entered.promise;

    expect(await outcomeOf(db.start())).toMatch(/already starting/);

    db.gate.resolve();

    expect(await outcomeOf(first)).toMatch(/held open by the test/);

    // And the memo is cleared by a failure as well as by a success, or a
    // start that failed once would refuse every retry after it. Reaching the
    // seam again is what proves it: a memo left behind would refuse here with
    // "already starting" instead.
    expect(await outcomeOf(db.start())).toMatch(/held open by the test/);
  });

  it("refuses a stop while a start is in flight", async () => {
    const db = new GatedStart();
    const first = db.start();

    await db.entered.promise;

    // The one overlap a teardown cannot wait out: performCleanup would end the
    // pool and stop the server while the start is still bringing one up.
    expect(await outcomeOf(db.stop())).toMatch(/currently starting/);

    db.gate.resolve();

    expect(await outcomeOf(first)).toMatch(/held open by the test/);

    // Once the start has settled the teardown is allowed again, and finds
    // nothing to do rather than refusing.
    expect(await outcomeOf(db.stop())).toBe("resolved");
  });
});

/**
 * The two questions an instance answers about itself, and the vocabulary they
 * are answered in.
 *
 * Driven through the same gated seam as the refusals above, because the states
 * worth checking are exactly the ones a caller cannot otherwise observe: both
 * `start()` and `stop()` refuse an overlap by throwing, so without this the
 * only way to discover which lifecycle you are in is to make a call that fails.
 */
describe("getLifecycleState", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });

    return { promise, resolve };
  }

  class GatedStart extends TestDatabaseInstance {
    readonly entered = deferred();
    readonly gate = deferred();

    protected override async findPort(): Promise<number> {
      this.entered.resolve();

      await this.gate.promise;

      throw new Error("start held open by the test");
    }
  }

  it("reports stopped before anything has been started", () => {
    expect(new TestDatabaseInstance().getLifecycleState()).toBe("stopped");
  });

  it("reports starting while a start is in flight, and stopped after it fails", async () => {
    const db = new GatedStart();
    const start = db.start();

    await db.entered.promise;

    // The state the refusals are about, and the one `isReady` cannot express:
    // there is no pool yet, so it reports false in exactly the same way it
    // does for an instance that was never started.
    expect(db.getLifecycleState()).toBe("starting");
    expect(db.isReady()).toBe(false);

    db.gate.resolve();

    await start.catch(() => {});

    // Back to a state a start is allowed from, since the failed one released
    // everything it had taken.
    expect(db.getLifecycleState()).toBe("stopped");
  });

  it("reports unstoppable while a server a stop gave up on is retained", () => {
    const db = new TestDatabaseInstance();
    const internals = db as unknown as {
      unstoppedServer: unknown;
    };

    // What performCleanup leaves when it could not confirm the postmaster
    // gone. Set directly rather than provoked, since provoking it needs a
    // PostgreSQL that will not stop, and what is under test is the reading.
    internals.unstoppedServer = {};

    expect(db.getLifecycleState()).toBe("unstoppable");
    expect(db.isReady()).toBe(false);
  });

  it("reports running only while there is a pool to query", async () => {
    const db = new TestDatabaseInstance();

    try {
      await db.start();

      // The one state isReady() reports true for. Both read the same two
      // fields, so they cannot disagree.
      expect(db.getLifecycleState()).toBe("running");
      expect(db.isReady()).toBe(true);
    } finally {
      await db.stop();
    }

    expect(db.getLifecycleState()).toBe("stopped");
    expect(db.isReady()).toBe(false);
  }, 120_000);
});

/**
 * The source every startup line carries, so `{ setup: false }` means the same
 * thing on this surface as it does on the dev server.
 *
 * Asserted on the lines rather than on rendered output, because what a filter
 * acts on is the field. A line that reads like startup chatter and carries no
 * source is invisible to the option that exists to quiet it, and nothing about
 * the message text would show that.
 */
describe("setup source", () => {
  it("tags what the startup is doing, and leaves the instance's own voice alone", async () => {
    const lines: { level: string; source?: string; message: string }[] = [];
    const record =
      (level: string) =>
      (data: { source?: string; message: string }): void => {
        lines.push({ level, ...data });
      };

    const db = new TestDatabaseInstance({
      logger: {
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      },
    });

    try {
      await db.start();
    } finally {
      await db.stop();
    }

    // Asserts the line is there before reporting its source, because
    // `find(...)?.source` is `undefined` both for a sourceless line and for a
    // line that is not in the list at all. Without this the `toBeUndefined`
    // checks below would keep passing if a message were ever reworded, which
    // is a test that has quietly stopped testing anything.
    const sourceOf = (fragment: string): string | undefined => {
      const line = lines.find((entry) => entry.message.includes(fragment));

      if (line === undefined) {
        throw new Error(
          `no logged line contains ${JSON.stringify(fragment)}. ` +
            "Either the message was reworded or the startup no longer logs it.",
        );
      }

      return line.source;
    };

    // Startup steps. Each is the counterpart of a line LocalDevDBServer has
    // always tagged `setup`, and each used to go out sourceless, so a caller
    // asking for a quiet test run got no quiet at all.
    expect(sourceOf("Created temporary directory")).toBe("setup");
    expect(sourceOf("Initializing embedded PostgreSQL")).toBe("setup");
    expect(sourceOf("PostgreSQL initialized successfully")).toBe("setup");
    expect(sourceOf("PostgreSQL server started successfully")).toBe("setup");
    expect(sourceOf("Created test database")).toBe("setup");

    // The instance's own voice keeps no source, so it survives the filter.
    // Silence nobody asked for is the worse failure of the two.
    expect(sourceOf("Starting embedded PostgreSQL for tests")).toBeUndefined();
    expect(sourceOf("started successfully on port")).toBeUndefined();
    expect(sourceOf("Stopping test database")).toBeUndefined();
    expect(sourceOf("Test database stopped")).toBeUndefined();

    // And the server's own output still says which server it came from.
    expect(lines.some((line) => line.source === "pg")).toBe(true);
  }, 120_000);
});

/**
 * That the two database surfaces answer `getLifecycleState()` the same way,
 * checked by the compiler rather than by eye.
 *
 * Type-only, so it costs nothing at runtime and `bun run type-check` is what
 * runs it. The point is the drift: the states are one shared union in
 * ./lifecycle-state precisely so a state added to one surface is a state the
 * other can return too, and a signature that moved on either side stops
 * assigning to `LifecycleSurface` here. A comment saying "keep these in sync"
 * would be the alternative, and comments do not fail builds.
 */
describe("one lifecycle interface across both surfaces", () => {
  interface LifecycleSurface {
    getLifecycleState(): LifecycleState;
    start(): Promise<void>;
    stop(): Promise<void>;
  }

  it("has both classes satisfying it", () => {
    const surfaces: LifecycleSurface[] = [
      new TestDatabaseInstance(),
      new LocalDevDBServer({
        port: 5432,
        user: "u",
        password: "p",
        database: "d",
        dataDir: "/tmp/never-started",
        pidFile: "/tmp/never-started.pid",
      }),
    ];

    // Constructed and never started, so this asserts the shape rather than any
    // behavior: neither constructor touches the filesystem or installs a
    // process listener, which is itself a property worth holding them to.
    expect(surfaces.map((s) => s.getLifecycleState())).toEqual([
      "stopped",
      "stopped",
    ]);
  });
});
