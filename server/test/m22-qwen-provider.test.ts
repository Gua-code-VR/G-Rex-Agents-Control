import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PricingCatalogService } from '../src/application/pricing-catalog-service.js';
import { ProviderCatalogService } from '../src/application/provider-catalog-service.js';
import { RuntimeSelectionService } from '../src/application/runtime-selection-service.js';
import {
  buildClineArgs,
  ClineProvider,
  ExecutionProviderRegistry,
  type ExecutionProvider,
  type ProviderCatalogEntry,
  type StartExecutionParams,
} from '../src/integrations/execution-provider.js';
import type { PricingProviderEntry } from '../src/domain/pricing.js';

/**
 * M22 — Qwen come provider diretto Cline (openai-compatible).
 *
 * Qwen arriva ad Agent Control tramite il file prezzi locale (`pricing.json`)
 * con `id` = chiave provider Cline `openai-compatible` (configurata con
 * `cline auth -p openai-compatible` verso Alibaba Model Studio) e modello
 * `qwen3-coder-plus`. La API key resta fuori dal repository (config Cline +
 * env `DASHSCOPE_API_KEY`).
 */

const QWEN: PricingProviderEntry = {
  id: 'openai-compatible',
  name: 'Qwen (Alibaba Model Studio)',
  models: [{
    id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', contextTokens: 128_000, defaultOutputTokens: 4000,
    pricing: { inputPerMillion: 0.5, outputPerMillion: 1.0, currency: 'USD' }, pricingSchedule: null,
  }],
};
const DEEPSEEK: PricingProviderEntry = {
  id: 'deepseek',
  name: 'DeepSeek',
  models: [{
    id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextTokens: 64_000, defaultOutputTokens: 4000,
    pricing: { inputPerMillion: 0.27, outputPerMillion: 1.10, currency: 'USD' }, pricingSchedule: null,
  }],
};

/** Runtime Cline fittizio (disponibile) con più provider diretti, come in M18. */
function clineMock(providers: PricingProviderEntry[]): { provider: ExecutionProvider; started: StartExecutionParams[] } {
  const started: StartExecutionParams[] = [];
  const provider: ExecutionProvider = {
    descriptor: { id: 'cline', runtimeType: 'cli', runtimeName: 'Cline', providerName: 'Cline', defaultModel: null },
    isConfigured: () => true,
    catalog: () => providers.map((p): ProviderCatalogEntry => ({
      runtime: { id: 'cline', name: 'Cline', type: 'cli', available: true, defaultModel: p.models[0]?.id ?? null, capabilities: ['code', 'workspace-edit'], version: null },
      provider: { id: p.id, name: p.name },
      models: p.models.map((m) => ({
        id: m.id, name: m.name, version: null, capabilities: ['code'],
        limits: { contextTokens: m.contextTokens, defaultOutputTokens: m.defaultOutputTokens },
        pricing: m.pricing, pricingSchedule: m.pricingSchedule,
      })),
    })),
    start: async (params) => { started.push(params); return { processReference: 'cline-test', descriptor: provider.descriptor, completion: new Promise(() => undefined) }; },
    stop: async () => undefined,
    touchHeartbeat: async () => undefined,
  };
  return { provider, started };
}

