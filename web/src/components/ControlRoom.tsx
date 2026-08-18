import { useEffect, useMemo, useState } from 'react';
import { summarizeEventPayload } from '../lib/event-summary';
import {
  api,
  type AgentSession,
  type Checkpoint,
  type DecisionType,
  type EventRecord,
  type ExecutionAttempt,
  type GovernanceApproval,
  type HealthResponse,
  type Objective,
  type Project,
  type RuntimeApproval,
} from '../api/client';
import { computeRequiresYou } from '../lib/requires-you';
import { GROUP_LABEL, OBJECTIVE_STATUS_LABEL, SESSION_STATUS_LABEL } from '../lib/labels';

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

export interface ControlRoomProps {
  projects: Project[];
  objectivesByProject: Record<string, Objective[]>;
  sessionsByObjective: Record<string, AgentSession[]>;
  checkpointsByObjective: Record<string, Checkpoint[]>;
  events: EventRecord[];
  onNavigate: (section: string) => void;
  onSelectProject: (projectId: string) => void;
  onDecide: (checkpointId: string, decisionType: DecisionType, note?: string) => void;
  deciding?: string | null;
}


/**
 * Fase 2 — Control Room (§5 CONTROL_ROOM_SPEC.md).
 * Cockpit operativo: cosa sta lavorando? cosa è in attesa? cosa richiede
 * intervento? cosa sta fallendo? Riutilizza solo dati/API già esistenti.
 */
