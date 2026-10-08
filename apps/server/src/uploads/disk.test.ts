import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diskSpace, formatBytes, isDiskFullError } from "./disk.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

describe("diskSpace", () => {
  it("reports free and total bytes for an existing directory", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "droparr-disk-"));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));

    const space = await diskSpace(tmp);
    expect(space.freeBytes).toBeGreaterThan(0);
    expect(space.totalBytes).toBeGreaterThanOrEqual(space.freeBytes);
  });

  it("throws for a missing path", async () => {
    await expect(
      diskSpace("/definitely/not/a/real/droparr-path"),
    ).rejects.toThrow();
  });
});

describe("isDiskFullError", () => {
  it("matches ENOSPC and EDQUOT only", () => {
    expect(
      isDiskFullError(Object.assign(new Error("full"), { code: "ENOSPC" })),
    ).toBe(true);
    expect(
      isDiskFullError(Object.assign(new Error("quota"), { code: "EDQUOT" })),
    ).toBe(true);
    expect(
      isDiskFullError(Object.assign(new Error("denied"), { code: "EACCES" })),
    ).toBe(false);
    expect(isDiskFullError(new Error("something else"))).toBe(false);
    expect(isDiskFullError(undefined)).toBe(false);
  });
});

describe("formatBytes", () => {
  it("formats sizes for user-facing messages", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2 * 1024 ** 2)).toBe("2.0 MiB");
    expect(formatBytes(10 * 1024 ** 3)).toBe("10.0 GiB");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});
