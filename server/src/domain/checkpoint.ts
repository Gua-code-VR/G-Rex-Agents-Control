import { z } from 'zod';
import type { GitStatus } from './project.js';
import type { DecisionType } from './decision.js';

/**
 * Checkpoint (§5 e §12-M4): la conclusione, la richiesta di intervento,
 * il blocco o l'errore di una sessione agente diventano un checkpoint
 * persistente e comprensibile che richiede una decisione umana.
 *
 * Classificazione delle evidenze (§6):
 * - SYSTEM --- ciò che Agent Control ha verificato (stato sessione,
 *   snapshot Git di inizio/fine, delta Git, exit reason).
 * - AGENT --- ciò che l'agente ha dichiarato (summary, acceptance status,
 *   test, avvertenze, azione raccomandata, riferimento al rapporto).
 * - HUMAN --- le decisioni umane arrivano con M5 e non fanno parte di M4.
 *
 * Il checkpoint permette di decidere senza leggere il log grezzo: esito,
 * sintesi, criteri, test, delta Git, avvertenze, azione raccomandata e
 * riferimento al rapporto completo (§6).
 */

/** Esiti del checkpoint: fine, richiesta di intervento, blocco, errore. */
export const CHECKPOINT_OUTCOMES = ['COMPLETED', 'INTERRUPTED', 'BLOCKED', 'ERROR'] as const;

export type CheckpointOutcome = (typeof CHECKPOINT_OUTCOMES)[number];

/** Stato dei criteri di accettazione rispetto al checkpoint (§5). */
export const CHECKPOINT_ACCEPTANCE_STATUSES = ['MET', 'NOT_MET', 'UNVERIFIED'] as const;

export type CheckpointAcceptanceStatus = (typeof CHECKPOINT_ACCEPTANCE_STATUSES)[number];

/** Stati possibili di un checkpoint (M4 + M5). */
export type CheckpointStatus = 'PENDING_DECISION' | 'DECIDED';

/** Sorgenti delle evidenze (§6). HUMAN compare solo con le decisioni di M5. */
export const EVIDENCE_SOURCES = ['SYSTEM', 'AGENT', 'HUMAN'] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * Delta Git calcolato da Agent Control (§6-SYSTEM): differenza tra lo
 * snapshot di inizio lavoro (git_start) e quello al momento del
 * checkpoint (git_end). L'eventuale avanzamento del ramo è verificato
 * dal sistema, mai dichiarato dall'agente.
 */
export interface GitDelta {
  /** Rami di inizio e fine lavoro. */
  fromBranch: string | null;
  toBranch: string | null;
  /** HEAD di inizio e fine lavoro. */
  fromHead: string | null;
  toHead: string | null;
  /** True se l'HEAD è avanzato tra inizio e fine (§6-SYSTEM). */
  commitChanged: boolean;
  /** Stato Git alla fine (verificato dal sistema). */
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  lastCommit: string | null;
  lastCommitAt: string | null;
}

export function computeGitDelta(start: GitStatus | null, end: GitStatus | null): GitDelta | null {
  if (!start || !end) return null;
  return {
    fromBranch: start.branch,
    toBranch: end.branch,
    fromHead: start.head,
    toHead: end.head,
    commitChanged: start.head !== end.head,
    dirty: end.dirty,
    ahead: end.ahead,
    behind: end.behind,
    lastCommit: end.lastCommit,
    lastCommitAt: end.lastCommitAt,
  };
}

/** Checkpoint (§5): l'entità persistente che attende una decisione umana. */
export interface Checkpoint {
  id: string;
  projectId: string;
  objectiveId: string;
  /** Sessione agente che ha generato il checkpoint (se ancora rintracciabile). */
  sessionId: string | null;
  /** Esito del checkpoint: fine / richiesta di intervento / blocco / errore. */
  outcome: CheckpointOutcome;
  /** Stato del checkpoint nel ciclo decisionale (M4: PENDING_DECISION, M5: DECIDED). */
  status: 'PENDING_DECISION' | 'DECIDED';
  /** Timestamp della decisione umana (solo per status DECIDED). */
  decidedAt: string | null;
  /** Tipo di decisione presa (solo per status DECIDED). */
  decisionType: DecisionType | null;
  /** Sintesi della conclusione (§5) --- AGENT o default costruito da Agent Control. */
  summary: string;
  /** Stato rispetto ai criteri di accettazione (§5) --- AGENT o UNVERIFIED. */
  acceptanceStatus: CheckpointAcceptanceStatus;
  /** Evidenze verificate da Agent Control (§6-SYSTEM), leggibili senza log grezzo. */
  evidenceSummary: string;
  /** Delta Git verificato dal sistema (§6-SYSTEM), null se nessun repository. */
  gitDelta: GitDelta | null;
  /** Esito dei test dichiarato dall'agente (§6-AGENT). */
  testsSummary: string;
  /** Avvertenze dichiarate dall'agente (§6-AGENT). */
  warnings: string[];
  /** Azione raccomandata (§5/§6). */
  recommendedAction: string;
  /** Riferimento al rapporto completo (§5/§6), es. objective:<id>:final_report. */
  fullReportReference: string | null;
  /** Sorgenti che hanno contribuito alle evidenze (§6). */
  evidenceSources: EvidenceSource[];
  createdAt: string;
}

/**
 * Dichiarazioni dell'agente accettate al momento del checkpoint (§6-AGENT).
 * Sono facoltative: se assenti, Agent Control costruisce i default e la
 * sorgente AGENT non compare nelle evidenze del checkpoint.
 */
export interface CheckpointAgentInput {
  summary?: string;
  acceptanceStatus?: CheckpointAcceptanceStatus;
  testsSummary?: string;
  warnings?: string[];
  recommendedAction?: string;
  fullReportReference?: string | null;
}

export const checkpointAgentSchema = z.object({
  summary: z
    .string()
    .trim()
    .max(4000, 'Sintesi troppo lunga (massimo 4000 caratteri)')
    .optional()
    .transform((v): string | undefined => (v ? v : undefined)),
  acceptanceStatus: z.enum(CHECKPOINT_ACCEPTANCE_STATUSES).optional(),
  testsSummary: z
    .string()
    .trim()
    .max(4000, 'Sintesi dei test troppo lunga (massimo 4000 caratteri)')
    .optional()
    .transform((v): string | undefined => (v ? v : undefined)),
  warnings: z
    .array(z.string().trim().min(1, 'Avvertenza vuota').max(1000))
    .max(20, 'Troppe avvertenze (massimo 20)')
    .optional(),
  recommendedAction: z
    .string()
    .trim()
    .max(2000, 'Azione raccomandata troppo lunga (massimo 2000 caratteri)')
    .optional()
    .transform((v): string | undefined => (v ? v : undefined)),
  fullReportReference: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform((v): string | null | undefined =>
      v === undefined ? undefined : v && v.trim() ? v.trim() : null,
    ),
});

/** Testo leggibile per l'esito del checkpoint (§6: decidere senza log grezzo). */
export function checkpointOutcomeLabel(outcome: CheckpointOutcome): string {
  switch (outcome) {
    case 'COMPLETED':
      return 'Sessione conclusa';
    case 'INTERRUPTED':
      return 'Richiesta di intervento';
    case 'BLOCKED':
      return 'Bloccato';
    case 'ERROR':
      return 'Errore tecnico';
  }
}
