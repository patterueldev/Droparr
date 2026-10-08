import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConfigStore } from "../config/store.js";

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
}
