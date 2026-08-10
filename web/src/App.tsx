import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type AgentSession,
  type CreateObjectiveInput,
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
} from './api/client';
import { CheckpointList } from './components/CheckpointList';

type LoadState = 'loading' | 'ready' | 'error';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  FERMO: 'Fermo',
  IN_AVVIO: 'In avvio',
  IN_LAVORAZIONE: 'In lavorazione',
  RICHIEDE_ATTENZIONE: 'Richiede attenzione',
  BLOCCATO: 'Bloccato',
  COMPLETATO: 'Completato',
  ERRORE: 'Errore',
};

const STATUS_OPTIONS: ProjectStatus[] = [
  'FERMO',
  'IN_AVVIO',
  'IN_LAVORAZIONE',
  'RICHIEDE_ATTENZIONE',
  'BLOCCATO',
  'COMPLETATO',
  'ERRORE',
];

const OBJECTIVE_STATUS_LABEL: Record<ObjectiveStatus, string> = {
  IN_AVVIO: 'In avvio',
  IN_LAVORAZIONE: 'In lavorazione',
  RICHIEDE_ATTENZIONE: 'Richiede attenzione',
  BLOCCATO: 'Bloccato',
  COMPLETATO: 'Completato',
  ERRORE: 'Errore',
  ANNULLATO: 'Annullato',
};

const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  IN_AVVIO: 'In avvio',
  ATTIVA: 'Attiva',
  COMPLETATA: 'Completata',
  ERRORE: 'Errore',
  INTERROTTA: 'Interrotta',
};

/** Stati di obiettivo non terminali: finché esistono, l'invariante §14 resta attivo. */
const NON_TERMINAL_OBJECTIVE_STATUSES: ObjectiveStatus[] = [
  'IN_AVVIO',
  'IN_LAVORAZIONE',
  'RICHIEDE_ATTENZIONE',
  'BLOCCATO',
];

/** Stati in cui l'obiettivo ha una sessione ancora aperta (avviabile o attiva). */
const OPEN_OBJECTIVE_STATUSES: ObjectiveStatus[] = ['IN_AVVIO', 'IN_LAVORAZIONE'];

/** Una riga per voce: utile per invarianti e criteri di accettazione inseriti a capo. */
function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function shortCommit(head: string | null): string {
  if (!head) return 'nessun commit';
  return head.length > 12 ? `${head.slice(0, 12)}…` : head;
}

/** I tre macro-gruppi che la dashboard M2 deve distinguere in modo affidabile. */
const GROUPS: Array<{ key: ProjectStatusGroup; label: string; hint: string }> = [
  { key: 'FERMO', label: 'Fermo', hint: 'Nessun obiettivo attivo.' },
  { key: 'IN_LAVORAZIONE', label: 'In lavorazione', hint: 'Obiettivo in corso o in avvio.' },
  { key: 'PROBLEMA', label: 'Con problema', hint: 'Richiede attenzione, bloccato o errore.' },
];

