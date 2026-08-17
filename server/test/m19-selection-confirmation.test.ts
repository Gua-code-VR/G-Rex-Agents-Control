import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M19 - selezione automatica, coda di esecuzione ed errori tecnici', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m19-'));
  let built: BuiltApp;
  beforeAll(async () => {
    // Un solo worker configurato (fake) per rendere deterministica la coda.
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake', GAC_CLINE_ENABLED: 'false', GAC_CODEX_ENABLED: 'false' }));
  });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  async function project(name: string): Promise<string> {
    return (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name } })).json().project.id;
  }

  it('avvia automaticamente quando un worker è disponibile e accetta un override della selezione', async () => {
    const projectId = await project('M19 confirm');
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${projectId}/objectives`, payload: { title: 't', objectiveText: 'test' } })).json();
    // Con il worker (fake) libero l'obiettivo parte subito con la selezione automatica.
    expect(created.autoStart).toEqual({ started: true });
    expect(created.session.status).toBe('ATTIVA');
    expect(created.objective.status).toBe('IN_LAVORAZIONE');
    expect(created.session.executionSelection.decision.mode).toBe('AUTOMATIC');

    // Worker ancora occupato (sessione ATTIVA di un altro progetto): il secondo
    // obiettivo resta IN_AVVIO in coda e l'avvio manuale può modificare la
    // selezione proposta (override esplicito) prima di partire.
    const secondProjectId = await project('M19 confirm 2');
    const queued = (await built.app.inject({ method: 'POST', url: `/api/projects/${secondProjectId}/objectives`, payload: { title: 'q', objectiveText: 'test' } })).json();
    expect(queued.autoStart).toEqual({ started: false });
    expect(queued.session.status).toBe('IN_AVVIO');
    expect(queued.objective.status).toBe('IN_AVVIO');
    expect(queued.session.executionSelection.decision.mode).toBe('AUTOMATIC');

    const started = await built.app.inject({ method: 'POST', url: `/api/objectives/${queued.objective.id}/sessions/${queued.session.id}/start`, payload: { runtimeId: 'fake', providerId: 'fake', modelId: 'fake' } });
    expect(started.statusCode).toBe(200);
    expect(started.json().session.status).toBe('ATTIVA');
    expect(started.json().session.executionSelection.decision.mode).toBe('EXPLICIT');
  });

  it('traduce un errore CLI grezzo e separa i dettagli tecnici', async () => {
    const projectId = await project('M19 error');
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${projectId}/objectives`, payload: { title: 't', objectiveText: 'test', runtime: 'fake', providerId: 'fake', modelId: 'fake' } })).json();
    await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` });
    const failed = await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/fail`, payload: { error: "error: the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'" } });
    const checkpoint = failed.json().checkpoint;
    expect(checkpoint.outcome).toBe('ERROR');
    expect(checkpoint.summary).not.toContain('--sandbox');
    expect(checkpoint.summary).toContain('compatibile');
    expect(checkpoint.technicalDetails).toContain('--sandbox');
    expect(checkpoint.recommendedAction).toContain('Riprova');
  });

  it('riprova un obiettivo in errore con una nuova sessione avviata', async () => {
    const projectId = await project('M19 retry');
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${projectId}/objectives`, payload: { title: 't', objectiveText: 'test', runtime: 'fake', providerId: 'fake', modelId: 'fake' } })).json();
    await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` });
    await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/fail`, payload: { error: 'boom' } });

    const retried = await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/retry` });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().session.status).toBe('ATTIVA');
    expect(retried.json().objective.status).toBe('IN_LAVORAZIONE');
  });
});
