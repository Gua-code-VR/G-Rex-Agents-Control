import { z } from 'zod';
import type { GitStatus, ProjectStatus } from './project.js';
import type { BudgetPolicy } from './governance.js';

/**
 * Stati di un Objective (§5 e §12-M3).
 *
 * L'obiettivo nasce IN_AVVIO (assegnato, sessione agente in partenza,
 * §4), passa IN_LAVORAZIONE quando l'agente è attivo e RICHIEDE_ATTENZIONE
 * quando l'agente raggiunge lo stop (serve una decisione umana).
 * BLOCCATO/COMPLETATO/ANNULLATO appartengono alle decisioni umane di M5,
 * ma l'enum è già quello finale: nessuno stato viene anticipato come
 * funzionalità, solo come contratto.
 */
export const OBJECTIVE_STATUSES = [
  'IN_AVVIO',
  'IN_LAVORAZIONE',
  'RICHIEDE_ATTENZIONE',
  'BLOCCATO',
  'COMPLETATO',
  'ERRORE',
  'ANNULLATO',
] as const;

export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/** Stati non terminali: finché esistono, nessun nuovo obiettivo può partire (§3/§14). */
export const ACTIVE_OBJECTIVE_STATUSES: readonly ObjectiveStatus[] = [
  'IN_AVVIO',
  'IN_LAVORAZIONE',
  'RICHIEDE_ATTENZIONE',
  'BLOCCATO',
];

/**
 * Stati di una AgentSession (§5). La sessione nasce IN_AVVIO insieme
 * all'obiettivo, diventa ATTIVA con il processo agente e termina in
 * COMPLETATA (exit 0), ERRORE (fallimento tecnico), INTERROTTA (stop
 * controllato dell'operatore) o BLOCCATA (M4: blocco con richiesta di
 * aiuto umano). STALE (M8): sessione senza heartbeat per tempo configurabile.
 */
