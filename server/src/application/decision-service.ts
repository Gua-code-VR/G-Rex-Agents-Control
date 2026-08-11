import type {
  DecisionType,
  DecideCheckpointInput,
  HumanDecision,
} from '../domain/decision.js';
import { decideCheckpointSchema, OBJECTIVE_EFFECTS, PROJECT_EFFECTS } from '../domain/decision.js';
import type { Objective, ObjectiveStatus } from '../domain/objective.js';
import type { Project } from '../domain/project.js';
import type { Checkpoint } from '../domain/checkpoint.js';
import type { EventService } from './event-service.js';
import type { ProjectService } from './project-service.js';
import type { CheckpointRepository } from '../infrastructure/db/checkpoint-repo.js';
import type { DecisionRepository } from '../infrastructure/db/decision-repo.js';
import type { ObjectiveRepository, SessionRepository } from '../infrastructure/db/objective-repo.js';

export const EVENT_DECISION_MADE = 'decision.made';

/** Lo checkpoint richiesto non esiste o non è in stato PENDING_DECISION. */
export class DecisionStateError extends Error {}

/** L'obiettivo associato al checkpoint è già in stato terminale. */
export class DecisionTerminalError extends Error {}

export interface DecisionResult {
  checkpoint: Checkpoint;
  decision: HumanDecision;
  objective: Objective;
  project: Project | null;
}

/**
 * Servizio applicativo per le decisioni umane sui checkpoint (§12-M5).
 *
 * Valida l'input, verifica lo stato del checkpoint e dell'obiettivo,
 * applica gli effetti deterministici (M5-INV3) e registra la
 * HumanDecision come record append-only.
 */
export class DecisionService {
  constructor(
    private readonly decisions: DecisionRepository,
    private readonly checkpoints: CheckpointRepository,
    private readonly objectives: ObjectiveRepository,
    private readonly sessions: SessionRepository,
    private readonly projects: ProjectService,
    private readonly events: EventService,
  ) {}

  decide(checkpointId: string, input: unknown): DecisionResult {
    const parsed = decideCheckpointSchema.parse(input) as DecideCheckpointInput;

    const checkpoint = this.checkpoints.getById(checkpointId);
    if (!checkpoint) {
      throw new DecisionStateError('Checkpoint non trovato');
    }
    if (checkpoint.status !== 'PENDING_DECISION') {
      throw new DecisionStateError(
        `Checkpoint già deciso (${checkpoint.status}). Ogni decisione è irreversibile (M5-INV1).`,
      );
    }

    const objective = this.objectives.getById(checkpoint.objectiveId);
    if (!objective) {
      throw new DecisionStateError('Obiettivo associato non trovato');
    }
    if (objective.status === 'COMPLETATO' || objective.status === 'ANNULLATO' || objective.status === 'ERRORE') {
      throw new DecisionTerminalError(
        `L'obiettivo è già in stato terminale (${objective.status}). Impossibile decidere.`,
      );
    }

    const now = new Date().toISOString();
    this.checkpoints.decide(checkpointId, parsed.decisionType, now);

    const decision = this.decisions.create(checkpointId, parsed.decisionType, parsed.note ?? null);

    const updatedObjective = this.applyObjectiveEffect(objective, parsed.decisionType);
    const updatedProject = this.applyProjectEffect(objective.projectId, parsed.decisionType);

    this.events.log(EVENT_DECISION_MADE, {
      projectId: objective.projectId,
      objectiveId: objective.id,
      payload: {
        checkpointId,
        decisionId: decision.id,
        decisionType: parsed.decisionType,
        note: parsed.note ?? null,
        objectiveStatus: updatedObjective.status,
        projectStatus: updatedProject?.status ?? null,
      },
    });

    const updatedCheckpoint = this.checkpoints.getById(checkpointId)!;
    return { checkpoint: updatedCheckpoint, decision, objective: updatedObjective, project: updatedProject };
  }

  private applyObjectiveEffect(objective: Objective, decisionType: DecisionType): Objective {
    const targetStatus: ObjectiveStatus = OBJECTIVE_EFFECTS[decisionType];

    switch (decisionType) {
      case 'APPROVE': {
        this.terminateOpenSessions(objective.id, 'Obiettivo approvato');
        return this.objectives.complete(objective.id)!;
      }
      case 'REQUEST_CHANGES': {
        this.terminateOpenSessions(objective.id, 'Richieste modifiche');
        return this.objectives.setStatus(objective.id, targetStatus)!;
      }
      case 'STOP': {
        this.terminateOpenSessions(objective.id, 'Stop decisionale');
        return this.objectives.setStatus(objective.id, targetStatus)!;
      }
      case 'CANCEL': {
        this.terminateOpenSessions(objective.id, 'Obiettivo annullato');
        this.objectives.setStatus(objective.id, targetStatus);
        this.projects.setCurrentObjective(objective.projectId, null, null);
        return this.objectives.getById(objective.id)!;
      }
    }
  }

  private applyProjectEffect(projectId: string, decisionType: DecisionType): Project | null {
    const targetStatus = PROJECT_EFFECTS[decisionType];
    this.projects.setStatus(projectId, { status: targetStatus });
    return this.projects.getById(projectId);
  }

  private terminateOpenSessions(objectiveId: string, reason: string): void {
    for (const session of this.sessions.listByObjective(objectiveId)) {
      if (session.status === 'IN_AVVIO' || session.status === 'ATTIVA') {
        this.sessions.terminate(session.id, 'INTERROTTA', reason);
      }
    }
  }
}
