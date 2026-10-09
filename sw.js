/* Comm Guide service worker — offline launch + basemap tile cache */
const APP = 'cg-app-v26';
const OCR = 'cg-ocr-v1'; // incident photo reader (large, immutable) — survives app updates
const TILES = 'cg-tiles-v5';
const NET_TIMEOUT_MS = 3000;
const SHELL = ['./', './index.html', './manifest.json', './dc-runtime.js',
  './leaflet.js', './comm-data.js', './comm-geo.js', './incident-core.js', './incident.js',
  './vendor/react.production.min.js', './vendor/react-dom.production.min.js',
  './font-latin.woff2', './font-latin-ext.woff2',
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
    await Promise.all(keys.filter(k => k !== APP && k !== TILES && k !== OCR).map(k => caches.delete(k)));
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

  // Incident photo reader files: cache-first (they never change for a given version)
  if (sameOrigin && url.indexOf('/vendor/ocr/') >= 0) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(OCR)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // App shell / same-origin: network-first when the signal is good, but never wait
  // long on a weak connection — after NET_TIMEOUT_MS fall back to the cached copy
  // (the network request keeps going and refreshes the cache for next launch).
  if (req.mode === 'navigate' || sameOrigin) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const net = fetch(req).then(async res => {
        if (res && res.ok && sameOrigin) (await caches.open(APP)).put(req, res.clone());
        return res;
      });
      if (!cached) {
        try { return await net; }
        catch (err) { return (await caches.match('./index.html')) || new Response('offline', { status: 503 }); }
      }
      net.catch(() => {});
      return Promise.race([
        net.catch(() => cached),
        new Promise(resolve => setTimeout(() => resolve(cached), NET_TIMEOUT_MS))
      ]);
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
