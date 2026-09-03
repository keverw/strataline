export * from "./lib/migration-system";
// Deliberately not `export * from "./lib/logger"`. Logging has its own
// entry point, `strataline/logger`, because it is not a migration concern:
// the dev server and the test database take the same `Logger`, and letting
// each surface re-export it would give one API four homes.
// Only the SchemaHelpers type is public — it's the type of the `helpers` object
// the public Migration interface hands to beforeSchema/afterSchema. The
// createSchemaHelpers factory is internal machinery the migration system uses
// to build that object and is intentionally not re-exported.
export type { SchemaHelpers } from "./lib/schema-helpers";
