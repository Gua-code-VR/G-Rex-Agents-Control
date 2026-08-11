import { randomUUID } from 'node:crypto';
import type {
  Checkpoint,
  CheckpointAgentInput,
  CheckpointOutcome,
  EvidenceSource,
  GitDelta,
} from '../domain/checkpoint.js';
import { computeGitDelta } from '../domain/checkpoint.js';
import type { AgentSession, Objective } from '../domain/objective.js';
import type { GitStatus } from '../domain/project.js';
import type { CheckpointRepository } from '../infrastructure/db/checkpoint-repo.js';
import type { EventService } from './event-service.js';

export const EVENT_CHECKPOINT_CREATED = 'checkpoint.created';

/** Input di CheckpointService.create: contesto verificato dalla transizione. */
export interface CreateCheckpointParams {
  /** Esito del checkpoint (§12-M4): fine, intervento, blocco, errore. */
  outcome: CheckpointOutcome;
  projectId: string;
  /** Obiettivo già aggiornato dalla transizione (es. con git_end). */
  objective: Objective;
  /** Sessione che ha generato il checkpoint. */
  session: AgentSession | null;
  /** Snapshot Git di fine lavoro (§6-SYSTEM); null senza repository. */
  gitEnd: GitStatus | null;
  /** Dichiarazioni dell'agente (§6-AGENT); facoltative. */
  agent: CheckpointAgentInput;
  /** Testi predefiniti per l'esito, usati quando l'agente non dichiara nulla. */
  defaults: { summary: string; recommendedAction: string };
}

/**
 * Costruzione dei Checkpoint M4 (§5/§6/§12-M4): ogni conclusione,
 * richiesta di intervento, blocco o errore diventa un record persistente
 * che richiede una decisione umana (PENDING_DECISION), con evidenze
 * classificate:
 * - SYSTEM --- verificate da Agent Control (stato sessione, snapshot Git
 *   di inizio/fine, delta Git, exit reason);
 * - AGENT --- dichiarate dall'agente (summary, acceptance status, test,
 *   avvertenze, azione raccomandata, riferimento al rapporto).
 * Il checkpoint è comprensibile senza leggere il log grezzo (§6).
 */
export class CheckpointService {
  constructor(
    private readonly checkpoints: CheckpointRepository,
    private readonly events: EventService,
  ) {}

  create(params: CreateCheckpointParams): Checkpoint {
    const gitDelta = computeGitDelta(params.objective.gitStart, params.gitEnd);
    const evidenceSources: EvidenceSource[] = ['SYSTEM'];
    if (this.hasAgentEvidence(params.agent)) {
      evidenceSources.push('AGENT');
    }

    const checkpoint: Checkpoint = {
      id: randomUUID(),
      projectId: params.projectId,
      objectiveId: params.objective.id,
      sessionId: params.session?.id ?? null,
      outcome: params.outcome,
      status: 'PENDING_DECISION',
      summary: params.agent.summary ?? params.defaults.summary,
      acceptanceStatus: params.agent.acceptanceStatus ?? 'UNVERIFIED',
      evidenceSummary: this.buildEvidenceSummary(params, gitDelta),
      gitDelta,
      testsSummary: params.agent.testsSummary ?? 'Non dichiarati',
      warnings: params.agent.warnings ?? [],
      recommendedAction: params.agent.recommendedAction ?? params.defaults.recommendedAction,
      fullReportReference:
        params.agent.fullReportReference !== undefined
          ? params.agent.fullReportReference
          : params.outcome === 'COMPLETED'
            ? `objective:${params.objective.id}:final_report`
            : null,
      evidenceSources,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decisionType: null,
    };

    const stored = this.checkpoints.create(checkpoint);
    this.events.log(EVENT_CHECKPOINT_CREATED, {
      projectId: stored.projectId,
      objectiveId: stored.objectiveId,
      sessionId: stored.sessionId ?? undefined,
      payload: {
        checkpointId: stored.id,
        outcome: stored.outcome,
        status: stored.status,
      },
    });
    return stored;
  }

  /** Evidenze SYSTEM (§6): sessione + Git, leggibili senza log grezzo. */
  private buildEvidenceSummary(params: CreateCheckpointParams, gitDelta: GitDelta | null): string {
    const { session, gitEnd } = params;
    const parts: string[] = [];
    if (session) {
      parts.push(`Sessione agente: ${session.status}`);
      if (session.exitReason) parts.push(`Motivo: ${session.exitReason}`);
    } else {
      parts.push('Sessione agente: non rintracciabile');
    }
    if (gitDelta) {
      const moved = gitDelta.commitChanged
        ? `HEAD avanzato ${shortHash(gitDelta.fromHead)} → ${shortHash(gitDelta.toHead)}`
        : 'HEAD invariato';
      const dirty = gitDelta.dirty ? ', albero sporco' : '';
      const ahead = gitDelta.ahead ? `, ${gitDelta.ahead} commit avanti` : '';
      const behind = gitDelta.behind ? `, ${gitDelta.behind} commit indietro` : '';
      parts.push(`Git: ${moved}${dirty}${ahead}${behind}`);
    } else if (gitEnd) {
      parts.push(`Git: snapshot finale su ${gitEnd.branch ?? '?'} @ ${shortHash(gitEnd.head)}`);
    } else {
      parts.push('Git: nessun repository associato');
    }
    return parts.join(' · ');
  }

  private hasAgentEvidence(agent: CheckpointAgentInput): boolean {
    return Boolean(
      agent.summary ||
        agent.acceptanceStatus ||
        agent.testsSummary ||
        (agent.warnings && agent.warnings.length > 0) ||
        agent.recommendedAction ||
        agent.fullReportReference !== undefined,
    );
  }
}

function shortHash(head: string | null): string {
  return head ? head.slice(0, 7) : '?';
}
