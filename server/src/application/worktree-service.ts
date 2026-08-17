import fs from 'node:fs';
import path from 'node:path';
import type { AgentWorkspace } from '../domain/workspace.js';
import type { Objective, AgentSession } from '../domain/objective.js';
import type { Project } from '../domain/project.js';
import type { WorkspaceRepository } from '../infrastructure/db/workspace-repo.js';
import { GitWorktreeManager, samePath } from '../infrastructure/git/git-worktree-manager.js';
import type { EventService } from './event-service.js';
import type { NotificationService } from './notification-service.js';

/**
 * WorktreeService (§19 V2): lifecycle delle workspace Git isolate. Creazione,
 * associazione, riuso (retry/fallback), integrazione e rimozione sono
 * tracciabili via eventi. Resta separato dal ProcessSupervisor e non altera
 * le responsabilità dell'Execution Plane (§29): i runtime ricevono solo il
 * percorso isolato come projectPath/cwd.
 */

export class WorktreeError extends Error {}

export const EVENT_WORKSPACE_PROVISIONED = 'workspace.provisioned';
export const EVENT_WORKSPACE_REUSED = 'workspace.reused';
export const EVENT_WORKSPACE_PROVISION_SKIPPED = 'workspace.provision_skipped';
export const EVENT_WORKSPACE_BLOCKED = 'workspace.blocked';
export const EVENT_WORKSPACE_INTEGRATED = 'workspace.integrated';
export const EVENT_WORKSPACE_INTEGRATION_DEFERRED = 'workspace.integration_deferred';
export const EVENT_WORKSPACE_INTEGRATION_CONFLICT = 'workspace.integration_conflict';
export const EVENT_WORKSPACE_RECONCILED = 'workspace.reconciled';
export const EVENT_WORKSPACE_REMOVED = 'workspace.removed';
export const EVENT_WORKSPACE_ERROR = 'workspace.error';

export interface WorktreeServiceConfig {
  enabled: boolean;
  baseDir: string;
  branchPrefix: string;
  integrateOnComplete: boolean;
  blockOnDirty: boolean;
}

/** Nome breve (8 char) e sicuro per file/branch derivato da un UUID. */
function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'ws';
}

