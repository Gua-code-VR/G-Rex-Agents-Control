import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type EventRecord,
  type GitStatus,
  type Project,
  type ProjectStatus,
  type ProjectStatusGroup,
  type StatusResponse,
} from './api/client';

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
      setLoadState('ready');
      setError(null);
    } catch (err) {
      setLoadState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            G
          </span>
          <div>
            <h1>G-Rex Agent Control</h1>
            <p>Piano di controllo locale degli agenti · M2 Registro progetti e stato</p>
          </div>
        </div>
        {status ? (
          <span className="pill pill-ok">API locale · {status.projectsCount} progetti</span>
        ) : loadState === 'loading' ? (
          <span className="pill">Connessione…</span>
        ) : (
          <span className="pill pill-err">API non raggiungibile</span>
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