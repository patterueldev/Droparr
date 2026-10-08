import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
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
});

const importCheckSchema = z.object({
  categoryId: z.string().min(1),
  sourcePath: z.string().min(1),
});

export function importRoutes(
  app: FastifyInstance,
  deps: { config: ConfigStore; db: Db; jobs: JobRegistry },
): void {
  app.post("/api/import", async (req, reply) => {
    const parsed = importRequestSchema.safeParse(req.body);
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
    if (instance.kind === "series" && !parsed.data.match.tvdbId) {
      return reply.code(400).send({ error: "Series imports require match.tvdbId" });
    }
    if (instance.kind === "movie" && !parsed.data.match.tmdbId) {
      return reply.code(400).send({ error: "Movie imports require match.tmdbId" });
    }

    const jobId = nanoid(12);
    deps.jobs.create(jobId);
    // Fire and forget — progress is streamed over /api/ws.
    void runImport(deps, jobId, parsed.data);
    return reply.code(202).send({ jobId });
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
