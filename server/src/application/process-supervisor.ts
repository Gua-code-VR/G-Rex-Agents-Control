import type { ExecutionAttemptRepository } from '../infrastructure/db/execution-attempt-repo.js';
import type { EventService } from './event-service.js';
import type { AgentSession } from '../domain/objective.js';
import type {
  ExecutionAttempt,
  CreateExecutionAttemptInput,
  UpdateExecutionAttemptInput,
  ExecutionAttemptStatus,
} from '../domain/execution-attempt.js';

export const EVENT_EXECUTION_ATTEMPT_STARTED = 'execution.attempt.started';
export const EVENT_EXECUTION_ATTEMPT_COMPLETED = 'execution.attempt.completed';
export const EVENT_EXECUTION_ATTEMPT_FAILED = 'execution.attempt.failed';
export const EVENT_EXECUTION_ATTEMPT_CANCELLED = 'execution.attempt.cancelled';
export const EVENT_EXECUTION_ATTEMPT_PROGRESS = 'execution.attempt.progress';
export const EVENT_EXECUTION_ATTEMPT_HEARTBEAT = 'execution.attempt.heartbeat';
export const EVENT_EXECUTION_ATTEMPT_FALLBACK = 'execution.attempt.fallback';
export const EVENT_EXECUTION_BUDGET_EXCEEDED = 'execution.budget.exceeded';

export interface ExecutionPolicy { retryMax: number; retryBackoffMs: number; fallbackRuntime: string | null; costBudget?: number | null; }
export interface RetryPlan { runtime: string; delayMs: number; fallbackOfAttemptId: string | null; }
export interface UsageTotals { inputTokens: number; outputTokens: number; totalTokens: number; costEstimate: number; costActual: number; }

export class ProcessSupervisor {
  constructor(
    private readonly attempts: ExecutionAttemptRepository,
    private readonly events: EventService,
    private readonly policy: ExecutionPolicy = { retryMax: 0, retryBackoffMs: 1_000, fallbackRuntime: null },
  ) {}

  private nextAttemptIndex(sessionId: string): number {
    const existing = this.attempts.listBySession(sessionId);
    return existing.length + 1;
  }

  private statusEventType(status: ExecutionAttemptStatus): string {
    switch (status) {
      case 'STARTED':
        return EVENT_EXECUTION_ATTEMPT_STARTED;
      case 'COMPLETED':
        return EVENT_EXECUTION_ATTEMPT_COMPLETED;
      case 'FAILED':
        return EVENT_EXECUTION_ATTEMPT_FAILED;
      case 'CANCELLED':
        return EVENT_EXECUTION_ATTEMPT_CANCELLED;
    }
  }

  async startAttempt(session: AgentSession, input: CreateExecutionAttemptInput): Promise<ExecutionAttempt> {
    const attemptIndex = this.nextAttemptIndex(session.id);
    const attempt = this.attempts.create(session.id, {
      ...input,
      attemptIndex,
    });
    this.events.log(EVENT_EXECUTION_ATTEMPT_STARTED, {
      projectId: null,
      objectiveId: session.objectiveId,
      sessionId: session.id,
      payload: {
        attemptId: attempt.id,
        attemptIndex: attempt.attemptIndex,
        runtimeType: attempt.runtimeType,
        runtimeName: attempt.runtimeName,
        providerName: attempt.providerName,
        modelName: attempt.modelName,
        processReference: attempt.processReference,
      },
    });
    return attempt;
  }

  recordProgress(attempt: ExecutionAttempt, type: 'progress' | 'heartbeat', payload: Record<string, unknown>): void {
    this.events.log(type === 'heartbeat' ? EVENT_EXECUTION_ATTEMPT_HEARTBEAT : EVENT_EXECUTION_ATTEMPT_PROGRESS, {
      category: 'AGENT', objectiveId: null, sessionId: attempt.sessionId,
      payload: { attemptId: attempt.id, ...payload },
    });
  }

