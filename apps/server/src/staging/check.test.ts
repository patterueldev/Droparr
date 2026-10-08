import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DroparrConfig, Instance } from "@droparr/shared";
import { auditImportStaging, auditSettingsStaging } from "./check.js";

describe("staging visibility audit", () => {
  let workDir: string;
  let stagingDir: string;
  let sourcePath: string;

  const instance: Instance = {
    id: "sonarr-1",
    name: "TV Sonarr",
    kind: "series",
    baseUrl: "http://sonarr.local:8989",
    apiKey: "key-1",
    // Patched in beforeAll — depends on the temp dir.
    pathMappings: [],
  };

  function config(staging: string, inst: Instance = instance): DroparrConfig {
    return {
      instances: [inst],
      categories: [
        {
          id: "tv",
          name: "TV",
          kind: "series",
          instanceId: inst.id,
          rootFolder: "/media/tv",
          tags: [],
          seriesType: "standard",
        },
      ],
      stagingDir: staging,
    };
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "droparr-audit-"));
    stagingDir = join(workDir, "staging");
    sourcePath = join(workDir, "incoming", "Some Drop");
    await mkdir(stagingDir, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    instance.pathMappings = [{ app: stagingDir, remote: "/media/staging" }];
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe("auditSettingsStaging", () => {
    it("passes a covered staging dir that exists", async () => {
      await expect(auditSettingsStaging(config(stagingDir))).resolves.toEqual({
        stagingDir,
        issues: [],
      });
    });

    it("ignores surrounding whitespace in the configured staging dir", async () => {
      const audit = await auditSettingsStaging(config(`  ${stagingDir}  `));
      expect(audit.issues).toEqual([]);
      expect(audit.stagingDir).toBe(stagingDir);
    });

    it("warns when an in-use instance cannot see the staging dir", async () => {
      const unmapped: Instance = { ...instance, pathMappings: [] };
      const audit = await auditSettingsStaging(config(stagingDir, unmapped));
      expect(audit.issues).toHaveLength(1);
      expect(audit.issues[0].code).toBe("staging-dir-unmapped");
      expect(audit.issues[0].instanceName).toBe("TV Sonarr");
      expect(audit.issues[0].suggestion).toContain("Path mappings");
    });

    it("warns when the staging dir is missing on this machine", async () => {
      const missing = join(workDir, "not-mounted", "staging");
      const audit = await auditSettingsStaging(config(missing, {
        ...instance,
        pathMappings: [{ app: missing, remote: "/media/staging" }],
      }));
      expect(audit.issues).toHaveLength(1);
      expect(audit.issues[0].code).toBe("staging-dir-missing");
      expect(audit.issues[0].message).toContain("does not exist");
    });

    it("warns when the staging path is a file, not a directory", async () => {
      const filePath = join(workDir, "staging-file");
      await writeFile(filePath, "not a dir");
      const audit = await auditSettingsStaging(config(filePath, {
        ...instance,
        pathMappings: [{ app: filePath, remote: "/media/staging" }],
      }));
      expect(audit.issues).toHaveLength(1);
      expect(audit.issues[0].message).toContain("not a directory");
    });

    it("reports an unset staging dir as one issue", async () => {
      const audit = await auditSettingsStaging(config(""));
      expect(audit.stagingDir).toBe("");
      expect(audit.issues).toHaveLength(1);
      expect(audit.issues[0].code).toBe("staging-dir-empty");
    });
  });

  describe("auditImportStaging", () => {
    it("resolves the planned dirs when the instance can see the staging dir", async () => {
      const audit = await auditImportStaging({
        stagingDir,
        instance,
        sourcePath,
      });
      expect(audit.issues).toEqual([]);
      expect(audit.stagingDir).toBe(join(stagingDir, "Some Drop"));
      expect(audit.instanceDir).toBe("/media/staging/Some Drop");
    });

    it("surfaces a mapping problem before the import starts", async () => {
      const audit = await auditImportStaging({
        stagingDir,
        instance: { ...instance, pathMappings: [] },
        sourcePath,
      });
      expect(audit.issues.map((i) => i.code)).toContain("staging-dir-unmapped");
      expect(audit.instanceDir).toBeUndefined();
    });

    it("warns when the staging base does not exist", async () => {
      const missing = join(workDir, "missing-base");
      const audit = await auditImportStaging({
        stagingDir: missing,
        instance: {
          ...instance,
          pathMappings: [{ app: missing, remote: "/media/staging" }],
        },
        sourcePath,
      });
      expect(audit.issues.map((i) => i.code)).toContain("staging-dir-missing");
    });

    it("reports an unset staging dir", async () => {
      const audit = await auditImportStaging({
        stagingDir: "",
        instance,
        sourcePath,
      });
      expect(audit.issues.map((i) => i.code)).toEqual(["staging-dir-empty"]);
    });
  });
});
