import { afterEach, describe, expect, it } from "vitest";
import type { DroparrConfig } from "@droparr/shared";
import { effectiveJellyfinBaseUrl } from "./url.js";

function config(baseUrl?: string): DroparrConfig {
  return {
    instances: [],
    categories: [],
    stagingDir: "",
    ...(baseUrl ? { jellyfin: { baseUrl } } : {}),
  };
}

describe("effectiveJellyfinBaseUrl", () => {
  afterEach(() => {
    delete process.env.DROPARR_JELLYFIN_URL;
  });

  it("falls back to the configured URL", () => {
    expect(effectiveJellyfinBaseUrl(config("http://jellyfin:8096"))).toBe(
      "http://jellyfin:8096",
    );
  });

  it("prefers DROPARR_JELLYFIN_URL over the config", () => {
    process.env.DROPARR_JELLYFIN_URL = "http://10.0.0.5:8096";
    expect(effectiveJellyfinBaseUrl(config("http://saturday.local:8096"))).toBe(
      "http://10.0.0.5:8096",
    );
  });

  it("works with the env set and no config value", () => {
    process.env.DROPARR_JELLYFIN_URL = "  http://10.0.0.5:8096  ";
    expect(effectiveJellyfinBaseUrl(config())).toBe("http://10.0.0.5:8096");
  });

  it("returns undefined when neither is set", () => {
    expect(effectiveJellyfinBaseUrl(config())).toBeUndefined();
  });
});
