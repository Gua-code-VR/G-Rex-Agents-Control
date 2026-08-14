export type RetryJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';

export interface RetryJob {
  id: string;
  sessionId: string;
  runtimeId: string;
  fallbackOfAttemptId: string | null;
  dueAt: string;
  status: RetryJobStatus;
  createdAt: string;
  completedAt: string | null;
  reason: string | null;
}
