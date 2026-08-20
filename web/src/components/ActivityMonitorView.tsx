import { useEffect, useMemo, useState } from 'react';
import { api, type AgentSession, type EventRecord, type ExecutionAttempt, type Objective, type Project } from '../api/client';
import { summarizeEventPayload } from '../lib/event-summary';
import { OBJECTIVE_STATUS_LABEL, SESSION_STATUS_LABEL } from '../lib/labels';
import { HelpLink } from './HelpLink';
import type { HelpTopicId } from '../content/help';

interface Props {
  projects: Project[];
  objectivesByProject: Record<string, Objective[]>;
  sessionsByObjective: Record<string, AgentSession[]>;
  onOpenHelp: (topic: HelpTopicId) => void;
}

type Worker = { id: string; task: string | null; events: EventRecord[] };

export interface TeamRunTimelineItem {
  id: string;
  worker: string;
  task: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  overlaps: string[];
  messagePreview: string | null;
}

export interface NativeWorkflowSummary {
  maxWorkers: number;
  phase: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  verification: string | null;
}

interface ExtractedRun {
  id: string;
  worker: string | null;
  taskId: string | null;
  task: string | null;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messagePreview: string | null;
}

interface TeamToolInput {
  agentId?: unknown;
  taskId?: unknown;
  task?: unknown;
  runId?: unknown;
}

interface TeamToolOutput {
  id?: unknown;
  runId?: unknown;
  agentId?: unknown;
  taskId?: unknown;
  task?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  messagePreview?: unknown;
}

const EVENT_HISTORY_LIMIT = 5_000;

const live = (value: Objective) => ['IN_AVVIO', 'IN_LAVORAZIONE'].includes(value.status);
const money = (value: number) => value > 0 ? `€ ${value.toFixed(4)}` : '—';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const stringValue = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const runIdOf = (value: unknown): string | null => {
  const id = stringValue(value);
  return id && /^run_0000[1-5]$|^run_\d+$/u.test(id) ? id : null;
};

