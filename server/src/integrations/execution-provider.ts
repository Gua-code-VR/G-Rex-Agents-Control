import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface CliLaunch { command: string; prefixArgs: string[]; }

const cliLaunchCache = new Map<string, CliLaunch | null>();
const cliAvailabilityCache = new Map<string, boolean>();

export function getCliLaunch(command: string): CliLaunch | null {
  const cacheKey = `${process.platform}\0${command}`;
  if (cliLaunchCache.has(cacheKey)) return cliLaunchCache.get(cacheKey) ?? null;
  if (process.platform !== 'win32') {
    const launch = { command, prefixArgs: [] };
    cliLaunchCache.set(cacheKey, launch);
    return launch;
  }
  const resolved = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$command = Get-Command -Name $env:G_REX_RUNTIME_CLI_COMMAND -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -eq $command) { exit 1 }; Write-Output ($command.CommandType.ToString() + [char]9 + $command.Source); exit 0',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, G_REX_RUNTIME_CLI_COMMAND: command },
  });
  if (resolved.status !== 0 || !resolved.stdout) {
    cliLaunchCache.set(cacheKey, null);
    return null;
  }
  const [commandType, source] = resolved.stdout.trim().split('\t', 2);
  if (!source) {
    cliLaunchCache.set(cacheKey, null);
    return null;
  }
  if (commandType === 'ExternalScript' && source.toLowerCase().endsWith('.ps1')) {
    const launch = { command: 'powershell.exe', prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', source] };
    cliLaunchCache.set(cacheKey, launch);
    return launch;
  }
  const launch = commandType === 'Application' ? { command: source, prefixArgs: [] } : null;
  cliLaunchCache.set(cacheKey, launch);
  return launch;
}

export function isCliCommandAvailable(command: string): boolean {
  const cacheKey = `${process.platform}\0${command}`;
  if (cliAvailabilityCache.has(cacheKey)) return cliAvailabilityCache.get(cacheKey) ?? false;
  try {
    const launch = getCliLaunch(command);
    const available = launch !== null && spawnSync(launch.command, [...launch.prefixArgs, '--version'], {
      encoding: 'utf8', windowsHide: true,
    }).status === 0;
    cliAvailabilityCache.set(cacheKey, available);
    return available;
  } catch {
    cliAvailabilityCache.set(cacheKey, false);
    return false;
  }
}

export type ExecutionOutcome = 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface ExecutionProviderDescriptor {
  id: string;
  runtimeType: string;
  runtimeName: string;
  providerName: string;
  defaultModel: string | null;
}
export interface ProviderCatalogEntry { runtime: { id: string; name: string; type: string; available: boolean; defaultModel: string | null; capabilities: string[]; version: string | null }; provider: { id: string; name: string }; models: Array<{ id: string; name: string; version: string | null; capabilities: string[]; limits: { contextTokens: number | null; defaultOutputTokens: number }; pricing: { inputPerMillion: number | null; outputPerMillion: number | null; currency: 'USD' } }> }

export interface StartExecutionParams {
  objectiveId: string;
  projectPath: string | null;
  objectiveText: string;
  stopCondition: string | null;
  model?: string | null;
  heartbeatIntervalMs?: number;
  onEvent?: (event: ExecutionEvent) => void;
}

export interface ExecutionEvent { type: 'progress' | 'heartbeat'; message?: string; metadata?: Record<string, unknown>; }

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  exitCode: number | null;
  reason: string | null;
  errorClass?: string | null;
  metadata?: Record<string, unknown>;
  usage?: ExecutionUsage;
}
export interface ExecutionUsage { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; costEstimate?: number | null; costActual?: number | null; }

export interface ExecutionHandle {
  processReference: string;
  descriptor: ExecutionProviderDescriptor;
  completion: Promise<ExecutionResult>;
}

/** Runtime port. The Control Plane depends only on this normalized contract. */
export interface ExecutionProvider {
  readonly descriptor: ExecutionProviderDescriptor;
  isConfigured(): boolean;
  start(params: StartExecutionParams): Promise<ExecutionHandle>;
  stop(processReference: string, reason?: string): Promise<void>;
  touchHeartbeat(processReference: string): Promise<void>;
  catalog(): ProviderCatalogEntry;
}

