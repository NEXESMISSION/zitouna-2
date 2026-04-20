import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizePhone } from './phone.js'
import { supabase } from './supabase.js'
import * as db from './db.js'
import { emitInvalidate, onInvalidate } from './dataEvents.js'
import { onAuth } from './authEventBus.js'
// PLAN 02 §2 / §9 — shared retry helper with AbortController-backed
// timeout, exponential backoff, and mid-loop cancellation. Used by the
// local `createCachedStore.doFetch`; the legacy `fetchWithRetryOnTimeout`
// below is kept for bespoke scoped hooks that haven't migrated yet.
import { retryWithBackoff } from './retryWithBackoff.js'
// PLAN 02 §4 / §8 — the new scoped-store factory. Imported here so (a)
// we can migrate ONE representative bespoke hook (useInstallmentsScoped)
// to it in this pass, and (b) expose the registry on `window` in dev so
// manual debugging can call `.refresh({force:true})` on stuck stores.
import { createScopedStore, getScopedStoreRegistry, getScopedResetHandlers } from './createScopedStore.js'

// 12s timeout — with one retry that's 24s total, enough for slow free-tier
// Supabase wake-up but fast enough that a genuinely stuck socket surfaces in
// the UI before the user hard-refreshes out of frustration. Was 20s (40s with
// retry) — too long; users hit hard-refresh before the second attempt even
// finished.
// 2026-04 fix (SKELETON_LOADING_ANALYTICS §Strategy A): 8 s × 1 retry = 16 s
// worst case before the UI gave up — long enough that users perceived the
// skeleton as "stuck" on slow networks / Supabase cold starts. Drop the per-
// attempt ceiling to 5 s. With the single retry path inside
// `fetchWithRetryOnTimeout`, the true max is now 10 s (5 s + backoff + 5 s),
// and stores watchdog-banner at 4 s so users always have a visible escape
// hatch before the outer deadline.
const DEFAULT_FETCH_TIMEOUT_MS = 5000

async function withTimeout(promiseOrFactory, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, label = 'request') {
  // Accept both: an already-running promise (legacy callers) OR a factory
  // function. A factory defers request creation until after the initial-auth
  // gate resolves, so the first fetch on a cold page load carries the JWT
  // and RLS can match against the active user.
  //
  // RESEARCH 02 §4: wrap with an AbortController so the timeout actually
  // cancels the underlying fetch. If the factory accepts a signal arg (its
  // .length >= 1), we pass it; otherwise the underlying Supabase-js request
  // still runs to completion but the outer promise rejects on schedule.
  // Either way we stop holding the React state open past `timeoutMs`.
  const controller = new AbortController()
  const promise = typeof promiseOrFactory === 'function'
    ? (await awaitInitialAuth(),
       promiseOrFactory.length >= 1
         ? promiseOrFactory(controller.signal)
         : promiseOrFactory())
    : promiseOrFactory
  let timeoutId = null
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      try { controller.abort() } catch { /* ignore */ }
      reject(new Error(`${label} timed out`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
  })
}

// Retry a fetch factory once on transient errors. Permanent errors (4xx
// other than 401/429, RLS-permission refusals) propagate on first try.
// Use for scoped hooks that don't go through createCachedStore (which has its
// own retry).
//
// RESEARCH 02 §2: the previous impl only retried on literal "timed out"
// error messages. Network drops, 5xx from PostgREST, stale JWT errors and
// rate-limit hiccups all propagated immediately and left the UI in an
// empty/stuck state with no recovery path.
function isTransientFetchError(e) {
  const msg = String(e?.message || e).toLowerCase()
  const status = e?.status || e?.code
  if (msg.includes('timed out')) return true
  if (msg.includes('network') || msg.includes('failed to fetch') || msg.includes('load failed')) return true
  if (msg.includes('jwt expired') || msg.includes('invalid jwt') || msg.includes('pgrst301')) return true
  if (msg.includes('fetch error') || msg.includes('networkerror')) return true
  // HTTP 5xx / 429 / 408 are transient; 401 may be recoverable once a
  // token refresh lands.
  if (typeof status === 'number' && (status >= 500 || status === 429 || status === 408 || status === 401)) return true
  if (typeof status === 'string' && /^(5\d\d|429|408|401)$/.test(status)) return true
  return false
}

async function fetchWithRetryOnTimeout(factory, label, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  return retryWithBackoff(
    (signal) => (factory.length >= 1 ? factory(signal) : factory()),
    {
      label,
      maxAttempts: 2,
      timeoutMs,
      isTransient: isTransientFetchError,
      onRetry: async ({ error }) => {
        const msg = String(error?.message || error).toLowerCase()
        if (msg.includes('jwt') || msg.includes('401')) {
          try { await supabase.auth.getSession() } catch { /* ignore */ }
        }
      },
    },
  )
}

function logFetchError(label, err) {
  const msg = String(err?.message || err)
  if (msg.includes('timed out')) {
    console.warn(`[${label}] ${msg}`)
  } else {
    console.error(label, err)
  }
}

// RESEARCH 02 §11: every scoped hook's `.subscribe()` used to run without a
// status callback, so CHANNEL_ERROR / TIMED_OUT / CLOSED events silently
// left the hook running on stale data. `observeChannel(label)` returns a
// status handler pre-bound to a readable label so each call site can use
// it with one line instead of copy-pasting the same warn block.
function observeChannel(label) {
  return (status, err) => {
    // CLOSED is the normal lifecycle state every time a channel unmounts
    // (route change, hook unsubscribe, HMR). Logging it produced hundreds
    // of warn lines on every navigation — pure noise. Only report
    // genuinely-abnormal states so real failures still surface.
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.warn(`[${label}] realtime`, status, err?.message || '')
    }
  }
}

// ----------------------------------------------------------------------------
// Initial-auth gate. Resolves when we have a DEFINITIVE answer about the
// session state:
//   • Path A — an auth event fires (`INITIAL_SESSION`, `SIGNED_IN`,
//     `SIGNED_OUT`, `TOKEN_REFRESHED`) — the happy case, <500 ms.
//   • Path B — `getSession()` returns `null` (anon visitor) → resolve
//     immediately so anon pages render without waiting.
//   • Path C — 15 s failsafe — catastrophic case, so the UI can surface an
//     error instead of a forever-spinner.
//
// RESEARCH / PLAN 01 §1: the previous 2 s UNCONDITIONAL safety timer
// resolved the gate BEFORE any JWT was attached, so every subsequent fetch
// ran without auth, RLS returned [], and stores marked themselves
// successfully-loaded-empty with no retry path. Hard refresh was the only
// recovery. The rewrite keeps a failsafe (15 s) but never uses it as a
// race trigger against the real events.
//
// PLAN 01 §6: `_gateResolvedVia` records WHICH path won the race. If a
// real auth event arrives LATER (e.g. 3 s after a failsafe resolution),
// the top-level bus listener resets `_initialAuthPromise` and force-revives
// every cached store so their JWT-less first fetch is redone with auth.
// `_initialAuthTimedOut` is kept as an alias for `_gateResolvedVia === 'failsafe'`
// for backward compatibility with existing `reviveStale` logic.
// ----------------------------------------------------------------------------
let _initialAuthPromise = null
let _initialAuthTimedOut = false
let _gateResolvedVia = null // 'event' | 'no-session' | 'failsafe' | null
let _lastAuthChangeAt = 0
function buildInitialAuthPromise() {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = null
    let failsafeTimer = null
    const finish = (via) => {
      if (settled) return
      settled = true
      _gateResolvedVia = via
      _initialAuthTimedOut = (via === 'failsafe')
      if (failsafeTimer) { window.clearTimeout(failsafeTimer); failsafeTimer = null }
      try { unsubscribe?.() } catch { /* ignore */ }
      resolve()
    }

    // Path A — subscribe to the real auth event stream via the shared bus so
    // we don't add yet another raw `onAuthStateChange` call. `initial-gate`
    // is unique; calling `onAuth` with the same name in StrictMode replaces
    // the handler rather than stacking.
    unsubscribe = onAuth('initial-gate', (event, session) => {
      if (
        event === 'INITIAL_SESSION' ||
        event === 'SIGNED_IN' ||
        event === 'SIGNED_OUT' ||
        event === 'TOKEN_REFRESHED'
      ) {
        // Update _lastAuthChangeAt eagerly so reviveStale can see it even if
        // the top-level subscriber hasn't processed this event yet.
        if (session?.user?.id) _lastAuthChangeAt = Date.now()
        finish('event')
      }
    })

    // Path B — synchronous storage check. `getSession()` reads the cached
    // JWT from localStorage without a network call. Anon users get an
    // immediate resolution; authenticated users wait for Path A to deliver
    // `INITIAL_SESSION` (Supabase always emits it on next tick).
    supabase.auth.getSession().then(({ data }) => {
      if (!data?.session) finish('no-session')
      // else: wait for INITIAL_SESSION. Do NOT resolve on a timer.
    }).catch(() => {
      // Broken client — unblock so the UI can render an error instead of
      // hanging. Treat this as a failsafe resolution so revive logic kicks
      // in if a real session later arrives.
      finish('failsafe')
    })

    // Path C — last-resort failsafe. Was 15 s in the plan 01 rewrite; that's
    // a very long stretch of skeleton for the user to look at when
    // INITIAL_SESSION never fires (rare, but happens after sleep/wake on
    // mobile Chrome). 2026-04 fix (SKELETON_LOADING_ANALYTICS §Strategy C):
    // shorten to 8 s. Still conservative — path A + B together resolve in
    // <500 ms in >99% of loads — and it puts the effective first-paint
    // ceiling at 8 s + 5 s fetch = ~13 s worst case (down from ~23 s).
    failsafeTimer = window.setTimeout(() => finish('failsafe'), 8_000)
  })
}
export function awaitInitialAuth() {
  if (!_initialAuthPromise) _initialAuthPromise = buildInitialAuthPromise()
  return _initialAuthPromise
}
// Reset the gate on sign-out so a fresh login is awaited (and stale cached
// data is cleared by cache stores below).
//
// FE2-C1 / FE2-H4 / FE2-M3 (13_FRONTEND_DEEP_AUDIT): the original code only
// ran reset on SIGNED_OUT. That missed the "user-switch without sign-out"
// path (token refresh swapping identity, magic-link bridge, dev tools
// pasting a different session). Without a reset on user-switch, the
// module-scope cache stores below would hand user B's first subscriber
// user A's stale rows for one render — possible PII leak.
//
// We now track the last-resolved auth user id at module scope. On EVERY
// auth event we re-resolve `session?.user?.id`; if it changed (and the
// previous value was non-null), we trigger the same full reset path used
// for SIGNED_OUT. Resetting also nulls out each store's `inflight`
// promise (see `reset()` in `createCachedStore`), so a fetch started by
// user A can't deliver its result into user B's snapshot.
//
// First-ever sign-in (`_currentUserId === null` → some id): we DO update
// the tracker but skip the reset, because there's nothing user-specific
// in the stores yet.
let _currentUserId = null
let _userIdResolved = false

