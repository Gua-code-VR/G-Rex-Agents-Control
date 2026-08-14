import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { getWebDistPath, registerStaticSpa, webDistPath } from '../src/infrastructure/web-static.js';

describe('static web application', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-static-web-'));
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent' }));
    await registerStaticSpa(built.app);
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('uses web/dist at repository root when started from the server workspace', () => {
    expect(webDistPath).toBe(path.join(repositoryRoot, 'web', 'dist'));
    expect(webDistPath).not.toBe(path.join(repositoryRoot, 'server', 'web', 'dist'));
    expect(getWebDistPath(pathToFileURL(path.join(repositoryRoot, 'server', 'dist', 'src', 'infrastructure', 'web-static.js')).href))
      .toBe(path.join(repositoryRoot, 'web', 'dist'));
  });

  it('serves the SPA entry point for a non-API route', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/projects/example' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toBe(fs.readFileSync(path.join(webDistPath, 'index.html'), 'utf8'));
  });
});
