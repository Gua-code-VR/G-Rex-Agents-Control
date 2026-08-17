import type { DatabaseSync } from 'node:sqlite';
import { budgetPolicySchema, defaultBudgetPolicy, type BudgetPolicy } from '../domain/governance.js';
import type { ExecutionPerformanceProfile, ExecutionRoutingCandidate, ExecutionSelection, ObjectiveRoutingType } from '../domain/objective.js';
import type { ProviderCatalogEntry } from '../integrations/execution-provider.js';
import type { ProviderCatalogService } from './provider-catalog-service.js';

interface BudgetContext { policy: BudgetPolicy; spent: number; remaining: number | null; }
interface HistoryRow {
  objective_text: string; status: string; attempt_index: number; duration_ms: number | null;
  cost_actual: number | null; cost_estimate: number | null; fallback_of_attempt_id: string | null;
  objective_status: string; checkpoint_outcome: string | null; acceptance_status: string | null;
  decision_type: string | null;
}

function classifyObjective(text: string): ObjectiveRoutingType {
  const value = text.toLocaleLowerCase('it-IT');
  if (/bug|errore|regression|fix|corregg|ripar/.test(value)) return 'BUG_FIX';
  if (/\btest|verific|typecheck|coverage|collaud/.test(value)) return 'TESTING';
  if (/document|readme|manual|guida|specifica/.test(value)) return 'DOCUMENTATION';
  if (/analizz|indag|diagnos|review|audit|spiega/.test(value)) return 'ANALYSIS';
  if (/codice|implement|svilupp|feature|refactor|api|database|ui\b/.test(value)) return 'CODE_CHANGE';
  return 'GENERAL';
}

function aggregateHistory(rows: HistoryRow[]) {
  if (!rows.length) return { qualityScore: 0.5, successRate: 0.5, retryRate: 0, fallbackRate: 0, humanInterventionRate: 0, durationEfficiency: 0.5, averageDurationMs: null, averageCost: null };
  const completed = rows.filter((row) => row.status === 'COMPLETED').length;
  const qualityScore = rows.reduce((sum, row) => sum + qualityOf(row), 0) / rows.length;
  const durations = rows.flatMap((row) => row.duration_ms === null ? [] : [row.duration_ms]);
  const costs = rows.flatMap((row) => row.cost_actual ?? row.cost_estimate ?? null).filter((cost): cost is number => cost !== null);
  const averageDurationMs = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null;
  const averageCost = costs.length ? Number((costs.reduce((sum, value) => sum + value, 0) / costs.length).toFixed(8)) : null;
  return {
    qualityScore, successRate: (completed + 1) / (rows.length + 2),
    retryRate: rows.filter((row) => row.attempt_index > 1).length / rows.length,
    fallbackRate: rows.filter((row) => row.fallback_of_attempt_id !== null).length / rows.length,
    humanInterventionRate: rows.filter((row) => ['REQUEST_CHANGES', 'STOP', 'CANCEL'].includes(row.decision_type ?? '') || ['BLOCKED', 'INTERRUPTED', 'ERROR'].includes(row.checkpoint_outcome ?? '')).length / rows.length,
    durationEfficiency: averageDurationMs === null ? 0.5 : 1 / (1 + averageDurationMs / 300_000), averageDurationMs, averageCost,
  };
}

