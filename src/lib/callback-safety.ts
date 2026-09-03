import {
  BaseLogger,
  ForwardingLogger,
  type LogDataInput,
  type LogLevel,
  type LogSource,
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
      let uncanceled = true;
      try {
        uncanceled = scope.dispatchEvent(event);
      } catch {
        // Dispatch failed, treat as uncanceled
      }

      reportToConsole(uncanceled, error, description);
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

/**
 * Wraps a Logger so method calls cannot throw or reject unhandled.
 *
 * @internal Not part of the published API.
 */
export function makeSafeLogger(logger: Logger): Logger {
  return new SafeLogger(logger);
}

/**
 * A forwarder that changes nothing about a line and everything about the call.
 *
 * Which is why it overrides `deliver` rather than `transform`: what it adds
 * sits around handing the line on, not in the line. Inheriting the rest means
 * the `warn` fallback is the same one every other forwarder uses instead of a
 * third copy of it, and a throw from the feature detection itself is inside
 * the guard rather than beside it.
 */
class SafeLogger extends ForwardingLogger {
  private readonly inner: Logger;
  private readonly escalate: (error: unknown) => void;

  constructor(inner: Logger) {
    super(inner);
    this.inner = inner;
    this.escalate = (error) =>
      inner.error({ message: ESCALATION_MESSAGE, error });
  }

  protected override deliver(level: LogLevel, data: LogDataInput): void {
    // No escalation for `error`: reporting a failed error through the same
    // error method is the call that just failed, so that one goes out of band.
    //
    // super.deliver's return value is what carries an async logger's promise
    // up to logSafely, which is the whole of how a rejection is caught rather
    // than left to end the process. Nothing is returned from here: the promise
    // has been taken care of, and handing it on would invite a second catch.
    logSafely(
      () => super.deliver(level, data),
      level === "error" ? null : this.escalate,
    );
  }

  createPrefixed(prefix: {
    source?: LogSource;
    task?: string;
    stage?: string;
  }): Logger {
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
