import { z } from 'zod';
import type { ExecutionProviderRegistry, ExecutionResult } from '../integrations/execution-provider.js';
import type { AgentSession, Objective } from '../domain/objective.js';
import { blockSessionSchema, stopSessionSchema } from '../domain/objective.js';
import { checkpointAgentSchema, type Checkpoint } from '../domain/checkpoint.js';
import type { EventService } from './event-service.js';
import type { GitStatusService } from './git-status-service.js';
import type { ProjectService } from './project-service.js';
import type {
  ObjectiveRepository,
  SessionRepository,
} from '../infrastructure/db/objective-repo.js';
import type { ProcessSupervisor } from './process-supervisor.js';
import type { Project } from '../domain/project.js';
import type { CheckpointService } from './checkpoint-service.js';
import type { NotificationService } from './notification-service.js';
import { classifyError } from './error-classifier.js';
import type { GovernanceService } from './governance-service.js';
import type { ProviderCatalogService } from './provider-catalog-service.js';

export const EVENT_SESSION_STARTED = 'session.started';
export const EVENT_SESSION_STOPPED = 'session.stopped';
export const EVENT_SESSION_COMPLETED = 'session.completed';
export const EVENT_SESSION_FAILED = 'session.failed';
export const EVENT_SESSION_BLOCKED = 'session.blocked';

/** La transizione richiesta non è compatibile con lo stato corrente. */
export class SessionStateError extends Error {}

const completeSessionSchema = checkpointAgentSchema.extend({
  report: z
    .string()
    .trim()
    .min(1, 'Report non valido')
    .max(10000, 'Report troppo lungo (massimo 10000 caratteri)')
    .optional(),
});

