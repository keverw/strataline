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
});

server.start().catch((error) => {
  console.error(`Fatal error: ${error}`);
  process.exit(1);
});
