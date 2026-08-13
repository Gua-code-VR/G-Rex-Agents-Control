import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M13 - enforcement governato', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m13-'));
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake' })); });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('blocks an estimated run pending explicit approval, then permits it with auditable exception', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M13 preflight' } })).json().project;
    await built.app.inject({ method: 'PUT', url: `/api/projects/${project.id}/policy`, payload: { costBudget: 1, warningPercent: 80, action: 'REQUIRE_APPROVAL' } });
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'gated', objectiveText: 'x', runtime: 'fake', estimatedCost: 1.2 } })).json();
    expect((await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` })).statusCode).toBe(400);
    const approvals = (await built.app.inject({ method: 'GET', url: `/api/governance/approvals?objectiveId=${created.objective.id}` })).json().approvals;
    expect(approvals[0]).toMatchObject({ status: 'PENDING', projectedCost: 1.2 });
    expect((await built.app.inject({ method: 'POST', url: `/api/governance/approvals/${approvals[0].id}/decide`, payload: { approve: true, note: 'necessario' } })).json().approval.status).toBe('APPROVED');
    expect((await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` })).statusCode).toBe(200);
    const exceptions = (await built.app.inject({ method: 'GET', url: `/api/objectives/${created.objective.id}/governance/exceptions` })).json().exceptions;
    expect((await built.app.inject({ method: 'POST', url: `/api/governance/exceptions/${exceptions[0].id}/revoke` })).statusCode).toBe(200);
    const events = (await built.app.inject({ method: 'GET', url: `/api/events?objectiveId=${created.objective.id}&limit=30` })).json().events.map((event: { type: string }) => event.type);
    expect(events).toEqual(expect.arrayContaining(['governance.approval.requested', 'governance.approval.approved', 'governance.exception.authorized', 'governance.exception.revoked']));
  });

  it('exposes a cross-project governance portfolio', async () => {
    const result = await built.app.inject({ method: 'GET', url: '/api/governance/portfolio' });
    expect(result.statusCode).toBe(200);
    expect(result.json().projects.some((item: { project: { name: string } }) => item.project.name === 'M13 preflight')).toBe(true);
  });
});
