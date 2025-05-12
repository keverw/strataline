import { type PoolClient } from "pg";

/**
 * Log level type
 */
export type LogLevel = "info" | "warn" | "error";

/**
 * Log data input structure (without level, which is determined by the method called)
 */
export interface LogDataInput {
  task?: string;
  stage?: string;
  message: string;
  error?: any;
}

/**
 * Complete log data structure (with level)
 */
export interface LogData extends LogDataInput {
  level: LogLevel;
}

/**
 * Logger interface for schema operations
 */
export interface SchemaLogger {
  log: (data: LogDataInput) => void;
  error: (data: LogDataInput) => void;
  warn?: (data: LogDataInput) => void;
}

/**
 * Default console logger implementation
 */
export const consoleLogger: SchemaLogger = {
  log: (data: LogDataInput) => {
    const logData: LogData = { ...data, level: "info" };
    const prefix = buildLogPrefix(logData);
    console.log(`${prefix}${logData.message}`);
  },
  error: (data: LogDataInput) => {
    const logData: LogData = { ...data, level: "error" };
    const prefix = buildLogPrefix(logData);
    console.error(`${prefix}${logData.message}`, logData.error);
  },
  warn: (data: LogDataInput) => {
    const logData: LogData = { ...data, level: "warn" };
    const prefix = buildLogPrefix(logData);
    console.warn(`${prefix}${logData.message}`);
  },
};

/**
 * Build a log prefix from structured log data
 */
