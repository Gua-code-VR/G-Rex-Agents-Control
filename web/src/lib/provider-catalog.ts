import type { ProviderCatalogEntry } from '../api/client';

/** Entry del catalogo per (runtime, provider). Il catalogo può dichiararne più
 *  di una per lo stesso provider (es. più provider dell'archivio G-Rex Pricing
 *  mappati alla stessa chiave CLI): il modello scelto può appartenere a una
 *  qualunque di esse. */
export function catalogEntriesFor(
  catalog: ProviderCatalogEntry[],
  runtimeId: string,
  providerId: string,
): ProviderCatalogEntry[] {
  return catalog.filter(
    (entry) => entry.runtime.id === runtimeId && entry.provider.id === providerId,
  );
}

/** Unione dei modelli dichiarati per il provider selezionato, deduplicati per id. */
export function modelsForProvider(
  catalog: ProviderCatalogEntry[],
  runtimeId: string,
  providerId: string,
): ProviderCatalogEntry['models'] {
  const byId = new Map<string, ProviderCatalogEntry['models'][number]>();
  for (const entry of catalogEntriesFor(catalog, runtimeId, providerId)) {
    for (const model of entry.models) {
      if (!byId.has(model.id)) byId.set(model.id, model);
    }
  }
  return [...byId.values()];
}

/** Provider distinti per un runtime, deduplicati (più entry possono condividere lo stesso provider). */
export function providersForRuntime(
  catalog: ProviderCatalogEntry[],
  runtimeId: string,
): Array<{ id: string; name: string }> {
  const seen = new Set<string>();
  const providers: Array<{ id: string; name: string }> = [];
  for (const entry of catalog) {
    if (entry.runtime.id !== runtimeId) continue;
    if (seen.has(entry.provider.id)) continue;
    seen.add(entry.provider.id);
    providers.push({ id: entry.provider.id, name: entry.provider.name });
  }
  return providers;
}

/** Modello predefinito del provider: primo defaultModel dichiarato tra le entry,
 *  altrimenti primo modello dell'unione. Stringa vuota = modello gestito dal runtime. */
export function defaultModelId(
  catalog: ProviderCatalogEntry[],
  runtimeId: string,
  providerId: string,
): string {
  const entries = catalogEntriesFor(catalog, runtimeId, providerId);
  const declared = entries.map((entry) => entry.runtime.defaultModel).find(Boolean);
  return declared ?? modelsForProvider(catalog, runtimeId, providerId)[0]?.id ?? '';
}
