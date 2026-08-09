import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { DatabaseSync } from './node-sqlite.js';
import { applySchema } from './schema.js';

/**
 * Apre (o crea) il database SQLite locale e garantisce lo schema.
 * Usa il modulo nativo node:sqlite di Node.js: nessuna dipendenza
 * nativa da compilare, nessun servizio esterno.
 */
export function openDatabase(dbPath: string): DatabaseSyncType {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  applySchema(db);
  return db;
}