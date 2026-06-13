import { hostname } from "os";
import { type Pool, type PoolClient } from "pg";
import { type Logger, consoleLogger, createPrefixedLogger } from "./logger";
import { type SchemaHelpers, createSchemaHelpers } from "./schema-helpers";

/**
 * A simplified migration system that clearly separates schema changes from data migrations
 * and allows for standalone data migration scripts.
 */

// Migration phase types
export type SchemaPhase = "beforeSchema" | "afterSchema";
export type MigrationMode = "job" | "distributed";

// Migration callback types
export type MigrationCompletionCallback = () => void;
export type MigrationDeferCallback = (reason?: string) => void;

// Migration interface with generic payload and return types
export interface Migration<
  TPayload = Record<string, unknown>,
  TReturn = unknown,
> {
  id: string;
  description: string;

  // Schema changes before data migration - runs in a transaction
  beforeSchema?: (client: PoolClient, helpers: SchemaHelpers) => Promise<void>;

  // Data migration - runs separately with explicit completion and defer callbacks
  // The migration should call ctx.complete() when it's done, or ctx.defer() if it needs to be paused
  // Only one of complete() or defer() can be called, not both
  // The logger is task-specific and will prefix all messages with the task ID
  // Mode is required and payload is always passed (empty object if not provided)
  // Data can be passed to ctx.complete(data)
  migration?: (
    pool: Pool,
    ctx: {
      logger: Logger;
      complete(data?: TReturn): void;
      defer(reason?: string, data?: TReturn): void;
      mode: MigrationMode;
      payload: TPayload;
      // Cooperative-cancellation signal. Aborts when the caller requests a
      // graceful shutdown (via the AbortSignal passed to runSchemaChanges or
      // runDataMigrationJobOnly) and — on the orchestrator pass only — when the
      // migration lock is lost mid-run (workers don't hold the lock, so that
      // can't happen there). Long-running data migrations should check
      // `ctx.signal.aborted` (or listen for "abort") and wind down gracefully,
      // typically by calling ctx.defer(). Always present: if no signal was
      // supplied, this is a signal that never aborts.
      signal: AbortSignal;
      // Freeform state previously persisted for this migration (the most recent
      // `data` passed to complete()/defer()), loaded at the start of this
      // attempt — null if nothing was stored yet. Use it to resume from a
      // checkpoint across runs. Only the orchestrator pass (runSchemaChanges)
      // persists it; runDataMigrationJobOnly workers can read it but do not
      // write migration state. Typed `unknown` because what's stored isn't
      // guaranteed to match TReturn (it may predate the current code).
      metadata: unknown;
      // Persist freeform progress/state to the metadata column mid-run, without
      // completing or deferring. Useful for live progress an external observer
      // can read from the status table. Await it.
      //
      // Where it writes depends on who's running the migration:
      //   - Orchestrator pass (runSchemaChanges): writes to the metadata column.
      //   - Job-only worker (runDataMigrationJobOnly): no-op. Workers don't write
      //     migration state; they report progress via the data they return.
      //
      // On the orchestrator pass only: a later complete(data)/defer(reason, data)
      // overwrites what you set here whenever it passes a value — including an
      // explicit empty value like {} (or null), which resets it. Only omitting
      // the argument entirely (complete()/defer() with no data) leaves the value
      // you set here in place; it is never auto-cleared.
      //
      // Resolves to `true` if the value was persisted, `false` otherwise (a
      // job-only worker no-op, or a failed write). It is non-fatal: a failed
      // write is logged and returns `false` rather than throwing, so a progress
      // update can't turn a healthy migration into an error.
      updateMetadata: (value: TReturn) => Promise<boolean>;
    },
  ) => Promise<void>; // Migration function itself still returns Promise<void>, data is passed via complete()

  // Schema changes after data migration - runs in a transaction
  afterSchema?: (client: PoolClient, helpers: SchemaHelpers) => Promise<void>;
}

// Migration status tracking
export interface MigrationStatus {
  id: string;
  description: string;
  beforeSchemaApplied: boolean;
  migrationComplete: boolean;
  afterSchemaApplied: boolean;
  completedAt: number;
  lastUpdated: number;
  // Observability fields:
  // When the migration was first attempted (epoch seconds, 0 if never).
  startedAt: number;
  // How many times this migration has been attempted via runSchemaChanges.
  // Incremented at the start of every attempt, regardless of how it ends -
  // including attempts that defer() or error. (runDataMigrationJobOnly, the
  // distributed-mode data-job path, does NOT increment this.)
  attempts: number;
  // The most recent error or defer reason, or null once it completes cleanly.
  lastError: string | null;
  // Freeform JSON the migration persists via ctx.complete(data)/ctx.defer(reason,
  // data). Unlike lastError it is NOT cleared between attempts, so it can carry
  // checkpoint/progress state forward (e.g. { remaining: 120, jobId: "..." }).
  // null until the migration writes something.
  metadata: unknown;
}

// For runDataMigrationJobOnly and internal phase results
export type DataMigrationJobStatus =
  | "success"
  | "error"
  | "already_complete"
  | "deferred"
  | "not_found"
  | "invalid_state";

export interface DataMigrationJobResult<D = unknown> {
  status: DataMigrationJobStatus;
  reason?: string;
  data?: D;
}

export interface DataMigrationPhaseResult<D = unknown> {
  status: "success" | "deferred" | "error";
  reason?: string;
  data?: D;
}

/**
 * Result of running schema changes
 */
