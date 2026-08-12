// ── M7: Auth API ──────────────────────────────────────────────────────

export interface AuthStatus {
  passwordSet: boolean;
}

export interface AuthLoginResponse {
  ok: boolean;
  expiresAt: string;
}

export interface AuthMeResponse {
  authenticated: boolean;
}

// ── Existing types ────────────────────────────────────────────────────

export type ProjectStatus =
  | 'FERMO'
  | 'IN_AVVIO'
  | 'IN_LAVORAZIONE'
  | 'RICHIEDE_ATTENZIONE'
  | 'BLOCCATO'
  | 'COMPLETATO'
  | 'ERRORE';

export type ProjectStatusGroup = 'FERMO' | 'IN_LAVORAZIONE' | 'PROBLEMA';

export interface GitStatus {
  fetchedAt: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  lastCommit: string | null;
  lastCommitAt: string | null;
  error: string | null;
}

export interface Project {
  id: string;
  name: string;
  repositoryPath: string | null;
  status: ProjectStatus;
  statusGroup: ProjectStatusGroup;
  currentObjective: string | null;
  gitStatus: GitStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  schemaVersion: number;
  uptimeSeconds: number;
  timestamp: string;
}

export interface StatusResponse {
  generatedAt: string;
  projectsCount: number;
  projectsByStatus: Record<string, number>;
  projectsByGroup: Record<ProjectStatusGroup, number>;
  eventsCount: number;
  /** M4: checkpoint in attesa di decisione umana. */
  pendingDecisions: number;
  storage: {
    dbPath: string;
    exists: boolean;
    fileSizeBytes: number;
  };
}

export interface EventRecord {
  id: number;
  projectId: string | null;
  objectiveId: string | null;
  sessionId: string | null;
  type: string;
  category: 'USER' | 'TECHNICAL' | 'AGENT';
  timestamp: string;
  payload: unknown;
}

export interface ListEventsOptions {
  limit?: number;
  projectId?: string;
  objectiveId?: string;
  sessionId?: string;
  category?: EventRecord['category'];
}

export interface CreateProjectInput {
  name: string;
  repositoryPath?: string;
  currentObjective?: string;
}

export interface UpdateProjectInput {
  repositoryPath?: string | null;
  currentObjective?: string | null;
}

export type ObjectiveStatus =
  | 'IN_AVVIO'
  | 'IN_LAVORAZIONE'
  | 'RICHIEDE_ATTENZIONE'
  | 'BLOCCATO'
  | 'COMPLETATO'
  | 'ERRORE'
  | 'ANNULLATO';

export type SessionStatus = 'IN_AVVIO' | 'ATTIVA' | 'COMPLETATA' | 'ERRORE' | 'INTERROTTA' | 'BLOCCATA' | 'STALE';

export interface Objective {
  id: string;
  projectId: string;
  title: string;
  objectiveText: string;
  invariants: string[];
  acceptanceCriteria: string[];
  stopCondition: string | null;
  status: ObjectiveStatus;
  startedAt: string | null;
  completedAt: string | null;
  finalReport: string | null;
  gitStart: GitStatus | null;
  gitEnd: GitStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  objectiveId: string;
  agentType: string;
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  lastActivityAt: string | null;
  processReference: string | null;
  exitReason: string | null;
  heartbeatIntervalMs: number;
  lastHeartbeatAt: string | null;
}

export interface Notification {
  id: string; type: string; severity: 'info' | 'warning' | 'error' | 'critical';
  title: string; message: string; createdAt: string; readAt: string | null;
}

export type CheckpointOutcome = 'COMPLETED' | 'INTERRUPTED' | 'BLOCKED' | 'ERROR';

export type CheckpointAcceptanceStatus = 'MET' | 'NOT_MET' | 'UNVERIFIED';

export type EvidenceSource = 'SYSTEM' | 'AGENT' | 'HUMAN';

export interface GitDelta {
  fromBranch: string | null;
  toBranch: string | null;
  fromHead: string | null;
  toHead: string | null;
  commitChanged: boolean;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  lastCommit: string | null;
  lastCommitAt: string | null;
}

/** Checkpoint M4/M5 (§12): esito di sessione in attesa di decisione umana. */
export interface Checkpoint {
  id: string;
  projectId: string;
  objectiveId: string;
  sessionId: string | null;
  outcome: CheckpointOutcome;
  status: 'PENDING_DECISION' | 'DECIDED';
  summary: string;
  acceptanceStatus: CheckpointAcceptanceStatus;
  evidenceSummary: string;
  gitDelta: GitDelta | null;
  testsSummary: string;
  warnings: string[];
  recommendedAction: string;
  fullReportReference: string | null;
  evidenceSources: EvidenceSource[];
  createdAt: string;
  decidedAt: string | null;
  decisionType: DecisionType | null;
}

export interface CreateObjectiveInput {
  title: string;
  objectiveText: string;
  invariants?: string[];
  acceptanceCriteria?: string[];
  stopCondition?: string | null;
}

