import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  ObjectiveStateError,
  type CreatedObjective,
  type ObjectiveService,
} from '../application/objective-service.js';
import {
  SessionStateError,
  type AgentSessionService,
} from '../application/agent-session-service.js';
import {
  DecisionStateError,
  DecisionTerminalError,
  type DecisionService,
} from '../application/decision-service.js';
import { GitRefreshError, type GitStatusService } from '../application/git-status-service.js';
import type { EventService } from '../application/event-service.js';
import type { ProjectService } from '../application/project-service.js';
import type { CheckpointRepository } from '../infrastructure/db/checkpoint-repo.js';
import { PROJECT_GROUPS, PROJECT_STATUSES } from '../domain/project.js';
import { SCHEMA_VERSION } from '../infrastructure/db/schema.js';
import type { AppConfig } from '../config.js';
import { EVENT_CATEGORIES, type EventCategory } from '../application/event-service.js';
import type { NotificationService } from '../application/notification-service.js';
import type { BackupService } from '../application/backup-service.js';
import type { ExecutionProviderRegistry } from '../integrations/execution-provider.js';
import type { ExecutionAttemptRepository } from '../infrastructure/db/execution-attempt-repo.js';
import type { ProcessSupervisor } from '../application/process-supervisor.js';
import type { GovernanceService } from '../application/governance-service.js';
import type { ExecutionQueueWorker } from '../application/execution-queue-worker.js';
import { WorktreeError, type WorktreeService } from '../application/worktree-service.js';
import { normalizeModelId, type ProviderCatalogService } from '../application/provider-catalog-service.js';

export interface ApiDeps {
  projects: ProjectService;
  events: EventService;
  gitStatus: GitStatusService;
  objectives: ObjectiveService;
  agentSessions: AgentSessionService;
  decisions: DecisionService;
  checkpoints: CheckpointRepository;
  config: AppConfig;
  notifications: NotificationService;
  backups: BackupService;
  providers: ExecutionProviderRegistry;
  attempts: ExecutionAttemptRepository;
  supervisor: ProcessSupervisor;
  governance: GovernanceService;
  catalog: ProviderCatalogService;
  queueWorker: ExecutionQueueWorker;
  workspaces: WorktreeService;
}

/** API REST di M4 (Web App/API, §7): registro progetti, obiettivi, sessioni
 *  agente e checkpoint (§5/§6/§12-M4). */
