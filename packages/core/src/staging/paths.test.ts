import { describe, expect, it } from "vitest";
import { PathMapper, validateMappings } from "./paths.js";
import { planStaging } from "./planner.js";

describe("PathMapper", () => {
  const mapper = new PathMapper([
    { app: "/data/staging", remote: "/media/staging" },
    { app: "/downloads", remote: "/mnt/dl" },
  ]);

  it("translates app → remote", () => {
    expect(mapper.toRemote("/data/staging/Show")).toBe("/media/staging/Show");
    expect(mapper.toRemote("/downloads/x/y")).toBe("/mnt/dl/x/y");
  });

  it("translates remote → app", () => {
    expect(mapper.toApp("/media/staging/Show")).toBe("/data/staging/Show");
  });

  it("returns undefined for unmapped paths", () => {
    expect(mapper.toRemote("/other/path")).toBeUndefined();
  });

  it("exact prefix match works", () => {
    expect(mapper.toRemote("/downloads")).toBe("/mnt/dl");
  });

  it("does not partially match directory names", () => {
    expect(mapper.toRemote("/downloads-extra/file")).toBeUndefined();
  });

  it("longest prefix wins", () => {
    const m = new PathMapper([
      { app: "/data", remote: "/mnt/a" },
      { app: "/data/staging", remote: "/mnt/b" },
    ]);
    expect(m.toRemote("/data/staging/x")).toBe("/mnt/b/x");
    expect(m.toRemote("/data/other")).toBe("/mnt/a/other");
  });
});

describe("validateMappings", () => {
  it("accepts clean mappings", () => {
    expect(
      validateMappings([{ app: "/data/staging", remote: "/media/staging" }]),
    ).toEqual([]);
  });

  it("rejects empty paths", () => {
    const errors = validateMappings([{ app: "", remote: "/x" }]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects overlapping app prefixes", () => {
    const errors = validateMappings([
      { app: "/data", remote: "/a" },
      { app: "/data/media", remote: "/b" },
    ]);
    expect(errors.some((e) => e.includes("Overlapping"))).toBe(true);
  });

  it("rejects relative paths", () => {
    const errors = validateMappings([{ app: "relative/path", remote: "/x" }]);
    expect(errors.some((e) => e.includes("absolute"))).toBe(true);
  });
});

describe("planStaging", () => {
  const mapper = new PathMapper([{ app: "/data/staging", remote: "/media/staging" }]);

  it("builds a staging plan with translated paths", () => {
    const plan = planStaging(
      "/incoming/The Matrix",
      "The Matrix (1999)",
      [
        { name: "The.Matrix.1999.mkv", path: "/incoming/The Matrix/The.Matrix.1999.mkv", size: 1000, ext: ".mkv" },
        { name: "The.Matrix.1999.srt", path: "/incoming/The Matrix/The.Matrix.1999.srt", size: 100, ext: ".srt" },
      ],
      "/data/staging",
      mapper,
    );
    expect(plan.stagingDir).toBe("/data/staging/The Matrix (1999)");
    expect(plan.instanceDir).toBe("/media/staging/The Matrix (1999)");
    expect(plan.files[0].remote).toBe(
      "/media/staging/The Matrix (1999)/The.Matrix.1999.mkv",
    );
    expect(plan.totalBytes).toBe(1100);
  });

  it("throws when staging dir is unmapped", () => {
    const badMapper = new PathMapper([{ app: "/other", remote: "/x" }]);
    expect(() =>
      planStaging("/in", "Show", [], "/data/staging", badMapper),
    ).toThrow(/no mapping/i);
  });

  it("sanitizes folder names", () => {
    const plan = planStaging("/in", 'Show: Season 1?', [], "/data/staging", mapper);
    expect(plan.stagingDir).toBe("/data/staging/Show Season 1");
  });
});
