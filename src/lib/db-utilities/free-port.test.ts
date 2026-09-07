import { describe, expect, test } from "bun:test";
import { createServer } from "net";
import {
  chooseSearchWindow,
  findFreePort,
  parseEphemeralRange,
} from "./free-port";

/** The window used whenever nothing rules the preferred one out. */
const PREFERRED = { first: 20_000, last: 30_000 };

describe("parseEphemeralRange", () => {
  test("reads the two numbers Linux writes", () => {
    // The real file is tab separated and newline terminated.
    expect(parseEphemeralRange("32768\t60999\n")).toEqual({
      low: 32_768,
      high: 60_999,
    });
    expect(parseEphemeralRange("10000 65535")).toEqual({
      low: 10_000,
      high: 65_535,
    });
  });

  test("refuses anything that is not exactly two numbers", () => {
    for (const raw of [
      null,
      "",
      "   ",
      "32768",
      "32768 60999 1",
      "32768abc 60999",
      "abc def",
    ]) {
      expect(parseEphemeralRange(raw)).toBeNull();
    }
  });

  test("refuses a pair that cannot describe real ports", () => {
    // Reversed, above the top of the port space, and a zero low. Reading any
    // of these as a range would move the search window on a bad value.
    expect(parseEphemeralRange("60999 32768")).toBeNull();
    expect(parseEphemeralRange("32768 70000")).toBeNull();
    expect(parseEphemeralRange("0 60999")).toBeNull();
  });

  test("a refused value leaves the preferred window in place", () => {
    expect(chooseSearchWindow(parseEphemeralRange("garbage"))).toEqual(
      PREFERRED,
    );
  });
});

describe("chooseSearchWindow", () => {
  test("uses the preferred window when the ephemeral range cannot be read", () => {
    expect(chooseSearchWindow(null)).toEqual(PREFERRED);
  });

  test("uses the preferred window under the Linux default range", () => {
    expect(chooseSearchWindow({ low: 32_768, high: 60_999 })).toEqual(
      PREFERRED,
    );
  });

  test("uses the preferred window under the macOS and Windows default range", () => {
    expect(chooseSearchWindow({ low: 49_152, high: 65_535 })).toEqual(
      PREFERRED,
    );
  });

  test("moves below a widened range that swallows the preferred window", () => {
    // `10000 65535` is a routine tuning on hosts that make many outbound
    // connections, and it covers 20000-30000 entirely. Nothing is left above
    // 65535, so the window has to go below.
    const window = chooseSearchWindow({ low: 10_000, high: 65_535 });

    expect(window).toEqual({ first: 1024, last: 9999 });
  });

  test("prefers the room above a range to the room below it", () => {
    // Both sides have room. Above wins, because the ports below a low
    // ephemeral range are where a developer machine actually runs things.
    const window = chooseSearchWindow({ low: 10_000, high: 20_000 });

    expect(window.first).toBe(20_001);
    expect(window.last).toBeLessThanOrEqual(65_535);
    expect(window.last - window.first + 1).toBeGreaterThanOrEqual(1000);
  });

  test("falls below when the room above is too small to search", () => {
    // 65000-65535 is 536 ports, which would run out and fall through to the
    // operating system's own ephemeral pick.
    const window = chooseSearchWindow({ low: 15_000, high: 64_999 });

    expect(window).toEqual({ first: 4999, last: 14_999 });
  });

  test("falls back to the preferred window when nothing is left outside", () => {
    // `1024 65535` leaves no unprivileged port outside the ephemeral range.
    // There is no better answer than the one this replaced, so it takes it
    // rather than inventing a window it cannot justify.
    expect(chooseSearchWindow({ low: 1024, high: 65_535 })).toEqual(PREFERRED);
  });

  test("falls back rather than return a window under the privileged floor", () => {
    // Below 2000 there are only 976 unprivileged ports, and none of them may
    // be bound without privileges below 1024.
    expect(chooseSearchWindow({ low: 2000, high: 65_535 })).toEqual(PREFERRED);
  });

  test("never returns a window that overlaps the ephemeral range it was given", () => {
    const ranges = [
      { low: 32_768, high: 60_999 },
      { low: 49_152, high: 65_535 },
      { low: 10_000, high: 65_535 },
      { low: 10_000, high: 20_000 },
      { low: 15_000, high: 64_999 },
      { low: 25_000, high: 26_000 },
    ];

    for (const range of ranges) {
      const window = chooseSearchWindow(range);
      const overlaps = window.first <= range.high && window.last >= range.low;

      // The all-covered fallback is the one documented exception, and none of
      // these ranges is that case.
      expect(overlaps).toBe(false);
      expect(window.first).toBeGreaterThanOrEqual(1024);
      expect(window.last).toBeLessThanOrEqual(65_535);
    }
  });
});

describe("findFreePort", () => {
  test("returns a port that can actually be bound", async () => {
    const port = await findFreePort();

    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65_535);

    await new Promise<void>((resolve, reject) => {
      const server = createServer();

      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve());
      });
    });
  });

  test("does not hand the same port to two overlapping callers", async () => {
    const ports = await Promise.all(
      Array.from({ length: 8 }, () => findFreePort()),
    );

    expect(new Set(ports).size).toBe(ports.length);
  });
});
