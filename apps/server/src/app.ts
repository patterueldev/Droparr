import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "./config/store.js";
import { Db } from "./db.js";
import { JobRegistry } from "./jobs.js";
import { SessionService } from "./auth/sessions.js";
import { LoginThrottle } from "./auth/throttle.js";
import { AuthEvents, type SessionRevokedEvent } from "./auth/events.js";
import { authGuard } from "./auth/guard.js";
import { authRoutes } from "./routes/auth.js";
import { instanceRoutes } from "./routes/instances.js";
import { categoryRoutes } from "./routes/categories.js";
import { fsRoutes } from "./routes/fs.js";
import { importRoutes } from "./routes/import.js";
import { historyRoutes } from "./routes/history.js";
import { settingsRoutes } from "./routes/settings.js";

export interface BuildAppOptions {
  dataDir?: string;
  configPath?: string;
  logger?: FastifyServerOptions["logger"];
  /** Serve the built web UI when present. Off in tests. */
  serveWeb?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  config: ConfigStore;
  db: Db;
  jobs: JobRegistry;
  authEvents: AuthEvents;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const dataDir =
    opts.dataDir ?? process.env.DROPARR_DATA ?? join(process.cwd(), "data");
  const config = await ConfigStore.load(
    opts.configPath ?? process.env.DROPARR_CONFIG,
  );
  const db = new Db(join(dataDir, "droparr.db"));
  const jobs = new JobRegistry();
  const authEvents = new AuthEvents();
  const sessions = new SessionService(db);
  const throttle = new LoginThrottle(db);

  db.pruneExpiredSessions(new Date().toISOString());

  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: true,
  });

  // Browser clients are served same-origin (Vite proxies /api in dev), so CORS
  // stays off unless explicitly opted in. `origin: true` + credentials would
  // let any site make credentialed requests once cookie auth is in play.
  const devOrigins = (process.env.DROPARR_DEV_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (devOrigins.length > 0) {
    await app.register(cors, { origin: devOrigins, credentials: true });
  }
  await app.register(cookie);
  // Per-route limits only (see the login route); no global default.
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  authGuard(app, sessions);

  // API routes
  authRoutes(app, { config, db, sessions, throttle, authEvents });
  instanceRoutes(app, config);
  categoryRoutes(app, config);
  fsRoutes(app);
  importRoutes(app, { config, db, jobs });
  historyRoutes(app, db);
  settingsRoutes(app, config);

  // Live progress stream. Every job event is broadcast; the client filters
  // by jobId. `GET /api/jobs/:id` replays events after a reconnect.
  // Unauthenticated upgrades are closed with 4401; when the session behind a
  // socket is revoked the socket is told and closed immediately.
  app.get("/api/ws", { websocket: true }, (socket, req) => {
    const resolved = sessions.resolve(req);
    if (!resolved) {
      socket.close(4401, "Unauthorized");
      return;
    }

    const onEvent = (event: unknown) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(event));
      }
    };
    const onRevoked = (event: SessionRevokedEvent) => {
      if (event.sessionId !== resolved.session.id) return;
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "session-revoked" }));
      }
      socket.close(4401, "Session revoked");
    };

    jobs.on("event", onEvent);
    authEvents.on("session-revoked", onRevoked);
    socket.on("close", () => {
      jobs.off("event", onEvent);
      authEvents.off("session-revoked", onRevoked);
    });
  });

  app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));

  // Serve the built web app when present (production/Docker).
  // In dev, Vite serves the UI and proxies /api here.
  if (opts.serveWeb !== false) {
    const webDist =
      process.env.DROPARR_WEB_DIST ?? join(process.cwd(), "..", "web", "dist");
    if (existsSync(webDist)) {
      await app.register(fastifyStatic, { root: webDist, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith("/api")) {
          return reply.code(404).send({ error: "Not found" });
        }
        return reply.sendFile("index.html");
      });
      app.log.info(`Serving web UI from ${webDist}`);
    }
  }

  return { app, config, db, jobs, authEvents };
}
