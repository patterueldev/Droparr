import type { FastifyInstance } from "fastify";
import { mkdir, stat } from "node:fs/promises";
import { z } from "zod";
import { JellyfinClient } from "@droparr/core";
import {
  jellyfinBaseUrlSchema,
  notificationSettingsSchema,
  uploadSettingsSchema,
} from "@droparr/shared";
import type { ConfigStore } from "../config/store.js";
import { buildExport, validateImport } from "../config/import.js";
import { deliverWebhook } from "../notifications/webhook.js";
import { auditSettingsStaging } from "../staging/check.js";
import { diskSpace } from "../uploads/disk.js";
import type { QuarantineCleanup } from "../uploads/cleanup.js";
import { resolveUploadSettings } from "../uploads/settings.js";

const settingsSchema = z.object({
  stagingDir: z.string().optional(),
  uploads: uploadSettingsSchema.optional(),
  jellyfin: z
    .object({ baseUrl: jellyfinBaseUrlSchema, apiKey: z.string().optional() })
    .optional(),
  notifications: notificationSettingsSchema.optional(),
  llm: z
    .object({ provider: z.string(), apiKey: z.string(), model: z.string() })
    .optional(),
});

export interface SettingsRouteDeps {
  /** Quarantine sweep scheduler (status + manual trigger). */
  cleanup: QuarantineCleanup;
}

export function settingsRoutes(
  app: FastifyInstance,
  config: ConfigStore,
  dataDir: string,
  deps: SettingsRouteDeps,
): void {
  // Return the upload policy with defaults resolved so the client can
  // pre-flight file sizes and show the quarantine location.
  const withResolvedUploads = () => ({
    ...config.get(),
    uploads: resolveUploadSettings(config.get(), dataDir),
  });

  app.get("/api/settings", async () => withResolvedUploads());

  app.put("/api/settings", async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    await config.updateSettings(parsed.data);
    return withResolvedUploads();
  });

  /** Connection feedback for the Settings → Jellyfin section (admin only). */
  app.post("/api/settings/jellyfin/test", async (req, reply) => {
    const parsed = z
      .object({ baseUrl: jellyfinBaseUrlSchema })
      .safeParse(req.body);
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
  });

  /**
   * Test webhook for Settings → Notifications (admin only). Tests the form's
   * current values, so it works before saving and while notifications are
   * disabled. Delivery failures answer 502 with the transport error.
   */
  app.post("/api/settings/notifications/test", async (req, reply) => {
    const parsed = notificationSettingsSchema
      .pick({ url: true, format: true })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const result = await deliverWebhook(parsed.data.format, parsed.data.url, {
      title: "Droparr test notification",
      body: "If you can read this, Droparr notifications are configured correctly.",
      priority: "default",
    });
    if (!result.ok) {
      return reply.code(502).send({ ok: false, error: result.error });
    }
    return { ok: true, format: parsed.data.format };
  });

  /**
   * Advisory staging-visibility audit for Settings: can every instance used by
   * a category see the staging dir, and does it exist on this machine?
   */
  app.get("/api/settings/staging-check", async () =>
    auditSettingsStaging(config.get()),
  );

  /**
   * Free/total bytes on the quarantine volume for Settings → Uploads, plus
   * whether the configured headroom is currently met.
   */
  app.get("/api/settings/disk", async (_req, reply) => {
    const settings = resolveUploadSettings(config.get(), dataDir);
    try {
      await mkdir(settings.quarantineDir, { recursive: true });
      const { freeBytes, totalBytes } = await diskSpace(settings.quarantineDir);
      return {
        quarantineDir: settings.quarantineDir,
        freeBytes,
        totalBytes,
        minFreeSpaceBytes: settings.minFreeSpaceBytes,
        belowThreshold:
          settings.minFreeSpaceBytes > 0 &&
          freeBytes < settings.minFreeSpaceBytes,
      };
    } catch (err) {
      return reply.code(500).send({
        error: `Cannot read disk space for ${settings.quarantineDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  });

  /** Quarantine cleanup status for Settings → Uploads. */
  app.get("/api/settings/cleanup", async () => ({
    retentionDays: resolveUploadSettings(config.get(), dataDir).retentionDays,
    ...deps.cleanup.status(),
  }));

  /** Run one sweep now (the "Run cleanup now" button). */
  app.post("/api/settings/cleanup/run", async () => deps.cleanup.runNow());

  /**
   * Export the full configuration as a versioned JSON file.
   * NOTE: contains API keys — the UI warns about this.
   */
  app.get("/api/settings/export", async (_req, reply) => {
    const filename = `droparr-settings-${new Date().toISOString().slice(0, 10)}.json`;
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return buildExport(config.get());
  });

  /**
   * Import a settings file, replacing the whole configuration.
   * Returns warnings for anything that was reconciled (missing staging dir,
   * pruned categories, …) so the UI can tell the user exactly what happened.
   */
  app.post("/api/settings/import", async (req, reply) => {
    const result = validateImport(req.body);
    if (!result.ok) {
      return reply.code(400).send({ error: result.errors });
    }

    const warnings = [...result.warnings];

    // Machine-specific paths may not exist on this host (e.g. Mac → server).
    if (!result.config.stagingDir) {
      warnings.push(
        "Staging directory is not set — configure it in Settings before importing anything.",
      );
    } else {
      try {
        const st = await stat(result.config.stagingDir);
        if (!st.isDirectory()) {
          warnings.push(
            `Staging directory "${result.config.stagingDir}" is not a directory on this machine — update it in Settings.`,
          );
        }
      } catch {
        warnings.push(
          `Staging directory "${result.config.stagingDir}" does not exist on this machine — update it in Settings.`,
        );
      }
    }

    await config.replace(result.config);

    return {
      ok: true,
      warnings,
      summary: {
        instances: result.config.instances.length,
        categories: result.config.categories.length,
      },
    };
  });
}
