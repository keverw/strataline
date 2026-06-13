// Ambient fallback types for the platform-specific @embedded-postgres/* binary
// packages (e.g. @embedded-postgres/darwin-arm64, .../linux-x64, ...).
//
// Only one of these packages is ever installed — the one matching the current
// OS/arch — so the others cannot be resolved at type-check time. This is a
// *wildcard* module declaration, which TypeScript uses only as a fallback when
// an import has no real resolvable module. That means the installed package
// keeps its own (more precise) shipped types, while the not-installed ones fall
// back to the shape declared here. The result: getBinaries() in
// db-utilities/pg-bin-helper.ts type-checks portably on every platform without
// any @ts-expect-error directives.
//
// Keep this in sync with the exports of the @embedded-postgres/<platform>
// packages (see their dist/index.d.ts).
declare module "@embedded-postgres/*" {
  export const pg_ctl: string;
  export const initdb: string;
  export const postgres: string;
}