export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/execution-providers', async () => ({ providers: deps.providers.list() }));
  app.get('/api/provider-catalog', async () => ({ catalog: deps.catalog.list() }));
  app.post('/api/provider-catalog/estimate', async (req, reply) => {
    const body = req.body as { runtimeId?: string; objectiveText?: string; stopCondition?: string | null } | undefined;
    if (!body?.runtimeId || !body.objectiveText) return reply.code(400).send({ message: 'Runtime e obiettivo sono obbligatori' });
    try { return { estimate: deps.catalog.estimate(body.runtimeId, body.objectiveText, body.stopCondition ?? null) }; }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : 'Stima non disponibile' }); }
  });
  app.get('/api/sessions/:id/execution-attempts', async (req) => ({ attempts: deps.attempts.listBySession((req.params as { id: string }).id) }));
  app.get('/api/sessions/:id/execution-metrics', async (req) => ({ metrics: deps.supervisor.totals((req.params as { id: string }).id) }));

  // Approvazioni runtime pendenti (§19 spec): richieste inoltrate dal runtime
  // in attesa di decisione umana, con azione Approva/Rifiuta.
  app.get('/api/runtime-approvals', async () => ({ approvals: deps.agentSessions.listRuntimeApprovals() }));
  app.post('/api/runtime-approvals/:id/decide', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { approved?: boolean } | undefined;
    if (typeof body?.approved !== 'boolean') return reply.code(400).send({ message: 'Campo `approved` booleano obbligatorio' });
    const result = await deps.agentSessions.decideRuntimeApproval(id, body.approved);
    if (!result) return reply.code(404).send({ message: 'Approvazione runtime non trovata' });
    return result;
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'g-rex-agent-control',
    version: '0.4.0',
    schemaVersion: SCHEMA_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/status', async () => {
    const projects = deps.projects.list();
    const projectsByStatus = Object.fromEntries(
      PROJECT_STATUSES.map((status) => [
        status,
        projects.filter((p) => p.status === status).length,
      ]),
    );
    const projectsByGroup = Object.fromEntries(
      PROJECT_GROUPS.map((group) => [
        group,
        projects.filter((p) => p.statusGroup === group).length,
      ]),
    );
    const dbExists = fs.existsSync(deps.config.dbPath);
    const dbSizeBytes = dbExists ? fs.statSync(deps.config.dbPath).size : 0;
    const pendingCheckpoints = deps.checkpoints.countPending();
    return {
      generatedAt: new Date().toISOString(),
      projectsCount: projects.length,
      projectsByStatus,
      projectsByGroup,
      eventsCount: deps.events.count(),
      // M4: decisioni umane ancora da prendere (checkpoint PENDING_DECISION).
      pendingDecisions: pendingCheckpoints,
      // §5 V2: numero esatto di azioni umane realmente pendenti (fonte unica
      // per badge e KPI): checkpoint + approvazioni budget + approvazioni
      // runtime. Notifiche non lette e sessioni STALE NON vi rientrano.
      requiresYouCount:
        pendingCheckpoints
        + deps.governance.countPendingApprovals()
        + deps.agentSessions.countRuntimeApprovals(),
      // Costo live rilevato oggi (fonte unica per l'header).
      costToday: deps.attempts.sumCostToday(),
      storage: {
        dbPath: deps.config.dbPath,
        exists: dbExists,
        fileSizeBytes: dbSizeBytes,
      },
    };
  });

  app.get('/api/projects', async () => ({ projects: deps.projects.list() }));

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = deps.projects.getById(id);
    if (!project) {
      return reply.code(404).send({ message: 'Progetto non trovato' });
    }
    return { project };
  });

  app.get('/api/projects/:id/governance', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.projects.getById(id)) return reply.code(404).send({ message: 'Progetto non trovato' });
    return { governance: deps.governance.dashboard(id) };
  });
  app.get('/api/governance/portfolio', async () => ({ projects: deps.governance.portfolio() }));
  app.get('/api/governance/approvals', async (req) => ({ approvals: deps.governance.listApprovals((req.query as { objectiveId?: string } | undefined)?.objectiveId) }));
  app.post('/api/governance/approvals/:id/decide', async (req, reply) => {
    const body = req.body as { approve?: boolean; note?: string } | undefined;
    if (!body || typeof body.approve !== 'boolean') return reply.code(400).send({ message: 'Decisione di governance non valida' });
    const approval = deps.governance.decideApproval((req.params as { id: string }).id, body.approve, body.note);
    return approval ? { approval } : reply.code(404).send({ message: 'Richiesta di approvazione non trovata o già decisa' });
  });

  app.put('/api/projects/:id/policy', async (req, reply) => {
    try { const policy = deps.governance.setPolicy('PROJECT', (req.params as { id: string }).id, req.body); return policy ? { policy } : reply.code(404).send({ message: 'Progetto non trovato' }); }
    catch (err) { if (err instanceof ZodError) return reply.code(400).send({ message: 'Policy non valida', issues: err.issues }); throw err; }
  });

  app.post('/api/projects', async (req, reply) => {
    try {
      const project = deps.projects.register(req.body);

      // Associa il repository (stato Git essenziale) quando è indicato un percorso.
      // Best-effort: un percorso non valido registra l'errore nello snapshot senza
      // impedire la creazione del progetto.
      let repositoryAssociated = false;
      if (project.repositoryPath) {
        try {
          await deps.gitStatus.refresh(project.id);
          repositoryAssociated = true;
        } catch {
          repositoryAssociated = false;
        }
      }

      // Crea l'obiettivo iniziale quando fornito («Obiettivo iniziale») e lo
      // avvia automaticamente senza richiedere la conferma ordinaria della
      // selezione (§11.2): parte subito se esiste almeno un worker disponibile,
      // altrimenti resta IN_AVVIO in coda e la coda di esecuzione lo avvia
      // appena un worker si libera.
      let initialObjective: (CreatedObjective & { autoStart: { started: boolean } }) | null = null;
      if (project.currentObjective) {
        try {
          const created = await deps.objectives.create(project.id, {
            // Il testo completo diventa l'objectiveText (limite 50.000, §2.2);
            // il titolo è una semplice etichetta breve, quindi ne deriviamo
            // un prefisso senza troncare mai l'objectiveText.
            title: project.currentObjective.slice(0, 200),
            objectiveText: project.currentObjective,
          });
          let state: CreatedObjective = created;
          let started = false;
          try {
            const result = await deps.agentSessions.tryAutoStart(created.objective.id, created.session.id);
            if (result.started && result.transition) {
              state = {
                objective: result.transition.objective,
                session: result.transition.session,
                project: result.transition.project,
              };
              started = true;
            }
          } catch {
            // Best-effort: se l'avvio automatico fallisce (es. governance)
            // l'obiettivo resta IN_AVVIO in coda.
            started = false;
          }
          initialObjective = { ...state, autoStart: { started } };
        } catch {
          // Best-effort: se la creazione dell'obiettivo fallisce, il progetto
          // resta valido e l'operatore può crearne uno in seguito.
          initialObjective = null;
        }
      }

      const persisted = deps.projects.getById(project.id) ?? project;
      return reply.code(201).send({
        project: persisted,
        repositoryAssociated,
        initialObjective,
      });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ message: 'Dati non validi', issues: err.issues });
      }
      const e = err as { errcode?: number };
      // node:sqlite espone il codice esteso SQLite: 2067 = SQLITE_CONSTRAINT_UNIQUE
      if (e.errcode === 2067) {
        return reply
          .code(409)
          .send({ message: 'Esiste già un progetto con lo stesso nome' });
      }
      throw err;
    }
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const project = deps.projects.update(id, req.body);
      if (!project) {
        return reply.code(404).send({ message: 'Progetto non trovato' });
      }
      return { project };
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ message: 'Dati non validi', issues: err.issues });
      }
      throw err;
    }
  });

  app.post('/api/projects/:id/git-status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = deps.projects.getById(id);
    if (!exists) {
      return reply.code(404).send({ message: 'Progetto non trovato' });
    }
    try {
      const project = await deps.gitStatus.refresh(id);
      return { project };
    } catch (err) {
      if (err instanceof GitRefreshError) {
        return reply.code(400).send({ message: err.message });
      }
      throw err;
    }
  });

  app.get('/api/projects/:id/objectives', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.projects.getById(id)) {
      return reply.code(404).send({ message: 'Progetto non trovato' });
    }
    return { objectives: deps.objectives.listByProject(id) };
  });

  app.post('/api/projects/:id/objectives', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      // Coda di esecuzione (§11.2): la selezione viene proposta in automatico
      // e l'obiettivo parte subito se esiste almeno un worker disponibile.
      // Altrimenti resta IN_AVVIO («In attesa di avvio») e la coda di
      // esecuzione lo avvia appena un worker si libera.
      const created = await deps.objectives.create(id, req.body);
      try {
        const result = await deps.agentSessions.tryAutoStart(created.objective.id, created.session.id);
        if (result.started && result.transition) {
          return reply.code(201).send({
            objective: result.transition.objective,
            session: result.transition.session,
            project: result.transition.project,
            autoStart: { started: true },
          });
        }
      } catch {
        // Best-effort: se l'avvio automatico fallisce l'obiettivo resta
        // IN_AVVIO in coda (l'operatore può ancora avviarlo manualmente).
      }
      return reply.code(201).send({
        ...created,
        autoStart: { started: false },
      });
    } catch (err) {
      if (err instanceof ObjectiveStateError) {
        return reply.code(404).send({ message: err.message });
      }
      if (err instanceof ZodError) {
        return reply
          .code(400)
          .send({ message: "Dati dell'obiettivo non validi", issues: err.issues });
      }
      throw err;
    }
  });

  app.get('/api/objectives/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = deps.objectives.getWithSessions(id);
    if (!detail) {
      return reply.code(404).send({ message: 'Obiettivo non trovato' });
    }
    // M4: il dettaglio espone anche i checkpoint dell'obiettivo.
    return { ...detail, checkpoints: deps.checkpoints.listByObjective(id) };
  });

  app.put('/api/objectives/:id/policy', async (req, reply) => {
    try { const policy = deps.governance.setPolicy('OBJECTIVE', (req.params as { id: string }).id, req.body); return policy ? { policy } : reply.code(404).send({ message: 'Obiettivo non trovato' }); }
    catch (err) { if (err instanceof ZodError) return reply.code(400).send({ message: 'Policy non valida', issues: err.issues }); throw err; }
  });

  app.post('/api/objectives/:id/governance/exceptions', async (req, reply) => {
    try { const exception = deps.governance.grantException((req.params as { id: string }).id, (req.body ?? {}) as { note?: string; expiresAt?: string | null }); return exception ? reply.code(201).send({ exception }) : reply.code(404).send({ message: 'Obiettivo non trovato' }); }
    catch (err) { return reply.code(400).send({ message: err instanceof Error ? err.message : 'Eccezione non valida' }); }
  });
  app.get('/api/objectives/:id/governance/exceptions', async (req) => ({ exceptions: deps.governance.listExceptions((req.params as { id: string }).id) }));
  app.post('/api/governance/exceptions/:id/revoke', async (req, reply) => {
    const exception = deps.governance.revokeException((req.params as { id: string }).id, (req.body as { note?: string } | undefined)?.note);
    return exception ? { exception } : reply.code(404).send({ message: 'Eccezione non trovata o già revocata' });
  });

  app.get('/api/objectives/:id/checkpoints', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.objectives.getById(id)) {
      return reply.code(404).send({ message: 'Obiettivo non trovato' });
    }
    return { checkpoints: deps.checkpoints.listByObjective(id) };
  });

  app.post('/api/objectives/:id/sessions/:sessionId/start', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    // M19: conferma della selezione. Il body può contenere un override
    // { runtimeId, providerId, modelId, outputTokenLimit? } quando l'utente
    // modifica la combinazione proposta prima di avviare.
    const body = (req.body ?? {}) as { runtimeId?: string; providerId?: string; modelId?: string | null; outputTokenLimit?: number | null };
    const override = body.runtimeId
      ? { runtimeId: body.runtimeId, providerId: body.providerId, modelId: normalizeModelId(body.modelId), outputTokenLimit: body.outputTokenLimit ?? null }
      : undefined;
    try {
      const transition = await deps.agentSessions.start(id, sessionId, override);
      return {
        objective: transition.objective,
        session: transition.session,
        project: transition.project,
        checkpoint: transition.checkpoint,
      };
    } catch (err) {
      if (err instanceof SessionStateError) {
        return reply.code(400).send({ message: err.message });
      }
      throw err;
    }
  });

  app.post('/api/objectives/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    // M19: «Riprova»/«Cambia agente» su un errore tecnico. Il body può
    // contenere un override { runtimeId, providerId, modelId } quando l'utente
    // cambia agente; senza override viene ri-selezionato automaticamente.
    const body = (req.body ?? {}) as { runtimeId?: string; providerId?: string; modelId?: string | null; outputTokenLimit?: number | null };
    const override = body.runtimeId
      ? { runtimeId: body.runtimeId, providerId: body.providerId, modelId: normalizeModelId(body.modelId), outputTokenLimit: body.outputTokenLimit ?? null }
      : undefined;
    try {
      // Risolve i checkpoint pendenti (decisione RETRY) prima di riprovare.
      const pending = deps.checkpoints.listByObjective(id).filter((c) => c.status === 'PENDING_DECISION');
      for (const checkpoint of pending) {
        deps.decisions.decide(checkpoint.id, { decisionType: 'RETRY', note: 'Riprova avviata' });
      }
      const transition = await deps.agentSessions.retry(id, override);
      return {
        objective: transition.objective,
        session: transition.session,
        project: transition.project,
        checkpoint: transition.checkpoint,
      };
    } catch (err) {
      if (err instanceof SessionStateError) {
        return reply.code(400).send({ message: err.message });
      }
      if (err instanceof DecisionStateError || err instanceof DecisionTerminalError) {
        return reply.code(409).send({ message: err.message });
      }
      throw err;
    }
  });

  app.post('/api/objectives/:id/sessions/:sessionId/heartbeat', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    try {
      return { session: await deps.agentSessions.heartbeat(id, sessionId) };
    } catch (err) {
      if (err instanceof SessionStateError) return reply.code(400).send({ message: err.message });
      throw err;
    }
  });

  app.post('/api/objectives/:id/sessions/:sessionId/stop', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    try {
      const transition = await deps.agentSessions.stop(id, sessionId, req.body ?? {});
      return {
        objective: transition.objective,
        session: transition.session,
        project: transition.project,
        checkpoint: transition.checkpoint,
      };
    } catch (err) {
      if (err instanceof SessionStateError) {
        return reply.code(400).send({ message: err.message });
      }
      if (err instanceof ZodError) {
        return reply.code(400).send({ message: 'Dati non validi', issues: err.issues });
      }
      throw err;
    }
  });

  app.post('/api/objectives/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const transition = await deps.agentSessions.complete(id, req.body ?? {});
      return {
        objective: transition.objective,
        session: transition.session,
        project: transition.project,
        checkpoint: transition.checkpoint,
      };
    } catch (err) {
      if (err instanceof SessionStateError) {
        return reply.code(400).send({ message: err.message });
      }
      if (err instanceof ZodError) {
        return reply.code(400).send({ message: 'Report non valido', issues: err.issues });
      }
      throw err;
    }
  });

  app.post('/api/objectives/:id/block', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const transition = await deps.agentSessions.block(id, req.body ?? {});
      return {
        objective: transition.objective,
        session: transition.session,
        project: transition.project,
        checkpoint: transition.checkpoint,
      };
    } catch (err) {
      if (err instanceof SessionStateError) {
        return reply.code(400).send({ message: err.message });
      }
      if (err instanceof ZodError) {
        return reply.code(400).send({ message: 'Dati non validi', issues: err.issues });
      }
      throw err;
    }
  });

  app.post('/api/objectives/:id/fail', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const transition = await deps.agentSessions.fail(id, req.body ?? {});
      return {
        objective: transition.objective,
        session: transition.session,
        project: transition.project,
        checkpoint: transition.checkpoint,
      };
    } catch (err) {
      if (err instanceof SessionStateError) {
        return reply.code(400).send({ message: err.message });
      }
      if (err instanceof ZodError) {
        return reply.code(400).send({ message: 'Dati non validi', issues: err.issues });
      }
      throw err;
    }
  });

  app.post('/api/objectives/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      // Chiude anche i checkpoint pendenti (decisione CANCEL) così l'obiettivo
      // annullato non resta in «Richiede te» (§5.1 V2: nessuna azione residua).
      // DecideForcefully è necessario perché l'annullamento è l'azione esplicita
      // che legittima la chiusura anche di eventuali checkpoint obsoleti.
      const pending = deps.checkpoints.listByObjective(id).filter((c) => c.status === 'PENDING_DECISION');
      for (const checkpoint of pending) {
        try {
          deps.decisions.decide(checkpoint.id, { decisionType: 'CANCEL', note: 'Obiettivo annullato' });
        } catch (err) {
          if (err instanceof DecisionTerminalError) continue;
          if (err instanceof DecisionStateError) {
            deps.decisions.decideForcefully(checkpoint.id, { decisionType: 'CANCEL', note: 'Obiettivo annullato (checkpoint obsoleto)' });
            continue;
          }
          throw err;
        }
      }
      const cancelled = deps.objectives.cancel(id);
      if (!cancelled) {
        return reply.code(404).send({ message: 'Obiettivo non trovato' });
      }
      return cancelled;
    } catch (err) {
      if (err instanceof ObjectiveStateError) {
        return reply.code(400).send({ message: err.message });
      }
      if (err instanceof DecisionStateError || err instanceof DecisionTerminalError) {
        return reply.code(409).send({ message: err.message });
      }
      throw err;
    }
  });

  app.get('/api/checkpoints', async (req) => {
    const query = req.query as { limit?: string | number; status?: string } | undefined;
    const raw = query?.limit;
    const parsed = typeof raw === 'string' ? Number(raw) : Number(raw ?? 50);
    const limit = Number.isFinite(parsed) && parsed >= 1 ? parsed : 50;
    return { checkpoints: deps.checkpoints.listRecent(limit, query?.status) };
  });

  // ── M5: Decisione umana su checkpoint ─────────────────────────────────
  app.post('/api/checkpoints/:id/decide', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = deps.decisions.decide(id, req.body ?? {});
      return reply.code(200).send({
        checkpoint: result.checkpoint,
        decision: result.decision,
        objective: result.objective,
        project: result.project,
      });
    } catch (err) {
      if (err instanceof DecisionStateError) {
        return reply.code(400).send({ message: err.message });
      }
      if (err instanceof DecisionTerminalError) {
        return reply.code(409).send({ message: err.message });
      }
      if (err instanceof ZodError) {
        return reply.code(400).send({ message: 'Dati non validi', issues: err.issues });
      }
      throw err;
    }
  });

  app.get('/api/events', async (req) => {
    const query = req.query as {
      limit?: string | number;
      projectId?: string;
      objectiveId?: string;
      sessionId?: string;
      category?: string;
    } | undefined;
    const raw = query?.limit;
    const parsed = typeof raw === 'string' ? Number(raw) : Number(raw ?? 50);
    const limit = Number.isFinite(parsed) && parsed >= 1 ? parsed : 50;
    const projectId = query?.projectId ? String(query.projectId) : null;
    const objectiveId = query?.objectiveId ? String(query.objectiveId) : null;
    const sessionId = query?.sessionId ? String(query.sessionId) : null;
    const category = EVENT_CATEGORIES.includes(query?.category as EventCategory)
      ? query?.category as EventCategory : null;
    return {
      events: deps.events.recent(limit, projectId, objectiveId, sessionId, category),
    };
  });

  app.get('/api/notifications', async (req) => {
    const query = req.query as { limit?: string | number } | undefined;
    const limit = Number(query?.limit ?? 50);
    return { notifications: deps.notifications.getUnreadNotifications(Number.isFinite(limit) ? limit : 50) };
  });

  app.post('/api/notifications/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    const notification = deps.notifications.markAsRead(id);
    if (!notification) return reply.code(404).send({ message: 'Notifica non trovata' });
    return { notification };
  });

  app.post('/api/notifications/read-all', async () => ({ count: deps.notifications.markAllAsRead() }));
  app.post('/api/backups', async (_req, reply) => reply.code(201).send({ backup: deps.backups.create() }));

  // ── §19: workspace Git isolate ─────────────────────────────────────
  app.get('/api/workspaces', async () => ({ workspaces: deps.workspaces.list() }));
  app.get('/api/projects/:id/workspaces', async (req) => {
    const { id } = req.params as { id: string };
    return { workspaces: deps.workspaces.listByProject(id) };
  });

  // Riconciliazione esplicita dello stato persistito con i worktree reali
  // (§19.5): utile dopo un crash o come verifica manuale.
  app.post('/api/workspaces/reconcile', async () => ({
    reconciled: await deps.workspaces.reconcile(),
  }));

  app.post('/api/workspaces/:id/cleanup', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { force?: boolean };
    try {
      const workspace = await deps.workspaces.cleanup(id, body.force === true);
      if (!workspace) return reply.code(404).send({ message: 'Workspace non trovata' });
      return { workspace };
    } catch (err) {
      if (err instanceof WorktreeError) {
        return reply.code(409).send({ message: err.message });
      }
      return reply.code(400).send({ message: err instanceof Error ? err.message : 'Rimozione non riuscita' });
    }
  });
}
