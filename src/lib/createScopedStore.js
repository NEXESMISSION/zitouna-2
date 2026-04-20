// src/lib/createScopedStore.js
//
// Plan 02 item 4 — the single factory that will replace eight bespoke
// scoped hooks in useSupabase.js during Phase 2. A scoped store is keyed by
// arbitrary filter params (e.g. `{clientId}`), maintains one store instance
// per filter key, and shares state across every component that subscribes
// with the same filters. Internally it reuses the lessons learned from
// `createCachedStore`:
//
//   - Module-scope cache per filterKey — navigating away and back is instant.
//   - Single inflight promise per store — a refresh during a pending fetch
//     does not duplicate work.
//   - Monotonic fetch generation + AbortController so `reset()` mid-fetch
//     cancels the pending request instead of letting it publish stale data.
//   - `safeSubscribe` wraps every realtime channel; no more silent
//     `CHANNEL_ERROR` black holes.
//   - `retryWithBackoff` on any transient error (network, 5xx, stale JWT).
//   - `emptyFromNoAuth` flag so the top-level revive logic can distinguish
//     "fetched without a JWT and got []" from "fetched with a session and
//     genuinely had zero rows". Plan 02 item 7.
//   - `isRefreshing` flag so consumers can render a subtle indicator during
//     manual refresh instead of reverting to a skeleton. Plan 02 item 6.
//   - `scopeValidator` contract lets callers express three states:
//        'ok'      — filters are valid, fire a fetch
//        'waiting' — filters not ready yet (e.g. clientId=null because
//                    AuthContext is still resolving). Return loading=true,
//                    ready=false, data=[]. No fetch.
//        'empty'   — filters explicitly say "no rows possible". Return
//                    loading=false, ready=true, data=[]. No fetch.
//
// Public API of the hook produced by this factory matches `useStoreStatus`:
//   { data, loading, isRefreshing, ready, error,
//     lastFetchedAt, lastAttemptAt, refresh, retry,
//     mutateLocal, scheduleRefresh, emptyFromNoAuth }
//
// Mutation helpers (create / update / delete) are *not* attached here; the
// caller (Phase 2 migration in useSupabase.js) will wire them on top as thin
// wrappers that call db.*, then invoke the returned hook's `.scheduleRefresh`
// / `emitInvalidate` primitives.

import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase.js'
import { retryWithBackoff } from './retryWithBackoff.js'
import { safeSubscribe } from './safeSubscribe.js'

const DEFAULT_FETCH_TIMEOUT_MS = 12000
const DEFAULT_STALE_MS = 15_000

// Module-scope registry so reset handlers / watchdog / reviveStale in
// useSupabase.js can find every scoped store instance the same way they
// find `createCachedStore` instances today. Phase 2 will wire this up.
const _scopedStoreRegistry = new Set()
const _scopedResetHandlers = new Set()

/**
 * @returns {ReadonlySet<ScopedStoreInstance>} registry of every live scoped
 *   store instance. Phase 2 will iterate this from the watchdog and
 *   reviveStale logic in useSupabase.js.
 */
export function getScopedStoreRegistry() {
  return _scopedStoreRegistry
}

/**
 * @returns {ReadonlySet<() => void>} reset handlers, one per scoped store
 *   factory. Phase 2 will invoke all of these on user-switch / SIGNED_OUT.
 */
export function getScopedResetHandlers() {
  return _scopedResetHandlers
}

/**
 * @typedef {Object} ScopedStoreSnapshot
 * @property {any[]|object} data
 * @property {boolean} loading          true on initial load only.
 * @property {boolean} isRefreshing     true on background refresh when data
 *                                      is already present.
 * @property {Error|null} error
 * @property {number} loadedAt          ms epoch of last successful load.
 * @property {number} lastAttemptAt     ms epoch of last attempt (success
 *                                      or failure).
 * @property {boolean} emptyFromNoAuth  true when the most recent fetch
 *                                      resolved to [] without an authed
 *                                      session; reviveStale watches this.
 */

/**
 * @typedef {Object} ScopedStoreInstance
 * @property {string} key
 * @property {() => ScopedStoreSnapshot} getState
 * @property {(fn: (state: ScopedStoreSnapshot) => void) => () => void} subscribe
 * @property {(opts?: {force?: boolean, background?: boolean}) => Promise<any>} refresh
 * @property {(ms?: number) => void} scheduleRefresh
 * @property {(fn: (data: any) => any) => void} mutateLocal
 * @property {() => void} reset
 * @property {number} _loadingStartedAt  watchdog bookkeeping field.
 */

