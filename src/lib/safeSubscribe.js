// src/lib/safeSubscribe.js
//
// Plan 02 item 3 — a wrapper around `supabase.channel(...).subscribe()` that
// actually observes the channel status. The legacy call sites in
// useSupabase.js call `.subscribe()` with no handler, so `CHANNEL_ERROR`,
// `CLOSED`, and `TIMED_OUT` silently drop the realtime feed and the page
// quietly drifts onto stale data without any recovery path.
//
// `safeSubscribe` owns the channel lifecycle end-to-end:
//   - logs terminal statuses
//   - re-subscribes with exponential backoff on CHANNEL_ERROR / CLOSED /
//     TIMED_OUT (up to `maxRetries` attempts)
//   - after retries are exhausted, emits a one-shot `console.error` and
//     surfaces a `degraded` status to the caller so the UI can display
//     a "data may be stale" hint
//   - returns a plain unsubscribe function
//
// Callers NEVER interact with the channel object directly.

import { supabase } from './supabase.js'

/**
 * @typedef {Object} SafeSubscribeArgs
 * @property {string} channelName
 *   Globally unique channel name. Include the scope key for scoped stores
 *   (e.g. `cache:sales:clientId=xxx`) so Supabase dedup doesn't collide.
 * @property {(channel: any) => void} attach
 *   Synchronously called with a fresh channel before `.subscribe()`. Wire
 *   up `.on('postgres_changes', ...)` handlers here.
 * @property {(status: string, err?: unknown) => void} [onStatusChange]
 *   Notified of every terminal status transition including `degraded`
 *   (custom — emitted when retries are exhausted).
 * @property {(payload: any) => void} [onEvent]
 *   Unused — reserved for future ergonomic sugar; attach handlers in
 *   `attach` for now.
 * @property {number} [maxRetries=3]
 *   Upper bound on re-subscribe attempts before emitting `degraded`.
 */

/**
 * Subscribe to a Supabase realtime channel with automatic retry on terminal
 * failures. Returns an unsubscribe function.
 *
 * @param {SafeSubscribeArgs} args
 * @returns {() => void} unsubscribe
 */
export function safeSubscribe({
  channelName,
  attach,
  onStatusChange = null,
  // onEvent kept in the public signature per plan; not used yet.
  // eslint-disable-next-line no-unused-vars
  onEvent = null,
  maxRetries = 3,
}) {
  let channel = null
  let retries = 0
  let cancelled = false
  let retryTimer = null
  let degraded = false

  const emitStatus = (status, err) => {
    if (!onStatusChange) return
    try { onStatusChange(status, err) } catch { /* ignore */ }
  }

  const build = () => {
    if (cancelled) return
    // Reuse of a still-open channel (rapid remount / HMR) can leave supabase
    // with a channel whose `.subscribe()` already ran. Calling `.on()` on
    // that throws. Detect and discard the stale channel before wiring up.
    let ch = supabase.channel(channelName)
    try { attach(ch) } catch (e) {
      const msg = String(e?.message || '')
      if (msg.includes('after `subscribe()`') || msg.includes('after subscribe()')) {
        // Stale channel from a prior mount — remove it and rebuild cleanly.
        try { supabase.removeChannel(ch) } catch { /* ignore */ }
        ch = supabase.channel(channelName)
        try { attach(ch) } catch (e2) {
          // If even the fresh channel rejects, something upstream is broken.
          console.warn(`[realtime:${channelName}] attach failed after rebuild`, e2?.message || e2)
        }
      } else {
        console.warn(`[realtime:${channelName}] attach failed`, e?.message || e)
      }
    }
    ch.subscribe((status, err) => {
      emitStatus(status, err)
      switch (status) {
        case 'SUBSCRIBED':
          retries = 0
          degraded = false
          return
        case 'CHANNEL_ERROR':
        case 'CLOSED':
        case 'TIMED_OUT': {
          if (cancelled) return
          // CLOSED on its own is the normal lifecycle state after unmount
          // / HMR / logout — logging every one of those produced hundreds
          // of warn lines per page. Only log genuinely-abnormal statuses.
          if (status !== 'CLOSED') {
            console.warn(`[realtime:${channelName}] status=${status}`, err?.message || '')
          }
          if (retries < maxRetries) {
            retries += 1
            const delay = Math.min(500 * Math.pow(2, retries), 8000)
            retryTimer = setTimeout(() => {
              retryTimer = null
              try { if (channel) supabase.removeChannel(channel) } catch { /* ignore */ }
              channel = null
              build()
            }, delay)
          } else if (!degraded) {
            degraded = true
            console.error(`[realtime:${channelName}] exhausted ${maxRetries} retries; data may be stale`)
            emitStatus('degraded', err)
          }
          return
        }
        default:
          // 'JOINING', 'LEAVING', etc. — ignore.
          return
      }
    })
    channel = ch
  }

  build()

  return () => {
    cancelled = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    try { if (channel) supabase.removeChannel(channel) } catch { /* ignore */ }
    channel = null
  }
}
