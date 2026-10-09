# Droparr

**Drop a folder. It's in your \*arr.**

Droparr is a self-hosted web app that takes an existing movie or series folder — messy names, mixed seasons, whatever — and handles the tedious part of getting it into Sonarr and Radarr:

- detects series vs movie, and routes anime vs standard drops to the right instance
- matches against TVDB/TMDB through your \*arr instances' own lookup APIs (no extra API keys)
- gives you a review screen to fix the match, pick seasons and monitoring
- stages files and lets Sonarr/Radarr do a native **manual import** — renaming, quality detection and moving stay inside the \*arr, exactly like the built-in UI

Optional extras: LLM-assisted matching for ugly filenames (off by default), and Jellyfin login with an admin approval queue for submissions from family and friends.

> **Status:** early development — plan and architecture are locked; implementation starts at milestone M1. See [`docs/PLAN.md`](docs/PLAN.md).

## Why not the built-in Library Import?

Sonarr and Radarr both ship a "Library Import" feature, but it is per-instance only, expects cleanly organized files inside a root folder, and cannot decide *which* of your instances (anime Sonarr? TV Sonarr? Radarr?) a drop belongs to. Droparr is the orchestration layer above that machinery. See [Prior art](docs/PLAN.md#prior-art-and-why-were-building-this).

## How it works

1. **Add** — drop folders (browser, chunked/resumable) or point at a server path / watch folder
2. **Analyze** — heuristics parse names (`S01E01`, absolute anime numbering, year), then query your \*arr lookups for matches
3. **Review** — fix the match, choose a category, seasons and monitoring; duplicates are handled ("import only" mode)
4. **Import** — files are staged, the title is added to Sonarr/Radarr, and a native manual import runs with live progress
5. **Play** — optional Jellyfin library refresh once it's done

## Roles

- **Admin** — full configuration, approval queue, instant imports
- **Submitter** — signs in with their Jellyfin account, drops files, tracks status; submissions wait in an approval queue unless an admin marks the account **trusted**

## Documentation

- [Product plan](docs/PLAN.md) — problem, scope, milestones, decision log
- [Architecture](docs/ARCHITECTURE.md) — stack, pipeline, verified \*arr/Jellyfin API mechanics, Cloudflare Tunnel constraints

## Development

pnpm monorepo — React 19 + Vite (web), Node + Fastify (server), TypeScript throughout, SQLite + JSON config, Docker for deployment.

Prerequisites: Node ≥ 22, pnpm ≥ 10.

```bash
pnpm install
pnpm dev          # API on :3100, web on :5173 (proxies /api)
```

Other commands:

```bash
pnpm -r typecheck  # typecheck all packages
pnpm -r test       # unit tests (analyzer, path mapping, staging)
pnpm --filter @droparr/web build   # build the web UI
```

Deploy with Docker:

```bash
docker compose up -d --build
```

The server serves the built UI and the API on a single port (`3100`).

Set `PUID`/`PGID` (default `1000:1000`) to the user that owns `./config` and
that your \*arr stack runs as, so quarantine uploads, config writes and SQLite
files stay readable by everyone involved; `UMASK` (default `022`) controls the
mode of newly created files. Settings → **Uploads & disk** covers the
quarantine directory, per-file and per-submission caps, the minimum free space
kept on the volume (uploads are refused/aborted below it), and the retention
window for abandoned and finished drops (default 7 days) with a manual
"Run cleanup now" action.

**First run:** open the UI — a setup wizard asks for your Jellyfin URL, then a
Jellyfin **admin** signs in and confirms; that account becomes the Droparr admin
and the wizard locks permanently (the lock lives in SQLite, so deleting
`config.json` cannot reopen it). While setup is incomplete, every API route
except health/auth/setup is blocked.

**After setup:** sign in with your Jellyfin account and configure instances,
categories and the staging directory in **Settings**. Jellyfin admins become
Droparr admins automatically; the **Users** tab lets an admin promote or
demote accounts, mark submitters **trusted** (skips the approval queue) and
**block** them (signs the account out everywhere and refuses new logins).
Other accounts can sign in and manage their own sessions; the submitter drop
flow arrives in M3. Droparr never stores Jellyfin passwords.

> Multi-arch note: images build on both `linux/arm64` (dev Mac) and
> `linux/amd64` (home server). Use `docker buildx build --platform linux/amd64,linux/arm64`.

## License

[MIT](LICENSE)
