import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "./config/store.js";
import { Db } from "./db.js";
import { JobRegistry } from "./jobs.js";
import { UploadEventBus } from "./uploads/events.js";
import { UploadLocks } from "./uploads/locks.js";
import { resolveUploadSettings } from "./uploads/settings.js";
import { instanceRoutes } from "./routes/instances.js";
import { categoryRoutes } from "./routes/categories.js";
import { fsRoutes } from "./routes/fs.js";
import { importRoutes } from "./routes/import.js";
import { historyRoutes } from "./routes/history.js";
import { settingsRoutes } from "./routes/settings.js";
import { uploadRoutes } from "./routes/uploads.js";

const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const dataDir = process.env.DROPARR_DATA ?? join(process.cwd(), "data");
  const config = await ConfigStore.load(process.env.DROPARR_CONFIG);
  const db = new Db(join(dataDir, "droparr.db"));
  const jobs = new JobRegistry();
  const uploads = new UploadEventBus();
  const uploadLocks = new UploadLocks();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    exposedHeaders: [
      "Location",
      "Upload-Offset",
      "Upload-Length",
      "Tus-Resumable",
    ],
  });
  await app.register(websocket);

  // API routes
  instanceRoutes(app, config);
  categoryRoutes(app, config);
  fsRoutes(app, {
    extraRoots: [resolveUploadSettings(config.get(), dataDir).quarantineDir],
  });
  importRoutes(app, { config, db, jobs });
  historyRoutes(app, db);
  settingsRoutes(app, config, dataDir);
  uploadRoutes(app, {
    db,
    events: uploads,
    locks: uploadLocks,
    getSettings: () => resolveUploadSettings(config.get(), dataDir),
  });

  // Live progress stream. Every job/upload event is broadcast; job clients
  // filter by jobId, upload clients by dropId. `GET /api/jobs/:id` replays
  // job events after a reconnect.
  app.get("/api/ws", { websocket: true }, (socket) => {
    const onJobEvent = (event: unknown) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "job", ...(event as object) }));
      }
    };
    const onUploadEvent = (event: unknown) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(event));
      }
    };
    jobs.on("event", onJobEvent);
    uploads.on("event", onUploadEvent);
    socket.on("close", () => {
      jobs.off("event", onJobEvent);
      uploads.off("event", onUploadEvent);
    });
  });

  app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));

  // Serve the built web app when present (production/Docker).
  // In dev, Vite serves the UI and proxies /api here.
  const webDist =
    process.env.DROPARR_WEB_DIST ??
    join(process.cwd(), "..", "web", "dist");
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

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Droparr server listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
