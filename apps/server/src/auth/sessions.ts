import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "@droparr/shared";
import type { Db, StoredSession } from "../db.js";

export const SESSION_COOKIE = "droparr_session";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // write at most hourly

export interface ResolvedSession {
  user: User;
  session: StoredSession;
  /** True when expiry slid forward and the cookie should be refreshed. */
  refreshed: boolean;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionServiceOptions {
  ttlMs?: number;
  touchIntervalMs?: number;
  now?: () => Date;
}

/**
 * Server-side sessions. The browser cookie carries a 256-bit random token;
 * SQLite stores only its SHA-256 hash, so a database leak does not yield
 * usable session tokens.
 */
export class SessionService {
  private readonly db: Db;
  private readonly ttlMs: number;
  private readonly touchIntervalMs: number;
  private readonly now: () => Date;

  constructor(db: Db, opts: SessionServiceOptions = {}) {
    this.db = db;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.touchIntervalMs = opts.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
  }

  create(
    userId: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): { token: string; session: StoredSession } {
    const now = this.now();
    // Opportunistic cleanup — logins are infrequent, expired rows shouldn't
    // accumulate on long-running servers.
    this.db.pruneExpiredSessions(now.toISOString());
    const token = randomBytes(32).toString("base64url");
    const session: StoredSession = {
      id: nanoid(12),
      userId,
      tokenHash: hashSessionToken(token),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      userAgent: meta.userAgent,
      ip: meta.ip,
    };
    this.db.createSession(session);
    return { token, session };
  }

  /**
   * Resolve the session cookie on a request. Expired sessions (and sessions
   * of blocked/deleted users) are dropped; stale but valid sessions slide
   * their expiry forward and refresh the cookie when a reply is provided.
   */
  resolve(
    req: FastifyRequest,
    reply?: FastifyReply,
  ): ResolvedSession | undefined {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return undefined;

    const session = this.db.getSessionByTokenHash(hashSessionToken(token));
    if (!session) return undefined;

    const now = this.now();
    if (new Date(session.expiresAt).getTime() <= now.getTime()) {
      this.db.deleteSession(session.id);
      return undefined;
    }

    const user = this.db.getUser(session.userId);
    if (!user || user.blocked) {
      this.db.deleteSession(session.id);
      return undefined;
    }

    let refreshed = false;
    if (
      now.getTime() - new Date(session.lastSeenAt).getTime() >
      this.touchIntervalMs
    ) {
      const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
      this.db.touchSession(session.id, now.toISOString(), expiresAt);
      session.lastSeenAt = now.toISOString();
      session.expiresAt = expiresAt;
      refreshed = true;
      if (reply) this.setCookie(reply, token);
    }

    return { user, session, refreshed };
  }

  setCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Secure is only added on HTTPS requests, so the same code path works
      // on LAN http today and behind the Cloudflare Tunnel (M2.4).
      secure: "auto",
      maxAge: Math.floor(this.ttlMs / 1000),
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }
}
