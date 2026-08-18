import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Durata massima (secondi) per gli asset con hash di contenuto: il nome file
 *  cambia a ogni build, quindi la cache può conservarli senza ri-validazioni. */
const IMMUTABLE_MAX_AGE_SECONDS = 31536000;

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

/** Gli asset Vite (dist/assets/*) hanno l'hash del contenuto nel nome file:
 *  sono immutabili e possono essere cachati a lungo. Tutto il resto (index.html,
 *  sw.js, manifest, icone) deve essere ri-validato a ogni richiesta. */
function isImmutableAsset(filePath: string): boolean {
  const relative = path.relative(webDistPath, filePath);
  const [firstSegment] = relative.split(path.sep);
  return firstSegment === 'assets';
}

/** Cache policy della PWA (§14): il client deve sempre ottenere l'app shell
 *  fresca (no-cache + ri-validazione ETag) e può conservare a lungo solo gli
 *  asset hashati, il cui nome cambia a ogni build. */
function setStaticCacheHeaders(reply: FastifyReply, filePath: string): void {
  reply.header(
    'Cache-Control',
    isImmutableAsset(filePath)
      ? `public, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`
      : 'no-cache',
  );
}

/** Serve la PWA compilata dalla root del repository, indipendentemente dal cwd. */
export async function registerStaticSpa(app: FastifyInstance): Promise<void> {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: '/',
    wildcard: false,
    // La cache HTTP è interamente sotto il controllo di setStaticCacheHeaders.
    cacheControl: false,
    setHeaders: setStaticCacheHeaders,
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ message: 'Endpoint non trovato' });
    }
    return reply.sendFile('index.html');
  });
}
