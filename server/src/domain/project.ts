import { z } from 'zod';
import type { BudgetPolicy } from './governance.js';

/**
 * Stati operativi definiti nella sorgente di verità (§4).
 * M2 introduce il registro progetti con stato ufficiale mantenuto da
 * Agent Control: le transizioni guidate dalle sessioni agente
 * (IN_AVVIO/IN_LAVORAZIONE dipendenti da M3+) arriveranno con le
 * milestone successive, ma gli stati e i gruppi sono quelli finali.
 */
export const PROJECT_STATUSES = [
  'FERMO',
  'IN_AVVIO',
  'IN_LAVORAZIONE',
  'RICHIEDE_ATTENZIONE',
  'BLOCCATO',
  'COMPLETATO',
  'ERRORE',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Macro-gruppi che la dashboard (M2) deve distinguere in modo affidabile. */
export const PROJECT_GROUPS = ['FERMO', 'IN_LAVORAZIONE', 'PROBLEMA'] as const;

export type ProjectStatusGroup = (typeof PROJECT_GROUPS)[number];

/**
 * Mappatura stato §4 → gruppo dashboard M2:
 * - FERMO: nessun obiettivo attivo (incluso COMPLETATO: obiettivo chiuso).
 * - IN_LAVORAZIONE: in avvio o agente attivo.
 * - PROBLEMA: richiede attenzione, bloccato o errore.
 */
const STATUS_GROUPS: Record<ProjectStatusGroup, readonly ProjectStatus[]> = {
  FERMO: ['FERMO', 'COMPLETATO'],
  IN_LAVORAZIONE: ['IN_AVVIO', 'IN_LAVORAZIONE'],
  PROBLEMA: ['RICHIEDE_ATTENZIONE', 'BLOCCATO', 'ERRORE'],
};

export function projectStatusGroup(status: ProjectStatus): ProjectStatusGroup {
  for (const group of PROJECT_GROUPS) {
    if ((STATUS_GROUPS[group] as readonly string[]).includes(status)) {
      return group;
    }
  }
  // Irraggiungibile: ogni stato ufficiale appartiene a un gruppo.
  return 'PROBLEMA';
}

/**
 * Stato Git essenziale (§5 e §6-SYSTEM): ramo, HEAD e dirty state sono
 * evidenze deterministiche che Agent Control legge e rende ufficiali.
 */
export interface GitStatus {
  fetchedAt: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  lastCommit: string | null;
  lastCommitAt: string | null;
  error: string | null;
}

export interface Project {
  id: string;
  name: string;
  repositoryPath: string | null;
  status: ProjectStatus;
  /** Gruppo derivato dallo stato ufficiale (per la dashboard M2). */
  statusGroup: ProjectStatusGroup;
  /**
   * Obiettivo corrente come testo mantenuto da Agent Control. Da M3 il
   * testo ufficiale è l'entità Objective (§5): questa colonna resta come
   * denormalizzazione per la dashboard e per i progetti registrati prima
   * di M3, aggiornata dal ciclo obiettivo (current_objective_id).
   */
  currentObjective: string | null;
  /** Id dell'Objective corrente (§5: current_objective_id), null se nessuno. */
  currentObjectiveId: string | null;
  gitStatus: GitStatus | null;
  createdAt: string;
  updatedAt: string;
  policy: BudgetPolicy | null;
}

export interface CreateProjectInput {
  name: string;
  repositoryPath?: string;
  currentObjective?: string | null;
}

export const createProjectInputSchema: z.ZodType<CreateProjectInput> = z.object({
  name: z.string().trim().min(1, 'Il nome del progetto è obbligatorio').max(120),
  repositoryPath: z
    .string()
    .trim()
    .max(1024)
    .optional()
    .transform((v) => (v ? v : undefined)),
  currentObjective: z
    .string()
    .trim()
    .max(2000, "L'obiettivo corrente è troppo lungo (massimo 2000 caratteri)")
    .optional()
    .transform((v): string | null => (v ? v : null)),
});

export interface UpdateProjectInput {
  repositoryPath?: string | null;
  currentObjective?: string | null;
}

export const updateProjectSchema: z.ZodType<UpdateProjectInput> = z
  .object({
    repositoryPath: z
      .string()
      .trim()
      .max(1024)
      .nullable()
      .optional()
      .transform((v) =>
        v === undefined ? undefined : typeof v === 'string' && v.trim() ? v.trim() : null,
      ),
    currentObjective: z
      .string()
      .trim()
      .max(2000, "L'obiettivo corrente è troppo lungo (massimo 2000 caratteri)")
      .nullable()
      .optional()
      .transform((v): string | null | undefined =>
        v === undefined ? undefined : typeof v === 'string' && v.trim() ? v.trim() : null,
      ),
  })
  .refine((v) => v.repositoryPath !== undefined || v.currentObjective !== undefined, {
    message: 'Indica almeno un campo da aggiornare (repositoryPath o currentObjective)',
  });

export const setProjectStatusSchema = z.object({
  status: z.enum(PROJECT_STATUSES),
});

export interface SetProjectStatusInput {
  status: ProjectStatus;
}
