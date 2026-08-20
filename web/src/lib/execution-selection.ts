import type { ProviderCatalogEntry } from '../api/client';
import { filterOperationalCatalog, modelsForProvider, providersForRuntime } from './provider-catalog';

/**
 * Sorgente unica per la selezione Runtime/Provider/Modello.
 *
 * Tutte le schermate (creazione obiettivo, conferma, cambio agente) usano le
 * stesse opzioni normalizzate e la stessa etichetta, così la semantica resta
 * uniforme e il runtime di test `fake` è nascosto quando esiste un runtime
 * reale disponibile (regola V2).
 */

export interface ExecutionSelectionValue {
  runtimeId: string;
  providerId: string;
  modelId: string;
}

export interface SelectionOption extends ExecutionSelectionValue {
  /** Id normalizzato separato da `|` per i selettori a singola voce. */
  value: string;
  label: string;
  runtimeName: string;
  providerName: string;
  modelName: string | null;
}

/** Id normalizzato della combinazione (usato come `value` nei selettori). */
export function selectionValue(selection: ExecutionSelectionValue): string {
  return `${selection.runtimeId}|${selection.providerId}|${selection.modelId}`;
}

/** Etichetta leggibile di una combinazione runtime/provider/modello. */
export function selectionLabel(runtimeName: string, providerName: string, modelName: string | null): string {
  return modelName
    ? `${runtimeName} · ${providerName} · ${modelName}`
    : `${runtimeName} · ${providerName} · modello gestito dal runtime`;
}

/** Costruisce l'elenco completo di combinazioni (runtime×provider×modello) dal
 *  catalogo operativo, deduplicate per id. Provider senza modelli producono una
 *  sola voce con modello gestito dal runtime. `fake` è nascosto se operativo. */
export function buildSelectionOptions(catalog: ProviderCatalogEntry[]): SelectionOption[] {
  const operational = filterOperationalCatalog(catalog);
  const seen = new Set<string>();
  const options: SelectionOption[] = [];

  const runtimeById = new Map<string, { id: string; name: string }>();
  for (const entry of operational) runtimeById.set(entry.runtime.id, { id: entry.runtime.id, name: entry.runtime.name });

  for (const runtime of runtimeById.values()) {
    for (const provider of providersForRuntime(operational, runtime.id)) {
      const models = modelsForProvider(operational, runtime.id, provider.id);
      const modelList = models.length > 0 ? models : [null];
      for (const model of modelList) {
        const modelId = model?.id ?? '';
        const value = selectionValue({ runtimeId: runtime.id, providerId: provider.id, modelId });
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({
          runtimeId: runtime.id,
          providerId: provider.id,
          modelId,
          value,
          runtimeName: runtime.name,
          providerName: provider.name,
          modelName: model?.name ?? null,
          label: selectionLabel(runtime.name, provider.name, model?.name ?? null),
        });
      }
    }
  }
  return options;
}
