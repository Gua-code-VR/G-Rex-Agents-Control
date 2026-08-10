import type {
  Checkpoint,
  CheckpointAcceptanceStatus,
  CheckpointOutcome,
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
};

const ACCEPTANCE_LABEL: Record<CheckpointAcceptanceStatus, string> = {
  MET: 'Criteri soddisfatti',
  NOT_MET: 'Criteri non soddisfatti',
  UNVERIFIED: 'Criteri non verificati',
};

const SOURCE_LABEL: Record<EvidenceSource, string> = {
  SYSTEM: 'System',
  AGENT: 'Agente',
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

/**
 * M4 — Checkpoint di un obiettivo (§12): esito, stato decisione, sintesi,
 * evidenze classificate (§6), delta Git verificato dal sistema e riferimento
 * al rapporto completo. Componente puramente presentazionale.
 */
export function CheckpointList({ checkpoints }: { checkpoints: Checkpoint[] }) {
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

          {checkpoint.fullReportReference && (
            <p className="mono checkpoint-ref">Rapporto completo: {checkpoint.fullReportReference}</p>
          )}
        </article>
      ))}
    </div>
  );
}
