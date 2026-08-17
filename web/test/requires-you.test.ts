import { describe, expect, it } from 'vitest';
import { computeRequiresYou } from '../src/lib/requires-you';
import type { Checkpoint, GovernanceApproval, RuntimeApproval } from '../src/api/client';

function checkpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'c1',
    projectId: 'p1',
    objectiveId: 'o1',
    sessionId: null,
    outcome: 'ERROR',
    status: 'PENDING_DECISION',
    summary: 'Errore tecnico',
    acceptanceStatus: 'UNVERIFIED',
    evidenceSummary: 'Sessione agente: ERRORE',
    gitDelta: null,
    testsSummary: 'Non dichiarati',
    warnings: [],
    recommendedAction: 'Riprova',
    technicalDetails: null,
    fullReportReference: null,
    evidenceSources: ['SYSTEM'],
    createdAt: '2026-01-01T00:00:00.000Z',
    decidedAt: null,
    decisionType: null,
    ...over,
  };
}

function approval(over: Partial<GovernanceApproval> = {}): GovernanceApproval {
  return {
    id: 'a1',
    objectiveId: 'o1',
    projectedCost: 1,
    status: 'PENDING',
    requestNote: null,
    decisionNote: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    decidedAt: null,
    ...over,
  };
}

function runtimeApproval(over: Partial<RuntimeApproval> = {}): RuntimeApproval {
  return {
    requestId: 'r1',
    objectiveId: 'o1',
    sessionId: 's1',
    processReference: null,
    action: 'approve',
    detail: null,
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('computeRequiresYou — invarianti «Richiede te» (§5/§14 V2)', () => {
  it('con zero azioni pendenti il totale è zero (sezione assente, §5.3)', () => {
    const r = computeRequiresYou({ checkpoints: [], approvals: [] });
    expect(r.total).toBe(0);
    expect(r.pendingCheckpoints).toHaveLength(0);
    expect(r.pendingApprovals).toHaveLength(0);
  });

  it('un checkpoint DECIDED non conta (decisione già presa, errore storico)', () => {
    const r = computeRequiresYou({ checkpoints: [checkpoint({ status: 'DECIDED' })], approvals: [] });
    expect(r.pendingCheckpoints).toHaveLength(0);
    expect(r.total).toBe(0);
  });

  it('un checkpoint PENDING_DECISION conta come azione umana pendente', () => {
    const r = computeRequiresYou({ checkpoints: [checkpoint({ status: 'PENDING_DECISION' })], approvals: [] });
    expect(r.pendingCheckpoints).toHaveLength(1);
    expect(r.total).toBe(1);
  });

  it("un'approvazione budget già decisa non conta", () => {
    const r = computeRequiresYou({
      checkpoints: [],
      approvals: [approval({ status: 'APPROVED' }), approval({ status: 'REJECTED' })],
    });
    expect(r.pendingApprovals).toHaveLength(0);
    expect(r.total).toBe(0);
  });

  it('il totale è la somma esatta delle sole azioni umane pendenti', () => {
    const r = computeRequiresYou({
      checkpoints: [checkpoint({ id: 'c1', status: 'PENDING_DECISION' }), checkpoint({ id: 'c2', status: 'DECIDED' })],
      approvals: [approval({ id: 'a1', status: 'PENDING' })],
      runtimeApprovals: [runtimeApproval()],
    });
    expect(r.pendingCheckpoints).toHaveLength(1);
    expect(r.pendingApprovals).toHaveLength(1);
    expect(r.runtimeApprovals).toHaveLength(1);
    expect(r.total).toBe(3);
  });

  it('le notifiche non lette e le sessioni STALE non sono input (§5.2, §21.8)', () => {
    // La funzione accetta SOLO checkpoint + approvazioni: non esiste un
    // parametro per notifiche o sessioni, quindi `unread`/`STALE` non possono
    // alimentare «Richiede te» per costruzione.
    const fn = computeRequiresYou as (p: {
      checkpoints: Checkpoint[];
      approvals: GovernanceApproval[];
      runtimeApprovals?: RuntimeApproval[];
    }) => unknown;
    expect(fn.length).toBe(1);
    const r = computeRequiresYou({ checkpoints: [], approvals: [] });
    expect(r.total).toBe(0);
  });
});
