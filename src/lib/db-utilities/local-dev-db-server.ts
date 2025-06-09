import { spawn } from "child_process";
import { access, writeFile, readFile, unlink, mkdir } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
import { userInfo } from "os";
import { Client } from "pg";
import { PostgresBinaries, getBinaries } from "./pg-bin-helper";

/**
 * Logger function type for LocalDevDBServer
 */
export type DevDBLoggerFunction = (
  type: "info" | "error" | "warn" | "pg" | "setup",
  message: string,
) => void;

/**
 * Exit handler function type for LocalDevDBServer
 * Called when the server wants to exit. If not provided, process.exit() will be called.
 */
export type DevDBExitHandler = (exitCode: number) => void;

/**
 * Console-based logger implementation for LocalDevDBServer
 * @param pgVerbose Whether to log verbose PostgreSQL messages
 * @param setupVerbose Whether to log verbose setup messages
 */
export const createDevDBConsoleLogger = (
  pgVerbose: boolean = true,
  setupVerbose: boolean = true,
): DevDBLoggerFunction => {
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
      case "setup":
        if (setupVerbose) {
          console.log(`[SETUP] ${message}`);
        }
        break;
    }
  };
};

/**
 * Helper function to check if a file exists (async equivalent of existsSync)
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current OS user in a cross-platform way
 */
function getCurrentUser(): string {
  // on Unix: USER, on Windows: USERNAME, else os.userInfo()
  const candidates = [
    process.env.USER,
    process.env.USERNAME,
    userInfo().username,
    "postgres", // final fallback
  ];

  // pick the first non-empty value
  for (const name of candidates) {
    if (name) {
      return name;
    }
  }

  // should never get here, but TS wants a return
  return "postgres";
}

/**
 * LocalDevDBServer class for managing a local PostgreSQL server for development.
 * This class handles initialization, starting, and proper termination of a PostgreSQL server.
 */

export class LocalDevDBServer {
  // Configuration properties
  private pgPort: number;
  private pgUser: string;
  private pgPass: string;
  private pgDb: string;
  private pgBinaries: PostgresBinaries | null = null;
  private pgDataDir: string;
  private pidFile: string;
  private logger?: DevDBLoggerFunction;
  private onExit?: DevDBExitHandler;
  private logConnections: boolean;
  private currentUser: string;

  // Process reference
  private pgProcess: ReturnType<typeof spawn> | null = null;

  // Track if cleanup is already in progress to prevent multiple cleanup calls
  private isCleaningUp: boolean = false;

  // Keep-alive interval to prevent Node.js from exiting while we wait for PostgreSQL
  private keepAliveInterval: NodeJS.Timeout | null = null;

  /**
   * Creates a new PostgresDevServer instance.
   *
   * @param config Configuration parameters
   */
  constructor(config: {
    port: number;
    user: string;
    password: string;
    database: string;
    dataDir: string;
    pidFile: string;
    logger?: DevDBLoggerFunction;
    onExit?: DevDBExitHandler;
    logConnections?: boolean;
  }) {
    // Initialize with provided config
    this.pgPort = config.port;
    this.pgUser = config.user;
    this.pgPass = config.password;
    this.pgDb = config.database;
    this.pgDataDir = config.dataDir;
    this.pidFile = config.pidFile;
    this.logger = config.logger;
    this.onExit = config.onExit;
    this.logConnections = config.logConnections ?? false;
    this.currentUser = getCurrentUser();

    // Register signal handlers
    this.registerSignalHandlers();
  }

  /**
   * Log a message if a logger is configured
   * @param type Message type
   * @param message Message content
   */
  private log(
    type: "info" | "error" | "warn" | "pg" | "setup",
    message: string,
  ): void {
    if (this.logger) {
      this.logger(type, message);
    }
  }

  /**
   * Handle exit with optional custom handler
   * @param exitCode Exit code to use
   */
  private handleExit(exitCode: number): void {
    if (this.onExit) {
      this.onExit(exitCode);
    } else {
      process.exit(exitCode);
    }
  }

