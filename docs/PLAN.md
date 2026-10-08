# Droparr — Product Plan

> Status: **locked** (2026-10-08) · Next step: milestone M1 implementation

## The problem

Existing media (movies/series already on disk) is painful to get into the \*arr stack:

1. copy the folder to the server's storage
2. open the right Sonarr/Radarr instance
3. add the missing title
4. run a manual import and fix mismatches by hand

With multiple instances (anime Sonarr, TV Sonarr, anime Radarr, movie Radarr) you must first decide *where* a drop belongs. Sonarr/Radarr's built-in "Library Import" only helps when files are already perfectly organized inside a root folder of that one instance, and it cannot route a drop across instances.

Droparr turns this into **drop → review → import**, with optional admin approval for other people's submissions.

## Users and roles

| Role | Who | Capabilities |
| --- | --- | --- |
| **Admin** | Patrick | full configuration, approval queue, instant imports |
| **Submitter** | e.g. sister | signs in with a Jellyfin account, drops files, tracks submission status |

Submitters require admin approval before anything touches Sonarr/Radarr. A per-user **trusted** toggle can skip approval later. Admins auto-approve their own drops.

## Core journeys

### Admin

1. Sign in (Jellyfin credentials).
2. Add folder(s): server path / watch folder / native picker / browser upload.
3. Review the auto-detected match, category, seasons, monitoring.
4. Submit → staged → added → natively imported by Sonarr/Radarr → history entry.

### Submitter (e.g. the sister)

1. Open the Droparr link, sign in with Jellyfin credentials.
2. Drag & drop files (chunked, resumable upload).
3. Confirm the suggested match (simplified view — no categories/profiles noise).
4. Submission enters the pending queue; admin approves or rejects.
5. Status page shows progress; optional notification when it's ready.

## Scope (v1)

**In:**

- instances and categories configuration (unlimited, never hardcoded to specific servers)
- series and movies
- analysis: heuristics first (`SxxExx`, absolute anime numbering, year), then \*arr lookup matching
- review UI: change match, category, seasons, monitor mode
- staging + add + \*arr-native manual import (`move` / `copy`)
- dedupe detection (title already in library → "import only" mode)
- Jellyfin login, approval queue, resumable uploads, history
- Docker deployment (compose alongside the \*arrs)
- optional LLM assist (off by default)

**Out (for now):**

- deleting or upgrading existing library files
- torrent client integration / seeding management (hardlink support later)
- re-implementing rename/quality logic (delegated to the \*arrs)
- multi-tenant quotas and the wider Jellyseerr feature set

## Configuration model

- **Instance** — name, kind (`series` | `movie`), `baseUrl`, `apiKey`, path mappings (`app` path ↔ `remote` path as the instance sees it)
- **Category** — name, instance, root folder, quality profile, tags, series type (`standard` | `anime` | `daily`). Categories are just routing presets and are fully user-defined
- **Settings** — staging directory, Jellyfin connection, optional LLM provider, optional notification webhooks

## Milestones

### M1 — Core pipeline (dev mode, LAN only, do not expose yet)

- [ ] monorepo scaffold + tooling
- [ ] Docker packaging (primary deployment target)
- [ ] config store + instance/category CRUD + connection test
- [ ] folder analysis (series/movie/anime heuristics)
- [ ] review UI (match search via \*arr lookup, category, seasons, monitor, dedupe)
- [ ] staging copy + path-mapping validation
- [ ] add to Sonarr/Radarr + manual-import preflight + import command + live progress
- [ ] history

### M2 — Identity (safe to expose)

- [ ] Jellyfin login + sessions
- [ ] first-run setup wizard (Jellyfin admin → Droparr admin)
- [ ] roles + per-user trust toggle
- [ ] Cloudflare Tunnel deployment docs

### M3 — Shared mode (sister onboarded)

- [ ] TUS-style chunked/resumable uploads (32 MB chunks)
- [ ] quarantine + disk guards + cleanup policy
- [ ] pending queue + approve/reject with inline edits
- [ ] submission status page
- [ ] optional ntfy/Discord webhook on pending submissions

### M4 — Intelligence & integrations

- [ ] LLM plugin (OpenAI-compatible: OpenAI, DeepSeek, Ollama, OpenRouter)
- [ ] anime heuristics polish
- [ ] watch folder ingest
- [ ] Jellyfin library refresh + "ready" notification

### M5 — Public release polish

- [ ] README/demo GIF, deployment guide, security notes
- [ ] optional guest invite links
- [ ] optional OIDC auth provider
- [ ] optional desktop wrapper (Tauri)

## Prior art (and why we're building this)

| Project | What it is | Gap |
| --- | --- | --- |
| Sonarr/Radarr **Library Import** | built-in existing-library scanner | per-instance; needs properly named/organized files in a root folder; no cross-instance routing |
| **Addarr** (283★) | Telegram bot to add titles | metadata only, no files |
| **DAPS** (318★) | \*arr post-processing script collection | power-user scripts; no UI, no detection, no review/approval |
| **justimport**, **ARR-Import-Suite**, **sonarr-import** | queue fixing, list imports, small CLIs | none own "drop → detect → review → route → import" |
| **Jellyseerr/Overseerr** | request management | not about files you already have |

## Decision log

| Date | Decision | Notes |
| --- | --- | --- |
| 2026-10-08 | Name: **Droparr** | GitHub org/user, npm, PyPI all free; "drop a folder, it's in your \*arr". Repo: `patterueldev/Droparr` |
| 2026-10-08 | Deployment: **Docker on the media server** | always-on and reachable by submitters; shared volumes with the \*arrs. Supersedes the earlier "local on Mac" choice |
| 2026-10-08 | Exposure: **Cloudflare Tunnel** to a subdomain (e.g. `droparr.example.com`) | consequence: 100 MB request-body limit → chunked uploads (see architecture) |
| 2026-10-08 | Auth: **Jellyfin login now** | `POST /Users/AuthenticateByName`; Jellyfin admin flag grants Droparr admin; sessions server-side; passwords never stored |
| 2026-10-08 | Approval: non-admin submissions require approval; per-user trust toggle; admins auto-approve | invite links dropped for MVP (possible future guest feature) |
| 2026-10-08 | LLM: **pluggable, off by default** | OpenAI-compatible providers; only file/folder names and metadata are ever sent; results cached |
| 2026-10-08 | Anime routing: heuristics pre-select the category, review always allows override | never trust detection blindly |
| 2026-10-08 | License: **MIT** | |

## Open questions

- Hardlink/staging strategy for seeding setups (deferred, tracked under "Out")
- Per-category auto-approve rules (e.g. trusted user + movies only) — revisit after M3
- Whether to surface "cutoff unmet" searches after import (probably never by default: we want no surprise downloads)
