/** M8: Classificazione errori per notifiche e analisi (§11). */
import type { ErrorClass } from '../domain/objective.js';

export function classifyError(error: unknown): ErrorClass {
  const message = typeof error === 'string'
    ? error.toLowerCase()
    : error instanceof Error
      ? error.message.toLowerCase()
      : '';
  if (!message) return 'UNKNOWN';

  // USER_REPORTED: errore segnalato manualmente dall'operatore.
  if (message.includes('user') || message.includes('manual') || message.includes("segnalato dall'operatore")) {
    return 'USER_REPORTED';
  }

  // AGENT_ERROR: errori provenienti dall'agente (exit code non-zero, crash).
  if (
    message.includes('exit code') ||
    message.includes('process exited') ||
    message.includes('agent') ||
    message.includes('spawn') ||
    message.includes('command not found')
  ) {
    return 'AGENT_ERROR';
  }

  // AGENT_CONTROL_ERROR: errori di controllo (process-supervisor, sessioni).
  if (
    message.includes('session') ||
    message.includes('sessionruntime') ||
    message.includes('shutdown called while') ||
    message.includes('run is in progress') ||
    message.includes('heartbeat') ||
    message.includes('stale') ||
    message.includes('process reference') ||
    message.includes('already running')
  ) {
    return 'AGENT_CONTROL_ERROR';
  }

  // CONNECTIVITY_ERROR: errori di rete, connessione o credenziali.
  if (
    message.includes('network') ||
    message.includes('connection') ||
    message.includes('timeout') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('socket') ||
    message.includes('fetch') ||
    message.includes('unauthorized') ||
    message.includes('authenticat') ||
    message.includes('re-authenticate') ||
    message.includes('api key') ||
    message.includes('credential')
  ) {
    return 'CONNECTIVITY_ERROR';
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

/** Traduzione leggibile di un errore tecnico (M19): cosa è successo, conseguenze, azione. */
export interface ErrorTranslation {
  summary: string;
  consequences: string;
  recommendedAction: string;
}

/** M19: traduce un errore grezzo in linguaggio comprensibile, senza esporre log CLI. */
export function translateTechnicalError(detail: string, errorClass: ErrorClass, agentType?: string): ErrorTranslation {
  const raw = String(detail ?? '');
  if (/--sandbox|--approve-for-me|unrecognized|unknown flag|unexpected argument|invalid argument|cannot be used with/i.test(raw)) {
    return {
      summary: 'Impossibile avviare il runtime: la riga di comando generata non è compatibile con la versione della CLI installata.',
      consequences: "Nessuna esecuzione è partita: l'obiettivo è stato messo in errore e nessun lavoro è stato svolto.",
      recommendedAction: "Riprova l'avvio; se il problema persiste, scegli un altro agente oppure annulla l'obiettivo.",
    };
  }
  if (/unauthorized|authenticat|re-authenticate|api ?key|credential/i.test(raw)) {
    return {
      summary: "Autenticazione del runtime non valida: l'account o le credenziali dell'agente non sono più accettati.",
      consequences: "L'esecuzione non è partita: il runtime ha rifiutato le credenziali prima di svolgere qualsiasi lavoro.",
      recommendedAction: "Riesegui l'autenticazione del runtime (o configura un provider con credenziali valide), poi riprova.",
    };
  }
  if (errorClass === 'CONNECTIVITY_ERROR') {
    return {
      summary: 'Il runtime non ha potuto raggiungere i servizi remoti (rete o credenziali).',
      consequences: "L'esecuzione non è partita o si è interrotta prima di completare il lavoro.",
      recommendedAction: 'Verifica connessione di rete e credenziali, poi riprova.',
    };
  }
  if (errorClass === 'AGENT_ERROR') {
    return {
      summary: `${agentType ?? 'Il runtime'} ha terminato con un errore durante l'esecuzione.`,
      consequences: "L'esecuzione è fallita e l'obiettivo è stato messo in errore.",
      recommendedAction: "Riprova l'esecuzione; se il problema persiste, cambia agente o annulla l'obiettivo.",
    };
  }
  return {
    summary: "Si è verificato un errore tecnico durante l'esecuzione.",
    consequences: "L'esecuzione è fallita e l'obiettivo è stato messo in errore.",
    recommendedAction: "Riprova l'esecuzione; se il problema persiste, cambia agente o annulla l'obiettivo.",
  };
}
