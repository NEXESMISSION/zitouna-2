// ----------------------------------------------------------------------------
// Auth helpers — shared timeout + abort + error-classification utilities for
// the auth boot path and any consumer that needs to wrap a Supabase auth /
// RPC call with a hard deadline. Extracted from AuthContext.jsx so other
// files (Plan 07's watchdog UI, future hooks) can reuse the same contract.
//
// AUDIT RULE: every raw `await supabase.auth.*` or `await <auth RPC>` inside
// AuthContext MUST go through `withAuthTimeout`. Storage-only reads (e.g.
// getSession() reading from localStorage) are cheap but still benefit from
// a generous cap because the underlying Web Lock can orphan.
// ----------------------------------------------------------------------------

/**
 * Await a promise with a hard cap. If it doesn't settle within `ms`, reject
 * with an Error tagged `auth_timeout:<label>`. The tag lets UI code (and
 * `isAuthTimeoutError`) distinguish timeouts from genuine auth failures.
 */
export function withAuthTimeout(promise, ms, label) {
  let timeoutId = null
  const timeoutPromise = new Promise((_, rej) => {
    timeoutId = setTimeout(() => rej(new Error(`auth_timeout:${label}`)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

/**
 * Race a promise against an AbortSignal. On abort, reject with a DOMException
 * tagged `AbortError` — matches the standard fetch/AbortController shape so
 * callers can `if (e?.name === 'AbortError' || signal.aborted) return` after
 * every await and short-circuit cleanly.
 *
 * NOTE: this does NOT cancel the underlying promise (Supabase SDK does not
 * yet accept AbortSignal on auth calls). It only drops the result from our
 * POV so the effect cleanup can proceed. The background request still runs
 * to completion but its outcome is ignored.
 */
export function raceAgainstAbort(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      try { signal.removeEventListener('abort', onAbort) } catch { /* ignore */ }
    })
  })
}

/**
 * Identify errors that are safe to retry (Web Lock contention under React
 * StrictMode double-mount, cross-tab lock steal, short-lived abort). Callers
 * should NOT hard-logout on these — the next revalidation will retry.
 */
export function isTransientAuthLockError(errorLike) {
  const name = String(errorLike?.name || '')
  const msg = String(errorLike?.message || errorLike || '').toLowerCase()
  return (
    name === 'NavigatorLockAcquireTimeoutError'
    || name === 'AbortError'
    || msg.includes('navigatorlock')
    || msg.includes('lock broken')
    || msg.includes('orphaned lock')
    || msg.includes('steal')
  )
}

/**
 * Read the `auth_timeout:` prefix the `withAuthTimeout` rejection stamps onto
 * its Error. UI code uses this to pick a "slow connection" banner instead of
 * a generic auth failure toast.
 */
export function isAuthTimeoutError(e) {
  return String(e?.message || '').startsWith('auth_timeout:')
}