describe('M22 - Qwen provider diretto (openai-compatible)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m22-'));
  let built: BuiltApp;

  beforeAll(async () => {
    const pricingFile = path.join(dataDir, 'pricing.json');
    fs.writeFileSync(pricingFile, JSON.stringify({ providers: [DEEPSEEK, QWEN] }), 'utf8');
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_PRICING_FILE: pricingFile }));
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function project(name: string): Promise<string> {
    return (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name } })).json().project.id;
  }

  it('passa sempre --provider e --model espliciti (indipendente dalla selezione globale di Cline)', () => {
    const qwen = buildClineArgs({ objectiveText: 'fix', stopCondition: null, providerId: 'openai-compatible', model: 'qwen3-coder-plus' });
    expect(qwen.slice(0, 5)).toEqual(['--json', '--provider', 'openai-compatible', '--model', 'qwen3-coder-plus']);
    expect(qwen[qwen.length - 1]).toBe('fix');

    const deepseek = buildClineArgs({ objectiveText: 'fix', stopCondition: null, providerId: 'deepseek', model: 'deepseek-v4-pro' });
    expect(deepseek.slice(0, 5)).toEqual(['--json', '--provider', 'deepseek', '--model', 'deepseek-v4-pro']);

    // Anche il fallback runtime-managed resta esplicito: non può leggere
    // lastUsedProvider dalla configurazione globale di Cline.
    expect(buildClineArgs({ objectiveText: 'fix', stopCondition: null, providerId: 'cline' }))
      .toEqual(['--json', '--provider', 'cline', 'fix']);
    expect(() => buildClineArgs({ objectiveText: 'fix', stopCondition: null, providerId: '  ' }))
      .toThrow('Cline richiede un provider selezionato esplicitamente');
  });

  it('espone Qwen nel catalogo provider/modello (dal pricing locale)', () => {
    const pricing = new PricingCatalogService(path.join(dataDir, 'pricing.json'));
    const cline = new ClineProvider('cline', true, () => pricing.list());
    const catalog = cline.catalog();
    const qwen = catalog.find((e) => e.provider.id === 'openai-compatible');
    expect(qwen).toBeDefined();
    expect(qwen?.provider.name).toBe('Qwen (Alibaba Model Studio)');
    expect(qwen?.models.some((m) => m.id === 'qwen3-coder-plus')).toBe(true);
    // DeepSeek resta presente e intatto.
    expect(catalog.some((e) => e.provider.id === 'deepseek')).toBe(true);
  });

  it('risolve la selezione Qwen e ne espone il nome provider', () => {
    const { provider } = clineMock([DEEPSEEK, QWEN]);
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([provider]));
    const selection = catalog.resolve({ runtimeId: 'cline', providerId: 'openai-compatible', modelId: 'qwen3-coder-plus' });
    expect(selection).toMatchObject({ runtimeId: 'cline', providerId: 'openai-compatible', modelId: 'qwen3-coder-plus' });
    expect(catalog.providerName('cline', 'openai-compatible')).toBe('Qwen (Alibaba Model Studio)');
  });

  it('il router M18 seleziona Qwen quando è il candidato più conveniente', async () => {
    const qwenCheap: PricingProviderEntry = { ...QWEN, models: [{ ...QWEN.models[0], pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4, currency: 'USD' } }] };
    const { provider } = clineMock([DEEPSEEK, qwenCheap]);
    const selector = new RuntimeSelectionService(new ProviderCatalogService(new ExecutionProviderRegistry([provider])), built.services.db);
    const selection = selector.select({ projectId: await project('M22 cost'), objectiveText: 'Implementa API', stopCondition: null, defaultRuntime: 'cline' });
    expect(selection.runtimeId).toBe('cline');
    expect(selection.providerId).toBe('openai-compatible');
    expect(selection.modelId).toBe('qwen3-coder-plus');
  });

  it('ri-seleziona Qwen nel retry/fallback vincolato al runtime cline', async () => {
    const { provider } = clineMock([QWEN]);
    const selector = new RuntimeSelectionService(new ProviderCatalogService(new ExecutionProviderRegistry([provider])), built.services.db);
    const selection = selector.selectForRuntime('cline', { projectId: await project('M22 retry'), objectiveText: 'Correggi il bug', stopCondition: null, defaultRuntime: 'cline' });
    expect(selection.runtimeId).toBe('cline');
    expect(selection.providerId).toBe('openai-compatible');
    expect(selection.modelId).toBe('qwen3-coder-plus');
  });

  it('il pricing locale dichiara Qwen (openai-compatible → qwen3-coder-plus)', () => {
    const serverDir = path.dirname(fileURLToPath(import.meta.url));
    const file = path.resolve(serverDir, '../data/pricing.json');
    if (!fs.existsSync(file)) return; // file locale non presente in ambienti puliti
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { providers: Array<{ id: string; models: Array<{ id: string }> }> };
    const qwen = raw.providers.find((p) => p.id === 'openai-compatible');
    expect(qwen?.models.map((m) => m.id)).toContain('qwen3-coder-plus');
    const deepseek = raw.providers.find((p) => p.id === 'deepseek');
    expect(deepseek).toBeDefined();
  });
});
