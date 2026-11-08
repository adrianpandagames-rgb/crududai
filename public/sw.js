// Service worker for the installed app. Served at /sw.js (app.js) so it covers the whole site.
// The app handles sensitive case data, so pages and API answers are never stored on the device: they always come
// from the network, and with no connection a page shows the offline notice instead. Only the files in /public
// (styles, scripts, images) are kept, always fetched fresh first and used from the cache only when offline.
const VERSION = 'v1';
const CACHE = `udai-estaticos-${VERSION}`;
const OFFLINE = '/public/offline.html';
const PRECACHE = [OFFLINE, '/public/imgs/logo.png', '/public/imgs/pwa/icon-192.png', '/public/css/bootstrap.min.css'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('udai-') && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Pages: straight from the network; the offline notice when there is none. Nothing is stored.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
    return;
  }

  // Static files: network first, so a deploy shows at once; the stored copy only without a connection.
  if (url.pathname.startsWith('/public/') && !url.pathname.endsWith('.pdf')) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request).then((cached) => cached || Response.error())));
  }
  // Everything else (data, live updates, downloads) goes to the network untouched.
});
