import { useEffect, useRef, useState } from 'react'
import './pull-to-refresh.css'

/**
 * Native-style pull-to-refresh for the whole app.
 *
 * Why it lives here:
 *   The app already disables the browser's own overscroll refresh via
 *   `overscroll-behavior: none` (pwa-responsive.css). Without a replacement
 *   users have no gesture to force a fresh load on mobile. This component
 *   restores that — but as an app-level gesture that respects the app's
 *   own modals/drawers instead of letting the browser reset the page mid-
 *   workflow.
 *
 * Rules the gesture obeys:
 *   1. Only triggers when `window.scrollY <= 2` — i.e. already at the top.
 *      Otherwise a normal downward finger drag must remain a scroll.
 *   2. Disabled while any AdminDrawer / AdminModal overlay is mounted,
 *      so pulling inside a confirm dialog can't nuke the half-filled form.
 *   3. Requires an 8 px "commit" distance before we start tracking — a tap
 *      or a short tap-scroll never fires the indicator.
 *   4. Threshold to actually refresh is 90 px of pull (after damping), and
 *      the indicator visually snaps to a blue "ready" state at that point
 *      so the user knows release will commit.
 *   5. On release below threshold, the indicator animates back to hidden;
 *      no refresh fires.
 *
 * Implementation notes:
 *   - `touchmove` uses `{ passive: false }` so we can preventDefault the
 *     native bounce once we've committed to a pull. We never preventDefault
 *     scrolls or modal gestures.
 *   - We translate the indicator in JS (no CSS transitions during the drag)
 *     so it tracks the finger 1:1. Release snaps back with a short CSS
 *     transition via the `--returning` class.
 *   - Refresh = `window.location.reload()`. The app's AuthContext + store
 *     cache re-hydrate in a few hundred ms; this is the simplest guarantee
 *     that nothing shows stale.
 */

const START_THRESHOLD = 8     // px finger drag before we claim the gesture
const DAMP = 0.55             // finger distance × this = visible pull
const TRIGGER = 90            // visible pull px that commits a refresh
const MAX_PULL = 140          // visible pull saturates here

function isModalOrDrawerOpen() {
  // Covers both the current .zadm-* components (AdminDrawer / AdminModal)
  // and the legacy .adm-* class variants still present in some pages.
  return Boolean(
    document.querySelector(
      '.zadm-modal-overlay, .zadm-drawer-overlay, .adm-modal-overlay, .adm-drawer-overlay',
    ),
  )
}

export default function PullToRefresh() {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [returning, setReturning] = useState(false)

  // touch-tracking refs — state would trigger a re-render per move.
  const startY = useRef(null)
  const activeId = useRef(null)
  const armed = useRef(false)

  useEffect(() => {
    function reset() {
      startY.current = null
      activeId.current = null
      armed.current = false
    }

    function onTouchStart(e) {
      if (refreshing) return
      if (e.touches.length !== 1) return
      if (window.scrollY > 2) return
      if (isModalOrDrawerOpen()) return
      startY.current = e.touches[0].clientY
      activeId.current = e.touches[0].identifier
      armed.current = false
      if (returning) setReturning(false)
    }

    function onTouchMove(e) {
      if (startY.current == null || refreshing) return
      const t = Array.from(e.touches).find((x) => x.identifier === activeId.current)
      if (!t) return
      const dy = t.clientY - startY.current
      if (dy <= 0) {
        if (pull !== 0) setPull(0)
        return
      }
      if (!armed.current) {
        if (dy < START_THRESHOLD) return
        // Re-verify the page state at the moment of arming — the user may
        // have scrolled further down or opened a modal between touchstart
        // and the first real move.
        if (window.scrollY > 2 || isModalOrDrawerOpen()) {
          reset()
          return
        }
        armed.current = true
      }
      const visible = Math.min(MAX_PULL, dy * DAMP)
      setPull(visible)
      // Stop native bounce / scroll-chaining once we're actively pulling.
      if (e.cancelable) e.preventDefault()
    }

    function onTouchEnd(e) {
      if (startY.current == null) return
      // Make sure this is the end of OUR tracked touch (could fire when a
      // different finger lifts during a multi-touch).
      if (e.changedTouches) {
        const ours = Array.from(e.changedTouches)
          .some((x) => x.identifier === activeId.current)
        if (!ours) return
      }

      const shouldRefresh = armed.current && pull >= TRIGGER
      reset()

      if (shouldRefresh) {
        setRefreshing(true)
        setPull(TRIGGER) // park the spinner at the trigger line
        // Give the spinner 280ms of visible spin before reloading, so the
        // transition feels intentional rather than a flash.
        window.setTimeout(() => {
          window.location.reload()
        }, 280)
        return
      }
      // Snap back to zero with a CSS transition.
      setReturning(true)
      setPull(0)
      window.setTimeout(() => setReturning(false), 220)
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [pull, refreshing, returning])

  const visible = pull > 0 || refreshing
  const progress = Math.min(1, pull / TRIGGER)
  const commit = progress >= 1 || refreshing
  const rotation = refreshing ? 0 : progress * 300

  return (
    <div
      aria-hidden={!visible}
      className={
        'ptr-root'
        + (visible ? ' ptr-root--visible' : '')
        + (returning ? ' ptr-root--returning' : '')
      }
      style={{ transform: `translate3d(-50%, ${pull}px, 0)` }}
    >
      <div className={'ptr-bubble' + (commit ? ' ptr-bubble--ready' : '')}>
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={refreshing ? 'ptr-icon ptr-icon--spin' : 'ptr-icon'}
          style={refreshing ? undefined : { transform: `rotate(${rotation}deg)` }}
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </div>
    </div>
  )
}
