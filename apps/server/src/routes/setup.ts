import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { JellyfinClient } from "@droparr/core";
import { jellyfinBaseUrlSchema, type SetupStatus } from "@droparr/shared";
import type { ConfigStore } from "../config/store.js";
import type { Db } from "../db.js";
import { effectiveJellyfinBaseUrl } from "../jellyfin/url.js";

const baseUrlSchema = z.object({
  baseUrl: jellyfinBaseUrlSchema,
});

/** Light per-IP limit on the unauthenticated first-run endpoints. */
const SETUP_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

export interface SetupRouteDeps {
  config: ConfigStore;
  db: Db;
}

/**
 * First-run setup wizard (#6): Jellyfin URL → admin login → confirm → done.
 *
 * These routes are open while the SQLite setup marker is unset and lock with
 * 403 afterwards. The admin login itself is the regular `POST /api/auth/login`
 * (role `admin` is only assigned when Jellyfin reports `IsAdministrator`), so
 * `complete` simply requires an admin session and records the lock.
 */
export function setupRoutes(app: FastifyInstance, deps: SetupRouteDeps): void {
  const { config, db } = deps;
  const locked = () => db.isSetupComplete();

  app.get("/api/setup/status", async (req, reply) => {
    if (locked()) {
      return reply.code(403).send({ error: "Setup is already complete" });
    }
    const baseUrl = effectiveJellyfinBaseUrl(config.get());
    const body: SetupStatus = {
      setupRequired: true,
      jellyfinConfigured: !!baseUrl,
      jellyfinBaseUrl: baseUrl,
      authenticated: !!req.auth,
      user: req.auth?.user,
    };
    return body;
  });

  app.post(
    "/api/setup/jellyfin/test",
    { config: { rateLimit: SETUP_RATE_LIMIT } },
    async (req, reply) => {
      if (locked()) {
        return reply.code(403).send({ error: "Setup is already complete" });
      }
      const parsed = baseUrlSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      try {
        const info = await new JellyfinClient({
          baseUrl: parsed.data.baseUrl,
        }).publicSystemInfo();
        return { ok: true, ...info };
      } catch (err) {
        return reply.code(502).send({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post(
    "/api/setup/jellyfin",
    { config: { rateLimit: SETUP_RATE_LIMIT } },
    async (req, reply) => {
      if (locked()) {
        return reply.code(403).send({ error: "Setup is already complete" });
      }
      const parsed = baseUrlSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const baseUrl = parsed.data.baseUrl.replace(/\/+$/, "");
      try {
        const info = await new JellyfinClient({ baseUrl }).publicSystemInfo();
        await config.updateSettings({ jellyfin: { baseUrl } });
        return { ok: true, ...info };
      } catch (err) {
        return reply.code(502).send({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post("/api/setup/complete", async (req, reply) => {
    if (locked()) {
      return reply.code(403).send({ error: "Setup is already complete" });
    }
    if (!req.auth) {
      return reply
        .code(401)
        .send({ error: "Sign in with a Jellyfin administrator first" });
    }
    if (req.auth.user.role !== "admin") {
      return reply
        .code(403)
        .send({ error: "This account is not a Jellyfin administrator" });
    }
    if (!effectiveJellyfinBaseUrl(config.get())) {
      return reply.code(409).send({ error: "Configure the Jellyfin URL first" });
    }
    if (!db.completeSetup(req.auth.user.id)) {
      // Another browser claimed the wizard between the check and here.
      return reply.code(403).send({ error: "Setup is already complete" });
    }
    return { ok: true, user: req.auth.user };
  });
}
