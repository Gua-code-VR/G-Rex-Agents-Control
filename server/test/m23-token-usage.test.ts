import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ProviderCatalogService } from '../src/application/provider-catalog-service.js';
import { RuntimeSelectionService } from '../src/application/runtime-selection-service.js';
import { AgentSessionService } from '../src/application/agent-session-service.js';
import { ProcessSupervisor } from '../src/application/process-supervisor.js';
import {
  accumulateUsage,
  buildClineArgs,
  ExecutionProviderRegistry,
  type ExecutionProvider,
  type ExecutionResult,
  type ProviderCatalogEntry,
} from '../src/integrations/execution-provider.js';
import { SqliteObjectiveRepository, SqliteSessionRepository } from '../src/infrastructure/db/objective-repo.js';
import { SqliteExecutionAttemptRepository } from '../src/infrastructure/db/execution-attempt-repo.js';

/** Scrive un archivio G-Rex Pricing minimale con Qwen + DeepSeek (per-token + cache). */
function writeArchive(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const providers = [
    { id: 'qwen', name: 'Qwen (Alibaba Model Studio)', timezone: 'UTC', officialSiteUrl: 'https://alibabacloud.com', sourceIds: ['qwen'], limits: {} },
    { id: 'deepseek', name: 'DeepSeek', timezone: 'UTC', officialSiteUrl: 'https://deepseek.com', sourceIds: ['deepseek'], limits: {} },
  ];
  const models = [
    { id: 'qwen3-coder-plus', providerId: 'qwen', name: 'Qwen3 Coder Plus', contextWindow: { maxInputTokens: 128000, maxOutputTokens: 8000 }, capabilities: ['code'] },
    { id: 'deepseek-v4-pro', providerId: 'deepseek', name: 'DeepSeek V4 Pro', contextWindow: { maxInputTokens: 64000, maxOutputTokens: 8000 }, capabilities: ['code'] },
    { id: 'deepseek-v4-flash', providerId: 'deepseek', name: 'DeepSeek V4 Flash', contextWindow: { maxInputTokens: 64000, maxOutputTokens: 8000 }, capabilities: ['code'] },
  ];
  const band = (inputPerToken: number, outputPerToken: number, cachedInputPerToken: number) => ({
    id: 'standard', name: 'Standard', timezone: 'UTC', priority: 0, isDefault: true, schedule: null,
    pricing: { currency: 'USD', inputPerToken, outputPerToken, cachedInputPerToken, cachedOutputPerToken: null, extra: {} },
  });
  const records = [
    { id: 'rec-qwen', schemaVersion: 1, providerId: 'qwen', modelId: 'qwen3-coder-plus', validFrom: '2024-01-01T00:00:00Z', validTo: null, timeBands: [band(0.8e-6, 3.2e-6, 0.08e-6)] },
    { id: 'rec-ds', schemaVersion: 1, providerId: 'deepseek', modelId: 'deepseek-v4-pro', validFrom: '2024-01-01T00:00:00Z', validTo: null, timeBands: [band(0.66e-6, 1.98e-6, 0.022e-6)] },
    { id: 'rec-ds-flash', schemaVersion: 1, providerId: 'deepseek', modelId: 'deepseek-v4-flash', validFrom: '2024-01-01T00:00:00Z', validTo: null, timeBands: [band(0.22e-6, 0.66e-6, 0.007e-6)] },
  ];
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1 }));
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ providers, models }));
  fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(records));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ current: { 'qwen::qwen3-coder-plus': 'rec-qwen', 'deepseek::deepseek-v4-pro': 'rec-ds', 'deepseek::deepseek-v4-flash': 'rec-ds-flash' } }));
}

