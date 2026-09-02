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
let stopping: Promise<void> | null = null;

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    // Repeat signals join the shutdown already running rather than starting a
    // second one, and Ctrl+C twice must not exit part-way through the first.
    stopping ??= server
      .shutdown(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`Shutdown failed: ${error}`);
        process.exit(1);
      });
  });
}

server.start().catch((error) => {
  console.error(`Fatal error: ${error}`);
  process.exit(1);
});
