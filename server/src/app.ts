import cors from '@fastify/cors';
import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventService } from './application/event-service.js';
import { GitStatusService } from './application/git-status-service.js';
import { ProjectService } from './application/project-service.js';
import { registerRoutes } from './api/routes.js';
import { loadConfig, type AppConfig } from './config.js';
import { openDatabase } from './infrastructure/db/connection.js';
import { SqliteProjectRepository } from './infrastructure/db/project-repo.js';

export interface AppServices {
  db: DatabaseSync;
  events: EventService;
  projects: ProjectService;
  gitStatus: GitStatusService;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: AppServices;
}

/**
 * Costruisce l'applicazione (Web App/API) con le sue dipendenze.
 * Il bind di rete è deciso dal chiamante (in produzione: 127.0.0.1).
 */
export async function buildApp(config: AppConfig = loadConfig()): Promise<BuiltApp> {
  const db = openDatabase(config.dbPath);
  const events = new EventService(db);
  const projectRepository = new SqliteProjectRepository(db);
  const projects = new ProjectService(projectRepository, events);
  const gitStatus = new GitStatusService(projectRepository, events);

  const app = Fastify({ logger: { level: config.logLevel } });

  // CORS limitato alle origini locali: nessuna esposizione pubblica (§14).
  await app.register(cors, {
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
  });

  registerRoutes(app, { projects, events, gitStatus, config });

  return { app, services: { db, events, projects, gitStatus } };
}