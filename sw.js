/* Comm Guide service worker — offline launch + basemap tile cache */
const APP = 'cg-app-v22';
const TILES = 'cg-tiles-v5';
const SHELL = ['./', './index.html', './manifest.json', './dc-runtime.js',
  './leaflet.js', './comm-data.js', './font-latin.woff2', './font-latin-ext.woff2',
  './layers.png', './layers-2x.png', './marker-icon.png',
  './icon-192.png', './icon-512.png', './icon-512-maskable.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(APP).then(c =>
    // Cache each file on its own so one missing file can't block offline launch
    Promise.all(SHELL.map(u => c.add(u).catch(err => console.warn('SW precache failed:', u, err))))
  ).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== APP && k !== TILES).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isTile(u) {
  return /basemaps\.cartocdn\.com/.test(u) || /server\.arcgisonline\.com/.test(u);
}
function tileKey(u) {
  return u.replace(/\/\/[a-d]\.basemaps\.cartocdn\.com/, '//s.basemaps.cartocdn.com');
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // Map tiles: cache-first, subdomain-normalized key, opaque responses OK
  if (isTile(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const key = new Request(tileKey(url), { mode: 'no-cors' });
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
        return res;
      } catch (err) {
        return hit || new Response('', { status: 504 });
      }
    })());
    return;
  }

  let sameOrigin = false;
  try { sameOrigin = new URL(url).origin === self.location.origin; } catch (e2) {}

  // App shell / same-origin: network-first (fresh when online), cache fallback (offline)
  if (req.mode === 'navigate' || sameOrigin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok && sameOrigin) (await caches.open(APP)).put(req, res.clone());
        return res;
      } catch (err) {
        const c = await caches.match(req);
        return c || (await caches.match('./index.html')) || new Response('offline', { status: 503 });
      }
    })());
    return;
  }

  // Other cross-origin (fonts, boundary GeoJSON): cache-first, then network
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) (await caches.open(APP)).put(req, res.clone());
      return res;
    } catch (err) {
      return hit || new Response('', { status: 504 });
    }
  })());
});

// Page messages: clear or count cached tiles; force activation on update
self.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'skipWaiting') { self.skipWaiting(); return; }
  if (msg.type === 'clearTiles') {
    e.waitUntil(caches.delete(TILES).then(() => e.source && e.source.postMessage({ type: 'tilesCleared' })));
  }
  if (msg.type === 'tileCount') {
    e.waitUntil(caches.open(TILES).then(c => c.keys()).then(k => e.source && e.source.postMessage({ type: 'tileCount', count: k.length })));
  }
});
