import path from 'node:path';
import process from 'node:process';

export interface ConfiguredClineModel {
  id: string;
  name: string;
  contextTokens: number | null;
  defaultOutputTokens: number;
}

export interface ConfiguredClineProvider {
  id: string;
  name: string;
  models: ConfiguredClineModel[];
}

/**
 * Configurazione applicativa. Tutto è locale: nessun servizio esterno.
 * La porta predefinita è 3000 e l'host predefinito è 127.0.0.1
 * (nessuna esposizione pubblica, invariante di progetto §14).
 */
export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  logLevel: string;
  /** Comando della CLI Cline (M3, §8): percorso o nome sul PATH. */
  clineCommand: string;
  /** True se l'integrazione Cline è abilitata (GAC_CLINE_ENABLED). */
  clineEnabled: boolean;
  /** ID del provider API usato dalla CLI Cline (GAC_CLINE_PROVIDER). */
  clineProvider: string;
  /** Modello Cline predefinito, se esplicitato (GAC_CLINE_MODEL). */
  clineModel: string | null;
  /** Provider/modelli operativi selezionabili per Cline anche senza listino. */
  clineConfiguredProviders: ConfiguredClineProvider[];
  clineInputPricePerMillion: number | null;
  clineOutputPricePerMillion: number | null;
  /** File JSON dei provider diretti Cline (M18); assente → fallback alle env singole. */
  pricingFile: string;
  /** Intervallo (ms) di rilettura del file prezzi (0 = refresh disabilitato). */
  pricingRefreshMs: number;
  /** Directory dell'archivio G-Rex Pricing (fonte unica dei prezzi).
   *  Default: `<dataDir>/g-rex-pricing-archive`; l'archivio, quando presente,
   *  prende la precedenza sul file `pricing.json` (che resta solo fallback). */
  pricingArchiveDir: string | null;
  /** Mappa archivio → chiave provider CLI Cline (solo i provider realmente configurati). */
  cliProviderMap: Record<string, string>;
  /** Runtime predefinito; ogni obiettivo può selezionarne uno diverso. */
  defaultRuntime: string;
  codexCommand: string;
  codexEnabled: boolean;
  codexModel: string | null;
  /** Autenticazione corrente della CLI Codex: `api-key` o `chatgpt` (GAC_CODEX_AUTH).
   *  Determina quali modelli sono realmente supportati: un account ChatGPT non
   *  espone l'alias `codex-default`, che quindi non viene proposto né avviato. */
  codexAuth: 'api-key' | 'chatgpt';
  codexInputPricePerMillion: number | null;
  codexOutputPricePerMillion: number | null;
  executionRetryMax: number;
  executionRetryBackoffMs: number;
  executionFallbackRuntime: string | null;
  executionCostBudget: number | null;
  nativeWorkflowEnabled: boolean;
  nativeWorkflowMaxWorkers: number;
  nativeWorkflowRuntimeIds: string[];
  // M7: autenticazione e accesso remoto
  /** Giorni di durata sessione (default 30). */
  sessionTtlDays: number;
  /** true se il server deve bindare su 0.0.0.0 (per Tailscale/VPN). */
  bindAll: boolean;
  /** Indirizzo di bind effettivo (GAC_BIND_ADDRESS > GAC_BIND_ALL > GAC_HOST). */
  bindAddress: string;
  heartbeatIntervalMs: number;
  staleCheckIntervalMs: number;
  // §19: workspace Git isolate (worktree + branch dedicato)
  /** True se le esecuzioni lavorano in workspace isolate (GAC_WORKSPACES_ENABLED). */
  workspacesEnabled: boolean;
  /** Directory base delle workspace isolate (GAC_WORKSPACES_DIR, default <dataDir>/workspaces). */
  workspacesDir: string;
  /** Prefisso dei branch dedicati (GAC_WORKSPACE_BRANCH_PREFIX, default `gac/objective/`). */
  workspaceBranchPrefix: string;
  /** Integrazione automatica al completamento quando sicura (GAC_WORKSPACE_INTEGRATE_ON_COMPLETE). */
  workspaceIntegrateOnComplete: boolean;
  /** Blocca la creazione della workspace se la working tree principale è sporca (§19.3). */
  workspaceBlockOnDirty: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.GAC_DATA_DIR?.trim()
    ? path.resolve(env.GAC_DATA_DIR)
    : path.resolve(process.cwd(), 'data');

  const rawPort = Number(env.GAC_PORT ?? 3000);
  const port =
    Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 3000;

  const host = env.GAC_HOST?.trim() || '127.0.0.1';

  const logLevel = env.GAC_LOG_LEVEL?.trim() || 'info';

  // M3: adattatore agente. Di default usa Cline (§8); 'fake' abilita
  // l'adapter simulato per demo senza CLI installata e per i test.
  const clineCommand = env.GAC_CLINE_COMMAND?.trim() || 'cline';
  const clineEnabled = env.GAC_CLINE_ENABLED !== 'false';
  const clineProvider = env.GAC_CLINE_PROVIDER?.trim() || 'cline';
  const clineModel = env.GAC_CLINE_MODEL?.trim() || null;
  const clineConfiguredProviders = parseConfiguredClineProviders(env.GAC_CLINE_CONFIGURED_PROVIDERS);
  const clineInputPricePerMillion = nonNegativeNumber(env.GAC_CLINE_INPUT_PRICE_PER_MILLION);
  const clineOutputPricePerMillion = nonNegativeNumber(env.GAC_CLINE_OUTPUT_PRICE_PER_MILLION);
  // Compatibilità M3: GAC_AGENT_MODE resta un alias del runtime predefinito.
  const defaultRuntime = env.GAC_DEFAULT_RUNTIME?.trim() || env.GAC_AGENT_MODE?.trim() || 'cline';
  const codexCommand = env.GAC_CODEX_COMMAND?.trim() || 'codex';
  const codexEnabled = env.GAC_CODEX_ENABLED !== 'false';
  const codexModel = env.GAC_CODEX_MODEL?.trim() || null;
  // Autenticazione corrente della CLI Codex. Default `api-key` (retro-compatibile:
  // `codex-default` resta proposto come oggi); `chatgpt` esclude l'alias.
  const rawCodexAuth = env.GAC_CODEX_AUTH?.trim().toLowerCase();
  const codexAuth: 'api-key' | 'chatgpt' = rawCodexAuth === 'chatgpt' ? 'chatgpt' : 'api-key';
  const codexInputPricePerMillion = nonNegativeNumber(env.GAC_CODEX_INPUT_PRICE_PER_MILLION);
  const codexOutputPricePerMillion = nonNegativeNumber(env.GAC_CODEX_OUTPUT_PRICE_PER_MILLION);
  // M18: file prezzi dichiarati (provider diretti), riletto periodicamente.
  const pricingFile = env.GAC_PRICING_FILE?.trim() ? path.resolve(env.GAC_PRICING_FILE) : path.join(dataDir, 'pricing.json');
  const rawPricingRefresh = Number(env.GAC_PRICING_REFRESH_MS ?? 60_000);
  const pricingRefreshMs = Number.isFinite(rawPricingRefresh) && rawPricingRefresh >= 0 ? Math.trunc(rawPricingRefresh) : 60_000;
  // Archivio G-Rex Pricing: fonte unica dei prezzi (prende la precedenza sul file).
  // Default `<dataDir>/g-rex-pricing-archive`: la distribuzione standard colloca
  // qui l'archivio prodotto da G-Rex Pricing, così il runtime lo consuma davvero.
  // Se l'archivio è assente o non valido, `PricingCatalogService` ricade sul file.
  const pricingArchiveDir = env.GAC_PRICING_ARCHIVE_DIR?.trim() ? path.resolve(env.GAC_PRICING_ARCHIVE_DIR) : path.join(dataDir, 'g-rex-pricing-archive');
  const cliProviderMap = parseCliProviderMap(env.GAC_PRICING_CLI_PROVIDER_MAP);
  const executionRetryMax = boundedInt(env.GAC_EXECUTION_RETRY_MAX, 1, 0, 5);
  const executionRetryBackoffMs = positiveMs(env.GAC_EXECUTION_RETRY_BACKOFF_MS, 1_000);
  const executionFallbackRuntime = env.GAC_EXECUTION_FALLBACK_RUNTIME?.trim() || null;
  const executionCostBudget = nonNegativeNumber(env.GAC_EXECUTION_COST_BUDGET);
  const nativeWorkflowEnabled = env.GAC_NATIVE_WORKFLOW_ENABLED !== 'false';
  const nativeWorkflowMaxWorkers = boundedInt(env.GAC_NATIVE_WORKFLOW_MAX_WORKERS, 4, 2, 16);
  const nativeWorkflowRuntimeIds = (env.GAC_NATIVE_WORKFLOW_RUNTIMES ?? 'cline')
    .split(',').map((value) => value.trim()).filter(Boolean);

  // M7: sessione e rete
  const rawTtl = Number(env.GAC_SESSION_TTL_DAYS ?? 30);
  const sessionTtlDays = Number.isFinite(rawTtl) && rawTtl >= 1 ? rawTtl : 30;
  const bindAll = env.GAC_BIND_ALL === 'true';
  // Bind address esplicito (Tailscale/VPN): GAC_BIND_ADDRESS prevale, poi
  // GAC_BIND_ALL (alias booleano per 0.0.0.0), poi GAC_HOST legacy, poi loopback.
  const bindAddress = env.GAC_BIND_ADDRESS?.trim() || (bindAll ? '0.0.0.0' : host);
  const heartbeatIntervalMs = positiveMs(env.GAC_HEARTBEAT_INTERVAL_MS, 30_000);
  const staleCheckIntervalMs = positiveMs(env.GAC_STALE_CHECK_INTERVAL_MS, 30_000);

  // §19: workspace Git isolate (worktree + branch dedicato). Default attivo:
  // gli agenti concorrenti non lavorano direttamente sulla working tree
  // principale (§27). Il provisioning degrada in modo sicuro quando il
  // repository non è Git o il percorso non esiste (fallback al comportamento
  // precedente), mentre una working tree principale sporca blocca l'avvio (§19.3).
  const workspacesEnabled = env.GAC_WORKSPACES_ENABLED !== 'false';
  const workspacesDir = env.GAC_WORKSPACES_DIR?.trim()
    ? path.resolve(env.GAC_WORKSPACES_DIR)
    : path.join(dataDir, 'workspaces');
  const workspaceBranchPrefix = env.GAC_WORKSPACE_BRANCH_PREFIX?.trim() || 'gac/objective/';
  const workspaceIntegrateOnComplete = env.GAC_WORKSPACE_INTEGRATE_ON_COMPLETE !== 'false';
  const workspaceBlockOnDirty = env.GAC_WORKSPACE_BLOCK_ON_DIRTY !== 'false';

  return {
    host,
    port,
    dataDir,
    dbPath: path.join(dataDir, 'gac.sqlite'),
    logLevel,
    clineCommand,
    clineEnabled,
    clineProvider,
    clineModel,
    clineConfiguredProviders,
    clineInputPricePerMillion,
    clineOutputPricePerMillion,
    defaultRuntime,
    codexCommand,
    codexEnabled,
    codexModel,
    codexAuth,
    codexInputPricePerMillion,
    codexOutputPricePerMillion,
    pricingFile,
    pricingRefreshMs,
    pricingArchiveDir,
    cliProviderMap,
    executionRetryMax,
    executionRetryBackoffMs,
    executionFallbackRuntime,
    executionCostBudget,
    nativeWorkflowEnabled,
    nativeWorkflowMaxWorkers,
    nativeWorkflowRuntimeIds,
    sessionTtlDays,
    bindAll,
    bindAddress,
    heartbeatIntervalMs,
    staleCheckIntervalMs,
    workspacesEnabled,
    workspacesDir,
    workspaceBranchPrefix,
    workspaceIntegrateOnComplete,
    workspaceBlockOnDirty,
  };
}

