import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { DecisionType, HumanDecision } from '../../domain/decision.js';

/** Riga persistita della tabella human_decisions (§5/§12-M5). */
interface DecisionRow {
  id: string;
  checkpoint_id: string;
  decision_type: DecisionType;
  note: string | null;
  decided_at: string;
}

function toDecision(row: DecisionRow): HumanDecision {
  return {
    id: row.id,
    checkpointId: row.checkpoint_id,
    decisionType: row.decision_type,
    note: row.note,
    decidedAt: row.decided_at,
  };
}

export interface DecisionRepository {
  create(checkpointId: string, decisionType: DecisionType, note: string | null): HumanDecision;
  getById(id: string): HumanDecision | null;
  listByCheckpoint(checkpointId: string): HumanDecision[];
}

/** Repository SQLite per le HumanDecision M5 (§5). Append-only per design. */
export class SqliteDecisionRepository implements DecisionRepository {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listByCheckpointStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      `INSERT INTO human_decisions (id, checkpoint_id, decision_type, note, decided_at)
       VALUES (:id, :checkpointId, :decisionType, :note, :decidedAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM human_decisions WHERE id = ?');
    this.listByCheckpointStmt = db.prepare(
      'SELECT * FROM human_decisions WHERE checkpoint_id = ? ORDER BY decided_at ASC',
    );
  }

  create(checkpointId: string, decisionType: DecisionType, note: string | null): HumanDecision {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.insertStmt.run({ id, checkpointId, decisionType, note, decidedAt: now });
    return this.getById(id)!;
  }

  getById(id: string): HumanDecision | null {
    const row = this.getStmt.get(id) as DecisionRow | undefined;
    return row ? toDecision(row) : null;
  }

  listByCheckpoint(checkpointId: string): HumanDecision[] {
    return (this.listByCheckpointStmt.all(checkpointId) as unknown as DecisionRow[]).map(toDecision);
  }
}
