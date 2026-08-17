import type { ObjectiveRepository, SessionRepository } from '../infrastructure/db/objective-repo.js';
import type { ProjectService } from './project-service.js';
import type { EventService } from './event-service.js';
import type { NotificationService } from './notification-service.js';
import type { CheckpointService } from './checkpoint-service.js';
import type { ProcessSupervisor } from './process-supervisor.js';
import type { PersistentRetryWorker } from './persistent-retry-worker.js';
import type { ExecutionProviderRegistry } from '../integrations/execution-provider.js';

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
    private readonly providers: ExecutionProviderRegistry,
    private readonly checkpoints: CheckpointService,
    private readonly supervisor: ProcessSupervisor,
    private readonly retryWorker: PersistentRetryWorker,
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
        const provider = this.providers.get(session.agentType);
        if (provider?.isProcessAlive?.(session.processReference ?? '')) {
          this.sessions.touchHeartbeat(session.id);
          this.sessions.touchActivity(session.id);
          this.events.log('session.reattached', { category: 'TECHNICAL', sessionId: session.id, payload: { processReference: session.processReference, source: 'stale-detector' } });
          continue;
        }
        const objective = this.objectives.getById(session.objectiveId);
        if (!objective) continue;

        // Processo morto: tenta il recovery automatico (retry/fallback) prima
        // di richiedere intervento umano (§ prodotto).
        let failed;
        try {
          failed = await this.supervisor.finalizeLatestAttempt(session.id, {
            endedAt: new Date().toISOString(),
            status: 'FAILED',
            reason: 'Heartbeat scaduto',
            errorClass: 'AGENT_CONTROL_ERROR',
            metadata: { source: 'stale-detector' },
          });
        } catch {
          failed = null;
        }

        if (failed) {
          const plan = this.supervisor.retryPlan(session.id, session.agentType, failed);
          if (plan) {
            this.retryWorker.schedule(session.id, plan.runtime, plan.fallbackOfAttemptId, plan.delayMs);
            this.sessions.touchHeartbeat(session.id);
            this.sessions.touchActivity(session.id);
            this.events.log('session.stale-retry', {
              category: 'TECHNICAL', projectId: objective.projectId, objectiveId: objective.id,
              sessionId: session.id, payload: { runtime: plan.runtime, delayMs: plan.delayMs },
            });
            continue;
          }
        }

        // Automazione non può proseguire: errore + checkpoint (intervento umano).
        const updated = this.sessions.terminate(session.id, 'STALE', 'Heartbeat scaduto');
        if (!updated) continue;
        this.objectives.setStatus(objective.id, 'ERRORE');
        this.projects.setStatus(objective.projectId, { status: 'ERRORE' });
        const checkpoint = this.checkpoints.create({
          outcome: 'ERROR',
          projectId: objective.projectId,
          objective,
          session: updated,
          gitEnd: null,
          agent: {},
          technicalDetails: 'Heartbeat scaduto',
          defaults: {
            summary: `La sessione agente è stata marcata inattiva (nessun heartbeat recente) per «${objective.title}».`,
            recommendedAction: "Riprova l'esecuzione oppure annulla l'obiettivo.",
          },
        });
        this.notifications.notifyCheckpointDecisionRequired({ ...checkpoint, summary: checkpoint.summary });
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
    private readonly providers: ExecutionProviderRegistry,
    private readonly checkpoints: CheckpointService,
    private readonly supervisor: ProcessSupervisor,
    private readonly retryWorker: PersistentRetryWorker,
  ) {}

  async recover(): Promise<{ staleSessions: number; interruptedSessions: number; retriedSessions: number }> {
    let staleSessions = 0;
    let interruptedSessions = 0;
    let retriedSessions = 0;
    for (const session of this.sessions.listAll()) {
      if (session.status !== 'ATTIVA') continue;
      const objective = this.objectives.getById(session.objectiveId);
      if (!objective) continue;
      const provider = this.providers.get(session.agentType);
      if (provider?.isProcessAlive?.(session.processReference ?? '')) {
        this.sessions.touchHeartbeat(session.id);
        this.sessions.touchActivity(session.id);
        this.events.log('session.reattached', {
          category: 'TECHNICAL', projectId: objective.projectId, objectiveId: objective.id,
          sessionId: session.id, payload: { processReference: session.processReference, source: 'startup-recovery' },
        });
        continue;
      }

      // Processo morto: tenta il recovery automatico (retry/fallback) prima di
      // richiedere intervento umano, come per lo StaleSessionDetector (§ prodotto).
      // L'obiettivo incompleto non deve restare fuori dalla coda: se esiste un
      // retry ammesso dalla policy la sessione resta ATTIVA e riprende il flusso.
      let failed;
      try {
        failed = await this.supervisor.finalizeLatestAttempt(session.id, {
          endedAt: new Date().toISOString(),
          status: 'FAILED',
          reason: 'Sessione recuperata dopo il riavvio del Control Plane',
          errorClass: 'AGENT_CONTROL_ERROR',
          metadata: { source: 'startup-recovery' },
        });
      } catch {
        failed = null;
      }

      if (failed) {
        const plan = this.supervisor.retryPlan(session.id, session.agentType, failed);
        if (plan) {
          this.retryWorker.schedule(session.id, plan.runtime, plan.fallbackOfAttemptId, plan.delayMs);
          this.sessions.touchHeartbeat(session.id);
          this.sessions.touchActivity(session.id);
          retriedSessions += 1;
          this.events.log('session.stale-retry', {
            category: 'TECHNICAL', projectId: objective.projectId, objectiveId: objective.id,
            sessionId: session.id, payload: { runtime: plan.runtime, delayMs: plan.delayMs, source: 'startup-recovery' },
          });
          continue;
        }
      }

      // Automazione non può proseguire: STALE + ERRORE + checkpoint (intervento umano).
      const status = 'STALE' as const;
      const reason = 'Sessione recuperata dopo il riavvio del Control Plane';
      const updated = this.sessions.terminate(session.id, status, reason);
      if (!updated) continue;
      this.objectives.setStatus(objective.id, 'ERRORE');
      this.projects.setStatus(objective.projectId, { status: 'ERRORE' });
      staleSessions += 1;
      const checkpoint = this.checkpoints.create({
        outcome: 'ERROR',
        projectId: objective.projectId,
        objective,
        session: updated,
        gitEnd: null,
        agent: {},
        technicalDetails: reason,
        defaults: {
          summary: `La sessione agente è stata marcata inattiva (STALE) dopo il riavvio del Control Plane per «${objective.title}».`,
          recommendedAction: "Riprova l'esecuzione oppure annulla l'obiettivo.",
        },
      });
      this.notifications.notifyCheckpointDecisionRequired({ ...checkpoint, summary: checkpoint.summary });
      this.notifications.notifySessionStale({ ...updated, projectId: objective.projectId });
      this.notifications.notifyObjectiveFailed({
        id: objective.id, projectId: objective.projectId, title: objective.title,
        errorClass: 'AGENT_CONTROL_ERROR',
      });
      this.events.log('session.recovered_after_restart', {
        category: 'TECHNICAL', projectId: objective.projectId, objectiveId: objective.id,
        sessionId: session.id, payload: { previousStatus: session.status, recoveredStatus: status },
      });
    }
    if (staleSessions || interruptedSessions) {
      this.notifications.notifySystemStartupRecovery({ staleSessions, interruptedSessions });
    }
    return { staleSessions, interruptedSessions, retriedSessions };
  }
}
