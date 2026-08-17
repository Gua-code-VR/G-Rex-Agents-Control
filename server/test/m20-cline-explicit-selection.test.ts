import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M20 - selezione esplicita Cline nel catalogo', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m20-'));
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent' })); });
  afterAll(async () => { await built.app.close(); built.services.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('espone Cline nel catalogo anche senza GAC_CLINE_MODEL (coerenza con /api/execution-providers)', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/provider-catalog' });
    const catalog = res.json().catalog as Array<{ runtime: { id: string }; provider: { id: string } }>;
    const cline = catalog.find((entry) => entry.runtime.id === 'cline');
    expect(cline).toBeDefined();
    expect(cline?.provider.id).toBe('cline');
  });

  it('riconosce il runtime cline nel resolve (non più «Runtime non supportato»)', () => {
    // Con la CLI non installata nel test l'esito è «non disponibile»;
    // il bug era «non supportato» (runtime assente dal catalogo).
    expect(() => built.services.catalog.resolve({ runtimeId: 'cline' })).not.toThrow(/non supportato/);
  });
});
