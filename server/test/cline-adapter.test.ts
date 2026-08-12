import { describe, it, expect } from 'vitest';
import { ClineAdapter } from '../src/integrations/agent-adapter.js';

describe('ClineAdapter (fallback behavior)', () => {
  it('returns fallback session when cline not installed', async () => {
    const adapter = new ClineAdapter('cline-not-installed', true);
    const configured = adapter.isConfigured();
    // most CI/dev machines won't have this binary
    expect(configured).toBe(false);
    const handle = await adapter.startSession({
      objectiveId: 'o1',
      projectPath: null,
      objectiveText: 'test',
      stopCondition: null,
    });
    expect(handle.agentType).toBe('cline');
    expect(handle.sessionRef).toMatch(/^cline-fallback-/);
  });

  it('respects disabled flag', async () => {
    const adapter = new ClineAdapter('cline-not-installed', false);
    expect(adapter.isConfigured()).toBe(false);
    const handle = await adapter.startSession({
      objectiveId: 'o2',
      projectPath: null,
      objectiveText: 't',
      stopCondition: null,
    });
    expect(handle.sessionRef).toMatch(/^cline-fallback-/);
  });
});
