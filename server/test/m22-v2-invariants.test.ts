import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * M22 — Invarianti di prodotto V2 (§23): test di regressione sui flussi
 * lifecycle/Control Room riallineati alla specifica V2.
 */
describe('M22 - invarianti di prodotto V2', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m22-'));
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }));
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function newProject(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name, ...extra } });
    expect(res.statusCode).toBe(201);
    return res.json().project.id as string;
  }

  async function newObjective(projectId: string, title: string): Promise<{ objectiveId: string; sessionId: string }> {
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: { title, objectiveText: `Obiettivo di test: ${title}.` },
    });
    expect(res.statusCode).toBe(201);
    return { objectiveId: res.json().objective.id, sessionId: res.json().session.id };
  }

  async function start(objectiveId: string, sessionId: string): Promise<void> {
    const res = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start` });
    expect(res.statusCode).toBe(200);
  }

  async function pendingDecisions(): Promise<number> {
    const res = await built.app.inject({ method: 'GET', url: '/api/status' });
    return res.json().pendingDecisions as number;
  }

  it("un completamento riuscito produce un risultato, non un'approvazione (§4.1)", async () => {
    const pid = await newProject('m22-complete');
    const { objectiveId, sessionId } = await newObjective(pid, 'Completa');
    await start(objectiveId, sessionId);

    const done = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/complete`, payload: { report: 'Fatto.' } });
    expect(done.statusCode).toBe(200);
    expect(done.json().objective.status).toBe('COMPLETATO');
    expect(done.json().objective.finalReport).toBe('Fatto.');
    expect(done.json().checkpoint).toBeNull();
    const detail = (await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` })).json();
    expect(detail.checkpoints.filter((c: { status: string }) => c.status === 'PENDING_DECISION')).toHaveLength(0);
  });

  it('una notifica informativa (completamento) non alimenta Richiede te (§5.2)', async () => {
    const before = await pendingDecisions();
    const pid = await newProject('m22-notify');
    const { objectiveId, sessionId } = await newObjective(pid, 'Notifica info');
    await start(objectiveId, sessionId);
    await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/complete`, payload: { report: 'Fatto.' } });
    expect(await pendingDecisions()).toBe(before);
  });

  it("l'`unread` da solo non implica intervento umano (§21.8)", async () => {
    const pid = await newProject('m22-unread');
    const { objectiveId, sessionId } = await newObjective(pid, 'Unread');
    await start(objectiveId, sessionId);
    await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/complete`, payload: { report: 'Fatto.' } });

    const notifications = (await built.app.inject({ method: 'GET', url: '/api/notifications' })).json().notifications as unknown[];
    expect(notifications.length).toBeGreaterThan(0);
    expect(await pendingDecisions()).toBe(0);
  });

  it('Riavvia preserva lo storico, crea una nuova esecuzione e non lascia errori correnti', async () => {
    const pid = await newProject('m22-recovered');
    const { objectiveId, sessionId } = await newObjective(pid, 'Recover');
    await start(objectiveId, sessionId);
    await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/fail`, payload: { error: 'Boom' } });
    expect(await pendingDecisions()).toBeGreaterThanOrEqual(1);

    const retry = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/retry`, payload: {} });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().objective.status).toBe('IN_LAVORAZIONE');
    expect(await pendingDecisions()).toBe(0);

    const detail = (await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` })).json();
    expect(detail.sessions.length).toBeGreaterThanOrEqual(2);
    expect(detail.checkpoints.filter((c: { status: string }) => c.status === 'PENDING_DECISION')).toHaveLength(0);
  });
  it("Cancella chiude i checkpoint pendenti e preserva l'audit", async () => {
    const pid = await newProject('m22-cancel');
    const { objectiveId, sessionId } = await newObjective(pid, 'Cancel');
    await start(objectiveId, sessionId);
    await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/fail`, payload: { error: 'Boom' } });
    expect(await pendingDecisions()).toBeGreaterThanOrEqual(1);

    const cancel = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().objective.status).toBe('ANNULLATO');
    expect(await pendingDecisions()).toBe(0);

    const events = (await built.app.inject({ method: 'GET', url: '/api/events?limit=200' })).json().events.map((e: { type: string }) => e.type);
    expect(events).toContain('checkpoint.created');
    expect(events).toContain('decision.made');
  });

  it('Project mantiene il repository tra un Objective e il successivo (§2.1)', async () => {
    const pid = await newProject('m22-repo', { repositoryPath: 'C:/repos/demo' });
    const { objectiveId, sessionId } = await newObjective(pid, 'Primo');
    await start(objectiveId, sessionId);
    await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/complete`, payload: { report: 'Fatto.' } });

    const project = (await built.app.inject({ method: 'GET', url: `/api/projects/${pid}` })).json().project;
    expect(project.repositoryPath).toBe('C:/repos/demo');
    expect(project.status).toBe('FERMO');

    const again = await built.app.inject({ method: 'POST', url: `/api/projects/${pid}/objectives`, payload: { title: 'Secondo', objectiveText: 'Secondo ciclo.' } });
    expect(again.statusCode).toBe(201);
  });

  it('progetto senza obiettivo iniziale resta FERMO senza obiettivo', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'm22-empty' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().project.status).toBe('FERMO');
    const objectives = (await built.app.inject({ method: 'GET', url: `/api/projects/${res.json().project.id}/objectives` })).json().objectives;
    expect(objectives).toHaveLength(0);
  });

  it("progetto con obiettivo iniziale crea e avvia l'Objective (§11.2)", async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'm22-init', currentObjective: 'Obiettivo iniziale da avviare subito.' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.initialObjective).toBeTruthy();
    expect(body.initialObjective.objective.status).toBe('IN_LAVORAZIONE');
    expect(body.initialObjective.autoStart.started).toBe(true);
  });

  it('objectiveText accetta correttamente fino a 50.000 caratteri (§2.2)', async () => {
    const pid = await newProject('m22-longtext');
    const ok = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/objectives`,
      payload: { title: 'Lungo', objectiveText: 'a'.repeat(50000) },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().objective.objectiveText.length).toBe(50000);

    const reject = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/objectives`,
      payload: { title: 'Troppo', objectiveText: 'b'.repeat(50001) },
    });
    expect(reject.statusCode).toBe(400);
  });

  it('bootstrap non produce falsi errori: riavvio su dati sani, nessun pending né errore', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m22-persist-'));
    const first = await buildApp(loadConfig({ GAC_DATA_DIR: persistDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }));
    const p = await first.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'persist' } });
    const pid = p.json().project.id as string;
    const o = await first.app.inject({ method: 'POST', url: `/api/projects/${pid}/objectives`, payload: { title: 'X', objectiveText: 'Y' } });
    await first.app.inject({ method: 'POST', url: `/api/objectives/${o.json().objective.id}/sessions/${o.json().session.id}/start` });
    await first.app.inject({ method: 'POST', url: `/api/objectives/${o.json().objective.id}/complete`, payload: { report: 'Fatto.' } });
    await first.app.close();
    first.services.db.close();

    const second = await buildApp(loadConfig({ GAC_DATA_DIR: persistDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }));
    try {
      const status = (await second.app.inject({ method: 'GET', url: '/api/status' })).json();
      expect(status.pendingDecisions).toBe(0);
      const objectives = (await second.app.inject({ method: 'GET', url: `/api/projects/${pid}/objectives` })).json().objectives;
      expect(objectives.filter((o: { status: string }) => o.status === 'ERRORE')).toHaveLength(0);
    } finally {
      await second.app.close();
      second.services.db.close();
      fs.rmSync(persistDir, { recursive: true, force: true });
    }
  });
});
