import { createRequire } from 'node:module';

// Vitest/vite-node non riesce a risolvere l'import statico di 'node:sqlite'
// (lo carica come URL e fallisce). Carichiamo il modulo nativo via
// createRequire: Node lo risolve come builtin senza passare per Vite.
// I tipi restano quelli ufficiali di node:sqlite (@types/node).

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as typeof import('node:sqlite');

export const { DatabaseSync } = sqlite;