import type { DatabaseSync, StatementSync } from 'node:sqlite';

export const EVENT_CATEGORIES = ['USER', 'TECHNICAL', 'AGENT'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/**
 * Event Store minimo (§7). In M1 vengono persistiti gli eventi
 * applicativi (avvio/arresto, registrazione progetto). Le categorie
 * utente/tecnico/agente del §11 saranno complete nelle milestone M3+.
 */
export interface EventRecord {
  id: number;
  projectId: string | null;
  objectiveId: string | null;
  sessionId: string | null;
  type: string;
  category: EventCategory;
  timestamp: string;
  payload: unknown;
}

interface EventRow {
  id: number;
  project_id: string | null;
  objective_id: string | null;
  session_id: string | null;
  type: string;
  category: EventCategory;
  timestamp: string;
  payload: string | null;
}

function toEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    objectiveId: row.objective_id,
    sessionId: row.session_id,
    type: row.type,
    category: row.category,
    timestamp: row.timestamp,
    payload: row.payload ? (JSON.parse(row.payload) as unknown) : null,
  };
}

export interface LogEventOptions {
  projectId?: string | null;
  objectiveId?: string | null;
  sessionId?: string | null;
  payload?: unknown;
  category?: EventCategory;
}

export class EventService {
  private readonly insertStmt: StatementSync;
  private readonly recentStmt: StatementSync;
  private readonly countStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      `INSERT INTO events (project_id, objective_id, session_id, type, category, timestamp, payload)
       VALUES (:projectId, :objectiveId, :sessionId, :type, :category, :timestamp, :payload)`,
    );
    this.recentStmt = db.prepare(
      `SELECT * FROM events
       WHERE (? IS NULL OR project_id = ?)
         AND (? IS NULL OR objective_id = ?)
         AND (? IS NULL OR session_id = ?)
         AND (? IS NULL OR category = ?)
       ORDER BY id DESC
       LIMIT ?`,
    );
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM events');
  }

  log(type: string, options: LogEventOptions = {}): EventRecord {
    const timestamp = new Date().toISOString();
    const payload =
      options.payload === undefined ? null : JSON.stringify(options.payload);
    const info = this.insertStmt.run({
      projectId: options.projectId ?? null,
      objectiveId: options.objectiveId ?? null,
      sessionId: options.sessionId ?? null,
      type,
      category: options.category ?? 'TECHNICAL',
      timestamp,
      payload,
    });
    return {
      id: Number(info.lastInsertRowid),
      projectId: options.projectId ?? null,
      objectiveId: options.objectiveId ?? null,
      sessionId: options.sessionId ?? null,
      type,
      category: options.category ?? 'TECHNICAL',
      timestamp,
      payload: options.payload ?? null,
    };
  }

  recent(
    limit: number,
    projectId?: string | null,
    objectiveId?: string | null,
    sessionId?: string | null,
    category?: EventCategory | null,
  ): EventRecord[] {
    const capped = Math.max(1, Math.min(5_000, Math.trunc(limit) || 50));
    const rows = this.recentStmt.all(
      projectId ?? null,
      projectId ?? null,
      objectiveId ?? null,
      objectiveId ?? null,
      sessionId ?? null,
      sessionId ?? null,
      category ?? null,
      category ?? null,
      capped,
    ) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  count(): number {
    const row = this.countStmt.get() as { n: number };
    return Number(row.n);
  }
}
