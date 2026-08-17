import type { Checkpoint, GovernanceApproval, RuntimeApproval } from '../api/client';

/**
 * Sorgente unica di «Richiede te» (§5/§14 V2).
 *
 * Un elemento è actionable SOLO se esiste adesso un'azione/decisione umana
 * realmente pendente:
 * - un checkpoint `PENDING_DECISION` (errore terminale, blocco, intervento);
 * - un'approvazione budget `PENDING`;
 * - un'approvazione runtime pendente (non ha uno stato: l'API restituisce
 *   solo quelle pendenti).
 *
 * Le notifiche non lette, le sessioni STALE e gli stati obiettivo derivati
 * NON sono input di questa funzione e quindi non possono alimentare
 * «Richiede te» (§5.2: unread ≠ actionable; §21.8).
 */
export interface RequiresYouResult {
  pendingCheckpoints: Checkpoint[];
  pendingApprovals: GovernanceApproval[];
  runtimeApprovals: RuntimeApproval[];
  /** Numero esatto di azioni umane realmente pendenti. */
  total: number;
}

export function computeRequiresYou(params: {
  checkpoints: Checkpoint[];
  approvals: GovernanceApproval[];
  runtimeApprovals?: RuntimeApproval[];
}): RequiresYouResult {
  const pendingCheckpoints = params.checkpoints.filter((c) => c.status === 'PENDING_DECISION');
  const pendingApprovals = params.approvals.filter((a) => a.status === 'PENDING');
  const runtimeApprovals = params.runtimeApprovals ?? [];
  return {
    pendingCheckpoints,
    pendingApprovals,
    runtimeApprovals,
    total: pendingCheckpoints.length + pendingApprovals.length + runtimeApprovals.length,
  };
}
