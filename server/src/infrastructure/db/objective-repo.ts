import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { GitStatus } from '../../domain/project.js';
import type {
  AgentSession,
  CreateObjectiveInput,
  Objective,
  ObjectiveStatus,
  SessionStatus,
  ExecutionSelection,
} from '../../domain/objective.js';
import { budgetPolicySchema, type BudgetPolicy } from '../../domain/governance.js';

interface ObjectiveRow {
  id: string;
  project_id: string;
  title: string;
  objective_text: string;
  invariants: string | null;
  acceptance_criteria: string | null;
  stop_condition: string | null;
  status: ObjectiveStatus;
  started_at: string | null;
  completed_at: string | null;
  final_report: string | null;
  git_start: string | null;
  git_end: string | null;
  created_at: string;
  updated_at: string;
  policy_json: string | null;
  estimated_cost: number | null;
}
function parsePolicy(raw: string | null): BudgetPolicy | null { try { return raw ? budgetPolicySchema.parse(JSON.parse(raw)) : null; } catch { return null; } }

/** Decodifica una lista JSON persistita (invariants/criteria); mai null. */
function parseJsonList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Decodifica uno snapshot Git JSON persistito; mai null. */
function parseGitSnapshot(raw: string | null): GitStatus | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GitStatus;
  } catch {
    return null;
  }
}

function toObjective(row: ObjectiveRow): Objective {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    objectiveText: row.objective_text,
    invariants: parseJsonList(row.invariants),
    acceptanceCriteria: parseJsonList(row.acceptance_criteria),
    stopCondition: row.stop_condition,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    finalReport: row.final_report,
    gitStart: parseGitSnapshot(row.git_start),
    gitEnd: parseGitSnapshot(row.git_end),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    policy: parsePolicy(row.policy_json),
    estimatedCost: row.estimated_cost,
  };
}

function toSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    objectiveId: row.objective_id,
    agentType: row.agent_type,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    lastActivityAt: row.last_activity_at,
    processReference: row.process_reference,
    exitReason: row.exit_reason,
    heartbeatIntervalMs: row.heartbeat_interval_ms ?? 30000,
    lastHeartbeatAt: row.last_heartbeat_at,
    executionSelection: parseSelection(row.selection_json),
    workspaceId: row.workspace_id ?? null,
  };
}

export interface ObjectiveRepository {
  create(projectId: string, input: CreateObjectiveInput): Objective;
  getById(id: string): Objective | null;
  listByProject(projectId: string): Objective[];
  setStatus(id: string, status: ObjectiveStatus): Objective | null;
  setGitStart(id: string, gitStart: GitStatus | null): Objective | null;
  markActive(id: string, status: ObjectiveStatus, startedAt: string): Objective | null;
  /** Conclusione del lavoro (§5/M4): report finale, snapshot Git di fine lavoro
   *  e passaggio a RICHIEDE_ATTENZIONE. L'approvazione (COMPLETATO) arriva
   *  con le decisioni umane di M5. */
  conclude(id: string, report: string, gitEnd: GitStatus | null): Objective | null;
  /** Aggiorna lo snapshot Git di fine lavoro senza cambiare stato (§6-SYSTEM). */
  setGitEnd(id: string, gitEnd: GitStatus | null): Objective | null;
  /** M5: chiude l'obiettivo come COMPLETATO (approvazione umana). */
  complete(id: string): Objective | null;
  /** Completamento riuscito (§ prodotto): COMPLETATO con report e snapshot Git finali, senza approvazione. */
  completeWithReport(id: string, report: string, gitEnd: GitStatus | null): Objective | null;
}

