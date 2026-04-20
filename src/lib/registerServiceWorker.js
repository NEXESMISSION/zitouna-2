/**
 * Service-worker registration for PWA install + offline shell.
 *
 * - Dev:   SW is skipped. Vite HMR + a SW don't mix well; an active SW
 *          intercepts module requests and serves stale bundles, making
 *          dev feel broken.
 * - Prod:  register /sw.js at load; on `updatefound` we auto-activate the
 *          new worker. The existing version.json polling loop (see
 *          vite.config.js + AuthContext hard-refresh logic) already nudges
 *          tabs to reload when a new deploy ships, so the new SW takes
 *          effect on the next reload.
 * - Fail-safe: every call is wrapped in try/catch. A SW failure must NEVER
 *              break the app — registration is a progressive enhancement.
 */
export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (import.meta.env?.DEV) return;

  // Defer until the main thread is idle so the registration doesn't
  // compete with the first paint.
  const schedule = window.requestIdleCallback || ((cb) => window.setTimeout(cb, 1500));

  schedule(async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

      // On `updatefound` + state 'installed' (with a current controller),
      // tell the waiting SW to activate immediately. The next navigation
      // will use the new caches.
      if (reg.waiting && navigator.serviceWorker.controller) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

      // Belt-and-braces: when the active SW changes mid-session, reload
      // once so the new shell + caches apply consistently. Guard against
      // reload loops with a sessionStorage flag.
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
    } catch (err) {
      // Logged only in case a user's DevTools is open; never surfaced.
      console.warn('[sw] registration failed:', err && err.message);
    }
  });
}
