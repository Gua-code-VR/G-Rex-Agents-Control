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
  /** Adapter agente selezionato: 'fake' per demo/test, 'cline' altrimenti. */
  agentMode: 'fake' | 'cline';
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
  const agentMode = env.GAC_AGENT_MODE?.trim() === 'fake' ? 'fake' : 'cline';

  return {
    host,
    port,
    dataDir,
    dbPath: path.join(dataDir, 'gac.sqlite'),
    logLevel,
    clineCommand,
    clineEnabled,
    agentMode,
  };
}