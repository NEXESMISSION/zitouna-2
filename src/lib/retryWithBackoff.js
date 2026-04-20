// src/lib/retryWithBackoff.js
//
// Plan 02 item 2 — replaces the bespoke `fetchWithRetryOnTimeout` that only
// retried on literal timeout messages. Network blips, stale-JWT 401s,
// PostgREST 500s, and free-tier rate limits all propagated with no retry,
// leaving the UI stuck on `error` + empty data.
//
// This helper wraps any factory `(signal) => Promise<T>` in
// `withAbortableTimeout` and retries up to `maxAttempts` on *any* transient
// error (default classifier covers timeouts, network failures, 5xx, 401
// stale-JWT, and known transient PostgREST codes). Non-transient errors
// propagate immediately, as does AbortError (user-cancelled).
//
// Backoff: exponential with full jitter, capped at `maxDelayMs`. The jitter
// prevents retry storms synchronising across multiple stores all recovering
// from a single Supabase incident.

import { withAbortableTimeout, TimeoutError } from './withAbortableTimeout.js'

const TRANSIENT_PGRST_CODES = new Set([
  'PGRST301', // JWT expired
  'PGRST116', // empty - retry once in case of replica lag
])

/**
 * Default classifier: returns true for errors that are likely to succeed on
 * retry (timeouts, network drops, 5xx, stale-JWT). Callers can override by
 * passing a custom `isTransient` to `retryWithBackoff`.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function defaultIsTransient(e) {
  if (!e) return false
  // User cancelled — never retry. AbortError from the browser fetch layer.
  if (e.name === 'AbortError') return false
  // Our own timeout wrapper — always retry.
  if (e.name === 'TimeoutError' || e instanceof TimeoutError) return true
  const msg = String(e.message || '').toLowerCase()
  if (msg.includes('failed to fetch')) return true
  if (msg.includes('network') || msg.includes('load failed')) return true
  if (msg.includes('timed out')) return true
  if (msg.includes('jwt expired') || msg.includes('invalid jwt')) return true
  const status = Number(e.status)
  if (Number.isFinite(status)) {
    if (status >= 500) return true
    if (status === 401 || status === 408 || status === 429) return true
  }
  if (e.code && TRANSIENT_PGRST_CODES.has(e.code)) return true
  return false
}

/**
 * Run a factory with timeout + transient-error retries.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T> | T} factory
 *   Produces the work. Signal is supplied by `withAbortableTimeout`.
 * @param {object} [opts]
 * @param {string} [opts.label='request']      Diagnostic label for logs.
 * @param {number} [opts.maxAttempts=3]        Total attempts including first try.
 * @param {number} [opts.baseDelayMs=300]      Base for exponential backoff.
 * @param {number} [opts.maxDelayMs=4000]      Cap on a single backoff delay.
 * @param {number} [opts.timeoutMs=12000]      Per-attempt timeout budget.
 * @param {(e: unknown) => boolean} [opts.isTransient=defaultIsTransient]
 *   Classifier — return true if the error merits a retry.
 * @param {(info: {attempt:number, delay:number, error:unknown, label:string}) => void} [opts.onRetry]
 *   Observability callback fired before each retry sleep.
 * @param {() => boolean} [opts.shouldCancel]
 *   Optional cancel check; called at the top of every iteration. When it
 *   returns true the loop exits with `null`. Used by `createScopedStore`
 *   to bail out on user-switch without finishing the retry chain.
 * @returns {Promise<T | null>}
 */
export async function retryWithBackoff(factory, {
  label = 'request',
  maxAttempts = 3,
  baseDelayMs = 300,
  maxDelayMs = 4000,
  timeoutMs = 12000,
  isTransient = defaultIsTransient,
  onRetry = null,
  shouldCancel = null,
} = {}) {
  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (shouldCancel && shouldCancel()) return null
    try {
      return await withAbortableTimeout(factory, { timeoutMs, label })
    } catch (e) {
      lastErr = e
      const transient = isTransient(e)
      const hasMore = attempt < maxAttempts
      if (!transient || !hasMore) throw e
      if (shouldCancel && shouldCancel()) return null
      // Exponential backoff with full jitter: delay ∈ [0, 2^(attempt-1) * base]
      // capped at maxDelayMs. Full jitter avoids storm synchronisation across
      // multiple stores reviving from the same incident.
      const cap = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs)
      const delay = Math.floor(Math.random() * cap)
      if (onRetry) {
        try { onRetry({ attempt, delay, error: e, label }) } catch { /* ignore */ }
      }
      console.warn(`[${label}] attempt ${attempt} failed (${e?.message || e}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw lastErr
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
