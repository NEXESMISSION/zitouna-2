## Lazy Loading, Suspense and Deploy-Chunk Resilience — Implementation Plan

Source research: [reserch/05-lazy-suspense-bundling.md](../reserch/05-lazy-suspense-bundling.md)

### Executive summary

The investigation documents a consistent post-deploy failure mode: users on an old tab navigate to a new route, the browser requests a chunk hash that no longer exists (because a new Vercel deploy produced a fresh manifest), `import()` fails, and `React.Suspense` hangs on its fallback forever. The user's only recovery is Ctrl+F5, which discards the cached `index.html` and refetches the current manifest.

The root cause is a stack of five gaps in [src/App.jsx](../src/App.jsx), [src/components/AppErrorBoundary.jsx](../src/components/AppErrorBoundary.jsx), and [vercel.json](../vercel.json):

1. Every `lazy(() => import(...))` call is bare — no retry, no catch, no recovery.
2. The top-level `Suspense` has only a spinner fallback, with no timeout and no error boundary between it and the chunk import.
3. `index.html` has no `Cache-Control: no-cache` header, so Vercel's default ~60s edge cache can serve an old manifest for a minute after each deploy.
4. There is no "version manifest" the running app can poll to notice a deploy happened.
5. `AppErrorBoundary`'s "Recharger" button calls `window.location.reload()`, which is explicitly "reload using the browser cache" and can loop back into the same stale manifest.

This plan fixes all five in independent, composable pieces. The anchor change is a `lazyWithRetry(importer)` helper in [src/lib/lazyWithRetry.js](../src/lib/lazyWithRetry.js): wrap every `lazy()` at its declaration site, and from then on every current and future lazy route inherits retry, a one-shot `sessionStorage` guarded hard-refresh, and a usable error signal that the new `ChunkLoadErrorBoundary` can surface.

The plan items are ordered so each one is valuable on its own. If implementation stops after item 3, the app is already materially more reliable; items 4–10 layer on polish, observability and future-proofing.

Target outcomes:

- "Stuck spinner after deploy" becomes either (a) automatic recovery on first retry, or (b) a user-facing "New version available — click to reload" banner.
- Every new lazy route follows a 3-line contract that opts into all of the above for free.
- Each Vercel deploy has a clear checklist that surfaces regressions in cache headers or version file immediately.

### Prerequisites

None. This plan is independent of the auth, cache and pages plans (01–04, 06). It touches only:

- [src/App.jsx](../src/App.jsx) — swap `lazy` for `lazyWithRetry`, swap `Suspense` fallback to the new boundary, make `CommissionTrackerPage` lazy.
- [src/main.jsx](../src/main.jsx) — mount the version-banner host (a single `<VersionBanner />`).
- [src/components/AppErrorBoundary.jsx](../src/components/AppErrorBoundary.jsx) — adjust `reload` semantics.
- [vercel.json](../vercel.json) — add `Cache-Control` for `index.html`.
- [public/version.json](../public/version.json) — new file, written at build time.
- [vite.config.js](../vite.config.js) — optional `define` for `__BUILD_SHA__`.

Everything else lives in new files under [src/lib/](../src/lib) and [src/components/](../src/components).

Nothing in this plan depends on migrating to React Router v7 `routes.lazy`, to a service worker, or to a new bundler. Those are explicitly listed as optional items 6 and 9.

### Plan items

Items are ordered by impact-per-effort. Each item is self-contained — you can ship 1 without 2, 2 without 3, and so on. The one implicit coupling is that items 1 and 2 are the most valuable when paired: the retry wrapper turns transient failures into success, and the Suspense-aware boundary turns permanent failures into actionable UI. Ship them together if possible.

### 1. `lazyWithRetry(importer)` helper

This is the single highest-leverage change. Today, [src/App.jsx](../src/App.jsx) has roughly 35 `lazy(() => import('./...'))` calls (lines 9–44). Each one is a silent hang-on-failure. Wrap them once and the retry, the session guard, and any future instrumentation apply to every route.

Create [src/lib/lazyWithRetry.js](../src/lib/lazyWithRetry.js):

