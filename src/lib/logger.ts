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
  error?: any;
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
  log: (data: LogDataInput) => void;
  error: (data: LogDataInput) => void;
  warn?: (data: LogDataInput) => void;
}

/**
 * Build a log prefix from structured log data
 */

function buildLogPrefix(data: LogData): string {
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
  abstract log(data: LogDataInput): void;

  /**
   * Log an error message
   */
  abstract error(data: LogDataInput): void;

  /**
   * Log a warning message (optional)
   */
  warn?(data: LogDataInput): void;

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

  log(data: LogDataInput): void {
    const logData: LogData = { ...data, level: "info" };
    const prefix = buildLogPrefix(logData);
    console.log(`${prefix}${logData.message}`);
  }

  /**
   * Log an error message to the console
   */

  error(data: LogDataInput): void {
    const logData: LogData = { ...data, level: "error" };
    const prefix = buildLogPrefix(logData);
    console.error(`${prefix}${logData.message}`, logData.error);
  }

  /**
   * Log a warning message to the console
   */
  warn(data: LogDataInput): void {
    const logData: LogData = { ...data, level: "warn" };
    const prefix = buildLogPrefix(logData);
    console.warn(`${prefix}${logData.message}`);
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
  log(data: LogDataInput): void {
    this.baseLogger.log({
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
   * Log a warning message with prefix if supported by the base logger
   */
  warn?(data: LogDataInput): void {
    if (this.baseLogger.warn) {
      this.baseLogger.warn({
        ...data,
        task: data.task || this.prefix.task,
        stage: data.stage || this.prefix.stage,
      });
    }
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
  if (baseLogger instanceof BaseLogger) {
    return baseLogger.createPrefixed(prefix);
  }

  // For non-class loggers, use the legacy approach
  return new PrefixedLogger(baseLogger, prefix);
}