onAuth('user-switch-detect', (event, session) => {
  const nextUserId = session?.user?.id || null
  // Track the moment a real auth event arrived — `reviveStale` uses this to
  // force-refresh stores whose `loadedAt` is OLDER than the latest auth
  // change (i.e. data loaded pre-JWT, now we have a session).
  if (nextUserId) _lastAuthChangeAt = Date.now()

  if (event === 'SIGNED_OUT') {
    _initialAuthPromise = null
    _initialAuthTimedOut = false
    _gateResolvedVia = null
    _currentUserId = null
    _userIdResolved = true
    // Clear store snapshots but skip the automatic refetch. Without a
    // session, every admin-table fetcher would 403 against RLS and spam
    // the console during the brief window before the login redirect
    // unmounts the admin pages. Applies to both cached stores and the
    // scoped-store factories (installments-scoped, sales-scoped, etc.).
    for (const reset of _storeResetHandlers) reset({ refetch: false })
    try {
      for (const resetAll of getScopedResetHandlers()) resetAll({ refetch: false })
    } catch { /* ignore — registry uninitialised in rare test setups */ }
    return
  }

  // Detect identity change on any other event (SIGNED_IN, TOKEN_REFRESHED,
  // USER_UPDATED, INITIAL_SESSION). Skip the very first observation since
  // the cache is still empty.
  if (_userIdResolved && _currentUserId && nextUserId && nextUserId !== _currentUserId) {
    // User identity changed without a SIGNED_OUT in between — purge every
    // cache store and abort their inflight fetches so stale RLS-scoped
    // data from the previous user can't leak into the new user's UI.
    _initialAuthPromise = null
    _initialAuthTimedOut = false
    _gateResolvedVia = null
    for (const reset of _storeResetHandlers) reset()
  }

  // PLAN 01 §6: post-failsafe recovery. If the gate was resolved via the
  // 15 s failsafe (meaning stores may have loaded without a JWT), and now
  // a real auth event delivers a session, we must:
  //   (a) reset `_initialAuthPromise` so future awaitInitialAuth() callers
  //       rebuild the gate against the real session state, and
  //   (b) force-refresh every cached store — their first load ran before
  //       the JWT attached, so RLS likely handed back [].
  // The reviveStale listener elsewhere in this file also handles (b), but
  // doing it here as well guarantees stores are kicked even if they were
  // in-flight when the late event arrived.
  if (
    _gateResolvedVia === 'failsafe' &&
    nextUserId &&
    (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')
  ) {
    _initialAuthPromise = null
    _initialAuthTimedOut = false
    _gateResolvedVia = null
    for (const s of _allCachedStores) {
      try { s.refresh({ force: true, background: Boolean(s.getState().loadedAt) }).catch(() => {}) } catch { /* ignore */ }
    }
  } else if (_initialAuthTimedOut && nextUserId) {
    // Legacy path: the gate was resolved with the pre-rewrite semantics but
    // `_gateResolvedVia` didn't get set (shouldn't happen normally; kept for
    // defence-in-depth). Still rebuild the gate so future waiters see the
    // real session.
    _initialAuthPromise = null
    _initialAuthTimedOut = false
    _gateResolvedVia = null
  }

  if (nextUserId !== null || event === 'INITIAL_SESSION') {
    _currentUserId = nextUserId
    _userIdResolved = true
  }
})

// ============================================================================
// Cached store factory — the core of Fix A.
//
// Problem this solves: every hook used to fetch on every mount, so
// navigating between pages refetched the same data, overwhelming free-tier
// Supabase. With this store:
//   • State lives at module scope — reused across pages.
//   • First subscriber triggers ONE fetch; later subscribers read cached data.
//   • A single realtime channel per table (singleton).
//   • Stale-while-revalidate: return cache instantly, refetch in background.
//   • Debounced burst refresh (for realtime event storms).
//   • One automatic retry on timeout.
// ============================================================================
const DEFAULT_STALE_MS = 15_000

// PLAN 02 §11 — Vite HMR hardening. Under HMR, saving this file
// re-evaluates the module which creates fresh `_salesStore`, `_clientsStore`
// etc. objects — while the OLD store instances are still subscribed to
// realtime channels. Pages then see a mix of stale and fresh stores
// depending on which module instance they imported first. We stash state
// onto globalThis with a stable key so every re-evaluation reuses the
// same Sets and the same `_namedStores` Map.
const HMR_KEY = '__zitouna_cache_stores__'
const _hmrGlobal = typeof globalThis !== 'undefined' ? globalThis : window
if (!_hmrGlobal[HMR_KEY]) {
  _hmrGlobal[HMR_KEY] = {
    resetHandlers: new Set(),
    allStores: new Set(),
    namedStores: new Map(),
  }
}
const _storeResetHandlers = _hmrGlobal[HMR_KEY].resetHandlers
// Registry of every cached store — lets module-level listeners (visibility
// change, auth refresh) bulk-refresh errored/stale stores without each store
// having to register its own listeners. Each entry exposes getState + refresh.
const _allCachedStores = _hmrGlobal[HMR_KEY].allStores
const _namedStores = _hmrGlobal[HMR_KEY].namedStores

function createCachedStore({ key, fetcher, realtimeTables = [], staleMs = DEFAULT_STALE_MS, initial = [] }) {
  // PLAN 02 §6 / §7 — state shape extended with `isRefreshing`
  // (background refetch indicator, distinct from `loading` which is only
  // the initial load) and `emptyFromNoAuth` / `lastAttemptAt` (so
  // `reviveStale` can distinguish "fetched without a JWT and got []" from
  // "fetched with a session and genuinely zero rows").
  let state = {
    data: initial,
    loading: true,
    isRefreshing: false,
    loadedAt: 0,
    lastAttemptAt: 0,
    error: null,
    emptyFromNoAuth: false,
  }
  const listeners = new Set()
  let inflight = null
  let channel = null
  let refreshTimer = null
  let subCount = 0
  // FE2-M3: monotonically-increasing fetch generation. `reset()` bumps this
  // when a user-switch is detected so any in-flight `doFetch` whose request
  // was issued by a previous user can be detected on resolve and DROPPED
  // instead of overwriting the current (now-empty) snapshot. Bumping is
  // cheaper and safer than wiring AbortSignal through every db.fetcher.
  let fetchGen = 0
  // Channel teardown grace timer — see FE2-L3.
  let channelTeardownTimer = null

  function publish(patch) {
    state = { ...state, ...patch }
    for (const fn of listeners) {
      try { fn(state) } catch (e) { console.error(`[cache:${key}] listener`, e) }
    }
  }

  async function doFetch() {
    if (inflight) return inflight
    const myGen = fetchGen

    // PLAN 02 §7 — classify the outcome so `reviveStale` can revive stores
    // that loaded empty WITHOUT a JWT. We check auth state at fetch start
    // instead of at publish so the empty classification reflects the
    // conditions the fetch actually ran under.
    //
    // PLAN 02 §9 — use a per-fetch AbortController. `retryWithBackoff`
    // receives a `shouldCancel` hook so each attempt bails out if `reset()`
    // fired between attempts (not just at the final publish).
    const run = async () => {
      let authOk = false
      try {
        await awaitInitialAuth()
        // _gateResolvedVia landed in Phase 1; only `event` and `no-session`
        // indicate a definitive answer. When resolution was via the 15 s
        // failsafe, we treat the fetch as no-auth so reviveStale can revive
        // it once a real session arrives.
        authOk = _gateResolvedVia === 'event'
      } catch { authOk = false }
      if (myGen !== fetchGen) return

      try {
        const data = await retryWithBackoff(
          // Legacy fetchers in db.js don't accept `{signal}` yet; pass it
          // along anyway so callers can opt in without the factory breaking
          // on any that do. `fetcher(opts)` keeps the zero-arg default.
          (signal) => fetcher({ signal }),
          {
            label: `fetch:${key}`,
            maxAttempts: 2,
            timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
            shouldCancel: () => myGen !== fetchGen,
          },
        )
        if (myGen !== fetchGen) return
        const isEmpty = Array.isArray(data) ? data.length === 0 : (data == null)
        publish({
          data,
          loading: false,
          isRefreshing: false,
          loadedAt: Date.now(),
          lastAttemptAt: Date.now(),
          error: null,
          emptyFromNoAuth: isEmpty && !authOk,
        })
      } catch (e) {
        if (myGen !== fetchGen) return
        console.error(`[cache:${key}]`, e)
        publish({
          loading: false,
          isRefreshing: false,
          error: e instanceof Error ? e : new Error(String(e?.message || e)),
          lastAttemptAt: Date.now(),
        })
      }
    }

    const promise = run()
    inflight = promise
    // Clear inflight only if it still points at THIS promise. If reset()
    // fired mid-fetch and a newer doFetch reassigned inflight, we must not
    // clobber that assignment when the old promise finally settles.
    promise.finally(() => {
      if (inflight === promise) inflight = null
    })
    return promise
  }

  function scheduleRefresh(ms = 350) {
    if (refreshTimer) window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      doFetch()
    }, ms)
  }

  async function refresh({ force = false, background = false } = {}) {
    const fresh = state.loadedAt && Date.now() - state.loadedAt < staleMs
    if (!force && fresh) return state.data
    // PLAN 02 §6 — distinguish initial load from background refetch so UIs
    // keep rendering existing data (and show a subtle indicator via
    // `isRefreshing`) instead of flashing a skeleton every time the user
    // hits a refresh button or realtime bumps the cache.
    if (!background && !state.loadedAt) {
      publish({ loading: true, isRefreshing: false, lastAttemptAt: Date.now() })
    } else {
      publish({ isRefreshing: true, lastAttemptAt: Date.now() })
    }
    await doFetch()
    return state.data
  }

  function mutateLocal(fn) {
    const next = fn(state.data)
    if (next !== state.data) publish({ data: next })
  }

  function setupChannel() {
    // FE2-L3: if a teardown timer is pending (subCount went 1→0 microseconds
    // ago and we're now back to 1), cancel the teardown and reuse the
    // existing channel rather than tearing it down and re-subscribing.
    if (channelTeardownTimer) {
      window.clearTimeout(channelTeardownTimer)
      channelTeardownTimer = null
    }
    if (channel || realtimeTables.length === 0) return
    let ch = supabase.channel(`cache:${key}`)
    for (const table of realtimeTables) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        scheduleRefresh(500)
      })
    }
    // RESEARCH 02 §11: observe channel health. A silent handshake failure
    // leaves the app running on stale data — without this callback we never
    // know to refresh. On CHANNEL_ERROR/TIMED_OUT, schedule a refresh so
    // dependent UIs pick up any data missed during the outage.
    ch.subscribe((status, err) => {
      // CLOSED fires on every unsubscribe (route change, HMR). Don't log.
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[cache:${key}] realtime ${status}`, err?.message || '')
        scheduleRefresh(1000)
      }
    })
    channel = ch
  }

  function teardownChannel() {
    // FE2-L3: React Strict Mode and route changes can toggle subCount from
    // 1 → 0 → 1 within microseconds. If we tear down synchronously, the
    // subsequent re-subscribe opens a NEW channel before the first finishes
    // closing — Supabase keeps both alive briefly, doubling realtime events
    // and refetches. Defer the actual `removeChannel` by 100ms; if a new
    // subscriber arrives first, `setupChannel` cancels this timer.
    if (refreshTimer) {
      window.clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (!channel) return
    if (channelTeardownTimer) window.clearTimeout(channelTeardownTimer)
    channelTeardownTimer = window.setTimeout(() => {
      channelTeardownTimer = null
      // Double-check no one re-subscribed during the grace period.
      if (subCount > 0) return
      try { supabase.removeChannel(channel) } catch { /* ignore */ }
      channel = null
    }, 100)
  }

  function subscribe(fn) {
    listeners.add(fn)
    subCount += 1
    if (subCount === 1) setupChannel()
    // Kick off the first load if we have no data yet AND nothing in-flight.
    // Subsequent subscribers just read the cached state — no new fetch.
    if (!state.loadedAt && !inflight) refresh().catch(() => {})
    // Hand the new subscriber the current snapshot immediately so it renders
    // cached data without waiting for the next publish.
    try { fn(state) } catch { /* ignore */ }
    return () => {
      listeners.delete(fn)
      subCount -= 1
      if (subCount === 0) teardownChannel()
    }
  }

  function reset({ refetch = true } = {}) {
    // FE2-C1 / FE2-M3: bump the fetch generation so any in-flight request
    // started by the previous user resolves into a no-op instead of
    // publishing into the new (cleared) snapshot.
    //
    // PLAN 02 §9 — `retryWithBackoff.shouldCancel` checks `myGen` at the
    // top of EVERY attempt (not just the final publish), so a reset mid-
    // retry no longer wastes a second request. The currently-open HTTP
    // request finishes naturally; its result is dropped by the
    // `myGen !== fetchGen` guard in doFetch's publish block.
    fetchGen += 1
    state = {
      data: initial,
      loading: true,
      isRefreshing: false,
      loadedAt: 0,
      lastAttemptAt: 0,
      error: null,
      emptyFromNoAuth: false,
    }
    inflight = null
    if (refreshTimer) { window.clearTimeout(refreshTimer); refreshTimer = null }
    for (const fn of listeners) { try { fn(state) } catch { /* ignore */ } }
    // If there are active subscribers, retrigger a fetch so they don't sit on
    // loading=true indefinitely. Without this, reset-during-render (e.g. on
    // user-switch / TOKEN_REFRESHED with identity change) left every admin
    // page's skeletons stuck forever — the user had to hard-refresh to
    // recover. The fresh fetch uses the updated auth context.
    //
    // Exception: on SIGNED_OUT, callers pass `refetch:false`. The admin
    // page is unmounting and there's no session left; refiring admin-table
    // fetchers would only produce "permission denied" console noise.
    if (refetch && subCount > 0) doFetch().catch(() => {})
  }
  _storeResetHandlers.add(reset)

  const storeHandle = {
    getState: () => state,
    subscribe,
    refresh,
    scheduleRefresh,
    mutateLocal,
    reset,
    key,
    // reviveStale / watchdog use this to skip stores that no component has
    // ever subscribed to. Without the check, stores for admin-only tables
    // (clients, sales, ...) get force-fetched on focus/visibility even when
    // the user is on a public route with no session — RLS then emits a
    // "permission denied" error into the console for every table.
    get hasActiveSubscribers() { return subCount > 0 },
  }
  _allCachedStores.add(storeHandle)
  return storeHandle
}

// ============================================================================
// Cross-store liveness: keep stores healthy without requiring a hard refresh.
//
// Three triggers refresh errored or stale stores:
//   1. Tab becomes visible again (user tabs back in).
//   2. Window regains focus.
//   3. Supabase emits TOKEN_REFRESHED or SIGNED_IN (a fresh JWT landed after
//      the initial-auth 2s safety timer had already fired, so early fetches
//      that failed without a session can now succeed).
//
// Throttled to once per 3s to avoid refresh storms when the OS fires both
// visibility + focus events in the same tick.
// ============================================================================
if (typeof window !== 'undefined') {
  let lastRevive = 0
  const FORCE_REFRESH_COOLDOWN_MS = 12_000
  const reviveStale = (reason) => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const now = Date.now()
    // On auth events, bypass the 3s throttle — those are infrequent and the
    // whole point is to immediately revive stores that loaded pre-JWT.
    const isAuthEvent = typeof reason === 'string' && reason.startsWith('auth:')
    if (!isAuthEvent && now - lastRevive < 3000) return
    lastRevive = now
    for (const s of _allCachedStores) {
      // Skip stores no component is subscribed to. Their initial state
      // always looks "loading but never loaded", which would otherwise make
      // reviveStale force-fetch admin tables (clients/sales/...) from the
      // public browse page and eat a RLS "permission denied" error per
      // table on every focus/visibility event.
      if (!s.hasActiveSubscribers) continue
      const st = s.getState()
      // Revive conditions:
      //   • loading=true for a long time (stuck skeleton), OR
      //   • error is set (prior fetch failed), OR
      //   • data is old enough to be stale, OR
      //   • RESEARCH 02 §7: store's loadedAt predates the last real auth
      //     change — i.e. fetched before the JWT arrived, likely returned
      //     empty via RLS. Force a refresh now that we have a session.
      //   • PLAN 02 §7: `emptyFromNoAuth` — the most recent fetch
      //     completed `{data:[], error:null, loading:false, loadedAt>0}`
      //     but ran without a valid session. Without this flag,
      //     reviveStale treated such stores as healthy and the user sat
      //     on an empty page forever.
      // 2026-04 fix (SKELETON_LOADING_ANALYTICS §Strategy B): 30 s was too
      // patient — a stuck store wasn't self-healing until the user waited
      // half a minute AND triggered a focus/visibility event. 10 s keeps
      // healthy refreshes from thundering while ensuring a truly stuck
      // skeleton recovers on the next tab switch instead of feeling dead.
      const stale = st.loadedAt && now - st.loadedAt > 10_000
      const loadedPreAuth = st.loadedAt && _lastAuthChangeAt && st.loadedAt < _lastAuthChangeAt
      if (st.error || (st.loading && !st.loadedAt) || stale || loadedPreAuth || st.emptyFromNoAuth) {
        const lastForcedAt = s._lastForcedRefreshAt || 0
        if (now - lastForcedAt < FORCE_REFRESH_COOLDOWN_MS) continue
        s._lastForcedRefreshAt = now
        try {
          s.refresh({ force: true, background: Boolean(st.loadedAt) }).catch(() => {})
        } catch { /* ignore — never let one store break the loop */ }
      }
    }
    // PLAN 02 §4/§8 — iterate scoped-store instances too. Phase 3 will
    // migrate remaining bespoke hooks; anything already on
    // `createScopedStore` benefits from reviveStale automatically.
    try {
      for (const s of getScopedStoreRegistry()) {
        const st = s.getState()
        // 2026-04 fix (SKELETON_LOADING_ANALYTICS §Strategy B): 30 s was too
      // patient — a stuck store wasn't self-healing until the user waited
      // half a minute AND triggered a focus/visibility event. 10 s keeps
      // healthy refreshes from thundering while ensuring a truly stuck
      // skeleton recovers on the next tab switch instead of feeling dead.
      const stale = st.loadedAt && now - st.loadedAt > 10_000
        const loadedPreAuth = st.loadedAt && _lastAuthChangeAt && st.loadedAt < _lastAuthChangeAt
        if (st.error || (st.loading && !st.loadedAt) || stale || loadedPreAuth || st.emptyFromNoAuth) {
          const lastForcedAt = s._lastForcedRefreshAt || 0
          if (now - lastForcedAt < FORCE_REFRESH_COOLDOWN_MS) continue
          s._lastForcedRefreshAt = now
          try {
            s.refresh({ force: true, background: Boolean(st.loadedAt) }).catch(() => {})
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    // reason is unused at runtime but kept for future observability.
    void reason
  }
  document.addEventListener('visibilitychange', () => reviveStale('visibility'))
  window.addEventListener('focus', () => reviveStale('focus'))
  window.addEventListener('online', () => reviveStale('online'))

  // When Supabase finally hands us a real session (possibly after the 15 s
  // failsafe already resolved the auth gate with no token), revive any
  // store that loaded without one. Routed through the authEventBus so only
  // one outer `onAuthStateChange` exists per page load.
  try {
    onAuth('revive-stale', (event, session) => {
      if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user?.id) {
        reviveStale(`auth:${event}`)
      }
    })
  } catch { /* ignore — client not initialized */ }

  // PLAN 02 §8 — module-scope watchdog. Every 2 s, scan every cached and
  // scoped store; if any has been `loading=true && loadedAt===0 && !error`
  // for longer than WATCHDOG_MS, force a refresh. Independent of focus /
  // visibility / auth events — a hedge against truly stuck fetches the
  // reviveStale triggers miss. Plan 03 pages will still wire `useWatchdog`
  // from Agent D for their own per-page UI; this is the bottom layer.
  const WATCHDOG_MS = 20000
  const WATCHDOG_TICK_MS = 2000
  window.setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const now = Date.now()
    const scan = (store) => {
      // Same rationale as reviveStale: don't force-fetch stores with no
      // subscribers — they're dormant by design, not stuck.
      if (store.hasActiveSubscribers === false) return
      const st = store.getState()
      if (st && st.loading && !st.loadedAt && !st.error) {
        if (!store._loadingStartedAt) store._loadingStartedAt = now
        // If a request started recently, let it finish naturally.
        const lastAttemptAge = st.lastAttemptAt ? now - st.lastAttemptAt : Infinity
        if (now - store._loadingStartedAt > WATCHDOG_MS && lastAttemptAge > WATCHDOG_MS) {
          const lastForcedAt = store._lastForcedRefreshAt || 0
          if (now - lastForcedAt < FORCE_REFRESH_COOLDOWN_MS) return
          // Reset so we don't spam the log every tick; a single warning
          // per stuck period is plenty.
          console.warn(
            `[watchdog:${store.key}] stuck loading for ${now - store._loadingStartedAt}ms; forcing refresh`,
          )
          store._loadingStartedAt = now
          store._lastForcedRefreshAt = now
          try {
            store.refresh({ force: true, background: false }).catch(() => {})
          } catch { /* ignore */ }
        }
      } else {
        store._loadingStartedAt = 0
      }
    }
    for (const s of _allCachedStores) { try { scan(s) } catch { /* ignore */ } }
    try {
      for (const s of getScopedStoreRegistry()) { try { scan(s) } catch { /* ignore */ } }
    } catch { /* ignore — registry uninitialised in rare test setups */ }
  }, WATCHDOG_TICK_MS)
}

function useCachedStore(store) {
  const [snap, setSnap] = useState(() => store.getState())
  useEffect(() => store.subscribe(setSnap), [store])
  return snap
}

/**
 * Connection health snapshot across ALL cached stores. Returns a summary
 * the UI can use for a "slow connection" banner without each page having
 * to manually gather per-store loading/error flags.
 *
 *   • `slow: true`  — at least one store has been loading for >5s with no
 *                     cached data to show. User is staring at a skeleton.
 *   • `errored: true` — at least one store has an error and no cached data.
 *                       Page is effectively broken.
 *   • `stale: false`  — reserved for future; currently unused.
 *
 * Polls every 1s (cheap, only reads getState) rather than subscribing to
 * every store individually. Returning early on the same shape keeps React
 * from re-rendering needlessly.
 */
export function useConnectionHealth() {
  const [health, setHealth] = useState({ slow: false, errored: false })
  useEffect(() => {
    const SLOW_MS = 9000
    const tick = () => {
      let slow = false
      let errored = false
      const now = Date.now()
      for (const s of _allCachedStores) {
        // Skip stores no page is actually waiting on. Their initial state is
        // {loading:true, loadedAt:0, error:null} forever until someone
        // subscribes — reporting them as "slow" produced a permanent banner
        // on admin pages that only consume a subset of the cached stores.
        if (!s.hasActiveSubscribers) {
          s._slowFirstSeen = 0
          continue
        }
        const st = s.getState()
        if (st.error && !st.loadedAt) { errored = true }
        // Loading with no cache and taking > SLOW_MS = user is stuck on skeleton.
        // We don't know when loading started; approximate by "loading && no
        // loadedAt && no error". Refine if we add a loadingSince timestamp.
        if (st.loading && !st.loadedAt && !st.error) {
          // Fire SLOW after the SLOW_MS threshold by tracking the first
          // observation time on the store handle.
          if (!s._slowFirstSeen) s._slowFirstSeen = now
          if (now - s._slowFirstSeen > SLOW_MS) slow = true
        } else {
          s._slowFirstSeen = 0
        }
      }
      setHealth((prev) => {
        if (prev.slow === slow && prev.errored === errored) return prev
        return { slow, errored }
      })
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  return health
}

// ── Store instances — one per top-level resource ────────────────────────────
// PLAN 02 §11 — wrap createCachedStore calls so Vite HMR reuses the
// existing module-scope instances instead of creating fresh ones every
// re-evaluation. The old behaviour left multiple copies of `_salesStore`
// alive, each subscribed to the same realtime channel, which manifested
// in dev as duplicate refetches after every save.
function getOrCreateStore(key, options) {
  const existing = _namedStores.get(key)
  if (existing) return existing
  const store = createCachedStore({ key, ...options })
  _namedStores.set(key, store)
  return store
}
// Fetchers are intentionally written as `(opts) => db.fetchX(opts)` so the
// `{signal}` passed by retryWithBackoff flows through once db.js fetchers
// adopt it (tracked in plan 02 §1). Until then, db.fetchers ignore the
// unknown `signal` key — harmless.
const _salesStore = getOrCreateStore('sales', {
  fetcher: (opts) => db.fetchSales(opts),
  realtimeTables: ['sales'],
})
const _clientsStore = getOrCreateStore('clients', {
  fetcher: (opts) => db.fetchClients(opts),
  realtimeTables: ['clients'],
})
const _projectsStore = getOrCreateStore('projects', {
  fetcher: (opts) => db.fetchProjects(opts),
  realtimeTables: ['projects', 'parcels'],
})
const _adminUsersStore = getOrCreateStore('admin_users', {
  fetcher: (opts) => db.fetchAdminUsers(opts),
  realtimeTables: ['admin_users'],
})
const _offersStore = getOrCreateStore('offers', {
  fetcher: (opts) => db.fetchOffers(opts),
  realtimeTables: ['project_offers'],
  initial: null,
})
const _installmentsStore = getOrCreateStore('installments', {
  fetcher: (opts) => db.fetchInstallments(opts),
  realtimeTables: ['installment_plans', 'installment_payments'],
})

// PLAN 02 §11 — HMR dispose hook. On re-evaluation, tear down realtime
// subscriptions so the fresh module subscribes cleanly. Without this, two
// different channels for the same table run in parallel until GC.
if (typeof import.meta !== 'undefined' && import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const s of _allCachedStores) {
      try { s.reset() } catch { /* ignore */ }
    }
  })
}

// PLAN 02 §8 — dev-only window surfacing. Plan 03 pages will wire their
// own per-page watchdog via `useWatchdog` (Agent D); meanwhile manual
// debugging benefits from a one-liner:
//     window.__zitounaStores.refreshAll()
//     window.__zitounaScoped
if (
  typeof window !== 'undefined' &&
  typeof import.meta !== 'undefined' &&
  import.meta.env &&
  import.meta.env.DEV
) {
  try {
    window.__zitounaStores = {
      get all() { return Array.from(_allCachedStores) },
      byKey: (k) => _namedStores.get(k) || null,
      refreshAll: () => {
        for (const s of _allCachedStores) {
          try { s.refresh({ force: true }).catch(() => {}) } catch { /* ignore */ }
        }
      },
    }
    window.__zitounaScoped = {
      get all() { return Array.from(getScopedStoreRegistry()) },
      refreshAll: () => {
        for (const s of getScopedStoreRegistry()) {
          try { s.refresh({ force: true }).catch(() => {}) } catch { /* ignore */ }
        }
      },
    }
  } catch { /* ignore */ }
}

// Bus → store: pages that emit `emitInvalidate('sales')` bump the cache.
onInvalidate('sales',            () => _salesStore.refresh({ force: true, background: true }))
onInvalidate('clients',          () => _clientsStore.refresh({ force: true, background: true }))
onInvalidate('projects',         () => _projectsStore.refresh({ force: true, background: true }))
onInvalidate('installmentPlans', () => _installmentsStore.refresh({ force: true, background: true }))

export function useProjects() {
  const { data: projects, loading } = useCachedStore(_projectsStore)
  const refresh = useCallback(() => _projectsStore.refresh({ force: true }), [])
  const updateParcelStatus = useCallback(async (parcelDbId, status) => {
    try {
      await db.updateParcelStatus(parcelDbId, status)
      _projectsStore.scheduleRefresh(250)
      emitInvalidate('projects')
    } catch (e) {
      console.error('updateParcelStatus', e)
    }
  }, [])
  return { projects, loading, refresh, updateParcelStatus }
}

export function useProjectsScoped(projectIds = []) {
  const { projects, loading, refresh } = useProjects()
  const filtered = useMemo(() => {
    if (!Array.isArray(projectIds) || projectIds.length === 0) return projects
    const ids = new Set(projectIds)
    return projects.filter((p) => ids.has(p.id))
  }, [projects, projectIds])
  return { projects: filtered, loading, refresh }
}

export function usePublicBrowseProjects() {
  const enableCatalogRealtime = Boolean(import.meta?.env?.VITE_ENABLE_PUBLIC_CATALOG_REALTIME)
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  // PLAN 02 §13 — surface the error AND clear stale data on initial load
  // failure. The previous implementation only `console.error`'d, so a
  // remount with prior state (e.g. if a future StoreProvider migration
  // rehydrated) would keep showing the old catalog after an error.
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchWithRetryOnTimeout(
        () => db.fetchPublicCatalogProjects(),
        'fetchPublicCatalogProjects',
      )
      setProjects(data)
    } catch (e) {
      console.error('fetchPublicCatalogProjects', e)
      setProjects([])
      setError(e instanceof Error ? e : new Error(String(e?.message || e)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await fetchWithRetryOnTimeout(
          () => db.fetchPublicCatalogProjects(),
          'fetchPublicCatalogProjects',
        )
        if (!cancelled) setProjects(data)
      } catch (e) {
        console.error('fetchPublicCatalogProjects', e)
        if (!cancelled) {
          // PLAN 02 §13 — clear AND surface. Consumers that destructure
          // only `{projects, loading}` ignore the new field (backward
          // compatible); the few that care can render a retry banner.
          setProjects([])
          setError(e instanceof Error ? e : new Error(String(e?.message || e)))
        }
      } finally {
        setLoading(false)
      }
    })()
    const channel = enableCatalogRealtime
      ? supabase
          .channel('realtime-public-catalog')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => refresh())
          .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels' }, () => refresh())
          .subscribe(observeChannel('realtime-public-catalog'))
      : null
    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
    }
  }, [refresh, enableCatalogRealtime])

  return { projects, loading, error, refresh }
}

export function usePublicProjectDetail(projectId) {
  const id = String(projectId || '').trim()
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(() => Boolean(id))

  const refresh = useCallback(async () => {
    if (!id) {
      setProject(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await db.fetchPublicProjectById(id)
      setProject(data)
    } catch (e) {
      console.error('fetchPublicProjectById', e)
      setProject(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (!id) {
      setProject(null)
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const data = await db.fetchPublicProjectById(id)
        if (!cancelled) setProject(data)
      } catch (e) {
        console.error('fetchPublicProjectById', e)
        if (!cancelled) setProject(null)
      } finally {
        setLoading(false)
      }
    })()
    // RESEARCH 04 §8: parcel_tree_batches has no project_id column to filter
    // on, so this used to subscribe unfiltered → any tree batch change in
    // the whole DB triggered a refresh on every PlotPage. Throttle the
    // wildcard listener to at most once per 2s to prevent refresh storms
    // while keeping counts reasonably fresh.
    let lastBatchRefresh = 0
    const channel = supabase
      .channel(`realtime-public-project-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects', filter: `id=eq.${id}` }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels', filter: `project_id=eq.${id}` }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcel_tree_batches' }, () => {
        const now = Date.now()
        if (now - lastBatchRefresh < 2000) return
        lastBatchRefresh = now
        void refresh()
      })
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`[usePublicProjectDetail:${id}] realtime`, status, err?.message || '')
        }
      })
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [id, refresh])

  return { project, loading, refresh }
}

