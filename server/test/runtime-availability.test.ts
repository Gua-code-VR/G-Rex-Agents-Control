import { describe, expect, it, vi } from 'vitest';

const { spawn, spawnSync } = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
  spawnSync,
}));

import { ClineProvider, CodexProvider } from '../src/integrations/execution-provider.js';

describe('CLI runtime availability', () => {
  it('uses the same resolved executable for availability and launch', async () => {
    spawnSync.mockImplementation((command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (command === 'powershell.exe' && args.includes('-Command')) {
        const cli = options?.env?.G_REX_RUNTIME_CLI_COMMAND;
        return { status: 0, stdout: cli === 'cline' ? 'ExternalScript\tC:\\tools\\cline.ps1\n' : 'Application\tC:\\tools\\codex.exe\n' };
      }
      return { status: 0, stdout: 'version\n' };
    });
    const child = { pid: 1, stdin: { write: vi.fn(), end: vi.fn() }, stdout: { setEncoding: vi.fn(), on: vi.fn() }, stderr: { setEncoding: vi.fn(), on: vi.fn() }, once: vi.fn(), killed: false };
    spawn.mockReturnValue(child);

    const cline = new ClineProvider('cline');
    expect(cline.isConfigured()).toBe(true);
    expect(new CodexProvider().isConfigured()).toBe(true);
    await cline.start({ objectiveId: 'o1', projectPath: null, objectiveText: 'test', stopCondition: null });
    expect(spawn).toHaveBeenCalledWith('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\tools\\cline.ps1', '--headless', '--json'], expect.any(Object));
  });

  it('keeps explicitly disabled runtimes unavailable', () => {
    spawnSync.mockClear();

    expect(new ClineProvider('cline', false).isConfigured()).toBe(false);
    expect(new CodexProvider('codex', false).isConfigured()).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
