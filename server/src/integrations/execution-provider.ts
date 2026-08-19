import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { PricingProviderEntry, PricingWindow } from '../domain/pricing.js';

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
    // Fail-safe: una CLI che non risponde (es. `--version` che va in hang) non
    // deve bloccare il server (runtime selection / avvio obiettivo).
    timeout: 4000,
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
      // Fail-safe: la sonda è sincrona e va in cache una volta per processo.
      // 15s è un limite ragionevole: CLI reali possono impiegare diversi secondi
      // per il cold start (misurato ~6s per cline 3.x su questo ambiente), ma una
      // CLI realmente bloccata non deve tenere il server appeso più di così.
      timeout: 15000,
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
export interface ProviderCatalogEntry { runtime: { id: string; name: string; type: string; available: boolean; defaultModel: string | null; capabilities: string[]; version: string | null }; provider: { id: string; name: string }; models: Array<{ id: string; name: string; version: string | null; capabilities: string[]; limits: { contextTokens: number | null; defaultOutputTokens: number }; pricing: { inputPerMillion: number | null; outputPerMillion: number | null; currency: 'USD'; inputPerToken?: number | null; outputPerToken?: number | null; cachedInputPerToken?: number | null; cachedOutputPerToken?: number | null; extra?: Record<string, number> }; pricingSchedule?: PricingWindow[] | null }> }

export interface StartExecutionParams {
  objectiveId: string;
  projectPath: string | null;
  objectiveText: string;
  stopCondition: string | null;
  /** ID del provider API richiesto per il runtime (es. `openrouter` per Cline). */
  providerId?: string | null;
  model?: string | null;
  heartbeatIntervalMs?: number;
  onEvent?: (event: ExecutionEvent) => void;
}

export type ExecutionEventType = 'progress' | 'heartbeat' | 'approval';

