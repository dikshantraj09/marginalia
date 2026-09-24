// App-shell cache for offline / installed-PWA use. Marginalia never talks
// to a server for its own data — every PDF and note lives in IndexedDB
// (see db.js) — so the only thing worth caching here is the shell itself:
// the HTML/CSS/JS and the pdf.js vendor files needed to boot the app with
// no network at all. Bump CACHE_NAME on any shell change (a new file, or a
// change to one already listed) so the activate step evicts the old cache
// instead of an installed app being stuck on stale JS.
const CACHE_NAME = 'marginalia-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/canvas.js',
  './js/db.js',
  './js/modal.js',
  './js/pdfview.js',
  './js/rail.js',
  './js/tour.js',
  './js/vault.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache-first for the app shell, with a network fallback that also updates
// the cache when it succeeds — so a person online always eventually gets a
// fresh copy, and a person offline still gets whatever was last cached.
// Anything not in the shell (there isn't much — this app has no backend)
// just falls through to a plain network fetch.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline — fall back to whatever's cached, if anything
      return cached || network;
    })
  );
});
