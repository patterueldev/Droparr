import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { JellyfinAuthError, JellyfinClient } from "@droparr/core";
import {
  jellyfinBaseUrlSchema,
  type AuthSession,
  type AuthStatus,
} from "@droparr/shared";
import type { ConfigStore } from "../config/store.js";
import type { Db } from "../db.js";
import { SESSION_COOKIE, hashSessionToken, type SessionService } from "../auth/sessions.js";
import type { LoginThrottle } from "../auth/throttle.js";
import type { AuthEvents } from "../auth/events.js";
import { requireAuth } from "../auth/guard.js";

const loginSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});

const baseUrlSchema = z.object({
  baseUrl: jellyfinBaseUrlSchema,
});

/** Light per-IP limit on the unauthenticated first-run bootstrap endpoints. */
const BOOTSTRAP_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

export interface AuthRouteDeps {
  config: ConfigStore;
  db: Db;
  sessions: SessionService;
  throttle: LoginThrottle;
  authEvents: AuthEvents;
}

/** 20 login requests / 15 min per IP (per-username lockout lives in SQLite). */
export const LOGIN_RATE_LIMIT = {
  max: 20,
  timeWindow: "15 minutes",
  errorResponseBuilder: () => ({
    statusCode: 429,
    error: "Too many login attempts. Try again later.",
  }),
};

export function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config, db, sessions, throttle, authEvents } = deps;

  app.get("/api/auth/status", async (req): Promise<AuthStatus> => {
    return {
      setupRequired: !config.get().jellyfin?.baseUrl,
      authenticated: !!req.auth,
      user: req.auth?.user,
    };
  });

  /**
   * Bootstrap (issue #6 replaces this with the locked setup wizard): while no
   * Jellyfin URL is configured these endpoints are open so a fresh install
   * can point Droparr at Jellyfin before anyone can log in.
   */
  app.post(
    "/api/auth/jellyfin/test",
    { config: { rateLimit: BOOTSTRAP_RATE_LIMIT } },
    async (req, reply) => {
      if (config.get().jellyfin?.baseUrl) {
        return reply.code(403).send({
          error: "Jellyfin is already configured — change it in Settings.",
        });
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
    "/api/auth/jellyfin",
    { config: { rateLimit: BOOTSTRAP_RATE_LIMIT } },
    async (req, reply) => {
      if (config.get().jellyfin?.baseUrl) {
        return reply.code(403).send({
          error: "Jellyfin is already configured — change it in Settings.",
        });
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

  app.post(
    "/api/auth/login",
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (req, reply) => {
      const baseUrl = config.get().jellyfin?.baseUrl;
      if (!baseUrl) {
        return reply.code(503).send({ error: "Jellyfin is not configured yet" });
      }

      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const { username, password } = parsed.data;

      const lock = throttle.check(username);
      if (lock.locked) {
        reply.header("retry-after", String(lock.retryAfterSeconds));
        return reply.code(429).send({
          error: `Too many failed attempts. Try again in ${formatRetry(lock.retryAfterSeconds)}.`,
        });
      }

      let result;
      try {
        result = await new JellyfinClient({ baseUrl }).authenticateByName(
          username,
          password,
        );
      } catch (err) {
        if (err instanceof JellyfinAuthError) {
          throttle.recordFailure(username);
          return reply
            .code(401)
            .send({ error: "Invalid username or password." });
        }
        return reply.code(502).send({
          error: `Cannot reach Jellyfin: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      throttle.recordSuccess(username);
      const user = db.upsertUser({
        jellyfinUserId: result.user.id,
        name: result.user.name,
        role: result.user.isAdministrator ? "admin" : "submitter",
      });
      if (user.blocked) {
        return reply.code(403).send({ error: "This account has been disabled." });
      }

      const { token } = sessions.create(user.id, {
        userAgent: req.headers["user-agent"],
        ip: req.ip,
      });
      sessions.setCookie(reply, token);
      return { user };
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    const current = req.auth?.session;
    if (current) {
      db.deleteSession(current.id);
      authEvents.emitSessionRevoked({
        sessionId: current.id,
        userId: current.userId,
      });
    } else {
      const token = req.cookies[SESSION_COOKIE];
      if (token) db.deleteSessionByTokenHash(hashSessionToken(token));
    }
    sessions.clearCookie(reply);
    return reply.code(204).send();
  });

  app.get(
    "/api/auth/sessions",
    { preHandler: requireAuth },
    async (req): Promise<AuthSession[]> => {
      const currentId = req.auth!.session.id;
      return db.listSessions(req.auth!.user.id).map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        userAgent: s.userAgent,
        ip: s.ip,
        current: s.id === currentId,
      }));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/auth/sessions/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const session = db.getSession(req.params.id);
      if (!session || session.userId !== req.auth!.user.id) {
        return reply.code(404).send({ error: "Session not found" });
      }
      db.deleteSession(session.id);
      authEvents.emitSessionRevoked({
        sessionId: session.id,
        userId: session.userId,
      });
      if (session.id === req.auth!.session.id) sessions.clearCookie(reply);
      return reply.code(204).send();
    },
  );
}

function formatRetry(seconds: number): string {
  if (seconds >= 120) return `${Math.ceil(seconds / 60)} minutes`;
  if (seconds >= 60) return "1 minute";
  return `${seconds} seconds`;
}
