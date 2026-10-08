# Droparr — Architecture

> Captured 2026-10-08. Verified against the Sonarr/Radarr `develop` OpenAPI specs and source, the Jellyfin stable OpenAPI spec, and Cloudflare documentation.

## Overview

```
┌────────────┐   HTTPS (Cloudflare Tunnel)   ┌──────────────────────────────┐
│  Browser   │ ────────────────────────────► │  Droparr (Docker)            │
│ admin /    │ ◄──── WebSocket progress ──── │  Fastify API + React SPA     │
│ submitter  │                               │  SQLite + JSON config        │
└────────────┘                               └───────┬──────────┬───────────┘
                                                     │          │
                             shared staging volume   │          │ /api/v3
                                     ┌───────────────┘          │
                                     ▼                          ▼
                              Sonarr ×2 / Radarr ×2   (anime / TV / movies)
```

Design principle: **Droparr never re-implements renaming, quality detection, or file moves.** It stages files and asks the target \*arr to run a **manual import** — the same machinery the \*arr UIs use — with `importMode: move | copy`. All file paths exchanged with an instance go through **per-instance path mappings** (`appPath ↔ instancePath`), the number-one setup gotcha.

## Tech stack

- **Monorepo**: pnpm workspaces
  - `apps/web` — React 19 + Vite + TypeScript + Tailwind + TanStack Query
  - `apps/server` — Node 22+ + Fastify + TypeScript + zod
  - `packages/core` — pure TypeScript: \*arr clients, analyzer/parser, staging planner (unit-tested)
  - `packages/shared` — zod schemas + shared types
- **Storage**: JSON config file (v1) + SQLite (sessions, submissions, history)
- **Realtime**: WebSocket for upload/import progress (works reliably through Cloudflare Tunnel)
- **Packaging**: single Docker image + `docker-compose.yml` example; runs alongside the \*arrs with a shared staging volume

## Data model (v1)

```ts
Instance  { id, name, kind: "series" | "movie", baseUrl, apiKey,
            pathMappings: { app: string; remote: string }[] }

Category  { id, name, kind, instanceId, rootFolder, qualityProfileId?,
            tags: string[], seriesType: "standard" | "anime" | "daily" }

Submission { id, submitterId,
             state: "uploading" | "analyzing" | "pending" | "approved"
                  | "importing" | "done" | "rejected",
             files: FileRef[], analysis: FolderAnalysis }

User      { id, jellyfinUserId, name, role: "admin" | "submitter",
            trusted: boolean, blocked: boolean }

HistoryEntry { id, instanceId, kind, title, year, matchedId, titleSlug?, files,
               rejectedFiles?, result, timestamps }
             // instanceName/link are resolved from config when read
```

## Import pipeline

1. **Ingest** (one of):
   - browser upload — chunked/resumable into the quarantine dir (M3, submitters)
   - server-side path — analyzed in place or copied to staging (M1, admin)
   - watch folder — server paths monitored for new drops (M4)
2. **Analyze** — enumerate video files (skip samples/extras), parse names:
   - `SxxExx`, `1x01`, season folders → series
   - absolute numbering (`Show - 01`, `[Group] Show - 12 (1080p)`) → anime-style series (needs ≥ 2 files to be confident)
   - year in folder/file → movie
   - release-tag stripping (`1080p`, `x265`, `WEB-DL`, …) to clean titles
   - multi-movie drops (≥ 2 sibling folders with videos, no episode patterns) → fan out into one movie item per folder; extras/disc-style folders are not items, loose root files become an extra item, and each item runs its own staging → add → manual-import pipeline with its own history entry
3. **Match** — query the *target instance's own* lookup API:
   - `GET /api/v3/series/lookup?term=…` (Sonarr / TVDB)
   - `GET /api/v3/movie/lookup?term=…` (Radarr / TMDB)
   - No TVDB/TMDB keys needed inside Droparr.
   - Exact normalized title + year → high-confidence auto-match; otherwise the review UI shows candidates.
   - Optional LLM: clean borderline names / rank candidates (pluggable, off by default)
4. **Review** — match search, category, season selection, monitor mode, dedupe checks:
   - title already in library → "import only" mode
   - files already imported → warn / skip
5. **Stage** — copy/move into the shared staging dir, mapped to the target instance's view. Uploads may use the quarantine dir directly as staging (no double copy) when the \*arr can read it.
6. **Execute**:
   - ensure the title exists: `POST /api/v3/series | /movie` with monitoring on and `searchForMissingEpisodes: false` / `searchForMovie: false`
   - preflight: `GET /api/v3/manualimport?folder=…` — the \*arr parses staged files itself and returns matches, episode IDs, quality and **rejections** (surfaced in the UI)
   - import: `POST /api/v3/command` `{ name: "ManualImport", files: […], importMode: "move" }`
   - poll `GET /api/v3/command/{id}` (pushed to the UI over WebSocket)
