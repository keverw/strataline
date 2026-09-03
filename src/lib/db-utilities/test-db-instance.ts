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
import { isProcessAlive, readPostmasterPidFile } from "./pid-file";
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

/**
 * True when a start failed because PostgreSQL could not take the port.
 *
 * Read out of the server's own output, because there is nothing else to read:
 * `EmbeddedPostgres.start()` rejects with a bare `reject()` on the child's
 * `close`, so every way a start can fail arrives as the same `undefined`.
 *
 * Matched across the WHOLE attempt rather than the last thing written, which
 * is the mistake this encodes against. PostgreSQL reports a taken port over
 * several lines and the bind line is never the last of them:
 *
 *   LOG:  could not bind IPv6 address "::1": Address already in use
 *   WARNING:  could not create listen socket for "localhost"
 *   FATAL:  could not create any TCP/IP sockets
 *   LOG:  database system is shut down
 *
 * Testing only the final chunk tests the shutdown notice, which matches
 * nothing, so the retry never ran at all.
 *
 * The socket-creation lines are matched as well as the bind line because a
 * host with IPv6 disabled, or one where only one address family is taken,
 * reaches the same failure by a different sentence.
 *
 * @internal Exported so the match can be checked against real PostgreSQL
 * output without provoking a port collision.
 */
export function isBindFailure(output: string): boolean {
  return /could not bind|address already in use|could not create any TCP\/IP sockets|could not create listen socket/i.test(
    output,
  );
}

/**
 * An embedded server whose port can be changed between starts.
 *
 * Here so the bind retry can reuse one instance rather than construct a
 * second, which is not a tidiness point. `EmbeddedPostgres` adds `this` to a
 * module-level set from its CONSTRUCTOR, not from `initialise()`, and nothing
 * ever removes an entry: its own exit hook then calls `stop()` on every
 * instance ever built. A start that failed leaves `this.process` pointing at
 * the postmaster that has already exited, and `stop()` waits for an `exit`
 * event that fired before its listener was attached and will not fire again —
 * the same never-ending wait {@link TestDatabaseInstance.stopServerWithinBound}
 * bounds, except that call is embedded-postgres's own and cannot be bounded
 * from here. So an abandoned attempt costs ten seconds of async-exit-hook's
 * force-exit timeout at the end of the run.
 *
 * Rebuilding per attempt therefore turned a SUCCESSFUL start into a stalled
 * exit, on a path a run reaches by having lost a port rather than by having
 * gone wrong. Reusing the instance registers nothing extra, so a start that
 * retried and then worked exits as promptly as one that never retried.
 *
 * `start()` reads `this.options.port` when it SPAWNS rather than caching it, so
 * rebinding it between attempts is the whole of what this needs. That reading
 * is the load-bearing half and no type expresses it: an upstream that moved
 * the read into the constructor would compile unchanged here and silently
 * start on the old port, which is a taken port, which is the bug this exists
 * to avoid arrived at from the other side. A subclass rather than a cast for
 * the half that IS checked — `options` is `protected` and its `port` a
 * documented, mutable field, so the compiler at least holds us to the shape.
 *
 * What this does NOT fix is the single instance a start that fails outright
 * leaves behind. That one is embedded-postgres's to fix, and is upstream as
 * leinelissen/embedded-postgres#32.
 */
