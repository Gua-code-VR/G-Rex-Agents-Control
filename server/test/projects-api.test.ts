import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M1 - API progetti', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-projects-'));
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent' }));
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
  });

  it('registra un progetto e lo rilegge correttamente', async () => {
    const create = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'demo-project', repositoryPath: 'C:\\repo\\demo' },
    });
    expect(create.statusCode).toBe(201);
    const project = create.json().project;
    expect(project.id).toBeTruthy();
    expect(project.name).toBe('demo-project');
    expect(project.repositoryPath).toBe('C:\\repo\\demo');
    expect(project.status).toBe('FERMO');
    expect(project.createdAt).toBeTruthy();
    expect(project.updatedAt).toBeTruthy();

    const list = await built.app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.statusCode).toBe(200);
    expect(list.json().projects).toHaveLength(1);
    expect(list.json().projects[0].id).toBe(project.id);

    const get = await built.app.inject({ method: 'GET', url: `/api/projects/${project.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().project.name).toBe('demo-project');
  });

  it('rifiuta una richiesta non valida (nome mancante)', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rifiuta il nome duplicato (409)', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'demo-project' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('ritorna 404 per un progetto inesistente', async () => {
    const res = await built.app.inject({
      method: 'GET',
      url: '/api/projects/nonexistent-id',
    });
    expect(res.statusCode).toBe(404);
  });
});