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

export class ProcessSupervisor {
  constructor(
    private readonly attempts: ExecutionAttemptRepository,
    private readonly events: EventService,
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
