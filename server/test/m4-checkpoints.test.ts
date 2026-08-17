import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * M4 — Checkpoint e attenzione umana (§12): conclusione, richiesta di
 * intervento, blocco ed errore di una sessione agente diventano checkpoint
 * persistenti e comprensibili (PENDING_DECISION) con evidenze classificate
 * §6 (SYSTEM verificato da Agent Control, AGENT dichiarato). Verifica che
 * la conclusione riuscita NON generi checkpoint né approvazione umana
 * (COMPLETATO automatico, §4.1 V2), che intervento/blocco/errore generino
 * checkpoint corretti, l'esposizione via API e il contatore decisioni in
 * /api/status, e la persistenza al riavvio.
 */

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
} catch {
  hasGit = false;
}

function runGit(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
}

function createGitRepo(baseDir: string, name: string, commitMessage: string): string {
  const repoDir = path.join(baseDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf8');
  runGit(repoDir, ['add', 'README.md']);
  runGit(repoDir, [
    '-c',
    'user.name=G-Rex Test',
    '-c',
    'user.email=test@g-rex.local',
    'commit',
    '-m',
    commitMessage,
  ]);
  return repoDir;
}

describe('M4 - checkpoint e attenzione umana', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m4-'));
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp(
      loadConfig({
        GAC_DATA_DIR: dataDir,
        GAC_LOG_LEVEL: 'silent',
        GAC_AGENT_MODE: 'fake',
      }),
    );
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
  });

  async function newProject(name: string, repositoryPath?: string): Promise<string> {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name, ...(repositoryPath ? { repositoryPath } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return res.json().project.id as string;
  }

  async function newObjective(
    projectId: string,
    title: string,
  ): Promise<{ objectiveId: string; sessionId: string }> {
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: { title, objectiveText: `Obiettivo di test M4: ${title}.` },
    });
    expect(res.statusCode).toBe(201);
    return { objectiveId: res.json().objective.id, sessionId: res.json().session.id };
  }

  async function start(objectiveId: string, sessionId: string): Promise<void> {
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });
    expect(res.statusCode).toBe(200);
  }

  it.skipIf(!hasGit)('conclusione: sessione COMPLETATA, obiettivo COMPLETATO automaticamente (report e snapshot Git finali)', async () => {
    const repoDir = createGitRepo(dataDir, 'repo-m4-complete', 'commit iniziale M4');
    const projectId = await newProject('m4-complete', repoDir);
    const { objectiveId, sessionId } = await newObjective(projectId, 'Concludere il lavoro');
    await start(objectiveId, sessionId);

    // L'agente dichiara di aver finito: si salva un commit ulteriore nel repo
    // perché il delta Git (evidenza SYSTEM) rilevi l'avanzamento dell'HEAD.
    fs.writeFileSync(path.join(repoDir, 'FEATURE.md'), 'lavoro concluso\n', 'utf8');
    runGit(repoDir, ['add', 'FEATURE.md']);
    runGit(repoDir, [
      '-c',
      'user.name=G-Rex Test',
      '-c',
      'user.email=test@g-rex.local',
      'commit',
      '-m',
      'lavoro M4',
    ]);
    // Working tree sporco: altra evidenza SYSTEM verificabile.
    fs.writeFileSync(path.join(repoDir, 'WIP.txt'), 'modifica non committata\n', 'utf8');

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/complete`,
      payload: {
        report: 'Implementata la fondazione M4 con i checkpoint.',
        summary: 'Fondazione M4 implementata e verificata.',
        acceptanceStatus: 'MET',
        testsSummary: '16 test verdi.',
        warnings: ['Nessuna avvertenza'],
        recommendedAction: 'Procedere con la revisione umana.',
      },
    });
    expect(res.statusCode).toBe(200);
    const { objective, session, project, checkpoint } = res.json();

    expect(session.status).toBe('COMPLETATA');
    // Completamento riuscito: stato terminale automatico (§ prodotto).
    expect(objective.status).toBe('COMPLETATO');
    expect(objective.completedAt).toBeTruthy();
    expect(objective.finalReport).toBe('Implementata la fondazione M4 con i checkpoint.');
    expect(objective.gitEnd?.branch).toBe('main');
    expect(project.status).toBe('FERMO');

    // Nessun checkpoint pendente per un completamento riuscito.
    expect(checkpoint).toBeNull();
  });

  it('richiesta di intervento: lo stop genera un checkpoint INTERRUPTED', async () => {
    const projectId = await newProject('m4-stop');
    const { objectiveId, sessionId } = await newObjective(projectId, 'Stop per intervento');
    await start(objectiveId, sessionId);

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/stop`,
      payload: { reason: 'Serve un chiarimento sul perimetro' },
    });
    expect(res.statusCode).toBe(200);
    const { objective, session, checkpoint } = res.json();
    expect(session.status).toBe('INTERROTTA');
    expect(objective.status).toBe('RICHIEDE_ATTENZIONE');

    expect(checkpoint.outcome).toBe('INTERRUPTED');
    expect(checkpoint.status).toBe('PENDING_DECISION');
    expect(checkpoint.summary).toBe('Richiesta di intervento: Serve un chiarimento sul perimetro');
    expect(checkpoint.recommendedAction).toBe('Rivedi il motivo dello stop e decidi come procedere.');
    // Senza repository le evidenze sono solo SYSTEM e il delta Git è assente.
    expect(checkpoint.evidenceSources).toEqual(['SYSTEM']);
    expect(checkpoint.gitDelta).toBeNull();
    expect(checkpoint.evidenceSummary).toContain('nessun repository');
  });

  it('blocco: sessione BLOCCATA, obiettivo/progetto BLOCCATO e checkpoint BLOCKED', async () => {
    const projectId = await newProject('m4-block');
    const { objectiveId, sessionId } = await newObjective(projectId, 'Blocco con richiesta di aiuto');
    await start(objectiveId, sessionId);

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/block`,
      payload: { reason: "L'agente non riesce a proseguire autonomamente" },
    });
    expect(res.statusCode).toBe(200);
    const { objective, session, project, checkpoint } = res.json();
    expect(session.status).toBe('BLOCCATA');
    expect(objective.status).toBe('BLOCCATO');
    expect(project.status).toBe('BLOCCATO');
    expect(checkpoint.outcome).toBe('BLOCKED');
    expect(checkpoint.status).toBe('PENDING_DECISION');
    expect(checkpoint.summary).toBe("Bloccato: L'agente non riesce a proseguire autonomamente");
    expect(checkpoint.recommendedAction).toContain('Sblocca');

    // BLOCCATO è uno stato attivo (§14): l'invariante resta impegnato.
    const conflict = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: { title: 'Non dovrebbe partire', objectiveText: "L'invariante è ancora attivo." },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('errore: sessione ERRORE, obiettivo/progetto ERRORE e checkpoint ERROR', async () => {
    const projectId = await newProject('m4-error');
    const { objectiveId, sessionId } = await newObjective(projectId, 'Errore tecnico');
    await start(objectiveId, sessionId);

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/fail`,
      payload: { error: 'Il processo agente è terminato con exit code 1' },
    });
    expect(res.statusCode).toBe(200);
    const { objective, session, project, checkpoint } = res.json();
    expect(session.status).toBe('ERRORE');
    expect(objective.status).toBe('ERRORE');
    expect(project.status).toBe('ERRORE');
    expect(checkpoint.outcome).toBe('ERROR');
    expect(checkpoint.status).toBe('PENDING_DECISION');
    // M19: il messaggio principale è tradotto in linguaggio comprensibile;
    // i dettagli tecnici grezzi restano separati dietro «Dettagli tecnici».
    expect(checkpoint.summary).not.toContain('exit code');
    expect(checkpoint.summary).toContain('errore durante');
    expect(checkpoint.technicalDetails).toBe('Il processo agente è terminato con exit code 1');
    expect(checkpoint.recommendedAction).toContain('Riprova');
    expect(checkpoint.evidenceSources).toEqual(['SYSTEM']);
  });

  it('espone i checkpoint via API e nel contatore decisioni di /api/status', async () => {
    const all = await built.app.inject({ method: 'GET', url: '/api/checkpoints?limit=100' });
    expect(all.statusCode).toBe(200);
    const outcomes = (all.json().checkpoints as Array<{ outcome: string }>).map((c) => c.outcome);
    expect(outcomes).toContain('INTERRUPTED');
    expect(outcomes).toContain('BLOCKED');
    expect(outcomes).toContain('ERROR');

    const pending = await built.app.inject({
      method: 'GET',
      url: '/api/checkpoints?status=PENDING_DECISION',
    });
    expect((pending.json().checkpoints as unknown[]).length).toBeGreaterThanOrEqual(3);

    const status = (await built.app.inject({ method: 'GET', url: '/api/status' })).json() as {
      pendingDecisions: number;
    };
    expect(status.pendingDecisions).toBeGreaterThanOrEqual(3);

    // I checkpoint sono esposti anche per obiettivo (404 se inesistente).
    const missing = await built.app.inject({
      method: 'GET',
      url: '/api/objectives/inesistente/checkpoints',
    });
    expect(missing.statusCode).toBe(404);
  });

  it("registra l'evento checkpoint.created", async () => {
    const events = (await built.app.inject({ method: 'GET', url: '/api/events?limit=100' })).json()
      .events as Array<{ type: string }>;
    const checkpointEvents = events.filter((e) => e.type === 'checkpoint.created');
    expect(checkpointEvents.length).toBeGreaterThanOrEqual(3);
  });

  it('persiste i checkpoint e il contatore decisioni attraverso il riavvio', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m4-persist-'));
    const first = await buildApp(
      loadConfig({ GAC_DATA_DIR: persistDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
    );
    const created = await first.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'm4-persistito' },
    });
    const persistProjectId = created.json().project.id as string;
    const obj = await first.app.inject({
      method: 'POST',
      url: `/api/projects/${persistProjectId}/objectives`,
      payload: {
        title: 'Obiettivo persistito M4',
        objectiveText: 'Il checkpoint deve sopravvivere al riavvio.',
      },
    });
    const objectiveId = obj.json().objective.id as string;
    const sessionId = obj.json().session.id as string;
    await first.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });
    const blocked = await first.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/block`,
      payload: { reason: 'Blocco prima del riavvio.' },
    });
    const checkpointId = blocked.json().checkpoint.id as string;

    await first.app.close();
    first.services.db.close();

    const second = await buildApp(
      loadConfig({ GAC_DATA_DIR: persistDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
    );
    try {
      const list = await second.app.inject({ method: 'GET', url: '/api/checkpoints?limit=100' });
      const checkpoints = list.json().checkpoints as Array<{
        id: string;
        status: string;
        outcome: string;
      }>;
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].id).toBe(checkpointId);
      expect(checkpoints[0].outcome).toBe('BLOCKED');
      expect(checkpoints[0].status).toBe('PENDING_DECISION');

      const status = (await second.app.inject({ method: 'GET', url: '/api/status' })).json() as {
        pendingDecisions: number;
      };
      expect(status.pendingDecisions).toBe(1);

      const detail = await second.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
      const detailBody = detail.json() as { objective: { status: string }; checkpoints: unknown[] };
      expect(detailBody.objective.status).toBe('BLOCCATO');
      expect(detailBody.checkpoints).toHaveLength(1);
    } finally {
      await second.app.close();
      second.services.db.close();
    }
  });
});
