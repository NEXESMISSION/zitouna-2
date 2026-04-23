import { useCallback, useEffect, useRef, useState } from 'react'
import * as db from '../../lib/db.js'

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
  })
}

/**
 * Admin-only hook that loads all data needed by the commission tracker page
 * in a single round-trip. No realtime subscriptions — the dataset is reviewed
 * manually and changes rarely, so explicit `refresh()` is preferred.
 *
 * @returns {{
 *   data: {
 *     commissionEvents: Array,
 *     clients: Array,
 *     sellerRelations: Array,
 *     sales: Array,
 *   },
 *   loading: boolean,
 *   error: Error | null,
 *   refresh: () => Promise<void>,
 * }}
 */
export function useCommissionTracker() {
  const [data, setData] = useState({
    commissionEvents: [],
    clients: [],
    sellerRelations: [],
    sales: [],
    reverseGrants: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const inflightRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++inflightRef.current
    setLoading(true)
    setError(null)
    try {
      const next = await withTimeout(db.fetchCommissionTrackerData(), 30_000, 'fetchCommissionTrackerData')
      if (seq !== inflightRef.current) return
      setData({
        commissionEvents: next?.commissionEvents || [],
        clients: next?.clients || [],
        sellerRelations: next?.sellerRelations || [],
        sales: next?.sales || [],
        reverseGrants: next?.reverseGrants || [],
      })
    } catch (e) {
      if (seq !== inflightRef.current) return
      console.error('fetchCommissionTrackerData', e)
      setError(e instanceof Error ? e : new Error(String(e?.message || e)))
    } finally {
      if (seq === inflightRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const seq = ++inflightRef.current
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await withTimeout(
          db.fetchCommissionTrackerData(),
          30_000,
          'fetchCommissionTrackerData',
        )
        if (cancelled || seq !== inflightRef.current) return
        setData({
          commissionEvents: next?.commissionEvents || [],
          clients: next?.clients || [],
          sellerRelations: next?.sellerRelations || [],
          sales: next?.sales || [],
          reverseGrants: next?.reverseGrants || [],
        })
      } catch (e) {
        if (cancelled || seq !== inflightRef.current) return
        console.error('fetchCommissionTrackerData', e)
        setError(e instanceof Error ? e : new Error(String(e?.message || e)))
      } finally {
        if (!cancelled && seq === inflightRef.current) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { data, loading, error, refresh }
}
