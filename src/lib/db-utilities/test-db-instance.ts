import { Pool } from "pg";
import { MigrationManager, Migration } from "../migration-system";
import { makeSafeLogger } from "../callback-safety";
import {
  BaseLogger,
  ConsoleLogger,
  createPrefixedLogger,
  type LogDataInput,
  type LogLevel,
  type LogSource,
  type Logger,
} from "../logger";
import EmbeddedPostgres from "embedded-postgres";
import * as tmp from "tmp";
import { findFreePort } from "./free-port";
import * as fs from "fs";

// Default configuration for test database
const DEFAULT_DB_USER = "test_user";
const DEFAULT_DB_PASSWORD = "test_password";
const DEFAULT_DB_NAME = "test_database";

/**
 * Logger function type for TestDatabaseInstance
 */
/**
 * The vocabulary this class logs in, and the two axes each word maps to.
 *
 * Internal shorthand, the same way LocalDevDBServer keeps one. The `migrate-`
 * words were a source and a level crossed into a string; here they come apart
 * into `source: "migration"` and the level they always meant.
 */
const TEST_DB_LOG_TAGS = {
  info: ["info", undefined],
  warn: ["warn", undefined],
  error: ["error", undefined],
  pg: ["info", "pg"],
  "migrate-info": ["info", "migration"],
  "migrate-warn": ["warn", "migration"],
  "migrate-error": ["error", "migration"],
} as const satisfies Record<string, readonly [LogLevel, LogSource | undefined]>;

type TestDBLogTag = keyof typeof TEST_DB_LOG_TAGS;

/** Somewhere for lines to go when no logger was supplied. */
const noOpLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Console-based logger implementation for TestDatabase
 *
 * A sink. Its two verbosity flags are source filters: PostgreSQL's own output
 * is `source: "pg"` and the migration system's is `source: "migration"`.
 *
 * @param pgVerbose Whether to log verbose PostgreSQL messages
 * @param migrateVerbose Whether to log verbose migration messages
 */
export const createTestDBConsoleLogger = (
  pgVerbose: boolean = false,
  migrateVerbose: boolean = true,
): Logger => new TestDBConsoleLogger(pgVerbose, migrateVerbose);

class TestDBConsoleLogger extends BaseLogger {
  private readonly console = new ConsoleLogger();
  private readonly pgVerbose: boolean;
  private readonly migrateVerbose: boolean;

  constructor(pgVerbose: boolean, migrateVerbose: boolean) {
    super();
    this.pgVerbose = pgVerbose;
    this.migrateVerbose = migrateVerbose;
  }

  info(data: LogDataInput): void {
    this.write("info", data);
  }

  warn(data: LogDataInput): void {
    this.write("warn", data);
  }

  error(data: LogDataInput): void {
    this.write("error", data);
  }

  private write(level: LogLevel, data: LogDataInput): void {
    if (!this.pgVerbose && data.source === "pg") {
      return;
    }

    // Only the migration system's routine chatter, as in the CLI: a warning or
    // an error from a migration is not something a verbosity flag should hide.
    if (
      !this.migrateVerbose &&
      level === "info" &&
      data.source === "migration"
    ) {
      return;
    }

    this.console[level](data);
  }
}

/**
 * Configuration options for {@link TestDatabaseInstance}. All fields are
 * optional — an omitted `port` is auto-assigned and the user/password/database
 * fall back to the `test_*` defaults.
 */
export interface TestDatabaseOptions {
  port?: number;
  logger?: Logger;
  user?: string;
  password?: string;
  databaseName?: string;
  migrations?: Migration[];
}

/**
 * A class for managing an embedded PostgreSQL instance for testing
 *
 * This class allows you to start an embedded PostgreSQL server, apply migrations, and reset the database
 * between test runs. It also provides a connection pool and credentials for direct connection.
 *
 * @example
 * import {TestDatabaseInstance} from 'test-database';
 *
 * const testDB = new TestDatabaseInstance();
 * await testDB.start();
 * const pool = testDB.getPool();
 * const credentials = testDB.getCredentials();
 *
 * // Run your tests here
 *
 * await testDB.stop();
 */
export class TestDatabaseInstance {
  private db?: EmbeddedPostgres;
  private pool?: Pool;
  private migrationsApplied: boolean = false;
  private tempDir?: string;
  private port: number;
  private logger?: Logger;
  private user: string;
  private password: string;
  private databaseName: string;
  private isRunning: boolean = false;
  private migrations?: Migration[];

