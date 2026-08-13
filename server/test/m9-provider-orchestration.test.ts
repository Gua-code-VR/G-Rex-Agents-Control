import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M9 - execution provider orchestration', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m9-'));
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake' }));
  });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('publishes interchangeable registered runtimes', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/api/execution-providers' });
    expect(response.statusCode).toBe(200);
    const ids = response.json().providers.map((provider: { id: string }) => provider.id);
    expect(ids).toEqual(expect.arrayContaining(['fake', 'cline', 'codex']));
  });

  it('selects the runtime on the session and persists normalized attempt metadata', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M9' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'Provider', objectiveText: 'test', runtime: 'fake' } })).json();
    expect(created.session.agentType).toBe('fake');
    expect((await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` })).statusCode).toBe(200);
    const attempt = built.services.db.prepare('SELECT runtime_name, provider_name, process_reference FROM execution_attempts WHERE session_id = ?').get(created.session.id) as { runtime_name: string; provider_name: string; process_reference: string };
    expect(attempt).toMatchObject({ runtime_name: 'Fake', provider_name: 'Fake' });
    expect(attempt.process_reference).toMatch(/^fake-/);
  });
});
