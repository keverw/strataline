import { describe, it, expect, afterEach } from "bun:test";
import { callHost, logSafely, makeSafeLogger } from "./callback-safety";
import {
  BaseLogger,
  createPrefixedLogger,
  getErrorMessage,
  type LogDataInput,
  type Logger,
} from "./logger";

/**
 * Collects unhandled rejections for the length of one test.
 *
 * Listened for rather than left to fire, because unhandled is exactly what
 * they would be: with no listener attached these do not fail a test, they take
 * the runner down. Which is the behavior under test, seen from the inside.
 */
function watchUnhandledRejections(): {
  seen: unknown[];
  stop: () => void;
} {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };

  process.on("unhandledRejection", onUnhandled);

  return {
    seen,
    stop: () => process.off("unhandledRejection", onUnhandled),
  };
}

/** Long enough for a rejection to have been reported if it was going to be. */
async function settle(): Promise<void> {
  await Bun.sleep(50);
}

/**
 * Stubs the out-of-band reporter for one test, and puts back what was there.
 *
 * `reportError` is a host global: Bun and browsers define it, Node as of 25.x
 * does not. So restoring means removing it again where it was absent, rather
 * than writing undefined over a name the runtime never had.
 */
function stubReportError(): { reported: unknown[]; restore: () => void } {
  const scope = globalThis as unknown as Record<string, unknown>;
  const names = ["reportError", "dispatchEvent"];
  const saved = names.map((name) => ({
    name,
    had: name in scope,
    value: scope[name],
  }));
  const reported: unknown[] = [];

  // dispatchEvent is removed, not merely left alone. The reporter prefers
  // dispatching wherever an EventTarget exists, and the runtime these tests
  // run on has one, so leaving it in place would send the report there and
  // reportError would never be reached. These tests are about which rung of
  // the in-band ladder ran, so the out-of-band destination is pinned to the
  // one they observe.
  delete scope.dispatchEvent;

  scope.reportError = (e: unknown) => {
    reported.push(e);
  };

  return {
    reported,
    restore: () => {
      for (const entry of saved) {
        if (entry.had) {
          scope[entry.name] = entry.value;
        } else {
          delete scope[entry.name];
        }
      }
    },
  };
}

