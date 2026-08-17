import { useEffect, useState } from 'react';
import {
  api,
  type Checkpoint,
  type DecisionType,
  type GovernanceApproval,
  type Objective,
  type ProviderCatalogEntry,
  type RuntimeApproval,
} from '../api/client';
import { computeRequiresYou } from '../lib/requires-you';

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `€ ${value.toFixed(4)}`;
}

/** Azioni contestuali per un errore tecnico (M19): Riprova / Cambia agente / Annulla. */
function ErrorActions({ objectiveId, options, onRetry, onCancel, busy }: {
  objectiveId: string;
  options: Array<{ value: string; label: string }>;
  onRetry: (objectiveId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null }) => void;
  onCancel: (objectiveId: string) => void;
  busy: boolean;
}) {
  const [selection, setSelection] = useState('');
  const confirmChange = () => {
    const [runtimeId, providerId, modelId] = selection.split('|');
    onRetry(objectiveId, { runtimeId, providerId, modelId: modelId || null });
  };
  return (
    <div className="needs-actions">
      <button type="button" className="btn touch-target" disabled={busy} onClick={() => onRetry(objectiveId)}>Riprova</button>
      {options.length > 0 && (
        <>
          <select value={selection} onChange={(e) => setSelection(e.target.value)} disabled={busy}>
            <option value="">Cambia agente…</option>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button type="button" className="btn touch-target" disabled={busy || !selection} onClick={confirmChange}>Conferma cambio</button>
        </>
      )}
      <button type="button" className="btn btn-danger touch-target" disabled={busy} onClick={() => onCancel(objectiveId)}>Annulla obiettivo</button>
    </div>
  );
}

export interface RequiresYouViewProps {
  objectivesByProject: Record<string, Objective[]>;
  checkpointsByObjective: Record<string, Checkpoint[]>;
  onDecide: (checkpointId: string, decisionType: DecisionType, note?: string) => void;
  onCancel: (objectiveId: string) => void;
  onRetry: (objectiveId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null }) => void;
  deciding?: string | null;
  busy: Record<string, boolean>;
}


/**
 * Fase 6 — Richiede te (§10 CONTROL_ROOM_SPEC.md).
 * Inbox umana: solo ciò che attende una decisione. Distingue visivamente
 * approvazioni budget, decisioni su risultati e blocchi/errori.
 */
