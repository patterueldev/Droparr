// Configure the deployed Droparr for the M1 validation bench:
//   1. create the isolated test root folders (host + each *arr)
//   2. import a generated settings JSON (instances, categories, staging)
//   3. test every instance connection
//
// Usage: node --env-file=e2e/m1/local.env e2e/m1/setup.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arr, arrKeys, droparr, env, ssh } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const roles = [
  {
    role: "sonarr_tv",
    id: "sonarr-tv",
    name: env("SONARR_TV_NAME", "TV Sonarr"),
    kind: "series",
    internal: env("SONARR_TV_INTERNAL"),
    root: env("SONARR_TV_ROOT"),
    profile: Number(env("SONARR_TV_PROFILE")),
    category: { id: "tv", name: env("TV_CATEGORY_NAME", "TV"), seriesType: "standard" },
  },
  {
    role: "sonarr_anime",
    id: "sonarr-anime",
    name: env("SONARR_ANIME_NAME", "Anime Sonarr"),
    kind: "series",
    internal: env("SONARR_ANIME_INTERNAL"),
    root: env("SONARR_ANIME_ROOT"),
    profile: Number(env("SONARR_ANIME_PROFILE")),
    category: { id: "anime", name: env("ANIME_CATEGORY_NAME", "Anime"), seriesType: "anime" },
  },
  {
    role: "radarr_movies",
    id: "radarr-movies",
    name: env("RADARR_MOVIES_NAME", "Movies Radarr"),
    kind: "movie",
    internal: env("RADARR_MOVIES_INTERNAL"),
    root: env("RADARR_MOVIES_ROOT"),
    profile: Number(env("RADARR_MOVIES_PROFILE")),
    category: { id: "movies", name: env("MOVIES_CATEGORY_NAME", "Movies"), seriesType: "standard" },
  },
];

const keys = arrKeys();

async function main() {
  // 1. Isolated test root folders on the host, owned by the *arr PUID/PGID.
  const testRootHost = env("TEST_ROOT_HOST_DIR");
  console.log(`==> Preparing test root folders under ${testRootHost}`);
  ssh(
    `mkdir -p '${testRootHost}/SERIES' '${testRootHost}/ANIME' '${testRootHost}/MOVIES' && chown -R 1000:1000 '${testRootHost}'`,
  );

  // 2. Ensure each *arr has its test root folder registered.
  for (const r of roles) {
    const roots = await arr(r.role, "/api/v3/rootfolder");
    if (!roots.some((x) => x.path === r.root)) {
      await arr(r.role, "/api/v3/rootfolder", {
        method: "POST",
        body: { path: r.root },
      });
      console.log(`==> Created root folder ${r.root} on ${r.name}`);
    }
  }

  // 3. Build + import the settings JSON (exercises the migration path).
  const stagingApp = env("STAGING_APP", "/data/staging");
  const stagingRemote = env("STAGING_REMOTE");
  const config = {
    instances: roles.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      baseUrl: r.internal,
      apiKey: keys[r.role],
      pathMappings: [{ app: stagingApp, remote: stagingRemote }],
    })),
    categories: roles.map((r) => ({
      id: r.category.id,
      name: r.category.name,
      kind: r.kind,
      instanceId: r.id,
      rootFolder: r.root,
      qualityProfileId: r.profile,
      tags: [],
      seriesType: r.category.seriesType,
    })),
    stagingDir: stagingApp,
  };
  const payload = {
    app: "droparr",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    config,
  };

  // Contains API keys — keep it in the gitignored .work dir only.
  mkdirSync(join(here, ".work"), { recursive: true });
  writeFileSync(
    join(here, ".work", "settings-import.json"),
    JSON.stringify(payload, null, 2),
  );

  console.log("==> Importing settings into Droparr");
  const result = await droparr("/api/settings/import", {
    method: "POST",
    body: payload,
  });
  for (const warning of result.warnings ?? []) console.log(`    ⚠ ${warning}`);
  console.log(
    `    ${result.summary.instances} instance(s), ${result.summary.categories} category(ies) imported`,
  );

  // 4. Connection tests.
  console.log("==> Testing instance connections");
  const instances = await droparr("/api/instances");
  for (const i of instances) {
    const t = await droparr(`/api/instances/${i.id}/test`, { method: "POST" });
    console.log(
      t.ok
        ? `    ✓ ${i.name}: ${t.appName} ${t.version}`
        : `    ✗ ${i.name}: ${t.error}`,
    );
    if (!t.ok) process.exitCode = 1;
  }

  console.log("\nNext: node --env-file=e2e/m1/local.env e2e/m1/run.mjs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
