import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    // Mark pg as external since it's a peer dependency
    "pg",
    // Mark all regular dependencies as external - npm will install them automatically
    "get-port",
    "tmp",
    // Mark embedded-postgres as external since it's a peer dependency
    "embedded-postgres",
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
  ],
});