export function usePublicVisitSlotOptions() {
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await db.fetchPublicVisitSlotOptions()
      setOptions(rows || [])
    } catch (e) {
      console.error('fetchPublicVisitSlotOptions', e)
      setOptions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchPublicVisitSlotOptions()
        if (!cancelled) setOptions(rows || [])
      } catch (e) {
        console.error('fetchPublicVisitSlotOptions', e)
        if (!cancelled) setOptions([])
      } finally {
        setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-visit-slot-options')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visit_slot_options' }, () => refresh())
      .subscribe(observeChannel('realtime-visit-slot-options'))
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  return { options, loading, refresh }
}

export function useClients() {
  const { data: clients, loading } = useCachedStore(_clientsStore)
  const refresh = useCallback(() => _clientsStore.refresh({ force: true }), [])
  const upsert = useCallback(async (client) => {
    const saved = await db.upsertClient(client)
    _clientsStore.scheduleRefresh(250)
    emitInvalidate('clients')
    return saved
  }, [])
  // FE2-H2 (13_FRONTEND_DEEP_AUDIT): the previous implementation `await`ed
  // the delete first → if RLS rejected, the await rejected and propagated
  // to the caller, but no UI ever changed and many callers only
  // `console.error`'d, leaving the user spamming the button.
  //
  // New contract: optimistically remove the row, await the server, on error
  // RESTORE the snapshot AND re-throw so the caller's catch can pop a toast.
  // Callers that previously ignored the rejection MUST now handle it (every
  // existing caller uses async/await with a try/catch that already logs).
  const remove = useCallback(async (clientId) => {
    const snapshot = _clientsStore.getState().data
    _clientsStore.mutateLocal((prev) => (prev || []).filter((c) => String(c.id) !== String(clientId)))
    try {
      await db.deleteClient(clientId)
      _clientsStore.scheduleRefresh(250)
      emitInvalidate('clients')
    } catch (e) {
      // Roll back the optimistic mutation so the row reappears in the UI.
      _clientsStore.mutateLocal(() => snapshot)
      throw e
    }
  }, [])
  return { clients, loading, refresh, upsert, remove }
}

