import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type AgentSession,
  type CreateObjectiveInput,
  type DecisionType,
  type EventRecord,
  type GitStatus,
  type Objective,
  type ObjectiveStatus,
  type Project,
  type ProjectStatus,
  type ProjectStatusGroup,
  type SessionStatus,
  type StatusResponse,
  type Checkpoint,
  type Notification,
  type ExecutionProvider,
} from './api/client';
import { CheckpointList } from './components/CheckpointList';
import { LoginPage } from './components/LoginPage';
import { MobileNav, type MobileTab } from './components/MobileNav';
import { SettingsPage } from './components/SettingsPage';

type LoadState = 'loading' | 'ready' | 'error';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  FERMO: 'Fermo', IN_AVVIO: 'In avvio', IN_LAVORAZIONE: 'In lavorazione',
  RICHIEDE_ATTENZIONE: 'Richiede attenzione', BLOCCATO: 'Bloccato',
  COMPLETATO: 'Completato', ERRORE: 'Errore',
};
const STATUS_OPTIONS: ProjectStatus[] = [
  'FERMO', 'IN_AVVIO', 'IN_LAVORAZIONE', 'RICHIEDE_ATTENZIONE',
  'BLOCCATO', 'COMPLETATO', 'ERRORE',
];
const OBJECTIVE_STATUS_LABEL: Record<ObjectiveStatus, string> = {
  IN_AVVIO: 'In avvio', IN_LAVORAZIONE: 'In lavorazione',
  RICHIEDE_ATTENZIONE: 'Richiede attenzione', BLOCCATO: 'Bloccato',
  COMPLETATO: 'Completato', ERRORE: 'Errore', ANNULLATO: 'Annullato',
};
const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  IN_AVVIO: 'In avvio', ATTIVA: 'Attiva', COMPLETATA: 'Completata',
  ERRORE: 'Errore', INTERROTTA: 'Interrotta', BLOCCATA: 'Bloccata', STALE: 'Inattiva',
};
const OPEN_OBJECTIVE_STATUSES: ObjectiveStatus[] = ['IN_AVVIO', 'IN_LAVORAZIONE'];
const GROUPS: Array<{ key: ProjectStatusGroup; label: string; hint: string }> = [
  { key: 'FERMO', label: 'Fermo', hint: 'Nessun obiettivo attivo.' },
  { key: 'IN_LAVORAZIONE', label: 'In lavorazione', hint: 'Obiettivo in corso o in avvio.' },
  { key: 'PROBLEMA', label: 'Con problema', hint: 'Richiede attenzione, bloccato o errore.' },
];
const GROUP_LABEL: Record<ProjectStatusGroup, string> = {
  FERMO: 'Fermo', IN_LAVORAZIONE: 'In lavorazione', PROBLEMA: 'Con problema',
};

function splitLines(value: string): string[] {
  return value.split('\n').map((l) => l.trim()).filter(Boolean);
}
function shortCommit(head: string | null): string {
  if (!head) return 'nessun commit';
  return head.length > 12 ? `${head.slice(0, 12)}…` : head;
}
function formatDate(value: string): string {
  return new Date(value).toLocaleString('it-IT');
}

// ── GitStatusBox ──────────────────────────────────────────────────────

