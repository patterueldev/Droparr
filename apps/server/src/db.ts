import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  FileRef,
  HistoryEntry,
  InstanceKind,
  Upload,
  UploadState,
  User,
  UserRole,
} from "@droparr/shared";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Internal session row — includes the token hash, never sent to clients. */
export interface StoredSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent?: string;
  ip?: string;
}

/** Per-username failed-login counter / lockout state. */
export interface AuthFailure {
  key: string;
  failures: number;
  windowStart: string;
  lockedUntil?: string;
}

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        instanceId TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        year INTEGER,
        matchedId INTEGER,
        filesJson TEXT NOT NULL,
        result TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        completedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_started
        ON history(startedAt DESC);

      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        dropId TEXT NOT NULL,
        filename TEXT NOT NULL,
        relPath TEXT NOT NULL,
        ext TEXT NOT NULL,
        size INTEGER NOT NULL,
        offset INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'uploading',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_uploads_drop ON uploads(dropId);
      CREATE INDEX IF NOT EXISTS idx_uploads_state ON uploads(state);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        jellyfinUserId TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        trusted INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        lastLoginAt TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        tokenHash TEXT NOT NULL UNIQUE,
        userId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        lastSeenAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        userAgent TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expiresAt);

      CREATE TABLE IF NOT EXISTS auth_failures (
        key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        windowStart TEXT NOT NULL,
        lockedUntil TEXT
      );
    `);
  }

  // --- History ---

  addHistory(entry: HistoryEntry): void {
    this.db
      .prepare(
        `INSERT INTO history
         (id, instanceId, kind, title, year, matchedId, filesJson, result, startedAt, completedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.instanceId,
        entry.kind,
        entry.title,
        entry.year ?? null,
        entry.matchedId ?? null,
        JSON.stringify(entry.files),
        entry.result,
        entry.timestamps.started,
        entry.timestamps.completed ?? null,
      );
  }

  listHistory(limit = 50, offset = 0): HistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM history ORDER BY startedAt DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as HistoryRow[];
    return rows.map(rowToEntry);
  }

  getHistory(id: string): HistoryEntry | undefined {
    const row = this.db
      .prepare(`SELECT * FROM history WHERE id = ?`)
      .get(id) as HistoryRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  // --- Uploads ---

  createUpload(upload: Upload): void {
    this.db
      .prepare(
        `INSERT INTO uploads
         (id, dropId, filename, relPath, ext, size, offset, state, createdAt, updatedAt, completedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        upload.id,
        upload.dropId,
        upload.filename,
        upload.relPath,
        upload.ext,
        upload.size,
        upload.offset,
        upload.state,
        upload.createdAt,
        upload.updatedAt,
        upload.completedAt ?? null,
      );
  }

  getUpload(id: string): Upload | undefined {
    const row = this.db
      .prepare(`SELECT * FROM uploads WHERE id = ?`)
      .get(id) as UploadRow | undefined;
    return row ? rowToUpload(row) : undefined;
  }

  /** Non-cancelled upload with this drop-relative path, if any. */
  findUploadByRelPath(dropId: string, relPath: string): Upload | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM uploads
         WHERE dropId = ? AND relPath = ? AND state != 'cancelled'`,
      )
      .get(dropId, relPath) as UploadRow | undefined;
    return row ? rowToUpload(row) : undefined;
  }

  listUploads(filter: { dropId?: string; state?: UploadState } = {}): Upload[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.dropId) {
      where.push("dropId = ?");
      params.push(filter.dropId);
    }
    if (filter.state) {
      where.push("state = ?");
      params.push(filter.state);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM uploads ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY createdAt ASC`,
      )
      .all(...params) as UploadRow[];
    return rows.map(rowToUpload);
  }

  /** Bytes committed across all non-cancelled uploads of a drop. */
  dropUploadedBytes(dropId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(size), 0) AS total FROM uploads
         WHERE dropId = ? AND state != 'cancelled'`,
      )
      .get(dropId) as { total: number };
    return row.total;
  }

  /** Commit a chunk offset; marks completedAt on the complete transition. */
  advanceUpload(id: string, offset: number, state: UploadState): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE uploads
         SET offset = ?, state = ?, updatedAt = ?,
             completedAt = CASE WHEN ? = 'complete'
                                THEN COALESCE(completedAt, ?)
                                ELSE completedAt END
         WHERE id = ?`,
      )
      .run(offset, state, now, state, now, id);
  }

  deleteUpload(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM uploads WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  // --- Users ---

  getUser(id: string): User | undefined {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(id) as UserRow | undefined;
    return row ? rowToUser(row) : undefined;
  }

  /**
   * Create or refresh a user from a Jellyfin login. The role is re-synced on
   * every login so Jellyfin policy changes propagate; Droparr-local flags
   * (trusted, blocked) are preserved.
   */
  upsertUser(input: {
    jellyfinUserId: string;
    name: string;
    role: UserRole;
    at?: string;
  }): User {
    const now = input.at ?? new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT * FROM users WHERE jellyfinUserId = ?`)
      .get(input.jellyfinUserId) as UserRow | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE users SET name = ?, role = ?, lastLoginAt = ? WHERE id = ?`,
        )
        .run(input.name, input.role, now, existing.id);
      return rowToUser({
        ...existing,
        name: input.name,
        role: input.role,
        lastLoginAt: now,
      });
    }

    const user: User = {
      id: nanoid(10),
      jellyfinUserId: input.jellyfinUserId,
      name: input.name,
      role: input.role,
      trusted: false,
      blocked: false,
      createdAt: now,
      lastLoginAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO users
         (id, jellyfinUserId, name, role, trusted, blocked, createdAt, lastLoginAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.jellyfinUserId,
        user.name,
        user.role,
        user.trusted ? 1 : 0,
        user.blocked ? 1 : 0,
        user.createdAt,
        user.lastLoginAt ?? null,
      );
    return user;
  }

  // --- Sessions ---

  createSession(session: StoredSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, tokenHash, userId, createdAt, lastSeenAt, expiresAt, userAgent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.tokenHash,
        session.userId,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
        session.userAgent ?? null,
        session.ip ?? null,
      );
  }

  getSession(id: string): StoredSession | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  getSessionByTokenHash(tokenHash: string): StoredSession | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE tokenHash = ?`)
      .get(tokenHash) as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  /** Newest first. */
  listSessions(userId: string): StoredSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE userId = ? ORDER BY lastSeenAt DESC`,
      )
      .all(userId) as SessionRow[];
    return rows.map(rowToSession);
  }

  touchSession(id: string, lastSeenAt: string, expiresAt: string): void {
    this.db
      .prepare(`UPDATE sessions SET lastSeenAt = ?, expiresAt = ? WHERE id = ?`)
      .run(lastSeenAt, expiresAt, id);
  }

  deleteSession(id: string): boolean {
    const info = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  deleteSessionByTokenHash(tokenHash: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM sessions WHERE tokenHash = ?`)
      .run(tokenHash);
    return info.changes > 0;
  }

  /** Remove expired sessions; returns how many were deleted. */
  pruneExpiredSessions(now: string): number {
    const info = this.db
      .prepare(`DELETE FROM sessions WHERE expiresAt <= ?`)
      .run(now);
    return info.changes;
  }

  // --- Auth throttle ---

  getAuthFailure(key: string): AuthFailure | undefined {
    const row = this.db
      .prepare(`SELECT * FROM auth_failures WHERE key = ?`)
      .get(key) as AuthFailureRow | undefined;
    return row
      ? {
          key: row.key,
          failures: row.failures,
          windowStart: row.windowStart,
          lockedUntil: row.lockedUntil ?? undefined,
        }
      : undefined;
  }

  setAuthFailure(failure: AuthFailure): void {
    this.db
      .prepare(
        `INSERT INTO auth_failures (key, failures, windowStart, lockedUntil)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           failures = excluded.failures,
           windowStart = excluded.windowStart,
           lockedUntil = excluded.lockedUntil`,
      )
      .run(
        failure.key,
        failure.failures,
        failure.windowStart,
        failure.lockedUntil ?? null,
      );
  }

  clearAuthFailure(key: string): void {
    this.db.prepare(`DELETE FROM auth_failures WHERE key = ?`).run(key);
  }
}