const defaultConfiguredClineProviders: ConfiguredClineProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [{
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      contextTokens: 64_000,
      defaultOutputTokens: 8_000,
    }],
  },
];

function parseConfiguredClineProviders(raw: string | undefined): ConfiguredClineProvider[] {
  if (!raw?.trim()) return defaultConfiguredClineProviders;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return defaultConfiguredClineProviders;
    const providers: ConfiguredClineProvider[] = [];
    for (const provider of parsed) {
      if (!provider || typeof provider !== 'object') continue;
      const record = provider as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      if (!id) continue;
      const models = Array.isArray(record.models) ? record.models.flatMap((model) => {
        if (typeof model === 'string') {
          const modelId = model.trim();
          return modelId ? [{ id: modelId, name: modelId, contextTokens: null, defaultOutputTokens: 4000 }] : [];
        }
        if (!model || typeof model !== 'object') return [];
        const modelRecord = model as Record<string, unknown>;
        const modelId = typeof modelRecord.id === 'string' ? modelRecord.id.trim() : '';
        if (!modelId) return [];
        const contextTokens = typeof modelRecord.contextTokens === 'number' && Number.isFinite(modelRecord.contextTokens) && modelRecord.contextTokens > 0 ? Math.trunc(modelRecord.contextTokens) : null;
        const output = typeof modelRecord.defaultOutputTokens === 'number' && Number.isFinite(modelRecord.defaultOutputTokens) && modelRecord.defaultOutputTokens > 0 ? Math.trunc(modelRecord.defaultOutputTokens) : 4000;
        return [{
          id: modelId,
          name: typeof modelRecord.name === 'string' && modelRecord.name.trim() ? modelRecord.name.trim() : modelId,
          contextTokens,
          defaultOutputTokens: output,
        }];
      }) : [];
      providers.push({
        id,
        name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
        models,
      });
    }
    return providers.length ? providers : defaultConfiguredClineProviders;
  } catch {
    return defaultConfiguredClineProviders;
  }
}

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 86_400_000 ? Math.trunc(parsed) : fallback;
}

/**
 * Mappa archivio G-Rex Pricing → chiave provider CLI Cline, in formato
 * `archivio=cli` separato da virgola (es. `qwen=openai-compatible,deepseek=deepseek`).
 * Default: Qwen (`qwen` → `openai-compatible`) e DeepSeek (`deepseek` → `deepseek`).
 */
function parseCliProviderMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = { qwen: 'openai-compatible', deepseek: 'deepseek' };
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [key, value] = pair.split('=');
    if (key?.trim() && value?.trim()) map[key.trim()] = value.trim();
  }
  return map;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function nonNegativeNumber(value: string | undefined): number | null { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : null; }
