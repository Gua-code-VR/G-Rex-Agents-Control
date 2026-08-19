import type { ExecutionProviderRegistry, ProviderCatalogEntry } from '../integrations/execution-provider.js';
import type { ExecutionSelection } from '../domain/objective.js';

export interface PreflightEstimate {
  runtimeId: string; providerId: string; modelId: string | null; available: boolean;
  inputTokens: number; outputTokens: number; totalTokens: number; cost: number | null;
  confidence: 'HIGH' | 'LOW' | 'UNAVAILABLE'; reason: string;
}

/**
 * Normalizza un modelId proveniente dal client: `undefined`, `null`, stringa
 * vuota e la stringa letterale `"null"` equivalgono a «modello non specificato»
 * (modello gestito dal runtime). Gli altri identificatori restano invariati.
 */
export function normalizeModelId(modelId: string | null | undefined): string | null {
  if (modelId === null || modelId === undefined) return null;
  const trimmed = modelId.trim();
  return trimmed === '' || trimmed.toLowerCase() === 'null' ? null : trimmed;
}

/** Unione di modelli deduplicati per id (una stessa chiave CLI può avere più entry nel catalogo). */
function uniqueModels(models: ProviderCatalogEntry['models']): ProviderCatalogEntry['models'] {
  const seen = new Set<string>();
  const result: ProviderCatalogEntry['models'] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

/** Consumes only normalized adapter metadata; it never contains CLI-specific rules. */
export class ProviderCatalogService {
  constructor(private readonly providers: ExecutionProviderRegistry) {}
  list(): ProviderCatalogEntry[] { return this.providers.catalog(); }
  /**
   * Entry del catalogo per (runtime, provider). Il catalogo può dichiararne più
   * di una per lo stesso provider (es. più provider dell'archivio G-Rex Pricing
   * mappati alla stessa chiave CLI): il modello scelto può appartenere a una
   * qualunque di esse, quindi la validazione opera sull'unione dei modelli.
   */
  private providerEntries(runtimeId: string, providerId: string): ProviderCatalogEntry[] {
    return this.list().filter((item) => item.runtime.id === runtimeId && item.provider.id === providerId);
  }
  resolve(input: Partial<ExecutionSelection> & { runtimeId: string }): ExecutionSelection {
    const entries = this.list().filter((item) => item.runtime.id === input.runtimeId);
    if (!entries.length) throw new Error(`Runtime non supportato: ${input.runtimeId}`);
    const providerEntries = input.providerId
      ? entries.filter((item) => item.provider.id === input.providerId)
      : [entries.find((item) => item.runtime.available) ?? entries[0]];
    const entry = providerEntries[0];
    if (!entry) throw new Error(`Provider ${input.providerId} non compatibile con runtime ${input.runtimeId}`);
    if (!entry.runtime.available) throw new Error(`Runtime non disponibile: ${entry.runtime.name}`);
    const models = uniqueModels(providerEntries.flatMap((item) => item.models));
    // Un modelId assente (null/undefined/vuoto/"null") è valido quando il
    // catalogo dichiara il modello come gestito dal runtime (entry senza modelli);
    // per i provider con modelli dichiarati la validazione resta invariata.
    const requestedModelId = normalizeModelId(input.modelId);
    const modelId = requestedModelId
      ?? providerEntries.map((item) => item.runtime.defaultModel).find(Boolean)
      ?? models[0]?.id ?? null;
    if (modelId && !models.some((model) => model.id === modelId)) throw new Error(`Modello ${modelId} non disponibile per ${entry.runtime.name}`);
    if (!modelId && models.length > 0) throw new Error(`Seleziona un modello per ${entry.runtime.name}`);
    const model = modelId ? models.find((item) => item.id === modelId)! : null;
    const outputTokenLimit = input.outputTokenLimit ?? null;
    if (outputTokenLimit !== null && model && model.limits.defaultOutputTokens > 0 && outputTokenLimit > model.limits.defaultOutputTokens) throw new Error(`Limite output ${outputTokenLimit} oltre il massimo catalogato (${model.limits.defaultOutputTokens})`);
    return {
      runtimeId: entry.runtime.id, providerId: entry.provider.id, modelId, outputTokenLimit,
      ...(input.decision ? { decision: input.decision } : {}),
    };
  }
  estimate(runtimeId: string, objectiveText: string, stopCondition: string | null): PreflightEstimate {
    const entries = this.list().filter((item) => item.runtime.id === runtimeId);
    const inputTokens = Math.max(1, Math.ceil((objectiveText.length + (stopCondition?.length ?? 0)) / 4));
    if (!entries.length) {
      return { runtimeId, providerId: runtimeId, modelId: null, available: false, inputTokens, outputTokens: 0, totalTokens: inputTokens, cost: null, confidence: 'UNAVAILABLE', reason: 'Runtime non disponibile' };
    }
    let best: PreflightEstimate | null = null;
    for (const entry of entries) {
      const model = entry.models.find((item) => item.id === entry.runtime.defaultModel) ?? entry.models[0] ?? null;
      const candidate = this.estimateModel(entry, model, inputTokens);
      if (candidate.cost !== null && (best === null || (best.cost !== null && candidate.cost < best.cost))) best = candidate;
      else if (best === null) best = candidate;
    }
    return best!;
  }
  estimateSelection(runtimeId: string, providerId: string, modelId: string | null, objectiveText: string, stopCondition: string | null): PreflightEstimate {
    const providerEntries = this.providerEntries(runtimeId, providerId);
    // Il modello può appartenere a una qualunque entry del provider: usa quella
    // che lo dichiara (fallback alla prima) per una stima corretta.
    const entry = (modelId !== null ? providerEntries.find((item) => item.models.some((m) => m.id === modelId)) : undefined) ?? providerEntries[0];
    if (!entry) throw new Error('Runtime non supportato');
    const inputTokens = Math.max(1, Math.ceil((objectiveText.length + (stopCondition?.length ?? 0)) / 4));
    const model = modelId === null ? null : entry.models.find((item) => item.id === modelId) ?? null;
    return this.estimateModel(entry, model, inputTokens);
  }
  /** Nome visualizzato del provider (per gli attempt), fallback al providerId. */
  providerName(runtimeId: string, providerId: string): string | null {
    return this.list().find((item) => item.runtime.id === runtimeId && item.provider.id === providerId)?.provider.name ?? null;
  }
  /** Prezzo per token risolto (cache-miss/cache-hit) del modello, per il consuntivo
   *  calcolato dai token reali quando il runtime non restituisce un costo monetario. */
  tokenPricing(runtimeId: string, providerId: string, modelId: string | null): { inputPerToken: number | null; outputPerToken: number | null; cachedInputPerToken: number | null; cachedOutputPerToken: number | null; extra: Record<string, number> } | null {
    const providerEntries = this.providerEntries(runtimeId, providerId);
    // Prezzo del modello dichiarato da una qualunque entry del provider
    // (fallback alla prima entry quando il modello non è specificato).
    const entry = (modelId !== null ? providerEntries.find((item) => item.models.some((m) => m.id === modelId)) : undefined) ?? providerEntries[0];
    const model = entry?.models.find((m) => m.id === modelId) ?? entry?.models[0] ?? null;
    const pricing = model?.pricing;
    if (!pricing) return null;
    const inputPerToken =
      pricing.inputPerToken ??
      (pricing.inputPerMillion != null ? pricing.inputPerMillion / 1_000_000 : null);
    const outputPerToken =
      pricing.outputPerToken ??
      (pricing.outputPerMillion != null ? pricing.outputPerMillion / 1_000_000 : null);
    if (inputPerToken == null && outputPerToken == null) return null;
    return {
      inputPerToken,
      outputPerToken,
      cachedInputPerToken: pricing.cachedInputPerToken ?? null,
      cachedOutputPerToken: pricing.cachedOutputPerToken ?? null,
      extra: pricing.extra ?? {},
    };
  }
  private estimateModel(entry: ProviderCatalogEntry, model: ProviderCatalogEntry['models'][number] | null, inputTokens: number): PreflightEstimate {
    const runtimeId = entry.runtime.id;
    const outputTokens = model?.limits.defaultOutputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    // La disponibilità della CLI è un fatto operativo separato dal listino:
    // la stima di costo dal pricing dichiarato resta deterministica anche
    // quando il runtime non è installato sul sistema (available resta false).
    if (!model || model.pricing.inputPerMillion === null || model.pricing.outputPerMillion === null) return { runtimeId, providerId: entry.provider.id, modelId: model?.id ?? null, available: entry.runtime.available, inputTokens, outputTokens, totalTokens, cost: null, confidence: 'UNAVAILABLE', reason: 'Pricing non configurato per il modello' };
    const cost = inputTokens / 1_000_000 * model.pricing.inputPerMillion + outputTokens / 1_000_000 * model.pricing.outputPerMillion;
    return { runtimeId, providerId: entry.provider.id, modelId: model.id, available: entry.runtime.available, inputTokens, outputTokens, totalTokens, cost: Number(cost.toFixed(8)), confidence: 'HIGH', reason: 'Stima deterministica da catalogo e pricing configurato' };
  }
}
