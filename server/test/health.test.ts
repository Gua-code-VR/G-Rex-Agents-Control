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
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent' }));
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
    expect(body.version).toBe('0.3.0');
    expect(body.schemaVersion).toBe(3);
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
    expect(body.storage.dbPath).toContain(dataDir);
    expect(body.storage.exists).toBe(true);
    expect(typeof body.generatedAt).toBe('string');
  });

  it('GET /api/events restituisce una lista', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/events?limit=5' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().events)).toBe(true);
  });
});