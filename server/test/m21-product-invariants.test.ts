import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M21 - invarianti di prodotto', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m21-'));
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' })); });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  async function newProject(name: string): Promise<string> {
    const res = await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json().project.id as string;
  }

  it('il progetto resta ERRORE se completa un obiettivo ma un altro è ancora aperto', async () => {
    const pid = await newProject('M21 derive');

    // Obiettivo A fallito (ERRORE, non terminale).
    const a = (await built.app.inject({ method: 'POST', url: `/api/projects/${pid}/objectives`, payload: { title: 'A', objectiveText: 'Primo obiettivo.' } })).json();
    await built.app.inject({ method: 'POST', url: `/api/objectives/${a.objective.id}/sessions/${a.session.id}/start` });
    await built.app.inject({ method: 'POST', url: `/api/objectives/${a.objective.id}/fail`, payload: { error: 'Boom' } });

    // Obiettivo B (nuovo ciclo) completato con successo.
    const b = (await built.app.inject({ method: 'POST', url: `/api/projects/${pid}/objectives`, payload: { title: 'B', objectiveText: 'Secondo obiettivo.' } })).json();
    await built.app.inject({ method: 'POST', url: `/api/objectives/${b.objective.id}/sessions/${b.session.id}/start` });
    const done = await built.app.inject({ method: 'POST', url: `/api/objectives/${b.objective.id}/complete`, payload: { report: 'Fatto.' } });
    expect(done.statusCode).toBe(200);
    expect(done.json().objective.status).toBe('COMPLETATO');

    // Lo stato progetto non è COMPLETATO: resta derivato dall'obiettivo A (ERRORE).
    expect(done.json().project.status).toBe('ERRORE');
  });

  it('il progetto torna FERMO quando l’obiettivo è completato (contenitore permanente)', async () => {
    const pid = await newProject('M21 completed');
    const o = (await built.app.inject({ method: 'POST', url: `/api/projects/${pid}/objectives`, payload: { title: 'Solo', objectiveText: 'Unico obiettivo.' } })).json();
    await built.app.inject({ method: 'POST', url: `/api/objectives/${o.objective.id}/sessions/${o.session.id}/start` });
    const done = await built.app.inject({ method: 'POST', url: `/api/objectives/${o.objective.id}/complete`, payload: { report: 'Fatto.' } });
    expect(done.json().project.status).toBe('FERMO');
  });

  it('una sessione stale tenta il recovery automatico senza creare checkpoint pendenti', async () => {
    const pid = await newProject('M21 stale-retry');
    const o = (await built.app.inject({ method: 'POST', url: `/api/projects/${pid}/objectives`, payload: { title: 'Stale', objectiveText: 'Recovery.' } })).json();
    await built.app.inject({ method: 'POST', url: `/api/objectives/${o.objective.id}/sessions/${o.session.id}/start` });
    built.services.db.prepare('UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', o.session.id);

    await built.services.staleDetector.check();

    const detail = (await built.app.inject({ method: 'GET', url: `/api/objectives/${o.objective.id}` })).json();
    // Il recovery automatico lascia la sessione attiva (retry pianificato).
    expect(detail.sessions[0].status).toBe('ATTIVA');
    // Nessun checkpoint PENDING_DECISION creato automaticamente.
    expect(detail.checkpoints.filter((c: { status: string }) => c.status === 'PENDING_DECISION')).toHaveLength(0);
    // Un job di retry è stato pianificato.
    const jobs = built.services.db.prepare('SELECT COUNT(*) AS c FROM retry_jobs WHERE session_id = ?').get(o.session.id) as { c: number };
    expect(jobs.c).toBeGreaterThan(0);
  });
});
