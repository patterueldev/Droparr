# M1 validation — real end-to-end import against real instances

Validation bench for [issue #14](https://github.com/patterueldev/Droparr/issues/14):
prove that files staged by Droparr are readable by real Sonarr/Radarr
instances through a shared storage view, and that the six M1 scenarios pass.

This directory is designed for the homeserver deployment (Droparr in Docker
next to the *arrs, shared staging volume, path mappings). All environment
specifics live in a gitignored `local.env`; API keys are read from the
server's `config.xml` files over SSH at runtime and never stored.

## Layout

| File | Purpose |
| --- | --- |
| `local.env.example` | Template for `local.env` (copy + fill in) |
| `server-compose.yaml` | Droparr compose service for the homeserver (build from repo, `mintfin` network, LAN-only port) |
| `deploy-server.sh` | Clones/updates the repo on the server, builds + starts Droparr, generates fixtures |
| `gen-fixtures.sh` | Tiny valid 1080p clips for every scenario (needs ffmpeg) |
| `setup.mjs` | Creates isolated test root folders, imports a generated settings JSON, tests connections |
| `run.mjs` | Runs the six scenarios, asserts against Droparr + the *arrs + staging, writes artifacts |
| `lib.mjs` | Shared helpers (env, fetch, SSH, *arr API) |

## Usage

```bash
cd <repo>
cp e2e/m1/local.env.example e2e/m1/local.env   # fill in server values
e2e/m1/deploy-server.sh                        # deploy + fixtures
node --env-file=e2e/m1/local.env e2e/m1/setup.mjs
node --env-file=e2e/m1/local.env e2e/m1/run.mjs
node --env-file=e2e/m1/local.env e2e/m1/run.mjs --cleanup   # remove test titles/files
```

Artifacts (job events, *arr payloads, history entries) are written to
`e2e/m1/.work/artifacts/<timestamp>/`. `run.mjs` exits non-zero if any
scenario fails.

## Scenarios

1. **movie** — movie drop → Radarr (non-anime): imported, renamed, history `success`
2. **tv** — season pack → Sonarr: episodes mapped, only the selected seasons monitored
3. **anime** — absolute-numbered drop → anime Sonarr: routed to the right category/root/profile
4. **duplicate** — title already in library: import-only, no duplicate add
5. **rejections** — an invalid episode is rejected by the *arr and surfaced (job result + history `partial`)
6. **copy** — copy mode keeps staged files (move mode deletes the staging drop after import)

## Notes

- **Isolated root folders**: `setup.mjs` creates `/media-03/DROPARR-TEST/{SERIES,ANIME,MOVIES}`
  and points the validation categories at them, so imports never touch the real
  library layout. `run.mjs --cleanup` removes the test titles again; the empty
  root folders can stay.
- **Permissions**: the Droparr container runs as `1000:1000` (the *arr PUID/PGID)
  so the *arrs can delete staged files during a `move` import.
- **Path mapping**: staging is `/data/staging` inside Droparr and
  `/media-03/.droparr/staging` as the *arrs see it — exactly the setup the
  validation is meant to prove.
- The runner is API-driven; the review screen itself (match search, category
  preselection, live progress, rejection rendering) is checked with a short
  manual UI pass — see `docs/validation/M1.md`.
