import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { RuntimeSelectionService } from '../src/application/runtime-selection-service.js';
import { ProviderCatalogService } from '../src/application/provider-catalog-service.js';
import { SqliteExecutionAttemptRepository } from '../src/infrastructure/db/execution-attempt-repo.js';
import { ExecutionProviderRegistry, type ExecutionProvider, type ProviderCatalogEntry } from '../src/integrations/execution-provider.js';
import { loadConfig } from '../src/config.js';

function provider(id: string, options: { available?: boolean; capabilities?: string[]; price?: number } = {}): ExecutionProvider {
  const price = options.price ?? 1;
  const entry: ProviderCatalogEntry = {
    runtime: { id, name: id, type: 'cli', available: options.available ?? true, defaultModel: `${id}-model`, capabilities: options.capabilities ?? ['workspace-edit'], version: '1' },
    provider: { id: `${id}-provider`, name: `${id}-provider` },
    models: [{ id: `${id}-model`, name: `${id}-model`, version: '1', capabilities: ['code'], limits: { contextTokens: 100_000, defaultOutputTokens: 1000 }, pricing: { inputPerMillion: price, outputPerMillion: price, currency: 'USD' } }],
  };
  return {
    descriptor: { id, runtimeType: 'cli', runtimeName: id, providerName: `${id}-provider`, defaultModel: `${id}-model` },
    isConfigured: () => entry.runtime.available,
    catalog: () => entry,
    start: async () => { throw new Error('not used'); }, stop: async () => undefined, touchHeartbeat: async () => undefined,
  };
}

describe('M16 - selezione automatica runtime/provider/modello', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m16-'));
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake' })); });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  async function project(name: string): Promise<string> {
    return (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name } })).json().project.id;
  }

  it('excludes unavailable and capability-incompatible combinations and records every reason', async () => {
    const projectId = await project('M16 eligibility');
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([
      provider('unavailable', { available: false }), provider('incapable', { capabilities: ['streaming'] }), provider('eligible'),
    ]));
    const selection = new RuntimeSelectionService(catalog, built.services.db).select({ projectId, objectiveText: 'code', stopCondition: null, defaultRuntime: 'eligible' });
    expect(selection.runtimeId).toBe('eligible');
    expect(selection.decision).toMatchObject({ mode: 'AUTOMATIC', requiredCapabilities: ['code', 'workspace-edit'] });
    expect(selection.decision?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtimeId: 'unavailable', eligible: false }),
      expect.objectContaining({ runtimeId: 'incapable', eligible: false }),
      expect.objectContaining({ runtimeId: 'eligible', eligible: true }),
    ]));
  });

  it('prefers lower cost at equal reliability and respects a restrictive remaining budget', async () => {
    const projectId = await project('M16 cost');
    await built.app.inject({ method: 'PUT', url: `/api/projects/${projectId}/policy`, payload: { costBudget: 0.002, warningPercent: 80, action: 'HARD_STOP' } });
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([provider('cheap', { price: 1 }), provider('expensive', { price: 10 })]));
    const selection = new RuntimeSelectionService(catalog, built.services.db).select({ projectId, objectiveText: 'x', stopCondition: null, defaultRuntime: 'cheap' });
    expect(selection.runtimeId).toBe('cheap');
    expect(selection.decision?.candidates.find((candidate) => candidate.runtimeId === 'expensive')).toMatchObject({ eligible: false, budgetFit: false });
  });

  it('uses persisted execution outcomes as a reliability signal', async () => {
    const projectId = await project('M16 reliability');
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${projectId}/objectives`, payload: { title: 'seed', objectiveText: 'seed', runtime: 'fake' } })).json();
    const attempts = new SqliteExecutionAttemptRepository(built.services.db);
    for (let index = 1; index <= 8; index += 1) {
      const cheap = attempts.create(created.session.id, { attemptIndex: index, runtimeName: 'cheap', providerName: 'cheap-provider', modelName: 'cheap-model' });
      attempts.update(cheap.id, { endedAt: new Date().toISOString(), status: 'FAILED' });
      const reliable = attempts.create(created.session.id, { attemptIndex: index + 8, runtimeName: 'reliable', providerName: 'reliable-provider', modelName: 'reliable-model' });
      attempts.update(reliable.id, { endedAt: new Date().toISOString(), status: 'COMPLETED' });
    }
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([provider('cheap', { price: 1 }), provider('reliable', { price: 2 })]));
    const selection = new RuntimeSelectionService(catalog, built.services.db).select({ projectId, objectiveText: 'x', stopCondition: null, defaultRuntime: 'cheap' });
    expect(selection.runtimeId).toBe('reliable');
    expect(selection.decision?.reason).toContain('affidabilità');
  });

  it('keeps over-budget candidates eligible only when policy action is WARN', async () => {
    const projectId = await project('M16 warning policy');
    await built.app.inject({ method: 'PUT', url: `/api/projects/${projectId}/policy`, payload: { costBudget: 0.000001, warningPercent: 80, action: 'WARN' } });
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([provider('warned', { price: 10 })]));
    const selection = new RuntimeSelectionService(catalog, built.services.db).select({ projectId, objectiveText: 'x', stopCondition: null, defaultRuntime: 'warned' });
    expect(selection.runtimeId).toBe('warned');
    expect(selection.decision?.candidates[0]).toMatchObject({ eligible: true, budgetFit: false });
  });

  it('persists and exposes an automatic decision when no explicit runtime is supplied', async () => {
    const projectId = await project('M16 integration');
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${projectId}/objectives`, payload: { title: 'automatic', objectiveText: 'test' } })).json();
    expect(created.session.executionSelection).toMatchObject({ runtimeId: 'fake', decision: { mode: 'AUTOMATIC', reason: expect.stringContaining('Scelta automatica') } });
    await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` });
    const attempts = (await built.app.inject({ method: 'GET', url: `/api/sessions/${created.session.id}/execution-attempts` })).json().attempts;
    expect(attempts[0].metadata).toMatchObject({
      selection: { decision: { mode: 'AUTOMATIC', reason: expect.stringContaining('Scelta automatica') } },
      selectionReason: expect.stringContaining('Scelta automatica'),
    });
  });
});
