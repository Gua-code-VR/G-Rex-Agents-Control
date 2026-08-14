import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { RetryJob, RetryJobStatus } from '../../domain/retry-job.js';

interface Row { id: string; session_id: string; runtime_id: string; fallback_of_attempt_id: string | null; due_at: string; status: RetryJobStatus; created_at: string; completed_at: string | null; reason: string | null; }
const map = (row: Row): RetryJob => ({ id: row.id, sessionId: row.session_id, runtimeId: row.runtime_id, fallbackOfAttemptId: row.fallback_of_attempt_id, dueAt: row.due_at, status: row.status, createdAt: row.created_at, completedAt: row.completed_at, reason: row.reason });

export interface RetryJobRepository {
  create(sessionId: string, runtimeId: string, fallbackOfAttemptId: string | null, dueAt: string): RetryJob;
  due(now: string): RetryJob[];
  claim(id: string): RetryJob | null;
  finish(id: string, status: 'COMPLETED' | 'CANCELLED', reason?: string | null): RetryJob | null;
  cancelBySession(sessionId: string, reason: string): void;
}

export class SqliteRetryJobRepository implements RetryJobRepository {
  private readonly getStmt: StatementSync;
  constructor(private readonly db: DatabaseSync) { this.getStmt = db.prepare('SELECT * FROM retry_jobs WHERE id=?'); }
  create(sessionId: string, runtimeId: string, fallbackOfAttemptId: string | null, dueAt: string): RetryJob {
    this.db.prepare('UPDATE retry_jobs SET status=\'CANCELLED\', completed_at=?, reason=? WHERE session_id=? AND status IN (\'PENDING\',\'RUNNING\')').run(new Date().toISOString(), 'Sostituito da un nuovo retry', sessionId);
    const id = randomUUID(); const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO retry_jobs (id,session_id,runtime_id,fallback_of_attempt_id,due_at,status,created_at) VALUES (?,?,?,?,?,?,?)').run(id, sessionId, runtimeId, fallbackOfAttemptId, dueAt, 'PENDING', createdAt);
    return this.get(id)!;
  }
  private get(id: string): RetryJob | null { const row = this.getStmt.get(id) as Row | undefined; return row ? map(row) : null; }
  due(now: string): RetryJob[] { return (this.db.prepare("SELECT * FROM retry_jobs WHERE status='PENDING' AND due_at<=? ORDER BY due_at").all(now) as unknown as Row[]).map(map); }
  claim(id: string): RetryJob | null { const changed = this.db.prepare("UPDATE retry_jobs SET status='RUNNING' WHERE id=? AND status='PENDING'").run(id).changes; return changed ? this.get(id) : null; }
  finish(id: string, status: 'COMPLETED' | 'CANCELLED', reason: string | null = null): RetryJob | null { this.db.prepare('UPDATE retry_jobs SET status=?, completed_at=?, reason=? WHERE id=?').run(status, new Date().toISOString(), reason, id); return this.get(id); }
  cancelBySession(sessionId: string, reason: string): void { this.db.prepare("UPDATE retry_jobs SET status='CANCELLED', completed_at=?, reason=? WHERE session_id=? AND status IN ('PENDING','RUNNING')").run(new Date().toISOString(), reason, sessionId); }
}
