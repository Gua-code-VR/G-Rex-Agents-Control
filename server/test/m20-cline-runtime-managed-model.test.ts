import { describe, expect, it } from 'vitest';
import { normalizeModelId, ProviderCatalogService } from '../src/application/provider-catalog-service.js';
import { ExecutionProviderRegistry, type ExecutionProvider, type ProviderCatalogEntry } from '../src/integrations/execution-provider.js';

/** Provider fittizio con un singolo entry di catalogo, per testare solo la validazione. */
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

/** Cline senza GAC_CLINE_MODEL: il catalogo dichiara il modello gestito dal runtime (nessun modello). */
const clineRuntimeManaged: ProviderCatalogEntry = {
  runtime: { id: 'cline', name: 'Cline', type: 'cli', available: true, defaultModel: null, capabilities: ['code', 'workspace-edit'], version: null },
  provider: { id: 'cline', name: 'Cline' },
  models: [],
};

/** Provider con modelli dichiarati: la validazione sul modello deve restare invariata. */
const codexWithModels: ProviderCatalogEntry = {
  runtime: { id: 'codex', name: 'Codex CLI', type: 'cli', available: true, defaultModel: 'codex-default', capabilities: ['workspace-edit'], version: '1' },
  provider: { id: 'openai-codex', name: 'OpenAI Codex' },
  models: [{
    id: 'codex-default', name: 'Codex default', version: null, capabilities: ['code'],
    limits: { contextTokens: null, defaultOutputTokens: 4000 },
    pricing: { inputPerMillion: 1, outputPerMillion: 1, currency: 'USD' },
  }],
};

describe('M20 - Cline con modello gestito dal runtime', () => {
  it('normalizza il modelId non specificato (null/undefined/vuoto/"null")', () => {
    expect(normalizeModelId(null)).toBeNull();
    expect(normalizeModelId(undefined)).toBeNull();
    expect(normalizeModelId('')).toBeNull();
    expect(normalizeModelId('null')).toBeNull();
    expect(normalizeModelId('NULL')).toBeNull();
    expect(normalizeModelId('  null  ')).toBeNull();
    expect(normalizeModelId('anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
  });

  it('accetta il modelId assente per Cline quando il runtime gestisce il modello', () => {
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([providerWith(clineRuntimeManaged)]));
    // null (selezione automatica), assente e la stringa "null" (difesa da client) sono tutti validi.
    expect(catalog.resolve({ runtimeId: 'cline', providerId: 'cline', modelId: null }).modelId).toBeNull();
    expect(catalog.resolve({ runtimeId: 'cline', providerId: 'cline' }).modelId).toBeNull();
    expect(catalog.resolve({ runtimeId: 'cline', providerId: 'cline', modelId: 'null' }).modelId).toBeNull();
  });

  it('non indebolisce la validazione per i provider con modelli dichiarati', () => {
    const catalog = new ProviderCatalogService(new ExecutionProviderRegistry([providerWith(codexWithModels)]));
    // Modello sconosciuto → errore esplicito.
    expect(() => catalog.resolve({ runtimeId: 'codex', providerId: 'openai-codex', modelId: 'sconosciuto' }))
      .toThrow(/Modello sconosciuto non disponibile per Codex CLI/);
    // Un modello dichiarato continua a risolvere correttamente.
    expect(catalog.resolve({ runtimeId: 'codex', providerId: 'openai-codex', modelId: 'codex-default' }).modelId).toBe('codex-default');
    // La stringa "null" è interpretata come «non specificato» (fallback al default), non come modello letterale.
    expect(catalog.resolve({ runtimeId: 'codex', providerId: 'openai-codex', modelId: 'null' }).modelId).toBe('codex-default');
  });
});
