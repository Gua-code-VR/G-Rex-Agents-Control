import { describe, expect, it } from 'vitest';
import type { ProviderCatalogEntry } from '../src/api/client';
import {
  catalogEntriesFor,
  defaultModelId,
  modelsForProvider,
  providersForRuntime,
} from '../src/lib/provider-catalog';

function entry(runtimeId: string, providerId: string, providerName: string, modelIds: string[], defaultModel?: string | null): ProviderCatalogEntry {
  return {
    runtime: {
      id: runtimeId, name: runtimeId, type: 'cli', available: true,
      defaultModel: defaultModel === undefined ? modelIds[0] ?? null : defaultModel,
      capabilities: [], version: null,
    },
    provider: { id: providerId, name: providerName },
    models: modelIds.map((id) => ({
      id, name: id, version: null, capabilities: [],
      limits: { contextTokens: null, defaultOutputTokens: 1000 },
      pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
      pricingSchedule: null,
    })),
  };
}

describe('provider-catalog — «tutti i modelli dell’AI Catalog per il provider selezionato»', () => {
  it('con più entry per lo stesso provider mostra l’unione dei modelli', () => {
    const catalog = [
      entry('cline', 'openai-compatible', 'Qwen (Alibaba Model Studio)', ['qwen3-coder-plus']),
      entry('cline', 'openai-compatible', 'Qwen (Alibaba Model Studio)', ['qwen3-coder-turbo']),
    ];
    expect(modelsForProvider(catalog, 'cline', 'openai-compatible').map((m) => m.id))
      .toEqual(['qwen3-coder-plus', 'qwen3-coder-turbo']);
  });

  it('deduplica i modelli ripetuti e ignora runtime/provider diversi', () => {
    const catalog = [
      entry('cline', 'openai-compatible', 'Qwen', ['shared', 'model-a']),
      entry('cline', 'openai-compatible', 'Qwen (Ali)', ['shared', 'model-b']),
      entry('codex', 'openai-compatible', 'Qwen', ['codex-only']),
      entry('cline', 'deepseek', 'DeepSeek', ['deepseek-chat']),
    ];
    expect(modelsForProvider(catalog, 'cline', 'openai-compatible').map((m) => m.id))
      .toEqual(['shared', 'model-a', 'model-b']);
  });

  it('catalogEntriesFor restituisce tutte le entry del (runtime, provider)', () => {
    const catalog = [
      entry('cline', 'p', 'P', ['a']),
      entry('cline', 'p', 'P', ['b']),
      entry('codex', 'p', 'P', ['c']),
    ];
    expect(catalogEntriesFor(catalog, 'cline', 'p')).toHaveLength(2);
    expect(catalogEntriesFor(catalog, 'codex', 'p')).toHaveLength(1);
    expect(catalogEntriesFor(catalog, 'cline', 'ignoto')).toHaveLength(0);
  });

  it('providersForRuntime deduplica i provider del runtime', () => {
    const catalog = [
      entry('cline', 'openai-compatible', 'Qwen', ['a']),
      entry('cline', 'openai-compatible', 'Qwen (Ali)', ['b']),
      entry('cline', 'deepseek', 'DeepSeek', ['c']),
      entry('codex', 'openai-codex', 'OpenAI Codex', ['d']),
    ];
    expect(providersForRuntime(catalog, 'cline')).toEqual([
      { id: 'openai-compatible', name: 'Qwen' },
      { id: 'deepseek', name: 'DeepSeek' },
    ]);
  });

  it('defaultModelId usa il primo default dichiarato tra le entry, poi il primo modello', () => {
    const withDefault = [
      entry('cline', 'p', 'P', ['a'], null),
      entry('cline', 'p', 'P', ['b', 'c'], 'b'),
    ];
    expect(defaultModelId(withDefault, 'cline', 'p')).toBe('b');
    const withoutDefault = [
      entry('cline', 'p', 'P', ['a'], null),
      entry('cline', 'p', 'P', ['b'], null),
    ];
    expect(defaultModelId(withoutDefault, 'cline', 'p')).toBe('a');
    expect(defaultModelId([], 'cline', 'p')).toBe('');
  });
});
