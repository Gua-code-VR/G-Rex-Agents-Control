import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  CreateProjectInput,
  GitStatus,
  Project,
  ProjectStatus,
  UpdateProjectInput,
} from '../../domain/project.js';
import { budgetPolicySchema, type BudgetPolicy } from '../../domain/governance.js';
import { projectStatusGroup } from '../../domain/project.js';

interface ProjectRow {
  id: string;
  name: string;
  repository_path: string | null;
  status: ProjectStatus;
  current_objective: string | null;
  current_objective_id: string | null;
  git_snapshot: string | null;
  created_at: string;
  updated_at: string;
  policy_json: string | null;
}
function parsePolicy(raw: string | null): BudgetPolicy | null { try { return raw ? budgetPolicySchema.parse(JSON.parse(raw)) : null; } catch { return null; } }

function parseGitSnapshot(raw: string | null): GitStatus | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GitStatus;
  } catch {
    // Snapshot danneggiato: non rendere inutilizzabile il progetto.
    return null;
  }
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    repositoryPath: row.repository_path,
    status: row.status,
    statusGroup: projectStatusGroup(row.status),
    currentObjective: row.current_objective,
    currentObjectiveId: row.current_objective_id,
    gitStatus: parseGitSnapshot(row.git_snapshot),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    policy: parsePolicy(row.policy_json),
  };
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Project;
  list(): Project[];
  getById(id: string): Project | null;
  update(id: string, input: UpdateProjectInput): Project | null;
  setStatus(id: string, status: ProjectStatus): Project | null;
  setCurrentObjective(id: string, objectiveId: string | null, title: string | null): Project | null;
  updateGitSnapshot(id: string, snapshot: GitStatus | null): Project | null;
}

/** Repository SQLite tipizzato per l'entità Project (§5). */
export class SqliteProjectRepository implements ProjectRepository {
  private readonly insertStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly setRepoStmt: StatementSync;
  private readonly setObjectiveStmt: StatementSync;
  private readonly setStatusStmt: StatementSync;
  private readonly setCurrentObjStmt: StatementSync;
  private readonly setGitStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      `INSERT INTO projects
         (id, name, repository_path, status, current_objective, git_snapshot, created_at, updated_at)
       VALUES
         (:id, :name, :repositoryPath, :status, :currentObjective, :gitSnapshot, :createdAt, :updatedAt)`,
    );
    this.listStmt = db.prepare('SELECT * FROM projects ORDER BY created_at ASC');
    this.getStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    this.setRepoStmt = db.prepare(
      'UPDATE projects SET repository_path = ?, updated_at = ? WHERE id = ?',
    );
    this.setObjectiveStmt = db.prepare(
      'UPDATE projects SET current_objective = ?, updated_at = ? WHERE id = ?',
    );
    this.setStatusStmt = db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?');
    this.setCurrentObjStmt = db.prepare(
      'UPDATE projects SET current_objective_id = ?, updated_at = ? WHERE id = ?',
    );
    // Lo snapshot Git non è una modifica del progetto in sé: updated_at resta la
    // crono dello stato operativo, lo snapshot ha il suo fetchedAt interno.
    this.setGitStmt = db.prepare('UPDATE projects SET git_snapshot = ? WHERE id = ?');
  }

  create(input: CreateProjectInput): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      repositoryPath: input.repositoryPath ?? null,
      status: 'FERMO',
      statusGroup: 'FERMO',
      currentObjective: input.currentObjective ?? null,
      currentObjectiveId: null,
      gitStatus: null,
      createdAt: now,
      updatedAt: now,
      policy: null,
    };
    this.insertStmt.run({
      id: project.id,
      name: project.name,
      repositoryPath: project.repositoryPath,
      status: project.status,
      currentObjective: project.currentObjective,
      gitSnapshot: null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
    return project;
  }

  list(): Project[] {
    return (this.listStmt.all() as unknown as ProjectRow[]).map(toProject);
  }

  getById(id: string): Project | null {
    const row = this.getStmt.get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  update(id: string, input: UpdateProjectInput): Project | null {
    if (!this.getById(id)) return null;
    const updatedAt = new Date().toISOString();
    if (input.repositoryPath !== undefined) {
      this.setRepoStmt.run(input.repositoryPath, updatedAt, id);
    }
    if (input.currentObjective !== undefined) {
      this.setObjectiveStmt.run(input.currentObjective, updatedAt, id);
    }
    return this.getById(id);
  }

  setStatus(id: string, status: ProjectStatus): Project | null {
    if (!this.getById(id)) return null;
    this.setStatusStmt.run(status, new Date().toISOString(), id);
    return this.getById(id);
  }

  setCurrentObjective(id: string, objectiveId: string | null, title: string | null): Project | null {
    if (!this.getById(id)) return null;
    const updatedAt = new Date().toISOString();
    // Aggiorna sia current_objective (denormalizzato) sia current_objective_id (relazione §5).
    this.setObjectiveStmt.run(title ?? null, updatedAt, id);
    this.setCurrentObjStmt.run(objectiveId, updatedAt, id);
    return this.getById(id);
  }

  updateGitSnapshot(id: string, snapshot: GitStatus | null): Project | null {
    if (!this.getById(id)) return null;
    this.setGitStmt.run(snapshot ? JSON.stringify(snapshot) : null, id);
    return this.getById(id);
  }
}
