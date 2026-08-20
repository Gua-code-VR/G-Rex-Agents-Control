import { describe, expect, it } from 'vitest';
import type { ExecutionProvider, ProviderCatalogEntry } from '../src/api/client';
import { filterOperationalCatalog, filterOperationalProviders } from '../src/lib/provider-catalog';

/** Entry di catalogo valida: runtime cli con defaultModel null, provider nudo, nessun modello. */
function entry(runtimeId: string, providerId: string, available: boolean, providerName?: string): ProviderCatalogEntry {
  return {
    runtime: {
      id: runtimeId,
      name: runtimeId,
      type: 'cli',
      available,
      defaultModel: null,
      capabilities: [],
      version: null,
    },
    provider: { id: providerId, name: providerName ?? providerId },
    models: [],
  };
}

/** Provider configurato (SystemView): {id, runtimeName, providerName, configured}. */
function provider(id: string, configured: boolean): ExecutionProvider {
  return { id, runtimeName: id, providerName: id, configured };
}

describe('filterOperationalCatalog — i runtime di test non partecipano al routing operativo', () => {
  it('con un runtime reale available restituisce SOLO il runtime reale (fake escluso)', () => {
    const catalog = [
      entry('cline', 'p1', true, 'Anthropic'),
      entry('fake', 'p2', true, 'Fake Prov'),
    ];
    const result = filterOperationalCatalog(catalog);
    expect(result).toHaveLength(1);
    expect(result[0].runtime.id).toBe('cline');
    expect(result.some((e) => e.runtime.id === 'fake')).toBe(false);
  });

  it('con SOLO fake (available) lo restituisce: fallback in ambiente di test', () => {
    const catalog = [entry('fake', 'p1', true, 'Fake Prov')];
    const result = filterOperationalCatalog(catalog);
    expect(result).toHaveLength(1);
    expect(result[0].runtime.id).toBe('fake');
  });

  it('con fake available e nessun runtime reale available restituisce entrambi', () => {
    const catalog = [
      entry('fake', 'p1', true, 'Fake Prov'),
      entry('cline', 'p2', false, 'Cline'),
    ];
    const result = filterOperationalCatalog(catalog);
    expect(result.map((e) => e.runtime.id).sort()).toEqual(['cline', 'fake']);
  });
});

describe('filterOperationalProviders — analogo per i provider configurati', () => {
  it('con un provider reale configured restituisce SOLO quello reale (fake escluso)', () => {
    const providers = [
      provider('cline', true),
      provider('fake', true),
    ];
    const result = filterOperationalProviders(providers);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cline');
    expect(result.some((p) => p.id === 'fake')).toBe(false);
  });

  it('con SOLO fake (configured) lo restituisce: fallback in ambiente di test', () => {
    const result = filterOperationalProviders([provider('fake', true)]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('fake');
  });

  it('con fake configured e nessun provider reale configured restituisce entrambi', () => {
    const providers = [
      provider('fake', true),
      provider('cline', false),
    ];
    const result = filterOperationalProviders(providers);
    expect(result.map((p) => p.id).sort()).toEqual(['cline', 'fake']);
  });
});
