import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('heartbeat lifecycle regression', () => {
  const apps: BuiltApp[] = []; const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async ({ app, services }) => { await app.close(); services.db.close(); }));
    directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  });

  it('does not mark an unstarted Cline session STALE before any process or heartbeat can exist', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-cline-heartbeat-')); directories.push(dataDir);
    const built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' })); apps.push(built);
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Heartbeat lifecycle' } })).json().project;
    const created = await built.services.objectives.create(project.id, { title: 'Fase 1 UI', objectiveText: 'test' });
    built.services.db.prepare('UPDATE sessions SET agent_type=?, last_heartbeat_at=? WHERE id=?').run('cline', '2000-01-01T00:00:00.000Z', created.session.id);
    expect(await built.services.staleDetector.check()).toBe(0);
    expect(built.services.db.prepare('SELECT status FROM sessions WHERE id=?').get(created.session.id)).toMatchObject({ status: 'IN_AVVIO' });
    expect(built.services.db.prepare('SELECT count(*) count FROM execution_attempts WHERE session_id=?').get(created.session.id)).toMatchObject({ count: 0 });
  });
});
