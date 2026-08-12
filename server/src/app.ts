import cors from '@fastify/cors';
import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { AgentSessionService } from './application/agent-session-service.js';
import { AuthService } from './application/auth-service.js';
import { CheckpointService } from './application/checkpoint-service.js';
import { DecisionService } from './application/decision-service.js';
import { EventService } from './application/event-service.js';
import { GitStatusService } from './application/git-status-service.js';
import { ObjectiveService } from './application/objective-service.js';
import { ProjectService } from './application/project-service.js';
import { registerAuthRoutes, parseCookieToken } from './api/auth-routes.js';
import { registerRoutes } from './api/routes.js';
import { loadConfig, type AppConfig } from './config.js';
import { ClineAdapter, FakeAgentAdapter, type AgentAdapter } from './integrations/agent-adapter.js';
import { openDatabase } from './infrastructure/db/connection.js';
import { AuthRepository } from './infrastructure/db/auth-repo.js';
import { SqliteCheckpointRepository } from './infrastructure/db/checkpoint-repo.js';
import { SqliteDecisionRepository } from './infrastructure/db/decision-repo.js';
import {
  SqliteObjectiveRepository,
  SqliteSessionRepository,
} from './infrastructure/db/objective-repo.js';
import { SqliteProjectRepository } from './infrastructure/db/project-repo.js';
import { SqliteExecutionAttemptRepository } from './infrastructure/db/execution-attempt-repo.js';
import { ProcessSupervisor } from './application/process-supervisor.js';
import { NotificationService } from './application/notification-service.js';
import { SqliteNotificationRepository } from './infrastructure/db/notification-repo.js';
import { BackupService } from './application/backup-service.js';
import { StaleSessionDetector, StartupRecoveryService } from './application/stale-detector.js';

export interface AppServices {
  db: DatabaseSync;
  events: EventService;
  projects: ProjectService;
  gitStatus: GitStatusService;
  objectives: ObjectiveService;
  agentSessions: AgentSessionService;
  checkpoints: CheckpointService;
  agent: AgentAdapter;
  auth: AuthService;
  notifications: NotificationService;
  backups: BackupService;
  staleDetector: StaleSessionDetector;
  startupRecovery: StartupRecoveryService;
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
 * Il bind di rete è deciso dal chiamante (in produzione: 127.0.0.1 o 0.0.0.0 con auth).
 */
export async function buildApp(config: AppConfig = loadConfig()): Promise<BuiltApp> {
  const db = openDatabase(config.dbPath);
  const events = new EventService(db);
  const notifications = new NotificationService(new SqliteNotificationRepository(db), events);
  const projectRepository = new SqliteProjectRepository(db);
  const projects = new ProjectService(projectRepository, events);
  const gitStatus = new GitStatusService(projectRepository, events);
  const objectiveRepository = new SqliteObjectiveRepository(db);
  const sessionRepository = new SqliteSessionRepository(db);
  const checkpointRepository = new SqliteCheckpointRepository(db);
  const checkpoints = new CheckpointService(checkpointRepository, events);
  const decisionRepository = new SqliteDecisionRepository(db);
  const attemptsRepository = new SqliteExecutionAttemptRepository(db);
  const supervisor = new ProcessSupervisor(attemptsRepository, events);
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
    config.heartbeatIntervalMs,
  );
  const backups = new BackupService(config, events);
  const staleDetector = new StaleSessionDetector(
    sessionRepository, objectiveRepository, projects, notifications, events,
    { checkIntervalMs: config.staleCheckIntervalMs },
  );
  const startupRecovery = new StartupRecoveryService(
    sessionRepository, objectiveRepository, projects, notifications, events,
  );
  const agentSessions = new AgentSessionService(
    objectiveRepository,
    sessionRepository,
    projects,
    gitStatus,
    events,
    agent,
    checkpoints,
    supervisor,
    notifications,
  );

  // M7: autenticazione
  const authRepo = new AuthRepository(db);
  const auth = new AuthService(authRepo, config.sessionTtlDays);

  const app = Fastify({ logger: { level: config.logLevel } });

  // M7: cookie plugin per gestione sessioni
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cookiePlugin = (await import('@fastify/cookie')).default;
  await app.register(cookiePlugin);

  // CORS: localhost per sviluppo; per accesso via VPN le richieste sono
  // same-origin (la PWA è servita dalla stessa porta), quindi CORS
  // serve solo per il dev proxy Vite.
  await app.register(cors, {
    origin: [
      /^http:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/,
      // M7: accesso via Tailscale (100.x.x.x range)
      /^http:\/\/100\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/,
      // M7: accesso via subnet private
      /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/,
      /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/,
    ],
    credentials: true,
  });

  // M7: route di autenticazione (prima delle route protette)
  registerAuthRoutes(app, auth);

  // M7: middleware di autenticazione su tutte le route /api/* (tranne /api/auth/*)
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    // Le route auth sono sempre accessibili
    if (url.startsWith('/api/auth/')) return;
    // Health check sempre accessibile
    if (url === '/api/health') return;
    // La static file serving non è protetta
    if (!url.startsWith('/api/')) return;

    if (!auth.isAccessAllowed(parseCookieToken(req.headers.cookie))) {
      return reply.code(401).send({ message: 'Autenticazione richiesta.' });
    }
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
    notifications,
    backups,
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
      auth,
      notifications,
      backups,
      staleDetector,
      startupRecovery,
    },
  };
}
