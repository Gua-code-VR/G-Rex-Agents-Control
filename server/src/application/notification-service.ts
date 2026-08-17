import type { EventService } from './event-service.js';
import type { ErrorClass } from '../domain/objective.js';

/** Livelli di severità per le notifiche. */
export type NotificationSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Tipi di notifica (M8). */
export const NOTIFICATION_TYPES = [
  'SESSION_STALE',
  'SESSION_ENDED_ERROR',
  'SESSION_ENDED_INTERRUPTED',
  'CHECKPOINT_CREATED',
  'CHECKPOINT_DECISION_REQUIRED',
  'OBJECTIVE_COMPLETED',
  'OBJECTIVE_FAILED',
  'AGENT_RESTART_ATTEMPT',
  'AGENT_RESTART_EXHAUSTED',
  'SYSTEM_STARTUP_RECOVERY',
  'HEARTBEAT_MISSING',
  'BUDGET_POLICY',
  // §19: workspace Git isolate
  'WORKSPACE_BLOCKED',
  'WORKSPACE_INTEGRATION_REQUIRED',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Notifica per l'utente (M8). */
export interface Notification {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  projectId?: string;
  objectiveId?: string;
  sessionId?: string;
  checkpointId?: string;
  errorClass?: ErrorClass;
  metadata?: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

/** Input per creare una notifica. */
export interface CreateNotificationInput {
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  projectId?: string;
  objectiveId?: string;
  sessionId?: string;
  checkpointId?: string;
  errorClass?: ErrorClass;
  metadata?: Record<string, unknown>;
}

/** Repository per le notifiche. */
export interface NotificationRepository {
  create(input: CreateNotificationInput): Notification;
  listUnread(limit?: number): Notification[];
  markAsRead(id: string): Notification | null;
  markAllAsRead(): number;
  getById(id: string): Notification | null;
}

/** Servizio notifiche (M8): centralizza la creazione e gestione notifiche. */
export class NotificationService {
  constructor(
    private readonly notificationRepo: NotificationRepository,
    private readonly eventService: EventService,
  ) {}

  /** Crea una notifica e la persiste come evento. */
  notify(input: CreateNotificationInput): Notification {
    const notification = this.notificationRepo.create(input);
    
    // Persisti come evento per audit trail
    this.eventService.log(`NOTIFICATION_${input.type}`, {
      category: 'USER',
      projectId: input.projectId ?? null,
      objectiveId: input.objectiveId ?? null,
      sessionId: input.sessionId ?? null,
      payload: {
        notificationId: notification.id,
        ...input,
      },
    });
    
    return notification;
  }

  /** Notifica per sessione STALE. */
  notifySessionStale(session: { id: string; objectiveId: string; projectId: string; agentType: string }): Notification {
    return this.notify({
      type: 'SESSION_STALE',
      severity: 'warning',
      title: 'Sessione agente inattiva',
      message: `La sessione ${session.id.slice(0, 8)} (${session.agentType}) non invia heartbeat da troppo tempo.`,
      projectId: session.projectId,
      objectiveId: session.objectiveId,
      sessionId: session.id,
      metadata: { agentType: session.agentType },
    });
  }

  /** Notifica per sessione terminata con errore. */
  notifySessionError(session: { id: string; objectiveId: string; projectId: string; agentType: string; exitReason: string | null; errorClass: ErrorClass }): Notification {
    const isRecoverable = session.errorClass === 'CONNECTIVITY_ERROR' || session.errorClass === 'AGENT_CONTROL_ERROR';
    return this.notify({
      type: 'SESSION_ENDED_ERROR',
      severity: isRecoverable ? 'warning' : 'error',
      title: isRecoverable ? 'Sessione terminata (recuperabile)' : 'Sessione terminata con errore',
      message: `Sessione ${session.id.slice(0, 8)} (${session.agentType}) terminata: ${session.exitReason ?? 'errore sconosciuto'}. ${isRecoverable ? 'Tentativo di riavvio automatico...' : 'Intervento umano richiesto.'}`,
      projectId: session.projectId,
      objectiveId: session.objectiveId,
      sessionId: session.id,
      errorClass: session.errorClass,
      metadata: { agentType: session.agentType, recoverable: isRecoverable },
    });
  }

  /** Notifica per sessione interrotta dall'utente. */
  notifySessionInterrupted(session: { id: string; objectiveId: string; projectId: string; agentType: string; exitReason: string | null }): Notification {
    return this.notify({
      type: 'SESSION_ENDED_INTERRUPTED',
      severity: 'info',
      title: 'Sessione interrotta',
      message: `Sessione ${session.id.slice(0, 8)} (${session.agentType}) interrotta dall'operatore.`,
      projectId: session.projectId,
      objectiveId: session.objectiveId,
      sessionId: session.id,
      metadata: { agentType: session.agentType },
    });
  }

  /** Notifica per checkpoint creato. */
  notifyCheckpointCreated(checkpoint: { id: string; projectId: string; objectiveId: string; sessionId: string | null; summary: string }): Notification {
    return this.notify({
      type: 'CHECKPOINT_CREATED',
      severity: 'info',
      title: 'Nuovo checkpoint',
      message: `Checkpoint creato: ${checkpoint.summary}`,
      projectId: checkpoint.projectId,
      objectiveId: checkpoint.objectiveId,
      sessionId: checkpoint.sessionId ?? undefined,
      checkpointId: checkpoint.id,
      metadata: {},
    });
  }

  /** Notifica per checkpoint che richiede decisione. */
  notifyCheckpointDecisionRequired(checkpoint: { id: string; projectId: string; objectiveId: string; sessionId: string | null; summary: string }): Notification {
    return this.notify({
      type: 'CHECKPOINT_DECISION_REQUIRED',
      severity: 'warning',
      title: 'Decisione richiesta',
      message: `Il checkpoint "${checkpoint.summary}" richiede la tua decisione per procedere.`,
      projectId: checkpoint.projectId,
      objectiveId: checkpoint.objectiveId,
      sessionId: checkpoint.sessionId ?? undefined,
      checkpointId: checkpoint.id,
      metadata: {},
    });
  }

  /** Notifica per obiettivo completato. */
  notifyObjectiveCompleted(objective: { id: string; projectId: string; title: string }): Notification {
    return this.notify({
      type: 'OBJECTIVE_COMPLETED',
      severity: 'info',
      title: 'Obiettivo completato',
      message: `L'obiettivo "${objective.title}" è stato completato con successo.`,
      projectId: objective.projectId,
      objectiveId: objective.id,
      metadata: {},
    });
  }

  /** Notifica per obiettivo fallito. */
  notifyObjectiveFailed(objective: { id: string; projectId: string; title: string; errorClass: ErrorClass }): Notification {
    return this.notify({
      type: 'OBJECTIVE_FAILED',
      severity: 'error',
      title: 'Obiettivo fallito',
      message: `L'obiettivo "${objective.title}" è fallito (${objective.errorClass}). Intervento umano richiesto.`,
      projectId: objective.projectId,
      objectiveId: objective.id,
      errorClass: objective.errorClass,
      metadata: {},
    });
  }

  /** Notifica per tentativo di riavvio agente. */
  notifyAgentRestartAttempt(session: { id: string; objectiveId: string; projectId: string; agentType: string; attempt: number; maxAttempts: number }): Notification {
    return this.notify({
      type: 'AGENT_RESTART_ATTEMPT',
      severity: 'info',
      title: 'Riavvio agente in corso',
      message: `Tentativo ${session.attempt}/${session.maxAttempts} di riavvio per sessione ${session.id.slice(0, 8)} (${session.agentType}).`,
      projectId: session.projectId,
      objectiveId: session.objectiveId,
      sessionId: session.id,
      metadata: { agentType: session.agentType, attempt: session.attempt, maxAttempts: session.maxAttempts },
    });
  }

  /** Notifica per tentativi di riavvio esauriti. */
  notifyAgentRestartExhausted(session: { id: string; objectiveId: string; projectId: string; agentType: string; maxAttempts: number }): Notification {
    return this.notify({
      type: 'AGENT_RESTART_EXHAUSTED',
      severity: 'critical',
      title: 'Riavvii agente esauriti',
      message: `Tutti i ${session.maxAttempts} tentativi di riavvio per sessione ${session.id.slice(0, 8)} (${session.agentType}) sono falliti. Intervento umano richiesto.`,
      projectId: session.projectId,
      objectiveId: session.objectiveId,
      sessionId: session.id,
      errorClass: 'AGENT_ERROR',
      metadata: { agentType: session.agentType, maxAttempts: session.maxAttempts },
    });
  }

  /** Notifica per recovery all'avvio del sistema. */
  notifySystemStartupRecovery(recovered: { staleSessions: number; interruptedSessions: number }): Notification {
    return this.notify({
      type: 'SYSTEM_STARTUP_RECOVERY',
      severity: 'info',
      title: 'Ripristino all\'avvio completato',
      message: `Sistema riavviato: ${recovered.staleSessions} sessioni STALE marcate, ${recovered.interruptedSessions} sessioni INTERROTTE ripristinate.`,
      metadata: recovered,
    });
  }

  /** Notifica per heartbeat mancante (early warning). */
  notifyHeartbeatMissing(session: { id: string; objectiveId: string; projectId: string; agentType: string; missedCount: number }): Notification {
    return this.notify({
      type: 'HEARTBEAT_MISSING',
      severity: 'warning',
      title: 'Heartbeat mancante',
      message: `Sessione ${session.id.slice(0, 8)} (${session.agentType}): ${session.missedCount} heartbeat consecutivi mancanti.`,
      projectId: session.projectId,
      objectiveId: session.objectiveId,
      sessionId: session.id,
      metadata: { agentType: session.agentType, missedCount: session.missedCount },
    });
  }

  /** Lista notifiche non lette. */
  getUnreadNotifications(limit = 50): Notification[] {
    return this.notificationRepo.listUnread(limit);
  }

  /** Segna notifica come letta. */
  markAsRead(id: string): Notification | null {
    return this.notificationRepo.markAsRead(id);
  }

  /** Segna tutte le notifiche come lette. */
  markAllAsRead(): number {
    return this.notificationRepo.markAllAsRead();
  }
}
