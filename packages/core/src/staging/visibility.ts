import type {
  DroparrConfig,
  Instance,
  StagingCheckIssue,
} from "@droparr/shared";
import { PathMapper } from "./paths.js";

/**
 * Early staging-visibility checks. Imports fail late (inside the runner) when
 * an instance can't see the staging dir; these helpers move the same knowledge
 * into Settings and the import wizard. They are pure (no filesystem access) and
 * advisory — callers must never block a setup because of a finding.
 */

/**
 * Instances referenced by at least one category, in config order. Only these
 * participate in imports, so only these need to see the staging dir.
 */
export function instancesInUse(
  config: Pick<DroparrConfig, "instances" | "categories">,
): Instance[] {
  const used = new Set(config.categories.map((c) => c.instanceId));
  return config.instances.filter((i) => used.has(i.id));
}

/** True when one of the instance's mappings covers `appPath`. */
export function canInstanceSeePath(instance: Instance, appPath: string): boolean {
  return new PathMapper(instance.pathMappings).toRemote(appPath) !== undefined;
}

export function emptyStagingIssue(): StagingCheckIssue {
  return {
    code: "staging-dir-empty",
    message:
      "Staging directory is not set — imports can't start until one is configured.",
    suggestion:
      "Set it in Settings to a path on this machine that every *arr can also read (through each instance's path mappings).",
  };
}

export function unmappedStagingIssue(
  instance: Instance,
  stagingDir: string,
): StagingCheckIssue {
  return {
    code: "staging-dir-unmapped",
    instanceId: instance.id,
    instanceName: instance.name,
    message: `"${instance.name}" cannot see the staging directory "${stagingDir}" — its path mappings don't cover it.`,
    suggestion:
      `Add a mapping on "${instance.name}" such as "${stagingDir}" → "/media/staging", ` +
      `using the path where ${instance.name} sees that volume ` +
      `(Settings → ${instance.name} → Path mappings).`,
  };
}

/**
 * Mapping coverage for Settings: the staging dir is set and every in-use
 * instance can see it. Filesystem checks (does the dir exist on this host?)
 * belong to the server.
 */
export function stagingCoverageIssues(
  config: Pick<DroparrConfig, "stagingDir" | "instances" | "categories">,
): StagingCheckIssue[] {
  const stagingDir = config.stagingDir.trim();
  if (!stagingDir) return [emptyStagingIssue()];

  return instancesInUse(config)
    .filter((i) => !canInstanceSeePath(i, stagingDir))
    .map((i) => unmappedStagingIssue(i, stagingDir));
}
