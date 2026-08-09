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
  listEvents: (limit = 50) =>
    request<{ events: EventRecord[] }>(`/api/events?limit=${limit}`),
};