import { type Pool, type PoolClient } from "pg";
import {
  type SchemaHelpers,
  type SchemaLogger,
  type LogDataInput,
  consoleLogger,
  createSchemaHelpers,
  createPrefixedLogger,
} from "./schema-helpers";

/**
 * A simplified migration system that clearly separates schema changes from data migrations
 * and allows for standalone data migration scripts.
 */

// Migration phase types
export type SchemaPhase = "beforeSchema" | "afterSchema";

// Migration callback types
export type MigrationCompletionCallback = () => void;
export type MigrationDeferCallback = (reason?: string) => void;

// Migration interface
export interface Migration {
  id: string;
  description: string;

  // Schema changes before data migration - runs in a transaction
  beforeSchema?: (client: PoolClient, helpers?: SchemaHelpers) => Promise<void>;

  // Data migration - runs separately with explicit completion and defer callbacks
  // The migration should call complete() when it's done, or defer() if it needs to be paused
  // Only one of complete() or defer() can be called, not both
  // The logger is task-specific and will prefix all messages with the task ID
  migration?: (
    pool: Pool,
    logger: SchemaLogger,
    complete: MigrationCompletionCallback,
    defer: MigrationDeferCallback,
  ) => Promise<void>;

  // Schema changes after data migration - runs in a transaction
  afterSchema?: (client: PoolClient, helpers?: SchemaHelpers) => Promise<void>;
}

// Migration status tracking
export interface MigrationStatus {
  id: string;
  description: string;
  beforeSchemaApplied: boolean;
  migrationComplete: boolean;
  afterSchemaApplied: boolean;
  appliedAt: number;
  lastUpdated: number;
}

/**
 * Result of running schema changes
 */
export interface MigrationResult {
  // Whether all migrations completed successfully
  success: boolean;

  // Status of the migration run
  status: "completed" | "locked" | "error" | "deferred";

  // Reason for failure or deferral if applicable
  reason?: string;

  // IDs of migrations that were successfully completed
  completedMigrations: string[];

  // IDs of migrations that are still pending
  pendingMigrations: string[];

  // ID of the last migration that was attempted (whether successful or not)
  lastAttemptedMigration?: string;

  // Error details if status is "error"
  error?: any;
}

/**
 * Migration logger interface - uses the same interface as SchemaLogger
 */
export type MigrationLogger = SchemaLogger;

/**
 * Migration Manager - handles running migrations and tracking their status
 */
export class MigrationManager {
  // Class constant for the lock name to ensure consistency
  private static readonly LOCK_NAME = "database_migrations";

  private pool: Pool;
  private migrations: Migration[] = [];
  private lockId: string | null = null;
  private lockRenewalInterval: NodeJS.Timeout | null = null;
  private lockRenewalSeconds = 60; // Renew every minute
  private logger: MigrationLogger;

  constructor(pool: Pool, logger: MigrationLogger = consoleLogger) {
    this.pool = pool;
    this.logger = logger;
  }

  /**
   * Create a task-specific logger that includes task ID and stage in log messages
   */
  private createTaskLogger(taskId: string, stage?: string): SchemaLogger {
    return {
      log: (data: LogDataInput) => {
        this.logger.log({
          ...data,
          task: data.task || taskId,
          stage: data.stage || stage,
        });
      },
      error: (data: LogDataInput) => {
        this.logger.error({
          ...data,
          task: data.task || taskId,
          stage: data.stage || stage,
        });
      },
      warn: this.logger.warn
        ? (data: LogDataInput) => {
            this.logger.warn!({
              ...data,
              task: data.task || taskId,
              stage: data.stage || stage,
            });
          }
        : undefined,
    };
  }

  /**
   * Initialize the migration system
   */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Create migration status table
      await client.query(`
        CREATE TABLE IF NOT EXISTS migration_status (
          id VARCHAR(255) PRIMARY KEY,
          description TEXT NOT NULL,
          before_schema_applied BOOLEAN NOT NULL DEFAULT FALSE,
          migration_complete BOOLEAN NOT NULL DEFAULT FALSE,
          after_schema_applied BOOLEAN NOT NULL DEFAULT FALSE,
          applied_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::bigint,
          last_updated BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::bigint
        )
      `);

