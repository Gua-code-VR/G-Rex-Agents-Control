import cors from '@fastify/cors';
import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { AgentSessionService } from './application/agent-session-service.js';
import { CheckpointService } from './application/checkpoint-service.js';
import { DecisionService } from './application/decision-service.js';
import { EventService } from './application/event-service.js';
import { GitStatusService } from './application/git-status-service.js';
import { ObjectiveService } from './application/objective-service.js';
import { ProjectService } from './application/project-service.js';
import { registerRoutes } from './api/routes.js';
import { loadConfig, type AppConfig } from './config.js';
import { ClineAdapter, FakeAgentAdapter, type AgentAdapter } from './integrations/agent-adapter.js';
import { openDatabase } from './infrastructure/db/connection.js';
import { SqliteCheckpointRepository } from './infrastructure/db/checkpoint-repo.js';
import { SqliteDecisionRepository } from './infrastructure/db/decision-repo.js';
import {
  SqliteObjectiveRepository,
  SqliteSessionRepository,
} from './infrastructure/db/objective-repo.js';
import { SqliteProjectRepository } from './infrastructure/db/project-repo.js';

export interface AppServices {
  db: DatabaseSync;
  events: EventService;
  projects: ProjectService;
  gitStatus: GitStatusService;
  objectives: ObjectiveService;
  agentSessions: AgentSessionService;
  checkpoints: CheckpointService;
  agent: AgentAdapter;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: AppServices;
}

/** Seleziona l'adapter agente (§8 e §14): fake per demo/test, Cline in produzione. */
export function buildAgentAdapter(config: AppConfig): AgentAdapter {
  if (config.agentMode === 'fake') {
    return new FakeAgentAdapter();
  }
  return new ClineAdapter(config.clineCommand, config.clineEnabled);
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
  const objectiveRepository = new SqliteObjectiveRepository(db);
  const sessionRepository = new SqliteSessionRepository(db);
  const checkpointRepository = new SqliteCheckpointRepository(db);
  const checkpoints = new CheckpointService(checkpointRepository, events);
  const decisionRepository = new SqliteDecisionRepository(db);
  const decisions = new DecisionService(
    decisionRepository,
    checkpointRepository,
    objectiveRepository,
    sessionRepository,
    projects,
    events,
  );
  const agent = buildAgentAdapter(config);
  const objectives = new ObjectiveService(
    objectiveRepository,
    sessionRepository,
    projects,
    gitStatus,
    events,
    agent,
  );
  const agentSessions = new AgentSessionService(
    objectiveRepository,
    sessionRepository,
    projects,
    gitStatus,
    events,
    agent,
    checkpoints,
  );

  const app = Fastify({ logger: { level: config.logLevel } });

  // CORS limitato alle origini locali: nessuna esposizione pubblica (§14).
  await app.register(cors, {
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
  });

  registerRoutes(app, {
    projects,
    events,
    gitStatus,
    objectives,
    agentSessions,
    decisions,
    checkpoints: checkpointRepository,
    config,
  });

  return {
    app,
    services: {
      db,
      events,
      projects,
      gitStatus,
      objectives,
      agentSessions,
      checkpoints,
      agent,
    },
  };
}