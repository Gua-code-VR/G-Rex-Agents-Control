import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * M7 — Test autenticazione applicativa (§8, §10).
 *
 * Copre tutti gli endpoint auth: status, setup, login, logout, me, change.
 * Verifica anche il middleware di protezione sulle route /api/*.
 */
describe('M7 - Autenticazione applicativa', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m7-auth-'));
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp(
      loadConfig({
        GAC_DATA_DIR: dataDir,
        GAC_LOG_LEVEL: 'silent',
        GAC_AGENT_MODE: 'fake',
        GAC_SESSION_TTL_DAYS: '1',
      }),
    );
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
  });

  function extractCookieToken(headers: Record<string, string | string[]>): string | undefined {
    const setCookie = headers['set-cookie'];
    if (!setCookie) return undefined;
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = raw.match(/gac_session=([^;]+)/);
    return match?.[1];
  }

  // ── /api/auth/status ──────────────────────────────────────────────────

  describe('GET /api/auth/status', () => {
    it('indica che nessuna password è impostata all\'avvio', async () => {
      const res = await built.app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json().passwordSet).toBe(false);
    });
  });

  // ── /api/auth/setup ───────────────────────────────────────────────────

  describe('POST /api/auth/setup', () => {
    it('imposta la password iniziale e crea una sessione', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { password: 'testpass123' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.expiresAt).toBeTruthy();
      const status = await built.app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(status.json().passwordSet).toBe(true);
    });

    it('rifiuta setup se la password è già impostata (409)', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { password: 'anotherpass' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain('già impostata');
    });

    it('rifiuta una password troppo corta (400)', async () => {
      const freshDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m7-setup-'));
      const fresh = await buildApp(
        loadConfig({ GAC_DATA_DIR: freshDataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
      );
      try {
        const res = await fresh.app.inject({
          method: 'POST', url: '/api/auth/setup', payload: { password: 'short' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain('6 caratteri');
      } finally {
        await fresh.app.close();
        fresh.services.db.close();
      }
    });
  });

  // ── /api/auth/login ───────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {
    it('autentica con la password corretta', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'testpass123' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('rifiuta una password errata (401)', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrongpassword' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('non valide');
    });

    it('rifiuta login senza password (400)', async () => {
      const res = await built.app.inject({
        method: 'POST', url: '/api/auth/login', payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('login senza password impostata crea sessione direttamente', async () => {
      const freshDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-m7-login-'));
      const fresh = await buildApp(
        loadConfig({ GAC_DATA_DIR: freshDataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
      );
      try {
        const res = await fresh.app.inject({
          method: 'POST', url: '/api/auth/login', payload: { password: 'anything' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().ok).toBe(true);
      } finally {
        await fresh.app.close();
        fresh.services.db.close();
      }
    });
  });


  // ── /api/auth/me ──────────────────────────────────────────────────────

  describe('GET /api/auth/me', () => {
    it('restituisce authenticated: true con un token valido', async () => {
      const login = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'testpass123' },
      });
      const token = extractCookieToken(login.headers as Record<string, string | string[]>);
      expect(token).toBeTruthy();

      const me = await built.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `gac_session=${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().authenticated).toBe(true);
    });

    it('restituisce 401 senza token', async () => {
      const me = await built.app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(me.statusCode).toBe(401);
    });

    it('restituisce 401 con un token non valido', async () => {
      const me = await built.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: 'gac_session=invalidtoken123' },
      });
      expect(me.statusCode).toBe(401);
    });
  });

  // ── /api/auth/change ──────────────────────────────────────────────────

  describe('POST /api/auth/change', () => {
    it('cambia la password con quella corretta', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/change',
        payload: { currentPassword: 'testpass123', newPassword: 'newpass456' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      // La vecchia password non funziona più
      const oldLogin = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'testpass123' },
      });
      expect(oldLogin.statusCode).toBe(401);

      // La nuova password funziona
      const newLogin = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'newpass456' },
      });
      expect(newLogin.statusCode).toBe(200);
    });

    it('rifiuta se la password corrente è sbagliata (400)', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/change',
        payload: { currentPassword: 'wrongold', newPassword: 'newpass789' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('non valida');
    });

    it('rifiuta una nuova password troppo corta (400)', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/change',
        payload: { currentPassword: 'newpass456', newPassword: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('6 caratteri');
    });

    it('rifiuta senza campi obbligatori (400)', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/change',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });


  // ── /api/auth/logout ──────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    it('distrugge la sessione e invalida il token', async () => {
      const login = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'newpass456' },
      });
      const token = extractCookieToken(login.headers as Record<string, string | string[]>);
      expect(token).toBeTruthy();

      const logout = await built.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: `gac_session=${token}` },
      });
      expect(logout.statusCode).toBe(200);
      expect(logout.json().ok).toBe(true);

      // Dopo il logout, il token è invalidato
      const me = await built.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `gac_session=${token}` },
      });
      expect(me.statusCode).toBe(401);
    });
  });

  // ── Middleware di autenticazione ───────────────────────────────────────

  describe('Middleware di autenticazione su route protette', () => {
    it('blocca /api/projects senza sessione valida', async () => {
      const res = await built.app.inject({ method: 'GET', url: '/api/projects' });
      expect(res.statusCode).toBe(401);
    });

    it('consente l\'accesso con sessione valida', async () => {
      const login = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'newpass456' },
      });
      const token = extractCookieToken(login.headers as Record<string, string | string[]>);

      const res = await built.app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { cookie: `gac_session=${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('consente /api/health senza autenticazione', async () => {
      const res = await built.app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
    });

    it('consente /api/auth/* senza autenticazione', async () => {
      const res = await built.app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(res.statusCode).toBe(200);
    });

    it('blocca /api/status senza sessione', async () => {
      const res = await built.app.inject({ method: 'GET', url: '/api/status' });
      expect(res.statusCode).toBe(401);
    });
  });
});


