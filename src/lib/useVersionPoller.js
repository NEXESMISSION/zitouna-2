import { useEffect, useRef, useState } from 'react'

// PLAN 05 §4: a dirt-simple client-side poller for /version.json. The build
// plugin in vite.config.js writes the current git short SHA into that file at
// deploy time, and the Vite `define` block exposes the same SHA to the running
// bundle as __BUILD_SHA__. When the two disagree, a new deploy landed while
// this tab was open — callers (VersionBanner) can surface a "reload" prompt.
//
// Failure semantics: every network or parse error is swallowed. The hook never
// throws, so a flaky /version.json never breaks the app. The worst case is
// "no banner shown" — which is the right behaviour when the client is offline
// or the build step failed to emit the file.

const POLL_MS = 5 * 60 * 1000 // 5 minutes
const VERSION_URL = '/version.json'

// Fallback used if the build plugin did not run (dev mode, CI without git).
// eslint-disable-next-line no-undef
const BOOT_BUILD = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev'

// sessionStorage key used to break reload loops. If a user clicks
// "Recharger" but the deploy hasn't propagated (CDN caching /version.json
// ahead of the JS bundle, Vercel build skew, etc.), the mismatch persists
// after reload and we'd prompt again immediately. Remember the SHA we
// already reloaded for and suppress the banner until a *different* build
// appears upstream.
const SUPPRESS_KEY = 'zitouna:versionBanner:reloadedForBuild'
export function markReloadTargetBuild(build) {
  try {
    if (typeof window === 'undefined') return
    if (typeof build === 'string' && build.length > 0) {
      window.sessionStorage.setItem(SUPPRESS_KEY, build)
    }
  } catch { /* storage disabled — best effort */ }
}
function readSuppressedBuild() {
  try {
    if (typeof window === 'undefined') return null
    return window.sessionStorage.getItem(SUPPRESS_KEY)
  } catch { return null }
}

export default function useVersionPoller({ pollMs = POLL_MS } = {}) {
  const [latest, setLatest] = useState(BOOT_BUILD)
  // Keep the latest value in a ref so the visibilitychange handler can
  // compare without re-creating the effect whenever state changes.
  const latestRef = useRef(BOOT_BUILD)

  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        const res = await fetch(VERSION_URL, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const build = data && typeof data.build === 'string' ? data.build : null
        if (!build || cancelled) return
        if (build !== latestRef.current) {
          latestRef.current = build
          setLatest(build)
        }
      } catch {
        // Offline, 404, malformed JSON — silently ignore. Next interval tick
        // (or visibility change) will retry.
      }
    }

    check()
    const id = setInterval(check, pollMs)

    // Re-check on tab focus so a laptop-closed-all-day user sees the banner
    // immediately on resume rather than waiting up to `pollMs` for the next
    // interval tick.
    function onVisible() {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pollMs])

  const suppressedBuild = readSuppressedBuild()
  const mismatchResolved = suppressedBuild && suppressedBuild === BOOT_BUILD
  if (mismatchResolved) {
    // Reload succeeded — the bundle is now the build we were told to load.
    // Clear the flag so a later, legitimate new deploy can still prompt.
    try {
      if (typeof window !== 'undefined') window.sessionStorage.removeItem(SUPPRESS_KEY)
    } catch { /* ignore */ }
  }

  return {
    bootBuild: BOOT_BUILD,
    latestBuild: latest,
    // `dev` means the build plugin did not run (e.g. `vite dev`). Never flag
    // an update in that case — the local tab is always "the latest" when the
    // dev server is the source of truth.
    updateAvailable:
      BOOT_BUILD !== 'dev' &&
      latest !== BOOT_BUILD &&
      // Suppress the banner if we already reloaded for this exact SHA and
      // the mismatch persists — the deploy hasn't propagated yet, prompting
      // again would trap the user in a reload loop.
      latest !== suppressedBuild,
  }
}
