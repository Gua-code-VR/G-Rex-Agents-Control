import type { ExecutionProviderRegistry, ProviderCatalogEntry } from '../integrations/execution-provider.js';

export interface PreflightEstimate {
  runtimeId: string; providerId: string; modelId: string | null; available: boolean;
  inputTokens: number; outputTokens: number; totalTokens: number; cost: number | null;
  confidence: 'HIGH' | 'LOW' | 'UNAVAILABLE'; reason: string;
}

/** Consumes only normalized adapter metadata; it never contains CLI-specific rules. */
export class ProviderCatalogService {
  constructor(private readonly providers: ExecutionProviderRegistry) {}
  list(): ProviderCatalogEntry[] { return this.providers.catalog(); }
  estimate(runtimeId: string, objectiveText: string, stopCondition: string | null): PreflightEstimate {
    const entry = this.list().find((item) => item.runtime.id === runtimeId);
    if (!entry) throw new Error('Runtime non supportato');
    const inputTokens = Math.max(1, Math.ceil((objectiveText.length + (stopCondition?.length ?? 0)) / 4));
    const model = entry.models.find((item) => item.id === entry.runtime.defaultModel) ?? entry.models[0] ?? null;
    const outputTokens = model?.limits.defaultOutputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    if (!entry.runtime.available) return { runtimeId, providerId: entry.provider.id, modelId: model?.id ?? null, available: false, inputTokens, outputTokens, totalTokens, cost: null, confidence: 'UNAVAILABLE', reason: 'Runtime non disponibile' };
    if (!model || model.pricing.inputPerMillion === null || model.pricing.outputPerMillion === null) return { runtimeId, providerId: entry.provider.id, modelId: model?.id ?? null, available: true, inputTokens, outputTokens, totalTokens, cost: null, confidence: 'UNAVAILABLE', reason: 'Pricing non configurato per il modello' };
    const cost = inputTokens / 1_000_000 * model.pricing.inputPerMillion + outputTokens / 1_000_000 * model.pricing.outputPerMillion;
    return { runtimeId, providerId: entry.provider.id, modelId: model.id, available: true, inputTokens, outputTokens, totalTokens, cost: Number(cost.toFixed(8)), confidence: 'HIGH', reason: 'Stima deterministica da catalogo e pricing configurato' };
  }
}
