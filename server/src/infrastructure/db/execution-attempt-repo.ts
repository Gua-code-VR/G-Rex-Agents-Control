import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  ExecutionAttempt,
  CreateExecutionAttemptInput,
  UpdateExecutionAttemptInput,
  ExecutionAttemptStatus,
} from '../../domain/execution-attempt.js';

interface ExecutionAttemptRow {
  id: string;
  session_id: string;
  attempt_index: number;
  runtime_type: string | null;
  runtime_name: string | null;
  provider_name: string | null;
  model_name: string | null;
  process_reference: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  reason: string | null;
  error_class: string | null;
  fallback_of_attempt_id: string | null;
  input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cost_estimate: number | null; cost_actual: number | null;
  metadata: string | null;
}

function parseMetadata(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toExecutionAttempt(row: ExecutionAttemptRow): ExecutionAttempt {
  return {
    id: row.id,
    sessionId: row.session_id,
    attemptIndex: row.attempt_index,
    runtimeType: row.runtime_type,
    runtimeName: row.runtime_name,
    providerName: row.provider_name,
    modelName: row.model_name,
    processReference: row.process_reference,
    status: row.status as ExecutionAttempt['status'],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    exitCode: row.exit_code,
    reason: row.reason,
    errorClass: row.error_class,
    fallbackOfAttemptId: row.fallback_of_attempt_id,
    inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalTokens: row.total_tokens, costEstimate: row.cost_estimate, costActual: row.cost_actual,
    metadata: parseMetadata(row.metadata),
  };
}

export interface ExecutionAttemptRepository {
  create(sessionId: string, input: CreateExecutionAttemptInput): ExecutionAttempt;
  getById(id: string): ExecutionAttempt | null;
  listBySession(sessionId: string): ExecutionAttempt[];
  update(id: string, input: UpdateExecutionAttemptInput): ExecutionAttempt | null;
}

export class SqliteExecutionAttemptRepository implements ExecutionAttemptRepository {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listBySessionStmt: StatementSync;
  private readonly updateStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      `INSERT INTO execution_attempts
         (id, session_id, attempt_index, runtime_type, runtime_name, provider_name, model_name,
          process_reference, status, started_at, ended_at, duration_ms, exit_code, reason,
          error_class, fallback_of_attempt_id, input_tokens, output_tokens, total_tokens, cost_estimate, cost_actual, metadata)
       VALUES
         (:id, :sessionId, :attemptIndex, :runtimeType, :runtimeName, :providerName, :modelName,
          :processReference, :status, :startedAt, :endedAt, :durationMs, :exitCode, :reason,
          :errorClass, :fallbackOfAttemptId, :inputTokens, :outputTokens, :totalTokens, :costEstimate, :costActual, :metadata)`,
    );
    this.getStmt = db.prepare('SELECT * FROM execution_attempts WHERE id = ?');
    this.listBySessionStmt = db.prepare(
      'SELECT * FROM execution_attempts WHERE session_id = ? ORDER BY attempt_index ASC',
    );
    this.updateStmt = db.prepare(
      `UPDATE execution_attempts
       SET ended_at = :endedAt,
           duration_ms = :durationMs,
           exit_code = :exitCode,
           reason = :reason,
           error_class = :errorClass,
           input_tokens = :inputTokens,
           output_tokens = :outputTokens,
           total_tokens = :totalTokens,
           cost_estimate = :costEstimate,
           cost_actual = :costActual,
           metadata = :metadata,
           status = :status
       WHERE id = :id`,
    );
  }

  create(sessionId: string, input: CreateExecutionAttemptInput): ExecutionAttempt {
    const id = randomUUID();
    const now = new Date().toISOString();
    const attemptIndex = input.attemptIndex ?? 1;
    const runtimeType = input.runtimeType ?? null;
    const runtimeName = input.runtimeName ?? null;
    const providerName = input.providerName ?? null;
    const modelName = input.modelName ?? null;
    const processReference = input.processReference ?? null;
    const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

    this.insertStmt.run({
      id,
      sessionId,
      attemptIndex,
      runtimeType,
      runtimeName,
      providerName,
      modelName,
      processReference,
      status: 'STARTED',
      startedAt: now,
      endedAt: null,
      durationMs: null,
      exitCode: null,
      reason: null,
      errorClass: null,
      fallbackOfAttemptId: input.fallbackOfAttemptId ?? null,
      inputTokens: null, outputTokens: null, totalTokens: null, costEstimate: null, costActual: null,
      metadata,
    });
    return this.getById(id)!;
  }

  getById(id: string): ExecutionAttempt | null {
    const row = this.getStmt.get(id) as ExecutionAttemptRow | undefined;
    return row ? toExecutionAttempt(row) : null;
  }

  listBySession(sessionId: string): ExecutionAttempt[] {
    return (this.listBySessionStmt.all(sessionId) as unknown as ExecutionAttemptRow[]).map(
      toExecutionAttempt,
    );
  }

  update(id: string, input: UpdateExecutionAttemptInput): ExecutionAttempt | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const status: ExecutionAttemptStatus = input.status
      ?? (input.exitCode === 0 ? 'COMPLETED' : 'FAILED');

    this.updateStmt.run({
      id,
      endedAt: input.endedAt,
      durationMs: input.durationMs ?? null,
      exitCode: input.exitCode ?? null,
      reason: input.reason ?? null,
      errorClass: input.errorClass ?? null,
      inputTokens: input.inputTokens ?? null, outputTokens: input.outputTokens ?? null, totalTokens: input.totalTokens ?? null, costEstimate: input.costEstimate ?? null, costActual: input.costActual ?? null,
      status,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    });
    return this.getById(id);
  }
}
