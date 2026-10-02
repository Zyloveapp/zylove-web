// Zylove service worker: an offline fallback page, nothing more.
//
// The app itself (index.html, JS, CSS) always comes from the network and is
// never cached here: serving a stale or redirected shell is what left the
// home-screen app on a black screen. Only offline.html and the icons are
// cached. __BUILD_ID__ is replaced at build time (see vite.config.ts), so each
// deploy gets a fresh cache and old ones are deleted on activate.

const BUILD_ID = '__BUILD_ID__'
const CACHE_NAME = 'zylove-v' + BUILD_ID
const OFFLINE_URL = '/offline.html'
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Pages: network only; the offline page only when the network fails.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())))
    return
  }

  // Icons: from the cache when there, else the network.
  if (url.pathname.startsWith('/icons/')) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)))
  }
  // Everything else (including /assets/ bundles) goes straight to the network.
})
