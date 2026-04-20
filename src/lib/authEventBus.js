// ----------------------------------------------------------------------------
// Single module-level onAuthStateChange subscriber + named fan-out bus.
//
// Background: five distinct `supabase.auth.onAuthStateChange` subscribers
// used to live across supabase.js, useSupabase.js (three places), and
// AuthContext.jsx. Under StrictMode some were duplicated, each running its
// own async work on every auth event — causing Web Lock contention and up
// to 2-4 redundant `/auth/v1/user` calls per TOKEN_REFRESHED.
//
// Plan 01 §10: this bus owns exactly ONE subscription. Consumers register
// named listeners via `onAuth(name, fn)`; the bus fans out every event.
// Listener errors never cross-contaminate; each is caught and logged with
// the listener's name for observability.
//
// The outer subscription is never torn down — it's intended to live for the
// app's lifetime. Deduplication by `name` means registering the same name
// twice (e.g. StrictMode re-mount) replaces the previous handler instead of
// doubling up. Callers that need a clean unsubscribe still get one from the
// returned function.
// ----------------------------------------------------------------------------
import { supabase } from './supabase.js'

const listeners = new Map() // name -> (event, session) => void | Promise<void>
let registered = false

function ensureSubscribed() {
  if (registered) return
  try {
    supabase.auth.onAuthStateChange((event, session) => {
      // Snapshot so listeners added/removed during dispatch don't disturb
      // the current fan-out.
      const entries = Array.from(listeners.entries())
      for (const [name, fn] of entries) {
        try {
          const r = fn(event, session)
          if (r && typeof r.catch === 'function') {
            r.catch((e) => console.warn(`[authEventBus:${name}]`, e?.message || e))
          }
        } catch (e) {
          console.warn(`[authEventBus:${name}]`, e?.message || e)
        }
      }
    })
    registered = true
  } catch {
    // Supabase client failed to construct (missing env). Leave registered=false
    // so a later retry can re-subscribe once the client is up.
    registered = false
  }
}

/**
 * Register a named listener. If the same name was previously registered,
 * the old handler is replaced (idempotent under StrictMode re-mounts).
 * Returns an unsubscribe function that removes this listener.
 */
export function onAuth(name, fn) {
  ensureSubscribed()
  listeners.set(name, fn)
  return () => {
    if (listeners.get(name) === fn) listeners.delete(name)
  }
}
