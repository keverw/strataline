import { Pool } from "pg";
import { MigrationManager, Migration } from "../migration-system";
import {
  Logger as StratalineLogger,
  BaseLogger,
  LogDataInput,
} from "../logger";
import EmbeddedPostgres from "embedded-postgres";
import * as tmp from "tmp";
import getPort from "get-port";
import * as fs from "fs";

// Default configuration for test database
const DEFAULT_DB_USER = "test_user";
const DEFAULT_DB_PASSWORD = "test_password";
const DEFAULT_DB_NAME = "test_database";

/**
 * Logger function type
 */
export type LoggerFunction = (
  type: "info" | "error" | "warn" | "pg" | "migrate",
  message: string,
) => void;

/**
 * Console-based logger implementation for TestDatabase
 * @param pgVerbose Whether to log verbose PostgreSQL messages
 * @param migrateVerbose Whether to log verbose migration messages
 */
export const createTestDBConsoleLogger = (
  pgVerbose: boolean = false,
  migrateVerbose: boolean = true,
): LoggerFunction => {
  return (type, message) => {
    switch (type) {
      case "info":
        console.log(message);
        break;
      case "error":
        console.error(message);
        break;
      case "warn":
        console.warn(message);
        break;
      case "pg":
        if (pgVerbose) {
          console.log(`[PG] ${message}`);
        }
        break;
      case "migrate":
        if (migrateVerbose) {
          console.log(`[MIGRATE] ${message}`);
        }
        break;
    }
  };
};

/**
 * Adapter that converts our LoggerFunction to a Strataline Logger
 * This is used internally by TestDatabaseInstance
 * @internal
 */
class TestDBStratalineLogger extends BaseLogger implements StratalineLogger {
  private testDbLogger?: LoggerFunction;

  constructor(logger?: LoggerFunction) {
    super();
    this.testDbLogger = logger;
  }

  log(data: LogDataInput): void {
    if (!this.testDbLogger) return;

    const taskPrefix = data.task ? `[${data.task}]` : "";
    const stagePrefix = data.stage ? `[${data.stage}]` : "";
    const prefix = `${taskPrefix} ${stagePrefix}`.trim();
    const message = prefix ? `${prefix} ${data.message}` : data.message;
    this.testDbLogger("migrate", message);
  }

  error(data: LogDataInput): void {
    if (!this.testDbLogger) return;

    const taskPrefix = data.task ? `[${data.task}]` : "";
    const stagePrefix = data.stage ? `[${data.stage}]` : "";
    const prefix = `${taskPrefix} ${stagePrefix}`.trim();
    const errorMsg = data.error
      ? `${data.message}: ${data.error.message || String(data.error)}`
      : data.message;
    const message = prefix ? `${prefix} ${errorMsg}` : errorMsg;
    this.testDbLogger("error", message);
  }

  warn(data: LogDataInput): void {
    if (!this.testDbLogger) return;

    const taskPrefix = data.task ? `[${data.task}]` : "";
    const stagePrefix = data.stage ? `[${data.stage}]` : "";
    const prefix = `${taskPrefix} ${stagePrefix}`.trim();
    const message = prefix ? `${prefix} ${data.message}` : data.message;
    this.testDbLogger("warn", message);
  }
}

/**
 * TestDatabase options interface
 */
interface TestDatabaseOptions {
  port?: number;
  logger?: LoggerFunction;
  user?: string;
  password?: string;
  databaseName?: string;
  migrations?: Migration[];
}

/**
 * TestDatabase class for managing an embedded PostgreSQL instance for testing
 */
export class TestDatabaseInstance {
  private db?: EmbeddedPostgres;
  private pool?: Pool;
  private migrationsApplied: boolean = false;
  private tempDir?: string;
  private port: number;
  private logger?: LoggerFunction;
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
    this.logger = options.logger;
    this.user = options.user || DEFAULT_DB_USER;
    this.password = options.password || DEFAULT_DB_PASSWORD;
    this.databaseName = options.databaseName || DEFAULT_DB_NAME;
    this.migrations = options.migrations;
  }

  /**
   * Log a message if a logger is configured
   * @param type Message type
   * @param message Message content
   */
  private log(
    type: "info" | "error" | "warn" | "pg" | "migrate",
    message: string,
  ): void {
    if (this.logger) {
      this.logger(type, message);
    }
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
        this.port = await getPort();
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
            if (err) reject(err);
            else resolve(path);
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
        onLog: (message) => {
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
        "info",
        "No migrations provided, skipping migration application",
      );
      this.migrationsApplied = true;
      return;
    }

    if (!this.pool) {
      throw new Error("Database not started. Call start() first.");
    }

    // Create a strataline logger adapter using our logger (if any)
    const stratalineLogger = new TestDBStratalineLogger(this.logger);
    const migrationManager = new MigrationManager(this.pool, stratalineLogger);

    this.log("info", "Applying migrations to test database...");

    try {
      // Register migrations
      migrationManager.register(this.migrations);

      // Run migrations in job mode
      const result = await migrationManager.runSchemaChanges("job");

      if (result.success) {
        this.log("info", "Migrations applied successfully");
        this.migrationsApplied = true;
      } else {
        this.log("error", `Migration failed: ${result.reason}`);
        throw new Error(`Failed to apply migrations: ${result.reason}`);
      }
    } catch (error) {
      this.log(
        "error",
        `Error applying migrations: ${(error as Error).message}`,
      );
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
