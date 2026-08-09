import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { GitRefreshError, type GitStatusService } from '../application/git-status-service.js';
import type { EventService } from '../application/event-service.js';
import type { ProjectService } from '../application/project-service.js';
import { PROJECT_GROUPS, PROJECT_STATUSES } from '../domain/project.js';
import { SCHEMA_VERSION } from '../infrastructure/db/schema.js';
import type { AppConfig } from '../config.js';

export interface ApiDeps {
  projects: ProjectService;
  events: EventService;
  gitStatus: GitStatusService;
  config: AppConfig;
}

/** API REST di M2 (Web App/API, §7): registrazione, stato e Git essenziale. */
export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'g-rex-agent-control',
    version: '0.2.0',
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

  app.get('/api/events', async (req) => {
    const query = req.query as { limit?: string | number } | undefined;
    const raw = query?.limit;
    const parsed = typeof raw === 'string' ? Number(raw) : Number(raw ?? 50);
    const limit = Number.isFinite(parsed) && parsed >= 1 ? parsed : 50;
    return { events: deps.events.recent(limit) };
  });
}