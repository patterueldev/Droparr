import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UPLOAD_CHUNK_SIZE_BYTES } from "@droparr/shared";
import { buildApp, type BuiltApp } from "./app.js";
import { CREATION_BODY_LIMIT } from "./routes/uploads.js";

let built: BuiltApp | undefined;
let dir: string | undefined;

async function makeApp(): Promise<BuiltApp> {
  dir = await mkdtemp(join(tmpdir(), "droparr-app-"));
  built = await buildApp({
    dataDir: dir,
    configPath: join(dir, "config.json"),
    serveWeb: false,
    logger: false,
  });
  return built;
}

afterEach(async () => {
  await built?.app.close();
  built = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Cloudflare Tunnel hardening (M2.4)", () => {
  it("marks every API response Cache-Control: no-store", async () => {
    await makeApp();

    for (const url of ["/api/health", "/api/auth/status"]) {
      const res = await built!.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("does not add no-store to non-API responses", async () => {
    await makeApp();

    const res = await built!.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  it("answers an oversized request body with our JSON 413, not a proxy page", async () => {
    await makeApp();
    const oversized = "x".repeat(2 * 1024 * 1024);

    const res = await built!.app.inject({
      method: "POST",
      url: "/api/setup/jellyfin",
      payload: { baseUrl: oversized },
    });

    expect(res.statusCode).toBe(413);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json<{ code: string }>().code).toBe(
      "FST_ERR_CTP_BODY_TOO_LARGE",
    );
  });

  it("keeps the largest accepted body below Cloudflare's 100 MB proxy limit", () => {
    // One TUS chunk plus creation metadata is the biggest body any route
    // accepts; if this ever grows past Cloudflare's limit, uploads would be
    // rejected by the edge (HTML 413) instead of the server (JSON 4xx).
    const cloudflareMaxRequestBytes = 100 * 1024 * 1024;
    expect(UPLOAD_CHUNK_SIZE_BYTES + CREATION_BODY_LIMIT).toBeLessThan(
      cloudflareMaxRequestBytes,
    );
  });
});
