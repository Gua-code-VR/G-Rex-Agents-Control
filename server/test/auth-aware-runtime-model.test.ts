import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ProviderCatalogService } from '../src/application/provider-catalog-service.js';
import { ExecutionProviderRegistry, type ExecutionProvider, type ProviderCatalogEntry } from '../src/integrations/execution-provider.js';
import { CodexProvider } from '../src/integrations/execution-provider.js';

/** Entry del catalogo che riflette la modalità `chatgpt` della CLI Codex. */
const chatgptCodexEntry: ProviderCatalogEntry = {
  runtime: { id: 'codex', name: 'Codex CLI', type: 'cli', available: true, defaultModel: null, capabilities: ['workspace-edit'], version: '0.147-compatible' },
  provider: { id: 'openai-codex', name: 'OpenAI Codex' },
  models: [],
};

function providerWith(entry: ProviderCatalogEntry): ExecutionProvider {
  return {
    descriptor: { id: entry.runtime.id, runtimeType: 'cli', runtimeName: entry.runtime.name, providerName: entry.provider.name, defaultModel: entry.runtime.defaultModel },
    isConfigured: () => true,
    catalog: () => [entry],
    start: async () => { throw new Error('not used'); },
    stop: async () => undefined,
    touchHeartbeat: async () => undefined,
  };
}

describe('Autenticazione runtime/model — Codex con account ChatGPT', () => {
  it('catalogo api-key (default): propone codex-default come oggi', () => {
    const catalog = new CodexProvider('codex').catalog();
    const codex = catalog[0];
    expect(codex.runtime.defaultModel).toBe('codex-default');
    expect(codex.models.map((m) => m.id)).toEqual(['codex-default']);
  });

  it('catalogo chatgpt senza modello esplicito: non propone codex-default (modello gestito dal runtime)', () => {
    const catalog = new CodexProvider('codex', true, null, undefined, 'chatgpt').catalog();
    const codex = catalog[0];
    expect(codex.runtime.defaultModel).toBeNull();
    expect(codex.models).toEqual([]);
    expect(codex.models.some((m) => m.id === 'codex-default')).toBe(false);
  });

  it('catalogo chatgpt con modello esplicito configurato: mantiene il modello scelto', () => {
    const catalog = new CodexProvider('codex', true, 'gpt-5', undefined, 'chatgpt').catalog();
    const codex = catalog[0];
    expect(codex.runtime.defaultModel).toBe('gpt-5');
    expect(codex.models.map((m) => m.id)).toEqual(['gpt-5']);
  });

  it('avvio chatgpt: blocca un codex-default forzato esplicitamente', async () => {
    const provider = new CodexProvider('codex', true, null, undefined, 'chatgpt');
    await expect(provider.start({
      objectiveId: 'o', projectPath: null, objectiveText: 'test', stopCondition: null, model: 'codex-default',
    })).rejects.toThrow(/account ChatGPT/);
    await expect(provider.start({
      objectiveId: 'o', projectPath: null, objectiveText: 'test', stopCondition: null, model: null,
    })).resolves.toBeDefined();
  });

  it('selezione: una volta escluso dal catalogo, codex-default viene rifiutato dalla validazione', () => {
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([providerWith(chatgptCodexEntry)]));
    expect(() => catalog.resolve({ runtimeId: 'codex', providerId: 'openai-codex', modelId: 'codex-default' }))
      .toThrow(/Modello codex-default non disponibile/);
    expect(catalog.resolve({ runtimeId: 'codex', providerId: 'openai-codex', modelId: null }).modelId).toBeNull();
  });
});

describe('Autenticazione runtime/model — via API (buildApp)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-auth-'));
  let built: BuiltApp;
  beforeAll(async () => {
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake', GAC_CODEX_AUTH: 'chatgpt' }));
  });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('espone il catalogo Codex senza codex-default quando l\'autenticazione è chatgpt', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/api/provider-catalog' });
    expect(response.statusCode).toBe(200);
    const codex = response.json().catalog.find((item: { runtime: { id: string } }) => item.runtime.id === 'codex');
    expect(codex.runtime.defaultModel).toBeNull();
    expect(codex.models).toEqual([]);
    expect(codex.models.some((m: { id: string }) => m.id === 'codex-default')).toBe(false);
  });
});
