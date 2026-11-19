// Service worker: cache the app shell, scanner and covers so the kiosk opens offline.
const SHELL = 'shell-v2';
const COVERS = 'covers-v1';
const FILES = ['/', '/index.html', '/manifest.json', '/vendor/zxing-reader.js', '/vendor/zxing_reader.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, COVERS].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/cover/')) {
    e.respondWith(caches.open(COVERS).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r; } catch { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return; // never cache API or admin
  e.respondWith(
    fetch(e.request).then((r) => { if (r.ok) caches.open(SHELL).then((c) => c.put(e.request, r.clone())); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});
