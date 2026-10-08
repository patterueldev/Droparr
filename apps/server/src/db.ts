import Database from "better-sqlite3";
import type { FileRef, HistoryEntry, InstanceKind } from "@droparr/shared";
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
