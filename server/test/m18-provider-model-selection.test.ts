import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { PricingCatalogService } from '../src/application/pricing-catalog-service.js';
import { ProviderCatalogService } from '../src/application/provider-catalog-service.js';
import { RuntimeSelectionService } from '../src/application/runtime-selection-service.js';
import { ExecutionProviderRegistry, type ExecutionProvider, type ProviderCatalogEntry } from '../src/integrations/execution-provider.js';
import { loadConfig } from '../src/config.js';
import { resolvePricingAt } from '../src/domain/pricing.js';

interface ModelSpec { id: string; name?: string; contextTokens?: number | null; defaultOutputTokens?: number; price: number; }
interface ProviderSpec { id: string; name?: string; models: ModelSpec[]; }

/** Un runtime Cline fittizio con più provider diretti (M18). */
function clineProvider(providers: ProviderSpec[]): ExecutionProvider {
  return {
    descriptor: { id: 'cline', runtimeType: 'cli', runtimeName: 'Cline', providerName: 'Cline', defaultModel: null },
    isConfigured: () => true,
    catalog: () => providers.map((provider) => ({
      runtime: { id: 'cline', name: 'Cline', type: 'cli', available: true, defaultModel: provider.models[0]?.id ?? null, capabilities: ['code', 'workspace-edit'], version: null },
      provider: { id: provider.id, name: provider.name ?? provider.id },
      models: provider.models.map((model) => ({
        id: model.id, name: model.name ?? model.id, version: null, capabilities: ['code'],
        limits: { contextTokens: model.contextTokens ?? null, defaultOutputTokens: model.defaultOutputTokens ?? 1000 },
        pricing: { inputPerMillion: model.price, outputPerMillion: model.price, currency: 'USD' as const },
        pricingSchedule: null,
      })),
    })),
    start: async () => { throw new Error('not used'); },
    stop: async () => undefined,
    touchHeartbeat: async () => undefined,
  };
}

