// Zylove service worker: offline support for the app shell.
//
// Pages are network-first so a new deploy is picked up immediately; the cached
// shell (then offline.html) is only a fallback. Built assets under /assets/
// have content-hashed names, so they're safe to serve cache-first. Cross-origin
// requests (Firebase, Google APIs, fonts) are never touched.

const CACHE = 'zylove-shell-v1'
const SHELL = ['/', '/offline.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png']

// Pre-caches the shell plus the JS/CSS bundles the current index.html loads.
async function precache() {
  const cache = await caches.open(CACHE)
  await cache.addAll(SHELL)
  const html = await (await cache.match('/')).text()
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
  await Promise.all(assets.map((url) => cache.add(url).catch(() => {})))
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

async function networkFirstPage(request) {
  try {
    const response = await fetch(request)
    // The SPA serves index.html for every route; keep the latest copy as '/'.
    if (response.ok) {
      const copy = response.clone()
      caches.open(CACHE).then((cache) => cache.put('/', copy))
    }
    return response
  } catch {
    return (await caches.match('/')) || (await caches.match('/offline.html')) || Response.error()
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(request, copy))
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request))
  } else if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(request))
  }
})
