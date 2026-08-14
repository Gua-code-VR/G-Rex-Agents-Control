import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DatabaseSync } from '../src/infrastructure/db/node-sqlite.js';

describe('schema migrations', () => {
  const directories: string[] = [];

  afterEach(() => {
    directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  });

  it('migrates a legacy events table without category while preserving its rows', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-legacy-schema-'));
    directories.push(dataDir);
    const dbPath = path.join(dataDir, 'gac.sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT,
        objective_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload TEXT
      );
      INSERT INTO events (project_id, type, timestamp, payload)
      VALUES ('legacy-project', 'legacy.event', '2026-01-01T00:00:00.000Z', '{"source":"legacy"}');
    `);
    legacy.close();

    const built = await buildApp(loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent' }));
    try {
      const columns = built.services.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('category');
      expect(built.services.db.prepare('SELECT category FROM events WHERE type = ?').get('legacy.event')).toEqual({ category: 'TECHNICAL' });
      expect(built.services.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_category'").get()).toEqual({ name: 'idx_events_category' });
    } finally {
      await built.app.close();
      built.services.db.close();
    }
  });
});