describe('M18 - selezione automatica provider diretto + modello', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m18-'));
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'cline' })); });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  async function project(name: string): Promise<string> {
    return (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name } })).json().project.id;
  }

  it('seleziona il provider+modello più economici tra più provider diretti', async () => {
    const projectId = await project('M18 cost');
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([
      clineProvider([
        { id: 'premium', name: 'Premium', models: [{ id: 'premium-model', price: 10 }] },
        { id: 'economy', name: 'Economy', models: [{ id: 'economy-model', price: 1 }] },
      ]),
    ]));
    const selection = new RuntimeSelectionService(catalog, built.services.db).select({ projectId, objectiveText: 'Implementa API', stopCondition: null, defaultRuntime: 'cline' });
    expect(selection.runtimeId).toBe('cline');
    expect(selection.providerId).toBe('economy');
    expect(selection.modelId).toBe('economy-model');
    expect(selection.decision?.mode).toBe('AUTOMATIC');
    expect(selection.decision?.learningVersion).toBe('M18-v1');
  });

  it('esclude un modello la cui finestra di contesto è insufficiente', async () => {
    const projectId = await project('M18 context');
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([
      clineProvider([
        { id: 'wide', name: 'Wide', models: [{ id: 'wide-model', contextTokens: 100_000, price: 5 }] },
        { id: 'tiny', name: 'Tiny', models: [{ id: 'tiny-model', contextTokens: 3, price: 1 }] },
      ]),
    ]));
    // 24 caratteri → 6 token stimati; tiny (3 token) non regge il contesto.
    const selection = new RuntimeSelectionService(catalog, built.services.db).select({ projectId, objectiveText: 'questa è una frase di prova', stopCondition: null, defaultRuntime: 'cline' });
    expect(selection.providerId).toBe('wide');
    expect(selection.modelId).toBe('wide-model');
    const tiny = selection.decision?.candidates.find((candidate) => candidate.providerId === 'tiny');
    expect(tiny).toMatchObject({ eligible: false });
    expect(tiny?.reasons.join(' ')).toContain('contesto oltre la finestra');
  });

  it('ri-seleziona provider+modello vincolato al runtime per il retry', async () => {
    const projectId = await project('M18 retry');
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([
      clineProvider([
        { id: 'provider-a', models: [{ id: 'model-a', price: 9 }] },
        { id: 'provider-b', models: [{ id: 'model-b', price: 2 }] },
      ]),
    ]));
    const selector = new RuntimeSelectionService(catalog, built.services.db);
    const selection = selector.selectForRuntime('cline', { projectId, objectiveText: 'Correggi il bug', stopCondition: null, defaultRuntime: 'cline' });
    expect(selection.runtimeId).toBe('cline');
    expect(selection.providerId).toBe('provider-b');
    expect(selection.modelId).toBe('model-b');
  });
  it('risolve il prezzo per fascia oraria (schedule UTC)', () => {
    const schedule = [
      { from: '00:00', to: '16:29', inputPerMillion: 0.55, outputPerMillion: 2.19 },
      { from: '16:30', to: '23:59', inputPerMillion: 0.27, outputPerMillion: 1.10 },
    ];
    expect(resolvePricingAt(schedule, new Date('2026-08-15T10:00:00Z'))).toEqual({ inputPerMillion: 0.55, outputPerMillion: 2.19 });
    expect(resolvePricingAt(schedule, new Date('2026-08-15T18:00:00Z'))).toEqual({ inputPerMillion: 0.27, outputPerMillion: 1.10 });
    expect(resolvePricingAt({ inputPerMillion: 1, outputPerMillion: 2 }, new Date())).toEqual({ inputPerMillion: 1, outputPerMillion: 2 });
  });

  it('carica i prezzi dichiarati dal file locale e li rilegge al refresh', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m18-file-'));
    const file = path.join(dir, 'pricing.json');
    const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value), 'utf8');
    write({ providers: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', contextTokens: 64_000, pricing: { inputPerMillion: 0.27, outputPerMillion: 1.10 } }] }] });
    const service = new PricingCatalogService(file);
    expect(service.list()[0]).toMatchObject({ id: 'deepseek', name: 'DeepSeek' });
    expect(service.list()[0].models[0]).toMatchObject({ id: 'deepseek-chat', contextTokens: 64_000, pricing: { inputPerMillion: 0.27, outputPerMillion: 1.10 }, pricingSchedule: null });
    write({ providers: [{ id: 'deepseek', models: [{ id: 'deepseek-chat', pricing: { inputPerMillion: 0.10, outputPerMillion: 0.50 } }] }] });
    service.refresh();
    expect(service.list()[0].models[0].pricing).toMatchObject({ inputPerMillion: 0.10, outputPerMillion: 0.50 });
    service.stopRefreshing();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('risolve la schedule dal file al tempo corrente iniettato', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m18-sched-'));
    const file = path.join(dir, 'pricing.json');
    fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'deepseek', models: [{ id: 'r1', pricing: [{ from: '00:00', to: '16:29', inputPerMillion: 0.55, outputPerMillion: 2.19 }, { from: '16:30', to: '23:59', inputPerMillion: 0.27, outputPerMillion: 1.10 }] }] }] }), 'utf8');
    const service = new PricingCatalogService(file, [], () => new Date('2026-08-15T10:00:00Z'));
    const model = service.list()[0].models[0];
    expect(model.pricing).toMatchObject({ inputPerMillion: 0.55, outputPerMillion: 2.19 });
    expect(model.pricingSchedule).toHaveLength(2);
    service.stopRefreshing();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('seleziona i modelli di QUALSIASI entry del catalogo per lo stesso provider', () => {
    // Più provider dell'archivio G-Rex Pricing possono mappare alla stessa chiave
    // CLI: il catalogo espone più entry con lo stesso (runtime, provider). Il
    // modello scelto può appartenere a una qualunque di esse (AI Catalog).
    const entry = (models: string[]): ProviderCatalogEntry => ({
      runtime: { id: 'cline', name: 'Cline', type: 'cli', available: true, defaultModel: null, capabilities: [], version: null },
      provider: { id: 'openai-compatible', name: 'Qwen (Alibaba Model Studio)' },
      models: models.map((id) => ({
        id, name: id, version: null, capabilities: ['code'],
        limits: { contextTokens: null, defaultOutputTokens: 1000 },
        pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' as const },
        pricingSchedule: null,
      })),
    });
    const provider: ExecutionProvider = {
      descriptor: { id: 'cline', runtimeType: 'cli', runtimeName: 'Cline', providerName: 'Cline', defaultModel: null },
      isConfigured: () => true,
      catalog: () => [entry(['model-a']), entry(['model-b'])],
      start: async () => { throw new Error('not used'); },
      stop: async () => undefined,
      touchHeartbeat: async () => undefined,
    };
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([provider]));
    // Ogni modello dichiarato da una qualunque entry del provider è valido.
    expect(catalog.resolve({ runtimeId: 'cline', providerId: 'openai-compatible', modelId: 'model-a' }).modelId).toBe('model-a');
    expect(catalog.resolve({ runtimeId: 'cline', providerId: 'openai-compatible', modelId: 'model-b' }).modelId).toBe('model-b');
    // Un modello sconosciuto resta rifiutato (validazione sull'unione delle entry).
    expect(() => catalog.resolve({ runtimeId: 'cline', providerId: 'openai-compatible', modelId: 'sconosciuto' })).toThrow(/non disponibile/);
    // Stima e prezzo per token risolvono sull'entry che dichiara il modello.
    expect(catalog.estimateSelection('cline', 'openai-compatible', 'model-b', 'test', null).modelId).toBe('model-b');
    expect(catalog.tokenPricing('cline', 'openai-compatible', 'model-b')).not.toBeNull();
  });
});