export const SESSION_STATUSES = [
  'IN_AVVIO',
  'ATTIVA',
  'BLOCCATA',
  'COMPLETATA',
  'ERRORE',
  'INTERROTTA',
  'STALE',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Classificazione degli errori (M8 §11). */
export const ERROR_CLASSES = [
  'AGENT_ERROR',
  'AGENT_CONTROL_ERROR',
  'CONNECTIVITY_ERROR',
  'USER_REPORTED',
  'UNKNOWN',
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * Lo stato ufficiale del Project deriva dall'Objective corrente (§5).
 * Il progetto è un contenitore permanente associato al repository: dopo
 * il completamento o l'annullamento di un obiettivo torna FERMO ed è
 * subito pronto a ricevere un nuovo obiettivo senza reinserire il
 * repository. Gli stati operativi restanti mantengono la semantica §4.
 */
export function objectiveStatusToProjectStatus(status: ObjectiveStatus): ProjectStatus {
  switch (status) {
    case 'IN_AVVIO':
      return 'IN_AVVIO';
    case 'IN_LAVORAZIONE':
      return 'IN_LAVORAZIONE';
    case 'RICHIEDE_ATTENZIONE':
      return 'RICHIEDE_ATTENZIONE';
    case 'BLOCCATO':
      return 'BLOCCATO';
    case 'COMPLETATO':
      return 'FERMO';
    case 'ERRORE':
      return 'ERRORE';
    case 'ANNULLATO':
      return 'FERMO';
  }
}

/** Priorità degli stati aperti per derivare lo stato del Project (§4.2 V2).
 *  Lo stato del progetto è DERIVATO dagli obiettivi reali: quando esistono
 *  più obiettivi aperti prevale la condizione più grave (errore > blocco >
 *  richiede attenzione > in lavorazione > in avvio); se tutti sono terminali
 *  il progetto torna FERMO. Serve a evitare stati progetto contraddittori
 *  rispetto agli obiettivi realmente attivi. */
const OPEN_STATUS_PRIORITY: Record<ObjectiveStatus, number> = {
  ERRORE: 6,
  BLOCCATO: 5,
  RICHIEDE_ATTENZIONE: 4,
  IN_LAVORAZIONE: 3,
  IN_AVVIO: 2,
  COMPLETATO: 0,
  ANNULLATO: 0,
};

export function deriveProjectStatus(objectives: readonly Objective[]): ProjectStatus {
  let best: ObjectiveStatus | null = null;
  let bestPriority = 0;
  for (const objective of objectives) {
    const priority = OPEN_STATUS_PRIORITY[objective.status];
    if (priority > bestPriority) {
      best = objective.status;
      bestPriority = priority;
    }
  }
  return best ? objectiveStatusToProjectStatus(best) : 'FERMO';
}

/** Objective (§5): testo, criteri, evidenze Git di inizio/fine lavoro. */
export interface Objective {
  id: string;
  projectId: string;
  title: string;
  objectiveText: string;
  invariants: string[];
  acceptanceCriteria: string[];
  stopCondition: string | null;
  status: ObjectiveStatus;
  startedAt: string | null;
  completedAt: string | null;
  finalReport: string | null;
  gitStart: GitStatus | null;
  gitEnd: GitStatus | null;
  createdAt: string;
  updatedAt: string;
  policy: BudgetPolicy | null;
  estimatedCost: number | null;
}

/** AgentSession (§5): sessione agente legata a un Objective. */
export interface AgentSession {
  id: string;
  objectiveId: string;
  agentType: string;
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  lastActivityAt: string | null;
  processReference: string | null;
  exitReason: string | null;
  /** M8: Heartbeat configurabile per rilevare sessioni STALE. */
  heartbeatIntervalMs: number;
  /** M8: Timestamp dell'ultimo heartbeat ricevuto. */
  lastHeartbeatAt: string | null;
  executionSelection: ExecutionSelection | null;
  /** §19: workspace Git isolata associata all'esecuzione (worktree + branch). */
  workspaceId: string | null;
}

/** Combinazione normalizzata, provider-agnostic, scelta per l'esecuzione. */
export interface ExecutionSelection {
  runtimeId: string;
  providerId: string;
  modelId: string | null;
  outputTokenLimit: number | null;
  decision?: ExecutionRoutingDecision;
}

export interface ExecutionRoutingCandidate {
  runtimeId: string; providerId: string; modelId: string | null; outputTokenLimit: number | null;
  eligible: boolean; score: number; reliability: number; estimatedCost: number | null;
  budgetFit: boolean; capabilities: string[]; reasons: string[];
  performance?: ExecutionPerformanceProfile;
}

export type ObjectiveRoutingType = 'CODE_CHANGE' | 'BUG_FIX' | 'TESTING' | 'DOCUMENTATION' | 'ANALYSIS' | 'GENERAL';

export interface ExecutionPerformanceProfile {
  objectiveType: ObjectiveRoutingType;
  sampleSize: number;
  globalSampleSize: number;
  qualityScore: number;
  successRate: number;
  retryRate: number;
  fallbackRate: number;
  humanInterventionRate: number;
  averageDurationMs: number | null;
  averageCost: number | null;
  costEfficiency: number;
  adaptiveScore: number;
}

export interface ExecutionRoutingDecision {
  mode: 'AUTOMATIC' | 'EXPLICIT';
  reason: string;
  selectedScore: number | null;
  requiredCapabilities: string[];
  budget: { policy: BudgetPolicy; spent: number; remaining: number | null };
  candidates: ExecutionRoutingCandidate[];
  objectiveType?: ObjectiveRoutingType;
  learningVersion?: string;
  decidedAt: string;
}

export interface CreateObjectiveInput {
  title: string;
  objectiveText: string;
  invariants: string[];
  acceptanceCriteria: string[];
  stopCondition: string | null;
  runtime?: string;
  providerId?: string;
  modelId?: string | null;
  outputTokenLimit?: number | null;
  estimatedCost?: number | null;
}

/** Lista di vincoli/criteri: una riga per voce, mai vuote. */
const stringList = z
  .array(z.string().trim().min(1, 'Voce vuota non ammessa').max(1000))
  .max(30, 'Troppe voci (massimo 30)')
  .optional()
  .transform((v) => v ?? []);

export const createObjectiveSchema = z.object({
  title: z.string().trim().min(1, "Il titolo dell'obiettivo è obbligatorio").max(200),
  objectiveText: z
    .string()
    .trim()
    .min(1, "Il testo dell'obiettivo è obbligatorio")
    .max(50000, "Il testo dell'obiettivo è troppo lungo (massimo 50000 caratteri)"),
  runtime: z.string().trim().min(1).max(80).optional(),
  providerId: z.string().trim().min(1).max(120).optional(),
  modelId: z.string().trim().min(1).max(160).nullable().optional(),
  outputTokenLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  estimatedCost: z.number().finite().positive().nullable().optional(),
  invariants: stringList,
  acceptanceCriteria: stringList,
  stopCondition: z
    .string()
    .trim()
    .max(2000, 'La condizione di stop è troppo lunga (massimo 2000 caratteri)')
    .optional()
    .transform((v): string | null => (v ? v : null)),
});

export interface StopSessionInput {
  reason?: string | null;
}

export const stopSessionSchema: z.ZodType<StopSessionInput> = z.object({
  reason: z
    .string()
    .trim()
    .max(500, 'Motivo troppo lungo (massimo 500 caratteri)')
    .optional()
    .transform((v): string | null => (v ? v : null)),
});

/** Input del blocco (M4): motivo facoltativo, come per lo stop. */
export interface BlockSessionInput {
  reason?: string | null;
}

export const blockSessionSchema: z.ZodType<BlockSessionInput> = z.object({
  reason: z
    .string()
    .trim()
    .max(500, 'Motivo troppo lungo (massimo 500 caratteri)')
    .optional()
    .transform((v): string | null => (v ? v : null)),
});
