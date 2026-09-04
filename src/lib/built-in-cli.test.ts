import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Pool } from "pg";
import { RunStratalineCLI, STRATALINE_EXIT_CODES } from "./built-in-cli";
import {
  createConsoleLogger,
  type LogDataInput,
  type LogLevel,
  type Logger,
} from "./logger";
import { TestDatabaseInstance } from "./db-utilities/test-db-instance";
import { Migration } from "./migration-system";

// Control whether to show logs during RunStratalineCLI tests
const CLI_TESTS_VERBOSE_LOGGING = false; // Set to true to see logs during test execution

describe("createConsoleLogger", () => {
  it("should create a logger", () => {
    const logger = createConsoleLogger();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
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
      const logger = createConsoleLogger();

      // Test regular log types
      logger.info({ message: "Test info message" });
      logger.error({ message: "Test error message" });
      logger.warn({ message: "Test warning message" });

      // Test migration log types
      logger.info({ source: "migration", message: "Test migration info" });
      logger.error({ source: "migration", message: "Test migration error" });
      logger.warn({ source: "migration", message: "Test migration warning" });

      // Verify console.log calls
      expect(mockLog).toHaveBeenCalledTimes(2);
      expect(mockLog).toHaveBeenCalledWith("Test info message");
      expect(mockLog).toHaveBeenCalledWith("[MIGRATION] Test migration info");

      // Verify console.error calls
      expect(mockError).toHaveBeenCalledTimes(2);
      expect(mockError).toHaveBeenCalledWith("Test error message");
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] Test migration error",
      );

      // Verify console.warn calls
      expect(mockWarn).toHaveBeenCalledTimes(2);
      expect(mockWarn).toHaveBeenCalledWith("Test warning message");
      expect(mockWarn).toHaveBeenCalledWith(
        "[MIGRATION] Test migration warning",
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
      const logger = createConsoleLogger({ migration: false });

      // Regular info should still be logged
      logger.info({ message: "Regular info" });

      // Migration info should be suppressed
      logger.info({ source: "migration", message: "Migration info" });

      // Verify console.log was only called once for regular info
      expect(mockLog).toHaveBeenCalledTimes(1);
      expect(mockLog).toHaveBeenCalledWith("Regular info");
      expect(mockLog).not.toHaveBeenCalledWith("[MIGRATION] Migration info");
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

  // Mock logger to capture logs. Two axes now: the level is the method that
  // was called, the source is a field, and `type` is the pair spelled the way
  // the old tags were so the assertions below still read the same.
  type LogEntry = {
    type: string;
    level: LogLevel;
    source?: string;
    task?: string;
    stage?: string;
    message: string;
    error?: any;
  };
  let logEntries: LogEntry[];
  let mockLogger: Logger;

  // Test database instance
  let testDb: TestDatabaseInstance;

  beforeEach(async () => {
    // Reset log entries
    logEntries = [];
    const record = (level: LogLevel) => (data: LogDataInput) => {
      logEntries.push({
        type: data.source ? `${data.source}-${level}` : level,
        level,
        source: data.source,
        task: data.task,
        stage: data.stage,
        message: data.message,
        error: data.error,
      });

      if (CLI_TESTS_VERBOSE_LOGGING) {
        // Use the actual CLI logger to print to console, respecting its
        // formatting. Pass `true` for migrateVerbose so everything shows.
        createConsoleLogger()[level](data);
      }
    };

    mockLogger = {
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
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

        // ctx.logger stamps the migration id as `task` and the phase as
        // `stage`, and they arrive as FIELDS. They used to reach here baked
        // into the message, because the adapter in between rendered them into
        // a string on the way past; now nothing renders until a sink does, so
        // a caller can group by migration without parsing anything.
        const inThisPhase = (entry: LogEntry, level: LogLevel) =>
          entry.type === `migration-${level}` &&
          entry.task === migrationId &&
          entry.stage === "dataMigration";

        const infoLog = logEntries.find(
          (entry) => inThisPhase(entry, "info") && entry.message === logMessage,
        );
        expect(infoLog).toBeDefined();

        const warnLog = logEntries.find(
          (entry) =>
            inThisPhase(entry, "warn") && entry.message === warnMessage,
        );
        expect(warnLog).toBeDefined();

        const errorLog = logEntries.find(
          (entry) =>
            inThisPhase(entry, "error") && entry.message === errorMessage,
        );
        expect(errorLog).toBeDefined();

        // The error object itself, not its message spliced into the string.
        // The old adapter could only hand over text, so this was asserted to be
        // undefined; keeping the object is what the structured shape buys.
        expect(errorLog?.error).toBe(errorObject);

        // MigrationManager's own bookkeeping line, which deliberately does
        // NOT carry `stage`: it uses the task-only logger and names the phase
        // in the message itself, so that a line about the phase is not
        // prefixed with the phase as well. See runDataMigrationPhase.
        const migrationManagerSuccessLog = logEntries.find(
          (entry) =>
            entry.type === "migration-info" &&
            entry.task === migrationId &&
            entry.stage === undefined &&
            entry.message ===
              "[dataMigration] Data migration marked as complete via callback.",
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

  describe("the outcomes a run can end in, and the code each reports", () => {
    /**
     * Every way `run` can finish that is not a completion, and the exit code
     * the CLI promises for it.
     *
     * These matter more than most branches because the exit code is the API
     * for a wrapper script, and it is the one part of this a caller consumes
     * without reading a log line. `error` is absent on purpose: it is thrown
     * rather than returned, so that callers who only `.catch` still exit
     * non-zero, and the throwing is covered elsewhere in this file.
     */
    /**
     * One CLI call, on a pool of its own.
     *
     * Not `testDb.getPool()`, because pool mode ADOPTS the pool it is given
     * and ends it in a finally on the way out, caller-supplied or not. Sharing
     * the fixture's pool would work exactly once and then fail the next thing
     * to touch it with "Cannot use a pool after calling end on the pool" --
     * which is how the locked test below, needing a setup query and then a
     * run, found this out.
     */
    const run = (migrations: Migration[], signal?: AbortSignal) => {
      const credentials = testDb.getCredentials();

      if (!credentials) {
        throw new Error("Failed to get test database credentials");
      }

      return RunStratalineCLI({
        migrations,
        loadFrom: "pool",
        pool: new Pool(credentials),
        logger: mockLogger,
        argv: ["node", "script.js", "run"],
        signal,
      });
    };

    const warnings = () =>
      logEntries
        .filter((entry) => entry.level === "warn")
        .map((entry) => entry.message)
        .join("\n");

    it("reports a completed run as 0", async () => {
      const result = await run([
        {
          id: "outcome-complete",
          description: "Completes",
          migration: async (_pool, ctx) => ctx.complete(),
        },
      ]);

      expect(result).toMatchObject({
        command: "run",
        status: "completed",
        exitCode: 0,
      });
    });

    it("reports a migration that paused itself as 2, without throwing", async () => {
      // A deferral is a deliberate pause, so it is returned rather than
      // thrown. A staged rollout ends here on purpose and must not read as a
      // failed deploy.
      const result = await run([
        {
          id: "outcome-defer",
          description: "Defers",
          migration: async (_pool, ctx) =>
            ctx.defer("waiting for the backfill"),
        },
      ]);

      expect(result).toMatchObject({ status: "deferred", exitCode: 2 });
      expect(result.reason ?? "").toContain("waiting for the backfill");
      expect(warnings()).toContain("deferred");
    });

    it("reports a run another process is holding as 3", async () => {
      // Someone else has the lock. Not a failure: the migrations are being
      // applied, just not by this process, which is the ordinary case for
      // several replicas starting at once.
      //
      // Held by writing the row a second process would have written, rather
      // than by standing up a second manager. The lock IS that row, an unheld
      // one is the absence of it, and a real competitor is another host and
      // pid entirely -- which is a string here and a whole process otherwise.
      // The fixture's own pool, which nothing here ends, for the two direct
      // statements. The runs get their own, per `run` above.
      const pool = testDb.getPool() as Pool;

      // The lock table is created by the first run, so there has to be one
      // before there is anywhere to write the row.
      await run([]);

      const expiry = new Date(Date.now() + 5 * 60 * 1000);

      await pool.query(
        `INSERT INTO migration_lock (lock_name, locked_by, locked_at, lock_expires_at)
         VALUES ($1, $2, now(), $3)
         ON CONFLICT (lock_name) DO UPDATE
           SET locked_by = EXCLUDED.locked_by,
               locked_at = EXCLUDED.locked_at,
               lock_expires_at = EXCLUDED.lock_expires_at`,
        ["database_migrations", "another-host-4242-1", expiry],
      );

      logEntries = [];

      try {
        const result = await run([
          {
            id: "outcome-locked",
            description: "Never reached",
            migration: async (_pool, ctx) => ctx.complete(),
          },
        ]);

        expect(result).toMatchObject({ status: "locked", exitCode: 3 });
        expect(result.reason ?? "").toContain("Another process");
        expect(warnings()).toContain("skipped");
      } finally {
        await pool.query("DELETE FROM migration_lock WHERE lock_name = $1", [
          "database_migrations",
        ]);
      }
    });

    it("reports a run stopped by its own signal as 4", async () => {
      const controller = new AbortController();

      // Aborted from inside the migration, which is where a real shutdown
      // lands: the signal is how a caller asks a long run to wind down, and
      // the run gets to finish the unit it is on.
      const result = await run(
        [
          {
            id: "outcome-abort",
            description: "Winds down when asked",
            migration: async (_pool, ctx) => {
              controller.abort();
              ctx.defer("shutting down");
            },
          },
        ],
        controller.signal,
      );

      const status = result.status;

      if (status === undefined) {
        throw new Error("A run command always reports a status");
      }

      // Either of the two is a correct reading of that sequence, and which one
      // it is depends on where the abort is noticed rather than on anything a
      // caller controls. Both are non-failures, and each carries its own code.
      expect(["aborted", "deferred"]).toContain(status);
      expect(result.exitCode).toBe(STRATALINE_EXIT_CODES[status]);
    });

    it("gives every outcome its own code", () => {
      // The codes are the contract, so a reordering that made two outcomes
      // indistinguishable would be caught here rather than by a deploy script
      // treating a deferral as a clean run.
      const codes = Object.values(STRATALINE_EXIT_CODES);

      expect(new Set(codes).size).toBe(codes.length);
      expect(STRATALINE_EXIT_CODES.completed).toBe(0);
      expect(STRATALINE_EXIT_CODES.error).toBe(1);
    });
  });

  describe("configuration that is rejected before anything is opened", () => {
    /**
     * A complete env, so each test below can spoil exactly one value.
     *
     * Every assertion here runs without a database on purpose. Validation
     * happens before `new Pool` is reached, so a bad number is refused rather
     * than carried into a connection attempt that fails later and blames the
     * network for a typo in a config file.
     */
    const validEnv = (): Record<string, string | undefined> => ({
      POSTGRES_USER: "u",
      POSTGRES_PASSWORD: "p",
      POSTGRES_DATABASE: "d",
      POSTGRES_HOST: "127.0.0.1",
      POSTGRES_PORT: "5432",
    });

    const run = (env: Record<string, string | undefined>) =>
      RunStratalineCLI({
        migrations: [],
        loadFrom: "env",
        logger: mockLogger,
        argv: ["node", "script.js", "help"],
        env,
      });

    it("refuses a port that is not a number, and says which variable", () => {
      // The name is in the message because the prefix means the variable a
      // person has to go and fix is not the one named in the docs.
      return expect(
        run({ ...validEnv(), POSTGRES_PORT: "abc" }),
      ).rejects.toThrow("Invalid POSTGRES_PORT");
    });

    it("refuses a port outside the range a port can take", () => {
      // parseInt is happy with both of these, which is the whole reason the
      // range is checked separately from the parse.
      return Promise.all([
        expect(run({ ...validEnv(), POSTGRES_PORT: "0" })).rejects.toThrow(
          "must be a valid port number (1-65535)",
        ),
        expect(run({ ...validEnv(), POSTGRES_PORT: "70000" })).rejects.toThrow(
          "must be a valid port number (1-65535)",
        ),
      ]);
    });

    it("names the prefixed variable when a prefix is in use", () => {
      return expect(
        RunStratalineCLI({
          migrations: [],
          loadFrom: "env",
          envPrefix: "API_",
          logger: mockLogger,
          argv: ["node", "script.js", "help"],
          env: {
            API_POSTGRES_USER: "u",
            API_POSTGRES_PASSWORD: "p",
            API_POSTGRES_DATABASE: "d",
            API_POSTGRES_HOST: "127.0.0.1",
            API_POSTGRES_PORT: "not-a-port",
          },
        }),
      ).rejects.toThrow("Invalid API_POSTGRES_PORT");
    });

    it("refuses a pool size that is not a positive number", () => {
      return Promise.all([
        expect(
          run({ ...validEnv(), POSTGRES_MAX_CONNECTIONS: "0" }),
        ).rejects.toThrow(
          "POSTGRES_MAX_CONNECTIONS: must be a positive number",
        ),
        expect(
          run({ ...validEnv(), POSTGRES_MAX_CONNECTIONS: "lots" }),
        ).rejects.toThrow(
          "POSTGRES_MAX_CONNECTIONS: must be a positive number",
        ),
      ]);
    });

    it("refuses negative timeouts but allows zero", () => {
      // Zero is a real setting for both of these rather than a missing value,
      // which is why they are checked for negativity and the pool size is
      // checked for positivity.
      return Promise.all([
        expect(
          run({ ...validEnv(), POSTGRES_IDLE_TIMEOUT: "-1" }),
        ).rejects.toThrow("POSTGRES_IDLE_TIMEOUT: must be a non-negative"),
        expect(
          run({ ...validEnv(), POSTGRES_CONNECTION_TIMEOUT: "-1" }),
        ).rejects.toThrow(
          "POSTGRES_CONNECTION_TIMEOUT: must be a non-negative",
        ),
      ]);
    });

    it("refuses a pool mode with no pool", () => {
      return expect(
        RunStratalineCLI({
          migrations: [],
          loadFrom: "pool",
          logger: mockLogger,
          argv: ["node", "script.js", "help"],
        }),
      ).rejects.toThrow("Must provide pool when loadFrom='pool'");
    });

    /**
     * A pool whose close fails, which is what a reused one does.
     *
     * `RunStratalineCLI` adopts the pool it is given and closes it on the way
     * out, so handing it the same pool twice has pg reject the second close
     * with "Called end on pool more than once". Stubbed rather than provoked
     * with two real runs, because the point is what happens to the FIRST
     * error when the close fails, and a stub says which error that was without
     * depending on pg's wording.
     */
    const poolThatWillNotClose = (
      onQuery: () => Promise<unknown>,
    ): { pool: Pool; closeAttempts: () => number } => {
      let attempts = 0;

      return {
        pool: {
          on: () => {},
          connect: async () => ({
            query: onQuery,
            release: () => {},
          }),
          query: onQuery,
          end: async () => {
            attempts++;

            throw new Error("Called end on pool more than once");
          },
        } as unknown as Pool,
        closeAttempts: () => attempts,
      };
    };

    it("reports the run's own failure, not a pool that would not close", async () => {
      const { pool, closeAttempts } = poolThatWillNotClose(() => {
        throw new Error("the real diagnosis");
      });

      // The close still runs, and still says so in the log. What it must not
      // do is take the place of the error being reported: a `finally` that
      // awaited it replaced the reason the run failed with a message about
      // closing, which names neither the cause nor anything to act on.
      await expect(
        RunStratalineCLI({
          migrations: [],
          loadFrom: "pool",
          pool,
          logger: mockLogger,
          argv: ["node", "script.js", "run"],
        }),
      ).rejects.toThrow("Database connection failure");

      expect(closeAttempts()).toBe(1);

      expect(
        logEntries.some(
          (entry) =>
            entry.level === "error" &&
            entry.message.includes("could not close the PostgreSQL pool"),
        ),
      ).toBe(true);
    });

    it("still raises a close failure when the run itself succeeded", async () => {
      const { pool, closeAttempts } = poolThatWillNotClose(async () => ({
        rows: [{ ok: 1 }],
      }));

      // Nothing to displace here, and a pool that will not close is a leaked
      // resource rather than noise, so this one is the news.
      //
      // A guard rather than a regression test, and worth saying which: the
      // `finally` this replaced also let a close failure out on the success
      // path, so this passes against both. It is here to stop the fix above
      // being over-applied into swallowing every close failure.
      await expect(
        RunStratalineCLI({
          migrations: [],
          loadFrom: "pool",
          pool,
          logger: mockLogger,
          argv: ["node", "script.js", "help"],
        }),
      ).rejects.toThrow("Called end on pool more than once");

      expect(closeAttempts()).toBe(1);
    });

    it("refuses an envPrefix alongside a pool, without ending that pool", async () => {
      const pool = testDb.getPool();

      if (!pool) {
        throw new Error("Failed to get test database pool");
      }

      // The refusal has to come before the pool is adopted. Once it is, the
      // run owns it and closes it on the way out -- the CALLER's pool, which
      // they are still using.
      await expect(
        RunStratalineCLI({
          migrations: [],
          loadFrom: "pool",
          pool: pool as Pool,
          envPrefix: "API_",
          logger: mockLogger,
          argv: ["node", "script.js", "help"],
        }),
      ).rejects.toThrow("Cannot provide envPrefix when loadFrom='pool'");

      // Still usable, which is the half of that rule a message cannot assert.
      const alive = await (pool as Pool).query("SELECT 1 AS ok");

      expect(alive.rows[0].ok).toBe(1);
    });
  });

  describe("a database that will not answer", () => {
    /**
     * A port nothing is listening on, so the connect is refused at once.
     *
     * The failure itself is not the point. What is being checked is that the
     * CLI says which settings it tried, because "connection refused" against
     * an unnamed host is the least actionable thing a person can be handed,
     * and the two modes have to say different things: an env-mode failure is
     * usually a typo in a variable, a pool-mode one is the caller's own
     * configuration and naming variables would send them to the wrong file.
     */
    const deadEnd = { host: "127.0.0.1", port: 1 };

    it("names the environment variables it tried", async () => {
      const env: Record<string, string | undefined> = {
        POSTGRES_USER: "nobody",
        POSTGRES_PASSWORD: "nothing",
        POSTGRES_DATABASE: "nowhere",
        POSTGRES_HOST: deadEnd.host,
        POSTGRES_PORT: String(deadEnd.port),
      };

      await expect(
        RunStratalineCLI({
          migrations: [],
          loadFrom: "env",
          logger: mockLogger,
          argv: ["node", "script.js", "help"],
          env,
        }),
      ).rejects.toThrow("Database connection failure");

      const reported = logEntries
        .filter((entry) => entry.type === "error")
        .map((entry) => entry.message)
        .join("\n");

      expect(reported).toContain("Error connecting to database");
      // The values, so the reader can see which one is wrong.
      expect(reported).toContain("nowhere");
      expect(reported).toContain(String(deadEnd.port));
      expect(reported).toContain("nobody");
    });

    it("points at the supplied pool rather than at variables", async () => {
      const pool = new Pool({
        host: deadEnd.host,
        port: deadEnd.port,
        user: "nobody",
        password: "nothing",
        database: "nowhere",
        connectionTimeoutMillis: 2000,
      });

      await expect(
        RunStratalineCLI({
          migrations: [],
          loadFrom: "pool",
          pool,
          logger: mockLogger,
          argv: ["node", "script.js", "help"],
        }),
      ).rejects.toThrow("Database connection failure");

      const reported = logEntries
        .filter((entry) => entry.type === "error")
        .map((entry) => entry.message)
        .join("\n");

      expect(reported).toContain("provided database pool");
      // Naming variables here would send the reader to a file that has
      // nothing to do with how this pool was built.
      expect(reported).not.toContain("POSTGRES_HOST");
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
      const logger = createConsoleLogger();

      // Test migration error logging
      logger.error({
        source: "migration",
        message: "[beforeSchema] Failed to create table: error details",
      });
      logger.error({
        source: "migration",
        message: "[dataMigration] Failed to insert data: error details",
      });
      logger.error({
        source: "migration",
        message: "[afterSchema] Failed to create index: error details",
      });

      // Verify console.error calls with proper prefixes
      expect(mockError).toHaveBeenCalledTimes(3);
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] [beforeSchema] Failed to create table: error details",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] [dataMigration] Failed to insert data: error details",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] [afterSchema] Failed to create index: error details",
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
      const logger = createConsoleLogger();

      // Simulate errors from different migration phases
      const beforeSchemaError = new Error("Error in beforeSchema phase");
      const dataMigrationError = new Error("Error in dataMigration phase");
      const afterSchemaError = new Error("Error in afterSchema phase");

      // Log errors with phase prefixes
      logger.error({
        source: "migration",
        message: `[beforeSchema] ${beforeSchemaError.message}`,
      });
      logger.error({
        source: "migration",
        message: `[dataMigration] ${dataMigrationError.message}`,
      });
      logger.error({
        source: "migration",
        message: `[afterSchema] ${afterSchemaError.message}`,
      });

      // Verify error messages are logged with correct prefixes
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] [beforeSchema] Error in beforeSchema phase",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] [dataMigration] Error in dataMigration phase",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] [afterSchema] Error in afterSchema phase",
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
      const logger = createConsoleLogger();

      // Test migration errors with different phase prefixes
      logger.error({
        source: "migration",
        message: "[beforeSchema] Error in schema creation",
      });
      logger.error({
        source: "migration",
        message: "[dataMigration] Error in data migration",
      });
      logger.error({
        source: "migration",
        message: "[afterSchema] Error in post-schema operations",
      });

      // Verify console.error calls preserve the phase prefixes
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] [beforeSchema] Error in schema creation",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] [dataMigration] Error in data migration",
      );
      expect(mockError).toHaveBeenCalledWith(
        "[MIGRATION] [afterSchema] Error in post-schema operations",
      );
    } finally {
      // Restore original console methods
      console.error = originalError;
    }
  });

  // Test with actual migration errors - separate tests for each phase
  describe("should handle real migration errors correctly", () => {
    // Create a test logger
    const createTestLogger = (verbose = CLI_TESTS_VERBOSE_LOGGING) => {
      const capturedErrors: string[] = [];
      const say =
        (level: LogLevel) =>
        (data: LogDataInput): void => {
          if (verbose) {
            console.log(
              `Logger: [${data.source ? `${data.source}-` : ""}${level}] ${data.message}`,
            );
          }

          // Every error, whichever source it came from. That is both halves of
          // what "error" and "migrate-error" used to name between them.
          if (level === "error") {
            capturedErrors.push(data.message);
          }
        };

      const testLogger: Logger = {
        info: say("info"),
        warn: say("warn"),
        error: say("error"),
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
          throw new Error(`Cannot connect to test database: ${error.message}`, {
            cause: error,
          });
        }

        // Define a simple migration that fails in the beforeSchema phase
        const beforeSchemaErrorMigration: Migration = {
          id: "error_before_schema",
          description: "This migration fails in the beforeSchema phase",
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
            // Log cleanup error but don't throw to avoid masking the original test error
            console.error(
              `Failed to stop test database during cleanup: ${(e as Error).message}`,
            );
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
          throw new Error(`Cannot connect to test database: ${error.message}`, {
            cause: error,
          });
        }

        // Define a simple migration that fails in the dataMigration phase
        const dataMigrationErrorMigration: Migration = {
          id: "error_data_migration",
          description: "This migration fails in the dataMigration phase",
          beforeSchema: async (client) => {
            // Should complete successfully
            await client.query("SELECT 1");
          },
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
            // Log cleanup error but don't throw to avoid masking the original test error
            console.error(
              `Failed to stop test database during cleanup: ${(e as Error).message}`,
            );
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
          throw new Error(`Cannot connect to test database: ${error.message}`, {
            cause: error,
          });
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
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
            // Log cleanup error but don't throw to avoid masking the original test error
            console.error(
              `Failed to stop test database during cleanup: ${(e as Error).message}`,
            );
          }
        }
      }
    });
  });
});