/** Mock Cline provider che restituisce un risultato COMPLETED con usage (senza costo). */
function clineWithUsage(usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }): ExecutionProvider {
  const entry: ProviderCatalogEntry = {
    runtime: { id: 'cline', name: 'Cline', type: 'cli', available: true, defaultModel: null, capabilities: ['code'], version: null },
    provider: { id: 'openai-compatible', name: 'Qwen (Alibaba Model Studio)' },
    models: [{ id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', version: null, capabilities: ['code'], limits: { contextTokens: 128000, defaultOutputTokens: 8000 }, pricing: { inputPerMillion: 0.8, outputPerMillion: 3.2, currency: 'USD', inputPerToken: 0.8e-6, outputPerToken: 3.2e-6, cachedInputPerToken: 0.08e-6 } }],
  };
  const provider: ExecutionProvider = {
    descriptor: { id: 'cline', runtimeType: 'cli', runtimeName: 'Cline', providerName: 'Cline', defaultModel: null },
    isConfigured: () => true,
    catalog: () => [entry],
    start: async () => {
      const completion = new Promise<ExecutionResult>((resolve) => {
        resolve({
          outcome: 'COMPLETED' as const, exitCode: 0, reason: null, report: 'ok',
          usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens, costEstimate: null, costActual: null },
        });
      });
      return { processReference: 'cline-test', descriptor: provider.descriptor, completion };
    },
    stop: async () => undefined,
    touchHeartbeat: async () => undefined,
  };
  return provider;
}

describe('M23 - consumo token reale e costo a scaglioni', () => {
  describe('accumulateUsage', () => {
    it('accumula più eventi usage e somma i token', () => {
      const output = [
        JSON.stringify({ type: 'usage', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, total_tokens: 1200 } }),
        JSON.stringify({ type: 'usage', usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, total_tokens: 600 } }),
      ].join('\n');
      expect(accumulateUsage(output)).toMatchObject({ inputTokens: 1500, outputTokens: 300, cachedInputTokens: 800, totalTokens: 1800 });
    });

    it('estrae la cache OpenAI-style (Qwen/DashScope)', () => {
      const output = JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 600 } } });
      expect(accumulateUsage(output)).toMatchObject({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600 });
    });

    it('estrae la cache DeepSeek (prompt_cache_hit_tokens)', () => {
      const output = JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_cache_hit_tokens: 400 } });
      expect(accumulateUsage(output)).toMatchObject({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400 });
    });

    it('estrae la cache Anthropic-style (cache_read_input_tokens)', () => {
      const output = JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 500 } });
      expect(accumulateUsage(output)).toMatchObject({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 300 });
    });

    it('estrae la cache Cline/DeepSeek (cacheReadTokens)', () => {
      const output = JSON.stringify({ usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700 } });
      expect(accumulateUsage(output)).toMatchObject({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 700 });
    });

    it('non conta due volte il report finale (run_result) di Cline', () => {
      // Cline CLI emette lo stesso aggregato nel done event e nel run_result:
      // il run_result è il report autorevole e sostituisce l'accumulo.
      const done = JSON.stringify({ type: 'agent_event', event: { type: 'done', reason: 'completed', text: 'OK.', usage: { inputTokens: 5326, outputTokens: 28, cacheReadTokens: 5248, totalCost: 0.0000334544 } } });
      const runResult = JSON.stringify({ type: 'run_result', finishReason: 'completed', usage: { inputTokens: 5326, outputTokens: 28, cacheReadTokens: 5248, totalCost: 0.0000334544 } });
      expect(accumulateUsage([done, runResult].join('\n'))).toMatchObject({ inputTokens: 5326, outputTokens: 28, cachedInputTokens: 5248, costActual: 0.0000334544 });
    });
  });
});


