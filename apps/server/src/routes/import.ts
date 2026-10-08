import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Category, Instance } from "@droparr/shared";
import type { ConfigStore } from "../config/store.js";
import type { Db } from "../db.js";
import type { JobRegistry } from "../jobs.js";
import { runImport } from "../import/runner.js";
import { auditImportStaging } from "../staging/check.js";

const importRequestSchema = z.object({
  sourcePath: z.string().min(1),
  categoryId: z.string().min(1),
  match: z.object({
    tvdbId: z.number().int().positive().optional(),
    tmdbId: z.number().int().positive().optional(),
    title: z.string().min(1),
    year: z.number().int().optional(),
    extra: z.record(z.unknown()).optional(),
  }),
  seasons: z.array(z.number().int().nonnegative()).optional(),
  importMode: z.enum(["move", "copy"]).default("copy"),
  // Optional subset of the drop's media files (relative to sourcePath) —
  // fanned-out items use this for files that sit loose at a shared drop root.
  files: z.array(z.string().min(1)).optional(),
});

const batchImportRequestSchema = z.object({
  items: z.array(importRequestSchema).min(1).max(100),
});

const importCheckSchema = z.object({
  categoryId: z.string().min(1),
  sourcePath: z.string().min(1),
});

/** Resolve a request's category + instance, or the validation error. */
function resolveImportTarget(
  deps: { config: ConfigStore },
  req: z.infer<typeof importRequestSchema>,
): { category: Category; instance: Instance } | { error: string } {
  const category = deps.config.getCategory(req.categoryId);
  if (!category) return { error: "Category not found" };
  const instance = deps.config.getInstance(category.instanceId);
  if (!instance) return { error: "Instance not found" };
  if (instance.kind === "series" && !req.match.tvdbId) {
    return { error: "Series imports require match.tvdbId" };
  }
  if (instance.kind === "movie" && !req.match.tmdbId) {
    return { error: "Movie imports require match.tmdbId" };
  }
  return { category, instance };
}

export function importRoutes(
  app: FastifyInstance,
  deps: { config: ConfigStore; db: Db; jobs: JobRegistry },
): void {
  app.post("/api/import", async (req, reply) => {
    const parsed = importRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const target = resolveImportTarget(deps, parsed.data);
    if ("error" in target) {
      return reply.code(400).send({ error: target.error });
    }

    const jobId = nanoid(12);
    deps.jobs.create(jobId);
    // Fire and forget — progress is streamed over /api/ws.
    void runImport(deps, jobId, parsed.data);
    return reply.code(202).send({ jobId });
  });

  /**
   * Batch import for fanned-out drops: one job per item, each item runs its
   * own full pipeline (staging, add, preflight, import, history). Validated
   * up front — either every item starts or none do. Runs sequentially so a
   * fanned import doesn't hammer the same *arr or staging disk.
   */
  app.post("/api/import/batch", async (req, reply) => {
    const parsed = batchImportRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    for (const [i, item] of parsed.data.items.entries()) {
      const target = resolveImportTarget(deps, item);
      if ("error" in target) {
        return reply.code(400).send({ error: `items[${i}]: ${target.error}` });
      }
    }

    const jobIds = parsed.data.items.map(() => nanoid(12));
    for (const id of jobIds) deps.jobs.create(id);

    // Fire and forget — the review UI tracks each jobId over /api/ws.
    void (async () => {
      for (const [i, item] of parsed.data.items.entries()) {
        await runImport(deps, jobIds[i], item);
      }
    })();

    return reply.code(202).send({ jobs: jobIds.map((id) => ({ jobId: id })) });
  });

  /**
   * Advisory pre-import check: can the target instance see the drop once it
   * is staged? The wizard shows the issues but never blocks the import.
   */
  app.get<{ Querystring: { categoryId?: string; sourcePath?: string } }>(
    "/api/import/check",
    async (req, reply) => {
      const parsed = importCheckSchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const category = deps.config.getCategory(parsed.data.categoryId);
      if (!category) {
        return reply.code(400).send({ error: "Category not found" });
      }
      const instance = deps.config.getInstance(category.instanceId);
      if (!instance) {
        return reply.code(400).send({ error: "Instance not found" });
      }
      return auditImportStaging({
        stagingDir: deps.config.get().stagingDir,
        instance,
        sourcePath: parsed.data.sourcePath,
      });
    },
  );

  /** Replay of a job's events (for reconnects). */
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return job;
  });
}
