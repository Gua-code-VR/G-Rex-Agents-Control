import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { deriveProjectStatus } from '../src/domain/objective.js';
import type { Objective } from '../src/domain/objective.js';

/**
 * Audit coerenza stati/contatori UI ↔ backend (§4/§5/§14 V2).
 *
 * Regressioni coperte:
 * - `requiresYouCount` è la fonte unica del badge «Richiede te» (checkpoint
 *   PENDING_DECISION + approvazioni budget + approvazioni runtime); non
 *   include sessioni STALE né errori risolti;
 * - una decisione su un checkpoint obsoleto NON interrompe un'esecuzione
 *   ancora attiva (guardia anti-kill);
 * - l'annullamento di un obiettivo non corrente non altera la relazione
 *   «obiettivo corrente» né lo stato derivato del progetto;
 * - il retry risolve i checkpoint pendenti (nessun residuo in «Richiede te»);
 * - lo stato del progetto è sempre derivato dagli obiettivi reali, anche
 *   quando un obiettivo nuovo parte con fratelli in stato più grave;
 * - lo stop produce un solo checkpoint coerente (niente doppioni).
 */
describe('Audit coerenza stati UI/backend (V2)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-audit-'));
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_DEFAULT_RUNTIME: 'fake' }));
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function newProject(name: string): Promise<string> {
    const res = await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json().project.id as string;
  }

  async function newObjective(projectId: string, title: string, extra: Record<string, unknown> = {}): Promise<{ objectiveId: string; sessionId: string }> {
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: { title, objectiveText: `Obiettivo di test: ${title}.`, ...extra },
    });
    expect(res.statusCode).toBe(201);
    return { objectiveId: res.json().objective.id as string, sessionId: res.json().session.id as string };
  }

  async function start(objectiveId: string, sessionId: string): Promise<void> {
    const res = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start` });
    expect(res.statusCode).toBe(200);
  }

  async function fail(objectiveId: string, error: string): Promise<void> {
    const res = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/fail`, payload: { error } });
    expect(res.statusCode).toBe(200);
  }

  async function detail(objectiveId: string): Promise<{ objective: Objective; sessions: Array<{ id: string; status: string }>; checkpoints: Array<{ id: string; status: string; outcome: string }> }> {
    const res = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function status(): Promise<{ requiresYouCount: number; pendingDecisions: number }> {
    const res = await built.app.inject({ method: 'GET', url: '/api/status' });
    return res.json();
  }

  describe('deriveProjectStatus (dominio)', () => {
    const obj = (status: Objective['status']): Objective => ({ status } as Objective);

    it('torna FERMO senza obiettivi aperti o con soli obiettivi terminali', () => {
      expect(deriveProjectStatus([])).toBe('FERMO');
      expect(deriveProjectStatus([obj('COMPLETATO'), obj('ANNULLATO')])).toBe('FERMO');
    });

    it('prevale la condizione più grave tra obiettivi aperti', () => {
      expect(deriveProjectStatus([obj('IN_LAVORAZIONE'), obj('ERRORE')])).toBe('ERRORE');
      expect(deriveProjectStatus([obj('IN_LAVORAZIONE'), obj('RICHIEDE_ATTENZIONE')])).toBe('RICHIEDE_ATTENZIONE');
      expect(deriveProjectStatus([obj('IN_AVVIO'), obj('BLOCCATO')])).toBe('BLOCCATO');
      expect(deriveProjectStatus([obj('IN_LAVORAZIONE')])).toBe('IN_LAVORAZIONE');
    });

    it('gli obiettivi terminali non contaminano la derivazione', () => {
      expect(deriveProjectStatus([obj('COMPLETATO'), obj('ERRORE'), obj('IN_LAVORAZIONE')])).toBe('ERRORE');
    });
  });

  it('requiresYouCount è la fonte unica del badge «Richiede te» (checkpoint + governance, non STALE/risolti)', async () => {
    const baseline = (await status()).requiresYouCount;
    const pid = await newProject('audit-count');
    const o1 = await newObjective(pid, 'Fallisce');
    await start(o1.objectiveId, o1.sessionId);
    await fail(o1.objectiveId, 'Boom');

    let s = await status();
    expect(s.pendingDecisions).toBe(baseline + 1);
    expect(s.requiresYouCount).toBe(baseline + 1);

    // Approvazione budget pendente: si somma al badge mentre pendingDecisions no.
    await built.app.inject({ method: 'PUT', url: `/api/projects/${pid}/policy`, payload: { costBudget: 1, warningPercent: 80, action: 'REQUIRE_APPROVAL' } });
    const o2 = await newObjective(pid, 'Gate', { runtime: 'fake', estimatedCost: 1.2 });
    const blocked = await built.app.inject({ method: 'POST', url: `/api/objectives/${o2.objectiveId}/sessions/${o2.sessionId}/start` });
    expect(blocked.statusCode).toBe(400);

    s = await status();
    expect(s.pendingDecisions).toBe(baseline + 1);
    expect(s.requiresYouCount).toBe(baseline + 2);

    // Decisione sul checkpoint: sparisce dal badge, resta l'approvazione.
    const pending = (await detail(o1.objectiveId)).checkpoints.filter((c) => c.status === 'PENDING_DECISION');
    expect(pending).toHaveLength(1);
    const decide = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${pending[0].id}/decide`, payload: { decisionType: 'CANCEL' } });
    expect(decide.statusCode).toBe(200);

    s = await status();
    expect(s.requiresYouCount).toBe(baseline + 1);
  });

  it("una decisione su un checkpoint obsoleto non interrompe un'esecuzione ancora attiva", async () => {
    const pid = await newProject('audit-guard');
    const o1 = await newObjective(pid, 'Guarded');
    await start(o1.objectiveId, o1.sessionId);
    await fail(o1.objectiveId, 'Boom');
    await built.app.inject({ method: 'POST', url: `/api/objectives/${o1.objectiveId}/retry` });

    const sessions = built.services.db.prepare('SELECT id, status FROM sessions WHERE objective_id = ?').all(o1.objectiveId) as Array<{ id: string; status: string }>;
    const oldSession = sessions.find((s) => s.status === 'ERRORE');
    const active = sessions.find((s) => s.status === 'ATTIVA');
    expect(oldSession).toBeTruthy();
    expect(active).toBeTruthy();

    // Inietto un checkpoint obsoleto (della vecchia sessione) mentre la nuova
    // esecuzione è ATTIVA: una decisione su di esso deve essere rifiutata.
    const objective = built.services.objectives.getById(o1.objectiveId)!;
    const stale = built.services.checkpoints.create({
      outcome: 'ERROR',
      projectId: pid,
      objective,
      session: built.services.db.prepare('SELECT * FROM sessions WHERE id = ?').get(oldSession!.id) as never,
      gitEnd: null,
      agent: {},
      technicalDetails: 'checkpoint obsoleto',
      defaults: { summary: 'Errore obsoleto', recommendedAction: 'Riprova' },
    });

    const decide = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${stale.id}/decide`, payload: { decisionType: 'CANCEL' } });
    expect(decide.statusCode).toBe(400);

    // L'esecuzione attiva non è stata interrotta e lo stato è rimasto coerente.
    const after = built.services.db.prepare('SELECT status FROM sessions WHERE id = ?').get(active!.id) as { status: string };
    expect(after.status).toBe('ATTIVA');
    expect(built.services.objectives.getById(o1.objectiveId)!.status).toBe('IN_LAVORAZIONE');
    const project = (await built.app.inject({ method: 'GET', url: `/api/projects/${pid}` })).json().project;
    expect(project.status).toBe('IN_LAVORAZIONE');
  });

  it("l'annullamento di un obiettivo non corrente non altera la relazione né lo stato del progetto", async () => {
    const pid = await newProject('audit-cancel');
    const o1 = await newObjective(pid, 'Vecchio');
    await start(o1.objectiveId, o1.sessionId);
    await fail(o1.objectiveId, 'Boom');

    const o2 = await newObjective(pid, 'Corrente');
    await start(o2.objectiveId, o2.sessionId);

    const before = (await built.app.inject({ method: 'GET', url: `/api/projects/${pid}` })).json().project;
    expect(before.currentObjectiveId).toBe(o2.objectiveId);
    // O1 è ancora ERRORE: la condizione più grave prevale sull'esecuzione di O2.
    expect(before.status).toBe('ERRORE');

    const cancel = await built.app.inject({ method: 'POST', url: `/api/objectives/${o1.objectiveId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().objective.status).toBe('ANNULLATO');

    // Il progetto continua a riflettere l'obiettivo realmente corrente.
    const after = (await built.app.inject({ method: 'GET', url: `/api/projects/${pid}` })).json().project;
    expect(after.currentObjectiveId).toBe(o2.objectiveId);
    expect(after.status).toBe('IN_LAVORAZIONE');

    // Nessun checkpoint residuo pendente per l'obiettivo annullato.
    const pending = (await detail(o1.objectiveId)).checkpoints.filter((c) => c.status === 'PENDING_DECISION');
    expect(pending).toHaveLength(0);
  });

  it('il retry risolve i checkpoint pendenti e non lascia residui in «Richiede te»', async () => {
    const pid = await newProject('audit-retry');
    const o1 = await newObjective(pid, 'Riprova');
    await start(o1.objectiveId, o1.sessionId);
    await fail(o1.objectiveId, 'Boom');

    expect((await detail(o1.objectiveId)).checkpoints.filter((c) => c.status === 'PENDING_DECISION')).toHaveLength(1);

    const retry = await built.app.inject({ method: 'POST', url: `/api/objectives/${o1.objectiveId}/retry` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().objective.status).toBe('IN_LAVORAZIONE');

    const after = await detail(o1.objectiveId);
    expect(after.checkpoints.filter((c) => c.status === 'PENDING_DECISION')).toHaveLength(0);
    expect(after.sessions.some((s) => s.status === 'ATTIVA')).toBe(true);
  });

  it('lo stato progetto deriva dagli obiettivi reali anche quando parte un obiettivo nuovo', async () => {
    const pid = await newProject('audit-derive');
    const o1 = await newObjective(pid, 'A');
    await start(o1.objectiveId, o1.sessionId);
    await fail(o1.objectiveId, 'Boom'); // O1 ERRORE

    // O2 parte mentre O1 è ancora in errore: il progetto deve riflettere la
    // condizione più grave (ERRORE), non essere sovrascritto a IN_LAVORAZIONE.
    const o2 = await newObjective(pid, 'B');
    await start(o2.objectiveId, o2.sessionId);

    const project = (await built.app.inject({ method: 'GET', url: `/api/projects/${pid}` })).json().project;
    expect(project.status).toBe('ERRORE');
    expect(project.currentObjectiveId).toBe(o2.objectiveId);
  });

  it('lo stop produce un solo checkpoint pendente coerente (niente doppioni)', async () => {
    const pid = await newProject('audit-stop');
    const o1 = await newObjective(pid, 'Stop');
    await start(o1.objectiveId, o1.sessionId);

    const stopped = await built.app.inject({ method: 'POST', url: `/api/objectives/${o1.objectiveId}/sessions/${o1.sessionId}/stop`, payload: { reason: 'basta' } });
    expect(stopped.statusCode).toBe(200);
    const t = stopped.json();
    expect(t.session.status).toBe('INTERROTTA');
    expect(t.objective.status).toBe('RICHIEDE_ATTENZIONE');
    expect(t.project.status).toBe('RICHIEDE_ATTENZIONE');

    const pending = (await detail(o1.objectiveId)).checkpoints.filter((c) => c.status === 'PENDING_DECISION');
    expect(pending).toHaveLength(1);
    expect(pending[0].outcome).toBe('INTERRUPTED');
  });
});
