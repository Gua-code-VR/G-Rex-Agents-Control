import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema del registro progetti M2 costruito sul State & Event Store di M1 (§7).
 * Aggiunge a projects: obiettivo corrente (placeholder fino all'entità
 * Objective di M3+) e snapshot Git essenziale (§5). La migrazione è
 * idempotente: ALTER TABLE solo sulle colonne mancanti.
 */
export const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repository_path TEXT,
  status TEXT NOT NULL DEFAULT 'FERMO',
  current_objective TEXT,
  git_snapshot TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  objective_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_project_id ON events (project_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

export function applySchema(db: DatabaseSync): void {
  db.exec(DDL);
  // Migrazione v1 → v2: colonne aggiunte solo se assenti (idempotente).
  ensureColumn(db, 'projects', 'current_objective', 'current_objective TEXT');
  ensureColumn(db, 'projects', 'git_snapshot', 'git_snapshot TEXT');
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}