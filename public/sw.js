/* Zitouna Garden — service worker.
 *
 * Strategy:
 *   - Navigation / HTML:       network-first, fall back to cached /offline.html
 *                              so the shell never hangs when offline.
 *   - JS / CSS / font / image: stale-while-revalidate. The cached copy
 *                              paints instantly; we refresh in the background.
 *   - Supabase API calls:      bypassed entirely. Auth/data MUST be live.
 *   - Cache versioning:        CACHE_VERSION is bumped on every deploy via
 *                              the /version.json polling loop. Old caches
 *                              are deleted in `activate`.
 */

const CACHE_VERSION = 'zitouna-v1';
const ASSET_CACHE   = `${CACHE_VERSION}-assets`;
const HTML_CACHE    = `${CACHE_VERSION}-html`;

const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(HTML_CACHE).then((c) => c.addAll(APP_SHELL.filter(Boolean))).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => !k.startsWith(CACHE_VERSION))
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

// Skip SW entirely for anything not http(s) (chrome-extension://, blob:, data:).
// Also skip cross-origin traffic we don't own — Supabase, analytics, etc.
function shouldHandle(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin !== self.location.origin) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!shouldHandle(url)) return;

  // Navigations → network-first, cache on success, offline → cached shell.
  const acceptsHTML = req.mode === 'navigate'
    || (req.headers.get('accept') || '').includes('text/html');
  if (acceptsHTML) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(HTML_CACHE);
        cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cached = await caches.match(req)
          || await caches.match('/');
        if (cached) return cached;
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Hors ligne</title>'
          + '<body style="font-family:system-ui;padding:2rem;background:#071009;color:#d7e5d8">'
          + '<h1>Vous êtes hors ligne</h1>'
          + '<p>Vérifiez votre connexion et rechargez.</p></body>',
          { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 503 },
        );
      }
    })());
    return;
  }

  // Static assets → stale-while-revalidate.
  if (/\.(?:js|mjs|css|woff2?|ttf|png|jpg|jpeg|svg|gif|webp|ico|map)$/i.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => null);
      return cached || network || new Response('', { status: 504 });
    })());
  }
});

// Let the app force-activate a new SW after /version.json detects a deploy.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