export interface ExecutionEvent {
  type: ExecutionEventType;
  message?: string;
  /** Richiesta di approvazione del runtime (azione sensibile, es. tool-use). */
  approval?: { requestId: string; action: string; detail: string | null };
  metadata?: Record<string, unknown>;
}

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  exitCode: number | null;
  reason: string | null;
  /** Report finale reale prodotto dal runtime (estratto dall'output CLI). */
  report?: string | null;
  errorClass?: string | null;
  metadata?: Record<string, unknown>;
  usage?: ExecutionUsage;
}
export interface ExecutionUsage { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; cachedInputTokens?: number | null; cachedOutputTokens?: number | null; costEstimate?: number | null; costActual?: number | null; }

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
  /** Risponde a una richiesta di approvazione pendente del runtime (se supportata). */
  respondApproval?(processReference: string, requestId: string, approved: boolean): Promise<void>;
  /** True only when this runtime can prove that the persisted process still exists. */
  isProcessAlive?(processReference: string): boolean;
  catalog(): ProviderCatalogEntry[];
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
  catalog(): ProviderCatalogEntry[] { return [...this.providers.values()].flatMap((provider) => provider.catalog()); }
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
    if (stdin !== undefined) { child.stdin?.write(stdin); /* stdin resta aperto per eventuali risposte di approvazione */ }
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
        // Richiesta di approvazione del runtime (azione sensibile): la
        // inoltriamo come evento `approval` così il Control Plane può esporla
        // nel pannello e rispondere. Schema Cline: {type:"ask", ask:<tipo>, text:<domanda>}.
        if (metadata.type === 'ask' || metadata.approval) {
          const ask = (typeof metadata.ask === 'object' && metadata.ask !== null ? metadata.ask : metadata) as Record<string, unknown>;
          const action = typeof metadata.ask === 'string' ? metadata.ask : typeof ask.action === 'string' ? ask.action : 'tool-use';
          const approvalText = typeof metadata.text === 'string' ? metadata.text : typeof ask.text === 'string' ? ask.text : typeof ask.question === 'string' ? ask.question : null;
          params.onEvent?.({
            type: 'approval',
            approval: { requestId: typeof ask.requestId === 'string' ? ask.requestId : String(Date.now()), action, detail: approvalText },
            metadata,
          });
        }
        params.onEvent?.({ type: 'progress', message: typeof metadata.message === 'string' ? metadata.message : undefined, metadata });
        params.onEvent?.({ type: 'heartbeat', metadata: { source: 'stdout' } });
      }
    });
    child.stderr?.on('data', (chunk: string) => output.push(chunk));
    const completion = new Promise<ExecutionResult>((resolve) => {
      child.once('error', (error) => {
        stopHeartbeat();
        child.stdin?.end();
        this.processes.delete(processReference);
        resolve({ outcome: 'FAILED', exitCode: null, reason: error.message, errorClass: 'AGENT_ERROR' });
      });
      child.once('exit', (code, signal) => {
        stopHeartbeat();
        child.stdin?.end();
        this.processes.delete(processReference);
        const cancelled = signal !== null;
        const raw = output.join('');
        // L'esito terminale strutturato (run_result/done) è la fonte autorevole
        // dell'esito del run: un exit code non-zero può essere prodotto da
        // diagnostica indipendente (es. fallimento di un hook di sessione) senza
        // che il run sia fallito. Gli eventi strutturati distinguono inoltre un
        // errore reale (es. Unauthorized) da un semplice warning su stderr.
        const structured = structuredTerminalOutcome(raw);
        const outcome: ExecutionOutcome = cancelled ? 'CANCELLED' : structured ?? (code === 0 ? 'COMPLETED' : 'FAILED');
        const errorMessage = extractErrorMessage(raw);
        resolve({
          outcome,
          exitCode: code,
          reason: cancelled
            ? `Processo terminato (${signal})`
            : outcome === 'FAILED'
              ? errorMessage || (structured === 'FAILED' ? 'Il runtime ha riportato un errore del run' : null) || `Exit code ${code}`
              : null,
          report: outcome === 'COMPLETED' ? extractFinalReport(raw) : null,
          errorClass: outcome === 'FAILED'
            ? /econn|timeout|network|unauthorized|authenticat|re-authenticate|api ?key|credential|401/i.test(raw)
              ? 'CONNECTIVITY_ERROR'
              : /sessionruntime|shutdown called while a run is in progress/i.test(raw)
                ? 'AGENT_CONTROL_ERROR'
                : 'AGENT_ERROR'
            : null,
          metadata: { signal, output: raw.slice(-4000) },
          usage: accumulateUsage(raw),
        });
      });
    });
    return { processReference, descriptor: this.descriptor, completion };
  }

  async stop(processReference: string): Promise<void> {
    const child = this.processes.get(processReference);
    if (!child || child.killed || child.exitCode !== null) return;
    // Terminazione controllata: SIGTERM, poi escalation a SIGKILL se il
    // processo non esce entro 1,5 s. La CLI può stampare «SessionRuntime.shutdown
    // called while a run is in progress» durante l'arresto: è il runtime che
    // riporta lo shutdown della sessione mentre il run è ancora aperto. Agent
    // Control ha già dichiarato la sessione non più ATTIVA prima di fermare il
    // processo, quindi il messaggio resta diagnostica di audit e non genera
    // transizioni di stato né interruzioni improprie.
    child.kill('SIGTERM');
    setTimeout(() => {
      const pending = this.processes.get(processReference);
      if (pending && pending.exitCode === null) pending.kill('SIGKILL');
    }, 1500).unref?.();
  }

  async respondApproval(processReference: string, requestId: string, approved: boolean): Promise<void> {
    const child = this.processes.get(processReference);
    if (!child || !child.stdin || child.killed) return;
    child.stdin.write(`${JSON.stringify({ type: 'approval_response', requestId, approved })}\n`);
  }
  async touchHeartbeat(_processReference: string): Promise<void> { /* activity is persisted by the Control Plane */ }
  isProcessAlive(processReference: string): boolean {
    const parts = processReference.split(':');
    const pid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      if (process.platform === 'win32') {
        return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`], { windowsHide: true }).status === 0;
      }
      process.kill(pid, 0); return true;
    } catch { return false; }
  }
  abstract catalog(): ProviderCatalogEntry[];
}

interface UsageParts {
  input: number | null;
  output: number | null;
  cachedInput: number | null;
  cachedOutput: number | null;
  total: number | null;
  costEstimate: number | null;
  costActual: number | null;
}

/** Estrae i token (incluso lo split cache-hit/miss) da una riga NDJSON del runtime. */
function usageParts(value: Record<string, any>): UsageParts | null {
  const usage = value.usage ?? value.metrics?.usage ?? value.event?.usage ?? value.run_result?.usage;
  if (!usage) return null;
  const input = numberOrNull(usage.input_tokens ?? usage.inputTokens ?? usage.totalInputTokens ?? usage.prompt_tokens);
  const output = numberOrNull(usage.output_tokens ?? usage.outputTokens ?? usage.totalOutputTokens ?? usage.completion_tokens);
  // Cache-hit (prompt caching): Anthropic `cache_read_input_tokens`, OpenAI
  // `prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit_tokens`.
  const cachedInput = numberOrNull(
    usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cachedInputTokens
    ?? usage.cache_hit_tokens
    ?? usage.cacheReadTokens
    ?? usage.cache_read_tokens,
  );
  const cachedOutput = numberOrNull(usage.cachedOutputTokens ?? usage.cache_write_output_tokens);
  const total = numberOrNull(usage.total_tokens ?? usage.totalTokens);
  return {
    input, output, cachedInput, cachedOutput, total,
    costEstimate: numberOrNull(usage.cost_estimate ?? usage.costEstimate),
    costActual: numberOrNull(usage.cost ?? usage.cost_actual ?? usage.costActual ?? usage.totalCost),
  };
}

/**
 * Accumula il consumo reale dei token da TUTTI gli eventi `usage` emessi dal
 * runtime (una richiesta può produrre più eventi), mantenendo lo split
 * cache-miss/cache-hit necessario per i listini a scaglioni.
 */
export function accumulateUsage(output: string): ExecutionUsage | undefined {
  let input = 0;
  let outputTokens = 0;
  let cachedInput = 0;
  let cachedOutput = 0;
  let total = 0;
  let costEstimate: number | null = null;
  let costActual: number | null = null;
  let count = 0;
  for (const line of output.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as Record<string, any>;
      const parts = usageParts(value);
      if (!parts) continue;
      count += 1;
      // `run_result` (Cline CLI) è il report finale aggregato: SOSTITUISCE
      // l'accumulo invece di sommarsi, altrimenti lo stesso consumo viene
      // contato due volte (l'`usage` emesso prima del run_result, es. nel
      // done event, riporta gli stessi totali).
      const isFinalReport = value.type === 'run_result' || value.run_result !== undefined;
      const accumulate = (
        target: number,
        part: number | null,
      ): number => (part === null ? target : isFinalReport ? part : target + part);
      input = accumulate(input, parts.input);
      outputTokens = accumulate(outputTokens, parts.output);
      cachedInput = accumulate(cachedInput, parts.cachedInput);
      cachedOutput = accumulate(cachedOutput, parts.cachedOutput);
      total = accumulate(total, parts.total);
      // Costo: l'ultimo valore non-null vince (il costo monetario è un hint;
      // il consuntivo affidabile è calcolato da G-Rex Pricing sui token).
      if (parts.costEstimate != null) costEstimate = parts.costEstimate;
      if (parts.costActual != null) costActual = parts.costActual;
    } catch { /* not JSON */ }
  }
  if (count === 0) return undefined;
  return {
    inputTokens: input,
    outputTokens,
    totalTokens: total > 0 ? total : input + outputTokens,
    cachedInputTokens: cachedInput,
    cachedOutputTokens: cachedOutput,
    costEstimate,
    costActual,
  };
}

function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

/**
 * Estrae il report finale reale dall'output NDJSON del runtime.
 * Cline emette `run_result` con `text` (il messaggio finale) e `agent_event`
 * con `event.type==="content_end"`/`contentType==="text"`; Codex emette
 * `{"type":"result","result":"..."}`. Restituisce l'ultimo testo significativo.
 */
function extractFinalReport(output: string): string | null {
  let report: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      // Ignora le richieste di approvazione (`ask`): non sono il report finale.
      if (value.type === 'ask') continue;
      const runResult = value.run_result as Record<string, unknown> | undefined;
      const event = value.event as Record<string, unknown> | undefined;
      const candidate = firstNonEmptyString(
        runResult?.text,
        value.result,
        value.finalResult,
        value.response,
        event?.type === 'content_end' ? event.text : undefined,
        typeof value.text === 'string' ? value.text : undefined,
        value.report,
      );
      if (candidate) report = candidate;
    } catch {
      // riga non-JSON: ignorata per l'estrazione del report
    }
  }
  return report;
}

/**
 * Esito terminale strutturato del runtime (Cline/Codex) ricavato dagli eventi
 * NDJSON (`run_result`/`done`). Questi eventi sono la fonte autorevole del
 * risultato di un run: un exit code non-zero può derivare da diagnostica
 * indipendente (es. il fallimento di un hook di sessione) senza che il run sia
 * fallito. Restituisce null quando nessun evento terminale è presente, lasciando
 * al chiamante il fallback sull'exit code.
 */
function structuredTerminalOutcome(output: string): 'COMPLETED' | 'FAILED' | null {
  let terminal: 'COMPLETED' | 'FAILED' | null = null;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: Record<string, any>;
    try { value = JSON.parse(trimmed); } catch { continue; }
    const runResult = value.run_result as Record<string, any> | undefined;
    const event = value.event as Record<string, any> | undefined;
    // `run_result` di Cline espone finishReason in cima all'oggetto event;
    // `done`/Codex lo espongono come reason (event.reason o value.reason).
    const finishReason: unknown = runResult?.finishReason ?? event?.reason ?? value.finishReason ?? value.reason;
    if (finishReason === 'completed' || finishReason === 'max_iterations') {
      terminal = terminal ?? 'COMPLETED';
    } else if (finishReason === 'error' || finishReason === 'failed') {
      terminal = 'FAILED';
    }
    // `run_result` è l'evento finale aggregato: quando è presente è decisivo.
    if (value.type === 'run_result') break;
  }
  return terminal;
}

/** Estrae un messaggio d'errore leggibile dall'output NDJSON del runtime,
 *  evitando di propagare al Control Plane l'intero flusso grezzo. */
function extractErrorMessage(output: string): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  let fallback = '';
  let doneError = '';
  let diagnosticError = '';
  for (const line of lines) {
    fallback = line.trim();
    try {
      const value = JSON.parse(line) as Record<string, any>;
      // Cline emette `run_result` come evento top-level; alcuni adapter lo
      // annidano invece in `run_result`. Questo è il record terminale e ha
      // precedenza su ogni diagnostica precedente (es. hook falliti).
      const runResult = (value.type === 'run_result' ? value : value.run_result) as Record<string, any> | undefined;
      if (runResult && (runResult.finishReason === 'error' || runResult.finishReason === 'failure')) {
        const text = typeof runResult.text === 'string' ? runResult.text.trim() : '';
        if (text) return truncate(text, 600);
      }
      const event = value.event as Record<string, any> | undefined;
      // Cline emette l'errore reale anche come `done` con reason:"error" e il
      // testo significativo nel campo `text` (es. Unauthorized).
      if (event?.type === 'done' && event.reason === 'error') {
        const message = typeof event.text === 'string' && event.text.trim()
          ? event.text
          : typeof event.error?.message === 'string' ? event.error.message : '';
        // Conserva `done` come fallback strutturato: una successiva
        // `run_result` terminale è più autorevole e deve poterlo sostituire.
        if (message.trim()) doneError = truncate(message.trim(), 600);
        continue;
      }
      if (event?.type === 'error') {
        const message = typeof event.error?.message === 'string' ? event.error.message
          : typeof event.message === 'string' ? event.message
          : typeof event.error === 'string' ? event.error : '';
        if (message.trim()) diagnosticError ||= truncate(message.trim(), 600);
      }
      if (value.type === 'error' && typeof value.message === 'string') {
        // Un errore libero nel flusso (per esempio un hook) è diagnostica:
        // non può occultare un `done`/`run_result` terminale successivo.
        if (value.message.trim()) diagnosticError ||= truncate(value.message.trim(), 600);
      }
    } catch { /* riga non-JSON: ignorata */ }
  }
  return doneError || diagnosticError || truncate(fallback, 600);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Cline CLI 3.x: `cline --json [-P <provider>] [-m <model>] <prompt>`.
 *  Costruisce gli argomenti in modo deterministico ed esplicito: provider e
 *  modello sono SEMPRE passati quando noti. Il routing di Agent Control non
 *  deve mai dipendere dal «provider attualmente selezionato» nella config
 *  globale di Cline (es. `lastUsedProvider`), altrimenti il router sceglierebbe
 *  un provider ma Cline ne userebbe un altro.
 */
export function buildClineArgs(params: {
  objectiveText: string;
  stopCondition: string | null;
  providerId?: string | null;
  model?: string | null;
}): string[] {
  const prompt = [params.objectiveText, params.stopCondition ? `Condizione di stop: ${params.stopCondition}` : null]
    .filter(Boolean)
    .join('\n\n');
  const args = ['--json'];
  if (params.providerId) args.push('--provider', params.providerId);
  if (params.model) args.push('--model', params.model);
  return [...args, prompt];
}

export class ClineProvider extends LocalCliProvider {
  readonly descriptor = { id: 'cline', runtimeType: 'cli', runtimeName: 'Cline', providerName: 'Cline', defaultModel: null };
  constructor(
    command = 'cline',
    enabled = true,
    private readonly pricing: () => PricingProviderEntry[] = () => [],
  ) { super(command, enabled); }
  async start(params: StartExecutionParams): Promise<ExecutionHandle> {
    return this.launch(buildClineArgs(params), params);
  }
  catalog(): ProviderCatalogEntry[] {
    return this.pricing().map((entry) => ({
      runtime: { id: 'cline', name: 'Cline', type: 'cli', available: this.isConfigured(), defaultModel: entry.models[0]?.id ?? null, capabilities: ['code', 'tool-use', 'workspace-edit', 'streaming'], version: null },
      provider: { id: entry.id, name: entry.name },
      models: entry.models.map((model) => ({
        id: model.id, name: model.name, version: null, capabilities: ['code', 'tool-use', 'workspace-edit', 'streaming'],
        limits: { contextTokens: model.contextTokens, defaultOutputTokens: model.defaultOutputTokens },
        pricing: {
          ...model.pricing,
          ...(model.tokenPricing ? {
            inputPerToken: model.tokenPricing.inputPerToken,
            outputPerToken: model.tokenPricing.outputPerToken,
            cachedInputPerToken: model.tokenPricing.cachedInputPerToken,
            cachedOutputPerToken: model.tokenPricing.cachedOutputPerToken,
            extra: model.tokenPricing.extra,
          } : {}),
        },
        pricingSchedule: model.pricingSchedule,
      })),
    }));
  }
}

/** Codex CLI 0.147 protocol: `codex exec --json [--model] --cd <dir> <prompt>`. */
export class CodexProvider extends LocalCliProvider {
  readonly descriptor = { id: 'codex', runtimeType: 'cli', runtimeName: 'Codex CLI', providerName: 'OpenAI Codex', defaultModel: null };
  constructor(command = 'codex', enabled = true, private readonly defaultModel: string | null = null, private readonly pricing: { inputPerMillion: number | null; outputPerMillion: number | null } = { inputPerMillion: null, outputPerMillion: null }) { super(command, enabled); }
  async start(params: StartExecutionParams): Promise<ExecutionHandle> {
    const prompt = [params.objectiveText, params.stopCondition ? `Condizione di stop: ${params.stopCondition}` : null].filter(Boolean).join('\n\n');
    // Codex 0.147: --sandbox <mode> e --approve-for-me sono mutuamente esclusivi
    // (la CLI rifiuta la combinazione). --approve-for-me instrada le approvazioni
    // tramite review automatica usando già la sandbox workspace-write, quindi
    // non va passato anche --sandbox: sandbox e approvazioni restano preservate.
    const args = ['exec', '--json', '--color', 'never', '--approve-for-me'];
    const model = params.model ?? this.defaultModel;
    if (model) args.push('--model', model);
    return this.launch([...args, prompt], params);
  }
  catalog(): ProviderCatalogEntry[] { const id = this.defaultModel ?? 'codex-default'; return [{ runtime: { id: 'codex', name: 'Codex CLI', type: 'cli', available: this.isConfigured(), defaultModel: id, capabilities: ['workspace-edit', 'streaming', 'json-output'], version: '0.147-compatible' }, provider: { id: 'openai-codex', name: 'OpenAI Codex' }, models: [{ id, name: this.defaultModel ?? 'Modello Codex predefinito', version: null, capabilities: ['code', 'tool-use'], limits: { contextTokens: null, defaultOutputTokens: 4000 }, pricing: { ...this.pricing, currency: 'USD' } }] }]; }
}

export class FakeProvider implements ExecutionProvider {
  readonly descriptor = { id: 'fake', runtimeType: 'fake', runtimeName: 'Fake', providerName: 'Fake', defaultModel: null };
  isConfigured(): boolean { return true; }
  async start(_params: StartExecutionParams): Promise<ExecutionHandle> {
    return { processReference: `fake-${Date.now()}`, descriptor: this.descriptor, completion: new Promise(() => undefined) };
  }
  async stop(_processReference: string): Promise<void> {}
  async touchHeartbeat(_processReference: string): Promise<void> {}
  isProcessAlive(_processReference: string): boolean { return false; }
  catalog(): ProviderCatalogEntry[] { return [{ runtime: { id: 'fake', name: 'Fake', type: 'fake', available: true, defaultModel: 'fake', capabilities: ['test'] , version: '1' }, provider: { id: 'fake', name: 'Fake' }, models: [{ id: 'fake', name: 'Fake', version: '1', capabilities: ['test'], limits: { contextTokens: null, defaultOutputTokens: 0 }, pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' } }] }]; }
}
