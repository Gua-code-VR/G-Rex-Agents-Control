// Service worker M7: app shell e asset con hash di contenuto.
// - Navigazioni (index.html): network-first con fallback offline. Un nuovo
//   deploy raggiunge subito il client senza hard refresh.
// - Asset hashati (/assets/*): cache-first: il nome file contiene l'hash del
//   contenuto, quindi la cache non può servire versioni stantie.
// - API (/api/*): mai intercettate, sempre dal vivo (§14).
const CACHE_NAME = 'gac-shell-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Asset hashati da Vite: il nome file cambia con il contenuto, quindi è
  // sicuro servirli dalla cache senza ri-validazione.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // App shell: versione fresca dal server quando online, cache come fallback
  // offline per mantenere la PWA utilizzabile senza rete.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request, url));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirstShell(request, url) {
  const cache = await caches.open(CACHE_NAME);
  // L'app shell viene sempre archiviata sotto la root dell'applicazione:
  // ogni navigazione riusa la stessa copia anche offline.
  const shellKey = url.origin + '/';
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(shellKey, response.clone());
    return response;
  } catch {
    const cached = await cache.match(shellKey);
    return cached ?? Response.error();
  }
}