export interface MigrationResult<D_ALL = Record<string, unknown>> {
  // Whether all migrations completed successfully
  success: boolean;

  // Status of the migration run.
  // - "locked": could not acquire the lock — another process already holds it
  //   (benign; nothing was attempted).
  // - "lock_lost": the lock was lost mid-run (its renewal found another process
  //   had taken it over). Unsafe — the run is aborted to avoid concurrency.
  //   Distinct from "locked" so callers can tell "someone else is running" from
  //   "I lost exclusivity while running".
  // - "aborted": the run was stopped early via a caller-supplied AbortSignal
  //   (graceful shutdown). Distinct from "error" (a real failure) and from
  //   "deferred" (a migration paused itself).
  status:
    | "completed"
    | "locked"
    | "lock_lost"
    | "error"
    | "deferred"
    | "aborted";

  // Reason for failure or deferral if applicable (always a formatted string for display)
  reason?: string;

  // IDs of migrations that were successfully completed in this run
  completedMigrations: string[];

  // IDs of migrations that were already applied in previous runs
  previouslyAppliedMigrations: string[];

  // IDs of migrations that are still pending
  pendingMigrations: string[];

  // ID of the last migration that was attempted (whether successful or not)
  lastAttemptedMigration?: string;

  // Raw error object for debugging (only present for unhandled exceptions)
  // Contains the original Error object when an exception was caught during migration execution
  // Use 'reason' for formatted display messages, 'error' for stack traces and detailed debugging
  // Note: Not present for controlled migration phase errors (those only populate 'reason')
  error?: Error;

  // Data returned by successful migrations in this run
  migrationData?: D_ALL;
}

/**
 * Migration logger interface
 */
export type MigrationLogger = Logger;

/**
 * Migration Manager - handles running migrations and tracking their status
 */
export class MigrationManager {
  // Class constant for the lock name to ensure consistency
  private static readonly LOCK_NAME = "database_migrations";

  private pool: Pool;
  private migrations: Migration<any, any>[] = [];
  private lockId: string | null = null;
  private lockRenewalInterval: NodeJS.Timeout | null = null;
  private lockRenewalSeconds: number; // Configurable lock renewal interval in seconds
  private logger: MigrationLogger;
  private initialized = false;
  // Abort controller scoped to a single runSchemaChanges call. Aborted on a
  // caller-supplied shutdown signal or when the lock is lost during renewal.
  private runAbortController: AbortController | null = null;
  // Set when lock renewal detects the lock was lost (taken by another process).
  // Distinguishes an unsafe lock-loss abort from a graceful shutdown abort.
  private lockLost = false;

  /**
   * Helper method to update migration status fields
   * @private
   */
  private async markStatus(
    id: string,
    fields: {
      beforeSchemaApplied?: boolean;
      migrationComplete?: boolean;
      afterSchemaApplied?: boolean;
      completedAt?: number;
      // Pass a string to record the latest failure/defer reason, or null to
      // clear it (e.g. on successful completion).
      lastError?: string | null;
      // Freeform JSON to persist into the metadata column. Stored as-is; not
      // cleared between attempts. Omit to leave the existing value untouched.
      metadata?: unknown;
    },
  ): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [id];
    let paramIndex = 2;

    if (fields.beforeSchemaApplied !== undefined) {
      updates.push(`before_schema_applied = $${paramIndex++}`);
      values.push(fields.beforeSchemaApplied);
    }

    if (fields.migrationComplete !== undefined) {
      updates.push(`migration_complete = $${paramIndex++}`);
      values.push(fields.migrationComplete);
    }

    if (fields.afterSchemaApplied !== undefined) {
      updates.push(`after_schema_applied = $${paramIndex++}`);
      values.push(fields.afterSchemaApplied);
    }

    if (fields.completedAt !== undefined) {
      updates.push(`completed_at = $${paramIndex++}`);
      values.push(fields.completedAt);
    }

    if (fields.lastError !== undefined) {
      updates.push(`last_error = $${paramIndex++}`);
      values.push(fields.lastError);
    }

