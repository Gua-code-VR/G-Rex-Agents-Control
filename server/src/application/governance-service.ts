import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { budgetPolicySchema, defaultBudgetPolicy, type BudgetPolicy } from '../domain/governance.js';
import type { EventService } from './event-service.js';
import type { NotificationService } from './notification-service.js';

export type GovernanceDecision = 'ALLOW' | 'WARNING' | 'HARD_STOP' | 'REQUIRE_APPROVAL';
type Totals = { inputTokens: number; outputTokens: number; totalTokens: number; costEstimate: number; costActual: number };
const emptyTotals = (): Totals => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costEstimate: 0, costActual: 0 });
function policy(raw: string | null): BudgetPolicy | null { try { return raw ? budgetPolicySchema.parse(JSON.parse(raw)) : null; } catch { return null; } }

export class GovernanceService {
  constructor(private readonly db: DatabaseSync, private readonly events: EventService, private readonly notifications: NotificationService, private readonly fallbackBudget: number | null = null) {}

  setPolicy(scope: 'PROJECT' | 'OBJECTIVE', id: string, input: unknown): BudgetPolicy | null {
    const value = budgetPolicySchema.parse(input);
    const table = scope === 'PROJECT' ? 'projects' : 'objectives';
    const beforeRow = this.db.prepare(`SELECT policy_json FROM ${table} WHERE id = ?`).get(id) as { policy_json: string | null } | undefined;
    if (!beforeRow) return null;
    const previousPolicy = policy(beforeRow.policy_json);
    const result = this.db.prepare(`UPDATE ${table} SET policy_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(value), new Date().toISOString(), id);
    if (!result.changes) return null;
    const projectId = scope === 'PROJECT' ? id : (this.db.prepare('SELECT project_id FROM objectives WHERE id = ?').get(id) as { project_id: string }).project_id;
    this.events.log('governance.policy.updated', { category: 'USER', projectId, objectiveId: scope === 'OBJECTIVE' ? id : null, payload: { scope, previousPolicy, policy: value } });
    return value;
  }

  effectivePolicy(objectiveId: string): BudgetPolicy {
    const row = this.db.prepare('SELECT o.policy_json AS objective_policy, p.policy_json AS project_policy FROM objectives o JOIN projects p ON p.id = o.project_id WHERE o.id = ?').get(objectiveId) as { objective_policy: string | null; project_policy: string | null } | undefined;
    return policy(row?.objective_policy ?? null) ?? policy(row?.project_policy ?? null) ?? { ...defaultBudgetPolicy, costBudget: this.fallbackBudget };
  }

  grantException(objectiveId: string, input: { note?: string; expiresAt?: string | null }): { id: string; expiresAt: string | null } | null {
    const objective = this.db.prepare('SELECT project_id FROM objectives WHERE id = ?').get(objectiveId) as { project_id: string } | undefined;
    if (!objective) return null;
    if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) throw new Error('Scadenza eccezione non valida');
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare('INSERT INTO governance_exceptions (id, objective_id, note, expires_at, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)').run(id, objectiveId, input.note?.trim() || null, input.expiresAt ?? null, now);
    this.events.log('governance.exception.authorized', { category: 'USER', projectId: objective.project_id, objectiveId, payload: { exceptionId: id, note: input.note ?? null, expiresAt: input.expiresAt ?? null } });
    return { id, expiresAt: input.expiresAt ?? null };
  }

  evaluate(objectiveId: string, projectedCost: number): { decision: GovernanceDecision; policy: BudgetPolicy; exceptionId: string | null } {
    const policyValue = this.effectivePolicy(objectiveId);
    const active = this.db.prepare("SELECT id FROM governance_exceptions WHERE objective_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1").get(objectiveId, new Date().toISOString()) as { id: string } | undefined;
    if (active || policyValue.costBudget === null) return { decision: 'ALLOW', policy: policyValue, exceptionId: active?.id ?? null };
    const ratio = projectedCost / policyValue.costBudget;
    if (ratio >= 1) return { decision: policyValue.action === 'WARN' ? 'WARNING' : policyValue.action, policy: policyValue, exceptionId: null };
    return { decision: ratio >= policyValue.warningPercent / 100 ? 'WARNING' : 'ALLOW', policy: policyValue, exceptionId: null };
  }

  recordDecision(objectiveId: string, decision: GovernanceDecision, projectedCost: number): void {
    if (decision === 'ALLOW') return;
    const row = this.db.prepare('SELECT project_id FROM objectives WHERE id = ?').get(objectiveId) as { project_id: string } | undefined;
    if (!row) return;
    this.events.log(`governance.budget.${decision.toLowerCase()}`, { category: 'TECHNICAL', projectId: row.project_id, objectiveId, payload: { projectedCost, decision } });
    this.notifications.notify({ type: 'BUDGET_POLICY', severity: decision === 'WARNING' ? 'warning' : decision === 'HARD_STOP' ? 'critical' : 'warning', title: decision === 'WARNING' ? 'Soglia budget raggiunta' : decision === 'HARD_STOP' ? 'Budget bloccante superato' : 'Approvazione budget richiesta', message: `La policy di budget dell'obiettivo richiede: ${decision}.`, projectId: row.project_id, objectiveId, metadata: { projectedCost, decision } });
  }

  dashboard(projectId: string): unknown {
    const totals = this.aggregate('o.project_id = ?', projectId);
    const objectives = this.db.prepare('SELECT id, title, policy_json FROM objectives WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<{ id: string; title: string; policy_json: string | null }>;
    const breakdown = this.db.prepare(`SELECT COALESCE(e.provider_name, 'unknown') providerName, COALESCE(e.model_name, 'unknown') modelName, COUNT(*) attempts, COALESCE(SUM(e.total_tokens),0) totalTokens, COALESCE(SUM(e.cost_actual), SUM(e.cost_estimate), 0) cost FROM execution_attempts e JOIN sessions s ON s.id=e.session_id JOIN objectives o ON o.id=s.objective_id WHERE o.project_id=? GROUP BY e.provider_name,e.model_name ORDER BY cost DESC`).all(projectId);
    const trend = this.db.prepare(`SELECT substr(e.started_at,1,10) date, COALESCE(SUM(e.cost_actual), SUM(e.cost_estimate), 0) cost, COALESCE(SUM(e.total_tokens),0) totalTokens FROM execution_attempts e JOIN sessions s ON s.id=e.session_id JOIN objectives o ON o.id=s.objective_id WHERE o.project_id=? GROUP BY substr(e.started_at,1,10) ORDER BY date ASC`).all(projectId);
    const projectPolicy = policy((this.db.prepare('SELECT policy_json FROM projects WHERE id=?').get(projectId) as { policy_json: string | null } | undefined)?.policy_json ?? null) ?? { ...defaultBudgetPolicy, costBudget: this.fallbackBudget };
    const used = totals.costActual || totals.costEstimate;
    return { policy: projectPolicy, totals, budget: { used, remaining: projectPolicy.costBudget === null ? null : Number(Math.max(0, projectPolicy.costBudget - used).toFixed(8)) }, breakdown, trend, objectives: objectives.map((o) => ({ id: o.id, title: o.title, policy: policy(o.policy_json), totals: this.aggregate('o.id = ?', o.id) })) };
  }

  private aggregate(where: string, id: string): Totals { return (this.db.prepare(`SELECT COALESCE(SUM(e.input_tokens),0) inputTokens, COALESCE(SUM(e.output_tokens),0) outputTokens, COALESCE(SUM(e.total_tokens),0) totalTokens, COALESCE(SUM(e.cost_estimate),0) costEstimate, COALESCE(SUM(e.cost_actual),0) costActual FROM execution_attempts e JOIN sessions s ON s.id=e.session_id JOIN objectives o ON o.id=s.objective_id WHERE ${where}`).get(id) as Totals | undefined) ?? emptyTotals(); }
}