/**
 * @typedef {'ok' | 'waiting' | 'empty'} ScopeState
 */

/**
 * @typedef {Object} CreateScopedStoreArgs
 * @property {string} key
 *   Logical store name (e.g. `'sales-scoped'`, `'installments-scoped'`).
 *   Used as the prefix for the per-filter cache key and realtime channel
 *   name.
 * @property {(filters: object, ctx: {signal: AbortSignal}) => Promise<any>} fetcher
 *   Called with the filter object and an AbortSignal. Must return the
 *   resolved data shape (array or object — opaque to the store).
 * @property {string[]} [realtimeTables=[]]
 *   Tables whose `postgres_changes` events should trigger a debounced
 *   refresh. Passed straight to `safeSubscribe`.
 * @property {(filters: object) => string} [filterKeyFn]
 *   Serialise a filter object to a stable cache key. Default sorts keys
 *   and drops null/undefined/'' values.
 * @property {(filters: object) => ScopeState} [scopeValidator]
 *   Decide whether the filter set is ready to fetch. Default: always 'ok'.
 * @property {any} [initial=[]]       Initial data snapshot before first load.
 * @property {number} [staleMs=15000] Window during which `refresh()` is a
 *   no-op unless `{force:true}`.
 * @property {number} [timeoutMs=12000] Per-attempt timeout.
 * @property {number} [maxAttempts=3]   Retry attempts including first.
 * @property {() => Promise<{ok: boolean}>} [awaitAuth]
 *   Optional auth gate. Phase 2 will pass `awaitInitialAuth` (or the
 *   upgraded `waitForAuthedFetch` from plan 01). Used only to decide
 *   `emptyFromNoAuth` when the fetch returns an empty array — no fetch is
 *   blocked if this is omitted.
 */

/**
 * Build a scoped store hook. See module docstring for the full behaviour.
 *
 * @param {CreateScopedStoreArgs} args
 * @returns {(filters?: object) => {
 *   data: any,
 *   loading: boolean,
 *   isRefreshing: boolean,
 *   ready: boolean,
 *   error: Error|null,
 *   lastFetchedAt: number,
 *   lastAttemptAt: number,
 *   emptyFromNoAuth: boolean,
 *   refresh: (opts?: {force?: boolean, background?: boolean}) => Promise<any>,
 *   retry: () => Promise<any>,
 *   mutateLocal: (fn: (data: any) => any) => void,
 *   scheduleRefresh: (ms?: number) => void,
 *   _store: ScopedStoreInstance | null,
 * }}
 */
