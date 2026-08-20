import { useEffect, useState } from 'react';
import {
  api,
  type AgentSession,
  type ExecutionProvider,
  type HealthResponse,
  type StatusResponse,
} from '../api/client';
import { HelpLink } from './HelpLink';
import type { HelpTopicId } from '../content/help';
import { filterOperationalProviders } from '../lib/provider-catalog';

export interface SystemViewProps {
  projectsCount: number;
  sessionsByObjective: Record<string, AgentSession[]>;
  providers: ExecutionProvider[];
  onOpenHelp: (topic: HelpTopicId) => void;
}

/**
 * Fase 8 — Sistema (§12 CONTROL_ROOM_SPEC.md).
 * Risponde: "Agent Control è in grado di lavorare in autonomia adesso?"
 * Uno stato di readiness di alto livello + diagnosi leggibili.
 */
export function SystemView({
  projectsCount,
  sessionsByObjective,
  providers,
  onOpenHelp,
}: SystemViewProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);

  useEffect(() => {
    void api.health().then((r) => setHealth(r)).catch(() => setHealth(null));
    void api.status().then((r) => setStatus(r)).catch(() => setStatus(null));
  }, []);

  const operationalProviders = filterOperationalProviders(providers);
  const configured = operationalProviders.filter((p) => p.configured);
  const activeSessions = Object.values(sessionsByObjective).flat().filter((s) => s.status === 'ATTIVA').length;
  const staleSessions = Object.values(sessionsByObjective).flat().filter((s) => s.status === 'STALE' || s.status === 'BLOCCATA').length;
  const queuedSessions = Object.values(sessionsByObjective).flat().filter((s) => s.status === 'IN_AVVIO').length;

  const controlPlaneOk = health?.status === 'ok';
  const ready = controlPlaneOk && configured.length > 0;

  const readiness = !controlPlaneOk ? 'Non pronto' : configured.length === 0 ? 'Funzionamento limitato' : 'Pronto a lavorare';

  const runBackup = async () => {
    setBackupMessage(null);
    try {
      const r = await api.createBackup();
      setBackupMessage(`Backup creato in ${r.backup.directory} (${r.backup.files.length} file).`);
    } catch (err) {
      setBackupMessage(err instanceof Error ? err.message : 'Backup non riuscito');
    }
  };

  return (
    <div className="system-view">
      <section className="panel">
        <div className="panel-head">
          <h2>Stato di readiness</h2>
          <HelpLink topic="primo-avvio" onOpenHelp={onOpenHelp}>Primo avvio</HelpLink>
        </div>
        <p className={`readiness-state readiness-${ready ? 'ok' : controlPlaneOk ? 'limited' : 'down'}`}>
          {readiness}
        </p>
        <p className="muted small">
          {ready
            ? 'Il Control Plane è attivo e almeno un runtime è configurato: il lavoro autonomo può procedere.'
            : controlPlaneOk
              ? 'Il Control Plane è attivo ma nessun runtime reale è configurato.'
              : 'Il Control Plane non risponde correttamente.'}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Salute componenti</h2></div>
        <ul className="health-list">
          <li><span className="health-label">Control Plane</span><span className={`health-value ${controlPlaneOk ? 'ok' : 'warn'}`}>{controlPlaneOk ? 'Operativo' : 'Non operativo'}</span></li>
          <li><span className="health-label">Database</span><span className="health-value">{status?.storage.exists === false ? 'Non trovato' : 'Disponibile'}</span></li>
          <li><span className="health-label">Runtime configurati</span><span className="health-value">{configured.length}</span></li>
          <li><span className="health-label">Sessioni attive</span><span className="health-value">{activeSessions}</span></li>
          <li><span className="health-label">In coda</span><span className="health-value">{queuedSessions}</span></li>
          <li><span className="health-label">Bloccate/inattive</span><span className="health-value">{staleSessions}</span></li>
          <li><span className="health-label">Progetti</span><span className="health-value">{projectsCount}</span></li>
          <li><span className="health-label">Decisioni pendenti</span><span className="health-value">{status?.requiresYouCount ?? status?.pendingDecisions ?? 0}</span></li>
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Runtime</h2><HelpLink topic="configurazione" onOpenHelp={onOpenHelp}>Configurazione</HelpLink></div>
        {operationalProviders.map((p) => (
          <div className="needs-item" key={p.id}>
            <p className="needs-summary"><strong>{p.runtimeName}</strong></p>
            <p className="muted small">
              {p.configured ? '✓ Configurato e disponibile' : 'Non disponibile (CLI non rilevata o disabilitata)'} · {p.providerName}
            </p>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Backup</h2></div>
        <p className="muted small">Crea una copia locale dei dati (SQLite).</p>
        <button type="button" className="btn touch-target" onClick={() => void runBackup()}>Crea backup</button>
        {backupMessage && <p className="muted small">{backupMessage}</p>}
      </section>
    </div>
  );
}
