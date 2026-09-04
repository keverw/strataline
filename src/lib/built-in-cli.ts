import {
  Migration,
  MigrationManager,
  type MigrationResult,
} from "./migration-system";
import { Pool } from "pg";
import { makeSafeLogger } from "./callback-safety";
import { createPrefixedLogger, getErrorMessage, type Logger } from "./logger";

async function testConnection(
  pool: Pool,
  logger: Logger,
  loadedFrom: "env" | "pool" = "env",
  envPrefix: string = "",
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  try {
    const client = await pool.connect();

    try {
      await client.query("SELECT 1");
      logger.info({ message: "Successfully connected to database" });
      return true;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    // Log the error with detailed connection information
    logger.error({ message: "Error connecting to database:" });
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ message: `→ ${errorMessage}` });

    // Only show environment variable details if we're using env mode
    if (loadedFrom === "env") {
      logger.error({
        message: "\nPlease check your database connection settings:",
      });

      // Use the environment variables with the correct prefix
      const host = env[`${envPrefix}POSTGRES_HOST`];
      const port = env[`${envPrefix}POSTGRES_PORT`];
      const database = env[`${envPrefix}POSTGRES_DATABASE`];
      const user = env[`${envPrefix}POSTGRES_USER`];

      logger.error({ message: `→ Host: ${host}` });
      logger.error({ message: `→ Port: ${port}` });
      logger.error({ message: `→ Database: ${database}` });
      logger.error({ message: `→ User: ${user}` });
    } else {
      logger.error({
        message:
          "\nPlease check that the provided database pool is configured correctly.",
      });
    }

    logger.error({
      message: "\nMake sure PostgreSQL is running and accessible.",
    });

    return false;
  }
}

/**
 * Run database migrations
 * @param pool Database connection pool
 * @param mode Migration mode (job or distributed)
 * @param migrations Array of migrations to run
 * @param logger Logger function to use
 * @param signal Optional AbortSignal for graceful shutdown
 * @returns The MigrationResult. Throws only when the run ends in "error";
 *   "deferred"/"locked"/"aborted" are logged and returned (they are not
 *   failures), so the caller can map them to distinct exit codes.
 */
