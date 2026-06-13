import { type PoolClient } from "pg";
import { type Logger, consoleLogger, createPrefixedLogger } from "./logger";

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

  addDeferrableForeignKey: (
    client: PoolClient,
    tableName: string,
    constraintName: string,
    columnName: string,
    referencedTable: string,
    referencedColumn: string,
    onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION",
    initiallyDeferred?: boolean,
  ) => Promise<void>;

  removeConstraint: (
    client: PoolClient,
    tableName: string,
    constraintName: string,
  ) => Promise<void>;
}

/**
 * Create schema helpers with the specified logger
 */
export function createSchemaHelpers(
  logger: Logger = consoleLogger,
  prefix: { task?: string; stage?: string } = {},
): SchemaHelpers {
  // Create a prefixed logger for the schema helpers
  const prefixedLogger = createPrefixedLogger(logger, prefix);

  /**
   * Resolve whether a table (or other relation) exists, the way Postgres itself
   * would resolve `ALTER TABLE <name>`: through `to_regclass`, which honours the
   * current `search_path` and accepts schema-qualified names ("schema.table").
   * Returns true if the relation exists, false otherwise.
   *
   * This is preferable to `information_schema.tables WHERE table_name = $1`,
   * which ignores the schema entirely and can false-positive against a
   * same-named table in another schema. All helpers route their existence checks
   * through here (and the pg_catalog lookups below) so they agree with where the
   * subsequent DDL will actually land.
   */
  async function tableExists(
    client: PoolClient,
    tableName: string,
  ): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT to_regclass($1) IS NOT NULL AS "exists"`,
      [tableName],
    );

    return rows[0]?.exists === true;
  }

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

    prefixedLogger.info({
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
      // Fail fast with a clear message if the table is missing, rather than
      // letting ALTER TABLE throw a raw Postgres error (mirrors removeColumn).
      if (!(await tableExists(client, tableName))) {
        throw new Error(`Table ${tableName} does not exist.`);
      }

      // Check if column exists (schema-aware: scoped to the resolved table OID).
      const { rows } = await client.query(
        `
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = to_regclass($1)
          AND attname = $2
          AND attnum > 0
          AND NOT attisdropped
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
        prefixedLogger.info({
          message: `Added column ${columnName} to table ${tableName}`,
        });
      } else {
        prefixedLogger.info({
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
      // First, check if the table exists
      if (!(await tableExists(client, tableName))) {
        throw new Error(`Table ${tableName} does not exist.`);
      }

      // Check if column exists (schema-aware: scoped to the resolved table OID).
      const { rows } = await client.query(
        `
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = to_regclass($1)
          AND attname = $2
          AND attnum > 0
          AND NOT attisdropped
      `,
        [tableName, columnName],
      );

      if (rows.length > 0) {
        // Column exists, remove it
        await client.query(`
          ALTER TABLE ${tableName}
          DROP COLUMN ${columnName}
        `);
        prefixedLogger.info({
          message: `Removed column ${columnName} from table ${tableName}`,
        });
      } else {
        prefixedLogger.info({
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
      // Fail fast with a clear message if the table is missing (mirrors the
      // remove* helpers) rather than letting CREATE INDEX throw a raw error.
      if (!(await tableExists(client, tableName))) {
        throw new Error(`Table ${tableName} does not exist.`);
      }

      // Check whether an index of this name already exists ON THIS TABLE, scoped
      // to the target table (indrelid = to_regclass(tableName)) rather than
      // resolving the bare index name through search_path. CREATE INDEX always
      // creates the index in the *table's* schema, which may not be the first
      // schema on search_path — so resolving the name independently could
      // false-positive against a same-named index in another schema (wrongly
      // skipping creation) or miss the real index when the table's schema isn't on
      // search_path (then attempting a duplicate CREATE INDEX). Scoping to the
      // resolved table keeps the check consistent with where the index will land.
      const { rows } = await client.query(
        `
        SELECT 1
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        WHERE i.indrelid = to_regclass($1)
          AND idx.relname = $2
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
        prefixedLogger.info({
          message: `Created index ${indexName} on table ${tableName}`,
        });
      } else {
        prefixedLogger.info({
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
      // Check if the index exists, resolving the name through search_path the
      // same way DROP INDEX will (schema-aware).
      const { rows } = await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS "exists"`,
        [indexName],
      );

      if (rows[0]?.exists) {
        // Index exists, drop it
        await client.query(`DROP INDEX ${indexName}`);
        prefixedLogger.info({
          message: `Removed index ${indexName}`,
        });
      } else {
        prefixedLogger.info({
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
      // Both ends of the constraint must exist; fail fast with clear messages
      // rather than letting ALTER TABLE throw a raw error.
      if (!(await tableExists(client, tableName))) {
        throw new Error(`Table ${tableName} does not exist.`);
      }

      if (!(await tableExists(client, referencedTable))) {
        throw new Error(`Referenced table ${referencedTable} does not exist.`);
      }

      // Check if constraint exists (schema-aware: scoped to the resolved table OID).
      const { rows } = await client.query(
        `
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = to_regclass($1) AND conname = $2
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
        prefixedLogger.info({
          message: `Added foreign key ${constraintName} to table ${tableName}`,
        });
      } else {
        prefixedLogger.info({
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
   * Add a deferrable foreign key constraint if it doesn't exist
   * This allows for circular references to be created in a single transaction
   */
  async function addDeferrableForeignKey(
    client: PoolClient,
    tableName: string,
    constraintName: string,
    columnName: string,
    referencedTable: string,
    referencedColumn: string,
    onDelete: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION" = "NO ACTION",
    initiallyDeferred: boolean = true,
  ): Promise<void> {
    try {
      // Both ends of the constraint must exist; fail fast with clear messages
      // rather than letting ALTER TABLE throw a raw error.
      if (!(await tableExists(client, tableName))) {
        throw new Error(`Table ${tableName} does not exist.`);
      }

      if (!(await tableExists(client, referencedTable))) {
        throw new Error(`Referenced table ${referencedTable} does not exist.`);
      }

      // Check if constraint exists (schema-aware: scoped to the resolved table OID).
      const { rows } = await client.query(
        `
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = to_regclass($1) AND conname = $2
      `,
        [tableName, constraintName],
      );

      if (rows.length === 0) {
        // Constraint doesn't exist, add it
        const deferredClause = initiallyDeferred
          ? "INITIALLY DEFERRED"
          : "INITIALLY IMMEDIATE";
        await client.query(`
          ALTER TABLE ${tableName}
          ADD CONSTRAINT ${constraintName}
          FOREIGN KEY (${columnName})
          REFERENCES ${referencedTable} (${referencedColumn})
          ON DELETE ${onDelete}
          DEFERRABLE ${deferredClause}
        `);
        prefixedLogger.info({
          message: `Added deferrable foreign key ${constraintName} to table ${tableName}`,
        });
      } else {
        prefixedLogger.info({
          message: `Foreign key ${constraintName} already exists on table ${tableName}`,
        });
      }
    } catch (error) {
      prefixedLogger.error({
        message: `Error adding deferrable foreign key ${constraintName} to table ${tableName}:`,
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
      // First, check if the table exists
      if (!(await tableExists(client, tableName))) {
        throw new Error(`Table ${tableName} does not exist.`);
      }

      // Check if constraint exists (schema-aware: scoped to the resolved table OID).
      const { rows } = await client.query(
        `
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = to_regclass($1) AND conname = $2
      `,
        [tableName, constraintName],
      );

      if (rows.length > 0) {
        // Constraint exists, drop it
        await client.query(`
          ALTER TABLE ${tableName}
          DROP CONSTRAINT ${constraintName}
        `);
        prefixedLogger.info({
          message: `Removed constraint ${constraintName} from table ${tableName}`,
        });
      } else {
        prefixedLogger.info({
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
    addDeferrableForeignKey,
    removeConstraint,
  };
}