describe("callHost", () => {
  let watcher: ReturnType<typeof watchUnhandledRejections> | null = null;

  afterEach(() => {
    watcher?.stop();
    watcher = null;
  });

  it("runs the callback and reports nothing when it succeeds", () => {
    const failures: unknown[] = [];
    let called = false;

    callHost(
      () => {
        called = true;
      },
      (e) => failures.push(e),
    );

    expect(called).toBe(true);
    expect(failures).toEqual([]);
  });

  it("reports a synchronous throw to onFailure", () => {
    const failures: unknown[] = [];
    const boom = new Error("sync boom");

    callHost(
      () => {
        throw boom;
      },
      (e) => failures.push(e),
    );

    expect(failures).toEqual([boom]);
  });

  it("reports a rejected promise to onFailure without leaving it unhandled", async () => {
    // The half a try/catch cannot cover. A callback declared `=> void` may be
    // an `async` function — TypeScript admits one — and its failure is a
    // rejection rather than a throw.
    watcher = watchUnhandledRejections();

    const failures: unknown[] = [];
    const boom = new Error("async boom");

    callHost(
      async () => {
        throw boom;
      },
      (e) => failures.push(e),
    );

    // Not yet: the rejection is delivered on a later turn, which is precisely
    // why the synchronous try/catch at the call site never saw it.
    expect(failures).toEqual([]);

    await settle();

    expect(failures).toEqual([boom]);
    expect(watcher.seen).toEqual([]);
  });

  it("absorbs a rejected thenable that is not a native promise", async () => {
    // Duck-typed on purpose: a thenable from another realm or another promise
    // library rejects just as unhandled as a native one.
    watcher = watchUnhandledRejections();

    const failures: unknown[] = [];
    const boom = new Error("thenable boom");

    callHost(
      () => ({
        then: (
          _resolve: (v: unknown) => void,
          reject: (e: unknown) => void,
        ) => {
          reject(boom);
        },
      }),
      (e) => failures.push(e),
    );

    await settle();

    expect(failures).toEqual([boom]);
    expect(watcher.seen).toEqual([]);
  });

  it("reports a thenable whose `then` getter throws", async () => {
    // Reading `then` is running the callback's code too, so the inspection
    // has to sit inside the same guard as the call. Outside it, a getter that
    // throws escapes uncaught from a place whose whole promise is that
    // nothing does — an event listener or a voided chain, where it becomes
    // the uncaught exception this module exists to prevent.
    watcher = watchUnhandledRejections();

    const failures: unknown[] = [];
    const boom = new Error("getter boom");

    callHost(
      () => ({
        get then(): never {
          throw boom;
        },
      }),
      (e) => failures.push(e),
    );

    await settle();

    expect(failures).toEqual([boom]);
    expect(watcher.seen).toEqual([]);
  });

  it("does not treat a plain non-thenable return value as a promise", async () => {
    const failures: unknown[] = [];

    callHost(
      () => 42,
      (e) => failures.push(e),
    );

    await settle();

    expect(failures).toEqual([]);
  });

  it("lets a throw from onFailure through rather than masking it", () => {
    // Pinned because it is the one thing this does not absorb. `onFailure` is
    // this file's own reporting, not caller-supplied code: every reporter in
    // the codebase is either a no-op or a logSafely-wrapped log, so a throw
    // from one is a bug in here and belongs on the surface rather than under
    // a second layer of catching.
    expect(() => {
      callHost(
        () => {
          throw new Error("first");
        },
        () => {
          throw new Error("second");
        },
      );
    }).toThrow("second");
  });
});

describe("logSafely", () => {
  let watcher: ReturnType<typeof watchUnhandledRejections> | null = null;

  afterEach(() => {
    watcher?.stop();
    watcher = null;
  });

  it("escalates a synchronous throw to the second chance rather than silencing it", () => {
    const escalated: unknown[] = [];
    const boom = new Error("logger down");

    expect(() => {
      logSafely(
        () => {
          throw boom;
        },
        (error) => escalated.push(error),
      );
    }).not.toThrow();

    // The bet the middle rung makes: one level or one destination is broken,
    // not the whole logger, so the report stays inside the caller's own
    // infrastructure where they are already looking.
    expect(escalated).toEqual([boom]);
  });

  it("escalates a rejection without leaving it unhandled", async () => {
    watcher = watchUnhandledRejections();

    const escalated: unknown[] = [];
    const boom = new Error("async logger down");

    logSafely(
      async () => {
        throw boom;
      },
      (error) => escalated.push(error),
    );

    await settle();

    expect(escalated).toEqual([boom]);
    expect(watcher.seen).toEqual([]);
  });

  it("goes out of band when the second chance fails too", async () => {
    // Both rungs of in-band reporting are gone by this point, so the failure
    // has to leave the logger entirely or vanish. reportError is the
    // web-standard way to hand it over without throwing.
    watcher = watchUnhandledRejections();

    const { reported, restore } = stubReportError();

    try {
      logSafely(
        () => {
          throw new Error("first");
        },
        () => {
          throw new Error("second");
        },
      );

      await settle();

      expect(reported).toHaveLength(1);
      expect((reported[0] as Error).message).toBe("second");
      expect(watcher.seen).toEqual([]);
    } finally {
      restore();
    }
  });

  it("skips the second chance when there is none to take", async () => {
    // Passing null is how a caller says the error channel IS what just failed,
    // so re-reporting through it would be the same call again.
    watcher = watchUnhandledRejections();

    const { reported, restore } = stubReportError();

    try {
      logSafely(() => {
        throw new Error("only chance");
      }, null);

      await settle();

      expect(reported).toHaveLength(1);
      expect((reported[0] as Error).message).toBe("only chance");
    } finally {
      restore();
    }
  });
});

