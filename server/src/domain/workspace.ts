/**
 * ExecutionWorkspace (§19 V2): working directory Git isolata assegnata al
 * lavoro di un Objective. Nel caso ordinario è realizzata tramite un Git
 * worktree + branch dedicato: Objective differenti sullo stesso repository
 * non condividono la working tree, e retry/fallback della stessa esecuzione
 * riutilizzano la stessa workspace.
 *
 * La workspace è infrastruttura dell'esecuzione: non cambia l'identità del
 * Project/Objective e non richiede modifiche al modello del runtime. I
 * runtime (Cline, Codex, fake) ricevono semplicemente il percorso isolato
 * come `projectPath`/`cwd` (§19.1). La gestione del lifecycle appartiene a
 * un servizio separato (WorktreeService) e non altera le responsabilità del
 * ProcessSupervisor né dell'Execution Plane (§19.2/§29).
 */

export const WORKSPACE_STATUSES = [
  /** Worktree e branch presenti, associata all'esecuzione (retry/fallback riusano). */
  'ACTIVE',
  /** Lavoro non integrato (main sporco o conflitto): richiede decisione/integrazione. */
  'PENDING_INTEGRATION',
  /** Lavoro integrato nel repository di destinazione (il worktree è stato rimosso). */
  'INTEGRATED',
  /** Worktree non più presente (riavvio/crash/rimozione manuale): work preservata nel branch. */
  'STALE',
  /** Rimossa esplicitamente (record mantenuto per audit). */
  'REMOVED',
] as const;

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/** Workspace Git isolata di un Objective (§19). */
export interface AgentWorkspace {
  id: string;
  projectId: string;
  objectiveId: string;
  /** Sessione che ha materializzato per prima la workspace (§19.2: le retry riusano). */
  sessionId: string;
  /** Percorso della working tree principale del repository. */
  repositoryPath: string;
  /** Percorso isolato (worktree) passato ai runtime come projectPath/cwd. */
  worktreePath: string;
  /** Branch dedicato e identificabile associato alla workspace. */
  branch: string;
  /** SHA del branch principale al momento della creazione (evidenza SYSTEM). */
  baseRef: string | null;
  status: WorkspaceStatus;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Timestamp dell'integrazione riuscita nel repository di destinazione. */
  integratedAt: string | null;
  error: string | null;
}

export interface CreateWorkspaceInput {
  projectId: string;
  objectiveId: string;
  sessionId: string;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string | null;
}

export interface UpdateWorkspaceInput {
  status?: WorkspaceStatus;
  statusReason?: string | null;
  lastUsedAt?: string | null;
  integratedAt?: string | null;
  error?: string | null;
}
