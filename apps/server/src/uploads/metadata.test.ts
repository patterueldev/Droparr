import { describe, expect, it } from "vitest";
import { parseUploadMetadata } from "./metadata.js";

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

describe("parseUploadMetadata", () => {
  it("decodes base64 values and lowercases keys", () => {
    const header = `filename ${b64("My Movie.mkv")},FileType ${b64("video/x-matroska")},dropid ${b64("abc")}`;
    expect(parseUploadMetadata(header)).toEqual({
      filename: "My Movie.mkv",
      filetype: "video/x-matroska",
      dropid: "abc",
    });
  });

  it("supports valueless keys and missing headers", () => {
    expect(parseUploadMetadata("is_confidential")).toEqual({
      is_confidential: "",
    });
    expect(parseUploadMetadata(undefined)).toEqual({});
    expect(parseUploadMetadata("")).toEqual({});
  });

  it("ignores malformed pairs and tolerates array headers", () => {
    expect(parseUploadMetadata("  , filename ")).toEqual({
      filename: "",
    });
    expect(
      parseUploadMetadata([`filename ${b64("a.mkv")}`, `relpath ${b64("s/a.mkv")}`]),
    ).toEqual({ filename: "a.mkv", relpath: "s/a.mkv" });
  });
});
