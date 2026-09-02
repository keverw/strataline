import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  LocalDevDBServer,
  createDevDBConsoleLogger,
} from "../src/local-dev-db-server";

// Calculate paths relative to the current script
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "pgdata");
const PID_FILE = join(__dirname, "..", ".pg_pid");

// Create and start the PostgreSQL server
const server = new LocalDevDBServer({
  port: 5433,
  user: "myapp_user",
  password: "myapp_pass",
  database: "myapp_dev",
  dataDir: DATA_DIR,
  pidFile: PID_FILE,
  logger: createDevDBConsoleLogger(), // Optional: remove this line to run silently
  // The library reports a server that died and does nothing else, which is
  // right: it has no business ending this process. With nothing left pending
  // the script would then exit on its own — but with code 0, reporting a
  // crashed database as a clean run. This is here for the code, not the exit.
  onExit: (code) => process.exit(code),
});

// The library traps no signals, so wiring them is the host's job — and this
// process IS the dev server, so it has to exit once the server is down.
// Without this, a SIGTERM from a supervisor terminates the script and leaves
// the postmaster holding the port and the data directory.
//
// Held rather than only `.catch`ed, because a signal arriving during startup
// has to wait for it. `shutdown()` refuses while a start is in flight — the
// escalation and the spawn would otherwise race for the same child — so
// calling it straight from the handler would reject, and this script would
// exit(1) leaving the postmaster to the library's synchronous `exit` hook,
// which SIGKILLs it. That skips the SIGINT shutdown checkpoint, strands a
// postmaster.pid, and leaks the SysV IPC objects PostgreSQL frees only on a
// clean exit. Startup is the longest part of a cold run, so it is exactly
// when Ctrl+C lands.
let settled = false;

const startup = server.start().then(
  (): unknown => {
    settled = true;

    return null;
  },
  (error: unknown) => {
    settled = true;

    return error;
  },
);

startup.then((error) => {
  if (error !== null) {
    console.error(`Fatal error: ${error}`);
    process.exit(1);
  }
});

/**
 * How long a signal waits for an in-flight `start()` before giving up.
 *
 * The wait needs a bound because trapping a signal suppresses Node's own
 * termination: without one, a `SIGTERM` during a first-run `initdb` — which is
 * unbounded, and the one step here that can be — leaves the supervisor's grace
 * period to expire and `SIGKILL` the script, which is the ungraceful ending the
 * wait was there to avoid, arrived at more slowly.
 *
 * Short enough to leave a shutdown room inside `docker stop`'s ten seconds.
 * The give-up path is no worse than not waiting at all, so the only thing the
 * bound trades away is the startups that would have finished later than this.
 */
const START_WAIT_MS = 5000;

let stopping: Promise<void> | null = null;

/** Ends the process without a clean stop, saying why and what it costs. */
function abandonStartup(reason: string): void {
  console.error(
    `${reason} Exiting without a clean shutdown: any PostgreSQL this started ` +
      "will be force-killed, which can leave a stale postmaster.pid and leaked " +
      "SysV IPC objects behind.",
  );
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    // A second signal while the first is still WAITING gives up on the wait.
    // Once the shutdown itself is running it is left alone: cutting an
    // escalation off part-way can leave a data directory needing recovery, so
    // Ctrl+C twice must not do that.
    if (stopping) {
      if (!settled) {
        abandonStartup("Signaled again while still waiting for startup.");
      }

      return;
    }

    const startWait = setTimeout(
      () => abandonStartup("Timed out waiting for startup to finish."),
      START_WAIT_MS,
    );

    // Unref'd so the bound never itself keeps the process alive.
    startWait.unref();

    stopping = startup
      .then((error) => {
        clearTimeout(startWait);

        // A start that failed has already torn its own child down and is
        // about to exit(1) from the handler above, so there is nothing here
        // to stop and nothing to add.
        if (error !== null) {
          return;
        }

        return server.shutdown(signal).then(() => process.exit(0));
      })
      .catch((error: unknown) => {
        clearTimeout(startWait);
        console.error(`Shutdown failed: ${error}`);
        process.exit(1);
      });
  });
}
