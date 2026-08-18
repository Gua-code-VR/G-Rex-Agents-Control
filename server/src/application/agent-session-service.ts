import { z } from 'zod';
import type { ExecutionEvent, ExecutionProviderRegistry, ExecutionResult } from '../integrations/execution-provider.js';
import type { AgentSession, ExecutionSelection, Objective } from '../domain/objective.js';
import { blockSessionSchema, deriveProjectStatus, stopSessionSchema } from '../domain/objective.js';
import { checkpointAgentSchema, type Checkpoint } from '../domain/checkpoint.js';
import type { EventService } from './event-service.js';
import type { GitStatusService } from './git-status-service.js';
import type { ProjectService } from './project-service.js';
import type { DecisionService } from './decision-service.js';
import type {
  ObjectiveRepository,
  SessionRepository,
} from '../infrastructure/db/objective-repo.js';
import type { ProcessSupervisor } from './process-supervisor.js';
import type { Project } from '../domain/project.js';
import type { CheckpointService } from './checkpoint-service.js';
import type { NotificationService } from './notification-service.js';
import { classifyError, translateTechnicalError } from './error-classifier.js';
import type { GovernanceService } from './governance-service.js';
import type { ProviderCatalogService } from './provider-catalog-service.js';
import type { RuntimeSelectionService } from './runtime-selection-service.js';
import type { PersistentRetryWorker } from './persistent-retry-worker.js';
import { WorktreeError, type WorktreeService } from './worktree-service.js';
import type { RetryJob } from '../domain/retry-job.js';

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

/** Esito di un tentativo di avvio automatico dalla coda di esecuzione. */
export interface AutoStartResult {
  started: boolean;
  /** Transizione aggiornata solo quando started=true. */
  transition: SessionTransition | null;
  /** true se start() ha lanciato (es. governance): la coda applica un cooldown. */
  failed?: boolean;
}

/** Richiesta di approvazione runtime in attesa di decisione umana (§19 spec). */
export interface RuntimeApproval {
  requestId: string;
  objectiveId: string;
  sessionId: string;
  processReference: string | null;
  action: string;
  detail: string | null;
  requestedAt: string;
}

