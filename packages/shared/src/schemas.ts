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

export const droparrConfigSchema = z.object({
  instances: z.array(instanceSchema),
  categories: z.array(categorySchema),
  // May be empty until the user configures it in Settings.
  stagingDir: z.string(),
  jellyfin: z
    .object({
      baseUrl: jellyfinBaseUrlSchema,
      apiKey: z.string().optional(),
    })
    .optional(),
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

export const submissionSchema = z.object({
  id: z.string().min(1),
  submitterId: z.string().min(1),
  state: submissionStateSchema,
  files: z.array(fileRefSchema),
  analysis: folderAnalysisSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const historyEntrySchema = z.object({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  kind: instanceKindSchema,
  title: z.string(),
  year: z.number().int().optional(),
  matchedId: z.number().int().optional(),
  files: z.array(fileRefSchema),
  result: z.enum(["success", "partial", "failed"]),
  timestamps: z.object({
    started: z.string().datetime(),
    completed: z.string().datetime().optional(),
  }),
});

/** Current settings export format version. */
export const SETTINGS_EXPORT_FORMAT_VERSION = 1;

export const settingsExportSchema = z.object({
  app: z.literal("droparr"),
  formatVersion: z.number().int().positive(),
  exportedAt: z.string().optional(),
  config: droparrConfigSchema,
});