describe("reportLoggerFailure, through logSafely's last rung", () => {
  /** Removes the globals these tests install, leaving what was already there. */
  function withoutGlobals(names: string[]): () => void {
    const scope = globalThis as unknown as Record<string, unknown>;
    const saved = names.map((name) => ({
      name,
      had: name in scope,
      value: scope[name],
    }));

    return () => {
      for (const entry of saved) {
        if (entry.had) {
          scope[entry.name] = entry.value;
        } else {
          delete scope[entry.name];
        }
      }
    };
  }

  /** Drives both rungs of in-band reporting into failure. */
  function exhaustTheLogger(): void {
    logSafely(
      () => {
        throw new Error("primary down");
      },
      () => {
        throw new Error("second chance down");
      },
    );
  }

  /**
   * Puts a REAL EventTarget behind globalThis for one test.
   *
   * Real rather than a stub returning a chosen boolean, because what is under
   * test is the platform's own cancelation semantics: an ErrorEvent is
   * uncancelable unless asked otherwise, and preventDefault on an uncancelable
   * event is a no-op that leaves dispatchEvent returning true whatever a
   * listener does. Against a stub that returns whatever it is told to, code
   * that forgot `cancelable: true` passes.
   */
  function withRealEventTarget(): {
    seen: ErrorEvent[];
    listen: (handler: (event: ErrorEvent) => void) => void;
    restore: () => void;
  } {
    const restore = withoutGlobals(["reportError", "dispatchEvent"]);
    const scope = globalThis as unknown as Record<string, unknown>;
    const target = new EventTarget();
    const seen: ErrorEvent[] = [];

    delete scope.reportError;
    scope.dispatchEvent = (event: Event) => target.dispatchEvent(event);

    target.addEventListener("error", (event) => {
      seen.push(event as ErrorEvent);
    });

    return {
      seen,
      listen: (handler) =>
        target.addEventListener("error", (event) =>
          handler(event as ErrorEvent),
        ),
      restore,
    };
  }

  it("dispatches a cancelable ErrorEvent when the host is an EventTarget but has no reportError", () => {
    const host = withRealEventTarget();

    try {
      exhaustTheLogger();

      // The behavior reportError stands for, for a host that set up the
      // channel but is on a runtime that does not provide the function.
      expect(host.seen).toHaveLength(1);
      expect(host.seen[0].type).toBe("error");
      expect(host.seen[0].error).toBeInstanceOf(Error);

      // Uncancelable is the default, and it makes preventDefault a no-op, so
      // a listener could never suppress the console line that follows.
      expect(host.seen[0].cancelable).toBe(true);
    } finally {
      host.restore();
    }
  });

  it("lets a listener suppress the console by cancelling, against a real EventTarget", () => {
    const host = withRealEventTarget();

    host.listen((event) => event.preventDefault());

    const original = console.error;
    const lines: unknown[][] = [];

    console.error = (...args: unknown[]) => {
      lines.push(args);
    };

    try {
      exhaustTheLogger();
    } finally {
      console.error = original;
      host.restore();
    }

    // Taken responsibility for, so it stops here. This is the assertion that
    // fails without `cancelable: true`.
    expect(host.seen).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  it("still reaches the console when nothing handled the dispatched event", () => {
    // reportError is not merely a dispatch: it reports to the console too
    // unless a listener cancels. A host with an EventTarget but no listener
    // that takes the error must not have this vanish.
    const host = withRealEventTarget();

    const original = console.error;
    const lines: unknown[][] = [];

    console.error = (...args: unknown[]) => {
      lines.push(args);
    };

    try {
      exhaustTheLogger();
    } finally {
      console.error = original;
      host.restore();
    }

    expect(host.seen).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it("prefers dispatching over reportError, when the host has both", () => {
    // Measured, not assumed. On Bun 1.3.14 reportError notifies no error
    // listener at all AND sets the process exit code to 1, so preferring it
    // would be both a black hole and this library deciding the host's exit
    // status over a log line.
    const restore = withoutGlobals(["reportError", "dispatchEvent"]);
    const scope = globalThis as unknown as Record<string, unknown>;

    try {
      const reported: unknown[] = [];
      const dispatched: Event[] = [];

      scope.reportError = (e: unknown) => {
        reported.push(e);
      };
      scope.dispatchEvent = (event: Event) => {
        dispatched.push(event);

        return false;
      };

      exhaustTheLogger();

      expect(dispatched).toHaveLength(1);
      expect(reported).toEqual([]);
    } finally {
      restore();
    }
  });

  it("does not fall on to reportError after an uncanceled dispatch", () => {
    // In a browser reportError dispatches an error event of its own, so
    // calling it after our dispatch would notify every listener twice. The
    // console is the tail because it is the one place that cannot double.
    const restore = withoutGlobals(["reportError", "dispatchEvent"]);
    const scope = globalThis as unknown as Record<string, unknown>;

    try {
      const reported: unknown[] = [];

      scope.reportError = (e: unknown) => {
        reported.push(e);
      };
      scope.dispatchEvent = () => true;

      const original = console.error;
      const lines: unknown[][] = [];

      console.error = (...args: unknown[]) => {
        lines.push(args);
      };

      try {
        exhaustTheLogger();
      } finally {
        console.error = original;
      }

      expect(lines).toHaveLength(1);
      expect(reported).toEqual([]);
    } finally {
      restore();
    }
  });

  it("uses reportError on a host that has it without an EventTarget", () => {
    const restore = withoutGlobals(["reportError", "dispatchEvent"]);
    const scope = globalThis as unknown as Record<string, unknown>;

    try {
      delete scope.dispatchEvent;

      const reported: unknown[] = [];

      scope.reportError = (e: unknown) => {
        reported.push(e);
      };

      exhaustTheLogger();

      expect(reported).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("falls to reportError when the ErrorEvent cannot even be constructed", () => {
    // Nothing was handed to anyone, so the channel is simply unusable and
    // moving on to the next rung is right.
    const restore = withoutGlobals([
      "reportError",
      "dispatchEvent",
      "ErrorEvent",
    ]);
    const scope = globalThis as unknown as Record<string, unknown>;

    try {
      const reported: unknown[] = [];
      const dispatched: Event[] = [];

      scope.ErrorEvent = function ThrowingErrorEvent() {
        throw new Error("no ErrorEvent here");
      };
      scope.dispatchEvent = (event: Event) => {
        dispatched.push(event);

        return true;
      };
      scope.reportError = (e: unknown) => {
        reported.push(e);
      };

      exhaustTheLogger();

      expect(dispatched).toEqual([]);
      expect(reported).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("does not fall to reportError when the dispatch itself throws", () => {
    // The opposite classification, and the one that matters: the event was
    // constructed and handed over, so listeners may already have run. Falling
    // on to reportError would notify them a second time, and on Bun would take
    // the process exit code with it.
    //
    // Stubbed deliberately, and this is the case where stubbing is right: the
    // question is what this code does when a dispatch throws, not what the
    // platform's dispatch returns. A real one will not do this — a listener's
    // exception is reported out of band rather than propagating — so a host
    // that rejects the event outright is the only way to reach the path.
    const restore = withoutGlobals(["reportError", "dispatchEvent"]);
    const scope = globalThis as unknown as Record<string, unknown>;

    try {
      const reported: unknown[] = [];

      scope.dispatchEvent = () => {
        throw new Error("this host rejects the event");
      };
      scope.reportError = (e: unknown) => {
        reported.push(e);
      };

      const original = console.error;
      const lines: unknown[][] = [];

      console.error = (...args: unknown[]) => {
        lines.push(args);
      };

      try {
        exhaustTheLogger();
      } finally {
        console.error = original;
      }

      expect(reported).toEqual([]);
      expect(lines).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("installs nothing on a host that provides neither", () => {
    // Detected, never installed: taking globalThis over is a decision about
    // the whole program and is not a library's to make.
    const restore = withoutGlobals(["reportError", "dispatchEvent"]);
    const scope = globalThis as unknown as Record<string, unknown>;

    try {
      delete scope.reportError;
      delete scope.dispatchEvent;

      const original = console.error;
      const lines: unknown[][] = [];

      console.error = (...args: unknown[]) => {
        lines.push(args);
      };

      try {
        exhaustTheLogger();
      } finally {
        console.error = original;
      }

      expect(lines).toHaveLength(1);
      expect("reportError" in scope).toBe(false);
      expect("dispatchEvent" in scope).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("makeSafeLogger", () => {
  let watcher: ReturnType<typeof watchUnhandledRejections> | null = null;

  afterEach(() => {
    watcher?.stop();
    watcher = null;
  });

  it("passes calls through and absorbs every way one can fail", async () => {
    watcher = watchUnhandledRejections();

    const stub = stubReportError();
    const seen: string[] = [];

    // Only the level under test is broken each time, so `error` stays usable
    // as the second chance the others escalate to.
    const safe = makeSafeLogger({
      info: (data) => {
        seen.push(data.message);
      },
      warn: () => {
        throw new Error("warn down");
      },
      error: (data) => {
        seen.push(data.message);
      },
    });

    try {
      expect(() => safe.info({ message: "through" })).not.toThrow();
      expect(() => safe.warn({ message: "sync" })).not.toThrow();

      await settle();

      // The warn failure was re-reported through `error` rather than lost.
      expect(seen).toEqual([
        "through",
        "A logger call failed and its line was lost",
      ]);

      // Nothing had to leave the logger, since the second chance worked.
      expect(stub.reported).toEqual([]);
      expect(watcher.seen).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("goes out of band when the error level is what rejects", async () => {
    // An `async` logger, which the `=> void` signature admits. The error level
    // has no second chance to take, so a failure there leaves the logger.
    watcher = watchUnhandledRejections();

    const stub = stubReportError();

    const safe = makeSafeLogger({
      info: () => {},
      warn: () => {},
      error: (() => Promise.reject(new Error("error down"))) as Logger["error"],
    });

    try {
      expect(() => safe.error({ message: "async" })).not.toThrow();

      await settle();

      expect(stub.reported).toHaveLength(1);
      expect((stub.reported[0] as Error).message).toBe("error down");

      // Absorbed, so it never became the unhandled rejection that ends a
      // process.
      expect(watcher.seen).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("warns through `info` when the wrapped logger has no `warn`", () => {
    // A JavaScript caller can omit it despite the type. The wrapper knows what
    // it is wrapping, so it does the falling back and every caller can just
    // call `warn` — rather than each call site feature-detecting, and rather
    // than this reproducing the hole by leaving `warn` off itself too.
    const seen: string[] = [];
    const partial = {
      info: (data: { message: string }) => {
        seen.push(data.message);
      },
      error: () => {},
    } as unknown as Logger;

    const safe = makeSafeLogger(partial);

    expect(typeof safe.warn).toBe("function");
    expect(() => safe.warn({ message: "fell back" })).not.toThrow();

    expect(seen).toEqual(["fell back"]);
  });

  it("keeps a BaseLogger's own createPrefixed, and guards what it returns", () => {
    // createPrefixedLogger asks whether a logger is a BaseLogger, and lets one
    // build its own prefixed child. Handing back a bare object would take
    // every wrapped logger down the built-in fallback instead — silently,
    // since that path also produces a working logger — and a subclass that
    // overrides createPrefixed would simply stop being asked. BaseLogger is
    // exported from the package, so that override is a supported thing to
    // write.
    const seen: string[] = [];

    class TaggingLogger extends BaseLogger {
      constructor(private readonly tag: string) {
        super();
      }

      info(data: LogDataInput): void {
        seen.push(`${this.tag}/info:${data.message}`);
      }

      warn(data: LogDataInput): void {
        seen.push(`${this.tag}/warn:${data.message}`);
      }

      error(data: LogDataInput): void {
        seen.push(`${this.tag}/error:${data.message}`);
      }

      createPrefixed(prefix: { task?: string; stage?: string }): Logger {
        return new TaggingLogger(prefix.stage ?? this.tag);
      }
    }

    const safe = makeSafeLogger(new TaggingLogger("root"));

    expect(safe).toBeInstanceOf(BaseLogger);

    const child = createPrefixedLogger(safe, { stage: "child" });

    child.info({ message: "hello" });

    // The subclass's own child, not a PrefixedLogger wrapped around the root.
    expect(seen).toEqual(["child/info:hello"]);
  });

  it("guards the prefixed child a wrapped logger builds", () => {
    // Delegating alone would hand back an unguarded logger, and most lines are
    // written through a task or stage logger, so the guarantee has to survive
    // the trip.
    const stub = stubReportError();

    class BrokenLogger extends BaseLogger {
      info(): void {
        throw new Error("child info down");
      }

      warn(): void {
        throw new Error("child warn down");
      }

      error(): void {
        throw new Error("child error down");
      }
    }

    const safe = makeSafeLogger(new BrokenLogger());
    const child = createPrefixedLogger(safe, { stage: "child" });

    try {
      expect(() => child.info({ message: "swallowed" })).not.toThrow();

      // Both the call and the escalation through `error` failed, so the
      // failure left the logger rather than being lost.
      expect(stub.reported).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it("catches a rejection from the prefixed child a wrapped logger builds", async () => {
    // The async twin of the test above, and the case a synchronous throw
    // cannot reach. A BaseLogger subclass INHERITS createPrefixed, so the
    // chain a wrapped one produces is SafeLogger -> PrefixedLogger -> logger:
    // the guard is no longer the immediate wrapper. A throw propagates up
    // through the forwarder in the middle by itself, but a promise only
    // survives if that forwarder hands back what it was given — otherwise the
    // rejection is nobody's, and Node ends the process over the one thing
    // makeSafeLogger exists to absorb.
    watcher = watchUnhandledRejections();

    const escalated: string[] = [];

    class AsyncLogger extends BaseLogger {
      // `Logger` declares these `void`, which an `async` implementation
      // satisfies with a promise. This is that logger, rejecting.
      info(): Promise<void> {
        return Promise.reject(new Error("async line lost"));
      }

      warn(): void {}

      error(data: LogDataInput): void {
        escalated.push(getErrorMessage(data.error));
      }
    }

    const child = createPrefixedLogger(makeSafeLogger(new AsyncLogger()), {
      stage: "child",
    });

    child.info({ message: "swallowed" });

    await settle();

    // Caught by the guard on the outside and re-reported through `error`,
    // rather than left to the runtime.
    expect(watcher.seen).toEqual([]);
    expect(escalated).toEqual(["async line lost"]);
  });

  it("keeps `warn` usable on the prefixed child of a logger without one", () => {
    // Where the absence had to be mirrored, this was the case that broke:
    // PrefixedLogger defines `warn` whatever it wraps, so a child over a
    // warn-less logger offered a method that reached one that was not there.
    // Falling back inside the wrapper fixes the child by construction, and
    // most lines are written through a task or stage logger.
    const seen: string[] = [];
    const partial = {
      info: (data: { message: string; stage?: string }) => {
        seen.push(`${data.stage ?? "-"}:${data.message}`);
      },
      error: () => {},
    } as unknown as Logger;

    const child = createPrefixedLogger(makeSafeLogger(partial), {
      stage: "child",
    });

    expect(() => child.warn({ message: "landed" })).not.toThrow();

    expect(seen).toEqual(["child:landed"]);
  });

  it("asks a plain object that can prefix itself, without it being a BaseLogger", () => {
    // The dispatch that used to be an `instanceof` check, which is what made
    // the wrapper's own prefixing regress: both branches return a working
    // logger, so taking the wrong one shows up as wrong prefixes rather than
    // as a failure. Asking for the method instead means anything that can
    // prefix itself gets asked, class or not.
    const seen: string[] = [];

    const canPrefix = {
      info: (data: LogDataInput) => {
        seen.push(`root:${data.message}`);
      },
      warn: () => {},
      error: () => {},
      createPrefixed: (prefix: { task?: string; stage?: string }) => ({
        info: (data: LogDataInput) => {
          seen.push(`${prefix.stage}:${data.message}`);
        },
        warn: () => {},
        error: () => {},
      }),
    } as unknown as Logger;

    expect(canPrefix).not.toBeInstanceOf(BaseLogger);

    createPrefixedLogger(canPrefix, { stage: "own" }).info({
      message: "hello",
    });

    expect(seen).toEqual(["own:hello"]);
  });

  it("asks a wrapped plain object that can prefix itself", () => {
    // The path the library actually takes, which the test above does not: the
    // migration system wraps the logger and then calls createPrefixedLogger on
    // the WRAPPER, so the dispatch that matters is the one inside it. An
    // `instanceof` check there sends a plain object down the fallback even
    // though the duck-typed one outside would have asked it.
    const seen: string[] = [];

    const canPrefix = {
      info: (data: LogDataInput) => {
        seen.push(`root:${data.message}`);
      },
      warn: () => {},
      error: () => {},
      createPrefixed: (prefix: { task?: string; stage?: string }) => ({
        info: (data: LogDataInput) => {
          seen.push(`${prefix.stage}:${data.message}`);
        },
        warn: () => {},
        error: () => {},
      }),
    } as unknown as Logger;

    createPrefixedLogger(makeSafeLogger(canPrefix), { stage: "own" }).info({
      message: "hello",
    });

    expect(seen).toEqual(["own:hello"]);
  });

  it("keeps warning usable on the child of a BaseLogger that has no `warn`", () => {
    // The other half of the same gap. A child is built over the raw logger, so
    // it defines `warn` whatever that logger has — and the caller has nothing
    // to feature-detect, since the method is right there.
    const seen: string[] = [];

    class NoWarnLogger extends BaseLogger {
      info(data: LogDataInput): void {
        seen.push(`info:${data.message}`);
      }

      error(data: LogDataInput): void {
        seen.push(`error:${data.message}`);
      }

      // No `warn`, which only untyped JavaScript can do. Declared so the
      // abstract member is satisfied, then removed from the prototype below.
      warn(data: LogDataInput): void {
        seen.push(`warn:${data.message}`);
      }
    }

    delete (NoWarnLogger.prototype as Partial<BaseLogger>).warn;

    const child = createPrefixedLogger(makeSafeLogger(new NoWarnLogger()), {
      stage: "child",
    });

    expect(() => child.warn({ message: "landed" })).not.toThrow();

    // On `info`, rather than lost to the "a logger call failed" escalation.
    expect(seen).toEqual(["info:landed"]);
  });

  it("degrades to the built-in child when a logger's createPrefixed throws", () => {
    // Asking for a child is a call into the caller's logger like any other.
    // It happens on the way into a migration rather than from a timer, so a
    // throw fails the run rather than the process — still not something to
    // fail the work being logged over.
    const seen: string[] = [];

    class RefusingLogger extends BaseLogger {
      info(data: LogDataInput): void {
        seen.push(`info:${data.message}`);
      }

      warn(data: LogDataInput): void {
        seen.push(`warn:${data.message}`);
      }

      error(data: LogDataInput): void {
        seen.push(`error:${data.message}`);
      }

      createPrefixed(): Logger {
        throw new Error("cannot build a child");
      }
    }

    const safe = makeSafeLogger(new RefusingLogger());

    let child: Logger | undefined;

    expect(() => {
      child = createPrefixedLogger(safe, { stage: "child" });
    }).not.toThrow();

    // The failure was reported rather than swallowed...
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(
      "error:A logger failed to build a prefixed child",
    );

    // ...and what came back still logs, through the built-in prefixing.
    child?.info({ message: "still works" });

    expect(seen[1]).toBe("info:still works");
  });
});
