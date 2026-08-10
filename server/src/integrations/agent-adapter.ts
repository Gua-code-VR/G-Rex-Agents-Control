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
export class ClineAdapter implements AgentAdapter {
  readonly agentType = 'cline';

  constructor(
    private readonly clineCommand: string = 'cline',
    private readonly enabled: boolean = true,
  ) {}

  isConfigured(): boolean {
    return this.enabled;
  }

  async startSession(_params: StartSessionParams): Promise<SessionHandle> {
    // M3: l'avvio effettivo del processo Cline è un'operazione di Execution
    // Plane che richiede la CLI installata. Il Control Plane registra la
    // sessione e delega l'avvio. In questa fase restituiamo un riferimento
    // che identifica il comando che verrà invocato (M4+).
    return {
      sessionRef: `${this.clineCommand}-${Date.now()}`,
      agentType: this.agentType,
    };
  }

  async stopSession(_sessionRef: string, _reason?: string): Promise<void> {
    // L'arresto effettivo del processo Cline è un'operazione di Execution
    // Plane. Il Control Plane registra lo stop e lo stato; l'invio del
    // segnale al processo sarà integrato in M4+.
  }

  async touchHeartbeat(_sessionRef: string): Promise<void> {
    // Il heartbeat effettivo dipende dal processo Cline; per ora il Control
    // Plane registra il timestamp senza inviare comandi esterni.
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