7. **Verify & finish** — episode/movie file counts, links to the \*arr UI, optional Jellyfin `POST /Library/Refresh`, history entry, staging cleanup.

## Uploads (TUS subset, M3.1)

Browser drops upload in 32 MiB PATCH chunks — never single-request uploads —
so multi-GB files pass through the Cloudflare Tunnel's 100 MB body limit.
The client is `tus-js-client`; the server implements the subset it needs
(creation + termination extensions; no concatenation, checksums, or deferred
lengths).

| Call | Purpose |
| --- | --- |
| `OPTIONS /api/uploads` | capabilities: `Tus-Version`, `Tus-Extension: creation,termination`, `Tus-Max-Size` (per-file cap) |
| `POST /api/uploads` | create with `Upload-Length` + `Upload-Metadata` (`filename`, `filetype`, `relpath`, `dropid`) → `201` + `Location` |
| `HEAD /api/uploads/:id` | resume probe → `Upload-Offset` / `Upload-Length`, `Cache-Control: no-store` |
| `PATCH /api/uploads/:id` | append a chunk at `Upload-Offset` (`application/offset+octet-stream`) → `204` + new offset; `409` on offset mismatch, `423` while another write holds the upload, `413` over the chunk/size caps |
| `DELETE /api/uploads/:id` | cancel + remove the partial file |
| `GET /api/uploads?dropId=…` | Droparr extension: files of a drop + `completePath` once every file is done |

Upload state (offset, filename, size, drop id) lives in SQLite; chunks are
written straight to `<quarantineDir>/<dropId>/<relPath>` and fsynced **before**
the offset is committed, so a crash never commits bytes that are not on disk.
A killed browser resumes at the stored offset: tus-js-client fingerprints
files (name/size/mtime) in localStorage, and re-adding the same files HEADs
the server before continuing. Progress events ride the existing `/api/ws`
channel (`type: "upload"`; job events are tagged `type: "job"`).

Allowlist: video + subtitle extensions shared with the analyzer
(`packages/shared/src/media.ts`); per-file and per-drop caps default to
64 GiB / 256 GiB (`config.uploads`, `0` = unlimited). The quarantine directory
defaults to `<dataDir>/quarantine`; when `DROPARR_BROWSE_ROOTS` is set it is
added to the allowed browse roots automatically so `/api/analyze` can read
completed drops.

## Verified \*arr API surface

### Sonarr v4+ (`X-Api-Key` header, base `/api/v3`)

| Purpose | Call |
| --- | --- |
| connection test | `GET /system/status` |
| dropdown data | `GET /rootfolder`, `GET /qualityprofile`, `GET /tag` |
| matching | `GET /series/lookup?term=…` |
| existing library | `GET /series` |
| add series | `POST /series` — `SeriesResource`; `addOptions.monitor`, `addOptions.searchForMissingEpisodes: false`; `seriesType: standard \| anime \| daily` |
| preflight | `GET /manualimport?folder=…&filterExistingFiles=false` |
| import | `POST /command` — `{ name: "ManualImport", files: [{ path, seriesId, episodeIds, quality, languages, releaseGroup }], importMode: "move" \| "copy" }` |
| fallbacks | `POST /command` — `{ name: "RescanSeries", seriesId }` or `{ name: "DownloadedEpisodesScan", path, downloadClientId, importMode }` |
| library import | `POST /series/import` |

### Radarr v5+

Mirrors Sonarr with `movieId`, `addOptions.searchForMovie: false`, `RescanMovie`, `DownloadedMoviesScan`, `POST /movie/import`.

Source of truth: `src/NzbDrone.Core/MediaFiles/**/Manual/ManualImportCommand.cs` and `ManualImportFile.cs`, `src/*.Api.V3/ManualImport/ManualImportController.cs` in both repositories, plus their generated OpenAPI specs (both currently report API version `3.0.0`).

## Jellyfin authentication

- Login: `POST {jellyfin}/Users/AuthenticateByName`, body `{ Username, Pw }` → `{ User, SessionInfo, AccessToken, ServerId }`; `User.Policy.IsAdministrator` is available.
- Droparr extracts identity immediately, **never stores passwords**, and creates its own server-side session (secure, HttpOnly cookie).
- First-run setup wizard requires a Jellyfin admin login → that account becomes the Droparr admin; the wizard locks afterwards.
- Jellyfin admins auto-grant Droparr admin (overridable); everyone else is a submitter pending approval.
- Optional Jellyfin API key (admin-generated) for avatars and `POST /Library/Refresh` after imports.