      // Create migration lock table
      await client.query(`
        CREATE TABLE IF NOT EXISTS migration_lock (
          lock_name VARCHAR(100) PRIMARY KEY,
          locked_by TEXT,
          locked_at TIMESTAMP WITH TIME ZONE,
          lock_expires_at TIMESTAMP WITH TIME ZONE
        )
      `);
    } finally {
      client.release();
    }
  }

  /**
   * Register migrations to be run
   * @throws Error if duplicate migration IDs are detected
   */

  register(migrations: Migration[]): void {
    // Check for duplicate migration IDs
    const ids = new Set<string>();
    const duplicates: string[] = [];

    for (const migration of migrations) {
      if (ids.has(migration.id)) {
        duplicates.push(migration.id);
      } else {
        ids.add(migration.id);
      }
    }

    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate migration IDs detected: ${duplicates.join(", ")}`,
      );
    }

    this.migrations = migrations;
  }

  /**
   * Get the status of all migrations
   */

  async getMigrationStatus(): Promise<MigrationStatus[]> {
    const { rows } = await this.pool.query(`
      SELECT
        id,
        description,
        before_schema_applied AS "beforeSchemaApplied",
        migration_complete AS "migrationComplete",
        after_schema_applied AS "afterSchemaApplied",
        applied_at AS "appliedAt",
        last_updated AS "lastUpdated"
      FROM migration_status
      ORDER BY applied_at
    `);

    return rows;
  }

  /**
   * Run schema changes for all pending migrations
   * @returns A structured result object with details about the migration run
   */

  async runSchemaChanges(): Promise<MigrationResult> {
    // Try to acquire the lock
    const lockAcquired = await this.acquireMigrationLock();
    if (!lockAcquired) {
      this.logger.log({
        message: "Another process is running migrations, skipping",
      });

      return {
        success: false,
        status: "locked",
        reason: "Another process is running migrations",
        completedMigrations: [],
        pendingMigrations: this.migrations.map((m) => m.id),
      };
    }

    try {
      const status = await this.getMigrationStatus();
      const appliedIds = status.map((s) => s.id);

      // Find migrations that haven't been applied yet
      const pendingMigrations = this.migrations.filter(
        (m) => !appliedIds.includes(m.id),
      );

      // If no pending migrations, return early with success
      // Include previously completed migrations in the result
      if (pendingMigrations.length === 0) {
        return {
          success: true,
          status: "completed",
          completedMigrations: appliedIds,
          pendingMigrations: [],
        };
      }

      const completedMigrations: string[] = [];
      const remainingPendingMigrations: string[] = [
        ...pendingMigrations.map((m) => m.id),
      ];

      let lastAttemptedMigration: string | undefined;

      // Process migrations in order, stopping if any migration fails
      for (const migration of pendingMigrations) {
        lastAttemptedMigration = migration.id;

        try {
          this.logger.log({
            message: `Starting migration ${migration.id} (${migration.description})`,
          });

          const success = await this.runSingleMigration(migration);
          if (!success) {
            this.logger.log({
              message: `Migration ${migration.id} did not complete successfully - stopping migration process to prevent out-of-order migrations`,
            });

            // For deferred migrations, keep them in the pending list since not completed
            return {
              success: false,
              status: "deferred",
              reason: `Migration ${migration.id} was deferred`,
              completedMigrations,
              pendingMigrations: remainingPendingMigrations,
              lastAttemptedMigration,
            };
          }

          // Migration completed successfully
          completedMigrations.push(migration.id);

          remainingPendingMigrations.splice(
            remainingPendingMigrations.indexOf(migration.id),
            1,
          );

          this.logger.log({
            message: `Successfully completed migration ${migration.id}`,
          });
        } catch (error: any) {
          // Log the error and stop processing further migrations
          this.logger.error({
            message: `Migration ${migration.id} failed - stopping migration process to prevent out-of-order migrations`,
            error,
          });

          // For error cases, keep them in the pending list since not completed
          return {
            success: false,
            status: "error",
            reason: error.message || String(error),
            completedMigrations,
            pendingMigrations: remainingPendingMigrations,
            lastAttemptedMigration,
            error,
          };
        }
      }

      // All migrations completed successfully
      return {
        success: true,
        status: "completed",
        completedMigrations,
        pendingMigrations: [],
      };
    } finally {
      // Always release the lock when done
      await this.releaseMigrationLock();
    }
  }

  /**
   * Run a single migration's schema changes
   * @returns A boolean indicating whether the migration was successful
   */
  private async runSingleMigration(migration: Migration): Promise<boolean> {
    // Create a task-specific logger for this migration
    const taskLogger = this.createTaskLogger(migration.id);

    taskLogger.log({
      message: `Running migration: ${migration.description}`,
    });

    // Create schema helpers with the task-specific logger
    const helpers = createSchemaHelpers(taskLogger);

    // Step 1: Run schema changes before data migration if provided
    if (migration.beforeSchema) {
      await this.runMigrationPhase(
        migration,
        "beforeSchema",
        helpers,
        taskLogger,
      );
    } else {
      taskLogger.log({
        message: `No beforeSchema phase provided for migration ${migration.id}`,
      });

      // Mark beforeSchema as applied even though it wasn't provided
      const now = Math.floor(Date.now() / 1000);
      await this.pool.query(
        `
        UPDATE migration_status
        SET before_schema_applied = TRUE, last_updated = $2
        WHERE id = $1
        `,
        [migration.id, now],
      );
    }

    // Step 2: Run data migration if provided
    if (migration.migration) {
      try {
        const isComplete = await this.runDataMigration(migration, taskLogger);
        if (!isComplete) {
          // If data migration is not complete, do not proceed with afterSchema
          taskLogger.log({
            message: `Data migration for ${migration.id} is not complete, stopping migration process`,
          });
          return false;
        }
      } catch (err) {
        taskLogger.error({
          message: `Error in data migration:`,
          error: err,
        });
        // Do not proceed with afterSchema if data migration fails
        taskLogger.log({
          message: `Data migration for ${migration.id} failed, stopping migration process`,
        });
        return false;
      }
    } else {
      // If there's no data migration, mark it as complete and log
      taskLogger.log({
        message: `No data migration provided for migration ${migration.id}`,
      });

      await this.pool.query(
        `
        UPDATE migration_status
        SET migration_complete = TRUE, last_updated = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE id = $1
      `,
        [migration.id],
      );
    }

    // Step 3: Run schema changes after data migration if needed
    if (migration.afterSchema) {
      await this.runMigrationPhase(
        migration,
        "afterSchema",
        helpers,
        taskLogger,
      );
    } else {
      taskLogger.log({
        message: `No afterSchema phase provided for migration ${migration.id}`,
      });

      // Mark afterSchema as applied even though it wasn't provided
      const now = Math.floor(Date.now() / 1000);
      await this.pool.query(
        `
        UPDATE migration_status
        SET after_schema_applied = TRUE, last_updated = $2
        WHERE id = $1
        `,
        [migration.id, now],
      );
    }

    // Log successful completion of the entire migration
    taskLogger.log({
      message: `Migration ${migration.id} completed successfully`,
    });

    return true;
  }

  /**
   * Run a specific phase of a migration
   */
  private async runMigrationPhase(
    migration: Migration,
    phase: SchemaPhase,
    helpers: SchemaHelpers,
    logger: SchemaLogger,
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Check if this phase has already been applied
      const statusField =
        phase === "beforeSchema"
          ? "before_schema_applied"
          : "after_schema_applied";

      const { rows } = await client.query(
        `SELECT ${statusField} FROM migration_status WHERE id = $1`,
        [migration.id],
      );

      // Skip if already applied
      if (rows.length > 0 && rows[0][statusField]) {
        logger.log({
          message: `Skipping ${phase} phase - already applied`,
        });
        await client.query("COMMIT");
        return;
      }

      // Run the appropriate phase function
      if (phase === "beforeSchema" && migration.beforeSchema) {
        await migration.beforeSchema(client, helpers);
      } else if (phase === "afterSchema" && migration.afterSchema) {
        await migration.afterSchema(client, helpers);
      }

      // Update migration status
      const now = Math.floor(Date.now() / 1000);

      if (rows.length === 0) {
        // First phase being applied - create status record
        await client.query(
          `
          INSERT INTO migration_status (
            id, description, ${statusField}, applied_at, last_updated
          ) VALUES ($1, $2, TRUE, $3, $3)
        `,
          [migration.id, migration.description, now],
        );
      } else {
        // Update existing status record
        await client.query(
          `
          UPDATE migration_status
          SET ${statusField} = TRUE, last_updated = $2
          WHERE id = $1
        `,
          [migration.id, now],
        );
      }

      await client.query("COMMIT");
      logger.log({
        message: `Completed ${phase} phase`,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error({
        message: `Error in ${phase} phase:`,
        error,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run the data migration phase for a single migration.
   * Assumes migration.migration is defined.
   * Returns a promise that resolves to true if the complete() callback was called,
   * false if the migration function finished without calling complete() or if defer() was called,
   * and rejects if the migration function throws an error.
   */

  private async runDataMigration(
    migration: Migration,
    logger: SchemaLogger,
  ): Promise<boolean> {
    // Pre-condition: migration.migration is guaranteed to be non-null by the caller.

    return new Promise<boolean>((resolve, reject) => {
      let callbackCalled = false;

      const completeCallback = () => {
        if (callbackCalled) return; // Prevent multiple calls
        callbackCalled = true;

        this.pool
          .query(
            `
          UPDATE migration_status
          SET migration_complete = TRUE, last_updated = EXTRACT(EPOCH FROM NOW())::bigint
          WHERE id = $1
          `,
            [migration.id],
          )
          .then(() => {
            logger.log({
              message: `Data migration marked as complete via callback.`,
            });
            resolve(true); // "Truly done"
          })
          .catch((dbError: any) => {
            logger.error({
              message: `Error updating migration_status after callback:`,
              error: dbError,
            });
            // Even if DB update fails, the migration logic itself called complete.
            // Depending on desired strictness, could reject or still resolve true.
            // For now, if complete() is called, we trust the migration logic's intent.
            resolve(true);
          });
      };

      const deferCallback = (reason?: string) => {
        if (callbackCalled) return; // Prevent multiple calls
        callbackCalled = true;

        const logMessage = reason
          ? `Data migration deferred: ${reason}`
          : `Data migration deferred`;

        logger.log({
          message: logMessage,
        });

        // Resolve to false to indicate migration is not complete
        resolve(false);
      };

      (async () => {
        try {
          logger.log({
            message: `Executing data migration function. Waiting for complete() or defer() callback...`,
          });

          // Pass the task-specific logger that already prefixes messages with the task ID
          const migrationFnExecution = migration.migration!(
            this.pool,
            logger, // This is the task-specific logger created in runSingleMigration
            completeCallback,
            deferCallback,
          );

          // If the migration function returns a promise, await its settlement.
          // This handles cases where the migration function does async work
          // and then might or might not call completeCallback.
          if (
            migrationFnExecution &&
            typeof migrationFnExecution.then === "function"
          ) {
            await migrationFnExecution;
          }

          // After the migration function itself has finished (either sync or async execution path),
          // if neither callback was called by then, it means for this run, it's not "truly done".
          if (!callbackCalled) {
            logger.log({
              message: `Data migration function finished without calling complete() or defer().`,
            });

            resolve(false);
          }
          // If completeCalled is true, the promise has already been resolved by completeCallback.
        } catch (error) {
          logger.error({
            message: `Error thrown by data migration function:`,
            error,
          });
          // If an error is thrown from the migration function, it's not "truly done".
          // Reject the promise; this will be caught by runSingleMigration.
          reject(error);
        }
      })();
    });
  }

  /**
   * Acquire a migration lock to prevent concurrent migrations
   */
  async acquireMigrationLock(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes expiration

      // Generate a unique lock ID for this process
      const processLockId = `${process.env.HOSTNAME || "unknown"}-${process.pid}-${Date.now()}`;

      // First try a simple insert - this is the most common case when no lock exists
      let lockResult;
      try {
        lockResult = await client.query(
          `
          INSERT INTO migration_lock (lock_name, locked_by, locked_at, lock_expires_at)
          VALUES ($1, $2, $3, $4)
          RETURNING *
        `,
          [MigrationManager.LOCK_NAME, processLockId, now, expiresAt],
        );

        // If we get here, we got the lock with a clean insert
      } catch (error: any) {
        // If error is not a duplicate key error, rethrow
        if (!error.message?.includes("duplicate key")) {
          throw error;
        }

        // We have a lock record already - check if it's expired and we can take it over
        lockResult = await client.query(
          `
          UPDATE migration_lock
          SET locked_by = $2,
              locked_at = $3,
              lock_expires_at = $4
          WHERE lock_name = $1
            AND lock_expires_at < $3
          RETURNING *
        `,
          [MigrationManager.LOCK_NAME, processLockId, now, expiresAt],
        );
      }

      // Check if we got the lock
      if (lockResult.rowCount === 0) {
        // Failed to get the lock, it's held by someone else
        // Get the current lock info to log it
        const { rows } = await client.query(
          `SELECT locked_by, locked_at, lock_expires_at FROM migration_lock WHERE lock_name = $1`,
          [MigrationManager.LOCK_NAME],
        );

        if (rows.length > 0) {
          const lockInfo = rows[0];
          const expiresIn =
            new Date(lockInfo.lock_expires_at).getTime() - now.getTime();
          this.logger.log({
            message: `Migration lock is held by ${lockInfo.locked_by} and will expire in ${Math.round(expiresIn / 1000)} seconds`,
          });
        }

        return false;
      }

      // We've got the lock
      this.lockId = lockResult.rows[0].locked_by;

      this.logger.log({
        message: `Acquired migration lock (${this.lockId}), expires at ${lockResult.rows[0].lock_expires_at}`,
      });

      // Start the renewal timer
      this.startLockRenewal();

      return true;
    } catch (error) {
      this.logger.error({
        message: "Error acquiring migration lock:",
        error,
      });
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Start automatic lock renewal
   */
  private startLockRenewal(): void {
    // Clear any existing interval
    if (this.lockRenewalInterval) {
      clearInterval(this.lockRenewalInterval);
    }

    // Set up periodic renewal
    this.lockRenewalInterval = setInterval(async () => {
      try {
        await this.renewLock();
      } catch (error) {
        this.logger.error({
          message: "Error renewing migration lock:",
          error,
        });
      }
    }, this.lockRenewalSeconds * 1000);

    // Ensure the interval doesn't keep the process alive
    if (this.lockRenewalInterval.unref) {
      this.lockRenewalInterval.unref();
    }
  }

  /**
   * Renew an existing migration lock
   */
  private async renewLock(): Promise<void> {
    if (!this.lockId) return;

    const client = await this.pool.connect();
    try {
      // Using the class constant for consistency

      // Set new expiration time (5 minutes from now)
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);

      // Update the lock expiration
      const result = await client.query(
        `
        UPDATE migration_lock
        SET lock_expires_at = $1
        WHERE lock_name = $2 AND locked_by = $3
        RETURNING *
      `,
        [expiresAt, MigrationManager.LOCK_NAME, this.lockId],
      );

      if (result.rowCount && result.rowCount > 0) {
        this.logger.log({
          message: `Renewed migration lock until ${expiresAt.toISOString()}`,
        });
      } else {
        if (this.logger.warn) {
          this.logger.warn({
            message:
              "Failed to renew migration lock - it may have been taken by another process",
          });
        } else {
          this.logger.log({
            message:
              "Failed to renew migration lock - it may have been taken by another process",
          });
        }
        // Stop trying to renew
        this.stopLockRenewal();
      }
    } catch (error) {
      this.logger.error({
        message: "Error renewing lock:",
        error,
      });
    } finally {
      client.release();
    }
  }

  /**
   * Stop the lock renewal timer
   */
  private stopLockRenewal(): void {
    if (this.lockRenewalInterval) {
      clearInterval(this.lockRenewalInterval);
      this.lockRenewalInterval = null;
    }
  }

  /**
   * Release the migration lock
   */
  async releaseMigrationLock(): Promise<void> {
    // Stop the renewal timer
    this.stopLockRenewal();

    // Only try to release if we have a lock ID
    if (!this.lockId) return;

    const client = await this.pool.connect();
    try {
      // Delete the lock record if it's ours
      const result = await client.query(
        `
        DELETE FROM migration_lock
        WHERE lock_name = $1 AND locked_by = $2
        RETURNING *
      `,
        [MigrationManager.LOCK_NAME, this.lockId],
      );

      if (result.rowCount && result.rowCount > 0) {
        this.logger.log({
          message: "Released and deleted migration lock",
        });
      } else {
        this.logger.log({
          message:
            "Could not release migration lock - it may have been acquired by another process",
        });
      }

      this.lockId = null;
    } catch (error) {
      this.logger.error({
        message: "Error releasing migration lock:",
        error,
      });
    } finally {
      client.release();
    }
  }
}
