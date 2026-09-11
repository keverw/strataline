# Change Log

<!-- toc -->

- [Unreleased](#unreleased)

<!-- tocstop -->

## Unreleased

This release hardens the embedded development and test databases against process-identity mistakes, failed starts, and overlapping lifecycle calls. It also gives every entry point one structured logging API.

**Breaking Changes**

- **Breaking:** `LocalDevDBServer`, `TestDatabaseInstance`, and `RunStratalineCLI` now take a structured `Logger` instead of their former tagged logger functions. `DevDBLoggerFunction`, `TestDBLoggerFunction`, `CLILoggerFunction`, `createDevDBConsoleLogger`, `createTestDBConsoleLogger`, and `createCLIConsoleLogger` have been removed. Import the logging API from the new `strataline/logger` entry point and use `createConsoleLogger()`, optionally setting the `pg`, `setup`, or `migration` source to `false`.
- **Breaking:** The logging types and helpers formerly exported by `strataline/migration` now come only from `strataline/logger`. Log origin is reported in `LogDataInput.source`, separately from the `info`, `warn`, or `error` method used for severity. `MutableLogger` is now only a verbosity gate and forwards messages and their structured fields unchanged, so sinks that do not render `task` and `stage` themselves no longer receive those fields duplicated in the message text.
- **Breaking:** `LocalDevDBServer` no longer installs `SIGINT`, `SIGTERM`, or `SIGHUP` handlers and never exits the host process. Applications must handle their own signals, await an in-flight `start()`, call the new `shutdown(signal)` method, and decide when to exit. `onExit` now reports only an unrequested PostgreSQL exit and is not called for `stop()`, `shutdown()`, or a failed `start()`.
- **Breaking:** Conflicting local-dev-server lifecycle calls now reject instead of being queued. `start()` rejects while another start or shutdown is in progress, and `stop()` or `shutdown()` rejects while startup is in progress. Concurrent shutdown calls still join the same operation. `stop()` and `shutdown()` now resolve only after PostgreSQL has exited and PID cleanup has finished, and reject if the server could not be stopped.
- **Breaking:** Local-dev-server shutdown now uses PostgreSQL fast shutdown, then immediate shutdown, then a hard kill as a last resort. It no longer sends `SIGTERM`, whose PostgreSQL smart-shutdown meaning can wait indefinitely for clients. `dataDir` is resolved to an absolute path when the server is constructed.
- **Breaking:** Local development PID files now contain structured JSON rather than a bare PID. Current readers accept the legacy format, so upgrades require no migration, but older Strataline versions cannot read the new records. Startup refuses unreadable, changing, foreign, or otherwise indeterminate PID state instead of signaling a process or deleting a record it cannot prove stale.
- **Breaking:** `TestDatabaseInstance.stop()` now rejects if PostgreSQL could not be confirmed stopped, and preserves the server and temporary directory so a later `stop()` can retry. Starts that overlap another lifecycle call and stops that overlap startup now reject, while concurrent stops join. Use `getLifecycleState()` when coordinating multiple lifecycle callers.
- **Breaking:** Test databases now listen only on IPv4, and `getCredentials().host` is `127.0.0.1` instead of `localhost`.
- **Breaking:** Both embedded database surfaces pin PostgreSQL's `log_line_prefix` to `%m [%p] ` so server severity can be parsed reliably. A custom `log_line_prefix` in a persistent development cluster's `postgresql.conf` is therefore overridden. `createConsoleLogger()` shows every source by default, unlike the former test-database factory, and `{ pg: false }` hides routine PostgreSQL information only, not warnings or errors.

**Local Development Server**

- Added `getLocalDevDBServerStatus()` and public PID inspection types and utilities to `strataline/local-dev-db-server`. Status results distinguish a verified server, a positively stale record, and an indeterminate live PID. Verification uses the available process command, start time, boot time, data directory, uid, PostgreSQL PID file, and optional connection evidence, and includes failed probes in `probeFailures` and `reason`.
- The optional connection tiebreaker asks PostgreSQL for its own start time and data directory when file and process evidence cannot decide. Its whole-operation timeout defaults to 6 seconds, must be a whole number from 20 through `2^31 - 1` milliseconds, and is exposed as `connection.timeoutMs` for status calls and `connectionTimeoutMs` for `LocalDevDBServer`. Wrappers can set `connection.timeoutOptionName` to name their corresponding setting in diagnostics. A caller-supplied probe is awaited only to the configured bound, although the probe must still clean up its own late work. Setup attempts to grant the configured development role `pg_read_all_settings` so the built-in probe can read `data_directory`. A failed grant warns without failing startup and can leave an otherwise ambiguous status indeterminate.
- PID publication and removal now use ownership-preserving filesystem operations, preventing a delayed lifecycle from overwriting or deleting a replacement record. Process identity is revalidated before every shutdown signal, and live-process evidence takes precedence over clock heuristics.
- First-run initialization uses a temporary sibling directory when the filesystem supports atomic publication, follows a symlinked `dataDir`, preserves the prior in-place behavior on cross-filesystem destinations, and reports nonempty uninitialized directories clearly. New clusters use a stable `postgres` bootstrap superuser, while clusters created by earlier versions remain usable with their original bootstrap user.
- Startup now cleans up partially started servers, closes failed readiness connections, includes captured PostgreSQL diagnostics in failures, and uses bounded, adaptive readiness polling. Unexpected child exits release the PID record and notify `onExit` without waiting indefinitely for inherited standard-I/O pipes.
- Added `getLifecycleState()`, returning the shared `LifecycleState` values `"stopped"`, `"starting"`, `"running"`, `"stopping"`, or `"unstoppable"`. `DevDBLifecycleState` remains an alias exported from the local-dev-server entry point.
- User, database, and password values used in setup DDL are now escaped with node-postgres helpers, so quotes and other identifier characters no longer break startup.

**Test Databases**

- Failed test-database starts now reject promptly with captured PostgreSQL output instead of hanging or replacing the original failure with a `TypeError`.
- Automatically assigned ports are chosen randomly outside the host's ephemeral port range when possible. If PostgreSQL still loses an automatically selected port before binding it, startup retries with another port. Explicit ports are never replaced.
- Test database startup and shutdown now share the same lifecycle state model as the local dev server. A failed stop retains the live cluster, and later cleanup no longer deletes a data directory that PostgreSQL may still be using.
- Test databases now force C-language PostgreSQL messages to match the local dev server. Both helpers capture PostgreSQL output with a size bound, group it by message, classify it by server severity, and add actionable diagnostics when System V shared memory or semaphores are exhausted.

**Logging and Callbacks**

- Added `createConsoleLogger`, `SourceFilterLogger`, `ForwardingLogger`, `LogSource`, and `SourceVerbosity` to `strataline/logger`. Source filters suppress only `info` messages for sources explicitly set to `false`, so warnings, errors, and unknown sources remain visible. `postgresOutputLevel()` is exported from `strataline/local-dev-db-server` for integrations that need the same severity classification.
- Embedded database and migration log records now identify PostgreSQL, setup, and migration output through `source`, while retaining `task`, `stage`, and error fields when forwarded to a caller's logger. Console output labels the source, uses the logger method for severity, and no longer prints a trailing `undefined` when an error record has no error object.
- Synchronous exceptions and asynchronous rejections from supplied loggers and `onExit` callbacks are contained instead of becoming unhandled failures in the host process. Logger failures are re-reported through the logger when possible, then through the host's existing global error-reporting channel or the console.
- `createPrefixedLogger()` now uses any logger object's own `createPrefixed()` method instead of requiring it to inherit from `BaseLogger`, and wrappers fall back to `info` when a JavaScript logger has no `warn` method.

**CLI**

- `POSTGRES_PORT`, `POSTGRES_MAX_CONNECTIONS`, `POSTGRES_IDLE_TIMEOUT`, and `POSTGRES_CONNECTION_TIMEOUT` must now be complete, safe whole-number strings. Values such as `5432oops`, `4.5`, or `1000ms` are rejected instead of silently truncated.
- If a migration operation fails and closing its adopted pool also fails, `RunStratalineCLI` preserves the operation's original error and reports the close failure separately. A close failure after an otherwise successful operation still rejects.