  /** Decides the next attempt without mutating session/objective state. */
  retryPlan(sessionId: string, currentRuntime: string, failedAttempt: ExecutionAttempt): RetryPlan | null {
    if (!['CONNECTIVITY_ERROR', 'AGENT_CONTROL_ERROR'].includes(failedAttempt.errorClass ?? '')) return null;
    const attempts = this.attempts.listBySession(sessionId);
    const retryCount = attempts.filter((attempt) => attempt.runtimeName === failedAttempt.runtimeName).length - 1;
    if (retryCount < this.policy.retryMax) return { runtime: currentRuntime, delayMs: this.policy.retryBackoffMs * (retryCount + 1), fallbackOfAttemptId: null };
    if (this.policy.fallbackRuntime && this.policy.fallbackRuntime !== currentRuntime) {
      this.events.log(EVENT_EXECUTION_ATTEMPT_FALLBACK, { category: 'TECHNICAL', sessionId, payload: { fromAttemptId: failedAttempt.id, fromRuntime: currentRuntime, toRuntime: this.policy.fallbackRuntime } });
      return { runtime: this.policy.fallbackRuntime, delayMs: this.policy.retryBackoffMs, fallbackOfAttemptId: failedAttempt.id };
    }
    return null;
  }
  totals(sessionId: string): UsageTotals {
    return this.attempts.listBySession(sessionId).reduce<UsageTotals>((sum, attempt) => ({ inputTokens: sum.inputTokens + (attempt.inputTokens ?? 0), outputTokens: sum.outputTokens + (attempt.outputTokens ?? 0), totalTokens: sum.totalTokens + (attempt.totalTokens ?? 0), costEstimate: sum.costEstimate + (attempt.costEstimate ?? 0), costActual: sum.costActual + (attempt.costActual ?? 0) }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, costEstimate: 0, costActual: 0 });
  }
  exceedsBudget(sessionId: string, pendingCost: number | null | undefined): boolean {
    if (this.policy.costBudget === null || this.policy.costBudget === undefined) return false;
    const total = this.totals(sessionId).costActual + (pendingCost ?? 0);
    if (total <= this.policy.costBudget) return false;
    this.events.log(EVENT_EXECUTION_BUDGET_EXCEEDED, { category: 'TECHNICAL', sessionId, payload: { budget: this.policy.costBudget, costActual: total } });
    return true;
  }

  async finalizeLatestAttempt(sessionId: string, input: UpdateExecutionAttemptInput): Promise<ExecutionAttempt> {
    const attempts = this.attempts.listBySession(sessionId);
    if (attempts.length === 0) {
      throw new Error(`Nessun ExecutionAttempt trovato per sessione: ${sessionId}`);
    }
    const latest = attempts[attempts.length - 1];
    const updated = this.attempts.update(latest.id, input);
    if (!updated) {
      throw new Error(`ExecutionAttempt non trovato: ${latest.id}`);
    }
    this.events.log(this.statusEventType(updated.status), {
      projectId: null,
      objectiveId: null,
      sessionId: updated.sessionId,
      payload: {
        attemptId: updated.id,
        status: updated.status,
        durationMs: updated.durationMs,
        exitCode: updated.exitCode,
        reason: updated.reason,
        errorClass: updated.errorClass,
      },
    });
    return updated;
  }

  async completeAttempt(attemptId: string, input: UpdateExecutionAttemptInput): Promise<ExecutionAttempt> {
    const updated = this.attempts.update(attemptId, { ...input, status: 'COMPLETED' });
    if (!updated) {
      throw new Error(`ExecutionAttempt non trovato: ${attemptId}`);
    }
    this.events.log(EVENT_EXECUTION_ATTEMPT_COMPLETED, {
      projectId: null,
      objectiveId: null,
      sessionId: updated.sessionId,
      payload: {
        attemptId: updated.id,
        status: updated.status,
        durationMs: updated.durationMs,
        exitCode: updated.exitCode,
        reason: updated.reason,
        errorClass: updated.errorClass,
      },
    });
    return updated;
  }

  async failAttempt(attemptId: string, input: UpdateExecutionAttemptInput): Promise<ExecutionAttempt> {
    const updated = this.attempts.update(attemptId, { ...input, status: 'FAILED' });
    if (!updated) {
      throw new Error(`ExecutionAttempt non trovato: ${attemptId}`);
    }
    this.events.log(EVENT_EXECUTION_ATTEMPT_FAILED, {
      projectId: null,
      objectiveId: null,
      sessionId: updated.sessionId,
      payload: {
        attemptId: updated.id,
        status: updated.status,
        durationMs: updated.durationMs,
        exitCode: updated.exitCode,
        reason: updated.reason,
        errorClass: updated.errorClass,
      },
    });
    return updated;
  }

  async cancelAttempt(attemptId: string, input: UpdateExecutionAttemptInput): Promise<ExecutionAttempt> {
    const updated = this.attempts.update(attemptId, { ...input, status: 'CANCELLED' });
    if (!updated) {
      throw new Error(`ExecutionAttempt non trovato: ${attemptId}`);
    }
    this.events.log(EVENT_EXECUTION_ATTEMPT_CANCELLED, {
      projectId: null,
      objectiveId: null,
      sessionId: updated.sessionId,
      payload: {
        attemptId: updated.id,
        status: updated.status,
        reason: updated.reason,
      },
    });
    return updated;
  }
}
