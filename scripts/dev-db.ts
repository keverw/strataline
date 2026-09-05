import { join, dirname } from "path";
import { createConsoleLogger } from "../src/logger";
import { fileURLToPath } from "url";
import { LocalDevDBServer } from "../src/local-dev-db-server";

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
  logger: createConsoleLogger(), // Optional: remove this line to run silently
  // The library reports a server that died and does nothing else, which is
  // right: it has no business ending this process. With nothing left pending
  // the script would then exit on its own — but with code 0, reporting a
  // crashed database as a clean run. This is here for the code, not the exit.
  //
  // `|| 1` because PostgreSQL's own code is not the whole story here. onExit
  // fires only for an exit nobody asked THIS process for, and one of the ways
  // to get there is somebody else shutting the server down cleanly — a
  // `pg_ctl stop`, or an operator's SIGINT to the postmaster — which exits 0.
  // Forwarding that would have the dev server report success while its
  // database has gone away, which is the one thing this callback exists to
  // stop happening quietly.
  onExit: (code) => process.exit(code || 1),
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
 * Generous, and deliberately so. Giving up gains nothing on its own: both
 * endings force-kill the postmaster through the library's `exit` hook, so a
 * short bound does not avoid that outcome, it only reaches it sooner and
 * throws away the starts that would have finished and shut down cleanly. The
 * bound is here for a start that is stuck rather than slow, since trapping a
 * signal suppresses Node's own termination and an unbounded wait would be a
 * script that ignores SIGTERM forever.
 *
 * So it clears the bounded phases with room over: a previous server's
 * shutdown escalation runs to about 42 seconds, the readiness wait polls for
 * about 30 more, and user and database setup follows. Five seconds — which
 * this was — expired inside the readiness wait, which is the longest stretch
 * of a cold run and exactly when a signal is most likely to land.
 *
 * Not a ceiling on a start, though, and it cannot be one. initdb has no bound
 * of its own, and a readiness poll against a port something else is holding
 * open spends its own connect timeout on every attempt rather than failing
 * fast. Both are far outside what a working machine does — initdb measures in
 * under a second, and a healthy start in a few — so this is chosen to sit
 * clear of the normal path rather than to prove anything about the worst one.
 *
 * Two things make the length safe to choose freely. A second signal gives up
 * at once, which is the interactive escape hatch, and a supervisor with a
 * shorter grace period simply kills the script itself, which is the same
 * ending this would have produced by exiting early.
 */
const START_WAIT_MS = 90_000;

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
