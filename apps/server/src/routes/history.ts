import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";

export function historyRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/api/history",
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const offset = Number(req.query.offset ?? 0) || 0;
      return db.listHistory(limit, offset);
    },
  );

  app.get<{ Params: { id: string } }>("/api/history/:id", async (req, reply) => {
    const entry = db.getHistory(req.params.id);
    if (!entry) return reply.code(404).send({ error: "History entry not found" });
    return entry;
  });
}
