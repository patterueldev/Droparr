import Database from "better-sqlite3";
import type {
  FileRef,
  HistoryEntry,
  InstanceKind,
  Upload,
  UploadState,
} from "@droparr/shared";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
    `);
  }

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