export function RequiresYouView({
  objectivesByProject,
  checkpointsByObjective,
  onDecide,
  onCancel,
  onRetry,
  deciding,
  busy,
}: RequiresYouViewProps) {
  const [approvals, setApprovals] = useState<GovernanceApproval[]>([]);
  const [runtimeApprovals, setRuntimeApprovals] = useState<RuntimeApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);

  useEffect(() => { void api.getProviderCatalog().then((r) => setCatalog(r.catalog)).catch(() => setCatalog([])); }, []);
  const agentOptions = catalog.flatMap((entry) => entry.models.map((model) => ({
    value: `${entry.runtime.id}|${entry.provider.id}|${model.id}`,
    label: `${entry.runtime.name} · ${entry.provider.name} · ${model.name}`,
  })));

  const objectives = Object.values(objectivesByProject).flat();
  const objectiveById = new Map(objectives.map((o) => [o.id, o] as const));

  const loadApprovals = () => {
    void api.listGovernanceApprovals().then((r) => setApprovals(r.approvals)).catch(() => setApprovals([]));
    void api.listRuntimeApprovals().then((r) => setRuntimeApprovals(r.approvals)).catch(() => setRuntimeApprovals([]));
  };
  useEffect(loadApprovals, []);

  const decideApproval = async (id: string, approve: boolean) => {
    setApprovalBusy(id);
    try {
      await api.decideGovernanceApproval(id, approve);
      loadApprovals();
    } catch {
      // Mantiene lo stato precedente: l'operatore può riprovare.
    } finally {
      setApprovalBusy(null);
    }
  };

  const decideRuntime = async (id: string, approved: boolean) => {
    setApprovalBusy(id);
    try {
      await api.decideRuntimeApproval(id, approved);
      loadApprovals();
    } catch {
      // Mantiene lo stato precedente: l'operatore può riprovare.
    } finally {
      setApprovalBusy(null);
    }
  };

  const { pendingApprovals, pendingCheckpoints, total } = computeRequiresYou({
    checkpoints: Object.values(checkpointsByObjective).flat(),
    approvals,
    runtimeApprovals,
  });
  const pendingErrorCheckpoints = pendingCheckpoints.filter((c) => c.outcome === 'ERROR');
  const pendingResultCheckpoints = pendingCheckpoints.filter((c) => c.outcome !== 'ERROR');

  return (
    <div className="requires-you-view">
      <section className="panel requires-you-summary">
        <div className="panel-head">
          <h2>Richiede il tuo intervento</h2>
          <span className="needs-badge">{total}</span>
        </div>
        {total === 0 && (
          <p className="muted">✓ Nessun intervento richiesto — gli agenti possono procedere in autonomia.</p>
        )}
      </section>

      {runtimeApprovals.length > 0 && (
        <section className="panel needs-you-panel">
          <div className="panel-head"><h2>Approvazioni runtime</h2><span className="needs-badge">{runtimeApprovals.length}</span></div>
          {runtimeApprovals.map((approval) => {
            const objective = objectiveById.get(approval.objectiveId);
            return (
              <div className="needs-item" key={approval.requestId}>
                <p className="needs-summary"><strong>{objective?.title ?? shortId(approval.objectiveId)}</strong></p>
                <p className="muted small">Azione richiesta: {approval.action}{approval.detail ? ` — ${approval.detail}` : ''}</p>
                <div className="needs-actions">
                  <button type="button" className="btn btn-approve touch-target" disabled={approvalBusy === approval.requestId}
                    onClick={() => void decideRuntime(approval.requestId, true)}>Approva</button>
                  <button type="button" className="btn btn-danger touch-target" disabled={approvalBusy === approval.requestId}
                    onClick={() => void decideRuntime(approval.requestId, false)}>Rifiuta</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {pendingApprovals.length > 0 && (
        <section className="panel needs-you-panel">
          <div className="panel-head"><h2>Approvazioni budget</h2><span className="needs-badge">{pendingApprovals.length}</span></div>
          {pendingApprovals.map((approval) => {
            const objective = objectiveById.get(approval.objectiveId);
            return (
              <div className="needs-item" key={approval.id}>
                <p className="needs-summary"><strong>{objective?.title ?? shortId(approval.objectiveId)}</strong></p>
                <p className="muted small">Costo previsto {money(approval.projectedCost)}</p>
                {approval.requestNote && <p className="muted small">{approval.requestNote}</p>}
                <div className="needs-actions">
                  <button type="button" className="btn btn-approve touch-target" disabled={approvalBusy === approval.id}
                    onClick={() => void decideApproval(approval.id, true)}>Approva</button>
                  <button type="button" className="btn btn-danger touch-target" disabled={approvalBusy === approval.id}
                    onClick={() => void decideApproval(approval.id, false)}>Rifiuta</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {pendingErrorCheckpoints.length > 0 && (
        <section className="panel needs-you-panel">
          <div className="panel-head"><h2>Errori tecnici da risolvere</h2><span className="needs-badge">{pendingErrorCheckpoints.length}</span></div>
          {pendingErrorCheckpoints.map((checkpoint) => {
            const objective = objectiveById.get(checkpoint.objectiveId);
            return (
              <div className="needs-item" key={checkpoint.id}>
                <p className="needs-summary"><strong>{objective?.title ?? shortId(checkpoint.objectiveId)}</strong></p>
                <p className="muted small">{checkpoint.summary}</p>
                {checkpoint.recommendedAction && <p className="muted small">Raccomandato: {checkpoint.recommendedAction}</p>}
                {checkpoint.technicalDetails && (
                  <details className="checkpoint-technical">
                    <summary>Dettagli tecnici</summary>
                    <pre className="mono checkpoint-technical-body">{checkpoint.technicalDetails}</pre>
                  </details>
                )}
                <ErrorActions
                  objectiveId={checkpoint.objectiveId}
                  options={agentOptions}
                  onRetry={onRetry}
                  onCancel={onCancel}
                  busy={busy[checkpoint.objectiveId] ?? false}
                />
              </div>
            );
          })}
        </section>
      )}

      {pendingResultCheckpoints.length > 0 && (
        <section className="panel needs-you-panel">
          <div className="panel-head"><h2>Obiettivi in attesa di decisione</h2><span className="needs-badge">{pendingResultCheckpoints.length}</span></div>
          {pendingResultCheckpoints.map((checkpoint) => {
            const objective = objectiveById.get(checkpoint.objectiveId);
            return (
              <div className="needs-item" key={checkpoint.id}>
                <p className="needs-summary"><strong>{objective?.title ?? shortId(checkpoint.objectiveId)}</strong></p>
                <p className="muted small">{checkpoint.summary}</p>
                {checkpoint.recommendedAction && <p className="muted small">Raccomandato: {checkpoint.recommendedAction}</p>}
                <div className="needs-actions">
                  <button type="button" className="btn btn-approve touch-target" disabled={deciding === checkpoint.id}
                    onClick={() => onDecide(checkpoint.id, 'APPROVE')}>Approva risultato</button>
                  <button type="button" className="btn touch-target" disabled={deciding === checkpoint.id}
                    onClick={() => onDecide(checkpoint.id, 'REQUEST_CHANGES')}>Richiedi modifiche</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

    </div>
  );
}