interface HistoryRow {
  id: string;
  instanceId: string;
  kind: string;
  title: string;
  year: number | null;
  matchedId: number | null;
  filesJson: string;
  result: string;
  startedAt: string;
  completedAt: string | null;
}

interface UserRow {
  id: string;
  jellyfinUserId: string;
  name: string;
  role: string;
  trusted: number;
  blocked: number;
  createdAt: string;
  lastLoginAt: string | null;
}

interface SessionRow {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
}

interface AuthFailureRow {
  key: string;
  failures: number;
  windowStart: string;
  lockedUntil: string | null;
}

function rowToEntry(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    instanceId: row.instanceId,
    kind: row.kind as InstanceKind,
    title: row.title,
    year: row.year ?? undefined,
    matchedId: row.matchedId ?? undefined,
    files: JSON.parse(row.filesJson) as FileRef[],
    result: row.result as HistoryEntry["result"],
    timestamps: {
      started: row.startedAt,
      completed: row.completedAt ?? undefined,
    },
  };
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    jellyfinUserId: row.jellyfinUserId,
    name: row.name,
    role: row.role as UserRole,
    trusted: row.trusted === 1,
    blocked: row.blocked === 1,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt ?? undefined,
  };
}

function rowToSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    userAgent: row.userAgent ?? undefined,
    ip: row.ip ?? undefined,
  };
}

interface UploadRow {
  id: string;
  dropId: string;
  filename: string;
  relPath: string;
  ext: string;
  size: number;
  offset: number;
  state: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function rowToUpload(row: UploadRow): Upload {
  return {
    id: row.id,
    dropId: row.dropId,
    filename: row.filename,
    relPath: row.relPath,
    ext: row.ext,
    size: row.size,
    offset: row.offset,
    state: row.state as UploadState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
  };
}
