import { hostname } from "os";
import { type Pool, type PoolClient } from "pg";
import { type Logger, consoleLogger, createPrefixedLogger } from "./logger";
import { type SchemaHelpers, createSchemaHelpers } from "./schema-helpers";

/**
 * A simplified migration system that clearly separates schema changes from data migrations
 * and allows for standalone data migration scripts.
 */

// Migration phase types
// SchemaPhase is internal-only: it labels the two transactional schema phases
// for runMigrationPhase. It is intentionally NOT exported — it isn't the type of
// any public field (the logger's `stage`, for instance, is a free-form string and
// the data phase logs "dataMigration", which isn't a SchemaPhase member).
type SchemaPhase = "beforeSchema" | "afterSchema";
export type MigrationMode = "job" | "distributed";

// Migration callback types. Generic over the migration's return type so the
// `data` argument is typed; `TReturn` defaults to `unknown`. These mirror the
// `complete`/`defer` callbacks on the data-migration `ctx` (and the interface
// below references them, so the two never drift apart).
export type MigrationCompletionCallback<TReturn = unknown> = (
  data?: TReturn,
) => void;
export type MigrationDeferCallback<TReturn = unknown> = (
  reason?: string,
  data?: TReturn,
) => void;

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
  //
  // Unlike the schema phases (each wrapped in one library-managed transaction),
  // the data migration receives the raw `Pool` and owns its own transaction
  // boundaries. This is deliberate: a data migration can touch a huge number of
  // rows, and forcing it into a single transaction would hold locks for the
  // whole run, bloat WAL, and throw away all progress on any failure. Instead
  // you process in batches / per-entity units (e.g. a user plus their related
  // rows across several tables), committing as you go so progress is durable and
  // the migration can resume from a checkpoint (see ctx.metadata) after an
  // interruption. The flip side: Strataline can't fence these writes by the lock
  // (it never sees them) and a batch may re-run on resume, so the data migration
  // MUST be idempotent. The lock gives coarse exclusivity; your own transactions
  // give per-unit atomicity; idempotency covers the re-run.
  migration?: (
    pool: Pool,
    ctx: {
      logger: Logger;
      complete: MigrationCompletionCallback<TReturn>;
      defer: MigrationDeferCallback<TReturn>;
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
  // Incremented once the attempt actually begins work, regardless of how it ends
  // - including attempts that defer() or error. A run that is already aborted
  // before this migration's schema phase starts does NOT count (it does no work
  // and leaves the prior last_error intact). (runDataMigrationJobOnly, the
  // distributed-mode data-job path, also does NOT increment this.)
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

// Internal result of the data-migration phase. Only ever returned by the
// private runDataMigration; not part of the public surface (the public
// equivalent for workers is DataMigrationJobResult).
interface DataMigrationPhaseResult<D = unknown> {
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

  // Data returned by successful migrations in this run. Always present (every
  // return path sets it); it is an empty object when no migration returned data.
  migrationData: D_ALL;
}

/**
 * Migration Manager - handles running migrations and tracking their status
 */
export class MigrationManager {
  // Class constant for the lock name to ensure consistency
  private static readonly LOCK_NAME = "database_migrations";

  // Default lease window: how long an acquired lock stays valid before another
  // process may take it over. The renewal timer pushes the expiry forward every
  // `lockRenewalSeconds`, so the lease must be comfortably larger than the
  // renewal interval to tolerate a few missed renewals. Overridable via
  // opts.lockExpirySeconds.
  private static readonly DEFAULT_LOCK_EXPIRY_SECONDS = 5 * 60; // 5 minutes

  private pool: Pool;
  // Every registered migration lives in this one array, but each can have a
  // different payload/return type — there's no single generic that fits a mix
  // of them, so the element type is intentionally `any`. (`unknown` doesn't
  // work here: it can't satisfy each migration's specific payload type.)
  // Type-safety is kept where it matters: the public register() generic checks
  // each migration as it's added.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private migrations: Migration<any, any>[] = [];
  private lockId: string | null = null;
  private lockRenewalInterval: NodeJS.Timeout | null = null;
  private lockRenewalSeconds: number; // Configurable lock renewal interval in seconds
  private lockExpirySeconds: number; // Configurable lock lease window in seconds
  private logger: Logger;
  private initialized = false;
  // Abort controller scoped to a single runSchemaChanges call. Aborted on a
  // caller-supplied shutdown signal or when the lock is lost during renewal.
  private runAbortController: AbortController | null = null;
  // Set when lock renewal detects the lock was lost (taken by another process).
  // Distinguishes an unsafe lock-loss abort from a graceful shutdown abort.
  private lockLost = false;
  // Epoch ms at which the lock we currently hold expires. Set on acquire and on
  // every successful renewal. Used by renewLock to decide, when a renewal query
  // *throws* (vs. cleanly finding the lock taken), whether the lease window has
  // already lapsed — at which point we can no longer assume exclusivity and must
  // treat it as a loss rather than optimistically retrying forever.
  private lockExpiresAtMs = 0;

  /**
   * Helper method to update migration status fields.
   *
   * Builds a dynamic, parameterized `UPDATE migration_status` statement that
   * only touches the columns whose values were actually passed in `fields`
   * (any omitted field is left untouched). Values are bound as query
   * parameters ($1, $2, ...) rather than interpolated into the SQL string, so
   * this is safe against SQL injection.
   *
   * Lock fencing: every status write is gated on still holding the migration
   * lock. When `this.lockId` is set (always true during a run), the UPDATE only
   * applies if `migration_lock.locked_by` still equals our lock id — so once the
   * lock has been taken over by another process, our writes become no-ops at the
   * database level rather than racing the rightful owner. (The lock is just a
   * row, so Postgres can't physically block us; this WHERE clause is how we
   * enforce it for Strataline's own bookkeeping. It does NOT fence the arbitrary
   * SQL a data migration runs on the pool — those stay the caller's
   * responsibility to make idempotent.)
   *
   * Returns `true` if the row was updated (we still hold the lock), `false` if
   * nothing was updated (lock lost, or the row is missing). Callers that advance
   * migration state (`migration_complete`, `completed_at`, the phase flags) must
   * treat `false` as a lock loss; best-effort/observability writes can ignore it.
   *
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
  ): Promise<boolean> {
    // Build a parameterized UPDATE that only sets the columns actually
    // provided. `param()` records a bound value and returns its placeholder
    // ($1, $2, ...), so the values array and the placeholders stay in lockstep
    // automatically with no separate index to maintain. $1 is always the row
    // id, consumed by the WHERE clause below.
    const updates: string[] = [];
    const values: unknown[] = [id];
    // Bind a value and return its positional placeholder (e.g. "$3").
    const param = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (fields.beforeSchemaApplied !== undefined) {
      updates.push(
        `before_schema_applied = ${param(fields.beforeSchemaApplied)}`,
      );
    }

    if (fields.migrationComplete !== undefined) {
      updates.push(`migration_complete = ${param(fields.migrationComplete)}`);
    }

    if (fields.afterSchemaApplied !== undefined) {
      updates.push(
        `after_schema_applied = ${param(fields.afterSchemaApplied)}`,
      );
    }

    if (fields.completedAt !== undefined) {
      updates.push(`completed_at = ${param(fields.completedAt)}`);
    }

    if (fields.lastError !== undefined) {
      updates.push(`last_error = ${param(fields.lastError)}`);
    }

    if (fields.metadata !== undefined) {
      // Serialize to JSON for the jsonb column.
      updates.push(
        `metadata = ${param(JSON.stringify(fields.metadata))}::jsonb`,
      );
    }

    // Always bump last_updated so every status write touches the row (this also
    // guarantees there is at least one column to SET).
    updates.push(`last_updated = ${param(Math.floor(Date.now() / 1000))}`);

    // Fence the write on still holding a *valid* lock. Skipped only if we
    // somehow have no lock id (markStatus is always called within a held lock
    // today, so in practice this clause is always present). When present, the
    // UPDATE no-ops if another process has taken the lock over (locked_by no
    // longer ours) OR our own lease has already expired (lock_expires_at in the
    // past) — the latter matters because once the lease lapses another runner is
    // allowed to take over at any instant, so we must stop committing even
    // before the takeover actually lands. The expiry is compared against the
    // current time on our own clock (a bound param), consistent with how
    // acquire/renew/takeover compare leases.
    const lockFence = this.lockId
      ? ` AND EXISTS (
            SELECT 1 FROM migration_lock
            WHERE lock_name = ${param(MigrationManager.LOCK_NAME)}
              AND locked_by = ${param(this.lockId)}
              AND lock_expires_at > ${param(new Date())}
          )`
      : "";

    const query = `
      UPDATE migration_status
      SET ${updates.join(", ")}
      WHERE id = $1${lockFence}
    `;

    const result = await this.pool.query(query, values);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Advance migration state via markStatus, treating a fenced-out (no-op) write
   * as a lock loss. A status write that updates zero rows means another process
   * has taken the lock over (the fence in markStatus rejected it), so we flag the
   * loss, abort the run, and stop renewal — exactly like a renewal that finds the
   * lock gone, but detected synchronously at write time (closing the gap between
   * the lease expiring and the next renewal tick noticing). Returns whether the
   * write applied. Use this for writes that advance state (migration_complete,
   * completed_at, the phase-applied flags); purely observational writes
   * (last_error) can call markStatus directly and ignore the result.
   *
   * @private
   */
  private async advanceStatusOrLoseLock(
    id: string,
    fields: Parameters<MigrationManager["markStatus"]>[1],
    context: string,
  ): Promise<boolean> {
    const applied = await this.markStatus(id, fields);

    if (!applied) {
      this.handleLockLost(
        `[${context}] migration_status write for ${id} was rejected - the migration lock is no longer held by this process (it may have been taken over); aborting to avoid concurrent migrations.`,
      );
    }

    return applied;
  }

  /**
   * Constructor for MigrationManager
   * @param pool Database connection pool
   * @param logger Logger instance (defaults to console logger)
   * @param opts Optional configuration options
   * @param opts.lockRenewalSeconds Number of seconds between lock renewal attempts (defaults to 60)
   * @param opts.lockExpirySeconds Lease window in seconds — how long an acquired
   *   lock stays valid before another process may take it over (defaults to 300).
   *   The renewal interval must be at most half this value.
   */
  constructor(
    pool: Pool,
    logger: Logger = consoleLogger,
    opts?: { lockRenewalSeconds?: number; lockExpirySeconds?: number },
  ) {
    this.pool = pool;
    this.logger = logger;
    this.lockRenewalSeconds = opts?.lockRenewalSeconds ?? 60; // Default to 60 seconds if not specified
    this.lockExpirySeconds =
      opts?.lockExpirySeconds ?? MigrationManager.DEFAULT_LOCK_EXPIRY_SECONDS;

    // Validate the two knobs independently so each failure points at the exact
    // problem, then validate their relationship. Three distinct throws:

    // 1. The lease window must itself be a sane positive, finite number.
    if (
      !Number.isFinite(this.lockExpirySeconds) ||
      this.lockExpirySeconds <= 0
    ) {
      throw new Error(
        `lockExpirySeconds must be a positive, finite number; got ${this.lockExpirySeconds}.`,
      );
    }

    // 2. The renewal interval must itself be a sane positive, finite number.
    if (
      !Number.isFinite(this.lockRenewalSeconds) ||
      this.lockRenewalSeconds <= 0
    ) {
      throw new Error(
        `lockRenewalSeconds must be a positive, finite number; got ${this.lockRenewalSeconds}.`,
      );
    }

    // 3. The renewal interval must be no greater than half the lease window —
    // otherwise the lock can expire before a renewal fires, letting another
    // process take it over during normal operation. Capping at half the lease
    // leaves room for at least one missed renewal so a single transient renewal
    // failure can't drop the lock. This is a misconfiguration, so fail loudly at
    // construction rather than silently allowing intermittent concurrent
    // migrations.
    const maxRenewalSeconds = this.lockExpirySeconds / 2;
    if (this.lockRenewalSeconds > maxRenewalSeconds) {
      throw new Error(
        `lockRenewalSeconds (${this.lockRenewalSeconds}) must be no greater than ${maxRenewalSeconds} ` +
          `(half the ${this.lockExpirySeconds}s lock lease, leaving room for a missed renewal).`,
      );
    }
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
      // Serialize initialization across processes. `CREATE TABLE IF NOT EXISTS`
      // is not race-free in Postgres: two processes running it concurrently on a
      // fresh database can collide in the catalog and raise a duplicate-key error
      // ("pg_type_typname_nsp_index"). A transaction-scoped advisory lock makes
      // concurrent first-boots wait their turn; the second one then finds the
      // tables already present and its IF NOT EXISTS statements no-op. The lock
      // auto-releases on COMMIT/ROLLBACK. (ensureInitialized runs before the
      // migration lock is acquired, so it can't rely on that for mutual exclusion.)
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('strataline:migration_init'))",
      );

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

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
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
   * @param mode Migration mode ("job" | "distributed") passed to data migrations
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
    //  - lock loss detected during renewal (unsafe -> reported as "lock_lost")
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

      // A migration counts as fully applied only when every phase is applied AND
      // completed_at is stamped. A row can exist while still incomplete (a phase
      // failed, deferred, or was interrupted mid-run), so "has a status row" is
      // NOT the same as "applied". previouslyAppliedMigrations is derived from
      // this so a partially-applied migration isn't double-counted as both
      // applied and pending.
      const isFullyApplied = (s: MigrationStatus): boolean =>
        s.completedAt !== 0 &&
        s.beforeSchemaApplied &&
        s.migrationComplete &&
        s.afterSchemaApplied;

      const fullyAppliedIds = status.filter(isFullyApplied).map((s) => s.id);

      // Get the status of migrations that are in our registered list
      const migrationStatusMap = new Map<string, MigrationStatus>();

      for (const s of status) {
        migrationStatusMap.set(s.id, s);
      }

      // A registered migration is pending unless it has a status row that is
      // fully applied.
      const pendingMigrations = this.migrations.filter((m) => {
        const migrationStatus = migrationStatusMap.get(m.id);
        // If not in status table (or somehow absent), it's pending.
        if (!migrationStatus) {
          return true;
        }

        return !isFullyApplied(migrationStatus);
      });

      // If no pending migrations, return early with success
      // Include previously completed migrations in the result
      if (pendingMigrations.length === 0) {
        return {
          success: true,
          status: "completed",
          completedMigrations: [], // No migrations completed in this run
          previouslyAppliedMigrations: fullyAppliedIds, // All migrations were already applied
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
      // Lock loss is unsafe, so it's surfaced as "lock_lost"; a caller-requested
      // shutdown is a benign "aborted".
      const buildInterruptedResult = (): MigrationResult => {
        const previouslyAppliedMigrations = fullyAppliedIds.filter(
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
            // An interruption (shutdown or lock loss) takes precedence over
            // however this migration's phases ended, so check it FIRST. The phase
            // result may be a real failure, a cooperative defer, OR the
            // non-"success" sentinel our schema-phase guards return on abort — we
            // deliberately don't inspect which. buildInterruptedResult() produces
            // the authoritative outcome ("lock_lost" if the lock was lost,
            // otherwise "aborted"); whatever status the phase returned is
            // discarded here. This is the single place that label is decided.
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
              previouslyAppliedMigrations: fullyAppliedIds.filter(
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
          // result's lists stay accurate. buildInterruptedResult() picks the
          // status: lockLost -> "lock_lost", else "aborted".
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
            previouslyAppliedMigrations: fullyAppliedIds.filter(
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
        previouslyAppliedMigrations: fullyAppliedIds.filter(
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
   * @param mode Migration mode to pass to data migration
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

    // If the run was already signalled to stop, bail before touching the status
    // row at all — don't create a record, bump the attempt counter, or clear the
    // prior last_error for a resume that's going to do no work. (The earlier
    // last_error/attempts write used to happen first, which erased the previous
    // failure reason on an aborted no-op resume.)
    //
    // NOTE: the status/reason returned here is NOT what the caller sees. After we
    // return, runSchemaChanges checks the aborted signal (the same signal we test)
    // and replaces our result with buildInterruptedResult() — the single place
    // that decides the user-facing "aborted" vs "lock_lost" (only the manager
    // knows which, via lockLost). So this return just has to be non-"success" to
    // route there. We use "deferred" rather than "error" only as the harmless
    // fallback disposition ("not done, will resume") on the off chance it were
    // ever read: the migration stays pending (this phase's flag unset) and resumes
    // next run, exactly like a data migration that defers in response to abort.
    if (signal?.aborted) {
      return {
        status: "deferred",
        reason:
          "[beforeSchema] Run stopped before schema phase; deferring to resume on the next run",
      };
    }

    if (rows.length === 0) {
      // Create initial migration record if it doesn't exist. Set completed_at to
      // 0 initially - it's updated when the migration is fully completed.
      //
      // Fenced like every other status write: the row is only inserted if we
      // still hold a valid lock (INSERT ... SELECT ... WHERE EXISTS). It's also
      // made idempotent with ON CONFLICT DO NOTHING so that if a concurrent
      // runner (which can only exist if our exclusivity was already lost) created
      // the same row, we get a clean zero-row result instead of a raw
      // duplicate-key error. Either way, a zero-row result while we expected to
      // hold the lock means we no longer do — treat it as a lock loss rather than
      // creating a tracking row (or erroring) without exclusivity.
      const now = Math.floor(Date.now() / 1000);
      const insertParams: unknown[] = [
        migration.id,
        migration.description,
        now,
      ];
      let insertFence = "";

      if (this.lockId) {
        insertParams.push(MigrationManager.LOCK_NAME, this.lockId, new Date());
        insertFence = ` WHERE EXISTS (
          SELECT 1 FROM migration_lock
          WHERE lock_name = $4 AND locked_by = $5 AND lock_expires_at > $6
        )`;
      }

      const insertResult = await this.pool.query(
        `
        INSERT INTO migration_status (
          id, description, before_schema_applied, migration_complete, after_schema_applied, completed_at, last_updated
        )
        SELECT $1, $2, FALSE, FALSE, FALSE, 0, $3${insertFence}
        ON CONFLICT (id) DO NOTHING
        `,
        insertParams,
      );

      if (this.lockId && (insertResult.rowCount ?? 0) === 0) {
        this.handleLockLost(
          `[beforeSchema] initial migration_status insert for ${migration.id} was rejected - the migration lock is no longer held by this process; aborting.`,
        );

        return {
          status: "deferred",
          reason:
            "[beforeSchema] Lock lost before creating the migration record; deferring to resume on the next run",
        };
      }

      taskLogger.info({
        message: `Created migration record for ${migration.id}`,
      });
    }

    // Record this attempt: bump the attempt counter, stamp started_at on the
    // first attempt, and clear any error from a prior attempt now that we're
    // trying again. Fenced on still holding a valid lock (same predicate as
    // markStatus / the phase write): if the lock was taken over between the
    // abort check above and here, this must NOT bump attempts or wipe the prior
    // last_error on the rightful owner's behalf — that would undo the no-work
    // resume guarantee. A fenced-out write is treated as a lock loss.
    const attemptNow = Math.floor(Date.now() / 1000);
    const attemptParams: unknown[] = [migration.id, attemptNow];
    let attemptFence = "";

    if (this.lockId) {
      attemptParams.push(MigrationManager.LOCK_NAME, this.lockId, new Date());
      attemptFence = ` AND EXISTS (
        SELECT 1 FROM migration_lock
        WHERE lock_name = $3 AND locked_by = $4 AND lock_expires_at > $5
      )`;
    }

    const attemptResult = await this.pool.query(
      `
      UPDATE migration_status
      SET attempts = attempts + 1,
          started_at = CASE WHEN started_at = 0 THEN $2 ELSE started_at END,
          last_error = NULL,
          last_updated = $2
      WHERE id = $1${attemptFence}
      `,
      attemptParams,
    );

    if ((attemptResult.rowCount ?? 0) === 0) {
      this.handleLockLost(
        `[beforeSchema] attempt-bookkeeping write for ${migration.id} was rejected - the migration lock is no longer held by this process; aborting.`,
      );

      return {
        status: "deferred",
        reason:
          "[beforeSchema] Lock lost before recording the attempt; deferring to resume on the next run",
      };
    }

    // Step 1: Run schema changes before data migration if provided
    if (migration.beforeSchema) {
      try {
        await this.runMigrationPhase(migration, "beforeSchema", taskLogger);
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
      if (
        !(await this.advanceStatusOrLoseLock(
          migration.id,
          { beforeSchemaApplied: true },
          "beforeSchema",
        ))
      ) {
        return {
          status: "deferred",
          reason:
            "[beforeSchema] Lock lost before marking phase applied; deferring to resume on the next run",
        };
      }
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

      if (
        !(await this.advanceStatusOrLoseLock(
          migration.id,
          { migrationComplete: true },
          "dataMigration",
        ))
      ) {
        return {
          status: "deferred",
          reason:
            "[dataMigration] Lock lost before marking migration complete; deferring to resume on the next run",
        };
      }
    }

    // Critical guard: the data migration may have ignored ctx.signal and called
    // complete() even though the run was signalled to stop mid-flight — most
    // importantly on lock loss, where continuing into afterSchema would run DDL
    // without a valid lock, possibly concurrent with another process. Stop before
    // the schema phase so afterSchema (and the completedAt write below) never run
    // without exclusivity. The data phase is already marked complete, so the
    // migration simply resumes at afterSchema on the next run.
    //
    // As with the beforeSchema guard above, the status/reason returned here is
    // never what the caller sees — runSchemaChanges intercepts on the aborted
    // signal and returns buildInterruptedResult() ("aborted"/"lock_lost"). The
    // "deferred" here is just the safe non-"success" fallback.
    if (signal?.aborted) {
      return {
        status: "deferred",
        reason:
          "[afterSchema] Run stopped before schema phase; deferring to resume on the next run",
      };
    }

    // Step 3: Run schema changes after data migration if needed
    if (migration.afterSchema) {
      try {
        await this.runMigrationPhase(migration, "afterSchema", taskLogger);
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
      if (
        !(await this.advanceStatusOrLoseLock(
          migration.id,
          { afterSchemaApplied: true },
          "afterSchema",
        ))
      ) {
        return {
          status: "deferred",
          reason:
            "[afterSchema] Lock lost before marking phase applied; deferring to resume on the next run",
        };
      }
    }

    // Update completedAt to mark when the migration was fully completed
    const completionTime = Math.floor(Date.now() / 1000);
    if (
      !(await this.advanceStatusOrLoseLock(
        migration.id,
        { completedAt: completionTime },
        "afterSchema",
      ))
    ) {
      return {
        status: "deferred",
        reason:
          "[afterSchema] Lock lost before stamping completion; deferring to resume on the next run",
      };
    }

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
    logger: Logger,
  ): Promise<void> {
    // The helpers handed to the user's phase callback are tagged with this
    // phase as the `stage`, so their logs come out as `[id] [phase] ...`
    // automatically, without the callback having to set anything. Internal
    // phase logging below stays on `logger` (task only); those lines already
    // embed the phase name in the message text, and the [phase]-prefixed
    // reason/last_error strings elsewhere are a parsed contract we don't touch.
    const phaseHelpers: SchemaHelpers = createSchemaHelpers(
      createPrefixedLogger(logger, { stage: phase }),
    );

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
        await migration.beforeSchema(client, phaseHelpers);
      } else if (phase === "afterSchema" && migration.afterSchema) {
        await migration.afterSchema(client, phaseHelpers);
      }

      // Mark the phase applied, fenced on still holding the lock — and because
      // this UPDATE shares the transaction with the DDL above, the fence
      // protects the DDL too: if the lock was taken over, the UPDATE matches
      // zero rows and we ROLLBACK the whole phase (schema change included)
      // rather than committing a phase flag (and DDL) without exclusivity, which
      // would let the next owner wrongly skip this phase. (markStatus can't be
      // reused here because it runs on its own pool connection, outside this
      // transaction.) The lock fence is included only when we hold a lock id, to
      // mirror markStatus.
      const now = Math.floor(Date.now() / 1000);
      const params: unknown[] = [migration.id, now];
      let lockFence = "";

      if (this.lockId) {
        // Require the lock to still be ours AND the lease to still be valid (not
        // yet expired) — see the matching note in markStatus. lock_expires_at is
        // compared against the current time as a bound param ($5) rather than
        // SQL now(), because now() is the transaction's start time and this
        // UPDATE runs after the (potentially long) DDL above, which would make
        // the check stale and too lenient.
        params.push(MigrationManager.LOCK_NAME, this.lockId, new Date());
        lockFence = ` AND EXISTS (
          SELECT 1 FROM migration_lock
          WHERE lock_name = $3 AND locked_by = $4 AND lock_expires_at > $5
        )`;
      }

      const updateResult = await client.query(
        `
        UPDATE migration_status
        SET ${statusField} = TRUE, last_updated = $2
        WHERE id = $1${lockFence}
        `,
        params,
      );

      if ((updateResult.rowCount ?? 0) === 0) {
        // The fenced write matched nothing: the lock was taken over (or the row
        // vanished). Flag the loss so the run aborts and is reported as
        // lock_lost, then throw to trigger the ROLLBACK below — undoing both the
        // phase flag and the DDL so nothing schema-related commits without the
        // lock.
        this.handleLockLost(
          `[${phase}] migration_status write for ${migration.id} was rejected - the migration lock is no longer held by this process; rolling back the ${phase} phase.`,
        );

        throw new Error(
          `[${phase}] Migration lock lost while applying ${phase} for ${migration.id}; phase rolled back to avoid schema changes without exclusivity.`,
        );
      }

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
    // Pre-condition: migration.migration is guaranteed to be non-null by the
    // caller. Capture it once (with an explicit guard) so the rest of the method
    // can use it without a non-null assertion.
    const migrationFn = migration.migration;

    if (!migrationFn) {
      throw new Error(
        `runDataMigration called for "${migration.id}" without a migration function`,
      );
    }

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

    // The logger handed to the migration function as ctx.logger is tagged with
    // the data phase as `stage`, so the migration's own log calls come out as
    // `[id] [dataMigration] ...` without it having to set anything. Internal
    // bookkeeping logs in this method keep using `logger` (task only) and embed
    // the phase in the message text themselves, to avoid a doubled prefix.
    const ctxLogger = createPrefixedLogger(logger, { stage: "dataMigration" });

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
          .then((applied) => {
            if (!applied) {
              // The fenced write updated zero rows: the lock was taken over
              // before complete() landed. Do NOT report success — that would let
              // a zombie flip migration_complete and mislead the rightful owner
              // into skipping the data phase. Flag the loss (aborts the run) and
              // return non-success; runSchemaChanges then reports lock_lost.
              this.handleLockLost(
                `[dataMigration] complete() write for ${migration.id} was rejected - the migration lock is no longer held by this process; aborting.`,
              );

              resolve({
                status: "error",
                reason:
                  "[dataMigration] Lock lost before marking migration complete; the lock was taken over by another process.",
              });
              return;
            }

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
      // update can never turn a healthy migration into an error. A return of
      // false also covers the lock having been taken over (the fenced write
      // no-ops) — this is intentionally just reported, not escalated to an
      // abort: progress reporting stays best-effort, and the completion writes
      // plus the renewal timer are what enforce/detect loss.
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
          return await this.markStatus(migration.id, { metadata: value });
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
          const migrationFnExecution = migrationFn(this.pool, {
            logger: ctxLogger, // task logger, additionally tagged with stage "dataMigration"
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
      const expiresAt = new Date(now.getTime() + this.lockExpirySeconds * 1000);

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
        // Only handle unique-violation errors from PostgreSQL (expected when the
        // lock row already exists). Match on the SQLSTATE code (23505) rather
        // than the message text: error messages are localized via lc_messages,
        // so a string match like "duplicate key" silently breaks on a
        // non-English server — which would not only misreport a held lock as an
        // error but, worse, skip the expired-lock takeover UPDATE below, leaving
        // a stale lock from a crashed process permanently unrecoverable.
        const isUniqueViolation =
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "23505";

        if (!isUniqueViolation) {
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
      this.lockExpiresAtMs = expiresAt.getTime();

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
      // Push the expiry forward by a full lease window from now.
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.lockExpirySeconds * 1000);

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
        // Renewed cleanly: extend our local view of the lease too, so the
        // catch-branch lapse check below stays accurate.
        this.lockExpiresAtMs = expiresAt.getTime();

        this.logger.info({
          message: `Renewed migration lock until ${expiresAt.toISOString()}`,
        });
      } else {
        // The row no longer matches our locked_by — another process took the
        // lock over. This is an unambiguous loss regardless of timing.
        this.handleLockLost(
          "Failed to renew migration lock - it may have been taken by another process",
        );
      }
    } catch (error) {
      // The renewal query itself failed (e.g. connection drop, pool
      // exhaustion). A single transient failure is harmless — the lease is
      // still valid and a later tick can renew it. But if the lease window has
      // already lapsed without a successful renewal, we can no longer assume we
      // hold the lock, so we must treat it as lost rather than retrying forever
      // while another process potentially runs. (Without this, repeated
      // exceptions would never trip the rowCount===0 path and loss would go
      // undetected.)
      this.logger.error({
        message: "Error renewing lock:",
        error,
      });

      if (this.lockId && Date.now() >= this.lockExpiresAtMs) {
        this.handleLockLost(
          "Migration lock lease lapsed while renewals were failing - assuming the lock is lost",
        );
      }
    } finally {
      client.release();
    }
  }

  /**
   * Handle a detected loss of the migration lock: warn, flag it so the run is
   * reported as the unsafe lock_lost status, abort the in-flight run so we stop
   * doing work without a valid lock, and stop the renewal timer. Idempotent.
   */
  private handleLockLost(message: string): void {
    if (this.logger.warn) {
      this.logger.warn({ message });
    } else {
      this.logger.info({ message });
    }

    this.lockLost = true;
    this.runAbortController?.abort();
    this.stopLockRenewal();
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
      this.lockExpiresAtMs = 0;
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
