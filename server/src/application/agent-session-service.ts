import { z } from 'zod';
import type { AgentAdapter } from '../integrations/agent-adapter.js';
import type { AgentSession, Objective } from '../domain/objective.js';
import { stopSessionSchema } from '../domain/objective.js';
import type { EventService } from './event-service.js';
import type { GitStatusService } from './git-status-service.js';
import type { ProjectService } from './project-service.js';
import type {
  ObjectiveRepository,
  SessionRepository,
} from '../infrastructure/db/objective-repo.js';
import type { Project } from '../domain/project.js';

export const EVENT_SESSION_STARTED = 'session.started';
export const EVENT_SESSION_STOPPED = 'session.stopped';
export const EVENT_SESSION_COMPLETED = 'session.completed';
export const EVENT_SESSION_FAILED = 'session.failed';

/** La transizione richiesta non è compatibile con lo stato corrente. */
export class SessionStateError extends Error {}

const completeSessionSchema = z.object({
  report: z
    .string()
    .trim()
    .min(1, 'Report non valido')
    .max(10000, 'Report troppo lungo (massimo 10000 caratteri)')
    .optional(),
});

const failSessionSchema = z.object({
  error: z
    .string()
    .trim()
    .min(1, 'Errore non valido')
    .max(1000, 'Dettaglio troppo lungo (massimo 1000 caratteri)')
    .optional(),
});

export interface SessionTransition {
  objective: Objective;
  session: AgentSession;
  project: Project | null;
}

/**
 * Ciclo di vita delle sessioni agente (§5 e §4): avvio con delega
 * all'adapter, stop controllato che porta l'obiettivo a
 * RICHIEDE_ATTENZIONE, completamento con report e snapshot Git finale,
 * gestione errori. Lo stato ufficiale del progetto segue l'obiettivo
 * tramite objectiveStatusToProjectStatus (§5).
 */
export class AgentSessionService {
  constructor(
    private readonly objectives: ObjectiveRepository,
    private readonly sessions: SessionRepository,
    private readonly projects: ProjectService,
    private readonly gitStatus: GitStatusService,
    private readonly events: EventService,
    private readonly agent: AgentAdapter,
  ) {}

  /** Avvia la sessione (IN_AVVIO → ATTIVA) e porta obiettivo e progetto IN_LAVORAZIONE. */
  async start(objectiveId: string, sessionId: string): Promise<SessionTransition> {
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    const session = this.sessions.getById(sessionId);
    if (!session || session.objectiveId !== objectiveId) {
      throw new SessionStateError('Sessione non trovata per questo obiettivo');
    }
    if (session.status !== 'IN_AVVIO') {
      throw new SessionStateError('La sessione non è in attesa di avvio');
    }
    if (objective.status !== 'IN_AVVIO') {
      throw new SessionStateError("L'obiettivo non è in attesa di avvio");
    }

    const project = this.projects.getById(objective.projectId);
    const handle = await this.agent.startSession({
      objectiveId: objective.id,
      projectPath: project?.repositoryPath ?? null,
      objectiveText: objective.objectiveText,
      stopCondition: objective.stopCondition,
    });

    this.sessions.setProcessReference(sessionId, handle.sessionRef);
    this.sessions.setStatus(sessionId, 'ATTIVA');
    this.sessions.touchActivity(sessionId);
    this.objectives.markActive(objectiveId, 'IN_LAVORAZIONE', new Date().toISOString());
    this.projects.setStatus(objective.projectId, { status: 'IN_LAVORAZIONE' });

    this.events.log(EVENT_SESSION_STARTED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId,
      payload: {
        agentType: handle.agentType,
        sessionRef: handle.sessionRef,
      },
    });

    return this.transition(objectiveId, sessionId);
  }

  /**
   * Stop controllato (§4): l'agente ha raggiunto la condizione di stop o
   * l'operatore ferma la sessione. La sessione termina INTERROTTA e
   * l'obiettivo passa RICHIEDE_ATTENZIONE (serve una decisione umana).
   */
  async stop(
    objectiveId: string,
    sessionId: string,
    input: unknown = {},
  ): Promise<SessionTransition> {
    const parsed = stopSessionSchema.parse(input);
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    const session = this.sessions.getById(sessionId);
    if (!session || session.objectiveId !== objectiveId) {
      throw new SessionStateError('Sessione non trovata per questo obiettivo');
    }
    if (session.status !== 'ATTIVA') {
      throw new SessionStateError('La sessione non è attiva');
    }

    await this.agent.stopSession(session.processReference ?? sessionId, parsed.reason ?? undefined);

    this.sessions.terminate(sessionId, 'INTERROTTA', parsed.reason ?? null);
    this.objectives.setStatus(objectiveId, 'RICHIEDE_ATTENZIONE');
    this.projects.setStatus(objective.projectId, { status: 'RICHIEDE_ATTENZIONE' });

    this.events.log(EVENT_SESSION_STOPPED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId,
      payload: { reason: parsed.reason ?? null },
    });

    return this.transition(objectiveId, sessionId);
  }

  /** Completa l'obiettivo: sessione COMPLETATA, obiettivo COMPLETATO con report e snapshot finale. */
  async complete(objectiveId: string, input: unknown = {}): Promise<SessionTransition> {
    const parsed = completeSessionSchema.parse(input);
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    const session = this.currentSession(objectiveId);
    if (!session) throw new SessionStateError('Nessuna sessione attiva da completare');

    const gitEnd = await this.gitStatus.readSnapshot(objective.projectId);
    const report = parsed.report ?? 'Obiettivo completato';

    this.sessions.terminate(session.id, 'COMPLETATA', null);
    this.objectives.complete(objectiveId, report, gitEnd);
    this.projects.setStatus(objective.projectId, { status: 'COMPLETATO' });

    this.events.log(EVENT_SESSION_COMPLETED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId: session.id,
      payload: { hasGitEnd: gitEnd !== null },
    });

    return this.transition(objectiveId, session.id);
  }

  /** Segna l'obiettivo in errore: sessione ERRORE, obiettivo ERRORE, progetto ERRORE. */
  async fail(objectiveId: string, input: unknown = {}): Promise<SessionTransition> {
    const parsed = failSessionSchema.parse(input);
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    const session = this.currentSession(objectiveId);
    if (!session) throw new SessionStateError('Nessuna sessione attiva da segnalare in errore');

    const detail = parsed.error ?? "Errore segnalato dall'operatore";

    this.sessions.terminate(session.id, 'ERRORE', detail);
    this.objectives.setStatus(objectiveId, 'ERRORE');
    this.projects.setStatus(objective.projectId, { status: 'ERRORE' });

    this.events.log(EVENT_SESSION_FAILED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId: session.id,
      payload: { error: detail },
    });

    return this.transition(objectiveId, session.id);
  }

  /** La sessione ancora aperta più recente dell'obiettivo, se esiste. */
  private currentSession(objectiveId: string): AgentSession | null {
    const sessions = this.sessions.listByObjective(objectiveId);
    for (let i = sessions.length - 1; i >= 0; i -= 1) {
      const session = sessions[i];
      if (session.status === 'IN_AVVIO' || session.status === 'ATTIVA') {
        return session;
      }
    }
    return null;
  }

  private transition(objectiveId: string, sessionId: string): SessionTransition {
    const objective = this.objectives.getById(objectiveId);
    const session = this.sessions.getById(sessionId);
    return {
      objective: objective!,
      session: session!,
      project: objective ? this.projects.getById(objective.projectId) : null,
    };
  }
}

