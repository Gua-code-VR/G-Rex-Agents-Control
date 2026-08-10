import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema del registro progetti M3 costruito sullo State & Event Store (§7).
 *
 * v1 → M1 fondazione; v2 → M2 registro progetti (current_objective,
 * git_snapshot); v3 → M3 obiettivi e sessioni agente (tabelle
 * objectives/sessions, colonna projects.current_objective_id).
 * La migrazione è idempotente: DDL IF NOT EXISTS + ALTER TABLE colonne mancanti.
 */
export const SCHEMA_VERSION = 3;

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

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  objective_text TEXT NOT NULL,
  invariants TEXT,
  acceptance_criteria TEXT,
  stop_condition TEXT,
  status TEXT NOT NULL DEFAULT 'IN_AVVIO',
  started_at TEXT,
  completed_at TEXT,
  final_report TEXT,
  git_start TEXT,
  git_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_objectives_project_id ON objectives (project_id);
CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives (status);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'IN_AVVIO',
  last_activity_at TEXT,
  process_reference TEXT,
  exit_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_objective_id ON sessions (objective_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
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
  // Migrazione v2 → v3: current_objective_id per la relazione §5 con Objective.
  ensureColumn(db, 'projects', 'current_objective_id', 'current_objective_id TEXT');
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}