export interface SessionRepository {
  create(objectiveId: string, agentType: string): AgentSession;
  createWithHeartbeat(objectiveId: string, agentType: string, heartbeatIntervalMs: number, selection?: ExecutionSelection | null): AgentSession;
  setExecutionSelection(id: string, selection: ExecutionSelection): AgentSession | null;
  getById(id: string): AgentSession | null;
  listByObjective(objectiveId: string): AgentSession[];
  /** M8: Lista tutte le sessioni (per recovery all'avvio). */
  listAll(): AgentSession[];
  setStatus(id: string, status: SessionStatus): AgentSession | null;
  setProcessReference(id: string, processReference: string, agentType?: string): AgentSession | null;
  /** §19: associa la sessione alla workspace Git isolata che esegue il lavoro. */
  setWorkspaceId(id: string, workspaceId: string | null): AgentSession | null;
  touchActivity(id: string): AgentSession | null;
  /** M8: Aggiorna l'ultimo heartbeat della sessione. */
  touchHeartbeat(id: string): AgentSession | null;
  /** M8: Trova sessioni STALE (senza heartbeat da più dell'intervallo configurato). */
  findStaleSessions(now: string): AgentSession[];
  terminate(id: string, status: SessionStatus, exitReason: string | null): AgentSession | null;
}
interface SessionRow {
  id: string;
  objective_id: string;
  agent_type: string;
  started_at: string;
  ended_at: string | null;
  status: SessionStatus;
  last_activity_at: string | null;
  process_reference: string | null;
  exit_reason: string | null;
  heartbeat_interval_ms: number | null;
  last_heartbeat_at: string | null;
  selection_json: string | null;
  workspace_id: string | null;
}
function parseSelection(raw: string | null): ExecutionSelection | null { try { const value = raw ? JSON.parse(raw) as ExecutionSelection : null; return value?.runtimeId && value.providerId ? value : null; } catch { return null; } }

