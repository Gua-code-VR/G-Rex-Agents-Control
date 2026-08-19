import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AgentSession,
  type CreateObjectiveInput,
  type DecisionType,
  type EventRecord,
  type Objective,
  type Project,
  type StatusResponse,
  type Checkpoint,
  type Notification,
  type ExecutionProvider,
  type GovernanceDashboard,
} from './api/client';
import { AppShell } from './components/AppShell';
import { summarizeEventPayload } from './lib/event-summary';
import { SESSION_STATUS_LABEL } from './lib/labels';
import { ControlRoom } from './components/ControlRoom';
import { ExecutionsView } from './components/ExecutionsView';
import { ObjectiveView } from './components/ObjectiveView';
import { ProjectView } from './components/ProjectView';
import { RequiresYouView } from './components/RequiresYouView';
import { SystemView } from './components/SystemView';
import { AiCatalogView } from './components/AiCatalogView';
import { LoginPage } from './components/LoginPage';
import type { NavSection } from './components/Sidebar';
import { SettingsPage } from './components/SettingsPage';
import { ActivityMonitorView } from './components/ActivityMonitorView';

type LoadState = 'loading' | 'ready' | 'error';

function formatDate(value: string): string {
  return new Date(value).toLocaleString('it-IT');
}

// ── PortfolioGovernance ──────────────────────────────────────────────

function PortfolioGovernance() {
  const [items, setItems] = useState<Array<{ project: { id: string; name: string }; governance: GovernanceDashboard }>>([]);
  const load = useCallback(() => { void api.getGovernancePortfolio().then((r) => setItems(r.projects)).catch(() => undefined); }, []);
  useEffect(load, [load]);
  return <section className="card portfolio-governance-card"><div className="git-box-head"><h2>Portafoglio budget</h2><button className="btn btn-ghost" onClick={load}>Aggiorna</button></div>{items.length === 0 ? <p className="muted">Nessun consumo registrato.</p> : <ul className="git-line">{items.map(({ project, governance }) => <li key={project.id}><strong>{project.name}</strong>: € {governance.budget.used.toFixed(4)} / {governance.policy.costBudget === null ? 'illimitato' : `€ ${governance.policy.costBudget.toFixed(4)}`} {governance.budget.remaining !== null && governance.budget.remaining <= 0 ? '— a rischio' : ''}</li>)}</ul>}</section>;
}

// ── Main App ──────────────────────────────────────────────────────────

