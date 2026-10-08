import { describe, expect, it } from "vitest";
import { buildExport, validateImport } from "./import.js";
import type { DroparrConfig } from "@droparr/shared";

const VALID_CONFIG: DroparrConfig = {
  instances: [
    {
      id: "sonarr-1",
      name: "TV Sonarr",
      kind: "series",
      baseUrl: "http://sonarr.local:8989",
      apiKey: "key-1",
      pathMappings: [{ app: "/data/staging", remote: "/media/staging" }],
    },
  ],
  categories: [
    {
      id: "tv",
      name: "TV",
      kind: "series",
      instanceId: "sonarr-1",
      rootFolder: "/media/tv",
      tags: [],
      seriesType: "standard",
    },
  ],
  stagingDir: "/data/staging",
};

describe("buildExport", () => {
  it("wraps the config in a versioned envelope", () => {
    const exp = buildExport(VALID_CONFIG);
    expect(exp.app).toBe("droparr");
    expect(exp.formatVersion).toBe(1);
    expect(exp.config).toEqual(VALID_CONFIG);
    expect(exp.exportedAt).toBeTruthy();
  });
});

describe("validateImport", () => {
  it("round-trips an export", () => {
    const result = validateImport(buildExport(VALID_CONFIG));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual(VALID_CONFIG);
      expect(result.warnings).toEqual([]);
    }
  });

  it("accepts a bare config (hand-edited JSON)", () => {
    const result = validateImport(VALID_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.categories).toHaveLength(1);
  });

  it("rejects files from another app", () => {
    const result = validateImport({ app: "sonarr", config: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("Not a Droparr settings file");
  });

  it("rejects newer export format versions", () => {
    const result = validateImport({ ...buildExport(VALID_CONFIG), formatVersion: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("newer than this Droparr supports");
  });

  it("rejects structurally invalid configs", () => {
    const result = validateImport({ app: "droparr", formatVersion: 1, config: { foo: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe("Invalid settings file");
      expect(result.errors.length).toBeGreaterThan(1);
    }
  });

  it("rejects duplicate instance ids", () => {
    const cfg: DroparrConfig = {
      ...VALID_CONFIG,
      instances: [VALID_CONFIG.instances[0], { ...VALID_CONFIG.instances[0], name: "Dupe" }],
    };
    const result = validateImport(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("Duplicate instance ids");
  });

  it("rejects invalid path mappings", () => {
    const cfg: DroparrConfig = {
      ...VALID_CONFIG,
      instances: [
        {
          ...VALID_CONFIG.instances[0],
          pathMappings: [
            { app: "/data", remote: "/a" },
            { app: "/data/media", remote: "/b" },
          ],
        },
      ],
    };
    const result = validateImport(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("Overlapping");
  });

  it("prunes orphaned categories with a warning", () => {
    const cfg: DroparrConfig = {
      ...VALID_CONFIG,
      categories: [
        ...VALID_CONFIG.categories,
        {
          id: "ghost",
          name: "Ghost",
          kind: "series",
          instanceId: "does-not-exist",
          rootFolder: "/x",
          tags: [],
          seriesType: "standard",
        },
      ],
    };
    const result = validateImport(cfg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.categories).toHaveLength(1);
      expect(result.warnings[0]).toContain("Ghost");
    }
  });

  it("corrects category kind to match its instance", () => {
    const cfg: DroparrConfig = {
      instances: [
        ...VALID_CONFIG.instances,
        {
          id: "radarr-1",
          name: "Movies",
          kind: "movie",
          baseUrl: "http://radarr.local:7878",
          apiKey: "key-2",
          pathMappings: [],
        },
      ],
      categories: [
        {
          id: "bad",
          name: "Mismatch",
          kind: "series", // wrong — points at a movie instance
          instanceId: "radarr-1",
          rootFolder: "/media/movies",
          tags: [],
          seriesType: "standard",
        },
      ],
      stagingDir: "/data/staging",
    };
    const result = validateImport(cfg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.categories[0].kind).toBe("movie");
      expect(result.warnings.join(" ")).toContain("Mismatch");
    }
  });
});