    if (fields.metadata !== undefined) {
      // Serialize to JSON for the jsonb column.
      updates.push(`metadata = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(fields.metadata));
    }

    // Always update last_updated timestamp
    updates.push(`last_updated = $${paramIndex++}`);
    values.push(Math.floor(Date.now() / 1000));

    if (updates.length === 0) {
      return;
    }

    const query = `
      UPDATE migration_status
      SET ${updates.join(", ")}
      WHERE id = $1
    `;

    await this.pool.query(query, values);
  }

  /**
   * Constructor for MigrationManager
   * @param pool Database connection pool
   * @param logger Logger instance (defaults to console logger)
   * @param opts Optional configuration options
   * @param opts.lockRenewalSeconds Number of seconds between lock renewal attempts (defaults to 60)
   */
  constructor(
    pool: Pool,
    logger: MigrationLogger = consoleLogger,
    opts?: { lockRenewalSeconds?: number },
  ) {
    this.pool = pool;
    this.logger = logger;
    this.lockRenewalSeconds = opts?.lockRenewalSeconds ?? 60; // Default to 60 seconds if not specified
  }

  /**
   * Create a task-specific logger that includes task ID and stage in log messages
   */
  private createTaskLogger(taskId: string, stage?: string): Logger {
    return createPrefixedLogger(this.logger, { task: taskId, stage });
  }

  /**
   * Initialize the migration system
   * @private
   */

  private async ensureInitialized(): Promise<void> {
    // Skip if already initialized
    if (this.initialized) {
      return;
    }

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
          completed_at BIGINT NOT NULL DEFAULT 0,
          last_updated BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::bigint,
          started_at BIGINT NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          metadata JSONB
        )
      `);

      // Backfill the observability columns for tables created by older versions
      // of Strataline. ADD COLUMN IF NOT EXISTS is a no-op when they're present.
      await client.query(`
        ALTER TABLE migration_status
          ADD COLUMN IF NOT EXISTS started_at BIGINT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_error TEXT,
          ADD COLUMN IF NOT EXISTS metadata JSONB
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

    // Mark as initialized
    this.initialized = true;
  }

  /**
   * Register migrations to be run
   * @throws Error if duplicate migration IDs are detected
   */

  register<TPayload = Record<string, unknown>, TReturn = unknown>(
    migrations: Migration<TPayload, TReturn>[],
  ): void {
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
    await this.ensureInitialized();

    // Query the migration status table
    const { rows } = await this.pool.query(`
      SELECT
        id,
        description,
        before_schema_applied AS "beforeSchemaApplied",
        migration_complete AS "migrationComplete",
        after_schema_applied AS "afterSchemaApplied",
        completed_at AS "completedAt",
        last_updated AS "lastUpdated",
        started_at AS "startedAt",
        attempts AS "attempts",
        last_error AS "lastError",
        metadata AS "metadata"
      FROM migration_status
      ORDER BY completed_at
    `);

    // pg returns BIGINT columns as strings to avoid precision loss. Our epoch
    // timestamps fit safely in a JS number, so coerce them here to honour the
    // numeric MigrationStatus type and keep numeric comparisons reliable.
    return rows.map((row) => ({
      ...row,
      completedAt: Number(row.completedAt),
      lastUpdated: Number(row.lastUpdated),
      startedAt: Number(row.startedAt),
      attempts: Number(row.attempts),
    }));
  }

  /**
   * Run schema changes for all pending migrations
   * @param mode Optional migration mode that will be passed to data migrations
   * @returns A structured result object with details about the migration run
   */

  async runSchemaChanges(
    mode: MigrationMode,
    opts?: {
      // Optional caller-owned signal for graceful shutdown. When it aborts, the
      // run stops at the next safe point and any in-flight data migration is
      // notified via ctx.signal. The library never installs OS signal handlers
      // itself — wire this to your own SIGTERM/SIGINT handling if desired.
      signal?: AbortSignal;
    },
  ): Promise<MigrationResult> {
    await this.ensureInitialized();

    const migrationData: Record<string, unknown> = {}; // To store data from successful migrations

    // Try to acquire the lock. A `false` return means another process holds it
    // (expected, skip), whereas a thrown error means an unexpected DB failure
    // that should be reported distinctly rather than masked as "locked".
    let lockAcquired: boolean;

    try {
      lockAcquired = await this.acquireMigrationLock();
    } catch (error: unknown) {
      return {
        success: false,
        status: "error",
        reason: `[acquireMigrationLock] ${error instanceof Error ? error.message : String(error)}`,
        completedMigrations: [],
        previouslyAppliedMigrations: [],
        pendingMigrations: this.migrations.map((m) => m.id),
        error: error instanceof Error ? error : undefined,
        migrationData,
      };
    }

    if (!lockAcquired) {
      this.logger.info({
        message: "Another process is running migrations, skipping",
      });

      return {
        success: false,
        status: "locked",
        reason: "Another process is running migrations",
        completedMigrations: [],
        previouslyAppliedMigrations: [], // We don't check the status when locked
        pendingMigrations: this.migrations.map((m) => m.id),
        migrationData,
      };
    }

    // Set up the run-scoped abort controller now that we hold the lock. A run
    // can be aborted by either:
    //  - the caller's shutdown signal (graceful -> reported as "aborted")
    //  - lock loss detected during renewal (unsafe -> reported as "error")
    this.lockLost = false;
    this.runAbortController = new AbortController();
    const externalSignal = opts?.signal;
    const onExternalAbort = () => this.runAbortController?.abort();

    if (externalSignal) {
      if (externalSignal.aborted) {
        this.runAbortController.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, {
          once: true,
        });
      }
    }

    try {
      const status = await this.getMigrationStatus();
      const appliedIds = status.map((s) => s.id);

      // Get the status of migrations that are in our registered list
      const migrationStatusMap = new Map<string, MigrationStatus>();

      for (const s of status) {
        migrationStatusMap.set(s.id, s);
      }

      // Find migrations that haven't been applied yet or have applied_at = 0
      const pendingMigrations = this.migrations.filter((m) => {
        // If not in status table, it's pending
        if (!migrationStatusMap.has(m.id)) {
          return true;
        }

        const migrationStatus = migrationStatusMap.get(m.id);
        if (!migrationStatus) {
          return true; // If not found in map, it's pending
        }

        // If completedAt is 0, it's not fully completed yet
        if (migrationStatus.completedAt === 0) {
          return true;
        }

        // If any of the phases are not applied, it's pending
        if (
          !migrationStatus.beforeSchemaApplied ||
          !migrationStatus.migrationComplete ||
          !migrationStatus.afterSchemaApplied
        ) {
          return true;
        }

        // Otherwise, it's completed
        return false;
      });

      // If no pending migrations, return early with success
      // Include previously completed migrations in the result
      if (pendingMigrations.length === 0) {
        return {
          success: true,
          status: "completed",
          completedMigrations: [], // No migrations completed in this run
          previouslyAppliedMigrations: appliedIds, // All migrations were already applied
          pendingMigrations: [],
          migrationData, // Empty, as no migrations from *this run*
        };
      }

      const completedMigrations: string[] = [];
      const remainingPendingMigrations: string[] = [
        ...pendingMigrations.map((m) => m.id),
      ];

      let lastAttemptedMigration: string | undefined;

      // Builds the result when a run is interrupted (aborted or lock lost).
      // Lock loss is unsafe, so it's surfaced as "error"; a caller-requested
      // shutdown is a benign "aborted".
      const buildInterruptedResult = (): MigrationResult => {
        const previouslyAppliedMigrations = appliedIds.filter(
          (id) => !completedMigrations.includes(id),
        );

        if (this.lockLost) {
          return {
            success: false,
            status: "lock_lost",
            reason:
              "[lock] Migration lock was lost (it may have been acquired by another process); aborting to avoid concurrent migrations.",
            completedMigrations,
            previouslyAppliedMigrations,
            pendingMigrations: remainingPendingMigrations,
            lastAttemptedMigration,
            migrationData,
          };
        }

        return {
          success: false,
          status: "aborted",
          reason: "Migration run aborted via shutdown signal",
          completedMigrations,
          previouslyAppliedMigrations,
          pendingMigrations: remainingPendingMigrations,
          lastAttemptedMigration,
          migrationData,
        };
      };

      // Process migrations in order, stopping if any migration fails
      for (const migration of pendingMigrations) {
        // Stop before starting the next migration if a shutdown was requested
        // or the lock was lost.
        if (this.runAbortController?.signal.aborted) {
          this.logger.info({
            message: this.lockLost
              ? "Migration lock lost - stopping before next migration"
              : "Shutdown requested - stopping before next migration",
          });

          return buildInterruptedResult();
        }

        lastAttemptedMigration = migration.id;

        try {
          this.logger.info({
            message: `Starting migration ${migration.id} (${migration.description})`,
          });

          // P_Payload and P_Return will be 'any' here as runSchemaChanges doesn't know specific types
          const result = await this.runSingleMigration<unknown, unknown>(
            migration,
            mode,
            this.runAbortController?.signal,
          );

          if (result.status !== "success") {
            // If the run was interrupted while this migration ran, that takes
            // precedence over however the migration itself ended (it may have
            // cooperatively deferred in response to the abort). Report the
            // interruption ("error" if the lock was lost, otherwise "aborted")
            // rather than a benign defer.
            if (this.runAbortController?.signal.aborted) {
              return buildInterruptedResult();
            }

            this.logger.info({
              message: `Migration ${migration.id} did not complete successfully - stopping migration process to prevent out-of-order migrations. Status: ${result.status}, Reason: ${result.reason || "N/A"}`,
            });

            let finalStatus: MigrationResult["status"] = "error";
            let finalReason = `Migration ${migration.id} failed`;

            if (result.status === "deferred") {
              finalStatus = "deferred";
              finalReason = result.reason
                ? `Migration ${migration.id} was deferred: ${result.reason}`
                : `Migration ${migration.id} was deferred`;
            } else if (result.status === "error") {
              finalStatus = "error";
              finalReason = result.reason
                ? `Migration ${migration.id} failed: ${result.reason}`
                : `Migration ${migration.id} failed due to an unknown error`;
            }

            return {
              success: false,
              status: finalStatus,
              reason: finalReason,
              completedMigrations,
              previouslyAppliedMigrations: appliedIds.filter(
                (id) => !completedMigrations.includes(id),
              ),
              pendingMigrations: remainingPendingMigrations,
              lastAttemptedMigration,
              // Note: We don't set 'error' here because result.reason is already a processed string
              // The 'error' field is reserved for raw error objects from unhandled exceptions
              migrationData, // Include data from migrations completed so far
            };
          }

          // Migration completed successfully
          completedMigrations.push(migration.id);

          if (result.data !== undefined) {
            migrationData[migration.id] = result.data;
          }

          remainingPendingMigrations.splice(
            remainingPendingMigrations.indexOf(migration.id),
            1,
          );

          this.logger.info({
            message: `Successfully completed migration ${migration.id}`,
          });

          // The migration finished, but the run may have been interrupted while
          // it was in flight — the migration could have ignored ctx.signal and
          // called complete() after a shutdown signal, or the lock could have
          // been lost yet the migration still finished. Surface that here so we
          // don't fall through and report "completed", which would mask a
          // graceful abort or (critically) an unsafe lock-loss condition. The
          // just-completed migration is already in completedMigrations, so the
          // result's lists stay accurate. lockLost -> "error", else "aborted".
          if (this.runAbortController?.signal.aborted) {
            return buildInterruptedResult();
          }
        } catch (error: unknown) {
          // Log the error and stop processing further migrations
          this.logger.error({
            message: `Migration ${migration.id} failed - stopping migration process to prevent out-of-order migrations`,
            error,
          });

          // For error cases, keep them in the pending list since not completed

          // Check if the error already has a phase prefix; if not, add a generic one
          // This ensures we don't lose information about which phase had the error
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const errorReason = errorMessage.match(
            /\[(beforeSchema|dataMigration|afterSchema)\]/,
          )
            ? errorMessage // Already has a phase prefix, preserve it
            : `[runSchemaChanges] ${errorMessage}`; // Add generic prefix for errors without phase info

          // Record the failure on the migration row for observability. The
          // per-phase failures inside runSingleMigration already do this, but an
          // unexpected throw lands here without last_error being set. Best-effort
          // and guarded so a failing write doesn't mask the original error.
          try {
            await this.markStatus(migration.id, { lastError: errorReason });
          } catch (statusErr: unknown) {
            this.logger.error({
              message: `Failed to persist last_error for ${migration.id}`,
              error: statusErr,
            });
          }

          return {
            success: false,
            status: "error",
            reason: errorReason,
            completedMigrations,
            previouslyAppliedMigrations: appliedIds.filter(
              (id) => !completedMigrations.includes(id),
            ),
            pendingMigrations: remainingPendingMigrations,
            lastAttemptedMigration,
            error: error instanceof Error ? error : undefined,
            migrationData, // Include data from migrations completed so far
          };
        }
      }

      // All migrations completed successfully
      return {
        success: true,
        status: "completed",
        completedMigrations,
        previouslyAppliedMigrations: appliedIds.filter(
          (id) => !completedMigrations.includes(id),
        ),
        pendingMigrations: [],
        migrationData,
      };
    } finally {
      // Detach the external abort listener and clear the run-scoped controller.
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      this.runAbortController = null;

      // Always release the lock when done
      await this.releaseMigrationLock();
    }
  }

  /**
   * Run a single migration's schema changes
   * @param migration The migration to run
   * @param mode Optional migration mode to pass to data migration
   * @returns A promise that resolves to a status object with optional data
   */

  private async runSingleMigration<
    TPayload = Record<string, unknown>,
    TReturn = unknown,
  >(
    migration: Migration<TPayload, TReturn>,
    mode: MigrationMode,
    signal?: AbortSignal,
  ): Promise<DataMigrationPhaseResult<TReturn>> {
    // Create a task-specific logger for this migration
    const taskLogger = this.createTaskLogger(migration.id);
    let migrationOutputData: TReturn | undefined = undefined;

    taskLogger.info({
      message: `Running migration: ${migration.description}`,
    });

    // Create schema helpers with the task-specific logger
    const helpers = createSchemaHelpers(taskLogger);

    // Ensure migration record exists in the status table, and capture the
    // current phase flags so we can skip phases that are already applied.
    const { rows } = await this.pool.query(
      `SELECT migration_complete FROM migration_status WHERE id = $1`,
      [migration.id],
    );

    // Whether the data migration phase has already been marked complete in a
    // prior run. Used to avoid re-running a completed data migration if a
    // later phase (e.g. afterSchema) failed and the migration is being resumed.
    const dataMigrationAlreadyComplete =
      rows.length > 0 && rows[0].migration_complete === true;

    if (rows.length === 0) {
      // Create initial migration record if it doesn't exist
      // Set completed_at to 0 initially - will be updated when migration is fully completed
      const now = Math.floor(Date.now() / 1000);
      await this.pool.query(
        `
        INSERT INTO migration_status (
          id, description, before_schema_applied, migration_complete, after_schema_applied, completed_at, last_updated
        ) VALUES ($1, $2, FALSE, FALSE, FALSE, 0, $3)
        `,
        [migration.id, migration.description, now],
      );

      taskLogger.info({
        message: `Created migration record for ${migration.id}`,
      });
    }

    // Record this attempt: bump the attempt counter, stamp started_at on the
    // first attempt, and clear any error from a prior attempt now that we're
    // trying again.
    const attemptNow = Math.floor(Date.now() / 1000);
    await this.pool.query(
      `
      UPDATE migration_status
      SET attempts = attempts + 1,
          started_at = CASE WHEN started_at = 0 THEN $2 ELSE started_at END,
          last_error = NULL,
          last_updated = $2
      WHERE id = $1
      `,
      [migration.id, attemptNow],
    );

    // Step 1: Run schema changes before data migration if provided
    if (migration.beforeSchema) {
      try {
        await this.runMigrationPhase(
          migration,
          "beforeSchema",
          helpers,
          taskLogger,
        );
      } catch (err: unknown) {
        taskLogger.error({
          message: `[beforeSchema] Error in beforeSchema for migration ${migration.id}:`,
          error: err,
        });

        const reason = `[beforeSchema] ${err instanceof Error ? err.message : String(err)}`;
        await this.markStatus(migration.id, { lastError: reason });
        return {
          status: "error",
          reason,
        };
      }
    } else {
      taskLogger.info({
        message: `No beforeSchema phase provided for migration ${migration.id}`,
      });

      // Mark beforeSchema as applied even though it wasn't provided
      await this.markStatus(migration.id, { beforeSchemaApplied: true });
    }

    // Step 2: Run data migration if provided
    if (migration.migration && dataMigrationAlreadyComplete) {
      // The data migration was already completed in a previous run (e.g. the
      // migration is being resumed after a later phase failed). Skip it so we
      // don't re-execute non-idempotent data work, mirroring how the schema
      // phases skip when already applied.
      taskLogger.info({
        message: `[dataMigration] Skipping data migration for ${migration.id} - already marked complete`,
      });
    } else if (migration.migration) {
      const dataMigrationResult = await this.runDataMigration<
        TPayload,
        TReturn
      >(migration, taskLogger, mode, {} as TPayload, signal); // Pass default payload

      if (dataMigrationResult.status !== "success") {
        taskLogger.info({
          message: `[dataMigration] Data migration for ${migration.id} did not complete successfully (status: ${dataMigrationResult.status}). Reason: ${dataMigrationResult.reason || "N/A"}`,
        });
        await this.markStatus(migration.id, {
          lastError:
            dataMigrationResult.reason ??
            `[dataMigration] ${dataMigrationResult.status}`,
        });
        return dataMigrationResult; // Propagate status, reason, and potentially data (if provided by either complete or defer)
      }

      migrationOutputData = dataMigrationResult.data; // Capture data from successful migration
    } else {
      // If there's no data migration, mark it as complete and log
      taskLogger.info({
        message: `No data migration provided for migration ${migration.id}`,
      });

      await this.markStatus(migration.id, { migrationComplete: true });
    }

    // Step 3: Run schema changes after data migration if needed
    if (migration.afterSchema) {
      try {
        await this.runMigrationPhase(
          migration,
          "afterSchema",
          helpers,
          taskLogger,
        );
      } catch (err: unknown) {
        taskLogger.error({
          message: `[afterSchema] Error in afterSchema for migration ${migration.id}:`,
          error: err,
        });

        const reason = `[afterSchema] ${err instanceof Error ? err.message : String(err)}`;
        await this.markStatus(migration.id, { lastError: reason });
        return {
          status: "error",
          reason,
        };
      }
    } else {
      taskLogger.info({
        message: `No afterSchema phase provided for migration ${migration.id}`,
      });

      // Mark afterSchema as applied even though it wasn't provided
      await this.markStatus(migration.id, { afterSchemaApplied: true });
    }

    // Update completedAt to mark when the migration was fully completed
    const completionTime = Math.floor(Date.now() / 1000);
    await this.markStatus(migration.id, { completedAt: completionTime });

    // Log that the migration is fully completed with the timestamp
    taskLogger.info({
      message: `Marked migration ${migration.id} as fully completed (completed_at = ${completionTime})`,
    });

    // Log successful completion of the entire migration
    taskLogger.info({
      message: `Migration ${migration.id} completed successfully`,
    });

    return { status: "success", data: migrationOutputData };
  }

  /**
   * Run a specific phase of a migration
   */
  private async runMigrationPhase<P = Record<string, unknown>>(
    migration: Migration<P>,
    phase: SchemaPhase,
    helpers: SchemaHelpers,
    logger: Logger,
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
        logger.info({
          message: `[${phase}] Skipping ${phase} phase - already applied`,
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
      await client.query(
        `
        UPDATE migration_status
        SET ${statusField} = TRUE, last_updated = $2
        WHERE id = $1
        `,
        [migration.id, Math.floor(Date.now() / 1000)],
      );

      await client.query("COMMIT");
      logger.info({
        message: `[${phase}] Completed ${phase} phase`,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error({
        message: `[${phase}] Error in ${phase} phase:`,
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
   * Returns a promise that resolves to a status object with optional data
   */

  private async runDataMigration<
    TPayload = Record<string, unknown>,
    TReturn = unknown,
  >(
    migration: Migration<TPayload, TReturn>,
    logger: Logger,
    mode: MigrationMode,
    payload: TPayload = {} as TPayload,
    signal?: AbortSignal,
    // Whether this call owns the migration's status. The orchestrator pass
    // (runSingleMigration) passes true: complete() marks migration_complete and
    // complete()/defer() persist the `data` to the metadata column. Job workers
    // (runDataMigrationJobOnly) pass false: they just run the function and
    // return the result, writing nothing to migration_status.
    ownsState: boolean = true,
  ): Promise<DataMigrationPhaseResult<TReturn>> {
    // Pre-condition: migration.migration is guaranteed to be non-null by the caller.

    // ctx.signal is always present; default to a signal that never aborts when
    // the caller did not supply one. What can trip it depends on the call path:
    //   - Orchestrator (runSchemaChanges): the run-scoped controller, which
    //     aborts on a caller shutdown signal OR on lock loss.
    //   - Worker (runDataMigrationJobOnly): only the caller's signal — this path
    //     never takes the lock, so lock loss can't trigger it here.
    const ctxSignal = signal ?? new AbortController().signal;

    // Load any previously-persisted metadata so the migration can resume from a
    // checkpoint via ctx.metadata. Read-only — safe on every path.
    let loadedMetadata: unknown = null;
    try {
      const { rows } = await this.pool.query(
        `SELECT metadata FROM migration_status WHERE id = $1`,
        [migration.id],
      );
      loadedMetadata = rows.length > 0 ? (rows[0].metadata ?? null) : null;
    } catch (err: unknown) {
      logger.error({
        message: `[dataMigration] Failed to load metadata for ${migration.id}; continuing with null`,
        error: err,
      });
      loadedMetadata = null;
    }

    return new Promise<DataMigrationPhaseResult<TReturn>>((resolve) => {
      let callbackCalled = false;

      const completeCallback = (data?: TReturn) => {
        if (callbackCalled) {
          logger.error({ message: "complete()/defer() called twice" });
          throw new Error("complete() or defer() already called");
        }

        callbackCalled = true;

        // Job-only workers don't own migration state: just report success and
        // hand the data back to the caller without writing anything.
        if (!ownsState) {
          logger.info({
            message: `[dataMigration] Data migration function reported complete (worker call — migration state not persisted).`,
          });

          resolve({ status: "success", data });
          return;
        }

        // Orchestrator pass: mark complete, and persist data as metadata if any.
        const fields: { migrationComplete: boolean; metadata?: unknown } = {
          migrationComplete: true,
        };

        if (data !== undefined) {
          fields.metadata = data;
        }

        this.markStatus(migration.id, fields)
          .then(() => {
            logger.info({
              message: `[dataMigration] Data migration marked as complete via callback.`,
            });

            resolve({ status: "success", data }); // "Truly done"
          })
          .catch((dbError: unknown) => {
            logger.error({
              message: `[dataMigration] Error updating migration_status after callback:`,
              error: dbError,
            });

            resolve({
              status: "error",
              reason:
                "[dataMigration] Data migration complete callback: Failed to update migration status in database after complete() was called: " +
                (dbError instanceof Error ? dbError.message : String(dbError)),
            });
          });
      };

      const deferCallback = (reason?: string, data?: TReturn) => {
        if (callbackCalled) {
          logger.error({ message: "complete()/defer() called twice" });
          throw new Error("complete() or defer() already called");
        }

        callbackCalled = true;

        const logMessage = reason
          ? `[dataMigration] Data migration deferred: ${reason}`
          : `[dataMigration] Data migration deferred`;

        logger.info({
          message: logMessage,
        });

        // Persist data as metadata on the orchestrator pass only (best-effort —
        // a failed metadata write should not turn a valid defer into an error).
        if (ownsState && data !== undefined) {
          this.markStatus(migration.id, { metadata: data })
            .catch((dbError: unknown) => {
              logger.error({
                message: `[dataMigration] Failed to persist metadata on defer for ${migration.id}`,
                error: dbError,
              });
            })
            .finally(() => {
              resolve({ status: "deferred", reason: reason, data });
            });
          return;
        }

        // Resolve to deferred status, include data
        resolve({ status: "deferred", reason: reason, data });
      };

      // Mid-run progress reporting. Writes only on the orchestrator pass; a
      // no-op on job-only workers (which report via their returned data).
      // Returns whether the value was persisted, and is non-fatal: a failed
      // write is logged and returns false rather than throwing, so a progress
      // update can never turn a healthy migration into an error.
      const updateMetadataCallback = async (
        value: TReturn,
      ): Promise<boolean> => {
        if (!ownsState) {
          logger.info({
            message: `[dataMigration] ctx.updateMetadata ignored on worker call (migration state not persisted).`,
          });
          return false;
        }

        try {
          await this.markStatus(migration.id, { metadata: value });
          return true;
        } catch (err: unknown) {
          logger.error({
            message: `[dataMigration] ctx.updateMetadata failed to persist for ${migration.id} (continuing)`,
            error: err,
          });

          return false;
        }
      };

      (async () => {
        try {
          logger.info({
            message: `[dataMigration] Executing data migration function. Waiting for complete() or defer() callback...`,
          });

          // Pass the task-specific logger that already prefixes messages with the task ID
          const migrationFnExecution = migration.migration!(this.pool, {
            logger, // This is the task-specific logger created in runSingleMigration
            complete: completeCallback,
            defer: deferCallback,
            mode,
            payload,
            signal: ctxSignal,
            metadata: loadedMetadata,
            updateMetadata: updateMetadataCallback,
          });

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
            logger.info({
              message: `[dataMigration] Data migration function finished without calling complete() or defer().`,
            });

            resolve({
              status: "error",
              reason:
                "[dataMigration] Migration function finished without calling complete() or defer().",
            });
          }
          // If completeCalled is true, the promise has already been resolved by completeCallback.
        } catch (error) {
          logger.error({
            message: `[dataMigration] Error thrown by data migration function:`,
            error,
          });

          // Resolve with error status and include the dataMigration prefix in the reason
          // This ensures the phase information is preserved when it's propagated up
          // Handle unknown error type by using String() as fallbackfdataMigration
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          resolve({
            status: "error",
            reason: `[dataMigration] ${errorMessage}`,
          });
        }
      })();
    });
  }

  /**
   * Acquire a migration lock to prevent concurrent migrations
   * @private
   */
  private async acquireMigrationLock(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes expiration

      // Generate a unique lock ID for this process.
      // Prefer HOSTNAME, but fall back to os.hostname() (HOSTNAME is often
      // unset on macOS / non-login shells, which otherwise leaves locks
      // attributed to "unknown").
      const host = process.env.HOSTNAME || hostname() || "unknown";
      const processLockId = `${host}-${process.pid}-${Date.now()}`;

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
      } catch (error: unknown) {
        // Only handle duplicate key errors from PostgreSQL (expected when lock already exists)
        const isDuplicateKeyError =
          error instanceof Error && error.message?.includes("duplicate key");

        if (!isDuplicateKeyError) {
          throw error; // Rethrow unexpected errors
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
          this.logger.info({
            message: `Migration lock is held by ${lockInfo.locked_by} and will expire in ${Math.round(expiresIn / 1000)} seconds`,
          });
        }

        return false;
      }

      // We've got the lock
      this.lockId = lockResult.rows[0].locked_by;

      this.logger.info({
        message: `Acquired migration lock (${this.lockId}), expires at ${lockResult.rows[0].lock_expires_at}`,
      });

      // Start the renewal timer
      this.startLockRenewal();

      return true;
    } catch (error) {
      // Unexpected failure (e.g. lost connection, permissions). Don't swallow
      // it as "false", which the caller would report as "another process holds
      // the lock" and could retry forever. Surface it so it becomes an error.
      this.logger.error({
        message: "Error acquiring migration lock:",
        error,
      });
      throw error;
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
    if (!this.lockId) {
      return;
    }

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
        this.logger.info({
          message: `Renewed migration lock until ${expiresAt.toISOString()}`,
        });
      } else {
        if (this.logger.warn) {
          this.logger.warn({
            message:
              "Failed to renew migration lock - it may have been taken by another process",
          });
        } else {
          this.logger.info({
            message:
              "Failed to renew migration lock - it may have been taken by another process",
          });
        }

        // The lock is gone, which means another process may now be running.
        // Flag it and abort the in-flight run so we stop doing work without a
        // valid lock (a safety condition, surfaced to the caller as an error).
        this.lockLost = true;
        this.runAbortController?.abort();

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
   * Run only the data migration phase for a specific migration as a job
   * @param migrationId The ID of the migration to run
   * @param payload Optional payload to pass to the data migration
   * @param opts.signal Optional AbortSignal exposed to the data migration as
   *   ctx.signal, so distributed job workers can be cancelled cooperatively.
   * @returns A DataMigrationJobResult object indicating status and any returned data
   */
  async runDataMigrationJobOnly<
    TPayload = Record<string, unknown>,
    TReturn = unknown,
  >(
    migrationId: string,
    payload?: TPayload,
    opts?: { signal?: AbortSignal },
  ): Promise<DataMigrationJobResult<TReturn>> {
    await this.ensureInitialized();

    // Find the migration by ID
    const migration = this.migrations.find((m) => m.id === migrationId) as
      | Migration<TPayload, TReturn>
      | undefined; // Cast for type safety

    if (!migration) {
      this.logger.error({
        message: `Migration with ID ${migrationId} not found`,
      });

      return {
        status: "not_found",
        reason: `Migration with ID ${migrationId} not found`,
      };
    }

    // Create a task-specific logger for this migration
    const taskLogger = this.createTaskLogger(migration.id);

    // Check if the migration is in the correct state to run data migration only
    const { rows } = await this.pool.query(
      `
      SELECT 
        before_schema_applied, 
        migration_complete, 
        after_schema_applied,
        completed_at
      FROM migration_status 
      WHERE id = $1
      `,
      [migrationId],
    );

    if (rows.length === 0) {
      taskLogger.error({
        message: `Migration ${migrationId} not found in status table. Before schema must be applied first.`,
      });

      return {
        status: "invalid_state",
        reason: `Migration ${migrationId} not found in status table. Before schema must be applied first.`,
      };
    }

    const status = rows[0];
    if (!status.before_schema_applied) {
      taskLogger.error({
        message: `Cannot run data migration for ${migrationId} - before schema has not been applied yet`,
      });

      return {
        status: "invalid_state",
        reason: `Cannot run data migration for ${migrationId} - before schema has not been applied yet.`,
      };
    }

    // If the data phase is already complete, a worker has nothing to do.
    // Check `migration_complete` directly — NOT completed_at. completed_at is
    // only set once the whole migration finishes (after afterSchema), so it can
    // still be 0 when migration_complete is true (e.g. afterSchema failed and the
    // migration is mid-resume). Gating on completed_at here would let a late or
    // retrying worker re-run the data migration even though its phase is done.
    if (status.migration_complete) {
      taskLogger.info({
        message: `Data migration for ${migrationId} has already been completed`,
      });

      // If already complete, no new data is generated by this call.
      return { status: "already_complete" };
    }

    if (status.after_schema_applied) {
      taskLogger.error({
        message: `Invalid state for migration ${migrationId} - after schema is applied but data migration is not complete`,
      });

      return {
        status: "invalid_state",
        reason: `Invalid state for migration ${migrationId} - after schema is applied but data migration is not complete.`,
      };
    }

    // If there's no data migration function, there's nothing for this worker to
    // run. It does NOT mark the migration complete — only the orchestrator pass
    // (runSchemaChanges) owns the migration_complete flag. Just report success.
    if (!migration.migration) {
      taskLogger.info({
        message: `No data migration provided for migration ${migration.id}; nothing to run (migration_complete is owned by runSchemaChanges)`,
      });

      return { status: "success" }; // Successfully did nothing, no data.
    }

    // Run the data migration
    try {
      // Always use 'job' mode for this method
      const mode: MigrationMode = "job";

      taskLogger.info({
        message: `Running data migration for ${migration.id} with mode: ${mode}`,
      });

      const result = await this.runDataMigration<TPayload, TReturn>(
        migration,
        taskLogger,
        mode,
        payload || ({} as TPayload),
        opts?.signal,
        // Worker call: run the function and return the result, but do NOT write
        // migration_complete/metadata — the orchestrator pass owns that.
        false,
      );

      if (result.status === "success") {
        taskLogger.info({
          message: `Data migration for ${migration.id} completed successfully`,
        });

        return { status: "success", data: result.data };
      } else if (result.status === "deferred") {
        taskLogger.info({
          message: `Data migration for ${migration.id} was deferred (reason: ${result.reason || "N/A"})`,
          ...(result.data !== undefined && { deferredData: result.data }),
        });
        // Propagate status, reason, and data for deferred
        return { status: "deferred", reason: result.reason, data: result.data };
      } else {
        // error
        taskLogger.info({
          message: `Data migration for ${migration.id} failed (reason: ${result.reason || "N/A"})`,
          // Error case typically doesn't carry data from the migration function itself,
          // but if runDataMigration somehow attached it, it would be in result.data
        });
        return { status: "error", reason: result.reason, data: result.data };
      }
    } catch (err: unknown) {
      taskLogger.error({
        message: `Error in data migration:`,
        error: err,
      });

      return {
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Release the migration lock
   * @private
   */
  private async releaseMigrationLock(): Promise<void> {
    // Stop the renewal timer
    this.stopLockRenewal();

    // Only try to release if we have a lock ID
    if (!this.lockId) {
      return;
    }

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
        this.logger.info({
          message: "Released and deleted migration lock",
        });
      } else {
        this.logger.info({
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