export default function App() {
  // Auth
  const [authenticated, setAuthenticated] = useState(true);
  const [checkingAuth, setCheckingAuth] = useState(true);
  // Data
  const [status, setStatus] = useState<StatusResponse | null>(null);
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
  // Navigation (§4 CONTROL_ROOM_SPEC.md)
  const [activeTab, setActiveTab] = useState<NavSection>('control-room');
  // Spesa rilevata (Fase 2): alimentata dalla Control Room per l'header.
  const [costToday, setCostToday] = useState<number | null>(null);
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
      setStatus(sr); setProjects(pr.projects); setEvents(er.events); setNotifications(nr.notifications); setProviders(runtimeList.providers); setCostToday(sr.costToday);
      await loadM3(pr.projects); setLoadState('ready'); setError(null);
    } catch (err) { setLoadState('error'); setError(err instanceof Error ? err.message : String(err)); }
  }, [loadM3]);

  // Bootstrap della UI solo a sessione autenticata: durante il ripristino della
  // sessione la vista resta neutra (Caricamento…) e non mostra il flash iniziale
  // «Errore di connessione / Autenticazione richiesta»; l'errore appare solo se
  // il refresh fallisce davvero con sessione attiva.
  useEffect(() => {
    if (!checkingAuth && authenticated) {
      setLoadState((prev) => (prev === 'ready' ? prev : 'loading'));
      void refresh();
    }
  }, [checkingAuth, authenticated, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { void api.listNotifications().then((r) => setNotifications(r.notifications)).catch(() => undefined); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  // Refresh automatico affidabile: la UI resta allineata al backend.
  useEffect(() => {
    const timer = window.setInterval(() => { if (authenticated) void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh, authenticated]);
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
  const handleCreateProject = async (input: { name: string; repositoryPath?: string; currentObjective?: string }) => {
    setActionError(null);
    try {
      const result = await api.createProject({
        name: input.name,
        ...(input.repositoryPath ? { repositoryPath: input.repositoryPath } : {}),
        ...(input.currentObjective ? { currentObjective: input.currentObjective } : {}),
      });
      // Apri il progetto appena creato.
      setSelectedProjectId(result.project.id);
      await refresh();
      // Usa la risposta di POST /api/projects: senza obiettivo iniziale porta
      // direttamente a «Nuovo obiettivo»; con obiettivo iniziale l'obiettivo è
      // già stato creato e avviato dal server (autoStart), quindi resta sul progetto.
      if (!result.initialObjective) {
        setActiveTab('objectives');
      }
    } catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
  };
  const handleRefreshGit = async (id: string) => {
    setActionError(null); setGitBusy((p) => ({ ...p, [id]: true }));
    try { await api.refreshProjectGitStatus(id); await refresh(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setGitBusy((p) => ({ ...p, [id]: false })); }
  };
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
  const handleStart = (oId: string, sId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null }) => runObjAction(oId, () => api.startSession(oId, sId, selection));
  const handleStop = (oId: string, sId: string, reason?: string) => runObjAction(oId, () => api.stopSession(oId, sId, reason));
  const handleComplete = (oId: string, report?: string) => runObjAction(oId, () => api.completeObjective(oId, report));
  const handleBlock = (oId: string, reason?: string) => runObjAction(oId, () => api.blockObjective(oId, reason));
  const handleFail = (oId: string, detail?: string) => runObjAction(oId, () => api.failObjective(oId, detail));
  const handleCancel = (oId: string) => runObjAction(oId, () => api.cancelObjective(oId));
  const handleRetry = (oId: string, selection?: { runtimeId: string; providerId?: string; modelId?: string | null }) => runObjAction(oId, () => api.retryObjective(oId, selection));
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
    return <LoginPage onAuthenticated={() => { setAuthenticated(true); }} />;
  }

  // «Richiede te» (badge unico, §5 V2): conteggio autoritativo dal backend,
  // che include checkpoint PENDING_DECISION + approvazioni budget + approvazioni
  // runtime. Fallback su checkpoint quando lo status non è ancora disponibile.
  const pendingDecisions = status?.requiresYouCount
    ?? Object.values(checkpointsByObjective).flat().filter((c) => c.status === 'PENDING_DECISION').length;

  if (loadState === 'error') {
    return (
      <div className="app-shell">
        <header className="app-header"><div className="header-brand"><span className="brand-mark">🦖</span><span className="brand-text">G-Rex Control Room</span></div></header>
        <div className="error-container">
          <p className="error-title">⚠ Errore di connessione</p><p className="error-message">{error}</p>
          <button type="button" className="btn btn-primary touch-target" onClick={() => void refresh()}>Riprova</button>
        </div>
      </div>
    );
  }

  return (
    <AppShell activeSection={activeTab} onNavigate={(section) => setActiveTab(section as NavSection)} pendingDecisions={pendingDecisions} costToday={costToday}>
      {loadState === 'loading' ? (<p className="muted">Caricamento…</p>) : (<>

          {(actionError) && (
            <div className="error-bar" onClick={() => { setActionError(null); }}>
              ⚠ {actionError}<span className="error-dismiss">✕</span>
            </div>
          )}
          {/* CONTROL ROOM (cockpit operativo — Fase 2, §5) */}
          {activeTab === 'control-room' && (<div className="tab-content control-room-tab">
            {notifications.length > 0 && <section className="card" aria-live="polite">
              <div className="git-box-head"><h2>Notifiche ({notifications.length})</h2><button type="button" className="btn btn-ghost" onClick={() => void markNotificationsRead()}>Segna lette</button></div>
              <ul className="event-list">{notifications.slice(0, 5).map((notification) => <li key={notification.id}><time>{formatDate(notification.createdAt)}</time><code>{notification.severity}</code><span><strong>{notification.title}</strong> — {notification.message}</span></li>)}</ul>
            </section>}
            <ControlRoom
              projects={projects}
              objectivesByProject={objectivesByProject}
              sessionsByObjective={sessionsByObjective}
              checkpointsByObjective={checkpointsByObjective}
              events={events}
              onNavigate={(section) => setActiveTab(section as NavSection)}
              onSelectProject={(id) => { setSelectedProjectId(id); setActiveTab('projects'); }}
              onDecide={handleDecide}
              deciding={decidingCheckpoint}
            />
          </div>)}

          {/* PROJECTS (§4: Progetti — vista dedicata in Fase 3) */}
          {activeTab === 'projects' && (<div className="tab-content project-view-tab">
            <ProjectView
              projects={projects}
              objectivesByProject={objectivesByProject}
              sessionsByObjective={sessionsByObjective}
              checkpointsByObjective={checkpointsByObjective}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              gitBusy={gitBusy}
              onRefreshGit={handleRefreshGit}
              onCreateProject={handleCreateProject}
              onDecide={handleDecide}
              deciding={decidingCheckpoint}
              onNavigateObjectives={(id) => { setSelectedProjectId(id); setActiveTab('objectives'); }}
            />
          </div>)}

          {/* OBJECTIVES (§4: Obiettivi — vista dedicata in Fase 4) */}
          {activeTab === 'objectives' && (<div className="tab-content objective-view-tab">
            <ObjectiveView projects={projects} objectivesByProject={objectivesByProject}
              sessionsByObjective={sessionsByObjective} checkpointsByObjective={checkpointsByObjective}
              selectedProjectId={selectedProjectId} onSelectProject={setSelectedProjectId}
              busy={objectiveBusy} creating={creatingObjective} onCreate={handleCreateObj}
              onStart={handleStart} onStop={handleStop} onComplete={handleComplete}
              onBlock={handleBlock} onFail={handleFail} onCancel={handleCancel}
              onRetry={handleRetry}
              onDecide={handleDecide} deciding={decidingCheckpoint} providers={providers} />
          </div>)}

          {/* EXECUTIONS (§4: Esecuzioni — vista dedicata in Fase 5) */}
          {activeTab === 'executions' && (<div className="tab-content executions-view-tab">
            <ExecutionsView
              projects={projects}
              objectivesByProject={objectivesByProject}
              sessionsByObjective={sessionsByObjective}
              providers={providers}
              onStop={handleStop}
              onCancel={handleCancel}
              busy={objectiveBusy}
            />
          </div>)}

          {activeTab === 'activity-monitor' && (<div className="tab-content activity-monitor-tab">
            <ActivityMonitorView projects={projects} objectivesByProject={objectivesByProject} sessionsByObjective={sessionsByObjective} />
          </div>)}

          {/* REQUIRES YOU (§4: Richiede te — vista dedicata in Fase 6) */}

          {activeTab === 'requires-you' && (<div className="tab-content requires-you-tab">
            <RequiresYouView
              objectivesByProject={objectivesByProject}
              checkpointsByObjective={checkpointsByObjective}
              onDecide={handleDecide}
              onCancel={handleCancel}
              onRetry={handleRetry}
              deciding={decidingCheckpoint}
              busy={objectiveBusy}
            />
          </div>)}

          {/* GOVERNANCE (§4: nav secondaria — vista dedicata in Fase 10) */}
          {activeTab === 'governance' && (<div className="tab-content">
            <PortfolioGovernance />
          </div>)}

          {/* AI CATALOG (§4: nav secondaria — vista dedicata in Fase 9) */}
          {activeTab === 'ai-catalog' && (<div className="tab-content ai-catalog-tab">
            <AiCatalogView />
          </div>)}


          {/* SYSTEM (§4: nav secondaria — vista dedicata in Fase 8) */}
          {activeTab === 'system' && (<div className="tab-content system-tab">
            <SystemView
              projectsCount={projects.length}
              sessionsByObjective={sessionsByObjective}
              providers={providers}
            />
          </div>)}



          {/* EVENTS / AUDIT (§4: nav secondaria — cronologia storica esistente, refinement in Fase 10) */}

          {activeTab === 'events-audit' && (<div className="tab-content">
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
                      <span>{summarizeEventPayload(ev.payload)}</span></li>
                  ))}
                </ul>
              )}
            </section>
          </div>)}
          {/* SETTINGS TAB */}
          {activeTab === 'settings' && (<div className="tab-content">
            <SettingsPage onLogout={() => setAuthenticated(false)} version="0.4.0" />
          </div>)}
          <footer className="footer">
            <p>Solo rete locale / VPN Tailscale · nessun servizio esterno · SQLite <code>data/gac.sqlite</code></p>
          </footer>
        </>
      )}
    </AppShell>
  );
}
