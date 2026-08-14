import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { ClineProvider } from '../src/integrations/execution-provider.js';

describe('local CLI heartbeat (real process)', () => {
  const directories: string[] = [];

  afterEach(() => {
    directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  });

  it('keeps reporting liveness while a real silent process is running', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-heartbeat-'));
    directories.push(directory);
    const command = path.join(directory, 'silent-runtime.ps1');
    fs.writeFileSync(command, [
      'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$RemainingArgs)',
      "if ($RemainingArgs -contains '--version') { Write-Output 'silent-runtime 1.0'; exit 0 }",
      'Start-Sleep -Seconds 5',
    ].join('\r\n'), 'utf8');
    const provider = new ClineProvider(command);
    let heartbeatReceived!: () => void;
    const heartbeat = new Promise<void>((resolve) => { heartbeatReceived = resolve; });
    const handle = await provider.start({
      objectiveId: 'real-silent-process', projectPath: directory, objectiveText: 'test', stopCondition: null,
      heartbeatIntervalMs: 100,
      onEvent: (event) => {
        if (event.type === 'heartbeat' && event.metadata?.source === 'process_alive') heartbeatReceived();
      },
    });

    await Promise.race([
      heartbeat,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Heartbeat non ricevuto dal processo vivo')), 2000)),
    ]);
    await provider.stop(handle.processReference);
    await handle.completion;
  });
});