/** Repository SQLite per l'entità Objective (§5). */
export class SqliteObjectiveRepository implements ObjectiveRepository {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listByProjectStmt: StatementSync;
  private readonly setStatusStmt: StatementSync;
  private readonly setGitStartStmt: StatementSync;
  private readonly markActiveStmt: StatementSync;
  private readonly concludeStmt: StatementSync;
  private readonly setGitEndStmt: StatementSync;
  private readonly completeStmt: StatementSync;
  private readonly completeWithReportStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      `INSERT INTO objectives
         (id, project_id, title, objective_text, invariants, acceptance_criteria,
          stop_condition, status, estimated_cost, created_at, updated_at)
       VALUES
         (:id, :projectId, :title, :objectiveText, :invariants, :acceptanceCriteria,
          :stopCondition, :status, :estimatedCost, :createdAt, :updatedAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM objectives WHERE id = ?');
    this.listByProjectStmt = db.prepare(
      'SELECT * FROM objectives WHERE project_id = ? ORDER BY created_at DESC',
    );
    this.setStatusStmt = db.prepare(
      'UPDATE objectives SET status = ?, updated_at = ? WHERE id = ?',
    );
    this.setGitStartStmt = db.prepare(
      'UPDATE objectives SET git_start = ?, updated_at = ? WHERE id = ?',
    );
    this.markActiveStmt = db.prepare(
      'UPDATE objectives SET status = ?, started_at = ?, updated_at = ? WHERE id = ?',
    );
    this.concludeStmt = db.prepare(
      `UPDATE objectives
       SET status = 'RICHIEDE_ATTENZIONE', final_report = ?, git_end = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.setGitEndStmt = db.prepare(
      'UPDATE objectives SET git_end = ?, updated_at = ? WHERE id = ?',
    );
    this.completeStmt = db.prepare(
      `UPDATE objectives SET status = 'COMPLETATO', completed_at = ?, updated_at = ? WHERE id = ?`,
    );
    this.completeWithReportStmt = db.prepare(
      `UPDATE objectives SET status = 'COMPLETATO', final_report = ?, git_end = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    );
  }
create(projectId: string, input: CreateObjectiveInput): Objective {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.insertStmt.run({
      id,
      projectId,
      title: input.title,
      objectiveText: input.objectiveText,
      invariants: input.invariants.length > 0 ? JSON.stringify(input.invariants) : null,
      acceptanceCriteria:
        input.acceptanceCriteria.length > 0 ? JSON.stringify(input.acceptanceCriteria) : null,
      stopCondition: input.stopCondition,
      status: 'IN_AVVIO',
      estimatedCost: input.estimatedCost ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return this.getById(id)!;
  }

  getById(id: string): Objective | null {
    const row = this.getStmt.get(id) as ObjectiveRow | undefined;
    return row ? toObjective(row) : null;
  }

  listByProject(projectId: string): Objective[] {
    return (this.listByProjectStmt.all(projectId) as unknown as ObjectiveRow[]).map(toObjective);
  }

  setStatus(id: string, status: ObjectiveStatus): Objective | null {
    if (!this.getById(id)) return null;
    this.setStatusStmt.run(status, new Date().toISOString(), id);
    return this.getById(id);
  }

  setGitStart(id: string, gitStart: GitStatus | null): Objective | null {
    if (!this.getById(id)) return null;
    this.setGitStartStmt.run(gitStart ? JSON.stringify(gitStart) : null, new Date().toISOString(), id);
    return this.getById(id);
  }

  markActive(id: string, status: ObjectiveStatus, startedAt: string): Objective | null {
    if (!this.getById(id)) return null;
    this.markActiveStmt.run(status, startedAt, new Date().toISOString(), id);
    return this.getById(id);
  }

  conclude(id: string, report: string, gitEnd: GitStatus | null): Objective | null {
    if (!this.getById(id)) return null;
    const now = new Date().toISOString();
    this.concludeStmt.run(report, gitEnd ? JSON.stringify(gitEnd) : null, now, id);
    return this.getById(id);
  }

  setGitEnd(id: string, gitEnd: GitStatus | null): Objective | null {
    if (!this.getById(id)) return null;
    this.setGitEndStmt.run(gitEnd ? JSON.stringify(gitEnd) : null, new Date().toISOString(), id);
    return this.getById(id);
  }

  complete(id: string): Objective | null {
    if (!this.getById(id)) return null;
    const now = new Date().toISOString();
    this.completeStmt.run(now, now, id);
    return this.getById(id);
  }

  completeWithReport(id: string, report: string, gitEnd: GitStatus | null): Objective | null {
    if (!this.getById(id)) return null;
    const now = new Date().toISOString();
    this.completeWithReportStmt.run(report, gitEnd ? JSON.stringify(gitEnd) : null, now, now, id);
    return this.getById(id);
  }
}
/** Repository SQLite per l'entità AgentSession (§5). */
export class SqliteSessionRepository implements SessionRepository {
  private readonly insertStmt: StatementSync;
  private readonly insertWithHeartbeatStmt: StatementSync;
  private readonly setSelectionStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listByObjStmt: StatementSync;
  private readonly listAllStmt: StatementSync;
  private readonly setStatusStmt: StatementSync;
  private readonly setRefStmt: StatementSync;
  private readonly touchActivityStmt: StatementSync;
  private readonly touchHeartbeatStmt: StatementSync;
  private readonly findStaleStmt: StatementSync;
  private readonly terminateStmt: StatementSync;
  private readonly setWorkspaceIdStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      `INSERT INTO sessions
         (id, objective_id, agent_type, started_at, status)
       VALUES
         (:id, :objectiveId, :agentType, :startedAt, :status)`,
    );
    this.insertWithHeartbeatStmt = db.prepare(
      `INSERT INTO sessions
         (id, objective_id, agent_type, started_at, status, heartbeat_interval_ms, last_heartbeat_at, selection_json)
       VALUES
         (:id, :objectiveId, :agentType, :startedAt, :status, :heartbeatIntervalMs, :lastHeartbeatAt, :selectionJson)`,
    );
    this.setSelectionStmt = db.prepare('UPDATE sessions SET selection_json = ?, agent_type = ? WHERE id = ?');
    this.getStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
    this.listByObjStmt = db.prepare(
      'SELECT * FROM sessions WHERE objective_id = ? ORDER BY started_at ASC',
    );
    this.listAllStmt = db.prepare('SELECT * FROM sessions ORDER BY started_at ASC');
    this.setStatusStmt = db.prepare('UPDATE sessions SET status = ? WHERE id = ?');
    this.setRefStmt = db.prepare(
      'UPDATE sessions SET process_reference = ?, agent_type = ? WHERE id = ?',
    );
    this.touchActivityStmt = db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?');
    this.touchHeartbeatStmt = db.prepare(
      'UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?',
    );
    this.findStaleStmt = db.prepare(
      `SELECT * FROM sessions
       WHERE status = 'ATTIVA'
         AND last_heartbeat_at IS NOT NULL
         AND (julianday(?) - julianday(last_heartbeat_at)) * 86400000 > heartbeat_interval_ms`,
    );
    this.setWorkspaceIdStmt = db.prepare('UPDATE sessions SET workspace_id = ? WHERE id = ?');
    this.terminateStmt = db.prepare(
      'UPDATE sessions SET ended_at = ?, status = ?, exit_reason = ? WHERE id = ?',
    );
  }

  create(objectiveId: string, agentType: string): AgentSession {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.insertStmt.run({
      id,
      objectiveId,
      agentType,
      startedAt: now,
      status: 'IN_AVVIO',
    });
    return this.getById(id)!;
  }

  createWithHeartbeat(objectiveId: string, agentType: string, heartbeatIntervalMs: number, selection: ExecutionSelection | null = null): AgentSession {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.insertWithHeartbeatStmt.run({
      id,
      objectiveId,
      agentType,
      startedAt: now,
      status: 'IN_AVVIO',
      heartbeatIntervalMs,
      lastHeartbeatAt: now,
      selectionJson: selection ? JSON.stringify(selection) : null,
    });
    return this.getById(id)!;
  }
  setExecutionSelection(id: string, selection: ExecutionSelection): AgentSession | null { this.setSelectionStmt.run(JSON.stringify(selection), selection.runtimeId, id); return this.getById(id); }

  getById(id: string): AgentSession | null {
    const row = this.getStmt.get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  listByObjective(objectiveId: string): AgentSession[] {
    return (this.listByObjStmt.all(objectiveId) as unknown as SessionRow[]).map(toSession);
  }

  listAll(): AgentSession[] {
    return (this.listAllStmt.all() as unknown as SessionRow[]).map(toSession);
  }

  setStatus(id: string, status: SessionStatus): AgentSession | null {
    if (!this.getById(id)) return null;
    this.setStatusStmt.run(status, id);
    return this.getById(id);
  }

  setProcessReference(id: string, processReference: string, agentType?: string): AgentSession | null {
    const existing = this.getById(id);
    if (!existing) return null;
    this.setRefStmt.run(processReference, agentType ?? existing.agentType, id);
    return this.getById(id);
  }

  setWorkspaceId(id: string, workspaceId: string | null): AgentSession | null {
    if (!this.getById(id)) return null;
    this.setWorkspaceIdStmt.run(workspaceId, id);
    return this.getById(id);
  }

  touchActivity(id: string): AgentSession | null {
    if (!this.getById(id)) return null;
    this.touchActivityStmt.run(new Date().toISOString(), id);
    return this.getById(id);
  }

  touchHeartbeat(id: string): AgentSession | null {
    if (!this.getById(id)) return null;
    this.touchHeartbeatStmt.run(new Date().toISOString(), id);
    return this.getById(id);
  }

  findStaleSessions(now: string): AgentSession[] {
    return (this.findStaleStmt.all(now) as unknown as SessionRow[]).map(toSession);
  }

  terminate(id: string, status: SessionStatus, exitReason: string | null): AgentSession | null {
    if (!this.getById(id)) return null;
    this.terminateStmt.run(new Date().toISOString(), status, exitReason, id);
    return this.getById(id);
  }
}