export function useOffers() {
  const { data: liveOffers, loading, error } = useCachedStore(_offersStore)
  const refresh = useCallback(() => _offersStore.refresh({ force: true }), [])
  const offersByProject = useMemo(() => {
    const out = {}
    const base = liveOffers && typeof liveOffers === 'object' ? liveOffers : {}
    for (const [projectId, list] of Object.entries(base)) {
      out[projectId] = (list || []).map((o) => ({
        dbId: o.dbId ?? o.id,
        name: o.label || o.name,
        price: Number(o.price || 0),
        downPayment: Number(o.avancePct ?? o.downPayment ?? 0),
        duration: Number(o.duration || 0),
      }))
    }
    return out
  }, [liveOffers])
  return { offersByProject, loading, error: error || null, refresh }
}

export function useSales() {
  const { data: sales, loading, error } = useCachedStore(_salesStore)
  const refresh = useCallback(() => _salesStore.refresh({ force: true }), [])

  const create = useCallback(async (sale) => {
    const row = await db.createSale({
      ...sale,
      buyerPhoneNormalized: normalizePhone(sale.buyerPhoneNormalized || sale.buyerPhone || ''),
    })
    // Optimistic: insert the new row at the top immediately, then schedule a
    // background refresh to pick up joined fields the insert didn't return.
    //
    // FE2-M1: tag the optimistic row with `__optimistic` so callers that
    // surface the row before the 350ms refresh resolves can detect that
    // joined fields (project_title, parcel_label, computed status) are NOT
    // yet hydrated. The server-side row replaces it once `scheduleRefresh`
    // resolves and `publish` swaps in the canonical data. See `isOptimistic`
    // helper exported below.
    if (row?.id) {
      const optimistic = { ...row, __optimistic: true }
      _salesStore.mutateLocal((prev) => [optimistic, ...(prev || [])])
    }
    _salesStore.scheduleRefresh(350)
    emitInvalidate('sales')
    return row
  }, [])

  // FE2-H2: optimistic update with snapshot-based rollback + re-throw on
  // error. The previous implementation `await`ed first and only mutated on
  // success — that's safe but felt laggy on slow links. Now the UI updates
  // instantly and reverts only if the server rejects.
  const update = useCallback(async (saleId, patch = {}) => {
    const snapshot = _salesStore.getState().data
    _salesStore.mutateLocal((prev) => (prev || []).map((s) =>
      String(s.id) === String(saleId) ? { ...s, ...patch } : s
    ))
    try {
      await db.updateSale(saleId, patch)
      _salesStore.scheduleRefresh(350)
      emitInvalidate('sales')
      return { id: saleId, ...patch }
    } catch (e) {
      _salesStore.mutateLocal(() => snapshot)
      throw e
    }
  }, [])

  // FE2-H2: same pattern as useClients.remove — optimistic remove + revert
  // on error + re-throw so callers can toast. See comment on useClients.remove
  // for the contract change rationale.
  const remove = useCallback(async (saleId) => {
    const snapshot = _salesStore.getState().data
    _salesStore.mutateLocal((prev) => (prev || []).filter((s) => String(s.id) !== String(saleId)))
    try {
      await db.deleteSale(saleId)
      _salesStore.scheduleRefresh(350)
      emitInvalidate('sales')
    } catch (e) {
      _salesStore.mutateLocal(() => snapshot)
      throw e
    }
  }, [])

  return { sales, loading, error: error || null, refresh, create, update, remove }
}

