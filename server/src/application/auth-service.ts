import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AuthRepository } from '../infrastructure/db/auth-repo.js';

/**
 * M7 — Autenticazione applicativa (§8, §10).
 *
 * Utente amministratore singolo. Password con hash forte (scrypt).
 * Sessione con cookie HttpOnly e scadenza configurabile.
 *
 * Se nessuna password è impostata, l'autenticazione è disabilitata
 * (compatibilità con installazioni locali pre-M7).
 */

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export interface SessionData {
  token: string;
  createdAt: Date;
  expiresAt: Date;
}

export class AuthService {
  private readonly authRepo: AuthRepository;
  private readonly sessions = new Map<string, SessionData>();
  private readonly sessionTtlMs: number;

  constructor(authRepo: AuthRepository, sessionTtlDays = 30) {
    this.authRepo = authRepo;
    this.sessionTtlMs = sessionTtlDays * 24 * 60 * 60 * 1000;
  }

  /** Verifica se è stata impostata una password. */
  isPasswordSet(): boolean {
    return this.authRepo.hasPassword();
  }

  /**
   * Imposta la password iniziale. Può essere chiamata solo
   * se non è ancora impostata nessuna password.
   */
  setupPassword(password: string): void {
    if (this.authRepo.hasPassword()) {
      throw new Error('Password già impostata. Usa changePassword per modificarla.');
    }
    const { hash, salt } = hashPassword(password);
    this.authRepo.setPassword(hash, salt);
  }

  /**
   * Cambia la password. Richiede la password corrente.
   */
  changePassword(currentPassword: string, newPassword: string): void {
    const stored = this.authRepo.getPassword();
    if (!stored) {
      throw new Error('Nessuna password impostata. Usa setupPassword.');
    }
    if (!verifyPassword(currentPassword, stored.hash, stored.salt)) {
      throw new Error('Password corrente non valida.');
    }
    const { hash, salt } = hashPassword(newPassword);
    this.authRepo.setPassword(hash, salt);
    // Invalida tutte le sessioni esistenti dopo cambio password.
    this.sessions.clear();
  }

  /**
   * Verifica le credenziali e crea una sessione.
   * Se non è impostata nessuna password, crea comunque una sessione
   * (auth disabilitata).
   */
  login(password: string): { token: string; expiresAt: Date } {
    const stored = this.authRepo.getPassword();
    if (stored) {
      if (!verifyPassword(password, stored.hash, stored.salt)) {
        throw new Error('Password non valida.');
      }
    }
    return this.createSession();
  }

  /**
   * Crea una sessione senza verifica password.
   * Usata quando l'auth è disabilitata (nessuna password impostata).
   */
  createSession(): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    this.sessions.set(token, { token, createdAt: now, expiresAt });
    return { token, expiresAt };
  }

  /** Valida un token di sessione. */
  validateSession(token: string): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt.getTime() < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** Distrugge una sessione (logout). */
  destroySession(token: string): void {
    this.sessions.delete(token);
  }

  /**
   * Verifica se l'accesso è consentito.
   * Se non è impostata nessuna password, è sempre consentito.
   * Altrimenti verifica il token di sessione.
   */
  isAccessAllowed(sessionToken: string | undefined): boolean {
    if (!this.isPasswordSet()) return true;
    if (!sessionToken) return false;
    return this.validateSession(sessionToken);
  }
}

// ── Password hashing con scrypt (node:crypto) ────────────────────────

function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, salt, SCRYPT_KEYLEN, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  });
  return { hash: derivedKey.toString('hex'), salt };
}

function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  const derivedKey = scryptSync(password, salt, SCRYPT_KEYLEN, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  });
  const hashBuffer = derivedKey;
  const storedBuffer = Buffer.from(storedHash, 'hex');
  if (hashBuffer.length !== storedBuffer.length) return false;
  return timingSafeEqual(hashBuffer, storedBuffer);
}
