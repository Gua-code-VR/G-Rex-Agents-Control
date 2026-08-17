import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  AgentWorkspace,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  WorkspaceStatus,
} from '../../domain/workspace.js';

interface WorkspaceRow {
  id: string;
  project_id: string;
  objective_id: string;
  session_id: string;
  repository_path: string;
  worktree_path: string;
  branch: string;
  base_ref: string | null;
  status: WorkspaceStatus;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  integrated_at: string | null;
  error: string | null;
}

function toWorkspace(row: WorkspaceRow): AgentWorkspace {
  return {
    id: row.id,
    projectId: row.project_id,
    objectiveId: row.objective_id,
    sessionId: row.session_id,
    repositoryPath: row.repository_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseRef: row.base_ref,
    status: row.status,
    statusReason: row.status_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    integratedAt: row.integrated_at,
    error: row.error,
  };
}

export interface WorkspaceRepository {
  create(input: CreateWorkspaceInput): AgentWorkspace;
  getById(id: string): AgentWorkspace | null;
  list(): AgentWorkspace[];
  listByProject(projectId: string): AgentWorkspace[];
  listByObjective(objectiveId: string): AgentWorkspace[];
  update(id: string, input: UpdateWorkspaceInput): AgentWorkspace | null;
  setStatus(id: string, status: WorkspaceStatus, statusReason?: string | null, integratedAt?: string | null): AgentWorkspace | null;
}

/** Repository SQLite per l'entità ExecutionWorkspace (§19 V2). */
export class SqliteWorkspaceRepository implements WorkspaceRepository {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly listByProjectStmt: StatementSync;
  private readonly listByObjectiveStmt: StatementSync;
  private readonly updateStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      `INSERT INTO workspaces
         (id, project_id, objective_id, session_id, repository_path, worktree_path,
          branch, base_ref, status, status_reason, created_at, updated_at, last_used_at, integrated_at, error)
       VALUES
         (:id, :projectId, :objectiveId, :sessionId, :repositoryPath, :worktreePath,
          :branch, :baseRef, :status, :statusReason, :createdAt, :updatedAt, :lastUsedAt, :integratedAt, :error)`,
    );
    this.getStmt = db.prepare('SELECT * FROM workspaces WHERE id = ?');
    this.listStmt = db.prepare('SELECT * FROM workspaces ORDER BY created_at ASC');
    this.listByProjectStmt = db.prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at DESC');
    this.listByObjectiveStmt = db.prepare('SELECT * FROM workspaces WHERE objective_id = ? ORDER BY created_at DESC');
    this.updateStmt = db.prepare(
      `UPDATE workspaces SET
         status = COALESCE(:status, status),
         status_reason = COALESCE(:statusReason, status_reason),
         last_used_at = COALESCE(:lastUsedAt, last_used_at),
         integrated_at = COALESCE(:integratedAt, integrated_at),
         error = COALESCE(:error, error),
         updated_at = :updatedAt
       WHERE id = :id`,
    );
  }

  create(input: CreateWorkspaceInput): AgentWorkspace {
    const now = new Date().toISOString();
    const workspace: AgentWorkspace = {
      id: randomUUID(),
      projectId: input.projectId,
      objectiveId: input.objectiveId,
      sessionId: input.sessionId,
      repositoryPath: input.repositoryPath,
      worktreePath: input.worktreePath,
      branch: input.branch,
      baseRef: input.baseRef,
      status: 'ACTIVE',
      statusReason: null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      integratedAt: null,
      error: null,
    };
    this.insertStmt.run({
      id: workspace.id,
      projectId: workspace.projectId,
      objectiveId: workspace.objectiveId,
      sessionId: workspace.sessionId,
      repositoryPath: workspace.repositoryPath,
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      baseRef: workspace.baseRef,
      status: workspace.status,
      statusReason: null,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      lastUsedAt: workspace.lastUsedAt,
      integratedAt: null,
      error: null,
    });
    return workspace;
  }

  getById(id: string): AgentWorkspace | null {
    const row = this.getStmt.get(id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  list(): AgentWorkspace[] {
    return (this.listStmt.all() as unknown as WorkspaceRow[]).map(toWorkspace);
  }

  listByProject(projectId: string): AgentWorkspace[] {
    return (this.listByProjectStmt.all(projectId) as unknown as WorkspaceRow[]).map(toWorkspace);
  }

  listByObjective(objectiveId: string): AgentWorkspace[] {
    return (this.listByObjectiveStmt.all(objectiveId) as unknown as WorkspaceRow[]).map(toWorkspace);
  }

  update(id: string, input: UpdateWorkspaceInput): AgentWorkspace | null {
    if (!this.getById(id)) return null;
    this.updateStmt.run({
      id,
      status: input.status ?? null,
      statusReason: input.statusReason === undefined ? null : input.statusReason,
      lastUsedAt: input.lastUsedAt === undefined ? null : input.lastUsedAt,
      integratedAt: input.integratedAt === undefined ? null : input.integratedAt,
      error: input.error === undefined ? null : input.error,
      updatedAt: new Date().toISOString(),
    });
    return this.getById(id);
  }

  setStatus(id: string, status: WorkspaceStatus, statusReason: string | null = null, integratedAt: string | null = null): AgentWorkspace | null {
    return this.update(id, { status, statusReason, ...(integratedAt ? { integratedAt } : {}) });
  }
}
