# Strataline v4.0.3

[![npm version](https://badge.fury.io/js/strataline.svg)](https://badge.fury.io/js/strataline)

**Strataline** is a structured migration system for PostgreSQL that treats database changes as layered, resumable operations, built to scale from small projects to distributed, orchestrated systems.

The name **Strataline** comes from:

- **Strata**: representing the _layers_ of a database migration, including schema changes, data backfills, and cleanup steps
- **Line**: reflecting the _path or flow_ each migration takes, whether inline or across distributed systems

Unlike traditional tools that rely on rigid `up/down` scripts, Strataline offers a modern framework approach:

- Define safe, phase-based migrations (`beforeSchema`, `migration`, `afterSchema`)
- Use **job mode** for simple, single-node projects, or scale out with **distributed mode** when needed
- Integrate directly into your app or scripts, using full TypeScript power and rich logging
- Test easily with built-in helpers, and spin up either temporary **test instances** or a persistent **local Postgres dev server** with no Docker required

Whether you're building a side project or orchestrating millions of rows in production, Strataline adapts to your needs, not the other way around.

## Table of Contents

<!-- toc -->

- [Table of Contents](#table-of-contents)
- [Key Features](#key-features)
- [Installation](#installation)
- [Basic Usage](#basic-usage)
  - [Job Mode (Single Machine)](#job-mode-single-machine)
  - [Distributed Mode (Orchestrated)](#distributed-mode-orchestrated)
- [Running Migrations](#running-migrations)
  - [Using the Built-In CLI Helper](#using-the-built-in-cli-helper)
    - [Basic Setup](#basic-setup)
    - [Configuration Options](#configuration-options)
    - [Environment Variables](#environment-variables)
    - [Available Commands](#available-commands)
    - [Exit Codes](#exit-codes)
    - [Graceful Shutdown](#graceful-shutdown)
    - [Pool Management](#pool-management)
    - [package.json Scripts](#packagejson-scripts)
    - [Node.js vs. Bun](#nodejs-vs-bun)
  - [Creating a Custom Migration Script](#creating-a-custom-migration-script)
- [Architecture](#architecture)
  - [Job Mode](#job-mode)
  - [Distributed Mode](#distributed-mode)
- [Migration Results](#migration-results)
  - [Error Handling](#error-handling)
  - [Exported Types](#exported-types)
- [Backpressure Handling](#backpressure-handling)
- [Graceful Shutdown & Cancellation](#graceful-shutdown--cancellation)
- [Metadata & Checkpoints](#metadata--checkpoints)
- [Logging & Schema Helpers](#logging--schema-helpers)
  - [Logging](#logging)
    - [Logger Module](#logger-module)
      - [Sources and Filtering](#sources-and-filtering)
      - [Creating Custom Loggers](#creating-custom-loggers)
  - [Schema Helpers](#schema-helpers)
- [Database Tables](#database-tables)
  - [migration_status](#migration_status)
  - [migration_lock](#migration_lock)
    - [Lock Lifecycle and Cleanup](#lock-lifecycle-and-cleanup)
- [Development and Test Database Instances Utilities](#development-and-test-database-instances-utilities)
  - [Note for Bun Users (Using `embedded-postgres`)](#note-for-bun-users-using-embedded-postgres)
  - [Test DB Instance](#test-db-instance)
    - [Features](#features)
    - [Usage](#usage)
    - [Logging](#logging-1)
      - [Migration Logging](#migration-logging)
    - [Example in Tests](#example-in-tests)
  - [Local Dev DB Server](#local-dev-db-server)
    - [Setting Up a Dev Database Script](#setting-up-a-dev-database-script)
    - [Configuration Options](#configuration-options-1)
    - [Logging](#logging-2)
    - [Data Persistence](#data-persistence)
    - [Process Management](#process-management)
    - [How Shutdown Works](#how-shutdown-works)
    - [Who Exits](#who-exits)
    - [Probing for a Running Server](#probing-for-a-running-server)
    - [Using With Your Application](#using-with-your-application)
    - [Git Configuration](#git-configuration)
  - [Locale and Collation](#locale-and-collation)
- [Development](#development)

<!-- tocstop -->

## Key Features

- **Phased Migration Approach**: Each migration is separated into three distinct phases:

  - `beforeSchema`: Transactional DDL changes before data work
  - `migration`: Data transformation logic with support for inline or distributed execution
  - `afterSchema`: Optional final cleanup (e.g., setting NOT NULL, dropping old columns)

> **Transaction Model:** The `beforeSchema` and `afterSchema` phases each run inside their own `BEGIN`/`COMMIT` transaction and receive a dedicated `PoolClient`. If the callback throws, that phase is rolled back automatically. The `migration` (data) phase instead receives the raw `Pool` and is responsible for managing its own transactions. This is intentional because long, batched, or resumable data work should not run inside a single giant transaction. That would hold locks for the whole run, bloat WAL, and throw away all progress on any failure.
>
> Because you own the transactions, **you** choose the unit of atomicity. Often that's a batch of rows, but it can also be a logical entity that spans several tables that must change together. For example, on a social network, you might backfill a user along with their `profiles` and `settings` rows in one transaction so that user is updated all-or-nothing, then commit and move to the next user or batch. Commit as you go so progress is durable and the migration can resume from a checkpoint (see [Metadata & Checkpoints](#metadata--checkpoints)) after an interruption.
>
> The division of labor: the **lock** gives coarse exclusivity, so normally only one run happens at all. **Your transactions** give per-unit atomicity. **Idempotency** covers the fact that an interrupted batch may re-run on the next pass. Strataline can't fence your data writes by the lock because it never sees them, so that idempotency is on you (see the **Resuming After a Failure** note below).
>
> **Resuming After a Failure:** Each of the three phases is tracked independently (`before_schema_applied`, `migration_complete`, `after_schema_applied`). When a migration is re-run, every phase that already completed is skipped and only the unfinished phase(s) run. So if `afterSchema` fails, the next run skips `beforeSchema` and the data migration (both already done) and retries **only** `afterSchema`. A data migration that `defer()`s or errors before completing _will_ run again on the next pass, so **write your data migration to be idempotent**. But once it calls `complete()` **and that completion is persisted**, it is marked done and is never re-run, even if a later `afterSchema` then fails. (For example, if the database write that records completion itself fails right after `complete()`, the run is reported as an error and the data migration runs again on the next pass, which is yet another reason to keep it idempotent.)

- **Flexible Execution Modes**:

  - `job` mode: Migrations run inline on a single machine, ideal for development or small projects
  - `distributed` mode: Your infrastructure orchestrates and routes calls to migration logic, perfect for large-scale systems

- **Backpressure Handling**: The `defer()` function allows migrations to pause work and retry later, enabling staged rollouts and preventing system overload

- **Library-First Design**: Strataline is designed as a flexible library that integrates into your existing infrastructure, not as an opinionated CLI tool

## Installation

```bash
bun install strataline
# or
npm add strataline
# or
yarn add strataline
```

> **Note:** `pg` is a peer dependency, so install it alongside Strataline if it isn't already in your project (`bun add pg` / `npm add pg` / `yarn add pg`). Every example below imports `Pool` from it.

## Basic Usage

### Job Mode (Single Machine)

Job mode runs migrations inline on a single machine, ideal for development or small projects:

```typescript
import { Pool } from "pg";
import { MigrationManager } from "strataline/migration";

// Create a PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create a migration manager
const migrationManager = new MigrationManager(pool);

// Register migrations
migrationManager.register([
  {
    id: "001-add-users-table",
    description: "Create users table and add initial indexes",

    // Schema changes before data migration (runs in a transaction)
    beforeSchema: async (client, helpers) => {
      await helpers.createTable(client, "users", {
        id: "SERIAL PRIMARY KEY",
        email: "VARCHAR(255) NOT NULL",
        name: "VARCHAR(255)",
        created_at: "TIMESTAMP WITH TIME ZONE DEFAULT NOW()",
      });

      await helpers.addIndex(
        client,
        "users",
        "users_email_idx",
        ["email"],
        true,
      );
    },

    // Data migration (runs separately)
    migration: async (pool, ctx) => {
      // Check the migration mode
      if (ctx.mode === "job") {
        // In job mode, we process all data unless a specific payload provides a
        // range. `ctx.payload` is always at least `{}` (never undefined), so read
        // the bounds with default values rather than an `|| { ... }` fallback
        // (which would never trigger, leaving startId/endId undefined).
        const { startId = 0, endId = Number.MAX_SAFE_INTEGER } = ctx.payload;

        ctx.logger.info({
          message: `Processing users from ID ${startId} to ${endId}`,
        });

        // Example: Import users from a legacy system
        const { rows } = await pool.query(
          "SELECT * FROM legacy_users WHERE id BETWEEN $1 AND $2",
          [startId, endId],
        );

        for (const user of rows) {
          await pool.query("INSERT INTO users (email, name) VALUES ($1, $2)", [
            user.email,
            user.name,
          ]);
        }

        ctx.logger.info({
          message: `Successfully processed ${rows.length} users`,
        });

        // Mark migration as complete
        ctx.complete();
      } else if (ctx.mode === "distributed") {
        // In distributed mode, we would route/schedule this as a job across multiple workers
        // and monitor when it has successfully been completed
        // If you don't plan to support this, you could provide an error message like below
        ctx.logger.error({
          message: "This migration is not designed to run in distributed mode",
        });

        ctx.defer("Migration not configured for distributed execution");
      }
    },

    // Schema changes after data migration (runs in a transaction)
    afterSchema: async (client, helpers) => {
      // Add constraints that couldn't be added before data was migrated
      await helpers.addColumn(
        client,
        "users",
        "email_verified",
        "BOOLEAN DEFAULT FALSE",
      );
    },
  },
]);

// Run migrations
async function runMigrations() {
  const result = await migrationManager.runSchemaChanges("job");

  if (result.success) {
    console.log("Migrations completed successfully!");

    if (result.migrationData && Object.keys(result.migrationData).length > 0) {
      console.log("Data returned from migrations:", result.migrationData);
    }
  } else {
    console.error("Migration failed:", result.reason);
  }
}

runMigrations().catch(console.error);
```

### Distributed Mode (Orchestrated)

In distributed mode, your infrastructure acts as a router, scheduler, and monitor. The migration system applies schema changes, then your infrastructure is responsible for dividing the data and scheduling jobs for each batch by calling `runDataMigrationJobOnly` with a payload for each job.

**How It Works:**

- **When `distributed` Mode Is Active** (you called `runSchemaChanges('distributed')`):

  1. The migration function _only_ orchestrates.
     - Discover the total work to do (row ranges, IDs, etc.).
     - Split that work into payload-sized batches.
     - Schedule each batch as its own `job` by invoking your queue / worker system (which will in turn call `runDataMigrationJobOnly`).
  2. Call `ctx.defer('batches scheduled')` so Strataline pauses, letting your jobs run in parallel.
  3. Once all jobs report success, rerun the `runSchemaChanges` migration function (still in distributed mode) and call `ctx.complete()` to let `afterSchema` and subsequent migrations proceed, officially marking the migration as being complete. The second run will find beforeSchema done, skip it, and jump straight to the data migration function.

- **When `job` Mode Is Active** (local run **or** a worker processing a batch):

  - **No Payload Provided** → you're on a single machine (dev/CI), so process the _entire_ dataset, then `ctx.complete()`.
  - **Payload Provided** → you're a worker handling a single batch that the distributed orchestrator created. Process just that slice and call `ctx.complete(data)` (or `ctx.defer(reason, data)` to retry later).

Example:

```typescript
migration: async (pool, ctx) => {
  if (ctx.mode === "distributed") {
    // Orchestrate: discover data, split into batches, schedule jobs (each as a 'job'), monitor, etc.
    const { rows } = await pool.query(
      "SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM legacy_users",
    );

    const minId = rows[0].min_id;
    const maxId = rows[0].max_id;
    const batchSize = 1000;
    const batches = [];

    for (let start = minId; start <= maxId; start += batchSize) {
      batches.push({
        startId: start,
        endId: Math.min(start + batchSize - 1, maxId),
      });
    }

    // Schedule jobs for each batch if not already (pseudo-code, replace with your job system)
    for (const batch of batches) {
      await scheduleJob("001-add-users-table", batch); // e.g., enqueue or trigger a 'job'
    }

    ctx.logger.info({ message: `Scheduled ${batches.length} batch jobs` });

    // Monitor jobs and ensure successful completion (pseudo-code, replace with your own job monitoring logic)
    const allJobsDone = await checkAllJobsComplete(
      "001-add-users-table",
      batches,
    );

    if (!allJobsDone) {
      ctx.defer("Waiting for all jobs to finish");
    } else {
      ctx.complete(); // All jobs finished, allow afterSchema and next migrations
    }
  } else if (ctx.mode === "job") {
    // Heads up: `ctx.mode === "job"` is true in BOTH a single-machine
    // runSchemaChanges("job") run (the orchestrator — here complete() IS
    // authoritative and marks the migration done) AND inside a worker via
    // runDataMigrationJobOnly (where complete() only reports success to your
    // job system and marks nothing). ctx.mode can't tell them apart — the call
    // path does. See "The Orchestrator Owns Migration State. Workers Don't."
    //
    // Do the actual work for this batch (or all data if no payload).
    // `ctx.payload` is always at least `{}`, so default the bounds here.
    const { startId = 0, endId = Number.MAX_SAFE_INTEGER } = ctx.payload;

    ctx.logger.info({
      message: `Processing users from ID ${startId} to ${endId}`,
    });

    // ... process all or the specified range ...
    // Example: return number of processed items
    const processedCount = 150; // Replace with actual count
    ctx.complete({ processed: processedCount });
  }
};
```

> **Important:**
>
> - In `distributed` mode, the migration function is for orchestration only: it discovers data, splits into batches, schedules jobs (each as a `job`), and monitors job completion. It never processes data directly.
> - After scheduling jobs in distributed mode, check if all jobs are complete. If not, call `ctx.defer()` to pause and indicate to retry later. Only call `ctx.complete()` when all jobs are finished, which allows afterSchema and subsequent migrations to proceed.
> - All actual data processing happens in `job` mode, which can process all data or just a batch (if a payload is provided).
> - The migration function should always check `ctx.mode` and process accordingly:
>   - In `distributed` mode, orchestrate the work and use `ctx.defer('reason', data?)` to pause, retry, or indicate that jobs were scheduled for background work, potentially passing back relevant data.
>   - In `job` mode, process all data at once, or a specific range if a payload is provided. You can also use `ctx.defer(reason, data?)` to implement staged rollouts or pause for backpressure.
> - If you call `ctx.defer(reason, data?)`, the migration will be paused. `afterSchema` and any subsequent migrations will not run until you rerun the job and it calls `ctx.complete()`. This enables staged rollouts, retries, or background processing. The optional `data` is returned to the **immediate caller**. From a **worker** it comes back in `DataMigrationJobResult.data` (you forward/aggregate it however you like). On the **orchestrator** pass a `defer(reason, data)` halts the run, so that `data` is **not** surfaced in `MigrationResult.migrationData` (only data from migrations that `complete()`d earlier in the same run appears there). Instead the orchestrator persists the deferred `data` to the [metadata column](#metadata--checkpoints), where you read it back via `ctx.metadata` on the next run. A worker cannot persist metadata, as described below.
> - Strataline is backend-agnostic: you can use any job scheduler, queue system, thread pool, or orchestration framework to schedule and monitor jobs as needed.
>
> **The Orchestrator Owns Migration State. Workers Don't.** `runDataMigrationJobOnly` is a thin wrapper that runs your migration function for one batch (pass the batch via `payload`) and **returns the result to you**. It writes **nothing** to `migration_status`, including `migration_complete`, `metadata`, `attempts`, `last_error`, or anything else, and it **never touches the migration lock**. There is no acquire, renew, or release because your job system controls worker concurrency. So when a worker calls `ctx.complete()`, that just tells _your_ job system its batch succeeded. It does **not** mark the whole migration done. Only the orchestrator pass (`runSchemaChanges`) writes migration state. It marks `migration_complete` and persists `metadata` once _it_ confirms all jobs finished. This is deliberate: it prevents the footgun where one finished batch would prematurely flip the whole migration complete and let `afterSchema` run early. (A worker can still _read_ `ctx.metadata` as read-only data, but for a worker the `payload` you pass in is usually the better way to hand it its slice/checkpoint, since you control it directly per call.)

## Running Migrations

Strataline provides flexible options for running database migrations. Since it's designed as a library rather than a CLI tool, you have complete control over how migrations are executed. You can either use our convenient built-in CLI helper to get started quickly or create a custom migration script for more advanced scenarios.

### Using the Built-In CLI Helper

For quick development or simpler use cases, Strataline provides a convenient CLI helper function called `RunStratalineCLI`. This function handles command parsing and execution for you with minimal setup.

#### Basic Setup

Create a script file to run your migrations:

```typescript
// scripts/db-migrate.ts

// Load environment variables - this is only needed if you are using Node.js, Bun does not need it
// import 'dotenv/config'

import { RunStratalineCLI } from "strataline/cli";
import { createConsoleLogger } from "strataline/logger";
import { migrations } from "../path/to/your/migrations";

// Use the built-in console logger. It shows everything by default; name a
// source to quiet its routine output. `{ migration: false }` drops only the
// per-migration `[MIGRATION]` info lines. Migration errors and warnings, and
// the CLI's own info, always print, so quieting a source never hides a
// problem. You can customize this or implement your own logger if needed.
const logger = createConsoleLogger();

// Run the CLI with environment variables.
// RunStratalineCLI resolves with a result whose `exitCode` distinguishes the
// outcome (0 completed · 2 deferred · 3 locked · 4 aborted · 5 lock_lost); a
// genuine error is thrown, so the `.catch` maps that to exit 1.
RunStratalineCLI({
  migrations,
  loadFrom: "env", // Use environment variables for database connection
  logger,
})
  .then((result) => {
    process.exit(result.exitCode);
  })
  .catch((error) => {
    console.error(`Failed to run CLI: ${error.message}`);
    process.exit(1);
  });
```

#### Configuration Options

The `RunStratalineCLI` function accepts several configuration options:

- **migrations**: An array of your migration objects
- **loadFrom**: How to load the database connection
  - `"env"`: Use environment variables (requires PostgreSQL environment variables)
  - `"pool"`: Use a provided PostgreSQL pool
- **envPrefix** (optional): Prefix for environment variables (e.g., `"APP_"` would look for `APP_POSTGRES_USER`, `"API_"` would look for `API_POSTGRES_USER`)
- **pool** (optional): A PostgreSQL pool instance (required when loadFrom is "pool")
- **logger**: A function to handle logging
- **signal** (optional): An `AbortSignal` for graceful shutdown. The library never traps OS signals itself, so wire this to your own SIGTERM/SIGINT handling. When it aborts, an in-flight `run` stops at the next safe point and resolves with `status: "aborted"` (exit code `4`). See [Graceful Shutdown](#graceful-shutdown).
- **argv** (optional): An array to use instead of `process.argv` for command parsing (the command is read from index 2, and `--distributed` is detected anywhere in the array). Useful for tests or when embedding the CLI.
- **env** (optional): An environment object to use instead of `process.env` when `loadFrom: "env"`. Useful for tests or when embedding the CLI.

**Validation Errors (Thrown):** The option combinations are mutually exclusive and validated up front:

- providing `pool` together with `loadFrom: "env"` throws (`Cannot provide both pool and loadFrom='env'`),
- `loadFrom: "pool"` without a `pool` throws (`Must provide pool when loadFrom='pool'`),
- providing `envPrefix` together with `loadFrom: "pool"` throws (`Cannot provide envPrefix when loadFrom='pool'`).

Missing required env vars and an invalid `POSTGRES_PORT` (or invalid optional numeric vars) also throw, so wrap the call in a `.catch` (which maps to exit code `1`).

#### Environment Variables

When using `loadFrom: "env"`, the following environment variables are required:

- `POSTGRES_USER`: Database username
- `POSTGRES_HOST`: Database host
- `POSTGRES_DATABASE`: Database name
- `POSTGRES_PASSWORD`: Database password
- `POSTGRES_PORT`: Database port

Optional environment variables for pool configuration:

- `POSTGRES_MAX_CONNECTIONS`: Maximum number of connections in the pool (default: 20)
- `POSTGRES_IDLE_TIMEOUT`: Idle timeout in milliseconds (default: 30000)
- `POSTGRES_CONNECTION_TIMEOUT`: Connection timeout in milliseconds (default: 2000)

A ready-to-copy [`.env.example`](.env.example) is included. To get started:

```bash
cp .env.example .env
# then edit .env with your database credentials
```

Bun loads `.env` automatically. On Node.js, add `import 'dotenv/config'` to your entrypoint (see [`scripts/db-migrate.ts`](scripts/db-migrate.ts)). If you pass an `envPrefix` (e.g. `"API_"`), prefix every variable accordingly (`API_POSTGRES_USER`, ...).

#### Available Commands

The CLI supports the following commands:

- `run`: Run pending migrations
  - Option: `--distributed` to run in distributed mode
- `status`: Show migration status
- `help`: Display help information (default if no command is provided)

> **Note:** Any unrecognized command falls through to `help` (printed, exit code `0`). An unknown command is not treated as an error, and the returned `result.command` is normalized to `"help"` (not the raw unknown string), matching the `run | status | help` set the type documents. The `--distributed` flag and the `signal` option only affect `run`, and they are ignored by `status` and `help`.

> **Note:** Every command, including `help`, first resolves the database configuration and tests the connection before it runs. With `loadFrom: "env"` that means missing/invalid env vars throw, and an unreachable database aborts, _before_ any command output. So even `help` requires a working connection in env mode. If you just want the help text without a database, print it yourself rather than relying on the CLI.

#### Exit Codes

`RunStratalineCLI` resolves with a `StratalineCLIResult` that includes a suggested `exitCode`, so a wrapper script can distinguish outcomes. A genuine **error is thrown** (not returned), so callers that only `.catch()` still exit non-zero.

| Outcome | `exitCode` | Behavior |
| --- | --- | --- |
| `completed` | `0` | Returned |
| `error` | `1` | **Thrown** (caller's `.catch` maps to 1) |
| `deferred` | `2` | Returned because a migration paused itself |
| `locked` | `3` | Returned because another process holds the lock |
| `aborted` | `4` | Returned because graceful shutdown was requested |
| `lock_lost` | `5` | Returned because the lock was lost mid-run (unsafe) |

Note `locked` (code `3`) and `lock_lost` (code `5`) are deliberately distinct: `locked` means another process already holds the lock so this run did nothing (benign), whereas `lock_lost` means this run held the lock and lost it partway through, a possible concurrent-run condition worth investigating.

```typescript
RunStratalineCLI({ migrations, loadFrom: "env", logger })
  .then((result) => process.exit(result.exitCode))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
```

The codes are also exported as `STRATALINE_EXIT_CODES`.

The full result shape (exported as `StratalineCLIResult`) is:

```typescript
interface StratalineCLIResult {
  command: string; // The command that ran: "run", "status", or "help".
  status?: MigrationResult["status"]; // Only populated for "run". Undefined for "status"/"help".
  exitCode: number; // Suggested process exit code for this outcome.
  reason?: string; // Only populated for "run", when it did not simply complete.
}
```

> **`status` and `reason` are populated only for the `run` command.** The `status`/`help` commands resolve with just `{ command, exitCode: 0 }`, so `result.status` and `result.reason` are `undefined` for them. Branch on `result.command` (or check for `undefined`) before reading `status`.

The `logger` you pass to `RunStratalineCLI`, and what `createConsoleLogger` returns, is the `Logger` interface exported from `strataline/logger`. The CLI's own lines carry no `source`, and the migration system's carry `source: "migration"`.

#### Graceful Shutdown

The CLI does **not** trap OS signals itself (so it won't interfere with however your app handles them). Instead, pass an `AbortSignal` and wire it to your own handler. The CLI forwards it down to the migration run:

```typescript
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());

const result = await RunStratalineCLI({
  migrations,
  loadFrom: "env",
  logger,
  signal: controller.signal,
});
```

When the signal aborts, an in-flight `run` stops at the next safe point and resolves with `status: "aborted"` (exit code `4`). See [Graceful Shutdown & Cancellation](#graceful-shutdown--cancellation) for how migrations observe the signal via `ctx.signal`.

#### Pool Management

**Note**: The CLI automatically manages the PostgreSQL pool lifecycle. It will create a pool if using environment variables or use your provided pool, and will properly end the pool when the operation completes. You do not need to end the pool yourself after calling `RunStratalineCLI`.

> **Heads up, it ends a pool you passed too.** When `loadFrom: "pool"`, `RunStratalineCLI` calls `pool.end()` in a `finally` block on the **pool you supplied**, not just on pools it created. The pool is dead after the call resolves, so don't plan to reuse it afterward. Create a dedicated pool for the CLI, or let it create one via `loadFrom: "env"`.
>
> The one exception is a **synchronous configuration error**, e.g. passing `envPrefix` together with `loadFrom: "pool"`, which throws `Cannot provide envPrefix when loadFrom='pool'`. These checks run _before_ the CLI adopts your pool, so on such a throw the pool is **left open** (it was never touched, and you still own the reference). That's deliberate: you can fix the config and retry with the same pool. Once the CLI gets past validation, the `finally` owns it and will end it.

#### package.json Scripts

Add these scripts to your package.json for convenient access:

```json
{
  "scripts": {
    "db:migrate": "bun run scripts/db-migrate.ts run",
    "db:migrate:distributed": "bun run scripts/db-migrate.ts run --distributed",
    "db:status": "bun run scripts/db-migrate.ts status"
  }
}
```

#### Node.js vs. Bun

The example above works with both Node.js and Bun, with one difference:

- **Bun**: Environment variables are automatically loaded from .env files
- **Node.js**: You need to add `import 'dotenv/config'` to load environment variables from .env files

### Creating a Custom Migration Script

For more control over the migration process, you can create your own custom migration script. This approach gives you complete flexibility in how migrations are executed, logged, and managed.

The recommended structure is one migration per file, a single `index.ts` that re-exports them as an ordered array, and a runner script that imports that array and drives the run. Here's the runner:

```typescript
// migrate.ts
import { Pool } from "pg";
import { MigrationManager } from "strataline/migration";

// Import the ordered migrations array (defined in ./migrations/index.ts, shown below)
import { migrations } from "./migrations";

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const mode = args.includes("--distributed") ? "distributed" : "job";
  const verbose = args.includes("--verbose");

  // Create database connection
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  // Set up migration manager
  const migrationManager = new MigrationManager(pool);

  try {
    // Register the migrations (they run in array order)
    migrationManager.register(migrations);

    // Run migrations
    console.log(`Running migrations in ${mode} mode...`);
    const result = await migrationManager.runSchemaChanges(mode);

    if (result.success) {
      console.log("✅ Migrations completed successfully!");

      // Always show migrations applied in this run (even if none)
      console.log(
        `Applied during this run: ${result.completedMigrations.join(", ") || "none"}`,
      );

      // Always show migrations that were already applied in previous runs (even if none).
      // previouslyAppliedMigrations is always present (never undefined), so no `?.` is needed.
      console.log(
        `Previously applied: ${result.previouslyAppliedMigrations.join(", ") || "none"}`,
      );

      // Always show pending migrations (even if none)
      console.log(
        `Pending migrations: ${result.pendingMigrations.join(", ") || "none"}`,
      );

      if (
        verbose &&
        result.migrationData &&
        Object.keys(result.migrationData).length > 0
      ) {
        console.log(
          "Migration data:",
          JSON.stringify(result.migrationData, null, 2),
        );
      }
    } else {
      // `success` is false for several distinct outcomes, and NOT all of them
      // are failures. `locked` (another process holds the lock), `deferred` (a
      // migration paused itself), and `aborted` (graceful shutdown) are benign;
      // only `error` and `lock_lost` are real problems. Branch on `result.status`
      // rather than treating every `!success` as an error so you don't exit 1 on
      // a benign skip. (This is exactly what the built-in CLI does — see the
      // Exit Codes table; reuse `STRATALINE_EXIT_CODES` if you want the same map.)
      switch (result.status) {
        case "deferred":
          console.log(`⏸ Migration run paused (deferred): ${result.reason}`);
          break;
        case "locked":
          console.log(
            `⏭ Skipped — another process is running: ${result.reason}`,
          );
          break;
        case "aborted":
          console.log(`⏹ Migration run aborted: ${result.reason}`);
          break;
        case "lock_lost":
          console.error(`✗ Migration lock lost mid-run: ${result.reason}`);
          break;
        default:
          console.error(`❌ Migration failed: ${result.reason}`);
          break;
      }

      console.log(
        `Completed migrations in this run: ${result.completedMigrations.join(", ") || "none"}`,
      );

      if (result.previouslyAppliedMigrations.length > 0) {
        console.log(
          `Previously applied migrations: ${result.previouslyAppliedMigrations.join(", ")}`,
        );
      }

      console.log(
        `Pending migrations: ${result.pendingMigrations.join(", ") || "none"}`,
      );

      if (result.lastAttemptedMigration) {
        console.log(
          `Last attempted migration: ${result.lastAttemptedMigration}`,
        );
      }

      // Only `error` and `lock_lost` are non-zero failures here; benign
      // outcomes exit 0. Map to whatever exit codes suit your tooling.
      const failed = result.status === "error" || result.status === "lock_lost";
      process.exit(failed ? 1 : 0);
    }
  } catch (error) {
    console.error("Error running migrations:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
```

> **`success: false` is not always a failure.** `runSchemaChanges` returns `success: false` for `locked`, `deferred`, and `aborted` too, all benign outcomes, alongside the genuine `error` and `lock_lost`. Branch on `result.status` (as above) when you need to tell them apart. The [built-in CLI](#using-the-built-in-cli-helper) already does this and maps each status to a distinct [exit code](#exit-codes), so prefer it if you don't want to hand-roll the distinction.

The `migrations` array imported above comes from one migration per file, each a typed `Migration`, collected by a single index file.

Define each migration in its own file, typed with `Migration` so the object's shape is checked as you write it:

```typescript
// migrations/001-add-users-table.ts
import type { Migration } from "strataline/migration";

export const migration001: Migration = {
  id: "001-add-users-table",
  description: "Create users table",
  beforeSchema: async (client, helpers) => {
    await helpers.createTable(client, "users", {
      id: "SERIAL PRIMARY KEY",
      email: "VARCHAR(255) NOT NULL",
    });
  },
  // migration / afterSchema as needed...
};
```

Then aggregate them in an index file, **typing the array as `Migration[]`**. This validates every migration at the point you collect them and gives `register()` a fully typed array:

```typescript
// migrations/index.ts
import type { Migration } from "strataline/migration";
import { migration001 } from "./001-add-users-table";
import { migration002 } from "./002-add-posts-table";
// ... import additional migrations

// Export migrations in the order they should run
export const migrations: Migration[] = [
  migration001,
  migration002,
  // ... add additional migrations in order
];
```

> **`register()` replaces, and rejects duplicates.** Each call to `register()` _replaces_ any previously registered list (it does not append), and it throws if two migrations share the same `id`, so accidental duplicates fail fast at registration rather than silently running twice.

You can then add scripts to your `package.json`:

```json
{
  "scripts": {
    "migrate": "bun run migrate.ts",
    "migrate:distributed": "bun run migrate.ts --distributed"
  }
}
```

This allows you to run migrations using:

```bash
# Run migrations in job mode
npm run migrate

# Run migrations in distributed mode
npm run migrate:distributed

# Run with verbose output
npm run migrate -- --verbose
```

You can also use `ts-node` instead of Bun if you prefer: just replace `bun run` with `ts-node` in your package.json scripts.

This approach ensures your migrations run in the exact order you specify, rather than relying on filesystem ordering.

## Architecture

Strataline is designed with flexibility in mind, allowing you to choose the execution model that best fits your needs:

### Job Mode

In `job` mode, migrations run inline on a single machine. This is useful for:

- Development environments
- Small projects with manageable data volumes
- CI/CD pipelines where migrations run before deployment

The job mode runs all migrations in sequence on a single machine, with each migration handling all of its data processing in one go.

### Distributed Mode

In `distributed` mode, your infrastructure acts as a router/scheduler/monitor, while the actual work is done by calling `runDataMigrationJobOnly` as jobs. This is ideal for:

- Large-scale production systems
- Migrations that process millions of records
- Systems where you need fine-grained control over resource usage
- Environments where you want to limit the blast radius of migrations

The distributed mode works like this:

1. You run `runSchemaChanges('distributed')` to apply schema changes. This is the **orchestrator** pass. Its result's `migrationData` holds the data from any migrations that **finished** via `ctx.complete(data)` during this run. A migration that calls `ctx.defer(reason, data)` instead **stops the run**, so its `data` is **not** in `migrationData`. Because this is the orchestrator pass, that `data` is saved to the [metadata column](#metadata--checkpoints) (read it back via `ctx.metadata` on the next run). (Standalone `runDataMigrationJobOnly` workers are different: they never persist metadata. They return their `data` in `DataMigrationJobResult.data`. See the [orchestrator/worker note](#distributed-mode-orchestrated) above.)
2. Your infrastructure determines how to split the data (e.g., by user ID ranges).
3. For each batch, you call `runDataMigrationJobOnly(migrationId, payload)`. This function executes the `migration` part of your defined migration for that specific `migrationId` and `payload`.
   - If the migration calls `ctx.complete(data)` or `ctx.defer(reason, data)`, the `data` provided there will be returned in the `data` field of the `DataMigrationJobResult`.
   - The overall result will be an object like `{ status: 'success', reason?: string, data?: TReturn }`.
4. Each batch runs as a separate job, processing just its portion of the data. The `data` returned in the `DataMigrationJobResult` can be used for logging, monitoring, or further orchestration.
5. Your infrastructure handles scheduling, retries, and monitoring based on the `status`, `reason`, and `data` from `runDataMigrationJobOnly`.

> **`runDataMigrationJobOnly` status values:** the returned `status` is one of:
>
> - `success`: the data function ran and called `ctx.complete()` (or the migration has no `migration` function, so there was nothing to run). Note a worker never marks `migration_complete`. Only the orchestrator pass does.
> - `deferred`: the data function called `ctx.defer()` (retry this batch later).
> - `error`: the data function threw or finished without calling `complete()`/`defer()`.
> - `already_complete`: the data phase was already marked complete, so there is nothing to do.
> - `not_found`: no migration is registered with that ID.
> - `invalid_state`: the migration isn't ready for a data-only run (e.g. `beforeSchema` hasn't been applied yet, or `afterSchema` is applied while the data phase isn't complete).
>
> Only `success`/`deferred`/`error` can carry `data`.

This approach allows you to:

- Process data in parallel across multiple machines
- Limit the impact of any single migration job
- Implement sophisticated retry and monitoring logic
- Handle backpressure and staged rollouts

> **`mode` is just a hint. Distribution is opt-in.** `runSchemaChanges` always runs the data migration inline. `"distributed"` only changes anything if _your function_ branches on `ctx.mode` to schedule jobs and `defer()`. A migration that ignores `ctx.mode` (just processes data and `complete()`s) run in distributed mode simply does all the work **inline, identical to a single job**. It degrades gracefully, no error. So you can adopt distributed mode per-migration, as you need it.

## Migration Results

The `runSchemaChanges()` method returns a `MigrationResult` object that provides detailed information about the migration run:

```typescript
interface MigrationResult {
  success: boolean; // Whether all migrations completed successfully
  // "locked"    = couldn't acquire the lock; another process holds it (benign).
  // "lock_lost" = held the lock but lost it mid-run (unsafe; run was aborted).
  // "aborted"   = stopped early via a caller-supplied AbortSignal (graceful).
  status:
    | "completed"
    | "locked"
    | "lock_lost"
    | "error"
    | "deferred"
    | "aborted";
  reason?: string; // User-friendly error/deferral message
  completedMigrations: string[]; // IDs of migrations completed in this run
  previouslyAppliedMigrations: string[]; // IDs *fully* applied in previous runs (every phase done). A migration that only partially applied before (e.g. a phase failed/was interrupted) is NOT counted here — it appears in pendingMigrations instead, so the two lists never overlap.
  pendingMigrations: string[]; // IDs of migrations still pending (including partially-applied ones resuming)
  lastAttemptedMigration?: string; // ID of the last migration attempted
  error?: Error; // Raw error object for debugging (unhandled exceptions only)
  migrationData: Record<string, unknown>; // Data returned by successful migrations. Always present — an empty object when no migration returned data.
}
```

### Error Handling

Strataline provides two levels of error information:

- **`reason`**: Always a formatted string message suitable for display in logs/CLI output
- **`error`**: Raw Error object with stack trace, only present for unhandled exceptions (not for controlled migration phase errors)

The built-in CLI shows both the `reason` (always) and `error` details with stack trace (when available) to help with debugging.

### Exported Types

Alongside `MigrationResult`, `MigrationStatus`, `DataMigrationJobResult`, and `DataMigrationJobStatus`, a few smaller types are exported from `strataline/migration` for when you want to annotate things explicitly (e.g. a wrapper function or a variable that holds the mode):

- **`MigrationMode`** (`"job" | "distributed"`): the value you pass to `runSchemaChanges`/`runDataMigrationJobOnly` and read back as `ctx.mode`.
- **`MigrationCompletionCallback<TReturn>` / `MigrationDeferCallback<TReturn>`**: the types of `ctx.complete` and `ctx.defer`. Usually inferred for you when you write the inline `migration` callback, and exported for the rare case you annotate them by hand.

> **`Migration` is generic: `Migration<TPayload, TReturn>`.** The examples use the bare `Migration` (which defaults to `Migration<Record<string, unknown>, unknown>`), but you can parameterize it to type the two values that flow through a single migration: `TPayload` types `ctx.payload` (the per-batch input you pass to `runDataMigrationJobOnly`), and `TReturn` types the `data` argument to `ctx.complete(data)` / `ctx.defer(reason, data)` (and `ctx.updateMetadata`). For example, `Migration<{ startId: number; endId: number }, { processed: number }>` gives you a fully typed `ctx.payload` and a checked `ctx.complete({ processed })`. `register<TPayload, TReturn>()` and `runDataMigrationJobOnly<TPayload, TReturn>()` carry the same parameters.

The logger the `MigrationManager` constructor accepts is the [`Logger`](#logger-module) interface. If `Logger` collides with a type already in your codebase, alias it on import: `import type { Logger as StratalineLogger } from "strataline/logger"`.

## Backpressure Handling

Inside a migration you can call `ctx.defer(reason?: string, data?: TReturn)` to pause work and retry later. This is useful for:

- Handling backpressure when the system is under load
- Implementing staged rollouts of data changes
- Pausing when rate limits are reached
- Recovering from temporary failures
- Spawning background tasks in distributed mode and exiting to check status later, potentially returning data like a task ID or checkpoint.

When a migration calls `defer(reason, data?)`, the current execution stops and should be retried later by your orchestration system. The `data` returned by `defer` (if provided) will be available in the `DataMigrationJobResult` when using `runDataMigrationJobOnly`. This is particularly powerful in distributed mode, where you might:

1. **Spawn Background Tasks**: Start a long-running process and defer the migration to check its status later
2. **Implement Circuit Breakers**: Detect system load and defer processing during peak times
3. **Create Staged Rollouts**: Process data in waves, deferring between each wave to monitor system health
4. **Handle External Dependencies**: Defer when dependent systems are unavailable or rate-limited

The `defer()` function accepts an optional `reason` parameter and an optional `data` parameter. The `reason` provides context for why the migration was paused, useful for monitoring and debugging. The `data` allows for returning structured information to the calling orchestrator.

> **Call exactly one, exactly once.** A data migration must call **either** `ctx.complete()` **or** `ctx.defer()` per run, not both, and not the same one twice. A second call (or calling both) throws `complete() or defer() already called`. Finishing the function _without_ calling either is also an error (`Migration function finished without calling complete() or defer()`), so always end on one of them. See [Graceful Shutdown & Cancellation](#graceful-shutdown--cancellation).

## Graceful Shutdown & Cancellation

Strataline supports cooperative cancellation so a long-running migration can wind down cleanly when your process is asked to stop (e.g. a Kubernetes rolling deploy sends `SIGTERM`). **The library never installs OS signal handlers itself**, so you own your signals and pass in an `AbortSignal`. This works the same whether you drive `MigrationManager` directly or go through the CLI wrapper.

**Using `MigrationManager` directly**: pass a `signal` to `runSchemaChanges`, and have your data migration observe `ctx.signal`:

```typescript
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());

const manager = new MigrationManager(pool);
manager.register([
  {
    id: "001-backfill",
    description: "Backfill in batches, stopping on shutdown",
    migration: async (pool, ctx) => {
      for (const batch of batches) {
        // Cooperatively stop at a safe point when shutdown is requested.
        if (ctx.signal.aborted) {
          ctx.defer("shutdown requested — will resume on next run");
          return;
        }
        await processBatch(pool, batch);
      }
      ctx.complete();
    },
  },
]);

const result = await manager.runSchemaChanges("job", {
  signal: controller.signal,
});
// result.status === "aborted" if the run was stopped via the signal
```

Key points:

- **`ctx.signal` is always present.** If you don't pass a signal, it's an `AbortSignal` that never aborts, so `ctx.signal.aborted` is safe to check unconditionally.
- **Cancellation is cooperative.** Strataline can't forcibly kill your in-flight code. Your migration must check `ctx.signal.aborted` (or listen for its `"abort"` event) and stop gracefully. **When you see the abort, stop at a safe point and call `ctx.defer("reason")`** (or `ctx.complete()` if the work genuinely finished). Do **not** just `return` without calling one of them: a data migration that finishes without calling `complete()` or `defer()` is treated as an error. Because migrations are resumable, after a `defer()` the next run picks up where it left off. (The overall run result is still `"aborted"` regardless, but `defer()` keeps the migration's recorded state clean.)
- **Between migrations**, the run also stops at the next migration boundary when the signal is aborted, returning `status: "aborted"`.
- **No run status is persisted.** It is just feedback in the returned result. `migration_status` has no "status" column, only per-phase progress flags (plus `last_error`/`metadata`). So whether a run ends `"deferred"` or `"aborted"`, the affected migration identically stays **pending** (phase flags incomplete) and resumes on the next run. (When a migration `defer()`s, the reason/data you passed _do_ get persisted to `last_error`/`metadata`, but that's because you passed them, separate from the run's status.)
- **Workers are canceled the same way**, with one return-value asymmetry: `runDataMigrationJobOnly(id, payload, { signal })` exposes `ctx.signal`, but `"aborted"` is only ever a `runSchemaChanges` result. A canceled worker should `ctx.defer()`, so its `DataMigrationJobResult` comes back as `"deferred"` (retry this batch later), never `"aborted"`. Lock loss doesn't apply to workers either because `runDataMigrationJobOnly` never acquires the lock or runs the renewal timer. Only `runSchemaChanges` does.

**Lock loss is treated as a safety abort.** While a run is in progress the lock is renewed on a timer (see [Lock Lifecycle and Cleanup](#lock-lifecycle-and-cleanup)). If a renewal discovers the lock is no longer ours because another process took it over after it expired, Strataline **auto-aborts** the in-flight run rather than continuing without exclusivity. Concretely, it trips the same abort path used for shutdown (so `ctx.signal` fires and your data migration can wind down), then `runSchemaChanges` returns `status: "lock_lost"` with a `[lock]` reason. This is a dedicated status, distinct from both `"aborted"` (a graceful shutdown) and `"locked"` (couldn't acquire in the first place), and through the CLI it exits with code `5`, because running without a valid lock is an unsafe condition worth investigating.

From your data migration's point of view there's nothing new to handle: lock loss fires the **same `ctx.signal`** as a shutdown, so respond the same way. Stop at a safe point, call **`ctx.defer("reason")`**, and return. On lock loss _specifically_ it barely matters what you call: Strataline already blocks `afterSchema`, **fences** your `ctx.complete()`/`ctx.updateMetadata()` writes (they no-op / return `false`, see [Lock Lifecycle and Cleanup](#lock-lifecycle-and-cleanup)), and reports `lock_lost` regardless, so the migration stays **pending** for the new owner no matter what you do. The reason to reach for `defer()` is really the _shutdown_ case, where you **do** still hold the lock and a stray `ctx.complete()` would wrongly mark not-yet-finished work as done. Treating the signal uniformly as "stop and `defer()`" is correct in both cases, so you never have to tell them apart. It's also the polite, clean way to exit the function, since a data migration that returns without calling `complete()` or `defer()` is treated as an error.

Loss is detected three ways, all converging on the same `lock_lost` abort:

1. **Confirmed at renewal**: a renewal that succeeds but finds the lock row now belongs to someone else. Triggers immediately.
2. **Lease lapse during renewal failures**: a **transient** renewal failure (the renewal query itself throwing, e.g. a brief DB hiccup) is logged and retried on the next tick. A momentary blip shouldn't kill a run that likely still holds the lock. But if renewals keep failing until the lease window (`lockExpirySeconds`) has lapsed, Strataline can no longer assume it holds the lock and treats it as a loss. Otherwise repeated renewal exceptions could never trip the confirmed path and the run would keep working past expiry while another process potentially takes over.
3. **At write time (synchronous fence)**: every status write Strataline makes (the initial status-row insert, the per-attempt `attempts`/`started_at`/`last_error` bookkeeping, `migration_complete`, `completed_at`, the phase-applied flags, and metadata) is gated on still holding the lock: the statement carries an `AND EXISTS (… migration_lock WHERE locked_by = <our id> AND lock_expires_at > <now>)` clause, so once the lock has been taken over **or our own lease has expired** the write touches **zero rows** instead of racing the rightful owner. (Checking `lock_expires_at` matters because once the lease lapses another runner may take over at any instant, even before it actually has.) A state-advancing write that comes back empty is itself treated as a loss, closing the gap between the lease lapsing and the next renewal tick noticing. This is what stops a "zombie" run (one that ignored `ctx.signal` and called `complete()` anyway) from flipping `migration_complete` and misleading the new owner into skipping the data phase. For the **schema phases** the fenced flag write shares the phase's transaction, so a fenced-out write **rolls the whole phase back, DDL included**, meaning a schema change can't commit without the lock either.

   **Note:** the fence covers Strataline's own bookkeeping (and, transitively, the transactional DDL in a schema phase). It can **not** fence the arbitrary SQL your _data_ migration runs on the pool. That's the one thing left unguarded, so the idempotency contract still stands. (There's also a small unavoidable window between a write's lock check passing and its `COMMIT`. The fence shrinks the exposure to that, it doesn't make a time-lease into a hard mutex.)

Via the CLI, pass the same signal as `RunStratalineCLI({ ..., signal })`. It forwards it to the run and maps `"aborted"` to exit code `4`. See [Graceful Shutdown](#graceful-shutdown) under the CLI helper.

## Metadata & Checkpoints

Each migration row has a freeform `metadata` JSONB column the migration can write to and read back. Unlike the transient `data` returned from a run, `metadata` is **persisted** and **not cleared between attempts**, so it's the right place for checkpoints, progress, or any state you want to carry across runs (e.g. `{ remaining: 120, jobId: "abc" }`).

Three ways to interact with it from `ctx`:

- **Read**: `ctx.metadata` is a **read-only snapshot** of whatever was last persisted (or `null`), loaded fresh at the start of **every** run/attempt (orchestrator pass _and_ worker call), not just the first. Use it to resume from a checkpoint. (To pass batch parameters _into_ a worker, use `payload` instead because `ctx.metadata` is for persisted cross-run state.)
- **Write on pause/finish**: the `data` you pass to `ctx.complete(data)` / `ctx.defer(reason, data)` is persisted to `metadata`. (Passing no data leaves the existing value untouched. It is never auto-cleared.)
- **Write mid-run**: `await ctx.updateMetadata(value)` persists progress _while the migration is still running_, so an external observer can watch it via the `status` table. It resolves to a `boolean` (`true` if persisted, `false` on a worker no-op or a failed write) and is **non-fatal**: a failed progress write is logged and returns `false` rather than throwing, so it can't turn an otherwise healthy migration into an error.

Both writes happen **only on the orchestrator pass** (`runSchemaChanges`, job or distributed). On a `runDataMigrationJobOnly` worker they are no-ops. Only the **read** (`ctx.metadata`) works everywhere. See **Ownership** below.

```typescript
migration: async (pool, ctx) => {
  // This is the single-machine / inline shape. To support distributed mode too,
  // branch on ctx.mode: orchestrate & schedule jobs when "distributed", process
  // (all data, or a slice from ctx.payload) when "job".

  // Resume from where a previous run left off.
  let cursor = (ctx.metadata as { cursor?: number } | null)?.cursor ?? 0;

  while (cursor < total) {
    if (ctx.signal.aborted) {
      ctx.defer("shutdown", { cursor }); // persist checkpoint, resume next run
      return;
    }
    cursor = await processBatch(pool, cursor);
    await ctx.updateMetadata({ cursor }); // live progress, visible in `status`
  }

  ctx.complete({ cursor }); // final state persisted to metadata
},
```

**Ownership:** what matters is the **call path, not the mode**. Any `runSchemaChanges` call is the orchestrator and writes `metadata` (and `migration_complete`). This includes single-machine **job mode** (`runSchemaChanges("job")`), not just distributed. Only `runDataMigrationJobOnly` (a worker) has no-op writes, though it can still **read** `ctx.metadata`. Watch out: `ctx.mode === "job"` is true in _both_ a single-machine `runSchemaChanges("job")` run _and_ inside a worker (which forces `mode: "job"`), so `ctx.mode` alone doesn't tell you whether your writes persist. The call path does. See the distributed-mode note below for why.

| You called | `ctx.mode` | `complete()` marks done? | `metadata` persists? |
| --- | --- | --- | --- |
| `runSchemaChanges("job")` | `"job"` | Yes | Yes |
| `runSchemaChanges("distributed")` | `"distributed"` | Yes | Yes |
| `runDataMigrationJobOnly(...)` | `"job"` (forced) | No | No |

The first and third rows both run with `ctx.mode === "job"` yet differ on persistence, proof that the **call path** (which method you invoked), not `ctx.mode`, decides ownership. A worker just returns its value in `DataMigrationJobResult.data`. Your orchestrator pass decides whether to save it.

## Logging & Schema Helpers

Strataline provides robust logging and schema helper utilities to make migrations safer and more traceable:

### Logging

- All migration phases and helpers use a `Logger` interface for structured logs and errors.
- By default, logs are sent to the console, but you can provide your own logger by passing it to the `MigrationManager`.
- The migration system automatically adds contextual information to logs:
  - The migration ID is used as the `task` field
  - The current phase (`beforeSchema`, `dataMigration`, `afterSchema`) is used as the `stage` field, both on the `ctx.logger` passed to your data migration and on the `helpers` passed to your schema phases
  - This provides built-in traceability without manual configuration

Example:

```typescript
migration: async (pool, ctx) => {
  // The logger already has the migration ID as the task
  ctx.logger.info({ message: "Starting migration batch" });
  // ...
  ctx.logger.error({ message: "Something went wrong", error: err });
  // Output includes: [migration-id] [dataMigration] Something went wrong
};
```

#### Logger Module

Strataline includes a dedicated logger module that provides:

- A generic `Logger` interface that can be implemented for different logging backends
- A class-based implementation with:
  - `BaseLogger`: An abstract base class that implements the `Logger` interface
  - `ConsoleLogger`: A concrete implementation that logs to the console
- A default `consoleLogger` instance for immediate use
- Structured logging with support for error objects and contextual information

The logger system automatically formats messages with task and stage prefixes, making it easy to trace the origin of each log message in complex migration scenarios.

A few lower-level building blocks are also exported from `strataline/logger` for advanced use: the `LogData` / `LogLevel` / `LogDataInput` types, the `buildLogPrefix` and `getErrorMessage` helpers, a `MutableLogger` (wraps another logger and can be toggled on/off via `setVerbose`, with `isVerbose()` to read the current state, handy in tests), `createPrefixedLogger` (a standalone function that creates a prefixed logger. Handles both `BaseLogger` subclasses and plain `Logger` objects), and `PrefixedLogger` (the internal class behind `createPrefixed`/`createPrefixedLogger`. Prefer those over constructing it directly). Most users only need `BaseLogger`, `ConsoleLogger`, and `consoleLogger`.

##### Sources and Filtering

Every line carries two independent things: a severity, which is the method you call (`info`, `warn`, `error`), and a `source`, which says where the line came from. The sources Strataline emits are:

| `source`      | What it is                                      |
| ------------- | ----------------------------------------------- |
| `"pg"`        | PostgreSQL's own server output                  |
| `"setup"`     | A dev server's startup and initialization steps |
| `"migration"` | The migration system                            |

Lines a surface logs in its own voice carry no `source` at all. That is deliberate, so quieting a source can never take the message that matters with it.

`createConsoleLogger` builds a console logger that quiets whichever sources you name. The whole logging API lives at `strataline/logger`, which is its own entry point rather than a passenger on any one surface, since the dev server and the test database need it as much as migrations do:

```typescript
import { createConsoleLogger } from "strataline/logger";

createConsoleLogger(); // everything, the default
createConsoleLogger({ pg: false }); // no routine PostgreSQL output
createConsoleLogger({ pg: false, setup: false }); // also no dev server startup steps
createConsoleLogger({ migration: false }); // no per-migration chatter
```

Two rules make this safe to use without reading the source list first:

- **Only routine `info` output is quieted.** A warning or an error is never hidden. Strataline reads the severity PostgreSQL prints in its own lines, so a `WARNING`, `ERROR`, `FATAL`, or `PANIC` reaches your logger at that level and prints even under `{ pg: false }`. That means `{ pg: false }` drops `listening on IPv4 address` without also hiding the `FATAL` explaining why the server would not start.
- **A source you did not name is shown.** Absent means visible, so a filter built for one surface is safe to hand to another. The wrong one is louder than you intended, never quieter, and a logger you wrote for your own sources keeps printing them.

To apply the same filtering to a logger of your own rather than to the console, wrap it in `SourceFilterLogger`:

```typescript
import { SourceFilterLogger } from "strataline/logger";

const logger = new SourceFilterLogger(myPinoAdapter, { pg: false });
```

##### Creating Custom Loggers

You can create your own logger by extending the `BaseLogger` class:

```typescript
import { BaseLogger, LogDataInput } from "strataline/logger";

// Create a custom logger that sends logs to a service
class ApiLogger extends BaseLogger {
  info(data: LogDataInput): void {
    // Send log to your logging service
    apiClient.sendLog({
      level: "info",
      message: data.message,
      context: {
        task: data.task,
        stage: data.stage,
      },
    });
  }

  error(data: LogDataInput): void {
    // Send error to your logging service
    apiClient.sendLog({
      level: "error",
      message: data.message,
      error: data.error,
      context: {
        task: data.task,
        stage: data.stage,
      },
    });
  }

  warn(data: LogDataInput): void {
    // Send warning to your logging service
    apiClient.sendLog({
      level: "warn",
      message: data.message,
      context: {
        task: data.task,
        stage: data.stage,
      },
    });
  }
}

// Create an instance and use it
const apiLogger = new ApiLogger();
const migrationManager = new MigrationManager(pool, apiLogger);
```

You can also create prefixed loggers easily with the `createPrefixed` method:

```typescript
// Create a logger with prefilled task/stage information
const prefixedLogger = apiLogger.createPrefixed({
  task: "my-task",
  stage: "initialization",
});

// All logs will include the prefixes
prefixedLogger.info({ message: "Starting process" });
// Output includes: [my-task] [initialization] Starting process
```

### Schema Helpers

The `helpers` object, passed as the second argument to `beforeSchema` and `afterSchema` functions, provides a set of safe, idempotent methods for common schema modifications. These helpers automatically log their actions using the configured logger and perform existence checks before attempting changes, preventing errors if an object already exists or doesn't exist when trying to remove it.

> **Schema Resolution:** Existence checks resolve relations through Postgres's `to_regclass` / `pg_catalog`, so they honor the connection's `search_path` and accept schema-qualified names (e.g. `"reporting.users"`). The check looks in the same place the subsequent DDL will run, not blindly across every schema. Note that table, column, index, and constraint **names are written directly into the SQL statement**. SQL placeholders (`$1`, `$2`, …) can only stand in for _values_ (data), never for identifiers like table or column names, so those names can't be parameterized and must be concatenated in. The same is true of the **column types, default values, and constraint definitions** you pass (e.g. `columnType`, `defaultValue`, the `columns` map values, and the `constraints` strings). These are interpolated directly too, **not** parameterized, so a value-shaped argument like `defaultValue` is _not_ safe to build from user input. Treat all of them as trusted, code-defined values. Don't build them from untrusted input.

**Available Helpers:**

- **`createTable(client, tableName, columns, constraints?)`**: Creates a table if it doesn't exist.
  - `columns`: An object mapping column names to their types (e.g., `{ id: "SERIAL PRIMARY KEY", name: "TEXT NOT NULL" }`).
  - `constraints` (optional): An array of strings defining table constraints (e.g., `["CONSTRAINT uq_email UNIQUE (email)"]`).
- **`addColumn(client, tableName, columnName, columnType, defaultValue?)`**: Adds a column to a table if it doesn't exist. Throws an error if the table does not exist.
  - `defaultValue` (optional): A default value for the new column.
- **`removeColumn(client, tableName, columnName)`**: Removes a column from a table if it exists. Throws an error if the table does not exist. Logs a message if the column doesn't exist.
- **`addIndex(client, tableName, indexName, columns, unique?)`**: Adds an index to a table if it doesn't exist. Throws an error if the table does not exist, or if the `indexName` collides with an existing relation in the table's schema that isn't this index. (In Postgres, indexes share one namespace with tables, views, sequences, etc. per schema, so an index name must be unique across all of them. A clash with another table's index _or_ a non-index relation is a conflict.)
  - `columns`: An array of column names to include in the index.
  - `unique` (optional, default `false`): Whether to create a unique index.
- **`removeIndex(client, indexName)`**: Removes an index if it exists. Logs a message if the index doesn't exist.
- **`addForeignKey(client, tableName, constraintName, columnName, referencedTable, referencedColumn, onDelete?)`**: Adds a foreign key constraint if it doesn't exist. Throws an error if the table or referenced table does not exist.
  - `onDelete` (optional, default `'NO ACTION'`): Action to take on delete (`CASCADE`, `SET NULL`, `RESTRICT`, `NO ACTION`).
- **`addDeferrableForeignKey(client, tableName, constraintName, columnName, referencedTable, referencedColumn, onDelete?, initiallyDeferred?)`**: Adds a deferrable foreign key constraint if it doesn't exist. This allows for circular references to be created in a single transaction. Throws an error if the table or referenced table does not exist.
  - `onDelete` (optional, default `'NO ACTION'`): Action to take on delete (`CASCADE`, `SET NULL`, `RESTRICT`, `NO ACTION`).
  - `initiallyDeferred` (optional, default `true`): Whether the constraint should be initially deferred (`INITIALLY DEFERRED`) or not (`INITIALLY IMMEDIATE`).
- **`removeConstraint(client, tableName, constraintName)`**: Removes a constraint (like a foreign key or check constraint) if it exists. Throws an error if the table does not exist. Logs a message if the constraint doesn't exist.

**Example Usage:**

```typescript
beforeSchema: async (client, helpers) => {
  // Create the main table
  await helpers.createTable(client, "products", {
    id: "SERIAL PRIMARY KEY",
    name: "VARCHAR(255) NOT NULL",
    category_id: "INT", // Will add FK later
    price: "NUMERIC(10, 2)",
    created_at: "TIMESTAMPTZ DEFAULT NOW()",
  });

  // Create a related table
  await helpers.createTable(client, "categories", {
    id: "SERIAL PRIMARY KEY",
    name: "VARCHAR(100) UNIQUE NOT NULL",
  });

  // Add an index
  await helpers.addIndex(client, "products", "idx_products_name", ["name"]);

  // Add a foreign key constraint
  await helpers.addForeignKey(
    client,
    "products",           // Table name
    "fk_product_category", // Constraint name
    "category_id",        // Column in products table
    "categories",         // Referenced table
    "id",                 // Referenced column in categories table
    "SET NULL",           // ON DELETE action
  );
},

afterSchema: async (client, helpers) => {
  // Example: Add a column after data migration
  await helpers.addColumn(
    client,
    "products",
    "is_active",
    "BOOLEAN",
    "TRUE", // Default value
  );

  // Example: Remove an old index (if it existed)
  await helpers.removeIndex(client, "old_idx_to_remove");
}
```

## Database Tables

Strataline creates and manages the following tables in your PostgreSQL database:

### migration_status

This table tracks the status of each migration:

```sql
CREATE TABLE IF NOT EXISTS migration_status (
  id VARCHAR(255) PRIMARY KEY,           -- Migration ID
  description TEXT NOT NULL,             -- Migration description
  before_schema_applied BOOLEAN NOT NULL DEFAULT FALSE,  -- Whether beforeSchema phase is complete
  migration_complete BOOLEAN NOT NULL DEFAULT FALSE,     -- Whether data migration is complete
  after_schema_applied BOOLEAN NOT NULL DEFAULT FALSE,   -- Whether afterSchema phase is complete
  completed_at BIGINT NOT NULL DEFAULT 0,                -- Timestamp when migration was fully completed (0 if not complete)
  last_updated BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::bigint,  -- Last update timestamp
  started_at BIGINT NOT NULL DEFAULT 0,  -- Timestamp of the first attempt (0 if never attempted)
  attempts INTEGER NOT NULL DEFAULT 0,   -- Number of times this migration has been attempted
  last_error TEXT,                       -- Most recent error/defer reason, or NULL once it completes cleanly
  metadata JSONB                         -- Freeform state the migration persists (checkpoints/progress); NOT cleared between attempts
)
```

The `started_at`, `attempts`, and `last_error` columns are observability aids that make a stuck or repeatedly-deferred migration debuggable straight from the table. The `metadata` column holds freeform JSON the migration persists for itself. See [Metadata & Checkpoints](#metadata--checkpoints). `attempts` increments at the start of every attempt that actually begins work, including attempts that `defer()` or error, not just successful ones. There are two exceptions: an attempt that is already aborted, via shutdown signal or lock loss, _before_ this migration's schema phase starts does no work, so it does **not** increment `attempts` and leaves the prior `last_error` intact. The distributed-mode `runDataMigrationJobOnly` path also never increments it. `started_at` is stamped once on the first attempt, and `last_error` is set on any failure or `defer()` and cleared at the **start** of the next attempt (so it appears `NULL` for the duration of any in-progress run, even if prior attempts failed) and is `NULL` once the migration completes cleanly. Existing tables created by older versions (prior to 4.0.0) are upgraded automatically (`ADD COLUMN IF NOT EXISTS`) the next time the migration system initializes.

You can also read these rows programmatically with `await manager.getMigrationStatus()`, which returns a typed `MigrationStatus[]` (the same data the CLI `status` command renders), useful for building your own dashboards or health checks. It reflects the raw table, ordered by `completed_at`, so it returns **every** row in `migration_status` rather than filtering to your currently registered list. In practice these are the same set, since migrations are normally kept around once applied. The only time they diverge is if you've renamed or deleted an old migration. In that case, its row lingers, so cross-reference against your migrations array if you need to exclude those.

### migration_lock

This table is used to prevent concurrent migrations:

```sql
CREATE TABLE IF NOT EXISTS migration_lock (
  lock_name VARCHAR(100) PRIMARY KEY,    -- Lock identifier (always "database_migrations")
  locked_by TEXT,                        -- Process ID that holds the lock
  locked_at TIMESTAMP WITH TIME ZONE,    -- When the lock was acquired
  lock_expires_at TIMESTAMP WITH TIME ZONE  -- When the lock expires (auto-renewed while running)
)
```

The lock system ensures that only one `runSchemaChanges` process can execute at a time, preventing concurrent runs of the overall migration sequence and protecting schema integrity. Individual `runDataMigrationJobOnly` calls (used for batch processing in distributed mode) do **not** acquire this global lock, allowing multiple data migration jobs for the same migration ID to run in parallel.

#### Lock Lifecycle and Cleanup

Both lock knobs are optional and ship with sensible defaults. Pass them as the third argument to the `MigrationManager` constructor (`new MigrationManager(pool, logger?, opts?)`) only when you need to tune the lock's timing, for example, lengthening the lease for unusually long-running phases:

```typescript
const manager = new MigrationManager(pool, consoleLogger, {
  lockExpirySeconds: 600, // lease window — how long the lock stays valid (default 300)
  lockRenewalSeconds: 120, // how often it's renewed (default 60); must be ≤ half the lease
});
```

Each knob is detailed below.

- **Owner (`locked_by`)** is a per-process identifier of the form `<host>-<pid>-<timestamp>`, where `<host>` is `process.env.HOSTNAME`, falling back to `os.hostname()` (and to the literal `"unknown"` if both are empty). `lock_name` is a separate column and is always the constant `"database_migrations"`.
- **Lease Window (`lockExpirySeconds`):** How long an acquired lock stays valid before another process may take it over. Default `300` (5 minutes), configurable via the `MigrationManager` constructor.
- **Renewal (`lockRenewalSeconds`):** While `runSchemaChanges` is running, the lock's `lock_expires_at` is pushed forward every `lockRenewalSeconds` (default `60`, configurable via the `MigrationManager` constructor). The constructor **validates** this against the lease: `lockRenewalSeconds` must be a positive, finite number no greater than **half** `lockExpirySeconds`, so the lease can survive at least one missed renewal. A value outside that range (or a non-positive/non-finite `lockExpirySeconds`) throws at construction rather than silently risking concurrent migrations.
- **Normal Release:** The lock row is deleted in a `finally` block when `runSchemaChanges` finishes (success or failure).
- **Crash Recovery:** If a process dies without releasing the lock, the row remains until `lock_expires_at` passes. The next runner then takes it over (the stale row is overwritten, not left forever). The takeover hinges on detecting the unique-violation on re-insert by its SQLSTATE code (`23505`), not by parsing the error text, so it works regardless of the server's `lc_messages` locale. In practice the lock self-heals within one lease window (`lockExpirySeconds`, default ~5 minutes) of a crash.
- **Caveat:** If a single data migration runs longer than `lockExpirySeconds` **and** renewal stops (e.g. the renewal timer is starved or the event loop is blocked long enough to miss every renewal), another process could acquire the lock and run concurrently. Lock loss is detected three converging ways: at renewal, on a lapsed lease during renewal failures, and synchronously at every Strataline state write (the write fence). See the full list under [Graceful Shutdown & Cancellation](#graceful-shutdown--cancellation). Renewals are reactive, not preventive, so keep individual phases well under the lease window, or raise the renewal cadence / lengthen the lease, for long-running work. **Long-running data migrations should also poll `ctx.signal.aborted` (or listen for its `"abort"` event) and wind down promptly. Stop work and return.** A migration that watches the signal shrinks the concurrency window. One that ignores it keeps running on the pool until it finishes, since **its own in-flight data SQL isn't fenced by the lock**. That's the one thing Strataline can't gate. Strataline's own state writes _are_ fenced (a write after the lock is lost no-ops, see [Graceful Shutdown & Cancellation](#graceful-shutdown--cancellation)), and it won't run `afterSchema` or mark completion without the lock. So the worst case is duplicated/again-idempotent data work, never a half-applied schema or a falsely-completed migration.

## Development and Test Database Instances Utilities

Strataline provides utilities to spin up local PostgreSQL instances for development and testing.

### Note for Bun Users (Using `embedded-postgres`)

Strataline's development and test database utilities leverage `embedded-postgres`. When using these utilities with Bun, you may encounter issues with native module resolution. To address this, Bun requires explicit trust for packages that use lifecycle scripts. Add the following to your `package.json`:

```json
"trustedDependencies": [
  "@embedded-postgres/darwin-arm64",
  "@embedded-postgres/darwin-x64",
  "@embedded-postgres/linux-arm",
  "@embedded-postgres/linux-arm64",
  "@embedded-postgres/linux-ia32",
  "@embedded-postgres/linux-ppc64",
  "@embedded-postgres/linux-x64",
  "@embedded-postgres/windows-x64"
]
```

This ensures that Bun can correctly execute the necessary setup scripts for `embedded-postgres`.

For more context, you can refer to this [GitHub issue](https://github.com/leinelissen/embedded-postgres/issues/13).

### Test DB Instance

This helper creates short-lived, non-persistent Postgres clusters for testing purposes. It provides isolated database instances that automatically shut down when tests complete, with optional migration application. Using `embedded-postgres`, it runs PostgreSQL directly in your test environment without external dependencies, making it ideal for integration and unit tests.

#### Features

- Creates temporary, isolated PostgreSQL instances
- Optionally applies database migrations (Strataline compatible)
- Provides connection pools and credentials
- Supports database resets between tests
- Configurable logging for both PostgreSQL and Strataline migrations
- Works with or without migrations for maximum flexibility

#### Usage

```typescript
import { TestDatabaseInstance } from "strataline/test-db-instance";
import { migrations } from "./path/to/your/migrations";

// Create a test database with migrations
const testDb = new TestDatabaseInstance({
  migrations, // Optional: provide your Strataline migrations
});

// Or create a database without migrations (just PostgreSQL)
const testDbNoMigrations = new TestDatabaseInstance();

// Or with all custom options
const testDb = new TestDatabaseInstance({
  port: 5432, // Optional: specific port (default: auto-assigned)
  logger: customLogger, // Optional: custom logger function
  user: "custom_user", // Optional: database username (default: 'test_user')
  password: "custom_pwd", // Optional: database password (default: 'test_password')
  databaseName: "custom", // Optional: database name (default: 'test_database')
  migrations, // Optional: your Strataline migrations array
});

// Start the database (will create, start PostgreSQL, and apply migrations if provided)
await testDb.start();

// Check readiness if needed (true once started and the pool is live)
testDb.isReady();

// Get the database pool for queries.
// Note: getPool() and getCredentials() return null until start() has completed,
// so guard the result if you call them outside the normal start()/stop() flow.
const pool = testDb.getPool();

// Or get connection credentials for direct connection. Returns
// { host, port, database, user, password }, or null until start() has completed.
// `host` is 127.0.0.1: the cluster listens on IPv4 only, so a name that can
// resolve to ::1 is not what you want to hand to a client.
const credentials = testDb.getCredentials();

// Reset the database (drops all tables in the `public` schema and reapplies
// migrations if provided). Note: only the `public` schema is cleared — tables
// in other schemas (e.g. schema-qualified migrations) are left in place.
await testDb.reset();

// Stop the database and clean up resources
await testDb.stop();
```

#### Logging

You can use the built-in console logger or implement your own:

```typescript
import { createConsoleLogger } from "strataline/logger";

// Use the built-in console logger, naming any source you want quieted.
// Everything is shown by default. `{ pg: false }` is the usual choice for a
// test suite, since PostgreSQL's routine output is rarely what a failing test
// is about. Only routine `info` lines are affected: a PostgreSQL WARNING,
// ERROR, FATAL or PANIC reaches your logger at that level and still prints.
const testDb = new TestDatabaseInstance({
  logger: createConsoleLogger({
    pg: false, // quiet PostgreSQL's routine server logs
    // migration: false,  // quiet the migration system's routine chatter
  }),
});

// Or implement your own logger
const customLogger: Logger = {
  info: (data) => console.log(render(data)),
  warn: (data) => console.warn(render(data)),
  error: (data) => console.error(render(data), data.error ?? ""),
};

// Severity is the method that was called. `source` says which part of the
// system is talking: "pg" is the PostgreSQL server, "migration" is Strataline's
// migration system, and no source at all is the test database's own voice.
function render(data: LogDataInput) {
  const from = data.source ? `[${data.source.toUpperCase()}] ` : "";

  return `${from}${data.message}`;
}
```

The logger is the `Logger` interface exported from `strataline/logger`, and the data it receives is `LogDataInput`. The constructor's options object is exported as `TestDatabaseOptions`.

##### Migration Logging

The TestDatabaseInstance automatically creates a Strataline-compatible logger adapter that works with or without a provided logger:

- If you provide a logger, migration logs reach it with `source: "migration"`, at whichever level the migration system used
- If you don't provide a logger, migrations will run silently with no logs

When you provide a logger to TestDatabaseInstance, it will:

1. Use that logger for its own operation logs, which carry no `source`
2. Use that logger for PostgreSQL logs, which carry `source: "pg"`
3. Send Strataline migration logs through the same logger with `source: "migration"`

This ensures all logs flow through a single logging interface, making it easy to direct logs to your preferred destination.

#### Example in Tests

```typescript
import { TestDatabaseInstance } from "strataline/test-db-instance";
import { migrations } from "./path/to/your/migrations";

describe("Database Tests", () => {
  let testDb: TestDatabaseInstance;

  beforeAll(async () => {
    testDb = new TestDatabaseInstance({
      migrations, // Include your migrations
    });

    await testDb.start();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    // Reset database before each test (reapplies migrations)
    await testDb.reset();
  });

  it("should execute a query", async () => {
    const pool = testDb.getPool();
    const result = await pool.query("SELECT 1 as value");
    expect(result.rows[0].value).toBe(1);
  });
});

// Example without migrations (just PostgreSQL)
describe("Simple Database Tests", () => {
  let testDb: TestDatabaseInstance;

  beforeAll(async () => {
    testDb = new TestDatabaseInstance(); // No migrations
    await testDb.start();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("should work without migrations", async () => {
    const pool = testDb.getPool();
    const result = await pool.query("SELECT 1 as value");
    expect(result.rows[0].value).toBe(1);
  });
});
```

### Local Dev DB Server

This helper runs a **persistent local PostgreSQL server** in a standalone script, perfect for development environments where you want a real database running alongside your app.

It uses the same embedded PostgreSQL binaries as Strataline's Test DB Instance, so there's **no need to install Postgres manually** or run Docker. No `brew`, no `apt`, no containers, just run `bun run dev:db` and go.

- **For local development, you do _not_ need to install PostgreSQL manually.**
- The dev database server (`bun run dev:db`) uses [@embedded-postgres](https://www.npmjs.com/package/@embedded-postgres) to provide platform-specific PostgreSQL 18 binaries via npm.
  - _Note: Strataline currently depends on a **pre-release** (beta) of `embedded-postgres` for its PostgreSQL 18 binaries, and the version range (`^18.4.0-beta.17`) can resolve forward to later 18.x betas. This only affects the local embedded dev/test databases, never your production instance, but pin the exact version in your own `package.json` if you want fully reproducible local builds._
- _Note: The embedded dev database does **not** bundle `pg_upgrade`. When we bump the embedded version in the future, you may need to delete your local data directory (`pgdata/`) and let it reinitialize. This is usually fine for dev/test workflows._
- **Production deployments** still require a managed PostgreSQL 18+ instance, and upgrades must be handled manually by your ops team.

Unlike test instances, the dev server is designed to **persist data between restarts**. That means you can keep your seeded content, local accounts, and data intact between sessions, making it especially useful when developing or demoing your app.

This setup is great for:

- Running your app locally with a real, stateful database
- Testing workflows without needing to re-seed every time
- Building or demoing features against consistent local data

The server handles startup, cleanup, and automatically creates the specified user, password, and database combination for you.

#### Setting Up a Dev Database Script

Create a script to run your local development database server:

```typescript
// scripts/dev-db.ts
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { LocalDevDBServer } from "strataline/local-dev-db-server";
import { createConsoleLogger } from "strataline/logger";

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
  // `|| 1`: onExit fires for any exit this process did not ask for, and a
  // clean shutdown from elsewhere (`pg_ctl stop`) exits 0, which would
  // otherwise report a vanished database as a successful run.
  onExit: (code) => process.exit(code || 1),
});

// Held, not just awaited. A signal can arrive during startup, and shutdown()
// rejects while a start is in flight, so the handler has to wait for the start
// to settle rather than call shutdown() into a refusal. Exiting there instead
// would leave the postmaster to the synchronous `exit` hook, which only
// SIGKILLs it: no shutdown checkpoint, a stranded postmaster.pid, and leaked
// SysV IPC objects.
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

// Clears the bounded phases with room over: a previous server's shutdown
// escalation runs to about 42 seconds, the readiness wait polls for about 30
// more, and user and database setup follows. Not a ceiling on a start, since
// initdb has no bound of its own, but well clear of what a working machine
// does. The bound is for a start that is stuck rather than one that is slow,
// since trapping a signal suppresses Node's own termination and an unbounded
// wait would ignore SIGTERM forever.
const START_WAIT_MS = 90_000;

let stopping: Promise<void> | null = null;

function abandonStartup(reason: string): void {
  console.error(`${reason} Exiting without a clean shutdown.`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    // A second signal while the first is still WAITING gives up on the wait.
    // Once the shutdown is running it is left alone: cutting an escalation off
    // part-way can leave a data directory needing recovery.
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

    startWait.unref();

    stopping = startup
      .then((error) => {
        clearTimeout(startWait);

        // A failed start has already torn its own child down, and the handler
        // above is about to exit. Nothing here to stop.
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
```

Add the script to your `package.json`:

```json
{
  "scripts": {
    "dev:db": "bun run scripts/dev-db.ts"
  }
}
```

Then start your development database:

```bash
bun run dev:db
```

#### Configuration Options

The `LocalDevDBServer` accepts the following configuration:

```typescript
const server = new LocalDevDBServer({
  // Required — there are no defaults for these. Unlike the Test DB Instance
  // (which auto-assigns a free port when you omit it), the dev server is meant
  // to run on a fixed, predictable port your app can always point at, so you
  // must choose one explicitly.
  port: 5433, // PostgreSQL port
  user: "myapp_user", // Database user to create automatically
  password: "myapp_pass", // Password for the database user
  database: "myapp_dev", // Database name to create automatically
  dataDir: "./pgdata", // Directory to store PostgreSQL data
  pidFile: "./.pg_pid", // File to store the PostgreSQL process ID
  // Optional
  logger: customLogger, // Optional: custom logger function
  onExit: (exitCode) => process.exit(exitCode || 1), // Optional: server-exit notification
  logConnections: false, // Optional: enable PostgreSQL connection logging (default: false)
});
```

> **Note on Required Fields:** `port`, `user`, `password`, `database`, `dataDir`, and `pidFile` are all required (TypeScript enforces this). Only `logger`, `onExit`, and `logConnections` are optional. This differs from the [Test DB Instance](#test-db-instance), where everything, including the port, is optional and a free port is auto-assigned, because test databases are throwaway and isolated while the dev server is long-lived and shared with your app.

**Note:** The server automatically creates the specified user, password, and database during startup. You don't need to create these manually - just specify the credentials you want to use and the server will set them up for you.

> **Heads up: a `postgres` superuser is also created.** Besides the user you configure, startup ensures a `postgres` superuser exists with the well-known password `postgres` (it's created if missing, or its password is reset to `postgres` if it already exists). This is a local-development convenience, but it means the cluster has a predictable superuser login. Keep the dev server bound to localhost (it is, by default) and **don't expose its port** on shared or untrusted networks.

**Exit Handling:** The library never exits the host process. `onExit` is an optional notification that fires only when an already-running PostgreSQL server exits without being asked, carrying PostgreSQL's exit code. It is not called by `stop()`, `shutdown(signal)`, a failed `start()`, or an operating-system signal. Handle startup errors through the promise returned by `start()`, and wire host signal handlers explicitly as shown below.

#### Logging

You can customize logging behavior using the built-in console logger:

```typescript
import { createConsoleLogger } from "strataline/logger";

// Create a logger, naming any source you want quieted. Everything is shown
// by default. Quieting affects routine `info` output only: Strataline reads
// the severity PostgreSQL prints in its own lines, so a WARNING, ERROR, FATAL
// or PANIC reaches your logger at that level and is shown either way. So
// `{ pg: false }` quiets "listening on IPv4 address" without hiding the FATAL
// that says why the server would not start.
const logger = createConsoleLogger({
  pg: false, // quiet PostgreSQL's routine server logs
  setup: false, // quiet the startup and initialization steps
});

// Or implement your own logger
const customLogger: Logger = {
  info: (data) => console.log(render(data)),
  warn: (data) => console.warn(render(data)),
  error: (data) => console.error(render(data), data.error ?? ""),
};

// Severity is the method that was called. `source` says which part of the
// system is talking: "pg" is the PostgreSQL server, "setup" is initialization,
// and no source at all is the dev server's own voice.
function render(data: LogDataInput) {
  const from = data.source ? `[${data.source.toUpperCase()}] ` : "";

  return `${from}${data.message}`;
}
```

> **If your process _is_ the server, you own every way it can end.** This library never exits your process, so a script whose whole job is to run the dev server has two things to wire: a signal handler that stops the server and exits, and an `onExit` that exits when PostgreSQL dies on its own. Omit the second and ordinary flow control takes over. With nothing left pending the script exits by itself, but with code `0`, reporting a crashed database as a clean run. Exit non-zero from it rather than forwarding PostgreSQL's code as it stands, since a clean shutdown asked for from somewhere else, a `pg_ctl stop` for instance, reaches `onExit` with code `0` and would read as a successful run. Callers that legitimately carry on afterwards, such as tests or a provisioning step that stops the server and moves on, are exactly the ones that should not exit from there.

The logger is the `Logger` interface exported from `strataline/logger`, and the `onExit` callback type is exported as `DevDBExitHandler` (`(exitCode: number) => void`), if you prefer the named types over writing the shapes inline. The constructor's configuration object is exported as `LocalDevDBServerConfig`, and `getLifecycleState()`'s return type as `DevDBLifecycleState`.

#### Data Persistence

The dev server creates a persistent data directory (e.g., `pgdata/`) that maintains your database state between restarts. This means:

- Your tables, data, and schema changes persist across server restarts
- You can seed data once and keep it for development sessions
- Database migrations applied during development remain in place

To start fresh, simply delete the data directory and restart the server:

```bash
rm -rf pgdata/
bun run dev:db
```

#### Process Management

The dev server includes robust process management:

- **Clean Shutdown**: Stops the verified server with PostgreSQL's fast-shutdown signal, escalating only as far as needed, so a connected client does not leave a stale data directory
- **Stale Process Detection**: Cleans up a previous server only after verifying its identity, and refuses startup when the evidence is ambiguous
- **PID File Management**: Tracks the server process ID for reliable cleanup
- **Verified Termination**: Only ever signals a PID that has been positively matched to this cluster and this boot, and leaves an unidentifiable process alone rather than guessing
- **Host-Owned Signals**: Installs no signal handlers. Call `shutdown(signal)` from the host's `SIGINT`, `SIGTERM`, or `SIGHUP` handler when the server should stop with the process

#### How Shutdown Works

PostgreSQL reads signals as distinct shutdown _modes_ rather than as a generic "stop", which makes the obvious approach the wrong one:

| Signal | PostgreSQL meaning |
| --- | --- |
| `SIGTERM` | Smart shutdown, which waits for every client to disconnect first |
| `SIGINT` | Fast shutdown, which disconnects clients, rolls back, and exits cleanly |
| `SIGQUIT` | Immediate shutdown, with no clean exit and recovery on next start |

Sending `SIGTERM` therefore hangs for as long as an application holds a connection, and whatever timeout sits behind it eventually escalates to a hard kill, leaving a stale `postmaster.pid` and a data directory needing recovery. That is usually what is happening when a dev server "sometimes doesn't stop properly".

Shutdown escalates only as far as it must:

1. `SIGINT` (fast shutdown), deliberately not `SIGTERM`.
2. `SIGQUIT` (immediate shutdown), which still cleans up child processes and shared memory.
3. `SIGKILL`, only as a last resort, since it can orphan children and leave shared memory behind.

On Windows, where Node maps these names to unconditional process termination rather than PostgreSQL signal semantics, the first two are sent with `pg_ctl kill <signal> <verified-pid>`. The PID-addressed form is intentional: `pg_ctl stop -D` would reread `postmaster.pid` in a child process after verification, allowing a replacement server to become the target.

`SIGKILL` is the exception there, and stays with Node. `pg_ctl` delivers signals through PostgreSQL's own emulated-signal pipe, which the server has to be healthy enough to service. The one signal that exists for a server too wedged to service anything is the one `pg_ctl` cannot deliver, and it reports success either way. Node maps `SIGKILL` to `TerminateProcess`, which is what a last resort has to be.

`stop()` resolves once the server has actually stopped, rather than once shutdown has merely been requested, and it never exits the host process or calls `onExit`. That holds whether or not there was anything to stop, so a defensive `stop()` in test teardown is safe as long as the start it is tearing down has been awaited.

Overlapping lifecycle requests are not queued. `start()` rejects while a start or a shutdown is in flight, and `stop()` and `shutdown(signal)` reject while a start is. A second `stop()` is the exception: it joins the shutdown already running. Sequence them by awaiting the first, and ask `getLifecycleState()` when you need to know which one that is:

```ts
type DevDBLifecycleState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "unstoppable";

server.getLifecycleState(); // "running"
```

| State         | `start()`         | `stop()` / `shutdown(signal)` |
| ------------- | ----------------- | ----------------------------- |
| `stopped`     | starts a server   | resolves, nothing to stop     |
| `starting`    | **rejects**       | **rejects**                   |
| `running`     | logs and resolves | stops it                      |
| `stopping`    | **rejects**       | joins the shutdown in flight  |
| `unstoppable` | **rejects**       | runs the escalation again     |

`unstoppable` is the state a failed `start()` leaves when the partially started server outlived even `SIGKILL`. The instance keeps the child rather than forgetting it, so `stop()` can try again, and `start()` refuses until it is gone. It is reported separately because the child's own exit status cannot distinguish it: an orphaned backend holding the inherited stdio pipes keeps the reference alive after the postmaster has died, which would otherwise read as `running` or `stopped` and promise a `start()` that in fact throws.

Stopping is deliberately the forgiving one. The two refusals fail in opposite directions: a `start()` that rejects leaves no server, which is visible and costs a retry, while a `stop()` that rejected would leave a postmaster holding the port and the data directory, produced by the one call whose whole job was to prevent that. Teardown is idempotent nearly everywhere for the same reason, `net.Server.close()` and Go's `http.Server.Shutdown` included.

What a joined caller gives up is knowing whose request stopped the server. The escalation belongs to whoever asked first, so a `stop()` joined to a `shutdown("SIGTERM")` resolves for a stop it had no part in, and a failure rejects both. Check `getLifecycleState()` first where that matters. Nothing has to check in order to be correct, which is the point.

This is the instance's own view and nothing more. A server left behind by a previous run reads as `stopped`, because this object has never held it. That question is [`getLocalDevDBServerStatus()`](#probing-for-a-running-server), which reads the PID records rather than memory. It is also a snapshot that does not survive an `await`, so use it for a log line or a branch that tolerates being wrong, not as a check that some later call is relied on to pass.

`stop()` waits for the child's `exit` event rather than only for the PID to disappear, so the PID file has been released by the time it resolves. It deliberately does not wait for `close`, which reports the stdio pipes closed as well as the process exited: PostgreSQL's backends inherit those pipes, and a postmaster wedged badly enough to need `SIGKILL` dies without signaling its children, which go on holding them with nothing left to reap them. So `close` can arrive late or never, and nothing `stop()` promises is about the pipes. The wait on `exit` is bounded too, and once the process itself is confirmed gone strataline finishes the cleanup itself rather than wait on an event, so a shutdown that worked is never reported as one that failed. What that leaves is that a resolved `stop()` does not mean the child's output has finished arriving. Only a `start()` whose server died waits for that, briefly and with a bound, so its error can carry what PostgreSQL said.

**This library traps no signals.** Wiring `SIGINT`/`SIGTERM`/`SIGHUP` is the program's job, the same as it already is for [`RunStratalineCLI`](#cli-integration). A signal listener suppresses Node's default termination for the whole process, so a library that installs one silently changes how its host dies, and where two of them disagree the loudest wins. Call `shutdown(signal)` from your own handler: it stops the server and resolves, so the exit stays yours.

```ts
const server = new LocalDevDBServer(config);

// Held, not just awaited. A signal can arrive during startup, and shutdown()
// rejects while a start is in flight, so the handler has to wait for the start
// to settle rather than call shutdown() into a refusal.
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

// Bounded, because trapping a signal suppresses Node's own termination and an
// unbounded wait would be a script that ignores SIGTERM forever. It clears the
// bounded phases with room over: a previous server's shutdown escalation runs
// to about 42 seconds, the readiness wait polls for about 30 more, and user and
// database setup follows. Not a ceiling on a start, since initdb has no bound
// of its own, but well clear of what a working machine does. This is for a
// start that is stuck rather than one that is slow, and giving up early only
// reaches the same force-kill sooner while throwing away the starts that would
// have finished.
const START_WAIT_MS = 90_000;

let stopping: Promise<void> | null = null;

function abandonStartup(reason: string): void {
  console.error(`${reason} Exiting without a clean shutdown.`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    // A second signal while the first is still WAITING gives up on the wait.
    // Once the shutdown is running it is left alone: cutting an escalation off
    // part-way can leave a data directory needing recovery.
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

    startWait.unref();

    stopping = startup
      .then((error) => {
        clearTimeout(startWait);

        // A failed start has already torn its own child down, and the handler
        // above is about to exit. Nothing here to stop.
        if (error !== null) {
          return;
        }

        return server.shutdown(signal).then(() => process.exit(0));
      })
      // shutdown() rejects when the server could not be stopped. Handle it, or
      // the rejection is unhandled and what says which server is still running
      // arrives as the first line of a crash dump.
      .catch((error: unknown) => {
        clearTimeout(startWait);
        console.error(`Shutdown failed: ${error}`);
        process.exit(1);
      });
  });
}
```

Waiting for the start is the point of that shape, not incidental to it. Calling `shutdown(signal)` straight from the handler rejects for the whole of `start()`, which on a cold run is its longest stretch, and a script that then exits leaves the postmaster to the synchronous `exit` hook. That hook only `SIGKILL`s: no shutdown checkpoint, a stale `postmaster.pid`, and the SysV shared memory and semaphores PostgreSQL releases on a clean exit and not on a hard kill.

The wait needs a bound for the same reason it needs to exist. Trapping a signal suppresses Node's own termination, so an unwaited-out `start()` becomes a script that ignores `SIGTERM`. A first-run `initdb` is unbounded and is the one step here that can be, so without the timer a supervisor's grace period expires and `SIGKILL`s the script, reaching the ungraceful ending more slowly than not waiting would have. Giving up is no worse than never having waited, so the bound only trades away the startups that would have finished later than it.

> **Wire this, or a supervisor orphans your database.** An untrapped `SIGTERM` terminates Node immediately without running any JavaScript, including the force-kill hook below. `docker stop`, systemd, or any process manager then leaves the postmaster running, holding the port and the data directory. `Ctrl+C` at a terminal usually survives it because the signal goes to the whole foreground process group and PostgreSQL gets its own copy, but that is luck rather than design.

`shutdown(signal)` is `stop()` with the signal recorded in the log. What reaches PostgreSQL is always the `SIGINT` → `SIGQUIT` → `SIGKILL` escalation, because those are the only shutdown modes it has, and the signal that reached your process says nothing about which one this server needs.

One `process` listener is installed for `exit`, and it force-kills a surviving postmaster. It makes no lifecycle decision because it is synchronous and runs only once the process is already leaving. It exists so a database does not outlive the program that spawned it, going on with the first server and coming off with the last.

#### Who Exits

**Not this library, ever.** It has no way to end your process and takes no decision that could. `onExit` is a notification, not an exit handler: it reports the one thing you could not otherwise find out, a server that stopped when nobody asked it to, and hands you PostgreSQL's own exit code to act on.

| What happened | `onExit` |
| --- | --- |
| You called `stop()` or `shutdown(signal)` | not called — you are awaiting it |
| A signal | not called — nothing is trapped |
| An uncaught exception in your process | not called — not this library's business |
| The server died unasked | **called** with PostgreSQL's exit code |

Supply nothing and nothing happens. The process stays up with no database behind it, which is logged as an error precisely because it is otherwise silent. Deciding that a dead database should take the program with it is the program's call. A test harness, a provisioning step, or anything that wanted a database for a while may have somewhere to carry on to.

`dispose()` takes off the `exit` hook once no server needs it, and nothing else:

```ts
const server = new LocalDevDBServer(config);

try {
  await server.start();
  // ...
} finally {
  await server.stop();
  server.dispose();
}
```

Because the lifecycle already does this, `dispose()` is rarely needed: `start()` puts the hook on and the shutdown takes it off, so an instance sitting idle between cycles holds nothing. What is left for it is releasing an instance whose server could not be stopped, and belt-and-braces teardown. It is idempotent, and `start()` registers again, including on the path where it finds the server already running, so a disposed instance can still be reused. Where several servers are running, disposing one leaves the hook in place for the others.

Stop the server before disposing it, as the example does. Disposing one that still holds a child takes it out of the set the `exit` hook protects, so that server can outlive the program that started it. It is allowed rather than an error, since an instance being torn down for some other reason should not be made to throw, and it warns to the logger.

Keep your own handler's shutdown to a single `await`. Calling `process.exit()` on `SIGINT` while `shutdown()` is still escalating cuts it off part-way through, which can leave a data directory needing recovery. Exit from the `.then`, as the example does, not alongside it.

#### Probing for a Running Server

`getLocalDevDBServerStatus()` answers the question a `LocalDevDBServer` instance cannot: whether a server is running for a data directory right now, including one left by a previous run or started by another process. It reads PostgreSQL's own `postmaster.pid` and Strataline's PID record rather than any in-memory state, so it works from a fresh process, a different tool, or a script that never constructs a server at all. Both it and the PID utilities it is built on are exported from `strataline/local-dev-db-server`.

```ts
import { getLocalDevDBServerStatus } from "strataline/local-dev-db-server";

const status = await getLocalDevDBServerStatus({
  pidFile: PID_FILE,
  dataDir: DATA_DIR,
  // Optional. Only consulted when the file and process checks cannot decide,
  // and then the server is asked for its own data_directory, which is identity
  // rather than inference.
  connection: {
    port: 5433,
    user: "myapp_user",
    password: "myapp_pass",
    database: "myapp_dev",
  },
});

if (status.running || status.indeterminate) {
  throw new Error(`Refusing to reset the data directory: ${status.reason}`);
}
```

**Three answers, not two.** This is the whole point of the shape, and the reason `running: false` is not a license to do anything destructive:

| Field | Meaning |
| --- | --- |
| `running: true` | A process was found **and** positively verified as this cluster's server |
| `indeterminate: true` | Something is alive at the recorded PID and it could not be tied to this server either way |
| `stale: true` | A record was found that could not be verified, with `staleKind` saying why |

A caller about to do something irreversible, dropping a data directory or deleting a PID record, should refuse on `running || indeterminate`. `running: false` on its own means "no server was verified", never "nothing is running", and treating the second as the first is how a live server's data directory gets deleted out from under it.

`staleKind` says what kind of evidence produced a stale answer, and the difference is the same one: `process-gone`, `recycled`, and `different-cluster` are positive evidence that the recorded server is gone, while `indeterminate` is the absence of evidence.

The rest of the result carries what was found: `pid`, `startedAt`, `dataDir`, `port`, a `source` of `"postmaster"`, `"pid-file"`, `"connection"`, or `"none"` saying which check settled it, and a `reason` phrased for a person and suitable for dropping straight into a log line or the refusal message above. `observedStartTime` is the operating system's own start time for `pid`, sampled during the verification that identified it, for a caller that intends to signal the process: sampling it again afterwards would be a fresh observation that may describe a different process, since a PID is reused the moment its owner exits.

Identification uses the process command line, start time, current boot, data directory, and owning uid, whichever the platform supplies. `DevDBServerStatus`, `DevDBStatusOptions`, `DevDBStaleKind`, and `DevDBStatusSource` are all exported if you want the named types.

#### Using With Your Application

Once the dev server is running, configure your application to connect to it:

```typescript
// In your application code
import { Pool } from "pg";

const pool = new Pool({
  // 127.0.0.1 rather than "localhost", which can resolve to ::1. The dev
  // server listens on IPv4 only, deliberately: on some hosts PostgreSQL's
  // per-connection backends fail to set TCP_NODELAY on an IPv6 socket.
  host: "127.0.0.1",
  port: 5433, // Match your dev server port
  user: "myapp_user", // Match your dev server user
  password: "myapp_pass", // Match your dev server password
  database: "myapp_dev", // Match your dev server database
});
```

Or use a connection string:

```typescript
const pool = new Pool({
  connectionString:
    "postgresql://myapp_user:myapp_pass@127.0.0.1:5433/myapp_dev",
});
```

This approach gives you a real PostgreSQL instance for development without the overhead of Docker or manual PostgreSQL installation, while maintaining data persistence for a smooth development experience.

#### Git Configuration

Add the following to your `.gitignore` to exclude the PostgreSQL data directory and PID file from version control:

```gitignore
# PostgreSQL data directory and PID file for local development
/pgdata
.pg_pid
```

### Locale and Collation

Both embedded helpers (Test DB Instance and Local Dev DB Server) initialize PostgreSQL with `--locale=C --encoding=UTF8`. The cluster still stores full Unicode (UTF-8) text. Only the **default sort order** is set to `C` (byte order) rather than a language-specific locale.

This is deliberate. Letting `initdb` inherit the host or CI locale causes two problems. A Linux-style locale such as `LC_ALL=C.UTF-8` makes `initdb` **fail outright on macOS** because macOS libc has no `C.UTF-8`, and an inherited locale makes text sort differently on each developer's machine. Pinning `C` gives the same deterministic ordering everywhere and avoids the index-breaking "collation version mismatch" issues that libc locales such as `en_US.UTF-8` can cause across OS upgrades.

**What This Affects, and What It Doesn't.** Collation applies only to **text** types, and only as the default when a query or column does not specify otherwise. The resolution order is an explicit `COLLATE` in the query, the column's collation, then the database default. It has **no effect** on ordering by timestamps, numbers, `uuid`s, or ULIDs:

- `timestamptz`, `timestamp`, integers, and `uuid` are non-text types, always sorted by value regardless of collation.
- ULIDs stored as **text** are canonical Crockford base32 (`0-9A-Z`), which is time-ordered and sorts the same whether the collation is `C` or a locale. Normalize them to uppercase on the way in, and validate them if they come from external sources. Crockford is case-insensitive, and mixed case would sort inconsistently under `C` because uppercase bytes sort before lowercase.

The `C`-versus-locale difference only appears on **human-language text** with mixed case or accents, for example, `"Zebra"` sorts before `"apple"` under `C`. If you need dictionary-style ordering, set it explicitly with a per-column or per-query `COLLATE` rather than relying on the database default:

```sql
-- per query, in the user's language
SELECT * FROM people ORDER BY last_name COLLATE "es-ES-x-icu";

-- or pin it on the column that needs it
CREATE TABLE people (last_name text COLLATE "en-US-x-icu");
```

Being explicit is the recommended pattern regardless of this library:

- **Correctness:** One cluster-wide collation cannot be right for English, Spanish, German, and every other language at the same time. Only the query or column knows which language it is ordering.
- **You May Not Control the Default:** Managed providers often fix the cluster collation, and a database's collation cannot be changed after it is created without a dump and restore. Per-column and per-query `COLLATE` always work.
- **Portability:** Your real production database is a separate, managed PostgreSQL instance with its own collation. `--locale=C` governs only the local embedded dev and test databases, never production. Setting collation explicitly keeps ordering consistent across local, CI, and production databases instead of silently depending on each environment's default.

## Development

Strataline is built with TypeScript and uses modern JavaScript features.

```bash
# Install dependencies
bun install

# Build the project
bun run build

# Run tests
bun test
```

When preparing a new release:

1. Update the version in `package.json`
2. Run the build command, which automatically updates the README version

```bash
# Build the project, including the README version update
bun run build
```

The build process runs the `update-docs` script defined in `package.json` before bundling. It regenerates the README table of contents with `markdown-toc-gen`, synchronizes the README version with `package.json` through `scripts/update-readme-version.ts`, and formats the docs. You can then publish the package to npm:

```bash
bun publish
```

Commit the release version changes after publishing.
