/**
 * Log level type
 */
export type LogLevel = "info" | "warn" | "error";

/**
 * Where a line came from, as opposed to how bad it is.
 *
 * The second of the two axes a log line has, and for a long time this library
 * had only one name for both. A "tag" was `info | warn | error | pg | setup` on
 * the dev server and `info | warn | error | migrate-info | migrate-warn |
 * migrate-error` on the CLI: severity and origin crossed into a single enum,
 * spelled out by hand, differently per surface. It went wrong in the ways
 * crossing two axes does: `pg` and `setup` could not carry a severity at all,
 * having spent the enum on being an origin, while `migrate-` was a namespace
 * built out of string prefixes, so the three tag sets shared no type and
 * adding a level meant editing each of them.
 *
 * Separating them makes a severity available to every origin. It does not by
 * itself supply one: LocalDevDBServer still logs PostgreSQL's output at `info`
 * whatever that output says, because the severity is inside the text
 * PostgreSQL wrote and nothing here reads it. What changed is that a source is
 * no longer the reason it cannot.
 *
 * Severity is the method you call. This is the other axis, and it is a field.
 *
 * Open rather than a union, because a host embedding this library has its own
 * sources and nothing here should have to know them.
 */
export type LogSource = "server" | "pg" | "setup" | "migration" | (string & {});

/**
 * Log data input structure (without level, which is determined by the method called)
 */
export interface LogDataInput {
  /** Where the line came from. See {@link LogSource}. */
  source?: LogSource;
  task?: string;
  stage?: string;
  message: string;
  error?: unknown;
}

/**
 * Complete log data structure (with level)
 */
export interface LogData extends LogDataInput {
  level: LogLevel;
}

/**
 * Logger interface for operations
 */
export interface Logger {
  info: (data: LogDataInput) => void;
  error: (data: LogDataInput) => void;
  warn: (data: LogDataInput) => void;
}

/**
 * Best-effort extraction of a human-readable message from an unknown thrown
 * value: an Error, an error-like object with a string `message`, or anything
 * else coerced via String(). Use this instead of accessing `.message` on a
 * caught value (whose type is `unknown`).
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return String(error);
}

/**
 * Build a log prefix from structured log data
 */

