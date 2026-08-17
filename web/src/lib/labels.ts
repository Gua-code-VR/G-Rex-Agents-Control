import type { AgentSession, Objective, Project, ProjectStatusGroup } from '../api/client';

/** Etichette di stato condivise: un'unica sorgente per evitare divergenze tra viste. */

export const OBJECTIVE_STATUS_LABEL: Record<Objective['status'], string> = {
  IN_AVVIO: 'In avvio',
  IN_LAVORAZIONE: 'In lavorazione',
  RICHIEDE_ATTENZIONE: 'Richiede attenzione',
  BLOCCATO: 'Bloccato',
  COMPLETATO: 'Completato',
  ERRORE: 'Errore',
  ANNULLATO: 'Annullato',
};

export const SESSION_STATUS_LABEL: Record<AgentSession['status'], string> = {
  IN_AVVIO: 'In avvio',
  ATTIVA: 'Attiva',
  COMPLETATA: 'Completata',
  ERRORE: 'Errore',
  INTERROTTA: 'Interrotta',
  BLOCCATA: 'Bloccata',
  STALE: 'Inattiva',
};

export const PROJECT_STATUS_LABEL: Record<Project['status'], string> = {
  FERMO: 'Fermo',
  IN_AVVIO: 'In avvio',
  IN_LAVORAZIONE: 'In lavorazione',
  RICHIEDE_ATTENZIONE: 'Richiede attenzione',
  BLOCCATO: 'Bloccato',
  COMPLETATO: 'Completato',
  ERRORE: 'Errore',
};

export const GROUP_LABEL: Record<ProjectStatusGroup, string> = {
  FERMO: 'Fermo',
  IN_LAVORAZIONE: 'In lavorazione',
  PROBLEMA: 'Con problema',
};
