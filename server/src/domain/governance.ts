import { z } from 'zod';

/** Policy economica indipendente dal runtime: Cline, Codex e i futuri provider
 * producono gli stessi dati normalizzati e non entrano in questa decisione. */
export const budgetPolicySchema = z.object({
  costBudget: z.number().finite().positive().nullable(),
  warningPercent: z.number().finite().min(1).max(100).default(80),
  action: z.enum(['WARN', 'HARD_STOP', 'REQUIRE_APPROVAL']).default('WARN'),
});

export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;
export const defaultBudgetPolicy: BudgetPolicy = { costBudget: null, warningPercent: 80, action: 'WARN' };
