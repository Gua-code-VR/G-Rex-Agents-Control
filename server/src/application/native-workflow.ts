import type { Objective } from '../domain/objective.js';

/** Policy for the runtime-native multi-worker engine. The Control Plane remains
 * authoritative; this is an execution contract, not a second scheduler. */
export interface NativeWorkflowPolicy {
  enabled: boolean;
  maxWorkers: number;
  runtimeIds: readonly string[];
}

export interface NativeWorkflowDirective {
  engine: 'native-team';
  maxWorkers: number;
  failureIsolation: 'dependency-scoped';
  finalVerification: 'required';
}

export function nativeWorkflowDirective(policy: NativeWorkflowPolicy, runtimeId: string): NativeWorkflowDirective | null {
  if (!policy.enabled || policy.maxWorkers < 2 || !policy.runtimeIds.includes(runtimeId)) return null;
  return { engine: 'native-team', maxWorkers: policy.maxWorkers, failureIsolation: 'dependency-scoped', finalVerification: 'required' };
}

/**
 * Explicit contract for runtimes that expose native `team_*` tools. It does not
 * assign state, budget, retry, or workspaces: those stay in the Control Plane.
 */
export function withNativeWorkflowDirective(objective: Objective, directive: NativeWorkflowDirective | null): string {
  if (!directive) return objective.objectiveText;
  return [
    objective.objectiveText,
    '',
    '## Orchestrazione multi-worker nativa',
    `Usa il motore team nativo del runtime con al massimo ${directive.maxWorkers} worker paralleli.`,
    '1. Scomponi prima il lavoro in task nominati, con dipendenze esplicite e criteri di completamento.',
    '2. Esegui in fan-out soltanto task indipendenti; attendi (join) tutte le dipendenze prima dei task successivi.',
    '3. Isola un errore al task e ai suoi dipendenti: prosegui con i rami indipendenti, ma non dichiarare riusciti i rami bloccati.',
    '4. Non fare modifiche concorrenti agli stessi file. Per il lavoro mutante usa un solo integratore; gli altri worker svolgono analisi, test o modifiche realmente disgiunte nella workspace già assegnata.',
    '5. Usa gli strumenti team nativi per avvio, attesa e elenco dei run, così ogni task produca eventi `team_*` con worker, task, stato e tempi.',
    '6. Dopo il join esegui una verifica finale contro criteri di accettazione, test e vincoli. Nel report finale indica piano, dipendenze, esiti dei task, failure isolate e verifica; non dichiarare successo se fallisce un task richiesto o la verifica finale.',
    'Il Control Plane di Agent Control resta l’unica fonte di verità per stato, routing, budget, retry, workspace Git e audit: non aggirare tali policy.',
  ].join('\n');
}
