import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

/**
 * Real client IP behind a trusted proxy.
 *
 * Cloudflare's edge always overwrites `CF-Connecting-IP` with the visitor
 * address, while it *appends* to a client-supplied `X-Forwarded-For`
 * (`X-Forwarded-For: spoofed, real-ip` — cloudflare/cloudflared#1426).
 * Fastify's `trustProxy: true` resolves `req.ip` to the leftmost XFF entry,
 * which a visitor can therefore spoof through the Tunnel, so the Cloudflare
 * header wins when it is a valid single IP. Direct LAN requests and other
 * reverse proxies fall back to Fastify's resolved `req.ip`.
 *
 * The same value keys login/setup rate limits and is stored on sessions, so
 * both the limiter and the Sessions page see the real visitor, not the local
 * `cloudflared` address.
 */
export function clientIp(req: FastifyRequest): string {
  const header = req.headers["cf-connecting-ip"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined) {
    const candidate = value.trim();
    // Validate before trusting: a malformed value must not become a
    // rate-limit key (or end up on a session row) verbatim.
    if (isIP(candidate) !== 0) return candidate;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