  /**
   * Clean up keep-alive interval and exit
   * @param exitCode Exit code to use
   */
  private cleanupAndExit(exitCode: number): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    this.handleExit(exitCode);
  }

  /**
   * Handle graceful shutdown by forwarding the signal to PostgreSQL
   */
  private handleGracefulShutdown(): void {
    if (this.isCleaningUp) return;
    this.isCleaningUp = true;

    this.log("info", "\nShutting down PostgreSQL server...");

    if (this.pgProcess && this.pgProcess.pid) {
      // Start keep-alive interval to prevent Node.js from exiting
      this.keepAliveInterval = setInterval(() => {
        // This keeps the event loop alive while we wait for PostgreSQL
      }, 1000);

      // Forward SIGTERM to PostgreSQL for graceful shutdown
      this.pgProcess.kill("SIGTERM");

      // Set a reasonable timeout to prevent hanging forever
      setTimeout(() => {
        if (this.pgProcess && this.pgProcess.pid) {
          this.pgProcess.kill("SIGKILL");
        }

        // Give it a moment to die, then exit
        setTimeout(() => {
          this.cleanupAndExit(0);
        }, 1000);
      }, 10000); // 10 second timeout

      // PostgreSQL will exit gracefully, and our close handler will call cleanupAndExit(0)
    } else {
      // No PostgreSQL process, exit immediately
      this.cleanupAndExit(0);
    }
  }

  /**
   * Registers process signal handlers to ensure proper cleanup.
   */
  private registerSignalHandlers(): void {
    // Remove any existing SIGINT handlers to ensure we have full control
    process.removeAllListeners("SIGINT");

    // Set up signal handlers for graceful shutdown
    process.on("SIGINT", () => {
      this.handleGracefulShutdown();
    });

    process.on("SIGTERM", () => {
      this.handleGracefulShutdown();
    });

    process.on("SIGHUP", () => {
      this.handleGracefulShutdown();
    });

    process.on("uncaughtException", (err) => {
      if (this.isCleaningUp) return;
      this.log("error", `Uncaught exception: ${err}`);
      process.exit(1);
    });

    // Additional handlers to ensure cleanup when process exits
    process.on("exit", () => {
      // This is a synchronous handler, so we can't use async operations
      if (this.pgProcess && this.pgProcess.pid) {
        try {
          // Try to kill the process directly
          const pid = this.pgProcess.pid;
          if (pid) {
            this.killProcess(pid, "SIGKILL");
          }
        } catch (e) {
          // Process might already be gone
        }
      }
    });
  }

  /**
   * Checks if a process is running by PID.
   *
   * @param pid Process ID to check
   * @returns True if the process is running, false otherwise
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // Signal 0 doesn't send a signal but checks if process exists
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Kills a process by PID.
   *
   * @param pid Process ID to kill
   * @param signal Signal to send (default: SIGTERM)
   * @returns True if the process was killed, false otherwise
   */
  private killProcess(
    pid: number,
    signal: NodeJS.Signals = "SIGTERM",
  ): boolean {
    try {
      process.kill(pid, signal);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Cleans up any existing PostgreSQL processes.
   */
  private async cleanupExistingProcess(): Promise<void> {
    // First check our PID file
    if (await fileExists(this.pidFile)) {
      try {
        const pidContent = await readFile(this.pidFile, "utf8");
        const pid = parseInt(pidContent.trim(), 10);

        if (this.isProcessRunning(pid)) {
          this.log(
            "setup",
            `Found existing PostgreSQL process (PID: ${pid}), terminating...`,
          );
          this.killProcess(pid, "SIGTERM");

          // Wait for process to terminate (up to 10 attempts, 5 seconds total)
          let attempts = 0;

          while (this.isProcessRunning(pid) && attempts < 10) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            attempts++;
          }

          if (this.isProcessRunning(pid)) {
            this.log("setup", `Process ${pid} still running, force killing...`);
            this.killProcess(pid, "SIGKILL");
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        // Remove the PID file regardless
        await unlink(this.pidFile);
      } catch (e) {
        this.log("error", `Error cleaning up existing process: ${e}`);

        // Remove the PID file if it exists but is invalid
        try {
          await unlink(this.pidFile);
        } catch (err) {
          // Ignore errors
        }
      }
    }

    // Also check for postmaster.pid file in the data directory
    const postmasterPidFile = join(this.pgDataDir, "postmaster.pid");

    if (await fileExists(postmasterPidFile)) {
      try {
        // The first line of postmaster.pid contains the PID
        const content = await readFile(postmasterPidFile, "utf8");
        const pid = parseInt(content.split("\n")[0], 10);

        if (this.isProcessRunning(pid)) {
          this.log(
            "setup",
            `Found existing PostgreSQL process from postmaster.pid (PID: ${pid}), terminating...`,
          );
          this.killProcess(pid, "SIGTERM");

          // Wait for process to terminate (up to 10 attempts, 5 seconds total)
          let attempts = 0;

          while (this.isProcessRunning(pid) && attempts < 10) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            attempts++;
          }

          if (this.isProcessRunning(pid)) {
            this.log("setup", `Process ${pid} still running, force killing...`);
            this.killProcess(pid, "SIGKILL");
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        // Try to remove the postmaster.pid file
        try {
          await unlink(postmasterPidFile);
          this.log("setup", "Removed stale postmaster.pid file");
        } catch (err) {
          this.log("warn", `Could not remove postmaster.pid file: ${err}`);
        }
      } catch (e) {
        this.log("error", `Error reading or processing postmaster.pid: ${e}`);
      }
    }

    // Wait a moment to ensure all processes are fully terminated
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  /**
   * Stops the PostgreSQL server gracefully.
   */

  public async stop(): Promise<void> {
    this.handleGracefulShutdown();
  }

  /**
   * Runs a PostgreSQL command and returns the output.
   *
   * @param command Command to run
   * @param args Command arguments
   * @param options Command options
   * @returns Object containing stdout, stderr, and exit code
   */
  private async runPgCommand(
    command: string,
    args: string[],
    options: { user?: string; silent?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const { user = "postgres", silent = false } = options;

    if (!silent) {
      this.log("pg", `Running: ${command} ${args.join(" ")}`);
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";

      const childProcess = spawn(command, args, {
        stdio: "pipe", // Always use pipe to capture output
        detached: false, // Ensure process is not detached
        env: {
          ...process.env,
          PGPASSWORD: user === "postgres" ? "postgres" : this.pgPass,
        },
      });

      if (childProcess.stdout && childProcess.stderr) {
        childProcess.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        childProcess.stderr.on("data", (data) => {
          stderr += data.toString();
        });
      }

      childProcess.on("close", (code) => {
        resolve({
          stdout,
          stderr,
          code,
        });
      });
    });
  }

  /**
   * Creates a PostgreSQL client with connection options optimized for local development
   * @param user User to connect as
   * @param database Database to connect to
   * @returns Connected PostgreSQL client
   */
  private async createClient(
    user: string = "postgres",
    database: string = "postgres",
  ): Promise<Client> {
    const password = user === "postgres" ? "postgres" : this.pgPass;

    const client = new Client({
      host: "127.0.0.1", // Force IPv4 instead of localhost (which might resolve to IPv6)
      port: this.pgPort,
      user: user,
      password: password,
      database: database,
      // Increase timeouts to be more forgiving during startup
      connectionTimeoutMillis: 10000,
      query_timeout: 15000,
      // Add keepalive settings to match server configuration
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    await client.connect();
    return client;
  }

  /**
   * Initializes the PostgreSQL data directory if it doesn't exist.
   */
  private async initializeDataDirectory(): Promise<void> {
    // Check if PostgreSQL data directory exists and is initialized
    const configExists = await fileExists(
      join(this.pgDataDir, "postgresql.conf"),
    );

    if (!configExists) {
      this.log(
        "setup",
        `Initializing new PostgreSQL data directory at ${this.pgDataDir}...`,
      );

      // Create the data directory if it doesn't exist
      await mkdir(this.pgDataDir, { recursive: true });

      // Initialize the data directory
      const initResult = await this.runPgCommand(this.pgBinaries!.initdb, [
        "-D",
        this.pgDataDir,
      ]);

      if (initResult.code !== 0) {
        throw new Error("Failed to initialize PostgreSQL data directory");
      }
    } else {
      this.log(
        "setup",
        `PostgreSQL data directory already initialized at ${this.pgDataDir}.`,
      );
    }
  }

  /**
   * Starts the PostgreSQL server process.
   */
  private async startPostgresServer(): Promise<void> {
    this.log("setup", "Starting PostgreSQL server...");

    // Start PostgreSQL with optimized configuration
    //
    // IMPORTANT: We force IPv4-only connections to avoid TCP_NODELAY errors.
    //
    // Background: PostgreSQL on some systems (particularly with IPv6) can encounter
    // "setsockopt(TCP_NODELAY) failed: Invalid argument" errors when child processes
    // attempt to configure TCP socket options. This manifests as FATAL errors in logs
    // but doesn't prevent successful connections. However, these errors can indicate
    // real issues and may cause PostgreSQL to crash in some cases.
    //
    // Root cause: The issue occurs when PostgreSQL forks child processes to handle
    // connections, and these child processes fail to set TCP_NODELAY on IPv6 sockets
    // due to platform-specific socket handling differences.
    //
    // Solution: By forcing IPv4-only listening (listen_addresses=127.0.0.1) and
    // connecting via 127.0.0.1 instead of localhost, we avoid IPv6 entirely and
    // eliminate these socket configuration errors.
    this.pgProcess = spawn(
      this.pgBinaries!.postgres,
      [
        "-D",
        this.pgDataDir,
        "-p",
        this.pgPort.toString(),
        // Force IPv4 only to avoid TCP_NODELAY socket errors
        "-c",
        "listen_addresses=127.0.0.1",
        // Add TCP configuration for better connection handling
        "-c",
        "tcp_keepalives_idle=600",
        "-c",
        "tcp_keepalives_interval=30",
        "-c",
        "tcp_keepalives_count=3",
        // Increase connection limits to handle rapid connections better
        "-c",
        "max_connections=100",
        "-c",
        "superuser_reserved_connections=3",
        // Reduce authentication timeout to fail faster on bad connections
        "-c",
        "authentication_timeout=10s",
        // Optional connection logging (disabled by default for cleaner output)
        ...(this.logConnections
          ? ["-c", "log_connections=on", "-c", "log_disconnections=on"]
          : []),
      ],
      {
        stdio: "pipe", // Always use pipe to capture output
        detached: false, // Keep as child process so it dies when parent dies
      },
    );

    // Capture and optionally log PostgreSQL output
    if (this.pgProcess.stdout) {
      this.pgProcess.stdout.on("data", (data) => {
        if (this.logger) {
          this.log("pg", data.toString().trim());
        }
      });
    }

    if (this.pgProcess.stderr) {
      this.pgProcess.stderr.on("data", (data) => {
        if (this.logger) {
          this.log("pg", data.toString().trim());
        }
      });
    }

    // Save PID to file for future cleanup
    if (this.pgProcess.pid) {
      await writeFile(this.pidFile, this.pgProcess.pid.toString());

      this.log(
        "setup",
        `PostgreSQL server started with PID: ${this.pgProcess.pid}`,
      );
    }

    // Set up process close handler
    this.pgProcess.on("close", async (code) => {
      this.log("setup", `PostgreSQL server process exited with code ${code}`);

      // Clean up PID file
      try {
        await unlink(this.pidFile);
      } catch (e) {
        // File might already be gone, ignore error
      }

      this.pgProcess = null;

      // Forward the exit code from PG, default to 1 if not a number
      const exitCode = typeof code === "number" ? code : 1;
      this.cleanupAndExit(exitCode);
    });
  }

  /**
   * Waits for the PostgreSQL server to be ready to accept connections.
   *
   * @param maxAttempts Maximum number of attempts to check if the server is ready (default: 30)
   * Waits for the server to be ready to accept connections (up to 30 attempts, 1 second between attempts)
   * @returns True if the server is ready, false otherwise
   */

  private async waitForServerReady(maxAttempts = 30): Promise<boolean> {
    this.log("setup", "Waiting for PostgreSQL server to start...");

    let serverReady = false;
    let attempts = 0;

    while (!serverReady && attempts < maxAttempts) {
      try {
        // Try to make a single connection test using our optimized client method
        const currentUser = this.currentUser;
        const client = await this.createClient(currentUser, "postgres");

        await client.query("SELECT 1");
        await client.end();

        this.log("setup", "PostgreSQL server is ready to accept connections");
        serverReady = true;
      } catch (e) {
        attempts++;

        if (attempts % 5 === 0) {
          this.log(
            "setup",
            `Still waiting for PostgreSQL server... (attempt ${attempts}/${maxAttempts})`,
          );
        }

        // Only wait if we're going to try again
        if (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    if (!serverReady) {
      throw new Error("PostgreSQL server failed to start after 30 seconds");
    }

    return serverReady;
  }

  /**
   * Sets up PostgreSQL users and databases
   */
  private async setupUsersAndDatabases(): Promise<void> {
    // Get the current system user
    const currentUser = this.currentUser;

    // Connect as the current system user initially to set up postgres superuser
    let client = await this.createClient(currentUser, "postgres");

    try {
      // Check if postgres role exists using the current connection
      const postgresRoleResult = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname=$1",
        ["postgres"],
      );

      if (postgresRoleResult.rows.length === 0) {
        this.log(
          "setup",
          "Creating superuser 'postgres' with password 'postgres'...",
        );
        await client.query(
          "CREATE ROLE postgres WITH SUPERUSER LOGIN PASSWORD 'postgres'",
        );
      } else {
        this.log(
          "setup",
          "Superuser 'postgres' already exists. Resetting password to 'postgres'.",
        );
        await client.query("ALTER USER postgres WITH PASSWORD 'postgres'");
      }
    } finally {
      await client.end();
    }

    // Now connect as postgres user to create the app user and database
    client = await this.createClient("postgres", "postgres");

    try {
      // Check if app user exists
      const appUserResult = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname=$1",
        [this.pgUser],
      );

      if (appUserResult.rows.length === 0) {
        this.log("setup", `Creating user ${this.pgUser}...`);
        // Note: User names and passwords cannot be parameterized in DDL statements
        // We need to escape the password value manually
        const escapedPassword = this.pgPass.replace(/'/g, "''"); // Escape single quotes
        await client.query(
          `CREATE USER "${this.pgUser}" WITH PASSWORD '${escapedPassword}'`,
        );
      } else {
        this.log("setup", `User ${this.pgUser} already exists.`);
      }

      // Check if database exists using the same connection
      const dbResult = await client.query(
        "SELECT 1 FROM pg_database WHERE datname=$1",
        [this.pgDb],
      );

      if (dbResult.rows.length === 0) {
        this.log(
          "setup",
          `Creating database ${this.pgDb} owned by ${this.pgUser}...`,
        );

        // Note: Database and user names cannot be parameterized
        await client.query(
          `CREATE DATABASE "${this.pgDb}" OWNER "${this.pgUser}"`,
        );
      } else {
        this.log("setup", `Database ${this.pgDb} already exists.`);
      }
    } finally {
      await client.end();
    }
  }

  /**
   * Starts the PostgreSQL server and sets up users and databases.
   */
  public async start(): Promise<void> {
    if (this.pgProcess) {
      this.log("warn", "PostgreSQL is already running, skipping start()");
      return;
    }

    this.pgBinaries = await getBinaries();

    this.log("setup", `Using PostgreSQL binaries: ${this.pgBinaries.postgres}`);
    try {
      // Clean up any existing PostgreSQL processes
      await this.cleanupExistingProcess();

      // Initialize data directory if needed
      await this.initializeDataDirectory();

      // Start PostgreSQL server
      await this.startPostgresServer();

      // Wait for server to be ready
      await this.waitForServerReady();

      // Set up users and databases
      await this.setupUsersAndDatabases();

      this.log("info", `PostgreSQL server is running on port ${this.pgPort}`);
      this.log("info", `Database: ${this.pgDb}`);
      this.log("info", `User: ${this.pgUser}`);
      this.log("info", `Password: ${this.pgPass}`);
      this.log("info", "Press Ctrl+C to stop the server");
    } catch (error) {
      this.log("error", `Error starting PostgreSQL server: ${error}`);
      process.exit(1);
    }
  }
}
