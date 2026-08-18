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
  policy: BudgetPolicy | null;
}
export interface BudgetPolicy { costBudget: number | null; warningPercent: number; action: 'WARN' | 'HARD_STOP' | 'REQUIRE_APPROVAL'; }
export interface GovernanceDashboard { policy: BudgetPolicy; totals: { totalTokens: number; costActual: number; costEstimate: number }; budget: { used: number; remaining: number | null }; breakdown: Array<{ providerName: string; modelName: string; attempts: number; totalTokens: number; cost: number }>; trend: Array<{ date: string; cost: number; totalTokens: number }>; objectives: Array<{ id: string; title: string; policy: BudgetPolicy | null; totals: { totalTokens: number; costActual: number; costEstimate: number } }> }

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
  /** M4: decisioni umane ancora da prendere (checkpoint PENDING_DECISION). */
  pendingDecisions: number;
  /** §5 V2: numero esatto di azioni umane realmente pendenti (checkpoint +
   *  approvazioni budget + approvazioni runtime). Fonte unica per i badge. */
  requiresYouCount: number;
  /** Costo live rilevato oggi (UTC). */
  costToday: number;
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
  policy: BudgetPolicy | null;
  estimatedCost: number | null;
}
export interface GovernanceApproval { id: string; objectiveId: string; projectedCost: number; status: 'PENDING' | 'APPROVED' | 'REJECTED'; requestNote: string | null; decisionNote: string | null; createdAt: string; decidedAt: string | null; }
export interface RuntimeApproval { requestId: string; objectiveId: string; sessionId: string; processReference: string | null; action: string; detail: string | null; requestedAt: string; }
export interface GovernanceException { id: string; objectiveId: string; note: string | null; expiresAt: string | null; createdAt: string; revokedAt: string | null; }

export interface RoutingCandidate {
  runtimeId: string; providerId: string; modelId: string | null; outputTokenLimit: number | null;
  eligible: boolean; score: number; reliability: number; estimatedCost: number | null;
  budgetFit: boolean; capabilities: string[]; reasons: string[];
}

export interface RoutingDecision {
  mode: 'AUTOMATIC' | 'EXPLICIT';
  reason: string;
  selectedScore: number | null;
  requiredCapabilities: string[];
  budget: { policy: BudgetPolicy; spent: number; remaining: number | null };
  candidates: RoutingCandidate[];
  objectiveType?: string;
  decidedAt: string;
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
  executionSelection: null | {
    runtimeId: string; providerId: string; modelId: string | null; outputTokenLimit: number | null;
    decision?: RoutingDecision;
  };
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
  technicalDetails: string | null;
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
  runtime?: string;
  providerId?: string;
  modelId?: string | null;
  outputTokenLimit?: number | null;
  estimatedCost?: number | null;
}

export interface ExecutionProvider { id: string; runtimeName: string; providerName: string; configured: boolean; }
export interface ProviderCatalogEntry { runtime: { id: string; name: string; type: string; available: boolean; defaultModel: string | null; capabilities: string[]; version: string | null }; provider: { id: string; name: string }; models: Array<{ id: string; name: string; version: string | null; capabilities: string[]; limits: { contextTokens: number | null; defaultOutputTokens: number }; pricing: { inputPerMillion: number | null; outputPerMillion: number | null; currency: string }; pricingSchedule?: Array<{ from: string; to: string; inputPerMillion: number | null; outputPerMillion: number | null }> | null }> }
export interface PreflightEstimate { runtimeId: string; providerId: string; modelId: string | null; available: boolean; inputTokens: number; outputTokens: number; totalTokens: number; cost: number | null; confidence: string; reason: string }
export interface ExecutionAttempt { id: string; attemptIndex: number; runtimeName: string | null; providerName: string | null; modelName: string | null; status: string; startedAt: string; endedAt: string | null; durationMs: number | null; exitCode: number | null; reason: string | null; errorClass: string | null; fallbackOfAttemptId?: string | null; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; costEstimate: number | null; costActual: number | null; metadata: unknown; }

/** Risposta delle API di transizione sessione/obiettivo (M3/M4). */
export interface ObjectiveTransition {
  objective: Objective;
  session: AgentSession;
  project: Project | null;
  /** Checkpoint M4 generato da complete/stop/block/fail (assente nell'avvio). */
  checkpoint?: Checkpoint | null;
}

