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
 * crossing two axes does. `pg` and `setup` had no severity at all, so a
 * PostgreSQL FATAL and a routine startup line were both an ordinary log; and
 * `migrate-` was a namespace built out of string prefixes, so the three tag
 * sets shared no type and adding a level meant editing each of them.
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
 * Subclassing this rather than `BaseLogger` makes that unwriteable. A
 * forwarder gets no say in what a line looks like: {@link transform} returns
 * the data to pass on or `null` to drop it, so the whole of its vocabulary is
 * fields, and there is nowhere to put a rendered string. The `warn` fallback
 * lives here too, in one copy rather than one per subclass.
 */
export abstract class ForwardingLogger extends BaseLogger {
  protected readonly next: Logger;

  constructor(next: Logger) {
    super();
    this.next = next;
  }

  info(data: LogDataInput): void {
    this.forward("info", data);
  }

  warn(data: LogDataInput): void {
    this.forward("warn", data);
  }

  error(data: LogDataInput): void {
    this.forward("error", data);
  }

  /**
   * What to pass on, or `null` to drop the line. Forwards unchanged by
   * default, which is what a subclass that only overrides {@link deliver}
   * wants.
   */
  protected transform(
    data: LogDataInput,
    // Named for the subclasses that branch on it. Unused here.
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

  private forward(level: LogLevel, data: LogDataInput): void {
    const forwarded = this.transform(data, level);

    if (forwarded === null) {
      return;
    }

    this.deliver(level, forwarded);
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