export function buildLogPrefix(data: LogData): string {
  const parts: string[] = [];

  // Source first, and upper-cased, which is where the surfaces that used to
  // render their own tags put it: "[PG]", "[SETUP]", "[MIGRATE-INFO]". Only
  // the origin survives that move, since the level half of those tags is the
  // method being called now.
  if (data.source) {
    parts.push(`[${data.source.toUpperCase()}]`);
  }

  if (data.task) {
    parts.push(`[${data.task}]`);
  }

  if (data.stage) {
    parts.push(`[${data.stage}]`);
  }

  return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

/**
 * Abstract base logger class that implements the Logger interface
 */

export abstract class BaseLogger implements Logger {
  /**
   * Log an informational message
   */
  abstract info(data: LogDataInput): void;

  /**
   * Log an error message
   */
  abstract error(data: LogDataInput): void;

  /**
   * Log a warning message (optional)
   */
  abstract warn(data: LogDataInput): void;

  /**
   * Create a prefixed logger that includes task and stage information
   */
  createPrefixed(prefix: {
    source?: LogSource;
    task?: string;
    stage?: string;
  }): Logger {
    return new PrefixedLogger(this, prefix);
  }
}

/**
 * A logger that hands its lines to another one.
 *
 * The loggers here fall into two kinds, and keeping the two apart is the point
 * of this class. A SINK renders: it turns `task` and `stage` into
 * `[task] [stage] ` and writes the line somewhere. `ConsoleLogger` is one. A
 * FORWARDER passes the line on to the next logger, having gated it, filled in
 * a field, or wrapped the call.
 *
 * Rendering belongs to the sink alone, and once. A forwarder that renders puts
 * the prefix in the message and then hands on the fields it was built from, so
 * the sink renders them again — which is precisely what MutableLogger did, and
 * for long enough to reach a release, because every line it produced was
 * doubled and its only caller was a test using a mock that records rather than
 * renders.
 *
 * Subclassing this rather than `BaseLogger` is what keeps the two apart, and
 * it leaves a forwarder exactly two questions to answer. {@link transform} is
 * what the line IS: return the data to pass on, or `null` to drop it.
 * {@link deliver} is how the CALL is made: wrap it, guard it, fall back from
 * it. Neither seam is shaped to hold a rendered string, and a subclass that
 * needs neither writes nothing at all.
 *
 * Shaped, not sealed, and the difference is worth stating rather than
 * glossing. `LogDataInput` carries a `message`, so a `transform` CAN return
 * `{ ...data, message: prefix + data.message }` and put the prefix straight
 * back where MutableLogger had it. Nothing in the types prevents that.
 * Claiming otherwise would be worse than claiming nothing, because the next
 * person would trust the claim instead of the rule: a forwarder leaves
 * `message` alone, the sink at the bottom renders, and a forwarder that
 * breaks that doubles every line it touches exactly as before.
 *
 * The `warn` fallback lives here too, in one copy rather than one per
 * subclass.
 */
export abstract class ForwardingLogger extends BaseLogger {
  protected readonly next: Logger;

  constructor(next: Logger) {
    super();
    this.next = next;
  }

  /**
   * The three levels, each handing back whatever the logger beneath returned.
   *
   * Declared `unknown` rather than `void`, which is what lets that value out.
   * `Logger` declares these `void`, and a method returning anything satisfies
   * a `void` one, so this is a wrapper that keeps its own promise rather than
   * a wider contract: nothing may act on what comes back except a wrapper that
   * knows what it wrapped.
   *
   * Returning it is the whole of what makes the guard hold through a chain.
   * SafeLogger catches an async logger's rejection by attaching to the promise
   * {@link deliver} hands up, and a wrapped logger's prefixed child is
   * SafeLogger -> PrefixedLogger -> logger, so the promise crosses a forwarder
   * that is not the guard. A synchronous throw crosses it by itself; a
   * rejection dropped here belongs to nobody, and Node ends the process over
   * exactly the failure makeSafeLogger exists to absorb.
   */
  info(data: LogDataInput): unknown {
    return this.forward("info", data);
  }

  warn(data: LogDataInput): unknown {
    return this.forward("warn", data);
  }

  error(data: LogDataInput): unknown {
    return this.forward("error", data);
  }

  /**
   * What the line is: the data to pass on, or `null` to drop it. Forwards
   * unchanged by default, which is what a subclass that only overrides
   * {@link deliver} wants.
   *
   * The two below are the two things this can do. MutableLogger returns
   * `null` and nothing beneath it is called at all; PrefixedLogger fills in
   * absent fields and hands the line on.
   */
  protected transform(
    data: LogDataInput,
    // For a subclass that wants to gate or fill per level. Neither of the two
    // in this file does, so it is unused today and kept on purpose rather
    // than by oversight: `deliver` already takes a level, and a `transform`
    // that could not see one would push anything level-dependent into the
    // seam that wraps the call instead of the seam that decides the line.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    level: LogLevel,
  ): LogDataInput | null {
    return data;
  }

  /**
   * Hands one line to the logger beneath, falling back to `info` where that
   * logger cannot warn.
   *
   * The fallback is here rather than in each subclass because it is a fact
   * about the logger underneath rather than about any wrapper. `Logger`
   * declares `warn`, but a JavaScript caller can hand over an object without
   * it, and wrapping such a logger produces one that HAS `warn` — so a call
   * site with nothing to feature-detect calls it and reaches the one that is
   * not there. A wrapper is never worse than what it wraps.
   *
   * Returns whatever the logger beneath returned, which `Logger` declares as
   * `void` and an `async` implementation satisfies with a promise. Dropping it
   * would leave that promise with nobody holding it, so a subclass wrapping
   * this call — SafeLogger does — would have nothing to attach a `catch` to
   * and the rejection would reach the process instead.
   */
  protected deliver(level: LogLevel, data: LogDataInput): unknown {
    if (level === "warn" && typeof this.next.warn !== "function") {
      return this.next.info(data);
    }

    return this.next[level](data);
  }

  /**
   * The body `info`, `warn`, and `error` share, and the whole of what it is.
   *
   * Not a third seam. The two a forwarder answers are {@link transform} and
   * {@link deliver}; this is the plumbing that runs one and then the other,
   * in one place rather than three copies differing only by a string literal.
   * It is `private` so that stays true — nothing overrides it, and a subclass
   * reaching for it wants one of the other two.
   */
  private forward(level: LogLevel, data: LogDataInput): unknown {
    const forwarded = this.transform(data, level);

    // A dropped line has nothing to hand back, and undefined is the right
    // nothing: a caller inspecting this for a promise finds none, which is
    // true — no logger beneath was called.
    if (forwarded === null) {
      return undefined;
    }

    return this.deliver(level, forwarded);
  }
}

/**
 * Console logger implementation
 */
export class ConsoleLogger extends BaseLogger {
  /**
   * Log an informational message to the console
   */

  info(data: LogDataInput): void {
    const logData: LogData = { ...data, level: "info" };
    const prefix = buildLogPrefix(logData);
    // eslint-disable-next-line no-console
    console.log(`${prefix}${logData.message}`);
  }

  /**
   * Log an error message to the console
   */

  error(data: LogDataInput): void {
    const logData: LogData = { ...data, level: "error" };
    const prefix = buildLogPrefix(logData);
    const line = `${prefix}${logData.message}`;

    // Only when there IS one. `console.error(line, undefined)` prints the word
    // "undefined" after the message, which is every error line that carries no
    // error object — most of them, since a message often says the whole thing.
    if (logData.error === undefined) {
      // eslint-disable-next-line no-console
      console.error(line);

      return;
    }

    // eslint-disable-next-line no-console
    console.error(line, logData.error);
  }

  /**
   * Log a warning message to the console
   */
  warn(data: LogDataInput): void {
    const logData: LogData = { ...data, level: "warn" };
    const prefix = buildLogPrefix(logData);
    // eslint-disable-next-line no-console
    console.warn(`${prefix}${logData.message}`);
  }
}

/**
 * Which sources to quiet, by name. Absent means shown.
 *
 * Positive rather than a list of what to silence, so a call site reads as the
 * setting it is: `{ pg: false }` is "PostgreSQL's own output, off". Open to
 * any name for the reason {@link LogSource} is, since a host logging its own
 * sources through this gets to quiet them the same way.
 */
export type SourceVerbosity = Record<string, boolean>;

/**
 * Quiets the routine output of named sources, and forwards everything else.
 *
 * The one filter behind every console logger this package builds, and the
 * reason there is no longer one class per surface. The dev server, the test
 * database and the CLI each used to carry a private copy of this, differing
 * only in which source names were hardcoded into it — which meant the
 * verbosity flags were welded to the console sink, and a host that supplied
 * its own logger silently lost them. Wrap any sink in this and the policy
 * comes with it:
 *
 * ```ts
 * new SourceFilterLogger(myPinoAdapter, { pg: false })
 * ```
 *
 * Two rules, both of them about not silencing anything that was worth saying.
 *
 * Only `info` is quieted. A warning or an error is not chatter, and
 * PostgreSQL says which of its lines are which — see `postgresOutputLevel` —
 * so `{ pg: false }` drops "listening on IPv4 address" without also hiding
 * the FATAL that explains why the server would not start.
 *
 * And a source this was told nothing about is shown, whatever its level. A
 * host logging through this under a source of its own asked for that line,
 * and silence nobody requested is the worse failure. It is also what makes a
 * filter built for one surface safe to hand to another: the wrong one is
 * louder than intended, never quieter.
 */
export class SourceFilterLogger extends ForwardingLogger {
  private readonly sources: SourceVerbosity;

  constructor(next: Logger, sources: SourceVerbosity = {}) {
    super(next);
    this.sources = sources;
  }

  protected override transform(
    data: LogDataInput,
    level: LogLevel,
  ): LogDataInput | null {
    const quieted =
      level === "info" &&
      data.source !== undefined &&
      this.sources[data.source] === false;

    return quieted ? null : data;
  }
}

/**
 * A console logger, quieting whichever sources you name.
 *
 * Everything is shown by default, which is the answer for most callers: a
 * logger you passed in order to see what is happening should not decide on
 * your behalf that some of it is not worth reading. Name a source to turn its
 * routine output off.
 *
 * ```ts
 * createConsoleLogger()                          // everything
 * createConsoleLogger({ pg: false })             // no routine PostgreSQL output
 * createConsoleLogger({ pg: false, setup: false })
 * createConsoleLogger({ migration: false })      // no migration chatter
 * ```
 *
 * The sources this package emits are `pg` (PostgreSQL's own output), `setup`
 * (a dev server's startup steps), and `migration` (the migration system).
 * Lines a surface logs in its own voice carry no source and are never
 * quieted, so a silenced source never takes the message that matters with it.
 *
 * One function rather than one per surface, deliberately. The three it
 * replaced took positional booleans whose meaning depended on which of them
 * you had called — `(pgVerbose, setupVerbose)` in one and
 * `(pgVerbose, migrateVerbose)` in another, same arity, same types, different
 * second argument and different first default — so two identical-looking call
 * sites meant different things and TypeScript could not tell them apart.
 * Naming the source removes the question.
 */
export function createConsoleLogger(sources: SourceVerbosity = {}): Logger {
  return new SourceFilterLogger(new ConsoleLogger(), sources);
}

/**
 * Mutable logger that can be toggled on/off for unit tests.
 *
 * A gate and nothing else: what passes through reaches the logger beneath
 * exactly as it arrived. That is the whole of what this adds, and adding
 * anything to the payload is how it went wrong before — it built the
 * `[task] [stage] ` prefix out of the CALLER's own fields, put it in front of
 * the message, and then forwarded those fields as well, so a base logger that
 * renders them (ConsoleLogger, which is what one usually is) rendered them a
 * second time and every line came out "[migrate] [up] [migrate] [up] ...".
 *
 * There was never a prefix of its own to contribute, since this takes none.
 * Which logger renders the fields is a question with one answer here, and it
 * is the same one PrefixedLogger relies on: the logger at the bottom does it,
 * once. Anything in between forwards. See {@link ForwardingLogger}, which is
 * where that is now enforced rather than remembered.
 */
export class MutableLogger extends ForwardingLogger {
  private verbose: boolean;

  /**
   * Create a new mutable logger
   * @param baseLogger The underlying logger to use when verbose is true
   * @param verbose Whether to output logs (defaults to true)
   */
  constructor(baseLogger: Logger, verbose: boolean = true) {
    super(baseLogger);
    this.verbose = verbose;
  }

  /**
   * Set the verbose flag to enable/disable logging
   */
  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  /**
   * Get the current verbose setting
   */
  isVerbose(): boolean {
    return this.verbose;
  }

  /** Passes everything on, or nothing. The whole of what this class does. */
  protected override transform(data: LogDataInput): LogDataInput | null {
    return this.verbose ? data : null;
  }
}

/**
 * Prefixed logger that adds task and stage information to log messages
 *
 * Fills the fields in and forwards. It does NOT render them: the sink at the
 * bottom does that, once, which is the rule {@link ForwardingLogger} exists to
 * hold. A caller's own `task` or `stage` wins over this logger's, so a nested
 * prefix describes the outermost thing that named itself.
 *
 * @internal This class is intended for internal use only
 */
export class PrefixedLogger extends ForwardingLogger {
  private prefix: { source?: LogSource; task?: string; stage?: string };

  /**
   * Create a new prefixed logger
   */
  constructor(
    baseLogger: Logger,
    prefix: { source?: LogSource; task?: string; stage?: string },
  ) {
    super(baseLogger);
    this.prefix = prefix;
  }

  protected override transform(data: LogDataInput): LogDataInput {
    return {
      ...data,
      source: data.source || this.prefix.source,
      task: data.task || this.prefix.task,
      stage: data.stage || this.prefix.stage,
    };
  }
}

/**
 * Default console logger instance
 */
export const consoleLogger: Logger = new ConsoleLogger();

/**
 * Create a task-specific logger that prefills task and stage information
 * This function is maintained for backward compatibility
 */
export function createPrefixedLogger(
  baseLogger: Logger,
  prefix: { source?: LogSource; task?: string; stage?: string },
): Logger {
  // Asked for by the method rather than by the class. A logger that can prefix
  // itself should be the one to do it, and whether it happens to descend from
  // BaseLogger is a different question with a different answer: an `instanceof`
  // check here silently sends anything else down the fallback, so a wrapper or
  // a decorator around a logger loses that logger's own prefixing without
  // anything failing — both branches return a working logger, so nothing shows
  // up until someone notices the prefixes are wrong.
  const own = (baseLogger as Partial<BaseLogger>).createPrefixed;

  if (typeof own === "function") {
    return own.call(baseLogger, prefix);
  }

  // A plain object with no prefixing of its own.
  return new PrefixedLogger(baseLogger, prefix);
}
