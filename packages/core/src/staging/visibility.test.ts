import { describe, expect, it } from "vitest";
import type { DroparrConfig } from "@droparr/shared";
import {
  canInstanceSeePath,
  instancesInUse,
  stagingCoverageIssues,
} from "./visibility.js";

const CONFIG: DroparrConfig = {
  instances: [
    {
      id: "sonarr-1",
      name: "TV Sonarr",
      kind: "series",
      baseUrl: "http://sonarr.local:8989",
      apiKey: "key-1",
      pathMappings: [{ app: "/data/staging", remote: "/media/staging" }],
    },
    {
      id: "radarr-1",
      name: "Movies",
      kind: "movie",
      baseUrl: "http://radarr.local:7878",
      apiKey: "key-2",
      pathMappings: [{ app: "/other", remote: "/mnt/other" }],
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
    {
      id: "anime",
      name: "Anime",
      kind: "series",
      instanceId: "sonarr-1",
      rootFolder: "/media/anime",
      tags: [],
      seriesType: "anime",
    },
  ],
  stagingDir: "/data/staging",
};

describe("instancesInUse", () => {
  it("returns deduped instances referenced by categories, in config order", () => {
    expect(instancesInUse(CONFIG).map((i) => i.id)).toEqual(["sonarr-1"]);
  });

  it("ignores instances without categories", () => {
    expect(instancesInUse({ instances: CONFIG.instances, categories: [] })).toEqual(
      [],
    );
  });
});

describe("canInstanceSeePath", () => {
  it("is true when a mapping covers the path", () => {
    expect(canInstanceSeePath(CONFIG.instances[0], "/data/staging/Show")).toBe(true);
  });

  it("is false when nothing covers the path", () => {
    expect(canInstanceSeePath(CONFIG.instances[0], "/mnt/nope")).toBe(false);
  });
});

describe("stagingCoverageIssues", () => {
  it("reports the empty staging dir as a single issue", () => {
    const issues = stagingCoverageIssues({ ...CONFIG, stagingDir: "" });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("staging-dir-empty");
    expect(issues[0].suggestion).toBeTruthy();
  });

  it("passes when every in-use instance covers the staging dir", () => {
    expect(stagingCoverageIssues(CONFIG)).toEqual([]);
  });

  it("warns for an in-use instance whose mappings don't cover it", () => {
    const cfg: DroparrConfig = {
      ...CONFIG,
      categories: [
        ...CONFIG.categories,
        {
          id: "movies",
          name: "Movies",
          kind: "movie",
          instanceId: "radarr-1",
          rootFolder: "/media/movies",
          tags: [],
          seriesType: "standard",
        },
      ],
    };
    const issues = stagingCoverageIssues(cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("staging-dir-unmapped");
    expect(issues[0].instanceId).toBe("radarr-1");
    expect(issues[0].instanceName).toBe("Movies");
    expect(issues[0].message).toContain("/data/staging");
    expect(issues[0].suggestion).toContain("Movies");
  });

  it("does not warn for instances that no category uses", () => {
    const cfg: DroparrConfig = {
      ...CONFIG,
      categories: CONFIG.categories.slice(0, 1),
    };
    expect(stagingCoverageIssues(cfg)).toEqual([]);
  });

  it("emits one issue per unmapped instance, not per category", () => {
    const cfg: DroparrConfig = {
      instances: [CONFIG.instances[1]],
      categories: [
        { ...CONFIG.categories[0], instanceId: "radarr-1" },
        { ...CONFIG.categories[1], instanceId: "radarr-1" },
      ],
      stagingDir: "/data/staging",
    };
    expect(stagingCoverageIssues(cfg)).toHaveLength(1);
  });

  it("treats a broader mapping as covering subdirectories", () => {
    const cfg: DroparrConfig = {
      ...CONFIG,
      instances: [
        { ...CONFIG.instances[0], pathMappings: [{ app: "/data", remote: "/mnt" }] },
      ],
    };
    expect(stagingCoverageIssues(cfg)).toEqual([]);
  });
});
