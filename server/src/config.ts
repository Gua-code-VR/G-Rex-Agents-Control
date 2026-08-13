import path from 'node:path';
import process from 'node:process';

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
  /** Runtime predefinito; ogni obiettivo può selezionarne uno diverso. */
  defaultRuntime: string;
  codexCommand: string;
  codexEnabled: boolean;
  codexModel: string | null;
  // M7: autenticazione e accesso remoto
  /** Giorni di durata sessione (default 30). */
  sessionTtlDays: number;
  /** true se il server deve bindare su 0.0.0.0 (per Tailscale/VPN). */
  bindAll: boolean;
  heartbeatIntervalMs: number;
  staleCheckIntervalMs: number;
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
  // Compatibilità M3: GAC_AGENT_MODE resta un alias del runtime predefinito.
  const defaultRuntime = env.GAC_DEFAULT_RUNTIME?.trim() || env.GAC_AGENT_MODE?.trim() || 'cline';
  const codexCommand = env.GAC_CODEX_COMMAND?.trim() || 'codex';
  const codexEnabled = env.GAC_CODEX_ENABLED !== 'false';
  const codexModel = env.GAC_CODEX_MODEL?.trim() || null;

  // M7: sessione e rete
  const rawTtl = Number(env.GAC_SESSION_TTL_DAYS ?? 30);
  const sessionTtlDays = Number.isFinite(rawTtl) && rawTtl >= 1 ? rawTtl : 30;
  const bindAll = env.GAC_BIND_ALL === 'true';
  const heartbeatIntervalMs = positiveMs(env.GAC_HEARTBEAT_INTERVAL_MS, 30_000);
  const staleCheckIntervalMs = positiveMs(env.GAC_STALE_CHECK_INTERVAL_MS, 30_000);

  return {
    host,
    port,
    dataDir,
    dbPath: path.join(dataDir, 'gac.sqlite'),
    logLevel,
    clineCommand,
    clineEnabled,
    defaultRuntime,
    codexCommand,
    codexEnabled,
    codexModel,
    sessionTtlDays,
    bindAll,
    heartbeatIntervalMs,
    staleCheckIntervalMs,
  };
}

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 86_400_000 ? Math.trunc(parsed) : fallback;
}
