import path from 'node:path';
import process from 'node:process';
import { EVENT_APP_STARTED, EVENT_APP_STOPPED } from './application/project-service.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, services } = await buildApp(config);

  // M7: servire la PWA built dal web/dist in produzione.
  // Il percorso è relativo alla root del workspace.
  const webDistPath = path.resolve(process.cwd(), 'web', 'dist');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: '/',
    decorateReply: false,
    wildcard: false,
  });
  // Fallback per SPA: route non-API non trovate → index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ message: 'Endpoint non trovato' });
    }
    return reply.sendFile('index.html');
  });

  // M7: bind su 0.0.0.0 se GAC_BIND_ALL=true (per Tailscale/VPN).
  const host = config.bindAll ? '0.0.0.0' : config.host;
  await app.listen({ host, port: config.port });

  services.events.log(EVENT_APP_STARTED, {
    payload: { pid: process.pid, version: '0.4.0', bindHost: host },
  });
  app.log.info(`G-Rex Agent Control avviato su http://${host}:${config.port}`);
  app.log.info(`Persistenza locale: ${config.dbPath}`);
  if (config.bindAll) {
    app.log.info('M7: bind su 0.0.0.0 — accesso remoto abilitato via VPN');
  }

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