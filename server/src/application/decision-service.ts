import type {
  DecisionType,
  DecideCheckpointInput,
  HumanDecision,
} from '../domain/decision.js';
import { decideCheckpointSchema, OBJECTIVE_EFFECTS } from '../domain/decision.js';
import type { Objective, ObjectiveStatus } from '../domain/objective.js';
import { deriveProjectStatus } from '../domain/objective.js';
import type { Project } from '../domain/project.js';
import type { Checkpoint } from '../domain/checkpoint.js';
import type { EventService } from './event-service.js';
import type { ProjectService } from './project-service.js';
import type { CheckpointRepository } from '../infrastructure/db/checkpoint-repo.js';
import type { DecisionRepository } from '../infrastructure/db/decision-repo.js';
import type { ObjectiveRepository, SessionRepository } from '../infrastructure/db/objective-repo.js';
import type { ExecutionProviderRegistry } from '../integrations/execution-provider.js';

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
    private readonly providers: ExecutionProviderRegistry,
  ) {}

  decide(checkpointId: string, input: unknown): DecisionResult {
    const parsed = decideCheckpointSchema.parse(input) as DecideCheckpointInput;
    return this.applyDecision(checkpointId, parsed.decisionType, parsed.note ?? null, { guardActiveSession: true });
  }

  /**
   * Chiude i checkpoint pendenti di un obiettivo come RETRY quando una nuova
   * esecuzione riprende il lavoro (§5.1 V2: retry/recovery non restano
   * azioni umane pendenti). Non tocca lo stato dell'obiettivo/progetto: il
   * checkpoint diventa storico e resta auditabile.
   */
  resolveStalePending(objectiveId: string, note: string): number {
    const now = new Date().toISOString();
    let count = 0;
    for (const checkpoint of this.checkpoints.listByObjective(objectiveId)) {
      if (checkpoint.status !== 'PENDING_DECISION') continue;
      this.checkpoints.decide(checkpoint.id, 'RETRY', now);
      const decision = this.decisions.create(checkpoint.id, 'RETRY', note);
      this.events.log(EVENT_DECISION_MADE, {
        projectId: checkpoint.projectId,
        objectiveId: checkpoint.objectiveId,
        sessionId: checkpoint.sessionId ?? undefined,
        payload: {
          checkpointId: checkpoint.id,
          decisionId: decision.id,
          decisionType: 'RETRY',
          note,
          source: 'automatic-stale-resolution',
          objectiveStatus: this.objectives.getById(checkpoint.objectiveId)?.status ?? null,
        },
      });
      count += 1;
    }
    return count;
  }

  /**
   * Decisione su checkpoint obsoleto in un flusso che termina l'obiettivo
   * (es. annullamento): salta solo la guardia dell'esecuzione attiva, perché
   * l'azione esplicita dell'operatore (Cancella) è l'unica legittimata a
   * chiudere anche un'esecuzione corrente. Mantiene le altre validazioni.
   */
  decideForcefully(checkpointId: string, input: unknown): DecisionResult {
    const parsed = decideCheckpointSchema.parse(input) as DecideCheckpointInput;
    return this.applyDecision(checkpointId, parsed.decisionType, parsed.note ?? null, { guardActiveSession: false });
  }

  private applyDecision(
    checkpointId: string,
    decisionType: DecisionType,
    note: string | null,
    opts: { guardActiveSession: boolean },
  ): DecisionResult {
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
    if (objective.status === 'COMPLETATO' || objective.status === 'ANNULLATO') {
      throw new DecisionTerminalError(
        `L'obiettivo è già in stato terminale (${objective.status}). Impossibile decidere.`,
      );
    }

    // Un checkpoint pendente non deve mai autorizzare l'interruzione di
    // un'esecuzione diversa da quella che lo ha generato.
    if (opts.guardActiveSession) {
      const running = this.sessions.listByObjective(objective.id).filter((s) => s.status === 'ATTIVA' && s.id !== checkpoint.sessionId);
      if (running.length > 0) {
        throw new DecisionStateError(
          "L'obiettivo ha un'esecuzione ancora attiva: il checkpoint appartiene a un tentativo precedente e non è più decidibile. Ferma l'esecuzione corrente oppure annulla l'obiettivo.",
        );
      }
    }

    const now = new Date().toISOString();
    this.checkpoints.decide(checkpointId, decisionType, now);

    const decision = this.decisions.create(checkpointId, decisionType, note);

    const updatedObjective = this.applyObjectiveEffect(objective, checkpoint.sessionId, decisionType);
    const updatedProject = this.applyProjectEffect(objective.projectId);

    this.events.log(EVENT_DECISION_MADE, {
      projectId: objective.projectId,
      objectiveId: objective.id,
      payload: {
        checkpointId,
        decisionId: decision.id,
        decisionType,
        note: note ?? null,
        objectiveStatus: updatedObjective.status,
        projectStatus: updatedProject?.status ?? null,
      },
    });

    const updatedCheckpoint = this.checkpoints.getById(checkpointId)!;
    return { checkpoint: updatedCheckpoint, decision, objective: updatedObjective, project: updatedProject };
  }

  private applyObjectiveEffect(objective: Objective, checkpointSessionId: string | null, decisionType: DecisionType): Objective {
    const targetStatus: ObjectiveStatus = OBJECTIVE_EFFECTS[decisionType];

    switch (decisionType) {
      case 'APPROVE': {
        this.terminateCheckpointSession(objective.id, checkpointSessionId, 'Obiettivo approvato');
        return this.objectives.complete(objective.id)!;
      }
      case 'REQUEST_CHANGES': {
        this.terminateCheckpointSession(objective.id, checkpointSessionId, 'Richieste modifiche');
        return this.objectives.setStatus(objective.id, targetStatus)!;
      }
      case 'STOP': {
        this.terminateCheckpointSession(objective.id, checkpointSessionId, 'Stop decisionale');
        return this.objectives.setStatus(objective.id, targetStatus)!;
      }
      case 'CANCEL': {
        this.terminateCheckpointSession(objective.id, checkpointSessionId, 'Obiettivo annullato');
        this.objectives.setStatus(objective.id, targetStatus);
        // Solo se l'obiettivo annullato è davvero l'obiettivo corrente del
        // progetto: non deve azzerare la relazione di un altro obiettivo.
        const project = this.projects.getById(objective.projectId);
        if (project?.currentObjectiveId === objective.id) {
          this.projects.setCurrentObjective(objective.projectId, null, null);
        }
        return this.objectives.getById(objective.id)!;
      }
      case 'RETRY': {
        this.terminateCheckpointSession(objective.id, checkpointSessionId, 'Riprova avviata');
        return this.objectives.setStatus(objective.id, targetStatus)!;
      }
    }
  }

  private applyProjectEffect(projectId: string): Project | null {
    // §4.2 V2: lo stato del Project è derivato dagli obiettivi reali, mai
    // imposto da una decisione su un checkpoint di un singolo obiettivo.
    const objectives = this.objectives.listByProject(projectId);
    this.projects.setStatus(projectId, { status: deriveProjectStatus(objectives) });
    return this.projects.getById(projectId);
  }

  /** Termina esclusivamente la sessione che ha generato il checkpoint (se
   *  ancora aperta). Non tocca mai altre esecuzioni dell'obiettivo. */
  private terminateCheckpointSession(objectiveId: string, sessionId: string | null, reason: string): void {
    if (!sessionId) return;
    const session = this.sessions.getById(sessionId);
    if (!session || session.objectiveId !== objectiveId) return;
    if (session.status !== 'IN_AVVIO' && session.status !== 'ATTIVA') return;
    if (session.status === 'ATTIVA') {
      const provider = this.providers.get(session.agentType);
      if (provider) void provider.stop(session.processReference ?? session.id).catch(() => undefined);
    }
    this.sessions.terminate(session.id, 'INTERROTTA', reason);
  }
}
