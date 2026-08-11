import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  Checkpoint,
  CheckpointStatus,
  EvidenceSource,
  GitDelta,
} from '../../domain/checkpoint.js';
import type { DecisionType } from '../../domain/decision.js';

/** Riga persistita della tabella checkpoints (§7: State & Event Store). */
interface CheckpointRow {
  id: string;
  project_id: string;
  objective_id: string;
  session_id: string | null;
  outcome: Checkpoint['outcome'];
  status: Checkpoint['status'];
  summary: string;
  acceptance_status: Checkpoint['acceptanceStatus'];
  evidence_summary: string;
  git_delta: string | null;
  tests_summary: string;
  warnings: string;
  recommended_action: string;
  full_report_reference: string | null;
  evidence_sources: string;
  created_at: string;
  decided_at: string | null;
  decision_type: string | null;
}

function parseGitDelta(raw: string | null): GitDelta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GitDelta;
  } catch {
    return null;
  }
}

function parseJsonList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    projectId: row.project_id,
    objectiveId: row.objective_id,
    sessionId: row.session_id,
    outcome: row.outcome,
    status: row.status as CheckpointStatus,
    summary: row.summary,
    acceptanceStatus: row.acceptance_status,
    evidenceSummary: row.evidence_summary,
    gitDelta: parseGitDelta(row.git_delta),
    testsSummary: row.tests_summary,
    warnings: parseJsonList(row.warnings),
    recommendedAction: row.recommended_action,
    fullReportReference: row.full_report_reference,
    evidenceSources: parseJsonList(row.evidence_sources) as EvidenceSource[],
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decisionType: (row.decision_type as DecisionType) ?? null,
  };
}

export interface CheckpointRepository {
  create(checkpoint: Checkpoint): Checkpoint;
  getById(id: string): Checkpoint | null;
  listByObjective(objectiveId: string): Checkpoint[];
  listRecent(limit: number, status?: string): Checkpoint[];
  countPending(): number;
  /** M5: segna il checkpoint come DECIDED con tipo e timestamp. */
  decide(id: string, decisionType: DecisionType, decidedAt: string): Checkpoint | null;
}

/** Repository SQLite per i Checkpoint M4 (§5/§6/§12-M4). */
export class SqliteCheckpointRepository implements CheckpointRepository {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listByObjStmt: StatementSync;
  private readonly recentStmt: StatementSync;
  private readonly countStmt: StatementSync;

  private readonly decideStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      `INSERT INTO checkpoints
         (id, project_id, objective_id, session_id, outcome, status, summary,
          acceptance_status, evidence_summary, git_delta, tests_summary,
          warnings, recommended_action, full_report_reference, evidence_sources, created_at)
       VALUES
         (:id, :projectId, :objectiveId, :sessionId, :outcome, :status, :summary,
          :acceptanceStatus, :evidenceSummary, :gitDelta, :testsSummary,
          :warnings, :recommendedAction, :fullReportReference, :evidenceSources, :createdAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM checkpoints WHERE id = ?');
    this.listByObjStmt = db.prepare(
      'SELECT * FROM checkpoints WHERE objective_id = ? ORDER BY created_at DESC',
    );
    this.recentStmt = db.prepare(
      `SELECT * FROM checkpoints
       WHERE (? IS NULL OR status = ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    this.countStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE status = 'PENDING_DECISION'",
    );
    this.decideStmt = db.prepare(
      `UPDATE checkpoints SET status = 'DECIDED', decision_type = ?, decided_at = ? WHERE id = ?`,
    );
  }

  create(checkpoint: Checkpoint): Checkpoint {
    this.insertStmt.run({
      id: checkpoint.id,
      projectId: checkpoint.projectId,
      objectiveId: checkpoint.objectiveId,
      sessionId: checkpoint.sessionId,
      outcome: checkpoint.outcome,
      status: checkpoint.status,
      summary: checkpoint.summary,
      acceptanceStatus: checkpoint.acceptanceStatus,
      evidenceSummary: checkpoint.evidenceSummary,
      gitDelta: checkpoint.gitDelta ? JSON.stringify(checkpoint.gitDelta) : null,
      testsSummary: checkpoint.testsSummary,
      warnings: JSON.stringify(checkpoint.warnings),
      recommendedAction: checkpoint.recommendedAction,
      fullReportReference: checkpoint.fullReportReference,
      evidenceSources: JSON.stringify(checkpoint.evidenceSources),
      createdAt: checkpoint.createdAt,
    });
    return this.getById(checkpoint.id)!;
  }

  getById(id: string): Checkpoint | null {
    const row = this.getStmt.get(id) as CheckpointRow | undefined;
    return row ? toCheckpoint(row) : null;
  }

  listByObjective(objectiveId: string): Checkpoint[] {
    return (this.listByObjStmt.all(objectiveId) as unknown as CheckpointRow[]).map(toCheckpoint);
  }

  listRecent(limit: number, status?: string): Checkpoint[] {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
    const filter = status ?? null;
    return (this.recentStmt.all(filter, filter, capped) as unknown as CheckpointRow[]).map(
      toCheckpoint,
    );
  }

  countPending(): number {
    const row = this.countStmt.get() as { n: number };
    return Number(row.n);
  }

  decide(id: string, decisionType: DecisionType, decidedAt: string): Checkpoint | null {
    if (!this.getById(id)) return null;
    this.decideStmt.run(decisionType, decidedAt, id);
    return this.getById(id);
  }
}