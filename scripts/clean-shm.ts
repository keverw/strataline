/**
 * Recovery script: remove leaked SysV shared-memory segments left behind by
 * embedded-postgres instances that were terminated without a clean shutdown
 * (e.g. an interrupted `bun test`, a crash, or a `kill -9`).
 *
 * macOS has a very low default SHMMNI (max number of shared-memory segments,
 * ~32), so a handful of leaked segments is enough to break the embedded test
 * database with:
 *   FATAL: could not create shared memory segment: No space left on device
 *
 * A clean test run releases its segments in afterAll, so you normally never
 * need this. Run `bun run test:clean-shm` if you've interrupted runs and start
 * seeing the error above.
 *
 * Safety: only removes segments owned by the current user whose CREATOR process
 * is no longer running, so it never touches shared memory in use by a live
 * process (your dev DB, other apps, etc).
 */

import { execSync } from "child_process";
import * as os from "os";

// This is a macOS-only problem in practice: Linux defaults to a very high
// SHMMNI, so it doesn't exhaust, and the `ipcs` column layout differs.
if (os.platform() !== "darwin") {
  console.log("clean-shm: only needed on macOS; nothing to do.");
  process.exit(0);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const user = os.userInfo().username;

let output: string;

try {
  // macOS columns: T ID KEY MODE OWNER GROUP CPID LPID
  output = execSync("ipcs -mp", { encoding: "utf8" });
} catch (err) {
  console.error("clean-shm: failed to list shared memory segments:", err);
  process.exit(1);
}

let removed = 0;
let kept = 0;
let failed = 0;

for (const line of output.split("\n")) {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "m") {
    continue;
  }

  const id = parts[1];
  const owner = parts[4];
  const cpid = parseInt(parts[6], 10);

  if (owner !== user || Number.isNaN(cpid)) {
    continue;
  }

  if (isAlive(cpid)) {
    kept++; // creator still running — leave it alone
    continue;
  }

  try {
    execSync(`ipcrm -m ${id}`);
    removed++;
  } catch {
    failed++;
  }
}

console.log(
  `clean-shm: removed ${removed} leaked segment(s), kept ${kept} (live creator)` +
    (failed > 0 ? `, ${failed} failed to remove` : "") +
    ".",
);
