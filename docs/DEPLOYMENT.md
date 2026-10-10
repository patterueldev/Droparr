# Droparr — Deployment guide

> Primary target (M2.4, [#8](https://github.com/patterueldev/Droparr/issues/8)):
> Docker on the media server next to the \*arrs, exposed at
> `droparr.example.com` with **Cloudflare Tunnel**. The same image also runs
> LAN-only over plain HTTP (`http://<server>:3100`); every hardening measure
> degrades gracefully to that mode.

## Overview

```
visitor ──HTTPS──► Cloudflare edge ──tunnel──► cloudflared ──HTTP──► Droparr :3100
                   (TLS terminates,              (outbound-only      (Fastify API +
                    adds CF-Connecting-IP)        connection)         built React UI)
```

- No inbound ports: `cloudflared` dials out, so nothing is exposed on your router.
- TLS terminates at Cloudflare; `cloudflared` forwards plain HTTP to the container.
- Uploads are chunked at 32 MiB, far below Cloudflare's 100 MB request-body
  limit (Free/Pro) — see [Uploads](ARCHITECTURE.md#uploads-tus-subset-m31).
- The visitor address arrives in `CF-Connecting-IP`; Droparr uses it for login
  rate limits and the Sessions list instead of the spoofable leftmost
  `X-Forwarded-For` entry.

## Prerequisites

- Media server with Docker and Docker Compose v2.
- A domain on Cloudflare (full setup — Cloudflare manages its DNS).
- `cloudflared`, either as a container (token-based tunnel, recommended) or on
  the host.
- A Jellyfin URL reachable from the Droparr container, and a Jellyfin admin
  account for the first-run wizard.

## 1. Deploy Droparr

Images are published from this repository to GitHub Container Registry —
no registry login is needed (the package is public):

| Tag | Meaning |
| --- | --- |
| `ghcr.io/patterueldev/droparr:latest` | newest release candidate — moves with each `v1.0.0-rcN` tag |
| `ghcr.io/patterueldev/droparr:v1.0.0-rcN` | pinned candidates — use for reproducible installs and rollbacks |
| `ghcr.io/patterueldev/droparr:v1.0.0` | first official release (not published yet) |

The repo's [`docker-compose.yml`](../docker-compose.yml) is ready to use as-is
(adjust paths/PUID/PGID after copying), or write a standalone one:

```yaml
services:
  droparr:
    image: ghcr.io/patterueldev/droparr:latest
    container_name: droparr
    ports:
      - "3100:3100"            # use "127.0.0.1:3100:3100" when tunneled (below)
    environment:
      - DROPARR_DATA=/data
      - DROPARR_CONFIG=/config/config.json
      - PUID=1000              # match your *arr stack
      - PGID=1000
      - UMASK=022
    volumes:
      - ./config:/config
      - ./data:/data
      - ./staging:/data/staging
      # - /mnt/media/incoming:/incoming   # optional server-side drops
    restart: unless-stopped
```

```bash
mkdir -p config data staging
docker compose pull && docker compose up -d
curl -s http://localhost:3100/api/health   # → {"ok":true,"version":"v1.0.0-rcN"}
```

### For an automated install (agent checklist)

Everything above is non-interactive. The only human step is the first-run
wizard (it needs Jellyfin admin credentials — **never handle those** for the
user). In order:

1. Ensure Docker + Compose v2; render the compose file with the server's real
   paths, PUID/PGID (must match the \*arr stack), and the staging mount.
2. `docker compose pull && docker compose up -d`; verify `/api/health` returns
   the expected image version.
3. Set up the Cloudflare Tunnel (sections 2–3) and run the verification bench
   (section 4).
4. Hand over to the human: complete the wizard on the LAN (below), then
   configure instances, categories and the staging directory in Settings.

### Adjustment reference

The important settings:

| Setting | Why |
| --- | --- |
| `DROPARR_DATA=/data` | SQLite (sessions, history, upload state) + the default quarantine dir (`/data/quarantine`) |
| `DROPARR_CONFIG=/config/config.json` | JSON config (instances, categories, settings) |
| `PUID` / `PGID` (default `1000:1000`) | Must match the \*arr stack so the \*arrs can move staged files |
| `UMASK` (default `022`) | Mode of newly created files |
| `HOST=0.0.0.0` | Baked into the image: the container listens on all interfaces. Reachability is controlled by the **published port**, not this value |

### Volumes and the shared staging view

```yaml
volumes:
  - ./config:/config        # config.json
  - ./data:/data            # SQLite + quarantine uploads
  - ./staging:/data/staging # shared with the *arrs
```

| Container path | Purpose |
| --- | --- |
| `/config` | `config.json` — back this up |
| `/data` | SQLite + quarantine uploads — back this up |
| `/data/staging` | **Shared** staging dir. Droparr writes here; Sonarr/Radarr must see the same files at their own path |
| `/incoming` (optional) | Server-side drops for admin analysis |

The number-one setup gotcha: the staging directory looks different inside each
container. Configure the same path in **Settings → Staging directory** as
Droparr sees it, and add a per-instance **path mapping** for how the \*arrs
see it. Example: Droparr `/data/staging` ↔ \*arr `/media-03/.droparr/staging`.

### Port binding — only expose the origin to cloudflared

| `cloudflared` runs… | `docker-compose.yml` ports | Tunnel origin service |
| --- | --- | --- |
| on the host | `- "127.0.0.1:3100:3100"` | `http://localhost:3100` |
| in the same Compose project | *omit `ports` entirely* | `http://droparr:3100` |
| in another Compose project | `- "127.0.0.1:3100:3100"` | `http://host.docker.internal:3100` (needs `extra_hosts: host.docker.internal:host-gateway` on Linux) |

Keep the port on loopback (or unpublished). If LAN clients can reach `:3100`
directly, they bypass the Cloudflare edge and can spoof forwarding headers —
Droparr trusts `CF-Connecting-IP` for rate limiting and session records.

### First run — complete the wizard on the LAN

The setup wizard is necessarily unauthenticated while it is open. Complete it
over the LAN *before* exposing the instance through the tunnel:

1. Open `http://<server-ip>:3100`.
2. Enter your Jellyfin URL, sign in with a Jellyfin **admin** account.
3. Confirm — that account becomes the Droparr admin and the wizard locks
   permanently (the marker lives in SQLite; deleting `config.json` cannot
   reopen it).

Then configure instances, categories and the staging directory in **Settings**.

## 2. Create the Cloudflare Tunnel

### Option A — dashboard (token-based, recommended)

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** →
   **Create a tunnel** → **Cloudflared**.
2. Name it (e.g. `droparr`) and copy the **token** shown on the connector page.
3. Open the tunnel's **Public hostnames** tab → **Add a public hostname**:
   - Subdomain: `droparr`, domain: `example.com`
   - Service: `http://droparr:3100` (cloudflared in the same Compose project)
     or `http://localhost:3100` (cloudflared on the host)
4. Save — Cloudflare creates the proxied DNS record automatically.

The connector install command on that page (`cloudflared service install <token>`)
is for host installs; with Docker, use the token in Compose instead (below).

### Option B — CLI (locally-managed tunnel)

```bash
cloudflared tunnel login
cloudflared tunnel create droparr
cloudflared tunnel route dns droparr droparr.example.com
```

Then write `~/.cloudflared/config.yml`:

```yaml
tunnel: droparr
credentials-file: /home/you/.cloudflared/<UUID>.json
ingress:
  - hostname: droparr.example.com
    service: http://localhost:3100
  - service: http_status:404
```

## 3. Run cloudflared

### As a container (token-based)

Add a service next to Droparr — same Compose project so `http://droparr:3100`
resolves, and no published ports:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
```

Put the token in a `.env` file next to the compose file (never commit it), then
`docker compose up -d`.

### On the host

```bash
sudo cloudflared service install <token>     # token-based
# or, for a locally-managed tunnel:
sudo cloudflared service install             # picks up ~/.cloudflared/config.yml
```

No origin certificate is needed: TLS between the visitor and Cloudflare ends at
the edge, and cloudflared speaks plain HTTP to the container.

## 4. Verify the deployment

The repo ships a bench that checks a live tunnel deployment end-to-end
(`e2e/m2.4/`):

```bash
cp e2e/m2.4/local.env.example e2e/m2.4/local.env   # set DROPARR_URL + a login
node --env-file=e2e/m2.4/local.env e2e/m2.4/verify-tunnel.mjs
```

It verifies `Cache-Control: no-store`, cookie flags, that the Sessions list
records the public visitor IP, a JSON 413 for an oversized chunk (instead of a
Cloudflare HTML page) and the WebSocket path. Manual equivalents:

```bash
# no-store on every API response
curl -sI https://droparr.example.com/api/health | grep -i cache-control
# → cache-control: no-store

# cookie flags after a successful login (use a throwaway account/shell)
curl -si https://droparr.example.com/api/auth/login \
  -H 'content-type: application/json' \
  --data '{"username":"YOUR_USER","password":"YOUR_PASSWORD"}' \
  | grep -i '^set-cookie'
# → droparr_session=…; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=…
```

Then sign in through the public URL and open the Sessions list (**Settings →
Sessions** as an admin, **Account → Sessions** as a submitter): the current
session must show your **public** IP, not the server's LAN address. Login rate
limiting (20 attempts / 15 min per IP) keys on the same value, so a spoofed
`X-Forwarded-For` cannot buy extra attempts; the per-username lockout
(5 failures / 15 min, SQLite) is a second layer.

### Hardening checklist (issue #8 acceptance)

| Acceptance | How it is met | Verify |
| --- | --- | --- |
| Fresh tunnel deployment documented end-to-end | this guide | run `e2e/m2.4/verify-tunnel.mjs` after deploying |
| Rate limiting sees real client IPs | `clientIp()` prefers `CF-Connecting-IP` (`apps/server/src/http/client-ip.ts`) | Sessions list (Settings/Account) shows your public IP |
| Cookies carry the right flags in production | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` on HTTPS (`secure: "auto"`) | `curl` login above |
| `Cache-Control: no-store` on API routes | global `onSend` hook for `/api*` | `curl -sI …/api/health` |
| Body limit below Cloudflare's 100 MB | 32 MiB TUS chunks; explicit 1 MiB default body limit | oversized chunk → Droparr JSON 413 |
| Deployment write-up in `docs/`, linked from README | `docs/DEPLOYMENT.md` | — |

## 5. Optional: Cloudflare Access in front of the app

Access adds an identity check at the edge, before requests reach Droparr. It is
an extra gate, **not a replacement** for Droparr's Jellyfin login, roles and
approval queue.

- Zero Trust → **Access** → **Applications** → **Add an application** →
  **Self-hosted**, domain `droparr.example.com`, with a policy (e.g. allowed
  emails or one-time PIN).
- Protect the **whole hostname**. Path-scoped policies in front of `/api/*`
  break the SPA: browser `fetch` calls get a 302 to the Access login page
  instead of JSON, and the app cannot recover.
- Every visitor then needs an Access identity *and* a Jellyfin account. If you
  don't want that for submitters, skip Access and rely on Droparr roles
  (admins get everything, submitters are quarantined until approved).
- For automation (the verification bench, monitoring), create a **service
  token** and send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
- WebSockets work with the Access session cookie.

## Operations

```bash
# update to the newest release candidate
docker compose pull && docker compose up -d

# pin or roll back: set the image tag in docker-compose.yml, then
docker compose up -d

# logs
docker compose logs -f droparr cloudflared

# backup (state that matters)
./config/config.json          # instances, categories, settings
./data/droparr.db             # sessions, history, upload state
./data/quarantine/            # in-flight uploads (transient)
./staging/                    # shared with the *arrs
```

Release process (maintainer): tag `main` and push the tag — CI builds the
multi-arch image and publishes both the pinned tag and `latest`:

```bash
git tag v1.0.0-rc2 && git push origin v1.0.0-rc2
```

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `502 Bad Gateway` from Cloudflare | cloudflared cannot reach the origin — check the public hostname service URL, that the Droparr container is up, and `docker compose logs cloudflared` |
| Cloudflare HTML `413` page | request body over 100 MB from a non-chunked client. The web uploader never does this (32 MiB chunks); don't raise chunk sizes |
| Sessions list shows `172.x`/`127.0.0.1` | `CF-Connecting-IP` missing — traffic may bypass the tunnel (direct LAN port), or a Transform Rule removed visitor-IP headers |
| Cookie has no `Secure` | you're on plain HTTP (LAN) — expected; over the tunnel `X-Forwarded-Proto: https` triggers it |
| `409 { "code": "setup_required" }` | first-run wizard not completed — do it on the LAN |
| WebSocket closes with `4401` | no or expired session — sign in again; frames are owner-scoped by design |
| Tunnel hostname does not resolve | domain not on Cloudflare nameservers, or the proxied CNAME to `<UUID>.cfargotunnel.com` is missing |

> Cloudflare's Tunnel FAQ says visitor IPs are not "sent" to the origin — that
> refers to the connection source (always cloudflared). The visitor address is
> still delivered in the `CF-Connecting-IP` header, which is what Droparr reads.

## Related

- [Architecture](ARCHITECTURE.md) — Cloudflare Tunnel constraints, uploads, session model
- [Verification bench](../e2e/m2.4/README.md) — the live-deployment checks above
