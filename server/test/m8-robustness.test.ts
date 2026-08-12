import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M8 robustness', () => {
  const builtApps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const directories: string[] = [];
  const makeApp = async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m8-'));
    directories.push(dataDir);
    const built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake', GAC_HEARTBEAT_INTERVAL_MS: '1000' }));
    builtApps.push(built);
    return built;
  };
  afterEach(async () => {
    await Promise.all(builtApps.splice(0).map(({ app, services }) => app.close().finally(() => services.db.close())));
    directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  });

  it('updates heartbeat, detects stale sessions and exposes an unread notification', async () => {
    const built = await makeApp();
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M8' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'Heartbeat', objectiveText: 'test' } })).json();
    const { objective, session } = created;
    expect((await built.app.inject({ method: 'POST', url: `/api/objectives/${objective.id}/sessions/${session.id}/start` })).statusCode).toBe(200);
    expect((await built.app.inject({ method: 'POST', url: `/api/objectives/${objective.id}/sessions/${session.id}/heartbeat` })).statusCode).toBe(200);
    built.services.db.prepare('UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', session.id);
    await built.services.staleDetector.check();
    const detail = (await built.app.inject({ method: 'GET', url: `/api/objectives/${objective.id}` })).json();
    expect(detail.sessions[0].status).toBe('STALE');
    expect(detail.objective.status).toBe('ERRORE');
    const notifications = (await built.app.inject({ method: 'GET', url: '/api/notifications' })).json().notifications;
    expect(notifications.some((n: { type: string }) => n.type === 'SESSION_STALE')).toBe(true);
  });

  it('recovers active sessions after restart and creates a local backup', async () => {
    const built = await makeApp();
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Recovery' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'Restart', objectiveText: 'test' } })).json();
    await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` });
    const recovery = built.services.startupRecovery.recover();
    expect(recovery.staleSessions).toBe(1);
    const backup = await built.app.inject({ method: 'POST', url: '/api/backups' });
    expect(backup.statusCode).toBe(201);
    expect(fs.existsSync(backup.json().backup.directory)).toBe(true);
    expect(backup.json().backup.files).toContain('gac.sqlite');
  });
});
