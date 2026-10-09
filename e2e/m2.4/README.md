# M2.4 validation — Cloudflare Tunnel deployment checks

Verification bench for [issue #8](https://github.com/patterueldev/Droparr/issues/8):
prove that a live Droparr deployment behind a Cloudflare Tunnel carries the
right headers, cookies, client IPs and error surfaces end-to-end.

Deploy first (see [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)), then run
this against the public hostname. Node ≥ 22, no dependencies.

## Usage

```bash
cp e2e/m2.4/local.env.example e2e/m2.4/local.env   # fill in DROPARR_URL + a login
node --env-file=e2e/m2.4/local.env e2e/m2.4/verify-tunnel.mjs
```

The script exits non-zero if any check fails and prints a summary. Anonymous
checks (health/no-store, SPA, WebSocket) always run; the rest need
`DROPARR_USERNAME`/`DROPARR_PASSWORD` and are reported as skipped without them.

## Checks

| Check | Proves |
| --- | --- |
| Health + auth status are `Cache-Control: no-store` | API responses are never cached at the edge (M2.4) |
| Web UI served over the tunnel | DNS + connector + static serving work |
| Login cookie flags | `Secure` + `HttpOnly` + `SameSite=Lax` + `Path=/` in production |
| Session records the public visitor IP | `CF-Connecting-IP` plumbing (`clientIp()`), not cloudflared's address |
| Oversized chunk → JSON 413 | Droparr's own 4xx wins; no Cloudflare HTML error page |
| WebSocket upgrade closes `4401` unauthenticated | the WS path works through the tunnel and still enforces auth |
| Login limiter keys on the real client IP | rotating `X-Forwarded-For` cannot bypass the 20/15 min limit |

## Notes

- **`RATE_LIMIT_CHECK=1` consumes this public IP's login budget** (20 attempts
  / 15 min). After the check, browser sign-ins from the same network are
  limited for up to 15 minutes. Leave it off unless you are recording evidence.
- **Cloudflare Access**: if Access protects the hostname, create a service
  token (Zero Trust → Access → Service Auth) and set `CF_ACCESS_CLIENT_ID` /
  `CF_ACCESS_CLIENT_SECRET`. Without them every request is challenged and the
  script fails with a hint.
- The bench only accepts an `https://` URL — it is meant for the public tunnel
  hostname, not the LAN address.
- Copy the output into `docs/validation/M2.4.md` when recording a deployment
  run (date, hostname, results, any deviations).
