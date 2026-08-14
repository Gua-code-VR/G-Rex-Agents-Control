import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function getWebDistPath(moduleUrl = import.meta.url): string {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  while (path.dirname(directory) !== directory) {
    if (fs.existsSync(path.join(directory, 'server', 'package.json')) && fs.existsSync(path.join(directory, 'web'))) {
      return path.join(directory, 'web', 'dist');
    }
    directory = path.dirname(directory);
  }
  throw new Error('Impossibile individuare la root del repository per la PWA.');
}

export const webDistPath = getWebDistPath();

/** Serve la PWA compilata dalla root del repository, indipendentemente dal cwd. */
export async function registerStaticSpa(app: FastifyInstance): Promise<void> {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: '/',
    wildcard: false,
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ message: 'Endpoint non trovato' });
    }
    return reply.sendFile('index.html');
  });
}