export function ControlRoom({
  projects,
  objectivesByProject,
  sessionsByObjective,
  checkpointsByObjective,
  events,
  onNavigate,
  onSelectProject,
  onDecide,
  deciding,
}: ControlRoomProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [approvals, setApprovals] = useState<GovernanceApproval[]>([]);
  const [runtimeApprovals, setRuntimeApprovals] = useState<RuntimeApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [attemptsBySession, setAttemptsBySession] = useState<Record<string, ExecutionAttempt[]>>({});

  const loadApprovals = () => {
    void api.listGovernanceApprovals().then((r) => setApprovals(r.approvals)).catch(() => setApprovals([]));
    void api.listRuntimeApprovals().then((r) => setRuntimeApprovals(r.approvals)).catch(() => setRuntimeApprovals([]));
  };

  useEffect(() => {
    void api.health().then((r) => setHealth(r)).catch(() => setHealth(null));
    loadApprovals();
  }, []);

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

  const objectives = useMemo(() => Object.values(objectivesByProject).flat(), [objectivesByProject]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p] as const)), [projects]);
  const objectiveById = useMemo(() => new Map(objectives.map((o) => [o.id, o] as const)), [objectives]);

  const waitingObjectives = objectives.filter((o) => o.status === 'IN_AVVIO');
  const errorObjectives = objectives.filter((o) => o.status === 'ERRORE');
  const { pendingApprovals, pendingCheckpoints } = computeRequiresYou({
    checkpoints: Object.values(checkpointsByObjective).flat(),
    approvals,
    runtimeApprovals,
  });
  const pendingErrorCheckpoints = pendingCheckpoints.filter((c) => c.outcome === 'ERROR');
  const pendingResultCheckpoints = pendingCheckpoints.filter((c) => c.outcome !== 'ERROR');

  const activeSessions = useMemo(() => {
    const rows: Array<{ objective: Objective; project: Project | undefined; session: AgentSession }> = [];
    for (const project of projects) {
      for (const objective of objectivesByProject[project.id] ?? []) {
        for (const session of sessionsByObjective[objective.id] ?? []) {
          if (session.status === 'ATTIVA' || session.status === 'IN_AVVIO') {
            rows.push({ objective, project, session });
          }
        }
      }
    }
    return rows;
  }, [projects, objectivesByProject, sessionsByObjective]);

  useEffect(() => {
    const sessions = activeSessions.map((r) => r.session);
    if (sessions.length === 0) { setAttemptsBySession({}); return; }
    let cancelled = false;
    void Promise.all(
      sessions.map(async (s) => [s.id, (await api.listExecutionAttempts(s.id)).attempts] as const),
    )
      .then((entries) => { if (!cancelled) setAttemptsBySession(Object.fromEntries(entries)); })
      .catch(() => { if (!cancelled) setAttemptsBySession({}); });
    return () => { cancelled = true; };
  }, [activeSessions]);

  const allAttempts = Object.values(attemptsBySession).flat();
  const todayCost = useMemo(() => {
    let total = 0;
    let hasValue = false;
    for (const attempt of allAttempts) {
      const value = attempt.costActual ?? attempt.costEstimate;
      if (value !== null) { total += value; hasValue = true; }
    }
    return hasValue ? total : null;
  }, [allAttempts]);

  const completedObjectives = objectives.filter((o) => o.status === 'COMPLETATO');
  const recentCompletions = completedObjectives.slice(-6).reverse();

  // «Richiede te» con la stessa semantica di RequiresYouView e del badge:
  // checkpoint pendenti + approvazioni budget + approvazioni runtime.
  const needsYouCount = pendingCheckpoints.length + pendingApprovals.length + runtimeApprovals.length;
  const recentEvents = events.slice(-10).reverse();

  const systemOk = health?.status === 'ok' || health?.status === 'OK' || health?.status === 'healthy';

  return (
    <div className="control-room">
      <section className="control-kpis" aria-label="Sintesi operativa">
        <div className="kpi kpi-active">
          {/* Solo esecuzioni realmente attive (sessione ATTIVA): l'obiettivo e
              la sua sessione non vengono contati due volte (§1.1 V2). */}
          <span className="kpi-value">{activeSessions.filter((r) => r.session.status === 'ATTIVA').length}</span>
          <span className="kpi-label">Attivi</span>
        </div>
        <div className="kpi kpi-waiting">
          <span className="kpi-value">{waitingObjectives.length}</span>
          <span className="kpi-label">In attesa</span>
        </div>
        {errorObjectives.length > 0 && (
          <div className="kpi kpi-error">
            <span className="kpi-value">{errorObjectives.length}</span>
            <span className="kpi-label">Errori</span>
          </div>
        )}
        {needsYouCount > 0 && (
          <div className="kpi kpi-need-you">
            <span className="kpi-value">{needsYouCount}</span>
            <span className="kpi-label">Richiedono te</span>
          </div>
        )}
        <div className="kpi kpi-cost">
          <span className="kpi-value">{money(todayCost)}</span>
          <span className="kpi-label">Spesa rilevata</span>
        </div>
        <div className="kpi kpi-health">
          <span className={`kpi-value ${systemOk ? 'ok' : 'warn'}`}>{systemOk ? '● OK' : '● Controlla'}</span>
          <span className="kpi-label">Sistema</span>
        </div>
      </section>

      <div className="control-room-grid">
        <div className="control-main">
          <section className="panel work-in-progress">
            <div className="panel-head">
              <h2>Lavoro in corso</h2>
              <span className="muted small">{activeSessions.length} sessione/i attive</span>
            </div>
            {activeSessions.length === 0 ? (
              <p className="muted">Nessuna sessione agente attiva. Crea un obiettivo per iniziare.</p>
            ) : (
              <div className="ops-table" role="table" aria-label="Lavoro in corso">
                <div className="ops-row ops-head" role="row">
                  <span role="columnheader">Progetto</span>
                  <span role="columnheader">Obiettivo</span>
                  <span role="columnheader">AI</span>
                  <span role="columnheader">Inizio</span>
                  <span role="columnheader">Costo</span>
                </div>
                {activeSessions.map(({ objective, project, session }) => {
                  const attempts = attemptsBySession[session.id] ?? [];
                  const lastAttempt = attempts[attempts.length - 1];
                  const cost = lastAttempt?.costActual ?? lastAttempt?.costEstimate ?? null;
                  return (
                    <div className="ops-row" role="row" key={session.id}>
                      <span className="ops-cell ops-project" role="cell">
                        <button type="button" className="link-btn" onClick={() => onSelectProject(objective.projectId)}>
                          {project?.name ?? shortId(objective.projectId)}
                        </button>
                      </span>
                      <span className="ops-cell ops-objective" role="cell">
                        <button type="button" className="link-btn" onClick={() => onNavigate('projects')}>
                          {objective.title}
                        </button>
                        <span className={`badge badge-${session.status.toLowerCase()}`}>{SESSION_STATUS_LABEL[session.status]}</span>
                      </span>
                      <span className="ops-cell ops-ai" role="cell">
                        {session.executionSelection
                          ? `${session.executionSelection.providerId}/${session.executionSelection.modelId ?? 'modello runtime'}`
                          : session.agentType}
                      </span>
                      <span className="ops-cell" role="cell">{formatDate(session.startedAt)}</span>
                      <span className="ops-cell" role="cell">{money(cost)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>


          <section className="panel projects-overview">
            <div className="panel-head">
              <h2>Progetti</h2>
              <button type="button" className="btn btn-ghost" onClick={() => onNavigate('projects')}>Apri Progetti</button>
            </div>
            {projects.length === 0 ? (
              <p className="muted">Nessun progetto registrato.</p>
            ) : (
              <div className="ops-table" role="table" aria-label="Progetti">
                <div className="ops-row ops-head" role="row">
                  <span role="columnheader">Progetto</span>
                  <span role="columnheader">Stato</span>
                  <span role="columnheader">Obiettivo corrente</span>
                </div>
                {projects.map((project) => {
                  const openObjectives = (objectivesByProject[project.id] ?? []).filter(
                    (o) => o.status === 'IN_AVVIO' || o.status === 'IN_LAVORAZIONE' || o.status === 'RICHIEDE_ATTENZIONE',
                  ).length;
                  return (
                    <div className="ops-row" role="row" key={project.id}>
                      <span className="ops-cell ops-project" role="cell">
                        <button type="button" className="link-btn" onClick={() => onSelectProject(project.id)}>{project.name}</button>
                      </span>
                      <span className="ops-cell" role="cell">
                        <span className={`badge badge-${project.status.toLowerCase()}`}>{GROUP_LABEL[project.statusGroup]}</span>
                        {openObjectives > 0 && <span className="muted small"> · {openObjectives} aperti</span>}
                      </span>
                      <span className="ops-cell" role="cell">
                        {project.currentObjective ?? <span className="muted">—</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="panel recent-results">
            <div className="panel-head">
              <h2>Risultati recenti</h2>
              <span className="muted small">{completedObjectives.length} completati</span>
            </div>
            {recentCompletions.length === 0 ? (
              <p className="muted">Nessun obiettivo completato di recente.</p>
            ) : (
              <ul className="result-list">
                {recentCompletions.map((o) => {
                  const project = projectById.get(o.projectId);
                  return (
                    <li key={o.id} className="result-row">
                      <details className="result-collapsible">
                        <summary className="result-head">
                        <button type="button" className="link-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSelectProject(o.projectId); }}>
                          {project?.name ?? shortId(o.projectId)}
                        </button>
                        <span className="muted small">→</span>
                        <strong>{o.title}</strong>
                        <span className={`badge badge-${o.status.toLowerCase()}`}>{OBJECTIVE_STATUS_LABEL[o.status]}</span>
                        </summary>
                        {o.finalReport && <p className="result-report muted small">{o.finalReport}</p>}
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>


        <aside className="control-needs-you" aria-label="Richiede il tuo intervento">
          {(pendingCheckpoints.length > 0 || pendingApprovals.length > 0) && (
          <section className="panel needs-you-panel">
            <div className="panel-head">
              <h2>Richiede te</h2>
              <span className="needs-badge">{needsYouCount}</span>
            </div>

            {pendingApprovals.length > 0 && (
              <div className="needs-group">
                <h3 className="needs-group-title needs-governance">Approvazioni budget</h3>
                {pendingApprovals.map((approval) => {
                  const objective = objectiveById.get(approval.objectiveId);
                  return (
                    <div className="needs-item" key={approval.id}>
                      <p className="needs-summary">
                        <strong>{objective?.title ?? shortId(approval.objectiveId)}</strong>
                      </p>
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
              </div>
            )}

            {pendingErrorCheckpoints.length > 0 && (
              <div className="needs-group">
                <h3 className="needs-group-title needs-error">Obiettivi in errore</h3>
                {pendingErrorCheckpoints.map((checkpoint) => {
                  const objective = objectiveById.get(checkpoint.objectiveId);
                  return (
                    <div className="needs-item" key={checkpoint.id}>
                      <p className="needs-summary">
                        <strong>{objective?.title ?? shortId(checkpoint.objectiveId)}</strong>
                      </p>
                      <p className="muted small">{checkpoint.summary}</p>
                      <button type="button" className="btn btn-ghost touch-target" onClick={() => objective && onSelectProject(objective.projectId)}>Apri</button>
                    </div>
                  );
                })}
              </div>
            )}

            {pendingResultCheckpoints.length > 0 && (
              <div className="needs-group">
                <h3 className="needs-group-title needs-result">Decisioni su risultati</h3>
                {pendingResultCheckpoints.map((checkpoint) => {
                  const objective = objectiveById.get(checkpoint.objectiveId);
                  return (
                    <div className="needs-item" key={checkpoint.id}>
                      <p className="needs-summary">
                        <strong>{objective?.title ?? shortId(checkpoint.objectiveId)}</strong>
                      </p>
                      <p className="muted small">{checkpoint.summary}</p>
                      {checkpoint.recommendedAction && (
                        <p className="muted small">Raccomandato: {checkpoint.recommendedAction}</p>
                      )}
                      <div className="needs-actions">
                        <button type="button" className="btn btn-approve touch-target" disabled={deciding === checkpoint.id}
                          onClick={() => onDecide(checkpoint.id, 'APPROVE')}>Approva</button>
                        <button type="button" className="btn touch-target" disabled={deciding === checkpoint.id}
                          onClick={() => onDecide(checkpoint.id, 'REQUEST_CHANGES')}>Modifiche</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

          </section>
          )}

          <section className="panel activity-feed">
            <div className="panel-head">
              <h2>Attività recente</h2>
              <button type="button" className="btn btn-ghost" onClick={() => onNavigate('events-audit')}>Audit</button>
            </div>
            {recentEvents.length === 0 ? (
              <p className="muted">Nessun evento recente.</p>
            ) : (
              <details className="activity-collapsible">
                <summary className="muted small">Mostra attività recente ({recentEvents.length})</summary>
                <ul className="event-list">
                  {recentEvents.map((ev) => (
                    <li key={ev.id}>
                      <time>{formatDate(ev.timestamp)}</time>
                      <code>{ev.type}</code>
                      <span>{summarizeEventPayload(ev.payload)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

