import { lazy } from 'react'

// PLAN 05 §1: after a deploy, users with an old index.html tab hit 404s when
// navigating to a route whose chunk hash has changed. React.lazy leaves
// Suspense spinning forever with no error state. This wrapper:
//   1. retries the import up to `maxAttempts - 1` times with backoff + jitter,
//   2. if the failure still looks like a chunk load error, triggers exactly
//      ONE hard reload per tab/session with a cache-busting query param, and
//   3. re-throws otherwise so ChunkErrorBoundary can render a visible panel.
//
// A session-scoped sessionStorage flag (`RELOAD_FLAG`) guarantees we never
// reload-loop: if the hard reload also failed, the second pass through this
// wrapper surfaces an error to the boundary instead of reloading again.
//
// Retry budget by default: 3 attempts total (≈ initial + 2 retries), with
// delays 600ms * attempt + jitter. Caller can override via `{ maxAttempts,
// delayMs }` but the defaults match the research doc's findings.

const RELOAD_FLAG = '__chunk_reload_attempted__'

function isChunkLoadError(err) {
  if (!err) return false
  const name = String(err?.name || '')
  const msg = String(err?.message || '')
  if (name === 'ChunkLoadError') return true
  return (
    /Loading chunk [\d]+ failed/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  )
}

// A small amount of jitter (±25%) on the retry delay de-correlates multiple
// simultaneous failing imports — a whole page of lazy components failing at
// once should not retry in lockstep.
function jittered(ms) {
  const delta = ms * 0.25
  return Math.max(50, Math.round(ms + (Math.random() * 2 - 1) * delta))
}

export default function lazyWithRetry(importFn, { maxAttempts = 3, delayMs = 600 } = {}) {
  return lazy(async () => {
    let lastErr = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await importFn()
      } catch (e) {
        lastErr = e
        // Only retry chunk-load-shaped errors; module syntax errors, network
        // unreachable, CSP violations etc. should surface immediately.
        if (!isChunkLoadError(e)) break
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, jittered(delayMs * attempt)))
        }
      }
    }
    // Chunk load failed after retries — if we haven't already tried a reload
    // this session, force one. Bust any cached index.html by tagging the URL
    // with a timestamp so the browser treats it as a new navigation.
    if (isChunkLoadError(lastErr) && typeof window !== 'undefined') {
      try {
        const reloaded = window.sessionStorage.getItem(RELOAD_FLAG)
        if (!reloaded) {
          window.sessionStorage.setItem(RELOAD_FLAG, String(Date.now()))
          console.warn('[lazyWithRetry] chunk load failed after retries — forcing a cache-busting reload')
          const url = new URL(window.location.href)
          url.searchParams.set('_r', String(Date.now()))
          window.location.replace(url.toString())
          // Return a never-resolving promise so React Suspense keeps the
          // spinner mounted while the browser navigates away. Without this,
          // React would render the error immediately before the reload lands.
          return new Promise(() => {})
        }
        // Already reloaded once this session — surface the error to the
        // boundary so the user gets a clear "reload manually" prompt.
        console.warn('[lazyWithRetry] chunk load failed after reload — surfacing to boundary')
      } catch {
        /* ignore — fall through to throw */
      }
    }
    throw lastErr
  })
}

export function clearChunkReloadFlag() {
  try { window.sessionStorage.removeItem(RELOAD_FLAG) } catch { /* ignore */ }
}

export { isChunkLoadError }
