import {
  BaseLogger,
  buildLogPrefix,
  getErrorMessage,
  type LogDataInput,
  type LogLevel,
  type Logger,
} from "./logger";

/**
 * Runs caller-supplied callback and catches both synchronous throws and unhandled promise rejections.
 * Prevents asynchronous user callbacks from crashing the host process.
 *
 * @internal Not part of the published API.
 */
export function callHost(
  call: () => unknown,
  onFailure: (e: unknown) => void,
): void {
  try {
    const result = call();
    if (typeof (result as PromiseLike<unknown> | null)?.then === "function") {
      void Promise.resolve(result).catch(onFailure);
    }
  } catch (e) {
    onFailure(e);
  }
}

/**
 * Out-of-band error reporting hierarchy:
 * 1. EventTarget `error` event dispatch (cancelable)
 * 2. `globalThis.reportError`
 * 3. `console.error`
 */
function reportLoggerFailure(error: unknown, description: string): void {
  const scope = globalThis as typeof globalThis & {
    reportError?: (e: unknown) => void;
    dispatchEvent?: (event: Event) => boolean;
    ErrorEvent?: typeof ErrorEvent;
  };

  if (
    typeof scope.dispatchEvent === "function" &&
    typeof scope.ErrorEvent === "function"
  ) {
    let event: Event | null = null;
    try {
      event = new scope.ErrorEvent("error", {
        error,
        message: `[strataline] ${description}`,
        cancelable: true,
      });
    } catch {
      // Cannot build ErrorEvent, proceed to fallback
    }

    if (event !== null) {
      let uncancelled = true;
      try {
        uncancelled = scope.dispatchEvent(event);
      } catch {
        // Dispatch failed, treat as uncancelled
      }

      reportToConsole(uncancelled, error, description);
      return;
    }
  }

  if (typeof scope.reportError === "function") {
    try {
      scope.reportError(error);
      return;
    } catch {
      // Fall through to console
    }
  }

  reportToConsole(true, error, description);
}

function reportToConsole(
  wanted: boolean,
  error: unknown,
  description: string,
): void {
  if (!wanted) {
    return;
  }
  try {
    // eslint-disable-next-line no-console
    console.error(`[strataline] ${description}`, error);
  } catch {
    // Suppress console errors
  }
}

/**
 * Executes a logger call safely, degrading to an escalation callback or out-of-band reporting.
 *
 * @internal Not part of the published API.
 */
export function logSafely(
  emit: () => unknown,
  escalate: ((error: unknown) => unknown) | null,
): void {
  callHost(emit, (error) => {
    if (!escalate) {
      reportLoggerFailure(error, "a logger call failed and its line was lost");
      return;
    }

    callHost(
      () => escalate(error),
      (second) =>
        reportLoggerFailure(
          second,
          "a logger call failed and reporting that through the same logger failed too",
        ),
    );
  });
}

const ESCALATION_MESSAGE = "A logger call failed and its line was lost";

export type TaggedLoggerFunction<TType extends string> = (
  type: TType,
  message: string,
) => void;

/**
 * Wraps a tagged logger so calls cannot throw or reject unhandled.
 *
 * @internal Not part of the published API.
 */
export function makeSafeTaggedLogger<TType extends string>(
  logger: TaggedLoggerFunction<TType>,
  errorType: NoInfer<TType>,
): TaggedLoggerFunction<TType> {
  return (type, message) =>
    logSafely(
      () => logger(type, message),
      type === errorType
        ? null
        : (error) => logger(errorType, `${ESCALATION_MESSAGE}: ${error}`),
    );
}

function renderTagged(data: LogDataInput, level: LogLevel): string {
  const prefix = buildLogPrefix({ ...data, level });
  const message =
    level === "error" && data.error
      ? `${data.message}: ${getErrorMessage(data.error)}`
      : data.message;
  return `${prefix}${message}`;
}

/**
 * Adapts a tagged logger function into an object-shaped Logger.
 *
 * @internal Not part of the published API.
 */
export function taggedLoggerAsLogger<TType extends string>(
  emit: TaggedLoggerFunction<TType> | undefined,
  tags: {
    info: NoInfer<TType>;
    warn: NoInfer<TType>;
    error: NoInfer<TType>;
  },
): Logger {
  return new TaggedLoggerAdapter(emit, tags);
}

class TaggedLoggerAdapter<TType extends string> extends BaseLogger {
  private readonly emit: TaggedLoggerFunction<TType> | undefined;
  private readonly tags: { info: TType; warn: TType; error: TType };

  constructor(
    emit: TaggedLoggerFunction<TType> | undefined,
    tags: { info: TType; warn: TType; error: TType },
  ) {
    super();
    this.emit = emit;
    this.tags = tags;
  }

  info(data: LogDataInput): void {
    this.send("info", data);
  }

  warn(data: LogDataInput): void {
    this.send("warn", data);
  }

  error(data: LogDataInput): void {
    this.send("error", data);
  }

  private send(level: LogLevel, data: LogDataInput): void {
    if (!this.emit) {
      return;
    }
    this.emit(this.tags[level], renderTagged(data, level));
  }
}

/**
 * Wraps a Logger so method calls cannot throw or reject unhandled.
 *
 * @internal Not part of the published API.
 */
export function makeSafeLogger(logger: Logger): Logger {
  return new SafeLogger(logger);
}

class SafeLogger extends BaseLogger {
  private readonly inner: Logger;
  private readonly escalate: (error: unknown) => void;

  constructor(inner: Logger) {
    super();
    this.inner = inner;
    this.escalate = (error) =>
      inner.error({ message: ESCALATION_MESSAGE, error });
  }

  info(data: LogDataInput): void {
    logSafely(() => this.inner.info(data), this.escalate);
  }

  warn(data: LogDataInput): void {
    logSafely(
      () =>
        typeof this.inner.warn === "function"
          ? this.inner.warn(data)
          : this.inner.info(data),
      this.escalate,
    );
  }

  error(data: LogDataInput): void {
    logSafely(() => this.inner.error(data), null);
  }

  createPrefixed(prefix: { task?: string; stage?: string }): Logger {
    const own = (this.inner as Partial<BaseLogger>).createPrefixed;
    if (typeof own !== "function") {
      return super.createPrefixed(prefix);
    }
    try {
      return makeSafeLogger(own.call(this.inner, prefix));
    } catch (error) {
      this.error({
        message:
          "A logger failed to build a prefixed child logger. Falling back to the built-in one.",
        error,
      });
      return super.createPrefixed(prefix);
    }
  }
}
