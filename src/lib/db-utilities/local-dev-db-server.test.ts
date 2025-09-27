import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  LocalDevDBServer,
  createDevDBConsoleLogger,
} from "./local-dev-db-server";
import { Pool } from "pg";
import * as tmp from "tmp";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import getPort from "get-port";

describe("LocalDevDBServer", () => {
  let server: LocalDevDBServer;
  let tempDir: tmp.DirResult;
  let pidFile: string;
  let serverPort: number;
  let exitCalled = false;
  let lastExitCode: number | undefined;

  beforeEach(async () => {
    // Reset exit tracking
    exitCalled = false;
    lastExitCode = undefined;

    // Create a temporary directory for each test
    tempDir = tmp.dirSync({
      unsafeCleanup: true,
      prefix: "local-dev-db-test-",
    });

    pidFile = join(tempDir.name, ".pg_pid");

    // Get an available port for this test
    serverPort = await getPort();

    // Create server instance with test configuration
    server = new LocalDevDBServer({
      port: serverPort,
      user: "test_dev_user",
      password: "test_dev_password",
      database: "test_dev_database",
      dataDir: join(tempDir.name, "pgdata"),
      pidFile: pidFile,
      // No logger for silent tests
      onExit: (exitCode) => {
        // In tests, track exit calls instead of actually exiting
        exitCalled = true;
        lastExitCode = exitCode;
      },
    });
  });

  afterEach(async () => {
    // Clean up the server
    if (server) {
      await server.stop();
    }

    // Clean up PID file if it exists
    if (existsSync(pidFile)) {
      try {
        unlinkSync(pidFile);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    // Clean up temporary directory
    try {
      tempDir.removeCallback();
    } catch (e) {
      // Ignore cleanup errors - the directory might have already been removed
      // by the PostgreSQL server process or other cleanup mechanisms
    }
  });

  it("should create a LocalDevDBServer instance", () => {
    expect(server).toBeDefined();
    expect(exitCalled).toBe(false);
    expect(lastExitCode).toBeUndefined();
  });

  it("should start and stop the server", async () => {
    // Start the server
    await server.start();

    // Verify PID file was created
    expect(existsSync(pidFile)).toBe(true);

    // Stop the server
    await server.stop();

    // Wait a brief moment for the exit handler to be called
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that the exit handler was called with code 0
    expect(exitCalled).toBe(true);
    expect(lastExitCode).toBe(0);

    // Note: PID file cleanup happens in the cleanup method which is called by stop()
    // The file might still exist briefly due to async cleanup
  }, 30000); // Timeout for server operations

  it("should create the specified user, password, and database", async () => {
    // Start the server
    await server.start();

    // Try to connect with the created credentials
    const pool = new Pool({
      host: "localhost",
      port: serverPort, // Use the dynamically assigned port
      user: "test_dev_user",
      password: "test_dev_password",
      database: "test_dev_database",
    });

    try {
      // Test the connection
      const client = await pool.connect();
      const result = await client.query("SELECT 1 as test_value");
      expect(result.rows[0].test_value).toBe(1);
      client.release();

      // Verify we're connected to the correct database
      const dbResult = await pool.query("SELECT current_database()");
      expect(dbResult.rows[0].current_database).toBe("test_dev_database");

      // Verify we're connected as the correct user
      const userResult = await pool.query("SELECT current_user");
      expect(userResult.rows[0].current_user).toBe("test_dev_user");
    } finally {
      await pool.end();
    }
  }, 30000);

  it("should handle custom port configuration", async () => {
    // Create a server with a dynamically assigned port
    const customPort = await getPort();
    let customExitCalled = false;
    let customExitCode: number | undefined;

    const customServer = new LocalDevDBServer({
      port: customPort,
      user: "custom_user",
      password: "custom_password",
      database: "custom_database",
      dataDir: join(tempDir.name, "custom_pgdata"),
      pidFile: join(tempDir.name, ".custom_pg_pid"),
      // No logger for silent tests
      onExit: (exitCode) => {
        customExitCalled = true;
        customExitCode = exitCode;
      },
    });

    try {
      await customServer.start();

      // Try to connect on the custom port
      const pool = new Pool({
        host: "localhost",
        port: customPort,
        user: "custom_user",
        password: "custom_password",
        database: "custom_database",
      });

      try {
        const client = await pool.connect();
        const result = await client.query("SELECT 1 as test_value");
        expect(result.rows[0].test_value).toBe(1);
        client.release();
      } finally {
        await pool.end();
      }
    } finally {
      await customServer.stop();
    }
  }, 30000);

  it("should work without a logger", async () => {
    // Create a server without a logger
    const silentPort = await getPort();
    let silentExitCalled = false;
    let silentExitCode: number | undefined;

    const silentServer = new LocalDevDBServer({
      port: silentPort,
      user: "silent_user",
      password: "silent_password",
      database: "silent_database",
      dataDir: join(tempDir.name, "silent_pgdata"),
      pidFile: join(tempDir.name, ".silent_pg_pid"),
      // No logger provided
      onExit: (exitCode) => {
        silentExitCalled = true;
        silentExitCode = exitCode;
      },
    });

    try {
      // Should start without errors even without a logger
      await silentServer.start();

      // Verify it works
      const pool = new Pool({
        host: "localhost",
        port: silentPort,
        user: "silent_user",
        password: "silent_password",
        database: "silent_database",
      });

      try {
        const client = await pool.connect();
        const result = await client.query("SELECT 1 as test_value");
        expect(result.rows[0].test_value).toBe(1);
        client.release();
      } finally {
        await pool.end();
      }
    } finally {
      await silentServer.stop();
    }
  }, 30000);

  it("should handle data directory persistence", async () => {
    const dataDir = join(tempDir.name, "persistent_pgdata");
    const persistPort1 = await getPort();
    const persistPort2 = await getPort();
    let persist1ExitCalled = false;
    let persist1ExitCode: number | undefined;
    let persist2ExitCalled = false;
    let persist2ExitCode: number | undefined;

    // Create first server instance
    const server1 = new LocalDevDBServer({
      port: persistPort1,
      user: "persist_user",
      password: "persist_password",
      database: "persist_database",
      dataDir: dataDir,
      pidFile: join(tempDir.name, ".persist_pg_pid_1"),
      // No logger for silent tests
      onExit: (exitCode) => {
        persist1ExitCalled = true;
        persist1ExitCode = exitCode;
      },
    });

    try {
      await server1.start();

      // Create a test table and insert data
      const pool1 = new Pool({
        host: "localhost",
        port: persistPort1,
        user: "persist_user",
        password: "persist_password",
        database: "persist_database",
      });

      try {
        await pool1.query(`
          CREATE TABLE test_persistence (
            id SERIAL PRIMARY KEY,
            message TEXT NOT NULL
          )
        `);
        await pool1.query(`
          INSERT INTO test_persistence (message) VALUES ('persistent data')
        `);
      } finally {
        await pool1.end();
      }

      await server1.stop();

      // Create second server instance using the same data directory
      const server2 = new LocalDevDBServer({
        port: persistPort2,
        user: "persist_user",
        password: "persist_password",
        database: "persist_database",
        dataDir: dataDir,
        pidFile: join(tempDir.name, ".persist_pg_pid_2"),
        // No logger for silent tests
        onExit: (exitCode) => {
          persist2ExitCalled = true;
          persist2ExitCode = exitCode;
        },
      });

      await server2.start();

      // Verify the data persisted
      const pool2 = new Pool({
        host: "localhost",
        port: persistPort2,
        user: "persist_user",
        password: "persist_password",
        database: "persist_database",
      });

      try {
        const result = await pool2.query(`
          SELECT message FROM test_persistence WHERE id = 1
        `);
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].message).toBe("persistent data");
      } finally {
        await pool2.end();
        await server2.stop();
      }
    } catch (error) {
      // Ensure cleanup even if test fails
      try {
        await server1.stop();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }, 45000);
});

describe("createDevDBConsoleLogger", () => {
  it("should create a logger function", () => {
    const logger = createDevDBConsoleLogger();
    expect(typeof logger).toBe("function");
  });

  it("should handle different log types", () => {
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
      const logger = createDevDBConsoleLogger(false, false); // Silent mode

      // These should not throw errors
      logger("info", "Test info message");
      logger("error", "Test error message");
      logger("warn", "Test warning message");
      logger("pg", "Test PostgreSQL message");
      logger("setup", "Test setup message");

      // Verify the console methods were called appropriately
      expect(logCalls).toContain("Test info message");
      expect(errorCalls).toContain("Test error message");
      expect(warnCalls).toContain("Test warning message");
      // pg and setup messages should not be logged in silent mode
      expect(logCalls).not.toContain("[PG] Test PostgreSQL message");
      expect(logCalls).not.toContain("[SETUP] Test setup message");
    } finally {
      // Restore original console methods
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
  });
});
