// src/lib/withAbortableTimeout.js
//
// Plan 02 item 1 — an AbortController-backed replacement for the old
// `withTimeout` helper in useSupabase.js. The legacy version raced `fetch`
// against `setTimeout`; when the timer won, it rejected the outer promise
// but the underlying HTTP request kept running to completion, burning
// sockets on free-tier Supabase and leaving realtime channels in a wonky
// half-open state.
//
// Contract: caller supplies a factory `(signal) => Promise<T>`. The
// AbortSignal it receives is wired to a timeout that, on expiry, aborts
// the request AND rejects with a `TimeoutError`. Supabase v2 query
// builders accept `.abortSignal(signal)` natively, so a typical caller
// looks like:
//
//   await withAbortableTimeout(
//     (signal) => db().from('sales').select('*').abortSignal(signal),
//     { timeoutMs: 12000, label: 'fetchSales' },
//   )
//
// RPCs and db.js wrappers follow the same pattern once they accept an
// optional `{signal}` argument.

/**
 * Error thrown when an abortable operation exceeds its timeout budget.
 * Downstream `retryWithBackoff` classifies this as transient.
 */
export class TimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * Run a factory with a hard timeout. On timeout the provided AbortSignal
 * fires and the returned promise rejects with `TimeoutError`.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T> | T} factory
 *   Produces the work to race. The signal should be forwarded to fetch
 *   or to Supabase's `.abortSignal(signal)`.
 * @param {object} opts
 * @param {number} opts.timeoutMs  Timeout budget in milliseconds.
 * @param {string} opts.label      Short label used in the timeout message
 *   and diagnostic logs (e.g. `fetch:sales`).
 * @returns {Promise<T>}
 * @throws {TimeoutError} when the timeout fires first.
 */
export async function withAbortableTimeout(factory, { timeoutMs, label } = {}) {
  const controller = new AbortController()
  let timer = null
  let settled = false
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return
      try { controller.abort() } catch { /* ignore */ }
      reject(new TimeoutError(`${label || 'request'} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const run = Promise.resolve().then(() => factory(controller.signal))
    return await Promise.race([run, timeoutPromise])
  } finally {
    settled = true
    if (timer) clearTimeout(timer)
  }
}
