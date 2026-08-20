import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/application/auth-service.js';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuthRepository } from '../src/infrastructure/db/auth-repo.js';
import { openDatabase } from '../src/infrastructure/db/connection.js';

/**
 * M7 — Prevedibilità dell'autenticazione al riavvio del Control Plane (§8, §10).
 *
 * La password (hash + salt) è persistita nella tabella `auth` del DB SQLite
 * locale (`<dataDir>/gac.sqlite`), quindi deve restare valida dopo un riavvio
 * senza alcun reset manuale del database. Le sessioni, invece, vivono in
 * memoria e vengono scartate al riavvio: il login deve restare coerente
 * (re-login necessario, stessa password ancora valida).
 *
 * Simula un riavvio completo del Control Plane chiudendo la prima istanza e
 * riaprendo una nuova istanza sulla stessa directory dati (stesso pattern di
 * `persistence.test.ts`).
 *
 * Vincolo: nessuna di queste verifiche indebolisce la sicurezza — i parametri
 * scrypt, il minimo TTL e la verifica della password restano invariati.
 */
describe('M7 - Autenticazione: prevedibilità al riavvio del Control Plane', () => {
  function makeApp(dataDir: string): Promise<BuiltApp> {
    return buildApp(
      loadConfig({
        GAC_DATA_DIR: dataDir,
        GAC_LOG_LEVEL: 'silent',
        GAC_AGENT_MODE: 'fake',
      }),
    );
  }

  function extractCookieToken(headers: Record<string, string | string[]>): string | undefined {
    const setCookie = headers['set-cookie'];
    if (!setCookie) return undefined;
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = raw.match(/gac_session=([^;]+)/);
    return match?.[1];
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('la password impostata resta valida dopo un riavvio del Control Plane', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-auth-restart-'));

    // Prima istanza: imposta la password.
    const first = await makeApp(dataDir);
    try {
      const setup = await first.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { password: 'originalpass123' },
      });
      expect(setup.statusCode).toBe(200);
      const status = await first.app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(status.json().passwordSet).toBe(true);
    } finally {
      await first.app.close();
      first.services.db.close();
    }

    // Riavvio: nuova istanza sulla stessa directory dati.
    const second = await makeApp(dataDir);
    try {
      // Nessun reset manuale: la password è ancora presente e attiva.
      const status = await second.app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(status.json().passwordSet).toBe(true);

      // La stessa password continua a essere valida.
      const ok = await second.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'originalpass123' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ok).toBe(true);

      // Una password errata è ancora rifiutata.
      const bad = await second.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrongpassword' },
      });
      expect(bad.statusCode).toBe(401);
    } finally {
      await second.app.close();
      second.services.db.close();
    }
  });

  it('un riavvio non richiede un nuovo setup (la password non viene resettata)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-auth-restart-'));

    const first = await makeApp(dataDir);
    try {
      await first.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { password: 'persistentpass1' },
      });
    } finally {
      await first.app.close();
      first.services.db.close();
    }

    const second = await makeApp(dataDir);
    try {
      // Il sistema non deve chiedere di reimpostare la password: il setup
      // iniziale risulta già completato, come ci si aspetta dopo un riavvio.
      const setup = await second.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { password: 'brandnewpass1' },
      });
      expect(setup.statusCode).toBe(409);
      expect(setup.json().message).toContain('già impostata');

      // E la password originariamente impostata resta quella valida.
      const login = await second.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'persistentpass1' },
      });
      expect(login.statusCode).toBe(200);
    } finally {
      await second.app.close();
      second.services.db.close();
    }
  });

  it('il cambio password persiste dopo un riavvio', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-auth-restart-'));

    const first = await makeApp(dataDir);
    try {
      await first.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { password: 'oldpass123' },
      });
      const change = await first.app.inject({
        method: 'POST',
        url: '/api/auth/change',
        payload: { currentPassword: 'oldpass123', newPassword: 'newpass456' },
      });
      expect(change.statusCode).toBe(200);
    } finally {
      await first.app.close();
      first.services.db.close();
    }

    // Riavvio: il nuovo hash deve essere persistito.
    const second = await makeApp(dataDir);
    try {
      const oldLogin = await second.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'oldpass123' },
      });
      expect(oldLogin.statusCode).toBe(401);

      const newLogin = await second.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'newpass456' },
      });
      expect(newLogin.statusCode).toBe(200);
    } finally {
      await second.app.close();
      second.services.db.close();
    }
  });


  it('le sessioni in-memory sono scartate al riavvio: re-login necessario ma prevedibile', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-auth-restart-'));

    const first = await makeApp(dataDir);
    let preRestartToken: string | undefined;
    try {
      await first.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { password: 'sessionpass1' },
      });
      const login = await first.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'sessionpass1' },
      });
      preRestartToken = extractCookieToken(login.headers as Record<string, string | string[]>);
      expect(preRestartToken).toBeTruthy();

      const me = await first.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `gac_session=${preRestartToken}` },
      });
      expect(me.statusCode).toBe(200);
    } finally {
      await first.app.close();
      first.services.db.close();
    }

    // Riavvio: il token pre-riavvio non è più valido (sessione in-memory persa).
    const second = await makeApp(dataDir);
    try {
      const stale = await second.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `gac_session=${preRestartToken}` },
      });
      expect(stale.statusCode).toBe(401);

      // Un nuovo login produce una nuova sessione valida.
      const relogin = await second.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'sessionpass1' },
      });
      const newToken = extractCookieToken(relogin.headers as Record<string, string | string[]>);
      expect(newToken).toBeTruthy();
      expect(newToken).not.toBe(preRestartToken);
      const me = await second.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `gac_session=${newToken}` },
      });
      expect(me.statusCode).toBe(200);
    } finally {
      await second.app.close();
      second.services.db.close();
    }
  });

  it('il logout resta efficace: la sessione distrutta non è più utilizzabile', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-auth-restart-'));

    const first = await makeApp(dataDir);
    try {
      await first.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { password: 'logoutpass1' },
      });
      const login = await first.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'logoutpass1' },
      });
      const token = extractCookieToken(login.headers as Record<string, string | string[]>);
      expect(token).toBeTruthy();

      const logout = await first.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: `gac_session=${token}` },
      });
      expect(logout.statusCode).toBe(200);

      const me = await first.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `gac_session=${token}` },
      });
      expect(me.statusCode).toBe(401);
    } finally {
      await first.app.close();
      first.services.db.close();
    }
  });

  it('scadenza sessione: un token scaduto viene rifiutato', () => {
    // Test a livello di servizio: evita di far scorrere il tempo reale e non
    // tocca i parametri di sicurezza (verifica password e TTL restano intatti).
    const db = openDatabase(':memory:');
    try {
      const service = new AuthService(new AuthRepository(db), 30); // TTL 30 giorni

      vi.useFakeTimers({ toFake: ['Date'] });
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(t0);

      const { token } = service.login('anypassword');
      // Dentro la validità la sessione è accettata.
      expect(service.validateSession(token)).toBe(true);

      // Oltre il TTL (30 giorni) la sessione è scaduta e viene rifiutata.
      vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'));
      expect(service.validateSession(token)).toBe(false);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });
});

