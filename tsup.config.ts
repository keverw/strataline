import { defineConfig } from "tsup";
import { readFileSync } from "fs";
import { join } from "path";

// Read package.json to get all dependencies
const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf-8"),
);

// Get all dependencies (regular + peer + dev) for external list
const getAllDependencies = (additionalDeps?: string[]) => {
  const deps = new Set<string>();

  // Add regular dependencies
  if (packageJson.dependencies) {
    for (const dep of Object.keys(packageJson.dependencies)) {
      deps.add(dep);
    }
  }

  // Add peer dependencies
  if (packageJson.peerDependencies) {
    for (const dep of Object.keys(packageJson.peerDependencies)) {
      deps.add(dep);
    }
  }

  // Add dev dependencies (in case they're used in build)
  if (packageJson.devDependencies) {
    for (const dep of Object.keys(packageJson.devDependencies)) {
      deps.add(dep);
    }
  }

  // Add additional dependencies if provided
  if (additionalDeps) {
    for (const dep of additionalDeps) {
      deps.add(dep);
    }
  }

  return Array.from(deps).sort();
};

const allExternals = getAllDependencies([
  // Mark embedded-postgres platform-specific packages as external
  // These are dynamically imported at runtime based on the platform
  "@embedded-postgres/darwin-arm64",
  "@embedded-postgres/darwin-x64",
  "@embedded-postgres/linux-arm",
  "@embedded-postgres/linux-arm64",
  "@embedded-postgres/linux-ia32",
  "@embedded-postgres/linux-ppc64",
  "@embedded-postgres/linux-x64",
  "@embedded-postgres/windows-x64",
]);

// NOTE: This configuration externalizes ALL dependencies for NPM distribution
// By default, tsup only excludes "dependencies" and "peerDependencies" but bundles "devDependencies"
// For a library published to NPM, we want EVERYTHING external so users install their own deps
// This approach automatically stays in sync with package.json changes

export default defineConfig([
  // Migration system
  {
    entry: ["src/migration.ts"],
    outDir: "dist/migration",
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true, // Safe to clean since it's in its own subdirectory
    external: allExternals,
  },
  // Test database instance
  {
    entry: ["src/test-db-instance.ts"],
    outDir: "dist/test-db-instance",
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true, // Safe to clean since it's in its own subdirectory
    external: allExternals,
  },
  // Local dev database server
  {
    entry: ["src/local-dev-db-server.ts"],
    outDir: "dist/local-dev-db-server",
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true, // Safe to clean since it's in its own subdirectory
    external: allExternals,
  },
  // CLI
  {
    entry: ["src/cli.ts"],
    outDir: "dist/cli",
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true, // Safe to clean since it's in its own subdirectory
    external: allExternals,
  },
]);