export class WorktreeService {
  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly git: GitWorktreeManager,
    private readonly events: EventService,
    private readonly notifications: NotificationService | undefined,
    private readonly config: WorktreeServiceConfig,
  ) {}

  list(): AgentWorkspace[] { return this.workspaces.list(); }
  listByProject(projectId: string): AgentWorkspace[] { return this.workspaces.listByProject(projectId); }
  listByObjective(objectiveId: string): AgentWorkspace[] { return this.workspaces.listByObjective(objectiveId); }
  getById(id: string): AgentWorkspace | null { return this.workspaces.getById(id); }

  /**
   * Risolve il percorso da passare al runtime. Con workspace abilitate e
   * repository Git valido restituisce il worktree isolato (creandolo o
   * riusando quello dell'Objective: retry/fallback preservano il lavoro,
   * §19.2). Quando l'isolamento non è applicabile degrada al percorso
   * principale (comportamento precedente), senza errori.
   */
  async resolveExecutionPath(
    project: Project | null,
    objective: Objective,
    session: AgentSession,
  ): Promise<{ path: string | null; workspace: AgentWorkspace | null }> {
    if (!this.config.enabled || !project?.repositoryPath) {
      return { path: project?.repositoryPath ?? null, workspace: null };
    }
    const repositoryPath = project.repositoryPath;

    // Riuso (§19.2): retry/fallback della stessa esecuzione non ricreano
    // inutilmente il lavoro già prodotto nella workspace.
    const existing = this.workspaces.listByObjective(objective.id)
      .find((w) => w.status === 'ACTIVE' || w.status === 'PENDING_INTEGRATION');
    if (existing) {
      try {
        if (await this.git.worktreeExists(repositoryPath, existing.worktreePath)) {
          this.workspaces.update(existing.id, { lastUsedAt: new Date().toISOString() });
          this.events.log(EVENT_WORKSPACE_REUSED, {
            projectId: objective.projectId,
            objectiveId: objective.id,
            sessionId: session.id,
            payload: { workspaceId: existing.id, branch: existing.branch, worktreePath: existing.worktreePath },
          });
          return { path: existing.worktreePath, workspace: existing };
        }
        this.workspaces.setStatus(existing.id, 'STALE', 'Worktree non più presente al riuso');
      } catch {
        this.workspaces.setStatus(existing.id, 'STALE', 'Worktree non verificabile al riuso');
      }
    }

    // Il repository deve essere un working tree Git valido; altrimenti si
    // degrada al comportamento precedente (percorso principale).
    let verified = false;
    try { verified = await this.git.verifyRepository(repositoryPath); } catch { verified = false; }
    if (!verified) {
      this.events.log(EVENT_WORKSPACE_PROVISION_SKIPPED, {
        projectId: objective.projectId,
        objectiveId: objective.id,
        sessionId: session.id,
        payload: { repositoryPath, reason: 'Il percorso non è un repository Git valido' },
      });
      return { path: repositoryPath, workspace: null };
    }

    // §19.3: modifiche locali non committate nella working tree principale
    // non vengono ignorate né nascoste: l'avvio si ferma con una richiesta
    // esplicita (notifica + evento), senza toccare il lavoro dell'utente.
    if (this.config.blockOnDirty) {
      let clean = true;
      let dirtyPaths: string[] = [];
      try {
        const state = await this.git.isClean(repositoryPath);
        clean = state.clean;
        dirtyPaths = state.dirtyPaths;
      } catch { clean = true; }
      if (!clean) {
        this.events.log(EVENT_WORKSPACE_BLOCKED, {
          projectId: objective.projectId,
          objectiveId: objective.id,
          sessionId: session.id,
          payload: { repositoryPath, dirtyPaths: dirtyPaths.slice(0, 20) },
        });
        this.notifications?.notify({
          type: 'WORKSPACE_BLOCKED',
          severity: 'warning',
          title: 'Working tree principale non pulita',
          message: `L'isolamento della workspace per «${objective.title}» non può procedere: la working tree principale contiene modifiche non committate. Saranno preservate: committale o puliscile, poi riprova.`,
          projectId: objective.projectId,
          objectiveId: objective.id,
          sessionId: session.id,
          metadata: { repositoryPath, dirtyPaths: dirtyPaths.slice(0, 20) },
        });
        throw new WorktreeError(
          'La working tree principale contiene modifiche non committate: l\'esecuzione isolata è bloccata (§19.3). Riconcilia le modifiche e riprova.',
        );
      }
    }

    return this.provision(repositoryPath, project, objective, session);
  }

  /** Registra l'uso della workspace da parte di una sessione. */
  attachSession(workspaceId: string, sessionId: string): void {
    const workspace = this.workspaces.getById(workspaceId);
    if (!workspace) return;
    this.workspaces.update(workspaceId, { lastUsedAt: new Date().toISOString() });
    if (workspace.status === 'ACTIVE') {
      this.workspaces.update(workspaceId, { statusReason: `Sessione in uso: ${sessionId.slice(0, 8)}` });
    }
  }


  /** Crea (o recupera) la workspace isolata per l'Objective: branch dedicato
   *  + worktree in `config.baseDir`. Gestisce anche il caso di crash in cui
   *  il branch esista già: il worktree viene aggiunto al branch esistente. */
  private async provision(
    repositoryPath: string,
    project: Project,
    objective: Objective,
    session: AgentSession,
  ): Promise<{ path: string; workspace: AgentWorkspace }> {
    const branch = `${this.config.branchPrefix}${objective.id}`;
    const worktreePath = path.join(
      this.config.baseDir,
      `${project.id.slice(0, 8)}-${shortId(objective.id)}-${shortId(session.id)}`,
    );

    const baseRef = await this.git.headSha(repositoryPath).catch(() => null);

    // Recovery da crash: branch già esistente con un worktree → riuso.
    let existingByBranch: { path: string } | null = null;
    try {
      const worktrees = await this.git.listWorktrees(repositoryPath);
      existingByBranch = worktrees.find((w) => w.branch === branch) ?? null;
    } catch { existingByBranch = null; }

    try {
      if (existingByBranch) {
        if (!samePath(existingByBranch.path, worktreePath)) {
          const prior = this.workspaces.listByObjective(objective.id)[0];
          if (prior) {
            this.workspaces.update(prior.id, {
              status: 'ACTIVE',
              statusReason: 'Worktree ritrovato su branch esistente',
              lastUsedAt: new Date().toISOString(),
            });
            return { path: prior.worktreePath, workspace: prior };
          }
        }
      } else if (await this.git.branchExists(repositoryPath, branch)) {
        await this.git.addWorktreeToBranch(repositoryPath, branch, worktreePath);
      } else {
        fs.mkdirSync(this.config.baseDir, { recursive: true });
        await this.git.createBranchWorktree(repositoryPath, branch, worktreePath);
      }
    } catch (error) {
      this.events.log(EVENT_WORKSPACE_ERROR, {
        projectId: objective.projectId,
        objectiveId: objective.id,
        sessionId: session.id,
        payload: { repositoryPath, branch, worktreePath, error: error instanceof Error ? error.message : String(error) },
      });
      throw error instanceof Error ? new WorktreeError(`Impossibile creare la workspace isolata: ${error.message}`) : error;
    }

    const workspace = this.workspaces.create({
      projectId: project.id,
      objectiveId: objective.id,
      sessionId: session.id,
      repositoryPath,
      worktreePath: existingByBranch ? existingByBranch.path : worktreePath,
      branch,
      baseRef,
    });

    this.events.log(EVENT_WORKSPACE_PROVISIONED, {
      projectId: project.id,
      objectiveId: objective.id,
      sessionId: session.id,
      payload: {
        workspaceId: workspace.id,
        branch,
        worktreePath: workspace.worktreePath,
        baseRef,
      },
    });

    return { path: workspace.worktreePath, workspace };
  }


  /**
   * Integrazione finale (§19.4): al completamento dell'Objective, se la
   * workspace esiste e l'integrazione automatica è abilitata, verifica che
   * la destinazione sia pulita e sicura, committa l'eventuale lavoro residuo
   * sul branch dedicato e lo integra nella working tree principale. Se
   * l'operazione non è deterministica e sicura (main sporco, conflitto
   * reale) il lavoro resta preservato e viene creata una richiesta umana:
   * nessuna modifica utente viene cancellata o forzata.
   */
  async integrateOnComplete(objective: Objective): Promise<AgentWorkspace | null> {
    if (!this.config.enabled || !this.config.integrateOnComplete) return null;
    const workspace = this.workspaces.listByObjective(objective.id)
      .find((w) => w.status === 'ACTIVE' || w.status === 'PENDING_INTEGRATION');
    if (!workspace) return null;
    const repositoryPath = workspace.repositoryPath;

    let exists = false;
    try { exists = await this.git.worktreeExists(repositoryPath, workspace.worktreePath); } catch { exists = false; }
    if (!exists) {
      this.workspaces.setStatus(workspace.id, 'STALE', 'Worktree non presente al completamento');
      this.events.log(EVENT_WORKSPACE_ERROR, {
        projectId: objective.projectId, objectiveId: objective.id,
        payload: { workspaceId: workspace.id, reason: 'Worktree non presente al completamento' },
      });
      return this.workspaces.getById(workspace.id);
    }

    let mainClean = false;
    try { mainClean = (await this.git.isClean(repositoryPath)).clean; } catch { mainClean = false; }
    if (!mainClean) {
      this.workspaces.setStatus(workspace.id, 'PENDING_INTEGRATION', 'Working tree principale sporca: integrazione rinviata');
      this.notifications?.notify({
        type: 'WORKSPACE_INTEGRATION_REQUIRED',
        severity: 'warning',
        title: 'Integrazione della workspace rinviata',
        message: `Il lavoro di «${objective.title}» è preservato sul branch «${workspace.branch}», ma la working tree principale contiene modifiche non committate: integrale manualmente quando è pulita.`,
        projectId: objective.projectId, objectiveId: objective.id,
        metadata: { workspaceId: workspace.id, branch: workspace.branch, worktreePath: workspace.worktreePath },
      });
      this.events.log(EVENT_WORKSPACE_INTEGRATION_DEFERRED, {
        projectId: objective.projectId, objectiveId: objective.id,
        payload: { workspaceId: workspace.id, reason: 'Working tree principale sporca' },
      });
      return this.workspaces.getById(workspace.id);
    }

    // Committa l'eventuale lavoro residuo sul branch dedicato (identità GAC).
    let committed = false;
    try {
      committed = await this.git.commitAll(workspace.worktreePath, `GAC: lavoro obiettivo «${objective.title}»`);
    } catch (error) {
      this.workspaces.setStatus(workspace.id, 'PENDING_INTEGRATION', `Commit del lavoro non riuscito: ${error instanceof Error ? error.message : String(error)}`);
      this.events.log(EVENT_WORKSPACE_ERROR, {
        projectId: objective.projectId, objectiveId: objective.id,
        payload: { workspaceId: workspace.id, error: error instanceof Error ? error.message : String(error) },
      });
      return this.workspaces.getById(workspace.id);
    }

    const merge = await this.git.mergeBranch(repositoryPath, workspace.branch);
    if (merge.ok) {
      await this.git.removeWorktree(repositoryPath, workspace.worktreePath).catch(() => undefined);
      this.workspaces.setStatus(workspace.id, 'INTEGRATED', merge.result === 'up-to-date' ? 'Nessuna modifica da integrare' : 'Integrato nella working tree principale', new Date().toISOString());
      this.events.log(EVENT_WORKSPACE_INTEGRATED, {
        projectId: objective.projectId, objectiveId: objective.id,
        payload: { workspaceId: workspace.id, branch: workspace.branch, result: merge.result, committed },
      });
    } else {
      this.workspaces.setStatus(workspace.id, 'PENDING_INTEGRATION', merge.error ?? 'Conflitto di integrazione');
      this.notifications?.notify({
        type: 'WORKSPACE_INTEGRATION_REQUIRED',
        severity: 'warning',
        title: 'Integrazione della workspace non automatica',
        message: `L'integrazione del branch «${workspace.branch}» (obiettivo «${objective.title}») non è automatica: ${merge.error ?? 'conflitto reale'}. Il lavoro è preservato: risolvi manualmente.`,
        projectId: objective.projectId, objectiveId: objective.id,
        metadata: { workspaceId: workspace.id, branch: workspace.branch, worktreePath: workspace.worktreePath, result: merge.result },
      });
      this.events.log(EVENT_WORKSPACE_INTEGRATION_CONFLICT, {
        projectId: objective.projectId, objectiveId: objective.id,
        payload: { workspaceId: workspace.id, branch: workspace.branch, result: merge.result, error: merge.error },
      });
    }
    return this.workspaces.getById(workspace.id);
  }


  /**
   * Riconciliazione dopo crash/riavvio (§19.5): confronta lo stato persistito
   * con i worktree realmente presenti prima di avviare nuovo lavoro
   * concorrente. Una workspace il cui worktree non esiste più passa a STALE
   * (il lavoro resta sul branch); una STALE ritrovata torna ACTIVE.
   */
  async reconcile(): Promise<{ checked: number; stale: number; recovered: number }> {
    if (!this.config.enabled) return { checked: 0, stale: 0, recovered: 0 };
    let stale = 0;
    let recovered = 0;
    let checked = 0;
    for (const ws of this.workspaces.list()) {
      if (ws.status === 'INTEGRATED' || ws.status === 'REMOVED') continue;
      checked += 1;
      let present = false;
      try { present = await this.git.worktreeExists(ws.repositoryPath, ws.worktreePath); } catch { present = false; }
      if (!present) {
        stale += 1;
        this.workspaces.setStatus(ws.id, 'STALE', 'Worktree non presente alla riconciliazione di avvio');
        this.events.log(EVENT_WORKSPACE_RECONCILED, {
          projectId: ws.projectId, objectiveId: ws.objectiveId,
          payload: { workspaceId: ws.id, outcome: 'stale', branch: ws.branch },
        });
      } else if (ws.status === 'STALE') {
        recovered += 1;
        this.workspaces.setStatus(ws.id, 'ACTIVE', 'Worktree ritrovato alla riconciliazione di avvio');
        this.events.log(EVENT_WORKSPACE_RECONCILED, {
          projectId: ws.projectId, objectiveId: ws.objectiveId,
          payload: { workspaceId: ws.id, outcome: 'recovered', branch: ws.branch },
        });
      }
    }
    this.events.log(EVENT_WORKSPACE_RECONCILED, {
      payload: { outcome: 'summary', checked, stale, recovered },
    });
    return { checked, stale, recovered };
  }

  /**
   * Pulizia esplicita (§19.5). Una workspace con lavoro non integrato
   * (PENDING_INTEGRATION) non viene rimossa senza `force`: la decisione
   * spetta all'utente. Il record resta per audit.
   */
  async cleanup(workspaceId: string, force = false): Promise<AgentWorkspace | null> {
    const workspace = this.workspaces.getById(workspaceId);
    if (!workspace) return null;
    if (workspace.status === 'PENDING_INTEGRATION' && !force) {
      throw new WorktreeError(
        'La workspace contiene lavoro non integrato: la rimozione richiede una decisione umana esplicita (force).',
      );
    }
    let removed = false;
    try {
      await this.git.removeWorktree(workspace.repositoryPath, workspace.worktreePath, force);
      removed = true;
    } catch (error) {
      if (!force) throw error instanceof Error ? new WorktreeError(error.message) : error;
    }
    this.workspaces.setStatus(workspace.id, 'REMOVED', removed ? 'Rimozione esplicita' + (force ? ' (forzata)' : '') : 'Rimozione forzata best-effort');
    this.events.log(EVENT_WORKSPACE_REMOVED, {
      projectId: workspace.projectId, objectiveId: workspace.objectiveId,
      payload: { workspaceId: workspace.id, branch: workspace.branch, worktreePath: workspace.worktreePath, force, removed },
    });
    return this.workspaces.getById(workspace.id);
  }
}

