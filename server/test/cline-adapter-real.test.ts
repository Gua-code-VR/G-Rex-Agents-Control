import { describe, it, expect, vi } from 'vitest';

// Mock child_process before importing the adapter so the module-level
// `spawn` used by the adapter is replaced with our controllable stub.
vi.mock('child_process', () => {
  const EventEmitter = require('events');
  const mod: any = {};
  mod.spawnSync = vi.fn(() => ({ status: 0, stdout: '/usr/bin/cline\n' }));
  mod.spawn = vi.fn((_cmd: string, _args: string[], _opts: any) => {
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter();
    stderr.setEncoding = () => {};
    const stdin = { write: vi.fn(), end: vi.fn() };
    const child: any = {
      pid: 4242,
      stdin,
      stdout,
      stderr,
      killed: false,
      kill: vi.fn(() => { child.killed = true; }),
      on: (ev: string, cb: Function) => {
        if (ev === 'exit') {
          // simulate exit after a short delay
          setTimeout(() => cb(0, null), 50);
        }
      },
    };
    // expose the last created child for assertions
    (mod.spawn as any).lastChild = child;

    // emit a couple of NDJSON lines to simulate cline output
    setTimeout(() => {
      stdout.emit('data', JSON.stringify({ type: 'log', msg: 'started' }) + '\n');
    }, 10);
    setTimeout(() => {
      stdout.emit('data', JSON.stringify({ type: 'status', status: 'done' }) + '\n');
    }, 30);

    return child;
  });
  return mod;
});

import { ClineAdapter } from '../src/integrations/agent-adapter.js';

describe('ClineAdapter (real-mode simulation)', () => {
  it('starts the process, parses NDJSON and stopSession kills the child', async () => {
    const adapter = new ClineAdapter('cline', true);
    expect(adapter.isConfigured()).toBe(true);

    const handle = await adapter.startSession({
      objectiveId: 'o1',
      projectPath: null,
      objectiveText: 'do work',
      stopCondition: null,
    });

    expect(handle.agentType).toBe('cline');
    expect(handle.sessionRef).toMatch(/^cline:/);

    // ensure the spawn mock created a child
    const cp = await import('child_process');
    const child = (cp.spawn as any).lastChild;
    expect(child).toBeDefined();

    // stopping the session should call kill on the underlying child
    await adapter.stopSession(handle.sessionRef, 'test-stop');
    expect(child.kill).toHaveBeenCalled();
  });
});