class RetargetablePostgres extends EmbeddedPostgres {
  /** Points the next `start()` at a different port. */
  setPort(port: number): void {
    this.options.port = port;
  }
}

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
    // Routine output only, as with migration lines below: a PostgreSQL
    // warning or error is not what `pgVerbose: false` was asking to be spared.
    if (!this.pgVerbose && level === "info" && data.source === "pg") {
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
  private db?: RetargetablePostgres;
  private pool?: Pool;
  private migrationsApplied: boolean = false;
  private tempDir?: string;
  private port: number;
  /**
   * Whether {@link findFreePort} chose the port, rather than the caller.
   *
   * The retry below is allowed only on a port this picked. See
   * {@link startWithPortRetry}.
   */
  private readonly portChosenAutomatically: boolean;
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
    // Settled once, from the caller's own option, and never recomputed. See
    // the note in start().
    this.portChosenAutomatically = !this.port;
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

  /** How long a stop is given before it is treated as already done. */
  private static readonly STOP_TIMEOUT_MS = 10_000;

  /**
   * Stops the server under a bound, because the stop it calls can never
   * return.
   *
   * Reported upstream as leinelissen/embedded-postgres#32, "stop() never
   * resolves if the postmaster already exited, so the exit hook stalls process
   * exit by 10s", open since July 2026 and unchanged in the 18.4.0-beta.17
   * this depends on. Watch that issue rather than this comment: when it is
   * fixed the bound below becomes dead weight and can go.
   *
   * `EmbeddedPostgres.stop()` waits for the child's `exit` event and sends
   * SIGINT to provoke it:
   *
   *     await new Promise((resolve) => {
   *       this.process?.on('exit', resolve);
   *       this.process?.kill('SIGINT');
   *     });
   *
   * A postmaster that has ALREADY exited fired that event before the listener
   * was attached, and Node does not replay it. The handle is still set, so the
   * guard above it passes, and the promise is waited on forever.
   *
   * Which is precisely the state a failed start leaves: the postmaster wrote
   * why it could not start and died, and cleanup() then asks for it to be
   * stopped. So every failed start hung here rather than rejecting, whatever
   * the reason for it, and the caller was left with no error at all instead of
   * the one PostgreSQL had already written. A port that could not be bound is
   * the way this was found; an incompatible data directory or exhausted shared
   * memory reach it identically.
   *
   * A bound rather than a fix, since the wait belongs to somebody else's code.
   * Giving up on it is safe in the case that produces it, because the process
   * being gone is the whole reason the event never came.
   *
   * Which is why the timeout alone does not settle it. A postmaster that is
   * merely SLOW reaches the same timeout: `stop()` sends SIGINT, PostgreSQL
   * reads that as a fast shutdown, and writing the shutdown checkpoint on a
   * loaded machine can take longer than the bound. Treating that as "it had
   * already exited" hands cleanup() a live server and it deletes the data
   * directory out from under it. So a timeout asks the cluster whether it is
   * still there — its own postmaster.pid, which PostgreSQL removes only on a
   * clean exit — and reports which of the two happened. A PID that has been
   * recycled reads as still running, which errs toward leaving a temporary
   * directory behind rather than removing a live cluster's.
   *
   * What this does NOT cover is the second half of that issue. embedded-postgres
   * keeps a module-level set of every instance it CONSTRUCTS, never prunes it,
   * and calls `stop()` on all of them from its own exit hook. That call is not
   * this one and cannot be bounded from here, so a postmaster that died out of
   * band can still add its ten seconds to process exit.
   *
   * What that leaves is a rule about ABANDONED instances, of which the number
   * to aim at is zero rather than few. The cost does not scale with the count:
   * their hook stops every instance under one `Promise.all` and async-exit-hook
   * arms a single force-exit timer over the whole set, so five stalled
   * instances cost the same ten seconds as one. What a second instance buys is
   * therefore nothing at all, which is why {@link RetargetablePostgres} exists
   * and why the bind retry rebinds a port rather than building again. A start
   * that fails and is started again does build a second, correctly: `cleanup()`
   * has dropped the first by then, so the rule is one per start, not one per
   * instance of this class.
   *
   * Clearing the child reference their exit hook reads would cure the stall
   * outright and is still not done. That one is `private`, it would have to be
   * gated on the child being confirmed dead — clearing it makes their `stop()`
   * early-return, so a survivor would be left unsignaled rather than sent the
   * fast-shutdown SIGINT that call otherwise sends it — and a stalled exit on a
   * start that has already failed is cheaper than depending on the shape of
   * somebody else's internals to that depth.
   */
  private async stopServerWithinBound(
    db: EmbeddedPostgres,
  ): Promise<"stopped" | "still-running"> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const abandoned = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(
        () => resolve("timed-out"),
        TestDatabaseInstance.STOP_TIMEOUT_MS,
      );
    });

    try {
      const outcome = await Promise.race([
        db.stop().then(() => "stopped" as const),
        abandoned,
      ]);

      if (outcome === "stopped") {
        return "stopped";
      }

      if (await this.serverStillRunning()) {
        this.log(
          "warn",
          "Stopping embedded PostgreSQL did not return within " +
            `${TestDatabaseInstance.STOP_TIMEOUT_MS}ms and its postmaster is still running. ` +
            "It is most likely still writing its shutdown checkpoint. Leaving its data directory in place " +
            "rather than removing it out from under a live server.",
        );

        return "still-running";
      }

      this.log(
        "warn",
        "Stopping embedded PostgreSQL did not return. Its postmaster is gone, so this is a wait " +
          "that never completes rather than a server still running. Carrying on with cleanup.",
      );

      return "stopped";
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether the cluster's own postmaster is still alive.
   *
   * Read from `postmaster.pid`, which PostgreSQL writes at startup and removes
   * only when it exits cleanly, rather than from the child handle: that handle
   * is private to embedded-postgres, and depending on the shape of somebody
   * else's internals is what the note above declines to do.
   *
   * Unknown counts as running. This gates deleting a data directory, so an
   * answer it could not get must not license that.
   */
  private async serverStillRunning(): Promise<boolean> {
    if (!this.tempDir) {
      return false;
    }

    try {
      const record = await readPostmasterPidFile(this.tempDir);

      return record !== null && isProcessAlive(record.pid);
    } catch {
      return true;
    }
  }

  /**
   * The port an automatic start uses, and the seam the bind race is tested at.
   *
   * A `protected` method rather than a mocked module, so the retry path can be
   * driven from a subclass without reaching into the module registry. It is
   * the same shape as the injectable `probes` in ./pid-file: the race it exists
   * for cannot be provoked on demand, and a loop that has never run in any test
   * is a loop nobody has seen work.
   *
   * @internal Not part of the published API.
   */
  protected async findPort(): Promise<number> {
    return findFreePort();
  }

  /** How many ports a start may lose to the bind race before giving up. */
  private static readonly PORT_RETRIES = 3;

  /**
   * Everything PostgreSQL wrote during the current start attempt.
   *
   * `EmbeddedPostgres.start()` rejects with no value at all, so the reason a
   * start failed exists nowhere except the output it logged on the way down,
   * and that output arrives in several chunks. Reset per attempt, so a retry
   * is judged on its own failure rather than the previous one's.
   */
  private attemptOutput = "";

  /**
   * Builds the embedded server for one port, against this run's directory.
   *
   * Once per start, never per attempt. A retry rebinds the port on this
   * instance instead of building another — see {@link RetargetablePostgres}.
   *
   * `protected` for the same reason {@link findPort} is: the count is the
   * whole of what stops an abandoned instance stalling process exit, and a
   * rule nothing checks is a rule that goes back to being broken. Counting
   * calls here is how port-retry.test.ts holds a retry to one.
   *
   * @internal Not part of the published API.
   */
  protected buildEmbeddedPostgres(port: number): RetargetablePostgres {
    return new RetargetablePostgres({
      port,
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
        // Appended, not replaced. PostgreSQL writes a failed bind across
        // several chunks and the bind line is never the last of them: the real
        // sequence is `could not bind IPv6 address ... Address already in
        // use`, then `could not create any TCP/IP sockets`, then `database
        // system is shut down`. Keeping only the last chunk therefore tested
        // the shutdown notice, matched nothing, and made the retry below
        // unreachable.
        this.attemptOutput += message;
        this.log("pg", message);
      },
    });
  }

  /**
   * True when a failed start was PostgreSQL refusing to bind the port.
   *
   * Read out of the server's own output rather than from the rejection,
   * because there is nothing in the rejection to read: embedded-postgres
   * rejects with a bare `reject()` on the child's `close`, so every way a
   * start can fail arrives as the same `undefined`. Matching the message is
   * the only thing that separates a port that was taken from a cluster that
   * will not start at all, and retrying the second would be three initdbs and
   * the same failure.
   */
  private failedToBind(): boolean {
    return isBindFailure(this.attemptOutput);
  }

  /**
   * Starts the server, taking another port if this one was claimed in the gap.
   *
   * The race this closes: {@link findFreePort} confirms a port is free and
   * then closes the socket it proved it with, and initdb runs between that and
   * the postmaster binding it. Anything may take the number in between, and
   * on a busy machine the likeliest thief is the kernel handing it out as the
   * local port for an outgoing connection. Choosing from outside the ephemeral
   * range makes that rare rather than impossible, and a program that binds the
   * port deliberately is not covered by the range choice at all.
   *
   * Cheap, which is what makes it worth doing rather than merely correct.
   * initdb writes no port into the cluster, so a retry keeps the data
   * directory it already built and only spawns a new postmaster against it.
   *
   * Only for a port this picked. An explicit `port` is the caller naming a
   * number for a reason, and quietly starting somewhere else would hand back a
   * database at an address they are not going to connect to.
   */
  private async startWithPortRetry(): Promise<void> {
    // One server for every attempt below, so it is read once. Nothing in the
    // loop replaces it: a retry rebinds this instance's port rather than
    // building another, which is the whole point of RetargetablePostgres.
    const db = this.db;

    if (!db) {
      throw new Error(
        "PostgreSQL server was not constructed before start was attempted",
      );
    }

    for (
      let attempt = 0;
      attempt <= TestDatabaseInstance.PORT_RETRIES;
      attempt++
    ) {
      this.attemptOutput = "";

      try {
        await db.start();

        return;
      } catch (error) {
        const canRetry =
          this.portChosenAutomatically &&
          attempt < TestDatabaseInstance.PORT_RETRIES &&
          this.failedToBind();

        if (!canRetry) {
          throw error;
        }

        const taken = this.port;

        // Rebound rather than rebuilt. A second instance would be registered
        // for the life of the process and stall its exit — see
        // RetargetablePostgres. The data directory is unchanged, and initdb
        // wrote no port into it, so pointing this one at another number is the
        // whole of what a retry needs.
        this.port = await this.findPort();
        db.setPort(this.port);

        // Worth saying out loud rather than retrying quietly. It is the one
        // symptom of a machine whose ephemeral range covers the ports this
        // picks from, and a run that says it three times is saying something
        // the range choice cannot fix.
        this.log(
          "warn",
          `Port ${taken} was taken between being chosen and PostgreSQL binding it. ` +
            `Retrying on port ${this.port} against the same data directory.`,
        );
      }
    }
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
      // If no port was specified or port is 0, find an available port.
      // An explicit `port` is taken as given and never searched for: the
      // caller has a reason for that number, and picking a different one
      // would silently ignore it.
      // Decided in the constructor from what the CALLER supplied, not here
      // from the current port. A second start() on the same instance still
      // holds the port the first one chose, since cleanup() does not reset it,
      // so deciding here would call that a supplied port: no fresh search, no
      // retry on the very path the retry exists for, and a log line crediting
      // the caller for a number they never gave.
      if (this.portChosenAutomatically) {
        this.port = await this.findPort();
      }

      // Which port, and whether this picked it. An automatic port is the one
      // worth naming: it is not in the caller's configuration anywhere, so a
      // log line is the only place it appears, and it is what a "could not
      // bind" further down would be about. See ./free-port for how it is
      // chosen and what that does and does not guarantee.
      this.log(
        "info",
        `Starting embedded PostgreSQL for tests on port ${this.port}` +
          (this.portChosenAutomatically
            ? " (chosen automatically; pass `port` to pin it)"
            : " (from the supplied `port`)"),
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
      this.db = this.buildEmbeddedPostgres(this.port);

      this.log("info", "Initializing embedded PostgreSQL...");

      try {
        // Initialize and start the PostgreSQL server. initdb writes no port
        // anywhere, so the cluster it produces belongs to no port in
        // particular and a retry below can reuse it as it stands.
        await this.db.initialise();
        this.log("info", "PostgreSQL initialized successfully");

        await this.startWithPortRetry();
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

    // Whether the data directory is this cleanup's to delete. Only a server
    // confirmed gone frees it: removing the files under a postmaster that is
    // still shutting down leaves it writing into a directory that is not there
    // and still holding the port.
    let serverStopped = true;

    if (this.db) {
      try {
        serverStopped =
          (await this.stopServerWithinBound(this.db)) === "stopped";
      } catch (error) {
        this.log(
          "error",
          `Error stopping embedded PostgreSQL: ${(error as Error).message}`,
        );

        // A stop that threw settled nothing about the postmaster, and the
        // initializer above is the answer that deletes the directory. `stop()`
        // can reject with the server untouched — its Windows branch spawns
        // taskkill from inside the wait, so a spawn that fails takes the whole
        // promise down while the postmaster carries on — so ask the cluster
        // the same question a timeout asks rather than assuming.
        serverStopped = !(await this.serverStillRunning());
      }
      this.db = undefined;
      this.migrationsApplied = false;
    }

    if (this.tempDir && !serverStopped) {
      this.log(
        "warn",
        `Leaving the temporary directory in place: ${this.tempDir}. ` +
          "PostgreSQL was still running there when the stop gave up, so removing it now would " +
          "delete a live cluster's files. Delete it once that server is gone.",
      );

      this.tempDir = undefined;
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