  /**
   * Create a new TestDatabase instance
   * @param options Configuration options
   */
  constructor(options: TestDatabaseOptions = {}) {
    this.port = options.port || 0; // 0 means we'll find a port dynamically
    // Wrapped on the way in, so no call site below has to guard it and a
    // logger that throws loses its line rather than the process. The other two
    // entry points do the same; this one was simply missed.
    this.logger = options.logger && makeSafeLogger(options.logger);
    this.user = options.user || DEFAULT_DB_USER;
    this.password = options.password || DEFAULT_DB_PASSWORD;
    this.databaseName = options.databaseName || DEFAULT_DB_NAME;
    this.migrations = options.migrations;
  }

  /**
   * Internal logging helper
   * @param type Message type
   * @param message Message content
   */
  private log(type: TestDBLogTag, message: string): void {
    if (!this.logger) {
      return;
    }

    const [level, source] = TEST_DB_LOG_TAGS[type];

    this.logger[level](source ? { source, message } : { message });
  }

  /**
   * Check if the database is running
   * @returns true if the database is running and ready for queries
   */
  public isReady(): boolean {
    return this.isRunning && !!this.pool;
  }

  /**
   * Start the embedded PostgreSQL server and apply migration
   */
  public async start(): Promise<void> {
    if (this.pool) {
      return;
    }

    // Use a separate try-catch for initial setup errors vs cleanup errors
    try {
      // If no port was specified or port is 0, find an available port
      if (!this.port || this.port === 0) {
        this.port = await findFreePort();
      }

      this.log(
        "info",
        `Starting embedded PostgreSQL for tests on port ${this.port}`,
      );

      // Create a temporary directory for the database using promise-based approach
      this.tempDir = await new Promise<string>((resolve, reject) => {
        tmp.dir(
          {
            unsafeCleanup: true, // Remove directory even if it's not empty
            prefix: "pg-test-",
          },
          (err, path) => {
            if (err) {
              reject(err);
            } else {
              resolve(path);
            }
          },
        );
      });

      this.log("info", `Created temporary directory: ${this.tempDir}`);

      // Create and start an embedded PostgreSQL server
      this.db = new EmbeddedPostgres({
        port: this.port,
        user: this.user,
        password: this.password,
        persistent: false, // Don't persist data between test runs
        databaseDir: this.tempDir,
        // Pin initdb's locale instead of letting it inherit the host/CI
        // shell's, for two reasons: (1) a Linux-style locale like
        // LC_ALL=C.UTF-8 makes initdb fail on macOS ("invalid locale settings")
        // because macOS libc has no C.UTF-8; (2) an inherited locale makes the
        // DB's collation vary per machine. "C" + UTF8 is valid on every OS and
        // gives the same byte-order collation everywhere — ideal for a
        // throwaway DB (just not locale-aware sorting, so don't "fix" this to
        // en_US).
        initdbFlags: ["--locale=C", "--encoding=UTF8"],
        onLog: (message: string) => {
          this.log("pg", message);
        },
      });

      this.log("info", "Initializing embedded PostgreSQL...");

      try {
        // Initialize and start the PostgreSQL server
        await this.db.initialise();
        this.log("info", "PostgreSQL initialized successfully");

        await this.db.start();
        this.log("info", "PostgreSQL server started successfully");

        // Create the test database
        await this.db.createDatabase(this.databaseName);
        this.log("info", `Created test database: ${this.databaseName}`);
      } catch (error) {
        this.log(
          "error",
          `Error during PostgreSQL startup: ${(error as Error).message}`,
        );
        throw error; // Will be caught by outer try-catch
      }

      // Create a connection pool to the test database
      this.pool = new Pool({
        host: "localhost",
        port: this.port,
        database: this.databaseName,
        user: this.user,
        password: this.password,
        // Add shorter timeouts for tests
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
      });

      // Test the connection
      try {
        const result = await this.pool.query("SELECT 1 as test_value");
        this.log(
          "info",
          `Database connection test successful: ${JSON.stringify(result.rows[0])}`,
        );
        this.log(
          "info",
          `Embedded PostgreSQL started successfully on port ${this.port}`,
        );
      } catch (dbError) {
        this.log(
          "error",
          `Database connection test failed: ${(dbError as Error).message}`,
        );

        throw dbError; // Will be caught by outer try-catch
      }

      // Apply migrations automatically
      await this.applyMigrations();

      // Mark as running only after everything succeeds
      this.isRunning = true;
    } catch (error) {
      this.log(
        "error",
        `Failed to start embedded PostgreSQL: ${(error as Error).message}`,
      );
      try {
        // Use a separate try-catch for cleanup to ensure it never throws
        await this.cleanup();
      } catch (cleanupError) {
        this.log(
          "warn",
          `Non-fatal error during cleanup after failed start: ${(cleanupError as Error).message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Get the connection pool
   * @returns The database connection pool or null if not ready
   */
  public getPool(): Pool | null {
    if (!this.pool || !this.isRunning) {
      return null;
    }

    return this.pool;
  }

  /**
   * Get connection credentials for direct connection
   * @returns Connection credentials object or null if not ready
   */
  public getCredentials() {
    if (!this.port || !this.isRunning) {
      return null;
    }

    return {
      host: "localhost",
      port: this.port,
      database: this.databaseName,
      user: this.user,
      password: this.password,
    };
  }

  /**
   * Apply migrations to the test database
   * @returns A promise that resolves when migrations are applied
   */
  private async applyMigrations(): Promise<void> {
    if (this.migrationsApplied) {
      return;
    }

    // Skip migrations if none are provided
    if (!this.migrations || this.migrations.length === 0) {
      this.log(
        "migrate-info",
        "No migrations provided, skipping migration application",
      );

      this.migrationsApplied = true;
      return;
    }

    if (!this.pool) {
      throw new Error("Database not started. Call start() first.");
    }

    // Create a strataline logger adapter using our logger (if any)
    // Marked as the migration system's lines rather than the test database's
    // own, which is what the `migrate-` half of the tag set is for.
    const stratalineLogger = createPrefixedLogger(this.logger ?? noOpLogger, {
      source: "migration",
    });
    const migrationManager = new MigrationManager(this.pool, stratalineLogger);

    this.log("migrate-info", "Applying migrations to test database...");

    try {
      // Register migrations
      migrationManager.register(this.migrations);

      // Run migrations in job mode
      const result = await migrationManager.runSchemaChanges("job");

      if (result.success) {
        this.log("migrate-info", "Migrations applied successfully");
        this.migrationsApplied = true;
      } else {
        this.log("migrate-error", `Migration failed: ${result.reason}`);
        // migrationsApplied is already false by default
        throw new Error(`Failed to apply migrations: ${result.reason}`);
      }
    } catch (error) {
      this.log(
        "migrate-error",
        `Error applying migrations: ${(error as Error).message}`,
      );

      // migrationsApplied is already false by default
      throw error;
    }
  }

  /**
   * Reset the database by dropping all tables and reapplying migrations
   * @returns A promise that resolves when the database is reset
   */
  public async reset(): Promise<void> {
    if (!this.pool) {
      throw new Error("Database not started. Call start() first.");
    }

    try {
      // Drop all tables in the public schema
      await this.pool.query(`
        DO $$ DECLARE
          r RECORD;
        BEGIN
          FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
            EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
          END LOOP;
        END $$;
      `);

      this.migrationsApplied = false;
      await this.applyMigrations();
    } catch (error) {
      this.log(
        "error",
        `Error resetting database: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Clean up resources (internal method)
   */
  private async cleanup(): Promise<void> {
    // Set running state to false immediately
    this.isRunning = false;

    if (this.pool) {
      try {
        await this.pool.end();
      } catch (error) {
        this.log(
          "error",
          `Error closing database pool: ${(error as Error).message}`,
        );
      }

      this.pool = undefined;
    }

    if (this.db) {
      try {
        await this.db.stop();
      } catch (error) {
        this.log(
          "error",
          `Error stopping embedded PostgreSQL: ${(error as Error).message}`,
        );
      }
      this.db = undefined;
      this.migrationsApplied = false;
    }

    // Clean up the temporary directory with a delay
    if (this.tempDir) {
      try {
        // Add a small delay to allow PostgreSQL to fully release file handles
        await new Promise((resolve) => setTimeout(resolve, 100));

        try {
          // First check if directory exists before trying to remove it
          if (fs.existsSync(this.tempDir)) {
            // Use fs.rm with recursive option for better cleanup
            await fs.promises.rm(this.tempDir, {
              recursive: true,
              force: true,
            });
          }
        } catch (error) {
          // Handle specific ENOENT error more gracefully
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            this.log(
              "warn",
              `Non-fatal error during temp directory cleanup: ${(error as Error).message}`,
            );
          }
        }
      } catch (error) {
        this.log(
          "warn",
          `Non-fatal error during temp directory cleanup: ${(error as Error).message}`,
        );
      }
      this.tempDir = undefined;
    }
  }

  /**
   * Stop the embedded database server and clean up resources
   * @returns A promise that resolves when the database is stopped
   */
  public async stop(): Promise<void> {
    this.log("info", "Stopping test database...");
    try {
      await this.cleanup();
      this.log("info", "Test database stopped");
    } catch (error) {
      this.log(
        "error",
        `Error during database stop: ${(error as Error).message}`,
      );
      // Don't rethrow to keep stop() fail-safe
    }
  }
}
