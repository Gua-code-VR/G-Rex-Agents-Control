import { describe, expect, it } from 'vitest';
import type { ProviderCatalogEntry } from '../src/api/client';
import { buildSelectionOptions, selectionValue } from '../src/lib/execution-selection';

function entry(opts: {
  runtimeId: string;
  runtimeName?: string;
  providerId: string;
  providerName?: string;
  modelIds?: string[];
  available?: boolean;
}): ProviderCatalogEntry {
  return {
    runtime: {
      id: opts.runtimeId,
      name: opts.runtimeName ?? opts.runtimeId,
      type: 'cli',
      available: opts.available ?? true,
      defaultModel: null,
      capabilities: [],
      version: null,
    },
    provider: { id: opts.providerId, name: opts.providerName ?? opts.providerId },
    models: (opts.modelIds ?? []).map((id) => ({
      id,
      name: id,
      version: null,
      capabilities: [],
      limits: { contextTokens: null, defaultOutputTokens: 1000 },
      pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
      pricingSchedule: null,
    })),
  };
}

describe('execution-selection — selezione Runtime/Provider/Modello', () => {
  it('catalogo reale con 1 runtime, 1 provider, 1 modello produce 1 opzione completa', () => {
    const catalog = [
      entry({ runtimeId: 'cline', runtimeName: 'Cline', providerId: 'p1', providerName: 'Anthropic', modelIds: ['claude'] }),
    ];
    const options = buildSelectionOptions(catalog);
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('cline|p1|claude');
    expect(options[0].label).toBe('Cline · Anthropic · claude');
    expect(options[0].runtimeName).toBe('Cline');
    expect(options[0].providerName).toBe('Anthropic');
    expect(options[0].modelName).not.toBeNull();
  });

  it('provider senza modelli produce una voce con modello gestito dal runtime', () => {
    const catalog = [
      entry({ runtimeId: 'cline', runtimeName: 'Cline', providerId: 'p1', providerName: 'Anthropic', modelIds: [] }),
    ];
    const options = buildSelectionOptions(catalog);
    expect(options).toHaveLength(1);
    expect(options[0].modelId).toBe('');
    expect(options[0].modelName).toBeNull();
    expect(options[0].value).toBe('cline|p1|');
    expect(options[0].label).toContain('modello gestito dal runtime');
  });

  it('nasconde il runtime fake quando esiste un runtime reale available', () => {
    const catalog = [
      entry({ runtimeId: 'cline', runtimeName: 'Cline', providerId: 'p1', providerName: 'Anthropic', modelIds: ['claude'] }),
      entry({ runtimeId: 'fake', runtimeName: 'Fake', providerId: 'p2', providerName: 'Fake Prov', modelIds: ['m'] }),
    ];
    const options = buildSelectionOptions(catalog);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.runtimeId === 'fake')).toBe(false);
    expect(options.some((o) => o.value.startsWith('fake|'))).toBe(false);
  });

  it('selectionValue normalizza la combinazione con modello vuoto', () => {
    expect(selectionValue({ runtimeId: 'a', providerId: 'b', modelId: '' })).toBe('a|b|');
  });
  it('Codex con account ChatGPT (catalogo senza codex-default) propone solo il modello gestito dal runtime', () => {
    const catalog = [
      entry({ runtimeId: 'codex', runtimeName: 'Codex CLI', providerId: 'openai-codex', providerName: 'OpenAI Codex', modelIds: [] }),
    ];
    const options = buildSelectionOptions(catalog);
    expect(options).toHaveLength(1);
    expect(options[0].modelId).toBe('');
    expect(options[0].modelName).toBeNull();
    expect(options[0].label).toContain('modello gestito dal runtime');
    expect(options[0].label).not.toContain('codex-default');
    expect(options.some((o) => o.modelId === 'codex-default')).toBe(false);
  });

});
