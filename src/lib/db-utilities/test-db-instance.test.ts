import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  TestDatabaseInstance,
  createTestDBConsoleLogger,
} from "./test-db-instance";
import { Migration } from "../migration-system";

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
  it("should create a logger function", () => {
    const logger = createTestDBConsoleLogger();
    expect(typeof logger).toBe("function");
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
      logger("info", "Test info message");
      logger("error", "Test error message");
      logger("warn", "Test warning message");
      logger("pg", "Test PostgreSQL message");
      logger("migrate-info", "Test migration info message");
      logger("migrate-error", "Test migration error message");
      logger("migrate-warn", "Test migration warning message");

      // Verify the console methods were called appropriately
      expect(logCalls).toContain("Test info message");
      expect(errorCalls).toContain("Test error message");
      expect(warnCalls).toContain("Test warning message");
      // pg and migrate messages should not be logged in silent mode
      expect(logCalls).not.toContain("[PG] Test PostgreSQL message");
      expect(logCalls).not.toContain(
        "[MIGRATE-INFO] Test migration info message",
      );
      expect(logCalls).not.toContain(
        "[MIGRATE-ERROR] Test migration error message",
      );
      expect(logCalls).not.toContain(
        "[MIGRATE-WARN] Test migration warning message",
      );
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

      logger("pg", "Test PostgreSQL message");
      logger("migrate-info", "Test migration message");

      // pg message should be logged with prefix
      expect(logCalls).toContain("[PG] Test PostgreSQL message");
      // migrate message should not be logged
      expect(logCalls).not.toContain("[MIGRATE-INFO] Test migration message");
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

      logger("pg", "Test PostgreSQL message");
      logger("migrate-info", "Test migration message");

      // pg message should not be logged
      expect(logCalls).not.toContain("[PG] Test PostgreSQL message");
      // migrate message should be logged with prefix
      expect(logCalls).toContain("[MIGRATE-INFO] Test migration message");
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

      logger("pg", "Test PostgreSQL message");
      logger("migrate-info", "Test migration message");

      // Both messages should be logged with prefixes
      expect(logCalls).toContain("[PG] Test PostgreSQL message");
      expect(logCalls).toContain("[MIGRATE-INFO] Test migration message");
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

      logger("pg", "Test PostgreSQL message");
      logger("migrate-info", "Test migration message");

      // pg should not be logged (default false), migrate should be logged (default true)
      expect(logCalls).not.toContain("[PG] Test PostgreSQL message");
      expect(logCalls).toContain("[MIGRATE-INFO] Test migration message");
    } finally {
      console.log = originalLog;
    }
  });
});
