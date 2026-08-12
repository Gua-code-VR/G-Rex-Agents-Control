import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../application/auth-service.js';

const COOKIE_NAME = 'gac_session';
const COOKIE_OPTIONS = 'Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000';

/**
 * M7 — Route di autenticazione (§8, §10).
 *
 * POST /api/auth/setup    — Imposta la password iniziale (solo se nessuna esiste)
 * POST /api/auth/login    — Login e creazione sessione
 * POST /api/auth/logout   — Logout e distruzione sessione
 * GET  /api/auth/me       — Informazioni sulla sessione corrente
 * POST /api/auth/change   — Cambio password (richiede password corrente)
 * GET  /api/auth/status   — Stato auth (se password impostata)
 */
export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  // Stato auth: il client deve sapere se serve il login.
  app.get('/api/auth/status', async () => {
    return { passwordSet: auth.isPasswordSet() };
  });

  // Setup password iniziale — solo se non ne esiste ancora una.
  app.post('/api/auth/setup', async (req, reply) => {
    if (auth.isPasswordSet()) {
      return reply.code(409).send({ message: 'Password già impostata. Usa /api/auth/change.' });
    }
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || typeof password !== 'string' || password.length < 6) {
      return reply.code(400).send({ message: 'La password deve avere almeno 6 caratteri.' });
    }
    try {
      auth.setupPassword(password);
      const { token, expiresAt } = auth.createSession();
      return reply
        .header('Set-Cookie', `${COOKIE_NAME}=${token}; ${COOKIE_OPTIONS}`)
        .send({ ok: true, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      return reply.code(409).send({ message: (err as Error).message });
    }
  });

  // Login
  app.post('/api/auth/login', async (req, reply) => {
    if (!auth.isPasswordSet()) {
      // Nessuna password: crea sessione direttamente.
      const { token, expiresAt } = auth.createSession();
      return reply
        .header('Set-Cookie', `${COOKIE_NAME}=${token}; ${COOKIE_OPTIONS}`)
        .send({ ok: true, expiresAt: expiresAt.toISOString() });
    }
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || typeof password !== 'string') {
      return reply.code(400).send({ message: 'Password richiesta.' });
    }
    try {
      const { token, expiresAt } = auth.login(password);
      return reply
        .header('Set-Cookie', `${COOKIE_NAME}=${token}; ${COOKIE_OPTIONS}`)
        .send({ ok: true, expiresAt: expiresAt.toISOString() });
    } catch {
      return reply.code(401).send({ message: 'Credenziali non valide.' });
    }
  });

  // Logout
  app.post('/api/auth/logout', async (req, reply) => {
    const token = parseCookieToken(req.headers.cookie);
    if (token) auth.destroySession(token);
    return reply
      .header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`)
      .send({ ok: true });
  });

  // Informazioni sessione corrente
  app.get('/api/auth/me', async (req, reply) => {
    const token = parseCookieToken(req.headers.cookie);
    if (!token || !auth.validateSession(token)) {
      return reply.code(401).send({ message: 'Non autenticato.' });
    }
    return { authenticated: true };
  });

  // Cambio password
  app.post('/api/auth/change', async (req, reply) => {
    if (!auth.isPasswordSet()) {
      return reply.code(400).send({ message: 'Nessuna password impostata. Usa /api/auth/setup.' });
    }
    const { currentPassword, newPassword } = (req.body ?? {}) as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword || typeof newPassword !== 'string') {
      return reply.code(400).send({ message: 'currentPassword e newPassword richiesti.' });
    }
    if (newPassword.length < 6) {
      return reply.code(400).send({ message: 'La nuova password deve avere almeno 6 caratteri.' });
    }
    try {
      auth.changePassword(currentPassword, newPassword);
      // La vecchia sessione è invalidata: creane una nuova.
      const { token, expiresAt } = auth.createSession();
      return reply
        .header('Set-Cookie', `${COOKIE_NAME}=${token}; ${COOKIE_OPTIONS}`)
        .send({ ok: true, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      return reply.code(400).send({ message: (err as Error).message });
    }
  });
}

/** Estrae il token dal header Cookie. */
export function parseCookieToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}