function duration(ms: number | null, from?: string | null) {
  const value = ms ?? (from ? Math.max(0, Date.now() - new Date(from).getTime()) : null);
  if (value === null) return '—';
  const s = Math.floor(value / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatDuration(ms: number | null) {
  if (ms === null) return '—';
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function kind(event: EventRecord) {
  const text = `${event.type} ${JSON.stringify(event.payload ?? '')}`.toLowerCase();
  return text.includes('workflow.native') ? 'workflow' : text.includes('heartbeat') ? 'heartbeat' : text.includes('fallback') ? 'fallback' : text.includes('retry') ? 'retry' : text.includes('tool') ? 'tool' : 'event';
}

/** Etichette leggibili dei bucket di evento mostrati nella timeline del Monitor. */
const EVENT_KIND_LABEL: Record<string, string> = {
  workflow: 'Workflow nativo',
  heartbeat: 'Heartbeat',
  fallback: 'Fallback',
  retry: 'Retry',
  tool: 'Strumento',
  event: 'Evento',
};

export function eventKindLabel(kindValue: string): string {
  return EVENT_KIND_LABEL[kindValue] ?? kindValue;
}

/** Etichette leggibili dello stato di un run team (join/fan-out del runtime). */
const RUN_STATUS_LABEL: Record<string, string> = {
  queued: 'In coda',
  running: 'In esecuzione',
  started: 'Avviato',
  completed: 'Completato',
  succeeded: 'Completato',
  success: 'Completato',
  failed: 'Fallito',
  error: 'Errore',
  cancelled: 'Annullato',
  canceled: 'Annullato',
  blocked: 'Bloccato',
};

export function runStatusLabel(status: string | null): string {
  if (!status) return '—';
  return RUN_STATUS_LABEL[status.toLowerCase()] ?? status;
}

/** Indica se un evento persistito rappresenta un errore corrente (per evidenza). */
const ERROR_EVENT_TYPE_PATTERNS: RegExp[] = [
  /\.error$/u,
  /\.failed$/u,
  /\.rejected$/u,
  /\.stale$/u,
  /\berror$/u,
];

export function isErrorEvent(event: EventRecord): boolean {
  if (ERROR_EVENT_TYPE_PATTERNS.some((pattern) => pattern.test(event.type))) return true;
  if (isRecord(event.payload)) {
    const outcome = stringValue(event.payload.outcome);
    if (outcome && /failed|error|cancelled/i.test(outcome)) return true;
  }
  return false;
}

/** Stato sintetico, derivato esclusivamente dagli eventi persistiti del Control Plane. */
export function extractNativeWorkflowSummary(events: EventRecord[]): NativeWorkflowSummary | null {
  let summary: NativeWorkflowSummary | null = null;
  let lastMaxWorkers: number | null = null;
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (!isRecord(event.payload) || !event.type.startsWith('workflow.native.')) continue;
    const maxWorkers: number | null = typeof event.payload.maxWorkers === 'number' ? event.payload.maxWorkers : lastMaxWorkers;
    if (!maxWorkers) continue;
    lastMaxWorkers = maxWorkers;
    if (event.type === 'workflow.native.started') {
      summary = { maxWorkers, phase: 'RUNNING', verification: null };
      continue;
    }
    const outcome = stringValue(event.payload.outcome);
    summary = {
      maxWorkers,
      phase: outcome === 'COMPLETED' ? 'COMPLETED' : outcome === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
      verification: stringValue(event.payload.verification),
    };
  }
  return summary;
}

function worker(event: EventRecord): { id: string; task: string | null } | null {
  if (!isRecord(event.payload)) return null;
  const p = event.payload;
  const m = isRecord(p.metadata) ? p.metadata : {};
  const id = [p.workerId, p.worker_id, p.agentId, p.agent_id, m.workerId, m.agentId].map(stringValue).find(Boolean);
  if (!id) return null;
  const task = [p.taskId, p.task_id, m.taskId].map(stringValue).find(Boolean) ?? null;
  return { id, task };
}

const raw = (value: unknown) => JSON.stringify(value, null, 2);

function toolEvent(payload: unknown): { toolName: string | null; toolCallId: string | null; phase: 'start' | 'end' | null; input: TeamToolInput | null; output: TeamToolOutput | TeamToolOutput[] | null } | null {
  if (!isRecord(payload) || !isRecord(payload.metadata) || !isRecord(payload.metadata.event)) return null;
  const event = payload.metadata.event;
  if (event.contentType !== 'tool') return null;
  const phase = event.type === 'content_start' ? 'start' : event.type === 'content_end' ? 'end' : null;
  return {
    toolName: stringValue(event.toolName),
    toolCallId: stringValue(event.toolCallId),
    phase,
    input: isRecord(event.input) ? event.input : null,
    output: Array.isArray(event.output)
      ? event.output.filter(isRecord)
      : isRecord(event.output) ? event.output : null,
  };
}

function mergeRun(existing: ExtractedRun | undefined, update: Partial<ExtractedRun>): ExtractedRun {
  return {
    id: update.id ?? existing?.id ?? '',
    worker: update.worker ?? existing?.worker ?? null,
    taskId: update.taskId ?? existing?.taskId ?? null,
    task: update.task ?? existing?.task ?? null,
    status: update.status ?? existing?.status ?? null,
    startedAt: update.startedAt ?? existing?.startedAt ?? null,
    endedAt: update.endedAt ?? existing?.endedAt ?? null,
    messagePreview: update.messagePreview ?? existing?.messagePreview ?? null,
  };
}

function runFromOutput(output: TeamToolOutput, fallback?: TeamToolInput | null): Partial<ExtractedRun> | null {
  const id = runIdOf(output.id) ?? runIdOf(output.runId);
  if (!id) return null;
  return {
    id,
    worker: stringValue(output.agentId) ?? stringValue(fallback?.agentId),
    taskId: stringValue(output.taskId) ?? stringValue(fallback?.taskId),
    task: stringValue(output.task) ?? stringValue(fallback?.task),
    status: stringValue(output.status),
    startedAt: stringValue(output.startedAt),
    endedAt: stringValue(output.endedAt),
    messagePreview: stringValue(output.messagePreview) ?? stringValue(fallback?.task),
  };
}

export function extractTeamRuns(events: EventRecord[]): TeamRunTimelineItem[] {
  const inputsByCall = new Map<string, TeamToolInput>();
  const runs = new Map<string, ExtractedRun>();

  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const tool = toolEvent(event.payload);
    if (!tool || !tool.toolCallId || !tool.toolName?.startsWith('team_')) continue;
    if (tool.phase === 'start' && tool.input) inputsByCall.set(tool.toolCallId, tool.input);
    if (tool.phase !== 'end' || !tool.output) continue;

    const input = inputsByCall.get(tool.toolCallId) ?? null;
    const outputs = Array.isArray(tool.output) ? tool.output : [tool.output];
    for (const output of outputs) {
      const parsed = runFromOutput(output, input);
      if (!parsed?.id) continue;
      runs.set(parsed.id, mergeRun(runs.get(parsed.id), parsed));
    }
  }

  const items = [...runs.values()].map((run) => {
    const started = run.startedAt ? new Date(run.startedAt).getTime() : Number.NaN;
    const ended = run.endedAt ? new Date(run.endedAt).getTime() : Number.NaN;
    return {
      id: run.id,
      worker: run.worker ?? 'worker non indicato',
      task: run.taskId ?? run.task ?? 'task non indicato',
      status: run.status ?? 'unknown',
      startedAt: Number.isFinite(started) ? run.startedAt : null,
      endedAt: Number.isFinite(ended) ? run.endedAt : null,
      durationMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
      overlaps: [] as string[],
      messagePreview: run.messagePreview,
    };
  }).sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.id.localeCompare(b.id));

  for (const item of items) {
    const start = item.startedAt ? new Date(item.startedAt).getTime() : null;
    const end = item.endedAt ? new Date(item.endedAt).getTime() : null;
    if (start === null || end === null) continue;
    item.overlaps = items
      .filter((other) => {
        if (other.id === item.id || !other.startedAt || !other.endedAt) return false;
        return start < new Date(other.endedAt).getTime() && new Date(other.startedAt).getTime() < end;
      })
      .map((other) => other.id);
  }

  return items;
}

