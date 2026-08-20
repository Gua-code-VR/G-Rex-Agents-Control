import { useEffect, useState, type FormEvent } from 'react';
import { summarizeEventPayload } from '../lib/event-summary';
import {
  api,
  type AgentSession,
  type Checkpoint,
  type CreateObjectiveInput,
  type DecisionType,
  type EventRecord,
  type ExecutionAttempt,
  type ExecutionProvider,
  type Objective,
  type Project,
  type ProviderCatalogEntry,
} from '../api/client';
import { CheckpointList } from './CheckpointList';
import { catalogEntriesFor, defaultModelId, modelsForProvider, providersForRuntime } from '../lib/provider-catalog';
import { OBJECTIVE_STATUS_LABEL, SESSION_STATUS_LABEL } from '../lib/labels';
import { HelpLink, InlineHelp } from './HelpLink';
import type { HelpTopicId } from '../content/help';

function formatDate(value: string): string {
  return new Date(value).toLocaleString('it-IT');
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `€ ${value.toFixed(4)}`;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function elapsed(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—';
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = Math.max(0, end - new Date(startedAt).getTime());
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} g ${hours % 24} h`;
}

function splitLines(value: string): string[] {
  return value.split('\n').map((l) => l.trim()).filter(Boolean);
}

export interface ObjectiveViewProps {
  projects: Project[];
  objectivesByProject: Record<string, Objective[]>;
  sessionsByObjective: Record<string, AgentSession[]>;
  checkpointsByObjective: Record<string, Checkpoint[]>;
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  busy: Record<string, boolean>;
  creating: boolean;
  onCreate: (input: CreateObjectiveInput) => Promise<void>;
  onStart: (oId: string, sId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null }) => void;
  onStop: (oId: string, sId: string, reason?: string) => void;
  onComplete: (oId: string, report?: string) => void;
  onBlock: (oId: string, reason?: string) => void;
  onFail: (oId: string, detail?: string) => void;
  onCancel: (oId: string) => void;
  onRetry: (oId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null }) => void;
  onDecide: (cId: string, dt: DecisionType, note?: string) => void;
  deciding?: string | null;
  providers: ExecutionProvider[];
  onOpenHelp: (topic: HelpTopicId) => void;
}

/**
 * Fase 4 — Vista Obiettivo (§7 e §8 CONTROL_ROOM_SPEC.md).
 * Creazione semplice per default (selezione manuale in percorso avanzato)
 * e dettaglio obiettivo: stato/attività, AI e routing, consumo, eventi,
 * e per i completati risultato/verifica/report/decisione.
 */
export function ObjectiveView({
  projects,
  objectivesByProject,
  sessionsByObjective,
  checkpointsByObjective,
  selectedProjectId,
  onSelectProject,
  busy,
  creating,
  onCreate,
  onStart,
  onStop,
  onComplete,
  onBlock,
  onFail,
  onCancel,
  onRetry,
  onDecide,
  deciding,
  providers,
  onOpenHelp,
}: ObjectiveViewProps) {
  const selected = projects.find((p) => p.id === selectedProjectId) ?? projects[0] ?? null;
  const objectives = selected ? objectivesByProject[selected.id] ?? [] : [];

  return (
    <div className="objective-view">
      <section className="panel objective-project-select">
        <div className="panel-head"><h2>Obiettivi</h2><HelpLink topic="obiettivi" onOpenHelp={onOpenHelp}>Guida obiettivi</HelpLink></div>
        <div className="project-picker">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`project-chip ${p.id === (selected?.id ?? '') ? 'active' : ''}`}
              onClick={() => onSelectProject(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </section>

      {selected && (
        <CreateObjectiveForm
          selected={selected}
          providers={providers}
          creating={creating}
          onCreate={onCreate}
          onOpenHelp={onOpenHelp}
        />
      )}

      <div className="objective-list">
        {objectives.length === 0 && <p className="muted">Nessun obiettivo per questo progetto.</p>}
        {objectives.map((o) => (
          <ObjectiveCard
            key={o.id}
            objective={o}
            sessions={sessionsByObjective[o.id] ?? []}
            checkpoints={checkpointsByObjective[o.id] ?? []}
            busy={busy[o.id] ?? false}
            onStart={onStart}
            onStop={onStop}
            onComplete={onComplete}
            onBlock={onBlock}
            onFail={onFail}
            onCancel={onCancel}
            onRetry={onRetry}
            onDecide={onDecide}
            deciding={deciding}
          />
        ))}
      </div>
    </div>
  );
}


function CreateObjectiveForm({
  selected, providers, creating, onCreate, onOpenHelp,
}: {
  selected: Project; providers: ExecutionProvider[]; creating: boolean;
  onCreate: (input: CreateObjectiveInput) => Promise<void>;
  onOpenHelp: (topic: HelpTopicId) => void;
}) {
  const [title, setTitle] = useState('');
  const [objectiveText, setObjectiveText] = useState('');
  const [stopCondition, setStopCondition] = useState('');
  const [invariants, setInvariants] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [estimatedCost, setEstimatedCost] = useState('');
  const [mode, setMode] = useState<'automatic' | 'manual'>('automatic');
  const [runtime, setRuntime] = useState('');
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [outputTokenLimit, setOutputTokenLimit] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const runtimeEntries = catalog.filter((entry) => entry.runtime.id === runtime);
  // Il catalogo può dichiarare più entry per lo stesso (runtime, provider): il
  // selettore modello deve mostrare TUTTI i modelli dell'AI Catalog per il
  // provider selezionato (unione delle entry, deduplicata per id).
  const selectedProviderEntries = catalogEntriesFor(catalog, runtime, providerId);
  const selectedProviderModels = modelsForProvider(catalog, runtime, providerId);
  const providerOptions = providersForRuntime(catalog, runtime);

  useEffect(() => {
    void api.getProviderCatalog().then((result) => setCatalog(result.catalog)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (runtimeEntries.length === 0) { setProviderId(''); setModelId(''); return; }
    const first = runtimeEntries[0];
    setProviderId(first.provider.id);
    setModelId(defaultModelId(catalog, runtime, first.provider.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, catalog]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const o = objectiveText.trim();
    if (!o) { setFormError("Il testo dell'obiettivo è obbligatorio."); return; }
    // Il titolo è facoltativo: se assente deriva dalle prime parole dell'obiettivo,
    // così basta indicare l'obiettivo (flusso immediato anche da smartphone).
    const t = title.trim() || (o.length > 60 ? `${o.slice(0, 57)}…` : o);
    setFormError(null);
    void onCreate({
      title: t,
      objectiveText: o,
      ...(invariants.trim() ? { invariants: splitLines(invariants) } : {}),
      ...(acceptanceCriteria.trim() ? { acceptanceCriteria: splitLines(acceptanceCriteria) } : {}),
      ...(stopCondition.trim() ? { stopCondition: stopCondition.trim() } : {}),
      ...(estimatedCost.trim() ? { estimatedCost: Number(estimatedCost) } : {}),
      ...(mode === 'manual' && runtime ? { runtime } : {}),
      ...(mode === 'manual' && providerId ? { providerId } : {}),
      ...(mode === 'manual' && modelId ? { modelId } : {}),
      ...(mode === 'manual' && outputTokenLimit ? { outputTokenLimit: Number(outputTokenLimit) } : {}),
    }).then(() => {
      setTitle(''); setObjectiveText(''); setStopCondition(''); setInvariants('');
      setAcceptanceCriteria(''); setEstimatedCost(''); setOutputTokenLimit('');
    });
  };


  return (
    <form onSubmit={handleSubmit} className="panel create-objective-form">
      <div className="panel-head"><h2>Nuovo obiettivo — {selected.name}</h2><HelpLink topic="obiettivi" onOpenHelp={onOpenHelp}>Scrivere un obiettivo</HelpLink></div>

      <label className="field objective-text-field">Titolo <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titolo breve (opzionale)" maxLength={200} disabled={creating} /></label>
      <label className="field objective-desc-field">Cosa deve essere raggiunto? * <textarea value={objectiveText} onChange={(e) => setObjectiveText(e.target.value)} rows={3} maxLength={50000} placeholder="Descrizione in linguaggio naturale" disabled={creating} /></label>

      <fieldset className="execution-mode">
        <legend>Esecuzione <HelpLink topic="runtime-provider-modello" onOpenHelp={onOpenHelp}>Runtime/provider/modello</HelpLink></legend>
        <label className="radio-option">
          <input type="radio" name="execution-mode" checked={mode === 'automatic'} onChange={() => setMode('automatic')} />
          <span><strong>Automatica (consigliata)</strong><span className="muted small"> G-Rex sceglie runtime/provider/modello.</span></span>
        </label>
        <label className="radio-option">
          <input type="radio" name="execution-mode" checked={mode === 'manual'} onChange={() => setMode('manual')} />
          <span><strong>Scelgo manualmente</strong><span className="muted small"> Percorso avanzato.</span></span>
        </label>
      </fieldset>

      {mode === 'manual' && (
        <div className="runtime-selection objective-runtime-selection">
          <InlineHelp topic="runtime-provider-modello" onOpenHelp={onOpenHelp}>La scelta manuale vincola il motore usato dall’obiettivo.</InlineHelp>
          <label className="field">Runtime
            <select value={runtime} onChange={(e) => setRuntime(e.target.value)} disabled={creating}>
              <option value="">Seleziona runtime</option>
              {providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.configured}>{provider.runtimeName}{provider.configured ? '' : ' (non disponibile)'}</option>)}
            </select>
          </label>
          <label className="field">Provider
            <select value={providerId} disabled={creating || runtimeEntries.length === 0}
              onChange={(e) => { setProviderId(e.target.value); setModelId(defaultModelId(catalog, runtime, e.target.value)); }}>
              {providerOptions.length === 0
                ? <option value="">Seleziona un runtime</option>
                : providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label className="field">Modello
            <select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={creating || selectedProviderEntries.length === 0 || selectedProviderModels.length === 0}>
              <option value="">{selectedProviderModels.length ? 'Seleziona modello' : 'Gestito dal runtime'}</option>
              {selectedProviderModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label>
          <label className="field">Output max <input type="number" min="1" max={selectedProviderModels.find((model) => model.id === modelId)?.limits.defaultOutputTokens || undefined} value={outputTokenLimit} onChange={(e) => setOutputTokenLimit(e.target.value)} placeholder="Limite catalogo" disabled={creating || !modelId} /></label>
        </div>
      )}

      <button type="button" className="btn btn-ghost advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? 'Nascondi avanzate' : 'Mostra opzioni avanzate'}
      </button>
      {showAdvanced && (
        <div className="objective-advanced-fields">
          <label className="field">Condizione di stop <input value={stopCondition} onChange={(e) => setStopCondition(e.target.value)} placeholder="Condizione di stop" maxLength={2000} disabled={creating} /></label>
          <label className="field">Invarianti <textarea value={invariants} onChange={(e) => setInvariants(e.target.value)} rows={2} maxLength={5000} placeholder="Uno per riga" disabled={creating} /></label>
          <label className="field">Criteri di accettazione <textarea value={acceptanceCriteria} onChange={(e) => setAcceptanceCriteria(e.target.value)} rows={2} maxLength={5000} placeholder="Uno per riga" disabled={creating} /></label>
          <label className="field">Stima costo affidabile (€) <input type="number" min="0" step="0.001" value={estimatedCost} onChange={(e) => setEstimatedCost(e.target.value)} placeholder="Opzionale: enforcement preventivo" disabled={creating} /></label>
          <InlineHelp topic="costi-budget" onOpenHelp={onOpenHelp}>Usa la stima quando vuoi un controllo preventivo sul budget.</InlineHelp>
        </div>
      )}

      {formError && <p className="form-error">{formError}</p>}
      <button type="submit" className="btn btn-primary touch-target objective-submit" disabled={creating}>{creating ? 'Creazione…' : 'Avvia obiettivo'}</button>
    </form>
  );
}


function SelectionConfirm({ session, selection, busy, onStart, onCancel }: {
  session: AgentSession;
  selection: NonNullable<AgentSession['executionSelection']>;
  busy: boolean;
  onStart: (oId: string, sId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null }) => void;
  onCancel: (oId: string) => void;
}) {
  const candidates = selection.decision?.candidates.filter((c) => c.eligible) ?? [];
  const [choice, setChoice] = useState('');
  const confirm = () => {
    if (!choice) { onStart(session.objectiveId, session.id); return; }
    const [runtimeId, providerId, modelId] = choice.split('|');
    // modelId vuoto = «modello gestito dal runtime»: invia null, non la stringa "null".
    onStart(session.objectiveId, session.id, { runtimeId, providerId, modelId: modelId || null });
  };
  return (
    <div className="selection-confirm">
      <p className="muted small">Conferma la selezione proposta prima di avviare l'esecuzione.</p>
      <div className="needs-actions">
        <button type="button" className="btn touch-target" disabled={busy} onClick={confirm}>{busy ? 'Avvio…' : 'Conferma e avvia'}</button>
        {candidates.length > 0 && (
          <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
            <option value="">Modifica…</option>
            {candidates.map((c) => (
              <option key={`${c.runtimeId}|${c.providerId}|${c.modelId ?? ''}`} value={`${c.runtimeId}|${c.providerId}|${c.modelId ?? ''}`}>
                {c.runtimeId} / {c.providerId} / {c.modelId ?? 'modello runtime'} · punteggio {c.score.toFixed(2)}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn btn-danger touch-target" disabled={busy} onClick={() => onCancel(session.objectiveId)}>Annulla obiettivo</button>
      </div>
    </div>
  );
}

function ObjectiveCard({
  objective, sessions, checkpoints, busy, onStart, onStop, onComplete,
  onBlock, onFail, onCancel, onRetry, onDecide, deciding,
}: {
  objective: Objective; sessions: AgentSession[]; checkpoints: Checkpoint[];
  busy: boolean;
  onStart: (objectiveId: string, sessionId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null }) => void;
  onStop: (objectiveId: string, sessionId: string, reason?: string) => void;
  onComplete: (objectiveId: string, report?: string) => void;
  onBlock: (objectiveId: string, reason?: string) => void;
  onFail: (objectiveId: string, detail?: string) => void;
  onCancel: (objectiveId: string) => void;
  onRetry: (objectiveId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null }) => void;
  onDecide: (checkpointId: string, decisionType: DecisionType, note?: string) => void;
  deciding?: string | null;
}) {
  const [attemptsBySession, setAttemptsBySession] = useState<Record<string, ExecutionAttempt[]>>({});
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [reason, setReason] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [failDetail, setFailDetail] = useState('');
  const [report, setReport] = useState('');

  useEffect(() => {
    void Promise.all(sessions.map(async (session) => [session.id, (await api.listExecutionAttempts(session.id)).attempts] as const))
      .then((entries) => setAttemptsBySession(Object.fromEntries(entries))).catch(() => undefined);
    void api.listEvents({ objectiveId: objective.id, limit: 15 })
      .then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, [sessions, objective.id]);

  const allAttempts = Object.values(attemptsBySession).flat();
  const totalTokens = allAttempts.reduce((sum, a) => sum + (a.totalTokens ?? 0), 0);
  const totalCost = allAttempts.reduce((sum, a) => sum + (a.costActual ?? a.costEstimate ?? 0), 0);
  const hasOpenSession = sessions.some(
    (s) => (objective.status === 'IN_AVVIO' || objective.status === 'IN_LAVORAZIONE') && (s.status === 'IN_AVVIO' || s.status === 'ATTIVA'),
  );
  const canComplete = !hasOpenSession && objective.status !== 'COMPLETATO' && objective.status !== 'ANNULLATO';
  const canCancel = !hasOpenSession && objective.status !== 'COMPLETATO' && objective.status !== 'ANNULLATO';
  // Riavvia pertinente solo per gli errori correnti non risolti (retry M19):
  // gli stati bloccati/richiedono-attenzione passano dalla decisione sul checkpoint.
  const canRetry = objective.status === 'ERRORE';
  const activeSession = sessions.find((s) => s.status === 'ATTIVA' || s.status === 'IN_AVVIO');
  const selection = activeSession?.executionSelection ?? null;


  return (
    <article className="panel objective-card">
      <header className="objective-card-head">
        <h3>{objective.title}</h3>
        <span className={`badge badge-${objective.status.toLowerCase()}`}>{OBJECTIVE_STATUS_LABEL[objective.status]}</span>
      </header>
      <p className="objective">{objective.objectiveText}</p>

      <div className="objective-meta">
        {objective.startedAt && <span className="muted small">Inizio {formatDate(objective.startedAt)}</span>}
        {objective.status !== 'COMPLETATO' && objective.startedAt && (
          <span className="muted small">Tempo trascorso {elapsed(objective.startedAt, objective.completedAt)}</span>
        )}
        {objective.completedAt && <span className="muted small">Completato {formatDate(objective.completedAt)}</span>}
      </div>

      {selection && (
        <div className="routing-box">
          <span className="objective-label">AI selezionata</span>
          <p className="routing-line">
            <strong>{selection.runtimeId}</strong> / {selection.providerId} / {selection.modelId ?? 'modello runtime'}
          </p>
          {selection.decision && (
            <p className="muted small">
              {selection.decision.mode === 'AUTOMATIC' ? 'Selezione automatica' : 'Selezione esplicita'}: {selection.decision.reason}
            </p>
          )}
          {selection.decision && selection.decision.candidates.length > 0 && (
            <details className="routing-candidates">
              <summary>Alternative valutate ({selection.decision.candidates.length})</summary>
              <ul className="candidate-list">
                {selection.decision.candidates.map((c) => (
                  <li key={`${c.runtimeId}/${c.providerId}/${c.modelId ?? 'modello-runtime'}`} className="muted small">
                    {c.runtimeId}/{c.providerId}/{c.modelId ?? 'modello-runtime'} · punteggio {c.score.toFixed(2)} · affidabilità {c.reliability.toFixed(2)} · {c.budgetFit ? 'entro budget' : 'fuori budget'} · {c.eligible ? 'ammissibile' : 'non ammissibile'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {objective.finalReport && (
        <details className="objective-section objective-collapsible">
          <summary className="objective-label">Report finale</summary>
          <p className="report-text">{objective.finalReport}</p>
        </details>
      )}

      {objective.invariants.length > 0 && (
        <div className="objective-section">
          <span className="objective-label">Invarianti</span>
          <ul className="objective-list">{objective.invariants.map((l, i) => (<li key={i}>{l}</li>))}</ul>
        </div>
      )}
      {objective.acceptanceCriteria.length > 0 && (
        <div className="objective-section">
          <span className="objective-label">Criteri di accettazione</span>
          <ul className="objective-list">{objective.acceptanceCriteria.map((l, i) => (<li key={i}>{l}</li>))}</ul>
        </div>
      )}
      {objective.stopCondition && (
        <div className="objective-section">
          <span className="objective-label">Condizione di stop</span><p>{objective.stopCondition}</p>
        </div>
      )}

      {objective.gitStart && objective.gitEnd && objective.gitStart.head !== objective.gitEnd.head && (
        <div className="objective-section">
          <span className="objective-label">Modifiche</span>
          <p className="muted small">HEAD {shortId(objective.gitStart.head ?? '')} → {shortId(objective.gitEnd.head ?? '')}{objective.gitEnd.dirty ? ' · albero sporco' : ''}</p>
        </div>
      )}

      <div className="objective-section">
        <span className="objective-label">Consumo</span>
        <p className="muted small">{totalTokens} token · {money(totalCost)}</p>
      </div>


      <details className="sessions-box objective-collapsible" open={objective.status !== 'COMPLETATO'}>
        <summary className="objective-label">Sessioni agente ({sessions.length})</summary>
        {sessions.length === 0 ? (
          <p className="muted small">Nessuna sessione registrata.</p>
        ) : sessions.map((session) => {
          const startable = session.status === 'IN_AVVIO';
          const stoppable = session.status === 'ATTIVA';
          return (
            <div className="session-row" key={session.id}>
              <div className="session-row-head">
                <span className={`badge badge-${session.status.toLowerCase()}`}>{SESSION_STATUS_LABEL[session.status]}</span>
                <span className="muted small">{session.agentType}</span>
                <time className="muted small">inizio {formatDate(session.startedAt)}</time>
                {session.endedAt && <time className="muted small">fine {formatDate(session.endedAt)}</time>}
              </div>
              {session.processReference && <code className="muted small session-ref">{session.processReference}</code>}
              {session.exitReason && <p className="muted small session-exit">{session.exitReason}</p>}
              {(attemptsBySession[session.id] ?? []).map((attempt) => (
                <p className="muted small" key={attempt.id}>Tentativo #{attempt.attemptIndex}: <strong>{attempt.status}</strong> · {attempt.runtimeName ?? 'runtime'} / {attempt.providerName ?? 'provider'} / {attempt.modelName ?? 'modello runtime'}{attempt.totalTokens !== null ? ` · ${attempt.totalTokens} token` : ''}{attempt.costActual !== null ? ` · €${attempt.costActual.toFixed(4)}` : attempt.costEstimate !== null ? ` · stim. €${attempt.costEstimate.toFixed(4)}` : ''}{attempt.reason ? ` — ${attempt.reason}` : ''}</p>
              ))}
              {startable && (session.executionSelection?.decision?.mode === 'AUTOMATIC' ? (
                <SelectionConfirm
                  session={session}
                  selection={session.executionSelection}
                  busy={busy}
                  onStart={onStart}
                  onCancel={onCancel}
                />
              ) : (
                <button type="button" className="btn touch-target" disabled={busy}
                  onClick={() => onStart(objective.id, session.id)}>
                  {busy ? 'Avvio…' : 'Avvia sessione'}
                </button>
              ))}
              {stoppable && (
                <div className="session-actions">
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo stop (opzionale)" maxLength={500} />
                  <button type="button" className="btn btn-ghost touch-target" disabled={busy}
                    onClick={() => onStop(objective.id, session.id, reason.trim() || undefined)}>
                    {busy ? 'Stop…' : 'Ferma sessione'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </details>

      {hasOpenSession && (
        <div className="objective-card-actions block-fail-actions">
          <div className="session-actions">
            <input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="Motivo blocco (opzionale)" maxLength={500} />
            <button type="button" className="btn btn-warn touch-target" disabled={busy}
              onClick={() => onBlock(objective.id, blockReason.trim() || undefined)}>
              {busy ? 'Blocco…' : 'Blocca obiettivo'}
            </button>
          </div>
          <div className="session-actions">
            <input value={failDetail} onChange={(e) => setFailDetail(e.target.value)} placeholder="Dettaglio errore (opzionale)" maxLength={1000} />
            <button type="button" className="btn btn-danger touch-target" disabled={busy}
              onClick={() => onFail(objective.id, failDetail.trim() || undefined)}>
              {busy ? 'Invio…' : 'Segnala errore'}
            </button>
          </div>
        </div>
      )}
      {canComplete && (
        <div className="session-actions complete-actions">
          <textarea value={report} onChange={(e) => setReport(e.target.value)} rows={2} maxLength={10000} placeholder="Report finale (opzionale)" />
          <button type="button" className="btn touch-target" disabled={busy}
            onClick={() => onComplete(objective.id, report.trim() || undefined)}>
            {busy ? 'Completo…' : 'Completa obiettivo'}
          </button>
        </div>
      )}
      {(canRetry || canCancel) && (
        <div className="objective-card-actions">
          {canRetry && (
            <button type="button" className="btn touch-target" disabled={busy}
              onClick={() => onRetry(objective.id)}>
              {busy ? 'Riavvio…' : 'Riavvia'}
            </button>
          )}
          {canCancel && (
            <button type="button" className="btn btn-danger touch-target" disabled={busy}
              onClick={() => onCancel(objective.id)}>Cancella</button>
          )}
        </div>
      )}

      {events.length > 0 && (
        <div className="objective-section">
          <span className="objective-label">Eventi recenti</span>
          <ul className="event-list">
            {events.slice(0, 8).map((ev) => (
              <li key={ev.id}><time>{formatDate(ev.timestamp)}</time><code>{ev.type}</code><span>{summarizeEventPayload(ev.payload)}</span></li>
            ))}
          </ul>
        </div>
      )}

      <CheckpointList checkpoints={checkpoints} onDecide={onDecide} deciding={deciding} />
    </article>
  );
}

