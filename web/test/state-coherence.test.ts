import { describe, expect, it } from 'vitest';
import {
  GROUP_LABEL,
  OBJECTIVE_STATUS_LABEL,
  PROJECT_STATUS_LABEL,
  SESSION_STATUS_LABEL,
} from '../src/lib/labels';
import { computeRequiresYou } from '../src/lib/requires-you';
import type {
  AgentSession,
  Checkpoint,
  GovernanceApproval,
  Objective,
  Project,
  ProjectStatusGroup,
  RuntimeApproval,
} from '../src/api/client';

/**
 * Audit coerenza UI (§14 V2): le etichette di stato hanno una sorgente unica
 * (lib/labels.ts) e il badge «Richiede te» del backend (requiresYouCount)
 * deve corrispondere esattamente alle azioni umane realmente pendenti.
 */
describe('Coerenza etichette stati (sorgente unica, §14 V2)', () => {
  const objectiveStatuses: Objective['status'][] = ['IN_AVVIO', 'IN_LAVORAZIONE', 'RICHIEDE_ATTENZIONE', 'BLOCCATO', 'COMPLETATO', 'ERRORE', 'ANNULLATO'];
  const sessionStatuses: AgentSession['status'][] = ['IN_AVVIO', 'ATTIVA', 'COMPLETATA', 'ERRORE', 'INTERROTTA', 'BLOCCATA', 'STALE'];
  const projectStatuses: Project['status'][] = ['FERMO', 'IN_AVVIO', 'IN_LAVORAZIONE', 'RICHIEDE_ATTENZIONE', 'BLOCCATO', 'COMPLETATO', 'ERRORE'];
  const groups: ProjectStatusGroup[] = ['FERMO', 'IN_LAVORAZIONE', 'PROBLEMA'];

  it('ogni stato obiettivo, sessione, progetto e gruppo ha un’etichetta non vuota', () => {
    for (const s of objectiveStatuses) expect(OBJECTIVE_STATUS_LABEL[s]).toBeTruthy();
    for (const s of sessionStatuses) expect(SESSION_STATUS_LABEL[s]).toBeTruthy();
    for (const s of projectStatuses) expect(PROJECT_STATUS_LABEL[s]).toBeTruthy();
    for (const g of groups) expect(GROUP_LABEL[g]).toBeTruthy();
  });

  it('stati semanticamente diversi non condividono etichette che nascondono differenze critiche', () => {
    // «Errore» e «Bloccato» restano distinti; «In attesa di avvio» non viene
    // confuso con «Richiede attenzione».
    expect(OBJECTIVE_STATUS_LABEL.ERRORE).not.toBe(OBJECTIVE_STATUS_LABEL.BLOCCATO);
    expect(SESSION_STATUS_LABEL.IN_AVVIO).not.toBe(OBJECTIVE_STATUS_LABEL.RICHIEDE_ATTENZIONE);
  });
});

describe('Coerenza badge «Richiede te» (§5.3 V2)', () => {
  const checkpoint = (over: Partial<Checkpoint> = {}): Checkpoint => ({
    id: 'c1', projectId: 'p1', objectiveId: 'o1', sessionId: null,
    outcome: 'ERROR', status: 'PENDING_DECISION', summary: 'Errore',
    acceptanceStatus: 'UNVERIFIED', evidenceSummary: 'evidenze', gitDelta: null,
    testsSummary: 'Non dichiarati', warnings: [], recommendedAction: 'Riprova',
    technicalDetails: null, fullReportReference: null, evidenceSources: ['SYSTEM'],
    createdAt: '2026-01-01T00:00:00.000Z', decidedAt: null, decisionType: null, ...over,
  });
  const approval = (over: Partial<GovernanceApproval> = {}): GovernanceApproval => ({
    id: 'a1', objectiveId: 'o1', projectedCost: 1, status: 'PENDING', requestNote: null,
    decisionNote: null, createdAt: '2026-01-01T00:00:00.000Z', decidedAt: null, ...over,
  });
  const runtimeApproval = (over: Partial<RuntimeApproval> = {}): RuntimeApproval => ({
    requestId: 'r1', objectiveId: 'o1', sessionId: 's1', processReference: null,
    action: 'approve', detail: null, requestedAt: '2026-01-01T00:00:00.000Z', ...over,
  });

  it('il conteggio del badge coincide con le sole azioni umane pendenti', () => {
    const checkpoints = [
      checkpoint({ id: 'c-pending', status: 'PENDING_DECISION' }),
      checkpoint({ id: 'c-decided', status: 'DECIDED' }),
    ];
    const approvals = [
      approval({ id: 'a-pending', status: 'PENDING' }),
      approval({ id: 'a-done', status: 'APPROVED' }),
    ];
    const runtime = [runtimeApproval()];

    const total = computeRequiresYou({ checkpoints, approvals, runtimeApprovals: runtime }).total;
    // Il badge backend (requiresYouCount) è definito con la stessa semantica:
    // checkpoint PENDING_DECISION + approvazioni PENDING + approvazioni runtime.
    expect(total).toBe(3);
    expect(total).toBe(
      checkpoints.filter((c) => c.status === 'PENDING_DECISION').length
      + approvals.filter((a) => a.status === 'PENDING').length
      + runtime.length,
    );
  });

  it('sessioni STALE e notifiche non lette non entrano nel conteggio', () => {
    // Il modello di computeRequiresYou non accetta sessioni né notifiche: per
    // costruzione STALE/unread non possono alimentare il badge (§5.2 V2).
    const r = computeRequiresYou({ checkpoints: [checkpoint({ status: 'DECIDED' })], approvals: [approval({ status: 'REJECTED' })] });
    expect(r.total).toBe(0);
  });
});
