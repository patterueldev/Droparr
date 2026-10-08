import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { instanceSchema, pathMappingSchema } from "@droparr/shared";
import { validateMappings, SonarrClient, RadarrClient } from "@droparr/core";
import { z } from "zod";
import type { ConfigStore } from "../config/store.js";

const instanceInputSchema = instanceSchema.omit({ id: true }).extend({
  pathMappings: z.array(pathMappingSchema).default([]),
});

export function instanceRoutes(app: FastifyInstance, config: ConfigStore): void {
  app.get("/api/instances", async () => config.listInstances());

  app.post("/api/instances", async (req, reply) => {
    const parsed = instanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const mappingErrors = validateMappings(parsed.data.pathMappings);
    if (mappingErrors.length > 0) {
      return reply.code(400).send({ error: mappingErrors });
    }
    const instance = { id: nanoid(10), ...parsed.data };
    await config.addInstance(instance);
    return reply.code(201).send(instance);
  });

  app.put<{ Params: { id: string } }>("/api/instances/:id", async (req, reply) => {
    const parsed = instanceInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (parsed.data.pathMappings) {
      const mappingErrors = validateMappings(parsed.data.pathMappings);
      if (mappingErrors.length > 0) {
        return reply.code(400).send({ error: mappingErrors });
      }
    }
    const updated = await config.updateInstance(req.params.id, parsed.data);
    if (!updated) return reply.code(404).send({ error: "Instance not found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/instances/:id", async (req, reply) => {
    const removed = await config.removeInstance(req.params.id);
    if (!removed) return reply.code(404).send({ error: "Instance not found" });
    return reply.code(204).send();
  });

  /** Connection test — also used as a lightweight health check in the UI. */
  app.post<{ Params: { id: string } }>("/api/instances/:id/test", async (req, reply) => {
    const instance = config.getInstance(req.params.id);
    if (!instance) return reply.code(404).send({ error: "Instance not found" });
    try {
      const client =
        instance.kind === "series"
          ? new SonarrClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey })
          : new RadarrClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });
      const status = await client.systemStatus();
      return { ok: true, appName: status.appName, version: status.version };
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Dropdown data for the category editor. */
  app.get<{ Params: { id: string } }>("/api/instances/:id/dropdowns", async (req, reply) => {
    const instance = config.getInstance(req.params.id);
    if (!instance) return reply.code(404).send({ error: "Instance not found" });
    const client =
      instance.kind === "series"
        ? new SonarrClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey })
        : new RadarrClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });
    try {
      const [rootFolders, qualityProfiles, tags] = await Promise.all([
        client.rootFolders(),
        client.qualityProfiles(),
        client.tags(),
      ]);
      return { rootFolders, qualityProfiles, tags };
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Match search through the instance's own lookup API. */
  app.get<{ Params: { id: string }; Querystring: { term?: string } }>(
    "/api/instances/:id/lookup",
    async (req, reply) => {
      const instance = config.getInstance(req.params.id);
      if (!instance) return reply.code(404).send({ error: "Instance not found" });
      const term = req.query.term?.trim();
      if (!term) return reply.code(400).send({ error: "term is required" });
      try {
        if (instance.kind === "series") {
          const client = new SonarrClient({
            baseUrl: instance.baseUrl,
            apiKey: instance.apiKey,
          });
          return await client.lookup(term);
        }
        const client = new RadarrClient({
          baseUrl: instance.baseUrl,
          apiKey: instance.apiKey,
        });
        return await client.lookup(term);
      } catch (err) {
        return reply.code(502).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
