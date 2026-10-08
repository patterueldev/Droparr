import { zodToReadableErrors } from "./zod-helpers.js";
import {
  droparrConfigSchema,
  SETTINGS_EXPORT_FORMAT_VERSION,
  type DroparrConfig,
} from "@droparr/shared";
import { validateMappings } from "@droparr/core";

export interface ExportResult {
  app: "droparr";
  formatVersion: number;
  exportedAt: string;
  config: DroparrConfig;
}

export function buildExport(config: DroparrConfig): ExportResult {
  return {
    app: "droparr",
    formatVersion: SETTINGS_EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    config,
  };
}

export type ImportResult =
  | { ok: true; config: DroparrConfig; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * Validate an imported settings payload.
 *
 * Accepts either the export envelope ({app, formatVersion, config}) or a bare
 * config object (handy when editing the JSON by hand). Performs referential
 * integrity checks and prunes orphaned categories with a warning.
 *
 * Pure function — filesystem checks (staging dir existence) are the caller's.
 */
export function validateImport(payload: unknown): ImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let candidate: unknown = payload;
  if (payload && typeof payload === "object" && "app" in payload) {
    const envelope = payload as Record<string, unknown>;
    if (envelope.app !== "droparr") {
      return {
        ok: false,
        errors: [`Not a Droparr settings file (app: ${String(envelope.app)})`],
      };
    }
    if (
      typeof envelope.formatVersion === "number" &&
      envelope.formatVersion > SETTINGS_EXPORT_FORMAT_VERSION
    ) {
      return {
        ok: false,
        errors: [
          `Export format v${envelope.formatVersion} is newer than this Droparr supports (v${SETTINGS_EXPORT_FORMAT_VERSION}). Update Droparr first.`,
        ],
      };
    }
    candidate = envelope.config;
  }

  const parsed = droparrConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: ["Invalid settings file", ...zodToReadableErrors(parsed.error)],
    };
  }
  const config = parsed.data;

  // Duplicate ids would corrupt references.
  for (const [label, ids] of [
    ["instance", config.instances.map((i) => i.id)],
    ["category", config.categories.map((c) => c.id)],
  ] as const) {
    const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
    if (dupes.length > 0) {
      errors.push(`Duplicate ${label} ids: ${[...new Set(dupes)].join(", ")}`);
    }
  }

  // Path mappings must be valid per instance.
  for (const inst of config.instances) {
    for (const err of validateMappings(inst.pathMappings)) {
      errors.push(`${inst.name}: ${err}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Prune categories that reference missing instances.
  const instanceIds = new Set(config.instances.map((i) => i.id));
  const orphans = config.categories.filter((c) => !instanceIds.has(c.instanceId));
  if (orphans.length > 0) {
    warnings.push(
      `Removed ${orphans.length} category(ies) referencing missing instances: ${orphans
        .map((o) => o.name)
        .join(", ")}`,
    );
    config.categories = config.categories.filter((c) =>
      instanceIds.has(c.instanceId),
    );
  }

  // Category kind must match its instance kind (otherwise routing breaks later).
  for (const cat of config.categories) {
    const inst = config.instances.find((i) => i.id === cat.instanceId);
    if (inst && inst.kind !== cat.kind) {
      warnings.push(
        `Category "${cat.name}" kind corrected to match instance "${inst.name}" (${inst.kind})`,
      );
      cat.kind = inst.kind;
    }
  }

  return { ok: true, config, warnings };
}
