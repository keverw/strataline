import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import EmbeddedPostgres from "embedded-postgres";
import { Pool, type PoolClient } from "pg"; // Import PoolClient
import { MigrationManager, type Migration } from "./migration-system";
import * as tmp from "tmp";
import { consoleLogger, MutableLogger } from "./logger";
import { createSchemaHelpers } from "./schema-helpers";

// Set a longer timeout for tests that involve database operations
const TEST_TIMEOUT = 30000;
const TEST_DB_PORT = 5555;

// Control whether to show logs during tests
const MIGRATION_MANAGER_VERBOSE_LOGGING = false;
// Control whether to show postgres logs
const PG_VERBOSE_LOGGING = false;
// Create a mutable logger that can be toggled

describe("MigrationManager", () => {
  let postgres: EmbeddedPostgres;
  let pool: Pool;
  let testLogger: MutableLogger;
  let migrationManager: MigrationManager;
  let isSetupComplete = false;

  // Set up the embedded PostgreSQL server before all tests
  beforeAll(async () => {
    try {
      // Create a temporary directory that will be automatically removed on process exit
      const tempDir = tmp.dirSync({
        unsafeCleanup: true, // Remove directory even if it's not empty
        prefix: "pg-test-",
      });

      if (PG_VERBOSE_LOGGING) {
        console.log(`Created temporary directory: ${tempDir.name}`);
      }

      // Create and start an embedded PostgreSQL server
      postgres = new EmbeddedPostgres({
        port: TEST_DB_PORT, // Use a different port than default to avoid conflicts
        user: "test_user",
        password: "test_password",
        persistent: false, // Don't persist data between test runs
        databaseDir: tempDir.name, // Use the temporary directory for the database
        onLog: (message) => {
          // Only log postgres messages if PG_VERBOSE_LOGGING is enabled
          if (PG_VERBOSE_LOGGING) {
            console.log(message);
          }
        },
      });

      // Initialize and start the PostgreSQL server
      await postgres.initialise();
      await postgres.start();

      // Create a test database
      await postgres.createDatabase("test_migrations");

      // Create a connection pool to the test database
      pool = new Pool({
        host: "localhost",
        port: TEST_DB_PORT,
        database: "test_migrations",
        user: "test_user",
        password: "test_password",
      });

      // Test the connection
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();

      isSetupComplete = true;

      if (PG_VERBOSE_LOGGING) {
        console.log("Embedded PostgreSQL started for testing");
      }
    } catch (error) {
      console.error("Failed to set up test database:", error);
      // Clean up if setup failed
      if (pool) {
        await pool.end().catch((e) => console.error("Error closing pool:", e));
      }

      if (postgres) {
        await postgres
          .stop()
          .catch((e) => console.error("Error stopping postgres:", e));
      }

      throw error;
    }
  }); // Allow up to 30 seconds for startup

  // Clean up the embedded PostgreSQL server after all tests
  afterAll(async () => {
    if (!isSetupComplete) {
      return;
    }

    try {
      // Close the connection pool
      if (pool) {
        await pool.end();
      }

      // Drop the test database and stop the embedded PostgreSQL server
      if (postgres) {
        try {
          await postgres.dropDatabase("test_migrations");
        } catch (err) {
          console.error("Error dropping test database:", err);
        }

        try {
          await postgres.stop();

          if (PG_VERBOSE_LOGGING) {
            console.log("Embedded PostgreSQL stopped");
          }
        } catch (err) {
          console.error("Error stopping PostgreSQL:", err);
        }
      }
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  });

  beforeEach(async () => {
    // If setup failed, the beforeAll should have thrown an error already
    expect(isSetupComplete).toBe(true);

    // Clean up any existing migration tables from previous tests
    try {
      const client = await pool.connect();
      await client.query("DROP TABLE IF EXISTS migration_status");
      await client.query("DROP TABLE IF EXISTS migration_lock");
      client.release();
    } catch (err) {
      console.error("Error cleaning up tables:", err);
    }

    // Create a fresh logger for each test
    testLogger = new MutableLogger(
      consoleLogger,
      MIGRATION_MANAGER_VERBOSE_LOGGING,
    );

    // Create a fresh migration manager for each test
    migrationManager = new MigrationManager(pool, testLogger);
  });

  afterEach(async () => {
    // Additional cleanup if needed
  });

  test(
    "should initialize migration tables",
    async () => {
      // This will implicitly call ensureInitialized()
      const status = await migrationManager.getMigrationStatus();

      // Verify the tables exist by querying them directly
      const client = await pool.connect();

      try {
        const { rows: statusTableExists } = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'migration_status'
        );
      `);

        const { rows: lockTableExists } = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'migration_lock'
        );
      `);

        expect(statusTableExists[0].exists).toBe(true);
        expect(lockTableExists[0].exists).toBe(true);
        expect(Array.isArray(status)).toBe(true);
      } finally {
        client.release();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "should register migrations",
    async () => {
      // Create a sample migration
      const testMigration: Migration = {
        id: "test_migration_001",
        description: "Test migration",
        beforeSchema: async (client) => {
          await client.query(`
          CREATE TABLE test_table (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL
          );
        `);
        },
        migration: async (pool, ctx) => {
          // Insert some test data
          await pool.query(`
          INSERT INTO test_table (name) VALUES ('Test 1'), ('Test 2');
        `);
          ctx.complete();
        },
        afterSchema: async (client) => {
          await client.query(`
          CREATE INDEX idx_test_table_name ON test_table (name);
        `);
        },
      };

      // Register the migration
      migrationManager.register([testMigration]);

      // Run the schema changes
      const result = await migrationManager.runSchemaChanges("job");

      // Verify the migration was successful
      expect(result.success).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.completedMigrations).toEqual(["test_migration_001"]);
      expect(result.previouslyAppliedMigrations).toEqual([]);

      // Verify the table was created and data was inserted
      const client = await pool.connect();

      try {
        const { rows } = await client.query(`
        SELECT * FROM test_table ORDER BY id;
      `);

        expect(rows.length).toBe(2);
        expect(rows[0].name).toBe("Test 1");
        expect(rows[1].name).toBe("Test 2");

        // Verify the index was created
        const { rows: indexExists } = await client.query(`
        SELECT EXISTS (
          SELECT FROM pg_indexes
          WHERE indexname = 'idx_test_table_name'
        );
      `);

        expect(indexExists[0].exists).toBe(true);
      } finally {
        client.release();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "should handle deferred migrations",
    async () => {
      // Create a migration that defers
      const deferredMigration: Migration = {
        id: "deferred_migration_001",
        description: "Migration that defers",
        beforeSchema: async (client) => {
          await client.query(`
          CREATE TABLE deferred_table (
            id SERIAL PRIMARY KEY,
            status TEXT NOT NULL
          );
        `);
        },
        migration: async (pool, ctx) => {
          // Defer the migration
          ctx.defer("Testing defer functionality");
        },
      };

      // Register and run the migration
      migrationManager.register([deferredMigration]);
      const result = await migrationManager.runSchemaChanges("job");

      // Verify the migration was deferred
      expect(result.success).toBe(false);
      expect(result.status).toBe("deferred");
      expect(result.reason).toBe(
        "Migration deferred_migration_001 was deferred: Testing defer functionality",
      );

      // Verify the table was created (beforeSchema should still run)
      const client = await pool.connect();

      try {
        const { rows: tableExists } = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'deferred_table'
        );
      `);

        expect(tableExists[0].exists).toBe(true);
      } finally {
        client.release();
      }
    },
    TEST_TIMEOUT,
  );

  // Add a test for data migration jobs
  test(
    "should run data migration jobs",
    async () => {
      // Create a migration with a data migration job
      const dataMigrationTest: Migration = {
        id: "data_migration_001",
        description: "Data migration test",
        beforeSchema: async (client) => {
          await client.query(`
          CREATE TABLE data_migration_table (
            id SERIAL PRIMARY KEY,
            value TEXT NOT NULL,
            processed BOOLEAN DEFAULT FALSE
          );
          
          INSERT INTO data_migration_table (value) 
          VALUES ('item1'), ('item2'), ('item3');
        `);
        },
        migration: async (pool, ctx) => {
          if (ctx.mode === "distributed") {
            // pretend we schedule a job elsewhere
            // Then run just the data migration job
            const result =
              await migrationManager.runDataMigrationJobOnly(
                "data_migration_001",
              );

            // Verify the data migration was successful
            expect(result.status).toBe("success");

            // Mark as complete (real implementation would do this more robustly)
            ctx.complete(result); // Pass data if any
          } else {
            // Process the data
            // In a real scenario, this would be more complex and use a payload to work on only a
            // subset of data

            await pool.query(`
              UPDATE data_migration_table 
              SET processed = TRUE, value = value || '_processed'
            `);

            // Mark as complete
            ctx.complete("Ran data migration job on all data");
          }
        },
      };

      // Register and run the migration
      migrationManager.register([dataMigrationTest]);

      // Run the schema part changes in distributed mode
      const migrationManagerResult =
        await migrationManager.runSchemaChanges("distributed");

      expect(migrationManagerResult).toMatchObject({
        success: true,
        status: "completed",
        completedMigrations: ["data_migration_001"],
        previouslyAppliedMigrations: [],
        pendingMigrations: [],
        migrationData: {
          data_migration_001: {
            status: "success",
            data: "Ran data migration job on all data",
          },
        },
      });

      // Check that the data was processed
      const client = await pool.connect();

      try {
        const { rows } = await client.query(`
        SELECT * FROM data_migration_table ORDER BY id;
      `);

        expect(rows.length).toBe(3);
        expect(rows[0].processed).toBe(true);
        expect(rows[0].value).toBe("item1_processed");
        expect(rows[1].processed).toBe(true);
        expect(rows[2].processed).toBe(true);
      } finally {
        client.release();
      }

      // if we try to run the data migration job only again, it should fail
      const result =
        await migrationManager.runDataMigrationJobOnly("data_migration_001");

      // Should be 'already_complete' as the migration (including its data part) was completed by runSchemaChanges
      expect(result.status).toBe("already_complete");
    },
    TEST_TIMEOUT,
  );

  test(
    "should handle deferred migrations with data",
    async () => {
      const deferredWithDataMigration: Migration<
        Record<string, never>,
        { checkpoint: number }
      > = {
        id: "deferred_with_data_001",
        description: "Migration that defers with data",
        beforeSchema: async (client) => {
          await client.query(
            `CREATE TABLE IF NOT EXISTS deferred_data_table (id INT);`,
          );
        },
        migration: async (pool, ctx) => {
          ctx.defer("Checkpointing", { checkpoint: 123 });
        },
      };

      migrationManager.register([deferredWithDataMigration]);

      // First, run via runSchemaChanges to simulate a scenario where it's part of a larger run
      const schemaChangesResult =
        await migrationManager.runSchemaChanges("job");
      expect(schemaChangesResult.success).toBe(false);
      expect(schemaChangesResult.status).toBe("deferred");
      expect(schemaChangesResult.reason).toContain(
        "Migration deferred_with_data_001 was deferred: Checkpointing",
      );
      // Data from defer is not directly in schemaChangesResult.migrationData,
      // as that's for successfully completed migrations.
      // The primary way to get this data is via runDataMigrationJobOnly.

      // Now, run it as a job to get the deferred data
      const jobResult = await migrationManager.runDataMigrationJobOnly(
        "deferred_with_data_001",
      );
      expect(jobResult.status).toBe("deferred");
      expect(jobResult.reason).toBe("Checkpointing");
      expect(jobResult.data).toEqual({ checkpoint: 123 });
    },
    TEST_TIMEOUT,
  );

  test(
    "should handle error in beforeSchema",
    async () => {
      const errorBeforeSchemaMigration: Migration = {
        id: "error_before_schema_001",
        description: "Migration that errors in beforeSchema",
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        beforeSchema: async (client) => {
          throw new Error("Failure in beforeSchema");
        },
        migration: async (pool, ctx) => {
          ctx.complete();
        },
      };

      migrationManager.register([errorBeforeSchemaMigration]);
      const result = await migrationManager.runSchemaChanges("job");

      expect(result.success).toBe(false);
      expect(result.status).toBe("error");
      expect(result.reason).toBe(
        "Migration error_before_schema_001 failed: [beforeSchema] Failure in beforeSchema",
      );
      expect(result.completedMigrations).toEqual([]);
      expect(result.previouslyAppliedMigrations).toEqual([]);
      expect(result.pendingMigrations).toContain("error_before_schema_001");
    },
    TEST_TIMEOUT,
  );

  test(
    "should handle error in migration function",
    async () => {
      const errorInMigrationFunc: Migration = {
        id: "error_in_migration_func_001",
        description: "Migration that errors in its main function",
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        migration: async (pool, ctx) => {
          throw new Error("Failure in migration function");
        },
      };

      migrationManager.register([errorInMigrationFunc]);
      const result = await migrationManager.runSchemaChanges("job");

      expect(result.success).toBe(false);
      expect(result.status).toBe("error");
      expect(result.reason).toBe(
        "Migration error_in_migration_func_001 failed: [dataMigration] Failure in migration function",
      );
      // beforeSchema might have completed for this one, but the overall migration failed.
      // Check status table if needed for more granular checks on partial completion.
    },
    TEST_TIMEOUT,
  );

  test(
    "should handle migration function finishing without complete/defer",
    async () => {
      const noCallbackMigration: Migration = {
        id: "no_callback_001",
        description:
          "Migration that finishes without calling complete or defer",
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        migration: async (pool, ctx) => {
          // Simulates doing some work but not calling complete() or defer()
          await pool.query("SELECT 1");
        },
      };

      migrationManager.register([noCallbackMigration]);
      const result = await migrationManager.runSchemaChanges("job");

      expect(result.success).toBe(false);
      expect(result.status).toBe("error");
      expect(result.reason).toBe(
        "Migration no_callback_001 failed: [dataMigration] Migration function finished without calling complete() or defer().",
      );
    },
    TEST_TIMEOUT,
  );

  test(
    "should handle error in afterSchema",
    async () => {
      const errorAfterSchemaMigration: Migration = {
        id: "error_after_schema_001",
        description: "Migration that errors in afterSchema",
        beforeSchema: async (client) => {
          await client.query(
            "CREATE TABLE IF NOT EXISTS another_dummy_table (id INT)",
          );
        },
        migration: async (pool, ctx) => {
          ctx.complete();
        },
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        afterSchema: async (client) => {
          throw new Error("Failure in afterSchema");
        },
      };

      migrationManager.register([errorAfterSchemaMigration]);
      const result = await migrationManager.runSchemaChanges("job");

      expect(result.success).toBe(false);
      expect(result.status).toBe("error");
      expect(result.reason).toBe(
        "Migration error_after_schema_001 failed: [afterSchema] Failure in afterSchema",
      );
      // beforeSchema and migration phases would have completed successfully.
    },
    TEST_TIMEOUT,
  );

  test(
    "should mark a migration with no handlers as fully complete",
    async () => {
      const emptyMigration: Migration = {
        id: "empty_migration_001",
        description: "Migration with no handlers",
        // No beforeSchema, migration, or afterSchema handlers
      };

      migrationManager.register([emptyMigration]);
      const result = await migrationManager.runSchemaChanges("job");

      // The migration should succeed since all phases are marked as complete
      expect(result.success).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.completedMigrations).toEqual(["empty_migration_001"]);
      expect(result.previouslyAppliedMigrations).toEqual([]);
      expect(result.pendingMigrations).toEqual([]);

      // Verify migration status in the database
      const client = await pool.connect();
      try {
        const { rows } = await client.query(
          `SELECT * FROM migration_status WHERE id = $1`,
          ["empty_migration_001"],
        );

        expect(rows.length).toBe(1);
        expect(rows[0].before_schema_applied).toBe(true);
        expect(rows[0].migration_complete).toBe(true);
        expect(rows[0].after_schema_applied).toBe(true);
        expect(Number(rows[0].completed_at)).toBeGreaterThan(0);
      } finally {
        client.release();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "should handle a migration with all handlers properly",
    async () => {
      // Create a table to track execution of each handler
      const client = await pool.connect();
      try {
        await client.query(
          `CREATE TABLE handler_execution_tracker (
            id SERIAL PRIMARY KEY,
            handler_type TEXT NOT NULL,
            executed BOOLEAN DEFAULT FALSE
          )`,
        );
      } finally {
        client.release();
      }

      const completeHandlersMigration: Migration = {
        id: "complete_handlers_001",
        description: "Migration with all three handlers",
        beforeSchema: async (client) => {
          await client.query(
            `INSERT INTO handler_execution_tracker (handler_type, executed) 
             VALUES ('beforeSchema', TRUE)`,
          );
        },
        migration: async (pool, ctx) => {
          const client = await pool.connect();
          try {
            await client.query(
              `INSERT INTO handler_execution_tracker (handler_type, executed) 
               VALUES ('migration', TRUE)`,
            );
          } finally {
            client.release();
          }
          ctx.complete();
        },
        afterSchema: async (client) => {
          await client.query(
            `INSERT INTO handler_execution_tracker (handler_type, executed) 
             VALUES ('afterSchema', TRUE)`,
          );
        },
      };

      migrationManager.register([completeHandlersMigration]);
      const result = await migrationManager.runSchemaChanges("job");

      // The migration should succeed with all handlers executed
      expect(result.success).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.completedMigrations).toEqual(["complete_handlers_001"]);
      expect(result.previouslyAppliedMigrations).toEqual([]);
      expect(result.pendingMigrations).toEqual([]);

      // Verify all handlers executed by checking the tracker table
      const verifyClient = await pool.connect();
      try {
        const { rows } = await verifyClient.query(
          `SELECT * FROM handler_execution_tracker ORDER BY id`,
        );

        expect(rows.length).toBe(3);
        expect(rows[0].handler_type).toBe("beforeSchema");
        expect(rows[0].executed).toBe(true);
        expect(rows[1].handler_type).toBe("migration");
        expect(rows[1].executed).toBe(true);
        expect(rows[2].handler_type).toBe("afterSchema");
        expect(rows[2].executed).toBe(true);

        // Also verify migration status in the database
        const { rows: statusRows } = await verifyClient.query(
          `SELECT * FROM migration_status WHERE id = $1`,
          ["complete_handlers_001"],
        );

        expect(statusRows.length).toBe(1);
        expect(statusRows[0].before_schema_applied).toBe(true);
        expect(statusRows[0].migration_complete).toBe(true);
        expect(statusRows[0].after_schema_applied).toBe(true);
        expect(Number(statusRows[0].completed_at)).toBeGreaterThan(0);
      } finally {
        verifyClient.release();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "should renew lock during long-running migrations",
    async () => {
      // Create a migration manager with a very short lock renewal time (1 second)
      const shortRenewalManager = new MigrationManager(pool, testLogger, {
        lockRenewalSeconds: 1, // Set to 1 second to ensure renewals happen quickly
      });

      // Create a migration that will take longer than the renewal interval
      const longRunningMigration: Migration = {
        id: "lock_renewal_test_001",
        description:
          "Migration that takes longer than the lock renewal interval",
        beforeSchema: async (client) => {
          await client.query(`
            CREATE TABLE IF NOT EXISTS lock_renewal_test (
              id SERIAL PRIMARY KEY,
              value TEXT,
              timestamp BIGINT
            )
          `);
        },
        migration: async (pool, ctx) => {
          // Insert a row to mark the start
          await pool.query(`
            INSERT INTO lock_renewal_test (value, timestamp) 
            VALUES ('start', extract(epoch from now())::bigint)
          `);

          // Sleep for 3 seconds to ensure at least 2-3 lock renewals
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Insert a row to mark the end
          await pool.query(`
            INSERT INTO lock_renewal_test (value, timestamp) 
            VALUES ('end', extract(epoch from now())::bigint)
          `);

          ctx.complete();
        },
      };

      // Register the migration
      shortRenewalManager.register([longRunningMigration]);

      // Run the migration
      const result = await shortRenewalManager.runSchemaChanges("job");

      // Verify the migration was successful
      expect(result.success).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.completedMigrations).toEqual(["lock_renewal_test_001"]);
      expect(result.previouslyAppliedMigrations).toEqual([]);

      // Verify the lock renewal by checking the lock_renewal_test table
      const client = await pool.connect();
      try {
        // Check that both start and end records exist
        const { rows } = await client.query(`
          SELECT * FROM lock_renewal_test ORDER BY id
        `);

        expect(rows.length).toBe(2);
        expect(rows[0].value).toBe("start");
        expect(rows[1].value).toBe("end");

        // Calculate the duration of the migration
        const duration = rows[1].timestamp - rows[0].timestamp;

        // The migration should have taken at least 3 seconds
        expect(duration).toBeGreaterThanOrEqual(3);

        // Check the migration_lock table to verify lock was created
        const { rows: lockRows } = await client.query(`
          SELECT * FROM migration_lock WHERE lock_name = 'database_migrations'
        `);

        // The lock should have been released after the migration completed
        expect(lockRows.length).toBe(0);
      } finally {
        client.release();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "should properly use logger methods in migration context",
    async () => {
      // Create a migration that uses all logger methods
      const loggerTestMigration: Migration = {
        id: "logger_test_001",
        description: "Migration that tests logger functionality",
        beforeSchema: async (client) => {
          await client.query(`
            CREATE TABLE IF NOT EXISTS logger_test_table (
              id SERIAL PRIMARY KEY,
              message TEXT,
              level TEXT,
              timestamp BIGINT
            )
          `);
        },
        migration: async (pool, ctx) => {
          // Use all three logger methods
          ctx.logger.info({
            message: "This is a regular log message",
          });

          ctx.logger.error({
            message: "This is an error message",
            error: new Error("Test error"),
          });

          if (ctx.logger.warn) {
            ctx.logger.warn({
              message: "This is a warning message",
            });
          }

          // Store log messages in the database to verify they were called
          const client = await pool.connect();
          try {
            await client.query(`
              INSERT INTO logger_test_table (message, level, timestamp) 
              VALUES 
                ('Regular log message', 'log', extract(epoch from now())::bigint),
                ('Error message', 'error', extract(epoch from now())::bigint),
                ('Warning message', 'warn', extract(epoch from now())::bigint)
            `);
          } finally {
            client.release();
          }

          ctx.complete();
        },
      };

      // Register the migration
      migrationManager.register([loggerTestMigration]);

      // Run the migration
      const result = await migrationManager.runSchemaChanges("job");

      // Verify the migration was successful
      expect(result.success).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.completedMigrations).toEqual(["logger_test_001"]);
      expect(result.previouslyAppliedMigrations).toEqual([]);

      // Verify the log entries were created in the database
      const client = await pool.connect();
      try {
        const { rows } = await client.query(`
          SELECT * FROM logger_test_table ORDER BY id
        `);

        expect(rows.length).toBe(3);
        expect(rows[0].level).toBe("log");
        expect(rows[1].level).toBe("error");
        expect(rows[2].level).toBe("warn");
      } finally {
        client.release();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "should run multiple schema migrations in sequence",
    async () => {
      // Create multiple migrations that build on each other
      const firstMigration: Migration = {
        id: "multi_migration_001",
        description: "First migration in sequence",
        beforeSchema: async (client) => {
          await client.query(`
            CREATE TABLE multi_test_table (
              id SERIAL PRIMARY KEY,
              name TEXT NOT NULL
            );
          `);
        },
        migration: async (pool, ctx) => {
          await pool.query(`
            INSERT INTO multi_test_table (name) VALUES ('Initial record');
          `);
          ctx.complete();
        },
      };

      const secondMigration: Migration = {
        id: "multi_migration_002",
        description: "Second migration in sequence",
        beforeSchema: async (client) => {
          await client.query(`
            ALTER TABLE multi_test_table ADD COLUMN description TEXT;
          `);
        },
        migration: async (pool, ctx) => {
          await pool.query(`
            UPDATE multi_test_table SET description = 'Added by second migration';
          `);
          ctx.complete();
        },
      };

      const thirdMigration: Migration = {
        id: "multi_migration_003",
        description: "Third migration in sequence",
        beforeSchema: async (client) => {
          await client.query(`
            CREATE INDEX idx_multi_test_name ON multi_test_table (name);
          `);
        },
        migration: async (pool, ctx) => {
          await pool.query(`
            INSERT INTO multi_test_table (name, description) 
            VALUES ('Second record', 'Added by third migration');
          `);
          ctx.complete();
        },
        afterSchema: async (client) => {
          await client.query(`
            ALTER TABLE multi_test_table ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
          `);
        },
      };

      // Register all migrations
      migrationManager.register([
        firstMigration,
        secondMigration,
        thirdMigration,
      ]);

      // Run all migrations
      const result = await migrationManager.runSchemaChanges("job");

      // Verify the migrations were successful
      expect(result.success).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.completedMigrations).toEqual([
        "multi_migration_001",
        "multi_migration_002",
        "multi_migration_003",
      ]);
      expect(result.previouslyAppliedMigrations).toEqual([]);
      expect(result.pendingMigrations).toEqual([]);

      // Run migrations again to test previously applied migrations behavior
      const secondResult = await migrationManager.runSchemaChanges("job");

      // Verify that no new migrations were applied, but previously applied ones are tracked
      expect(secondResult.success).toBe(true);
      expect(secondResult.status).toBe("completed");
      expect(secondResult.completedMigrations).toEqual([]); // No new migrations in this run
      expect(secondResult.previouslyAppliedMigrations).toEqual([
        "multi_migration_001",
        "multi_migration_002",
        "multi_migration_003",
      ]); // All migrations were already applied
      expect(secondResult.pendingMigrations).toEqual([]);

      // Verify the database state after all migrations
      const client = await pool.connect();
      try {
        // Check that the table exists with all columns
        const { rows: columns } = await client.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'multi_test_table'
          ORDER BY column_name;
        `);

        const columnNames = columns.map((col) => col.column_name);
        expect(columnNames).toContain("created_at");
        expect(columnNames).toContain("description");
        expect(columnNames).toContain("id");
        expect(columnNames).toContain("name");
        expect(columnNames.length).toBe(4);

        // Check that the index exists
        const { rows: indexExists } = await client.query(`
          SELECT EXISTS (
            SELECT FROM pg_indexes
            WHERE indexname = 'idx_multi_test_name'
          );
        `);
        expect(indexExists[0].exists).toBe(true);

        // Check that the data was inserted and updated correctly
        const { rows: tableData } = await client.query(`
          SELECT * FROM multi_test_table ORDER BY id;
        `);

        expect(tableData.length).toBe(2);
        expect(tableData[0].name).toBe("Initial record");
        expect(tableData[0].description).toBe("Added by second migration");
        expect(tableData[1].name).toBe("Second record");
        expect(tableData[1].description).toBe("Added by third migration");

        // Verify all migrations are marked as complete in the status table
        const { rows: migrationStatus } = await client.query(`
          SELECT id, before_schema_applied, migration_complete, after_schema_applied, completed_at
          FROM migration_status
          WHERE id IN ('multi_migration_001', 'multi_migration_002', 'multi_migration_003')
          ORDER BY id;
        `);

        expect(migrationStatus.length).toBe(3);

        // All migrations should be fully completed
        for (const status of migrationStatus) {
          expect(status.before_schema_applied).toBe(true);
          expect(status.migration_complete).toBe(true);
          expect(status.after_schema_applied).toBe(true);
          expect(Number(status.completed_at)).toBeGreaterThan(0);
        }
      } finally {
        client.release();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "should run data migration job with a payload",
    async () => {
      type PayloadType = { item_id: number; new_value: string };
      type ReturnType = { processed_item_id: number; status: string };

      const payloadMigration: Migration<PayloadType, ReturnType> = {
        id: "payload_migration_001",
        description: "Migration that uses a payload for a data job",
        beforeSchema: async (client) => {
          await client.query(`
            CREATE TABLE payload_test_table (
              id INT PRIMARY KEY,
              value TEXT
            );
            INSERT INTO payload_test_table (id, value) VALUES (1, 'initial_value_1'), (2, 'initial_value_2');
          `);
        },
        migration: async (pool, ctx) => {
          // This migration should only be run as a job with a payload
          if (ctx.mode !== "job" || !ctx.payload) {
            ctx.defer("Requires job mode and payload");
            return;
          }

          const { item_id, new_value } = ctx.payload;

          const result = await pool.query(
            `UPDATE payload_test_table SET value = $1 WHERE id = $2 RETURNING id`,
            [new_value, item_id],
          );

          if (result.rowCount === 1) {
            ctx.complete({
              processed_item_id: result.rows[0].id,
              status: "updated",
            });
          } else {
            ctx.complete({
              processed_item_id: item_id,
              status: "not_found",
            });
          }
        },
      };

      migrationManager.register([payloadMigration]);

      // Run beforeSchema part first (e.g., via runSchemaChanges or manually setting status)
      // For simplicity in this test, we'll run schema changes in a mode that defers the data part
      // if it's not designed for it, or just ensure beforeSchema runs.
      // A quick way to ensure beforeSchema runs is to attempt a runSchemaChanges
      // that we expect to defer or error if the migration isn't set up for 'distributed'
      // or if it tries to run the data part without payload.
      // Let's make it simple: run schema changes which will apply beforeSchema.
      // The migration itself will defer if not in 'job' mode with payload.
      const initialRun = await migrationManager.runSchemaChanges("distributed");
      // We expect this to defer because the migration logic defers if mode is not 'job' or no payload
      expect(initialRun.status).toBe("deferred");
      expect(initialRun.reason).toContain("Requires job mode and payload");

      // Now run the data migration job with a specific payload
      const jobPayload: PayloadType = {
        item_id: 1,
        new_value: "updated_via_payload",
      };
      const jobResult = await migrationManager.runDataMigrationJobOnly<
        PayloadType,
        ReturnType
      >("payload_migration_001", jobPayload);

      expect(jobResult.status).toBe("success");
      expect(jobResult.data).toEqual({
        processed_item_id: 1,
        status: "updated",
      });

      // Verify the data in the table
      const client = await pool.connect();
      try {
        const { rows } = await client.query(
          `SELECT value FROM payload_test_table WHERE id = 1`,
        );
        expect(rows.length).toBe(1);
        expect(rows[0].value).toBe("updated_via_payload");

        // Verify other data wasn't touched
        const { rows: otherRows } = await client.query(
          `SELECT value FROM payload_test_table WHERE id = 2`,
        );
        expect(otherRows.length).toBe(1);
        expect(otherRows[0].value).toBe("initial_value_2");
      } finally {
        client.release();
      }

      // Test with a payload for an item that doesn't exist
      const nonExistentPayload: PayloadType = {
        item_id: 99,
        new_value: "wont_be_written",
      };
      const nonExistentJobResult =
        await migrationManager.runDataMigrationJobOnly<PayloadType, ReturnType>(
          "payload_migration_001",
          nonExistentPayload,
        );
      expect(nonExistentJobResult.status).toBe("success"); // complete is called
      expect(nonExistentJobResult.data).toEqual({
        processed_item_id: 99,
        status: "not_found",
      });
    },
    TEST_TIMEOUT,
  );

  // Add a new describe block for schema helpers
  describe("SchemaHelpers", () => {
    let helpers: ReturnType<typeof createSchemaHelpers>;
    let client: PoolClient; // Use PoolClient from pg

    beforeEach(async () => {
      // Get a client from the pool for schema operations
      client = await pool.connect();
      helpers = createSchemaHelpers(testLogger, { task: "schema-test" });

      // Ensure a base table exists for testing modifications
      await client.query(`
        DROP TABLE IF EXISTS helper_test_table_ref;
        DROP TABLE IF EXISTS helper_test_table;
        CREATE TABLE helper_test_table (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE helper_test_table_ref (
          ref_id SERIAL PRIMARY KEY,
          description TEXT
        );
      `);
    });

    afterEach(async () => {
      // Clean up tables and release the client
      if (client) {
        try {
          await client.query("DROP TABLE IF EXISTS helper_test_table;");
          await client.query("DROP TABLE IF EXISTS helper_test_table_ref;");
        } catch (err) {
          console.error("Error dropping helper test tables:", err);
        } finally {
          client.release();
        }
      }
    });

    // --- Tests for createTable ---
    test("createTable should create a new table with constraints", async () => {
      const tableName = "new_created_table";
      await helpers.createTable(
        client,
        tableName,
        { col1: "INT", col2: "VARCHAR(50)" },
        ["CONSTRAINT pk_new PRIMARY KEY (col1)"],
      );

      // Verify table exists
      const { rows } = await client.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1);`,
        [tableName],
      );
      expect(rows[0].exists).toBe(true);

      // Verify columns exist
      const { rows: cols } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position;`,
        [tableName],
      );
      expect(cols.map((r) => r.column_name)).toEqual(["col1", "col2"]);

      // Verify constraint exists (basic check)
      const { rows: constraints } = await client.query(
        `SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = $1 AND constraint_type = 'PRIMARY KEY';`,
        [tableName],
      );
      expect(constraints[0].constraint_name).toBe("pk_new");

      await client.query(`DROP TABLE ${tableName};`); // Clean up
    });

    test("createTable should not fail if table already exists", async () => {
      // helper_test_table already exists from beforeEach
      expect(
        helpers.createTable(client, "helper_test_table", { id: "INT" }),
      ).resolves.toBeUndefined(); // Should complete without error
    });

    // --- Tests for addColumn ---
    test("addColumn should add a new column", async () => {
      await helpers.addColumn(
        client,
        "helper_test_table",
        "new_col",
        "BOOLEAN",
      );
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'helper_test_table' AND column_name = 'new_col';`,
      );
      expect(rows.length).toBe(1);
    });

    test("addColumn should add a new column with a default value", async () => {
      await helpers.addColumn(
        client,
        "helper_test_table",
        "col_with_default",
        "INT",
        "42",
      );
      const { rows } = await client.query(
        `SELECT column_default FROM information_schema.columns WHERE table_name = 'helper_test_table' AND column_name = 'col_with_default';`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].column_default).toBe("42"); // Default value is stored as string
    });

    test("addColumn should not fail if column already exists", async () => {
      // 'name' column exists from beforeEach
      expect(
        helpers.addColumn(client, "helper_test_table", "name", "TEXT"),
      ).resolves.toBeUndefined();
    });

    test("addColumn should throw error for non-existent table", async () => {
      expect(
        helpers.addColumn(client, "non_existent_table", "some_col", "TEXT"),
      ).rejects.toThrow(); // Should throw because table doesn't exist
    });

    // --- Tests for removeColumn ---
    test("removeColumn should remove an existing column", async () => {
      // Add a column first to remove it
      await client.query(
        `ALTER TABLE helper_test_table ADD COLUMN to_be_removed INT;`,
      );
      await helpers.removeColumn(client, "helper_test_table", "to_be_removed");
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'helper_test_table' AND column_name = 'to_be_removed';`,
      );
      expect(rows.length).toBe(0);
    });

    test("removeColumn should not fail if column does not exist", async () => {
      expect(
        helpers.removeColumn(
          client,
          "helper_test_table",
          "non_existent_column",
        ),
      ).resolves.toBeUndefined();
    });

    test("removeColumn should throw error for non-existent table", async () => {
      expect(
        helpers.removeColumn(client, "non_existent_table", "some_col"),
      ).rejects.toThrow(); // Should throw because table doesn't exist
    });

    // --- Tests for addIndex ---
    test("addIndex should add a new index", async () => {
      const indexName = "idx_helper_name";
      await helpers.addIndex(client, "helper_test_table", indexName, ["name"]);
      const { rows } = await client.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'helper_test_table' AND indexname = $1;`,
        [indexName],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].indexname).toBe(indexName);
    });

    test("addIndex should add a unique index", async () => {
      const indexName = "uq_helper_name";
      // Ensure name is unique before adding unique index
      await client.query(
        `DELETE FROM helper_test_table; INSERT INTO helper_test_table (name) VALUES ('unique1'), ('unique2');`,
      );
      await helpers.addIndex(
        client,
        "helper_test_table",
        indexName,
        ["name"],
        true, // unique = true
      );
      const { rows } = await client.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'helper_test_table' AND indexname = $1;`,
        [indexName],
      );
      expect(rows.length).toBe(1);
      // Also check constraint type if possible (more complex query needed, pg_constraint)
      // For simplicity, just check existence and try inserting duplicate
      expect(
        client.query(
          `INSERT INTO helper_test_table (name) VALUES ('unique1');`,
        ),
      ).rejects.toThrow(); // Should violate unique constraint
    });

    test("addIndex should not fail if index already exists", async () => {
      const indexName = "idx_helper_created_at";
      await client.query(
        `CREATE INDEX ${indexName} ON helper_test_table(created_at);`,
      );

      expect(
        helpers.addIndex(client, "helper_test_table", indexName, [
          "created_at",
        ]),
      ).resolves.toBeUndefined();
    });

    test("addIndex should throw error for non-existent table", async () => {
      expect(
        helpers.addIndex(client, "non_existent_table", "some_idx", ["col"]),
      ).rejects.toThrow();
    });

    // --- Tests for removeIndex ---
    test("removeIndex should remove an existing index", async () => {
      const indexName = "idx_to_remove";
      await client.query(
        `CREATE INDEX ${indexName} ON helper_test_table(name);`,
      );
      await helpers.removeIndex(client, indexName);
      const { rows } = await client.query(
        `SELECT indexname FROM pg_indexes WHERE indexname = $1;`,
        [indexName],
      );
      expect(rows.length).toBe(0);
    });

    test("removeIndex should not fail if index does not exist", async () => {
      expect(
        helpers.removeIndex(client, "non_existent_index"),
      ).resolves.toBeUndefined();
    });

    // --- Tests for addForeignKey ---
    test("addForeignKey should add a new foreign key constraint", async () => {
      const constraintName = "fk_helper_ref";
      // Add column to reference the other table
      await client.query(
        `ALTER TABLE helper_test_table ADD COLUMN ref_col INT;`,
      );
      await helpers.addForeignKey(
        client,
        "helper_test_table",
        constraintName,
        "ref_col",
        "helper_test_table_ref",
        "ref_id",
        "CASCADE",
      );

      // Verify constraint exists
      const { rows } = await client.query(
        `SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'helper_test_table' AND constraint_name = $1 AND constraint_type = 'FOREIGN KEY';`,
        [constraintName],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].constraint_name).toBe(constraintName);

      // Verify ON DELETE CASCADE (optional, more complex check)
    });

    // --- Tests for addDeferrableForeignKey ---
    test("addDeferrableForeignKey should add a deferrable foreign key constraint", async () => {
      const constraintName = "fk_helper_deferrable";
      // Add column to reference the other table
      await client.query(
        `ALTER TABLE helper_test_table ADD COLUMN ref_col_deferrable INT;`,
      );

      await helpers.addDeferrableForeignKey(
        client,
        "helper_test_table",
        constraintName,
        "ref_col_deferrable",
        "helper_test_table_ref",
        "ref_id",
        "SET NULL",
        true, // initiallyDeferred = true
      );

      // Verify constraint exists
      const { rows: constraintRows } = await client.query(
        `SELECT constraint_name FROM information_schema.table_constraints 
         WHERE table_name = 'helper_test_table' 
         AND constraint_name = $1 
         AND constraint_type = 'FOREIGN KEY';`,
        [constraintName],
      );
      expect(constraintRows.length).toBe(1);
      expect(constraintRows[0].constraint_name).toBe(constraintName);

      // Verify constraint is deferrable and initially deferred
      const { rows: deferRows } = await client.query(
        `SELECT c.conname, c.condeferrable, c.condeferred
         FROM pg_constraint c
         JOIN pg_class t ON c.conrelid = t.oid
         WHERE c.conname = $1
         AND t.relname = 'helper_test_table';`,
        [constraintName],
      );

      expect(deferRows.length).toBe(1);
      expect(deferRows[0].condeferrable).toBe(true);
      expect(deferRows[0].condeferred).toBe(true);

      // Test with initiallyDeferred = false
      const constraintName2 = "fk_helper_deferrable_immediate";
      await client.query(
        `ALTER TABLE helper_test_table ADD COLUMN ref_col_deferrable2 INT;`,
      );

      await helpers.addDeferrableForeignKey(
        client,
        "helper_test_table",
        constraintName2,
        "ref_col_deferrable2",
        "helper_test_table_ref",
        "ref_id",
        "SET NULL",
        false, // initiallyDeferred = false
      );

      const { rows: deferRows2 } = await client.query(
        `SELECT c.conname, c.condeferrable, c.condeferred
         FROM pg_constraint c
         JOIN pg_class t ON c.conrelid = t.oid
         WHERE c.conname = $1
         AND t.relname = 'helper_test_table';`,
        [constraintName2],
      );

      expect(deferRows2.length).toBe(1);
      expect(deferRows2[0].condeferrable).toBe(true);
      expect(deferRows2[0].condeferred).toBe(false);
    });

    test("addDeferrableForeignKey should not fail if constraint already exists", async () => {
      const constraintName = "fk_helper_deferrable_existing";
      await client.query(
        `ALTER TABLE helper_test_table ADD COLUMN ref_col_deferrable_existing INT;`,
      );

      await client.query(`
        ALTER TABLE helper_test_table 
        ADD CONSTRAINT ${constraintName} 
        FOREIGN KEY (ref_col_deferrable_existing) 
        REFERENCES helper_test_table_ref(ref_id)
        DEFERRABLE INITIALLY DEFERRED;
      `);

      expect(
        helpers.addDeferrableForeignKey(
          client,
          "helper_test_table",
          constraintName,
          "ref_col_deferrable_existing",
          "helper_test_table_ref",
          "ref_id",
        ),
      ).resolves.toBeUndefined();
    });

    test("addForeignKey should not fail if constraint already exists", async () => {
      const constraintName = "fk_helper_ref_existing";
      await client.query(
        `ALTER TABLE helper_test_table ADD COLUMN ref_col_existing INT;`,
      );

      await client.query(`
        ALTER TABLE helper_test_table 
        ADD CONSTRAINT ${constraintName} 
        FOREIGN KEY (ref_col_existing) 
        REFERENCES helper_test_table_ref(ref_id);
      `);

      expect(
        helpers.addForeignKey(
          client,
          "helper_test_table",
          constraintName,
          "ref_col_existing",
          "helper_test_table_ref",
          "ref_id",
        ),
      ).resolves.toBeUndefined();
    });

    test("addForeignKey should throw error for non-existent table", async () => {
      expect(
        helpers.addForeignKey(
          client,
          "non_existent_table",
          "fk_fail",
          "col",
          "helper_test_table_ref",
          "ref_id",
        ),
      ).rejects.toThrow();
    });

    test("addForeignKey should throw error for non-existent referenced table", async () => {
      await client.query(
        `ALTER TABLE helper_test_table ADD COLUMN bad_ref_col INT;`,
      );

      expect(
        helpers.addForeignKey(
          client,
          "helper_test_table",
          "fk_fail_ref",
          "bad_ref_col",
          "non_existent_ref_table",
          "id",
        ),
      ).rejects.toThrow();
    });

    // --- Tests for removeConstraint ---
    test("removeConstraint should remove an existing constraint", async () => {
      const constraintName = "fk_to_remove";
      await client.query(
        `ALTER TABLE helper_test_table ADD COLUMN fk_col_remove INT;`,
      );
      await client.query(`
        ALTER TABLE helper_test_table 
        ADD CONSTRAINT ${constraintName} 
        FOREIGN KEY (fk_col_remove) 
        REFERENCES helper_test_table_ref(ref_id);
      `);
      await helpers.removeConstraint(
        client,
        "helper_test_table",
        constraintName,
      );
      const { rows } = await client.query(
        `SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'helper_test_table' AND constraint_name = $1;`,
        [constraintName],
      );
      expect(rows.length).toBe(0);
    });

    test("removeConstraint should not fail if constraint does not exist", async () => {
      expect(
        helpers.removeConstraint(
          client,
          "helper_test_table",
          "non_existent_constraint",
        ),
      ).resolves.toBeUndefined();
    });

    test("removeConstraint should throw error for non-existent table", async () => {
      expect(
        helpers.removeConstraint(
          client,
          "non_existent_table",
          "some_constraint",
        ),
      ).rejects.toThrow();
    });
  }); // End of SchemaHelpers describe block
}); // End of MigrationManager describe block