export function calculatePeakConcurrency(runs: TeamRunTimelineItem[]) {
  const points = runs.flatMap((run) => {
    if (!run.startedAt || !run.endedAt) return [];
    return [
      { time: new Date(run.startedAt).getTime(), delta: 1 },
      { time: new Date(run.endedAt).getTime(), delta: -1 },
    ];
  }).sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0;
  let peak = 0;
  for (const point of points) {
    active += point.delta;
    peak = Math.max(peak, active);
  }
  const now = Date.now();
  const currentlyActive = runs.filter((run) => run.startedAt && !run.endedAt && new Date(run.startedAt).getTime() <= now).length;
  return { peak, currentlyActive };
}

function timelineBounds(runs: TeamRunTimelineItem[]) {
  const starts = runs.map((run) => run.startedAt ? new Date(run.startedAt).getTime() : null).filter((value): value is number => value !== null && Number.isFinite(value));
  const ends = runs.map((run) => run.endedAt ? new Date(run.endedAt).getTime() : null).filter((value): value is number => value !== null && Number.isFinite(value));
  if (starts.length === 0 || ends.length === 0) return null;
  const start = Math.min(...starts);
  const end = Math.max(...ends);
  return { start, end: Math.max(end, start + 1), span: Math.max(1, end - start) };
}

function timeLabel(value: string | null) {
  return value ? new Date(value).toLocaleTimeString('it-IT') : '—';
}

