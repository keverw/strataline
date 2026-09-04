import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  writeFile,
  readFile,
  open,
  rename,
  link,
  unlink,
  mkdir,
  readdir,
  rm,
  rmdir,
  realpath,
} from "fs/promises";
import { dirname, isAbsolute, join, resolve } from "path";
import { Client } from "pg";
import { callHost, makeSafeLogger } from "../callback-safety";
// Imported rather than re-exported: this module does `export * from
// "./pid-file"` below, so a name exported here becomes public API.
import { fileExists, getFilePresence } from "./file-presence";
import { readOsUsername } from "../os-user";
import { type LogLevel, type LogSource, type Logger } from "../logger";
import { PostgresBinaries, getBinaries } from "./pg-bin-helper";
import {
  ipcExhaustionHint,
  PINNED_LOG_LINE_PREFIX,
  PostgresOutputBuffer,
  PostgresOutputReader,
  type PostgresOutputRead,
} from "./postgres-output";
import {
  buildDevDBPidRecord,
  dataDirFromCommand,
  getLocalDevDBServerStatus,
  parseDevDBPidRecord,
  sameDataDir,
  serializeDevDBPidRecord,
  systemProbes,
  type ProcessProbes,
  verifyPid,
} from "./pid-file";

// Re-exported so consumers can probe for a running server without reaching
// into internal paths. See ./pid-file for the verification rules.
export * from "./pid-file";

// Re-exported from where it moved to, so this stays the path it has always
// been imported from. TestDatabaseInstance reads the same severities, and
// importing this module for one pure function would take a whole process
// lifecycle manager into a bundle with no use for one.
export { postgresOutputLevel } from "./postgres-output";

/**
 * Three rules run through this file, stated once here rather than at each of
 * the places that depend on them. The identification rules they build on are
 * at the top of ./pid-file.
 *
 * **Claiming a record.** Reading a path and then unlinking that path are two
 * steps, and a record written between them is the one that gets deleted. So a
 * record is claimed with a rename first — atomic, so what comes back is held
 * by this call alone — and the decision to delete is made about the thing in
 * hand rather than about whatever the shared name points at by the time the
 * unlink lands. A record that turns out not to be ours goes back with a link,
 * which is one step and fails rather than overwrites, so a newer record that
 * took the name meanwhile keeps it. {@link removeRecordIfUnchanged} is the
 * only implementation, used for strataline's record and PostgreSQL's alike.
 * The claim is always a sibling of the file, so it cannot fail with EXDEV; for
 * postmaster.pid that means it lands in the data directory, where a crash can
 * strand one inertly, since PostgreSQL ignores names it does not know there.
 *
 * **One view of the machine.** Every decision within one start or one shutdown
 * reads the process table through {@link pidVerificationProbes}, never a
 * mixture of those and a fresh look. A conclusion drawn from one view sitting
 * beside a fingerprint sampled from another is exactly the splice the bracket
 * rule exists to rule out: a PID that one view calls a live foreign server and
 * another calls nothing would have its record deleted by the branch written to
 * preserve it.
 *
 * **Who exits.** Not this library, and it traps no signals to decide with.
 * A shutdown stops a server and resolves; what happens next belongs to whoever
 * asked for it. `stop()` and `shutdown(signal)` resolve to their callers, and
 * a failed `start()` rejects to its caller. The one exception is a server
 * dying when nobody asked it to, which has always ended the process and which
 * `onExit` intercepts — there is no other channel to report it through. The
 * process-exit hook force-kills a surviving child but decides nothing, being
 * synchronous and running only once the process is already leaving.
 */

/**
 * Evidence used to revalidate a PID immediately before each signal.
 *
 * A `recorded` target deliberately carries no recorded start time. The only
 * things that may reauthorize a signal are the fingerprint sampled during the
 * verification that authorized the escalation, or — when there is none — the
 * command line naming this data directory. A recorded timestamp would let a
 * PostgreSQL that merely started at the right moment pass instead; see
 * confirmSignalTarget.
 */
type SignalTarget =
  | { kind: "own-child"; proc: ReturnType<typeof spawn> }
  | {
      kind: "recorded";
      fingerprint: number | null;
    };

/**
 * Whether the target is no longer running, however that came about.
 *
 * Deliberately not phrased as "we stopped it". A target that had already
 * exited, or whose number now belongs to a different process, is just as gone,
 * and only one of those is something this code did. Claiming the credit in the
 * type would have every caller reading an observation as an action. What they
 * each actually need to know is whether the data directory is free, so that is
 * what this says, and the distinction between the ways of being gone is left
 * to the log line that reports it.
 */
type TerminationOutcome = "gone" | "failed";

/**
 * What claiming a PID record for removal concluded, and what it left behind.
 *
 * `displaced` is the record that was found in hand rather than the one being
 * removed, carried out with the outcome so a caller can say whose it was
 * without reading a file this call has just destroyed or given up on.
 */
type RecordRemoval =
  | { outcome: "removed" | "absent" | "restored" }
  | { outcome: "discarded"; displaced: string | null }
  | { outcome: "stranded"; heldAt: string; displaced: string | null }
  | { outcome: "unclaimable"; error: unknown };

/**
 * Instances between `start()` and the release of the child it started.
 *
 * The population the process-exit hook protects. One hook serves all of them,
 * so it stays installed until the last child has been released.
 */
const serversOwningAChild = new Set<LocalDevDBServer>();

/**
 * The vocabulary this class logs in, and the two axes each word maps to.
 *
 * Internal shorthand rather than an interface: a call site says `this.log("pg",
 * ...)` and the table turns that into a level and a source. It is the same set
 * of words the public logger used to take, which is why the call sites did not
 * have to move, but they are no longer what a caller sees.
 *
 * The server's own voice carries NO source. It is the primary thing talking,
 * so its lines read as they always did, unprefixed; a source is for saying
 * that some OTHER thing is speaking through it.
 */
const DEV_DB_LOG_TAGS = {
  info: ["info", undefined],
  warn: ["warn", undefined],
  error: ["error", undefined],
  pg: ["info", "pg"],
  setup: ["info", "setup"],
} as const satisfies Record<string, readonly [LogLevel, LogSource | undefined]>;

type DevDBLogTag = keyof typeof DEV_DB_LOG_TAGS;

/**
 * Reports that the server exited without being asked to, and why.
 *
 * A notification, not a decision. This library never ends your process, so
 * nothing happens by default when a server dies: the code is PostgreSQL's own
 * exit code, and what to do about it is yours. A script whose whole process is
 * the dev server will usually want to exit from here.
 *
 * NOT called for `stop()` or `shutdown()`, whose caller is already awaiting
 * them and knows the server is down.
 */
export type DevDBExitHandler = (exitCode: number) => void;

/**
 * Which lifecycle a {@link LocalDevDBServer} instance is in.
 *
 * About this instance, not about the machine: a server left behind by a
 * previous run reads as `stopped` here, because this object has never held it.
 * See {@link LocalDevDBServer.getLifecycleState}.
 */
export type DevDBLifecycleState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  /**
   * A failed `start()` left a child that outlived even SIGKILL, and this
   * instance is still holding it. Not permanent: once that child does die and
   * its cleanup runs, the instance reads `stopped` again and can be started.
   */
  | "unstoppable";

/**
 * Everything in a postmaster.pid except the status PostgreSQL rewrites.
 *
 * Line 8 is PostgreSQL's own status, and it flips from "ready" to "stopping"
 * the moment a shutdown begins. A postmaster wedged badly enough to need
 * SIGKILL never gets to remove the file, so what survives carries that changed
 * line, and comparing the whole thing would read the server's own last act as
 * somebody else having taken the data directory. Lines 1 to 7 are written once
 * at startup and are what actually identify the postmaster: its PID, its
 * directory, its start time, its port, its socket directory, its listen
 * address, and its shared memory segment.
 */
function postmasterRecordIdentity(raw: string): string {
  return raw.split("\n").slice(0, 7).join("\n");
}

/**
 * Get current OS user in a cross-platform way
 */
