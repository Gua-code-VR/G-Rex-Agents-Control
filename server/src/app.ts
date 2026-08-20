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
import { CodexProvider, ClineProvider, ExecutionProviderRegistry, FakeProvider } from './integrations/execution-provider.js';
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
import { GovernanceService } from './application/governance-service.js';
import { ProviderCatalogService } from './application/provider-catalog-service.js';
import { PricingCatalogService } from './application/pricing-catalog-service.js';
import { RuntimeSelectionService } from './application/runtime-selection-service.js';
import type { PricingProviderEntry } from './domain/pricing.js';
import { PersistentRetryWorker } from './application/persistent-retry-worker.js';
import { ExecutionQueueWorker } from './application/execution-queue-worker.js';
import { WorktreeService } from './application/worktree-service.js';
import { GitWorktreeManager } from './infrastructure/git/git-worktree-manager.js';
import { SqliteWorkspaceRepository } from './infrastructure/db/workspace-repo.js';
import { SqliteRetryJobRepository } from './infrastructure/db/retry-job-repo.js';

export interface AppServices {
  db: DatabaseSync;
  events: EventService;
  projects: ProjectService;
  gitStatus: GitStatusService;
  objectives: ObjectiveService;
  agentSessions: AgentSessionService;
  checkpoints: CheckpointService;
  providers: ExecutionProviderRegistry;
  auth: AuthService;
  notifications: NotificationService;
  backups: BackupService;
  staleDetector: StaleSessionDetector;
  startupRecovery: StartupRecoveryService;
  governance: GovernanceService;
  catalog: ProviderCatalogService;
  runtimeSelector: RuntimeSelectionService;
  retryWorker: PersistentRetryWorker;
  queueWorker: ExecutionQueueWorker;
  workspaces: WorktreeService;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: AppServices;
}

/** Fallback retro-compatibile (M18/M20): Cline è sempre esposto nel catalogo,
 *  anche senza GAC_CLINE_MODEL (modelli vuoti → la CLI usa il suo default).
 *  Questo evita «Runtime non supportato: cline» nella selezione manuale. */
function legacyFallbackClineProviders(config: AppConfig): PricingProviderEntry[] {
  return [{
    id: config.clineProvider,
    name: config.clineProvider,
    models: config.clineModel
      ? [{
          id: config.clineModel,
          name: config.clineModel,
          contextTokens: null,
          defaultOutputTokens: 4000,
          pricing: { inputPerMillion: config.clineInputPricePerMillion, outputPerMillion: config.clineOutputPricePerMillion, currency: 'USD' },
          pricingSchedule: null,
        }]
      : [],
  }];
}

function fallbackClineProviders(config: AppConfig): PricingProviderEntry[] {
  const byProvider = new Map<string, PricingProviderEntry>();
  const ensure = (id: string, name: string): PricingProviderEntry => {
    const existing = byProvider.get(id);
    if (existing) return existing;
    const created: PricingProviderEntry = { id, name, models: [] };
    byProvider.set(id, created);
    return created;
  };
  const appendModel = (
    provider: PricingProviderEntry,
    model: { id: string; name: string; contextTokens: number | null; defaultOutputTokens: number },
    pricing: { inputPerMillion: number | null; outputPerMillion: number | null },
  ): void => {
    if (provider.models.some((item) => item.id === model.id)) return;
    provider.models.push({
      id: model.id,
      name: model.name,
      contextTokens: model.contextTokens,
      defaultOutputTokens: model.defaultOutputTokens,
      pricing: { ...pricing, currency: 'USD' },
      pricingSchedule: null,
    });
  };

  for (const provider of legacyFallbackClineProviders(config)) {
    const target = ensure(provider.id, provider.name);
    for (const model of provider.models) {
      appendModel(target, model, {
        inputPerMillion: model.pricing.inputPerMillion,
        outputPerMillion: model.pricing.outputPerMillion,
      });
    }
  }
  for (const providerConfig of config.clineConfiguredProviders) {
    const provider = ensure(providerConfig.id, providerConfig.name);
    for (const model of providerConfig.models) {
      appendModel(provider, model, { inputPerMillion: null, outputPerMillion: null });
    }
  }
  return [...byProvider.values()];
}

