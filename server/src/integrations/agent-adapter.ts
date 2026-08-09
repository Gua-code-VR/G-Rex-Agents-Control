/**
 * Port per l'integrazione degli agenti (§7 e §14).
 *
 * M1 non avvia sessioni agente: introduce solo il contratto astratto
 * che le milestone successive (M3+) estenderanno con operazioni di
 * sessione (start/stop, stato, exit reason). Mantiene l'architettura
 * agent-agnostic separabile tramite adapter.
 */
export interface AgentAdapter {
  readonly agentType: string;

  /** True se l'adapter è configurato e utilizzabile in questo momento. */
  isConfigured(): boolean;
}

/**
 * Adapter di default per M1: nessun agente è disponibile finché
 * non verrà introdotto il ClineAdapter (M3).
 */
export class NoopAgentAdapter implements AgentAdapter {
  readonly agentType = 'noop';

  isConfigured(): boolean {
    return false;
  }
}