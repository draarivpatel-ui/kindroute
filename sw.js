/**
 * KindRoute offline service worker.
 * Caches only relative assets under the app's own /kindroute/ subpath.
 * No external origins, no runtime network fallbacks, no tracking.
 */
const CACHE = 'kindroute-v5';
const SCOPE = new URL('./', self.registration.scope).pathname;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './src/app.js',
  './src/index.js',
  './src/map-viz.js',
  './src/hungarian.js',
  './src/routing.js',
  './src/dispatch.js',
  './src/scenarios.js',
  './src/crypto-card.js',
  './src/qr-svg.js',
  './src/accessible-routing.js',
  './src/route-proof.js',
  './sw.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // CacheStorage is shared by the whole origin, so an upgrade may only evict
  // keys inside this app's own kindroute- namespace; other same-origin apps'
  // caches must survive.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('kindroute-') && key !== CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE)) return;
  // Fragment-only card views are the same document; cache-first keeps them local.
  // Network first with an offline cache fallback: fresh assets win when
  // online, and every cached asset still works with the network disconnected.
  event.respondWith(
    fetch(request).then((response) => {
      if (response && response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request).then((cached) => {
      if (cached) return cached;
      if (request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    })),
  );
});