export function ActivityMonitorView({ projects, objectivesByProject, sessionsByObjective, onOpenHelp }: Props) {
  const objectives = useMemo(
    () => Object.values(objectivesByProject).flat().sort((a, b) => Number(live(b)) - Number(live(a)) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [objectivesByProject],
  );
  const [selectedId, setSelectedId] = useState('');
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [attempts, setAttempts] = useState<ExecutionAttempt[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { if (!selectedId && objectives[0]) setSelectedId(objectives[0].id); }, [selectedId, objectives]);
  useEffect(() => { if (selectedId && !objectives.some((o) => o.id === selectedId)) setSelectedId(objectives[0]?.id ?? ''); }, [selectedId, objectives]);

  const objective = objectives.find((o) => o.id === selectedId) ?? null;
  const sessions = objective ? sessionsByObjective[objective.id] ?? [] : [];
  const project = objective ? projects.find((p) => p.id === objective.projectId) : null;

  useEffect(() => {
    if (!objective) {
      setEvents([]);
      setAttempts([]);
      return;
    }
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const [objectiveEvents, sessionEventResponses, responses] = await Promise.all([
          api.listEvents({ objectiveId: objective.id, limit: EVENT_HISTORY_LIMIT }),
          Promise.all(sessions.map((s) => api.listEvents({ sessionId: s.id, limit: EVENT_HISTORY_LIMIT }))),
          Promise.all(sessions.map((s) => api.listExecutionAttempts(s.id))),
        ]);
        if (alive) {
          const merged = new Map<number, EventRecord>();
          for (const event of objectiveEvents.events) merged.set(event.id, event);
          for (const response of sessionEventResponses) for (const event of response.events) merged.set(event.id, event);
          setEvents([...merged.values()].sort((a, b) => b.id - a.id));
          setAttempts(responses.flatMap((r) => r.attempts));
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [objective?.id, sessions.map((s) => s.id).join(',')]);

  const orderedAttempts = useMemo(() => [...attempts].sort((a, b) => a.attemptIndex - b.attemptIndex), [attempts]);
  const current = orderedAttempts.find((a) => !a.endedAt) ?? orderedAttempts[orderedAttempts.length - 1] ?? null;
  const activeSession = sessions.find((s) => s.status === 'ATTIVA' || s.status === 'IN_AVVIO') ?? sessions[sessions.length - 1] ?? null;
  const total = orderedAttempts.reduce((sum, a) => sum + (a.costActual ?? a.costEstimate ?? 0), 0);
  const teamRuns = useMemo(() => extractTeamRuns(events), [events]);
  const nativeWorkflow = useMemo(() => extractNativeWorkflowSummary(events), [events]);
  const concurrency = useMemo(() => calculatePeakConcurrency(teamRuns), [teamRuns]);
  const bounds = useMemo(() => timelineBounds(teamRuns), [teamRuns]);
  const workers = useMemo(() => {
    const all = new Map<string, Worker>();
    for (const event of events) {
      const found = worker(event);
      if (!found) continue;
      const item = all.get(found.id) ?? { id: found.id, task: found.task, events: [] };
      item.events.push(event);
      all.set(found.id, item);
    }
    for (const run of teamRuns) {
      const item = all.get(run.worker) ?? { id: run.worker, task: run.task, events: [] };
      item.task = item.task ?? run.task;
      all.set(run.worker, item);
    }
    return [...all.values()];
  }, [events, teamRuns]);

  return (
    <div className="activity-monitor">
      <section className="panel activity-monitor-head">
        <div>
          <p className="eyebrow">Monitor attività</p>
          <h1>Segui un obiettivo</h1>
          <p className="muted">Aggiornamento automatico ogni 5 secondi · solo eventi e stato già persistiti.</p>
          <HelpLink topic="monitor-attivita" onOpenHelp={onOpenHelp}>Leggi il Monitor</HelpLink>
        </div>
        <label className="select-label">
          Obiettivo
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            {objectives.map((o) => <option key={o.id} value={o.id}>{OBJECTIVE_STATUS_LABEL[o.status]} · {o.title}</option>)}
          </select>
        </label>
      </section>

      {!objective ? (
        <section className="panel"><p className="muted">Nessun obiettivo attivo o recente da monitorare.</p></section>
      ) : (
        <>
          <section className="monitor-summary">
            <div className="kpi"><span className="kpi-label">Stato</span><strong className="kpi-value">{OBJECTIVE_STATUS_LABEL[objective.status]}</strong><span className="muted small">{project?.name ?? '—'}</span></div>
            <div className="kpi"><span className="kpi-label">Runtime</span><strong className="kpi-value">{current?.runtimeName ?? activeSession?.agentType ?? '—'}</strong><span className="muted small">{current?.providerName ?? activeSession?.executionSelection?.providerId ?? '—'} / {current?.modelName ?? activeSession?.executionSelection?.modelId ?? 'modello runtime'}</span></div>
            <div className="kpi"><span className="kpi-label">Costo</span><strong className="kpi-value">{money(total)}</strong><span className="muted small">{orderedAttempts.length} tentativi</span></div>
            <div className="kpi"><span className="kpi-label">Durata</span><strong className="kpi-value">{duration(current?.durationMs ?? null, current?.startedAt ?? objective.startedAt)}</strong><span className="muted small">{activeSession?.lastHeartbeatAt ? `Heartbeat ${new Date(activeSession.lastHeartbeatAt).toLocaleTimeString('it-IT')}` : 'Nessun heartbeat'}</span></div>
            {nativeWorkflow && <div className="kpi"><span className="kpi-label">Workflow nativo</span><strong className="kpi-value">{nativeWorkflow.phase}</strong><span className="muted small">{nativeWorkflow.maxWorkers} worker max · {nativeWorkflow.verification ?? 'join/verifica in corso'}</span></div>}
          </section>

          <section className="panel worker-timeline-panel">
            <div className="panel-head">
              <div>
                <h2>Timeline worker/run</h2>
                <p className="muted small">Ricostruita dai payload persistiti `team_run_task`, `team_await_runs` e `team_list_runs`.</p>
              </div>
              <div className="panel-actions">
                {nativeWorkflow && <HelpLink topic="native-workflow" onOpenHelp={onOpenHelp}>Workflow nativo</HelpLink>}
                <span className={concurrency.peak > 1 ? 'parallel-badge' : 'muted small'}>
                  Attivi ora {concurrency.currentlyActive} · Picco {concurrency.peak}{nativeWorkflow ? ` · Limite ${nativeWorkflow.maxWorkers}` : ''}
                </span>
              </div>
            </div>
            {teamRuns.length === 0 || !bounds ? (
              <p className="muted">Nessun run team ricostruibile dagli eventi persistiti dell’obiettivo selezionato.</p>
            ) : (
              <>
                <div className="worker-timeline-scale">
                  <span>{new Date(bounds.start).toLocaleTimeString('it-IT')}</span>
                  <span>{new Date(bounds.end).toLocaleTimeString('it-IT')}</span>
                </div>
                <div className="worker-timeline" role="img" aria-label={`Timeline dei run con picco di concorrenza ${concurrency.peak}`}>
                  {teamRuns.map((run) => {
                    const start = run.startedAt ? new Date(run.startedAt).getTime() : bounds.start;
                    const end = run.endedAt ? new Date(run.endedAt).getTime() : bounds.end;
                    const left = Math.max(0, Math.min(100, ((start - bounds.start) / bounds.span) * 100));
                    const width = Math.max(1.5, Math.min(100 - left, ((end - start) / bounds.span) * 100));
                    return (
                      <div key={run.id} className="worker-timeline-row">
                        <div className="worker-timeline-label">
                          <strong>{run.id}</strong>
                          <span>{run.worker}</span>
                        </div>
                        <div className="worker-timeline-track">
                          <div
                            className={`worker-timeline-bar ${run.overlaps.length > 0 ? 'overlapping' : ''}`}
                            style={{ left: `${left}%`, width: `${width}%` }}
                            title={`${run.id} · ${run.worker} · ${timeLabel(run.startedAt)} → ${timeLabel(run.endedAt)}`}
                          >
                            <span>{run.task}</span>
                          </div>
                        </div>
                        <span className="worker-timeline-status">{runStatusLabel(run.status)}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="table-scroll">
                  <table className="worker-run-table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Worker</th>
                        <th>Task</th>
                        <th>Stato</th>
                        <th>StartedAt</th>
                        <th>EndedAt</th>
                        <th>Durata</th>
                        <th>Sovrapposizioni</th>
                      </tr>
                    </thead>
                    <tbody>
                      {teamRuns.map((run) => (
                        <tr key={run.id}>
                          <td className="mono">{run.id}</td>
                          <td>{run.worker}</td>
                          <td>{run.task}</td>
                          <td>{runStatusLabel(run.status)}</td>
                          <td>{run.startedAt ?? '—'}</td>
                          <td>{run.endedAt ?? '—'}</td>
                          <td>{formatDuration(run.durationMs)}</td>
                          <td>{run.overlaps.length > 0 ? run.overlaps.join(', ') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <div className="monitor-grid">
            <section className="panel monitor-main">
              <div className="panel-head"><h2>Attività</h2><span className="muted small">{loading ? 'Aggiornamento…' : `${events.length} eventi`}</span></div>
              {events.length === 0 ? <p className="muted">Nessun evento registrato.</p> : (
                <ol className="monitor-timeline">
                  {events.map((event) => {
                    const type = kind(event);
                    return (
                      <li key={event.id} className={`monitor-event monitor-event-${type} ${isErrorEvent(event) ? 'monitor-event-error' : ''}`}>
                        <time>{new Date(event.timestamp).toLocaleTimeString('it-IT')}</time>
                        <span className="monitor-event-kind">{eventKindLabel(type)}</span>
                        <div>
                          {isErrorEvent(event) && <span className="badge badge-errore">Errore</span>}
                          <strong>{event.type}</strong>
                          <p>{summarizeEventPayload(event.payload) || event.type.replace(/\./g, ' ')}</p>
                          {event.payload !== null && <details><summary>Dettagli tecnici raw</summary><pre>{raw(event.payload)}</pre></details>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <aside className="monitor-side">
              <section className="panel">
                <div className="panel-head"><h2>Tentativi e recovery</h2><HelpLink topic="retry-fallback" onOpenHelp={onOpenHelp}>Retry/fallback</HelpLink></div>
                <ol className="attempt-list">
                  {orderedAttempts.map((attempt) => (
                    <li key={attempt.id}>
                      <strong>#{attempt.attemptIndex} · {attempt.status}</strong>
                      <span>{attempt.runtimeName ?? 'runtime'} / {attempt.providerName ?? 'provider'} / {attempt.modelName ?? 'modello runtime'}</span>
                      <span>{duration(attempt.durationMs, attempt.startedAt)} · {money(attempt.costActual ?? attempt.costEstimate ?? 0)}</span>
                      {(attempt.attemptIndex > 1 || attempt.fallbackOfAttemptId) && <em>{attempt.fallbackOfAttemptId ? 'Fallback' : 'Retry'}</em>}
                      {attempt.reason && <p className="muted small">{attempt.reason}</p>}
                      <details><summary>Dettagli tecnici raw</summary><pre>{raw(attempt.metadata)}</pre></details>
                    </li>
                  ))}
                </ol>
                {orderedAttempts.length === 0 && <p className="muted">Nessun tentativo registrato.</p>}
              </section>
              <section className="panel">
                <div className="panel-head"><h2>Sessioni</h2></div>
                <ul className="monitor-sessions">
                  {sessions.map((s) => <li key={s.id}><strong>{SESSION_STATUS_LABEL[s.status]}</strong><span>{s.agentType} · heartbeat: {s.lastHeartbeatAt ? new Date(s.lastHeartbeatAt).toLocaleTimeString('it-IT') : '—'}</span></li>)}
                </ul>
              </section>
              {workers.length > 0 && (
                <section className="panel monitor-workers">
                  <div className="panel-head"><h2>Worker e task</h2><span className={workers.length > 1 ? 'parallel-badge' : 'muted small'}>{workers.length > 1 ? 'In parallelo' : 'Tracciato'}</span></div>
                  <p className="muted small">Rilevati dagli eventi del runtime.</p>
                  <ul>{workers.map((w) => <li key={w.id}><strong>Worker {w.id}</strong><span>Task: {w.task ?? 'non indicato'}</span><span className="muted small">{w.events.length} eventi</span></li>)}</ul>
                </section>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
