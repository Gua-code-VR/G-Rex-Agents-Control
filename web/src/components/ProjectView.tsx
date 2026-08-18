import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  api,
  type AgentSession,
  type Checkpoint,
  type DecisionType,
  type ExecutionAttempt,
  type GitStatus,
  type GovernanceApproval,
  type GovernanceDashboard,
  type Objective,
  type Project,
} from '../api/client';
import { GROUP_LABEL, OBJECTIVE_STATUS_LABEL, PROJECT_STATUS_LABEL as STATUS_LABEL, SESSION_STATUS_LABEL } from '../lib/labels';

function formatDate(value: string): string {
  return new Date(value).toLocaleString('it-IT');
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `€ ${value.toFixed(2)}`;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function GitSummary({ git, onRefresh, busy }: { git: GitStatus | null; onRefresh: () => void; busy: boolean }) {
  return (
    <div className="git-box">
      <div className="git-box-head">
        <h4>Stato Git</h4>
        <button type="button" className="btn btn-ghost" onClick={onRefresh} disabled={busy}>
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

export interface ProjectViewProps {
  projects: Project[];
  objectivesByProject: Record<string, Objective[]>;
  sessionsByObjective: Record<string, AgentSession[]>;
  checkpointsByObjective: Record<string, Checkpoint[]>;
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  gitBusy: Record<string, boolean>;
  onRefreshGit: (id: string) => void;
  onCreateProject: (input: { name: string; repositoryPath?: string; currentObjective?: string }) => Promise<void>;
  onDecide: (checkpointId: string, decisionType: DecisionType, note?: string) => void;
  deciding?: string | null;
  onNavigateObjectives: (projectId: string) => void;
}

/**
 * Fase 3 — Vista Progetto (§6 CONTROL_ROOM_SPEC.md).
 * Stato operativo, obiettivi attivi, backlog, richieste umane, risultati
 * recenti, salute e costi. Riutilizza solo dati e API già esistenti.
 */
export function ProjectView({
  projects,
  objectivesByProject,
  sessionsByObjective,
  checkpointsByObjective,
  selectedProjectId,
  onSelectProject,
  gitBusy,
  onRefreshGit,
  onCreateProject,
  onDecide,
  deciding,
  onNavigateObjectives,
}: ProjectViewProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [currentObjective, setCurrentObjective] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [governance, setGovernance] = useState<GovernanceDashboard | null>(null);
  const [approvals, setApprovals] = useState<GovernanceApproval[]>([]);
  const [attemptsBySession, setAttemptsBySession] = useState<Record<string, ExecutionAttempt[]>>({});

  const project = projects.find((p) => p.id === selectedProjectId) ?? projects[0] ?? null;
  const objectives = project ? objectivesByProject[project.id] ?? [] : [];

  useEffect(() => {
    if (!project) { setGovernance(null); setAttemptsBySession({}); return; }
    let cancelled = false;
    void api.getProjectGovernance(project.id)
      .then((r) => { if (!cancelled) setGovernance(r.governance); })
      .catch(() => { if (!cancelled) setGovernance(null); });
    const sessions = objectives.flatMap((o) => sessionsByObjective[o.id] ?? []);
    void Promise.all(sessions.map(async (s) => [s.id, (await api.listExecutionAttempts(s.id)).attempts] as const))
      .then((entries) => { if (!cancelled) setAttemptsBySession(Object.fromEntries(entries)); })
      .catch(() => { if (!cancelled) setAttemptsBySession({}); });
    void Promise.all(objectives.map(async (o) => (await api.listGovernanceApprovals(o.id)).approvals))
      .then((lists) => { if (!cancelled) setApprovals(lists.flat()); })
      .catch(() => { if (!cancelled) setApprovals([]); });
    return () => { cancelled = true; };
  }, [project, objectives, sessionsByObjective]);

  const handleCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const t = name.trim();
    if (!t) { setFormError('Il nome del progetto è obbligatorio.'); return; }
    setSubmitting(true); setFormError(null);
    try {
      await onCreateProject({
        name: t,
        ...(repositoryPath.trim() ? { repositoryPath: repositoryPath.trim() } : {}),
        ...(currentObjective.trim() ? { currentObjective: currentObjective.trim() } : {}),
      });
      setName(''); setRepositoryPath(''); setCurrentObjective(''); setShowCreate(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const decideApproval = async (id: string, approve: boolean) => {
    try {
      await api.decideGovernanceApproval(id, approve);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // Mantiene lo stato precedente: l'operatore può riprovare.
    }
  };

  const activeObjectives = objectives.filter((o) => o.status === 'IN_AVVIO' || o.status === 'IN_LAVORAZIONE');
  const backlog = objectives.filter(
    (o) => o.status === 'RICHIEDE_ATTENZIONE' || o.status === 'BLOCCATO' || o.status === 'ERRORE',
  );
  const completed = objectives.filter((o) => o.status === 'COMPLETATO');
  const needsAttention = objectives.filter((o) => o.status === 'RICHIEDE_ATTENZIONE');
  const projectPendingCheckpoints = objectives.flatMap((o) => checkpointsByObjective[o.id] ?? []).filter((c) => c.status === 'PENDING_DECISION');

  const allAttempts = Object.values(attemptsBySession).flat();
  const pendingApprovals = approvals.filter((a) => a.status === 'PENDING');
  const projectCost = useMemo(() => {
    let total = 0;
    let hasValue = false;
    for (const attempt of allAttempts) {
      const value = attempt.costActual ?? attempt.costEstimate;
      if (value !== null) { total += value; hasValue = true; }
    }
    return hasValue ? total : null;
  }, [allAttempts]);


  if (projects.length === 0) {
    return (
      <div className="project-view">
        <section className="panel">
          <div className="panel-head"><h2>Progetti</h2></div>
          <p className="muted">Nessun progetto registrato. Creane uno per iniziare.</p>
          <button type="button" className="btn btn-primary touch-target" onClick={() => setShowCreate(true)}>Nuovo progetto</button>
        </section>
        {showCreate && (
          <CreateProjectForm
            name={name} repositoryPath={repositoryPath} currentObjective={currentObjective}
            onName={setName} onRepo={setRepositoryPath} onObjective={setCurrentObjective}
            onSubmit={handleCreate} submitting={submitting} formError={formError}
            onCancel={() => setShowCreate(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="project-view">
      <section className="panel project-selector">
        <div className="panel-head">
          <h2>Progetti</h2>
          <button type="button" className="btn btn-ghost" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Chiudi' : 'Nuovo progetto'}
          </button>
        </div>
        <div className="project-picker">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`project-chip ${p.id === (project?.id ?? '') ? 'active' : ''}`}
              onClick={() => onSelectProject(p.id)}
            >
              {p.name}
              <span className={`badge badge-${p.status.toLowerCase()}`}>{STATUS_LABEL[p.status]}</span>
            </button>
          ))}
        </div>
      </section>

      {showCreate && (
        <CreateProjectForm
          name={name} repositoryPath={repositoryPath} currentObjective={currentObjective}
          onName={setName} onRepo={setRepositoryPath} onObjective={setCurrentObjective}
          onSubmit={handleCreate} submitting={submitting} formError={formError}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {project && (
        <div className="project-detail">
          <section className="panel project-status-head">
            <div className="project-title-line">
              <h2>{project.name}</h2>
              <span className={`badge badge-${project.status.toLowerCase()}`}>{STATUS_LABEL[project.status]}</span>
              <span className={`project-group-mark group-${project.statusGroup.toLowerCase()}`}>{GROUP_LABEL[project.statusGroup]}</span>
            </div>
            <p className="mono repo-path">Repository: <code>{project.repositoryPath ?? '—'}</code></p>
          </section>

          <div className="project-grid">
            <div className="project-side">
              <section className="panel">
                <GitSummary git={project.gitStatus} onRefresh={() => onRefreshGit(project.id)} busy={gitBusy[project.id] ?? false} />
              </section>

              <section className="panel">
                <div className="panel-head"><h2>Salute progetto</h2></div>
                <ul className="health-list">
                  <li><span className="health-label">Obiettivi attivi</span><span className="health-value">{activeObjectives.length}</span></li>
                  <li><span className="health-label">Backlog/attenzione</span><span className="health-value">{backlog.length + needsAttention.length}</span></li>
                  <li><span className="health-label">Completati</span><span className="health-value">{completed.length}</span></li>
                  <li><span className="health-label">Decisioni pendenti</span><span className="health-value">{projectPendingCheckpoints.length}</span></li>
                </ul>
              </section>

              <section className="panel">
                <div className="panel-head"><h2>Costi e budget</h2></div>
                {governance ? (
                  <>
                    <p className="muted small">
                      Usato {money(governance.budget.used)} · Residuo {governance.budget.remaining === null ? 'illimitato' : money(governance.budget.remaining)}
                    </p>
                    <p className="muted small">{governance.totals.totalTokens} token totali</p>
                    {governance.breakdown.length > 0 && (
                      <ul className="breakdown-list">
                        {governance.breakdown.map((b) => (
                          <li key={`${b.providerName}/${b.modelName}`} className="muted small">
                            {b.providerName}/{b.modelName}: {money(b.cost)} · {b.totalTokens} token
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <p className="muted small">{projectCost !== null ? `Spesa rilevata ${money(projectCost)}` : 'Nessun consumo registrato per questo progetto.'}</p>
                )}
              </section>
            </div>

            <div className="project-main">
              <section className="panel">
                <div className="panel-head">
                  <h2>Obiettivi attivi</h2>
                  <span className="muted small">{activeObjectives.length}</span>
                </div>
                {activeObjectives.length === 0 ? (
                  <p className="muted">Nessun obiettivo in corso. Il backlog elenca il lavoro in attesa.</p>
                ) : (
                  <div className="ops-table" role="table" aria-label="Obiettivi attivi">
                    <div className="ops-row ops-head" role="row">
                      <span role="columnheader">Obiettivo</span>
                      <span role="columnheader">Stato</span>
                      <span role="columnheader">Sessione</span>
                      <span role="columnheader">Costo</span>
                    </div>
                    {activeObjectives.map((o) => {
                      const sessions = sessionsByObjective[o.id] ?? [];
                      const activeSession = sessions.find((s) => s.status === 'ATTIVA' || s.status === 'IN_AVVIO');
                      const attempts = activeSession ? attemptsBySession[activeSession.id] ?? [] : [];
                      const cost = attempts.length
                        ? attempts.reduce((sum, a) => sum + (a.costActual ?? a.costEstimate ?? 0), 0)
                        : null;
                      return (
                        <div className="ops-row" role="row" key={o.id}>
                          <span className="ops-cell ops-objective" role="cell">
                            <button type="button" className="link-btn" onClick={() => onNavigateObjectives(o.projectId)}>{o.title}</button>
                          </span>
                          <span className="ops-cell" role="cell">
                            <span className={`badge badge-${o.status.toLowerCase()}`}>{OBJECTIVE_STATUS_LABEL[o.status]}</span>
                          </span>
                          <span className="ops-cell" role="cell">
                            {activeSession ? SESSION_STATUS_LABEL[activeSession.status] : '—'}
                          </span>
                          <span className="ops-cell" role="cell">{money(cost)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>


              <section className="panel">
                <div className="panel-head">
                  <h2>Backlog e attenzione</h2>
                  <span className="muted small">{backlog.length + needsAttention.length}</span>
                </div>
                {backlog.length === 0 && needsAttention.length === 0 ? (
                  <p className="muted">Nessun obiettivo in attesa o da verificare.</p>
                ) : (
                  <div className="ops-table" role="table" aria-label="Backlog">
                    <div className="ops-row ops-head" role="row">
                      <span role="columnheader">Obiettivo</span>
                      <span role="columnheader">Stato</span>
                      <span role="columnheader">Ultimo aggiornamento</span>
                    </div>
                    {[...needsAttention, ...backlog].map((o) => (
                      <div className="ops-row" role="row" key={o.id}>
                        <span className="ops-cell ops-objective" role="cell">
                          <button type="button" className="link-btn" onClick={() => onNavigateObjectives(o.projectId)}>{o.title}</button>
                        </span>
                        <span className="ops-cell" role="cell">
                          <span className={`badge badge-${o.status.toLowerCase()}`}>{OBJECTIVE_STATUS_LABEL[o.status]}</span>
                        </span>
                        <span className="ops-cell" role="cell">{formatDate(o.updatedAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="muted small backlog-note">
                  Priorità e dipendenze esplicite non sono ancora esposte dal backend: il backlog elenca gli obiettivi in stato non attivo, senza inventare attributi non supportati.
                </p>
              </section>


              <section className="panel">
                <div className="panel-head">
                  <h2>Risultati recenti</h2>
                  <span className="muted small">{completed.length}</span>
                </div>
                {completed.length === 0 ? (
                  <p className="muted">Nessun obiettivo completato in questo progetto.</p>
                ) : (
                  <ul className="result-list">
                    {completed.slice(-5).reverse().map((o) => (
                      <li key={o.id} className="result-row">
                        <details className="result-collapsible">
                          <summary className="result-head">
                            <strong>{o.title}</strong>
                            <span className={`badge badge-${o.status.toLowerCase()}`}>{OBJECTIVE_STATUS_LABEL[o.status]}</span>
                          </summary>
                          {o.finalReport && <p className="result-report muted small">{o.finalReport}</p>}
                        </details>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {pendingApprovals.length > 0 && (
                <div className="needs-group">
                  <h3 className="needs-group-title needs-governance">Approvazioni budget</h3>
                  {pendingApprovals.map((approval) => {
                    const objective = objectives.find((o) => o.id === approval.objectiveId);
                    return (
                      <div className="needs-item" key={approval.id}>
                        <p className="needs-summary"><strong>{objective?.title ?? shortId(approval.objectiveId)}</strong></p>
                        <p className="muted small">Costo previsto {money(approval.projectedCost)}</p>
                        <div className="needs-actions">
                          <button type="button" className="btn btn-approve touch-target"
                            onClick={() => void decideApproval(approval.id, true)}>Approva</button>
                          <button type="button" className="btn btn-danger touch-target"
                            onClick={() => void decideApproval(approval.id, false)}>Rifiuta</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {projectPendingCheckpoints.length > 0 && (
                <section className="panel needs-you-panel">
                  <div className="panel-head">
                    <h2>Richiede te</h2>
                    <span className="needs-badge">{projectPendingCheckpoints.length}</span>
                  </div>
                  {projectPendingCheckpoints.map((checkpoint) => {
                    const objective = objectives.find((o) => o.id === checkpoint.objectiveId);
                    return (
                      <div className="needs-item" key={checkpoint.id}>
                        <p className="needs-summary"><strong>{objective?.title ?? shortId(checkpoint.objectiveId)}</strong></p>
                        <p className="muted small">{checkpoint.summary}</p>
                        <div className="needs-actions">
                          <button type="button" className="btn btn-approve touch-target" disabled={deciding === checkpoint.id}
                            onClick={() => onDecide(checkpoint.id, 'APPROVE')}>Approva</button>
                          <button type="button" className="btn touch-target" disabled={deciding === checkpoint.id}
                            onClick={() => onDecide(checkpoint.id, 'REQUEST_CHANGES')}>Modifiche</button>
                        </div>
                      </div>
                    );
                  })}
                </section>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function CreateProjectForm({
  name, repositoryPath, currentObjective,
  onName, onRepo, onObjective, onSubmit, submitting, formError, onCancel,
}: {
  name: string; repositoryPath: string; currentObjective: string;
  onName: (v: string) => void; onRepo: (v: string) => void; onObjective: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void; submitting: boolean; formError: string | null;
  onCancel: () => void;
}) {
  return (
    <section className="panel create-project-panel">
      <div className="panel-head"><h2>Nuovo progetto</h2></div>
      <form onSubmit={onSubmit} className="create-project-form">
        <label className="field">Nome * <input value={name} onChange={(e) => onName(e.target.value)} placeholder="Nome del progetto" maxLength={200} disabled={submitting} /></label>
        <label className="field">Repository <input value={repositoryPath} onChange={(e) => onRepo(e.target.value)} placeholder="/percorso/al/repository" maxLength={2000} disabled={submitting} /></label>
        <label className="field">Obiettivo iniziale <input value={currentObjective} onChange={(e) => onObjective(e.target.value)} placeholder="Opzionale" maxLength={50000} disabled={submitting} /></label>
        {formError && <p className="form-error">{formError}</p>}
        <button type="submit" className="btn btn-primary touch-target" disabled={submitting}>{submitting ? 'Creazione…' : 'Crea progetto'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Annulla</button>
      </form>
    </section>
  );
}

