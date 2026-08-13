import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M14 - catalogo provider/modello e stima', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m14-'));
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake', GAC_CODEX_MODEL: 'gpt-test', GAC_CODEX_INPUT_PRICE_PER_MILLION: '2', GAC_CODEX_OUTPUT_PRICE_PER_MILLION: '8' })); });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('exposes separate runtime/provider/model metadata without provider-specific control-plane fields', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/api/provider-catalog' });
    expect(response.statusCode).toBe(200);
    const codex = response.json().catalog.find((item: { runtime: { id: string } }) => item.runtime.id === 'codex');
    expect(codex).toMatchObject({ runtime: { name: 'Codex CLI', defaultModel: 'gpt-test' }, provider: { id: 'openai-codex' }, models: [{ id: 'gpt-test', pricing: { inputPerMillion: 2, outputPerMillion: 8 } }] });
  });

  it('calculates a deterministic preflight estimate from pricing and reports unavailable pricing honestly', async () => {
    const codex = await built.app.inject({ method: 'POST', url: '/api/provider-catalog/estimate', payload: { runtimeId: 'codex', objectiveText: '12345678', stopCondition: null } });
    expect(codex.json().estimate).toMatchObject({ inputTokens: 2, outputTokens: 4000, cost: 0.032004, confidence: 'HIGH' });
    const cline = await built.app.inject({ method: 'POST', url: '/api/provider-catalog/estimate', payload: { runtimeId: 'cline', objectiveText: 'x' } });
    expect(cline.json().estimate.confidence).toBe('UNAVAILABLE');
  });

  it('feeds the catalog estimate into preventive governance when no manual estimate is supplied', async () => {
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'M14 gate' } })).json().project;
    await built.app.inject({ method: 'PUT', url: `/api/projects/${project.id}/policy`, payload: { costBudget: 0.000001, warningPercent: 80, action: 'REQUIRE_APPROVAL' } });
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/objectives`, payload: { title: 'catalog gate', objectiveText: 'x', runtime: 'fake' } })).json();
    expect((await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` })).statusCode).toBe(200);
  });
});
