/**
 * Port per l'integrazione degli agenti (§7 e §14).
 *
 * M3 introduce il ciclo obiettivo → sessione con agenti reali. La sessione
 * è astratta: il Control Plane non dipende da un agente specifico. Il
 * ClineAdapter invoca la CLI `cline` in modalità headless; il
 * FakeAgentAdapter simula un agente per test e demo deterministici.
 *
 * Vincolo §14: agent-agnostic separabile tramite adapter (port/adapter).
 */
export interface AgentAdapter {
  readonly agentType: string;

  /** True se l'adapter è configurato e utilizzabile in questo momento. */
  isConfigured(): boolean;

  /**
   * Avvia una sessione agente per l'obiettivo specificato.
   * Restituisce un riferimento al processo (PID o identificativo)
   * e un heartbeat iniziale.
   */
  startSession(params: StartSessionParams): Promise<SessionHandle>;

  /** Ferma una sessione in corso. */
  stopSession(sessionRef: string, reason?: string): Promise<void>;

  /** Aggiorna il heartbeat di attività della sessione. */
  touchHeartbeat(sessionRef: string): Promise<void>;
}

export interface StartSessionParams {
  objectiveId: string;
  projectPath: string | null;
  objectiveText: string;
  stopCondition: string | null;
}

export interface SessionHandle {
  /** Riferimento univoco della sessione (PID o ID interno). */
  sessionRef: string;
  /** Tipo di agente che gestisce la sessione. */
  agentType: string;
}

/**
 * Adapter Cline (§8): invoca la CLI `cline` in modalità headless.
 * Il comando è configurabile via `GAC_CLINE_COMMAND` per non dipendere
 * da un percorso hardcoded.
 */
import { spawn } from 'node:child_process';

export class ClineAdapter implements AgentAdapter {
  readonly agentType = 'cline';

  private readonly clineCommand: string;
  private readonly enabled: boolean;
  private readonly processes = new Map<string, ReturnType<typeof spawn>>();

  constructor(clineCommand = 'cline', enabled = true) {
    this.clineCommand = clineCommand;
    this.enabled = enabled;
  }

  isConfigured(): boolean {
    if (!this.enabled) return false;
    try {
      const where = process.platform === 'win32' ? 'where' : 'which';
      const res = require('child_process').spawnSync(where, [this.clineCommand], { encoding: 'utf8' });
      return Boolean(res && res.status === 0 && res.stdout && res.stdout.trim().length > 0);
    } catch (err) {
      return false;
    }
  }

  async startSession(params: StartSessionParams): Promise<SessionHandle> {
    if (!this.isConfigured()) {
      return {
        sessionRef: `cline-fallback-${Date.now()}`,
        agentType: this.agentType,
      };
    }

    const args: string[] = ['--headless', '--json'];
    const opts: any = {};
    if (params.projectPath) opts.cwd = params.projectPath;

    const child = spawn(this.clineCommand, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    const sessionRef = `cline:${child.pid}:${Date.now()}`;
    this.processes.set(sessionRef, child);

    try {
      const input = JSON.stringify({ objectiveText: params.objectiveText, stopCondition: params.stopCondition ?? null });
      child.stdin.write(input);
      child.stdin.end();
    } catch (err) {
      // ignore
    }

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          console.info('[cline]', sessionRef, parsed);
        } catch (err) {
          console.debug('[cline][raw]', sessionRef, line);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      console.warn('[cline][err]', sessionRef, d.toString());
    });

    child.on('exit', (code, signal) => {
      console.info('[cline][exit]', sessionRef, { code, signal });
      this.processes.delete(sessionRef);
    });

    return { sessionRef, agentType: this.agentType };
  }

  async stopSession(sessionRef: string, _reason?: string): Promise<void> {
    const child = this.processes.get(sessionRef);
    if (!child) return;
    try {
      if (!child.killed) child.kill();
    } catch (err) {
      // ignore
    } finally {
      this.processes.delete(sessionRef);
    }
  }

  async touchHeartbeat(_sessionRef: string): Promise<void> {
    // no-op for now
  }
}

/**
 * Adapter per test e demo deterministici: simula un agente che completa
 * l'obiettivo senza invocare alcun processo esterno. Utile per i test
 * automatici di M3 e per la demo senza installare Cline.
 */
export class FakeAgentAdapter implements AgentAdapter {
  readonly agentType = 'fake';

  isConfigured(): boolean {
    return true;
  }

  async startSession(params: StartSessionParams): Promise<SessionHandle> {
    void params;
    return {
      sessionRef: `fake-${Date.now()}`,
      agentType: this.agentType,
    };
  }

  async stopSession(_sessionRef: string, _reason?: string): Promise<void> {
    // Nessun processo da fermare.
  }

  async touchHeartbeat(_sessionRef: string): Promise<void> {
    // Nessun heartbeat esterno.
  }
}