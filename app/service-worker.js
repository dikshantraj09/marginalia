// App-shell cache for offline / installed-PWA use. Marginalia never talks
// to a server for its own data — every PDF and note lives in IndexedDB
// (see db.js) — so the only thing worth caching here is the shell itself:
// the HTML/CSS/JS and the pdf.js vendor files needed to boot the app with
// no network at all. Bump CACHE_NAME on any shell change (a new file, or a
// change to one already listed) so the activate step evicts the old cache
// instead of an installed app being stuck on stale JS.
const CACHE_NAME = 'marginalia-shell-v2';
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
//
// IMPORTANT: respondWith()'s promise must always resolve to a real
// Response. `cached` is `undefined` on a cache miss, and if the network
// fetch also fails (offline, or — very commonly on Android — the PWA
// launching a split second before the connection is actually up),
// `cached || network` previously resolved to plain `undefined`. Chrome
// treats that as a fatal, uncatchable navigation failure — the literal
// "This site can't be reached / ERR_FAILED" a person sees when they tap
// the installed app's icon. Every branch below now ends in an actual
// Response: the cached shell page for a failed navigation, or a
// constructed error Response as the last resort for anything else.
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
        .catch(() => null); // offline / request outright failed

      if (cached) return cached;

      return network.then((response) => {
        if (response) return response;
        // Neither cached nor reachable. For a page navigation, the app
        // shell itself is the best fallback we have — it's precached on
        // install, so this only comes up if that install never completed.
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html').then((shell) => shell || offlineResponse());
        }
        return offlineResponse();
      });
    })
  );
});

function offlineResponse() {
  return new Response('Offline and nothing cached for this yet.', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain' },
  });
}
