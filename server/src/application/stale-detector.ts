import type { ObjectiveRepository, SessionRepository } from '../infrastructure/db/objective-repo.js';
import type { ProjectService } from './project-service.js';
import type { EventService } from './event-service.js';
import type { NotificationService } from './notification-service.js';

export interface StaleDetectorConfig {
  checkIntervalMs: number;
}

export const DEFAULT_STALE_DETECTOR_CONFIG: StaleDetectorConfig = { checkIntervalMs: 30_000 };

/** Turns a lost agent heartbeat into an explicit, auditable state transition. */
export class StaleSessionDetector {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(
    private readonly sessions: SessionRepository,
    private readonly objectives: ObjectiveRepository,
    private readonly projects: ProjectService,
    private readonly notifications: NotificationService,
    private readonly events: EventService,
    private readonly config: StaleDetectorConfig = DEFAULT_STALE_DETECTOR_CONFIG,
  ) {}

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => { void this.check(); }, this.config.checkIntervalMs);
    void this.check();
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
  }

  async check(): Promise<number> {
    if (this.checking) return 0;
    this.checking = true;
    try {
      const stale = this.sessions.findStaleSessions(new Date().toISOString());
      for (const session of stale) {
        const updated = this.sessions.terminate(session.id, 'STALE', 'Heartbeat scaduto');
        const objective = this.objectives.getById(session.objectiveId);
        if (!updated || !objective) continue;
        this.objectives.setStatus(objective.id, 'ERRORE');
        this.projects.setStatus(objective.projectId, { status: 'ERRORE' });
        this.notifications.notifySessionStale({ ...updated, projectId: objective.projectId });
        this.notifications.notifyObjectiveFailed({
          id: objective.id, projectId: objective.projectId, title: objective.title,
          errorClass: 'AGENT_CONTROL_ERROR',
        });
        this.events.log('session.stale', {
          category: 'TECHNICAL', projectId: objective.projectId,
          objectiveId: objective.id, sessionId: session.id,
          payload: { lastHeartbeatAt: session.lastHeartbeatAt, heartbeatIntervalMs: session.heartbeatIntervalMs },
        });
      }
      return stale.length;
    } finally {
      this.checking = false;
    }
  }
}

/** Reconciles persisted sessions after a process restart; no agent is assumed alive. */
export class StartupRecoveryService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly objectives: ObjectiveRepository,
    private readonly projects: ProjectService,
    private readonly notifications: NotificationService,
    private readonly events: EventService,
  ) {}

  recover(): { staleSessions: number; interruptedSessions: number } {
    let staleSessions = 0;
    let interruptedSessions = 0;
    for (const session of this.sessions.listAll()) {
      if (session.status !== 'ATTIVA' && session.status !== 'IN_AVVIO') continue;
      const objective = this.objectives.getById(session.objectiveId);
      if (!objective) continue;
      const status = session.status === 'ATTIVA' ? 'STALE' : 'INTERROTTA';
      const reason = 'Sessione recuperata dopo il riavvio del Control Plane';
      this.sessions.terminate(session.id, status, reason);
      this.objectives.setStatus(objective.id, 'ERRORE');
      this.projects.setStatus(objective.projectId, { status: 'ERRORE' });
      if (status === 'STALE') staleSessions += 1; else interruptedSessions += 1;
      this.events.log('session.recovered_after_restart', {
        category: 'TECHNICAL', projectId: objective.projectId, objectiveId: objective.id,
        sessionId: session.id, payload: { previousStatus: session.status, recoveredStatus: status },
      });
    }
    if (staleSessions || interruptedSessions) {
      this.notifications.notifySystemStartupRecovery({ staleSessions, interruptedSessions });
    }
    return { staleSessions, interruptedSessions };
  }
}