async function runMigrations(
  pool: Pool,
  mode: "job" | "distributed",
  migrations: Migration[],
  logger: Logger,
  signal?: AbortSignal,
): Promise<MigrationResult> {
  logger.info({
    message: `Initializing database migration manager in ${mode} mode...`,
  });

  // Stamped as the migration system's lines rather than the CLI's own. The
  // ordinary prefixer does it, since a source is a field like task and stage.
  const stratalineLogger = createPrefixedLogger(logger, {
    source: "migration",
  });
  const manager = new MigrationManager(pool, stratalineLogger);

  // Register all migrations from the config
  manager.register(migrations);

  // Run pending migrations
  logger.info({ message: "Running pending schema changes..." });
  const result = await manager.runSchemaChanges(mode, { signal });

  if (result.success) {
    const appliedNow = result.completedMigrations.length;
    const previouslyApplied = result.previouslyAppliedMigrations?.length ?? 0;

    // Lead with a clear, human summary so it's obvious at a glance whether
    // anything happened, rather than leaving the reader to parse the lists.
    if (appliedNow === 0 && previouslyApplied === 0) {
      logger.info({ message: "No migrations registered — nothing to do." });
    } else if (appliedNow === 0) {
      logger.info({
        message: `✓ Already up to date — all ${previouslyApplied} migration(s) were applied in previous runs.`,
      });
    } else {
      logger.info({
        message: `✓ Applied ${appliedNow} migration(s) in this run.`,
      });
    }

    // Always show migrations applied in this run (even if none)
    logger.info({
      message: `Applied during this run: ${result.completedMigrations.join(", ") || "none"}`,
    });

    // Always show migrations that were already applied in previous runs (even if none)
    logger.info({
      message: `Previously applied: ${result.previouslyAppliedMigrations.join(", ") || "none"}`,
    });

    // Always show pending migrations (even if none)
    logger.info({
      message: `Pending migrations: ${result.pendingMigrations.join(", ") || "none"}`,
    });

    return result;
  } else {
    // A run can end early for several reasons. Only "error" is an actual
    // failure — a deferral is a deliberate pause (staged rollout), a locked
    // result just means another process is handling it, and "aborted" is a
    // caller-requested graceful shutdown.
    switch (result.status) {
      case "deferred":
        logger.warn({
          message: `⏸ Migration run paused — deferred: ${result.reason}`,
        });
        break;
      case "locked":
        logger.warn({ message: `⏭ Migration run skipped: ${result.reason}` });
        break;
      case "aborted":
        logger.warn({ message: `⏹ Migration run aborted: ${result.reason}` });
        break;
      case "lock_lost":
        // Unsafe condition — log loudly, but it's returned (not thrown) with
        // its own exit code so callers can distinguish it from a generic error.
        logger.error({
          message: `✗ Migration lock lost mid-run: ${result.reason}`,
        });
        break;
      default:
        logger.error({ message: `✗ Migration failed: ${result.reason}` });
        break;
    }

    logger.info({
      message: `Completed during this run: ${result.completedMigrations.join(", ") || "none"}`,
    });

    if (
      result.previouslyAppliedMigrations &&
      result.previouslyAppliedMigrations.length > 0
    ) {
      logger.info({
        message: `Previously applied migrations: ${result.previouslyAppliedMigrations.join(", ")}`,
      });
    }

    // Remaining work is always surfaced when a run ends early.
    logger.info({
      message: `Pending migrations: ${result.pendingMigrations.join(", ") || "none"}`,
    });

    if (result.lastAttemptedMigration) {
      logger.info({
        message: `Last attempted migration: ${result.lastAttemptedMigration}`,
      });
    }

    // Show raw error details if available for debugging (unhandled exceptions only)
    if (result.error) {
      logger.error({ message: `Error details: ${result.error.message}` });

      if (result.error.stack) {
        logger.error({ message: `Stack trace: ${result.error.stack}` });
      }
    }

    // Only a real "error" throws (so callers that only `.catch` still see
    // failures and exit non-zero). deferred/locked/aborted are not failures —
    // they're returned so the caller can map each to its own exit code.
    if (result.status === "error") {
      throw new Error(`Migration failed: ${result.reason}`);
    }

    return result;
  }
}

/**
 * Show migration status
 * @param pool Database connection pool
 * @param migrations Array of migrations to check
 * @param logger Logger function to use
 */
async function showMigrationStatus(
  pool: Pool,
  migrations: Migration[],
  logger: Logger,
): Promise<void> {
  // Stamped as the migration system's lines rather than the CLI's own. The
  // ordinary prefixer does it, since a source is a field like task and stage.
  const stratalineLogger = createPrefixedLogger(logger, {
    source: "migration",
  });
  const manager = new MigrationManager(pool, stratalineLogger);

  // Register all migrations from the config
  manager.register(migrations);

  // Get migration status
  const status = await manager.getMigrationStatus();

  logger.info({ message: "\nMigration Status:" });
  logger.info({ message: "=================" });

  if (status.length === 0) {
    logger.info({ message: "No migrations have been applied yet." });
  } else {
    const formatDate = (completedAt: number): string =>
      completedAt
        ? new Date(completedAt * 1000)
            .toISOString()
            .replace("T", " ")
            .substring(0, 19)
        : "Not completed";

    const yesNo = (applied: boolean): string => (applied ? "Yes" : "No");

    // Keep the table readable by truncating long values to a single line.
    const truncate = (text: string, max: number): string => {
      const oneLine = text.replace(/\s+/g, " ").trim();
      return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
    };

    const formatError = (lastError: string | null): string =>
      lastError ? truncate(lastError, 60) : "—";

    const formatMetadata = (metadata: unknown): string => {
      if (metadata === null || metadata === undefined) {
        return "—";
      }
      try {
        return truncate(JSON.stringify(metadata), 40);
      } catch {
        return "(unserializable)";
      }
    };

    // Build the rows first so column widths can be sized to the actual content
    // (keeps the table aligned regardless of migration ID length).
    const headers = [
      "ID",
      "Before",
      "Migration",
      "After",
      "Applied At",
      "Attempts",
      "Last Error",
      "Metadata",
    ];

    const rows = status.map((m) => [
      m.id,
      yesNo(m.beforeSchemaApplied),
      yesNo(m.migrationComplete),
      yesNo(m.afterSchemaApplied),
      formatDate(m.completedAt),
      String(m.attempts),
      formatError(m.lastError),
      formatMetadata(m.metadata),
    ]);

    const widths = headers.map((header, col) =>
      Math.max(header.length, ...rows.map((row) => row[col].length)),
    );

    const renderRow = (cells: string[]): string =>
      cells.map((cell, col) => cell.padEnd(widths[col])).join(" | ");

    logger.info({ message: renderRow(headers) });
    logger.info({ message: widths.map((w) => "-".repeat(w)).join("-+-") });

    for (const row of rows) {
      logger.info({ message: renderRow(row) });
    }
  }
}