function buildLogPrefix(data: LogData): string {
  const parts: string[] = [];

  if (data.task) {
    parts.push(`[${data.task}]`);
  }

  if (data.stage) {
    parts.push(`[${data.stage}]`);
  }

  return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

/**
 * Schema helpers interface
 */
export interface SchemaHelpers {
  createTable: (
    client: PoolClient,
    tableName: string,
    columns: Record<string, string>,
    constraints?: string[],
  ) => Promise<void>;

  addColumn: (
    client: PoolClient,
    tableName: string,
    columnName: string,
    columnType: string,
    defaultValue?: string,
  ) => Promise<void>;

  removeColumn: (
    client: PoolClient,
    tableName: string,
    columnName: string,
  ) => Promise<void>;

  addIndex: (
    client: PoolClient,
    tableName: string,
    indexName: string,
    columns: string[],
    unique?: boolean,
  ) => Promise<void>;

  removeIndex: (client: PoolClient, indexName: string) => Promise<void>;

  addForeignKey: (
    client: PoolClient,
    tableName: string,
    constraintName: string,
    columnName: string,
    referencedTable: string,
    referencedColumn: string,
    onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION",
  ) => Promise<void>;

  removeConstraint: (
    client: PoolClient,
    tableName: string,
    constraintName: string,
  ) => Promise<void>;
}

/**
 * Create a task-specific logger that prefills task and stage information
 */
export function createPrefixedLogger(
  baseLogger: SchemaLogger,
  prefix: { task?: string; stage?: string },
): SchemaLogger {
  return {
    log: (data: LogDataInput) => {
      baseLogger.log({
        ...data,
        task: data.task || prefix.task,
        stage: data.stage || prefix.stage,
      });
    },
    error: (data: LogDataInput) => {
      baseLogger.error({
        ...data,
        task: data.task || prefix.task,
        stage: data.stage || prefix.stage,
      });
    },
    warn: baseLogger.warn
      ? (data: LogDataInput) => {
          baseLogger.warn!({
            ...data,
            task: data.task || prefix.task,
            stage: data.stage || prefix.stage,
          });
        }
      : undefined,
  };
}

/**
 * Create schema helpers with the specified logger
 */
export function createSchemaHelpers(
  logger: SchemaLogger = consoleLogger,
  prefix: { task?: string; stage?: string } = {},
): SchemaHelpers {
  // Create a prefixed logger for the schema helpers
  const prefixedLogger = createPrefixedLogger(logger, prefix);
  /**
   * Create a table if it doesn't exist
   */
  async function createTable(
    client: PoolClient,
    tableName: string,
    columns: Record<string, string>,
    constraints: string[] = [],
  ): Promise<void> {
    // Build column definitions
    const columnDefs = Object.entries(columns)
      .map(([name, type]) => `${name} ${type}`)
      .join(",\n    ");

    // Add constraints if provided
    const constraintDefs =
      constraints.length > 0 ? ",\n    " + constraints.join(",\n    ") : "";

    // Create table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        ${columnDefs}${constraintDefs}
      )
    `);

    prefixedLogger.log({
      message: `Ensured table ${tableName} exists`,
    });
  }

  /**
   * Add a column to a table if it doesn't exist
   */
  async function addColumn(
    client: PoolClient,
    tableName: string,
    columnName: string,
    columnType: string,
    defaultValue?: string,
  ): Promise<void> {
    try {
      // Check if column exists
      const { rows } = await client.query(
        `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = $1 AND column_name = $2
      `,
        [tableName, columnName],
      );

      if (rows.length === 0) {
        // Column doesn't exist, add it
        const defaultClause = defaultValue ? ` DEFAULT ${defaultValue}` : "";
        await client.query(`
          ALTER TABLE ${tableName} 
          ADD COLUMN ${columnName} ${columnType}${defaultClause}
        `);
        prefixedLogger.log({
          message: `Added column ${columnName} to table ${tableName}`,
        });
      } else {
        prefixedLogger.log({
          message: `Column ${columnName} already exists in table ${tableName}`,
        });
      }
    } catch (error) {
      prefixedLogger.error({
        message: `Error adding column ${columnName} to table ${tableName}:`,
        error,
      });
      throw error;
    }
  }

  /**
   * Remove a column from a table if it exists
   */
  async function removeColumn(
    client: PoolClient,
    tableName: string,
    columnName: string,
  ): Promise<void> {
    try {
      // Check if column exists
      const { rows } = await client.query(
        `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = $1 AND column_name = $2
      `,
        [tableName, columnName],
      );

      if (rows.length > 0) {
        // Column exists, remove it
        await client.query(`
          ALTER TABLE ${tableName} 
          DROP COLUMN ${columnName}
        `);
        prefixedLogger.log({
          message: `Removed column ${columnName} from table ${tableName}`,
        });
      } else {
        prefixedLogger.log({
          message: `Column ${columnName} doesn't exist in table ${tableName}, nothing to remove`,
        });
      }
    } catch (error) {
      prefixedLogger.error({
        message: `Error removing column ${columnName} from table ${tableName}:`,
        error,
      });
      throw error;
    }
  }

  /**
   * Add an index to a table if it doesn't exist
   */
  async function addIndex(
    client: PoolClient,
    tableName: string,
    indexName: string,
    columns: string[],
    unique: boolean = false,
  ): Promise<void> {
    try {
      // Check if index exists
      const { rows } = await client.query(
        `
        SELECT indexname 
        FROM pg_indexes 
        WHERE tablename = $1 AND indexname = $2
      `,
        [tableName, indexName],
      );

      if (rows.length === 0) {
        // Index doesn't exist, create it
        const uniqueClause = unique ? "UNIQUE " : "";
        await client.query(`
          CREATE ${uniqueClause}INDEX ${indexName} 
          ON ${tableName} (${columns.join(", ")})
        `);
        prefixedLogger.log({
          message: `Created index ${indexName} on table ${tableName}`,
        });
      } else {
        prefixedLogger.log({
          message: `Index ${indexName} already exists on table ${tableName}`,
        });
      }
    } catch (error) {
      prefixedLogger.error({
        message: `Error creating index ${indexName} on table ${tableName}:`,
        error,
      });
      throw error;
    }
  }

  /**
   * Remove an index if it exists
   */
  async function removeIndex(
    client: PoolClient,
    indexName: string,
  ): Promise<void> {
    try {
      // Check if index exists
      const { rows } = await client.query(
        `
        SELECT indexname 
        FROM pg_indexes 
        WHERE indexname = $1
      `,
        [indexName],
      );

      if (rows.length > 0) {
        // Index exists, drop it
        await client.query(`DROP INDEX ${indexName}`);
        prefixedLogger.log({
          message: `Removed index ${indexName}`,
        });
      } else {
        prefixedLogger.log({
          message: `Index ${indexName} doesn't exist, nothing to remove`,
        });
      }
    } catch (error) {
      prefixedLogger.error({
        message: `Error removing index ${indexName}:`,
        error,
      });
      throw error;
    }
  }

  /**
   * Add a foreign key constraint if it doesn't exist
   */
  async function addForeignKey(
    client: PoolClient,
    tableName: string,
    constraintName: string,
    columnName: string,
    referencedTable: string,
    referencedColumn: string,
    onDelete: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION" = "NO ACTION",
  ): Promise<void> {
    try {
      // Check if constraint exists
      const { rows } = await client.query(
        `
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = $1 AND constraint_name = $2
      `,
        [tableName, constraintName],
      );

      if (rows.length === 0) {
        // Constraint doesn't exist, add it
        await client.query(`
          ALTER TABLE ${tableName}
          ADD CONSTRAINT ${constraintName}
          FOREIGN KEY (${columnName})
          REFERENCES ${referencedTable} (${referencedColumn})
          ON DELETE ${onDelete}
        `);
        prefixedLogger.log({
          message: `Added foreign key ${constraintName} to table ${tableName}`,
        });
      } else {
        prefixedLogger.log({
          message: `Foreign key ${constraintName} already exists on table ${tableName}`,
        });
      }
    } catch (error) {
      prefixedLogger.error({
        message: `Error adding foreign key ${constraintName} to table ${tableName}:`,
        error,
      });
      throw error;
    }
  }

  /**
   * Remove a constraint if it exists
   */
  async function removeConstraint(
    client: PoolClient,
    tableName: string,
    constraintName: string,
  ): Promise<void> {
    try {
      // Check if constraint exists
      const { rows } = await client.query(
        `
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = $1 AND constraint_name = $2
      `,
        [tableName, constraintName],
      );

      if (rows.length > 0) {
        // Constraint exists, drop it
        await client.query(`
          ALTER TABLE ${tableName}
          DROP CONSTRAINT ${constraintName}
        `);
        prefixedLogger.log({
          message: `Removed constraint ${constraintName} from table ${tableName}`,
        });
      } else {
        prefixedLogger.log({
          message: `Constraint ${constraintName} doesn't exist on table ${tableName}, nothing to remove`,
        });
      }
    } catch (error) {
      prefixedLogger.error({
        message: `Error removing constraint ${constraintName} from table ${tableName}:`,
        error,
      });
      throw error;
    }
  }

  return {
    createTable,
    addColumn,
    removeColumn,
    addIndex,
    removeIndex,
    addForeignKey,
    removeConstraint,
  };
}
