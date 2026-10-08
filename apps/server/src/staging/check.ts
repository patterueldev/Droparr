import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  PathMapper,
  PathMappingError,
  emptyStagingIssue,
  planStaging,
  stagingCoverageIssues,
  unmappedStagingIssue,
} from "@droparr/core";
import type {
  DroparrConfig,
  Instance,
  StagingCheckIssue,
} from "@droparr/shared";

export interface StagingAudit {
  /**
   * As Droparr sees it: the configured base (Settings) or the drop's planned
   * staging folder (import wizard).
   */
  stagingDir: string;
  /** The planned drop folder as the target instance sees it (wizard only). */
  instanceDir?: string;
  issues: StagingCheckIssue[];
}

/**
 * Local filesystem findings for a staging dir. The caller owns the
 * mapping-coverage check; an empty path is reported there, not here.
 */
async function stagingDirFilesystemIssues(
  stagingDir: string,
): Promise<StagingCheckIssue[]> {
  if (!stagingDir.trim()) return [];
  try {
    const st = await stat(stagingDir);
    if (!st.isDirectory()) {
      return [
        {
          code: "staging-dir-missing",
          message: `Staging directory "${stagingDir}" is not a directory on this machine.`,
          suggestion:
            "Point it at a directory on this machine that every *arr can also read.",
        },
      ];
    }
    return [];
  } catch {
    return [
      {
        code: "staging-dir-missing",
        message: `Staging directory "${stagingDir}" does not exist on this machine.`,
        suggestion:
          "Create it or point the staging directory at the mounted shared volume — imports will otherwise try to create it and may fail.",
      },
    ];
  }
}

/** Settings-level audit: mapping coverage for every in-use instance + local existence. */
export async function auditSettingsStaging(
  config: DroparrConfig,
): Promise<StagingAudit> {
  const coverage = stagingCoverageIssues(config);
  if (coverage.some((i) => i.code === "staging-dir-empty")) {
    return { stagingDir: "", issues: coverage };
  }
  return {
    stagingDir: config.stagingDir,
    issues: [
      ...coverage,
      ...(await stagingDirFilesystemIssues(config.stagingDir)),
    ],
  };
}

/**
 * Wizard audit for one target instance: once the drop is staged under the
 * configured base, will the instance see it? Resolves the exact planned dirs
 * through the same planner the runner uses, so the check matches the import.
 */
export async function auditImportStaging(opts: {
  stagingDir: string;
  instance: Instance;
  sourcePath: string;
}): Promise<StagingAudit> {
  const stagingBase = opts.stagingDir.trim();
  if (!stagingBase) {
    return { stagingDir: "", issues: [emptyStagingIssue()] };
  }

  const issues: StagingCheckIssue[] = [];
  let stagingDropDir = stagingBase;
  let instanceDir: string | undefined;

  try {
    const plan = planStaging(
      opts.sourcePath,
      basename(opts.sourcePath) || "drop",
      [],
      stagingBase,
      new PathMapper(opts.instance.pathMappings),
    );
    stagingDropDir = plan.stagingDir;
    instanceDir = plan.instanceDir;
  } catch (err) {
    if (!(err instanceof PathMappingError)) throw err;
    issues.push(unmappedStagingIssue(opts.instance, stagingBase));
  }

  issues.push(...(await stagingDirFilesystemIssues(stagingBase)));

  return { stagingDir: stagingDropDir, instanceDir, issues };
}