/**
 * Process exit codes returned by RunStratalineCLI, one per outcome so wrapper
 * scripts can distinguish them. A genuine "error" is thrown rather than
 * returned, so callers that `.catch(() => process.exit(1))` still map it to 1.
 */
export const STRATALINE_EXIT_CODES = {
  completed: 0,
  error: 1,
  deferred: 2,
  locked: 3,
  aborted: 4,
  lock_lost: 5,
} as const;

/**
 * Result returned by RunStratalineCLI for non-error outcomes.
 */
export interface StratalineCLIResult {
  // The CLI command that ran ("run", "status", or "help").
  command: string;
  // The migration run status, present for the "run" command.
  status?: MigrationResult["status"];
  // Suggested process exit code for this outcome.
  exitCode: number;
  // Human-readable reason, when the run did not simply complete.
  reason?: string;
}

function exitCodeForRunStatus(status: MigrationResult["status"]): number {
  switch (status) {
    case "completed":
      return STRATALINE_EXIT_CODES.completed;
    case "deferred":
      return STRATALINE_EXIT_CODES.deferred;
    case "locked":
      return STRATALINE_EXIT_CODES.locked;
    case "aborted":
      return STRATALINE_EXIT_CODES.aborted;
    case "lock_lost":
      return STRATALINE_EXIT_CODES.lock_lost;
    default:
      // "error" is thrown, not returned, but map it for completeness.
      return STRATALINE_EXIT_CODES.error;
  }
}

/**
 * Run the Strataline CLI with the provided configuration
 * @param config Configuration object
 * @param config.migrations Array of migrations to run
 * @param config.loadFrom Whether to load database configuration from environment variables or a provided pool
 * @param config.envPrefix Optional prefix for environment variables (e.g., "API_" for "API_POSTGRES_USER")
 * @param config.pool Connection pool to use for database operations
 * @param config.logger Logger function to use for logging (Required, unlike the other ones in this project)
 * @param config.argv Optional array to use instead of process.argv for CLI arguments
 * @param config.env Optional environment object to use instead of process.env
 * @param config.signal Optional AbortSignal for graceful shutdown. The library
 *   never traps OS signals itself — wire this to your own SIGTERM/SIGINT
 *   handling. When it aborts, an in-flight `run` stops at the next safe point.
 * @returns A StratalineCLIResult with a suggested `exitCode`. Throws on a real
 *   migration error or on configuration/connection failures.
 */
