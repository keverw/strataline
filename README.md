# Strataline v3.0.1

todo: bump to v4.0.0 since imports changed....

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
  - [Using the Built-in CLI Helper](#using-the-built-in-cli-helper)
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
- [Backpressure Handling](#backpressure-handling)
- [Graceful Shutdown & Cancellation](#graceful-shutdown--cancellation)
- [Metadata & Checkpoints](#metadata--checkpoints)
- [Logging & Schema Helpers](#logging--schema-helpers)
  - [Logging](#logging)
    - [Logger Module](#logger-module)
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
    - [Using with Your Application](#using-with-your-application)
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
        // In job mode, we process all data unless a specific payload is provided
        const { startId, endId } = ctx.payload || {
          startId: 0,
          endId: Number.MAX_SAFE_INTEGER,
        };

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
    // Do the actual work for this batch (or all data if no payload)
    const { startId = 0, endId = Number.MAX_SAFE_INTEGER } = ctx.payload || {};

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
> - If you call `ctx.defer(reason, data?)`, the migration will be paused. `afterSchema` and any subsequent migrations will not run until you rerun the job and it calls `ctx.complete()`. This enables staged rollouts, retries, or background processing. The optional `data` is returned to the **immediate caller**. From a **worker** it comes back in `DataMigrationJobResult.data` (you forward/aggregate it however you like), and from the **orchestrator** pass it lands in `MigrationResult.migrationData`. To carry worker state across runs, the **orchestrator** may persist it via the [metadata column](#metadata--checkpoints), while a worker cannot, as described below.
> - Strataline is backend-agnostic: you can use any job scheduler, queue system, thread pool, or orchestration framework to schedule and monitor jobs as needed.
>
> **The Orchestrator Owns Migration State. Workers Don't.** `runDataMigrationJobOnly` is a thin wrapper that runs your migration function for one batch (pass the batch via `payload`) and **returns the result to you**. It writes **nothing** to `migration_status`, including `migration_complete`, `metadata`, `attempts`, `last_error`, or anything else, and it **never touches the migration lock**. There is no acquire, renew, or release because your job system controls worker concurrency. So when a worker calls `ctx.complete()`, that just tells _your_ job system its batch succeeded. It does **not** mark the whole migration done. Only the orchestrator pass (`runSchemaChanges`) writes migration state. It marks `migration_complete` and persists `metadata` once _it_ confirms all jobs finished. This is deliberate: it prevents the footgun where one finished batch would prematurely flip the whole migration complete and let `afterSchema` run early. (A worker can still _read_ `ctx.metadata` as read-only data, but for a worker the `payload` you pass in is usually the better way to hand it its slice/checkpoint, since you control it directly per call.)

## Running Migrations

Strataline provides flexible options for running database migrations. Since it's designed as a library rather than a CLI tool, you have complete control over how migrations are executed. You can either use our convenient built-in CLI helper to get started quickly or create a custom migration script for more advanced scenarios.

### Using the Built-in CLI Helper

For quick development or simpler use cases, Strataline provides a convenient CLI helper function called `RunStratalineCLI`. This function handles command parsing and execution for you with minimal setup.

#### Basic Setup

Create a script file to run your migrations:

```typescript
// scripts/db-migrate.ts

// Load environment variables - this is only needed if you are using Node.js, Bun does not need it
// import 'dotenv/config'

import { RunStratalineCLI, createCLIConsoleLogger } from "strataline/cli";
import { migrations } from "../path/to/your/migrations";

// Use the built-in CLI console logger
// You can customize this or implement your own logger if needed
const logger = createCLIConsoleLogger(true);

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

#### Exit Codes

`RunStratalineCLI` resolves with a `StratalineCLIResult` that includes a suggested `exitCode`, so a wrapper script can distinguish outcomes. A genuine **error is thrown** (not returned), so callers that only `.catch()` still exit non-zero.

| Outcome     | `exitCode` | Behavior                                            |
| ----------- | ---------- | --------------------------------------------------- |
| `completed` | `0`        | Returned                                            |
| `error`     | `1`        | **Thrown** (caller's `.catch` maps to 1)            |
| `deferred`  | `2`        | Returned because a migration paused itself          |
| `locked`    | `3`        | Returned because another process holds the lock     |
| `aborted`   | `4`        | Returned because graceful shutdown was requested    |
| `lock_lost` | `5`        | Returned because the lock was lost mid-run (unsafe) |

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

      // Always show migrations that were already applied in previous runs (even if none)
      console.log(
        `Previously applied: ${result.previouslyAppliedMigrations?.join(", ") || "none"}`,
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
      console.error(`❌ Migration failed: ${result.reason}`);
      console.log(
        `Completed migrations in this run: ${result.completedMigrations.join(", ") || "none"}`,
      );

      if (
        result.previouslyAppliedMigrations &&
        result.previouslyAppliedMigrations.length > 0
      ) {
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

      process.exit(1);
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

1. You run `runSchemaChanges('distributed')` to apply schema changes. The result may contain `migrationData` from any migrations that completed during this run, which could include data returned by migrations that ran inline that called `ctx.complete(data)` or `ctx.defer(reason, data)`.
2. Your infrastructure determines how to split the data (e.g., by user ID ranges).
3. For each batch, you call `runDataMigrationJobOnly(migrationId, payload)`. This function executes the `migration` part of your defined migration for that specific `migrationId` and `payload`.
   - If the migration calls `ctx.complete(data)` or `ctx.defer(reason, data)`, the `data` provided there will be returned in the `data` field of the `DataMigrationJobResult`.
   - The overall result will be an object like `{ status: 'success', reason?: string, data?: TReturn }`.
4. Each batch runs as a separate job, processing just its portion of the data. The `data` returned in the `DataMigrationJobResult` can be used for logging, monitoring, or further orchestration.
5. Your infrastructure handles scheduling, retries, and monitoring based on the `status`, `reason`, and `data` from `runDataMigrationJobOnly`.

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
  migrationData?: Record<string, any>; // Data returned by successful migrations
}
```

### Error Handling

Strataline provides two levels of error information:

- **`reason`**: Always a formatted string message suitable for display in logs/CLI output
- **`error`**: Raw Error object with stack trace, only present for unhandled exceptions (not for controlled migration phase errors)

The built-in CLI shows both the `reason` (always) and `error` details with stack trace (when available) to help with debugging.

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
- **Workers are cancelled the same way**, with one return-value asymmetry: `runDataMigrationJobOnly(id, payload, { signal })` exposes `ctx.signal`, but `"aborted"` is only ever a `runSchemaChanges` result. A cancelled worker should `ctx.defer()`, so its `DataMigrationJobResult` comes back as `"deferred"` (retry this batch later), never `"aborted"`. Lock loss doesn't apply to workers either because `runDataMigrationJobOnly` never acquires the lock or runs the renewal timer. Only `runSchemaChanges` does.

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

## Logging & Schema Helpers

Strataline provides robust logging and schema helper utilities to make migrations safer and more traceable:

### Logging

- All migration phases and helpers use a `Logger` interface for structured logs and errors.
- By default, logs are sent to the console, but you can provide your own logger by passing it to the `MigrationManager`.
- The migration system automatically adds contextual information to logs:
  - The migration ID is used as the `task` field
  - The current phase (beforeSchema, migration, afterSchema) is used as the `stage` field
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

A few lower-level building blocks are also exported from `strataline/migration` for advanced use: the `LogData` / `LogLevel` / `LogDataInput` types, the `buildLogPrefix` and `getErrorMessage` helpers, a `MutableLogger` (wraps another logger and can be toggled on/off via `setVerbose`, handy in tests), and `PrefixedLogger` (the internal class behind `createPrefixed`. Prefer `createPrefixed`/`createPrefixedLogger` over constructing it directly). Most users only need `BaseLogger`, `ConsoleLogger`, and `consoleLogger`.

##### Creating Custom Loggers

You can create your own logger by extending the `BaseLogger` class:

```typescript
import { BaseLogger, LogDataInput } from "strataline/migration";

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

> **Schema Resolution:** Existence checks resolve relations through Postgres's `to_regclass` / `pg_catalog`, so they honour the connection's `search_path` and accept schema-qualified names (e.g. `"reporting.users"`). The check looks in the same place the subsequent DDL will run, not blindly across every schema. Note that table, column, index, and constraint **names are written directly into the SQL statement**. SQL placeholders (`$1`, `$2`, …) can only stand in for _values_ (data), never for identifiers like table or column names, so those names can't be parameterized and must be concatenated in. Treat them as trusted, code-defined values. Don't build them from untrusted input.

**Available Helpers:**

- **`createTable(client, tableName, columns, constraints?)`**: Creates a table if it doesn't exist.
  - `columns`: An object mapping column names to their types (e.g., `{ id: "SERIAL PRIMARY KEY", name: "TEXT NOT NULL" }`).
  - `constraints` (optional): An array of strings defining table constraints (e.g., `["CONSTRAINT uq_email UNIQUE (email)"]`).
- **`addColumn(client, tableName, columnName, columnType, defaultValue?)`**: Adds a column to a table if it doesn't exist. Throws an error if the table does not exist.
  - `defaultValue` (optional): A default value for the new column.
- **`removeColumn(client, tableName, columnName)`**: Removes a column from a table if it exists. Throws an error if the table does not exist. Logs a message if the column doesn't exist.
- **`addIndex(client, tableName, indexName, columns, unique?)`**: Adds an index to a table if it doesn't exist. Throws an error if the table does not exist.
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

The `started_at`, `attempts`, and `last_error` columns are observability aids that make a stuck or repeatedly-deferred migration debuggable straight from the table. The `metadata` column holds freeform JSON the migration persists for itself. See [Metadata & Checkpoints](#metadata--checkpoints). `attempts` increments at the start of every attempt, including attempts that `defer()` or error, not just successful ones (note: the distributed-mode `runDataMigrationJobOnly` path does not increment it). `started_at` is stamped once on the first attempt, and `last_error` is set on any failure or `defer()` and cleared on successful completion. Existing tables created by older versions (prior to 4.0.0) are upgraded automatically (`ADD COLUMN IF NOT EXISTS`) the next time the migration system initializes.

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

- **Owner (`locked_by`)** is a per-process identifier of the form `<host>-<pid>-<timestamp>`, where `<host>` is `process.env.HOSTNAME`, falling back to `os.hostname()`. `lock_name` is a separate column and is always the constant `"database_migrations"`.
- **Lease Window (`lockExpirySeconds`):** How long an acquired lock stays valid before another process may take it over. Default `300` (5 minutes), configurable via the `MigrationManager` constructor.
- **Renewal (`lockRenewalSeconds`):** While `runSchemaChanges` is running, the lock's `lock_expires_at` is pushed forward every `lockRenewalSeconds` (default `60`, configurable via the `MigrationManager` constructor). The constructor **validates** this against the lease: `lockRenewalSeconds` must be a positive, finite number no greater than **half** `lockExpirySeconds`, so the lease can survive at least one missed renewal. A value outside that range (or a non-positive/non-finite `lockExpirySeconds`) throws at construction rather than silently risking concurrent migrations.
- **Normal Release:** The lock row is deleted in a `finally` block when `runSchemaChanges` finishes (success or failure).
- **Crash Recovery:** If a process dies without releasing the lock, the row remains until `lock_expires_at` passes. The next runner then takes it over (the stale row is overwritten, not left forever). The takeover hinges on detecting the unique-violation on re-insert by its SQLSTATE code (`23505`), not by parsing the error text, so it works regardless of the server's `lc_messages` locale. In practice the lock self-heals within one lease window (`lockExpirySeconds`, default ~5 minutes) of a crash.
- **Caveat:** If a single data migration runs longer than `lockExpirySeconds` **and** renewal stops (e.g. the renewal timer is starved or the event loop is blocked long enough to miss every renewal), another process could acquire the lock and run concurrently. Lock-loss is detected at phase boundaries (and renewals are reactive, not preventive), so keep individual phases well under the lease window, or raise the renewal cadence / lengthen the lease, for long-running work. **Long-running data migrations should also poll `ctx.signal.aborted` (or listen for its `"abort"` event) and wind down promptly. Stop work and return.** A migration that watches the signal shrinks the concurrency window. One that ignores it keeps running on the pool until it finishes, since **its own in-flight data SQL isn't fenced by the lock**. That's the one thing Strataline can't gate. Strataline's own state writes _are_ fenced (a write after the lock is lost no-ops, see [Graceful Shutdown & Cancellation](#graceful-shutdown--cancellation)), and it won't run `afterSchema` or mark completion without the lock. So the worst case is duplicated/again-idempotent data work, never a half-applied schema or a falsely-completed migration.

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
import {
  TestDatabaseInstance,
  createTestDBConsoleLogger,
} from "strataline/test-db-instance";
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

// Or get connection credentials for direct connection
const credentials = testDb.getCredentials();

// Reset the database (drops all tables and reapplies migrations if provided)
await testDb.reset();

// Stop the database and clean up resources
await testDb.stop();
```

#### Logging

You can use the built-in console logger or implement your own:

```typescript
// Use the built-in console logger with options
const testDb = new TestDatabaseInstance({
  logger: createTestDBConsoleLogger(
    true, // true enables verbose PostgreSQL logs
    true, // true enables verbose migration logs
  ),
});

// Or implement your own logger
const customLogger = (
  type:
    | "info"
    | "error"
    | "warn"
    | "pg"
    | "migrate-info"
    | "migrate-error"
    | "migrate-warn",
  message: string,
) => {
  // Types: info/error/warn (general), pg (PostgreSQL server), migrate-info/migrate-error/migrate-warn (Strataline migrations)
  console.log(`[${type.toUpperCase()}] ${message}`);
};
```

##### Migration Logging

The TestDatabaseInstance automatically creates a Strataline-compatible logger adapter that works with or without a provided logger:

- If you provide a logger, migration logs will be sent through your logger with the appropriate type:
  - `migrate-info`: For informational migration logs
  - `migrate-error`: For migration errors
  - `migrate-warn`: For migration warnings
- If you don't provide a logger, migrations will run silently with no logs

When you provide a logger to TestDatabaseInstance, it will:

1. Use that logger for its own operation logs (info, error, warn)
2. Use that logger for PostgreSQL logs (pg)
3. Automatically create an adapter to send Strataline migration logs through the same logger (migrate-info, migrate-error, migrate-warn)

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
import {
  LocalDevDBServer,
  createDevDBConsoleLogger,
} from "strataline/local-dev-db-server";

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
  onExit: (exitCode) => process.exit(exitCode), // Optional: custom exit handler
  logConnections: false, // Optional: enable PostgreSQL connection logging (default: false)
});
```

> **Note on Required Fields:** `port`, `user`, `password`, `database`, `dataDir`, and `pidFile` are all required (TypeScript enforces this). Only `logger`, `onExit`, and `logConnections` are optional. This differs from the [Test DB Instance](#test-db-instance), where everything, including the port, is optional and a free port is auto-assigned, because test databases are throwaway and isolated while the dev server is long-lived and shared with your app.

**Note:** The server automatically creates the specified user, password, and database during startup. You don't need to create these manually - just specify the credentials you want to use and the server will set them up for you.

**Exit Handling:** By default, the server calls `process.exit()` when it needs to terminate (e.g., when the PostgreSQL process exits or during cleanup). For testing or custom scenarios, you can provide an `onExit` callback to handle termination differently.

#### Logging

You can customize logging behavior using the built-in console logger:

```typescript
import { createDevDBConsoleLogger } from "strataline/local-dev-db-server";

// Create a logger with custom verbosity settings
const logger = createDevDBConsoleLogger(
  true, // pgVerbose: show PostgreSQL server logs
  true, // setupVerbose: show setup/initialization logs
);

// Or implement your own logger
const customLogger = (
  type: "info" | "error" | "warn" | "pg" | "setup",
  message: string,
) => {
  // Types: info/error/warn (general), pg (PostgreSQL server), setup (initialization)
  console.log(`[${type.toUpperCase()}] ${message}`);
};
```

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

- **Automatic Cleanup**: Handles graceful shutdown on `Ctrl+C` or process termination
- **Stale Process Detection**: Automatically cleans up any existing PostgreSQL processes on startup
- **PID File Management**: Tracks the server process ID for reliable cleanup
- **Signal Handling**: Responds to `SIGINT`, `SIGTERM`, and `SIGHUP` signals

#### Using with Your Application

Once the dev server is running, configure your application to connect to it:

```typescript
// In your application code
import { Pool } from "pg";

const pool = new Pool({
  host: "localhost",
  port: 5433, // Match your dev server port
  user: "myapp_user", // Match your dev server user
  password: "myapp_pass", // Match your dev server password
  database: "myapp_dev", // Match your dev server database
});
```

Or using a connection string:

```typescript
const pool = new Pool({
  connectionString:
    "postgresql://myapp_user:myapp_pass@localhost:5433/myapp_dev",
});
```

This approach gives you a real PostgreSQL instance for development without the overhead of Docker or manual PostgreSQL installation, while maintaining data persistence for a smooth development experience.

#### Git Configuration

Add the following to your `.gitignore` to exclude the PostgreSQL data directory and PID file from version control:

```gitignore
# PostgreSQL data directory and PID file - for local development
/pgdata
.pg_pid
```

### Locale and Collation

Both embedded helpers (Test DB Instance and Local Dev DB Server) initialize PostgreSQL with `--locale=C --encoding=UTF8`. The cluster still stores full Unicode (UTF-8) text. Only the **default sort order** is set to `C` (byte order) rather than a language-specific locale.

This is deliberate. Letting `initdb` inherit the host/CI locale causes two problems: a Linux-style locale such as `LC_ALL=C.UTF-8` makes `initdb` **fail outright on macOS** (macOS libc has no `C.UTF-8`), and an inherited locale makes text sort differently on each developer's machine. Pinning `C` gives the same, deterministic ordering everywhere and avoids the index-breaking "collation version mismatch" issues that libc locales (like `en_US.UTF-8`) can cause across OS upgrades.

**What This Affects, and What It Doesn't.** Collation only applies to **text** types, and only as the _default_ when a query or column doesn't specify otherwise (resolution order: explicit `COLLATE` in the query → the column's collation → the database default). So it has **no effect** on ordering by timestamps, numbers, `uuid`s, or ULIDs:

- `timestamptz` / `timestamp`, integers, and `uuid` are non-text types, always sorted by value, regardless of collation.
- ULIDs stored as **text** are canonical Crockford base32 (`0-9A-Z`), which is time-ordered and sorts the same whether the collation is `C` or a locale. Just normalize them to uppercase on the way in (and validate them if they come from external sources). Crockford is case-insensitive, and mixed case would sort inconsistently under `C` (uppercase bytes sort before lowercase).

The `C`-vs-locale difference only shows up on **human-language text** with mixed case or accents (e.g. `"Zebra"` sorts before `"apple"` under `C`). If you need dictionary-style ordering, set it explicitly with a per-column or per-query `COLLATE` rather than relying on the database default:

```sql
-- per query, in the user's language
SELECT * FROM people ORDER BY last_name COLLATE "es-ES-x-icu";

-- or pin it on the column that needs it
CREATE TABLE people (last_name text COLLATE "en-US-x-icu");
```

Being explicit is the recommended pattern regardless of this library:

- **Correctness:** One cluster-wide collation can't be right for English, Spanish, German, etc. at the same time. Only the query or column knows which language it's ordering.
- **You May Not Control the Default:** Managed providers often fix the cluster collation, and a database's collation can't be changed after it's created (short of a dump/restore). Per-column and per-query `COLLATE` always work.
- **Portability:** Your real production database is a separate, managed PostgreSQL instance with its own collation. `--locale=C` only governs the local embedded dev/test databases, never prod. Setting collation explicitly is what keeps ordering consistent across all of them (local, CI, production) instead of silently depending on whatever default each environment happens to have.

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
2. Run the build command, which will automatically update the README version

```bash
# Build the project (includes README version update)
bun run build
```

The build process runs the `update-docs` script defined in package.json before bundling. It regenerates the README table of contents (`markdown-toc-gen`), synchronizes the README version with package.json (`scripts/update-readme-version.ts`), and formats the docs (`format:docs`). Afterwards, you can publish the package to npm:

```bash
# Publish to npm
bun publish
```

Make sure to commit the new version back to GIT
