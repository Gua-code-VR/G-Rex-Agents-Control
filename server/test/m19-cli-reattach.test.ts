import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M19 - reattach supervisione CLI', () => {
  const apps: BuiltApp[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async ({ app, services }) => { await app.close(); services.db.close(); }));
    dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it('mantiene attiva una sessione CLI quando il PID persistito è ancora vivo', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m19-')); dirs.push(dataDir);
    const built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake', GAC_CLINE_ENABLED: 'false' })); apps.push(built);
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M19' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'Reattach', objectiveText: 'test' } })).json();
    const reference = `cline:${process.pid}:${Date.now()}`;
    built.services.db.prepare("UPDATE sessions SET status='ATTIVA', agent_type='cline', process_reference=?, last_heartbeat_at=? WHERE id=?").run(reference, '2000-01-01T00:00:00.000Z', created.session.id);
    const recovery = await built.services.startupRecovery.recover();
    expect(recovery.staleSessions).toBe(0);
    expect(built.services.db.prepare('SELECT status, last_heartbeat_at FROM sessions WHERE id=?').get(created.session.id)).toMatchObject({ status: 'ATTIVA' });
    await built.services.staleDetector.check();
    expect(built.services.db.prepare("SELECT count(*) count FROM events WHERE type='session.reattached'").get()).toMatchObject({ count: expect.any(Number) });
  });
});
