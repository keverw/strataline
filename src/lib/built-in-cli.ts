import { Migration, MigrationManager } from "./migration-system";
import { Pool } from "pg";
import { Logger, LogDataInput, BaseLogger } from "./logger";

/**
 * Logger function type for Strataline CLI
 */
export type CLILoggerFunction = (
  type:
    | "info"
    | "error"
    | "warn"
    | "migrate-info"
    | "migrate-error"
    | "migrate-warn",
  message: string,
) => void;

/**
 * Console-based logger implementation for Strataline CLI
 * @param migrateVerbose Whether to log verbose migration messages
 */
export const createCLIConsoleLogger = (
  migrateVerbose: boolean = true,
): CLILoggerFunction => {
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
      case "migrate-info":
        if (migrateVerbose) {
          console.log(`[MIGRATE-INFO] ${message}`);
        }
        break;
      case "migrate-error":
        console.error(`[MIGRATE-ERROR] ${message}`);
        break;
      case "migrate-warn":
        console.warn(`[MIGRATE-WARN] ${message}`);
        break;
    }
  };
};

/**
 * Adapter that converts between the Strataline Logger interface and our CLI logger
 * This separates CLI tool logs from migration system logs while preserving severity levels
 */
class CLIStratalineLogger extends BaseLogger implements Logger {
  private cliLogger: CLILoggerFunction;

  constructor(logger: CLILoggerFunction) {
    super();
    this.cliLogger = logger;
  }

  info(data: LogDataInput): void {
    const taskPrefix = data.task ? `[${data.task}]` : "";
    const stagePrefix = data.stage ? `[${data.stage}]` : "";
    const prefix = `${taskPrefix} ${stagePrefix}`.trim();
    const message = prefix ? `${prefix} ${data.message}` : data.message;

    // All info logs through this adapter are migration-related
    this.cliLogger("migrate-info", message);
  }

  error(data: LogDataInput): void {
    const taskPrefix = data.task ? `[${data.task}]` : "";
    const stagePrefix = data.stage ? `[${data.stage}]` : "";
    const prefix = `${taskPrefix} ${stagePrefix}`.trim();
    const errorMsg = data.error
      ? `${data.message}: ${data.error.message || String(data.error)}`
      : data.message;
    const message = prefix ? `${prefix} ${errorMsg}` : errorMsg;

    // All errors through this adapter are migration-related
    this.cliLogger("migrate-error", message);
  }

  warn(data: LogDataInput): void {
    const taskPrefix = data.task ? `[${data.task}]` : "";
    const stagePrefix = data.stage ? `[${data.stage}]` : "";
    const prefix = `${taskPrefix} ${stagePrefix}`.trim();
    const message = prefix ? `${prefix} ${data.message}` : data.message;

    // All warnings through this adapter are migration-related
    this.cliLogger("migrate-warn", message);
  }
}

async function testConnection(
  pool: Pool,
  logger: CLILoggerFunction,
  loadedFrom: "env" | "pool" = "env",
  envPrefix: string = "",
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  try {
    const client = await pool.connect();

    try {
      await client.query("SELECT 1");
      logger("info", "Successfully connected to database");
      return true;
    } finally {
      client.release();
    }
  } catch (error: any) {
    // Log the error with detailed connection information
    logger("error", "Error connecting to database:");
    logger("error", `→ ${error.message}`);

    // Only show environment variable details if we're using env mode
    if (loadedFrom === "env") {
      logger("error", "\nPlease check your database connection settings:");

      // Use the environment variables with the correct prefix
      const host = env[`${envPrefix}POSTGRES_HOST`];
      const port = env[`${envPrefix}POSTGRES_PORT`];
      const database = env[`${envPrefix}POSTGRES_DATABASE`];
      const user = env[`${envPrefix}POSTGRES_USER`];

      logger("error", `→ Host: ${host}`);
      logger("error", `→ Port: ${port}`);
      logger("error", `→ Database: ${database}`);
      logger("error", `→ User: ${user}`);
    } else {
      logger(
        "error",
        "\nPlease check that the provided database pool is configured correctly.",
      );
    }

    logger("error", "\nMake sure PostgreSQL is running and accessible.");

    return false;
  }
}

/**
 * Run database migrations
 * @param pool Database connection pool
 * @param mode Migration mode (job or distributed)
 * @param migrations Array of migrations to run
 * @param logger Logger function to use
 */
