import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M1 - health e stato dashboard', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-health-'));
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp(
      loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
    );
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
  });

  it('GET /api/health risponde ok con i metadati di servizio', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('g-rex-agent-control');
    expect(body.version).toBe('0.4.0');
    expect(body.schemaVersion).toBe(8);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.timestamp).toBe('string');
  });

  it('GET /api/status espone il riepilogo per la dashboard', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projectsCount).toBe(0);
    expect(body.projectsByStatus.FERMO).toBe(0);
    expect(body.projectsByGroup.FERMO).toBe(0);
    expect(body.projectsByGroup.IN_LAVORAZIONE).toBe(0);
    expect(body.projectsByGroup.PROBLEMA).toBe(0);
    expect(body.eventsCount).toBeGreaterThanOrEqual(0);
    // M4: nessuna decisione umana pendente su un database vuoto.
    expect(body.pendingDecisions).toBe(0);
    expect(body.storage.dbPath).toContain(dataDir);
    expect(body.storage.exists).toBe(true);
    expect(typeof body.generatedAt).toBe('string');
  });

  it('GET /api/events restituisce una lista', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/events?limit=5' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().events)).toBe(true);
  });

  it('GET /api/events filtra gli eventi per progetto e obiettivo', async () => {
    const project = built.services.projects.register({
      name: 'history-filter',
    });

    const created = await built.services.objectives.create(project.id, {
      title: 'Storico obiettivo',
      objectiveText: 'Test filtri eventi',
    });
    const objectiveId = created.objective.id;

    const res = await built.app.inject({
      method: 'GET',
      url: `/api/events?limit=20&projectId=${encodeURIComponent(project.id)}&objectiveId=${encodeURIComponent(objectiveId)}`,
    });

    expect(res.statusCode).toBe(200);
    const events = res.json().events as Array<{ projectId: string | null; objectiveId: string | null }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((event) => event.projectId === project.id && event.objectiveId === objectiveId)).toBe(true);
  });

  it('GET /api/events filtra gli eventi per sessione', async () => {
    const project = built.services.projects.register({
      name: 'history-session-filter',
    });

    const created = await built.services.objectives.create(project.id, {
      title: 'Storico sessione',
      objectiveText: 'Test filtro sessione',
    });
    const objectiveId = created.objective.id;
    const sessionId = created.session.id;

    await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });

    const res = await built.app.inject({
      method: 'GET',
      url: `/api/events?limit=20&projectId=${encodeURIComponent(project.id)}&objectiveId=${encodeURIComponent(objectiveId)}&sessionId=${encodeURIComponent(sessionId)}`,
    });

    expect(res.statusCode).toBe(200);
    const events = res.json().events as Array<{ projectId: string | null; objectiveId: string | null; sessionId: string | null }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((event) => event.projectId === project.id && event.objectiveId === objectiveId && event.sessionId === sessionId)).toBe(true);
  });
});