function GitStatusBox({
  git, projectId, onRefresh, busy,
}: {
  git: GitStatus | null; projectId: string;
  onRefresh: (id: string) => void; busy: boolean;
}) {
  return (
    <div className="git-box">
      <div className="git-box-head">
        <h4>Stato Git</h4>
        <button type="button" className="btn btn-ghost" onClick={() => onRefresh(projectId)} disabled={busy}>
          {busy ? 'Aggiorno…' : 'Aggiorna Git'}
        </button>
      </div>
      {git === null ? (
        <p className="muted small">Non ancora letto. Premi «Aggiorna Git».</p>
      ) : git.error ? (
        <p className="git-error">⚠ {git.error}</p>
      ) : (
        <ul className="git-line">
          <li><span className="chip">{git.branch ?? 'senza ramo'}</span></li>
          <li><span className="chip chip-dim">{git.head ?? 'nessun commit'}</span></li>
          <li><span className={`chip ${git.dirty ? 'chip-dirty' : 'chip-clean'}`}>
            {git.dirty ? 'albero sporco' : 'pulito'}
          </span></li>
          {git.ahead !== null && git.behind !== null && (
            <li className="muted small">↑ {git.ahead} davanti · ↓ {git.behind} dietro</li>
          )}
          {git.lastCommit && (
            <li className="muted small">«{git.lastCommit}»{git.lastCommitAt ? ` · ${formatDate(git.lastCommitAt)}` : ''}</li>
          )}
        </ul>
      )}
      {git && <p className="muted small">Rilevato: {formatDate(git.fetchedAt)}</p>}
    </div>
  );
}

// ── ProjectCard ───────────────────────────────────────────────────────

function ProjectCard({
  project, pendingStatus, onPendingStatus, onApplyStatus, onRefreshGit,
  statusBusy, gitBusy,
}: {
  project: Project; pendingStatus: ProjectStatus;
  onPendingStatus: (id: string, status: ProjectStatus) => void;
  onApplyStatus: (project: Project) => void;
  onRefreshGit: (id: string) => void;
  statusBusy: boolean; gitBusy: boolean;
}) {
  return (
    <article className="card project-card">
      <header className="project-card-head">
        <div className="project-title">
          <h3>{project.name}</h3>
          <span className={`badge badge-${project.status.toLowerCase()}`}>
            {STATUS_LABEL[project.status] ?? project.status}
          </span>
        </div>
        <span className={`project-group-mark group-${project.statusGroup.toLowerCase()}`}>
          {GROUP_LABEL[project.statusGroup]}
        </span>
      </header>
      <p className="mono repo-path">Repository: <code>{project.repositoryPath ?? '—'}</code></p>
      {project.currentObjective && (
        <p className="objective">
          <span className="objective-label">Obiettivo corrente:</span> {project.currentObjective}
        </p>
      )}
      <GitStatusBox git={project.gitStatus} projectId={project.id} onRefresh={onRefreshGit} busy={gitBusy} />
      <div className="status-control">
        <label className="status-label">Stato operativo</label>
        <div className="status-row">
          <select value={pendingStatus ?? project.status}
            onChange={(event) => onPendingStatus(project.id, event.target.value as ProjectStatus)}>
            {STATUS_OPTIONS.map((s) => (<option key={s} value={s}>{STATUS_LABEL[s]}</option>))}
          </select>
          <button type="button" className="btn touch-target" onClick={() => onApplyStatus(project)} disabled={statusBusy}>
            {statusBusy ? 'Invio…' : 'Imposta stato'}
          </button>
        </div>
      </div>
      {project.updatedAt && <p className="muted small">Aggiornato: {formatDate(project.updatedAt)}</p>}
    </article>
  );
}
// ── ObjectiveCard ─────────────────────────────────────────────────────

