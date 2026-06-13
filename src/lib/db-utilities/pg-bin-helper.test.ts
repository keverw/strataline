import { describe, it, expect, afterEach, mock, spyOn } from "bun:test";
import * as os from "os";
import { getBinaries } from "./pg-bin-helper";

// The platform/arch -> package mapping mirrored from pg-bin-helper, used both to
// drive the test cases and to figure out which package belongs to the host.
const PACKAGES: Record<string, string> = {
  "darwin/arm64": "@embedded-postgres/darwin-arm64",
  "darwin/x64": "@embedded-postgres/darwin-x64",
  "linux/arm64": "@embedded-postgres/linux-arm64",
  "linux/arm": "@embedded-postgres/linux-arm",
  "linux/ia32": "@embedded-postgres/linux-ia32",
  "linux/ppc64": "@embedded-postgres/linux-ppc64",
  "linux/x64": "@embedded-postgres/linux-x64",
  "win32/x64": "@embedded-postgres/windows-x64",
};

// The real package for whatever machine the suite runs on. `mock.module` is
// global for the whole `bun test` run, so we must NOT mock this one — other test
// files (test-db-instance, local-dev-db-server) import it to spin up a real
// embedded Postgres, and a fake module would break them.
const HOST_KEY = `${os.platform()}/${os.arch()}`;
const HOST_PACKAGE = PACKAGES[HOST_KEY];

// Stand-in module objects so we can assert which platform package was imported
// without needing the real (platform-specific) binaries installed.
const fakeBinary = (name: string) => ({
  postgres: `/${name}/postgres`,
  pg_ctl: `/${name}/pg_ctl`,
  initdb: `/${name}/initdb`,
});

for (const [key, pkg] of Object.entries(PACKAGES)) {
  if (pkg === HOST_PACKAGE) {
    continue; // leave the host's real package intact
  }
  mock.module(pkg, () => fakeBinary(key.replace("/", "-")));
}

describe("getBinaries", () => {
  let platformSpy: ReturnType<typeof spyOn> | undefined;
  let archSpy: ReturnType<typeof spyOn> | undefined;

  const setEnv = (platform: NodeJS.Platform, arch: string) => {
    platformSpy = spyOn(os, "platform").mockReturnValue(platform);
    // arch values include intentionally-unsupported ones (e.g. "mips") to
    // exercise the throw branches, so cast past the narrowed return type.
    archSpy = spyOn(os, "arch").mockReturnValue(
      arch as ReturnType<typeof os.arch>,
    );
  };

  afterEach(() => {
    platformSpy?.mockRestore();
    archSpy?.mockRestore();
  });

  for (const [key, pkg] of Object.entries(PACKAGES)) {
    const [platform, arch] = key.split("/") as [NodeJS.Platform, string];

    it(`imports ${pkg} on ${platform}/${arch}`, async () => {
      setEnv(platform, arch);
      const binaries = await getBinaries();

      if (pkg === HOST_PACKAGE) {
        // Real module: just assert it exposes the binary paths.
        expect(typeof binaries.postgres).toBe("string");
        expect(typeof binaries.pg_ctl).toBe("string");
        expect(typeof binaries.initdb).toBe("string");
      } else {
        expect(binaries.postgres).toBe(`/${key.replace("/", "-")}/postgres`);
      }
    });
  }

  it("throws on an unsupported arch for a supported platform", () => {
    setEnv("darwin", "mips");
    expect(() => getBinaries()).toThrow(
      'Unsupported arch "mips" for platform "darwin"',
    );
  });

  it("throws on an unsupported linux arch", () => {
    setEnv("linux", "sparc");
    expect(() => getBinaries()).toThrow(
      'Unsupported arch "sparc" for platform "linux"',
    );
  });

  it("throws on an unsupported windows arch", () => {
    setEnv("win32", "arm64");
    expect(() => getBinaries()).toThrow(
      'Unsupported arch "arm64" for platform "win32"',
    );
  });

  it("throws on an unsupported platform", () => {
    setEnv("aix", "x64");
    expect(() => getBinaries()).toThrow('Unsupported platform "aix"');
  });
});