### Session model (M2.1)

- Every request carries Jellyfin's client-info header (`MediaBrowser Client="Droparr", Device=…, DeviceId=…`). The transient `AccessToken` from a successful login is revoked via `POST /Sessions/Logout` immediately and never stored.
- Sessions live server-side in SQLite: the `droparr_session` cookie holds a 256-bit random token, only its SHA-256 hash is persisted. Flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` only on HTTPS (`secure: "auto"`) — the same code path works on LAN http and behind the Tunnel (M2.4).
- Sliding 30-day expiry, touched at most hourly; expired sessions and sessions belonging to blocked users are dropped when used.
- Login protection: 20 requests / 15 min per IP (`@fastify/rate-limit`) plus a per-username lockout after 5 failed credentials for 15 min (SQLite, survives restarts). Only Jellyfin 401/403 count as failures; outages return 502 without counting. Unknown users and wrong passwords get the same generic 401.
- All `/api/*` routes require a session; non-auth routes are admin-only until M3 adds submitter routes. `/api/ws` closes unauthenticated upgrades with 4401, and revoking a session notifies + closes that browser's socket.
- First-run setup wizard (M2.2): `GET /api/setup/status` and the `/api/setup/jellyfin[/test]` steps are open while setup is incomplete; the admin signs in through the regular login route, and `POST /api/setup/complete` requires an admin session and records the lock. The marker lives in the SQLite `setup` table, so deleting the config file never reopens the wizard. Until it is set, every `/api` route except health/auth/setup answers `409 { code: "setup_required" }`. Installs that predate the wizard backfill the marker on first boot when an admin exists and Jellyfin is configured. Settings → Jellyfin tests a URL via `GET /System/Info/Public` and lets admins change it.

## Cloudflare Tunnel constraints (engineering requirements)

| Constraint | Mitigation |
| --- | --- |
| **100 MB max request body** on proxied traffic (Free/Pro; 200 MB Business; 500 MB Enterprise) — Tunnel traffic is proxied | chunked/resumable uploads, 32 MB chunks (TUS-style); never single-request uploads |
| 100 s origin response timeout | chunk requests are short; imports are async commands + polling, not held requests |
| TLS terminates at Cloudflare | Fastify `trustProxy`, `Secure` + `HttpOnly` + `SameSite` cookies; real client IP via `CF-Connecting-IP` |
| Proxy buffering quirks | WebSocket for progress (supported through Tunnel); `Cache-Control: no-store` on API routes |
| Error surface | Fastify body limit below 100 MB so our 4xx (not Cloudflare's 413) is returned |

Noted alternative: a DNS-only record bypasses the limit but exposes the origin IP — not recommended.

## Security model

- Jellyfin login with rate limiting + lockout; sessions in SQLite; admin can revoke.
- First-run setup is necessarily unauthenticated while it is open — on a fresh install, complete the wizard on the LAN before exposing the instance through the Tunnel.
- Non-admin submissions are quarantined until approved; nothing reaches the \*arrs before approval.
- Upload allowlist (video + subtitle extensions), configurable size caps, free-space guards, rejected-upload cleanup (default 7 days).
- Path-traversal guards on all filesystem endpoints; API keys stored server-side, env-overridable, never logged.
- Optional Cloudflare Access in front of admin routes for extra hardening.

## Edge cases to handle

- multi-movie folders: ≥ 2 sibling movie folders fan out into N independently matchable items (`POST /api/import/batch` runs one pipeline + history entry each; loose root files import as an extra item)
- anime: absolute numbering, S00 specials, OVAs, fansub junk
- season packs and multi-season drops; multi-episode files
- duplicates: title exists (import-only), file exists (skip), re-submission of the same files
- samples, `.nfo` and subtitle sidecars, `.part` junk, macOS `._` AppleDouble files
- permissions/ownership in Docker (PUID/PGID); hardlinks for seeding (later)
- interrupted copies/uploads (resume); disk-full mid-copy
- SMB mounts remounting at different paths (`/Volumes/media-1`) → clear remap UX

## Milestone mapping

| Milestone | Components |
| --- | --- |
| M1 | config store, \*arr clients, analyzer, review UI, staging + import, history |
| M2 | Jellyfin auth, setup wizard, sessions, roles, Tunnel docs |
| M3 | chunked uploads, quarantine, approval queue, notifications, cleanup |
| M4 | LLM plugin, watch folder, Jellyfin refresh, anime polish |
| M5 | guest links, OIDC, desktop wrapper, release polish |
