/* Network-first service worker (offline fallback). */
// Bump CACHE_NAME on every deploy so returning clients revalidate and pick up
// newly versioned assets (index.html currently loads app.js?v=12 / style.css?v=8).
const CACHE_NAME = 'ai-agent-v4';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Never intercept API calls — they must always reach the backend.
  if (request.method !== 'GET' || request.url.includes('/api/')) return;

  // Cache key that ignores the cache-busting `?v=` query, so a versioned
  // request (e.g. app.js?v=12) resolves to the cached unversioned asset.
  const key = new URL(request.url);
  key.search = '';

  // Network-first: always try the network so updates propagate, fall back to
  // cache only when offline. The stripped `key` keeps the versioned request
  // and the precached unversioned asset unified under a single entry.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      fetch(request)
        .then((response) => {
          if (response.ok && request.url.startsWith(self.location.origin)) {
            const copy = response.clone();
            cache.put(key, copy);
          }
          return response;
        })
        .catch(() => cache.match(key).then((cached) => cached || Response.error()))
    )
  );
});