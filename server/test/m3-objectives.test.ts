import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * M3 — Obiettivi e sessioni agente (§12): ciclo obiettivo → sessione
 * agente → stato operativo, senza dipendere dalla UI di VS Code.
 * Verifica creazione con sessione iniziale, invariante «un solo obiettivo
 * attivo» (§14), avvio/stop/completamento, annullamento, eventi e
 * persistenza al riavvio. L'adapter agente è il fake (§8): nessun
 * processo esterno.
 */

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
} catch {
  hasGit = false;
}

function createGitRepo(baseDir: string, name: string, commitMessage: string): string {
  const repoDir = path.join(baseDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe', windowsHide: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'pipe', windowsHide: true });
  execFileSync(
    'git',
    ['-c', 'user.name=G-Rex Test', '-c', 'user.email=test@g-rex.local', 'commit', '-m', commitMessage],
    { cwd: repoDir, stdio: 'pipe', windowsHide: true },
  );
  return repoDir;
}

describe('M3 - obiettivi e sessioni agente', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m3-'));
  let built: BuiltApp;
  let projectId: string;

  beforeAll(async () => {
    built = await buildApp(
      loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
    );
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'm3-demo' },
    });
    projectId = res.json().project.id;
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
  });

  it('crea un obiettivo con la sessione agente iniziale', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: {
        title: 'Completare la fondazione M3',
        objectiveText: 'Implementare obiettivi e sessioni agente secondo il §5.',
        invariants: ['Un solo obiettivo attivo per progetto'],
        acceptanceCriteria: ['I test passano', 'La dashboard mostra le sessioni'],
        stopCondition: 'Quando la prima demo è pronta',
      },
    });
    expect(res.statusCode).toBe(201);
    const { objective, session, project } = res.json();
    expect(objective.id).toBeTruthy();
    expect(objective.projectId).toBe(projectId);
    expect(objective.status).toBe('IN_AVVIO');
    expect(objective.invariants).toEqual(['Un solo obiettivo attivo per progetto']);
    expect(objective.acceptanceCriteria).toHaveLength(2);
    expect(objective.stopCondition).toBe('Quando la prima demo è pronta');
    expect(session.objectiveId).toBe(objective.id);
    expect(session.status).toBe('IN_AVVIO');
    expect(session.agentType).toBe('fake');
    expect(project.status).toBe('IN_AVVIO');
    expect(project.currentObjective).toBe('Completare la fondazione M3');
    expect(project.currentObjectiveId).toBe(objective.id);
  });

  it('rispetta l’invariante §14: un solo obiettivo attivo per progetto (409)', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: { title: 'Secondo obiettivo', objectiveText: 'Non dovrebbe partire.' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('attivo');
  });

  it('rifiuta un obiettivo senza titolo o testo (400)', async () => {
    const noTitle = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: { title: '   ', objectiveText: 'testo valido' },
    });
    expect(noTitle.statusCode).toBe(400);

    const noText = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: { title: 'Titolo valido', objectiveText: '' },
    });
    expect(noText.statusCode).toBe(400);
  });

  it('ritorna 404 per un progetto inesistente', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/projects/progetto-inesistente/objectives',
      payload: { title: 'x', objectiveText: 'y' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('elenca gli obiettivi del progetto', async () => {
    const res = await built.app.inject({ method: 'GET', url: `/api/projects/${projectId}/objectives` });
    expect(res.statusCode).toBe(200);
    const { objectives } = res.json();
    expect(objectives).toHaveLength(1);
    expect(objectives[0].title).toBe('Completare la fondazione M3');
  });

  it('espone il dettaglio dell’obiettivo con le sessioni', async () => {
    const list = await built.app.inject({ method: 'GET', url: `/api/projects/${projectId}/objectives` });
    const objectiveId = list.json().objectives[0].id as string;
    const res = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
    expect(res.statusCode).toBe(200);
    const { objective, sessions } = res.json();
    expect(objective.id).toBe(objectiveId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('IN_AVVIO');
  });

  it('avvia la sessione: agente attivo e progetto in lavorazione', async () => {
    const list = await built.app.inject({ method: 'GET', url: `/api/projects/${projectId}/objectives` });
    const objectiveId = list.json().objectives[0].id as string;
    const detail = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
    const sessionId = detail.json().sessions[0].id as string;

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });
    expect(res.statusCode).toBe(200);
    const { objective, session, project } = res.json();
    expect(session.status).toBe('ATTIVA');
    expect(session.processReference).toContain('fake-');
    expect(session.lastActivityAt).toBeTruthy();
    expect(objective.status).toBe('IN_LAVORAZIONE');
    expect(objective.startedAt).toBeTruthy();
    expect(project.status).toBe('IN_LAVORAZIONE');
  });

  it('rifiuta un doppio avvio della stessa sessione (400)', async () => {
    const list = await built.app.inject({ method: 'GET', url: `/api/projects/${projectId}/objectives` });
    const objectiveId = list.json().objectives[0].id as string;
    const detail = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
    const sessionId = detail.json().sessions[0].id as string;

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('attesa di avvio');
  });

  it('ferma la sessione: obiettivo e progetto richiedono attenzione', async () => {
    const list = await built.app.inject({ method: 'GET', url: `/api/projects/${projectId}/objectives` });
    const objectiveId = list.json().objectives[0].id as string;
    const detail = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
    const sessionId = detail.json().sessions[0].id as string;

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/stop`,
      payload: { reason: 'Prima bozza pronta: serve una decisione umana' },
    });
    expect(res.statusCode).toBe(200);
    const { objective, session, project, checkpoint } = res.json();
    expect(session.status).toBe('INTERROTTA');
    expect(session.exitReason).toBe('Prima bozza pronta: serve una decisione umana');
    expect(session.endedAt).toBeTruthy();
    expect(objective.status).toBe('RICHIEDE_ATTENZIONE');
    expect(project.status).toBe('RICHIEDE_ATTENZIONE');
    // M4: lo stop è una richiesta di intervento → checkpoint PENDING_DECISION.
    expect(checkpoint).not.toBeNull();
    expect(checkpoint.outcome).toBe('INTERRUPTED');
    expect(checkpoint.status).toBe('PENDING_DECISION');
    expect(checkpoint.summary).toContain('Prima bozza pronta');
  });

  it('rifiuta lo stop su una sessione non attiva (400)', async () => {
    const list = await built.app.inject({ method: 'GET', url: `/api/projects/${projectId}/objectives` });
    const objectiveId = list.json().objectives[0].id as string;
    const detail = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
    const sessionId = detail.json().sessions[0].id as string;

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/stop`,
      payload: { reason: 'troppo tardi' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('non è attiva');
  });

  it('rifiuta il completamento senza una sessione attiva (400)', async () => {
    const list = await built.app.inject({ method: 'GET', url: `/api/projects/${projectId}/objectives` });
    const objectiveId = list.json().objectives[0].id as string;

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/complete`,
      payload: { report: 'Non dovrebbe essere possibile' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('sessione attiva');
  });

  it.skipIf(!hasGit)('conclude il lavoro con report e snapshot Git finale (M4: resta RICHIEDE_ATTENZIONE)', async () => {
    const repoDir = createGitRepo(dataDir, 'repo-m3-complete', 'commit iniziale M3');
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'm3-complete', repositoryPath: repoDir },
    });
    const completeProjectId = created.json().project.id as string;

    const createdObj = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${completeProjectId}/objectives`,
      payload: {
        title: 'Obiettivo da completare',
        objectiveText: 'Deve terminare con report e snapshot Git finale.',
      },
    });
    const objectiveId = createdObj.json().objective.id as string;
    const sessionId = createdObj.json().session.id as string;

    await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/complete`,
      payload: {
        report: 'Obiettivo completato: tutti i test passano.',
        summary: 'Lavoro completo con test verdi.',
        acceptanceStatus: 'MET',
        testsSummary: 'Test passano.',
        warnings: ['Nessuna'],
        recommendedAction: 'Procedere con la revisione.',
      },
    });
    expect(res.statusCode).toBe(200);
    const { objective, session, project, checkpoint } = res.json();
    expect(session.status).toBe('COMPLETATA');
    // M4: la conclusione NON è l'approvazione. L'obiettivo resta
    // RICHIEDE_ATTENZIONE con checkpoint PENDING_DECISION: la decisione
    // umana (COMPLETATO) arriva con M5.
    expect(objective.status).toBe('RICHIEDE_ATTENZIONE');
    expect(objective.completedAt).toBeNull();
    expect(objective.finalReport).toBe('Obiettivo completato: tutti i test passano.');
    expect(objective.gitStart).not.toBeNull();
    expect(objective.gitEnd).not.toBeNull();
    expect(objective.gitEnd?.branch).toBe('main');
    expect(project.status).toBe('RICHIEDE_ATTENZIONE');
    expect(checkpoint).not.toBeNull();
    expect(checkpoint.outcome).toBe('COMPLETED');
    expect(checkpoint.status).toBe('PENDING_DECISION');
    expect(checkpoint.summary).toBe('Lavoro completo con test verdi.');
    expect(checkpoint.acceptanceStatus).toBe('MET');
    expect(checkpoint.evidenceSources).toEqual(expect.arrayContaining(['SYSTEM', 'AGENT']));

    // M4: RICHIEDE_ATTENZIONE è uno stato non terminale, quindi l'invariante
    // §14 resta attivo dopo la conclusione: il nuovo obiettivo è rifiutato.
    const again = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${completeProjectId}/objectives`,
      payload: { title: 'Dopo il completamento', objectiveText: 'L’invariante è ancora attivo.' },
    });
    expect(again.statusCode).toBe(409);

    // La decisione umana di M5 chiuderà l'obiettivo; intanto l'annullamento
    // (già M3) libera l'invariante per un nuovo ciclo.
    const closed = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/cancel`,
    });
    expect(closed.statusCode).toBe(200);

    const free = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${completeProjectId}/objectives`,
      payload: { title: 'Dopo la chiusura', objectiveText: 'L’invariante è libero.' },
    });
    expect(free.statusCode).toBe(201);
  });

  it('annulla l’obiettivo: stato FERMO, sessioni aperte interrotte e invariante libero', async () => {
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'm3-cancel' },
    });
    const cancelProjectId = created.json().project.id as string;

    const createdObj = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${cancelProjectId}/objectives`,
      payload: { title: 'Obiettivo da annullare', objectiveText: 'Non serve più.' },
    });
    const objectiveId = createdObj.json().objective.id as string;
    const sessionId = createdObj.json().session.id as string;

    await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });

    const res = await built.app.inject({ method: 'POST', url: `/api/objectives/${objectiveId}/cancel` });
    expect(res.statusCode).toBe(200);
    const { objective, project } = res.json();
    expect(objective.status).toBe('ANNULLATO');
    expect(project.status).toBe('FERMO');
    expect(project.currentObjective).toBeNull();
    expect(project.currentObjectiveId).toBeNull();

    // La sessione ancora aperta viene interrotta dall'annullamento.
    const detail = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
    const sessions = detail.json().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('INTERROTTA');
    expect(sessions[0].exitReason).toBe('Obiettivo annullato');

    // L'annullamento libera l'invariante: un nuovo obiettivo può partire.
    const again = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${cancelProjectId}/objectives`,
      payload: { title: 'Dopo l’annullamento', objectiveText: 'L’invariante è libero.' },
    });
    expect(again.statusCode).toBe(201);
  });

  it('registra gli eventi del ciclo obiettivo nello State & Event Store', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/events?limit=100' });
    const types = res.json().events.map((event: { type: string }) => event.type);
    expect(types).toContain('objective.created');
    expect(types).toContain('session.started');
    expect(types).toContain('session.stopped');
    expect(types).toContain('objective.cancelled');
    expect(types).toContain('session.completed');
    // M4: ogni esito del ciclo genera anche un checkpoint.
    expect(types).toContain('checkpoint.created');
  });

  it('ricostruisce obiettivi e sessioni dopo il riavvio', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m3-persist-'));
    const first = await buildApp(
      loadConfig({ GAC_DATA_DIR: persistDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
    );

    const created = await first.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'persistito-m3' },
    });
    const persistProjectId = created.json().project.id as string;

    const createdObj = await first.app.inject({
      method: 'POST',
      url: `/api/projects/${persistProjectId}/objectives`,
      payload: { title: 'Obiettivo persistito', objectiveText: 'Deve sopravvivere al riavvio.' },
    });
    const objectiveId = createdObj.json().objective.id as string;
    const sessionId = createdObj.json().session.id as string;
    await first.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });

    // Riavvio completo: chiude la prima istanza e riapre sulla stessa directory.
    await first.app.close();
    first.services.db.close();

    const second = await buildApp(
      loadConfig({ GAC_DATA_DIR: persistDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
    );
    try {
      const list = await second.app.inject({
        method: 'GET',
        url: `/api/projects/${persistProjectId}/objectives`,
      });
      const objectives = list.json().objectives;
      expect(objectives).toHaveLength(1);
      expect(objectives[0].title).toBe('Obiettivo persistito');
      expect(objectives[0].status).toBe('IN_LAVORAZIONE');

      const detail = await second.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
      const sessions = detail.json().sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe('ATTIVA');

      const project = (await second.app.inject({ method: 'GET', url: `/api/projects/${persistProjectId}` })).json()
        .project;
      expect(project.status).toBe('IN_LAVORAZIONE');
      expect(project.currentObjectiveId).toBe(objectiveId);
    } finally {
      await second.app.close();
      second.services.db.close();
    }
  });
});