async function runMigrations(
  pool: Pool,
  mode: "job" | "distributed",
  migrations: Migration[],
  logger: CLILoggerFunction,
): Promise<void> {
  logger("info", `Initializing database migration manager in ${mode} mode...`);

  // Create migration manager with our adapter for logging
  const stratalineLogger = new CLIStratalineLogger(logger);
  const manager = new MigrationManager(pool, stratalineLogger);

  // Register all migrations from the config
  manager.register(migrations);

  // Run pending migrations
  logger("info", "Running pending schema changes...");
  const result = await manager.runSchemaChanges(mode);

  if (result.success) {
    if (result.completedMigrations.length > 0) {
      logger(
        "info",
        `Applied ${result.completedMigrations.length} migrations: ${result.completedMigrations.join(", ")}`,
      );
    } else {
      logger("info", "No pending migrations to apply");
    }
  } else {
    logger("error", `Migration failed: ${result.reason}`);

    logger(
      "info",
      `Completed migrations: ${result.completedMigrations.join(", ") || "none"}`,
    );

    logger(
      "info",
      `Pending migrations: ${result.pendingMigrations.join(", ") || "none"}`,
    );

    if (result.lastAttemptedMigration) {
      logger(
        "info",
        `Last attempted migration: ${result.lastAttemptedMigration}`,
      );
    }

    throw new Error(`Migration failed: ${result.reason}`);
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
  logger: CLILoggerFunction,
): Promise<void> {
  // Create migration manager with our adapter for logging
  const stratalineLogger = new CLIStratalineLogger(logger);
  const manager = new MigrationManager(pool, stratalineLogger);

  // Register all migrations from the config
  manager.register(migrations);

  // Get migration status
  const status = await manager.getMigrationStatus();

  logger("info", "\nMigration Status:");
  logger("info", "=================");

  if (status.length === 0) {
    logger("info", "No migrations have been applied yet.");
  } else {
    logger(
      "info",
      "ID                   | Before | Migration | After  | Applied At",
    );
    logger(
      "info",
      "---------------------|--------|-----------|--------|------------------",
    );

    status.forEach((m) => {
      const date = m.completedAt
        ? new Date(m.completedAt * 1000)
            .toISOString()
            .replace("T", " ")
            .substring(0, 19)
        : "Not completed";

      logger(
        "info",
        `${m.id.padEnd(20)} | ${m.beforeSchemaApplied ? "Yes" : "No ".padEnd(6)} | ${m.migrationComplete ? "Yes" : "No ".padEnd(9)} | ${m.afterSchemaApplied ? "Yes" : "No ".padEnd(6)} | ${date}`,
      );
    });
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
 */
export async function RunStratalineCLI(config: {
  migrations: Migration[];
  loadFrom: "env" | "pool";
  envPrefix?: string; // Prefix for env vars, e.g., "API_" for "API_POSTGRES_USER"
  pool?: Pool;
  logger: CLILoggerFunction;
  argv?: string[];
  env?: Record<string, string | undefined>;
}) {
  let poolInstance: Pool | undefined;

  // Validate configuration
  if (config.loadFrom == "env") {
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
      (envVar) => !env[`${prefix}${envVar}`],
    );

    if (missingEnvVars.length > 0) {
      const formattedVars = missingEnvVars.map((v) => `${prefix}${v}`);

      config.logger(
        "error",
        `Missing required environment variables: ${formattedVars.join(", ")}`,
      );

      config.logger(
        "error",
        "Please ensure all required database configuration is set in your .env file or environment variables.",
      );

      throw new Error(
        `Missing required environment variables: ${formattedVars.join(", ")}`,
      );
    }

    // PostgreSQL Connection Pool
    poolInstance = new Pool({
      user: env[`${prefix}POSTGRES_USER`],
      host: env[`${prefix}POSTGRES_HOST`],
      database: env[`${prefix}POSTGRES_DATABASE`],
      password: env[`${prefix}POSTGRES_PASSWORD`],
      port: parseInt(env[`${prefix}POSTGRES_PORT`]!, 10),
      max: env[`${prefix}POSTGRES_MAX_CONNECTIONS`]
        ? parseInt(env[`${prefix}POSTGRES_MAX_CONNECTIONS`]!, 10)
        : 20, // Max number of clients in the pool
      idleTimeoutMillis: env[`${prefix}POSTGRES_IDLE_TIMEOUT`]
        ? parseInt(env[`${prefix}POSTGRES_IDLE_TIMEOUT`]!, 10)
        : 30000, // How long a client is allowed to remain idle before being closed
      connectionTimeoutMillis: env[`${prefix}POSTGRES_CONNECTION_TIMEOUT`]
        ? parseInt(env[`${prefix}POSTGRES_CONNECTION_TIMEOUT`]!, 10)
        : 2000, // How long to wait for a connection from the pool
    });
  } else if (config.loadFrom == "pool") {
    // Ensure pool is provided
    if (config.pool) {
      poolInstance = config.pool;
    } else {
      throw new Error("Must provide pool when loadFrom='pool'");
    }

    // Ensure envPrefix is not provided
    if (config.envPrefix) {
      throw new Error("Cannot provide envPrefix when loadFrom='pool'");
    }
  }

  // set up migration manager
  if (poolInstance) {
    poolInstance.on("error", (err) => {
      config.logger(
        "error",
        `Unexpected error on idle client in PostgreSQL pool: ${err.message}`,
      );
    });

    // Get the operation from command line arguments (use provided argv or fall back to process.argv)
    const args = config.argv || process.argv;
    const operation = args[2] || "help";
    const isDistributed = args.includes("--distributed");

    try {
      // Test database connection before proceeding
      const connected = await testConnection(
        poolInstance,
        config.logger,
        config.loadFrom,
        config.loadFrom === "env" ? config.envPrefix || "" : "",
        config.env,
      );

      if (!connected) {
        // Add a clear message about aborting the operation
        config.logger(
          "error",
          "\nAborting operation due to database connection failure.\n",
        );
        throw new Error("Database connection failure");
      }

      switch (operation) {
        case "run":
          await runMigrations(
            poolInstance,
            isDistributed ? "distributed" : "job",
            config.migrations,
            config.logger,
          );
          break;
        case "status":
          await showMigrationStatus(
            poolInstance,
            config.migrations,
            config.logger,
          );
          break;
        case "help":
        default:
          config.logger(
            "info",
            `
Strataline Database Migration CLI

Available commands:
  run         Run pending migrations
  status      Show migration status

Options:
  --distributed  Run migrations in distributed mode
`,
          );
          break;
      }
    } catch (error: any) {
      config.logger("error", `Error: ${error.message || String(error)}`);
      throw error; // Re-throw to allow caller to handle it
    } finally {
      await poolInstance.end();
    }
  } else {
    throw new Error("Database pool was not initialized properly");
  }
}