/** Seleziona l'adapter agente (§8 e §14): fake per demo/test, Cline in produzione. */
export function buildProviderRegistry(config: AppConfig, pricing: PricingCatalogService): ExecutionProviderRegistry {
  return new ExecutionProviderRegistry([
    new FakeProvider(),
    new ClineProvider(config.clineCommand, config.clineEnabled, () => pricing.list()),
    new CodexProvider(config.codexCommand, config.codexEnabled, config.codexModel, { inputPerMillion: config.codexInputPricePerMillion, outputPerMillion: config.codexOutputPricePerMillion }, config.codexAuth),
  ]);
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
  // §19: workspace Git isolate (worktree + branch dedicato). Lifecycle
  // separato dal ProcessSupervisor e dall'Execution Plane (§29).
  const workspaces = new WorktreeService(
    new SqliteWorkspaceRepository(db),
    new GitWorktreeManager(),
    events,
    notifications,
    {
      enabled: config.workspacesEnabled,
      baseDir: config.workspacesDir,
      branchPrefix: config.workspaceBranchPrefix,
      integrateOnComplete: config.workspaceIntegrateOnComplete,
      blockOnDirty: config.workspaceBlockOnDirty,
    },
  );
  const objectiveRepository = new SqliteObjectiveRepository(db);
  const sessionRepository = new SqliteSessionRepository(db);
  const checkpointRepository = new SqliteCheckpointRepository(db);
  const checkpoints = new CheckpointService(checkpointRepository, events);
  const decisionRepository = new SqliteDecisionRepository(db);
  const attemptsRepository = new SqliteExecutionAttemptRepository(db);
  const retryJobs = new SqliteRetryJobRepository(db);
  const pricingCatalog = new PricingCatalogService(
    config.pricingFile,
    fallbackClineProviders(config),
    () => new Date(),
    config.pricingArchiveDir ?? undefined,
    config.cliProviderMap,
  );
  pricingCatalog.startRefreshing(config.pricingRefreshMs);
  const providers = buildProviderRegistry(config, pricingCatalog);
  const supervisor = new ProcessSupervisor(attemptsRepository, events, { retryMax: config.executionRetryMax, retryBackoffMs: config.executionRetryBackoffMs, fallbackRuntime: config.executionFallbackRuntime, costBudget: config.executionCostBudget });
  const governance = new GovernanceService(db, events, notifications, config.executionCostBudget);
  const decisions = new DecisionService(
    decisionRepository,
    checkpointRepository,
    objectiveRepository,
    sessionRepository,
    projects,
    events,
    providers,
  );
  const catalog = new ProviderCatalogService(providers);
  const runtimeSelector = new RuntimeSelectionService(catalog, db);
  const retryWorker = new PersistentRetryWorker(retryJobs, events);
  const objectives = new ObjectiveService(
    objectiveRepository,
    sessionRepository,
    projects,
    gitStatus,
    events,
    providers,
    catalog,
    runtimeSelector,
    config.defaultRuntime,
    config.heartbeatIntervalMs,
  );
  const backups = new BackupService(config, events);
  const staleDetector = new StaleSessionDetector(
    sessionRepository, objectiveRepository, projects, notifications, events, providers, checkpoints, supervisor, retryWorker,
    { checkIntervalMs: config.staleCheckIntervalMs },
  );
  const startupRecovery = new StartupRecoveryService(
    sessionRepository, objectiveRepository, projects, notifications, events, providers,
    checkpoints, supervisor, retryWorker,
  );
  const agentSessions = new AgentSessionService(
    objectiveRepository,
    sessionRepository,
    projects,
    gitStatus,
    events,
    providers,
    checkpoints,
    supervisor,
    notifications,
    governance,
    catalog,
    runtimeSelector,
    retryWorker,
    workspaces,
    decisions,
    {
      enabled: config.nativeWorkflowEnabled,
      maxWorkers: config.nativeWorkflowMaxWorkers,
      runtimeIds: config.nativeWorkflowRuntimeIds,
    },
  );
  retryWorker.setExecutor((job) => agentSessions.runRetryJob(job));

  // Coda di esecuzione: avvia automaticamente gli obiettivi IN_AVVIO quando
  // esiste almeno un worker disponibile (§11 CONTROL_ROOM_SPEC).
  const queueWorker = new ExecutionQueueWorker(sessionRepository, objectiveRepository, providers, events);
  queueWorker.setExecutor((objectiveId, sessionId) => agentSessions.tryAutoStart(objectiveId, sessionId));

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

  // M7: middleware di autenticazione su tutte le route /api/* (tranne /api/auth/*).
  // Registrato prima di registerAuthRoutes per coprire anche auth e health.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    // Le risposte API non devono mai essere servite dalla cache del browser o di
    // un proxy: la verità dei dati appartiene ad Agent Control, non alla cache (§14).
    if (url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
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

  // M7: route di autenticazione (prima delle route protette)
  registerAuthRoutes(app, auth);

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
    providers,
    attempts: attemptsRepository,
    supervisor,
    governance,
    catalog,
    queueWorker,
    workspaces,
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
      providers,
      auth,
      notifications,
      backups,
      staleDetector,
      startupRecovery,
      governance,
      catalog,
      runtimeSelector,
      retryWorker,
      queueWorker,
      workspaces,
    },
  };
}
