// src/lib/useStoreStatus.js
//
// Plan 02 item 12 — a shared primitive for components that want uniform
// loading / refreshing / error / retry UI glue. Works with both the legacy
// `createCachedStore` handles from useSupabase.js AND the new
// `createScopedStore` instances, since both expose the same
// `{getState, subscribe, refresh}` surface.
//
// Typical consumer:
//
//   function SalesPage() {
//     const { data, loading, isRefreshing, error, canRetry, retry } =
//       useStoreStatus(_salesStore)
//     if (loading && !data.length) return <Skeleton />
//     if (error && !data.length) return <ErrorBanner onRetry={retry} />
//     return (
//       <>
//         {isRefreshing && <TopBarIndicator />}
//         <SalesList rows={data} />
//       </>
//     )
//   }

import { useCallback, useEffect, useState } from 'react'

/**
 * @typedef {Object} StoreHandle
 * @property {() => any} getState
 * @property {(fn: (state: any) => void) => () => void} subscribe
 * @property {(opts?: {force?: boolean, background?: boolean}) => Promise<any>} refresh
 */

/**
 * @typedef {Object} StoreStatus
 * @property {any}          data
 * @property {boolean}      loading          initial load in progress.
 * @property {boolean}      isRefreshing     background refresh in progress.
 * @property {Error|null}   error
 * @property {number}       lastFetchedAt    ms epoch of last success (or 0).
 * @property {number}       lastAttemptAt    ms epoch of last attempt (or 0).
 * @property {boolean}      canRetry         truthy when a retry button makes
 *                                           sense (error OR emptyFromNoAuth).
 * @property {() => Promise<any>} retry      force-refresh the store.
 */

/**
 * Subscribe to any store handle and surface a uniform status shape.
 *
 * @param {StoreHandle | null | undefined} store
 * @returns {StoreStatus}
 */
export function useStoreStatus(store) {
  const [snap, setSnap] = useState(() => (store ? safeGetState(store) : EMPTY_SNAPSHOT))

  useEffect(() => {
    if (!store) return undefined
    // Both createCachedStore and createScopedStore hand the current snapshot
    // to a brand-new listener synchronously, so a fresh subscribe will
    // re-sync state without an explicit setSnap() here.
    return store.subscribe(setSnap)
  }, [store])

  const retry = useCallback(() => {
    if (!store) return Promise.resolve()
    return store.refresh({ force: true })
  }, [store])

  return {
    data: snap.data,
    loading: Boolean(snap.loading),
    isRefreshing: Boolean(snap.isRefreshing),
    error: snap.error || null,
    lastFetchedAt: Number(snap.loadedAt || 0),
    lastAttemptAt: Number(snap.lastAttemptAt || 0),
    canRetry: Boolean(snap.error) || Boolean(snap.emptyFromNoAuth),
    retry,
  }
}

const EMPTY_SNAPSHOT = Object.freeze({
  data: null,
  loading: false,
  isRefreshing: false,
  error: null,
  loadedAt: 0,
  lastAttemptAt: 0,
  emptyFromNoAuth: false,
})

function safeGetState(store) {
  try { return store.getState() || EMPTY_SNAPSHOT } catch { return EMPTY_SNAPSHOT }
}
