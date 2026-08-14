import type { ExecutionProviderRegistry, ProviderCatalogEntry } from '../integrations/execution-provider.js';
import type { ExecutionSelection } from '../domain/objective.js';

export interface PreflightEstimate {
  runtimeId: string; providerId: string; modelId: string | null; available: boolean;
  inputTokens: number; outputTokens: number; totalTokens: number; cost: number | null;
  confidence: 'HIGH' | 'LOW' | 'UNAVAILABLE'; reason: string;
}

/** Consumes only normalized adapter metadata; it never contains CLI-specific rules. */
export class ProviderCatalogService {
  constructor(private readonly providers: ExecutionProviderRegistry) {}
  list(): ProviderCatalogEntry[] { return this.providers.catalog(); }
  resolve(input: Partial<ExecutionSelection> & { runtimeId: string }): ExecutionSelection {
    const entry = this.list().find((item) => item.runtime.id === input.runtimeId);
    if (!entry) throw new Error(`Runtime non supportato: ${input.runtimeId}`);
    if (!entry.runtime.available) throw new Error(`Runtime non disponibile: ${entry.runtime.name}`);
    if (input.providerId && input.providerId !== entry.provider.id) throw new Error(`Provider ${input.providerId} non compatibile con runtime ${entry.runtime.name}`);
    const modelId = input.modelId ?? entry.runtime.defaultModel ?? entry.models[0]?.id ?? null;
    if (modelId && !entry.models.some((model) => model.id === modelId)) throw new Error(`Modello ${modelId} non disponibile per ${entry.runtime.name}`);
    if (!modelId && entry.models.length > 0) throw new Error(`Seleziona un modello per ${entry.runtime.name}`);
    const model = modelId ? entry.models.find((item) => item.id === modelId)! : null;
    const outputTokenLimit = input.outputTokenLimit ?? null;
    if (outputTokenLimit !== null && model && model.limits.defaultOutputTokens > 0 && outputTokenLimit > model.limits.defaultOutputTokens) throw new Error(`Limite output ${outputTokenLimit} oltre il massimo catalogato (${model.limits.defaultOutputTokens})`);
    return {
      runtimeId: entry.runtime.id, providerId: entry.provider.id, modelId, outputTokenLimit,
      ...(input.decision ? { decision: input.decision } : {}),
    };
  }
  estimate(runtimeId: string, objectiveText: string, stopCondition: string | null): PreflightEstimate {
    const entry = this.list().find((item) => item.runtime.id === runtimeId);
    if (!entry) throw new Error('Runtime non supportato');
    const inputTokens = Math.max(1, Math.ceil((objectiveText.length + (stopCondition?.length ?? 0)) / 4));
    const model = entry.models.find((item) => item.id === entry.runtime.defaultModel) ?? entry.models[0] ?? null;
    return this.estimateModel(entry, model, inputTokens);
  }
  estimateSelection(runtimeId: string, modelId: string | null, objectiveText: string, stopCondition: string | null): PreflightEstimate {
    const entry = this.list().find((item) => item.runtime.id === runtimeId);
    if (!entry) throw new Error('Runtime non supportato');
    const inputTokens = Math.max(1, Math.ceil((objectiveText.length + (stopCondition?.length ?? 0)) / 4));
    const model = modelId === null ? null : entry.models.find((item) => item.id === modelId) ?? null;
    return this.estimateModel(entry, model, inputTokens);
  }
  private estimateModel(entry: ProviderCatalogEntry, model: ProviderCatalogEntry['models'][number] | null, inputTokens: number): PreflightEstimate {
    const runtimeId = entry.runtime.id;
    const outputTokens = model?.limits.defaultOutputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    if (!entry.runtime.available) return { runtimeId, providerId: entry.provider.id, modelId: model?.id ?? null, available: false, inputTokens, outputTokens, totalTokens, cost: null, confidence: 'UNAVAILABLE', reason: 'Runtime non disponibile' };
    if (!model || model.pricing.inputPerMillion === null || model.pricing.outputPerMillion === null) return { runtimeId, providerId: entry.provider.id, modelId: model?.id ?? null, available: true, inputTokens, outputTokens, totalTokens, cost: null, confidence: 'UNAVAILABLE', reason: 'Pricing non configurato per il modello' };
    const cost = inputTokens / 1_000_000 * model.pricing.inputPerMillion + outputTokens / 1_000_000 * model.pricing.outputPerMillion;
    return { runtimeId, providerId: entry.provider.id, modelId: model.id, available: true, inputTokens, outputTokens, totalTokens, cost: Number(cost.toFixed(8)), confidence: 'HIGH', reason: 'Stima deterministica da catalogo e pricing configurato' };
  }
}