/** Risposta delle API di transizione sessione/obiettivo (M3/M4). */
export interface ObjectiveTransition {
  objective: Objective;
  session: AgentSession;
  project: Project | null;
  /** Checkpoint M4 generato da complete/stop/block/fail (assente nell'avvio). */
  checkpoint?: Checkpoint | null;
}

/** M5: Tipo di decisione umana su un checkpoint. */
export type DecisionType = 'APPROVE' | 'REQUEST_CHANGES' | 'STOP' | 'CANCEL';

/** M5: Record di decisione umana (append-only). */
export interface HumanDecision {
  id: string;
  checkpointId: string;
  decisionType: DecisionType;
  note: string | null;
  decidedAt: string;
}

/** M5: Risposta dell'API di decisione. */
export interface DecisionResponse {
  checkpoint: Checkpoint;
  decision: HumanDecision;
  objective: Objective;
  project: Project | null;
}

export interface ObjectiveDetail {
  objective: Objective;
  sessions: AgentSession[];
  /** Checkpoint M4 associati all'obiettivo (§12). */
  checkpoints: Checkpoint[];
}

export interface CancelObjectiveResponse {
  objective: Objective;
  project: Project | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // si mantiene statusText
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  status: () => request<StatusResponse>('/api/status'),
  listProjects: () => request<{ projects: Project[] }>('/api/projects'),
  getProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}`),
  createProject: (input: CreateProjectInput) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateProject: (id: string, input: UpdateProjectInput) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  setProjectStatus: (id: string, status: ProjectStatus) =>
    request<{ project: Project }>(`/api/projects/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  refreshProjectGitStatus: (id: string) =>
    request<{ project: Project }>(`/api/projects/${id}/git-status`, {
      method: 'POST',
    }),
  listObjectives: (projectId: string) =>
    request<{ objectives: Objective[] }>(`/api/projects/${projectId}/objectives`),
  createObjective: (projectId: string, input: CreateObjectiveInput) =>
    request<ObjectiveTransition>(`/api/projects/${projectId}/objectives`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getObjective: (id: string) => request<ObjectiveDetail>(`/api/objectives/${id}`),
  startSession: (objectiveId: string, sessionId: string) =>
    request<ObjectiveTransition>(`/api/objectives/${objectiveId}/sessions/${sessionId}/start`, {
      method: 'POST',
    }),
  stopSession: (objectiveId: string, sessionId: string, reason?: string) =>
    request<ObjectiveTransition>(`/api/objectives/${objectiveId}/sessions/${sessionId}/stop`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  completeObjective: (objectiveId: string, report?: string) =>
    request<ObjectiveTransition>(`/api/objectives/${objectiveId}/complete`, {
      method: 'POST',
      body: JSON.stringify(report ? { report } : {}),
    }),
  blockObjective: (objectiveId: string, reason?: string) =>
    request<ObjectiveTransition>(`/api/objectives/${objectiveId}/block`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  failObjective: (objectiveId: string, error?: string) =>
    request<ObjectiveTransition>(`/api/objectives/${objectiveId}/fail`, {
      method: 'POST',
      body: JSON.stringify(error ? { error } : {}),
    }),
  getObjectiveCheckpoints: (objectiveId: string) =>
    request<{ checkpoints: Checkpoint[] }>(`/api/objectives/${objectiveId}/checkpoints`),
  cancelObjective: (objectiveId: string) =>
    request<CancelObjectiveResponse>(`/api/objectives/${objectiveId}/cancel`, {
      method: 'POST',
    }),
  // M5: Decisione umana su checkpoint
  decideCheckpoint: (checkpointId: string, decisionType: DecisionType, note?: string) =>
    request<DecisionResponse>(`/api/checkpoints/${checkpointId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decisionType, ...(note ? { note } : {}) }),
    }),
  listEvents: (options: number | ListEventsOptions = 50) => {
    const normalized = typeof options === 'number' ? { limit: options } : options ?? {};
    const params = new URLSearchParams();
    if (normalized.limit !== undefined) params.append('limit', String(normalized.limit));
    if (normalized.projectId) params.append('projectId', normalized.projectId);
    if (normalized.objectiveId) params.append('objectiveId', normalized.objectiveId);
    if (normalized.sessionId) params.append('sessionId', normalized.sessionId);
    if (normalized.category) params.append('category', normalized.category);
    const query = params.toString();
    return request<{ events: EventRecord[] }>(`/api/events${query ? `?${query}` : ''}`);
  },
  listNotifications: () => request<{ notifications: Notification[] }>('/api/notifications'),
  markAllNotificationsRead: () => request<{ count: number }>('/api/notifications/read-all', { method: 'POST' }),
  createBackup: () => request<{ backup: { directory: string; createdAt: string; files: string[] } }>('/api/backups', { method: 'POST' }),

  // M7: Auth API
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  authLogin: (password: string) =>
    request<AuthLoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  authSetup: (password: string) =>
    request<AuthLoginResponse>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  authLogout: () =>
    request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  authMe: () => request<AuthMeResponse>('/api/auth/me'),
  authChangePassword: (currentPassword: string, newPassword: string) =>
    request<AuthLoginResponse>('/api/auth/change', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};