function getCurrentUser(): string {
  // The OS first, and the environment only as a fallback. Which way round
  // this goes is not a matter of taste: initdb runs here with no `-U`, so the
  // cluster's bootstrap superuser is named after the user the process is
  // ACTUALLY running as, and this name is what connects to it. The two have to
  // agree, and only one of these sources is a fact about the process.
  //
  // USER and USERNAME are inherited, so they describe whoever set them. Any
  // way of running as another user without rewriting them leaves them naming
  // the wrong one -- `su` without `-`, a container that pins them, and on
  // Windows a process launched under other credentials, which is how this was
  // found: the cluster's superuser was the real account and the connection
  // asked for the parent's, so every start failed with
  // `FATAL: role "..." does not exist` against a database it had just created.
  //
  // Kept as fallbacks rather than dropped, for a platform where userInfo()
  // cannot answer -- it throws where the user has no passwd entry, which a
  // container running as an unmapped uid does.
  const candidates = [
    readOsUsername(),
    process.env.USER,
    process.env.USERNAME,
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
 * Configuration for {@link LocalDevDBServer}. Unlike {@link TestDatabaseOptions},
 * the connection fields (`port`, `user`, `password`, `database`, `dataDir`,
 * `pidFile`) are required — the dev server runs on a fixed, predictable port and
 * data directory rather than a throwaway one. Only `logger`, `onExit`, and
 * `logConnections` are optional.
 */
export interface LocalDevDBServerConfig {
  port: number;
  user: string;
  password: string;
  database: string;
  dataDir: string;
  pidFile: string;
  logger?: Logger;
  onExit?: DevDBExitHandler;
  logConnections?: boolean;
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
  private pgDataDir: string;
  private pidFile: string;
  private logger?: Logger;
  private onExit?: DevDBExitHandler;
  private logConnections: boolean;
  private currentUser: string;
  private pidVerificationProbes: ProcessProbes = systemProbes;

  // Process reference
  private pgProcess: ReturnType<typeof spawn> | null = null;

  // Track if cleanup is already in progress to prevent multiple cleanup calls
  private isCleaningUp: boolean = false;

  // The exact bytes this invocation wrote to the PID file, or null when it has
  // no record on disk. Not the PID it names: a PID is reused the moment its
  // process exits, so a replacement server can write a record naming the same
  // number, and this invocation's delayed release would then delete that live
  // record. The record already distinguishes them — it carries the write's own
  // startedAt — so holding the bytes is the ownership token, and no field has
  // to be added to the on-disk format to get one.
  private pidRecord: string | null = null;

  // Concurrent callers share the same shutdown. Joined rather than refused,
  // unlike startInFlight — see stop() for why the two differ.
  private shutdownInFlight: Promise<void> | null = null;

  // What start() refuses a second start against, rather than what a second
  // start joins. The already-running guard reads pgProcess, which nothing sets
  // until the spawn several awaits in, so without this record two overlapping
  // calls both find the data directory free and both spawn: the second
  // reference overwrites the first, and the first postmaster is then reachable
  // by nothing — not stop(), not the "exit" hook, not cleanupFailedStart — so
  // it outlives this process still holding the port and the data directory.
  // Which is the outcome this whole module exists to prevent, arrived at from
  // inside rather than from a previous run.
  //
  // Refused rather than joined, unlike shutdownInFlight. A second start is
  // the shape a lost lifecycle takes and costs only a retry to report, while
  // a stop that refused would leave a server running. See stop().
  private startInFlight: Promise<void> | null = null;

  // The child a deliberate shutdown is aimed at, held until its lifecycle handler
  // runs. shutdownInFlight cannot answer this: it is cleared the moment the
  // shutdown settles, so a stop() that gave up waiting for a slow `close`
  // would have that close arrive to an instance with no memory of it and be
  // mistaken for a crash — which exits the process.
  private stoppingProc: ReturnType<typeof spawn> | null = null;

  // The running child's lifecycle cleanup: `closed` resolves once the
  // lifecycle handler has finished it, and `finalize` performs it. Both are exposed
  // because `close` is not guaranteed to arrive promptly — it waits on the
  // stdio pipes too — so a shutdown that has confirmed the process gone must
  // be able to run the cleanup itself rather than wait indefinitely for the
  // event. `finalize` runs at most once per child, whoever calls it.
  private pgProcessLifecycle: {
    proc: ReturnType<typeof spawn>;
    closed: Promise<void>;
    finalize: () => Promise<void>;
  } | null = null;

  // Keep-alive interval to prevent Node.js from exiting while we wait for PostgreSQL
  private keepAliveInterval: NodeJS.Timeout | null = null;

  // The one `process` listener this module holds on behalf of every running
  // server, so exactly it comes off again and nothing a host added.
  private static exitListener: (() => void) | null = null;

  // Set while start() is running, so the child's lifecycle handler leaves the
  // failure to start() instead of exiting the process out from under it.
  private startingUp: boolean = false;

  // Why the spawned server never became usable, when it did not.
  private startupFailure: Error | null = null;

  // The end of what the spawned PostgreSQL wrote, kept so a failure can say
  // what it said. Bounded, because a server that runs for a week must not
  // accumulate its own log in memory, and only the end of it diagnoses a
  // startup that died: the postmaster reports the reason and then exits.
  //
  // The same buffer TestDatabaseInstance keeps, for the same reasons and with
  // the same bound. See PostgresOutputBuffer, which is also where the reason
  // it counts characters rather than lines is written down.
  private readonly serverOutput = new PostgresOutputBuffer();

  // One per pipe, because they are two streams and a half-written line on one
  // is not the start of the next line on the other. See PostgresOutputReader,
  // which is also where the reason the LOGGED text is assembled while
  // serverOutput above stays verbatim is written down.
  private readonly serverLines = {
    stdout: new PostgresOutputReader(),
    stderr: new PostgresOutputReader(),
  };

  // The child a failed start left behind because it outlived even SIGKILL.
  //
  // The reference rather than a flag, so it answers "which child" and not
  // merely "some child": it only means anything while pgProcess is still that
  // same one, and every other state either nulls pgProcess or replaces it with
  // a different one. That identity check is what makes the field safe to read
  // without clearing, which is not the same as there being no reason to clear
  // it — a dead child's handle holds its stdio stream objects, so finalize()
  // drops this alongside the rest of what that child owned.
  private unstoppableChild: ReturnType<typeof spawn> | null = null;

  // Which attachment this instance currently speaks for. Bumped by every
  // attachExitHandler, and each handler closes over the number it was given,
  // so a handler can ask whether it is still the current one.
  //
  // Deliberately not pgProcess or pgProcessLifecycle, which a completed
  // lifecycle sets to null: those cannot tell "this child's cleanup has
  // finished" apart from "a later child has taken over", and a lifecycle handler
  // has to know which of the two it is before touching anything shared.
  //
  // A counter rather than the child itself, which is what this held before.
  // The comparison only ever asked whether the current attachment is still
  // this one, and a number answers that — while holding the handle kept a dead
  // child, and the stdio stream objects hanging off it, reachable from the
  // instance for as long as no later start replaced it. That is bounded rather
  // than a growing leak, but it also made finalize()'s release of
  // unstoppableChild do nothing, since this field still pointed at the same
  // child. Nothing else ever read it, so there is nothing else to change.
  private attachedGeneration = 0;

  /**
   * Creates a new PostgresDevServer instance.
   *
   * @param config Configuration parameters
   */
  constructor(config: LocalDevDBServerConfig) {
    // Initialize with provided config
    this.pgPort = config.port;
    this.pgUser = config.user;
    this.pgPass = config.password;
    this.pgDb = config.database;
    // Absolute from here on, so the `-D` we spawn with is absolute too:
    // pid-file.ts will not resolve a relative one, since it belongs to the
    // target process's working directory rather than ours.
    this.pgDataDir = resolve(config.dataDir);
    this.pidFile = config.pidFile;
    // Wrapped on the way in, so nothing below has to remember to guard it and
    // a failure degrades instead of ending the process. See makeSafeLogger.
    this.logger = config.logger && makeSafeLogger(config.logger);
    this.onExit = config.onExit;
    this.logConnections = config.logConnections ?? false;
    this.currentUser = getCurrentUser();

    // Deliberately no process listeners here. The shared exit hook goes on in
    // start() and comes off once there is no child left to protect. A
    // constructed-but-never-started instance therefore changes no host state.
  }

  /**
   * Log a message if a logger is configured.
   *
   * The logger belongs to the caller, so calling it is running somebody else's
   * code, and a throw from it must not become the outcome of whatever was
   * being reported. There is nowhere for such a throw to go that is not worse
   * than dropping the line. It is raised inside the `exit` hook, where nothing
   * can catch it and the child never gets its SIGKILL; inside the `close`
   * handler, which is an async listener whose rejection is unhandled and whose
   * exit decision is skipped; inside a signal handler, whose own catch reports
   * a shutdown failure that did not happen; and from start()'s catch, ahead of
   * the cleanupFailedStart that takes this instance's process listeners back
   * off, which is the same leak arming them around the try was fixing.
   *
   * So it is swallowed, deliberately and silently. Reporting it would mean
   * logging, which is the thing that just failed.
   *
   * @param type Message type
   * @param message Message content
   */
  private log(type: DevDBLogTag, message: string, override?: LogLevel): void {
    if (!this.logger) {
      return;
    }

    const [defaultLevel, source] = DEV_DB_LOG_TAGS[type];
    const level = override ?? defaultLevel;

    // Guarded once when it was stored rather than here, so every call is
    // covered by construction. See makeSafeLogger.
    this.logger[level](source ? { source, message } : { message });
  }

  /**
   * Reports a server that exited on its own, and stops keeping the loop alive.
   *
   * Deliberately does not end the process. Deciding that a database going away
   * should take the program with it is the program's call: a test harness, a
   * provisioning step, or anything that just wanted a database for a while all
   * have somewhere to carry on to, and a library that exits has taken a
   * decision none of them can get back. A script whose whole process IS the
   * dev server exits from its own handler.
   *
   * The consequence of supplying no handler is that nothing happens at all —
   * the process stays up with no database behind it. That is the quiet
   * failure, so it is worth a log line whether or not anyone is listening.
   */
  private reportServerExit(exitCode: number): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    this.log(
      "error",
      `PostgreSQL exited with code ${exitCode} without being asked to. ` +
        (this.onExit
          ? "Reporting it to onExit."
          : "No onExit handler is set, so nothing else will happen: this process is still running with no database behind it."),
    );

    const onExit = this.onExit;

    if (!onExit) {
      return;
    }

    // Somebody else's code, called from an `async` exit listener, which is
    // what makes absorbing it necessary rather than tidy. A throw from a
    // synchronous listener would surface as an uncaughtException the host can
    // trap; from this one it rejects a promise nothing holds, and Node ends
    // the process over it — see callHost.
    //
    // Reported, in the way a failed logger cannot be: there IS somewhere for
    // this to go. The exit has been announced by the time this runs, so a
    // handler that fails changes nothing else about the shutdown; it only
    // means the announcement was not acted on.
    callHost(
      () => onExit(exitCode),
      (e) =>
        this.log(
          "error",
          `The onExit handler failed while being told PostgreSQL exited with code ${exitCode}: ${e}`,
        ),
    );
  }

  /**
   * Stops the server, once, however many callers ask at the same time.
   *
   * Never exits. `stop()` and the host-owned signal handler that calls
   * `shutdown()` both regain control when the shutdown settles.
   */
  private async handleGracefulShutdown(
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    // stop() resolves only after an in-flight shutdown finishes.
    if (this.shutdownInFlight) {
      return this.shutdownInFlight;
    }

    if (this.isCleaningUp) {
      return;
    }

    this.isCleaningUp = true;

    // Leave the instance ready for a later start()/stop() cycle once this
    // shutdown has fully settled.
    this.shutdownInFlight = this.performGracefulShutdown(signal).finally(() => {
      this.shutdownInFlight = null;
      this.isCleaningUp = false;
    });

    return this.shutdownInFlight;
  }

  private async performGracefulShutdown(
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this.log(
      "info",
      signal === null
        ? "\nShutting down PostgreSQL server..."
        : `\nShutting down PostgreSQL server (${signal})...`,
    );

    if (!this.pgProcess || !this.pgProcess.pid) {
      return;
    }

    const pid = this.pgProcess.pid;
    const proc = this.pgProcess;

    // Recorded against the child itself, so it outlives this shutdown's own
    // promise however that promise ends.
    this.stoppingProc = proc;

    const lifecycle =
      this.pgProcessLifecycle?.proc === proc ? this.pgProcessLifecycle : null;

    // Start keep-alive interval to prevent Node.js from exiting
    this.keepAliveInterval = setInterval(() => {
      // This keeps the event loop alive while we wait for PostgreSQL
    }, 1000);

    try {
      const outcome = await this.terminateOwnChild(
        pid,
        "PostgreSQL server",
        proc,
      );

      if (outcome === "failed") {
        throw new Error(`PostgreSQL (PID ${pid}) could not be stopped.`);
      }

      // The read ends are ours, and the postmaster is gone by here, so nothing
      // is going to close them for us. PostgreSQL's backends inherit those
      // pipes and a postmaster killed without signaling its children leaves
      // them holding the write ends, so the handles stay readable with nothing
      // left to reap them — and a ref'd pipe keeps the event loop up, so a
      // host that awaits stop() and returns would never exit. Same drop
      // start() makes before reusing an instance, for the same reason.
      //
      // Ahead of everything below, so no later refusal can skip it. The
      // lifecycle settles `closed` from the child's `exit` rather than its
      // `close`, so waiting on that says nothing about the pipes and cannot be
      // what decides this.
      //
      // Dropping them is also this stream ending, and it ends without an
      // "end", so the last line PostgreSQL wrote goes out first or not at all.
      this.flushServerOutput();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.stdin?.destroy();

      if (!lifecycle) {
        throw new Error(
          `PostgreSQL (PID ${pid}) stopped, but Strataline could not confirm that its PID-file cleanup finished. ` +
            `Retry shutdown; if PostgreSQL is no longer running, check and remove the stale PID file at ${this.pidFile}.`,
        );
      }

      // A gone PID does not mean the lifecycle handler has run — `exit` is an
      // event like any other. Wait for it to remove the PID file and clear the
      // process reference, with a bound so stop() cannot hang on one that
      // never arrives.
      let lifecycleTimeout: NodeJS.Timeout | undefined;

      const closedInTime = await Promise.race([
        lifecycle.closed.then(() => true),
        new Promise<boolean>((settleRace) => {
          lifecycleTimeout = setTimeout(() => settleRace(false), 2000);
        }),
      ]);

      if (lifecycleTimeout) {
        clearTimeout(lifecycleTimeout);
      }

      if (!closedInTime) {
        // Running out of time here is NOT a failed shutdown, and reporting one
        // would be wrong in the case that produces it. The postmaster is
        // confirmed gone by this point — waitForExit said so — so what is late
        // is Node's `exit` event, not the stop.
        //
        // Left to reject, that turned a successful Ctrl+C into a non-zero exit
        // reporting a shutdown that had in fact worked — and, because the
        // release lives in the lifecycle handler, into a stale PID record too. So
        // do the lifecycle cleanup here instead. It is the same call the
        // lifecycle handler makes and runs at most once, so an `exit` that
        // does arrive later still makes its own decision without repeating it.
        this.log(
          "warn",
          `PostgreSQL (PID ${pid}) is gone, but Node has not yet reported its exit. ` +
            "Completing shutdown without waiting for that event.",
        );

        await lifecycle.finalize();
      }
    } finally {
      // The lifecycle handler clears this too, but only when it exits — which an
      // explicit stop() does not do, and a failed shutdown never reaches.
      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval);
        this.keepAliveInterval = null;
      }
    }
  }

  /**
   * Installs the one `process` listener this module owns, on behalf of every
   * running server.
   *
   * Deliberately no signal handlers. Trapping SIGINT or SIGTERM inside a
   * library takes a decision that belongs to the program: the listener
   * suppresses Node's default termination for the WHOLE process, so a library
   * that installs one silently changes how its host dies, and where two of
   * them disagree the loudest wins. `RunStratalineCLI` has always said the
   * same thing about itself. Wire your own handler and call
   * {@link LocalDevDBServer.shutdown} from it.
   *
   * The `exit` hook is not that, and stays. It decides nothing — it cannot,
   * being synchronous and running only once the process is already leaving —
   * and all it does is stop a postmaster outliving the process that spawned
   * it. Node runs it on a normal exit, on `process.exit()`, and after an
   * uncaught exception, but NOT when an untrapped signal terminates the
   * process: that is the orphan a host that wires no handler still risks, and
   * the reason to wire one.
   */
  private static armProcessListeners(): void {
    if (LocalDevDBServer.exitListener !== null) {
      return;
    }

    const onExitHook = (): void => {
      // Synchronous, so no async cleanup is possible here. Force-kill any
      // child still running: an inherited stdio handle can keep `close`
      // pending long after the child is gone, so a non-null pgProcess is not
      // evidence the number is still ours. Node's own report on the handle
      // is, and cannot be got wrong.
      for (const server of serversOwningAChild) {
        const proc = server.pgProcess;

        if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) {
          continue;
        }

        try {
          server.killProcess(proc.pid, "SIGKILL");
        } catch {
          // Process might already be gone.
        }
      }
    };

    process.on("exit", onExitHook);
    LocalDevDBServer.exitListener = onExitHook;
  }

  /** Takes it off again once no server is left to protect. */
  private static releaseProcessListeners(): void {
    if (LocalDevDBServer.exitListener !== null && !serversOwningAChild.size) {
      process.off("exit", LocalDevDBServer.exitListener);
      LocalDevDBServer.exitListener = null;
    }
  }

  /**
   * Joins the set the process listeners serve, installing them if needed.
   *
   * What `start()` does on the way in, before anything is spawned, so a child
   * created anywhere in the startup path is protected if the host exits.
   */
  private armProcessHandlers(): void {
    serversOwningAChild.add(this);
    LocalDevDBServer.armProcessListeners();
  }

  /** Leaves it again, taking the listeners off once nothing needs them. */
  private releaseProcessHandlers(): void {
    serversOwningAChild.delete(this);
    LocalDevDBServer.releaseProcessListeners();
  }

  /**
   * Removes the `process` listeners this instance registered, ahead of the
   * point in the lifecycle where they would have come off by themselves.
   *
   * Rarely needed now that the handlers are scoped to a running server:
   * {@link start} puts them on and the shutdown takes them off, so an
   * instance sitting idle between cycles already holds none, and a program
   * that builds servers over its lifetime no longer accumulates them. What is
   * left for this is releasing an instance whose server could not be stopped,
   * and belt-and-braces teardown in a test suite.
   *
   * Safe to call more than once, and a disposed instance can still be reused
   * because `start()` registers again.
   *
   * Call {@link stop} first. Disposing an instance that still holds a child
   * removes that child from the shared `exit` hook, so it can outlive the
   * process that started it. It is allowed, since an instance being torn down
   * for some other reason should not be made to throw, but it is not a tidy
   * thing to do and it says so in the log.
   */
  public dispose(): void {
    if (this.pgProcess) {
      this.log(
        "warn",
        `dispose() was called while PostgreSQL (PID ${this.pgProcess.pid}) is still running. ` +
          "It will no longer be stopped when this process exits. Call stop() first.",
      );
    }

    this.releaseProcessHandlers();
  }

  /**
   * Checks if a process is running by PID.
   *
   * @param pid Process ID to check
   * @returns True if the process is running, false otherwise
   */
  private isProcessRunning(pid: number): boolean {
    // NOTE: this proves only that *something* holds the PID, never that it is
    // our server. Anything that leads to a kill must verify first. Through the
    // shared probes, per "One view of the machine" at the top of this file.
    return this.pidVerificationProbes.isAlive(pid);
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
    } catch {
      return false;
    }
  }

  /**
   * Waits for a PID to disappear, up to a timeout.
   *
   * @returns True if the process exited within the timeout.
   */
  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.isProcessRunning(pid)) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return !this.isProcessRunning(pid);
  }

  /**
   * Sends a signal to an already-verified PID.
   *
   * Windows does not implement PostgreSQL's signal semantics through
   * process.kill(), so use pg_ctl's PID-addressed kill mode there. Crucially,
   * this does not use pg_ctl stop -D: that command rereads postmaster.pid in
   * a child process and could target a replacement server after our check.
   */
  private async signalVerifiedPid(
    pid: number,
    signal: NodeJS.Signals,
  ): Promise<boolean> {
    // SIGKILL is the exception. On Windows pg_ctl delivers signals through
    // PostgreSQL's emulated-signal pipe, which a wedged server cannot service
    // — and it reports success anyway. Node maps SIGKILL to TerminateProcess.
    if (process.platform !== "win32" || signal === "SIGKILL") {
      return this.killProcess(pid, signal);
    }

    try {
      const pgBinaries = await getBinaries();
      const result = await this.runPgCommand(
        pgBinaries.pg_ctl,
        ["kill", signal.replace(/^SIG/, ""), String(pid)],
        // Bounded, because this runs inside the escalation and pg_ctl has no
        // timeout of its own. Left unbounded it is the one step that can
        // outlast the whole thing: every other wait in terminateProcess has a
        // deadline, so a hung pg_ctl here is what turns a bounded shutdown
        // into one that never returns. Delivering a signal is a syscall away,
        // so this bound is loose enough to only catch a hang.
        { silent: true, timeoutMs: 10_000 },
      );

      if (result.code === null) {
        this.log(
          "warn",
          `pg_ctl could not signal PID ${pid} (${result.stderr.trim()})`,
        );
      }

      return result.code === 0;
    } catch (e) {
      this.log("warn", `pg_ctl could not signal PID ${pid}: ${e}`);

      return false;
    }
  }

  /**
   * The escalation, and how long each step is given before the next one.
   *
   * Deliberately not one budget for all three. SIGINT is the step that ends
   * well: PostgreSQL disconnects its clients, writes a shutdown checkpoint,
   * and exits cleanly, and how long that checkpoint takes is a function of
   * how much the database has dirtied and how loaded the machine is — a real
   * dev database on a busy laptop takes tens of seconds, not the five a
   * shared budget gave it. Cutting it short there is not a faster stop, it is
   * a worse one: SIGQUIT skips the checkpoint, so the time comes back with
   * interest as WAL replay on the next start, intermittently and with nothing
   * to connect it to the shutdown that caused it.
   *
   * The other two are last resorts and want the opposite. SIGQUIT is bounded
   * by how long it takes to abandon the work rather than finish it, and
   * anything still alive after SIGKILL is not going to die of waiting.
   *
   * Their sum is what the backstop in performGracefulShutdown must exceed;
   * see the comment there.
   */
  private static readonly SHUTDOWN_ESCALATION: ReadonlyArray<
    readonly [NodeJS.Signals, number]
  > = [
    ["SIGINT", 30_000],
    ["SIGQUIT", 10_000],
    ["SIGKILL", 2_000],
  ];

  /** Half again the escalation's own total, so it cannot pre-empt a step. */
  private static readonly SHUTDOWN_BACKSTOP_MS =
    LocalDevDBServer.SHUTDOWN_ESCALATION.reduce(
      (total, [, budget]) => total + budget,
      0,
    ) * 1.5;

  /**
   * Escalates against a child this instance spawned, under a backstop.
   *
   * Every wait inside the escalation has a deadline of its own, so what this
   * covers is the escalation getting stuck between them rather than taking
   * its full budget. That is worth covering because a stuck one outlasts its
   * caller: `start()` and `stop()` both promise to return.
   *
   * Only for a child this instance holds a handle to. A `recorded` target is
   * somebody else's process reached by number alone, and force-killing one
   * from a timer would signal it without the revalidation confirmSignalTarget
   * does before every other signal here, which is the one thing this module
   * never does. That path is bounded by its own deadlines instead, which is
   * why the spawns it makes are bounded too.
   */
  private async terminateOwnChild(
    pid: number,
    label: string,
    proc: ReturnType<typeof spawn>,
  ): Promise<TerminationOutcome> {
    // Derived from the escalation rather than fixed, and with room to spare,
    // because it has to stay a backstop. Any value below the escalation's own
    // total is a competing deadline for whichever rung it lands in, and the
    // fixed 30 seconds this replaced landed in the first one: armed before the
    // loop starts, it fired while SIGINT was still being waited out, so the
    // clean shutdown it was waiting for got SIGKILLed part way through its
    // checkpoint. That is the outcome the budgets above exist to avoid,
    // arrived at from the other direction.
    const backstop = setTimeout(() => {
      // The child this call was aimed at, not whatever the instance holds now.
      // A stuck escalation can outlast its own child, and a start() in that
      // window puts a fresh postmaster on the instance, which this would then
      // SIGKILL. Node's own report on the handle is the same guard the "exit"
      // hook uses.
      if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }, LocalDevDBServer.SHUTDOWN_BACKSTOP_MS);

    try {
      return await this.terminateProcess(pid, label, {
        kind: "own-child",
        proc,
      });
    } finally {
      clearTimeout(backstop);
    }
  }

  /** Escalates from SIGINT to SIGQUIT and finally SIGKILL. */
  private async terminateProcess(
    pid: number,
    label: string,
    target: SignalTarget,
  ): Promise<TerminationOutcome> {
    this.log("setup", `Stopping ${label} (PID: ${pid})...`);

    /** Turns a target that is no longer ours to signal into an outcome. */
    const settle = (
      state: "gone" | "pid-reused" | "unknown",
    ): TerminationOutcome => {
      if (state === "pid-reused") {
        // Positive disproof that the target still holds the number, which it
        // could only lose by exiting. Worth saying out loud, because it is not
        // what was asked for and the number in the logs now names somebody
        // else, but as far as the caller is concerned it is gone like any
        // other gone.
        this.reportPidReused(pid, label);

        return "gone";
      }

      if (state === "unknown") {
        this.reportIdentityLost(pid, label);

        return "failed";
      }

      return "gone";
    };

    // The loop's own check covers the state before the first signal too, so
    // there is no separate one ahead of it. A duplicate would not merely be
    // dead weight: without a fingerprint this runs a full verifyPid, which on
    // macOS is six `ps` spawns, and doing it twice back to back only widens
    // the gap between the observation and the signal it authorizes.
    for (const [signal, budget] of LocalDevDBServer.SHUTDOWN_ESCALATION) {
      const state = this.confirmSignalTarget(pid, target);

      if (state !== "ours") {
        return settle(state);
      }

      if (signal === "SIGKILL") {
        this.log("warn", `Process ${pid} did not stop, force killing...`);
      } else {
        this.log("setup", `Sending ${signal} to PID ${pid}...`);
      }

      await this.signalVerifiedPid(pid, signal);

      // Even SIGKILL can fail — a process owned by another user, for instance.
      // The caller must not treat that as a stop.
      if (await this.waitForExit(pid, budget)) {
        return "gone";
      }
    }

    // The last rung has no successor to re-confirm at, and waitForExit asks
    // only whether the number is in use. A target that died during the final
    // wait and had its number taken straight away therefore falls out of the
    // loop looking alive, and reporting that as a failed stop tells the user
    // to go and kill whatever inherited the number. Ask the same question the
    // top of every other rung asks, so the number changing hands settles as
    // the stop it is. Still ours means it really did survive everything.
    const final = this.confirmSignalTarget(pid, target);

    return final === "ours" ? "failed" : settle(final);
  }

  /**
   * Checks whether another cluster's recorded server may still be live.
   *
   * Through the shared probes, like its caller — see "One view of the machine"
   * at the top of this file.
   *
   * No timestamps, for the reason liveServerVerdict gives: this gates deleting
   * another cluster's record, and both the recorded start time and the
   * recorded boot time are readings a clock adjustment moves on the live side
   * while leaving the recorded side. Offering either would let a clock stepped
   * back since the record was written report a running server as `recycled`,
   * which clears the refusal and erases the only thing recording it. What is
   * left — the PID being gone, a command line naming another cluster or
   * another program, an owner that cannot have changed — is disproof no
   * adjustment can manufacture.
   */
  private otherClusterStillLive(
    pid: number,
    otherDataDir: string | null,
    uid: number | null = null,
  ): boolean {
    const probes = this.pidVerificationProbes;

    if (!probes.isAlive(pid)) {
      return false;
    }

    const check = verifyPid(pid, {
      startedAt: null,
      bootTime: null,
      dataDir: otherDataDir ?? "",
      // Where the record carries one. A process cannot change uid after exec,
      // so a live PID owned by somebody else is not the recorded server, and
      // withholding that turns proof it is gone into a refusal that stands
      // until somebody deletes the file by hand. Null for a caller with no
      // owner to offer — a legacy record carries none, and neither does a
      // status — which leaves the check switched off rather than guessing.
      uid,
      probes,
    });

    return check.verifiedBy !== null || check.kind === "indeterminate";
  }

  /**
   * Says why the escalation stopped, when the number changed hands under it.
   *
   * A warning rather than an error, because the server really is gone: the
   * number could only change hands once it exited. Logging it as a failure
   * would have a startup that then proceeds normally read as one that had gone
   * wrong. It is still worth a line, because the number that was being chased
   * now belongs to a process nothing here has any business signaling.
   */
  private reportPidReused(pid: number, label: string): void {
    this.log(
      "warn",
      `PID ${pid} is no longer the ${label}: the process now at that number is demonstrably a different one, so the server exited and something else took its number. Treating the server as gone and sending no further signals.`,
    );
  }

  /** Says why the escalation stopped, when identity could no longer be read. */
  private reportIdentityLost(pid: number, label: string): void {
    this.log(
      "error",
      `PID ${pid} could no longer be confirmed as the ${label}, and nothing ruled it out either, so it may still be that process. Sending no further signals.`,
    );
  }

  /** Captures identity evidence from the verification that authorized stopping. */
  private captureSignalFingerprint(
    pid: number,
    observedStartTime: number | null,
  ): { fingerprint: number | null } | null {
    if (observedStartTime !== null && Number.isFinite(observedStartTime)) {
      return { fingerprint: observedStartTime };
    }

    // The fingerprint handed back is compared against a later reading in
    // confirmSignalTarget, so both have to come from the shared probes.
    const probes = this.pidVerificationProbes;

    // Recheck command-line identity between start-time samples to detect PID reuse.
    const before = probes.startTime(pid);
    const recheck = verifyPid(pid, {
      startedAt: null,
      bootTime: probes.bootTime(),
      dataDir: this.pgDataDir,
      probes,
    });
    const after = probes.startTime(pid);

    if (recheck.kind === "process-gone") {
      // It shut down while being checked. That is a stop, not a number
      // changing hands — refusing here would fail startup over a server that
      // has just gone away of its own accord.
      return { fingerprint: null };
    }

    if (recheck.verifiedBy === null || before !== after) {
      return null;
    }

    // Authorized by its command line, not by the clock: the bracketed samples
    // only prove the observation was not spliced across PID reuse, and a coarse
    // process clock can give a newly recycled PID a nearby timestamp.
    return { fingerprint: null };
  }

  /** Revalidates the target immediately before each shutdown action. */
  private confirmSignalTarget(
    pid: number,
    target: SignalTarget,
  ): "ours" | "gone" | "pid-reused" | "unknown" {
    if (target.kind === "own-child") {
      const exited =
        target.proc.exitCode !== null || target.proc.signalCode !== null;

      return exited ? "gone" : "ours";
    }

    if (!this.isProcessRunning(pid)) {
      return "gone";
    }

    // The fingerprint below was sampled through these, and a difference
    // between two views of the machine settles as `pid-reused`, which ends the
    // escalation reporting a live server as gone.
    const probes = this.pidVerificationProbes;

    if (target.fingerprint !== null) {
      const current = probes.startTime(pid);

      if (current === null) {
        // Most often this is simply the process exiting between the liveness
        // check above and this read — which is a clean stop, not a failure to
        // identify. Reporting it as anything but `gone` would abort the
        // escalation and tell the user to go and stop a server that has just
        // stopped.
        if (!this.isProcessRunning(pid)) {
          return "gone";
        }

        // Still alive, but it was readable when the escalation was authorized
        // and is not now. That is itself a change; do not signal on it. It is
        // not disproof either — nothing was compared — so it is not a stop.
        return "unknown";
      }

      // This is a fingerprint sampled by the same OS probe at both points,
      // not a comparison between independent clocks. Any difference means the
      // process changed; a tolerance would admit a quickly recycled PID.
      return current === target.fingerprint ? "ours" : "pid-reused";
    }

    const check = verifyPid(pid, {
      // Without a fingerprint, only command-line identity may reauthorize a signal.
      startedAt: null,
      bootTime: probes.bootTime(),
      dataDir: this.pgDataDir,
      probes,
    });

    if (check.kind === "process-gone") {
      return "gone";
    }

    if (check.verifiedBy !== null) {
      return "ours";
    }

    // Only positive disproof says the recorded server exited. `indeterminate`
    // is an absence of evidence, and reading it as a stop would let start()
    // proceed against a server that may still be serving this data directory.
    return check.kind === "indeterminate" ? "unknown" : "pid-reused";
  }

  /**
   * Reads a record this call has already claimed, keeping a failure to read
   * it apart from a record that turns out to be somebody else's.
   *
   * A plain read collapses the two into one `null`, and here they must not
   * be. A record that does not match is positive evidence that the name
   * changed hands. Bytes that could not be read are no evidence about
   * anything, and reporting them as the first has a start refuse with a
   * message about another server having taken the data directory — over a
   * record that may never have changed.
   *
   * ENOENT is left to the mismatch path deliberately. The claim was renamed
   * into place a moment ago, so its absence is somebody removing it, which
   * is the same class of interference as replacing it and wants the same
   * cautious answer rather than a quiet success.
   */
  private async readClaimedRecord(
    path: string,
  ): Promise<{ raw: string } | { error: unknown }> {
    try {
      return { raw: await readFile(path, "utf8") };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;

      if (code === "ENOENT" || code === "ENOTDIR") {
        return { raw: "" };
      }

      return { error: e };
    }
  }

  /**
   * Reads bytes that startup will use to account for a PID record.
   *
   * Distinguishes absence from an unreadable path, which is what separates
   * this from {@link readClaimedRecord}: that one is tolerant, because it runs
   * after this invocation has claimed a record and is trying to put somebody
   * else's back. Startup's accounting has a different job: `null` licenses
   * treating a path as empty, so only genuine absence may produce it. An
   * access failure must refuse the start rather than let a later rename
   * overwrite an unknown record.
   */
  private async readAccountedPidFileBytes(
    path: string,
  ): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;

      if (code === "ENOENT" || code === "ENOTDIR") {
        return null;
      }

      throw new Error(
        `${path} exists or is inaccessible and could not be read while startup was accounting for PID records. ` +
          "It has been left in place. Check that no server is using this file, then fix its permissions or remove it and try again.",
        { cause: e },
      );
    }
  }

  /**
   * Removes a file, but only while it still holds the record `accounted`
   * identifies, and without a window in which it could hold something else.
   *
   * The one implementation of the claim protocol — see "Claiming a record"
   * at the top of this file — used for PostgreSQL's postmaster.pid and for
   * strataline's own record alike. `identify` is what counts as the same
   * record: every byte for strataline's file, since nothing but strataline
   * writes it, and the part that does not move for PostgreSQL's.
   *
   * Reports rather than logs, because the two callers want to say different
   * things about the same outcome. `cleanupExistingProcess` is refusing a
   * start and names the file; `releasePidRecord` is tidying up after its own
   * server and can say whose record it ended up holding. Neither wording
   * belongs to the protocol.
   */
  private async removeRecordIfUnchanged(
    path: string,
    accounted: string,
    identify: (raw: string) => string,
  ): Promise<RecordRemoval> {
    const claimed = `${path}.${randomUUID()}.claim`;

    try {
      await rename(path, claimed);
    } catch (e) {
      // ENOENT is the record having gone away, which is what a clean shutdown
      // looks like and leaves nothing to delete. Anything else — a read-only
      // mount, a directory this user may traverse but not write — is the
      // record still being there and this call unable to take hold of it.
      //
      // Those are different answers and the difference is the one this module
      // is built on, so do not report the second as the first. Reported as
      // absent, a postmaster.pid that could not be claimed reads as a data
      // directory that is free, and start() goes on to spawn a postmaster
      // that fails against PostgreSQL's own lock file with "lock file
      // postmaster.pid already exists" — a message about the wrong thing, in
      // place of the refusal every other unclaimable record here produces.
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { outcome: "absent" };
      }

      return { outcome: "unclaimable", error: e };
    }

    const read = await this.readClaimedRecord(claimed);
    const held = "error" in read ? null : read.raw;

    if (held !== null && identify(held) === accounted) {
      await this.removeFileIfPresent(claimed);

      return { outcome: "removed" };
    }

    // Either replaced between the read that decided and the rename that
    // claimed it — so what is held is somebody else's live record — or held
    // and not readable at all. Both end the same way, with the record going
    // back where it came from, so put it back first and say which it was
    // afterwards. Back with a link rather than by writing the bytes again: a
    // link is one step, so the record is never observed half written, and it
    // fails rather than overwrites, so a newer record that took the name
    // meanwhile keeps it. Where the filesystem has no hard links, an exclusive
    // create puts the same bytes back instead — see publishWithoutReplacing.
    //
    // Only where there are bytes to put back. `held` is null where the read
    // failed and EMPTY where the claim had gone by the time it was read, which
    // readClaimedRecord reports as the same absence a mismatch is, and neither
    // is a record: rewriting one would publish a name holding nothing, which
    // every reader treats as corrupt. The link is the only way back for those,
    // and its failure is reported as one.
    try {
      if (held) {
        await this.publishWithoutReplacing(claimed, path, held);
      } else {
        await link(claimed, path);
      }

      await this.removeFileIfPresent(claimed);

      // The record is at `path` again and nothing here could identify it,
      // which is the answer an unclaimable rename gives and is reported the
      // same way. Not `restored`: the callers read that as positive evidence
      // that another server took this data directory, and refuse a start
      // saying so. A read that failed is no evidence at all, and the bytes
      // may never have changed.
      return "error" in read
        ? { outcome: "unclaimable", error: read.error }
        : { outcome: "restored" };
    } catch (e) {
      // EEXIST is a THIRD record having taken the name, which is newer than
      // the one being put back, so there is nowhere for this one to go and
      // keeping it would strand a copy per attempt under a name nothing looks
      // for. Discard it: the caller refuses either way, and the record that
      // matters is the one now at `path`. Any other failure says nothing about
      // who holds the name — a read-only mount and a full filesystem both land
      // here — so that record is not ours to destroy and is left where a
      // person can find it.
      //
      // The displaced bytes go back with the outcome either way. A caller that
      // wants to name whose record this was has them already, and reading the
      // file again would be a second observation of something this call has
      // just destroyed or given up on. They are null when the read failed,
      // which is why describeRecord has a word for that.
      //
      // Both of these outcomes lose the distinction the read error was kept
      // for, and only these two: a claim that could not be read and then could
      // not be put back is reported as one that changed hands. For EEXIST that
      // is true anyway, since a third record demonstrably holds the name by
      // then. For the rest it overstates, and it takes two failures at once to
      // get there. Carried no further because the outcome a caller acts on is
      // the same either way, the record is not at `path` and this could not
      // put it there, and the log line above it names the file.
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
        await this.removeFileIfPresent(claimed);

        return { outcome: "discarded", displaced: held };
      }

      // ENOENT is the claim itself having gone between the rename and this
      // put-back — a temp reaper, or somebody clearing the directory. The
      // claim is a sibling of `path`, so it cannot be missing for want of a
      // parent directory that the rename above already used, which leaves the
      // record simply not existing any more: not at `path`, since this call
      // renamed it away, and not at `claimed`, since something removed it.
      //
      // That is an absence, and reporting it as `stranded` describes neither
      // path truthfully: the caller refuses the start naming a record that is
      // in the way, points a person at a claim file that is not there, and
      // does it over a data directory that is in fact free. The end state is
      // the one a clean shutdown leaves, so say so.
      //
      // Unless `path` is taken by then, which is the EEXIST case above reached
      // by another route rather than an absence. `link` resolves its source
      // before its destination, so a source that has vanished reports ENOENT
      // whether or not the name is already held, and from here the two are
      // indistinguishable. Answering "absent" over a live record would let a
      // start proceed against a data directory something else has, which is
      // the one mistake this whole protocol exists to prevent.
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        // Three answers rather than two, because only a CONFIRMED absence may
        // report a free data directory here and only a CONFIRMED presence may
        // say who took it. A plain existence check folds EACCES on a directory
        // this user may no longer traverse, and EIO on a failing disk, into
        // the same `false` a missing file gives, which is the
        // absent-versus-unreadable conflation the rest of this module is built
        // to avoid.
        const presence = await getFilePresence(path);

        if (presence === "absent") {
          return { outcome: "absent" };
        }

        if (presence === "present") {
          return { outcome: "discarded", displaced: held };
        }

        // Held by something, or not — this could not look. `discarded` would
        // be safe, since both outcomes refuse, but it is not TRUE: its callers
        // state as fact that another server replaced the record, and the
        // paragraph above earns that wording from EEXIST, where a third record
        // demonstrably holds the name. Nothing here demonstrates anything, and
        // sending a person to hunt a second postmaster over what is really a
        // permission or a failing disk is the wrong end of the machine. So
        // report the outcome whose remedy fits: something is in the way and
        // this start could not get hold of it.
        return {
          outcome: "unclaimable",
          error: new Error(
            `the record was claimed for removal and could not be put back, and ${path} could not be inspected to see whether anything now holds it`,
            { cause: e },
          ),
        };
      }

      return { outcome: "stranded", heldAt: claimed, displaced: held };
    }
  }

  /**
   * Publishes a record at `path` without replacing whatever may already be
   * there, by `link` where the filesystem has hard links and by an exclusive
   * create where it does not.
   *
   * A hard link is the better of the two and stays the first choice: it is one
   * step, so the record is never observed half written, and it fails rather
   * than overwrites. But it is a capability rather than a given. exFAT and
   * FAT32 have no hard links at all, and neither do many SMB/CIFS mounts,
   * WSL's DrvFs, or some cloud-sync file providers, and every one of them
   * fails the call outright — EPERM, ENOTSUP, ENOSYS. Treating that as fatal
   * made every start on such a filesystem fail, permanently, with a bare errno
   * that named nothing to do about it, and this module's own file writing was
   * the only thing that needed the capability.
   *
   * The fallback keeps the property this is here for and gives up the other
   * one. `wx` creates exclusively, so a name somebody else has taken still
   * comes back EEXIST and is never overwritten; what it cannot promise is that
   * a reader arriving mid-write sees the whole record. That reader sees an
   * unparseable one, which every reader here refuses on rather than acts on,
   * so the cost is a cautious refusal on a filesystem that could not have had
   * the guarantee anyway.
   *
   * EEXIST is rethrown from whichever step produced it, so callers keep
   * recognizing it as somebody having taken the name. ENOENT is rethrown
   * without a fallback at all: the source having gone means there is no record
   * in hand to publish, and writing `contents` anyway would put bytes under a
   * name whose record this call no longer holds.
   *
   * `contents` must be the record itself. Publishing an empty string would
   * create a name holding nothing, which every reader here treats as a corrupt
   * record and refuses on, so a caller without real bytes must not use this.
   */
  private async publishWithoutReplacing(
    source: string,
    path: string,
    contents: string,
  ): Promise<void> {
    try {
      await link(source, path);

      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;

      if (code === "EEXIST" || code === "ENOENT") {
        throw e;
      }

      // Opened rather than written in one call, so that creating the name and
      // failing to fill it are distinguishable. `wx` fails with EEXIST where
      // the name is taken, and a failure to open creates nothing, so there is
      // nothing to undo and nothing of anybody else's to touch.
      //
      // The open's own error, for the reason the write branch below gives:
      // the link failing is what sent us here and describes the filesystem,
      // while this one describes what actually went wrong. A read-only mount
      // and a directory this user may not write both fail HERE rather than at
      // the write, so throwing the link's error would report exactly the
      // "operation not permitted, link" that names the one thing that is not
      // the problem. EEXIST is not special-cased any more because nothing has
      // to be: it is rethrown as itself along with everything else, so callers
      // still recognize somebody having taken the name.
      const handle = await open(path, "wx");

      try {
        try {
          await handle.writeFile(contents);
        } finally {
          await handle.close();
        }
      } catch (failed) {
        // The name exists and does not hold the whole record. Only this call
        // could have created it, so removing it is safe, and leaving it would
        // strand exactly the half-written file the link was avoiding.
        await this.removeFileIfPresent(path);

        // The write's own error rather than the link's. The link failing is
        // what sent us here and describes the filesystem; this one describes
        // what actually went wrong, and reporting a full disk or a read-only
        // mount as "operation not permitted, link" points at the one thing
        // that is not the problem.
        throw failed;
      }
    }
  }

  /** Removes a file, ignoring the case where it is already gone. */
  private async removeFileIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Already gone, or not ours to remove — nothing to do either way.
    }
  }

  /**
   * Where a newly initialized cluster actually has to land.
   *
   * The configured path, except that a symlink is followed to what it points
   * at. `rename()` does not follow one in its final component, so publishing
   * onto a symlinked data directory would fail with ENOTDIR against a
   * perfectly good directory — and pointing `dataDir` at another volume
   * through a symlink is an ordinary thing to do, which the in-place `initdb`
   * this replaced handled by simply following it.
   *
   * A path that does not exist yet resolves to itself, which is the ordinary
   * first run: there is no link to follow and `rename()` creates the name. So
   * does a dangling symlink, whose target `realpath` cannot reach, and the
   * ENOTDIR that then comes back from the rename is reported for what it is.
   */
  private async resolveDataDirDestination(): Promise<string> {
    try {
      return await realpath(this.pgDataDir);
    } catch {
      return this.pgDataDir;
    }
  }

  /**
   * Runs initdb against one target, with the arguments both call sites share.
   *
   * Pin initdb's locale rather than inherit the host shell's: a Linux-style
   * LC_ALL=C.UTF-8 makes initdb fail on macOS, whose libc has no such locale,
   * and an inherited one makes collation vary per machine. "C" + UTF8 is valid
   * everywhere and sorts by byte order — right for a throwaway DB, so do not
   * "fix" it to en_US.
   *
   * `-U postgres`, so the cluster's superuser is a name this code chose rather
   * than one it has to work out. Without it initdb names the bootstrap
   * superuser after whoever ran it, and the connection then has to arrive at
   * the same name independently -- which means asking the operating system who
   * this process is, and being right on every platform and runtime. Where that
   * guess was wrong, every start failed with `role "..." does not exist`
   * against a database it had just created, and the guess was wrong in
   * ordinary situations: an inherited USERNAME, a container that pins it, a
   * process launched under other credentials.
   *
   * A name that is decided here cannot disagree with itself. It also makes the
   * cluster independent of the account that happened to create it, so a data
   * directory still works when the next start runs as somebody else.
   */
  private async runInitdb(
    pgBinaries: PostgresBinaries,
    target: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return this.runPgCommand(pgBinaries.initdb, [
      "-D",
      target,
      "-U",
      LocalDevDBServer.BOOTSTRAP_USER,
      "--locale=C",
      "--encoding=UTF8",
    ]);
  }

  /**
   * Turns a failed initdb into an error carrying initdb's own diagnosis.
   *
   * runPgCommand captures that output and nothing else reads it, so discarding
   * it left the one message that says WHY unread: a locale libc rejects, a
   * directory that is not empty, or on macOS an exhausted SysV shared-memory
   * table, whose "No space left on device" reads as a full disk until you see
   * it came from initdb. A caller left with only "failed to initialize" has to
   * go and reproduce the failure by hand to learn anything at all.
   */
  private initdbFailure(result: {
    stdout: string;
    stderr: string;
    code: number | null;
  }): Error {
    const detail = result.stderr.trim() || result.stdout.trim();

    return new Error(
      `Failed to initialize PostgreSQL data directory at ${this.pgDataDir}${
        detail
          ? `: ${detail}`
          : ` (initdb exited with code ${result.code} without reporting a reason)`
      }` + ipcExhaustionHint(detail),
    );
  }

  /** True while `path` is a directory holding nothing. */
  private async isEmptyDirectory(path: string): Promise<boolean> {
    try {
      return (await readdir(path)).length === 0;
    } catch {
      // Absent, not a directory, or not ours to list. None of the three is a
      // directory this may initialize into.
      return false;
    }
  }

  /**
   * Initializes the cluster inside `destination` itself, for a directory
   * nothing can be renamed onto.
   *
   * The one case the staged-and-renamed publish cannot serve, and it is an
   * ordinary setup rather than an exotic one: a `dataDir` that is a mount
   * point. A volume mounted there in a container or a devcontainer, or a
   * second disk parked at that path, is a filesystem of its own, so the
   * staging sibling — which lives in the PARENT directory — is on the other
   * side of a filesystem boundary. `rename()` refuses to cross one: macOS
   * reports EXDEV and Linux EBUSY for a mount point, and `rmdir` reports EBUSY
   * for one either way, so neither publishing nor clearing the name can work.
   * Verified against a real mounted volume rather than reasoned about.
   *
   * initdb has no such trouble, because it never crosses anything: it writes
   * into the directory it is given, which is what the in-place initdb this
   * replaced always did, and it accepts an existing directory as long as it is
   * empty. So this is the older behavior kept for exactly the case that needs
   * it, rather than a second strategy on the ordinary path.
   *
   * What it gives up is the protection the staging exists for, and it gives it
   * up in both directions. An initdb that is interrupted OR that fails leaves
   * the directory holding part of a cluster and no postgresql.conf, which the
   * next start reads as neither initialized nor empty and reports rather than
   * clears — see the failure branch below for why clearing it would be the one
   * destructive act this module never commits. Nothing serializes two starts
   * here either: the staged path is safe against that by construction, since
   * each stages under a name only it knows and the loser recognizes the
   * winner's postgresql.conf, while this one has every start writing into the
   * same directory. Both are the behavior a mounted `dataDir` had before any
   * of this, which is why they are confined to this path and why the ordinary
   * one is still the staged publish.
   */
  private async initializeInPlace(
    pgBinaries: PostgresBinaries,
    destination: string,
  ): Promise<void> {
    this.log(
      "setup",
      `${this.pgDataDir} is a filesystem of its own, so a cluster initialized beside it cannot be moved in. Initializing in place instead.`,
    );

    const initResult = await this.runInitdb(pgBinaries, destination);

    if (initResult.code !== 0) {
      // Deliberately nothing is removed, and this is the one place that
      // decision is worth spelling out, because tidying up looks free here
      // and is not.
      //
      // What is in the directory now is not what the emptiness check saw. The
      // check happened before an initdb that takes about half a second, and
      // the directory is SHARED: unlike the staging sibling, whose name is a
      // uuid nothing else knows, this name is the one every start against
      // this dataDir is aiming at. Two first-time starts can both find it
      // empty and both come here, and initdb refuses a directory that is not
      // empty — so the one that loses is the one that fails, and a cleanup
      // here would delete the WINNER's freshly initialized cluster out from
      // under a start that is about to spawn a postmaster against it. An
      // ordinary `rm -rf` of a listing taken after the await does the same to
      // anything else that wrote there meanwhile.
      //
      // That is the read-then-unlink the claim protocol at the top of this
      // file exists to rule out, and it cannot be claimed the same way: a
      // rename of a mount point is what does not work here in the first
      // place. Only positive disproof licenses destruction, and an emptiness
      // reading from before the write is not any.
      //
      // So the directory is left as it is, which is what the in-place initdb
      // this path restores always did. A retry reports it — the publish above
      // finds a destination that is no longer empty and says the remains of
      // an interrupted first run are in the way — and the message below says
      // the same thing while the reason is still in hand.
      throw new Error(
        this.initdbFailure(initResult).message +
          `\n\nAnything initdb wrote has been left in ${this.pgDataDir}, since this start cannot tell it apart from what another start or another program may have put there. ` +
          "Check what is in that directory and empty it before trying again.",
      );
    }
  }

  /**
   * Publishes the staged cluster at `destination`, clearing an empty
   * directory out of the way where the platform will not rename over one.
   *
   * POSIX `rename()` replaces an empty destination directory, so a first run
   * against a `dataDir` that already exists and is empty works there with
   * nothing extra. Windows does not: `MoveFileEx`'s replace flag is
   * documented as not applying to directories at all, so ANY existing
   * destination fails with EPERM, empty or not.
   *
   * Pre-creating the data directory is an ordinary thing to do — a volume
   * mount, a `mkdir -p` in a setup script, a directory an earlier version's
   * in-place `initdb` was pointed at — and every one of those would otherwise
   * fail the FIRST start on Windows, with the message below telling the
   * caller to check what is in a directory that is empty. That is the one
   * case the staged-and-renamed publish must not have made worse than the
   * in-place initdb it replaced.
   *
   * So an empty destination is removed and the rename tried once more. Only
   * an empty one, and `rmdir` is what establishes that rather than a listing:
   * it refuses a directory holding anything, so the decision and the removal
   * are a single syscall and nothing can be deleted on the strength of a
   * reading that was already stale. It also refuses a file and a symlink,
   * which is what leaves the ENOTDIR diagnosis below reporting itself.
   *
   * Anything else, and any second failure, reports the ORIGINAL error. That
   * is the one describing what is actually in the way, and the caller's
   * branches read its errno.
   */
  private async publishInitializedCluster(
    staged: string,
    destination: string,
  ): Promise<void> {
    try {
      await rename(staged, destination);
    } catch (e) {
      try {
        await rmdir(destination);
      } catch {
        // Not there, not empty, or not ours to remove. Nothing was cleared,
        // so there is nothing to try again and the first error still stands.
        throw e;
      }

      try {
        await rename(staged, destination);
      } catch {
        // The name was free a moment ago and is not now — another start
        // publishing into it is the way that happens, and the caller's own
        // race check reads that from the config it left. Either way the
        // first error is the one that says what was in the way.
        throw e;
      }
    }
  }

  /**
   * Removes a directory tree this instance created, ignoring a failure.
   *
   * Only ever called on the staging directory initdb was pointed at, whose
   * name is unique to this call, so there is nothing here that could belong to
   * anybody else. A failure to tidy it is logged rather than thrown: the
   * caller is already reporting why the initialization failed, and losing that
   * to a cleanup error would replace the diagnosis with the housekeeping.
   */
  private async removeDirectoryIfPresent(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (e) {
      this.log(
        "warn",
        `Could not remove the partially initialized data directory at ${path}: ${e}`,
      );
    }
  }

  /**
   * Removes the PID file, but only while it still holds this invocation's own
   * record.
   *
   * Having written a record is not the same as the file still holding it. A
   * `close` can fire long after the child is gone — an inherited stdio handle
   * keeps it pending, as the "exit" hook notes — by which time another server
   * may have replaced the record. Removing it on the strength of having once
   * written one would delete that server's live record and leave it running
   * unrecorded. So this is the claim protocol like any other removal, with
   * this invocation's own bytes as the accounted record.
   *
   * Those bytes come from {@link pidRecord} rather than from the child handle,
   * which a lifecycle handler may already have dropped.
   *
   * Nothing here throws. Failing to tidy a file must not be what stops the
   * process exiting — see finalize — so every outcome that is not a removal
   * reports itself to the log and returns.
   */
  private async releasePidRecord(): Promise<void> {
    const ownRecord = this.pidRecord;

    if (ownRecord === null) {
      return;
    }

    // Before the first await, so two callers cannot both reach the unlink.
    this.pidRecord = null;

    // A cheap look first, so a record that is plainly somebody else's is never
    // moved at all and the claim below stays confined to the case that is
    // genuinely ambiguous.
    if (!(await this.pidRecordIsOurs(this.pidFile, ownRecord))) {
      return;
    }

    // Trimmed on both sides, which is the identity this instance has always
    // used for its own record: it wrote the bytes, so trailing whitespace is
    // not somebody else having taken the name.
    const removal = await this.removeRecordIfUnchanged(
      this.pidFile,
      ownRecord.trim(),
      (raw) => raw.trim(),
    );

    if (removal.outcome === "unclaimable") {
      // It was confirmed to be ours a moment ago, so the next start finds a
      // record naming a server that has stopped and spends its escalation
      // proving that before it may remove it. Nothing here can fix that.
      this.log(
        "warn",
        `Left this server's PID record at ${this.pidFile}: it could not be claimed for removal (${removal.error})`,
      );

      return;
    }

    if (removal.outcome === "discarded") {
      // A third record holds the name and is newer than the one being put
      // back, so there was nowhere for the displaced one to go. That makes
      // this the one path where releasing a record destroys one it does not
      // own, which is not something to do quietly.
      this.log(
        "warn",
        `Discarded ${this.describeRecord(removal.displaced)}: another server replaced it at ${this.pidFile} while it was being put back`,
      );

      return;
    }

    if (removal.outcome === "stranded") {
      // Not ours to destroy and it could not go back, so leave it where a
      // person can find it and say where that is.
      this.log(
        "warn",
        `Left ${this.describeRecord(removal.displaced)} at ${removal.heldAt}. It could not be restored to ${this.pidFile}`,
      );
    }
  }

  /** Names whose record some displaced bytes are, for a log line. */
  private describeRecord(displaced: string | null): string {
    const record = displaced === null ? null : parseDevDBPidRecord(displaced);

    return record === null
      ? "an unreadable PID record"
      : `the PID record for server ${record.pid}`;
  }

  /**
   * True while the record at `path` is the one this invocation wrote.
   *
   * An unreadable record is not ours: this invocation writes a complete record
   * atomically, so whatever is there was put there by something else. That
   * leaves it for a person, which is the same bar cleanupExistingProcess
   * applies to a record it cannot read.
   */
  private async pidRecordIsOurs(
    path: string,
    ownRecord: string,
  ): Promise<boolean> {
    try {
      return (await readFile(path, "utf8")).trim() === ownRecord.trim();
    } catch {
      // Absent, or not readable by us. Either way it is not ours to remove.
      return false;
    }
  }

  /**
   * The identity of the record at `path`, established as the one the status
   * probe actually examined, or null when there is none to account for.
   *
   * `before` is the identity read ahead of the probe. Matching it afterwards
   * is what ties the two together. A record that arrived or changed during the
   * probe was never evaluated by it, and nothing here has standing to delete
   * it, so that is a refusal rather than an accounted record.
   *
   * A record that went away is not: that is what a clean shutdown looks like,
   * and there is then nothing to delete. Should one reappear before the
   * removals at the end of cleanupExistingProcess, the null-accounted branch
   * there refuses on it.
   */
  private async accountedRecord(
    path: string,
    before: string | null,
    identify: (raw: string) => string,
  ): Promise<string | null> {
    const raw = await this.readAccountedPidFileBytes(path);
    const after = raw === null ? null : identify(raw);
    const examined = before === null ? null : identify(before);

    if (after === examined || after === null) {
      return after;
    }

    throw new Error(
      `${path} changed while the previous server for ${this.pgDataDir} was being identified, so something has taken this data directory since. ` +
        "That file is what stops a second server being started against this data directory, so it has been left in place. " +
        "Check what is running for this data directory before starting the dev server.",
    );
  }

  /**
   * Refuses to delete strataline's own PID record unless this start can say it
   * is this cluster's to delete.
   *
   * statusFromPidFile already applies these rules, but only ever to a status
   * that came from that file. A verified postmaster.pid settles what is
   * serving THIS directory on its own, and probeStatusFromFiles then returns
   * without reading strataline's record at all — so the removal below would
   * delete a record nothing examined. Being unchanged across the probe is not
   * the same as having been looked at: accountedRecord proves only that the
   * bytes deleted are the bytes that were there, never that anything formed a
   * view about them.
   *
   * That gap is reachable exactly where the different-cluster refusal was
   * written for. Point two data directories at one `pidFile`, start the second
   * while the first is running, and this cluster's own postmaster.pid verifies,
   * is stopped, and the other server's live record is erased on the way past.
   *
   * So the same two refusals apply here, and for the same reasons they apply
   * there: a record naming another directory whose server is still live, and a
   * record that could not be read at all. Which of the two files happened to
   * settle what is running does not change whose record this one is, and a
   * rule that held on one path and not the other would be decided by that
   * accident rather than by the record.
   *
   * A record naming THIS cluster is the ordinary case, is this start's to
   * remove, and costs no probe to recognize.
   */
  private async refuseUnexaminedPidRecord(accounted: string): Promise<void> {
    const record = parseDevDBPidRecord(accounted);

    // Unreadable is not the same as harmless. This start formed no view of it,
    // so it cannot say the record is its own, and destroying what it cannot
    // identify is the one thing the rest of this module never does.
    if (record === null) {
      throw new Error(
        `${this.pidFile} could not be read as a Strataline PID record, and the server for ${this.pgDataDir} was identified without it, so nothing here established whose record it is. ` +
          "It has been left in place. Check that no server is using this pidFile, then remove that file and try again.",
      );
    }

    // A legacy record is the bare PID and nothing else, so the record itself
    // can never say whose it is. Ask the same verifier used everywhere else.
    // That preserves the important undecidable cases: a relative -D belongs to
    // the target process's working directory, a flat command line may have cut
    // a path off at a space, and a PostgreSQL inheriting PGDATA names no
    // directory at all. None licenses deleting its record.
    if (!record.dataDir) {
      // Keep the command that made the verification decisive. Reading it
      // again below would be a second process snapshot, and a transient miss
      // on that read must not turn proof of a live foreign server into
      // permission to erase its record.
      let observedCommand: string | null = null;
      const check = verifyPid(record.pid, {
        startedAt: null,
        bootTime: null,
        dataDir: this.pgDataDir,
        probes: {
          ...this.pidVerificationProbes,
          command: (pid) => {
            observedCommand = this.pidVerificationProbes.command(pid);

            return observedCommand;
          },
        },
      });

      if (check.verifiedBy !== null || check.kind === "process-gone") {
        return;
      }

      if (check.kind === "indeterminate") {
        throw new Error(
          `${this.pidFile} holds a metadata-free PID record whose PID ${record.pid} could not be tied to this data directory or safely ruled out (${check.reason}). ` +
            "It has been left in place. Check which server owns it before starting this one.",
        );
      }

      // At this point the verifier positively ruled out this cluster. It may
      // be an unrelated program, in which case the recorded server is gone and
      // the stale record may be removed, or a live PostgreSQL for another
      // absolute data directory, whose record must be preserved. The verifier
      // has already rejected relative and ambiguous parses, so this second
      // use of its observation tells those two decisive recycled cases apart
      // without a second process snapshot.
      const declared =
        observedCommand === null ? null : dataDirFromCommand(observedCommand);

      if (
        declared === null ||
        !isAbsolute(declared) ||
        sameDataDir(declared, this.pgDataDir)
      ) {
        return;
      }

      // Still requires the process to be identifiable as that cluster's
      // server. A dead number, or one an unrelated program picked up after a
      // reboot, must not refuse — see otherClusterStillLive.
      if (!this.otherClusterStillLive(record.pid, declared)) {
        return;
      }

      throw new Error(
        `${this.pidFile} holds an old-format PID record whose PID ${record.pid} is a live server for another data directory (${declared}), and the server for ${this.pgDataDir} was identified without it. ` +
          "Removing it would leave that server running with nothing recording it, so it has been left in place. " +
          "Give each data directory its own pidFile, or stop that server before starting this one.",
      );
    }

    if (sameDataDir(record.dataDir, this.pgDataDir)) {
      return;
    }

    // Naming another cluster is not enough. The refusal is a hard stop, so it
    // takes evidence that the other server is actually there rather than that
    // its number is in use — see otherClusterStillLive.
    if (!this.otherClusterStillLive(record.pid, record.dataDir, record.uid)) {
      return;
    }

    throw new Error(
      `${this.pidFile} describes a live server (PID ${record.pid}) for another data directory (${record.dataDir}), and this start identified the server for ${this.pgDataDir} without it. ` +
        "Removing it would leave that server running with nothing recording it, so it has been left in place. " +
        "Give each data directory its own pidFile, or stop that server before starting this one.",
    );
  }

  /** Stops a verified previous server or rejects when its identity is unsafe. */
  private async cleanupExistingProcess(): Promise<void> {
    const postmasterPidFile = join(this.pgDataDir, "postmaster.pid");

    // Read BEFORE the probe as well as after. Probing is not instant — it may
    // open a connection and wait out a three-second timeout — and reading only
    // afterwards would let a record written during that window become the one
    // this start accounts for without the status decision having examined it
    // at all. The removals at the end would then delete a live postmaster.pid
    // as unchanged, orphaning the server that had just claimed the directory.
    const priorPidFile = await this.readAccountedPidFileBytes(this.pidFile);
    const priorPostmasterPid =
      await this.readAccountedPidFileBytes(postmasterPidFile);

    const status = await getLocalDevDBServerStatus({
      pidFile: this.pidFile,
      dataDir: this.pgDataDir,
      // The same probes every other decision in this start is made from, so
      // the status and the refusals that read it describe one machine.
      probes: this.pidVerificationProbes,
      connection: {
        port: this.pgPort,
        user: this.pgUser,
        password: this.pgPass,
        database: this.pgDb,
      },
    });

    // The records this start is deciding about, confirmed to be the ones the
    // decision was made against. Whatever gets deleted at the end has to be
    // these, and not something that replaced them meanwhile.
    const accountedPidFile = await this.accountedRecord(
      this.pidFile,
      priorPidFile,
      (raw) => raw,
    );
    const accountedPostmasterPid = await this.accountedRecord(
      postmasterPidFile,
      priorPostmasterPid,
      postmasterRecordIdentity,
    );

    if (status.running && !status.pid) {
      throw new Error(
        `A PostgreSQL server is running for ${this.pgDataDir} but its process could not be identified (${status.reason}). ` +
          "Stop it manually before starting the dev server.",
      );
    }

    if (status.running && status.pid) {
      const captured = this.captureSignalFingerprint(
        status.pid,
        status.observedStartTime,
      );

      if (!captured) {
        throw new Error(
          `PID ${status.pid} was reported as this cluster's server, but the process now at that number could not be tied to it, so the number appears to have changed hands while it was being checked. ` +
            "Nothing was signaled. Re-run, or stop the server manually.",
        );
      }

      const { fingerprint } = captured;

      // A `reused` outcome is not a failure: the number demonstrably changed
      // hands, which it could only do once the recorded server exited, so the
      // data directory is free. Refusing on it would send a person off to stop
      // a server that has already gone, and name an unrelated process to them.
      //
      // The one escalation with no backstop over it, deliberately: this target
      // is a previous run's process reached by number, not a child this
      // instance holds — see terminateOwnChild.
      if (
        (await this.terminateProcess(status.pid, "PostgreSQL server", {
          kind: "recorded",
          fingerprint,
        })) === "failed"
      ) {
        // Deleting the PID files now would erase the only record of a server
        // that is still running, and starting a second one against the same
        // data directory risks corruption. Fail loudly instead.
        throw new Error(
          `A PostgreSQL server is running at PID ${status.pid} for ${this.pgDataDir} and could not be stopped. ` +
            "Stop it manually before starting the dev server.",
        );
      }
    } else if (status.indeterminate) {
      const subject =
        status.pid === null
          ? "An existing PID record could not be read"
          : "A process is running at PID " +
            status.pid +
            " that could not be identified";

      // Two problems with two different fixes, so do not give one answer to
      // both. An unidentifiable process has to be stopped. An unreadable
      // record names no process at all, so there may be nothing running and
      // the file itself is the thing to remove: exactly the one the reason
      // above names, which says whether it is PostgreSQL's or Strataline's.
      const remedy =
        status.pid === null
          ? "Check that no server is running for this data directory, then remove that file and try again."
          : "Stop it manually before starting the dev server.";

      throw new Error(
        subject +
          " (" +
          status.reason +
          "). " +
          "It may be a server for this data directory, so it is neither safe to signal nor safe to forget. " +
          remedy,
      );
    } else if (
      status.staleKind === "different-cluster" &&
      status.pid &&
      this.otherClusterStillLive(status.pid, status.dataDir)
    ) {
      // Name the actual conflicting record so the error suggests the right fix.
      const offendingFile =
        status.source === "postmaster" ? postmasterPidFile : this.pidFile;

      throw new Error(
        `${offendingFile} describes a live server for another data directory (${status.reason}). ` +
          "Overwriting it would orphan that server. " +
          (status.source === "postmaster"
            ? "This data directory appears to have been copied from another cluster; remove its stale postmaster.pid only once you are sure that server is stopped."
            : "Give each data directory its own pidFile, or stop that server before starting this one."),
      );
    } else if (status.pid) {
      this.log(
        "setup",
        `Ignoring unverified PID ${status.pid} (${status.reason}); no signal sent`,
      );
    }

    // Both files are about to be deleted on the strength of a decision made
    // before an escalation that takes seconds, and postmaster.pid is not
    // strataline's bookkeeping: it is the first of PostgreSQL's two interlocks
    // against a second postmaster on one data directory. The shared memory
    // segment is the second and it holds — a postmaster started against a data
    // directory whose live postmaster.pid was deleted still refuses, with
    // "pre-existing shared memory block is still in use", verified rather than
    // assumed — which bounds the damage to a server left running unrecorded
    // and this start then failing with a message about shared memory that says
    // nothing about what happened. Worth preventing, and worth not overstating.
    //
    // Recognize the record rather than ask about the PID inside it again. A
    // postmaster claiming this directory writes its own postmaster.pid as part
    // of taking the lock, so unchanged bytes are still the record this start
    // accounted for, whatever has become of the number they name. Re-probing
    // would be strictly worse: a number recycled to a process nothing can
    // identify makes a provably stale file look undecidable, and refuses over
    // a data directory that is free. Removal itself follows the claim protocol
    // at the top of this file.
    //
    // postmaster.pid first, since it is the one that matters. A stale record
    // this start accounted for is safe to remove whatever the outcome for the
    // other file, so removing it before a later refusal loses nothing.
    for (const guarded of [
      {
        path: postmasterPidFile,
        accounted: accountedPostmasterPid,
        identify: postmasterRecordIdentity,
      },
      {
        path: this.pidFile,
        accounted: accountedPidFile,
        identify: (raw: string) => raw,
      },
    ]) {
      if (guarded.accounted === null) {
        // Nothing was there when this start decided, so anything there now
        // arrived since and describes something this start knows nothing of.
        if ((await this.readAccountedPidFileBytes(guarded.path)) === null) {
          continue;
        }

        throw new Error(
          `${guarded.path} appeared while the previous server for ${this.pgDataDir} was being stopped, so something has taken this data directory since. ` +
            "That file is what stops a second server being started against this data directory, so it has been left in place. " +
            "Check what is running for this data directory before starting the dev server.",
        );
      }

      // Only strataline's file can be a record this start never examined:
      // probeStatusFromFiles always reads postmaster.pid first, so that one is
      // examined on every path that reaches here.
      if (guarded.path === this.pidFile) {
        await this.refuseUnexaminedPidRecord(guarded.accounted);
      }

      const removal = await this.removeRecordIfUnchanged(
        guarded.path,
        guarded.accounted,
        guarded.identify,
      );

      if (removal.outcome === "unclaimable") {
        this.log(
          "error",
          `Could not claim the PID record at ${guarded.path} for removal: ${removal.error}`,
        );

        // Still there, and this start could not take hold of it. Say so rather
        // than start anyway: PostgreSQL refuses against a data directory that
        // still has a postmaster.pid, and writePidRecord links into the same
        // directory this one could not be renamed out of, so both of the
        // failures this would otherwise defer to name something other than the
        // permissions that actually caused it. The log line above carries the
        // errno, in the same way the stranded branch below points at its own.
        throw new Error(
          `${guarded.path} holds a stale record that this start could not claim for removal, so it has been left in place. ` +
            "Check the permissions on that path, remove the file, and try again.",
        );
      }

      if (removal.outcome === "discarded") {
        this.log(
          "warn",
          `Discarded a PID record from ${guarded.path}: another server replaced it there while it was being put back`,
        );
      }

      if (removal.outcome === "stranded") {
        this.log(
          "error",
          `Left a PID record at ${removal.heldAt} that could not be restored to ${guarded.path}`,
        );
      }

      if (
        removal.outcome === "restored" ||
        removal.outcome === "discarded" ||
        removal.outcome === "stranded"
      ) {
        throw new Error(
          `${guarded.path} holds a record that was not there when the previous server for ${this.pgDataDir} was stopped, so something has taken this data directory since. ` +
            (removal.outcome === "stranded"
              ? "It could not be put back, and the log says where it is now. "
              : "It has been left in place, since that file is what stops a second server being started against this data directory. ") +
            "Check what is running for this data directory before starting the dev server.",
        );
      }

      if (removal.outcome === "removed" && guarded.path === postmasterPidFile) {
        this.log("setup", "Removed stale postmaster.pid file");
      }
    }
  }

  /**
   * Which lifecycle this instance is in, decided the same way `start()` and
   * `stop()` decide whether to refuse.
   *
   * There to be asked BEFORE either of them, since both refuse an overlap by
   * throwing and neither is a way to find out. A host with more than one route
   * into a stop — a signal handler and its own teardown, say — has no other
   * way to tell "a shutdown is already running" from "a start is, and this
   * call is about to throw".
   *
   * A snapshot, and only the instance's own view. It says nothing about a
   * server left by a previous run, which is {@link getLocalDevDBServerStatus}'s
   * question and is answered from the PID records rather than from memory. Nor
   * does it survive an await: the answer can be stale by the time it is read,
   * so it belongs in a log line or a branch that tolerates being wrong, not in
   * a check that a subsequent call is relied on to pass.
   *
   * - `stopped` — nothing held. `start()` starts, `stop()` resolves with
   *   nothing to do.
   * - `starting` — `start()` and `stop()` both throw. Await the start.
   * - `running` — `stop()` stops it, `start()` logs and resolves.
   * - `stopping` — `start()` throws, `stop()` joins the shutdown in flight.
   * - `unstoppable` — a failed start left a child that outlived even SIGKILL
   *   and this instance is still holding it. `start()` throws, `stop()` runs
   *   the escalation against it again. It is a state the instance LEAVES: the
   *   child's own exit runs the lifecycle cleanup, which drops the reference,
   *   and the next reading is `stopped` with `start()` working normally again.
   *
   * `stopping` is the one asymmetric row, and {@link stop} says why: a stop
   * that refuses would leave a server running, so it waits instead.
   *
   * `running` is decided from what Node reports about the child rather than
   * from holding a reference to it, for the reason `start()` gives: a
   * postmaster that died without signaling its children leaves them holding
   * the inherited stdio pipes, and the reference outlives the server. There is
   * no state for an exited child whose cleanup is outstanding, because that is
   * no longer a place an instance rests: the lifecycle handler runs on the
   * child's `exit`, so the PID record is released as soon as the process is
   * gone rather than when the pipes close.
   */
  public getLifecycleState(): DevDBLifecycleState {
    // Ordered as the guards are, so the answer and the refusal cannot
    // disagree: a shutdown that is winding down a child still reads
    // `stopping` rather than `running`.
    if (this.shutdownInFlight || this.isCleaningUp) {
      return "stopping";
    }

    if (this.startInFlight || this.startingUp) {
      return "starting";
    }

    const proc = this.pgProcess;

    // Ahead of the handle, which cannot see this. A failed start that could
    // not kill its child keeps the reference deliberately, and start() refuses
    // while it holds it — including after the child has died, in the window
    // before the lifecycle cleanup drops the reference. Reading the handle
    // here would answer `running` in the first case and `stopped` in the
    // second, and both of those rows promise a start() that in fact throws.
    // This is exactly the state the method exists to report, since the call
    // that would otherwise reveal it is the one throwing.
    //
    // Only while the reference is held, which is the whole life of the state:
    // once finalize() nulls pgProcess this reads `stopped` and start() works,
    // because a child that has exited and been cleaned up after is no longer
    // in anybody's way.
    if (proc && this.unstoppableChild === proc) {
      return "unstoppable";
    }

    return proc && proc.exitCode === null && proc.signalCode === null
      ? "running"
      : "stopped";
  }

  /**
   * Stops the server. Idempotent, and joins a shutdown already running.
   *
   * Deliberately more forgiving than {@link start}, which refuses every
   * overlap. Teardown is idempotent nearly everywhere for a reason — Node's
   * own `net.Server.close()`, Go's `http.Server.Shutdown` — and it is a
   * sharper reason here than convention: the two refusals fail in opposite
   * directions. A `start()` that refuses leaves no server, which is visible
   * and costs a retry. A `stop()` that refuses leaves a postmaster running,
   * holding the port and the data directory, which is the exact outcome this
   * module exists to prevent, and it would be produced by the one call whose
   * whole job was to prevent it. So a second stop waits for the first rather
   * than throwing into a host that may have nowhere left to handle it.
   *
   * What a joined caller gives up is knowing whose request stopped the server:
   * the escalation belongs to whoever asked first, so a `stop()` joined to a
   * `shutdown("SIGTERM")` resolves for a stop it had no part in, and a failure
   * rejects both. Ask {@link getLifecycleState} before calling where that
   * distinction matters. Nobody has to ask in order to be correct, which is
   * the point of the leniency.
   *
   * Refused only against a start, which is not an overlap this can wait out:
   * the escalation would race the spawn it is trying to stop. Await `start()`
   * first.
   */
  public async stop(): Promise<void> {
    if (this.startInFlight || this.startingUp) {
      throw new Error(
        "Cannot stop PostgreSQL server: server is currently starting.",
      );
    }

    return this.handleGracefulShutdown(null);
  }

  /**
   * {@link stop} with `signal` recorded in the log, for a host stopping the
   * server because it was itself signaled. The same call otherwise: identical
   * refusals, and what reaches PostgreSQL is always the SIGINT to SIGQUIT to
   * SIGKILL escalation, since `signal` says what happened to the host rather
   * than what this server needs.
   */
  public async shutdown(signal: NodeJS.Signals): Promise<void> {
    if (this.startInFlight || this.startingUp) {
      throw new Error(
        "Cannot stop PostgreSQL server: server is currently starting.",
      );
    }

    return this.handleGracefulShutdown(signal);
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
    options: { user?: string; silent?: boolean; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const { user = "postgres", silent = false, timeoutMs } = options;

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

      let settled = false;

      // Opt-in, and off for the callers with no bound worth guessing at.
      // initdb is the one that matters: it takes about half a second on a
      // warm local disk, but what it actually costs is a function of the
      // filesystem underneath it, and a timeout here would not shorten a slow
      // one, it would kill it part way. It is for the callers that run inside
      // a bounded operation and would otherwise hand an unbounded wait to a
      // caller that was promised a bound.
      let timer: NodeJS.Timeout | undefined;

      const finish = (result: {
        stdout: string;
        stderr: string;
        code: number | null;
      }): void => {
        if (settled) {
          return;
        }

        settled = true;

        if (timer) {
          clearTimeout(timer);
        }

        resolve(result);
      };

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          // Reported as a spawn that produced no exit code, which is what a
          // caller already has to handle: `code === null` is the failed-spawn
          // answer too, and neither one signaled anything.
          childProcess.kill("SIGKILL");

          finish({
            stdout,
            stderr: stderr || `timed out after ${timeoutMs}ms and was killed`,
            code: null,
          });
        }, timeoutMs);
      }

      // A failed spawn emits "error" and never "close", so without this the
      // event is unhandled — which throws — and the promise never settles,
      // hanging every caller, Windows shutdown through pg_ctl included.
      childProcess.on("error", (err) => {
        finish({
          stdout,
          stderr: stderr || String(err),
          code: null,
        });
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
        finish({
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
   * @param timeoutMs Bound on connecting and on each query, for a caller that
   *   has a deadline of its own. The forgiving defaults suit setup work, whose
   *   caller is waiting on it and nothing else; a poll inside a bounded wait
   *   needs its attempts to cost less than the wait — see waitForServerReady.
   * @returns Connected PostgreSQL client
   */
  private async createClient(
    user: string = "postgres",
    database: string = "postgres",
    timeoutMs?: number,
  ): Promise<Client> {
    const password = user === "postgres" ? "postgres" : this.pgPass;

    const client = new Client({
      host: "127.0.0.1", // Force IPv4 instead of localhost (which might resolve to IPv6)
      port: this.pgPort,
      user: user,
      password: password,
      database: database,
      // Increase timeouts to be more forgiving during startup
      connectionTimeoutMillis: timeoutMs ?? 10000,
      query_timeout: timeoutMs ?? 15000,
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
  private async initializeDataDirectory(
    pgBinaries: PostgresBinaries,
  ): Promise<void> {
    // Check if PostgreSQL data directory exists and is initialized
    const configExists = await fileExists(
      join(this.pgDataDir, "postgresql.conf"),
    );

    if (!configExists) {
      this.log(
        "setup",
        `Initializing new PostgreSQL data directory at ${this.pgDataDir}...`,
      );

      // initdb runs into a sibling and the result is renamed into place, so
      // the data directory only ever exists initialized. It is the same
      // publish-by-rename the PID record uses, for a sharper reason: initdb is
      // the one step in a start with no bound on it, and on a first run it is
      // the step there is nothing else to wait for — so it is where an
      // interruption lands. It is quick on a warm local disk, about half a
      // second, which is not a guarantee about anybody else's filesystem and
      // is no help at all to whoever hits Ctrl+C during it.
      //
      // Interrupted in place it left a directory with no postgresql.conf in
      // it, which is neither a cluster nor absent: the check above sees no
      // config and runs initdb again, and initdb refuses a directory that is
      // not empty. Every later start then failed the same way until somebody
      // deleted the directory by hand.
      //
      // A sibling, so the rename cannot fail with EXDEV, and uniquely named,
      // so two starts racing for one data directory do not also race here.
      // What an interruption strands now is that sibling, which nothing looks
      // for and which no start consults.
      //
      // Sibling of the RESOLVED path, which is what makes a symlinked data
      // directory keep working. rename() does not follow a symlink in its
      // final component, so renaming onto one fails with ENOTDIR however good
      // the directory behind it is — and parking pgdata on another volume
      // through a symlink is an ordinary thing to do, which initdb itself
      // handles by simply following it. Resolving first puts the cluster
      // where the link points and leaves the link alone. sameDataDir already
      // canonicalizes for the same reason.
      const destination = await this.resolveDataDirDestination();
      const stagedDataDir = `${destination}.${randomUUID()}.init`;

      // The parent, rather than the data directory itself. initdb creates its
      // own target and is where the directory now comes from.
      await mkdir(dirname(destination), { recursive: true });

      const initResult = await this.runInitdb(pgBinaries, stagedDataDir);

      if (initResult.code !== 0) {
        await this.removeDirectoryIfPresent(stagedDataDir);

        throw this.initdbFailure(initResult);
      }

      try {
        await this.publishInitializedCluster(stagedDataDir, destination);
      } catch (e) {
        await this.removeDirectoryIfPresent(stagedDataDir);

        const code = (e as NodeJS.ErrnoException)?.code;

        // Another start got there first. Two of these racing for one fresh
        // data directory both stage a cluster and both try to publish it, and
        // the one that loses must not report the winner's work as rubble to
        // be deleted. A config at the destination is that race and nothing
        // else, since this branch only runs when there was none.
        if (await fileExists(join(this.pgDataDir, "postgresql.conf"))) {
          this.log(
            "setup",
            `Another start initialized ${this.pgDataDir} first. Using that cluster.`,
          );

          return;
        }

        // A destination that is still there and still empty is one nothing
        // can be renamed onto or removed — a mount point, in practice. initdb
        // will happily write into it, so fall back to that rather than report
        // a directory full of files that is in fact empty. See
        // initializeInPlace, which is also where what this gives up is
        // written down.
        if (await this.isEmptyDirectory(destination)) {
          await this.initializeInPlace(pgBinaries, destination);

          return;
        }

        // An empty destination has already been cleared and retried by
        // publishInitializedCluster, and one that could be neither is handled
        // just above, so a directory reaching here is one holding something.
        // That is not this start's to delete: it may be a data directory left
        // half initialized by an older strataline, and it may equally be a
        // directory the caller pointed `dataDir` at by mistake, with files in
        // it that are not PostgreSQL's at all. Nothing here can tell those
        // apart, and only one of them is safe to remove, so say what is in the
        // way instead.
        // EPERM and EACCES join the list only where the destination is
        // actually there, which is what tells "the name is taken" apart from
        // "this user may not write here". POSIX rename() replaces an empty
        // destination directory and reports ENOTEMPTY for one holding
        // anything; Windows MoveFile refuses a destination that exists at all
        // and reports EPERM, so the same situation arrives under a different
        // errno and used to fall through to a bare rename error naming two
        // paths and no cause.
        const destinationExists =
          (code === "EPERM" || code === "EACCES") &&
          (await fileExists(destination));

        if (
          code === "ENOTEMPTY" ||
          code === "EEXIST" ||
          code === "EXDEV" ||
          destinationExists
        ) {
          throw new Error(
            `${this.pgDataDir} already holds files but is not an initialized PostgreSQL cluster, so a new one could not be moved into place. ` +
              "It may be the remains of an interrupted first run, or a directory that is not meant to be a data directory at all. " +
              "Check what is in it, then remove it and try again.",
            { cause: e },
          );
        }

        // Not a directory at all. A regular file where the data directory
        // should be is the everyday way to reach this, and a symlink pointing
        // at nothing is the other: resolving above leaves a dangling one as
        // itself, and rename will not replace it either.
        if (code === "ENOTDIR") {
          throw new Error(
            `${this.pgDataDir} exists but is not a directory, so a PostgreSQL data directory could not be created there. ` +
              "It may be a file, or a symlink pointing at something that is not there. " +
              "Check that path, then remove it or point dataDir somewhere else and try again.",
            { cause: e },
          );
        }

        throw e;
      }
    } else {
      this.log(
        "setup",
        `PostgreSQL data directory already initialized at ${this.pgDataDir}.`,
      );
    }
  }

  /**
   * The superuser every cluster this code creates is initialized with.
   *
   * `postgres` because that is the name PostgreSQL installations use by
   * convention, so a person reaching for psql against this data directory
   * guesses right.
   */
  private static readonly BOOTSTRAP_USER = "postgres";

  /**
   * The superuser this cluster actually answers to, once one has connected.
   *
   * Not simply {@link BOOTSTRAP_USER}, because a data directory initialized by
   * an older strataline has a superuser named after whoever ran initdb that
   * day. Those clusters keep working: readiness tries the names in order and
   * remembers the one that answered, so an upgrade needs no migration and no
   * flag.
   */
  private bootstrapUser: string | null = null;

  /**
   * Who to try connecting as, best first.
   *
   * The current OS user is still a candidate, and last, since that is what an
   * older cluster was initialized with. It may well be the wrong name -- that
   * is the whole reason it is no longer relied on -- but a wrong name simply
   * fails to connect, and the right one is already ahead of it.
   */
  private superuserCandidates(): string[] {
    return [...new Set([LocalDevDBServer.BOOTSTRAP_USER, this.currentUser])];
  }

  /**
   * Records what PostgreSQL wrote, logging it too when there is a logger.
   *
   * The chunk goes into the buffer exactly as it arrived. What is LOGGED is
   * trimmed, since that is one message to a person; what is kept is not, since
   * ipcExhaustionHint reads it. See PostgresOutputBuffer.
   */
  private noteServerOutput(
    chunk: string,
    stream: keyof typeof this.serverLines,
  ): void {
    // Verbatim, because ipcExhaustionHint and withServerOutput read this and a
    // line structure imposed here is one the pipe did not have.
    this.serverOutput.append(chunk);

    // Whole lines only, because the severity is read out of what comes out and
    // a severity word torn across a chunk boundary reads as no severity at
    // all. See PostgresOutputReader.
    this.logServerOutput(this.serverLines[stream].take(chunk));
  }

  /**
   * Logs a line one stream's assembler is still holding, once that stream has
   * ended.
   *
   * The last thing a postmaster writes is the reason it is exiting, and
   * nothing guarantees it ends in a newline, so this is what stops the one
   * line that matters being the one held back forever.
   *
   * One stream at a time, because they end one at a time. Flushing the pair
   * whenever either one ended would take the other's half-written line and log
   * it as a message, then log the rest of it as a second one, which is the tear
   * the assembler exists to prevent.
   */
  private flushServerStream(stream: keyof typeof this.serverLines): void {
    this.logServerOutput(this.serverLines[stream].flush());
  }

  /**
   * The same for both streams, where this code is the one deciding nothing
   * more is coming.
   *
   * For the two moments that is true rather than heard from the stream: a
   * failed start whose drain is done, and a shutdown that destroys the read
   * ends itself. A pipe destroyed here emits no `end`, so without this the
   * held line goes with it, and the assembler would carry it into whatever the
   * next start writes.
   */
  private flushServerOutput(): void {
    this.flushServerStream("stdout");
    this.flushServerStream("stderr");
  }

  /**
   * Puts a whole message through the logger at the level it asks for.
   *
   * PostgreSQL says how bad the line is, in the line. Reading it is what lets
   * a startup failure reach a logger's error level rather than sitting at
   * `info` alongside "listening on IPv4 address". Which message the level
   * belongs to, when the pipe broke one in half, is PostgresOutputReader's.
   */
  private logServerOutput(reads: PostgresOutputRead[]): void {
    for (const read of reads) {
      this.log("pg", read.text, read.level);
    }
  }

  /**
   * Appends what PostgreSQL said to a message that has to explain itself.
   *
   * The rule the initdb failure already follows: the process that failed is
   * the one that knows why, and dropping its output leaves the caller to
   * reproduce the failure by hand to learn anything. A major-version bump is
   * the everyday case — "database files are incompatible with server" against
   * a data directory an older PostgreSQL initialized — and without this it
   * reaches the caller as an exit code and nothing else.
   */
  private withServerOutput(message: string): string {
    const detail = this.serverOutput.read();

    return detail
      ? `${message}. PostgreSQL said:\n${detail}${ipcExhaustionHint(detail)}`
      : `${message}.`;
  }

  /**
   * Starts the PostgreSQL server process.
   */
  private async startPostgresServer(
    pgBinaries: PostgresBinaries,
  ): Promise<void> {
    this.log("setup", "Starting PostgreSQL server...");

    // IPv4 only, deliberately. On some hosts PostgreSQL's per-connection child
    // processes fail to set TCP_NODELAY on an IPv6 socket and log a FATAL
    // "setsockopt(TCP_NODELAY) failed: Invalid argument" — sometimes crashing.
    // Listening on 127.0.0.1 and connecting to it avoids IPv6 entirely.
    this.pgProcess = spawn(
      pgBinaries.postgres,
      [
        "-D",
        this.pgDataDir,
        "-p",
        this.pgPort.toString(),
        // Force IPv4 only to avoid TCP_NODELAY socket errors
        "-c",
        "listen_addresses=127.0.0.1",
        // Pinned rather than inherited from the data directory's own config.
        // See PINNED_LOG_LINE_PREFIX: `%a` in a prefix is the connecting
        // client's application_name, which is arbitrary text sitting ahead of
        // the severity this reads.
        "-c",
        `log_line_prefix=${PINNED_LOG_LINE_PREFIX}`,
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

    // Without a listener a failed spawn throws out of the event loop rather
    // than failing start() — see runPgCommand. Recording it instead lets
    // waitForServerReady stop waiting for a server that will never appear.
    this.startupFailure = null;
    // Ahead of the clear, and unconditional, because the paths that flush do
    // not cover every way a child is let go. A server that died without being
    // asked takes the reportServerExit branch, which does not flush, and
    // finalize() then nulls pgProcess so the next start() skips the reuse
    // block that would have — while the `end` that would have flushed for
    // itself may never arrive, since PostgreSQL's backends inherit those pipes
    // and can hold them open indefinitely. What is left held is a partial line
    // and a carried severity belonging to a dead server, and the assembler
    // would splice both onto the first thing this one writes. So flush here
    // too: the previous child is gone by now, so anything still held is the
    // last of what it wrote, and it is logged as its own message rather than
    // carried across. See PostgresOutputReader.flush, which is also where the
    // reset that stops the level carrying over lives.
    this.flushServerOutput();
    this.serverOutput.clear();
    this.pgProcess.on("error", (err) => {
      this.startupFailure = err;
      this.log("error", `PostgreSQL process could not be started: ${err}`);
    });

    // Attached synchronously, before the PID record is written. `exit` fires
    // once and is not replayed, so a child that dies inside that await would
    // otherwise go unnoticed: startupFailure would stay empty and startup
    // would wait out its full thirty seconds rather than failing fast.
    this.attachExitHandler(this.pgProcess);

    // Capture and optionally log PostgreSQL output. Captured whether or not
    // there is a logger: without a logger the process output goes nowhere, and
    // that is exactly the caller who has nothing but the thrown error to go on.
    // `setEncoding` rather than decoding each chunk, so a multi-byte character
    // split across a read is held by Node's own decoder rather than turned
    // into two replacement characters. It is the same tear the assembler
    // handles a line above, at the byte level, and this is where it is already
    // solved: `data.toString()` on a Buffer ending mid-sequence cannot recover
    // what the next Buffer starts with.
    if (this.pgProcess.stdout) {
      this.pgProcess.stdout.setEncoding("utf8");
      this.pgProcess.stdout.on("data", (data: string) => {
        this.noteServerOutput(data, "stdout");
      });
    }

    if (this.pgProcess.stderr) {
      this.pgProcess.stderr.setEncoding("utf8");
      this.pgProcess.stderr.on("data", (data: string) => {
        this.noteServerOutput(data, "stderr");
      });
    }

    // The stream saying it has ended is the one moment a held partial line is
    // known to be all there is, so it is where the flush belongs rather than
    // at the process's exit: `exit` can fire with data still in the pipe, and
    // flushing then would emit half a line and log the rest of it separately.
    // Each stream flushes only its own for the same reason, since one being
    // done says nothing about the other. A pipe this code destroys emits no
    // "end", which is why the startup path and every shutdown flush for
    // themselves.
    this.pgProcess.stdout?.once("end", () => this.flushServerStream("stdout"));
    this.pgProcess.stderr?.once("end", () => this.flushServerStream("stderr"));

    // Save PID to file for future cleanup. This is written as a structured
    // record rather than a bare integer so that a leftover file can later be
    // told apart from a live server — see cleanupExistingProcess.
    const spawnedPid = this.pgProcess.pid;

    if (spawnedPid) {
      await this.writePidRecord(spawnedPid);

      // Captured before the await rather than read back after it: the close
      // handler clears pgProcess, and a child that dies while its record is
      // being written would otherwise be reported by dereferencing null.
      this.log("setup", `PostgreSQL server started with PID: ${spawnedPid}`);
    }
  }

  /**
   * Writes this invocation's PID record, leaving the PID file either absent or
   * holding a complete record and never anything in between.
   *
   * The write goes to a sibling that is then linked into place. Writing the
   * path directly would truncate it first, so a failure part-way through would
   * strand a half-written file this invocation does not know it owns —
   * `pidRecord` is only set once the write succeeds — and every later start
   * would refuse it as an unreadable record.
   *
   * Linked rather than renamed, which is the same distinction "Claiming a
   * record" draws at the top of this file and for the same reason: a rename
   * replaces the destination and says nothing, a link fails instead. Publishing
   * with a rename left the one path here that could destroy a record without
   * deciding to. `cleanupExistingProcess` accounts for what is at this name and
   * removes it or refuses, but the spawn and the readiness wait sit between
   * that and this write, and a record arriving in the meantime would be
   * replaced unseen — routing around the very refusals that exist to stop a
   * second cluster's live record being erased, and leaving that server running
   * with nothing recording it.
   *
   * So a record here is anomalous by construction. Every path into this has
   * just been through `cleanupExistingProcess`, which returns only once this
   * name is absent, so EEXIST is somebody else having taken it since and is
   * reported as such rather than papered over.
   */
  private async writePidRecord(pid: number): Promise<void> {
    const record = serializeDevDBPidRecord(
      buildDevDBPidRecord(pid, this.pgDataDir, this.pgPort),
    );
    // Unique per write, so two servers sharing a pidFile cannot collide on the
    // sibling as well — they are already racing on the record itself.
    const tempPidFile = `${this.pidFile}.${randomUUID()}.tmp`;

    try {
      await writeFile(tempPidFile, record);
      await this.publishWithoutReplacing(tempPidFile, this.pidFile, record);
    } catch (e) {
      // Its name is unique to this write, so nothing else would reclaim it. A
      // crash can still strand one, harmlessly: readers only open the PID file.
      await this.removeFileIfPresent(tempPidFile);

      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw new Error(
          `${this.pidFile} holds a PID record that arrived after this start accounted for the previous one, so something has taken this pidFile since. ` +
            "It has been left in place and no record was written for this server, which is about to be stopped. " +
            "Give each data directory its own pidFile, or check what is running before starting this one.",
          { cause: e },
        );
      }

      throw e;
    }

    // Before the sibling is cleared, so the moment the record is reachable
    // under the shared name this invocation is on record as owning it. The
    // other order leaves a window where the record is published and nothing
    // here would release it.
    this.pidRecord = record;

    // The link made the record reachable under both names. Only the shared one
    // is a record; this one is scaffolding, and nothing looks for it.
    await this.removeFileIfPresent(tempPidFile);
  }

  /** How long an exiting child is given to flush what it last wrote. */
  private static readonly OUTPUT_DRAIN_MS = 250;

  /**
   * Waits briefly for a child's stdio to close, so a diagnosis composed after
   * this includes the last thing it wrote.
   *
   * Bounded, and the bound is the point: `close` is what guarantees the pipes
   * are drained, and it is exactly the event that may never arrive, since
   * PostgreSQL's backends inherit those pipes and can outlive the postmaster
   * holding them open. So this waits for the guarantee where it is coming and
   * gives up where it is not, rather than making a diagnosis depend on it.
   *
   * `hasClosed` is how it knows the guarantee has ALREADY arrived, and it is
   * not a shortcut. `close` fires once and Node does not replay it, so waiting
   * on it after the fact waits forever — and this is called from the exit
   * handler AFTER an `await finalize()` that does real filesystem work, which
   * is ample time for the pipes to EOF and the event to fire. That left the
   * rest of the handler unreachable: no flush, and no reportServerExit, so a
   * crashed server was never announced to `onExit` and a host with nothing
   * else pending exited 0 reporting a clean run. The flag is set by a listener
   * attached beside the exit handler, since neither `destroyed` nor `closed`
   * on the streams answers this question on both runtimes: under Bun both are
   * already true when `exit` fires, so reading them would skip the drain on
   * the startup path, which is the path it exists for.
   *
   * The timer is deliberately NOT unref'd. It is what settles this where
   * `close` is not coming, so a process with nothing else pending must stay up
   * for it rather than exit through the gap — the same failure by the other
   * route. It costs at most {@link OUTPUT_DRAIN_MS} at the end of a teardown
   * that is already reporting a dead server.
   */
  private async drainServerOutput(
    proc: ReturnType<typeof spawn>,
    hasClosed: () => boolean,
  ): Promise<void> {
    if (hasClosed() || (proc.stdout === null && proc.stderr === null)) {
      return;
    }

    await new Promise<void>((settle) => {
      const timer = setTimeout(settle, LocalDevDBServer.OUTPUT_DRAIN_MS);

      proc.once("close", () => {
        clearTimeout(timer);
        settle();
      });
    });
  }

  /**
   * Attaches the handler that owns a running server's lifecycle: releasing the
   * PID file, dropping the process reference, and reporting the exit code.
   *
   * Factored out because failed-start cleanup detaches it, and has to put an
   * equivalent one back if the process turns out to have survived.
   */
  private attachExitHandler(proc: ReturnType<typeof spawn>): void {
    if (this.stoppingProc !== proc) {
      this.stoppingProc = null;
    }

    // From here on this attachment is the one this instance answers for, and
    // any handler from an earlier one is answering for history.
    const generation = ++this.attachedGeneration;

    // Whether the child's stdio has already closed, recorded rather than
    // asked for later. `close` fires once and is not replayed, so the only
    // way to know it has happened is to have been listening when it did —
    // which is why this goes on here, synchronously, beside the exit handler
    // and before anything can await. See drainServerOutput, which waits on
    // that event and would otherwise wait for one that had already gone.
    let stdioClosed = false;

    proc.once("close", () => {
      stdioClosed = true;
    });

    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    let finalizing: Promise<void> | null = null;

    /**
     * Releases everything this child owns.
     *
     * Runs once and every caller waits for that one run, which is stronger
     * than running once and is the property actually needed here. Two callers
     * are expected: a shutdown that has confirmed the process gone runs this
     * rather than wait out a `close` the stdio pipes may hold back
     * indefinitely, and the event may still arrive afterwards. They can also
     * land together.
     *
     * A flag alone would let the second return while the first was still
     * inside releasePidRecord. That would let stop() fulfill before its PID
     * cleanup completed, and a host could exit while the claim protocol was
     * between renaming a record and restoring it. Memoizing the promise makes
     * every caller wait for the full release.
     */
    const finalize = (): Promise<void> => {
      finalizing ??= (async () => {
        // Clean up PID file, but only the record this invocation wrote — the
        // same bar cleanupFailedStart applies. This handler is attached before
        // the record is written, and may fire after another server has
        // replaced it, so either would otherwise remove somebody else's file.
        //
        // Caught rather than propagated. releasePidRecord handles its own
        // filesystem errors, so nothing is expected here, but a rejection
        // would be memoized along with everything else: both callers would
        // then throw, and one of them is an async `close` listener whose
        // rejection is unhandled and whose exit decision would be skipped.
        // Failing to tidy a file must not be what stops the process exiting.
        try {
          await this.releasePidRecord();
        } catch (e) {
          this.log("error", `Could not release the PID record: ${e}`);
        }

        // Only while it is still this child. A late `close` from a previous
        // child must not clear a reference that a fresh start() has since put
        // there, nor take that new child's owner out of the set.
        if (this.pgProcess === proc) {
          this.pgProcess = null;
        }

        // Released after the PID record and with nothing awaited in between,
        // so that by the time the caller makes its exit decision this instance
        // has finished with everything shared.
        //
        // The shared exit hook goes with the last child. A host awaiting this
        // shutdown holds its own promise, so removing the hook does not affect
        // the host's subsequent exit decision.
        if (this.pgProcess === null) {
          this.releaseProcessHandlers();
        }

        if (this.pgProcessLifecycle?.proc === proc) {
          this.pgProcessLifecycle = null;
        }

        // The child a failed start could not kill has now died and been
        // cleaned up after, so it is no longer in anybody's way and this
        // instance leaves the `unstoppable` state here. Nothing reads the
        // field once pgProcess stops pointing at the same child, so clearing
        // it changes no decision; what it does is let go of a dead child's
        // handle, and with it the stdio stream objects hanging off it, rather
        // than hold them for the life of the instance.
        if (this.unstoppableChild === proc) {
          this.unstoppableChild = null;
        }
      })();

      return finalizing;
    };

    this.pgProcessLifecycle = { proc, closed, finalize };

    // `exit` rather than `close`, which is the whole of why a dead server no
    // longer leaves anything outstanding.
    //
    // Node emits both: `exit` once the process is gone, `close` once the
    // process is gone AND every stdio pipe has been closed. PostgreSQL's
    // backends inherit those pipes, so a postmaster killed without signaling
    // its children leaves orphaned backends holding them and `close` arrives
    // late or never. Everything below is about the process rather than the
    // pipes — releasing the PID record, dropping the reference, reporting the
    // exit — so waiting for the pipes tied all of it to an event that may not
    // come, and a crashed server could sit there with its record still on disk
    // and its death unreported.
    //
    // `closed` settles from here too, so it reports the lifecycle having
    // finished rather than the pipes having drained. A shutdown awaiting it
    // therefore learns nothing about the pipes and drops the read ends itself
    // either way — see performGracefulShutdown.
    proc.on("exit", async (code) => {
      // Answered before anything else, because everything else is about the
      // instance rather than about this child, and a superseded child has no
      // claim on any of it.
      //
      // Far narrower than it was now that this is `exit`: a superseded child
      // is one a later start() replaced, and start() only spawns with
      // pgProcess null, which nothing but finalize() and cleanupFailedStart()
      // makes it. Both release this child's PID record first, so anything
      // arriving here has already been cleaned up.
      if (this.attachedGeneration !== generation) {
        this.log(
          "setup",
          `A superseded PostgreSQL server process (PID ${proc.pid}) reported exit code ${code}. ` +
            "It was stopped before the current one started, so this reports its exit rather than acting on it.",
        );

        resolveClosed();

        return;
      }

      // Read once, before anything is awaited, and used for both decisions
      // below. Re-reading it after the await would be a different question:
      // start()'s own failure path clears the flag in its `finally` without
      // waiting for finalize(), which does real filesystem work, so a start
      // that owned this failure when the child died can have handed the flag
      // back by the time this resumes — and the exit decision would then take
      // the host process down instead of letting start() reject.
      const startOwnsThisExit = this.startingUp;

      // The one thing `exit` is worse at than `close`, and the only place it
      // matters. A postmaster that refuses to start writes the reason and
      // exits immediately, and that text can still be sitting in the pipe when
      // `exit` fires, so composing the diagnosis now would report the failure
      // without the sentence explaining it — a major-version mismatch reduced
      // back to an exit code, which is what withServerOutput exists to
      // prevent. So give the pipes a moment, bounded, and carry on with
      // whatever arrived either way.
      //
      // Only on the startup path. Nothing else reads the captured output, and
      // an ordinary stop should not pay for this.
      if (startOwnsThisExit) {
        await this.drainServerOutput(proc, () => stdioClosed);

        // Nothing more is coming: either `close` arrived, which means both
        // pipes are done, or the bound expired and waiting longer would only
        // delay the diagnosis. So a line still held back is the last one
        // PostgreSQL wrote, which on this path is the sentence saying why it
        // would not start. Logged now rather than left to an "end" that a
        // destroyed pipe never emits.
        this.flushServerOutput();

        // Still ahead of the cleanup below, and well ahead of start() asking:
        // waitForServerReady polls this once a second, so the short wait above
        // cannot let a start resolve with no server running.
        this.startupFailure ??= new Error(
          this.withServerOutput(
            `PostgreSQL exited with code ${code} before it was ready`,
          ),
        );
      }

      try {
        this.log("setup", `PostgreSQL server process exited with code ${code}`);

        await finalize();

        // Forward the exit code from PG, default to 1 if not a number
        const exitCode = typeof code === "number" ? code : 1;
        const deliberate = this.stoppingProc === proc;

        if (deliberate) {
          this.stoppingProc = null;
        }

        // Drops the read ends, which every OTHER way a child is let go already
        // does: performGracefulShutdown, cleanupFailedStart, and the reuse
        // path in performStart. This was the one that did not, and the gap is
        // reached by two routes — the exit nobody asked for, and a child a
        // failed start could not kill, which cleanupFailedStart deliberately
        // leaves holding its pipes while it is still running and which arrives
        // here as `deliberate` whenever it finally dies.
        //
        // What this is worth is worth stating exactly. The hazard the other
        // three guard against is real in principle: PostgreSQL's backends
        // inherit these pipes, so a postmaster killed without signaling its
        // children could leave them holding the write ends, and a read end
        // that never sees EOF stays ref'd and keeps the event loop up. In
        // practice a backend polls for postmaster death and exits, so EOF does
        // arrive and Node destroys the streams itself — provoking that orphan
        // on macOS with PostgreSQL 18 did not manage it, and a test against a
        // real kill therefore passes whatever this code does.
        //
        // The guarantee is testable even where the hazard is not, because it
        // is about this instance rather than about PostgreSQL: a child this
        // still speaks for is not left holding pipes nobody will close. A fake
        // child asserts that directly, and does fail without the drop. See
        // "letting go of a child that exited unasked" in the tests.
        //
        // "Still speaks for" is the whole scope. A superseded child returns
        // above this, and its pipes are not this branch's to drop: the reuse
        // path in performStart destroys them before it replaces the child, so
        // by the time a late exit arrives here they are already gone.
        //
        // Draining is only for the unrequested route. The last thing a
        // postmaster writes is why it is going, and a destroyed pipe emits no
        // "end", so the flush belongs here rather than with that event. The
        // other two routes have drained or flushed already, and making a
        // deliberate stop wait out this bound again would add it to every
        // shutdown for output that has been read.
        const unrequested = !startOwnsThisExit && !deliberate;

        if (unrequested) {
          await this.drainServerOutput(proc, () => stdioClosed);
          this.flushServerOutput();
        }

        proc.stdout?.destroy();
        proc.stderr?.destroy();
        proc.stdin?.destroy();

        if (startOwnsThisExit) {
          // start() owned this failure when the child died: it will run
          // cleanupFailedStart and reject. Exiting here would pre-empt that
          // and bypass the caller's .catch entirely.
          return;
        }

        if (deliberate) {
          // Somebody asked for this. Whoever asked owns what happens next.
          return;
        }

        // Nobody asked for this: the server crashed, or something outside
        // stopped it. Reported rather than acted on — see reportServerExit.
        this.reportServerExit(exitCode);
      } finally {
        resolveClosed();
      }
    });
  }

  /** How long readiness polling may take in total, however it is spent. */
  private static readonly READINESS_TIMEOUT_MS = 30_000;

  /** What one readiness attempt may spend connecting and querying. */
  private static readonly READINESS_ATTEMPT_TIMEOUT_MS = 2000;

  /**
   * How much of the budget an attempt needs before it is worth making.
   *
   * The deadline can fall anywhere, including a few milliseconds away, and an
   * attempt given what is left of a budget nearly spent is not a shorter
   * attempt but a pointless one: it can only time out, and it still counts
   * itself in the "not ready after N attempts" the failure reports. So the
   * loop stops when there is no time for a real try rather than making a
   * token one.
   *
   * It also keeps the attempt timeout away from zero by construction, which
   * matters more than it looks: node-postgres reads a connectionTimeoutMillis
   * of 0 as NO timeout, so a clamp allowed to reach it would hand back the
   * unbounded connect this whole bound exists to remove.
   */
  private static readonly READINESS_MIN_ATTEMPT_MS = 250;

  /** The interval the poll settles at once the early attempts have missed. */
  private static readonly READINESS_POLL_MS = 1000;

  /**
   * What the first few readiness polls wait, before settling at the interval
   * above.
   *
   * A flat second was nearly the whole of an ordinary wait. A postmaster that
   * is not up yet refuses the connection at once, so an attempt costs almost
   * nothing and the loop spent its time asleep — and a server that became
   * ready in the usual few hundred milliseconds went unnoticed until the
   * second was out. Polling finely where the answer is most likely to change
   * and coarsely where it is not notices a warm start about as soon as it
   * happens, while a cold one polls no harder than it did before: these five
   * add up to about a second and a half, so a run that gets past them is on
   * the old interval having lost nothing.
   */
  private static readonly READINESS_BACKOFF_MS: readonly number[] = [
    50, 100, 200, 400, 800,
  ];

  /** How long to wait after `attempts` failures, backing off to the interval. */
  private static readinessDelay(attempts: number): number {
    return (
      LocalDevDBServer.READINESS_BACKOFF_MS[attempts - 1] ??
      LocalDevDBServer.READINESS_POLL_MS
    );
  }

  /**
   * Waits for the PostgreSQL server to be ready to accept connections.
   *
   * Bounded by a deadline rather than by an attempt count alone, because the
   * count alone was not a bound. A server that is simply not up yet refuses
   * the connection at once, so thirty attempts a second apart really did cost
   * about thirty seconds — but something else holding the port, which is the
   * collision free-port.ts exists to avoid, accepts the connection and then
   * says nothing, and each attempt spent the client's full connect timeout
   * instead. Thirty of those is five and a half minutes, reported as a failure
   * "after 30 seconds" and well past the bound a host sizes its own shutdown
   * wait from. So each attempt gets a short timeout of its own and the loop
   * stops at the deadline whichever runs out first.
   *
   * The gap between attempts backs off rather than sitting at a flat second,
   * which is where an ordinary start spent nearly all of its wait — see
   * READINESS_BACKOFF_MS. Thirty attempts still come to about the same
   * twenty-six seconds of sleeping, so which of the two bounds ends the loop
   * depends on what the attempts themselves cost: the count where they are
   * refused instantly, the deadline where they are not.
   *
   * "About" thirty seconds rather than exactly. One attempt's timeout covers
   * connecting and then querying in turn, so the last one admitted can spend
   * twice it, and the wait can run a couple of seconds over. The bound is here
   * to keep a stuck start from becoming a five-minute one, not to be exact.
   *
   * @param maxAttempts Maximum number of attempts to check if the server is ready (default: 30)
   * @returns True if the server is ready, false otherwise
   */

  private async waitForServerReady(maxAttempts = 30): Promise<boolean> {
    this.log("setup", "Waiting for PostgreSQL server to start...");

    const startedAt = Date.now();
    const deadline = startedAt + LocalDevDBServer.READINESS_TIMEOUT_MS;

    let serverReady = false;
    let attempts = 0;

    while (
      !serverReady &&
      attempts < maxAttempts &&
      deadline - Date.now() >= LocalDevDBServer.READINESS_MIN_ATTEMPT_MS
    ) {
      // Nothing is coming: the spawn failed, or the server exited before it
      // was ready. Waiting out the remaining attempts would turn a knowable
      // failure into a thirty-second one.
      if (this.startupFailure) {
        throw this.startupFailure;
      }

      try {
        // Sized from what is left of the budget, so an attempt admitted near
        // the end cannot run long past it. The loop guard above is what keeps
        // this clear of zero, which pg would read as no bound at all — see
        // READINESS_MIN_ATTEMPT_MS.
        const attemptTimeout = Math.min(
          LocalDevDBServer.READINESS_ATTEMPT_TIMEOUT_MS,
          deadline - Date.now(),
        );

        // Whichever superuser this cluster has. A name that fails to connect
        // is not a server that is not ready, so the candidates are tried
        // within one attempt rather than across the poll: otherwise a wrong
        // first name would spend the whole thirty seconds proving itself
        // wrong. The one that answers is remembered for setup.
        const client = await this.connectAsSuperuser(attemptTimeout);

        // Ended in a finally, because a server that accepts the connection but
        // is not yet answering queries — or one that outlasts createClient's
        // query_timeout — throws with the socket already open. Dropped there,
        // each attempt leaves a live backend behind and, worse, an open handle
        // holding the event loop up: a caller that catches this start()'s
        // rejection and returns would never exit. Same leaked-handle hang
        // performGracefulShutdown destroys the child's stdio to avoid.
        try {
          await client.query("SELECT 1");
        } finally {
          // Swallowed because the case that matters is the query having
          // SUCCEEDED: a rejection from the disconnect would then escape the
          // finally, land in the retry catch below, and leave serverReady
          // unset — so a server that had just answered would be retried
          // thirty times and then reported as never having started. When the
          // query failed instead, both errors reach the same catch and are
          // discarded alike, so nothing is lost there either.
          await client.end().catch(() => {});
        }

        this.log("setup", "PostgreSQL server is ready to accept connections");
        serverReady = true;
      } catch {
        attempts++;

        if (attempts % 5 === 0) {
          this.log(
            "setup",
            `Still waiting for PostgreSQL server... (attempt ${attempts}/${maxAttempts})`,
          );
        }

        // Only wait if we're going to try again, and never past the deadline.
        const remaining = deadline - Date.now();

        if (attempts < maxAttempts && remaining > 0) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(LocalDevDBServer.readinessDelay(attempts), remaining),
            ),
          );
        }
      }
    }

    if (this.startupFailure) {
      throw this.startupFailure;
    }

    if (!serverReady) {
      // What it actually waited, rather than what it was budgeted. The two
      // agree on the ordinary path and the message is read on the other one.
      const waited = Math.round((Date.now() - startedAt) / 1000);

      throw new Error(
        this.withServerOutput(
          `PostgreSQL server was not ready after ${attempts} connection attempt${
            attempts === 1 ? "" : "s"
          } over ${waited} seconds`,
        ),
      );
    }

    return serverReady;
  }

  /**
   * Connects as this cluster's superuser, working out which one that is.
   *
   * Settled once and then reused. The candidates differ only for a data
   * directory an older strataline initialized, where the superuser is named
   * after whoever ran initdb, so the first successful connection is the answer
   * for the life of this instance.
   *
   * The last candidate's failure is what propagates, since by then every name
   * has been refused and the caller wants an error rather than a list.
   */
  private async connectAsSuperuser(timeoutMs?: number): Promise<Client> {
    const candidates =
      this.bootstrapUser === null
        ? this.superuserCandidates()
        : [this.bootstrapUser];

    let lastFailure: unknown;

    for (const candidate of candidates) {
      try {
        const client = await this.createClient(
          candidate,
          "postgres",
          timeoutMs,
        );

        if (this.bootstrapUser !== candidate) {
          this.bootstrapUser = candidate;
        }

        return client;
      } catch (e) {
        lastFailure = e;
      }
    }

    throw lastFailure;
  }

  /**
   * Sets up PostgreSQL users and databases
   */
  private async setupUsersAndDatabases(): Promise<void> {
    // Whichever superuser answered during readiness. It has already been
    // established that this one connects, so there is nothing to try here.
    let client = await this.connectAsSuperuser();

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

      // data_directory is a superuser-only setting, and the dev user is not a
      // superuser. Without this grant the server cannot identify itself over a
      // connection, which is what settles an otherwise undecidable PID.
      try {
        await client.query(`GRANT pg_read_all_settings TO "${this.pgUser}"`);
      } catch (e) {
        // Not fatal: identification simply falls back to the PID checks.
        this.log(
          "warn",
          `Could not grant pg_read_all_settings to ${this.pgUser}: ${e}`,
        );
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
   *
   * A second call while one is already running, or while a shutdown is, is
   * refused rather than queued — see {@link startInFlight}. An overlap is a
   * caller that has lost track of which lifecycle it is in, and the two
   * requests describe different end states; answering one of them silently
   * would pick for the caller. Sequence them instead: await the first.
   */
  public async start(): Promise<void> {
    if (this.shutdownInFlight || this.isCleaningUp) {
      throw new Error(
        "Cannot start PostgreSQL server: server is currently stopping.",
      );
    }

    if (this.startInFlight || this.startingUp) {
      throw new Error(
        "Cannot start PostgreSQL server: server is already starting.",
      );
    }

    // `finally` rather than the two-armed `then` handleGracefulShutdown uses:
    // there is no exit decision to pre-empt here, and the memo has to be
    // cleared on a rejection too or a failed start would refuse every retry.
    // Cleared before the promise callers hold settles, so the next start()
    // sees no memo.
    this.startInFlight = this.performStart().finally(() => {
      this.startInFlight = null;
    });

    return this.startInFlight;
  }

  private async performStart(): Promise<void> {
    // Nothing waits for a shutdown here. start() refuses one that is in
    // flight, so this is only ever entered from a settled lifecycle: waiting
    // would be waiting for a promise that has to be null to get this far.

    // On for the duration of this cycle, so the shared exit hook protects any
    // child created during startup. Shutdown removes it once no child remains.
    //
    // Ahead of the already-running guard below rather than after it, and ahead
    // of the work this method does, on two counts. An instance disposed while
    // it still held a child rejoins on the start() that then finds nothing to
    // do, rather than staying permanently unmanaged.
    //
    // A start() that then fails leaves the set again from cleanupFailedStart,
    // which every failure path runs, so a refusal leaves nothing armed.
    this.armProcessHandlers();

    if (this.pgProcess) {
      const held = this.pgProcess;

      // A child that outlived a failed start's SIGKILL is not a running
      // server. Resolving here would report a success the earlier start()
      // already rejected, and send the caller off to connect to a server that
      // never came up.
      if (this.unstoppableChild === this.pgProcess) {
        // Whether it is still holding the port is a separate question from
        // whether this instance can be restarted, and Node's own report on the
        // handle answers it — the same evidence the "exit" hook trusts. A
        // `close` left pending by an inherited stdio handle keeps the
        // reference alive well after the process is gone, so refusing with
        // "may still be holding the port" would send a person looking for a
        // server that has already died.
        const exited =
          this.pgProcess.exitCode !== null ||
          this.pgProcess.signalCode !== null;

        throw new Error(
          `A partially started PostgreSQL server (PID ${this.pgProcess.pid}) left by an earlier failed start could not be stopped. ` +
            (exited
              ? "It has since exited and this instance is still winding it down, so there is nothing left to stop by hand: try again in a moment."
              : `It may still be holding port ${this.pgPort}. Stop it manually before starting the dev server.`),
        );
      }

      // Node's own report on the handle decides this, not the reference,
      // which is the same evidence the "exit" hook and the shutdown backstop
      // already trust. `close` waits on the stdio pipes as well as the
      // process, and PostgreSQL's backends inherit them, so a postmaster that
      // died without signaling its children can leave this reference standing
      // long after the server is gone — indefinitely, since nothing bounds
      // that wait outside a deliberate stop. Answering "already running" from
      // the reference alone resolves start() for a database that is not
      // there, and the caller is not told by any other route either:
      // reportServerExit lives in the very handler that has not run.
      if (held.exitCode === null && held.signalCode === null) {
        this.log("warn", "PostgreSQL is already running, skipping start()");
        return;
      }

      this.log(
        "warn",
        `The previous PostgreSQL server (PID ${held.pid}) has exited, but Node has not reported its stdio closed. ` +
          "Completing its cleanup before starting a new one: orphaned PostgreSQL child processes can hold those pipes open after the postmaster is gone.",
      );

      // Aimed at before anything is awaited, so the late `close` reads as an
      // exit that was accounted for rather than an unrequested crash. Left
      // unset it would reach reportServerExit and call onExit part way through
      // this start — and a host whose onExit ends the process, which is what
      // the documented handler does, would die during its own restart.
      this.stoppingProc = held;

      const lifecycle =
        this.pgProcessLifecycle?.proc === held ? this.pgProcessLifecycle : null;

      if (lifecycle) {
        // The same call the lifecycle handler makes, and it runs at most once, so
        // a `close` that does arrive later still repeats none of it.
        await lifecycle.finalize();
      } else {
        // No lifecycle to run it, so release the record directly rather than
        // leave the next start to prove a dead server dead.
        await this.releasePidRecord();
      }

      if (this.pgProcess === held) {
        this.pgProcess = null;
      }

      if (this.pgProcessLifecycle?.proc === held) {
        this.pgProcessLifecycle = null;
      }

      // The read ends are ours and nothing else is going to close them.
      // Dropping them lets `close` fire and stops a leaked pipe holding the
      // event loop open — see performGracefulShutdown, which does the same
      // thing for the same reason, and flushes first for the same reason too:
      // a line still held belongs to the child being let go, and the assembler
      // would otherwise splice it onto the first line the next one writes.
      this.flushServerOutput();
      held.stdout?.destroy();
      held.stderr?.destroy();
      held.stdin?.destroy();

      // finalize() releases the shared exit hook along with the last child, so
      // put it back: the arm above ran before that release, and the child this
      // start is about to spawn would otherwise be left unprotected.
      this.armProcessHandlers();
    }

    this.startingUp = true;

    try {
      // Inside the try, along with everything else this method does. Resolving
      // the binaries can fail on its own — the per-platform @embedded-postgres
      // package is an optional dependency, so an install that skipped it, or
      // an unsupported arch, rejects here — and a failure outside would return
      // past cleanupFailedStart, which takes the shared exit hook registered
      // above back off again. Left on, an instance that never started a child
      // would remain in the owner set and keep that hook installed.
      const pgBinaries = await getBinaries();

      this.log("setup", `Using PostgreSQL binaries: ${pgBinaries.postgres}`);

      // Clean up any existing PostgreSQL processes
      await this.cleanupExistingProcess();

      // Initialize data directory if needed
      await this.initializeDataDirectory(pgBinaries);

      // Start PostgreSQL server
      await this.startPostgresServer(pgBinaries);

      // Wait for server to be ready
      await this.waitForServerReady();

      // Set up users and databases
      await this.setupUsersAndDatabases();

      // PostgreSQL can exit after the last setup step, and its lifecycle handler
      // records that rather than exiting while start() owns the failure — so
      // ask once more before reporting a success.
      if (this.startupFailure) {
        throw this.startupFailure;
      }

      this.log("info", `PostgreSQL server is running on port ${this.pgPort}`);
      this.log("info", `Database: ${this.pgDb}`);
      this.log("info", `User: ${this.pgUser}`);
      this.log("info", `Password: ${this.pgPass}`);
      this.log("info", "Press Ctrl+C to stop the server");
    } catch (error) {
      this.log("error", `Error starting PostgreSQL server: ${error}`);
      // A step after startPostgresServer() can throw with PostgreSQL already
      // running, and a caller that catches the rejection keeps going — so tear
      // the child down rather than leak a server holding the port.
      const cleanedUp = await this.cleanupFailedStart();

      if (!cleanedUp) {
        // The partially started server survived every attempt to stop it. Say
        // so rather than letting the original error imply a tidy failure, and
        // keep the underlying cause attached.
        throw new Error(
          `PostgreSQL failed to start and the partially started server could not be stopped. ` +
            `It may still be holding port ${this.pgPort}; stop it manually. Cause: ${error}`,
          { cause: error },
        );
      }

      // Reject rather than exit: the caller's .catch owns how a failed start
      // terminates, and exiting here would bypass a caller-supplied onExit —
      // which governs an already-running server, not this.
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      // Past this point a child exit is an ordinary shutdown again, and its
      // lifecycle handler should exit the process as it always has.
      this.startingUp = false;
    }
  }

  /**
   * Tear down a partially-started server after a failed start(). Stops the
   * spawned PostgreSQL process (escalating to SIGKILL if it doesn't exit) and
   * removes the PID file, so a caught start() rejection doesn't leave a server
   * holding the port. Returns false if the process could not be stopped, in
   * which case the PID record and process reference are deliberately retained.
   *
   * The lifecycle handler is detached first, so tearing the child down here is not
   * reported as a server that died on its own: a failed start rejects to its
   * caller, and that rejection is the report.
   */
  private async cleanupFailedStart(): Promise<boolean> {
    const proc = this.pgProcess;

    if (proc && proc.pid) {
      const pid = proc.pid;

      // Detach the lifecycle handler so killing the process here is not
      // reported through onExit as an unasked-for exit.
      proc.removeAllListeners("exit");

      // The reference deliberately stays on the instance across the
      // escalation below, and is dropped once the child is gone. Clearing it
      // first left a window seconds wide, since the escalation waits after each
      // signal, in which this instance believed it had no child at all. A host
      // calling shutdown() then found nothing to stop, and the exit hook found
      // nothing to force-kill, so the partially started postmaster could
      // outlive the process that spawned it. Holding the reference lets both
      // paths find the child.
      //
      // Same escalation as any other shutdown, so a half-started server is not
      // hard-killed with SIGTERM (which PostgreSQL reads as smart shutdown and
      // which therefore waits for clients).
      if (
        (await this.terminateOwnChild(
          pid,
          "partially started PostgreSQL server",
          proc,
        )) === "failed"
      ) {
        // Outlived even SIGKILL. Keep the reference and the PID record so a
        // later stop() can try again, and put an equivalent lifecycle handler back
        // — without one that stop() would leave the PID file behind and never
        // clear the reference or the keep-alive interval.
        //
        // Aimed at, before the handler goes back on: a shutdown was asked for
        // here and merely could not be completed. start() is about to reject
        // with that, so when the process does finally die the lifecycle handler
        // must not read it as an unrequested crash and exit the host process
        // out from under a caller that has already handled the rejection.
        this.stoppingProc = proc;
        this.pgProcess = proc;
        this.unstoppableChild = proc;
        this.attachExitHandler(proc);

        return false;
      }
    }

    // Nothing of this instance's is running, so the reference comes off —
    // whether it was held across the escalation above or belongs to a spawn
    // that never got a PID at all.
    //
    // That second case skips the block above entirely, and leaving its handle
    // on the instance is not a cosmetic leak: `start()` treats a non-null
    // pgProcess as a running server, so the next start() would log "already
    // running", resolve, and hand back a caller with nothing behind it —
    // reporting success for a server that failed to spawn. `stop()` would be
    // just as inert, since performGracefulShutdown returns early on a child
    // with no PID.
    //
    // The lifecycle handler goes with it. A failed spawn emits "error" and
    // never "exit", so nothing would ever take that listener off by itself.
    if (this.pgProcess === proc) {
      proc?.removeAllListeners("exit");
      this.pgProcess = null;
    }

    // Only while it is still this child's, for the reason finalize gives: a
    // later start() may already have attached its own.
    if (this.pgProcessLifecycle?.proc === proc) {
      this.pgProcessLifecycle = null;
    }

    // The child is confirmed gone by this point, so the read ends are ours and
    // nothing else is going to close them. Dropped for the reason
    // performGracefulShutdown drops them: PostgreSQL's backends inherit those
    // pipes and can outlive the postmaster holding them open, and a leaked
    // pipe keeps the event loop up — so a caller that catches this start()'s
    // rejection and returns would never exit. The unstoppable path above
    // returns before this, deliberately: that child is still running and its
    // output is still worth having.
    //
    // Flushed before they go, since a destroyed pipe emits no "end" and this
    // is a failed start, where the line being held is the likeliest one to say
    // why.
    this.flushServerOutput();
    proc?.stdout?.destroy();
    proc?.stderr?.destroy();
    proc?.stdin?.destroy();

    // Nothing of ours is running any more. Released here rather than beside
    // the kill above, so a spawn that failed before it ever had a PID — which
    // skips that block entirely — is released too; its lifecycle handler, the
    // other place this happens, may never run.
    //
    // The handlers go with it, for the same reason and covering the same gap:
    // a start() that refused before spawning anything registered them on the
    // way in and has no lifecycle handler coming to take them off again.
    this.releaseProcessHandlers();

    // Only the record this invocation created: startup can refuse before
    // spawning anything, and the file then describes somebody else's server.
    // A child that died while its record was being written leaves pgProcess
    // null but the record on disk, so this must not depend on that reference.
    await this.releasePidRecord();

    return true;
  }
}
