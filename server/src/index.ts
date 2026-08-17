import process from 'node:process';
import { EVENT_APP_STARTED, EVENT_APP_STOPPED } from './application/project-service.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { registerStaticSpa } from './infrastructure/web-static.js';

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, services } = await buildApp(config);
  const recovered = await services.startupRecovery.recover();
  // §19.5: prima di avviare nuovo lavoro concorrente, lo stato persistito
  // delle workspace viene riconciliato con i worktree/branch reali.
  const workspaces = await services.workspaces.reconcile().catch(() => ({ checked: 0, stale: 0, recovered: 0 }));
  services.staleDetector.start();
  services.retryWorker.start();
  services.queueWorker.start();

  await registerStaticSpa(app);

  // Bind address esplicito: loopback di default, 0.0.0.0 per Tailscale/VPN.
  const host = config.bindAddress;
  await app.listen({ host, port: config.port });

  services.events.log(EVENT_APP_STARTED, {
    payload: { pid: process.pid, version: '0.4.0', bindHost: host, recovered, workspacesReconciled: workspaces },
  });
  app.log.info(`G-Rex Agent Control avviato su http://${host}:${config.port}`);
  app.log.info(`Persistenza locale: ${config.dbPath}`);
  if (!isLoopback(host)) {
    if (services.auth.isPasswordSet()) {
      app.log.info('Accesso remoto abilitato (bind non loopback): le API sono protette da autenticazione.');
    } else {
      app.log.warn('Accesso remoto abilitato (bind non loopback) ma nessuna password amministratore impostata: imposta la password per proteggere le API.');
    }
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Segnale ${signal} ricevuto: arresto in corso`);
    services.events.log(EVENT_APP_STOPPED, { payload: { pid: process.pid } });
    services.staleDetector.stop();
    services.retryWorker.stop();
    services.queueWorker.stop();
    await app.close();
    services.db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err) => {
  console.error('Avvio di G-Rex Agent Control non riuscito:', err);
  process.exit(1);
});