export function createScopedStore({
  key,
  fetcher,
  realtimeTables = [],
  filterKeyFn = defaultFilterKeyFn,
  scopeValidator = null,
  initial = [],
  staleMs = DEFAULT_STALE_MS,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxAttempts = 3,
  awaitAuth = null,
} = {}) {
  if (!key) throw new Error('createScopedStore: key is required')
  if (typeof fetcher !== 'function') throw new Error('createScopedStore: fetcher must be a function')

  /** @type {Map<string, ScopedStoreInstance>} */
  const stores = new Map()

  function getStore(filters) {
    const fk = filterKeyFn(filters)
    let s = stores.get(fk)
    if (!s) {
      s = buildStoreInstance({
        key: `${key}:${fk}`,
        filters,
        fetcher,
        realtimeTables,
        initial,
        staleMs,
        timeoutMs,
        maxAttempts,
        awaitAuth,
      })
      stores.set(fk, s)
      _scopedStoreRegistry.add(s)
    }
    return s
  }

  // Bulk-reset handler: Phase 2 plugs this into the user-switch path so
  // every scoped store instance (across all filter keys) gets purged when
  // the active user changes.
  const resetAll = (opts) => {
    for (const s of stores.values()) {
      try { s.reset(opts) } catch { /* ignore */ }
    }
  }
  _scopedResetHandlers.add(resetAll)

  // Stable hook identity. `useCallback`-safe by reference.
  function useScoped(filters = {}) {
    const scopeState = scopeValidator ? scopeValidator(filters) : 'ok'

    // All hooks must run unconditionally for `react-hooks/rules-of-hooks`.
    // We fetch the store only when scope is 'ok'; other states reuse the
    // shared null-store sentinel so no store is lazily instantiated for
    // filter sets the caller didn't actually want to fetch against.
    const store = scopeState === 'ok' ? getStore(filters) : null
    const [snap, setSnap] = useState(() => (store ? store.getState() : null))

    useEffect(() => {
      if (!store) return undefined
      return store.subscribe(setSnap)
    }, [store])

    const refresh = useCallback(
      (opts = {}) => (store ? store.refresh({ force: true, ...opts }) : Promise.resolve()),
      [store],
    )
    const retry = useCallback(
      () => (store ? store.refresh({ force: true }) : Promise.resolve()),
      [store],
    )
    const mutateLocal = useCallback(
      (fn) => { if (store) store.mutateLocal(fn) },
      [store],
    )
    const scheduleRefresh = useCallback(
      (ms) => { if (store) store.scheduleRefresh(ms) },
      [store],
    )

    if (scopeState === 'empty') {
      return {
        data: emptyOf(initial),
        loading: false,
        isRefreshing: false,
        ready: true,
        error: null,
        lastFetchedAt: 0,
        lastAttemptAt: 0,
        emptyFromNoAuth: false,
        refresh,
        retry,
        mutateLocal,
        scheduleRefresh,
        _store: null,
      }
    }
    if (scopeState === 'waiting') {
      return {
        data: emptyOf(initial),
        loading: true,
        isRefreshing: false,
        ready: false,
        error: null,
        lastFetchedAt: 0,
        lastAttemptAt: 0,
        emptyFromNoAuth: false,
        refresh,
        retry,
        mutateLocal,
        scheduleRefresh,
        _store: null,
      }
    }

    const current = snap || (store ? store.getState() : null)
    return {
      data: current ? current.data : emptyOf(initial),
      loading: current ? current.loading : true,
      isRefreshing: current ? Boolean(current.isRefreshing) : false,
      ready: current ? (current.loadedAt > 0 || current.error !== null) : false,
      error: current ? current.error : null,
      lastFetchedAt: current ? current.loadedAt : 0,
      lastAttemptAt: current ? (current.lastAttemptAt || 0) : 0,
      emptyFromNoAuth: Boolean(current && current.emptyFromNoAuth),
      refresh,
      retry,
      mutateLocal,
      scheduleRefresh,
      _store: store,
    }
  }

  // Expose the low-level pieces for advanced callers (e.g. the Phase 2
  // migration that wants to bulk-refresh or reset across filter keys).
  useScoped.getStoreFor = (filters) => getStore(filters)
  useScoped.resetAll = resetAll
  useScoped.storeKey = key

  return useScoped
}

// ----------------------------------------------------------------------------
// Internal: per-filter store instance.
// ----------------------------------------------------------------------------

