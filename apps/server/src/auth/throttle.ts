import type { Db } from "../db.js";

export interface ThrottleOptions {
  /** Failed credentials allowed per username before locking. Default 5. */
  maxFailures?: number;
  /** Failure window. Default 15 minutes. */
  windowMs?: number;
  /** Lockout duration. Default 15 minutes. */
  lockMs?: number;
  now?: () => Date;
}

export interface LockState {
  locked: boolean;
  retryAfterSeconds: number;
}

/**
 * Per-username failed-login lockout, persisted in SQLite so restarts don't
 * reset it. Per-IP burst limiting is handled by @fastify/rate-limit on the
 * login route.
 */
export class LoginThrottle {
  private readonly db: Db;
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly now: () => Date;

  constructor(db: Db, opts: ThrottleOptions = {}) {
    this.db = db;
    this.maxFailures = opts.maxFailures ?? 5;
    this.windowMs = opts.windowMs ?? 15 * 60 * 1000;
    this.lockMs = opts.lockMs ?? 15 * 60 * 1000;
    this.now = opts.now ?? (() => new Date());
  }

  private key(username: string): string {
    return `user:${username.trim().toLowerCase()}`;
  }

  check(username: string): LockState {
    const key = this.key(username);
    const state = this.db.getAuthFailure(key);
    if (!state) return { locked: false, retryAfterSeconds: 0 };

    const now = this.now().getTime();
    if (state.lockedUntil) {
      const until = new Date(state.lockedUntil).getTime();
      if (until > now) {
        return {
          locked: true,
          retryAfterSeconds: Math.ceil((until - now) / 1000),
        };
      }
      // Lock expired — start fresh.
      this.db.clearAuthFailure(key);
      return { locked: false, retryAfterSeconds: 0 };
    }

    if (new Date(state.windowStart).getTime() + this.windowMs <= now) {
      this.db.clearAuthFailure(key);
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  recordFailure(username: string): void {
    const key = this.key(username);
    const now = this.now();
    const state = this.db.getAuthFailure(key);

    let failures: number;
    let windowStart: string;
    if (
      !state ||
      new Date(state.windowStart).getTime() + this.windowMs <= now.getTime()
    ) {
      failures = 1;
      windowStart = now.toISOString();
    } else {
      failures = state.failures + 1;
      windowStart = state.windowStart;
    }

    this.db.setAuthFailure({
      key,
      failures,
      windowStart,
      lockedUntil:
        failures >= this.maxFailures
          ? new Date(now.getTime() + this.lockMs).toISOString()
          : undefined,
    });
  }

  recordSuccess(username: string): void {
    this.db.clearAuthFailure(this.key(username));
  }
}