/** M5: Tipo di decisione umana su un checkpoint. */
export type DecisionType = 'APPROVE' | 'REQUEST_CHANGES' | 'STOP' | 'CANCEL' | 'RETRY';

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

/** Risultato dell'obiettivo iniziale creato dal flusso «Crea progetto». */
export interface InitialObjectiveResult {
  objective: Objective;
  session: AgentSession;
  project: Project | null;
  autoStart: { started: boolean };
}

/** Risposta completa di POST /api/projects (flusso «Crea progetto»). */
export interface CreateProjectResult {
  project: Project;
  repositoryAssociated: boolean;
  initialObjective: InitialObjectiveResult | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Il content-type JSON va impostato solo quando c'è davvero un body:
  // una POST/PUT senza body con `Content-Type: application/json` fa fallire
  // il body parser del server con "Body cannot be empty...".
  const hasBody = init?.body !== undefined && init?.body !== null && init.body !== '';
  const response = await fetch(path, {
    ...init,
    headers: hasBody
      ? { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) }
      : init?.headers,
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
    request<CreateProjectResult>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateProject: (id: string, input: UpdateProjectInput) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  getProjectGovernance: (id: string) => request<{ governance: GovernanceDashboard }>(`/api/projects/${id}/governance`),
  setProjectPolicy: (id: string, policy: BudgetPolicy) => request<{ policy: BudgetPolicy }>(`/api/projects/${id}/policy`, { method: 'PUT', body: JSON.stringify(policy) }),
  setObjectivePolicy: (id: string, policy: BudgetPolicy) => request<{ policy: BudgetPolicy }>(`/api/objectives/${id}/policy`, { method: 'PUT', body: JSON.stringify(policy) }),
  grantBudgetException: (id: string, note?: string, expiresAt?: string) => request<{ exception: { id: string; expiresAt: string | null } }>(`/api/objectives/${id}/governance/exceptions`, { method: 'POST', body: JSON.stringify({ note, expiresAt }) }),
  listGovernanceApprovals: (objectiveId?: string) => request<{ approvals: GovernanceApproval[] }>(`/api/governance/approvals${objectiveId ? `?objectiveId=${encodeURIComponent(objectiveId)}` : ''}`),
  decideGovernanceApproval: (id: string, approve: boolean, note?: string) => request<{ approval: GovernanceApproval }>(`/api/governance/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ approve, note }) }),
  listRuntimeApprovals: () => request<{ approvals: RuntimeApproval[] }>('/api/runtime-approvals'),
  decideRuntimeApproval: (id: string, approved: boolean) => request<{ requestId: string; approved: boolean }>(`/api/runtime-approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ approved }) }),
  listGovernanceExceptions: (id: string) => request<{ exceptions: GovernanceException[] }>(`/api/objectives/${id}/governance/exceptions`),
  revokeGovernanceException: (id: string, note?: string) => request<{ exception: GovernanceException }>(`/api/governance/exceptions/${id}/revoke`, { method: 'POST', body: JSON.stringify({ note }) }),
  getGovernancePortfolio: () => request<{ projects: Array<{ project: { id: string; name: string }; governance: GovernanceDashboard }> }>('/api/governance/portfolio'),
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
  listExecutionProviders: () => request<{ providers: ExecutionProvider[] }>('/api/execution-providers'),
  getProviderCatalog: () => request<{ catalog: ProviderCatalogEntry[] }>('/api/provider-catalog'),
  estimateProviderCost: (runtimeId: string, objectiveText: string, stopCondition?: string | null) => request<{ estimate: PreflightEstimate }>('/api/provider-catalog/estimate', { method: 'POST', body: JSON.stringify({ runtimeId, objectiveText, stopCondition }) }),
  listExecutionAttempts: (sessionId: string) => request<{ attempts: ExecutionAttempt[] }>(`/api/sessions/${sessionId}/execution-attempts`),
  getObjective: (id: string) => request<ObjectiveDetail>(`/api/objectives/${id}`),
  startSession: (objectiveId: string, sessionId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null; outputTokenLimit?: number | null }) =>
    request<ObjectiveTransition>(`/api/objectives/${objectiveId}/sessions/${sessionId}/start`, {
      method: 'POST',
      body: selection ? JSON.stringify(selection) : undefined,
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
  retryObjective: (objectiveId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null; outputTokenLimit?: number | null }) =>
    request<ObjectiveTransition>(`/api/objectives/${objectiveId}/retry`, {
      method: 'POST',
      body: selection ? JSON.stringify(selection) : undefined,
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
