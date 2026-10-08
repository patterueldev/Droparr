import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { ConfigStore } from "../config/store.js";
import { buildExport, validateImport } from "../config/import.js";

const settingsSchema = z.object({
  stagingDir: z.string().optional(),
  jellyfin: z
    .object({ baseUrl: z.string().url(), apiKey: z.string().optional() })
    .optional(),
  llm: z
    .object({ provider: z.string(), apiKey: z.string(), model: z.string() })
    .optional(),
});

export function settingsRoutes(app: FastifyInstance, config: ConfigStore): void {
  app.get("/api/settings", async () => config.get());

  app.put("/api/settings", async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return config.updateSettings(parsed.data);
  });

  /**
   * Export the full configuration as a versioned JSON file.
   * NOTE: contains API keys — the UI warns about this.
   */
  app.get("/api/settings/export", async (_req, reply) => {
    const filename = `droparr-settings-${new Date().toISOString().slice(0, 10)}.json`;
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return buildExport(config.get());
  });

  /**
   * Import a settings file, replacing the whole configuration.
   * Returns warnings for anything that was reconciled (missing staging dir,
   * pruned categories, …) so the UI can tell the user exactly what happened.
   */
  app.post("/api/settings/import", async (req, reply) => {
    const result = validateImport(req.body);
    if (!result.ok) {
      return reply.code(400).send({ error: result.errors });
    }

    const warnings = [...result.warnings];

    // Machine-specific paths may not exist on this host (e.g. Mac → server).
    if (!result.config.stagingDir) {
      warnings.push(
        "Staging directory is not set — configure it in Settings before importing anything.",
      );
    } else {
      try {
        const st = await stat(result.config.stagingDir);
        if (!st.isDirectory()) {
          warnings.push(
            `Staging directory "${result.config.stagingDir}" is not a directory on this machine — update it in Settings.`,
          );
        }
      } catch {
        warnings.push(
          `Staging directory "${result.config.stagingDir}" does not exist on this machine — update it in Settings.`,
        );
      }
    }

    await config.replace(result.config);

    return {
      ok: true,
      warnings,
      summary: {
        instances: result.config.instances.length,
        categories: result.config.categories.length,
      },
    };
  });
}
