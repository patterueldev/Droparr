import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { categorySchema } from "@droparr/shared";
import type { ConfigStore } from "../config/store.js";

const categoryInputSchema = categorySchema.omit({ id: true });

export function categoryRoutes(app: FastifyInstance, config: ConfigStore): void {
  app.get("/api/categories", async () => config.listCategories());

  app.post("/api/categories", async (req, reply) => {
    const parsed = categoryInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    // The instance must exist and match the category kind.
    const instance = config.getInstance(parsed.data.instanceId);
    if (!instance) {
      return reply.code(400).send({ error: "instanceId does not exist" });
    }
    if (instance.kind !== parsed.data.kind) {
      return reply
        .code(400)
        .send({ error: "Category kind must match the instance kind" });
    }
    const category = { id: nanoid(10), ...parsed.data };
    await config.addCategory(category);
    return reply.code(201).send(category);
  });

  app.put<{ Params: { id: string } }>("/api/categories/:id", async (req, reply) => {
    const parsed = categoryInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (parsed.data.instanceId) {
      const instance = config.getInstance(parsed.data.instanceId);
      if (!instance) {
        return reply.code(400).send({ error: "instanceId does not exist" });
      }
    }
    const updated = await config.updateCategory(req.params.id, parsed.data);
    if (!updated) return reply.code(404).send({ error: "Category not found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/categories/:id", async (req, reply) => {
    const removed = await config.removeCategory(req.params.id);
    if (!removed) return reply.code(404).send({ error: "Category not found" });
    return reply.code(204).send();
  });
}
