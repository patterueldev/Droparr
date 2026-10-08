import { describe, expect, it } from "vitest";
import {
  resolveUploadTarget,
  sanitizeDropId,
  sanitizeRelPath,
} from "./paths.js";

describe("sanitizeRelPath", () => {
  it("accepts plain and nested paths", () => {
    expect(sanitizeRelPath("movie.mkv")).toBe("movie.mkv");
    expect(sanitizeRelPath("Season 1/episode 1.mkv")).toBe(
      "Season 1/episode 1.mkv",
    );
  });

  it("normalizes backslashes and drops dot/empty segments", () => {
    expect(sanitizeRelPath("a\\b/./c.mkv")).toBe("a/b/c.mkv");
    expect(sanitizeRelPath("a//b.mkv")).toBe("a/b.mkv");
  });

  it("rejects traversal, absolute and drive-lettered paths", () => {
    expect(sanitizeRelPath("../escape.mkv")).toBeNull();
    expect(sanitizeRelPath("a/../../escape.mkv")).toBeNull();
    expect(sanitizeRelPath("/etc/passwd.mkv")).toBeNull();
    expect(sanitizeRelPath("C:\\media\\movie.mkv")).toBeNull();
  });

  it("rejects NUL bytes, empty paths and AppleDouble junk", () => {
    expect(sanitizeRelPath("a\0b.mkv")).toBeNull();
    expect(sanitizeRelPath("")).toBeNull();
    expect(sanitizeRelPath(".")).toBeNull();
    expect(sanitizeRelPath("._movie.mkv")).toBeNull();
    expect(sanitizeRelPath("folder/._movie.mkv")).toBeNull();
  });

  it("rejects over-long segments and paths", () => {
    expect(sanitizeRelPath(`${"x".repeat(256)}.mkv`)).toBeNull();
    expect(sanitizeRelPath(`${"a/".repeat(600)}movie.mkv`)).toBeNull();
  });
});

describe("sanitizeDropId", () => {
  it("accepts filesystem-safe ids", () => {
    expect(sanitizeDropId("abc123_-XYZ")).toBe("abc123_-XYZ");
  });

  it("rejects ids with separators or weird characters", () => {
    expect(sanitizeDropId("../evil")).toBeUndefined();
    expect(sanitizeDropId("a/b")).toBeUndefined();
    expect(sanitizeDropId("a b")).toBeUndefined();
    expect(sanitizeDropId("")).toBeUndefined();
    expect(sanitizeDropId(undefined)).toBeUndefined();
  });
});

describe("resolveUploadTarget", () => {
  it("joins quarantine + drop + relative path", () => {
    expect(
      resolveUploadTarget("/data/quarantine", "drop1", "Season 1/a.mkv"),
    ).toBe("/data/quarantine/drop1/Season 1/a.mkv");
  });

  it("throws when a path tries to escape the drop dir", () => {
    expect(() =>
      resolveUploadTarget("/data/quarantine", "drop1", "../other/a.mkv"),
    ).toThrow(/escapes/);
  });
});
