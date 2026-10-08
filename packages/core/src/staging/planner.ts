import type { FileRef } from "@droparr/shared";
import { PathMapper } from "./paths.js";

export interface StagingPlan {
  /** Where files are staged on the Droparr side. */
  stagingDir: string;
  /** The same directory as the target instance sees it. */
  instanceDir: string;
  /** Files with both app-side and instance-side paths. */
  files: {
    app: string;
    remote: string;
    name: string;
    size: number;
  }[];
  totalBytes: number;
}

export class PathMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathMappingError";
  }
}

/**
 * Build a staging plan for a drop.
 *
 * @param sourceDir  directory on the Droparr side containing the files
 *                   (a server path or an already-imported quarantine dir)
 * @param dropName   folder name to use under the staging dir
 * @param files      files to stage (video + sidecars)
 * @param stagingBase absolute staging root as Droparr sees it
 * @param mapper     path mapper for the target instance
 */
export function planStaging(
  sourceDir: string,
  dropName: string,
  files: FileRef[],
  stagingBase: string,
  mapper: PathMapper,
): StagingPlan {
  const stagingDir = joinPath(stagingBase, sanitizeName(dropName));
  const instanceDir = mapper.toRemote(stagingDir);
  if (!instanceDir) {
    throw new PathMappingError(
      `Staging dir "${stagingDir}" has no mapping to the target instance. ` +
        `Add a path mapping covering it (e.g. "/staging" → "/media/staging").`,
    );
  }

  const planned = files.map((f) => {
    const app = joinPath(stagingDir, f.name);
    const remote = mapper.toRemote(app);
    if (!remote) {
      throw new PathMappingError(
        `File "${app}" has no mapping to the target instance`,
      );
    }
    return { app, remote, name: f.name, size: f.size };
  });

  const totalBytes = planned.reduce((sum, f) => sum + (f.size || 0), 0);

  return {
    stagingDir,
    instanceDir,
    files: planned,
    totalBytes,
  };
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/\/+$/, ""))
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/");
}

/** Make a folder name safe for the filesystem. */
export function sanitizeName(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 200) || "drop"
  );
}