export class ExecutionProviderRegistry {
  private readonly providers = new Map<string, ExecutionProvider>();

  constructor(providers: ExecutionProvider[]) {
    for (const provider of providers) this.providers.set(provider.descriptor.id, provider);
  }

  get(id: string): ExecutionProvider | null { return this.providers.get(id) ?? null; }
  require(id: string): ExecutionProvider {
    const provider = this.get(id);
    if (!provider) throw new Error(`Runtime non supportato: ${id}`);
    if (!provider.isConfigured()) throw new Error(`Runtime non configurato: ${id}`);
    return provider;
  }
  list(): Array<ExecutionProviderDescriptor & { configured: boolean }> {
    return [...this.providers.values()].map((provider) => ({ ...provider.descriptor, configured: provider.isConfigured() }));
  }
  catalog(): ProviderCatalogEntry[] { return [...this.providers.values()].map((provider) => provider.catalog()); }
}

abstract class LocalCliProvider implements ExecutionProvider {
  abstract readonly descriptor: ExecutionProviderDescriptor;
  abstract start(params: StartExecutionParams): Promise<ExecutionHandle>;
  protected readonly processes = new Map<string, ChildProcess>();
  constructor(protected readonly command: string, protected readonly enabled = true) {}

  isConfigured(): boolean {
    return this.enabled && isCliCommandAvailable(this.command);
  }

  protected launch(args: string[], params: StartExecutionParams, stdin?: string): ExecutionHandle {
    const launch = getCliLaunch(this.command);
    if (!launch) throw new Error(`Runtime CLI non avviabile: ${this.command}`);
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], { cwd: params.projectPath ?? undefined, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const processReference = `${this.descriptor.id}:${child.pid ?? 'pending'}:${Date.now()}`;
    this.processes.set(processReference, child);
    if (stdin !== undefined) { child.stdin?.write(stdin); child.stdin?.end(); }
    const output: string[] = [];
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    const heartbeatIntervalMs = Math.max(100, Math.floor(params.heartbeatIntervalMs ?? 10_000));
    const heartbeatTimer = setInterval(() => {
      if (child.exitCode === null && !child.killed) {
        params.onEvent?.({ type: 'heartbeat', metadata: { source: 'process_alive' } });
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();
    const stopHeartbeat = () => clearInterval(heartbeatTimer);
    child.stdout?.on('data', (chunk: string) => {
      output.push(chunk);
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        let metadata: Record<string, unknown> = { line: line.slice(0, 2000) };
        try { metadata = JSON.parse(line) as Record<string, unknown>; } catch { /* raw provider output */ }
        params.onEvent?.({ type: 'progress', message: typeof metadata.message === 'string' ? metadata.message : undefined, metadata });
        params.onEvent?.({ type: 'heartbeat', metadata: { source: 'stdout' } });
      }
    });
    child.stderr?.on('data', (chunk: string) => output.push(chunk));
    const completion = new Promise<ExecutionResult>((resolve) => {
      child.once('error', (error) => {
        stopHeartbeat();
        resolve({ outcome: 'FAILED', exitCode: null, reason: error.message, errorClass: 'AGENT_ERROR' });
      });
      child.once('exit', (code, signal) => {
        stopHeartbeat();
        this.processes.delete(processReference);
        const cancelled = signal !== null;
        resolve({
          outcome: cancelled ? 'CANCELLED' : code === 0 ? 'COMPLETED' : 'FAILED',
          exitCode: code,
          reason: cancelled ? `Processo terminato (${signal})` : code === 0 ? null : output.join('').slice(-4000) || `Exit code ${code}`,
          errorClass: code === 0 ? null : /econn|timeout|network/i.test(output.join('')) ? 'CONNECTIVITY_ERROR' : 'AGENT_ERROR',
          metadata: { signal, output: output.join('').slice(-4000) },
          usage: normalizedUsage(output.join('')),
        });
      });
    });
    return { processReference, descriptor: this.descriptor, completion };
  }

  async stop(processReference: string): Promise<void> {
    const child = this.processes.get(processReference);
    if (child && !child.killed) child.kill();
  }
  async touchHeartbeat(_processReference: string): Promise<void> { /* activity is persisted by the Control Plane */ }
  abstract catalog(): ProviderCatalogEntry;
}

function normalizedUsage(output: string): ExecutionUsage | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as Record<string, any>;
      const usage = value.usage ?? value.metrics?.usage;
      if (!usage) continue;
      const input = numberOrNull(usage.input_tokens ?? usage.inputTokens);
      const outputTokens = numberOrNull(usage.output_tokens ?? usage.outputTokens);
      const total = numberOrNull(usage.total_tokens ?? usage.totalTokens) ?? ((input ?? 0) + (outputTokens ?? 0));
      return { inputTokens: input, outputTokens, totalTokens: total, costEstimate: numberOrNull(usage.cost_estimate ?? usage.costEstimate), costActual: numberOrNull(usage.cost ?? usage.cost_actual ?? usage.costActual) };
    } catch { /* not JSON */ }
  }
  return undefined;
}
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

