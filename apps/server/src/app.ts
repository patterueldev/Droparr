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
import { QuarantineCleanup } from "./uploads/cleanup.js";
import { UploadEventBus } from "./uploads/events.js";
import { UploadLocks } from "./uploads/locks.js";
import { resolveUploadSettings } from "./uploads/settings.js";
import { SubmissionEventBus } from "./submissions/events.js";
import { SessionService } from "./auth/sessions.js";
import { LoginThrottle } from "./auth/throttle.js";
import { AuthEvents, type SessionRevokedEvent } from "./auth/events.js";
import { authGuard } from "./auth/guard.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { setupRoutes } from "./routes/setup.js";
import { instanceRoutes } from "./routes/instances.js";
import { categoryRoutes } from "./routes/categories.js";
import { fsRoutes } from "./routes/fs.js";
import { importRoutes } from "./routes/import.js";
import { historyRoutes } from "./routes/history.js";
import { settingsRoutes } from "./routes/settings.js";
import { submissionRoutes } from "./routes/submissions.js";
import { uploadRoutes } from "./routes/uploads.js";

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
  uploads: UploadEventBus;
  submissions: SubmissionEventBus;
  uploadLocks: UploadLocks;
  cleanup: QuarantineCleanup;
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
  const uploads = new UploadEventBus();
  const submissions = new SubmissionEventBus();
  const uploadLocks = new UploadLocks();
  const authEvents = new AuthEvents();
  const sessions = new SessionService(db);
  const throttle = new LoginThrottle(db);

  db.pruneExpiredSessions(new Date().toISOString());
  // First boot: create the setup lock. Installs that predate the wizard are
  // backfilled as complete so upgrading never reopens first-run setup (#6).
  db.initializeSetupState({
    adminExists: db.hasAdminUser(),
    jellyfinConfigured: !!config.get().jellyfin?.baseUrl,
  });

  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: true,
  });

  // Quarantine sweep: created here so routes/tests can use it; the timer is
  // only started by the server entrypoint (index.ts).
  const cleanup = new QuarantineCleanup({
    db,
    events: uploads,
    locks: uploadLocks,
    getSettings: () => resolveUploadSettings(config.get(), dataDir),
    // Drops referenced by a live submission (pending/approved/importing) are
    // never swept — the submitter is still waiting on a decision (M3.3).
    isDropProtected: (dropId) => db.isDropProtected(dropId),
    log: { warn: (obj, msg) => app.log.warn(obj, msg) },
  });

  // Browser clients are served same-origin (Vite proxies /api in dev), so CORS
  // stays off unless explicitly opted in. `origin: true` + credentials would
  // let any site make credentialed requests once cookie auth is in play.
  const devOrigins = (process.env.DROPARR_DEV_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (devOrigins.length > 0) {
    await app.register(cors, {
      origin: devOrigins,
      credentials: true,
      exposedHeaders: [
        "Location",
        "Upload-Offset",
        "Upload-Length",
        "Tus-Resumable",
      ],
    });
  }
  await app.register(cookie);
  // Per-route limits only (see the login route); no global default.
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  authGuard(app, sessions, db);

  // API routes
  authRoutes(app, { config, db, sessions, throttle, authEvents });
  userRoutes(app, { db, authEvents });
  setupRoutes(app, { config, db });
  instanceRoutes(app, config);
  categoryRoutes(app, config);
  fsRoutes(app, {
    extraRoots: () => [
      resolveUploadSettings(config.get(), dataDir).quarantineDir,
    ],
  });
  importRoutes(app, { config, db, jobs });
  historyRoutes(app, { db, config });
  settingsRoutes(app, config, dataDir, { cleanup });
  uploadRoutes(app, {
    db,
    events: uploads,
    locks: uploadLocks,
    getSettings: () => resolveUploadSettings(config.get(), dataDir),
  });
  submissionRoutes(app, {
    config,
    db,
    jobs,
    submissions,
    uploads,
    getSettings: () => resolveUploadSettings(config.get(), dataDir),
    log: { warn: (obj, msg) => app.log.warn(obj, msg) },
  });

  // Live progress stream. Every job/upload/submission event is broadcast;
  // job clients filter by jobId, upload clients by dropId. `GET /api/jobs/:id`
  // replays job events after a reconnect.
  // Frames are scoped: admins see everything, submitters only their own
  // uploads (event.userId) and submission imports (job owner).
  // Unauthenticated upgrades are closed with 4401; when the session behind a
  // socket is revoked the socket is told and closed immediately.
  app.get("/api/ws", { websocket: true }, (socket, req) => {
    const resolved = sessions.resolve(req);
    if (!resolved) {
      socket.close(4401, "Unauthorized");
      return;
    }
    const isAdmin = resolved.user.role === "admin";

    const onJobEvent = (event: unknown) => {
      const jobId = (event as { jobId?: string }).jobId;
      if (!isAdmin && (!jobId || jobs.get(jobId)?.ownerId !== resolved.user.id)) {
        return;
      }
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "job", ...(event as object) }));
      }
    };
    const onUploadEvent = (event: unknown) => {
      const ownerId = (event as { userId?: string }).userId;
      if (!isAdmin && ownerId !== resolved.user.id) return;
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(event));
      }
    };
    const onSubmissionEvent = (event: unknown) => {
      const submitterId = (event as { submitterId?: string }).submitterId;
      if (!isAdmin && submitterId !== resolved.user.id) return;
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

    jobs.on("event", onJobEvent);
    uploads.on("event", onUploadEvent);
    submissions.on("event", onSubmissionEvent);
    authEvents.on("session-revoked", onRevoked);
    socket.on("close", () => {
      jobs.off("event", onJobEvent);
      uploads.off("event", onUploadEvent);
      submissions.off("event", onSubmissionEvent);
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

  return { app, config, db, jobs, uploads, submissions, uploadLocks, cleanup, authEvents };
}
