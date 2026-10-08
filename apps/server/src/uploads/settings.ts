import { join, resolve } from "node:path";
import {
  DEFAULT_MAX_SUBMISSION_SIZE_BYTES,
  DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES,
  type DroparrConfig,
} from "@droparr/shared";

/** Upload policy resolved from config + runtime defaults. */
export interface UploadSettings {
  /** Absolute quarantine directory (uploads land here first). */
  quarantineDir: string;
  /** Per-file cap in bytes; 0 = unlimited. */
  maxFileSizeBytes: number;
  /** Per-drop cap in bytes; 0 = unlimited. */
  maxSubmissionSizeBytes: number;
}

export function resolveUploadSettings(
  config: DroparrConfig,
  dataDir: string,
): UploadSettings {
  const configured = config.uploads?.quarantineDir?.trim();
  return {
    quarantineDir: resolve(configured || join(dataDir, "quarantine")),
    maxFileSizeBytes:
      config.uploads?.maxFileSizeBytes ?? DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES,
    maxSubmissionSizeBytes:
      config.uploads?.maxSubmissionSizeBytes ??
      DEFAULT_MAX_SUBMISSION_SIZE_BYTES,
  };
}