const GROUP_LABEL: Record<ProjectStatusGroup, string> = {
  FERMO: 'Fermo',
  IN_LAVORAZIONE: 'In lavorazione',
  PROBLEMA: 'Con problema',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString('it-IT');
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`;
}

function GitStatusBox({
  git,
  projectId,
  onRefresh,
  busy,
}: {
  git: GitStatus | null;
  projectId: string;
  onRefresh: (id: string) => void;
  busy: boolean;
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
        <p className="muted small">Non ancora letto. Premi «Aggiorna Git» per rilevare ramo, HEAD e pulizia.</p>
      ) : git.error ? (
        <p className="git-error">⚠ {git.error}</p>
      ) : (
        <ul className="git-line">
          <li>
            <span className="chip">{git.branch ?? 'senza ramo'}</span>
          </li>
          <li>
            <span className="chip chip-dim">{git.head ?? 'nessun commit'}</span>
          </li>
          <li>
            <span className={`chip ${git.dirty ? 'chip-dirty' : 'chip-clean'}`}>
              {git.dirty ? 'albero sporco' : 'pulito'}
            </span>
          </li>
          {git.ahead !== null && git.behind !== null && (
            <li className="muted small">
              ↑ {git.ahead} davanti · ↓ {git.behind} dietro
            </li>
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

function ProjectCard({
  project,
  pendingStatus,
  onPendingStatus,
  onApplyStatus,
  onRefreshGit,
  statusBusy,
  gitBusy,
}: {
  project: Project;
  pendingStatus: ProjectStatus;
  onPendingStatus: (id: string, status: ProjectStatus) => void;
  onApplyStatus: (project: Project) => void;
  onRefreshGit: (id: string) => void;
  statusBusy: boolean;
  gitBusy: boolean;
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

      <p className="mono repo-path">
        Repository: <code>{project.repositoryPath ?? '—'}</code>
      </p>

      {project.currentObjective && (
        <p className="objective">
          <span className="objective-label">Obiettivo corrente:</span> {project.currentObjective}
        </p>
      )}

      <GitStatusBox git={project.gitStatus} projectId={project.id} onRefresh={onRefreshGit} busy={gitBusy} />

      <div className="status-control">
        <label className="status-label">Stato operativo</label>
        <div className="status-row">
          <select
            value={pendingStatus ?? project.status}
            onChange={(event) => onPendingStatus(project.id, event.target.value as ProjectStatus)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => onApplyStatus(project)} disabled={statusBusy}>
            {statusBusy ? 'Invio…' : 'Imposta stato'}
          </button>
        </div>
      </div>
    </article>
  );
}

function ObjectiveCard({
  objective,
  sessions,
  checkpoints,
  busy,
  onStart,
  onStop,
  onComplete,
  onBlock,
  onFail,
  onCancel,
}: {
  objective: Objective;
  sessions: AgentSession[];
  checkpoints: Checkpoint[];
  busy: boolean;
  onStart: (objectiveId: string, sessionId: string) => void;
  onStop: (objectiveId: string, sessionId: string, reason?: string) => void;
  onComplete: (objectiveId: string, report?: string) => void;
  onBlock: (objectiveId: string, reason?: string) => void;
  onFail: (objectiveId: string, detail?: string) => void;
  onCancel: (objectiveId: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [report, setReport] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [failDetail, setFailDetail] = useState('');

  const canCancel = NON_TERMINAL_OBJECTIVE_STATUSES.includes(objective.status);
  const canComplete = OPEN_OBJECTIVE_STATUSES.includes(objective.status);
  const hasOpenSession = sessions.some((s) => s.status === 'IN_AVVIO' || s.status === 'ATTIVA');

  return (
    <article className="objective-card">
      <header className="objective-card-head">
        <h3>{objective.title}</h3>
        <span className={`badge badge-${objective.status.toLowerCase()}`}>
          {OBJECTIVE_STATUS_LABEL[objective.status]}
        </span>
      </header>

      <p className="objective-text">{objective.objectiveText}</p>

      {objective.invariants.length > 0 && (
        <div className="objective-list">
          <span className="objective-label">Invarianti</span>
          <ul>
            {objective.invariants.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {objective.acceptanceCriteria.length > 0 && (
        <div className="objective-list">
          <span className="objective-label">Criteri di accettazione</span>
          <ul>
            {objective.acceptanceCriteria.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {objective.stopCondition && (
        <p className="muted small">Condizione di stop: {objective.stopCondition}</p>
      )}

      <div className="objective-snapshots">
        {objective.gitStart && (
          <span className="chip chip-dim" title={`Snapshot di inizio (${formatDate(objective.gitStart.fetchedAt)})`}>
            Git inizio: {objective.gitStart.branch ?? '?'} @ {shortCommit(objective.gitStart.head)}
          </span>
        )}
        {objective.gitEnd && (
          <span className="chip chip-clean" title={`Snapshot di fine (${formatDate(objective.gitEnd.fetchedAt)})`}>
            Git fine: {objective.gitEnd.branch ?? '?'} @ {shortCommit(objective.gitEnd.head)}
          </span>
        )}
      </div>

      {objective.finalReport && (
        <div className="report-box">
          <span className="objective-label">Report finale</span>
          <p>{objective.finalReport}</p>
        </div>
      )}

      <div className="sessions-box">
        <span className="objective-label">Sessioni agente</span>
        {sessions.length === 0 ? (
          <p className="muted small">Nessuna sessione registrata.</p>
        ) : (
          sessions.map((session) => {
            const startable = session.status === 'IN_AVVIO';
            const stoppable = session.status === 'ATTIVA';
            return (
              <div className="session-row" key={session.id}>
                <div className="session-row-head">
                  <span className={`badge badge-${session.status.toLowerCase()}`}>
                    {SESSION_STATUS_LABEL[session.status]}
                  </span>
                  <span className="muted small">{session.agentType}</span>
                  <time className="muted small">inizio {formatDate(session.startedAt)}</time>
                  {session.endedAt && (
                    <time className="muted small">fine {formatDate(session.endedAt)}</time>
                  )}
                </div>
                {session.processReference && (
                  <code className="muted small session-ref">{session.processReference}</code>
                )}
                {session.exitReason && <p className="muted small session-exit">{session.exitReason}</p>}
                {startable && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => onStart(objective.id, session.id)}
                  >
                    {busy ? 'Avvio…' : 'Avvia sessione'}
                  </button>
                )}
                {stoppable && (
                  <div className="session-actions">
                    <input
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Motivo stop (opzionale)"
                      maxLength={500}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => onStop(objective.id, session.id, reason.trim() || undefined)}
                    >
                      {busy ? 'Stop…' : 'Ferma sessione'}
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {hasOpenSession && (
        <div className="objective-card-actions block-fail-actions">
          <div className="session-actions">
            <input
              value={blockReason}
              onChange={(event) => setBlockReason(event.target.value)}
              placeholder="Motivo blocco (opzionale)"
              maxLength={500}
            />
            <button
              type="button"
              className="btn btn-warn"
              disabled={busy}
              onClick={() => onBlock(objective.id, blockReason.trim() || undefined)}
            >
              {busy ? 'Blocco…' : 'Blocca obiettivo'}
            </button>
          </div>
          <div className="session-actions">
            <input
              value={failDetail}
              onChange={(event) => setFailDetail(event.target.value)}
              placeholder="Dettaglio errore (opzionale)"
              maxLength={1000}
            />
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => onFail(objective.id, failDetail.trim() || undefined)}
            >
              {busy ? 'Invio…' : 'Segnala errore'}
            </button>
          </div>
        </div>
      )}

      {canComplete && (
        <div className="session-actions complete-actions">
          <textarea
            value={report}
            onChange={(event) => setReport(event.target.value)}
            rows={2}
            maxLength={10000}
            placeholder="Report finale (opzionale)"
          />
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onComplete(objective.id, report.trim() || undefined)}
          >
            {busy ? 'Completo…' : 'Completa obiettivo'}
          </button>
        </div>
      )}

      {canCancel && (
        <div className="objective-card-actions">
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onCancel(objective.id)}>
            Annulla obiettivo
          </button>
        </div>
      )}

      <CheckpointList checkpoints={checkpoints} />
    </article>
  );
}

function ObjectivesSection({
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
}: {
  projects: Project[];
  objectivesByProject: Record<string, Objective[]>;
  sessionsByObjective: Record<string, AgentSession[]>;
  checkpointsByObjective: Record<string, Checkpoint[]>;
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  busy: Record<string, boolean>;
  creating: boolean;
  onCreate: (input: CreateObjectiveInput) => Promise<void>;
  onStart: (objectiveId: string, sessionId: string) => void;
  onStop: (objectiveId: string, sessionId: string, reason?: string) => void;
  onComplete: (objectiveId: string, report?: string) => void;
  onBlock: (objectiveId: string, reason?: string) => void;
  onFail: (objectiveId: string, detail?: string) => void;
  onCancel: (objectiveId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [objectiveText, setObjectiveText] = useState('');
  const [invariants, setInvariants] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [stopCondition, setStopCondition] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const selected = projects.find((p) => p.id === selectedProjectId) ?? null;
  const objectives = selected ? objectivesByProject[selected.id] ?? [] : [];

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedText = objectiveText.trim();
    if (!trimmedTitle || !trimmedText) {
      setFormError("Titolo e testo dell'obiettivo sono obbligatori.");
      return;
    }
    setFormError(null);
    void onCreate({
      title: trimmedTitle,
      objectiveText: trimmedText,
      invariants: splitLines(invariants),
      acceptanceCriteria: splitLines(acceptanceCriteria),
      ...(stopCondition.trim() ? { stopCondition: stopCondition.trim() } : {}),
    })
      .then(() => {
        setTitle('');
        setObjectiveText('');
        setInvariants('');
        setAcceptanceCriteria('');
        setStopCondition('');
      })
      .catch(() => {
        // L'errore dell'API viene mostrato nella barra superiore: i campi restano compilati.
      });
  };

  return (
    <section className="card span-2 objectives-section">
      <header className="group-head">
        <h2>Obiettivi e sessioni agente</h2>
        <p className="muted small">
          Ciclo obiettivo → sessione agente (§5): un solo obiettivo attivo per progetto.
        </p>
      </header>

      <label className="select-label">
        Progetto
        <select value={selectedProjectId} onChange={(event) => onSelectProject(event.target.value)}>
          <option value="">— Seleziona un progetto —</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      {selected && (
        <>
          <form className="form objective-form" onSubmit={handleSubmit}>
            <h3>Nuovo obiettivo su «{selected.name}»</h3>
            <label>
              Titolo
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                placeholder="es. Completare la fondazione operativa"
              />
            </label>
            <label>
              Testo dell'obiettivo
              <textarea
                value={objectiveText}
                onChange={(event) => setObjectiveText(event.target.value)}
                rows={3}
                maxLength={8000}
                placeholder="Cosa deve fare l'agente."
              />
            </label>
            <label>
              Invarianti (una per riga, facoltativo)
              <textarea
                value={invariants}
                onChange={(event) => setInvariants(event.target.value)}
                rows={2}
                placeholder="es. Non esporre porte verso Internet"
              />
            </label>
            <label>
              Criteri di accettazione (una per riga, facoltativo)
              <textarea
                value={acceptanceCriteria}
                onChange={(event) => setAcceptanceCriteria(event.target.value)}
                rows={2}
                placeholder="es. I test passano"
              />
            </label>
            <label>
              Condizione di stop (facoltativo)
              <textarea
                value={stopCondition}
                onChange={(event) => setStopCondition(event.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="es. Quando la prima demo è pronta"
              />
            </label>
            {formError && <p className="form-error">{formError}</p>}
            <button type="submit" disabled={creating || busy[selected.id]}>
              {creating ? 'Creazione…' : 'Crea obiettivo'}
            </button>
          </form>

          <div className="objective-grid">
            {objectives.length === 0 ? (
              <p className="muted small">Nessun obiettivo per questo progetto.</p>
            ) : (
              objectives.map((objective) => (
                <ObjectiveCard
                  key={objective.id}
                  objective={objective}
                  sessions={sessionsByObjective[objective.id] ?? []}
                  checkpoints={checkpointsByObjective[objective.id] ?? []}
                  busy={Boolean(busy[objective.id])}
                  onStart={onStart}
                  onStop={onStop}
                  onComplete={onComplete}
                  onBlock={onBlock}
                  onFail={onFail}
                  onCancel={onCancel}
                />
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [objective, setObjective] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [pendingStatus, setPendingStatus] = useState<Record<string, ProjectStatus>>({});
  const [statusBusy, setStatusBusy] = useState<Record<string, boolean>>({});
  const [gitBusy, setGitBusy] = useState<Record<string, boolean>>({});

  // M3: obiettivi e sessioni agente.
  const [objectivesByProject, setObjectivesByProject] = useState<Record<string, Objective[]>>({});
  const [sessionsByObjective, setSessionsByObjective] = useState<Record<string, AgentSession[]>>({});
  // M4: checkpoint esposti dal dettaglio obiettivo (ricaricati a ogni refresh).
  const [checkpointsByObjective, setCheckpointsByObjective] = useState<Record<string, Checkpoint[]>>({});
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [objectiveBusy, setObjectiveBusy] = useState<Record<string, boolean>>({});
  const [creatingObjective, setCreatingObjective] = useState(false);

  /** M3: carica obiettivi e sessioni per tutti i progetti (dettaglio con sessioni). */
  const loadM3 = useCallback(async (projectsList: Project[]) => {
    const loadedObjectives: Record<string, Objective[]> = {};
    const loadedSessions: Record<string, AgentSession[]> = {};
    const loadedCheckpoints: Record<string, Checkpoint[]> = {};
    for (const project of projectsList) {
      const { objectives } = await api.listObjectives(project.id);
      loadedObjectives[project.id] = objectives;
      const details = await Promise.all(objectives.map((o) => api.getObjective(o.id)));
      for (const detail of details) {
        loadedSessions[detail.objective.id] = detail.sessions;
        loadedCheckpoints[detail.objective.id] = detail.checkpoints;
      }
    }
    setObjectivesByProject(loadedObjectives);
    setSessionsByObjective(loadedSessions);
    setCheckpointsByObjective(loadedCheckpoints);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [statusResult, projectsResult, eventsResult] = await Promise.all([
        api.status(),
        api.listProjects(),
        api.listEvents(30),
      ]);
      setStatus(statusResult);
      setProjects(projectsResult.projects);
      setEvents(eventsResult.events);
      await loadM3(projectsResult.projects);
      setLoadState('ready');
      setError(null);
    } catch (err) {
      setLoadState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadM3]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // M3: preseleziona il primo progetto quando il registro è caricato.
  useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Il nome del progetto è obbligatorio.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await api.createProject({
        name: trimmed,
        ...(repositoryPath.trim() ? { repositoryPath: repositoryPath.trim() } : {}),
        ...(objective.trim() ? { currentObjective: objective.trim() } : {}),
      });
      setName('');
      setRepositoryPath('');
      setObjective('');
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefreshGit = async (id: string) => {
    setActionError(null);
    setGitBusy((prev) => ({ ...prev, [id]: true }));
    try {
      await api.refreshProjectGitStatus(id);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setGitBusy((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handleApplyStatus = async (project: Project) => {
    const target = pendingStatus[project.id] ?? project.status;
    setActionError(null);
    setStatusBusy((prev) => ({ ...prev, [project.id]: true }));
    try {
      await api.setProjectStatus(project.id, target);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusBusy((prev) => ({ ...prev, [project.id]: false }));
    }
  };

  const handlePendingStatus = (id: string, s: ProjectStatus) =>
    setPendingStatus((prev) => ({ ...prev, [id]: s }));

  // --- M3: ciclo obiettivo → sessione agente ---
  const runObjectiveAction = async (objectiveId: string, action: () => Promise<unknown>) => {
    setActionError(null);
    setObjectiveBusy((prev) => ({ ...prev, [objectiveId]: true }));
    try {
      await action();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setObjectiveBusy((prev) => ({ ...prev, [objectiveId]: false }));
    }
  };

  const handleCreateObjective = async (input: CreateObjectiveInput) => {
    if (!selectedProjectId) return;
    setCreatingObjective(true);
    setActionError(null);
    try {
      await api.createObjective(selectedProjectId, input);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setCreatingObjective(false);
    }
  };

  const handleStart = (objectiveId: string, sessionId: string) =>
    void runObjectiveAction(objectiveId, () => api.startSession(objectiveId, sessionId));

  const handleStop = (objectiveId: string, sessionId: string, reason?: string) =>
    void runObjectiveAction(objectiveId, () => api.stopSession(objectiveId, sessionId, reason));

  const handleComplete = (objectiveId: string, report?: string) =>
    void runObjectiveAction(objectiveId, () => api.completeObjective(objectiveId, report));

  const handleBlock = (objectiveId: string, reason?: string) =>
    void runObjectiveAction(objectiveId, () => api.blockObjective(objectiveId, reason));

  const handleFail = (objectiveId: string, detail?: string) =>
    void runObjectiveAction(objectiveId, () => api.failObjective(objectiveId, detail));

  const handleCancel = (objectiveId: string) =>
    void runObjectiveAction(objectiveId, () => api.cancelObjective(objectiveId));

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            G
          </span>
          <div>
            <h1>G-Rex Agent Control</h1>
            <p>Piano di controllo locale degli agenti · M4 Checkpoint e attenzione umana</p>
          </div>
        </div>
        {status ? (
          <span className="pill pill-ok">API locale · {status.projectsCount} progetti</span>
        ) : loadState === 'loading' ? (
          <span className="pill">Connessione…</span>
        ) : (
          <span className="pill pill-err">API non raggiungibile</span>
        )}
        {status && (
          <span className={`pill ${status.pendingDecisions > 0 ? 'pill-warn' : ''}`}>
            Decisioni pendenti: {status.pendingDecisions}
          </span>
        )}
      </header>

      {loadState === 'error' && (
        <div className="card error-card">
          <p>Impossibile contattare l'API locale: {error}</p>
        </div>
      )}

      {actionError && <p className="form-error action-error">{actionError}</p>}

      {loadState === 'loading' && <p className="muted center">Caricamento…</p>}

      {loadState === 'ready' && (
        <main className="grid">
          <section className="card">
            <h2>Registro</h2>
            <dl className="stat-list">
              <div>
                <dt>Progetti registrati</dt>
                <dd>{status?.projectsCount ?? projects.length}</dd>
              </div>
              <div>
                <dt>Eventi registrati</dt>
                <dd>{status?.eventsCount ?? events.length}</dd>
              </div>
              <div>
                <dt>Dimensione DB</dt>
                <dd>{status ? formatBytes(status.storage.fileSizeBytes) : '—'}</dd>
              </div>
            </dl>
          </section>

          <section className="card span-2 group-facts">
            {GROUPS.map((g) => {
              const count = status?.projectsByGroup[g.key] ?? 0;
              return (
                <div key={g.key} className={`funnel funnel-${g.key.toLowerCase()}`}>
                  <strong>{count}</strong>
                  <span>{g.label}</span>
                </div>
              );
            })}
          </section>

          <section className="card">
            <h2>Registra un progetto</h2>
            <form className="form" onSubmit={handleSubmit}>
              <label>
                Nome
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="es. g-rex-agents-control"
                  maxLength={120}
                />
              </label>
              <label>
                Percorso repository (facoltativo)
                <input
                  value={repositoryPath}
                  onChange={(event) => setRepositoryPath(event.target.value)}
                  placeholder="es. C:\Projects\g-rex-agents-control"
                  maxLength={1024}
                />
              </label>
              <label>
                Obiettivo corrente (facoltativo)
                <textarea
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="es. Completare la milestone corrente"
                />
              </label>
              {formError && <p className="form-error">{formError}</p>}
              <button type="submit" disabled={submitting}>
                {submitting ? 'Registrazione…' : 'Registra progetto'}
              </button>
            </form>
          </section>

          {GROUPS.map((g) => {
            const items = projects.filter((p) => p.statusGroup === g.key);
            return (
              <section key={g.key} className={`card span-2 group-section group-${g.key.toLowerCase()}`}>
                <header className="group-head">
                  <h2>
                    {g.label} <span className="group-count">{items.length}</span>
                  </h2>
                  <p className="muted small">{g.hint}</p>
                </header>
                {items.length === 0 ? (
                  <p className="muted small">Nessun progetto in questo gruppo.</p>
                ) : (
                  <div className="project-grid">
                    {items.map((project) => (
                      <ProjectCard
                        key={project.id}
                        project={project}
                        pendingStatus={pendingStatus[project.id] ?? project.status}
                        onPendingStatus={handlePendingStatus}
                        onApplyStatus={handleApplyStatus}
                        onRefreshGit={handleRefreshGit}
                        statusBusy={Boolean(statusBusy[project.id])}
                        gitBusy={Boolean(gitBusy[project.id])}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          <ObjectivesSection
            projects={projects}
            objectivesByProject={objectivesByProject}
            sessionsByObjective={sessionsByObjective}
            checkpointsByObjective={checkpointsByObjective}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            busy={objectiveBusy}
            creating={creatingObjective}
            onCreate={handleCreateObjective}
            onStart={handleStart}
            onStop={handleStop}
            onComplete={handleComplete}
            onBlock={handleBlock}
            onFail={handleFail}
            onCancel={handleCancel}
          />

          <section className="card span-2">
            <h2>Eventi recenti (State &amp; Event Store)</h2>
            {events.length === 0 ? (
              <p className="muted">Nessun evento registrato.</p>
            ) : (
              <ul className="event-list">
                {events.map((event) => (
                  <li key={event.id}>
                    <time>{formatDate(event.timestamp)}</time>
                    <code>{event.type}</code>
                    <span>{event.payload ? JSON.stringify(event.payload) : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      )}

      <footer className="footer">
        <p>
          Solo rete locale (127.0.0.1) · nessun servizio esterno · persistenza SQLite su{' '}
          <code>data/gac.sqlite</code>
        </p>
      </footer>
    </div>
  );
}