```js
import { lazy } from 'react'

// Treated as a "chunk is missing because the manifest is stale" signal.
// Browsers spell this error inconsistently — cover the known variants.
function isChunkLoadError(err) {
  if (!err) return false
  const name = String(err.name || '')
  const message = String(err.message || '')
  return (
    name === 'ChunkLoadError' ||
    /Loading chunk [\d]+ failed/.test(message) ||
    /Failed to fetch dynamically imported module/.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/.test(message)
  )
}

// Exported so ChunkLoadErrorBoundary can call .isChunkLoadError too.
export { isChunkLoadError }

/**
 * Wrap React.lazy so the import:
 *   - retries once after a short backoff,
 *   - triggers exactly one hard refresh per session when the retry also fails
 *     (guarded by sessionStorage so we do not refresh-loop),
 *   - rethrows so the nearest error boundary can render a useful message.
 */
export function lazyWithRetry(importer, opts = {}) {
  const {
    retries = 1,
    backoffMs = 400,
    sessionKey = 'lazy:hardReloadDone',
  } = opts

  return lazy(() =>
    loadWithRetry(importer, retries, backoffMs).catch((err) => {
      if (!isChunkLoadError(err)) throw err
      // Only permit one hard reload per tab/session, so that a persistent
      // failure (e.g. the chunk really is gone server-side) surfaces as an
      // error instead of a reload loop.
      try {
        if (sessionStorage.getItem(sessionKey) !== '1') {
          sessionStorage.setItem(sessionKey, '1')
          window.location.reload()
          // Return a never-resolving promise so Suspense keeps its fallback
          // while the browser tears down the current document.
          return new Promise(() => {})
        }
      } catch {
        // sessionStorage can throw in private-mode Safari, etc. Fall through.
      }
      throw err
    })
  )
}

function loadWithRetry(importer, retries, backoffMs) {
  return importer().catch((err) => {
    if (retries <= 0 || !isChunkLoadError(err)) throw err
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        loadWithRetry(importer, retries - 1, backoffMs * 2).then(resolve, reject)
      }, backoffMs)
    })
  })
}
```

Usage in [src/App.jsx](../src/App.jsx): the only diff is the import line and a mechanical find/replace.

```jsx
// before
import { Suspense, lazy, useEffect } from 'react'
const LoginPage = lazy(() => import('./pages/LoginPage.jsx'))

// after
import { Suspense, useEffect } from 'react'
import { lazyWithRetry } from './lib/lazyWithRetry.js'
const LoginPage = lazyWithRetry(() => import('./pages/LoginPage.jsx'))
```

Why a session flag, not a time window: timestamps make retry-loop reasoning fragile ("did 30s pass since the last hard reload?"). A single boolean keyed per browsing session is easy to reason about and easy to clear — opening a new tab is a new session. Clear it on successful navigation if desired (see "Optional polish" at the end of this item).

Why backoff and not a fixed retry: transient CDN edge misses usually resolve in 100–500 ms. `400 ms → 800 ms` is conservative enough that a failed retry points to a real stale chunk rather than a flaky network blip. Do not retry more than twice total (default 1 retry) — if two fetches in ~1s both fail, the manifest is genuinely stale and the hard reload is the right answer.