const failSessionSchema = checkpointAgentSchema.extend({
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
  /** Checkpoint M4 generato dalla transizione (null solo per l'avvio). */
  checkpoint: Checkpoint | null;
}

/**
 * Ciclo di vita delle sessioni agente (§5 e §4): avvio con delega
 * all'adapter, stop controllato che porta l'obiettivo a
 * RICHIEDE_ATTENZIONE, conclusione con report e snapshot Git finale
 * (M4: l'obiettivo resta RICHIEDE_ATTENZIONE, l'approvazione è M5),
 * blocco con richiesta di aiuto e gestione errori. Ogni esito diverso
 * dall'avvio genera un Checkpoint M4 (§12-M4): conclusione, richiesta di
 * intervento, blocco o errore diventano un record persistente che
 * richiede una decisione umana. Lo stato ufficiale del progetto segue
 * l'obiettivo tramite objectiveStatusToProjectStatus (§5).
 */
export class AgentSessionService {
  constructor(
    private readonly objectives: ObjectiveRepository,
    private readonly sessions: SessionRepository,
    private readonly projects: ProjectService,
    private readonly gitStatus: GitStatusService,
    private readonly events: EventService,
    private readonly providers: ExecutionProviderRegistry,
    private readonly checkpoints: CheckpointService,
    private readonly supervisor: ProcessSupervisor,
    private readonly notifications?: NotificationService,
    private readonly governance?: GovernanceService,
    private readonly catalog?: ProviderCatalogService,
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

    const catalogEstimate = objective.estimatedCost === null && this.catalog ? this.catalog.estimate(session.agentType, objective.objectiveText, objective.stopCondition) : null;
    const preflight = this.governance?.preflight(objectiveId, objective.estimatedCost ?? catalogEstimate?.cost ?? null);
    if (preflight?.decision === 'HARD_STOP') throw new SessionStateError('Budget preventivo superato dalla stima dell’obiettivo');
    if (preflight?.decision === 'REQUIRE_APPROVAL') throw new SessionStateError(`Approvazione budget richiesta (${preflight.approval?.id ?? 'in attesa'})`);

    const project = this.projects.getById(objective.projectId);
    let provider;
    try { provider = this.providers.require(session.agentType); } catch (error) {
      throw new SessionStateError(error instanceof Error ? error.message : 'Runtime non disponibile');
    }
    let executionAttempt: import('../domain/execution-attempt.js').ExecutionAttempt | null = null;
    const handle = await provider.start({
      objectiveId: objective.id,
      projectPath: project?.repositoryPath ?? null,
      objectiveText: objective.objectiveText,
      stopCondition: objective.stopCondition,
      heartbeatIntervalMs: Math.max(100, Math.floor(session.heartbeatIntervalMs / 2)),
      onEvent: (event) => {
        if (!executionAttempt) return;
        this.supervisor.recordProgress(executionAttempt, event.type, { message: event.message ?? null, metadata: event.metadata ?? null });
        if (event.type === 'heartbeat') { this.sessions.touchHeartbeat(sessionId); this.sessions.touchActivity(sessionId); }
      },
    });

    this.sessions.setProcessReference(sessionId, handle.processReference);
    this.sessions.setStatus(sessionId, 'ATTIVA');
    this.sessions.touchActivity(sessionId);
    this.sessions.touchHeartbeat(sessionId);

    const attempt = await this.supervisor.startAttempt(session, {
      runtimeType: handle.descriptor.runtimeType,
      runtimeName: handle.descriptor.runtimeName,
      providerName: handle.descriptor.providerName,
      modelName: handle.descriptor.defaultModel,
      processReference: handle.processReference,
      metadata: { source: 'agent-session.start', runtimeId: handle.descriptor.id },
    });
    executionAttempt = attempt;

    this.objectives.markActive(objectiveId, 'IN_LAVORAZIONE', new Date().toISOString());
    this.projects.setStatus(objective.projectId, { status: 'IN_LAVORAZIONE' });

    this.events.log(EVENT_SESSION_STARTED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId,
      payload: {
        agentType: handle.descriptor.id,
        sessionRef: handle.processReference,
        executionAttemptId: attempt.id,
      },
    });

    void handle.completion.then((result) => this.applyRuntimeResult(objectiveId, sessionId, result)).catch(() => undefined);
    return this.transition(objectiveId, sessionId, null);
  }

  /** Heartbeat authenticated from the agent bridge; it also records normal activity. */
  async heartbeat(objectiveId: string, sessionId: string): Promise<AgentSession> {
    const session = this.sessions.getById(sessionId);
    if (!session || session.objectiveId !== objectiveId) throw new SessionStateError('Sessione non trovata per questo obiettivo');
    if (session.status !== 'ATTIVA') throw new SessionStateError('La sessione non è attiva');
    await this.providers.require(session.agentType).touchHeartbeat(session.processReference ?? session.id);
    const updated = this.sessions.touchHeartbeat(session.id);
    this.sessions.touchActivity(session.id);
    this.events.log('session.heartbeat', {
      category: 'AGENT', objectiveId, sessionId, payload: { agentType: session.agentType },
    });
    return updated!;
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

    await this.providers.require(session.agentType).stop(session.processReference ?? sessionId, parsed.reason ?? undefined);
    // Evidenza di fine lavoro (§6-SYSTEM): snapshot Git al momento dello stop.
    const gitEnd = await this.gitStatus.readSnapshot(objective.projectId);

    const terminated = this.sessions.terminate(sessionId, 'INTERROTTA', parsed.reason ?? null);
    await this.supervisor.finalizeLatestAttempt(sessionId, {
      endedAt: new Date().toISOString(),
      status: 'CANCELLED',
      reason: parsed.reason ?? 'Stop controllato',
      metadata: { finalEvent: 'session.stop' },
    });
    this.objectives.setStatus(objectiveId, 'RICHIEDE_ATTENZIONE');
    if (gitEnd) this.objectives.setGitEnd(objectiveId, gitEnd);
    this.projects.setStatus(objective.projectId, { status: 'RICHIEDE_ATTENZIONE' });

    // M4: lo stop è una richiesta di intervento → checkpoint PENDING_DECISION.
    const checkpoint = this.checkpoints.create({
      outcome: 'INTERRUPTED',
      projectId: objective.projectId,
      objective: this.objectives.getById(objectiveId)!,
      session: terminated ?? session,
      gitEnd,
      agent: {},
      defaults: {
        summary: parsed.reason
          ? `Richiesta di intervento: ${parsed.reason}`
          : "Richiesta di intervento: l'agente ha raggiunto la condizione di stop oppure l'operatore ha fermato la sessione.",
        recommendedAction: 'Rivedi il motivo dello stop e decidi come procedere.',
      },
    });

    this.events.log(EVENT_SESSION_STOPPED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId,
      payload: { reason: parsed.reason ?? null, checkpointId: checkpoint.id },
    });
    this.notifications?.notifySessionInterrupted({ ...session, projectId: objective.projectId });
    this.notifications?.notifyCheckpointDecisionRequired({ ...checkpoint, summary: checkpoint.summary });

    return this.transition(objectiveId, sessionId, checkpoint);
  }

  /**
   * Conclusione del lavoro (§5 e §12-M4): la sessione termina COMPLETATA e
   * l'obiettivo passa RICHIEDE_ATTENZIONE. L'approvazione (COMPLETATO) è
   * una decisione umana che arriverà con M5; intanto il checkpoint di
   * conclusione resta PENDING_DECISION con le evidenze §6 (SYSTEM+AGENT).
   */
  async complete(objectiveId: string, input: unknown = {}, runtimeResult?: ExecutionResult): Promise<SessionTransition> {
    const parsed = completeSessionSchema.parse(input);
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    const session = this.currentSession(objectiveId);
    if (!session) throw new SessionStateError('Nessuna sessione attiva da completare');

    const gitEnd = await this.gitStatus.readSnapshot(objective.projectId);
    const report = parsed.report ?? 'Obiettivo completato';

    const terminated = this.sessions.terminate(session.id, 'COMPLETATA', null);
    await this.supervisor.finalizeLatestAttempt(session.id, {
      endedAt: new Date().toISOString(),
      status: 'COMPLETED',
      exitCode: runtimeResult?.exitCode ?? 0,
      reason: runtimeResult?.reason ?? 'Sessione completata con successo',
      inputTokens: runtimeResult?.usage?.inputTokens ?? null, outputTokens: runtimeResult?.usage?.outputTokens ?? null, totalTokens: runtimeResult?.usage?.totalTokens ?? null, costEstimate: runtimeResult?.usage?.costEstimate ?? null, costActual: runtimeResult?.usage?.costActual ?? null,
      metadata: { finalEvent: 'session.complete', runtime: runtimeResult?.metadata ?? null },
    });
    this.objectives.conclude(objectiveId, report, gitEnd);
    this.projects.setStatus(objective.projectId, { status: 'RICHIEDE_ATTENZIONE' });

    const checkpoint = this.checkpoints.create({
      outcome: 'COMPLETED',
      projectId: objective.projectId,
      objective: this.objectives.getById(objectiveId)!,
      session: terminated ?? session,
      gitEnd,
      agent: parsed,
      defaults: {
        summary: `La sessione agente si è conclusa: lavoro dichiarato completo per «${objective.title}».`,
        recommendedAction: 'Valuta i criteri di accettazione e decidi come procedere.',
      },
    });

    this.events.log(EVENT_SESSION_COMPLETED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId: session.id,
      payload: { hasGitEnd: gitEnd !== null, checkpointId: checkpoint.id },
    });
    this.notifications?.notifyCheckpointCreated({ ...checkpoint, summary: checkpoint.summary });
    this.notifications?.notifyCheckpointDecisionRequired({ ...checkpoint, summary: checkpoint.summary });

    return this.transition(objectiveId, session.id, checkpoint);
  }

  /**
   * Blocco con richiesta di aiuto (M4): la sessione termina BLOCCATA e
   * obiettivo/progetto passano BLOCCATO. Il blocco genera un checkpoint
   * BLOCKED che richiede una decisione umana.
   */
  async block(objectiveId: string, input: unknown = {}): Promise<SessionTransition> {
    const parsed = blockSessionSchema.parse(input);
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    const session = this.currentSession(objectiveId);
    if (!session) throw new SessionStateError('Nessuna sessione attiva da bloccare');

    const reason = parsed.reason ?? "Bloccato dall'operatore";
    const gitEnd = await this.gitStatus.readSnapshot(objective.projectId);

    const terminated = this.sessions.terminate(session.id, 'BLOCCATA', reason);
    await this.supervisor.finalizeLatestAttempt(session.id, {
      endedAt: new Date().toISOString(),
      status: 'CANCELLED',
      reason,
      metadata: { finalEvent: 'session.block' },
    });
    this.objectives.setStatus(objectiveId, 'BLOCCATO');
    if (gitEnd) this.objectives.setGitEnd(objectiveId, gitEnd);
    this.projects.setStatus(objective.projectId, { status: 'BLOCCATO' });

    const checkpoint = this.checkpoints.create({
      outcome: 'BLOCKED',
      projectId: objective.projectId,
      objective: this.objectives.getById(objectiveId)!,
      session: terminated ?? session,
      gitEnd,
      agent: {},
      defaults: {
        summary: parsed.reason
          ? `Bloccato: ${parsed.reason}`
          : "L'agente ha chiesto aiuto e non può proseguire autonomamente.",
        recommendedAction: "Sblocca manualmente l'agente o decidi come procedere.",
      },
    });

    this.events.log(EVENT_SESSION_BLOCKED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId: session.id,
      payload: { reason, checkpointId: checkpoint.id },
    });
    this.notifications?.notifyCheckpointDecisionRequired({ ...checkpoint, summary: checkpoint.summary });

    return this.transition(objectiveId, session.id, checkpoint);
  }

  /** Segna l'obiettivo in errore: sessione ERRORE, obiettivo ERRORE, progetto ERRORE. */
  async fail(objectiveId: string, input: unknown = {}, runtimeResult?: ExecutionResult): Promise<SessionTransition> {
    const parsed = failSessionSchema.parse(input);
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    const session = this.currentSession(objectiveId);
    if (!session) throw new SessionStateError('Nessuna sessione attiva da segnalare in errore');

    const detail = parsed.error ?? "Errore segnalato dall'operatore";
    const gitEnd = await this.gitStatus.readSnapshot(objective.projectId);

    const terminated = this.sessions.terminate(session.id, 'ERRORE', detail);
    await this.supervisor.finalizeLatestAttempt(session.id, {
      endedAt: new Date().toISOString(),
      status: 'FAILED',
      exitCode: runtimeResult?.exitCode ?? null,
      reason: detail,
      errorClass: runtimeResult?.errorClass ?? 'USER_REPORTED',
      inputTokens: runtimeResult?.usage?.inputTokens ?? null, outputTokens: runtimeResult?.usage?.outputTokens ?? null, totalTokens: runtimeResult?.usage?.totalTokens ?? null, costEstimate: runtimeResult?.usage?.costEstimate ?? null, costActual: runtimeResult?.usage?.costActual ?? null,
      metadata: { finalEvent: 'session.fail', runtime: runtimeResult?.metadata ?? null },
    });
    this.objectives.setStatus(objectiveId, 'ERRORE');
    if (gitEnd) this.objectives.setGitEnd(objectiveId, gitEnd);
    this.projects.setStatus(objective.projectId, { status: 'ERRORE' });

    // M4: un errore resta un checkpoint PENDING_DECISION (decisione umana).
    const checkpoint = this.checkpoints.create({
      outcome: 'ERROR',
      projectId: objective.projectId,
      objective: this.objectives.getById(objectiveId)!,
      session: terminated ?? session,
      gitEnd,
      agent: parsed,
      defaults: {
        summary: detail,
        recommendedAction: 'Verifica il problema tecnico e decidi come procedere.',
      },
    });

    this.events.log(EVENT_SESSION_FAILED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId: session.id,
      payload: { error: detail, checkpointId: checkpoint.id },
    });
    const errorClass = classifyError(detail);
    this.notifications?.notifySessionError({ ...session, projectId: objective.projectId, exitReason: detail, errorClass });
    this.notifications?.notifyObjectiveFailed({ id: objective.id, projectId: objective.projectId, title: objective.title, errorClass });
    this.notifications?.notifyCheckpointDecisionRequired({ ...checkpoint, summary: checkpoint.summary });

    return this.transition(objectiveId, session.id, checkpoint);
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

  /** Bridges a provider result back into the existing Control Plane lifecycle. */
  private async applyRuntimeResult(objectiveId: string, sessionId: string, result: ExecutionResult): Promise<void> {
    const session = this.sessions.getById(sessionId);
    if (!session || session.status !== 'ATTIVA') return; // a human transition already won the race
    if (result.outcome === 'COMPLETED') {
      const pending = result.usage?.costActual ?? result.usage?.costEstimate ?? 0;
      const governance = this.governance?.evaluateAdditionalCost(objectiveId, pending);
      if (governance) this.governance?.recordDecision(objectiveId, governance.decision, pending);
      if (governance?.decision === 'HARD_STOP' || (!governance && this.supervisor.exceedsBudget(sessionId, pending))) {
        await this.fail(objectiveId, { error: 'Budget di esecuzione superato' }, { ...result, outcome: 'FAILED', errorClass: 'AGENT_CONTROL_ERROR' });
        return;
      }
      await this.complete(objectiveId, { report: result.reason ?? `Completato da ${session.agentType}` }, result);
      return;
    }
    if (result.outcome === 'FAILED') {
      const failed = await this.supervisor.finalizeLatestAttempt(sessionId, {
        endedAt: new Date().toISOString(), status: 'FAILED', exitCode: result.exitCode,
        reason: result.reason, errorClass: result.errorClass ?? 'AGENT_ERROR', metadata: result.metadata ?? null,
        inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null, totalTokens: result.usage?.totalTokens ?? null, costEstimate: result.usage?.costEstimate ?? null, costActual: result.usage?.costActual ?? null,
      });
      const plan = this.supervisor.retryPlan(sessionId, session.agentType, failed);
      if (plan) {
        await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
        if (this.sessions.getById(sessionId)?.status !== 'ATTIVA') return;
        await this.startRetryAttempt(objectiveId, sessionId, plan.runtime, plan.fallbackOfAttemptId);
        return;
      }
      await this.fail(objectiveId, { error: result.reason ?? `Errore del runtime ${session.agentType}` }, result);
      return;
    }
    await this.stop(objectiveId, sessionId, { reason: result.reason ?? `Runtime ${session.agentType} interrotto` });
  }

  private async startRetryAttempt(objectiveId: string, sessionId: string, runtime: string, fallbackOfAttemptId: string | null): Promise<void> {
    const objective = this.objectives.getById(objectiveId)!;
    const project = this.projects.getById(objective.projectId);
    const provider = this.providers.require(runtime);
    let attempt: import('../domain/execution-attempt.js').ExecutionAttempt | null = null;
    const handle = await provider.start({ objectiveId, projectPath: project?.repositoryPath ?? null, objectiveText: objective.objectiveText, stopCondition: objective.stopCondition,
      heartbeatIntervalMs: Math.max(100, Math.floor(this.sessions.getById(sessionId)!.heartbeatIntervalMs / 2)),
      onEvent: (event) => {
        if (!attempt) return;
        this.supervisor.recordProgress(attempt, event.type, { message: event.message ?? null, metadata: event.metadata ?? null });
        if (event.type === 'heartbeat') { this.sessions.touchHeartbeat(sessionId); this.sessions.touchActivity(sessionId); }
      },
    });
    this.sessions.setProcessReference(sessionId, handle.processReference, runtime);
    attempt = await this.supervisor.startAttempt(this.sessions.getById(sessionId)!, {
      runtimeType: handle.descriptor.runtimeType, runtimeName: handle.descriptor.runtimeName, providerName: handle.descriptor.providerName,
      modelName: handle.descriptor.defaultModel, processReference: handle.processReference, fallbackOfAttemptId,
      metadata: { source: 'process-supervisor.retry', runtimeId: runtime, backoffApplied: true },
    });
    void handle.completion.then((result) => this.applyRuntimeResult(objectiveId, sessionId, result)).catch(() => undefined);
  }

  private transition(
    objectiveId: string,
    sessionId: string,
    checkpoint: Checkpoint | null = null,
  ): SessionTransition {
    const objective = this.objectives.getById(objectiveId);
    const session = this.sessions.getById(sessionId);
    return {
      objective: objective!,
      session: session!,
      project: objective ? this.projects.getById(objective.projectId) : null,
      checkpoint,
    };
  }
}
