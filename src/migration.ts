export * from "./lib/migration-system";
export * from "./lib/logger";
// Only the SchemaHelpers type is public — it's the type of the `helpers` object
// the public Migration interface hands to beforeSchema/afterSchema. The
// createSchemaHelpers factory is internal machinery the migration system uses
// to build that object and is intentionally not re-exported.
export type { SchemaHelpers } from "./lib/schema-helpers";
