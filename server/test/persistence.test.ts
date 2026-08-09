import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * Evidenza chiave di M1: lo stato persistito sopravvive al riavvio.
 * Simula un riavvio completo chiudendo la prima istanza e riaprendo
 * una nuova istanza sulla stessa directory dati.
 */
describe('M1 - persistenza attraverso il riavvio', () => {
  it('il progetto registrato sopravvive alla chiusura e riapertura', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-persist-'));

    // Prima esecuzione: registra un progetto e un evento
    const first: BuiltApp = await buildApp(
      loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent' }),
    );
    const create = await first.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'sopravvissuto', repositoryPath: 'C:\\repo\\persistente' },
    });
    expect(create.statusCode).toBe(201);
    const projectId = create.json().project.id as string;
    first.services.events.log('test.event', {
      projectId,
      payload: { fonte: 'persistence.test' },
    });
    await first.app.close();
    first.services.db.close();

    // Riavvio: nuova istanza sulla stessa directory dati
    const second: BuiltApp = await buildApp(
      loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent' }),
    );
    try {
      const list = await second.app.inject({ method: 'GET', url: '/api/projects' });
      expect(list.statusCode).toBe(200);
      const projects = list.json().projects as Array<{
        id: string;
        name: string;
        repositoryPath: string | null;
        status: string;
      }>;
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(projectId);
      expect(projects[0].name).toBe('sopravvissuto');
      expect(projects[0].repositoryPath).toBe('C:\\repo\\persistente');
      expect(projects[0].status).toBe('FERMO');

      // Anche gli eventi sopravvivono (State & Event Store)
      const events = (await second.app.inject({ method: 'GET', url: '/api/events' })).json()
        .events as Array<{ type: string }>;
      expect(events.some((e) => e.type === 'project.created')).toBe(true);
      expect(events.some((e) => e.type === 'test.event')).toBe(true);
    } finally {
      await second.app.close();
      second.services.db.close();
    }
  });
});