// FE2-M1: tiny helper for callers that want to know whether a sale row is
// the locally-built optimistic stub or the canonical server row. Useful for
// UIs that want to grey-out the row or skip click handlers until the
// background refresh hydrates the joined fields.
export function isOptimistic(row) {
  return Boolean(row && row.__optimistic === true)
}

function applySaleFilters(list, filters = {}) {
  let out = list || []
  if (filters.clientId != null && filters.clientId !== '') {
    out = out.filter((s) => String(s.clientId) === String(filters.clientId))
  }
  if (filters.postNotaryDestination) {
    out = out.filter((s) => s.postNotaryDestination === filters.postNotaryDestination)
  }
  if (filters.statusIn && Array.isArray(filters.statusIn)) {
    const set = new Set(filters.statusIn)
    out = out.filter((s) => set.has(s.status))
  }
  if (filters.minPipeline) {
    const order = ['draft', 'pending_finance', 'pending_legal', 'active', 'completed']
    const minIdx = order.indexOf(filters.minPipeline)
    if (minIdx >= 0) {
      out = out.filter((s) => order.indexOf(s.status) >= minIdx)
    }
  }
  return out
}

export function useSalesScoped(filters = {}) {
  const [liveSales, setLiveSales] = useState([])
  const [loading, setLoading] = useState(true)
  // PLAN 02 §6 — `isRefreshing` distinguishes "initial load skeleton"
  // from "user manually hit refresh / realtime triggered a refetch".
  // Components that opt in can render a subtle indicator instead of
  // blanking the list behind a skeleton on every refresh.
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastError, setLastError] = useState(null)
  const clientId = filters.clientId
  // PLAN 02 §5 — distinguish THREE states, not two:
  //   • `undefined`     → admin-mode fetch-all (no filter key passed)
  //   • `null`          → caller is still resolving profile — SKELETON
  //                       (keep loading=true; do NOT setLoading(false))
  //   • `''`            → explicit empty — show the empty state
  //                       (loading=false, data=[])
  //   • anything else   → fetch-scoped
  // The previous impl collapsed null+'' into a single `isWaiting=true`
  // branch that cleared loading for both, so admin pages with an
  // unresolved clientProfile flashed an empty list instead of the
  // skeleton they expected.
  const isResolving = clientId === null // keep skeleton
  const isExplicitEmpty = clientId === '' // show empty state

  const refresh = useCallback(async () => {
    if (isResolving) {
      // Auth still resolving — keep the skeleton; do NOT setLoading(false).
      return
    }
    if (isExplicitEmpty) {
      setLiveSales([])
      setLoading(false)
      setIsRefreshing(false)
      return
    }
    // PLAN 02 §6 — was `setLoading(!loadedOnceRef.current || Boolean(lastError))`.
    // That suppressed the skeleton on every refetch after the first
    // success, so the user got zero feedback during a manual refresh.
    // New contract: `loading` stays `true` only while we have no data
    // yet; otherwise flip `isRefreshing` so consumers can render a
    // subtle indicator.
    if (liveSales.length === 0) setLoading(true)
    else setIsRefreshing(true)
    try {
      const rows =
        clientId !== undefined
          ? await fetchWithRetryOnTimeout(() => db.fetchSalesScoped({ clientId }), 'fetchSalesScoped')
          : await fetchWithRetryOnTimeout(() => db.fetchSales(), 'fetchSales')
      setLiveSales(rows)
      setLastError(null)
    } catch (e) {
      logFetchError('fetchSalesScoped', e)
      setLastError(e)
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }, [clientId, isResolving, isExplicitEmpty, liveSales.length])

  // FE2-H5 (13_FRONTEND_DEEP_AUDIT): keep `refresh` accessible to the
  // realtime channel without re-subscribing whenever `refresh`'s identity
  // changes (it does, every time `clientId` changes). The channel handler
  // reads `refreshRef.current()` so it always calls the freshest closure
  // without needing the effect to re-run.
  const refreshRef = useRef(refresh)
  useEffect(() => { refreshRef.current = refresh }, [refresh])

  // Effect 1 — fetch on clientId change. Independent of channel lifecycle.
  useEffect(() => {
    if (isResolving) {
      // PLAN 02 §5 — do NOT setLoading(false). Keep the skeleton until
      // `clientId` transitions to a real id or explicit-empty.
      return
    }
    if (isExplicitEmpty) {
      setLiveSales([])
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      // PLAN 02 §6 — killed `setLoading(!loadedOnceRef.current)`.
      // `loading=true` here ONLY if we truly have nothing cached.
      if (liveSales.length === 0) setLoading(true)
      try {
        const rows =
          clientId !== undefined
            ? await fetchWithRetryOnTimeout(() => db.fetchSalesScoped({ clientId }), 'fetchSalesScoped')
            : await fetchWithRetryOnTimeout(() => db.fetchSales(), 'fetchSales')
        if (!cancelled) { setLiveSales(rows); setLastError(null) }
      } catch (e) {
        if (!cancelled) { logFetchError('fetchSalesScoped', e); setLastError(e) }
      } finally {
        // Always clear loading. React 18 ignores setState on unmounted
        // components silently, so the cancelled guard on loading leaves the
        // skeleton stuck when deps change rapidly mid-fetch.
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // liveSales.length omitted on purpose — the effect is keyed on
    // clientId only; we check length inside to avoid a re-fetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, isResolving, isExplicitEmpty])

  // Effect 2 — channel + bus subscription. Deps: only `clientId`. Without
  // this split, every change to `refresh` (which recomputes when clientId
  // changes) tore down and recreated the realtime channel, dropping
  // notifications during the ~300ms reconnect window.
  useEffect(() => {
    const channel = supabase
      .channel(`realtime-sales-scoped-${String(clientId || 'all')}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => refreshRef.current())
      .subscribe(observeChannel(`realtime-sales-scoped-${String(clientId || 'all')}`))
    const unsubBus = onInvalidate('sales', () => refreshRef.current())
    return () => {
      supabase.removeChannel(channel)
      unsubBus()
    }
  }, [clientId])

  const filtered = useMemo(
    () => applySaleFilters(liveSales, filters),
    [liveSales, filters.postNotaryDestination, filters.statusIn, filters.minPipeline, filters.clientId],
  )

  // Preserve `{sales, loading, refresh}` public API; expose the new
  // `isRefreshing` flag as an extra (backward-compatible) field per
  // plan 02 §6.
  return { sales: filtered, loading, isRefreshing, error: lastError, refresh }
}

export function useSalesBySellerClientId(sellerClientId) {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const loadedOnceRef = useRef(false)
  const isWaiting = sellerClientId == null || sellerClientId === ''

  const refresh = useCallback(async () => {
    if (isWaiting) {
      setSales([])
      setLoading(false)
      return
    }
    setLoading(!loadedOnceRef.current)
    try {
      const rows = await fetchWithRetryOnTimeout(
        () => db.fetchSalesBySellerClientId(sellerClientId),
        'fetchSalesBySellerClientId',
      )
      setSales(rows)
    } catch (e) {
      logFetchError('fetchSalesBySellerClientId', e)
    } finally {
      loadedOnceRef.current = true
      setLoading(false)
    }
  }, [sellerClientId, isWaiting])

  useEffect(() => {
    if (isWaiting) {
      setSales([])
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(!loadedOnceRef.current)
      try {
        const rows = await fetchWithRetryOnTimeout(
          () => db.fetchSalesBySellerClientId(sellerClientId),
          'fetchSalesBySellerClientId',
        )
        if (!cancelled) setSales(rows)
      } catch (e) {
        if (!cancelled) logFetchError('fetchSalesBySellerClientId', e)
      } finally {
        loadedOnceRef.current = true
        setLoading(false)
      }
    })()
    const channel = supabase
      .channel(`realtime-sales-seller-${String(sellerClientId)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => refresh())
      .subscribe(observeChannel(`realtime-sales-seller-${String(sellerClientId)}`))
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh, sellerClientId, isWaiting])

  return { sales, loading, refresh }
}

export function useInstallments() {
  const { data: plans, loading } = useCachedStore(_installmentsStore)
  const refresh = useCallback(() => _installmentsStore.refresh({ force: true }), [])
  const createPlan = useCallback(async (plan) => {
    const id = await db.createInstallmentPlan(plan)
    _installmentsStore.scheduleRefresh(250)
    emitInvalidate('installmentPlans')
    return id
  }, [])
  return { plans, loading, refresh, createPlan, updatePlan: async () => {} }
}

// MIGRATED to createScopedStore. Other hooks still use the legacy pattern — Phase 3 will migrate them incrementally.
//
// Public API contract preserved: `{plans, loading, refresh}`. The shared
// store also exposes `isRefreshing`, `error`, and `emptyFromNoAuth` via
// the scoped-store snapshot; the caller may destructure those extras
// without breaking existing consumers.
//
// PLAN 02 §5 — scope validator distinguishes:
//   • `null`  → 'waiting' (clientProfile still resolving; show skeleton)
//   • `''`    → 'empty'   (explicit no-filter; return data=[] immediately)
//   • real id → 'ok'      (fetch scoped)
// This is the canonical fix for the stuck-skeleton bug called out in
// research 02 §16 (hybrid staff+buyer whose heal takes >5s).
const _useInstallmentsScopedStore = createScopedStore({
  key: 'installments-scoped',
  fetcher: (filters, { signal }) => db.fetchInstallmentsScoped({ clientId: filters.clientId, signal }),
  realtimeTables: ['installment_plans', 'installment_payments'],
  scopeValidator: (f) => {
    const cid = f?.clientId
    if (cid === null || cid === undefined) return 'waiting'
    if (cid === '') return 'empty'
    return 'ok'
  },
  // Plan 01 item 1 will eventually expose `waitForAuthedFetch`. Until
  // it lands, awaitInitialAuth() is "good enough" — the scoped store
  // uses the returned `{ok}` flag only to classify `emptyFromNoAuth`.
  awaitAuth: async () => {
    await awaitInitialAuth()
    return { ok: _gateResolvedVia === 'event' }
  },
})
export function useInstallmentsScoped(filters = {}) {
  const clientId = filters?.clientId
  // The scoped-store hook already handles all three scope states (waiting,
  // empty, ok) internally. `snap.refresh` from createScopedStore is a
  // useCallback-stable reference keyed on the store handle, so we can
  // forward it directly without re-wrapping.
  const snap = _useInstallmentsScopedStore({ clientId })
  return {
    plans: snap.data || [],
    loading: snap.loading,
    isRefreshing: snap.isRefreshing,
    error: snap.error,
    emptyFromNoAuth: snap.emptyFromNoAuth,
    refresh: snap.refresh,
  }
}

export function useAdminUsers() {
  const { data: adminUsers, loading, error } = useCachedStore(_adminUsersStore)
  const refresh = useCallback(() => _adminUsersStore.refresh({ force: true }), [])
  const upsert = useCallback(async (user) => {
    const saved = await db.upsertAdminUser(user)
    _adminUsersStore.scheduleRefresh(250)
    return saved
  }, [])
  const remove = useCallback(async (userId) => {
    await db.deleteAdminUser(userId)
    _adminUsersStore.mutateLocal((prev) => (prev || []).filter((u) => String(u.id) !== String(userId)))
    _adminUsersStore.scheduleRefresh(250)
  }, [])
  return { adminUsers, loading, error: error || null, refresh, upsert, remove }
}

export function useProjectWorkflow(projectId) {
  const id = String(projectId || '').trim()
  const [workflow, setWorkflow] = useState(null)
  const [loading, setLoading] = useState(Boolean(id))
  // RESEARCH 02 §9: updateWorkflow does up to 4 sequential DB writes with
  // no loading signal. UI looked responsive while nothing saved — users
  // double-clicked save and duplicated writes. Surface `saving` so
  // ProjectDetailPage can disable the save button during the round-trip.
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    if (!id) {
      setWorkflow(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const wf = await db.fetchProjectWorkflowConfig(id)
      setWorkflow(wf)
    } catch (e) {
      console.error('fetchProjectWorkflowConfig', e)
      setWorkflow(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // FE2-L4 (13_FRONTEND_DEEP_AUDIT): the previous implementation made THREE
  // round trips per save — fetch-before-merge, write, fetch-after-refresh.
  // We already hold the latest workflow in local `workflow` state, so use it
  // as the merge base. The post-save refetch is replaced by a local
  // optimistic update + projects-bus invalidation; pages that show project
  // summaries will repick the change via the projects store realtime.
  // No realtime channel exists for `project_workflow_settings`, so we ALSO
  // emit `emitInvalidate('projects')` so cards / lists rebuild.
  const updateWorkflow = useCallback(
    async (patch) => {
      if (!id) return
      // Use the in-memory workflow as the base. Fall back to a one-shot fetch
      // ONLY if the component called updateWorkflow before the initial load
      // resolved (rare: programmatic save before render).
      const base = workflow || (await db.fetchProjectWorkflowConfig(id))
      const next = { ...base, ...patch, projectId: id }
      // Optimistic local update — admin pages reflect changes instantly.
      setWorkflow(next)
      setSaving(true)
      try {
        await db.upsertProjectWorkflowSettingsFromShape(id, next)
        if (Object.prototype.hasOwnProperty.call(patch, 'signatureChecklist')) {
          await db.replaceProjectSignatureChecklist(id, next.signatureChecklist || [])
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'commissionRules')) {
          await db.replaceProjectCommissionRules(id, next.commissionRules || [])
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'arabonDefault')) {
          await db.updateProjectArabonDefault(id, next.arabonDefault)
        }
        // Tell the projects store its data may be stale. We don't refresh
        // the workflow itself — the optimistic state is now the truth and
        // would only be overwritten by a future explicit refresh().
        emitInvalidate('projects')
      } catch (e) {
        // Roll back the optimistic update so the UI reflects the rejection.
        setWorkflow(base)
        throw e
      } finally {
        setSaving(false)
      }
    },
    [id, workflow],
  )

  return { workflow, updateWorkflow, loading, saving, refresh }
}

export function useWorkspaceAudit() {
  const [audit, setAudit] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await db.fetchAuditLog(8000)
      setAudit(rows)
    } catch (e) {
      console.error('fetchAuditLog', e)
      setError(e instanceof Error ? e : new Error(String(e?.message || e)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const rows = await db.fetchAuditLog(8000)
        if (!cancelled) setAudit(rows)
      } catch (e) {
        console.error('fetchAuditLog', e)
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e?.message || e)))
      } finally {
        setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-audit-logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_logs' }, () => refresh())
      .subscribe(observeChannel('realtime-audit-logs'))
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const append = useCallback(
    async (entry) => {
      try {
        await db.appendAuditEntry({
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId != null ? String(entry.entityId) : '',
          details: entry.details || '',
          metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {},
          actorUserId: entry.actorUserId || null,
          user: entry.actorEmail || entry.user || '',
          actorEmail: entry.actorEmail || entry.user || '',
          subjectUserId: entry.subjectUserId || null,
          severity: entry.severity || 'info',
          category: entry.category || 'business',
          source: entry.source || 'admin_ui',
        })
        await refresh()
      } catch (e) {
        console.error('appendAuditEntry', e)
      }
    },
    [refresh],
  )

  return { audit, append, loading, error, refresh }
}

export function useAccessGrants() {
  const [accessGrants, setAccessGrants] = useState([])
  const [grantAuditLog, setGrantAuditLog] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, auditRows] = await Promise.all([
        db.fetchActivePageAccessGrants(),
        db.fetchPageAccessGrantsAudit(500),
      ])
      setAccessGrants(Array.isArray(rows) ? rows : [])
      const sorted = [...(Array.isArray(auditRows) ? auditRows : [])].sort(
        (a, b) => String(b.grantedAt || '').localeCompare(String(a.grantedAt || '')),
      )
      setGrantAuditLog(sorted)
    } catch (e) {
      console.error('fetchActivePageAccessGrants', e)
      setAccessGrants([])
      setGrantAuditLog([])
    } finally {
      setLoading(false)
    }
  }, [])

  // PLAN 02 §10 — initial `refresh()` previously fired without a
  // `cancelled` guard. On rapid unmount (route change mid-fetch), the
  // `setAccessGrants(...)` calls inside `refresh` fired on an unmounted
  // component. Track a cancelled flag and gate the refresh call through
  // it. The realtime handler also consults `cancelled` so a late event
  // doesn't trigger setState after unmount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (cancelled) return
      try { await refresh() } catch { /* swallowed in refresh */ }
    })()
    const channel = supabase
      .channel('page-access-grants')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'page_access_grants' }, () => {
        if (!cancelled) void refresh()
      })
      .subscribe(observeChannel('page-access-grants'))
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const grant = useCallback(
    async (clientId, pageKey, sourceSaleId, checklistKey, actorUserId) => {
      await db.grantPageAccessLive({ clientId, pageKey, sourceSaleId, sourceChecklistKey: checklistKey, actorUserId })
      await refresh()
    },
    [refresh],
  )

  const revoke = useCallback(
    async (grantId, actorUserId) => {
      try {
        return await db.revokePageAccessGrant(grantId, actorUserId)
      } catch (e) {
        console.error(e)
        return { ok: false }
      } finally {
        await refresh()
      }
    },
    [refresh],
  )

  return { accessGrants, grantAuditLog, grant, revoke, loading, refresh }
}

