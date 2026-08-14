import type { RetryJob } from '../domain/retry-job.js';
import type { RetryJobRepository } from '../infrastructure/db/retry-job-repo.js';
import type { EventService } from './event-service.js';

export const EVENT_RETRY_SCHEDULED = 'execution.retry.scheduled';
export const EVENT_RETRY_STARTED = 'execution.retry.started';
export const EVENT_RETRY_CANCELLED = 'execution.retry.cancelled';

export class PersistentRetryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private executor: ((job: RetryJob) => Promise<void>) | null = null;
  constructor(private readonly jobs: RetryJobRepository, private readonly events: EventService, private readonly intervalMs = 1_000) {}
  schedule(sessionId: string, runtimeId: string, fallbackOfAttemptId: string | null, delayMs: number): RetryJob {
    const job = this.jobs.create(sessionId, runtimeId, fallbackOfAttemptId, new Date(Date.now() + delayMs).toISOString());
    this.events.log(EVENT_RETRY_SCHEDULED, { category: 'TECHNICAL', sessionId, payload: { retryJobId: job.id, runtimeId, dueAt: job.dueAt, fallbackOfAttemptId } });
    return job;
  }
  setExecutor(executor: (job: RetryJob) => Promise<void>): void { this.executor = executor; }
  start(): void { if (!this.timer) { this.timer = setInterval(() => void this.runDue(), this.intervalMs); this.timer.unref(); } void this.runDue(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  cancelSession(sessionId: string, reason: string): void { this.jobs.cancelBySession(sessionId, reason); this.events.log(EVENT_RETRY_CANCELLED, { category: 'TECHNICAL', sessionId, payload: { reason } }); }
  async runDue(): Promise<void> { if (!this.executor) return; for (const pending of this.jobs.due(new Date().toISOString())) { const job = this.jobs.claim(pending.id); if (!job) continue; try { this.events.log(EVENT_RETRY_STARTED, { category: 'TECHNICAL', sessionId: job.sessionId, payload: { retryJobId: job.id, runtimeId: job.runtimeId } }); await this.executor(job); this.jobs.finish(job.id, 'COMPLETED'); } catch (error) { this.jobs.finish(job.id, 'CANCELLED', error instanceof Error ? error.message : 'Retry non avviabile'); } } }
}
