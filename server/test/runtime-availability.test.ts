import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawn, spawnSync } = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
  spawnSync,
}));

import { ClineProvider, CodexProvider } from '../src/integrations/execution-provider.js';

describe('CLI runtime availability', () => {
  afterEach(() => { vi.useRealTimers(); });

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
    expect(spawn).toHaveBeenCalledWith('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\tools\\cline.ps1', '--json', 'test'], expect.any(Object));
  });

  it('keeps explicitly disabled runtimes unavailable', () => {
    spawnSync.mockClear();

    expect(new ClineProvider('cline', false).isConfigured()).toBe(false);
    expect(new CodexProvider('codex', false).isConfigured()).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('forwards explicit provider/model selection to the Cline CLI', async () => {
    spawn.mockClear();
    spawnSync.mockClear();
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'powershell.exe' && args.includes('-Command')) {
        return { status: 0, stdout: 'ExternalScript\tC:\\tools\\cline.ps1\n' };
      }
      return { status: 0, stdout: 'version\n' };
    });
    const child = { pid: 3, stdin: { write: vi.fn(), end: vi.fn() }, stdout: { setEncoding: vi.fn(), on: vi.fn() }, stderr: { setEncoding: vi.fn(), on: vi.fn() }, once: vi.fn(), killed: false };
    spawn.mockReturnValue(child);

    await new ClineProvider('cline-explicit').start({
      objectiveId: 'o-explicit', projectPath: null, objectiveText: 'test', stopCondition: null,
      providerId: 'openrouter', model: 'anthropic/claude-sonnet-4',
    });
    expect(spawn).toHaveBeenCalledWith('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\tools\\cline.ps1',
      '--json', '--provider', 'openrouter', '--model', 'anthropic/claude-sonnet-4', 'test',
    ], expect.any(Object));
  });

  it('emits runtime approval events and extracts the final report from NDJSON output', async () => {
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'powershell.exe' && args.includes('-Command')) {
        return { status: 0, stdout: 'Application\tC:\\tools\\cline.exe\n' };
      }
      return { status: 0, stdout: 'version\n' };
    });
    const stdout = new (await import('node:events')).EventEmitter() as any;
    const child = {
      pid: 5,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { setEncoding: vi.fn(), on: (ev: string, cb: Function) => { if (ev === 'data') stdout.on('data', cb as (...args: unknown[]) => void); } },
      stderr: { setEncoding: vi.fn(), on: vi.fn() },
      once: (ev: string, cb: Function) => { if (ev === 'exit') setTimeout(() => cb(0, null), 10); },
      killed: false,
      exitCode: null,
    };
    spawn.mockReturnValue(child);
    const onEvent = vi.fn();
    const provider = new ClineProvider('cline-report');

    const handle = await provider.start({
      objectiveId: 'o-report', projectPath: null, objectiveText: 'do work', stopCondition: null,
      onEvent,
    });

    stdout.emit('data', JSON.stringify({ type: 'ask', ask: 'tool', text: 'May I run rm -rf /tmp/x?' }) + '\n');
    stdout.emit('data', JSON.stringify({ type: 'say', text: 'Lavoro completato: 12 test verdi.' }) + '\n');

    const result = await handle.completion;
    expect(result.outcome).toBe('COMPLETED');
    expect(result.report).toBe('Lavoro completato: 12 test verdi.');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval', approval: expect.objectContaining({ action: 'tool', detail: 'May I run rm -rf /tmp/x?' }) }));
  });

  it('treats a failed session hook as diagnostics, not as a failed run, when run_result is COMPLETED', async () => {
    spawnSync.mockClear();
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'powershell.exe' && args.includes('-Command')) {
        return { status: 0, stdout: 'Application\tC:\\tools\\cline.exe\n' };
      }
      return { status: 0, stdout: 'version\n' };
    });
    const stdout = new (await import('node:events')).EventEmitter() as any;
    const child = {
      pid: 6,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { setEncoding: vi.fn(), on: (ev: string, cb: Function) => { if (ev === 'data') stdout.on('data', cb as (...args: unknown[]) => void); } },
      stderr: { setEncoding: vi.fn(), on: vi.fn() },
      once: (ev: string, cb: Function) => { if (ev === 'exit') setTimeout(() => cb(1, null), 10); },
      killed: false,
      exitCode: null,
    };
    spawn.mockReturnValue(child);

    const handle = await new ClineProvider('cline-hook-diagnostic').start({
      objectiveId: 'o-hook', projectPath: null, objectiveText: 'do work', stopCondition: null,
    });

    // Il run termina strutturalmente COMPLETED; l'unica riga "di errore" è la
    // diagnostica di un hook di sessione fallito. L'esito dell'attempt deve
    // derivare dall'evento terminale reale, non dalla presenza di stderr.
    stdout.emit('data', JSON.stringify({ type: 'run_result', finishReason: 'completed', text: 'Lavoro completato.', durationMs: 500, iterations: 1 }) + '\n');

    const result = await handle.completion;
    expect(result.outcome).toBe('COMPLETED');
    expect(result.report).toBe('Lavoro completato.');
    expect(result.exitCode).toBe(1);
  });

  it('keeps a run FAILED when structured events report a real error (Unauthorized)', async () => {
    spawnSync.mockClear();
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'powershell.exe' && args.includes('-Command')) {
        return { status: 0, stdout: 'Application\tC:\\tools\\cline.exe\n' };
      }
      return { status: 0, stdout: 'version\n' };
    });
    const stdout = new (await import('node:events')).EventEmitter() as any;
    const child = {
      pid: 8,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { setEncoding: vi.fn(), on: (ev: string, cb: Function) => { if (ev === 'data') stdout.on('data', cb as (...args: unknown[]) => void); } },
      stderr: { setEncoding: vi.fn(), on: vi.fn() },
      once: (ev: string, cb: Function) => { if (ev === 'exit') setTimeout(() => cb(1, null), 10); },
      killed: false,
      exitCode: null,
    };
    spawn.mockReturnValue(child);

    const handle = await new ClineProvider('cline-unauthorized').start({
      objectiveId: 'o-unauth', projectPath: null, objectiveText: 'do work', stopCondition: null,
    });

    // Errore reale del run riportato dall'evento `done` (reason:"error"): il
    // messaggio estratto deve essere il testo significativo, non il fallback.
    stdout.emit('data', JSON.stringify({ type: 'agent_event', event: { type: 'done', reason: 'error', text: 'Unauthorized: Please verify your API key and permissions.' } }) + '\n');

    const result = await handle.completion;
    expect(result.outcome).toBe('FAILED');
    expect(result.reason).toContain('Unauthorized');
    expect(result.errorClass).toBe('CONNECTIVITY_ERROR');
  });

  it('emits heartbeat while a silent Cline process is still alive', async () => {
    vi.useFakeTimers();
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'powershell.exe' && args.includes('-Command')) {
        return { status: 0, stdout: 'Application\tC:\\tools\\cline.exe\n' };
      }
      return { status: 0, stdout: 'version\n' };
    });
    const child = { pid: 2, stdin: { write: vi.fn(), end: vi.fn() }, stdout: { setEncoding: vi.fn(), on: vi.fn() }, stderr: { setEncoding: vi.fn(), on: vi.fn() }, once: vi.fn(), killed: false, exitCode: null };
    spawn.mockReturnValue(child);
    const onEvent = vi.fn();

    await new ClineProvider('cline').start({
      objectiveId: 'o-silent', projectPath: null, objectiveText: 'long task', stopCondition: null,
      heartbeatIntervalMs: 1000, onEvent,
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(onEvent).toHaveBeenCalledWith({ type: 'heartbeat', metadata: { source: 'process_alive' } });
  });

  it('builds Codex exec args without --sandbox when --approve-for-me is used (compat 0.147)', async () => {
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'powershell.exe' && args.includes('-Command')) {
        return { status: 0, stdout: 'Application\tC:\\tools\\codex.exe\n' };
      }
      return { status: 0, stdout: 'version\n' };
    });
    const child = { pid: 7, stdin: { write: vi.fn(), end: vi.fn() }, stdout: { setEncoding: vi.fn(), on: vi.fn() }, stderr: { setEncoding: vi.fn(), on: vi.fn() }, once: vi.fn(), killed: false, exitCode: null };
    spawn.mockReturnValue(child);
    spawn.mockClear();

    await new CodexProvider('codex').start({ objectiveId: 'o-codex', projectPath: null, objectiveText: 'test', stopCondition: null });

    const args = spawn.mock.calls[0][1] as string[];
    expect(args).toContain('--approve-for-me');
    expect(args).toContain('--json');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('workspace-write');
  });
});