export async function RunStratalineCLI(config: {
  migrations: Migration[];
  loadFrom: "env" | "pool";
  envPrefix?: string; // Prefix for env vars, e.g., "API_" for "API_POSTGRES_USER"
  pool?: Pool;
  logger: Logger;
  argv?: string[];
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<StratalineCLIResult> {
  // Wrapped once on the way in, so no call site below has to remember to guard
  // it: a logger that throws, or an `async` one that rejects, loses its line
  // and degrades rather than ending the process. See makeSafeLogger.
  const logger = makeSafeLogger(config.logger);

  let poolInstance: Pool | undefined;

  // Validate configuration
  if (config.loadFrom === "env") {
    // Ensure pool is not provided, and envPrefix is optional
    if (config.pool) {
      throw new Error("Cannot provide both pool and loadFrom='env'");
    }

    // Check for required env vars and create the pool
    const prefix = config.envPrefix || "";
    const requiredEnvVars = [
      "POSTGRES_USER",
      "POSTGRES_HOST",
      "POSTGRES_DATABASE",
      "POSTGRES_PASSWORD",
      "POSTGRES_PORT",
    ];

    // Use provided env object or fall back to process.env
    const env = config.env || process.env;

    // Check if all required environment variables are present with the given prefix
    const missingEnvVars = requiredEnvVars.filter(
      (envVar) => !env[prefix + envVar],
    );

    if (missingEnvVars.length > 0) {
      const formattedVars = missingEnvVars.map((v) => prefix + v);

      logger.error({
        message:
          "Missing required environment variables: " + formattedVars.join(", "),
      });

      logger.error({
        message:
          "Please ensure all required database configuration is set in your .env file or environment variables.",
      });

      throw new Error(
        "Missing required environment variables: " + formattedVars.join(", "),
      );
    }

    // PostgreSQL Connection Pool
    const portValue = env[prefix + "POSTGRES_PORT"];
    const maxConnectionsValue = env[prefix + "POSTGRES_MAX_CONNECTIONS"];
    const idleTimeoutValue = env[prefix + "POSTGRES_IDLE_TIMEOUT"];
    const connectionTimeoutValue = env[prefix + "POSTGRES_CONNECTION_TIMEOUT"];

    // Parse and validate port. POSTGRES_PORT is required and already confirmed
    // present by the missing-vars check above; the `?? ""` only satisfies the
    // type (an empty string parses to NaN, which the range check below rejects).
    const port = parseInt(portValue ?? "", 10);

    if (isNaN(port) || port <= 0 || port > 65535) {
      throw new Error(
        "Invalid " +
          prefix +
          "POSTGRES_PORT: must be a valid port number (1-65535), got: " +
          portValue,
      );
    }

    // Parse and validate optional numeric values
    let maxConnections = 20;

    if (maxConnectionsValue) {
      maxConnections = parseInt(maxConnectionsValue, 10);

      if (isNaN(maxConnections) || maxConnections <= 0) {
        throw new Error(
          "Invalid " +
            prefix +
            "POSTGRES_MAX_CONNECTIONS: must be a positive number, got: " +
            maxConnectionsValue,
        );
      }
    }

    let idleTimeout = 30000;

    if (idleTimeoutValue) {
      idleTimeout = parseInt(idleTimeoutValue, 10);

      if (isNaN(idleTimeout) || idleTimeout < 0) {
        throw new Error(
          "Invalid " +
            prefix +
            "POSTGRES_IDLE_TIMEOUT: must be a non-negative number, got: " +
            idleTimeoutValue,
        );
      }
    }

    let connectionTimeout = 2000;

    if (connectionTimeoutValue) {
      connectionTimeout = parseInt(connectionTimeoutValue, 10);

      if (isNaN(connectionTimeout) || connectionTimeout < 0) {
        throw new Error(
          "Invalid " +
            prefix +
            "POSTGRES_CONNECTION_TIMEOUT: must be a non-negative number, got: " +
            connectionTimeoutValue,
        );
      }
    }

    poolInstance = new Pool({
      user: env[prefix + "POSTGRES_USER"],
      host: env[prefix + "POSTGRES_HOST"],
      database: env[prefix + "POSTGRES_DATABASE"],
      password: env[prefix + "POSTGRES_PASSWORD"],
      port: port,
      max: maxConnections,
      idleTimeoutMillis: idleTimeout,
      connectionTimeoutMillis: connectionTimeout,
    });
  } else if (config.loadFrom === "pool") {
    // Validate *before* adopting the pool. Once poolInstance is set, the run
    // below owns it and closes it on the way out — including the
    // caller-supplied pool, unconditionally, since there is no option to opt
    // out of that. A validation throw here happens before any of it, so
    // assigning poolInstance first would leave a caller's pool open on the
    // envPrefix misconfiguration. Check everything up front, then adopt.

    // Ensure pool is provided
    if (!config.pool) {
      throw new Error("Must provide pool when loadFrom='pool'");
    }

    // Ensure envPrefix is not provided
    if (config.envPrefix) {
      throw new Error("Cannot provide envPrefix when loadFrom='pool'");
    }

    poolInstance = config.pool;
  }

  // set up migration manager
  if (poolInstance) {
    poolInstance.on("error", (err) => {
      logger.error({
        message: `Unexpected error on idle client in PostgreSQL pool: ${err.message}`,
      });
    });

    // Get the operation from command line arguments (use provided argv or fall back to process.argv)
    const args = config.argv || process.argv;
    const operation = args[2] || "help";
    const isDistributed = args.includes("--distributed");

    /**
     * Closes the adopted pool, reporting rather than raising a failure to.
     *
     * For the path where the run has already failed. That failure is the one
     * worth raising, and a close error would displace it: the pool is adopted,
     * including a caller-supplied one (see the ownership note above), so
     * calling this twice with the same pool has pg reject the second close
     * with "Called end on pool more than once" -- and the second run has by
     * then already failed at testConnection against a closed pool, which is
     * the diagnosis that names the actual mistake.
     */
    const closePoolReportingFailure = async (): Promise<void> => {
      try {
        await poolInstance.end();
      } catch (closeError: unknown) {
        logger.error({
          message: `Error: could not close the PostgreSQL pool: ${getErrorMessage(
            closeError,
          )}. Reporting the earlier failure instead.`,
        });
      }
    };

    // Assigned in every branch of the switch below, then returned after the
    // pool has been closed rather than from inside the try. The close used to
    // sit in a `finally`, where an `await` that rejects REPLACES whatever was
    // propagating out of the try -- which is how a run that failed for its own
    // reasons came back reporting only that a pool could not be closed.
    let cliResult: StratalineCLIResult;

    try {
      // Test database connection before proceeding
      const connected = await testConnection(
        poolInstance,
        logger,
        config.loadFrom,
        config.loadFrom === "env" ? config.envPrefix || "" : "",
        config.env,
      );

      if (!connected) {
        // Add a clear message about aborting the operation
        logger.error({
          message: "\nAborting operation due to database connection failure.\n",
        });
        throw new Error("Database connection failure");
      }

      switch (operation) {
        case "run": {
          const result = await runMigrations(
            poolInstance,
            isDistributed ? "distributed" : "job",
            config.migrations,
            logger,
            config.signal,
          );
          cliResult = {
            command: "run",
            status: result.status,
            exitCode: exitCodeForRunStatus(result.status),
            reason: result.reason,
          };
          break;
        }
        case "status":
          await showMigrationStatus(poolInstance, config.migrations, logger);
          cliResult = { command: "status", exitCode: 0 };
          break;
        case "help":
        default:
          logger.info({
            message: `
Strataline Database Migration CLI

Available commands:
  run         Run pending migrations
  status      Show migration status
  help        Show this help (default when no command is given)

Options:
  --distributed  Run migrations in distributed mode
`,
          });
          cliResult = { command: "help", exitCode: 0 };
          break;
      }
    } catch (error: unknown) {
      logger.error({ message: `Error: ${getErrorMessage(error)}` });

      // Closed here rather than in a `finally`, so a failure to close cannot
      // take the place of the failure being reported.
      await closePoolReportingFailure();

      throw error; // Re-throw to allow caller to handle it
    }

    // The run succeeded, so there is nothing for a close failure to displace,
    // and a pool that will not close is a leaked resource rather than noise.
    // It propagates.
    await poolInstance.end();

    return cliResult;
  } else {
    throw new Error("Database pool was not initialized properly");
  }
}
