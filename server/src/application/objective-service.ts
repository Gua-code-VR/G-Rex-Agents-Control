import type { AgentAdapter } from '../integrations/agent-adapter.js';
import type { AgentSession, CreateObjectiveInput, Objective } from '../domain/objective.js';
import { createObjectiveSchema } from '../domain/objective.js';
import type { EventService } from './event-service.js';
import type { GitStatusService } from './git-status-service.js';
import type { ProjectService } from './project-service.js';
import type {
  ObjectiveRepository,
  SessionRepository,
} from '../infrastructure/db/objective-repo.js';
import type { Project } from '../domain/project.js';

export const EVENT_OBJECTIVE_CREATED = 'objective.created';
export const EVENT_OBJECTIVE_CANCELLED = 'objective.cancelled';

/** Violazione dell'invariante §14: esiste già un obiettivo attivo. */
export class ObjectiveConflictError extends Error {}

/** Lo stato corrente non consente l'operazione richiesta. */
export class ObjectiveStateError extends Error {}

export interface CreatedObjective {
  objective: Objective;
  session: AgentSession;
  project: Project | null;
}

/**
 * Gestione degli Objective (§5 e §14): creazione con sessione iniziale,
 * lettura, lista per progetto e annullamento. La creazione verifica
 * l'invariante «un solo obiettivo attivo per progetto» e cattura lo
 * snapshot Git di inizio lavoro come evidenza (§6-SYSTEM).
 */
export class ObjectiveService {
  constructor(
    private readonly objectives: ObjectiveRepository,
    private readonly sessions: SessionRepository,
    private readonly projects: ProjectService,
    private readonly gitStatus: GitStatusService,
    private readonly events: EventService,
    private readonly agent: AgentAdapter,
  ) {}

  /**
   * Crea un Objective IN_AVVIO e la sua sessione agente iniziale IN_AVVIO.
   * Aggiorna l'obiettivo corrente del progetto e lo stato ufficiale.
   * Fallisce con ObjectiveConflictError se esiste già un obiettivo attivo
   * (§14: nessun nuovo obiettivo finché il precedente non è chiuso).
   */
  async create(projectId: string, input: unknown): Promise<CreatedObjective> {
    const parsed = createObjectiveSchema.parse(input) as CreateObjectiveInput;
    const project = this.projects.getById(projectId);
    if (!project) {
      throw new ObjectiveStateError('Progetto non trovato');
    }
    const active = this.objectives.getActiveByProject(projectId);
    if (active) {
      throw new ObjectiveConflictError(
        `Esiste già un obiettivo attivo («${active.title}»). Chiudilo prima di crearne uno nuovo.`,
      );
    }

    const objective = this.objectives.create(projectId, parsed);
    // Evidenza di inizio lavoro (§6-SYSTEM): snapshot Git non distruttivo.
    const gitStart = await this.gitStatus.readSnapshot(projectId);
    if (gitStart) {
      this.objectives.setGitStart(objective.id, gitStart);
    }

    const session = this.sessions.create(objective.id, this.agent.agentType);

    this.projects.setCurrentObjective(projectId, objective.id, objective.title);
    this.projects.setStatus(projectId, { status: 'IN_AVVIO' });

    this.events.log(EVENT_OBJECTIVE_CREATED, {
      projectId,
      objectiveId: objective.id,
      sessionId: session.id,
      payload: {
        title: objective.title,
        agentType: session.agentType,
        status: objective.status,
      },
    });

    return {
      objective,
      session,
      project: this.projects.getById(projectId),
    };
  }

  listByProject(projectId: string): Objective[] {
    return this.objectives.listByProject(projectId);
  }

  getById(id: string): Objective | null {
    return this.objectives.getById(id);
  }

  /** Dettaglio obiettivo con le sue sessioni (§5). */
  getWithSessions(id: string): { objective: Objective; sessions: AgentSession[] } | null {
    const objective = this.objectives.getById(id);
    if (!objective) return null;
    return { objective, sessions: this.sessions.listByObjective(id) };
  }

  /**
   * Annulla l'obiettivo (ANNULLATO): lo stato del progetto torna FERMO e
   * le eventuali sessioni ancora aperte vengono chiuse come INTERROTTE.
   * D5: rifiuta un obiettivo già COMPLETATO (errore esplicito).
   */
  cancel(id: string): { objective: Objective; project: Project | null } | null {
    const objective = this.objectives.getById(id);
    if (!objective) return null;

    // D5: COMPLETATO è terminale — non si può annullare.
    if (objective.status === 'COMPLETATO') {
      throw new ObjectiveStateError(
        "Impossibile annullare un obiettivo già completato (D5). Crea un nuovo obiettivo se necessario.",
      );
    }

    for (const session of this.sessions.listByObjective(id)) {
      if (session.status === 'IN_AVVIO' || session.status === 'ATTIVA') {
        this.sessions.terminate(session.id, 'INTERROTTA', 'Obiettivo annullato');
      }
    }

    const updated = this.objectives.setStatus(id, 'ANNULLATO');
    this.projects.setCurrentObjective(objective.projectId, null, null);
    this.projects.setStatus(objective.projectId, { status: 'FERMO' });

    this.events.log(EVENT_OBJECTIVE_CANCELLED, {
      projectId: objective.projectId,
      objectiveId: id,
      payload: { title: objective.title },
    });

    return { objective: updated!, project: this.projects.getById(objective.projectId) };
  }
}
