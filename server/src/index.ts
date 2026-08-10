import process from 'node:process';
import { EVENT_APP_STARTED, EVENT_APP_STOPPED } from './application/project-service.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, services } = await buildApp(config);

  await app.listen({ host: config.host, port: config.port });

  services.events.log(EVENT_APP_STARTED, {
    payload: { pid: process.pid, version: '0.3.0' },
  });
  app.log.info(`G-Rex Agent Control avviato su http://${config.host}:${config.port}`);
  app.log.info(`Persistenza locale: ${config.dbPath}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Segnale ${signal} ricevuto: arresto in corso`);
    services.events.log(EVENT_APP_STOPPED, { payload: { pid: process.pid } });
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