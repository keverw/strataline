/**
 * Log level type
 */
export type LogLevel = "info" | "warn" | "error";

/**
 * Log data input structure (without level, which is determined by the method called)
 */
export interface LogDataInput {
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
  createPrefixed(prefix: { task?: string; stage?: string }): Logger {
    return new PrefixedLogger(this, prefix);
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
    // eslint-disable-next-line no-console
    console.error(`${prefix}${logData.message}`, logData.error);
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
 * once. Anything in between forwards.
 */
export class MutableLogger extends BaseLogger {
  private baseLogger: Logger;
  private verbose: boolean;

  /**
   * Create a new mutable logger
   * @param baseLogger The underlying logger to use when verbose is true
   * @param verbose Whether to output logs (defaults to true)
   */
  constructor(baseLogger: Logger, verbose: boolean = true) {
    super();
    this.baseLogger = baseLogger;
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

  /**
   * Log an informational message if verbose is enabled
   */
  info(data: LogDataInput): void {
    if (this.verbose) {
      this.baseLogger.info(data);
    }
  }

  /**
   * Log an error message if verbose is enabled
   */
  error(data: LogDataInput): void {
    if (this.verbose) {
      this.baseLogger.error(data);
    }
  }

  /**
   * Log a warning message if verbose is enabled, or inform where the logger
   * beneath cannot warn.
   *
   * Same fallback PrefixedLogger makes, and for the same reason: `Logger`
   * declares `warn`, but a JavaScript caller can hand over an object without
   * it, and wrapping such a logger here produces one that HAS `warn` — so a
   * call site with nothing to feature-detect calls it and reaches the one that
   * is not there. A wrapper is never worse than what it wraps.
   */
  warn(data: LogDataInput): void {
    if (this.verbose) {
      if (typeof this.baseLogger.warn === "function") {
        this.baseLogger.warn(data);

        return;
      }

      this.baseLogger.info(data);
    }
  }
}

/**
 * Prefixed logger that adds task and stage information to log messages
 * @internal This class is intended for internal use only
 */
export class PrefixedLogger extends BaseLogger {
  private baseLogger: Logger;
  private prefix: { task?: string; stage?: string };

  /**
   * Create a new prefixed logger
   */
  constructor(baseLogger: Logger, prefix: { task?: string; stage?: string }) {
    super();
    this.baseLogger = baseLogger;
    this.prefix = prefix;
  }

  /**
   * Log an informational message with prefix
   */
  info(data: LogDataInput): void {
    this.baseLogger.info({
      ...data,
      task: data.task || this.prefix.task,
      stage: data.stage || this.prefix.stage,
    });
  }

  /**
   * Log an error message with prefix
   */
  error(data: LogDataInput): void {
    this.baseLogger.error({
      ...data,
      task: data.task || this.prefix.task,
      stage: data.stage || this.prefix.stage,
    });
  }

  /**
   * Log a warning message with prefix, or inform where the logger beneath
   * cannot warn.
   *
   * This class is where a missing `warn` actually bites. `Logger` declares the
   * method, but a JavaScript caller can hand over an object without it, and
   * wrapping such a logger here produces a child that HAS `warn` — so a call
   * site with nothing to feature-detect calls it, and it reaches the one that
   * is not there. Falling back here means a prefixed child is never worse than
   * what it wraps.
   */
  warn(data: LogDataInput): void {
    const prefixed = {
      ...data,
      task: data.task || this.prefix.task,
      stage: data.stage || this.prefix.stage,
    };

    if (typeof this.baseLogger.warn === "function") {
      this.baseLogger.warn(prefixed);

      return;
    }

    this.baseLogger.info(prefixed);
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
  prefix: { task?: string; stage?: string },
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
