import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M18 - worker persistente e retry recuperabile', () => {
  const apps: BuiltApp[] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m18-'));
  const makeApp = async () => {
    const built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }));
    apps.push(built);
    return built;
  };
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async ({ app, services }) => { services.retryWorker.stop(); await app.close(); services.db.close(); }));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('persiste un retry e lo esegue dopo il riavvio del Control Plane', async () => {
    const first = await makeApp();
    const project = (await first.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M18' } })).json().project;
    const created = (await first.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'Retry persistente', objectiveText: 'test' } })).json();
    await first.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` });
    const job = first.services.retryWorker.schedule(created.session.id, 'fake', null, 0);
    expect(first.services.db.prepare('SELECT status FROM retry_jobs WHERE id=?').get(job.id)).toMatchObject({ status: 'PENDING' });
    await first.app.close(); first.services.db.close(); apps.splice(apps.indexOf(first), 1);

    const restarted = await makeApp();
    await restarted.services.retryWorker.runDue();
    expect(restarted.services.db.prepare('SELECT status FROM retry_jobs WHERE id=?').get(job.id)).toMatchObject({ status: 'COMPLETED' });
    expect(restarted.services.db.prepare('SELECT count(*) count FROM execution_attempts WHERE session_id=?').get(created.session.id)).toMatchObject({ count: 2 });
  });
});
