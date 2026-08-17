import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AgentSession } from '../src/domain/objective.js';

/**
 * §19 V2 — workspace Git isolate (worktree + branch dedicato).
 *
 * Verifica end-to-end, contro un repository Git reale, il lifecycle della
 * workspace: provisioning all'avvio, isolamento tra Objective, riuso per
 * retry/fallback, integrazione controllata al completamento, riconciliazione
 * dopo crash/riavvio e pulizia che preserva il lavoro non integrato.
 */

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}

/** Crea un repository Git minimale con un commit iniziale. */
function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['-c', 'user.name=GAC Test', '-c', 'user.email=test@gac.local', 'commit', '--allow-empty', '-m', 'init']);
}

describe('§19 — workspace Git isolate (worktree)', () => {
  const apps: BuiltApp[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app, services }) => app.close().finally(() => services.db.close())));
    dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  async function makeApp(): Promise<BuiltApp> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-ws-'));
    dirs.push(dataDir);
    const built = await buildApp(loadConfig({
      GAC_DATA_DIR: dataDir,
      GAC_LOG_LEVEL: 'silent',
      GAC_DEFAULT_RUNTIME: 'fake',
      GAC_CLINE_ENABLED: 'false',
      GAC_CODEX_ENABLED: 'false',
      GAC_WORKSPACES_ENABLED: 'true',
      GAC_WORKSPACES_DIR: path.join(dataDir, 'workspaces'),
    }));
    apps.push(built);
    return built;
  }

  async function projectWithRepo(built: BuiltApp, name: string): Promise<{ projectId: string; repoDir: string }> {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-repo-'));
    dirs.push(repoDir);
    initRepo(repoDir);
    const project = (await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name, repositoryPath: repoDir } })).json().project;
    return { projectId: project.id, repoDir };
  }

  async function createObjective(built: BuiltApp, projectId: string, title: string) {
    const res = await built.app.inject({ method: 'POST', url: `/api/projects/${projectId}/objectives`, payload: { title, objectiveText: `Obiettivo: ${title}` } });
    expect(res.statusCode).toBe(201);
    return res.json() as { objective: { id: string; status: string }; session: { id: string; status: string }; autoStart: { started: boolean } };
  }

  it('crea una workspace isolata (worktree + branch dedicato) all’avvio', async () => {
    const built = await makeApp();
    const { projectId } = await projectWithRepo(built, 'WS prov');
    const created = await createObjective(built, projectId, 'Isolamento');
    expect(created.autoStart.started).toBe(true);

    const workspaces = built.services.workspaces.list();
    expect(workspaces).toHaveLength(1);
    const ws = workspaces[0];
    expect(ws.status).toBe('ACTIVE');
    expect(ws.branch).toBe(`gac/objective/${created.objective.id}`);
    expect(fs.existsSync(ws.worktreePath)).toBe(true);

    const row = built.services.db.prepare('SELECT workspace_id FROM sessions WHERE id = ?').get(created.session.id) as { workspace_id: string | null };
    expect(row.workspace_id).toBe(ws.id);
  });

  it('obiettivi diversi ricevono worktree e branch distinti (§19.1)', async () => {
    const built = await makeApp();
    const { projectId } = await projectWithRepo(built, 'WS iso');

    const a = await createObjective(built, projectId, 'Primo');
    expect(a.autoStart.started).toBe(true);
    const wsA = built.services.workspaces.listByObjective(a.objective.id)[0];
    expect(wsA).toBeTruthy();

    // Completa il primo (integra e rimuove il worktree) per liberare il worker.
    const done = await built.app.inject({ method: 'POST', url: `/api/objectives/${a.objective.id}/complete`, payload: { report: 'Fatto.' } });
    expect(done.statusCode).toBe(200);

    const b = await createObjective(built, projectId, 'Secondo');
    expect(b.autoStart.started).toBe(true);
    const wsB = built.services.workspaces.listByObjective(b.objective.id)[0];
    expect(wsB).toBeTruthy();

    expect(wsB.branch).not.toBe(wsA.branch);
    expect(wsB.worktreePath).not.toBe(wsA.worktreePath);
  });

  it('retry/riavvio riusa la stessa workspace preservando il lavoro (§19.2)', async () => {
    const built = await makeApp();
    const { projectId } = await projectWithRepo(built, 'WS retry');
    const created = await createObjective(built, projectId, 'Retry');
    expect(created.autoStart.started).toBe(true);

    const before = built.services.workspaces.listByObjective(created.objective.id);
    expect(before).toHaveLength(1);

    // Simula una nuova sessione della stessa esecuzione (retry/fallback):
    // la risoluzione del percorso deve riusare la workspace già prodotta.
    const { objective, sessions } = built.services.objectives.getWithSessions(created.objective.id)!;
    const project = built.services.projects.getById(projectId)!;
    const retrySession: AgentSession = { ...sessions[0], id: 'retry-session' };

    const resolved = await built.services.workspaces.resolveExecutionPath(project, objective, retrySession);

    expect(resolved.workspace?.id).toBe(before[0].id);
    expect(resolved.path).toBe(before[0].worktreePath);
    expect(built.services.workspaces.listByObjective(created.objective.id)).toHaveLength(1);
  });

  it('integra il lavoro al completamento: merge del branch e rimozione del worktree (§19.4)', async () => {
    const built = await makeApp();
    const { projectId, repoDir } = await projectWithRepo(built, 'WS integra');
    const created = await createObjective(built, projectId, 'Integra');
    expect(created.autoStart.started).toBe(true);

    const ws = built.services.workspaces.listByObjective(created.objective.id)[0];
    // Produce una modifica nel worktree isolato, poi la committa al completamento.
    fs.writeFileSync(path.join(ws.worktreePath, 'work.txt'), 'lavoro prodotto\n');

    const done = await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/complete`, payload: { report: 'Fatto.' } });
    expect(done.statusCode).toBe(200);

    const updated = built.services.workspaces.getById(ws.id)!;
    expect(updated.status).toBe('INTEGRATED');
    expect(fs.existsSync(ws.worktreePath)).toBe(false);
    // Il lavoro committato è stato integrato nella working tree principale.
    expect(fs.existsSync(path.join(repoDir, 'work.txt'))).toBe(true);
  });

  it('reconcile: una workspace senza worktree passa STALE e viene recuperata se ritrovata (§19.5)', async () => {
    const built = await makeApp();
    const { projectId, repoDir } = await projectWithRepo(built, 'WS reconcile');
    const created = await createObjective(built, projectId, 'Reconcile');
    expect(created.autoStart.started).toBe(true);
    const ws = built.services.workspaces.listByObjective(created.objective.id)[0];

    // Rimuove fisicamente il worktree: alla riconciliazione la workspace è STALE.
    git(repoDir, ['worktree', 'remove', ws.worktreePath]);
    const stale = await built.services.workspaces.reconcile();
    expect(stale.stale).toBeGreaterThanOrEqual(1);
    expect(built.services.workspaces.getById(ws.id)!.status).toBe('STALE');

    // Il branch esiste ancora: ricreando il worktree la workspace torna ACTIVE.
    git(repoDir, ['worktree', 'add', ws.worktreePath, ws.branch]);
    const recovered = await built.services.workspaces.reconcile();
    expect(recovered.recovered).toBeGreaterThanOrEqual(1);
    expect(built.services.workspaces.getById(ws.id)!.status).toBe('ACTIVE');
  });

  it('cleanup non elimina una workspace con lavoro non integrato senza force (§19.5)', async () => {
    const built = await makeApp();
    const { projectId, repoDir } = await projectWithRepo(built, 'WS cleanup');
    const created = await createObjective(built, projectId, 'Cleanup');
    expect(created.autoStart.started).toBe(true);
    const ws = built.services.workspaces.listByObjective(created.objective.id)[0];

    // Rende sporca la working tree principale: l'integrazione al completamento
    // viene rinviata e la workspace diventa PENDING_INTEGRATION.
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'modifica non committata\n');
    const done = await built.app.inject({ method: 'POST', url: `/api/objectives/${created.objective.id}/complete`, payload: { report: 'Fatto.' } });
    expect(done.statusCode).toBe(200);
    expect(built.services.workspaces.getById(ws.id)!.status).toBe('PENDING_INTEGRATION');

    const refusal = await built.app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/cleanup`, payload: {} });
    expect(refusal.statusCode).toBe(409);
    expect(built.services.workspaces.getById(ws.id)!.status).toBe('PENDING_INTEGRATION');

    const forced = await built.app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/cleanup`, payload: { force: true } });
    expect(forced.statusCode).toBe(200);
    expect(built.services.workspaces.getById(ws.id)!.status).toBe('REMOVED');
  });
});

