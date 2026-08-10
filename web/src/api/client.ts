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
  timestamp: string;
  payload: unknown;
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

export type SessionStatus = 'IN_AVVIO' | 'ATTIVA' | 'COMPLETATA' | 'ERRORE' | 'INTERROTTA';

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
}

export interface CreateObjectiveInput {
  title: string;
  objectiveText: string;
  invariants?: string[];
  acceptanceCriteria?: string[];
  stopCondition?: string | null;
}

/** Risposta delle API di transizione sessione/obiettivo (M3). */
export interface ObjectiveTransition {
  objective: Objective;
  session: AgentSession;
  project: Project | null;
}

export interface ObjectiveDetail {
  objective: Objective;
  sessions: AgentSession[];
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
  cancelObjective: (objectiveId: string) =>
    request<CancelObjectiveResponse>(`/api/objectives/${objectiveId}/cancel`, {
      method: 'POST',
    }),
  listEvents: (limit = 50) =>
    request<{ events: EventRecord[] }>(`/api/events?limit=${limit}`),
};