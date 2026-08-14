import type { DatabaseSync } from 'node:sqlite';
import { budgetPolicySchema, defaultBudgetPolicy, type BudgetPolicy } from '../domain/governance.js';
import type { ExecutionRoutingCandidate, ExecutionSelection } from '../domain/objective.js';
import type { ProviderCatalogEntry } from '../integrations/execution-provider.js';
import type { ProviderCatalogService } from './provider-catalog-service.js';

interface BudgetContext { policy: BudgetPolicy; spent: number; remaining: number | null; }

export interface AutomaticSelectionInput {
  projectId: string;
  objectiveText: string;
  stopCondition: string | null;
  defaultRuntime: string;
  requiredCapabilities?: string[];
}

/** Deterministic, provider-agnostic routing based only on normalized catalog and history. */
export class RuntimeSelectionService {
  constructor(private readonly catalog: ProviderCatalogService, private readonly db: DatabaseSync) {}

  select(input: AutomaticSelectionInput): ExecutionSelection {
    let required = [...new Set(input.requiredCapabilities ?? ['code', 'workspace-edit'])].sort();
    const budget = this.budgetContext(input.projectId);
    const catalog = this.catalog.list();
    let entries = catalog.filter((entry) => entry.runtime.type !== 'fake');
    if (input.defaultRuntime === 'fake') {
      entries = catalog.filter((entry) => entry.runtime.id === 'fake');
      required = [];
    }
    const candidates = entries.flatMap((entry) => this.candidates(entry, input, required, budget));
    const eligibleWithCost = candidates.filter((candidate) => candidate.eligible && candidate.estimatedCost !== null);
    const costs = eligibleWithCost.map((candidate) => candidate.estimatedCost!);
    const minCost = costs.length ? Math.min(...costs) : null;
    const maxCost = costs.length ? Math.max(...costs) : null;
    for (const candidate of candidates) {
      if (!candidate.eligible) continue;
      const costScore = candidate.estimatedCost === null ? 0
        : minCost === maxCost ? 20
          : 20 - 15 * ((candidate.estimatedCost - minCost!) / (maxCost! - minCost!));
      candidate.score = Number((40 + candidate.reliability * 30 + costScore
        + (candidate.estimatedCost === null ? 0 : 5) + (candidate.budgetFit ? 5 : 0)).toFixed(4));
    }
    candidates.sort((a, b) => b.score - a.score
      || a.runtimeId.localeCompare(b.runtimeId)
      || (a.modelId ?? '').localeCompare(b.modelId ?? ''));
    const selected = candidates.find((candidate) => candidate.eligible);
    if (!selected) {
      const detail = candidates.flatMap((candidate) => candidate.reasons).filter(Boolean).join('; ');
      throw new Error(`Nessuna combinazione runtime/provider/modello utilizzabile${detail ? `: ${detail}` : ''}`);
    }
    const reason = `Scelta automatica ${selected.runtimeId}/${selected.providerId}/${selected.modelId ?? 'modello-runtime'}: punteggio ${selected.score}; ${selected.reasons.join('; ')}`;
    return {
      runtimeId: selected.runtimeId,
      providerId: selected.providerId,
      modelId: selected.modelId,
      outputTokenLimit: selected.outputTokenLimit,
      decision: {
        mode: 'AUTOMATIC', reason, selectedScore: selected.score,
        requiredCapabilities: required, budget: { ...budget }, candidates,
        decidedAt: new Date().toISOString(),
      },
    };
  }

  private candidates(entry: ProviderCatalogEntry, input: AutomaticSelectionInput, required: string[], budget: BudgetContext): ExecutionRoutingCandidate[] {
    const models = entry.models.length ? entry.models : [null];
    return models.map((model) => {
      const capabilities = new Set([...entry.runtime.capabilities, ...(model?.capabilities ?? [])]);
      const missing = required.filter((capability) => !capabilities.has(capability));
      const estimate = this.catalog.estimateSelection(entry.runtime.id, model?.id ?? null, input.objectiveText, input.stopCondition);
      const reliability = this.reliability(entry.runtime.name, entry.provider.name, model?.id ?? null);
      const reasons = [
        entry.runtime.available ? 'runtime disponibile' : 'runtime non disponibile',
        missing.length ? `capacità mancanti: ${missing.join(', ')}` : `capacità richieste coperte: ${required.join(', ') || 'nessuna'}`,
        `affidabilità ${Math.round(reliability * 100)}%`,
        estimate.cost === null ? 'costo non determinabile' : `costo stimato ${estimate.cost}`,
      ];
      let eligible = entry.runtime.available && missing.length === 0;
      let budgetFit = true;
      if (budget.remaining !== null && estimate.cost !== null && estimate.cost > budget.remaining) {
        budgetFit = false;
        if (budget.policy.action !== 'WARN') eligible = false;
        reasons.push(`oltre budget residuo ${budget.remaining} (${budget.policy.action})`);
      } else if (budget.remaining !== null && estimate.cost === null && budget.policy.action !== 'WARN') {
        budgetFit = false; eligible = false; reasons.push(`costo ignoto non ammesso dalla policy ${budget.policy.action}`);
      } else {
        reasons.push(budget.remaining === null ? 'budget non limitante' : `entro budget residuo ${budget.remaining}`);
      }
      return {
        runtimeId: entry.runtime.id, providerId: entry.provider.id, modelId: model?.id ?? null,
        outputTokenLimit: model?.limits.defaultOutputTokens ?? null,
        eligible, score: eligible ? 0 : -1, reliability, estimatedCost: estimate.cost,
        budgetFit, capabilities: [...capabilities].sort(), reasons,
      };
    });
  }

  private reliability(runtimeName: string, providerName: string, modelId: string | null): number {
    const row = this.db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) completed
      FROM execution_attempts WHERE runtime_name = ? AND provider_name = ? AND COALESCE(model_name, '') = COALESCE(?, '')
        AND status IN ('COMPLETED', 'FAILED', 'CANCELLED')`)
      .get(runtimeName, providerName, modelId) as { total: number; completed: number };
    return Number(((row.completed + 1) / (row.total + 2)).toFixed(4));
  }

  private budgetContext(projectId: string): BudgetContext {
    const row = this.db.prepare('SELECT policy_json FROM projects WHERE id = ?').get(projectId) as { policy_json: string | null } | undefined;
    let policy = defaultBudgetPolicy;
    try { policy = row?.policy_json ? budgetPolicySchema.parse(JSON.parse(row.policy_json)) : defaultBudgetPolicy; } catch { policy = defaultBudgetPolicy; }
    const spentRow = this.db.prepare(`SELECT COALESCE(SUM(COALESCE(e.cost_actual, e.cost_estimate, 0)), 0) spent
      FROM execution_attempts e JOIN sessions s ON s.id = e.session_id JOIN objectives o ON o.id = s.objective_id WHERE o.project_id = ?`).get(projectId) as { spent: number };
    const spent = Number(spentRow.spent ?? 0);
    const remaining = policy.costBudget === null ? null : Number(Math.max(0, policy.costBudget - spent).toFixed(8));
    return { policy, spent, remaining };
  }
}