function buildStoreInstance({
  key,
  filters,
  fetcher,
  realtimeTables,
  initial,
  staleMs,
  timeoutMs,
  maxAttempts,
  awaitAuth,
}) {
  /** @type {ScopedStoreSnapshot} */
  let state = {
    data: emptyOf(initial),
    loading: true,
    isRefreshing: false,
    loadedAt: 0,
    lastAttemptAt: 0,
    error: null,
    emptyFromNoAuth: false,
  }
  const listeners = new Set()
  let inflight = null
  let unsubscribeChannel = null
  let refreshTimer = null
  let subCount = 0
  let fetchGen = 0
  let channelTeardownTimer = null

  function publish(patch) {
    state = { ...state, ...patch }
    for (const fn of listeners) {
      try { fn(state) } catch (e) {
        console.error(`[scoped:${key}] listener`, e)
      }
    }
  }

  async function doFetch() {
    if (inflight) return inflight
    const myGen = fetchGen

    const run = async () => {
      try {
        // Resolve the auth gate (if any) up-front so we can classify the
        // outcome as emptyFromNoAuth when the caller is still anonymous.
        let authOk = true
        if (awaitAuth) {
          try {
            const res = await awaitAuth()
            authOk = Boolean(res && res.ok)
          } catch { authOk = false }
          if (myGen !== fetchGen) return
        }

        const data = await retryWithBackoff(
          (signal) => fetcher(filters, { signal }),
          {
            label: `fetch:${key}`,
            maxAttempts,
            timeoutMs,
            shouldCancel: () => myGen !== fetchGen,
          },
        )
        if (myGen !== fetchGen) return

        const isEmpty = Array.isArray(data) ? data.length === 0 : isEmptyObjectPayload(data)
        publish({
          data,
          loading: false,
          isRefreshing: false,
          loadedAt: Date.now(),
          lastAttemptAt: Date.now(),
          error: null,
          emptyFromNoAuth: isEmpty && authOk !== true,
        })
      } catch (e) {
        if (myGen !== fetchGen) return
        console.error(`[scoped:${key}]`, e)
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
    promise.finally(() => { if (inflight === promise) inflight = null })
    return promise
  }

  function scheduleRefresh(ms = 350) {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      doFetch()
    }, ms)
  }

  async function refresh({ force = false, background = false } = {}) {
    const fresh = state.loadedAt && Date.now() - state.loadedAt < staleMs
    if (!force && fresh) return state.data
    if (!background && !state.loadedAt) {
      publish({ loading: true, isRefreshing: false })
    } else {
      publish({ isRefreshing: true })
    }
    await doFetch()
    return state.data
  }

  function mutateLocal(fn) {
    const next = fn(state.data)
    if (next !== state.data) publish({ data: next })
  }

  function setupChannel() {
    if (channelTeardownTimer) {
      clearTimeout(channelTeardownTimer)
      channelTeardownTimer = null
    }
    if (unsubscribeChannel || realtimeTables.length === 0) return
    unsubscribeChannel = safeSubscribe({
      channelName: `scoped:${key}`,
      attach: (ch) => {
        for (const table of realtimeTables) {
          ch.on(
            'postgres_changes',
            { event: '*', schema: 'public', table },
            () => scheduleRefresh(500),
          )
        }
      },
      onStatusChange: (status) => {
        // When realtime is confirmed degraded, kick a refresh so consumers
        // pick up whatever changes happened while the channel was down.
        if (status === 'degraded') scheduleRefresh(1000)
      },
    })
  }

  function teardownChannel() {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (!unsubscribeChannel) return
    if (channelTeardownTimer) clearTimeout(channelTeardownTimer)
    channelTeardownTimer = setTimeout(() => {
      channelTeardownTimer = null
      if (subCount > 0) return
      try { unsubscribeChannel() } catch { /* ignore */ }
      unsubscribeChannel = null
    }, 100)
  }

  function subscribe(fn) {
    listeners.add(fn)
    subCount += 1
    if (subCount === 1) setupChannel()
    if (!state.loadedAt && !inflight) refresh().catch(() => {})
    try { fn(state) } catch { /* ignore */ }
    return () => {
      listeners.delete(fn)
      subCount -= 1
      if (subCount === 0) teardownChannel()
    }
  }

  function reset({ refetch = true } = {}) {
    fetchGen += 1
    state = {
      data: emptyOf(initial),
      loading: true,
      isRefreshing: false,
      loadedAt: 0,
      lastAttemptAt: 0,
      error: null,
      emptyFromNoAuth: false,
    }
    inflight = null
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
    for (const fn of listeners) { try { fn(state) } catch { /* ignore */ } }
    // Same rationale as createCachedStore: on SIGNED_OUT the caller passes
    // `refetch: false` so we don't fire RLS-denied requests right as the
    // admin page unmounts on its way to /login.
    if (refetch && subCount > 0) doFetch().catch(() => {})
  }

  const handle = /** @type {ScopedStoreInstance} */ ({
    key,
    getState: () => state,
    subscribe,
    refresh,
    scheduleRefresh,
    mutateLocal,
    reset,
    _loadingStartedAt: 0,
  })
  return handle
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Default filter-key serialiser. Drops null/undefined/empty-string values
 * so `{clientId: null}` and `{}` hash the same way.
 *
 * @param {object|null|undefined} filters
 * @returns {string}
 */
export function defaultFilterKeyFn(filters) {
  const entries = Object.entries(filters || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
  entries.sort(([a], [b]) => a.localeCompare(b))
  return entries.length === 0 ? '_' : JSON.stringify(entries)
}

function emptyOf(initial) {
  if (Array.isArray(initial)) return []
  if (initial && typeof initial === 'object') {
    // Preserve the shape (e.g. `{grants: [], auditLog: []}`) so consumers
    // that destructure specific keys don't crash on first render.
    const out = {}
    for (const k of Object.keys(initial)) {
      out[k] = Array.isArray(initial[k]) ? [] : initial[k]
    }
    return out
  }
  return initial
}

function isEmptyObjectPayload(data) {
  if (data == null) return true
  if (typeof data !== 'object') return false
  // Object-shaped stores (e.g. `{grants, auditLog}`) count as empty when
  // every enumerable value is an empty array. Non-array values short-circuit
  // to "not empty" because we can't reason about them generically.
  const vals = Object.values(data)
  if (vals.length === 0) return true
  return vals.every((v) => Array.isArray(v) && v.length === 0)
}

// Supabase client re-export so Phase 2 callers can access the same instance
// without an additional import round-trip. Not strictly required today; kept
// here to match the pattern used by createCachedStore in useSupabase.js.
export { supabase }
