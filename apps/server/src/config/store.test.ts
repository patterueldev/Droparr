import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./store.js";

/**
 * Regression: the server used to crash on restart when stagingDir was still
 * empty ("") — the default for a fresh config — because the schema required
 * a non-empty string.
 */
describe("ConfigStore.load", () => {
  it("loads a fresh config whose stagingDir is still empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "droparr-store-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({ instances: [], categories: [], stagingDir: "" }),
      );
      const store = await ConfigStore.load(path);
      expect(store.get().stagingDir).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips saved config (save -> load)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "droparr-store-"));
    try {
      const path = join(dir, "config.json");
      const store = await ConfigStore.load(path);
      await store.addInstance({
        id: "a",
        name: "TV",
        kind: "series",
        baseUrl: "http://x.local:8989",
        apiKey: "k",
        pathMappings: [],
      });
      const reloaded = await ConfigStore.load(path);
      expect(reloaded.listInstances()).toHaveLength(1);
      expect(reloaded.getInstance("a")?.name).toBe("TV");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails with a clear message on invalid config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "droparr-store-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ instances: "nope" }));
      await expect(ConfigStore.load(path)).rejects.toThrow(
        /Invalid Droparr config at .*config\.json/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
