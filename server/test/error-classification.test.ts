import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawn, spawnSync } = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
  spawnSync,
}));

import { classifyError, translateTechnicalError } from '../src/application/error-classifier.js';
import { ClineProvider } from '../src/integrations/execution-provider.js';

describe('error classification and CLI error extraction', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('classifica gli errori di autenticazione come CONNECTIVITY_ERROR', () => {
    expect(classifyError('Unauthorized: Please make sure you are using the latest version of Cline and re-authenticate your Cline account.')).toBe('CONNECTIVITY_ERROR');
    expect(classifyError('Authentication failed for provider cline')).toBe('CONNECTIVITY_ERROR');
    expect(classifyError('exit code 1')).toBe('AGENT_ERROR');
  });

  it('traduce un errore di autenticazione in una guida chiara', () => {
    const translation = translateTechnicalError('Unauthorized: re-authenticate your Cline account', 'CONNECTIVITY_ERROR', 'Cline');
    expect(translation.summary).toContain('Autenticazione');
    expect(translation.recommendedAction).toContain('autenticazione');
  });

  it('estrae un messaggio pulito (non il flusso NDJSON grezzo) e la classe corretto', async () => {
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'powershell.exe' && args.includes('-Command')) {
        return { status: 0, stdout: 'Application\tC:\\tools\\cline.exe\n' };
      }
      return { status: 0, stdout: 'version\n' };
    });

    const stdout = new (await import('node:events')).EventEmitter() as any;
    const child = {
      pid: 42,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { setEncoding: vi.fn(), on: (ev: string, cb: Function) => { if (ev === 'data') stdout.on('data', cb as (...args: unknown[]) => void); } },
      stderr: { setEncoding: vi.fn(), on: vi.fn() },
      once: (ev: string, cb: Function) => { if (ev === 'exit') setTimeout(() => cb(1, null), 10); },
      killed: false,
      exitCode: null,
    };
    spawn.mockReturnValue(child);

    const provider = new ClineProvider('cline-auth');
    const handle = await provider.start({ objectiveId: 'o-auth', projectPath: null, objectiveText: 'test', stopCondition: null });

    stdout.emit('data', JSON.stringify({ type: 'agent_event', event: { type: 'error', error: { name: 'Error', message: 'Unauthorized: Please make sure you\'re using the latest version of Cline and re-authenticate your Cline account.' } } }) + '\n');
    stdout.emit('data', JSON.stringify({ type: 'run_result', finishReason: 'error', text: 'Unauthorized: Please make sure you\'re using the latest version of Cline and re-authenticate your Cline account.' }) + '\n');

    const result = await handle.completion;
    expect(result.outcome).toBe('FAILED');
    expect(result.errorClass).toBe('CONNECTIVITY_ERROR');
    expect(result.reason).toBe('Unauthorized: Please make sure you\'re using the latest version of Cline and re-authenticate your Cline account.');
    expect(result.reason).not.toContain('agent_event');
  });
});
