// Path → chunk preloader registry. Consumers (nav cards, quick-action
// buttons) call preloadRoute('/admin/finance') on hover/focus/idle so the
// route chunk is downloaded before the user clicks. When the click lands,
// Suspense resolves synchronously — no fallback flash.
//
// The actual preload functions are registered from App.jsx once the lazy
// components are created. Keeping this file dependency-free avoids a
// circular import between App.jsx and pages that want to preload siblings.

const registry = new Map()

export function registerRoutePreloader(path, fn) {
  if (!path || typeof fn !== 'function') return
  registry.set(String(path).replace(/\/$/, '') || path, fn)
}

export function preloadRoute(path) {
  if (!path) return
  const key = String(path).replace(/\/$/, '') || path
  const fn = registry.get(key)
  if (typeof fn === 'function') {
    try { fn() } catch { /* ignore — chunk will retry on real navigation */ }
  }
}
