import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { ProviderCatalogService } from '../src/application/provider-catalog-service.js';
import { RuntimeSelectionService } from '../src/application/runtime-selection-service.js';
import { ExecutionProviderRegistry, type ExecutionProvider, type ProviderCatalogEntry } from '../src/integrations/execution-provider.js';
import { loadConfig } from '../src/config.js';

function provider(id: string): ExecutionProvider {
  const entry: ProviderCatalogEntry = {
    runtime: { id, name: id, type: 'cli', available: true, defaultModel: `${id}-model`, capabilities: ['workspace-edit'], version: '1' },
    provider: { id: `${id}-provider`, name: `${id}-provider` },
    models: [{ id: `${id}-model`, name: `${id}-model`, version: '1', capabilities: ['code'], limits: { contextTokens: 100_000, defaultOutputTokens: 1000 }, pricing: { inputPerMillion: 1, outputPerMillion: 1, currency: 'USD' } }],
  };
  return {
    descriptor: { id, runtimeType: 'cli', runtimeName: id, providerName: `${id}-provider`, defaultModel: `${id}-model` },
    isConfigured: () => true, catalog: () => [entry],
    start: async () => { throw new Error('not used'); }, stop: async () => undefined, touchHeartbeat: async () => undefined,
  };
}

describe('M17 - adaptive routing and performance learning', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m17-'));
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake' })); });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  async function project(name: string): Promise<string> {
    return (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name } })).json().project.id;
  }

  function seed(projectId: string, runtime: string, objectiveText: string, outcome: 'GOOD' | 'POOR', index: number): void {
    const objectiveId = `${runtime}-${outcome}-objective-${index}`;
    const sessionId = `${runtime}-${outcome}-session-${index}`;
    const attemptId = `${runtime}-${outcome}-attempt-${index}`;
    const checkpointId = `${runtime}-${outcome}-checkpoint-${index}`;
    const providerName = runtime === 'Fake' ? 'Fake' : `${runtime}-provider`;
    const modelName = runtime === 'Fake' ? 'fake' : `${runtime}-model`;
    const now = new Date(1_700_000_000_000 + index * 1000).toISOString();
    built.services.db.prepare(`INSERT INTO objectives
      (id, project_id, title, objective_text, invariants, acceptance_criteria, stop_condition, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, '[]', '[]', NULL, ?, ?, ?)`).run(objectiveId, projectId, objectiveId, objectiveText, outcome === 'GOOD' ? 'COMPLETATO' : 'ERRORE', now, now);
    built.services.db.prepare(`INSERT INTO sessions
      (id, objective_id, agent_type, started_at, ended_at, status, heartbeat_interval_ms)
      VALUES (?, ?, ?, ?, ?, ?, 30000)`).run(sessionId, objectiveId, runtime, now, now, outcome === 'GOOD' ? 'COMPLETATA' : 'ERRORE');
    built.services.db.prepare(`INSERT INTO execution_attempts
      (id, session_id, attempt_index, runtime_type, runtime_name, provider_name, model_name, status, started_at, ended_at, duration_ms, fallback_of_attempt_id, cost_actual)
      VALUES (?, ?, ?, 'cli', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(attemptId, sessionId, outcome === 'GOOD' ? 1 : 2, runtime, providerName, modelName, outcome === 'GOOD' ? 'COMPLETED' : 'FAILED', now, now, outcome === 'GOOD' ? 10_000 : 600_000, outcome === 'GOOD' ? null : `${attemptId}-primary`, outcome === 'GOOD' ? 0.01 : 0.2);
    built.services.db.prepare(`INSERT INTO checkpoints
      (id, project_id, objective_id, session_id, outcome, status, summary, acceptance_status, evidence_summary, tests_summary, warnings, recommended_action, evidence_sources, created_at, decided_at, decision_type)
      VALUES (?, ?, ?, ?, ?, 'DECIDED', '', ?, '', '', '[]', '', '["SYSTEM","HUMAN"]', ?, ?, ?)`)
      .run(checkpointId, projectId, objectiveId, sessionId, outcome === 'GOOD' ? 'COMPLETED' : 'ERROR', outcome === 'GOOD' ? 'MET' : 'NOT_MET', now, now, outcome === 'GOOD' ? 'APPROVE' : 'REQUEST_CHANGES');
    built.services.db.prepare('INSERT INTO human_decisions (id, checkpoint_id, decision_type, note, decided_at) VALUES (?, ?, ?, NULL, ?)')
      .run(`${checkpointId}-decision`, checkpointId, outcome === 'GOOD' ? 'APPROVE' : 'REQUEST_CHANGES', now);
  }

  it('learns different reliability by objective type from quality, retry, fallback, time, cost and human outcomes', async () => {
    const projectId = await project('M17 learning');
    for (let index = 0; index < 8; index += 1) {
      seed(projectId, 'alpha', 'Correggere bug e regressione', 'GOOD', index);
      seed(projectId, 'beta', 'Correggere bug e regressione', 'POOR', index);
      seed(projectId, 'alpha', 'Aggiornare documentazione e guida', 'POOR', index + 20);
      seed(projectId, 'beta', 'Aggiornare documentazione e guida', 'GOOD', index + 20);
    }
    const selector = new RuntimeSelectionService(new ProviderCatalogService(new ExecutionProviderRegistry([provider('alpha'), provider('beta')])), built.services.db);
    const bug = selector.select({ projectId, objectiveText: 'Correggi il bug di routing', stopCondition: null, defaultRuntime: 'alpha' });
    const docs = selector.select({ projectId, objectiveText: 'Aggiorna la documentazione utente', stopCondition: null, defaultRuntime: 'alpha' });
    expect(bug.runtimeId).toBe('alpha');
    expect(docs.runtimeId).toBe('beta');
    expect(bug.decision).toMatchObject({ objectiveType: 'BUG_FIX', learningVersion: 'M18-v1' });
    const alpha = bug.decision?.candidates.find((candidate) => candidate.runtimeId === 'alpha')?.performance;
    const beta = bug.decision?.candidates.find((candidate) => candidate.runtimeId === 'beta')?.performance;
    expect(alpha).toMatchObject({ sampleSize: 8, globalSampleSize: 16, averageDurationMs: 10_000, averageCost: 0.01 });
    expect(beta).toMatchObject({ sampleSize: 8, averageDurationMs: 600_000, averageCost: 0.2 });
    expect(alpha!.retryRate).toBeLessThan(beta!.retryRate);
    expect(alpha!.fallbackRate).toBeLessThan(beta!.fallbackRate);
    expect(alpha!.humanInterventionRate).toBeLessThan(beta!.humanInterventionRate);
    expect(alpha!.costEfficiency).toBeGreaterThan(beta!.costEfficiency);
    expect(bug.decision?.reason).toContain('apprendimento BUG_FIX');
  });

  it('persists the adaptive explanation from objective creation through the real execution attempt', async () => {
    const projectId = await project('M17 end to end');
    seed(projectId, 'Fake', 'Implementare una feature API', 'GOOD', 100);
    const created = (await built.app.inject({ method: 'POST', url: `/api/projects/${projectId}/objectives`, payload: { title: 'adaptive', objectiveText: 'Implementare una nuova API' } })).json();
    expect(created.session.executionSelection.decision).toMatchObject({ mode: 'AUTOMATIC', objectiveType: 'CODE_CHANGE', learningVersion: 'M18-v1' });
    expect(created.session.executionSelection.decision.candidates[0].performance).toMatchObject({ globalSampleSize: 1, qualityScore: expect.any(Number), averageDurationMs: 10_000, averageCost: 0.01 });
    await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/sessions/${created.session.id}/start` });
    const attempts = (await built.app.inject({ method: 'GET', url: `/api/sessions/${created.session.id}/execution-attempts` })).json().attempts;
    expect(attempts[0].metadata.selection.decision).toMatchObject({ objectiveType: 'CODE_CHANGE', learningVersion: 'M18-v1', reason: expect.stringContaining('Scelta automatica adattiva') });
  });

  it('keeps restrictive budget policy authoritative over learned performance', async () => {
    const projectId = await project('M17 governed');
    await built.app.inject({ method: 'PUT', url: `/api/projects/${projectId}/policy`, payload: { costBudget: 0.000001, warningPercent: 80, action: 'HARD_STOP' } });
    const selector = new RuntimeSelectionService(new ProviderCatalogService(new ExecutionProviderRegistry([provider('alpha')])), built.services.db);
    expect(() => selector.select({ projectId, objectiveText: 'Implementa API', stopCondition: null, defaultRuntime: 'alpha' })).toThrow(/Nessuna combinazione/);
  });
});
