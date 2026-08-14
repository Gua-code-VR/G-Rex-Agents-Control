import process from 'node:process';
import { EVENT_APP_STARTED, EVENT_APP_STOPPED } from './application/project-service.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { registerStaticSpa } from './infrastructure/web-static.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, services } = await buildApp(config);
  const recovered = services.startupRecovery.recover();
  services.staleDetector.start();
  services.retryWorker.start();

  await registerStaticSpa(app);

  // M7: bind su 0.0.0.0 se GAC_BIND_ALL=true (per Tailscale/VPN).
  const host = config.bindAll ? '0.0.0.0' : config.host;
  await app.listen({ host, port: config.port });

  services.events.log(EVENT_APP_STARTED, {
    payload: { pid: process.pid, version: '0.4.0', bindHost: host, recovered },
  });
  app.log.info(`G-Rex Agent Control avviato su http://${host}:${config.port}`);
  app.log.info(`Persistenza locale: ${config.dbPath}`);
  if (config.bindAll) {
    app.log.info('M7: bind su 0.0.0.0 — accesso remoto abilitato via VPN');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Segnale ${signal} ricevuto: arresto in corso`);
    services.events.log(EVENT_APP_STOPPED, { payload: { pid: process.pid } });
    services.staleDetector.stop();
    services.retryWorker.stop();
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
