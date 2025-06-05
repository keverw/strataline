import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TestDatabaseInstance } from "./test-db-instance";
import { Migration } from "strataline";

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
      let result = await pool.query(`SELECT * FROM additional_test_table`);
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
