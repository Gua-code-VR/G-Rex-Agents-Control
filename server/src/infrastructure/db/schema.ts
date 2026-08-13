import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema del registro progetti M3 costruito sullo State & Event Store (§7).
 *
 * v1 → M1 fondazione; v2 → M2 registro progetti (current_objective,
 * git_snapshot); v3 → M3 obiettivi e sessioni agente (tabelle
 * objectives/sessions, colonna projects.current_objective_id);
 * v4 → M4 checkpoint e attenzione umana (tabella checkpoints con
 * evidenze §6 SYSTEM/AGENT, stato PENDING_DECISION).
 * v5 → M5 decisioni umane (tabella human_decisions, colonne lifecycle
 * su checkpoints: decided_at, decision_type).
 * v6 → M7 autenticazione applicativa (tabella auth per password hash).
 * v7 → M8 heartbeat, last_heartbeat_at su sessioni; category su eventi
 *   (USER/TECHNICAL/AGENT per §11 separazione log).
 * La migrazione è idempotente: DDL IF NOT EXISTS + ALTER TABLE colonne mancanti.
 */
export const SCHEMA_VERSION = 8;

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
  payload TEXT,
  category TEXT NOT NULL DEFAULT 'TECHNICAL'
);

CREATE INDEX IF NOT EXISTS idx_events_project_id ON events (project_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_category ON events (category);

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
  exit_reason TEXT,
  heartbeat_interval_ms INTEGER,
  last_heartbeat_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_objective_id ON sessions (objective_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  project_id TEXT,
  objective_id TEXT,
  session_id TEXT,
  checkpoint_id TEXT,
  error_class TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_project_id ON notifications (project_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications (read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  session_id TEXT,
  outcome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_DECISION',
  summary TEXT NOT NULL,
  acceptance_status TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  git_delta TEXT,
  tests_summary TEXT NOT NULL,
  warnings TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  full_report_reference TEXT,
  evidence_sources TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  runtime_type TEXT,
  runtime_name TEXT,
  provider_name TEXT,
  model_name TEXT,
  process_reference TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  reason TEXT,
  error_class TEXT,
  fallback_of_attempt_id TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_execution_attempts_session_id ON execution_attempts (session_id);

CREATE INDEX IF NOT EXISTS idx_checkpoints_objective_id ON checkpoints (objective_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_status ON checkpoints (status);
CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints (created_at);

CREATE TABLE IF NOT EXISTS human_decisions (
  id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  note TEXT,
  decided_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_human_decisions_checkpoint_id ON human_decisions (checkpoint_id);

-- M7: tabella autenticazione (singolo amministratore, §8).
CREATE TABLE IF NOT EXISTS auth (
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
  // Migrazione v2 → v3: current_objective_id per la relazione §5 con Objective.
  ensureColumn(db, 'projects', 'current_objective_id', 'current_objective_id TEXT');
  // Migrazione v4 → v5: colonne lifecycle sui checkpoints per M5.
  ensureColumn(db, 'checkpoints', 'decided_at', 'decided_at TEXT');
  ensureColumn(db, 'checkpoints', 'decision_type', 'decision_type TEXT');
  ensureColumn(db, 'execution_attempts', 'metadata', 'metadata TEXT');
  // Migrazione v6 → v7: M8 heartbeat, last_heartbeat_at su sessioni; category su eventi.
  ensureColumn(db, 'sessions', 'heartbeat_interval_ms', 'heartbeat_interval_ms INTEGER');
  ensureColumn(db, 'sessions', 'last_heartbeat_at', 'last_heartbeat_at TEXT');
  ensureColumn(db, 'events', 'category', "category TEXT NOT NULL DEFAULT 'TECHNICAL'");
  ensureColumn(db, 'execution_attempts', 'fallback_of_attempt_id', 'fallback_of_attempt_id TEXT');
  // Migrazione v7: tabella notifications per M8.
  // Tabella già creata nel DDL, ma serve per vecchi DB.
  // (DDL IF NOT EXISTS la crea se manca)
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}