function qualityOf(row: HistoryRow): number {
  if (row.acceptance_status === 'MET' || row.decision_type === 'APPROVE' || row.objective_status === 'COMPLETATO') return 1;
  if (row.acceptance_status === 'NOT_MET' || ['REQUEST_CHANGES', 'STOP', 'CANCEL'].includes(row.decision_type ?? '')) return 0;
  return row.status === 'COMPLETED' ? 0.7 : 0;
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function round(value: number): number { return Number(value.toFixed(4)); }

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
    return this.evaluate(input, null);
  }

  /** Ri-selezione automatica per retry/fallback (M18): vincola il runtime. */
  selectForRuntime(runtimeId: string, input: AutomaticSelectionInput): ExecutionSelection {
    return this.evaluate(input, runtimeId);
  }

  private evaluate(input: AutomaticSelectionInput, runtimeFilter: string | null): ExecutionSelection {
    let required = [...new Set(input.requiredCapabilities ?? ['code', 'workspace-edit'])].sort();
    const budget = this.budgetContext(input.projectId);
    const objectiveType = classifyObjective(input.objectiveText);
    const catalog = this.catalog.list();
    let entries = catalog;
    if (runtimeFilter !== null) {
      entries = catalog.filter((entry) => entry.runtime.id === runtimeFilter);
      if (runtimeFilter === 'fake') required = [];
    } else {
      entries = catalog.filter((entry) => entry.runtime.type !== 'fake');
      if (input.defaultRuntime === 'fake') {
        entries = catalog.filter((entry) => entry.runtime.id === 'fake');
        required = [];
      }
    }
    const candidates = entries.flatMap((entry) => this.candidates(entry, input, required, budget, objectiveType));
    const historicalCosts = candidates.flatMap((candidate) => candidate.performance?.averageCost ?? null).filter((cost): cost is number => cost !== null);
    const minHistoricalCost = historicalCosts.length ? Math.min(...historicalCosts) : null;
    const maxHistoricalCost = historicalCosts.length ? Math.max(...historicalCosts) : null;
    for (const candidate of candidates) {
      if (!candidate.performance) continue;
      const averageCost = candidate.performance.averageCost;
      const costEfficiency = averageCost === null ? 0.5
        : minHistoricalCost === maxHistoricalCost ? 1
          : 1 - ((averageCost - minHistoricalCost!) / (maxHistoricalCost! - minHistoricalCost!));
      candidate.performance.costEfficiency = round(costEfficiency);
      candidate.performance.adaptiveScore = round(candidate.performance.adaptiveScore * 0.9 + costEfficiency * 0.1);
    }
    const eligibleWithCost = candidates.filter((candidate) => candidate.eligible && candidate.estimatedCost !== null);
    const costs = eligibleWithCost.map((candidate) => candidate.estimatedCost!);
    const minCost = costs.length ? Math.min(...costs) : null;
    const maxCost = costs.length ? Math.max(...costs) : null;
    for (const candidate of candidates) {
      if (!candidate.eligible) continue;
      const costScore = candidate.estimatedCost === null ? 0
        : minCost === maxCost ? 20
          : 20 - 15 * ((candidate.estimatedCost - minCost!) / (maxCost! - minCost!));
      const adaptiveScore = candidate.performance?.adaptiveScore ?? 0.5;
      candidate.score = Number((35 + candidate.reliability * 20 + adaptiveScore * 25 + costScore
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
    const reason = `Scelta automatica adattiva ${selected.runtimeId}/${selected.providerId}/${selected.modelId ?? 'modello-runtime'} per ${objectiveType}: punteggio ${selected.score}; ${selected.reasons.join('; ')}`;
    return {
      runtimeId: selected.runtimeId,
      providerId: selected.providerId,
      modelId: selected.modelId,
      outputTokenLimit: selected.outputTokenLimit,
      decision: {
        mode: 'AUTOMATIC', reason, selectedScore: selected.score,
        requiredCapabilities: required, budget: { ...budget }, candidates,
        objectiveType, learningVersion: 'M18-v1',
        decidedAt: new Date().toISOString(),
      },
    };
  }

  private candidates(entry: ProviderCatalogEntry, input: AutomaticSelectionInput, required: string[], budget: BudgetContext, objectiveType: ObjectiveRoutingType): ExecutionRoutingCandidate[] {
    const models = entry.models.length ? entry.models : [null];
    return models.map((model) => {
      const capabilities = new Set([...entry.runtime.capabilities, ...(model?.capabilities ?? [])]);
      const missing = required.filter((capability) => !capabilities.has(capability));
      const estimate = this.catalog.estimateSelection(entry.runtime.id, entry.provider.id, model?.id ?? null, input.objectiveText, input.stopCondition);
      const performance = this.performance(entry.runtime.name, entry.provider.name, model?.id ?? null, objectiveType);
      const reliability = performance.successRate;
      const reasons = [
        entry.runtime.available ? 'runtime disponibile' : 'runtime non disponibile',
        missing.length ? `capacità mancanti: ${missing.join(', ')}` : `capacità richieste coperte: ${required.join(', ') || 'nessuna'}`,
        `affidabilità ${Math.round(reliability * 100)}%`,
        performance.globalSampleSize === 0
          ? `nessuno storico: profilo neutro per ${performance.objectiveType}`
          : `apprendimento ${performance.objectiveType}: ${performance.sampleSize}/${performance.globalSampleSize} campioni, qualita ${Math.round(performance.qualityScore * 100)}%, retry ${Math.round(performance.retryRate * 100)}%, fallback ${Math.round(performance.fallbackRate * 100)}%, interventi umani ${Math.round(performance.humanInterventionRate * 100)}%, durata media ${performance.averageDurationMs ?? 'n/d'} ms, costo medio ${performance.averageCost ?? 'n/d'}, efficienza costo ${Math.round(performance.costEfficiency * 100)}%`,
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
      if (model?.limits.contextTokens != null && estimate.inputTokens > model.limits.contextTokens) {
        eligible = false;
        reasons.push(`contesto oltre la finestra del modello (${estimate.inputTokens} > ${model.limits.contextTokens} token)`);
      }
      return {
        runtimeId: entry.runtime.id, providerId: entry.provider.id, modelId: model?.id ?? null,
        outputTokenLimit: model?.limits.defaultOutputTokens ?? null,
        eligible, score: eligible ? 0 : -1, reliability, estimatedCost: estimate.cost,
        budgetFit, capabilities: [...capabilities].sort(), reasons, performance,
      };
    });
  }

  private performance(runtimeName: string, providerName: string, modelId: string | null, objectiveType: ObjectiveRoutingType): ExecutionPerformanceProfile {
    const rows = this.db.prepare(`SELECT o.objective_text, e.status, e.attempt_index, e.duration_ms, e.cost_actual, e.cost_estimate,
        e.fallback_of_attempt_id, o.status objective_status,
        (SELECT c.outcome FROM checkpoints c WHERE c.session_id = s.id ORDER BY c.created_at DESC LIMIT 1) checkpoint_outcome,
        (SELECT c.acceptance_status FROM checkpoints c WHERE c.session_id = s.id ORDER BY c.created_at DESC LIMIT 1) acceptance_status,
        (SELECT h.decision_type FROM human_decisions h JOIN checkpoints c ON c.id = h.checkpoint_id
          WHERE c.session_id = s.id ORDER BY h.decided_at DESC LIMIT 1) decision_type
      FROM execution_attempts e JOIN sessions s ON s.id = e.session_id JOIN objectives o ON o.id = s.objective_id
      WHERE e.runtime_name = ? AND e.provider_name = ? AND COALESCE(e.model_name, '') = COALESCE(?, '')
        AND e.status IN ('COMPLETED', 'FAILED', 'CANCELLED')`)
      .all(runtimeName, providerName, modelId) as unknown as HistoryRow[];
    const typed = rows.filter((row) => classifyObjective(row.objective_text) === objectiveType);
    const global = aggregateHistory(rows);
    const specific = aggregateHistory(typed);
    const typeWeight = typed.length / (typed.length + 3);
    const blend = (typedValue: number, globalValue: number, neutral: number): number => {
      const baseline = rows.length ? globalValue : neutral;
      return typed.length ? typedValue * typeWeight + baseline * (1 - typeWeight) : baseline;
    };
    const qualityScore = blend(specific.qualityScore, global.qualityScore, 0.5);
    const successRate = blend(specific.successRate, global.successRate, 0.5);
    const retryRate = blend(specific.retryRate, global.retryRate, 0);
    const fallbackRate = blend(specific.fallbackRate, global.fallbackRate, 0);
    const humanInterventionRate = blend(specific.humanInterventionRate, global.humanInterventionRate, 0);
    const durationEfficiency = blend(specific.durationEfficiency, global.durationEfficiency, 0.5);
    const adaptiveScore = clamp(qualityScore * 0.35 + successRate * 0.25 + durationEfficiency * 0.15
      + (1 - retryRate) * 0.1 + (1 - fallbackRate) * 0.05 + (1 - humanInterventionRate) * 0.1);
    return {
      objectiveType, sampleSize: typed.length, globalSampleSize: rows.length,
      qualityScore: round(qualityScore), successRate: round(successRate), retryRate: round(retryRate),
      fallbackRate: round(fallbackRate), humanInterventionRate: round(humanInterventionRate),
      averageDurationMs: specific.averageDurationMs ?? global.averageDurationMs,
      averageCost: specific.averageCost ?? global.averageCost, costEfficiency: 0.5, adaptiveScore: round(adaptiveScore),
    };
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
