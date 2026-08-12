import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  CreateNotificationInput,
  Notification,
  NotificationRepository,
} from '../../application/notification-service.js';

interface NotificationRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  project_id: string | null;
  objective_id: string | null;
  session_id: string | null;
  checkpoint_id: string | null;
  error_class: string | null;
  metadata: string | null;
  created_at: string;
  read_at: string | null;
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: row.type as Notification['type'],
    severity: row.severity as Notification['severity'],
    title: row.title,
    message: row.message,
    projectId: row.project_id ?? undefined,
    objectiveId: row.objective_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    checkpointId: row.checkpoint_id ?? undefined,
    errorClass: (row.error_class as Notification['errorClass']) ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

/** Repository SQLite per le notifiche (M8). */
export class SqliteNotificationRepository implements NotificationRepository {
  private readonly insertStmt: StatementSync;
  private readonly listUnreadStmt: StatementSync;
  private readonly markReadStmt: StatementSync;
  private readonly markAllReadStmt: StatementSync;
  private readonly getByIdStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      `INSERT INTO notifications
         (id, type, severity, title, message, project_id, objective_id, session_id, checkpoint_id, error_class, metadata, created_at)
       VALUES
         (:id, :type, :severity, :title, :message, :projectId, :objectiveId, :sessionId, :checkpointId, :errorClass, :metadata, :createdAt)`,
    );
    this.listUnreadStmt = db.prepare(
      `SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    );
    this.markReadStmt = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?');
    this.markAllReadStmt = db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL');
    this.getByIdStmt = db.prepare('SELECT * FROM notifications WHERE id = ?');
  }

  create(input: CreateNotificationInput): Notification {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.insertStmt.run({
      id,
      type: input.type,
      severity: input.severity,
      title: input.title,
      message: input.message,
      projectId: input.projectId ?? null,
      objectiveId: input.objectiveId ?? null,
      sessionId: input.sessionId ?? null,
      checkpointId: input.checkpointId ?? null,
      errorClass: input.errorClass ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: now,
    });
    return this.getById(id)!;
  }

  listUnread(limit = 50): Notification[] {
    return (this.listUnreadStmt.all(Math.max(1, Math.min(200, limit))) as unknown as NotificationRow[]).map(toNotification);
  }

  markAsRead(id: string): Notification | null {
    const existing = this.getById(id);
    if (!existing) return null;
    this.markReadStmt.run(new Date().toISOString(), id);
    return this.getById(id);
  }

  markAllAsRead(): number {
    const now = new Date().toISOString();
    const result = this.markAllReadStmt.run(now);
    return Number(result.changes);
  }

  getById(id: string): Notification | null {
    const row = this.getByIdStmt.get(id) as NotificationRow | undefined;
    return row ? toNotification(row) : null;
  }
}
