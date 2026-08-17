import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * M24 — Coda di esecuzione: un obiettivo «In attesa di avvio» (IN_AVVIO)
 * parte automaticamente quando esiste almeno un worker disponibile
 * (provider configurato non impegnato da una sessione ATTIVA). La coda è
 * FIFO e si svuota sia alla creazione sia quando un worker si libera,
 * incluso dopo il riavvio del Control Plane.
 */
describe('M24 - coda di esecuzione', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m24-'));
  let built: BuiltApp;

  beforeAll(async () => {
    // Un solo worker configurato (fake): rende deterministica la coda.
    built = await buildApp(loadConfig({
      GAC_DATA_DIR: dataDir,
      GAC_LOG_LEVEL: 'silent',
      GAC_DEFAULT_RUNTIME: 'fake',
      GAC_CLINE_ENABLED: 'false',
      GAC_CODEX_ENABLED: 'false',
    }));
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function project(name: string): Promise<string> {
    const res = await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json().project.id as string;
  }

  async function objective(projectId: string, title: string): Promise<{
    objective: { id: string; status: string };
    session: { id: string; status: string };
    autoStart: { started: boolean };
  }> {
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: { title, objectiveText: `Obiettivo: ${title}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('avvia subito quando un worker è libero e mette in coda quando è occupato', async () => {
    const p1 = await project('M24 coda A');
    const first = await objective(p1, 'Primo');
    expect(first.autoStart).toEqual({ started: true });
    expect(first.session.status).toBe('ATTIVA');
    expect(first.objective.status).toBe('IN_LAVORAZIONE');

    // L'unico worker (fake) è occupato: il secondo obiettivo resta in coda.
    const p2 = await project('M24 coda B');
    const second = await objective(p2, 'Secondo');
    expect(second.autoStart).toEqual({ started: false });
    expect(second.session.status).toBe('IN_AVVIO');
    expect(second.objective.status).toBe('IN_AVVIO');

    // Con il worker occupato la coda non può svuotarsi.
    expect(await built.services.queueWorker.drain()).toBe(0);

    // Completando il primo obiettivo il worker si libera: la coda avvia il secondo.
    const done = await built.app.inject({ method: 'POST', url: `/api/objectives/${first.objective.id}/complete`, payload: { report: 'Fatto.' } });
    expect(done.statusCode).toBe(200);
    expect(await built.services.queueWorker.drain()).toBe(1);

    const detail = (await built.app.inject({ method: 'GET', url: `/api/objectives/${second.objective.id}` })).json();
    expect(detail.objective.status).toBe('IN_LAVORAZIONE');
    expect(detail.sessions[0].status).toBe('ATTIVA');
  });

  it('availableSlots riflette la capacità residua', async () => {
    // Una sessione ATTIVA ancora in corso e un solo worker configurato.
    expect(built.services.queueWorker.availableSlots()).toBe(0);
  });

  it('avvia dopo il riavvio gli obiettivi rimasti in coda', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m24-persist-'));
    const config = {
      GAC_DATA_DIR: persistDir,
      GAC_LOG_LEVEL: 'silent',
      GAC_DEFAULT_RUNTIME: 'fake',
      GAC_CLINE_ENABLED: 'false',
      GAC_CODEX_ENABLED: 'false',
      // Retry disattivato: il riavvio marca STALE la sessione ATTIVA (processo
      // non vivo), il worker si libera e la coda avvia l'obiettivo IN_AVVIO.
      GAC_EXECUTION_RETRY_MAX: '0',
    };
    const first = await buildApp(loadConfig(config));
    let queuedObjectiveId = '';
    try {
      const p1 = (await first.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'q1' } })).json().project.id as string;
      const a = await first.app.inject({ method: 'POST', url: `/api/projects/${p1}/objectives`, payload: { title: 'A', objectiveText: 'A' } });
      expect(a.json().autoStart.started).toBe(true);

      const p2 = (await first.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'q2' } })).json().project.id as string;
      const b = await first.app.inject({ method: 'POST', url: `/api/projects/${p2}/objectives`, payload: { title: 'B', objectiveText: 'B' } });
      expect(b.json().autoStart.started).toBe(false);
      queuedObjectiveId = b.json().objective.id as string;
    } finally {
      await first.app.close();
      first.services.db.close();
    }

    const second = await buildApp(loadConfig(config));
    try {
      // Il riavvio marca STALE la sessione ATTIVA (processo non vivo): il worker
      // si libera e la coda avvia l'obiettivo rimasto IN_AVVIO.
      await second.services.startupRecovery.recover();
      expect(await second.services.queueWorker.drain()).toBe(1);
      const detail = (await second.app.inject({ method: 'GET', url: `/api/objectives/${queuedObjectiveId}` })).json();
      expect(detail.objective.status).toBe('IN_LAVORAZIONE');
      expect(detail.sessions[0].status).toBe('ATTIVA');
    } finally {
      await second.app.close();
      second.services.db.close();
      fs.rmSync(persistDir, { recursive: true, force: true });
    }
  });
});
