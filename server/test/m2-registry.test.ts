import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * M2 — Registro progetti e stato (§12): più progetti indipendenti,
 * stato operativo ufficiale, obiettivo corrente, stato Git essenziale,
 * persistenza al riavvio e raggruppamento dashboard (fermo /
 * in lavorazione / con problema).
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

/** Crea un repository Git reale pronto per la verifica dello stato essenziale. */
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

describe('M2 - registro progetti e stato', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m2-'));
  let built: BuiltApp;
  let repoDir: string;

  beforeAll(async () => {
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }));
    repoDir = createGitRepo(dataDir, 'repo-test', 'primo commit di test');
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
  });

  it('registra e mantiene tre progetti indipendenti', async () => {
    const inputs = [
      {
        name: 'progetto-alpha',
        repositoryPath: 'C:\\repo\\alpha',
        currentObjective: 'Completare M2 del registro progetti',
      },
      {
        name: 'progetto-beta',
        repositoryPath: 'C:\\repo\\beta',
        currentObjective: 'Refactor del modulo eventi',
      },
      { name: 'progetto-gamma', repositoryPath: 'C:\\repo\\gamma' },
    ];

    const created: Array<{
      id: string;
      name: string;
      repositoryPath: string | null;
      currentObjective: string | null;
    }> = [];
    for (const input of inputs) {
      const res = await built.app.inject({ method: 'POST', url: '/api/projects', payload: input });
      expect(res.statusCode).toBe(201);
      const project = res.json().project;
      // «Crea progetto» con obiettivo iniziale crea l'Objective e lo avvia
      // subito (IN_LAVORAZIONE); senza obiettivo il progetto resta FERMO.
      expect(project.status).toBe(input.currentObjective ? 'IN_LAVORAZIONE' : 'FERMO');
      expect(project.statusGroup).toBe(input.currentObjective ? 'IN_LAVORAZIONE' : 'FERMO');
      expect(project.currentObjective).toBe(input.currentObjective ?? null);
      // Il repository viene associato già in creazione: lo snapshot è presente
      // anche per percorsi non validi (errore esplicito, mai null).
      expect(project.gitStatus).not.toBeNull();
      // L'obiettivo iniziale (se fornito) è stato creato come entità Objective
      // e avviato automaticamente (senza conferma della selezione).
      if (input.currentObjective) {
        expect(res.json().initialObjective).toBeTruthy();
        expect(res.json().initialObjective.objective.title).toBe(input.currentObjective);
        expect(res.json().initialObjective.autoStart).toEqual({ started: true });
        expect(res.json().initialObjective.session.status).toBe('ATTIVA');
      } else {
        expect(res.json().initialObjective).toBeNull();
      }
      created.push(project);
    }
    expect(created).toHaveLength(3);

    const list = await built.app.inject({ method: 'GET', url: '/api/projects' });
    const projects: Array<{ id: string; name: string; repositoryPath: string | null; currentObjective: string | null }> =
      list.json().projects;
    expect(projects).toHaveLength(3);

    const byName = Object.fromEntries(projects.map((p) => [p.name, p]));
    // Ogni progetto conserva i propri dati: nessun incrocio tra i tre.
    expect(byName['progetto-alpha'].repositoryPath).toBe('C:\\repo\\alpha');
    expect(byName['progetto-alpha'].currentObjective).toBe('Completare M2 del registro progetti');
    expect(byName['progetto-beta'].currentObjective).toBe('Refactor del modulo eventi');
    expect(byName['progetto-gamma'].repositoryPath).toBe('C:\\repo\\gamma');
    expect(byName['progetto-gamma'].currentObjective ?? null).toBeNull();
    expect(new Set(projects.map((p) => p.id)).size).toBe(3);

    for (const project of created) {
      const get = await built.app.inject({ method: 'GET', url: `/api/projects/${project.id}` });
      expect(get.statusCode).toBe(200);
      expect(get.json().project.name).toBe(project.name);
    }
  });

  it('aggiorna repository e obiettivo corrente (PATCH)', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'progetto-update', repositoryPath: 'C:\\repo\\upd' },
    });
    const id = res.json().project.id as string;

    const patch = await built.app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      payload: { currentObjective: 'Nuovo obiettivo assegnato' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().project.currentObjective).toBe('Nuovo obiettivo assegnato');
    expect(patch.json().project.repositoryPath).toBe('C:\\repo\\upd');

    const clear = await built.app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      payload: { currentObjective: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().project.currentObjective).toBeNull();

    const emptyPatch = await built.app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      payload: {},
    });
    expect(emptyPatch.statusCode).toBe(400);

    const missing = await built.app.inject({
      method: 'PATCH',
      url: '/api/projects/nonexistent',
      payload: { currentObjective: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('lo stato operativo è derivato (nessun override manuale)', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'progetto-stato' },
    });
    const id = res.json().project.id as string;
    expect(res.json().project.status).toBe('FERMO');

    // L'override manuale dello stato è stato rimosso (§ prodotto): 404.
    const override = await built.app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}/status`,
      payload: { status: 'IN_LAVORAZIONE' },
    });
    expect(override.statusCode).toBe(404);
  });

  it('la dashboard (raggruppamento) distingue fermo / in lavorazione / problema', async () => {
    const names = ['gruppo-fermo', 'gruppo-lavoro', 'gruppo-problema'];
    const ids: string[] = [];
    for (const name of names) {
      const res = await built.app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
      ids.push(res.json().project.id as string);
    }
    // Lo stato è derivato dal ciclo obiettivo; qui si forzano gli stati via DB
    // per verificare il raggruppamento della dashboard.
    built.services.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('IN_LAVORAZIONE', ids[1]);
    built.services.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('ERRORE', ids[2]);

    const statusRes = await built.app.inject({ method: 'GET', url: '/api/status' });
    const body = statusRes.json();
    expect(body.projectsByGroup.FERMO).toBeGreaterThanOrEqual(1);
    expect(body.projectsByGroup.IN_LAVORAZIONE).toBeGreaterThanOrEqual(1);
    expect(body.projectsByGroup.PROBLEMA).toBeGreaterThanOrEqual(1);
    expect(body.projectsByStatus.IN_LAVORAZIONE).toBeGreaterThanOrEqual(1);
    expect(body.projectsByStatus.ERRORE).toBeGreaterThanOrEqual(1);

    const list = await built.app.inject({ method: 'GET', url: '/api/projects' });
    const groups = new Set(
      list.json().projects
        .filter((p: { name: string }) => names.includes(p.name))
        .map((p: { statusGroup: string }) => p.statusGroup),
    );
    expect(groups.has('FERMO')).toBe(true);
    expect(groups.has('IN_LAVORAZIONE')).toBe(true);
    expect(groups.has('PROBLEMA')).toBe(true);
  });

  it.skipIf(!hasGit)(
    'legge e persiste lo stato Git essenziale da un repository reale',
    async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'git-essenziale', repositoryPath: repoDir, currentObjective: 'Verifica Git' },
      });
      const id = res.json().project.id as string;

      const refresh = await built.app.inject({
        method: 'POST',
        url: `/api/projects/${id}/git-status`,
      });
      expect(refresh.statusCode).toBe(200);
      const git = refresh.json().project.gitStatus as {
        branch: string | null;
        head: string | null;
        dirty: boolean;
        lastCommit: string | null;
        ahead: number | null;
        behind: number | null;
        error: string | null;
      };
      expect(git).not.toBeNull();
      expect(git.error).toBeNull();
      expect(git.branch).toBe('main');
      expect(git.head).toMatch(/^[0-9a-f]{7}$/);
      expect(git.dirty).toBe(false);
      expect(git.lastCommit).toBe('primo commit di test');
      // Nessun upstream configurato: ahead/behind restano nulli.
      expect(git.ahead).toBeNull();
      expect(git.behind).toBeNull();

      // Working tree sporco → nuovo snapshot con dirty state aggiornato.
      fs.writeFileSync(path.join(repoDir, 'non-tracciato.txt'), 'segnaposto\n', 'utf8');
      const dirtyRes = await built.app.inject({
        method: 'POST',
        url: `/api/projects/${id}/git-status`,
      });
      expect(dirtyRes.json().project.gitStatus.dirty).toBe(true);

      // Percorso non valido: lo snapshot registra l'errore, la chiamata resta 200.
      const missingRes = await built.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'git-mancante', repositoryPath: path.join(dataDir, 'non-esiste') },
      });
      const missingId = missingRes.json().project.id as string;
      const badRepo = await built.app.inject({
        method: 'POST',
        url: `/api/projects/${missingId}/git-status`,
      });
      expect(badRepo.statusCode).toBe(200);
      expect(badRepo.json().project.gitStatus.error).toBeTruthy();

      // Progetto senza repository configurato → 400 con messaggio chiaro.
      const noRepoRes = await built.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'senza-repo' },
      });
      const noRepoId = noRepoRes.json().project.id as string;
      const emptyPath = await built.app.inject({
        method: 'POST',
        url: `/api/projects/${noRepoId}/git-status`,
      });
      expect(emptyPath.statusCode).toBe(400);
      expect(emptyPath.json().message).toContain('repository');
    },
  );

  it.skipIf(!hasGit)('ricostruisce stato, obiettivo e Git dopo il riavvio', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m2-persist-'));
    const gitRepo = createGitRepo(persistDir, 'repo-persistente', 'commit che deve sopravvivere');

    const first: BuiltApp = await buildApp(
      loadConfig({ GAC_DATA_DIR: persistDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
    );

    const createdA = await first.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'persistente-a',
        repositoryPath: gitRepo,
        currentObjective: 'Obiettivo A da ricostruire',
      },
    });
    const idA = createdA.json().project.id as string;
    await first.app.inject({ method: 'POST', url: `/api/projects/${idA}/git-status` });

    const createdB = await first.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'persistente-b', currentObjective: 'Obiettivo B da ricostruire' },
    });
    const createdC = await first.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'persistente-c' },
    });
    const idB = createdB.json().project.id as string;
    const idC = createdC.json().project.id as string;

    // Riavvio completo: chiude la prima istanza e riapre sulla stessa directory.
    await first.app.close();
    first.services.db.close();

    const second: BuiltApp = await buildApp(
      loadConfig({ GAC_DATA_DIR: persistDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
    );
    try {
      const list = (await second.app.inject({ method: 'GET', url: '/api/projects' })).json()
        .projects as Array<{
        id: string;
        name: string;
        status: string;
        statusGroup: string;
        currentObjective: string | null;
        repositoryPath: string | null;
        gitStatus: { branch: string | null; lastCommit: string | null } | null;
      }>;
      expect(list).toHaveLength(3);

      const byId = Object.fromEntries(list.map((p) => [p.id, p]));
      const a = byId[idA];
      const b = byId[idB];
      const c = byId[idC];

      expect(a.status).toBe('IN_LAVORAZIONE');
      expect(a.statusGroup).toBe('IN_LAVORAZIONE');
      expect(a.currentObjective).toBe('Obiettivo A da ricostruire');
      expect(a.repositoryPath).toBe(gitRepo);
      expect(a.gitStatus?.branch).toBe('main');
      expect(a.gitStatus?.lastCommit).toBe('commit che deve sopravvivere');

      expect(b.name).toBe('persistente-b');
      expect(b.status).toBe('IN_LAVORAZIONE');
      expect(b.currentObjective).toBe('Obiettivo B da ricostruire');

      expect(c.name).toBe('persistente-c');
      expect(c.status).toBe('FERMO');
      expect(c.gitStatus).toBeNull();

      const status = (await second.app.inject({ method: 'GET', url: '/api/status' })).json();
      expect(status.projectsCount).toBe(3);
      expect(status.projectsByStatus.FERMO).toBe(1);
      expect(status.projectsByStatus.IN_LAVORAZIONE).toBe(2);
    } finally {
      await second.app.close();
      second.services.db.close();
    }
  });
});