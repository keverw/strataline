import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Pool } from "pg";
import {
  RunStratalineCLI,
  createCLIConsoleLogger,
  CLILoggerFunction,
} from "./built-in-cli";
import { TestDatabaseInstance } from "./db-utilities/test-db-instance";
import { Migration } from "./migration-system";

// Control whether to show logs during RunStratalineCLI tests
const CLI_TESTS_VERBOSE_LOGGING = false; // Set to true to see logs during test execution

describe("createCLIConsoleLogger", () => {
  it("should create a logger function", () => {
    const logger = createCLIConsoleLogger();
    expect(typeof logger).toBe("function");
  });

  it("should log different message types correctly", () => {
    // Mock console methods
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    const mockLog = mock(() => {});
    const mockError = mock(() => {});
    const mockWarn = mock(() => {});

    console.log = mockLog;
    console.error = mockError;
    console.warn = mockWarn;

    try {
      const logger = createCLIConsoleLogger(true);

      // Test regular log types
      logger("info", "Test info message");
      logger("error", "Test error message");
      logger("warn", "Test warning message");

      // Test migration log types
      logger("migrate-info", "Test migration info");
      logger("migrate-error", "Test migration error");
      logger("migrate-warn", "Test migration warning");

      // Verify console.log calls
      expect(mockLog).toHaveBeenCalledTimes(2);
      expect(mockLog).toHaveBeenCalledWith("Test info message");
      expect(mockLog).toHaveBeenCalledWith(
        "[MIGRATE-INFO] Test migration info",
      );

      // Verify console.error calls
      expect(mockError).toHaveBeenCalledTimes(2);
      expect(mockError).toHaveBeenCalledWith("Test error message");
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] Test migration error",
      );

      // Verify console.warn calls
      expect(mockWarn).toHaveBeenCalledTimes(2);
      expect(mockWarn).toHaveBeenCalledWith("Test warning message");
      expect(mockWarn).toHaveBeenCalledWith(
        "[MIGRATE-WARN] Test migration warning",
      );
    } finally {
      // Restore original console methods
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  it("should respect migrateVerbose flag", () => {
    // Mock console methods
    const originalLog = console.log;
    const mockLog = mock(() => {});
    console.log = mockLog;

    try {
      // Create logger with migrateVerbose=false
      const logger = createCLIConsoleLogger(false);

      // Regular info should still be logged
      logger("info", "Regular info");

      // Migration info should be suppressed
      logger("migrate-info", "Migration info");

      // Verify console.log was only called once for regular info
      expect(mockLog).toHaveBeenCalledTimes(1);
      expect(mockLog).toHaveBeenCalledWith("Regular info");
      expect(mockLog).not.toHaveBeenCalledWith("[MIGRATE-INFO] Migration info");
    } finally {
      // Restore original console.log
      console.log = originalLog;
    }
  });
});

describe("RunStratalineCLI", () => {
  // Mock migrations for testing
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

  // Mock logger to capture logs
  type LogType =
    | "info"
    | "error"
    | "warn"
    | "pg"
    | "migrate-info"
    | "migrate-error"
    | "migrate-warn";
  type LogEntry = { type: LogType; message: string; error?: any };
  let logEntries: LogEntry[];
  let mockLogger: (type: LogType, message: string, error?: any) => void;

  // Test database instance
  let testDb: TestDatabaseInstance;

  beforeEach(async () => {
    // Reset log entries
    logEntries = [];
    mockLogger = (type, message, error) => {
      logEntries.push({ type, message, error });

      if (CLI_TESTS_VERBOSE_LOGGING) {
        // Use the actual CLI logger to print to console, respecting its formatting.
        // Pass `true` for migrateVerbose to ensure all details are shown if verbose logging is on.
        const consoleCliLogger = createCLIConsoleLogger(true);

        if (type === "pg") {
          // Add "PG: " prefix to postgres logs
          consoleCliLogger("info", `PG: ${message}`);
        } else {
          consoleCliLogger(type, message);
        }
      }
    };

    // Create a test database instance
    testDb = new TestDatabaseInstance({
      migrations: [],
      user: "test_user",
      password: "test_password",
      databaseName: "test_db",
    });
    await testDb.start();
  });

  afterEach(async () => {
    // Clean up test database
    await testDb.stop();
  });

  describe("Pool-based mode", () => {
    it("should connect to the database using a provided pool", async () => {
      // Create a fresh pool for this test
      const credentials = testDb.getCredentials();
      if (!credentials) {
        throw new Error("Failed to get test database credentials");
      }

      const pool = new Pool({
        user: credentials.user,
        password: credentials.password,
        database: credentials.database,
        host: credentials.host,
        port: credentials.port,
      });

      // RunStratalineCLI will end the pool internally, so we don't need to end it here
      await RunStratalineCLI({
        migrations: testMigrations,
        loadFrom: "pool",
        pool,
        logger: mockLogger,
      });

      // Check logs for successful connection
      const connectionLogs = logEntries.filter(
        (entry) =>
          entry.type === "info" &&
          entry.message.includes("Successfully connected to database"),
      );
      expect(connectionLogs.length).toBeGreaterThan(0);
    });

    it("should run migrations in job mode", async () => {
      // Create a fresh pool for this test
      const credentials = testDb.getCredentials();
      if (!credentials) {
        throw new Error("Failed to get test database credentials");
      }

      const pool = new Pool({
        user: credentials.user,
        password: credentials.password,
        database: credentials.database,
        host: credentials.host,
        port: credentials.port,
      });

      // CLI arguments for "run" operation
      const argv = ["node", "script.js", "run"];

      // RunStratalineCLI will end the pool internally, so we don't need to end it here
      await RunStratalineCLI({
        migrations: testMigrations,
        loadFrom: "pool",
        pool,
        logger: mockLogger,
        argv,
      });

      // Check for migration-related logs
      const migrationLogs = logEntries.filter(
        (entry) =>
          entry.message.includes("test-001") ||
          entry.message.includes("Migration") ||
          entry.message.includes("migrations"),
      );
      expect(migrationLogs.length).toBeGreaterThan(0);

      // We can't query the pool after RunStratalineCLI because it ends the pool
      // We'll rely on the logs to verify the migration ran successfully
    });

    it("should show migration status", async () => {
      // This test will run migrations first, then check status
      // First, run migrations
      const credentials = testDb.getCredentials();
      if (!credentials) {
        throw new Error("Failed to get test database credentials");
      }

      // Create a pool for running migrations
      const runPool = new Pool({
        user: credentials.user,
        password: credentials.password,
        database: credentials.database,
        host: credentials.host,
        port: credentials.port,
      });

      // CLI arguments for run command
      const runArgv = ["node", "script.js", "run"];

      // Run migrations first
      await RunStratalineCLI({
        migrations: testMigrations,
        loadFrom: "pool",
        pool: runPool,
        logger: mockLogger,
        argv: runArgv,
      });

      // Clear logs before checking status
      logEntries = [];

      // Create a new pool for checking status
      const statusPool = new Pool({
        user: credentials.user,
        password: credentials.password,
        database: credentials.database,
        host: credentials.host,
        port: credentials.port,
      });

      // CLI arguments for status command
      const statusArgv = ["node", "script.js", "status"];

      // Check status
      await RunStratalineCLI({
        migrations: testMigrations,
        loadFrom: "pool",
        pool: statusPool,
        logger: mockLogger,
        argv: statusArgv,
      });

      // Check for status logs
      const statusLogs = logEntries.filter(
        (entry) =>
          entry.message.includes("Migration Status") ||
          entry.message.includes("migration"),
      );
      expect(statusLogs.length).toBeGreaterThan(0);

      // Should show our test migration
      const migrationIdLogs = logEntries.filter((entry) =>
        entry.message.includes("test-001"),
      );
      expect(migrationIdLogs.length).toBeGreaterThan(0);
    });

    it("should show help when no command is provided", async () => {
      // Create a fresh pool for this test
      const credentials = testDb.getCredentials();
      if (!credentials) {
        throw new Error("Failed to get test database credentials");
      }

      const helpPool = new Pool({
        user: credentials.user,
        password: credentials.password,
        database: credentials.database,
        host: credentials.host,
        port: credentials.port,
      });

      // CLI arguments for help command
      const helpArgv = ["node", "script.js"];

      // RunStratalineCLI will end the pool internally, so we don't need to end it here
      await RunStratalineCLI({
        migrations: testMigrations,
        loadFrom: "pool",
        pool: helpPool,
        logger: mockLogger,
        argv: helpArgv,
      });

      // Check for help logs
      const helpLogs = logEntries.filter(
        (entry) =>
          entry.message.includes("Usage") ||
          entry.message.includes("Strataline Database Migration CLI"),
      );
      expect(helpLogs.length).toBeGreaterThan(0);
    });

    it("should correctly log info, warn, and error messages from within a migration via ctx.logger", async () => {
      const migrationId = "test-log-types-migration";
      const logMessage = "Test log message from migration";
      const warnMessage = "Test warn message from migration";
      const errorMessage = "Test error message from migration";
      const errorObject = new Error("Detailed error object");

      const loggingMigration: Migration = {
        id: migrationId,
        description: "A migration that tests ctx.logger types",
        migration: async (_pool, ctx) => {
          ctx.logger.info({ message: logMessage });
          ctx.logger.warn({ message: warnMessage });
          ctx.logger.error({ message: errorMessage, error: errorObject });
          ctx.complete();
        },
      };

      const credentials = testDb.getCredentials();
      if (!credentials) {
        throw new Error("Failed to get test database credentials");
      }
      const pool = new Pool(credentials); // Use a fresh pool for this test

      try {
        await RunStratalineCLI({
          migrations: [loggingMigration],
          loadFrom: "pool",
          pool: pool,
          logger: mockLogger,
          argv: ["node", "script.js", "run"],
        });

        const expectedInfoMessage = `[${migrationId}] ${logMessage}`;
        const expectedWarnMessage = `[${migrationId}] ${warnMessage}`;
        const expectedErrorMessage = `[${migrationId}] ${errorMessage}: ${errorObject.message}`;

        const infoLog = logEntries.find(
          (entry) =>
            entry.type === "migrate-info" &&
            entry.message === expectedInfoMessage,
        );
        expect(infoLog).toBeDefined();
        expect(infoLog?.message).toBe(expectedInfoMessage);

        const warnLog = logEntries.find(
          (entry) =>
            entry.type === "migrate-warn" &&
            entry.message === expectedWarnMessage,
        );
        expect(warnLog).toBeDefined();
        expect(warnLog?.message).toBe(expectedWarnMessage);

        const errorLog = logEntries.find(
          (entry) =>
            entry.type === "migrate-error" &&
            entry.message === expectedErrorMessage,
        );
        expect(errorLog).toBeDefined();
        expect(errorLog?.message).toBe(expectedErrorMessage);
        expect(errorLog?.error).toBeUndefined(); // CLIStratalineLogger incorporates error.message into the string, but doesn't pass the object

        // Check for successful data migration phase log from MigrationManager
        const migrationManagerSuccessLog = logEntries.find(
          (entry) =>
            entry.type === "migrate-info" &&
            entry.message ===
              `[${migrationId}] [dataMigration] Data migration marked as complete via callback.`,
        );
        expect(migrationManagerSuccessLog).toBeDefined();
      } finally {
        // The pool is ended by RunStratalineCLI when provided via loadFrom: "pool"
      }
    });
  });

  describe("Environment variable mode", () => {
    it("should connect to the database using a custom env object", async () => {
      const credentials = testDb.getCredentials();

      if (!credentials) {
        throw new Error("Failed to get test database credentials");
      }

      const customEnv: Record<string, string | undefined> = {
        POSTGRES_USER: credentials.user,
        POSTGRES_PASSWORD: credentials.password,
        POSTGRES_DATABASE: credentials.database,
        POSTGRES_HOST: credentials.host,
        POSTGRES_PORT: credentials.port.toString(),
      };

      // CLI arguments for default help command
      const envArgv = ["node", "script.js", "help"];

      await RunStratalineCLI({
        migrations: testMigrations,
        loadFrom: "env",
        logger: mockLogger,
        argv: envArgv,
        env: customEnv,
      });

      // Check logs for successful connection
      const connectionLogs = logEntries.filter(
        (entry) =>
          entry.type === "info" &&
          entry.message.includes("Successfully connected to database"),
      );
      expect(connectionLogs.length).toBeGreaterThan(0);
    });

    it("should use environment variable prefix with a custom env object", async () => {
      const credentials = testDb.getCredentials();
      if (!credentials) {
        throw new Error("Failed to get test database credentials");
      }

      const customEnvWithPrefix: Record<string, string | undefined> = {
        TEST_POSTGRES_USER: credentials.user,
        TEST_POSTGRES_PASSWORD: credentials.password,
        TEST_POSTGRES_DATABASE: credentials.database,
        TEST_POSTGRES_HOST: credentials.host,
        TEST_POSTGRES_PORT: credentials.port.toString(),
      };

      const argv = ["node", "script.js", "help"]; // Default to help command
      await RunStratalineCLI({
        migrations: testMigrations,
        loadFrom: "env",
        envPrefix: "TEST_",
        logger: mockLogger,
        argv,
        env: customEnvWithPrefix,
      });

      // Check logs for successful connection
      const connectionLogs = logEntries.filter(
        (entry) =>
          entry.type === "info" &&
          entry.message.includes("Successfully connected to database"),
      );
      expect(connectionLogs.length).toBeGreaterThan(0);
    });

    it("should throw error when required environment variables are missing in custom env object", async () => {
      const customEnvMissing: Record<string, string | undefined> = {}; // Empty object ensures variables are missing

      await expect(
        RunStratalineCLI({
          migrations: testMigrations,
          loadFrom: "env",
          logger: mockLogger,
          env: customEnvMissing,
        }),
      ).rejects.toThrow("Missing required environment variables");

      // Verify error logs for missing environment variable error
      const errorLogs = logEntries.filter(
        (entry) =>
          entry.type === "error" &&
          entry.message.includes("Missing required environment variable"),
      );
      expect(errorLogs.length).toBeGreaterThan(0);
    });
  });

  it("should throw error when both pool and loadFrom='env' are provided", async () => {
    const pool = testDb.getPool();
    expect(pool).not.toBeNull();

    if (pool) {
      await expect(
        RunStratalineCLI({
          migrations: testMigrations,
          loadFrom: "env",
          pool: pool as Pool, // This should cause an error
          logger: mockLogger,
        }),
      ).rejects.toThrow("Cannot provide both pool and loadFrom='env'");
    }
  });

  // Test that the CLI logger properly handles migration errors
  it("should log migration errors correctly", () => {
    // Mock console methods
    const originalError = console.error;
    const mockError = mock(() => {});
    console.error = mockError;

    try {
      const logger = createCLIConsoleLogger(true);

      // Test migration error logging
      logger(
        "migrate-error",
        "[beforeSchema] Failed to create table: error details",
      );
      logger(
        "migrate-error",
        "[dataMigration] Failed to insert data: error details",
      );
      logger(
        "migrate-error",
        "[afterSchema] Failed to create index: error details",
      );

      // Verify console.error calls with proper prefixes
      expect(mockError).toHaveBeenCalledTimes(3);
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] [beforeSchema] Failed to create table: error details",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] [dataMigration] Failed to insert data: error details",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] [afterSchema] Failed to create index: error details",
      );
    } finally {
      // Restore original console methods
      console.error = originalError;
    }
  });

  // Test that the CLI logger properly handles errors from different migration phases
  it("should handle errors from different migration phases", () => {
    // Mock console methods
    const originalError = console.error;
    const mockError = mock(() => {});
    console.error = mockError;

    try {
      const logger = createCLIConsoleLogger(true);

      // Simulate errors from different migration phases
      const beforeSchemaError = new Error("Error in beforeSchema phase");
      const dataMigrationError = new Error("Error in dataMigration phase");
      const afterSchemaError = new Error("Error in afterSchema phase");

      // Log errors with phase prefixes
      logger("migrate-error", `[beforeSchema] ${beforeSchemaError.message}`);
      logger("migrate-error", `[dataMigration] ${dataMigrationError.message}`);
      logger("migrate-error", `[afterSchema] ${afterSchemaError.message}`);

      // Verify error messages are logged with correct prefixes
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] [beforeSchema] Error in beforeSchema phase",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] [dataMigration] Error in dataMigration phase",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] [afterSchema] Error in afterSchema phase",
      );
    } finally {
      // Restore original console methods
      console.error = originalError;
    }
  });

  // Test that the CLI logger properly preserves phase prefixes
  it("should preserve phase prefixes in error messages", () => {
    // Mock console methods
    const originalError = console.error;
    const mockError = mock(() => {});
    console.error = mockError;

    try {
      const logger = createCLIConsoleLogger(true);

      // Test migration errors with different phase prefixes
      logger("migrate-error", "[beforeSchema] Error in schema creation");
      logger("migrate-error", "[dataMigration] Error in data migration");
      logger("migrate-error", "[afterSchema] Error in post-schema operations");

      // Verify console.error calls preserve the phase prefixes
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] [beforeSchema] Error in schema creation",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] [dataMigration] Error in data migration",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATE-ERROR] [afterSchema] Error in post-schema operations",
      );
    } finally {
      // Restore original console methods
      console.error = originalError;
    }
  });

  // Test with actual migration errors - separate tests for each phase
  describe("should handle real migration errors correctly", () => {
    // Create a test logger function
    const createTestLogger = (verbose = CLI_TESTS_VERBOSE_LOGGING) => {
      const capturedErrors: string[] = [];
      const testLogger: CLILoggerFunction = (type, message) => {
        if (verbose) {
          console.log(`Logger: [${type}] ${message}`);
        }

        if (type === "error" || type === "migrate-error") {
          capturedErrors.push(message);
        }
      };
      return { testLogger, capturedErrors };
    };

    // Test beforeSchema error
    it("should handle beforeSchema phase errors correctly", async () => {
      // Create a real test database with automatic port assignment
      const uniqueTime = Date.now();
      const uniqueDbName = `strataline_test_${uniqueTime}`;

      let dbInstance: TestDatabaseInstance | null = null;
      const { testLogger } = createTestLogger();

      try {
        // Start a real PostgreSQL test instance with automatic port assignment
        dbInstance = new TestDatabaseInstance({
          databaseName: uniqueDbName,
        });

        await dbInstance.start();
        const pool = dbInstance.getPool();

        // Make sure the pool is available before proceeding
        if (!pool) {
          throw new Error(
            "Failed to get a database pool from TestDatabaseInstance",
          );
        }

        // Test the database connection first
        try {
          const client = await pool.connect();
          await client.release();
        } catch (error: any) {
          throw new Error(`Cannot connect to test database: ${error.message}`);
        }

        // Define a simple migration that fails in the beforeSchema phase
        const beforeSchemaErrorMigration: Migration = {
          id: "error_before_schema",
          description: "This migration fails in the beforeSchema phase",
          beforeSchema: async (client) => {
            throw new Error("Intentional error in beforeSchema phase");
          },
          migration: async (pool, ctx) => {
            ctx.complete();
          },
        };

        let beforeSchemaError: any = null;

        try {
          // CLI arguments for "run" operation
          const errorArgv = ["node", "strataline-cli.js", "run"];

          await RunStratalineCLI({
            migrations: [beforeSchemaErrorMigration],
            loadFrom: "pool",
            pool,
            logger: testLogger,
            argv: errorArgv,
          });

          // Should have thrown an error
          expect("Migration should have failed").toBe("but it succeeded");
        } catch (error: any) {
          // Expected error to be thrown
          beforeSchemaError = error;
        }

        // Verify the error contains phase prefix information
        expect(beforeSchemaError).toBeDefined();
        expect(beforeSchemaError.message).toContain("beforeSchema");
      } finally {
        // Clean up the test database
        if (dbInstance) {
          try {
            await dbInstance.stop();
          } catch (e) {
            throw new Error(`Failed to stop test database: ${e.message}`);
          }
        }
      }
    });

    // Test dataMigration error
    it("should handle dataMigration phase errors correctly", async () => {
      // Create a real test database with automatic port assignment
      const uniqueTime = Date.now();
      const uniqueDbName = `strataline_test_${uniqueTime}`;

      let dbInstance: TestDatabaseInstance | null = null;
      const { testLogger } = createTestLogger();

      try {
        // Start a real PostgreSQL test instance with automatic port assignment
        dbInstance = new TestDatabaseInstance({
          databaseName: uniqueDbName,
        });

        await dbInstance.start();
        const pool = dbInstance.getPool();

        // Make sure the pool is available before proceeding
        if (!pool) {
          throw new Error(
            "Failed to get a database pool from TestDatabaseInstance",
          );
        }

        // Test the database connection first
        try {
          const client = await pool.connect();
          await client.release();
        } catch (error: any) {
          throw new Error(`Cannot connect to test database: ${error.message}`);
        }

        // Define a simple migration that fails in the dataMigration phase
        const dataMigrationErrorMigration: Migration = {
          id: "error_data_migration",
          description: "This migration fails in the dataMigration phase",
          beforeSchema: async (client) => {
            // Should complete successfully
            await client.query("SELECT 1");
          },
          migration: async (pool, ctx) => {
            throw new Error("Intentional error in dataMigration phase");
          },
        };

        let dataMigrationError: any = null;

        try {
          // CLI arguments for "run" operation
          const errorArgv = ["node", "strataline-cli.js", "run"];

          await RunStratalineCLI({
            migrations: [dataMigrationErrorMigration],
            loadFrom: "pool",
            pool,
            logger: testLogger,
            argv: errorArgv,
          });

          // Should have thrown an error
          expect("Migration should have failed").toBe("but it succeeded");
        } catch (error: any) {
          // Expected error to be thrown
          dataMigrationError = error;
        }

        // Verify the error contains phase prefix information
        expect(dataMigrationError).toBeDefined();
        expect(dataMigrationError.message).toContain("dataMigration");
      } finally {
        // Clean up the test database
        if (dbInstance) {
          try {
            await dbInstance.stop();
          } catch (e) {
            throw new Error(`Failed to stop test database: ${e.message}`);
          }
        }
      }
    });

    // Test afterSchema error
    it("should handle afterSchema phase errors correctly", async () => {
      // Create a real test database with automatic port assignment
      const uniqueTime = Date.now();
      const uniqueDbName = `strataline_test_${uniqueTime}`;

      let dbInstance: TestDatabaseInstance | null = null;
      const { testLogger } = createTestLogger();

      try {
        // Start a real PostgreSQL test instance with automatic port assignment
        dbInstance = new TestDatabaseInstance({
          databaseName: uniqueDbName,
        });

        await dbInstance.start();
        const pool = dbInstance.getPool();

        // Make sure the pool is available before proceeding
        if (!pool) {
          throw new Error(
            "Failed to get a database pool from TestDatabaseInstance",
          );
        }

        // Test the database connection first
        try {
          const client = await pool.connect();
          await client.release();
        } catch (error: any) {
          throw new Error(`Cannot connect to test database: ${error.message}`);
        }

        // Define a simple migration that fails in the afterSchema phase
        const afterSchemaErrorMigration: Migration = {
          id: "error_after_schema",
          description: "This migration fails in the afterSchema phase",
          beforeSchema: async (client) => {
            // Should complete successfully
            await client.query("SELECT 1");
          },
          migration: async (pool, ctx) => {
            ctx.complete();
          },
          afterSchema: async (client) => {
            throw new Error("Intentional error in afterSchema phase");
          },
        };

        let afterSchemaError: any = null;

        try {
          // CLI arguments for run command
          const errorArgv = ["node", "strataline-cli.js", "run"];

          await RunStratalineCLI({
            migrations: [afterSchemaErrorMigration],
            loadFrom: "pool",
            pool,
            logger: testLogger,
            argv: errorArgv,
          });

          // Should have thrown an error
          expect("Migration should have failed").toBe("but it succeeded");
        } catch (error: any) {
          // Expected error to be thrown
          afterSchemaError = error;
        }

        // Verify the error contains phase prefix information
        expect(afterSchemaError).toBeDefined();
        expect(afterSchemaError.message).toContain("afterSchema");
      } finally {
        // Clean up the test database
        if (dbInstance) {
          try {
            await dbInstance.stop();
          } catch (e) {
            throw new Error(`Failed to stop test database: ${e.message}`);
          }
        }
      }
    });
  });
});
