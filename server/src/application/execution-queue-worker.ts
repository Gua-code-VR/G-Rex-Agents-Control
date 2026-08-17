import type { ObjectiveRepository, SessionRepository } from '../infrastructure/db/objective-repo.js';
import type { ExecutionProviderRegistry } from '../integrations/execution-provider.js';
import type { EventService } from './event-service.js';
import type { AutoStartResult } from './agent-session-service.js';

export const EVENT_EXECUTION_QUEUE_AUTO_STARTED = 'execution.queue.auto_started';
export const EVENT_EXECUTION_QUEUE_BLOCKED = 'execution.queue.blocked';

/**
 * Coda di esecuzione (§11 CONTROL_ROOM_SPEC): avvia automaticamente gli
 * obiettivi «In attesa di avvio» (sessione IN_AVVIO) quando esiste almeno un
 * worker disponibile. Un worker è un provider di esecuzione configurato; ogni
 * sessione ATTIVA ne occupa uno. Lo svuotamento è FIFO (per data di creazione
 * della sessione) e segue lo stesso pattern di PersistentRetryWorker.
 */
export class ExecutionQueueWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private executor: ((objectiveId: string, sessionId: string) => Promise<AutoStartResult>) | null = null;
  /** Cooldown (ms) per sessione dopo un avvio fallito (es. governance). */
  private readonly failedCooldownMs = 60_000;
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly objectives: ObjectiveRepository,
    private readonly providers: ExecutionProviderRegistry,
    private readonly events: EventService,
    private readonly intervalMs = 2_000,
  ) {}

  setExecutor(executor: (objectiveId: string, sessionId: string) => Promise<AutoStartResult>): void {
    this.executor = executor;
  }

  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.drain(), this.intervalMs);
      this.timer.unref();
    }
    void this.drain();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Worker liberi: provider configurati meno sessioni ATTIVE (mai negativo). */
  availableSlots(): number {
    const configured = this.providers.list().filter((provider) => provider.configured).length;
    if (configured <= 0) return 0;
    const active = this.sessions.listAll().filter((session) => session.status === 'ATTIVA').length;
    return Math.max(0, configured - active);
  }

  /** Svuota la coda: avvia le sessioni IN_AVVIO finché esiste un worker libero. */
  async drain(): Promise<number> {
    if (!this.executor || this.availableSlots() <= 0) return 0;
    const queued = this.sessions.listAll().filter((session) => session.status === 'IN_AVVIO');
    if (queued.length === 0) return 0;
    const now = Date.now();
    let started = 0;
    for (const session of queued) {
      // Avvio fallito in precedenza (es. governance): rispetta il cooldown.
      if (now < (this.failedAt.get(session.id) ?? 0)) continue;
      const objective = this.objectives.getById(session.objectiveId);
      if (!objective || objective.status !== 'IN_AVVIO') continue;
      let result: AutoStartResult | null = null;
      try {
        result = await this.executor(objective.id, session.id);
      } catch {
        result = null;
      }
      if (result?.started) {
        started += 1;
        this.failedAt.delete(session.id);
        this.events.log(EVENT_EXECUTION_QUEUE_AUTO_STARTED, {
          projectId: objective.projectId,
          objectiveId: objective.id,
          sessionId: session.id,
          payload: { runtimeId: session.agentType },
        });
      } else if (result?.failed) {
        this.failedAt.set(session.id, now + this.failedCooldownMs);
        this.events.log(EVENT_EXECUTION_QUEUE_BLOCKED, {
          projectId: objective.projectId,
          objectiveId: objective.id,
          sessionId: session.id,
          payload: { runtimeId: session.agentType },
        });
      }
    }
    return started;
  }
}
