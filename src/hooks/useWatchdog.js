import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Surface a "slow load" affordance when a loading state persists longer
 * than `ms` milliseconds. Plan 03 §3.3 — component-level safety net that
 * complements the per-store watchdog in plan 02.
 *
 * Accepts either:
 *   - A status object shaped like `{ state: 'idle'|'loading'|'ready'|'error' }`
 *     (preferred, from `useStoreStatus`), or
 *   - A plain boolean `loading` flag (convenience for pages not yet migrated).
 *
 * Returns `{ stuck, reset }`:
 *   - `stuck === true` once loading has continued past `ms` without a
 *     ready/error transition. The returned value is automatically gated
 *     by the current loading state, so the banner disappears as soon as
 *     the status leaves loading/idle — without triggering cascading renders.
 *   - `reset()` forces the internal "was stuck" marker back to false and
 *     clears any pending timer. Use right after firing a manual retry so
 *     the banner doesn't linger through the next loading cycle.
 *
 * @param {{ state?: string } | boolean} status
 * @param {number} [ms=8000]
 * @returns {{ stuck: boolean, reset: () => void }}
 */
export function useWatchdog(status, ms = 8000) {
  const [wasStuck, setWasStuck] = useState(false)
  const timerRef = useRef(0)
  const resetTokenRef = useRef(0)

  const isLoading =
    typeof status === 'boolean'
      ? status
      : status && (status.state === 'loading' || status.state === 'idle')

  useEffect(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = 0
    }
    if (!isLoading) {
      return undefined
    }
    const token = resetTokenRef.current
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0
      // Ignore the firing if reset() was called in-between.
      if (resetTokenRef.current !== token) return
      setWasStuck(true)
    }, Math.max(0, ms))
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
        timerRef.current = 0
      }
    }
  }, [isLoading, ms])

  const reset = useCallback(() => {
    resetTokenRef.current += 1
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = 0
    }
    setWasStuck(false)
  }, [])

  // Only expose "stuck" while actually loading; the moment the status
  // leaves loading/idle the derived value is false, without needing an
  // in-effect setState dance.
  const stuck = Boolean(isLoading && wasStuck)

  return { stuck, reset }
}

export default useWatchdog