Do not try to detect staleness by parsing the error URL. Browsers inconsistently expose which chunk URL failed, and the logic in [reserch/05-lazy-suspense-bundling.md](../reserch/05-lazy-suspense-bundling.md) (finding #1, finding #14) makes it clear any chunk error during route load should be treated the same.

Optional polish (do last, not required for item 1 to ship):

- Clear `lazy:hardReloadDone` on successful navigation to a new route, so that a second unrelated deploy during the same session can still trigger its own one-shot reload. Implementation: in a small `useEffect` in `App.jsx` that watches `location.pathname` and `sessionStorage.removeItem('lazy:hardReloadDone')` on each change.
- Emit a breadcrumb to your telemetry (`console.warn` at minimum, `Sentry.addBreadcrumb` if added later) each time retry fires and each time the hard reload fires, so the rate of "real deploys catching users" is observable.

### 2. Suspense-aware error boundary (`ChunkLoadErrorBoundary`)

Today [src/App.jsx:67](../src/App.jsx#L67) wraps every route in:

```jsx
<Suspense fallback={<div className="app-loader"><div className="app-loader-spinner" /></div>}>
```

The fallback has no timeout, no error state, and no way to react to a rejection from the `lazy()` import. Item 1 fixes the "silent" half of the problem; this item fixes the "the user sees a spinner they cannot escape" half.

Create [src/components/ChunkLoadErrorBoundary.jsx](../src/components/ChunkLoadErrorBoundary.jsx):

```jsx
import { Component, Suspense } from 'react'
import { isChunkLoadError } from '../lib/lazyWithRetry.js'

class InnerBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    if (isChunkLoadError(error)) {
      console.warn('ChunkLoadErrorBoundary caught chunk load failure', error, info)
    } else {
      console.error('ChunkLoadErrorBoundary caught error', error, info)
    }
  }

  retry = () => {
    this.setState({ error: null })
  }

  hardReload = () => {
    // See item 7 — avoid the cache-friendly reload() here.
    try { sessionStorage.removeItem('lazy:hardReloadDone') } catch {}
    window.location.href = window.location.href
  }

  render() {
    if (this.state.error) {
      const chunk = isChunkLoadError(this.state.error)
      return (
        <main className="app-loader app-loader--error" role="alert">
          <h2>{chunk ? 'Mise à jour détectée' : 'Une erreur est survenue'}</h2>
          <p>
            {chunk
              ? "Une nouvelle version de l'application est disponible. Rechargez pour continuer."
              : "Impossible de charger cette page."}
          </p>
          <div className="app-loader-actions">
            <button type="button" onClick={this.retry}>Réessayer</button>
            <button type="button" onClick={this.hardReload}>Recharger</button>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}

// Three-state fallback: spinner → "slow connection" → "deploy update" via a
// small state machine driven by setTimeout. This is deliberately self-contained
// so App.jsx only needs <Suspense fallback={<SlowSuspenseFallback />}>.
function SlowSuspenseFallback() {
  const [phase, setPhase] = useState('loading')

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('slow'), 8000)
    const t2 = setTimeout(() => setPhase('stuck'), 20000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  if (phase === 'stuck') {
    return (
      <div className="app-loader app-loader--stuck" role="status">
        <p>La page ne répond pas. Il peut s'agir d'une mise à jour récente.</p>
        <button type="button" onClick={() => { window.location.href = window.location.href }}>
          Recharger pour obtenir la dernière version
        </button>
      </div>
    )
  }
  if (phase === 'slow') {
    return (
      <div className="app-loader app-loader--slow" role="status">
        <div className="app-loader-spinner" />
        <p>Connexion lente — patientez ou réessayez.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Réessayer
        </button>
      </div>
    )
  }
  return (
    <div className="app-loader" role="status">
      <div className="app-loader-spinner" />
    </div>
  )
}

// The exported composite: Boundary + Suspense with the slow fallback.
export default function ChunkLoadErrorBoundary({ children }) {
  return (
    <InnerBoundary>
      <Suspense fallback={<SlowSuspenseFallback />}>{children}</Suspense>
    </InnerBoundary>
  )
}
```

(Note the two missing imports in the sketch above: `useState, useEffect` from `react` for `SlowSuspenseFallback`. Omitted for compactness; add at the top.)

Then in [src/App.jsx](../src/App.jsx):

```jsx
// before
<Suspense fallback={<div className="app-loader"><div className="app-loader-spinner" /></div>}>
  <Routes>...</Routes>
</Suspense>

// after
<ChunkLoadErrorBoundary>
  <Routes>...</Routes>
</ChunkLoadErrorBoundary>
```

Design notes:

- The error boundary is **inside** `AppErrorBoundary`. `AppErrorBoundary` stays as the last-resort catch-all for render errors in already-loaded code. `ChunkLoadErrorBoundary` specifically handles the "chunk never arrived" case with a friendlier message.
- The 8-second threshold is deliberately short. [reserch/05-lazy-suspense-bundling.md](../reserch/05-lazy-suspense-bundling.md) finding #2 shows users today wait forever. 8s is the common web-perf cliff where perceived loading stops and perceived breakage starts.
- The 20-second "stuck" threshold gives a bypass button even when the error object never arrives — important for "chunk preload silently dropped" cases (finding #14).
- The retry button clears the boundary state but does not refresh. If the underlying lazy import is already cached and succeeds, the route mounts. If it fails again, the boundary catches again and shows the same UI — the user can then escalate to Recharger.
- Accessibility: `role="alert"` on the error, `role="status"` on the loading/slow states. Users of assistive tech get a live region update.

### 3. `vercel.json` cache-control headers

Today's [vercel.json](../vercel.json) has no `Cache-Control` block. Vercel's default (~60 s) means a deploy finishing at second 45 can still serve the old `index.html` for 15 s — 15 s during which every navigation points at old chunk hashes that will 404 (findings #4, #18).

The fix splits headers by path:

- `/` and `/index.html` — `Cache-Control: no-cache, must-revalidate` (the browser must revalidate on every load).
- `/assets/*` (Vite's hashed-chunk output) — `Cache-Control: public, max-age=31536000, immutable` (safe because filenames change on content change).
- `/version.json` (item 4) — `Cache-Control: no-cache, must-revalidate` (same reasoning as `index.html`).
- Existing security headers — kept verbatim.

Before (current):

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Content-Security-Policy", "value": "default-src 'self'; ..." }
      ]
    }
  ]
}
```

After (proposed):

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.supabase.co https://*.supabase.in wss://*.supabase.co wss://*.supabase.in; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'" }
      ]
    },
    {
      "source": "/",
      "headers": [
        { "key": "Cache-Control", "value": "no-cache, must-revalidate" }
      ]
    },
    {
      "source": "/index.html",
      "headers": [
        { "key": "Cache-Control", "value": "no-cache, must-revalidate" }
      ]
    },
    {
      "source": "/version.json",
      "headers": [
        { "key": "Cache-Control", "value": "no-cache, must-revalidate" }
      ]
    },
    {
      "source": "/assets/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    }
  ]
}
```

Notes:

- `no-cache` means "revalidate with origin before serving from cache" — not "never cache". That is what we want: the browser can keep the file, but must ask Vercel "is this still current?" before using it. On an unchanged deploy this is a 304 Not Modified round-trip; on a changed deploy it's a 200 with the new bytes.
- `must-revalidate` is a stricter signal specifically targeting stale-while-error paths: do not serve a stale copy even if the origin is briefly unreachable. For our stale-chunk failure mode this is the right stance.
- The Vite default asset folder is `/assets/`. If you override `build.assetsDir`, update the glob to match.
- If a future change adds a `sw.js` service worker at the site root (see item 9), add an equivalent `no-cache, must-revalidate` block for it — service workers must be revalidated on every page load or they become permanently stuck on the old build.

### 4. Version manifest and `useVersionPoller` hook

Item 3 stops users receiving a stale `index.html`, but users who already loaded the app 2 hours ago still have the old bundle in memory. When a deploy lands mid-session, nothing tells their tab. This is the exact scenario that produces the "stuck chunk on navigation" report in [reserch/05-lazy-suspense-bundling.md](../reserch/05-lazy-suspense-bundling.md) finding #3.

The fix is a dirt-simple manifest the app can poll:

Create [public/version.json](../public/version.json):

```json
{ "build": "dev" }
```

(Committed value is a placeholder. The build step overwrites it with the real git SHA — see the Deploy checklist.)

Option A — let Vite write it at build time via a small plugin in [vite.config.js](../vite.config.js) (preferred; keeps build reproducible):

```js
// vite.config.js — sketch
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function buildSha() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'unknown'
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'emit-version-json',
      closeBundle() {
        const sha = buildSha()
        const out = resolve('dist', 'version.json')
        writeFileSync(out, JSON.stringify({ build: sha }))
      },
    },
  ],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
  },
  // ... existing server config preserved
})
```

Option B — a `scripts/emit-version.js` called from `"build": "node scripts/emit-version.js && vite build"` in [package.json](../package.json). Functionally equivalent; pick A if you want one config file to read, pick B if you prefer scripts you can run standalone.

Either way, the running app learns its own build id at compile time via `__BUILD_SHA__` and compares it against the current `version.json`:

Create [src/lib/useVersionPoller.js](../src/lib/useVersionPoller.js):

```js
import { useEffect, useState } from 'react'

const POLL_MS = 5 * 60 * 1000    // 5 minutes
const VERSION_URL = '/version.json'
const BOOT_BUILD = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev'

export default function useVersionPoller() {
  const [latest, setLatest] = useState(BOOT_BUILD)

  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        const res = await fetch(VERSION_URL, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && data && typeof data.build === 'string') {
          setLatest(data.build)
        }
      } catch {
        // Network or offline. Try again next tick.
      }
    }

    check()
    const id = setInterval(check, POLL_MS)

    // Also re-check when the tab becomes visible again, so a user who left a
    // laptop closed all day finds out about the new version on resume.
    function onVisible() { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return {
    bootBuild: BOOT_BUILD,
    latestBuild: latest,
    updateAvailable: latest !== BOOT_BUILD,
  }
}
```

Then a small banner component, mounted once in [src/App.jsx](../src/App.jsx) (or [src/main.jsx](../src/main.jsx) just inside `<BrowserRouter>`):

Create [src/components/VersionBanner.jsx](../src/components/VersionBanner.jsx):

```jsx
import useVersionPoller from '../lib/useVersionPoller.js'

export default function VersionBanner() {
  const { updateAvailable } = useVersionPoller()
  if (!updateAvailable) return null

  return (
    <div className="version-banner" role="status" aria-live="polite">
      <span>Une nouvelle version est disponible.</span>
      <button
        type="button"
        onClick={() => { window.location.href = window.location.href }}
      >
        Recharger
      </button>
    </div>
  )
}
```

Style the banner as a slim strip pinned to the top of the viewport; it should not cover nav. Use `position: sticky; top: 0; z-index: 999` with the admin-theme palette.

Why 5 minutes: cheap enough to never matter on the server side (a single JSON GET), long enough to avoid feeling spammy, short enough that any user who leaves a tab open through a deploy sees the banner in practice. The visibility handler covers the "laptop closed for 8 hours" case without relying on the interval tick.

Why poll client-side instead of push (WebSocket / SSE): the app already talks to Supabase over WSS; adding another push channel just to deliver a string is overkill. Polling a 20-byte JSON file is boring and reliable.

Failure modes to consider:

- **Network offline**: `fetch` throws, the hook silently swallows, banner stays hidden. Correct — offline users cannot update anyway.
- **404 on `version.json`**: missing build step. `res.ok` is false, state unchanged. Banner stays hidden. Add a Deploy checklist item so this is caught at release time.
- **Malformed JSON**: `res.json()` throws, hook swallows. Safe.
- **SHA-like but collision-prone hash**: short git SHAs can theoretically collide. We are comparing string equality, so a collision is a silent miss, not a loop. Acceptable for a "nudge to reload" signal.

### 5. Make `CommissionTrackerPage` lazy

This is the small cleanup flagged in finding #5. Current [src/App.jsx:45](../src/App.jsx#L45):

```jsx
import CommissionTrackerPage from './admin/pages/CommissionTrackerPage.jsx'
```

Change to:

```jsx
const CommissionTrackerPage = lazyWithRetry(() => import('./admin/pages/CommissionTrackerPage.jsx'))
```

Impact:

- Main chunk shrinks by the size of `CommissionTrackerPage` and its non-shared deps (10–20 KB per finding #5).
- A syntax error in that page now fails only on `/admin/commissions`, not at app boot.
- Consistency — every other admin page is lazy. This is the only eager outlier; the inconsistency is itself a footgun for the next developer who looks for a pattern.

No JSX usage change needed; `<CommissionTrackerPage />` at line 101 works identically under `Suspense`.

### 6. Consider React Router v7 `routes.lazy` (optional)

[package.json](../package.json) already pins `react-router-dom: ^7.14.0`. v7 supports a declarative `routes.lazy` in its data-router API that combines route definition with lazy loading, letting you preload a route's loader, action, and component together.

Benefits if you adopt it:

- Natural place to colocate loader/action (if/when you start using them).
- Router-aware preloading on link hover (v7's `<Link prefetch>`).
- The retry logic in item 1 still applies — `lazyWithRetry` just returns a React component, which plugs into either `element={...}` or `lazy: () => ...` forms.

Cost:

- Migration from JSX `<Route element>` to data-router objects is cosmetic-only if you do not adopt loaders/actions, but still touches every route entry in [src/App.jsx](../src/App.jsx).
- No urgency — the current JSX routes work fine with item 1.

Recommendation: defer until you have a second reason to touch `App.jsx` (e.g. adopting loaders). Do not block this plan on it. If adopting later, the migration is:

```js
// sketch — not required by this plan
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
const router = createBrowserRouter([
  { path: '/', element: <BrowsePage /> },
  {
    path: '/admin',
    element: <RequireStaff><AdminLayout /></RequireStaff>,
    children: [
      { path: 'projects', lazy: () => import('./admin/pages/ProjectsPage.jsx').then(m => ({ Component: m.default })) },
      // ...
    ],
  },
])
```

### 7. `AppErrorBoundary.reload` — full bypass-cache reload

Current [src/components/AppErrorBoundary.jsx:28](../src/components/AppErrorBoundary.jsx#L28):

```jsx
<button type="button" className="cta-primary" onClick={() => window.location.reload()}>
  Recharger
</button>
```

`window.location.reload()` (no arg) is spec'd as "reload using the browser cache". For a stale-chunk error, that is exactly the wrong behaviour — it can trip the same 404 → error → reload cycle finding #6 warns about.

Two options:

**Option A — reassign href (recommended):**

```jsx
<button
  type="button"
  className="cta-primary"
  onClick={() => { window.location.href = window.location.href }}
>
  Recharger
</button>
```

Reassigning `href` to itself triggers a standard navigation, which in most browsers counts as a cache-revalidating load (same as typing the URL and pressing Enter). It is not a documented "hard reload" but is the closest portable analogue.

**Option B — `sessionStorage`-flagged reload:**

```jsx
<button
  type="button"
  className="cta-primary"
  onClick={() => {
    try { sessionStorage.setItem('app:forceFresh', '1') } catch {}
    window.location.reload()
  }}
>
  Recharger
</button>
```

Then in [src/main.jsx](../src/main.jsx), before `createRoot`, check:

```js
try {
  if (sessionStorage.getItem('app:forceFresh') === '1') {
    sessionStorage.removeItem('app:forceFresh')
    // Optionally: hit a cache-busting asset to force a fresh manifest.
    // Mostly: the no-cache header on index.html (item 3) already handles this.
  }
} catch {}
```

**Trade-offs:**

| aspect | Option A (href reassign) | Option B (sessionStorage + reload) |
| --- | --- | --- |
| one-liner | yes | no, needs hook in main.jsx |
| works cross-browser | yes | yes |
| documented as "bypass cache" | no | no (there is no such API) |
| interacts with item 3 cache-control | fully sufficient | redundant |
| readable intent | medium | high — the flag name reads as the intent |

**Recommendation:** Option A. Once item 3 lands, `index.html` is `no-cache, must-revalidate` — the `href` reassignment already revalidates against the CDN and picks up the new manifest. Option B adds moving parts for no measurable benefit, and the only reason to prefer it is if item 3 cannot ship for some reason.

Either way, apply the same change to both the hard-reload paths introduced in this plan: `ChunkLoadErrorBoundary.hardReload` (item 2) and `VersionBanner` (item 4). Grep for `window.location.reload()` after the change — any remaining instance is an intentional soft-refresh (e.g. "retry current page's data", not "fetch a new bundle").

There is no web API that is explicitly "reload bypassing cache" short of the user pressing Ctrl+F5 — that is a browser UI feature, not something JS can trigger. The combination of (a) no-cache headers on the HTML and (b) `href` reassignment is the practical web-standard equivalent.

### 8. Distinct spinners (optional polish)

Finding #10 observes: auth wait, chunk load, and data load all use the same `.app-loader-spinner`. Users cannot self-diagnose — "am I waiting on my login, on a download, or on Supabase?" is invisible to them.

Three visually distinct spinners:

- **Auth loading** (`.app-loader-spinner--auth`): current spinner, tinted green to match the auth theme. Used in [src/components/RequireCustomerAuth.jsx:18–22](../src/components/RequireCustomerAuth.jsx#L18), [src/components/RequireStaff.jsx:83–89](../src/components/RequireStaff.jsx#L83).
- **Chunk loading** (`.app-loader-spinner--chunk`): skeleton + shimmer strip matching the user's [loading animations preference](../.claude/memory/MEMORY.md) rather than a spinner — signals "downloading" rather than "thinking". Used in `ChunkLoadErrorBoundary`'s fallback (item 2).
- **Data loading** (`.app-loader-spinner--data`): unchanged default spinner, used inside already-mounted pages for Supabase queries.

Implementation is CSS-only in [src/App.css](../src/App.css). Add three variant classes, update the callsites to pick the right one. Do this only after items 1–4 are shipped; it is a UX polish item, not a correctness fix.

### 9. Service worker audit

Verified on disk:

- [public/](../public) contains only `favicon.svg`, `icons.svg`, `theme-init.js`. No `sw.js`.
- No matches in [src/](../src) for `serviceWorker`, `registerSW`, `workbox`, `sw.js`.
- No SW is registered in [src/main.jsx](../src/main.jsx) or [index.html](../index.html).

Conclusion: **no service worker exists and none is planned by this plan.** Finding #12 in [reserch/05-lazy-suspense-bundling.md](../reserch/05-lazy-suspense-bundling.md) is a "no known issue, but know that one is absent" note — there is no offline fallback and no pre-cache layer.

If a future change introduces a service worker (e.g. `vite-plugin-pwa`), it must adopt one of these two update models:

1. **`skipWaiting` + client-side reload**: new SW activates immediately, and on next page load the app detects the controllerchange event and forces a reload.
2. **User-prompted update** (recommended): new SW enters `waiting`, and the `VersionBanner` from item 4 is enhanced to call `navigator.serviceWorker.getRegistration().then(r => r.waiting?.postMessage({ type: 'SKIP_WAITING' }))` when the user clicks Recharger.

The second option plays naturally with the plan — the banner is already the "reload to pick up new version" UI; wiring in SW skip-waiting is one more message. Make the decision at the time a SW is proposed, not now.

### 10. Vite config review

[vite.config.js](../vite.config.js) (29 lines) contains no custom `build` options — no `rollupOptions.output.manualChunks`, no `chunkFileNames` override, no `build.sourcemap` tweak. Vite's defaults apply:

- Each `import()` becomes its own chunk.
- Chunks named `assets/[name]-[hash].js` with an 8-char content hash.
- Shared dependencies auto-deduplicated by Rollup.

This is the recommended default and the research-doc finding #15 "no manual chunks" is more an observation than a bug. The non-determinism risk is theoretical: Rollup's default hashing is content-based, so identical source produces identical hashes. Hash drift only appears if the dependency graph changes (which is a real diff, not noise).

If a future bundle-size analysis shows value in pinning a vendor chunk (e.g. `react`, `react-dom`, `react-router-dom` together), the pattern is:

```js
// vite.config.js — not part of this plan, sketch only
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        supabase: ['@supabase/supabase-js'],
      },
    },
  },
},
```

Gotcha to know about in advance: manual chunks share cache across deploys only if their inputs are unchanged. If you bump `react`, both `react-vendor` and every chunk that imports it gets a new hash. That is correct behaviour, just worth knowing when reading bundle diffs.

Item 10 ships no code change; it is a "reviewed, nothing to do" entry.

### New infrastructure

Files created by this plan:

- [src/lib/lazyWithRetry.js](../src/lib/lazyWithRetry.js) — the retry wrapper (item 1).
- [src/lib/useVersionPoller.js](../src/lib/useVersionPoller.js) — version polling hook (item 4).
- [src/components/ChunkLoadErrorBoundary.jsx](../src/components/ChunkLoadErrorBoundary.jsx) — Suspense-aware error boundary + slow-connection fallback (item 2).
- [src/components/VersionBanner.jsx](../src/components/VersionBanner.jsx) — "new version available" banner (item 4).
- [public/version.json](../public/version.json) — build-time manifest (item 4).

Files modified:

- [src/App.jsx](../src/App.jsx) — swap imports/lazy calls, replace `<Suspense fallback>` with `<ChunkLoadErrorBoundary>`, mount `<VersionBanner />`, lazy-load `CommissionTrackerPage`.
- [src/components/AppErrorBoundary.jsx](../src/components/AppErrorBoundary.jsx) — item 7 reload semantics.
- [vercel.json](../vercel.json) — cache-control headers (item 3).
- [vite.config.js](../vite.config.js) — emit-version plugin and `__BUILD_SHA__` define (item 4).
- [package.json](../package.json) — optional, only if you pick Option B for build-time version emission.

No files deleted.

### Migration guide for new lazy routes

Three-line contract. Paste this at the top of any new page module added to [src/App.jsx](../src/App.jsx):

```jsx
import { lazyWithRetry } from '../lib/lazyWithRetry.js'
const MyNewPage = lazyWithRetry(() => import('./pages/MyNewPage.jsx'))
// then: <Route path="/my-new-page" element={<MyNewPage />} />
```

That is it. Retry, hard-reload guard, and integration with the Suspense boundary are all inherited. Do not use the bare `lazy(...)` from React directly in this codebase — if you need a one-off without retry (e.g. a dev-only tool), add a comment explaining why.

Lint suggestion (optional): add a custom ESLint rule or a `no-restricted-imports` entry for `react`'s `lazy` export to steer future code toward `lazyWithRetry`. Sketch:

```js
// eslint.config.js additions — sketch
{
  rules: {
    'no-restricted-imports': ['warn', {
      paths: [{
        name: 'react',
        importNames: ['lazy'],
        message: 'Use lazyWithRetry from src/lib/lazyWithRetry.js instead of React.lazy.',
      }],
    }],
  },
}
```

### Deploy checklist

Run through this on every Vercel deploy. The first three items are non-negotiable; the rest are smoke tests.

1. **`index.html` cache-control** — after deploy, run:
   ```sh
   curl -I https://<your-domain>/index.html | grep -i cache-control
   ```
   Expected: `Cache-Control: no-cache, must-revalidate`. If missing, [vercel.json](../vercel.json) was not picked up — check the Vercel project dashboard → Settings → Headers.

2. **`public/version.json` updated** — hit `https://<your-domain>/version.json` and confirm `build` matches the deploying commit's short SHA (first 7 chars of `git rev-parse HEAD`). If it reads `"dev"` or the previous deploy's SHA, the build plugin from item 4 did not run. Re-check [vite.config.js](../vite.config.js).

3. **Stale-tab smoke test** — the scenario the plan exists to fix:
   1. Before starting the deploy, open the site in two tabs. Leave one on e.g. `/browse`, the other on `/admin`.
   2. Deploy the new version.
   3. Wait for deploy to finish.
   4. In the `/browse` tab, navigate to `/admin` (or any other lazy-loaded route). Expected: either (a) the navigation succeeds because the retry worked, or (b) within 5 minutes the `VersionBanner` appears with "Une nouvelle version est disponible". Either path is acceptable; a hung spinner is not.
   5. In the other tab, wait for the banner to appear. Click Recharger. Expected: page reloads with the new `build` SHA visible at `/version.json`.

4. **Hashed-asset caching** —
   ```sh
   curl -I https://<your-domain>/assets/<some-hashed-file>.js | grep -i cache-control
   ```
   Expected: `Cache-Control: public, max-age=31536000, immutable`.

5. **No console errors on cold-load** — open an incognito window, load `/browse`, check the console. No `ChunkLoadError`, no `Failed to fetch dynamically imported module`.

6. **AppErrorBoundary reload path** — this does not get exercised on every deploy but should be verified after any change to `AppErrorBoundary.jsx`. Throw a render error behind a query-param toggle (dev-only), click Recharger, confirm the page reloads to the latest manifest.

7. **CSP allows `/version.json`** — the current CSP in [vercel.json](../vercel.json) has `default-src 'self'` plus `connect-src ... https://*.supabase.co ...`. Fetching `/version.json` is same-origin and covered by `default-src 'self'` (via `connect-src` inheritance). If in doubt, check the network panel for a blocked request.

### Out of scope

These are handled in other plans and must not be touched here:

- **Auth, session races, timeout handling** — plan 01 ([reserch/01-auth-session-races.md](../reserch/01-auth-session-races.md)). Finding #17 "no timeout on Supabase auth calls" is referenced by this research doc but is an auth-layer concern.
- **Data-layer caching, Supabase query retries** — plan 02.
- **Admin page loading skeletons** — plan 03.
- **Public/customer page loading** — plan 04.
- **CSS / skeleton loading animations** — plan 06. This plan uses skeletons in the chunk-loading spinner variant (item 8) but the CSS implementation lives in plan 06.
- **StrictMode double-mount** — finding #9 is an observation, not a bug the user experiences. Fixing it is a React lifecycle concern, not a bundling one.
- **ScrollToTop robustness** — finding #8 is genuinely low-impact edge case (sandboxed iframes). Not fixed here.
- **Service worker adoption** — explicitly deferred in item 9.
- **React Router v7 data-router migration** — explicitly deferred in item 6.
- **Manual vendor chunking** — explicitly deferred in item 10.

### Acceptance checklist

Each item below is a single check that the plan was implemented correctly. Tick once all are green.

- [ ] Every `lazy(...)` call in [src/App.jsx](../src/App.jsx) is `lazyWithRetry(...)`.
- [ ] No direct `import { lazy } from 'react'` remains in [src/App.jsx](../src/App.jsx).
- [ ] `CommissionTrackerPage` is lazy (no eager `import CommissionTrackerPage` line).
- [ ] [src/App.jsx](../src/App.jsx) uses `<ChunkLoadErrorBoundary>` instead of a bare `<Suspense fallback>`.
- [ ] [src/components/ChunkLoadErrorBoundary.jsx](../src/components/ChunkLoadErrorBoundary.jsx) exists, catches errors, detects `ChunkLoadError`, renders retry and hard-reload buttons.
- [ ] Suspense fallback transitions through three phases (spinner → slow → stuck) at the documented thresholds (8 s, 20 s).
- [ ] [src/lib/lazyWithRetry.js](../src/lib/lazyWithRetry.js) exports both `lazyWithRetry` (default) and `isChunkLoadError` (named).
- [ ] First chunk failure retries once after ~400 ms; second failure triggers exactly one hard reload per session.
- [ ] The session flag (`lazy:hardReloadDone`) is cleared on normal page navigation (optional polish) or at tab close.
- [ ] [vercel.json](../vercel.json) contains `Cache-Control: no-cache, must-revalidate` for `/`, `/index.html`, and `/version.json`.
- [ ] [vercel.json](../vercel.json) contains `Cache-Control: public, max-age=31536000, immutable` for `/assets/(.*)`.
- [ ] `curl -I` against a deployed `index.html` confirms the headers above.
- [ ] [public/version.json](../public/version.json) exists and is served.
- [ ] At build time, `version.json` is overwritten with the current git short SHA.
- [ ] [src/lib/useVersionPoller.js](../src/lib/useVersionPoller.js) exists and polls every 5 min and on `visibilitychange`.
- [ ] [src/components/VersionBanner.jsx](../src/components/VersionBanner.jsx) is mounted once at the app root.
- [ ] After a real deploy, the banner appears on an open tab within 5 minutes.
- [ ] [src/components/AppErrorBoundary.jsx](../src/components/AppErrorBoundary.jsx) reload uses `window.location.href = window.location.href` (or the sessionStorage-flagged variant).
- [ ] No service worker registered in [src/main.jsx](../src/main.jsx) (unchanged) — explicitly documented in item 9.
- [ ] [vite.config.js](../vite.config.js) has no `rollupOptions.output.manualChunks` override (unchanged) — explicitly documented in item 10.
- [ ] The deploy checklist section is added to the team's release runbook (or this file is bookmarked).
- [ ] Smoke test in the Deploy checklist passes end-to-end: stale tab recovers gracefully after a real deploy.
