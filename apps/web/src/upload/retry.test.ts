import { describe, expect, it } from "vitest";
import { shouldRetryUpload } from "./retry.js";

describe("shouldRetryUpload", () => {
  it("never retries 507 — the server removed the partial upload", () => {
    expect(shouldRetryUpload(507, true)).toBe(false);
    expect(shouldRetryUpload(507, false)).toBe(false);
  });

  it("retries offset conflicts and locks", () => {
    expect(shouldRetryUpload(409, true)).toBe(true);
    expect(shouldRetryUpload(423, true)).toBe(true);
  });

  it("does not retry a creation-time 409 duplicate", () => {
    expect(shouldRetryUpload(409, false)).toBe(false);
  });

  it("does not retry other 4xx (type/size/path rejections)", () => {
    for (const status of [400, 404, 413, 415]) {
      expect(shouldRetryUpload(status, true)).toBe(false);
    }
  });

  it("retries server errors and network failures", () => {
    expect(shouldRetryUpload(500, true)).toBe(true);
    expect(shouldRetryUpload(502, true)).toBe(true);
    expect(shouldRetryUpload(0, true)).toBe(true);
    expect(shouldRetryUpload(0, false)).toBe(true);
  });
});
