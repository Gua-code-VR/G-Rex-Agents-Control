import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type AgentSession,
  type ExecutionAttempt,
  type ExecutionProvider,
  type Objective,
  type Project,
} from '../api/client';
import { SESSION_STATUS_LABEL } from '../lib/labels';

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `€ ${value.toFixed(4)}`;
}

function durationMs(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export interface ExecutionsViewProps {
  projects: Project[];
  objectivesByProject: Record<string, Objective[]>;
  sessionsByObjective: Record<string, AgentSession[]>;
  providers: ExecutionProvider[];
  onStop: (objectiveId: string, sessionId: string, reason?: string) => void;
  onCancel: (objectiveId: string) => void;
  busy: Record<string, boolean>;
}

interface Row {
  project: Project | undefined;
  objective: Objective;
  session: AgentSession;
  attempts: ExecutionAttempt[];
  kind: 'active' | 'queue' | 'retry' | 'waiting' | 'blocked';
  explanation: string;
}


/**
 * Fase 5 — Esecuzioni (§11 CONTROL_ROOM_SPEC.md).
 * "Task manager" degli agenti: chi lavora, su cosa, con quale AI, durata,
 * costo, coda, retry/fallback e attese umane.
 */
export function ExecutionsView({
  projects,
  objectivesByProject,
  sessionsByObjective,
  providers,
  onStop,
  onCancel,
  busy,
}: ExecutionsViewProps) {
  const [attemptsBySession, setAttemptsBySession] = useState<Record<string, ExecutionAttempt[]>>({});

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p] as const)), [projects]);
  const objectiveById = useMemo(
    () => new Map(Object.values(objectivesByProject).flat().map((o) => [o.id, o] as const)),
    [objectivesByProject],
  );

  const allSessions = useMemo(
    () => Object.values(sessionsByObjective).flat(),
    [sessionsByObjective],
  );

  useEffect(() => {
    if (allSessions.length === 0) { setAttemptsBySession({}); return; }
    let cancelled = false;
    void Promise.all(
      allSessions.map(async (s) => [s.id, (await api.listExecutionAttempts(s.id)).attempts] as const),
    )
      .then((entries) => { if (!cancelled) setAttemptsBySession(Object.fromEntries(entries)); })
      .catch(() => { if (!cancelled) setAttemptsBySession({}); });
    return () => { cancelled = true; };
  }, [allSessions]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const session of allSessions) {
      const objective = objectiveById.get(session.objectiveId);
      if (!objective) continue;
      const project = projectById.get(objective.projectId);
      const attempts = attemptsBySession[session.id] ?? [];
      const last = attempts[attempts.length - 1];

      let kind: Row['kind'] = 'waiting';
      let explanation = '';

      if (session.status === 'ATTIVA') {
        kind = 'active';
        explanation = 'Esecuzione in corso';
      } else if (session.status === 'IN_AVVIO') {
        kind = 'queue';
        explanation = 'In attesa di avvio';
      } else if (session.status === 'BLOCCATA') {
        kind = 'blocked';
        explanation = session.exitReason ?? 'Esecuzione bloccata';
      } else if (session.status === 'STALE') {
        kind = 'blocked';
        explanation = 'Sessione inattiva (nessun heartbeat recente)';
      } else if (session.status === 'ERRORE' || last?.status === 'FAILED') {
        if (last?.errorClass === 'CONNECTIVITY_ERROR' || last?.errorClass === 'AGENT_CONTROL_ERROR') {
          kind = 'retry';
          explanation = `Errore recuperabile (${last.errorClass}): verrà ritentato${last.fallbackOfAttemptId ? ' con fallback su altro runtime' : ''}`;
        } else {
          kind = 'blocked';
          explanation = last?.reason ?? last?.errorClass ?? 'Errore non recuperabile';
        }
      } else if (objective.status === 'RICHIEDE_ATTENZIONE') {
        kind = 'waiting';
        explanation = 'In attesa di decisione umana';
      } else if (objective.status === 'BLOCCATO') {
        kind = 'blocked';
        explanation = 'Obiettivo bloccato';
      } else {
        kind = 'waiting';
        explanation = SESSION_STATUS_LABEL[session.status];
      }

      out.push({ project, objective, session, attempts, kind, explanation });
    }
    return out;
  }, [allSessions, objectiveById, projectById, attemptsBySession]);

  const active = rows.filter((r) => r.kind === 'active');
  const queue = rows.filter((r) => r.kind === 'queue');
  const retry = rows.filter((r) => r.kind === 'retry');
  const waiting = rows.filter((r) => r.kind === 'waiting');
  const blocked = rows.filter((r) => r.kind === 'blocked');

  const configuredWorkers = providers.filter((p) => p.configured).length || 1;
  const occupied = active.length;

  const sections: Array<{ key: Row['kind']; title: string; rows: Row[]; priority: number }> = [
    { key: 'waiting', title: 'In attesa di te', rows: waiting, priority: 0 },
    { key: 'active', title: 'Attive', rows: active, priority: 1 },
    { key: 'retry', title: 'Retry/Fallback', rows: retry, priority: 2 },
    { key: 'queue', title: 'Coda', rows: queue, priority: 3 },
    { key: 'blocked', title: 'Bloccate', rows: blocked, priority: 4 },
  ];

  const orderedSections = [...sections].sort((a, b) => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) {
      const mobilePriority: Record<Row['kind'], number> = { waiting: 0, active: 1, retry: 2, queue: 3, blocked: 4 };
      return mobilePriority[a.key] - mobilePriority[b.key];
    }
    return a.priority - b.priority;
  });

  const totalRows = rows.length;

  return (
    <div className="executions-view">
      <section className="control-kpis executions-kpis" aria-label="Capacità">
        <div className="kpi kpi-active">
          <span className="kpi-value">{occupied} / {configuredWorkers}</span>
          <span className="kpi-label">Worker occupati</span>
        </div>
        <div className="kpi kpi-waiting">
          <span className="kpi-value">{queue.length}</span>
          <span className="kpi-label">In coda</span>
        </div>
        {retry.length > 0 && (
          <div className="kpi kpi-error">
            <span className="kpi-value">{retry.length}</span>
            <span className="kpi-label">Retry</span>
          </div>
        )}
        {waiting.length + blocked.length > 0 && (
          <div className="kpi kpi-need-you">
            <span className="kpi-value">{waiting.length + blocked.length}</span>
            <span className="kpi-label">Richiedono te</span>
          </div>
        )}
      </section>

      {totalRows === 0 ? (
        <section className="panel">
          <div className="panel-head"><h2>Esecuzioni</h2></div>
          <p className="muted">Nessuna esecuzione registrata. ✓ Gli agenti possono procedere in autonomia.</p>
        </section>
      ) : (
        orderedSections.map((section) => {
          if (section.rows.length === 0) return null;
          return (
            <section className="panel execution-group" key={section.key}>
              <div className="panel-head">
                <h2>{section.title}</h2>
                <span className="muted small">{section.rows.length}</span>
              </div>
              <div className="ops-table executions-table" role="table" aria-label={section.title}>
                <div className="ops-row ops-head" role="row">
                  <span role="columnheader">Chi</span>
                  <span role="columnheader">Obiettivo</span>
                  <span role="columnheader">AI</span>
                  <span role="columnheader">Durata</span>
                  <span role="columnheader">Costo</span>
                  <span role="columnheader">Stato</span>
                  <span role="columnheader">Azioni</span>
                </div>
                {section.rows.map((row) => {
                  const stoppable = row.session.status === 'ATTIVA';
                  const latest = row.attempts[row.attempts.length - 1];
                  return (
                    <div className="ops-row" role="row" key={row.session.id}>
                      <span className="ops-cell ops-project" role="cell">
                        {row.project?.name ?? shortId(row.objective.projectId)}
                      </span>
                      <span className="ops-cell ops-objective" role="cell">
                        {row.objective.title}
                        <span className={`badge badge-${row.session.status.toLowerCase()}`}>{SESSION_STATUS_LABEL[row.session.status]}</span>
                      </span>
                      <span className="ops-cell ops-ai" role="cell">
                        {row.session.executionSelection
                          ? `${row.session.executionSelection.providerId}/${row.session.executionSelection.modelId ?? 'modello runtime'}`
                          : row.session.agentType}
                      </span>
                      <span className="ops-cell" role="cell">{durationMs(latest?.durationMs ?? null)}</span>
                      <span className="ops-cell" role="cell">{money(latest?.costActual ?? latest?.costEstimate ?? null)}</span>
                      <span className="ops-cell" role="cell">
                        <span className="execution-status" title={row.explanation}>{row.explanation}</span>
                      </span>
                      <span className="ops-cell ops-actions" role="cell">
                        {stoppable && (
                          <button type="button" className="btn btn-ghost touch-target" disabled={busy[row.objective.id] ?? false}
                            onClick={() => onStop(row.objective.id, row.session.id)}>
                            Ferma esecuzione
                          </button>
                        )}
                        {row.kind === 'blocked' && row.objective.status !== 'COMPLETATO' && row.objective.status !== 'ANNULLATO' && (
                          <button type="button" className="btn btn-danger touch-target" disabled={busy[row.objective.id] ?? false}
                            onClick={() => onCancel(row.objective.id)}>
                            Annulla obiettivo
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="muted small execution-note">
                «Ferma esecuzione» interrompe la sessione corrente e mantiene l'obiettivo disponibile per un nuovo tentativo. «Annulla obiettivo» chiude definitivamente l'obiettivo.
              </p>
            </section>
          );
        })
      )}
    </div>
  );
}

