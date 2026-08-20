import { describe, expect, it } from 'vitest';
import { nativeWorkflowDirective, withNativeWorkflowDirective } from '../src/application/native-workflow.js';
import type { Objective } from '../src/domain/objective.js';

const objective = {
  id: 'o1', projectId: 'p1', title: 'Workflow', objectiveText: 'Implementa la modifica', invariants: [], acceptanceCriteria: ['Test verdi'], stopCondition: null,
  status: 'IN_AVVIO', startedAt: null, completedAt: null, finalReport: null, gitStart: null, gitEnd: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', policy: null, estimatedCost: null,
} satisfies Objective;

describe('native multi-worker workflow policy', () => {
  it('abilita solo i runtime configurati e conserva il Control Plane come autorità', () => {
    const directive = nativeWorkflowDirective({ enabled: true, maxWorkers: 4, runtimeIds: ['cline'] }, 'cline');
    expect(directive).toMatchObject({ engine: 'native-team', maxWorkers: 4, failureIsolation: 'dependency-scoped', finalVerification: 'required' });
    expect(nativeWorkflowDirective({ enabled: true, maxWorkers: 4, runtimeIds: ['cline'] }, 'codex')).toBeNull();

    const prompt = withNativeWorkflowDirective(objective, directive);
    expect(prompt).toContain('fan-out');
    expect(prompt).toContain('join');
    expect(prompt).toContain('Non fare modifiche concorrenti agli stessi file');
    expect(prompt).toContain('unica fonte di verità per stato, routing, budget, retry, workspace Git e audit');
  });
});
