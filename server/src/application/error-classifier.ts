/** M8: Classificazione errori per notifiche e analisi (§11). */
import type { ErrorClass } from '../domain/objective.js';

export function classifyError(error: unknown): ErrorClass {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    // AGENT_ERROR: errori provenienti dall'agente (exit code non-zero, crash)
    if (
      message.includes('exit code') ||
      message.includes('process exited') ||
      message.includes('agent') ||
      message.includes('spawn') ||
      message.includes('command not found')
    ) {
      return 'AGENT_ERROR';
    }
    
    // AGENT_CONTROL_ERROR: errori di controllo (process-supervisor, sessioni)
    if (
      message.includes('session') ||
      message.includes('heartbeat') ||
      message.includes('stale') ||
      message.includes('process reference') ||
      message.includes('already running')
    ) {
      return 'AGENT_CONTROL_ERROR';
    }
    
    // CONNECTIVITY_ERROR: errori di rete/connessione
    if (
      message.includes('network') ||
      message.includes('connection') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('socket') ||
      message.includes('fetch')
    ) {
      return 'CONNECTIVITY_ERROR';
    }
    
    return 'UNKNOWN';
  }
  
  // Errori non-Error object
  if (typeof error === 'string') {
    const message = error.toLowerCase();
    if (message.includes('user') || message.includes('manual')) {
      return 'USER_REPORTED';
    }
  }
  
  return 'UNKNOWN';
}

/** M8: Determina se un errore è recuperabile (retry automatico). */
export function isRecoverableError(errorClass: ErrorClass): boolean {
  return errorClass === 'CONNECTIVITY_ERROR' || errorClass === 'AGENT_CONTROL_ERROR';
}

/** M8: Determina se un errore richiede intervento umano. */
export function requiresHumanIntervention(errorClass: ErrorClass): boolean {
  return errorClass === 'AGENT_ERROR' || errorClass === 'USER_REPORTED';
}
