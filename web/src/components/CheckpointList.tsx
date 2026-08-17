import { useState } from 'react';
import type {
  Checkpoint,
  CheckpointAcceptanceStatus,
  CheckpointOutcome,
  DecisionType,
  EvidenceSource,
  GitDelta,
} from '../api/client';

/** Etichette leggibili per l'esito del checkpoint (§6: decidere senza log grezzo). */
const OUTCOME_LABEL: Record<CheckpointOutcome, string> = {
  COMPLETED: 'Sessione conclusa',
  INTERRUPTED: 'Richiesta di intervento',
  BLOCKED: 'Bloccato',
  ERROR: 'Errore tecnico',
};

const STATUS_LABEL: Record<Checkpoint['status'], string> = {
  PENDING_DECISION: 'Decisione pendente',
  DECIDED: 'Deciso',
};

const ACCEPTANCE_LABEL: Record<CheckpointAcceptanceStatus, string> = {
  MET: 'Criteri soddisfatti',
  NOT_MET: 'Criteri non soddisfatti',
  UNVERIFIED: 'Criteri non verificati',
};

const SOURCE_LABEL: Record<EvidenceSource, string> = {
  SYSTEM: 'System',
  AGENT: 'Agente',
  HUMAN: 'Umano',
};

const DECISION_TYPE_LABEL: Record<DecisionType, string> = {
  APPROVE: 'Approvato',
  REQUEST_CHANGES: 'Richieste modifiche',
  STOP: 'Fermato',
  CANCEL: 'Annullato',
  RETRY: 'Riprovato',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString('it-IT');
}

function shortCommit(head: string | null): string {
  if (!head) return '—';
  return head.length > 12 ? `${head.slice(0, 12)}…` : head;
}

function GitDeltaLine({ delta }: { delta: GitDelta }) {
  return (
    <div className="checkpoint-git">
      <span className={`chip ${delta.commitChanged ? 'chip-clean' : 'chip-dim'}`}>
        HEAD {shortCommit(delta.fromHead)} → {shortCommit(delta.toHead)}
        {delta.commitChanged ? ' (avanzato)' : ''}
      </span>
      <span className={`chip ${delta.dirty ? 'chip-dirty' : 'chip-clean'}`}>
        {delta.dirty ? 'albero sporco' : 'albero pulito'}
      </span>
      {delta.ahead !== null && delta.behind !== null && (
        <span className="muted small">
          ↑ {delta.ahead} davanti · ↓ {delta.behind} dietro
        </span>
      )}
    </div>
  );
}

/** Pulsanti di azione per un checkpoint PENDING_DECISION (M5). */
function CheckpointDecisionButtons({
  checkpointId,
  onDecide,
  busy,
}: {
  checkpointId: string;
  onDecide: (checkpointId: string, decisionType: DecisionType, note?: string) => void;
  busy: boolean;
}) {
  const [note, setNote] = useState('');

  const handleDecision = (decisionType: DecisionType) => {
    onDecide(checkpointId, decisionType, note.trim() || undefined);
    setNote('');
  };

  return (
    <div className="checkpoint-decision-actions">
      <input
        className="checkpoint-note-input"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Nota (opzionale)"
        maxLength={5000}
        disabled={busy}
      />
      <div className="checkpoint-buttons">
        <button type="button" className="btn btn-approve" disabled={busy} onClick={() => handleDecision('APPROVE')}>
          Approva
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => handleDecision('REQUEST_CHANGES')}>
          Richiedi modifiche
        </button>
        <button type="button" className="btn btn-warn" disabled={busy} onClick={() => handleDecision('STOP')}>
          Ferma
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => handleDecision('CANCEL')}>
          Annulla
        </button>
      </div>
    </div>
  );
}

/**
 * M4/M5 — Checkpoint di un obiettivo (§12): esito, stato decisione, sintesi,
 * evidenze classificate (§6), delta Git verificato dal sistema e riferimento
 * al rapporto completo. M5: pulsanti di azione per checkpoint pendenti e
 * visualizzazione dello storico decisioni.
 */
export function CheckpointList({
  checkpoints,
  onDecide,
  deciding,
}: {
  checkpoints: Checkpoint[];
  onDecide?: (checkpointId: string, decisionType: DecisionType, note?: string) => void;
  deciding?: string | null;
}) {
  if (checkpoints.length === 0) {
    return (
      <div className="checkpoint-box">
        <span className="objective-label">Checkpoint</span>
        <p className="muted small">Nessun checkpoint.</p>
      </div>
    );
  }

  return (
    <div className="checkpoint-box">
      <span className="objective-label">Checkpoint ({checkpoints.length})</span>
      {checkpoints.map((checkpoint) => (
        <article className="checkpoint-card" key={checkpoint.id}>
          <div className="checkpoint-head">
            <span className={`badge badge-${checkpoint.outcome.toLowerCase()}`}>
              {OUTCOME_LABEL[checkpoint.outcome]}
            </span>
            <span className={`badge badge-${checkpoint.status.toLowerCase()}`}>
              {STATUS_LABEL[checkpoint.status]}
            </span>
            <time className="muted small">{formatDate(checkpoint.createdAt)}</time>
          </div>

          <p className="checkpoint-summary">{checkpoint.summary}</p>

          {checkpoint.evidenceSummary && (
            <div className="checkpoint-evidence">
              <div className="checkpoint-sources">
                {checkpoint.evidenceSources.map((source) => (
                  <span key={source} className={`checkpoint-src checkpoint-src-${source.toLowerCase()}`}>
                    {SOURCE_LABEL[source]}
                  </span>
                ))}
              </div>
              <p className="checkpoint-evidence-text">{checkpoint.evidenceSummary}</p>
            </div>
          )}

          {checkpoint.gitDelta && <GitDeltaLine delta={checkpoint.gitDelta} />}

          {checkpoint.acceptanceStatus !== 'UNVERIFIED' && (
            <p className="muted small">Accettazione: {ACCEPTANCE_LABEL[checkpoint.acceptanceStatus]}</p>
          )}

          {checkpoint.testsSummary && <p className="muted small">Test: {checkpoint.testsSummary}</p>}

          {checkpoint.warnings.length > 0 && (
            <ul className="checkpoint-warnings">
              {checkpoint.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}

          {checkpoint.recommendedAction && (
            <p className="muted small checkpoint-recommended">
              Azione raccomandata: {checkpoint.recommendedAction}
            </p>
          )}

          {checkpoint.technicalDetails && (
            <details className="checkpoint-technical">
              <summary>Dettagli tecnici</summary>
              <pre className="mono checkpoint-technical-body">{checkpoint.technicalDetails}</pre>
            </details>
          )}

          {checkpoint.fullReportReference && (
            <p className="mono checkpoint-ref">Rapporto completo: {checkpoint.fullReportReference}</p>
          )}

          {/* M5: Decisione presa */}
          {checkpoint.status === 'DECIDED' && checkpoint.decisionType && (
            <div className="checkpoint-decision-info">
              <span className="chip chip-decided">
                {DECISION_TYPE_LABEL[checkpoint.decisionType]}
              </span>
              {checkpoint.decidedAt && (
                <time className="muted small">{formatDate(checkpoint.decidedAt)}</time>
              )}
            </div>
          )}

          {/* M5: Pulsanti azione per checkpoint pendenti */}
          {checkpoint.status === 'PENDING_DECISION' && onDecide && (
            <CheckpointDecisionButtons
              checkpointId={checkpoint.id}
              onDecide={onDecide}
              busy={deciding === checkpoint.id}
            />
          )}
        </article>
      ))}
    </div>
  );
}
