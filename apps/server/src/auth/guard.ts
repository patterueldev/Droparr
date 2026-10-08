import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { User } from "@droparr/shared";
import type { Db, StoredSession } from "../db.js";
import type { SessionService } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth guard for requests carrying a valid session. */
    auth?: { user: User; session: StoredSession };
  }
}

/** Routes reachable without a session. */
const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/logout",
]);

/**
 * Routes allowed while first-run setup is incomplete. Setup routes lock
 * themselves once the marker is set.
 */
function allowedDuringSetup(path: string): boolean {
  return (
    PUBLIC_PATHS.has(path) ||
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/setup/")
  );
}

function pathname(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Resolve sessions for all `/api` requests and enforce access:
 * - while first-run setup is incomplete → only health/auth/setup respond;
 *   everything else gets `409 { code: "setup_required" }`
 * - public paths → allowed
 * - authenticated → allowed (`/api/auth/*` routes also serve submitters)
 * - any other API route → admin only for now; submitters get their own routes
 *   in M3.
 *
 * `/api/ws` authenticates inside the WebSocket handler so it can close the
 * socket with a 4401 code instead of an HTTP reply.
 */
export function authGuard(
  app: FastifyInstance,
  sessions: SessionService,
  db: Db,
): void {
  app.decorateRequest("auth");

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || pathname(req.url) === "/api/ws") {
      return;
    }

    const resolved = sessions.resolve(req, reply);
    if (resolved) {
      req.auth = { user: resolved.user, session: resolved.session };
    }

    const path = pathname(req.url);

    // First-run gate: the setup wizard must complete before the app responds.
    if (!db.isSetupComplete() && !allowedDuringSetup(path)) {
      return reply.code(409).send({
        error: "Setup has not been completed",
        code: "setup_required",
      });
    }

    // Setup routes manage their own lock (and `complete` needs req.auth).
    if (path.startsWith("/api/setup/")) return;

    if (PUBLIC_PATHS.has(path)) return;

    if (!req.auth) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (req.auth.user.role !== "admin" && !path.startsWith("/api/auth/")) {
      return reply.code(403).send({ error: "Admin access required" });
    }
  });
}

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!req.auth) {
    await reply.code(401).send({ error: "Authentication required" });
  }
}

export async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!req.auth) {
    await reply.code(401).send({ error: "Authentication required" });
    return;
  }
  if (req.auth.user.role !== "admin") {
    await reply.code(403).send({ error: "Admin access required" });
  }
}
