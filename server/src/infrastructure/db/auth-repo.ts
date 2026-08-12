import type { DatabaseSync } from 'node:sqlite';

/**
 * Repository per la tabella auth (M7: autenticazione applicativa §8).
 * La tabella auth è un key-value store usato per memorizzare
 * password_hash e password_salt dell'amministratore singolo.
 */
export class AuthRepository {
  private readonly getStmt;
  private readonly setStmt;

  constructor(db: DatabaseSync) {
    this.getStmt = db.prepare('SELECT value FROM auth WHERE key = ?');
    this.setStmt = db.prepare(
      `INSERT INTO auth (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  }

  get(key: string): string | null {
    const row = this.getStmt.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.setStmt.run(key, value);
  }

  /** Verifica se è stata impostata una password. */
  hasPassword(): boolean {
    return this.get('password_hash') !== null;
  }

  /** Salva hash e salt della password. */
  setPassword(hash: string, salt: string): void {
    this.set('password_hash', hash);
    this.set('password_salt', salt);
  }

  /** Restituisce hash e salt, oppure null se non impostati. */
  getPassword(): { hash: string; salt: string } | null {
    const hash = this.get('password_hash');
    const salt = this.get('password_salt');
    if (!hash || !salt) return null;
    return { hash, salt };
  }
}