export class ClineProvider extends LocalCliProvider {
  readonly descriptor = { id: 'cline', runtimeType: 'cli', runtimeName: 'Cline', providerName: 'Cline', defaultModel: null };
  async start(params: StartExecutionParams): Promise<ExecutionHandle> {
    return this.launch(['--headless', '--json'], params, JSON.stringify({ objectiveText: params.objectiveText, stopCondition: params.stopCondition ?? null }));
  }
  catalog(): ProviderCatalogEntry { return { runtime: { id: 'cline', name: 'Cline', type: 'cli', available: this.isConfigured(), defaultModel: null, capabilities: ['workspace-edit', 'streaming'], version: null }, provider: { id: 'cline', name: 'Cline' }, models: [] }; }
}

/** Codex CLI 0.147 protocol: `codex exec --json [--model] --cd <dir> <prompt>`. */
export class CodexProvider extends LocalCliProvider {
  readonly descriptor = { id: 'codex', runtimeType: 'cli', runtimeName: 'Codex CLI', providerName: 'OpenAI Codex', defaultModel: null };
  constructor(command = 'codex', enabled = true, private readonly defaultModel: string | null = null, private readonly pricing: { inputPerMillion: number | null; outputPerMillion: number | null } = { inputPerMillion: null, outputPerMillion: null }) { super(command, enabled); }
  async start(params: StartExecutionParams): Promise<ExecutionHandle> {
    const prompt = [params.objectiveText, params.stopCondition ? `Condizione di stop: ${params.stopCondition}` : null].filter(Boolean).join('\n\n');
    const args = ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--approve-for-me'];
    const model = params.model ?? this.defaultModel;
    if (model) args.push('--model', model);
    return this.launch([...args, prompt], params);
  }
  catalog(): ProviderCatalogEntry { const id = this.defaultModel ?? 'codex-default'; return { runtime: { id: 'codex', name: 'Codex CLI', type: 'cli', available: this.isConfigured(), defaultModel: id, capabilities: ['workspace-edit', 'streaming', 'json-output'], version: '0.147-compatible' }, provider: { id: 'openai-codex', name: 'OpenAI Codex' }, models: [{ id, name: this.defaultModel ?? 'Modello Codex predefinito', version: null, capabilities: ['code', 'tool-use'], limits: { contextTokens: null, defaultOutputTokens: 4000 }, pricing: { ...this.pricing, currency: 'USD' } }] }; }
}

export class FakeProvider implements ExecutionProvider {
  readonly descriptor = { id: 'fake', runtimeType: 'fake', runtimeName: 'Fake', providerName: 'Fake', defaultModel: null };
  isConfigured(): boolean { return true; }
  async start(_params: StartExecutionParams): Promise<ExecutionHandle> {
    return { processReference: `fake-${Date.now()}`, descriptor: this.descriptor, completion: new Promise(() => undefined) };
  }
  async stop(_processReference: string): Promise<void> {}
  async touchHeartbeat(_processReference: string): Promise<void> {}
  catalog(): ProviderCatalogEntry { return { runtime: { id: 'fake', name: 'Fake', type: 'fake', available: true, defaultModel: 'fake', capabilities: ['test'] , version: '1' }, provider: { id: 'fake', name: 'Fake' }, models: [{ id: 'fake', name: 'Fake', version: '1', capabilities: ['test'], limits: { contextTokens: null, defaultOutputTokens: 0 }, pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' } }] }; }
}
