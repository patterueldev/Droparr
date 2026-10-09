import { z } from "zod";

export const instanceKindSchema = z.enum(["series", "movie"]);
export const seriesTypeSchema = z.enum(["standard", "anime", "daily"]);
export const submissionStateSchema = z.enum([
  "uploading",
  "analyzing",
  "pending",
  "approved",
  "importing",
  "done",
  "rejected",
]);
export const userRoleSchema = z.enum(["admin", "submitter"]);

export const userSchema = z.object({
  id: z.string().min(1),
  jellyfinUserId: z.string().min(1),
  name: z.string(),
  role: userRoleSchema,
  trusted: z.boolean(),
  blocked: z.boolean(),
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().optional(),
});

export const authSessionSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  userAgent: z.string().optional(),
  ip: z.string().optional(),
  current: z.boolean().optional(),
});

export const authStatusSchema = z.object({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
  user: userSchema.optional(),
});

/** Jellyfin base URL — http(s) only; used by config, bootstrap and settings. */
export const jellyfinBaseUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Jellyfin URL must start with http:// or https://",
  });

export const pathMappingSchema = z.object({
  app: z.string().min(1),
  remote: z.string().min(1),
});

export const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: instanceKindSchema,
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  pathMappings: z.array(pathMappingSchema),
});

export const categorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: instanceKindSchema,
  instanceId: z.string().min(1),
  rootFolder: z.string().min(1),
  qualityProfileId: z.number().int().positive().optional(),
  tags: z.array(z.string()),
  seriesType: seriesTypeSchema,
});

export const uploadSettingsSchema = z.object({
  quarantineDir: z.string().optional(),
  maxFileSizeBytes: z.number().int().nonnegative().optional(),
  maxSubmissionSizeBytes: z.number().int().nonnegative().optional(),
  minFreeSpaceBytes: z.number().int().nonnegative().optional(),
  retentionDays: z.number().int().nonnegative().optional(),
});

export const notificationFormatSchema = z.enum(["ntfy", "discord"]);

/**
 * Webhook target — http(s) only. Used wherever a URL is about to be posted
 * to (config validation while enabled, the settings test send).
 */
export const webhookUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Webhook URL must start with http:// or https://",
  });

const notificationSettingsBaseSchema = z.object({
  enabled: z.boolean(),
  /**
   * ntfy topic URL or Discord webhook URL. Required while enabled; may be
   * empty while disabled, so the URL can be cleared without re-enabling.
   */
  url: z.string().max(2048),
  format: notificationFormatSchema,
});

export const notificationSettingsSchema =
  notificationSettingsBaseSchema.superRefine((value, ctx) => {
    if (!value.enabled) return;
    // Enabling delivery requires a usable URL (the transport would fail).
    const parsed = webhookUrlSchema.safeParse(value.url);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message:
          value.url.trim() === ""
            ? "Webhook URL is required when notifications are enabled"
            : (parsed.error.issues[0]?.message ?? "Invalid webhook URL"),
      });
    }
  });

export const droparrConfigSchema = z.object({
  instances: z.array(instanceSchema),
  categories: z.array(categorySchema),
  // May be empty until the user configures it in Settings.
  stagingDir: z.string(),
  uploads: uploadSettingsSchema.optional(),
  jellyfin: z
    .object({
      baseUrl: jellyfinBaseUrlSchema,
      apiKey: z.string().optional(),
    })
    .optional(),
  notifications: notificationSettingsSchema.optional(),
  llm: z
    .object({
      provider: z.string(),
      apiKey: z.string(),
      model: z.string(),
    })
    .optional(),
});

export const fileRefSchema = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  ext: z.string(),
});

export const folderAnalysisSchema = z.object({
  kind: z.enum(["series", "movie"]),
  title: z.string(),
  year: z.number().int().optional(),
  seriesType: seriesTypeSchema.optional(),
  season: z.number().int().optional(),
  episodeNumbers: z.array(z.number().int()).optional(),
  files: z.array(fileRefSchema),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.array(z.string()),
});

export const folderAnalysisItemSchema = folderAnalysisSchema.extend({
  subPath: z.string(),
});

export const matchSelectionSchema = z.object({
  tvdbId: z.number().int().positive().optional(),
  tmdbId: z.number().int().positive().optional(),
  title: z.string().min(1),
  year: z.number().int().optional(),
  extra: z.record(z.unknown()).optional(),
});

export const submissionItemSchema = z.object({
  subPath: z.string(),
  sourcePath: z.string().min(1),
  analysis: folderAnalysisItemSchema,
  title: z.string(),
  year: z.number().int().optional(),
  categoryId: z.string().min(1).optional(),
  match: matchSelectionSchema.nullish(),
  seasons: z.array(z.number().int().nonnegative()).optional(),
  include: z.boolean(),
});

export const submissionSchema = z.object({
  id: z.string().min(1),
  submitterId: z.string().min(1),
  state: submissionStateSchema,
  dropId: z.string().min(1),
  dropName: z.string(),
  sourcePath: z.string().min(1),
  items: z.array(submissionItemSchema),
  importMode: z.enum(["move", "copy"]),
  note: z.string().optional(),
  jobIds: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  submitterName: z.string().optional(),
});

export const historyRejectedFileSchema = z.object({
  path: z.string(),
  reasons: z.array(z.string()),
});

export const historyEntrySchema = z.object({
  id: z.string().min(1),
  submissionId: z.string().optional(),
  instanceId: z.string().min(1),
  kind: instanceKindSchema,
  title: z.string(),
  year: z.number().int().optional(),
  matchedId: z.number().int().optional(),
  titleSlug: z.string().optional(),
  files: z.array(fileRefSchema),
  rejectedFiles: z.array(historyRejectedFileSchema).optional(),
  result: z.enum(["success", "partial", "failed"]),
  timestamps: z.object({
    started: z.string().datetime(),
    completed: z.string().datetime().optional(),
  }),
  /** Response-only: instance name resolved from config when read. */
  instanceName: z.string().optional(),
  /** Response-only: absolute *arr UI URL for the matched title. */
  link: z.string().optional(),
});

/** Current settings export format version. */
export const SETTINGS_EXPORT_FORMAT_VERSION = 1;

export const settingsExportSchema = z.object({
  app: z.literal("droparr"),
  formatVersion: z.number().int().positive(),
  exportedAt: z.string().optional(),
  config: droparrConfigSchema,
});