/**
 * Ciclo di vita delle sessioni agente (§5 e §4): avvio con delega
 * all'adapter, stop controllato che porta l'obiettivo a
 * RICHIEDE_ATTENZIONE, conclusione con report e snapshot Git finale
 * (M4: l'obiettivo resta RICHIEDE_ATTENZIONE, l'approvazione è M5),
 * blocco con richiesta di aiuto e gestione errori. Ogni esito diverso
 * dall'avvio genera un Checkpoint M4 (§12-M4): conclusione, richiesta di
 * intervento, blocco o errore diventano un record persistente che
 * richiede una decisione umana. Lo stato ufficiale del progetto è
 * derivato dagli obiettivi reali (§4.2 V2).
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
    private readonly runtimeSelector?: RuntimeSelectionService,
    private readonly retryWorker?: PersistentRetryWorker,
    private readonly worktrees?: WorktreeService,
    private readonly decisions?: DecisionService,
  ) {}

  private readonly runtimeApprovals = new Map<string, RuntimeApproval>();

  /** Numero di approvazioni runtime realmente pendenti (§5 V2). */
  countRuntimeApprovals(): number {
    return this.runtimeApprovals.size;
  }

  /** Rimuove le approvazioni runtime pendenti di una sessione conclusa. */
  private clearRuntimeApprovals(sessionId: string): void {
    for (const [requestId, approval] of this.runtimeApprovals) {
      if (approval.sessionId === sessionId) this.runtimeApprovals.delete(requestId);
    }
  }

  /** Registra una richiesta di approvazione runtime inoltrata dal provider. */
  private registerRuntimeApproval(objectiveId: string, sessionId: string, processReference: string | null, event: ExecutionEvent): void {
    if (!event.approval) return;
    const { requestId, action, detail } = event.approval;
    this.runtimeApprovals.set(requestId, { requestId, objectiveId, sessionId, processReference, action, detail, requestedAt: new Date().toISOString() });
    this.events.log('runtime.approval.requested', { category: 'AGENT', objectiveId, sessionId, payload: { requestId, action, detail } });
    this.notifications?.notify({
      type: 'CHECKPOINT_DECISION_REQUIRED',
      severity: 'warning',
      title: 'Approvazione runtime richiesta',
      message: `L'agente chiede di eseguire: ${action}${detail ? ` — ${detail}` : ''}.`,
      objectiveId,
      sessionId,
      metadata: { requestId, action, detail },
    });
  }

  /** Elenco delle approvazioni runtime pendenti (§10/§19 spec). */
  listRuntimeApprovals(): RuntimeApproval[] {
    return [...this.runtimeApprovals.values()].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /** Decide una richiesta di approvazione runtime e risponde al processo. */
  async decideRuntimeApproval(requestId: string, approved: boolean): Promise<{ requestId: string; approved: boolean } | null> {
    const approval = this.runtimeApprovals.get(requestId);
    if (!approval) return null;
    this.runtimeApprovals.delete(requestId);
    const session = this.sessions.getById(approval.sessionId);
    const provider = session ? this.providers.get(session.agentType) : null;
    if (provider?.respondApproval && approval.processReference) {
      await provider.respondApproval(approval.processReference, requestId, approved);
    }
    this.events.log('runtime.approval.decided', { category: 'USER', objectiveId: approval.objectiveId, sessionId: approval.sessionId, payload: { requestId, approved } });
    return { requestId, approved };
  }

  /** Avvia la sessione (IN_AVVIO → ATTIVA) e porta obiettivo e progetto IN_LAVORAZIONE. */
  async start(
    objectiveId: string,
    sessionId: string,
    selectionOverride?: Partial<ExecutionSelection> & { runtimeId: string },
  ): Promise<SessionTransition> {
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    const session = this.sessions.getById(sessionId);
    if (!session || session.objectiveId !== objectiveId) {
      throw new SessionStateError('Sessione non trovata per questo obiettivo');
    }
    if (session.status === 'ATTIVA') {
      return this.transition(objectiveId, sessionId, null);
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
    let selection;
    try {
      if (selectionOverride) {
        // M19: conferma con modifica — la combinazione scelta dall'utente diventa esplicita.
        selection = this.catalog?.resolve({
          runtimeId: selectionOverride.runtimeId,
          providerId: selectionOverride.providerId,
          modelId: selectionOverride.modelId ?? null,
          outputTokenLimit: selectionOverride.outputTokenLimit ?? null,
          decision: {
            mode: 'EXPLICIT',
            reason: `Selezione confermata manualmente: ${selectionOverride.runtimeId}/${selectionOverride.providerId ?? 'provider'}/${selectionOverride.modelId ?? 'modello-runtime'}`,
            selectedScore: null,
            requiredCapabilities: [],
            budget: { policy: { costBudget: null, warningPercent: 80, action: 'WARN' }, spent: 0, remaining: null },
            candidates: [],
            decidedAt: new Date().toISOString(),
          },
        });
        if (selection) this.sessions.setExecutionSelection(sessionId, selection);
      } else {
        selection = this.catalog?.resolve(session.executionSelection ?? { runtimeId: session.agentType });
      }
    }
    catch (error) { throw new SessionStateError(error instanceof Error ? error.message : 'Selezione runtime non utilizzabile'); }
    if (!selection) throw new SessionStateError('Catalogo runtime non disponibile');
    let provider;
    try { provider = this.providers.require(selection.runtimeId); } catch (error) {
      throw new SessionStateError(error instanceof Error ? error.message : 'Runtime non disponibile');
    }
    let executionAttempt: import('../domain/execution-attempt.js').ExecutionAttempt | null = null;
    const pendingEvents: ExecutionEvent[] = [];
    // §19: risolve il percorso isolato (worktree + branch dedicato) passato
    // all'Execution Plane; se l'isolamento non è applicabile degrada al
    // percorso principale senza cambiare il contratto runtime.
    let executionPath = project?.repositoryPath ?? null;
    let workspace: import('../domain/workspace.js').AgentWorkspace | null = null;
    if (this.worktrees) {
      try {
        const resolved = await this.worktrees.resolveExecutionPath(project, objective, session);
        executionPath = resolved.path ?? executionPath;
        workspace = resolved.workspace;
      } catch (error) {
        if (error instanceof WorktreeError) throw new SessionStateError(error.message);
        throw error;
      }
    }
    const handle = await provider.start({
      objectiveId: objective.id,
      projectPath: executionPath,
      objectiveText: objective.objectiveText,
      stopCondition: objective.stopCondition,
      providerId: selection.providerId,
      model: selection.modelId,
      heartbeatIntervalMs: Math.max(100, Math.floor(session.heartbeatIntervalMs / 2)),
      onEvent: (event) => {
        // Le approvazioni e gli heartbeat non dipendono dall'ExecutionAttempt:
        // vanno gestiti anche prima che l'attempt venga creato, altrimenti
        // vengono persi durante l'avvio del processo reale.
        if (event.type === 'approval') {
          this.registerRuntimeApproval(objective.id, session.id, handle.processReference, event);
          if (executionAttempt) this.supervisor.recordProgress(executionAttempt, 'progress', { message: event.message ?? null, metadata: event.metadata ?? null });
          return;
        }
        if (event.type === 'heartbeat') {
          this.sessions.touchHeartbeat(sessionId);
          this.sessions.touchActivity(sessionId);
          return;
        }
        if (!executionAttempt) {
          pendingEvents.push(event);
          return;
        }
        this.supervisor.recordProgress(executionAttempt, event.type, { message: event.message ?? null, metadata: event.metadata ?? null });
      },
    });

    this.sessions.setProcessReference(sessionId, handle.processReference);
    this.sessions.setStatus(sessionId, 'ATTIVA');
    this.sessions.touchActivity(sessionId);
    this.sessions.touchHeartbeat(sessionId);
    if (workspace) {
      this.sessions.setWorkspaceId(sessionId, workspace.id);
      this.worktrees?.attachSession(workspace.id, sessionId);
    }

    const attempt = await this.supervisor.startAttempt(session, {
      runtimeType: handle.descriptor.runtimeType,
      runtimeName: handle.descriptor.runtimeName,
      providerName: this.catalog?.providerName(selection.runtimeId, selection.providerId) ?? handle.descriptor.providerName,
      modelName: selection.modelId,
      processReference: handle.processReference,
      metadata: {
        source: 'agent-session.start', selection, selectionReason: selection.decision?.reason ?? 'Selezione validata dal catalogo M14',
        ...(workspace ? { workspaceId: workspace.id, workspacePath: workspace.worktreePath, workspaceBranch: workspace.branch } : {}),
      },
    });
    executionAttempt = attempt;
    for (const event of pendingEvents) {
      if (event.type === 'approval') continue;
      this.supervisor.recordProgress(executionAttempt, event.type, { message: event.message ?? null, metadata: event.metadata ?? null });
    }

    this.objectives.markActive(objectiveId, 'IN_LAVORAZIONE', new Date().toISOString());
    // §4.2 V2: stato progetto derivato dagli obiettivi reali.
    this.projects.setStatus(objective.projectId, {
      status: deriveProjectStatus(this.objectives.listByProject(objective.projectId)),
    });

    // §5.1 V2: una nuova esecuzione rende obsoleti i checkpoint pendenti del
    // tentativo precedente (retry/recovery non restano azioni umane pendenti).
    // La risoluzione è automatica e auditabile e non tocca lo stato corrente.
    this.decisions?.resolveStalePending(objectiveId, 'Sessione avviata: il nuovo tentativo sostituisce la decisione sul tentativo precedente');

    this.events.log(EVENT_SESSION_STARTED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId,
      payload: {
        agentType: handle.descriptor.id, selection,
        sessionRef: handle.processReference,
        executionAttemptId: attempt.id,
      },
    });

    void handle.completion.then((result) => this.applyRuntimeResult(objectiveId, sessionId, result)).catch(() => undefined);
    return this.transition(objectiveId, sessionId, null);
  }

  /** Avvia automaticamente la sessione IN_AVVIO se esiste almeno un worker
   *  disponibile (provider configurato non impegnato da una sessione ATTIVA).
   *  Altrimenti l'obiettivo resta in coda. failed=true se start() ha lanciato
   *  (es. governance): la coda applica un cooldown per non ripetere il
   *  preflight (log/notifiche) a ogni tick. */
  async tryAutoStart(objectiveId: string, sessionId: string): Promise<AutoStartResult> {
    const session = this.sessions.getById(sessionId);
    if (!session || session.status !== 'IN_AVVIO') return { started: false, transition: null };
    const objective = this.objectives.getById(objectiveId);
    if (!objective || objective.status !== 'IN_AVVIO') return { started: false, transition: null };
    // Approvazione governance già pendente: non rieseguire il preflight a ogni
    // tick. Dopo la decisione dell'operatore il preflight riesce e la coda
    // avvia l'obiettivo al tick successivo.
    if (this.governance && this.governance.listApprovals(objectiveId).some((approval) => approval.status === 'PENDING')) {
      return { started: false, transition: null };
    }
    if (!this.hasAvailableWorker()) return { started: false, transition: null };
    try {
      const transition = await this.start(objectiveId, sessionId);
      return { started: true, transition };
    } catch {
      return { started: false, transition: null, failed: true };
    }
  }

  /** Esiste almeno un worker libero: provider configurati meno sessioni ATTIVE. */
  private hasAvailableWorker(): boolean {
    const configured = this.providers.list().filter((provider) => provider.configured).length;
    if (configured <= 0) return false;
    const active = this.sessions.listAll().filter((session) => session.status === 'ATTIVA').length;
    return active < configured;
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
    this.retryWorker?.cancelSession(sessionId, "Sessione fermata dall'operatore");
    this.clearRuntimeApprovals(sessionId);

    // La sessione viene terminata PRIMA delle operazioni asincrone (stop del
    // processo, snapshot Git): un eventuale esito del runtime in arrivo vede la
    // sessione non più ATTIVA e non può generare transizioni duplicate o stati
    // contraddittori (es. doppio checkpoint per lo stesso stop).
    const terminated = this.sessions.terminate(sessionId, 'INTERROTTA', parsed.reason ?? null);
    await this.providers.require(session.agentType).stop(session.processReference ?? sessionId, parsed.reason ?? undefined);
    // Evidenza di fine lavoro (§6-SYSTEM): snapshot Git al momento dello stop.
    const gitEnd = await this.gitStatus.readSnapshot(objective.projectId);

    await this.supervisor.finalizeLatestAttempt(sessionId, {
      endedAt: new Date().toISOString(),
      status: 'CANCELLED',
      reason: parsed.reason ?? 'Stop controllato',
      metadata: { finalEvent: 'session.stop' },
    });
    this.objectives.setStatus(objectiveId, 'RICHIEDE_ATTENZIONE');
    if (gitEnd) this.objectives.setGitEnd(objectiveId, gitEnd);
    // §4.2 V2: stato progetto derivato dagli obiettivi reali.
    this.projects.setStatus(objective.projectId, {
      status: deriveProjectStatus(this.objectives.listByProject(objective.projectId)),
    });

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
   * Conclusione riuscita del lavoro (§4.1 V2): la sessione termina COMPLETATA
   * e l'obiettivo passa automaticamente a COMPLETATO, con report finale
   * persistito. Un completamento riuscito NON genera un checkpoint pendente né
   * una voce in «Richiede te»: l'approvazione umana ordinaria è superata.
   */
  async complete(objectiveId: string, input: unknown = {}, runtimeResult?: ExecutionResult): Promise<SessionTransition> {
    const parsed = completeSessionSchema.parse(input);
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    const session = this.currentSession(objectiveId);
    if (!session) throw new SessionStateError('Nessuna sessione attiva da completare');
    this.retryWorker?.cancelSession(session.id, 'Sessione completata');
    this.clearRuntimeApprovals(session.id);

    // Terminazione prima delle operazioni asincrone: un esito del runtime in
    // arrivo vede la sessione non più ATTIVA (niente doppio completamento).
    this.sessions.terminate(session.id, 'COMPLETATA', null);
    await this.stopProcess(session);

    const gitEnd = await this.gitStatus.readSnapshot(objective.projectId);
    const report = parsed.report ?? 'Obiettivo completato';

    await this.supervisor.finalizeLatestAttempt(session.id, {
      endedAt: new Date().toISOString(),
      status: 'COMPLETED',
      exitCode: runtimeResult?.exitCode ?? 0,
      reason: runtimeResult?.reason ?? 'Sessione completata con successo',
      inputTokens: runtimeResult?.usage?.inputTokens ?? null, outputTokens: runtimeResult?.usage?.outputTokens ?? null, totalTokens: runtimeResult?.usage?.totalTokens ?? null, cachedInputTokens: runtimeResult?.usage?.cachedInputTokens ?? null, cachedOutputTokens: runtimeResult?.usage?.cachedOutputTokens ?? null, costEstimate: runtimeResult?.usage?.costEstimate ?? null, costActual: this.effectiveCost(session, runtimeResult?.usage),
      metadata: { finalEvent: 'session.complete', runtime: runtimeResult?.metadata ?? null },
    });

    // Completamento riuscito: stato terminale automatico, senza approvazione
    // umana ordinaria (§ prodotto). Il report finale è mostrato sull'obiettivo.
    this.objectives.completeWithReport(objectiveId, report, gitEnd);
    // §4.2 V2: lo stato progetto è derivato dagli obiettivi reali (se esistono
    // altri obiettivi non terminali il progetto li riflette, altrimenti FERMO).
    this.projects.setStatus(objective.projectId, {
      status: deriveProjectStatus(this.objectives.listByProject(objective.projectId)),
    });

    this.events.log(EVENT_SESSION_COMPLETED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId: session.id,
      payload: { hasGitEnd: gitEnd !== null, finalReport: report },
    });
    this.notifications?.notifyObjectiveCompleted({ id: objective.id, projectId: objective.projectId, title: objective.title });

    // §19.4: integrazione controllata della workspace nel repository di
    // destinazione. Non altera l'esito del completamento: se l'integrazione
    // non è sicura/deterministica il lavoro resta preservato sul branch e
    // viene creata una richiesta umana (§19.4/§19.5).
    if (this.worktrees) {
      await this.worktrees.integrateOnComplete(objective).catch(() => undefined);
    }

    return this.transition(objectiveId, session.id, null);
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
    this.retryWorker?.cancelSession(session.id, 'Sessione bloccata');
    this.clearRuntimeApprovals(session.id);

    const reason = parsed.reason ?? "Bloccato dall'operatore";
    // Terminazione prima delle operazioni asincrone (stesso invariante dello stop).
    const terminated = this.sessions.terminate(session.id, 'BLOCCATA', reason);
    await this.stopProcess(session);

    const gitEnd = await this.gitStatus.readSnapshot(objective.projectId);

    await this.supervisor.finalizeLatestAttempt(session.id, {
      endedAt: new Date().toISOString(),
      status: 'CANCELLED',
      reason,
      metadata: { finalEvent: 'session.block' },
    });
    this.objectives.setStatus(objectiveId, 'BLOCCATO');
    if (gitEnd) this.objectives.setGitEnd(objectiveId, gitEnd);
    // §4.2 V2: stato progetto derivato dagli obiettivi reali.
    this.projects.setStatus(objective.projectId, {
      status: deriveProjectStatus(this.objectives.listByProject(objective.projectId)),
    });

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
    this.retryWorker?.cancelSession(session.id, 'Sessione terminata in errore');
    this.clearRuntimeApprovals(session.id);

    const detail = parsed.error ?? "Errore segnalato dall'operatore";
    const errorClass = classifyError(detail);
    const translation = translateTechnicalError(detail, errorClass, session.agentType);
    // Terminazione prima delle operazioni asincrone (stesso invariante dello stop).
    const terminated = this.sessions.terminate(session.id, 'ERRORE', detail);
    await this.stopProcess(session);

    const gitEnd = await this.gitStatus.readSnapshot(objective.projectId);

    await this.supervisor.finalizeLatestAttempt(session.id, {
      endedAt: new Date().toISOString(),
      status: 'FAILED',
      exitCode: runtimeResult?.exitCode ?? null,
      reason: detail,
      errorClass: runtimeResult?.errorClass ?? 'USER_REPORTED',
      inputTokens: runtimeResult?.usage?.inputTokens ?? null, outputTokens: runtimeResult?.usage?.outputTokens ?? null, totalTokens: runtimeResult?.usage?.totalTokens ?? null, cachedInputTokens: runtimeResult?.usage?.cachedInputTokens ?? null, cachedOutputTokens: runtimeResult?.usage?.cachedOutputTokens ?? null, costEstimate: runtimeResult?.usage?.costEstimate ?? null, costActual: this.effectiveCost(session, runtimeResult?.usage),
      metadata: { finalEvent: 'session.fail', runtime: runtimeResult?.metadata ?? null },
    });
    this.objectives.setStatus(objectiveId, 'ERRORE');
    if (gitEnd) this.objectives.setGitEnd(objectiveId, gitEnd);
    // §4.2 V2: stato progetto derivato dagli obiettivi reali.
    this.projects.setStatus(objective.projectId, {
      status: deriveProjectStatus(this.objectives.listByProject(objective.projectId)),
    });

    // M4: un errore resta un checkpoint PENDING_DECISION (decisione umana).
    const checkpoint = this.checkpoints.create({
      outcome: 'ERROR',
      projectId: objective.projectId,
      objective: this.objectives.getById(objectiveId)!,
      session: terminated ?? session,
      gitEnd,
      agent: parsed,
      technicalDetails: detail,
      defaults: {
        summary: `${translation.summary} ${translation.consequences}`,
        recommendedAction: translation.recommendedAction,
      },
    });

    this.events.log(EVENT_SESSION_FAILED, {
      projectId: objective.projectId,
      objectiveId,
      sessionId: session.id,
      payload: { error: detail, checkpointId: checkpoint.id },
    });
    this.notifications?.notifySessionError({ ...session, projectId: objective.projectId, exitReason: detail, errorClass });
    this.notifications?.notifyObjectiveFailed({ id: objective.id, projectId: objective.projectId, title: objective.title, errorClass });
    this.notifications?.notifyCheckpointDecisionRequired({ ...checkpoint, summary: checkpoint.summary });

    return this.transition(objectiveId, session.id, checkpoint);
  }

  /** Ferma il processo reale della sessione (best-effort): collega la
   *  terminazione della sessione alla reale interruzione dell'esecuzione. */
  private async stopProcess(session: AgentSession): Promise<void> {
    const provider = this.providers.get(session.agentType);
    if (!provider) return;
    try {
      await provider.stop(session.processReference ?? session.id);
    } catch {
      // Processo gia' terminato o runtime non raggiungibile: nessuna azione.
    }
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

  /**
   * Costo effettivo di un attempt: se il runtime restituisce un costo monetario
   * lo usa; altrimenti lo calcola dai token reali × prezzo per token risolto
   * dall'archivio G-Rex Pricing (consuntivo).
   */
  private effectiveCost(session: AgentSession, usage?: ExecutionResult['usage']): number | null {
    const monetary = usage?.costActual ?? usage?.costEstimate ?? null;
    if (monetary != null) return monetary;
    const selection = session.executionSelection;
    if (!selection || !this.catalog) return null;
    const tp = this.catalog.tokenPricing(selection.runtimeId, selection.providerId, selection.modelId);
    if (!tp) return null;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const cachedOutputTokens = usage?.cachedOutputTokens ?? 0;
    if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) return null;
    // Scaglioni cache-miss/cache-hit: `input_tokens` include i token serviti
    // dalla cache, quindi la quota cache-miss è la differenza.
    const cacheMissInput = Math.max(0, inputTokens - cachedInputTokens);
    const cost =
      cacheMissInput * (tp.inputPerToken ?? 0)
      + cachedInputTokens * (tp.cachedInputPerToken ?? tp.inputPerToken ?? 0)
      + outputTokens * (tp.outputPerToken ?? 0)
      + cachedOutputTokens * (tp.cachedOutputPerToken ?? tp.outputPerToken ?? 0);
    return Number(cost.toFixed(8));
  }

  /** Bridges a provider result back into the existing Control Plane lifecycle. */
  private async applyRuntimeResult(objectiveId: string, sessionId: string, result: ExecutionResult): Promise<void> {
    const session = this.sessions.getById(sessionId);
    if (!session || session.status !== 'ATTIVA') return; // a human transition already won the race
    this.clearRuntimeApprovals(sessionId);
    if (result.outcome === 'COMPLETED') {
      const pending = this.effectiveCost(session, result.usage) ?? 0;
      const governance = this.governance?.evaluateAdditionalCost(objectiveId, pending);
      if (governance) this.governance?.recordDecision(objectiveId, governance.decision, pending);
      if (governance?.decision === 'HARD_STOP' || (!governance && this.supervisor.exceedsBudget(sessionId, pending))) {
        await this.fail(objectiveId, { error: 'Budget di esecuzione superato' }, { ...result, outcome: 'FAILED', errorClass: 'AGENT_CONTROL_ERROR' });
        return;
      }
      await this.complete(objectiveId, { report: result.report ?? result.reason ?? `Completato da ${session.agentType}` }, result);
      return;
    }
    if (result.outcome === 'FAILED') {
      const failed = await this.supervisor.finalizeLatestAttempt(sessionId, {
        endedAt: new Date().toISOString(), status: 'FAILED', exitCode: result.exitCode,
        reason: result.reason, errorClass: result.errorClass ?? 'AGENT_ERROR', metadata: result.metadata ?? null,
        inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null, totalTokens: result.usage?.totalTokens ?? null, cachedInputTokens: result.usage?.cachedInputTokens ?? null, cachedOutputTokens: result.usage?.cachedOutputTokens ?? null, costEstimate: result.usage?.costEstimate ?? null, costActual: this.effectiveCost(session, result.usage),
      });
      const plan = this.supervisor.retryPlan(sessionId, session.agentType, failed);
      if (plan) {
        this.retryWorker?.schedule(sessionId, plan.runtime, plan.fallbackOfAttemptId, plan.delayMs);
        if (!this.retryWorker) await this.startRetryAttempt(objectiveId, sessionId, plan.runtime, plan.fallbackOfAttemptId);
        return;
      }
      await this.fail(objectiveId, { error: (result.reason ?? `Errore del runtime ${session.agentType}`).slice(0, 1000) }, result);
      return;
    }
    await this.stop(objectiveId, sessionId, { reason: result.reason ?? `Runtime ${session.agentType} interrotto` });
  }

  async runRetryJob(job: RetryJob): Promise<void> {
    const session = this.sessions.getById(job.sessionId);
    if (!session || session.status !== 'ATTIVA') return;
    await this.startRetryAttempt(session.objectiveId, job.sessionId, job.runtimeId, job.fallbackOfAttemptId);
  }

  private async startRetryAttempt(objectiveId: string, sessionId: string, runtime: string, fallbackOfAttemptId: string | null): Promise<void> {
    const objective = this.objectives.getById(objectiveId)!;
    const project = this.projects.getById(objective.projectId);
    const session = this.sessions.getById(sessionId)!;
    const original = session.executionSelection;
    let selection;
    try {
      if (original?.decision?.mode === 'EXPLICIT' && runtime === original.runtimeId) {
        selection = this.catalog?.resolve(original);
      } else {
        selection = this.runtimeSelector?.selectForRuntime(runtime, { projectId: objective.projectId, objectiveText: objective.objectiveText, stopCondition: objective.stopCondition, defaultRuntime: runtime });
      }
    }
    catch (error) { throw new SessionStateError(error instanceof Error ? error.message : 'Fallback non utilizzabile'); }
    if (!selection) throw new SessionStateError('Catalogo runtime non disponibile');
    const provider = this.providers.require(selection.runtimeId);
    let attempt: import('../domain/execution-attempt.js').ExecutionAttempt | null = null;
    const pendingEvents: ExecutionEvent[] = [];
    // §19: retry/fallback riusano la stessa workspace dell'Objective (§19.2):
    // il lavoro già prodotto non viene perso né ricreato.
    let executionPath = project?.repositoryPath ?? null;
    let workspace: import('../domain/workspace.js').AgentWorkspace | null = null;
    if (this.worktrees) {
      try {
        const resolved = await this.worktrees.resolveExecutionPath(project, objective, session);
        executionPath = resolved.path ?? executionPath;
        workspace = resolved.workspace;
      } catch (error) {
        if (error instanceof WorktreeError) throw new SessionStateError(error.message);
        throw error;
      }
    }
    const handle = await provider.start({ objectiveId, projectPath: executionPath, objectiveText: objective.objectiveText, stopCondition: objective.stopCondition, providerId: selection.providerId, model: selection.modelId,
      heartbeatIntervalMs: Math.max(100, Math.floor(session.heartbeatIntervalMs / 2)),
      onEvent: (event) => {
        if (event.type === 'approval') {
          this.registerRuntimeApproval(objectiveId, sessionId, handle.processReference, event);
          if (attempt) this.supervisor.recordProgress(attempt, 'progress', { message: event.message ?? null, metadata: event.metadata ?? null });
          return;
        }
        if (event.type === 'heartbeat') {
          this.sessions.touchHeartbeat(sessionId);
          this.sessions.touchActivity(sessionId);
          return;
        }
        if (!attempt) {
          pendingEvents.push(event);
          return;
        }
        this.supervisor.recordProgress(attempt, event.type, { message: event.message ?? null, metadata: event.metadata ?? null });
      },
    });
    this.sessions.setExecutionSelection(sessionId, selection);
    this.sessions.setProcessReference(sessionId, handle.processReference, selection.runtimeId);
    if (workspace) {
      this.sessions.setWorkspaceId(sessionId, workspace.id);
      this.worktrees?.attachSession(workspace.id, sessionId);
    }
    attempt = await this.supervisor.startAttempt(this.sessions.getById(sessionId)!, {
      runtimeType: handle.descriptor.runtimeType, runtimeName: handle.descriptor.runtimeName, providerName: this.catalog?.providerName(selection.runtimeId, selection.providerId) ?? handle.descriptor.providerName,
      modelName: selection.modelId, processReference: handle.processReference, fallbackOfAttemptId,
      metadata: { source: 'process-supervisor.retry', selection, selectionReason: fallbackOfAttemptId ? 'Ri-selezione automatica per fallback (M18)' : (selection.decision?.mode === 'AUTOMATIC' ? 'Ri-selezione automatica per retry (M18)' : 'Retry della selezione validata'), backoffApplied: true, ...(workspace ? { workspaceId: workspace.id, workspacePath: workspace.worktreePath, workspaceBranch: workspace.branch } : {}) },
    });
    for (const event of pendingEvents) {
      if (event.type === 'approval') continue;
      this.supervisor.recordProgress(attempt, event.type, { message: event.message ?? null, metadata: event.metadata ?? null });
    }
    this.sessions.touchHeartbeat(sessionId);
    this.sessions.touchActivity(sessionId);
    void handle.completion.then((result) => this.applyRuntimeResult(objectiveId, sessionId, result)).catch(() => undefined);
  }

  /** M19: riprova un obiettivo in errore, ri-selezionando (o usando l'override) e riavviando. */
  async retry(objectiveId: string, selectionOverride?: Partial<ExecutionSelection> & { runtimeId: string }): Promise<SessionTransition> {
    const objective = this.objectives.getById(objectiveId);
    if (!objective) throw new SessionStateError('Obiettivo non trovato');
    if (objective.status !== 'ERRORE' && objective.status !== 'IN_AVVIO') {
      throw new SessionStateError('Obiettivo non riprovabile nello stato corrente');
    }

    const failedSession = this.sessions.listByObjective(objectiveId).slice(-1)[0] ?? null;
    const heartbeatIntervalMs = failedSession?.heartbeatIntervalMs ?? 30000;

    let selection: ExecutionSelection | undefined;
    try {
      if (selectionOverride) {
        selection = this.catalog?.resolve({
          runtimeId: selectionOverride.runtimeId,
          providerId: selectionOverride.providerId,
          modelId: selectionOverride.modelId ?? null,
          outputTokenLimit: selectionOverride.outputTokenLimit ?? null,
          decision: {
            mode: 'EXPLICIT',
            reason: `Riprova con selezione modificata: ${selectionOverride.runtimeId}/${selectionOverride.providerId ?? 'provider'}/${selectionOverride.modelId ?? 'modello-runtime'}`,
            selectedScore: null,
            requiredCapabilities: [],
            budget: { policy: { costBudget: null, warningPercent: 80, action: 'WARN' }, spent: 0, remaining: null },
            candidates: [],
            decidedAt: new Date().toISOString(),
          },
        });
      } else if (this.runtimeSelector) {
        selection = this.runtimeSelector.select({ projectId: objective.projectId, objectiveText: objective.objectiveText, stopCondition: objective.stopCondition, defaultRuntime: failedSession?.agentType ?? 'cline' });
      } else {
        selection = this.catalog?.resolve({ runtimeId: failedSession?.agentType ?? 'cline' });
      }
    }
    catch (error) { throw new SessionStateError(error instanceof Error ? error.message : 'Selezione runtime non utilizzabile'); }
    if (!selection) throw new SessionStateError('Catalogo runtime non disponibile');

    this.objectives.setStatus(objectiveId, 'IN_AVVIO');
    // §4.2 V2: stato progetto derivato dagli obiettivi reali.
    this.projects.setStatus(objective.projectId, {
      status: deriveProjectStatus(this.objectives.listByProject(objective.projectId)),
    });
    const session = this.sessions.createWithHeartbeat(objectiveId, selection.runtimeId, heartbeatIntervalMs, selection);
    return this.start(objectiveId, session.id);
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
