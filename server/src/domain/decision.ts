import { z } from 'zod';

// ---------------------------------------------------------------------------
// §5 + M5: HumanDecision — record della decisione umana su un checkpoint.
// ---------------------------------------------------------------------------

/** Le decisioni umane possibili (§12-M5 + M19 RETRY per gli errori tecnici). */
export const DECISION_TYPES = ['APPROVE', 'REQUEST_CHANGES', 'STOP', 'CANCEL', 'RETRY'] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

/** Schema di input per POST /api/checkpoints/:id/decide. */
export const decideCheckpointSchema = z.object({
  decisionType: z.enum(DECISION_TYPES),
  note: z
    .string()
    .trim()
    .max(5000, 'Nota troppo lunga (massimo 5000 caratteri)')
    .optional(),
});

export type DecideCheckpointInput = z.infer<typeof decideCheckpointSchema>;

/** Entità persistita: decisione umana registrata su un checkpoint. */
export interface HumanDecision {
  id: string;
  checkpointId: string;
  decisionType: DecisionType;
  note: string | null;
  decidedAt: string;
}

// ---------------------------------------------------------------------------
// Effetti deterministici delle decisioni (M5-INV3)
// ---------------------------------------------------------------------------

import type { ObjectiveStatus } from './objective.js';

/**
 * Effetto di una decisione sullo stato dell'obiettivo.
 * M5-INV3: stessa decisione → stessa transizione, sempre.
 * La transizione da "non terminale" a terminale è irreversibile (D4-A).
 *
 * Nota (§4.2 V2): lo stato del Project NON è un effetto della decisione; è
 * sempre derivato dagli obiettivi reali (deriveProjectStatus), quindi qui
 * non esiste più una mappa PROJECT_EFFECTS.
 */
export const OBJECTIVE_EFFECTS: Record<DecisionType, ObjectiveStatus> = {
  APPROVE: 'COMPLETATO',
  REQUEST_CHANGES: 'RICHIEDE_ATTENZIONE',
  STOP: 'RICHIEDE_ATTENZIONE',
  CANCEL: 'ANNULLATO',
  RETRY: 'IN_AVVIO',
};
