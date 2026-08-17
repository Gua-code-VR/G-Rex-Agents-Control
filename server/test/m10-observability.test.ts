import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M10 - attempt observability', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m10-'));
  let built: BuiltApp;
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake', GAC_EXECUTION_FALLBACK_RUNTIME: 'codex', GAC_EXECUTION_COST_BUDGET: '0.03' })); });
  it('exposes persisted attempt history for a session', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M10' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'observe', objectiveText: 'x', runtime: 'fake' } })).json();
    await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` });
    const response = await built.app.inject({ method: 'GET', url: `/api/sessions/${created.session.id}/execution-attempts` });
    expect(response.statusCode).toBe(200);
    expect(response.json().attempts[0]).toMatchObject({ status: 'STARTED', runtimeName: 'Fake', providerName: 'Fake' });
  });

  it('plans retry with backoff then provider fallback while keeping attempt history', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M10 retry' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'retry', objectiveText: 'x', runtime: 'fake' } })).json();
    const session = created.session;
    const first = await (built.services as any).agentSessions['supervisor'].startAttempt(session, { runtimeName: 'Cline' });
    await (built.services as any).agentSessions['supervisor'].finalizeLatestAttempt(session.id, { endedAt: new Date().toISOString(), status: 'FAILED', errorClass: 'CONNECTIVITY_ERROR' });
    const retry = (built.services as any).agentSessions['supervisor'].retryPlan(session.id, 'cline', { ...first, errorClass: 'CONNECTIVITY_ERROR' });
    expect(retry).toMatchObject({ runtime: 'cline', delayMs: 1000, fallbackOfAttemptId: null });
    const second = await (built.services as any).agentSessions['supervisor'].startAttempt(session, { runtimeName: 'Cline' });
    await (built.services as any).agentSessions['supervisor'].finalizeLatestAttempt(session.id, { endedAt: new Date().toISOString(), status: 'FAILED', errorClass: 'CONNECTIVITY_ERROR' });
    const fallback = (built.services as any).agentSessions['supervisor'].retryPlan(session.id, 'cline', { ...second, errorClass: 'CONNECTIVITY_ERROR' });
    expect(fallback).toMatchObject({ runtime: 'codex', fallbackOfAttemptId: second.id });
  });

  it('persists normalized usage and aggregates it by session', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M11 metrics' } })).json().project;
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'metrics', objectiveText: 'x', runtime: 'fake' } })).json();
    const attempt = await (built.services as any).agentSessions['supervisor'].startAttempt(created.session, { runtimeName: 'Fake' });
    await (built.services as any).agentSessions['supervisor'].completeAttempt(attempt.id, { endedAt: new Date().toISOString(), exitCode: 0, inputTokens: 12, outputTokens: 8, totalTokens: 20, costActual: 0.04 });
    const attempts = (await built.app.inject({ method: 'GET', url: `/api/sessions/${created.session.id}/execution-attempts` })).json().attempts;
    expect(attempts.find((row: { id: string }) => row.id === attempt.id)).toMatchObject({ totalTokens: 20, costActual: 0.04 });
    expect((built.services as any).agentSessions['supervisor'].totals(created.session.id)).toMatchObject({ totalTokens: 20, costActual: 0.04 });
    expect((built.services as any).agentSessions['supervisor'].exceedsBudget(created.session.id, 0)).toBe(true);
  });
});