describe('M23 - costo consuntivo dai token (DeepSeek e Qwen)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m23-'));
  const archiveDir = path.join(dataDir, 'archive');
  let built: BuiltApp;

  beforeAll(async () => {
    writeArchive(archiveDir);
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_PRICING_ARCHIVE_DIR: archiveDir }));
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('espone Qwen e DeepSeek dal pricing locale con prezzo per token e cache', () => {
    const entries = built.services.catalog.list();
    const qwen = entries.find((e) => e.provider.id === 'openai-compatible');
    const deepseek = entries.find((e) => e.provider.id === 'deepseek');
    expect(qwen).toBeDefined();
    expect(qwen?.models[0].pricing).toMatchObject({ inputPerMillion: 0.8, outputPerMillion: 3.2 });
    expect(qwen?.models[0].pricing.inputPerToken).toBeCloseTo(0.8e-6, 12);
    expect(qwen?.models[0].pricing.cachedInputPerToken).toBeCloseTo(0.08e-6, 12);
    expect(deepseek).toBeDefined();
    expect(deepseek?.models[0].pricing.inputPerToken).toBeCloseTo(0.66e-6, 12);
  });

  it('espone DeepSeek V4 Flash dal pricing locale (no hardcode in Agent Control)', () => {
    const entries = built.services.catalog.list();
    const deepseek = entries.find((e) => e.provider.id === 'deepseek');
    expect(deepseek?.models.map((m) => m.id)).toContain('deepseek-v4-flash');
    const flash = deepseek?.models.find((m) => m.id === 'deepseek-v4-flash');
    expect(flash?.pricing).toMatchObject({ inputPerMillion: 0.22, outputPerMillion: 0.66 });
    expect(flash?.pricing.inputPerToken).toBeCloseTo(0.22e-6, 12);
    expect(flash?.pricing.cachedInputPerToken).toBeCloseTo(0.007e-6, 12);
  });

  it('calcola il consuntivo dai token con scaglione cache-hit (Qwen)', () => {
    const tp = built.services.catalog.tokenPricing('cline', 'openai-compatible', 'qwen3-coder-plus');
    const expected = 400 * 0.8e-6 + 600 * 0.08e-6 + 200 * 3.2e-6; // 400 miss + 600 hit + 200 out
    const cost = (1000 - 600) * (tp!.inputPerToken ?? 0) + 600 * (tp!.cachedInputPerToken ?? 0) + 200 * (tp!.outputPerToken ?? 0);
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('calcola il consuntivo dai token con scaglione cache-hit (DeepSeek)', () => {
    const tp = built.services.catalog.tokenPricing('cline', 'deepseek', 'deepseek-v4-pro');
    const expected = 400 * 0.66e-6 + 600 * 0.022e-6 + 200 * 1.98e-6;
    const cost = (1000 - 600) * (tp!.inputPerToken ?? 0) + 600 * (tp!.cachedInputPerToken ?? 0) + 200 * (tp!.outputPerToken ?? 0);
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("l'attempt persiste il consumo reale e calcola cost_actual dai token", async () => {
    const projectId = built.services.projects.register({ name: 'M23 usage e2e' }).id;
    const usageProvider = clineWithUsage({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600 });
    const mockRegistry = new ExecutionProviderRegistry([usageProvider]);
    const mockCatalog = new ProviderCatalogService(mockRegistry);
    const mockSelector = new RuntimeSelectionService(mockCatalog, built.services.db);
    const objectiveRepo = new SqliteObjectiveRepository(built.services.db);
    const sessionRepo = new SqliteSessionRepository(built.services.db);
    const supervisor = new ProcessSupervisor(new SqliteExecutionAttemptRepository(built.services.db), built.services.events, { retryMax: 0, retryBackoffMs: 10, fallbackRuntime: null });
    const svc = new AgentSessionService(
      objectiveRepo, sessionRepo, built.services.projects, built.services.gitStatus, built.services.events,
      mockRegistry, built.services.checkpoints, supervisor, built.services.notifications,
      built.services.governance, mockCatalog, mockSelector, built.services.retryWorker,
    );
    const objective = objectiveRepo.create(projectId, { title: 'M23 usage e2e', objectiveText: 'test', invariants: [], acceptanceCriteria: [], stopCondition: null });
    const selection = mockCatalog.resolve({ runtimeId: 'cline', providerId: 'openai-compatible', modelId: 'qwen3-coder-plus' });
    const session = sessionRepo.createWithHeartbeat(objective.id, 'cline', 30000, selection);
    await svc.start(objective.id, session.id);
    await new Promise((r) => setTimeout(r, 50)); // lascia risolvere il completion del mock
    const attempt = built.services.db.prepare('SELECT input_tokens, output_tokens, total_tokens, cached_input_tokens, cached_output_tokens, cost_actual FROM execution_attempts WHERE session_id = ?').get(session.id) as { input_tokens: number; output_tokens: number; total_tokens: number; cached_input_tokens: number; cached_output_tokens: number | null; cost_actual: number | null };
    expect(attempt.input_tokens).toBe(1000);
    expect(attempt.output_tokens).toBe(200);
    expect(attempt.total_tokens).toBe(1200);
    expect(attempt.cached_input_tokens).toBe(600);
    const expectedCost = 400 * 0.8e-6 + 600 * 0.08e-6 + 200 * 3.2e-6;
    expect(attempt.cost_actual).toBeCloseTo(expectedCost, 8);
  });
});

describe("M23 - l'archivio G-Rex Pricing è attivo di default (DeepSeek V4 Flash)", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m23-default-'));
  let built: BuiltApp;

  beforeAll(async () => {
    // L'archivio va nella posizione di default `<dataDir>/g-rex-pricing-archive`:
    // nessun override GAC_PRICING_ARCHIVE_DIR, come nel deployment reale. Questo
    // test blocca la regressione che lasciava l'archivio inutilizzato a runtime.
    writeArchive(path.join(dataDir, 'g-rex-pricing-archive'));
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent' }));
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("la config di default punta all'archivio sotto dataDir", () => {
    const cfg = loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent' });
    expect(cfg.pricingArchiveDir).toBe(path.join(dataDir, 'g-rex-pricing-archive'));
  });

  it('/api/provider-catalog espone DeepSeek V4 Flash senza override di config', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/provider-catalog' });
    expect(res.statusCode).toBe(200);
    const deepseek = (res.json().catalog as Array<{ runtime: { id: string }; provider: { id: string }; models: Array<{ id: string }> }>)
      .find((e) => e.runtime.id === 'cline' && e.provider.id === 'deepseek');
    expect(deepseek?.models.map((m) => m.id)).toContain('deepseek-v4-flash');
  });

  it('la selezione di DeepSeek V4 Flash arriva alla CLI Cline (--provider/--model)', () => {
    expect(buildClineArgs({ objectiveText: 'fix', stopCondition: null, providerId: 'deepseek', model: 'deepseek-v4-flash' }))
      .toEqual(['--json', '--provider', 'deepseek', '--model', 'deepseek-v4-flash', 'fix']);
  });

  it('il fallback Cline resta esplicito e non dipende da lastUsedProvider', () => {
    expect(buildClineArgs({ objectiveText: 'fix', stopCondition: null, providerId: 'cline', model: null }))
      .toEqual(['--json', '--provider', 'cline', 'fix']);
  });
});

