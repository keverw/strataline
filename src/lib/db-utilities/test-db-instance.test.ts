import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import {
  TestDatabaseInstance,
  createTestDBConsoleLogger,
  isBindFailure,
} from "./test-db-instance";
import { Migration } from "../migration-system";
import * as tmp from "tmp";
import { existsSync, writeFileSync } from "fs";
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

describe("createTestDBConsoleLogger", () => {
  it("should create a logger", () => {
    const logger = createTestDBConsoleLogger();
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
      const logger = createTestDBConsoleLogger(false, false); // Silent mode for pg and migrate

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
      const logger = createTestDBConsoleLogger(true, false); // pg verbose, migrate silent

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
      const logger = createTestDBConsoleLogger(false, true); // pg silent, migrate verbose

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
      const logger = createTestDBConsoleLogger(true, true); // both verbose

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
      const logger = createTestDBConsoleLogger(); // defaults: pgVerbose=false, migrateVerbose=true

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

  it("leaves the data directory alone when the stop gives up on a live postmaster", async () => {
    const instance = new TestDatabaseInstance();
    const internals = instance as unknown as Internals;
    const dataDir = cluster(process.pid);

    internals.tempDir = dataDir;
    internals.db = stallingDb;

    await instance.stop();

    // The regression this encodes against: the timeout alone was read as "it
    // had already exited", and these files went out from under a server that
    // was still writing to them.
    expect(existsSync(dataDir)).toBe(true);
  }, 30_000);

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
});