function useCommissionWorkspace() {
  const [commissionEvents, setCommissionEvents] = useState([])
  const [payoutRequests, setPayoutRequests] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [ev, pr] = await Promise.all([db.fetchCommissionEvents(), db.fetchCommissionPayoutRequestsWithItems()])
      setCommissionEvents(ev)
      setPayoutRequests(pr)
    } catch (e) {
      console.error('commissionWorkspace', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [ev, pr] = await Promise.all([db.fetchCommissionEvents(), db.fetchCommissionPayoutRequestsWithItems()])
        if (!cancelled) {
          setCommissionEvents(ev)
          setPayoutRequests(pr)
        }
      } catch (e) {
        console.error('commissionWorkspace', e)
      } finally {
        setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-commission-workspace')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_events' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_payout_requests' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_payout_request_items' }, () => void refresh())
      .subscribe(observeChannel('realtime-commission-workspace'))
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const submitPayoutRequest = useCallback(
    async (beneficiaryClientId, actorUserId) => {
      try {
        const r = await db.submitCommissionPayoutRequest(beneficiaryClientId, actorUserId)
        await refresh()
        return r
      } catch (e) {
        console.error('submitCommissionPayoutRequest', e)
        return { ok: false, reason: 'error' }
      }
    },
    [refresh],
  )

  const reviewPayoutRequest = useCallback(
    async (requestId, decision, opts) => {
      try {
        const r = await db.reviewCommissionPayoutRequest(requestId, decision, opts)
        await refresh()
        return r
      } catch (e) {
        console.error('reviewCommissionPayoutRequest', e)
        return { ok: false, reason: 'error' }
      }
    },
    [refresh],
  )

  return { commissionEvents, payoutRequests, loading, refresh, submitPayoutRequest, reviewPayoutRequest }
}

