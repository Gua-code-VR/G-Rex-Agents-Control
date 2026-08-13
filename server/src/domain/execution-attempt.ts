export const EXECUTION_ATTEMPT_STATUSES = ['STARTED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type ExecutionAttemptStatus = (typeof EXECUTION_ATTEMPT_STATUSES)[number];

export interface ExecutionAttempt {
  id: string;
  sessionId: string;
  attemptIndex: number;
  runtimeType: string | null;
  runtimeName: string | null;
  providerName: string | null;
  modelName: string | null;
  processReference: string | null;
  status: ExecutionAttemptStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  reason: string | null;
  errorClass: string | null;
  fallbackOfAttemptId: string | null;
  metadata: unknown | null;
}

export interface CreateExecutionAttemptInput {
  attemptIndex?: number;
  runtimeType?: string | null;
  runtimeName?: string | null;
  providerName?: string | null;
  modelName?: string | null;
  processReference?: string | null;
  metadata?: unknown | null;
  fallbackOfAttemptId?: string | null;
}

export interface UpdateExecutionAttemptInput {
  endedAt: string;
  durationMs?: number | null;
  exitCode?: number | null;
  status?: ExecutionAttemptStatus;
  reason?: string | null;
  errorClass?: string | null;
  metadata?: unknown | null;
}
