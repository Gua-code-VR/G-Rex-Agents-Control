import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M15 - selezione runtime/provider/modello', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m15-'));
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake' })); });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('persists the validated explicit selection and exposes it in attempt history', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M15 selection' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'selection', objectiveText: 'test', runtime: 'fake', providerId: 'fake', modelId: 'fake', outputTokenLimit: 1 } })).json();
    expect(created.session.executionSelection).toMatchObject({ runtimeId: 'fake', providerId: 'fake', modelId: 'fake', outputTokenLimit: 1, decision: { mode: 'EXPLICIT' } });
    await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` });
    const attempts = (await built.app.inject({ method: 'GET', url: `/api/sessions/${created.session.id}/execution-attempts` })).json().attempts;
    expect(attempts[0]).toMatchObject({ runtimeName: 'Fake', providerName: 'Fake', modelName: 'fake', metadata: { selection: { runtimeId: 'fake', providerId: 'fake', modelId: 'fake', outputTokenLimit: 1 } } });
  });

  it('rejects incompatible provider/model combinations with an actionable reason', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M15 invalid' } })).json().project;
    const response = await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'invalid', objectiveText: 'test', runtime: 'fake', providerId: 'openai-codex' } });
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain('non compatibile');
  });

  it('revalidates the persisted selection before a retry attempt', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M15 retry' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'retry', objectiveText: 'test', runtime: 'fake', providerId: 'fake', modelId: 'fake' } })).json();
    await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` });
    await (built.services.agentSessions as any).startRetryAttempt(created.objective.id, created.session.id, 'fake', null);
    const attempts = (await built.app.inject({ method: 'GET', url: `/api/sessions/${created.session.id}/execution-attempts` })).json().attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[1].metadata).toMatchObject({ selection: { runtimeId: 'fake', providerId: 'fake', modelId: 'fake' }, selectionReason: 'Retry della selezione validata' });
  });
});