export function useSellerRelations() {
  const [sellerRelations, setSellerRelations] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await db.fetchSellerRelations()
      setSellerRelations(rows)
    } catch (e) {
      console.error('sellerRelations', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchSellerRelations()
        if (!cancelled) setSellerRelations(rows)
      } catch (e) {
        console.error('sellerRelations', e)
      } finally {
        setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-seller-relations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seller_relations' }, () => void refresh())
      .subscribe(observeChannel('realtime-seller-relations'))
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const tryLink = useCallback(
    async (childClientId, parentClientId, sourceSaleId) => {
      try {
        const r = await db.upsertSellerRelation({ childClientId, parentClientId, sourceSaleId })
        await refresh()
        return r
      } catch (e) {
        console.error('upsertSellerRelation', e)
        return { ok: false, reason: 'error' }
      }
    },
    [refresh],
  )

  return { sellerRelations, tryLink, loading, refresh }
}

export function useCommissionData() {
  const { commissionEvents, payoutRequests, loading, refresh } = useCommissionWorkspace()
  return { commissionEvents, payoutRequests, loading, refresh }
}

export function useCommissionLedger() {
  const { commissionEvents, payoutRequests, loading, refresh, submitPayoutRequest, reviewPayoutRequest } =
    useCommissionWorkspace()
  return { commissionEvents, payoutRequests, loading, refresh, submitPayoutRequest, reviewPayoutRequest }
}

export function useMySellerParcelAssignments(enabled = true) {
  const [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(() => Boolean(enabled))

  const refresh = useCallback(async () => {
    if (!enabled) {
      setAssignments([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const rows = await db.fetchMySellerParcelAssignments()
      setAssignments(Array.isArray(rows) ? rows : [])
    } catch (e) {
      console.error('fetchMySellerParcelAssignments', e)
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setAssignments([])
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchMySellerParcelAssignments()
        if (!cancelled) setAssignments(Array.isArray(rows) ? rows : [])
      } catch (e) {
        console.error('fetchMySellerParcelAssignments', e)
      } finally {
        setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-seller-parcel-assignments')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seller_parcel_assignments' }, () => refresh())
      .subscribe(observeChannel('realtime-seller-parcel-assignments'))
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh, enabled])

  return { assignments: enabled ? assignments : [], loading: enabled ? loading : false, refresh }
}

/**
 * Aggregated ambassador/parrainage KPIs fetched from the DB RPC
 * `get_my_referral_summary` and kept fresh via realtime subscriptions on
 * `commission_events`, `commission_payout_requests`, and `seller_relations`.
 *
 * @param {boolean} enabled Gate the fetch/subscriptions (e.g. skip while the
 *                          buyer's clientProfile is still resolving).
 */
export function useAmbassadorReferralSummary(enabled = true) {
  const [summary, setSummary] = useState({
    ok: false,
    gainsAccrued: 0,
    commissionsReleased: 0,
    walletBalance: 0,
    minPayoutAmount: 0,
    fieldDepositMin: 0,
    fullDepositTarget: 0,
    referralGross: 0,
    referralGrossPerLevel: 0,
    parrainageMaxDepth: 0,
    rsRatePct: 0,
    levelGrossRules: [],
    reason: 'pending',
    errorMessage: null,
    identityVerificationBlocked: false,
  })
  const [loading, setLoading] = useState(Boolean(enabled))
  const inflightRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const seq = ++inflightRef.current
    setLoading(true)
    try {
      const next = await withTimeout(
        () => db.fetchAmbassadorReferralSummary(),
        DEFAULT_FETCH_TIMEOUT_MS,
        'fetchAmbassadorReferralSummary',
      )
      // Drop stale responses (e.g. enabled toggled, user logged out mid-fetch).
      if (seq !== inflightRef.current) return
      setSummary(next)
    } catch (e) {
      if (seq !== inflightRef.current) return
      setSummary((prev) => ({ ...prev, ok: false, reason: 'rpc_error', errorMessage: String(e?.message || e) }))
    } finally {
      if (seq === inflightRef.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setSummary((prev) => ({ ...prev, reason: 'not_enabled' }))
      return
    }
    let cancelled = false
    // Belt-and-braces watchdog — withTimeout() already races the RPC
    // against DEFAULT_FETCH_TIMEOUT_MS, but if that timeout mechanism
    // itself misbehaves (auth-gate wait, unhandled rejection in the
    // factory, etc.) the `finally` never runs and the dashboard's
    // Parrainage section pins on skeleton. This hard floor guarantees
    // loading clears after 9 s no matter what.
    const hardFloor = window.setTimeout(() => {
      if (!cancelled) {
        setLoading(false)
      }
    }, DEFAULT_FETCH_TIMEOUT_MS + 1000)
    ;(async () => {
      try {
        const next = await withTimeout(
          () => db.fetchAmbassadorReferralSummary(),
          DEFAULT_FETCH_TIMEOUT_MS,
          'fetchAmbassadorReferralSummary',
        )
        if (!cancelled) setSummary(next)
      } catch (e) {
        if (!cancelled) setSummary((prev) => ({ ...prev, ok: false, reason: 'rpc_error', errorMessage: String(e?.message || e) }))
      } finally {
        setLoading(false)
      }
    })()

    const channel = supabase
      .channel('realtime-ambassador-referral')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_events' }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_payout_requests' }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seller_relations' }, () => refresh())
      .subscribe(observeChannel('realtime-ambassador-referral'))

    return () => {
      cancelled = true
      window.clearTimeout(hardFloor)
      supabase.removeChannel(channel)
    }
  }, [enabled, refresh])

  return { summary, loading, refresh }
}

/**
 * Detailed commission ledger for the signed-in client: one enriched row per
 * commission_events row where they are the beneficiary. Used by the Parrainage
 * tab to show WHERE each DT comes from (which sale, which filleul, L1 vs L2+).
 */
export function useMyCommissionLedger(optsOrLegacy = null) {
  // PLAN 02 §14 — canonical signature is `{ clientId, enabled }`.
  // The legacy boolean (`useMyCommissionLedger(true)`) and plain-string
  // (`useMyCommissionLedger('abc-123')`) forms are accepted for
  // back-compat but warned in dev. `Boolean('')` happens to equal
  // `false` in JS, which meant the string form silently disabled itself
  // on empty input — a footgun we remove by normalising up front.
  let explicitId = null
  let enabled = true
  if (optsOrLegacy === null || optsOrLegacy === undefined) {
    enabled = true
  } else if (typeof optsOrLegacy === 'boolean') {
    if (
      typeof import.meta !== 'undefined' &&
      import.meta.env?.DEV
    ) {
      console.warn(
        '[useMyCommissionLedger] boolean argument is deprecated; pass {clientId, enabled} instead',
      )
    }
    enabled = optsOrLegacy
  } else if (typeof optsOrLegacy === 'string') {
    if (
      typeof import.meta !== 'undefined' &&
      import.meta.env?.DEV
    ) {
      console.warn(
        '[useMyCommissionLedger] plain-string argument is deprecated; pass {clientId} instead',
      )
    }
    explicitId = optsOrLegacy
    enabled = Boolean(optsOrLegacy)
  } else if (typeof optsOrLegacy === 'object') {
    explicitId = typeof optsOrLegacy.clientId === 'string' ? optsOrLegacy.clientId : null
    enabled = optsOrLegacy.enabled !== undefined ? Boolean(optsOrLegacy.enabled) : Boolean(explicitId)
  }
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(Boolean(enabled))
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setEvents([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const rows = await withTimeout(() => db.fetchMyCommissionLedger(explicitId), DEFAULT_FETCH_TIMEOUT_MS, 'fetchMyCommissionLedger')
      setEvents(rows || [])
    } catch (e) {
      console.warn('[useMyCommissionLedger]', e?.message || e)
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [enabled, explicitId])

  useEffect(() => {
    if (!enabled) { setLoading(false); return }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await withTimeout(() => db.fetchMyCommissionLedger(explicitId), DEFAULT_FETCH_TIMEOUT_MS, 'fetchMyCommissionLedger')
        if (!cancelled) setEvents(rows || [])
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e))
      } finally {
        setLoading(false)
      }
    })()
    const filter = explicitId ? `beneficiary_client_id=eq.${explicitId}` : undefined
    const channel = supabase
      .channel(`realtime-my-commission-ledger-${explicitId || 'self'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_events', ...(filter ? { filter } : {}) }, () => refresh())
      .subscribe(observeChannel(`realtime-my-commission-ledger-${explicitId || 'self'}`))
    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [enabled, explicitId, refresh])

  return { events, loading, error, refresh }
}
