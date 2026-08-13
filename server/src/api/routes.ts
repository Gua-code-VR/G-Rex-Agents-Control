import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  ObjectiveConflictError,
  ObjectiveStateError,
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
}

/** API REST di M4 (Web App/API, §7): registro progetti, obiettivi, sessioni
 *  agente e checkpoint (§5/§6/§12-M4). */
export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/execution-providers', async () => ({ providers: deps.providers.list() }));
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
    return {
      generatedAt: new Date().toISOString(),
      projectsCount: projects.length,
      projectsByStatus,
      projectsByGroup,
      eventsCount: deps.events.count(),
      // M4: decisioni umane ancora da prendere (checkpoint PENDING_DECISION).
      pendingDecisions: deps.checkpoints.countPending(),
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

  app.post('/api/projects', async (req, reply) => {
    try {
      const project = deps.projects.register(req.body);
      return reply.code(201).send({ project });
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

  app.patch('/api/projects/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const project = deps.projects.setStatus(id, req.body);
      if (!project) {
        return reply.code(404).send({ message: 'Progetto non trovato' });
      }
      return { project };
    } catch (err) {
      if (err instanceof ZodError) {
        return reply
          .code(400)
          .send({ message: 'Stato non valido: usa uno degli stati ufficiali' });
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
      const created = await deps.objectives.create(id, req.body);
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof ObjectiveConflictError) {
        return reply.code(409).send({ message: err.message });
      }
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

  app.get('/api/objectives/:id/checkpoints', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.objectives.getById(id)) {
      return reply.code(404).send({ message: 'Obiettivo non trovato' });
    }
    return { checkpoints: deps.checkpoints.listByObjective(id) };
  });

  app.post('/api/objectives/:id/sessions/:sessionId/start', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    try {
      const transition = await deps.agentSessions.start(id, sessionId);
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
      const cancelled = deps.objectives.cancel(id);
      if (!cancelled) {
        return reply.code(404).send({ message: 'Obiettivo non trovato' });
      }
      return cancelled;
    } catch (err) {
      if (err instanceof ObjectiveStateError) {
        return reply.code(400).send({ message: err.message });
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
}