function ObjectiveCard({
  objective, sessions, checkpoints, busy, onStart, onStop, onComplete,
  onBlock, onFail, onCancel, onDecide, deciding,
}: {
  objective: Objective; sessions: AgentSession[]; checkpoints: Checkpoint[];
  busy: boolean;
  onStart: (objectiveId: string, sessionId: string) => void;
  onStop: (objectiveId: string, sessionId: string, reason?: string) => void;
  onComplete: (objectiveId: string, report?: string) => void;
  onBlock: (objectiveId: string, reason?: string) => void;
  onFail: (objectiveId: string, detail?: string) => void;
  onCancel: (objectiveId: string) => void;
  onDecide?: (checkpointId: string, decisionType: DecisionType, note?: string) => void;
  deciding?: string | null;
}) {
  const [attemptsBySession, setAttemptsBySession] = useState<Record<string, import('./api/client').ExecutionAttempt[]>>({});
  useEffect(() => {
    void Promise.all(sessions.map(async (session) => [session.id, (await api.listExecutionAttempts(session.id)).attempts] as const))
      .then((entries) => setAttemptsBySession(Object.fromEntries(entries))).catch(() => undefined);
  }, [sessions]);
  const [reason, setReason] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [failDetail, setFailDetail] = useState('');
  const [report, setReport] = useState('');
  const hasOpenSession = sessions.some(
    (s) => OPEN_OBJECTIVE_STATUSES.includes(objective.status) && (s.status === 'IN_AVVIO' || s.status === 'ATTIVA'),
  );
  const canComplete = !hasOpenSession && objective.status !== 'COMPLETATO' && objective.status !== 'ANNULLATO';
  const canCancel = !hasOpenSession && objective.status !== 'COMPLETATO' && objective.status !== 'ANNULLATO';
  return (
    <article className="card objective-card">
      <header className="objective-card-head">
        <h3>{objective.title}</h3>
        <span className={`badge badge-${objective.status.toLowerCase()}`}>
          {OBJECTIVE_STATUS_LABEL[objective.status]}
        </span>
      </header>
      <p className="objective">{objective.objectiveText}</p>
      {objective.invariants && (
        <div className="objective-section">
          <span className="objective-label">Invarianti</span>
          <ul className="objective-list">{objective.invariants.map((l, i) => (<li key={i}>{l}</li>))}</ul>
        </div>
      )}
      {objective.acceptanceCriteria && (
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
      {objective.gitStart && <p className="muted small">Git inizio: <code className="git-ref">{shortCommit(objective.gitStart.head ?? null)}</code></p>}
      {objective.gitEnd && <p className="muted small">Git fine: <code className="git-ref">{shortCommit(objective.gitEnd.head ?? null)}</code></p>}
      {objective.startedAt && <p className="muted small">Inizio: {formatDate(objective.startedAt)}</p>}
      {objective.completedAt && <p className="muted small">Completato: {formatDate(objective.completedAt)}</p>}
      {objective.finalReport && (
        <div className="objective-section">
          <span className="objective-label">Report finale</span><p className="report-text">{objective.finalReport}</p>
        </div>
      )}

      <div className="sessions-box">
        <span className="objective-label">Sessioni agente</span>
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
              {(attemptsBySession[session.id] ?? []).map((attempt) => <p className="muted small" key={attempt.id}>Tentativo #{attempt.attemptIndex}: <strong>{attempt.status}</strong> · {attempt.runtimeName ?? 'runtime'} / {attempt.providerName ?? 'provider'}{attempt.totalTokens !== null ? ` · ${attempt.totalTokens} token` : ''}{attempt.costActual !== null ? ` · €${attempt.costActual.toFixed(4)}` : attempt.costEstimate !== null ? ` · stim. €${attempt.costEstimate.toFixed(4)}` : ''}{attempt.reason ? ` — ${attempt.reason}` : ''}</p>)}
              {startable && (
                <button type="button" className="btn touch-target" disabled={busy}
                  onClick={() => onStart(objective.id, session.id)}>
                  {busy ? 'Avvio…' : 'Avvia sessione'}
                </button>
              )}
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
      </div>
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
      {canCancel && (
        <div className="objective-card-actions">
          <button type="button" className="btn btn-danger touch-target" disabled={busy}
            onClick={() => onCancel(objective.id)}>Annulla obiettivo</button>
        </div>
      )}
      <CheckpointList checkpoints={checkpoints} onDecide={onDecide} deciding={deciding} />
    </article>
  );
}

// ── ObjectivesSection ─────────────────────────────────────────────────

function ObjectivesSection({
  projects, objectivesByProject, sessionsByObjective, checkpointsByObjective,
  selectedProjectId, onSelectProject, busy, creating, onCreate, onStart,
  onStop, onComplete, onBlock, onFail, onCancel, onDecide, deciding, providers,
}: {
  projects: Project[]; objectivesByProject: Record<string, Objective[]>;
  sessionsByObjective: Record<string, AgentSession[]>; checkpointsByObjective: Record<string, Checkpoint[]>;
  selectedProjectId: string; onSelectProject: (id: string) => void;
  busy: Record<string, boolean>; creating: boolean;
  onCreate: (input: CreateObjectiveInput) => Promise<void>;
  onStart: (oId: string, sId: string) => void;
  onStop: (oId: string, sId: string, reason?: string) => void;
  onComplete: (oId: string, report?: string) => void;
  onBlock: (oId: string, reason?: string) => void;
  onFail: (oId: string, detail?: string) => void;
  onCancel: (oId: string) => void;
  onDecide?: (cId: string, dt: DecisionType, note?: string) => void;
  deciding?: string | null;
  providers: ExecutionProvider[];
}) {
  const [title, setTitle] = useState('');
  const [objectiveText, setObjectiveText] = useState('');
  const [invariants, setInvariants] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [stopCondition, setStopCondition] = useState('');
  const [runtime, setRuntime] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const selected = projects.find((p) => p.id === selectedProjectId) ?? null;
  const objectives = selected ? objectivesByProject[selected.id] ?? [] : [];
  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const t = title.trim(); const o = objectiveText.trim();
    if (!t || !o) { setFormError("Titolo e testo dell'obiettivo sono obbligatori."); return; }
    setFormError(null);
    void onCreate({
      title: t, objectiveText: o,
      ...(invariants.trim() ? { invariants: splitLines(invariants) } : {}),
      ...(acceptanceCriteria.trim() ? { acceptanceCriteria: splitLines(acceptanceCriteria) } : {}),
      ...(stopCondition.trim() ? { stopCondition: stopCondition.trim() } : {}),
      ...(runtime ? { runtime } : {}),
    }).then(() => { setTitle(''); setObjectiveText(''); setInvariants(''); setAcceptanceCriteria(''); setStopCondition(''); });
  };
  return (
    <div className="objectives-section">
      <div className="objectives-project-select">
        <label className="select-label">
          Progetto
          <select value={selectedProjectId} onChange={(e) => onSelectProject(e.target.value)}>
            <option value="">— Seleziona —</option>
            {projects.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
          </select>
        </label>
      </div>
      {selected && (
        <form onSubmit={handleSubmit} className="card create-objective-form">
          <h3>Nuovo obiettivo per {selected.name}</h3>
          <label className="field">Titolo * <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titolo breve" maxLength={200} disabled={creating} /></label>
          <label className="field">Obiettivo * <textarea value={objectiveText} onChange={(e) => setObjectiveText(e.target.value)} rows={3} maxLength={5000} placeholder="Descrizione dettagliata" disabled={creating} /></label>
          <label className="field">Runtime <select value={runtime} onChange={(e) => setRuntime(e.target.value)} disabled={creating}><option value="">Predefinito</option>{providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.configured}>{provider.runtimeName}{provider.configured ? '' : ' (non disponibile)'}</option>)}</select></label>
          <label className="field">Invarianti <textarea value={invariants} onChange={(e) => setInvariants(e.target.value)} rows={2} maxLength={5000} placeholder="Invarianti (uno per riga)" disabled={creating} /></label>
          <label className="field">Criteri di accettazione <textarea value={acceptanceCriteria} onChange={(e) => setAcceptanceCriteria(e.target.value)} rows={2} maxLength={5000} placeholder="Criteri (uno per riga)" disabled={creating} /></label>
          <label className="field">Condizione di stop <input value={stopCondition} onChange={(e) => setStopCondition(e.target.value)} placeholder="Condizione di stop" maxLength={2000} disabled={creating} /></label>
          {formError && <p className="form-error">{formError}</p>}
          <button type="submit" className="btn btn-primary touch-target" disabled={creating}>{creating ? 'Creazione…' : 'Crea obiettivo'}</button>
        </form>
      )}
      {objectives.map((o) => (
        <ObjectiveCard key={o.id} objective={o} sessions={sessionsByObjective[o.id] ?? []}
          checkpoints={checkpointsByObjective[o.id] ?? []} busy={busy[o.id] ?? false}
          onStart={onStart} onStop={onStop} onComplete={onComplete} onBlock={onBlock}
          onFail={onFail} onCancel={onCancel} onDecide={onDecide} deciding={deciding} />
      ))}
      {selected && objectives.length === 0 && <p className="muted">Nessun obiettivo per questo progetto.</p>}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────

export default function App() {
  // Auth
  const [authenticated, setAuthenticated] = useState(true);
  const [checkingAuth, setCheckingAuth] = useState(true);
  // Data
  const [, setStatus] = useState<StatusResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [historyEvents, setHistoryEvents] = useState<EventRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyProjectId, setHistoryProjectId] = useState('');
  const [historyObjectiveId, setHistoryObjectiveId] = useState('');
  const [historySessionId, setHistorySessionId] = useState('');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Navigation
  const [activeTab, setActiveTab] = useState<MobileTab>('home');
  // Form state
  const [name, setName] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [objective, setObjective] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<Record<string, ProjectStatus>>({});
  const [statusBusy, setStatusBusy] = useState<Record<string, boolean>>({});
  const [gitBusy, setGitBusy] = useState<Record<string, boolean>>({});
  // Objectives
  const [objectivesByProject, setObjectivesByProject] = useState<Record<string, Objective[]>>({});
  const [sessionsByObjective, setSessionsByObjective] = useState<Record<string, AgentSession[]>>({});
  const [checkpointsByObjective, setCheckpointsByObjective] = useState<Record<string, Checkpoint[]>>({});
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [objectiveBusy, setObjectiveBusy] = useState<Record<string, boolean>>({});
  const [creatingObjective, setCreatingObjective] = useState(false);
  const [decidingCheckpoint, setDecidingCheckpoint] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [providers, setProviders] = useState<ExecutionProvider[]>([]);

  // M7: Check auth on mount
  useEffect(() => {
    void api.authMe()
      .then(() => { setAuthenticated(true); setCheckingAuth(false); })
      .catch(() => { setAuthenticated(false); setCheckingAuth(false); });
  }, []);

  const loadM3 = useCallback(async (projectsList: Project[]) => {
    const lo: Record<string, Objective[]> = {};
    const ls: Record<string, AgentSession[]> = {};
    const lc: Record<string, Checkpoint[]> = {};
    for (const project of projectsList) {
      const { objectives } = await api.listObjectives(project.id);
      lo[project.id] = objectives;
      const details = await Promise.all(objectives.map((o) => api.getObjective(o.id)));
      for (const d of details) { ls[d.objective.id] = d.sessions; lc[d.objective.id] = d.checkpoints; }
    }
    setObjectivesByProject(lo); setSessionsByObjective(ls); setCheckpointsByObjective(lc);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [sr, pr, er, nr, runtimeList] = await Promise.all([api.status(), api.listProjects(), api.listEvents(30), api.listNotifications(), api.listExecutionProviders()]);
      setStatus(sr); setProjects(pr.projects); setEvents(er.events); setNotifications(nr.notifications); setProviders(runtimeList.providers);
      await loadM3(pr.projects); setLoadState('ready'); setError(null);
    } catch (err) { setLoadState('error'); setError(err instanceof Error ? err.message : String(err)); }
  }, [loadM3]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { void api.listNotifications().then((r) => setNotifications(r.notifications)).catch(() => undefined); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { if (!selectedProjectId && projects.length > 0) setSelectedProjectId(projects[0].id); }, [projects, selectedProjectId]);
  useEffect(() => { if (!historyProjectId && selectedProjectId) setHistoryProjectId(selectedProjectId); }, [selectedProjectId, historyProjectId]);
  useEffect(() => {
    const loadHistory = async () => {
      setHistoryLoading(true); setHistoryError(null);
      try {
        const r = await api.listEvents({ limit: 100, projectId: historyProjectId || undefined,
          objectiveId: historyObjectiveId || undefined, sessionId: historySessionId || undefined });
        setHistoryEvents(r.events);
      } catch (err) { setHistoryError(err instanceof Error ? err.message : String(err)); }
      finally { setHistoryLoading(false); }
    };
    void loadHistory();
  }, [historyProjectId, historyObjectiveId, historySessionId]);

  // ── Handlers ──
  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const t = name.trim();
    if (!t) { setFormError('Il nome del progetto è obbligatorio.'); return; }
    setSubmitting(true); setFormError(null);
    try {
      await api.createProject({ name: t,
        ...(repositoryPath.trim() ? { repositoryPath: repositoryPath.trim() } : {}),
        ...(objective.trim() ? { currentObjective: objective.trim() } : {}) });
      setName(''); setRepositoryPath(''); setObjective(''); await refresh();
    } catch (err) { setFormError(err instanceof Error ? err.message : String(err)); }
    finally { setSubmitting(false); }
  };
  const handleRefreshGit = async (id: string) => {
    setActionError(null); setGitBusy((p) => ({ ...p, [id]: true }));
    try { await api.refreshProjectGitStatus(id); await refresh(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setGitBusy((p) => ({ ...p, [id]: false })); }
  };
  const handleApplyStatus = async (project: Project) => {
    const target = pendingStatus[project.id] ?? project.status;
    setActionError(null); setStatusBusy((p) => ({ ...p, [project.id]: true }));
    try { await api.setProjectStatus(project.id, target); await refresh(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setStatusBusy((p) => ({ ...p, [project.id]: false })); }
  };
  const handlePendingStatus = (id: string, s: ProjectStatus) =>
    setPendingStatus((p) => ({ ...p, [id]: s }));
  const runObjAction = async (objectiveId: string, action: () => Promise<unknown>) => {
    setActionError(null); setObjectiveBusy((p) => ({ ...p, [objectiveId]: true }));
    try { await action(); await refresh(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setObjectiveBusy((p) => ({ ...p, [objectiveId]: false })); }
  };
  const handleDecide = async (checkpointId: string, decisionType: DecisionType, note?: string) => {
    setActionError(null); setDecidingCheckpoint(checkpointId);
    try { await api.decideCheckpoint(checkpointId, decisionType, note); await refresh(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setDecidingCheckpoint(null); }
  };
  const handleStart = (oId: string, sId: string) => runObjAction(oId, () => api.startSession(oId, sId));
  const handleStop = (oId: string, sId: string, reason?: string) => runObjAction(oId, () => api.stopSession(oId, sId, reason));
  const handleComplete = (oId: string, report?: string) => runObjAction(oId, () => api.completeObjective(oId, report));
  const handleBlock = (oId: string, reason?: string) => runObjAction(oId, () => api.blockObjective(oId, reason));
  const handleFail = (oId: string, detail?: string) => runObjAction(oId, () => api.failObjective(oId, detail));
  const handleCancel = (oId: string) => runObjAction(oId, () => api.cancelObjective(oId));
  const markNotificationsRead = async () => { await api.markAllNotificationsRead(); setNotifications([]); };
  const handleCreateObj = async (input: CreateObjectiveInput) => {
    setCreatingObjective(true); setActionError(null);
    try { await api.createObjective(selectedProjectId, input); await refresh(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setCreatingObjective(false); }
  };

  // ── Auth guard ──
  if (checkingAuth) {
    return (<div className="login-container"><div className="login-card"><div className="login-logo">🦖</div><p className="muted">Verifica autenticazione...</p></div></div>);
  }
  if (!authenticated) {
    return <LoginPage onAuthenticated={() => { setAuthenticated(true); void refresh(); }} />;
  }

  const pendingDecisions = Object.values(checkpointsByObjective).flat().filter((c) => c.status === 'PENDING_DECISION').length;

  if (loadState === 'error') {
    return (
      <div className="app-container">
        <header className="app-header"><h1>🦖 G-Rex Agent Control</h1></header>
        <div className="error-container">
          <p className="error-title">⚠ Errore di connessione</p><p className="error-message">{error}</p>
          <button type="button" className="btn btn-primary touch-target" onClick={() => void refresh()}>Riprova</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>🦖 G-Rex Agent Control</h1>
        <div className="header-right">
          {pendingDecisions > 0 && <span className="pending-badge">🔔 {pendingDecisions}</span>}
          <span className="app-version">v0.4.0</span>
        </div>
      </header>
      {loadState === 'loading' ? (
        <main className="app-main"><p className="muted">Caricamento…</p></main>
      ) : (<main className="app-main">

          {notifications.length > 0 && <section className="card" aria-live="polite">
            <div className="git-box-head"><h2>Notifiche ({notifications.length})</h2><button type="button" className="btn btn-ghost" onClick={() => void markNotificationsRead()}>Segna lette</button></div>
            <ul className="event-list">{notifications.slice(0, 5).map((notification) => <li key={notification.id}><time>{formatDate(notification.createdAt)}</time><code>{notification.severity}</code><span><strong>{notification.title}</strong> — {notification.message}</span></li>)}</ul>
          </section>}

          {(actionError || formError) && (
            <div className="error-bar" onClick={() => { setActionError(null); setFormError(null); }}>
              ⚠ {actionError || formError}<span className="error-dismiss">✕</span>
            </div>
          )}
          {/* HOME TAB */}
          {activeTab === 'home' && (<div className="tab-content">
            <section className="card">
              <h2>Progetti</h2>
              {projects.length === 0 ? <p className="muted">Nessun progetto. Vai a Progetti.</p> : (
                <div className="summary-grid">
                  {GROUPS.map((group) => {
                    const grouped = projects.filter((p) => p.statusGroup === group.key);
                    return (
                      <div key={group.key} className="summary-cell">
                        <h3 className={`summary-title group-${group.key.toLowerCase()}`}>{group.label} ({grouped.length})</h3>
                        {grouped.length === 0 ? <p className="muted small">{group.hint}</p> : (
                          <ul className="summary-list">
                            {grouped.map((p) => (
                              <li key={p.id} className="summary-item clickable"
                                onClick={() => { setSelectedProjectId(p.id); setActiveTab('projects'); }}>
                                <strong>{p.name}</strong>
                                <span className={`badge badge-${p.status.toLowerCase()}`}>{STATUS_LABEL[p.status]}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            {pendingDecisions > 0 && (
              <section className="card pending-section">
                <h2>🔔 Decisioni pendenti ({pendingDecisions})</h2>
              </section>
            )}
            <section className="card">
              <h2>Attività recente</h2>
              {events.length === 0 ? <p className="muted">Nessun evento recente.</p> : (
                <ul className="event-list">
                  {events.map((ev) => (
                    <li key={ev.id}><time>{formatDate(ev.timestamp)}</time><code>{ev.type}</code>
                      <span>{ev.payload ? JSON.stringify(ev.payload) : ''}</span></li>
                  ))}
                </ul>
              )}
            </section>
          </div>)}

          {/* PROJECTS TAB */}
          {activeTab === 'projects' && (<div className="tab-content">
            <section className="card">
              <h2>Nuovo progetto</h2>
              <form onSubmit={handleSubmit} className="create-project-form">
                <label className="field">Nome * <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome del progetto" maxLength={200} disabled={submitting} /></label>
                <label className="field">Repository <input value={repositoryPath} onChange={(e) => setRepositoryPath(e.target.value)} placeholder="/percorso/al/repository" maxLength={2000} disabled={submitting} /></label>
                <label className="field">Obiettivo iniziale <input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Opzionale" maxLength={2000} disabled={submitting} /></label>
                {formError && <p className="form-error">{formError}</p>}
                <button type="submit" className="btn btn-primary touch-target" disabled={submitting}>{submitting ? 'Creazione…' : 'Crea progetto'}</button>
              </form>
            </section>
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} pendingStatus={pendingStatus[p.id] ?? p.status}
                onPendingStatus={handlePendingStatus} onApplyStatus={handleApplyStatus}
                onRefreshGit={handleRefreshGit} statusBusy={statusBusy[p.id] ?? false} gitBusy={gitBusy[p.id] ?? false} />
            ))}
            <ObjectivesSection projects={projects} objectivesByProject={objectivesByProject}
              sessionsByObjective={sessionsByObjective} checkpointsByObjective={checkpointsByObjective}
              selectedProjectId={selectedProjectId} onSelectProject={setSelectedProjectId}
              busy={objectiveBusy} creating={creatingObjective} onCreate={handleCreateObj}
              onStart={handleStart} onStop={handleStop} onComplete={handleComplete}
              onBlock={handleBlock} onFail={handleFail} onCancel={handleCancel}
              onDecide={handleDecide} deciding={decidingCheckpoint} providers={providers} />
          </div>)}

          {/* HISTORY TAB */}
          {activeTab === 'history' && (<div className="tab-content">
            <section className="card">
              <h2>Cronologia storica</h2>
              <div className="filter-row">
                <label className="select-label">Progetto
                  <select value={historyProjectId} onChange={(e) => { setHistoryProjectId(e.target.value); setHistoryObjectiveId(''); setHistorySessionId(''); }}>
                    <option value="">— Tutti —</option>
                    {projects.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                  </select>
                </label>
                {historyProjectId && (
                  <label className="select-label">Obiettivo
                    <select value={historyObjectiveId} onChange={(e) => { setHistoryObjectiveId(e.target.value); setHistorySessionId(''); }}>
                      <option value="">— Tutti —</option>
                      {(objectivesByProject[historyProjectId] ?? []).map((o) => (<option key={o.id} value={o.id}>{o.title}</option>))}
                    </select>
                  </label>
                )}
                {historyObjectiveId && (sessionsByObjective[historyObjectiveId]?.length ?? 0) > 0 && (
                  <label className="select-label">Sessione
                    <select value={historySessionId} onChange={(e) => setHistorySessionId(e.target.value)}>
                      <option value="">— Tutte —</option>
                      {sessionsByObjective[historyObjectiveId].map((s) => (
                        <option key={s.id} value={s.id}>{s.id.slice(0, 8)}… ({SESSION_STATUS_LABEL[s.status]})</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {historyLoading && <p className="muted">Caricamento…</p>}
              {historyError && <p className="form-error">Errore: {historyError}</p>}
              {!historyLoading && historyEvents.length === 0 ? <p className="muted">Nessun evento.</p> : (
                <ul className="event-list">
                  {historyEvents.map((ev) => (
                    <li key={ev.id}><time>{formatDate(ev.timestamp)}</time><code>{ev.type}</code>
                      <span>{ev.payload ? JSON.stringify(ev.payload) : ''}</span></li>
                  ))}
                </ul>
              )}
            </section>
          </div>)}
          {/* SETTINGS TAB */}
          {activeTab === 'settings' && (<div className="tab-content">
            <SettingsPage onLogout={() => setAuthenticated(false)} version="0.4.0" />
          </div>)}
        </main>
      )}
      <footer className="footer">
        <p>Solo rete locale / VPN Tailscale · nessun servizio esterno · SQLite <code>data/gac.sqlite</code></p>
      </footer>
      <MobileNav active={activeTab} onChange={setActiveTab} pendingDecisions={pendingDecisions} />
    </div>
  );
}
