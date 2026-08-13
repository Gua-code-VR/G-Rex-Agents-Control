import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M12 - policy e governance per progetto/obiettivo', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m12-'));
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake' })); });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('persists inherited policies and exposes provider/model, trend and budget aggregates', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M12 governance' } })).json().project;
    expect((await built.app.inject({ method: 'PUT', url: `/api/projects/${project.id}/policy`, payload: { costBudget: 1, warningPercent: 75, action: 'HARD_STOP' } })).statusCode).toBe(200);
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'Policy', objectiveText: 'x', runtime: 'fake' } })).json();
    const attempt = await (built.services as any).agentSessions.supervisor.startAttempt(created.session, { providerName: 'Codex', modelName: 'gpt-5', runtimeName: 'Codex' });
    await (built.services as any).agentSessions.supervisor.completeAttempt(attempt.id, { endedAt: new Date().toISOString(), exitCode: 0, totalTokens: 42, costActual: 0.8 });
    const dashboard = (await built.app.inject({ method: 'GET', url: `/api/projects/${project.id}/governance` })).json().governance;
    expect(dashboard).toMatchObject({ budget: { used: 0.8, remaining: 0.2 }, totals: { totalTokens: 42 } });
    expect(dashboard.breakdown[0]).toMatchObject({ providerName: 'Codex', modelName: 'gpt-5', cost: 0.8 });
    expect(dashboard.trend).toHaveLength(1);
    expect(dashboard.objectives[0].policy).toBeNull();
    const policyEvent = (await built.app.inject({ method: 'GET', url: `/api/events?projectId=${project.id}&limit=20` })).json().events.find((event: { type: string }) => event.type === 'governance.policy.updated');
    expect(policyEvent.payload).toMatchObject({ previousPolicy: null, policy: { action: 'HARD_STOP' } });
    expect((built.services as any).governance.evaluate(created.objective.id, 1.01).decision).toBe('HARD_STOP');
  });

  it('supports objective override, approval policy, authorized exception and audit events', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M12 exception' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'Override', objectiveText: 'x', runtime: 'fake' } })).json();
    await built.app.inject({ method: 'PUT', url: `/api/objectives/${created.objective.id}/policy`, payload: { costBudget: 0.1, warningPercent: 50, action: 'REQUIRE_APPROVAL' } });
    expect((built.services as any).governance.evaluate(created.objective.id, 0.11).decision).toBe('REQUIRE_APPROVAL');
    const exception = await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/governance/exceptions`, payload: { note: 'approvata per demo' } });
    expect(exception.statusCode).toBe(201);
    expect((built.services as any).governance.evaluate(created.objective.id, 2).decision).toBe('ALLOW');
    const events = (await built.app.inject({ method: 'GET', url: `/api/events?objectiveId=${created.objective.id}&limit=20` })).json().events.map((event: { type: string }) => event.type);
    expect(events).toContain('governance.policy.updated');
    expect(events).toContain('governance.exception.authorized');
  });
});
