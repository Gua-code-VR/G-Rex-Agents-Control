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
 * Verifica creazione con sessione iniziale, più obiettivi attivi nello stesso
 * progetto gestiti dalla coda, avvio/stop/completamento, annullamento, eventi
 * e persistenza al riavvio. L'adapter agente è il fake (§8): nessun processo
 * esterno.
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
      loadConfig({
        GAC_DATA_DIR: dataDir,
        GAC_LOG_LEVEL: 'silent',
        GAC_AGENT_MODE: 'fake',
        GAC_CLINE_ENABLED: 'false',
        GAC_CODEX_ENABLED: 'false',
      }),
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

  it("crea un obiettivo e lo avvia automaticamente quando un worker è disponibile", async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: {
        title: 'Completare la fondazione M3',
        objectiveText: 'Implementare obiettivi e sessioni agente secondo il §5.',
        invariants: ['Workspace isolato quando il progetto ha repository Git'],
        acceptanceCriteria: ['I test passano', 'La dashboard mostra le sessioni'],
        stopCondition: 'Quando la prima demo è pronta',
      },
    });
    expect(res.statusCode).toBe(201);
    const { objective, session, project } = res.json();
    expect(objective.id).toBeTruthy();
    expect(objective.projectId).toBe(projectId);
    // Worker fake disponibile: la coda di esecuzione avvia subito l'obiettivo.
    expect(objective.status).toBe('IN_LAVORAZIONE');
    expect(objective.invariants).toEqual(['Workspace isolato quando il progetto ha repository Git']);
    expect(objective.acceptanceCriteria).toHaveLength(2);
    expect(objective.stopCondition).toBe('Quando la prima demo è pronta');
    expect(session.objectiveId).toBe(objective.id);
    expect(session.status).toBe('ATTIVA');
    expect(session.agentType).toBe('fake');
    expect(session.executionSelection).toMatchObject({ runtimeId: 'fake', decision: { mode: 'AUTOMATIC' } });
    expect(project.status).toBe('IN_LAVORAZIONE');
    expect(project.currentObjective).toBe('Completare la fondazione M3');
    expect(project.currentObjectiveId).toBe(objective.id);
    expect(res.json().autoStart).toEqual({ started: true });
    const attempts = built.services.db.prepare('SELECT count(*) count FROM execution_attempts WHERE session_id = ?').get(session.id) as { count: number };
    expect(attempts.count).toBe(1);

    // L'avvio esplicito resta idempotente per una sessione già attiva.
    const started = await built.app.inject({ method: 'POST', url: `/api/objectives/${objective.id}/sessions/${session.id}/start` });
    expect(started.statusCode).toBe(200);
    expect(started.json().session.status).toBe('ATTIVA');
  });

  it('consente un secondo obiettivo attivo nello stesso progetto e lo lascia alla coda se gli slot sono occupati', async () => {
    const project = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'm3-paralleli' },
    });
    expect(project.statusCode).toBe(201);
    const parallelProjectId = project.json().project.id as string;

    const first = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${parallelProjectId}/objectives`,
      payload: { title: 'Primo parallelo', objectiveText: 'Occupa lo slot fake.' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().objective.status).toBe('IN_AVVIO');
    expect(first.json().session.status).toBe('IN_AVVIO');

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${parallelProjectId}/objectives`,
      payload: { title: 'Secondo obiettivo', objectiveText: 'Deve essere accettato e accodato.' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().autoStart).toEqual({ started: false });
    expect(res.json().objective.status).toBe('IN_AVVIO');
    expect(res.json().session.status).toBe('IN_AVVIO');

    const objectives = built.services.objectives.listByProject(parallelProjectId);
    expect(objectives.filter((objective) => objective.status === 'IN_AVVIO' || objective.status === 'IN_LAVORAZIONE')).toHaveLength(2);
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
    expect(sessions[0].status).toBe('ATTIVA');
  });

  it('espone la sessione auto-avviata: agente attivo e progetto in lavorazione', async () => {
    const list = await built.app.inject({ method: 'GET', url: `/api/projects/${projectId}/objectives` });
    const objectiveId = list.json().objectives[0].id as string;
    const detail = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });

    const { objective, sessions } = detail.json();
    const session = sessions[0];
    const project = built.services.projects.getById(projectId)!;
    expect(session.status).toBe('ATTIVA');
    expect(session.processReference).toContain('fake-');
    expect(session.lastActivityAt).toBeTruthy();
    expect(objective.status).toBe('IN_LAVORAZIONE');
    expect(objective.startedAt).toBeTruthy();
    expect(project.status).toBe('IN_LAVORAZIONE');
  });

  it('rende idempotente un secondo avvio della stessa sessione', async () => {
    const list = await built.app.inject({ method: 'GET', url: `/api/projects/${projectId}/objectives` });
    const objectiveId = list.json().objectives[0].id as string;
    const detail = await built.app.inject({ method: 'GET', url: `/api/objectives/${objectiveId}` });
    const sessionId = detail.json().sessions[0].id as string;

    const res = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe('ATTIVA');
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

  it.skipIf(!hasGit)('conclude il lavoro con report e snapshot Git finale (completamento automatico)', async () => {
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
    // Completamento riuscito: stato terminale automatico (§ prodotto).
    expect(objective.status).toBe('COMPLETATO');
    expect(objective.completedAt).toBeTruthy();
    expect(objective.finalReport).toBe('Obiettivo completato: tutti i test passano.');
    expect(objective.gitStart).not.toBeNull();
    expect(objective.gitEnd).not.toBeNull();
    expect(objective.gitEnd?.branch).toBe('main');
    expect(project.status).toBe('FERMO');
    expect(checkpoint).toBeNull();

    // COMPLETATO è terminale: l'invariante §14 è liberato, un nuovo
    // obiettivo è subito ammesso.
    const again = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${completeProjectId}/objectives`,
      payload: { title: 'Dopo il completamento', objectiveText: 'Nuovo ciclo ammesso.' },
    });
    expect(again.statusCode).toBe(201);
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
    // M4/V2: gli esiti che richiedono una decisione (stop/blocco/errore)
    // generano un checkpoint; il completamento riuscito non ne genera (§4.1).
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
