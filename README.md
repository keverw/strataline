# Strataline

[![npm version](https://badge.fury.io/js/strataline.svg)](https://badge.fury.io/js/strataline)

**Strataline** is a structured migration system for PostgreSQL that treats database changes as layered, resumable operations—built to scale from small projects to distributed, orchestrated systems.

The name **Strataline** comes from:

- **Strata**: representing the _layers_ of a database migration—schema changes, data backfills, and cleanup steps
- **Line**: reflecting the _path or flow_ each migration takes, whether inline or across distributed systems

## Key Features

- **Phased Migration Approach**: Each migration is separated into three distinct phases:

  - `beforeSchema`: Transactional DDL changes before data work
  - `migration`: Data transformation logic with support for inline or distributed execution
  - `afterSchema`: Optional final cleanup (e.g., setting NOT NULL, dropping old columns)

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
import { MigrationManager } from "strataline";

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

        ctx.logger.log({
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

        ctx.logger.log({
          message: `Successfully processed ${rows.length} users`,
        });

        // Mark migration as complete
        ctx.complete();
      } else if (ctx.mode === "distributed") {
        // In distributed mode, we would expect a specific payload
        // and would typically only process a subset of data
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
  } else {
    console.error("Migration failed:", result.reason);
  }
}

runMigrations().catch(console.error);
```

### Distributed Mode (Orchestrated)

In distributed mode, your infrastructure acts as a router, scheduler, and monitor. The migration system applies schema changes, then your infrastructure is responsible for dividing the data and scheduling jobs for each batch by calling `runDataMigrationJobOnly` with a payload for each job.

**How it works:**

1. Call `runSchemaChanges('distributed')` to apply schema changes and get a list of pending migrations.
2. For each migration, call the migration function. In distributed mode, the batching and job scheduling logic can happen inside the migration function itself.
   - If no payload is provided, the migration function discovers the data to process, splits it into batches, schedules jobs for each batch (using your job system), and then calls `ctx.defer('Batches scheduled')`.
   - If a payload is provided, the migration function processes just that batch and then calls `ctx.complete()`.

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
    ctx.logger.log({ message: `Scheduled ${batches.length} batch jobs` });

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
    ctx.logger.log({
      message: `Processing users from ID ${startId} to ${endId}`,
    });
    // ... process all or the specified range ...
    ctx.complete();
  }
};
```

> **Important:**
>
> - In this pattern, `distributed` mode is for orchestration only: it discovers data, splits into batches, schedules jobs (each as a `job`), and monitors job completion. It never processes data directly.
> - After scheduling jobs, the distributed mode should check if all jobs are complete. If not, call `ctx.defer()` to pause and retry later. Only call `ctx.complete()` when all jobs are finished—this allows afterSchema and subsequent migrations to proceed.
> - All actual data processing happens in `job` mode, which can process all data or just a batch (if a payload is provided).
> - If you call `ctx.defer()`, the migration will be paused: `afterSchema` and any subsequent migrations will not run until you rerun the job and it calls `ctx.complete()`. This enables staged rollouts, retries, or background processing.
> - Strataline is backend-agnostic: you can use any job scheduler, queue system, thread pool, or orchestration framework to schedule and monitor jobs as needed.

````

> **Important:**
> - The migration function is called once per batch. Splitting into batches and scheduling jobs is handled by your orchestration code, not inside the migration function.
> - If you call `ctx.defer()`, the migration will be paused: `afterSchema` and any subsequent migrations will not run until you rerun the job and it calls `ctx.complete()`. This allows for staged rollouts, retries, or background processing.
> - The migration function should always check `ctx.mode` and process accordingly:
>   - In `distributed` mode, only process the batch described by the payload. Use `ctx.defer('reason')` to pause, retry, or indicate that a job was scheduled for background work (e.g., via a job queue, thread pool, or cloud task).
>   - In `job` mode, you can process all data at once, or a specific range if a payload is provided. You can also use `ctx.defer()` to implement staged rollouts or pause for backpressure.
>
> Strataline is backend-agnostic: you can use it with any job scheduler, queue system, thread pool, or orchestration framework.

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
1. You run `runSchemaChanges('distributed')` to apply schema changes
2. Your infrastructure determines how to split the data (e.g., by user ID ranges)
3. For each batch, you call `runDataMigrationJobOnly(migrationId, payload)`
4. Each batch runs as a separate job, processing just its portion of the data
5. Your infrastructure handles scheduling, retries, and monitoring

This approach allows you to:
- Process data in parallel across multiple machines
- Limit the impact of any single migration job
- Implement sophisticated retry and monitoring logic
- Handle backpressure and staged rollouts

## Backpressure Handling

The `defer()` function can be called from within a migration to pause work and retry later. This is useful for:
- Handling backpressure when the system is under load
- Implementing staged rollouts of data changes
- Pausing when rate limits are reached
- Recovering from temporary failures
- Spawning background tasks in distributed mode and exiting to check status later

When a migration calls `defer()`, the current execution stops and should be retried later by your orchestration system. This is particularly powerful in distributed mode, where you might:

1. **Spawn Background Tasks**: Start a long-running process and defer the migration to check its status later
2. **Implement Circuit Breakers**: Detect system load and defer processing during peak times
3. **Create Staged Rollouts**: Process data in waves, deferring between each wave to monitor system health
4. **Handle External Dependencies**: Defer when dependent systems are unavailable or rate-limited

The `defer()` function accepts an optional reason parameter that can be used to provide context for why the migration was paused, which can be useful for monitoring and debugging.

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
  ctx.logger.log({ message: 'Starting migration batch' });
  // ...
  ctx.logger.error({ message: 'Something went wrong', error: err });
  // Output includes: [migration-id] [dataMigration] Something went wrong
}
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

##### Creating Custom Loggers

You can create your own logger by extending the `BaseLogger` class:

```typescript
import { BaseLogger, LogDataInput } from 'strataline';

// Create a custom logger that sends logs to a service
class ApiLogger extends BaseLogger {
  log(data: LogDataInput): void {
    // Send log to your logging service
    apiClient.sendLog({
      level: 'info',
      message: data.message,
      context: {
        task: data.task,
        stage: data.stage
      }
    });
  }

  error(data: LogDataInput): void {
    // Send error to your logging service
    apiClient.sendLog({
      level: 'error',
      message: data.message,
      error: data.error,
      context: {
        task: data.task,
        stage: data.stage
      }
    });
  }

  warn(data: LogDataInput): void {
    // Send warning to your logging service
    apiClient.sendLog({
      level: 'warn',
      message: data.message,
      context: {
        task: data.task,
        stage: data.stage
      }
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
  task: 'my-task',
  stage: 'initialization'
});

// All logs will include the prefixes
prefixedLogger.log({ message: 'Starting process' });
// Output includes: [my-task] [initialization] Starting process
```

### Schema Helpers

The `helpers` object, passed as the second argument to `beforeSchema` and `afterSchema` functions, provides a set of safe, idempotent methods for common schema modifications. These helpers automatically log their actions using the configured logger and perform existence checks before attempting changes, preventing errors if an object already exists or doesn't exist when trying to remove it.

**Available Helpers:**

-   **`createTable(client, tableName, columns, constraints?)`**: Creates a table if it doesn't exist.
    -   `columns`: An object mapping column names to their types (e.g., `{ id: "SERIAL PRIMARY KEY", name: "TEXT NOT NULL" }`).
    -   `constraints` (optional): An array of strings defining table constraints (e.g., `["CONSTRAINT uq_email UNIQUE (email)"]`).
-   **`addColumn(client, tableName, columnName, columnType, defaultValue?)`**: Adds a column to a table if it doesn't exist. Throws an error if the table does not exist.
    -   `defaultValue` (optional): A default value for the new column.
-   **`removeColumn(client, tableName, columnName)`**: Removes a column from a table if it exists. Throws an error if the table does not exist. Logs a message if the column doesn't exist.
-   **`addIndex(client, tableName, indexName, columns, unique?)`**: Adds an index to a table if it doesn't exist. Throws an error if the table does not exist.
    -   `columns`: An array of column names to include in the index.
    -   `unique` (optional, default `false`): Whether to create a unique index.
-   **`removeIndex(client, indexName)`**: Removes an index if it exists. Logs a message if the index doesn't exist.
-   **`addForeignKey(client, tableName, constraintName, columnName, referencedTable, referencedColumn, onDelete?)`**: Adds a foreign key constraint if it doesn't exist. Throws an error if the table or referenced table does not exist.
    -   `onDelete` (optional, default `'NO ACTION'`): Action to take on delete (`CASCADE`, `SET NULL`, `RESTRICT`, `NO ACTION`).
-   **`removeConstraint(client, tableName, constraintName)`**: Removes a constraint (like a foreign key or check constraint) if it exists. Throws an error if the table does not exist. Logs a message if the constraint doesn't exist.

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
  last_updated BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::bigint  -- Last update timestamp
)
```

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

## Development

Strataline is built with TypeScript and uses modern JavaScript features.

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```
````
