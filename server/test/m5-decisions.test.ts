import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
} catch {
  hasGit = false;
}

function createGitRepo(baseDir: string, name: string): string {
  const repoDir = path.join(baseDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  if (hasGit) {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['-c', 'user.name=G-Rex Test', '-c', 'user.email=test@g-rex.local', 'commit', '-m', 'init'], {
      cwd: repoDir, stdio: 'ignore', windowsHide: true,
    });
  }
  return repoDir;
}

describe('M5 - Approvazione e prosecuzione', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m5-'));
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }));
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
  });

  async function newProject(name: string): Promise<string> {
    const repoDir = createGitRepo(dataDir, name.toLowerCase().replace(/\s+/g, '-'));
    const res = await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name, repositoryPath: repoDir } });
    expect(res.statusCode).toBe(201);
    return res.json().project.id as string;
  }

  async function newObjective(projectId: string, title: string): Promise<{ objectiveId: string; sessionId: string }> {
    const res = await built.app.inject({ method: 'POST', url: `/api/projects/${projectId}/objectives`, payload: { title, objectiveText: `Test M5: ${title}.` } });
    expect(res.statusCode).toBe(201);
    return { objectiveId: res.json().objective.id, sessionId: res.json().session.id };
  }

  async function startSession(objectiveId: string, sessionId: string): Promise<void> {
    const res = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start` });
    expect(res.statusCode).toBe(200);
  }

  async function completeObjective(objectiveId: string): Promise<string> {
    const res = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/complete`, payload: { summary: 'Lavoro completato.' } });
    expect(res.statusCode).toBe(200);
    return res.json().checkpoint.id as string;
  }

  async function blockObjective(objectiveId: string): Promise<string> {
    const res = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/block`, payload: { reason: 'Blocco test.' } });
    expect(res.statusCode).toBe(200);
    return res.json().checkpoint.id as string;
  }

  async function errorObjective(objectiveId: string): Promise<string> {
    const res = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/fail`, payload: { error: 'Errore tecnico' } });
    expect(res.statusCode).toBe(200);
    return res.json().checkpoint.id as string;
  }

  // AC1: APPROVE chiude checkpoint e obiettivo
  it('AC1 - APPROVE chiude checkpoint e obiettivo', async () => {
    const pid = await newProject('M5 Approve T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Approva');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'APPROVE', note: 'Ottimo!' } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.checkpoint.status).toBe('DECIDED');
    expect(b.checkpoint.decisionType).toBe('APPROVE');
    expect(b.checkpoint.decidedAt).toBeTruthy();
    expect(b.decision.note).toBe('Ottimo!');
    expect(b.objective.status).toBe('COMPLETATO');
    expect(b.objective.completedAt).toBeTruthy();
    expect(b.project.status).toBe('COMPLETATO');
  });

  // AC2: REQUEST_CHANGES lascia RICHIEDE_ATTENZIONE
  it('AC2 - REQUEST_CHANGES lascia obiettivo RICHIEDE_ATTENZIONE', async () => {
    const pid = await newProject('M5 ReqChg T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Modifiche');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'REQUEST_CHANGES', note: 'Manca doc.' } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.checkpoint.status).toBe('DECIDED');
    expect(b.checkpoint.decisionType).toBe('REQUEST_CHANGES');
    expect(b.objective.status).toBe('RICHIEDE_ATTENZIONE');
    expect(b.project.status).toBe('RICHIEDE_ATTENZIONE');
  });

  // AC3: STOP lascia obiettivo aperto
  it('AC3 - STOP interrompe ma tiene obiettivo aperto', async () => {
    const pid = await newProject('M5 Stop T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Ferma');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'STOP', note: 'Pausa.' } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.checkpoint.decisionType).toBe('STOP');
    expect(b.objective.status).toBe('RICHIEDE_ATTENZIONE');
    expect(b.project.status).toBe('RICHIEDE_ATTENZIONE');
  });

  // AC4: CANCEL annulla obiettivo e progetto
  it('AC4 - CANCEL annulla obiettivo e imposta progetto FERMO', async () => {
    const pid = await newProject('M5 Cancel T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Annulla');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'CANCEL' } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.checkpoint.decisionType).toBe('CANCEL');
    expect(b.objective.status).toBe('ANNULLATO');
    expect(b.project.status).toBe('FERMO');
  });

  // AC5: Note opzionale
  it('AC5 - Note opzionale su APPROVE', async () => {
    const pid = await newProject('M5 NoNote T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Senza nota');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'APPROVE' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision.note).toBeNull();
  });

  // AC6: M5-INV1 — DECIDED è irreversibile
  it('AC6 - Doppia decisione sullo stesso checkpoint rifiutata', async () => {
    const pid = await newProject('M5 Inv1 T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Irreversibile');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const r1 = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'APPROVE' } });
    expect(r1.statusCode).toBe(200);

    const r2 = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'CANCEL' } });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().message).toMatch(/già deciso/);
  });

  // AC7: Checkpoint inesistente
  it('AC7 - Checkpoint inesistente restituisce errore', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/checkpoints/nonexistent/decide', payload: { decisionType: 'APPROVE' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/non trovato/);
  });

  // AC8: DecisionType non valido
  it('AC8 - DecisionType non valido restituisce errore 400', async () => {
    const pid = await newProject('M5 Invalid T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Errore tipo');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'INVALID' } });
    expect(res.statusCode).toBe(400);
  });

  // AC9: CANCEL su COMPLETATO rifiutato (D5)
  it('AC9 - CANCEL rifiutato su obiettivo COMPLETATO', async () => {
    const pid = await newProject('M5 D5 T');
    const { objectiveId, sessionId } = await newObjective(pid, 'D5 test');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const ar = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'APPROVE' } });
    expect(ar.statusCode).toBe(200);
    expect(ar.json().objective.status).toBe('COMPLETATO');

    const cr = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/cancel` });
    expect(cr.statusCode).toBe(400);
    expect(cr.json().message).toMatch(/completato/);
  });

  // AC10: HumanDecision è append-only
  it('AC10 - Decisione registrata come record indipendente', async () => {
    const pid = await newProject('M5 Append T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Append');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'APPROVE', note: 'Storico' } });
    expect(res.statusCode).toBe(200);
    const d = res.json().decision;
    expect(d.id).toBeTruthy();
    expect(d.checkpointId).toBe(cid);
    expect(d.decisionType).toBe('APPROVE');
    expect(d.note).toBe('Storico');
    expect(d.decidedAt).toBeTruthy();
  });

  // AC11: pendingDecisions si riduce
  it('AC11 - pendingDecisions si riduce dopo decisione', async () => {
    const pid = await newProject('M5 Status T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Status');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const b = await built.app.inject({ method: 'GET', url: '/api/status' });
    const before = b.json().pendingDecisions as number;

    await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'APPROVE' } });

    const a = await built.app.inject({ method: 'GET', url: '/api/status' });
    expect(a.json().pendingDecisions).toBe(before - 1);
  });

  // AC12: Evento decision.made
  it('AC12 - Evento decision.made registrato', async () => {
    const pid = await newProject('M5 Event T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Event');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const beforeRes = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'APPROVE' } });
    expect(beforeRes.statusCode).toBe(200);

    // Verifica che l'ultimo evento sia decision.made
    const events = await built.app.inject({ method: 'GET', url: '/api/events?limit=200' });
    const allEvents = events.json().events as Array<{ type: string; payload: string }>;
    expect(allEvents.length).toBeGreaterThan(0);
    const decisionEvent = allEvents.find((e) => e.type === 'decision.made');
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent!.type).toBe('decision.made');
  });

  // AC13: CANCEL termina sessioni aperte
  it('AC13 - CANCEL termina sessioni aperte', async () => {
    const pid = await newProject('M5 Cancel Sess T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Sessione attiva');
    await startSession(objectiveId, sessionId);
    const cid = await completeObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'CANCEL' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().objective.status).toBe('ANNULLATO');

    const oRes = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
    const sessions = oRes.json().sessions as Array<{ status: string }>;
    for (const s of sessions) {
      expect(['COMPLETATA', 'ERRORE', 'INTERROTTA', 'BLOCCATA']).toContain(s.status);
    }
  });

  // AC14: APPROVE su BLOCKED checkpoint
  it('AC14 - APPROVE su checkpoint BLOCKED chiude obiettivo', async () => {
    const pid = await newProject('M5 Approve Blocked T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Blocca e approva');
    await startSession(objectiveId, sessionId);
    const cid = await blockObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'APPROVE' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().objective.status).toBe('COMPLETATO');
    expect(res.json().project.status).toBe('COMPLETATO');
  });

  it('AC15 - APPROVE su checkpoint ERROR chiude obiettivo', async () => {
    const pid = await newProject('M5 Approve Error T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Errore e approva');
    await startSession(objectiveId, sessionId);
    const cid = await errorObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'APPROVE' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().objective.status).toBe('COMPLETATO');
    expect(res.json().project.status).toBe('COMPLETATO');
  });

  it('AC16 - REQUEST_CHANGES su checkpoint ERROR lascia obiettivo RICHIEDE_ATTENZIONE', async () => {
    const pid = await newProject('M5 ReqChg Error T');
    const { objectiveId, sessionId } = await newObjective(pid, 'Errore e richiedi modifiche');
    await startSession(objectiveId, sessionId);
    const cid = await errorObjective(objectiveId);

    const res = await built.app.inject({ method: 'POST', url: `/api/checkpoints/${cid}/decide`, payload: { decisionType: 'REQUEST_CHANGES', note: 'Servono correzioni tecniche.' } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.checkpoint.status).toBe('DECIDED');
    expect(b.checkpoint.decisionType).toBe('REQUEST_CHANGES');
    expect(b.objective.status).toBe('RICHIEDE_ATTENZIONE');
    expect(b.project.status).toBe('RICHIEDE_ATTENZIONE');
  });
});
