import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../lib/AuthContext.jsx'
import { titleOf, bodyOf, linkOf, severityOf } from '../lib/notifications.js'

// ----------------------------------------------------------------------------
// Listens to the realtime INSERT stream on user_notifications and pops a
// toast for any row with severity in {warning, danger, success}. Mount once
// at the app root (see src/App.jsx). Uses only the auth user → no prop
// drilling required. Self-contained styles live in App.css.
// ----------------------------------------------------------------------------

const TOAST_TTL_MS = 6000
const MAX_VISIBLE = 3
// FE2-M4: cap for the "already seen" id set. 64 is generous — covers a full
// reconnect burst plus noise — and keeps memory bounded even for users who
// leave the tab open for weeks.
const SEEN_CAP = 64
// Skip loud toasts for mundane success events — they still land in the bell.
const SILENT_TYPES = new Set(['commission_earned', 'installment_paid', 'visit_scheduled'])

export default function NotificationToaster() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [toasts, setToasts] = useState([])

  // FE2-M4 (13_FRONTEND_DEEP_AUDIT): the previous implementation kept only
  // the timestamp of the last-seen row. When two notifications have the
  // same `created_at` (common in our commission_events flow where DB
  // triggers fire in the same microsecond), the second was silently dropped.
  // Switch to a FIFO-capped Set of notification IDs. We only drop if the
  // id has genuinely been seen before.
  const seenIdsRef = useRef(new Set())
  const seenOrderRef = useRef([])

  // FE2-H3: the wallclock-based freshness check (Date.now() - created > 10s)
  // silently swallowed every toast if the user's laptop clock drifted by
  // more than 10 seconds (common after sleep/wake, cross-timezone moves).
  // Replace it with a per-subscription "first-render skip-batch":
  // remember the maximum `created_at` in the bell at channel-open time,
  // and skip rows whose created_at is older than or equal to that point.
  // This still filters the Supabase reconnect catch-up burst but never
  // drops legitimately fresh notifications due to clock skew.
  const firstSeenCeilingRef = useRef(null)

  // FE2-H1: gate every realtime delivery against the *current* auth user,
  // not the user id captured in the effect closure. When a logout happens
  // mid-flight (or the auth context re-hydrates a different identity),
  // React may not have re-run this effect yet; the payload handler must
  // verify user_id === userIdRef.current before pushing a toast.
  const userIdRef = useRef(user?.id || null)
  useEffect(() => { userIdRef.current = user?.id || null }, [user?.id])

  // FE2-M2: append a per-mount useId() so two toasters mounted in the
  // same tab (dev hot-reload, Strict Mode) can't collide on channel name.
  const instanceId = useId()

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((n) => {
    if (!n) return
    setToasts((prev) => {
      if (prev.some((t) => t.id === n.id)) return prev
      const next = [...prev, { ...n, _shownAt: Date.now() }]
      return next.slice(-MAX_VISIBLE)
    })
  }, [])

  useEffect(() => {
    if (!user?.id) return undefined
    // Reset the skip-batch ceiling and the seen-id set on every new
    // subscription target (login, user-switch). Without the reset, a
    // second user in the same tab would inherit the first user's ceiling.
    firstSeenCeilingRef.current = null
    seenIdsRef.current = new Set()
    seenOrderRef.current = []

    const channel = supabase
      .channel(`toast:${user.id}:${instanceId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'user_notifications', filter: `user_id=eq.${user.id}` },
        (payload) => {
          const row = payload?.new
          if (!row) return

          // FE2-H1: user might have switched between effect registration
          // and this delivery. Drop if it isn't for the current auth user.
          if (row.user_id !== userIdRef.current) return

          // FE2-H3: initialize the ceiling lazily on the FIRST message.
          // Any subsequent row older-or-equal is part of the reconnect
          // catch-up burst and is skipped. Legitimately fresh rows have a
          // strictly larger created_at and pass through.
          const createdMs = new Date(row.created_at || Date.now()).getTime()
          if (firstSeenCeilingRef.current === null) {
            // Anchor at (createdMs - 1) so the very first row is itself
            // passed through on its first receipt.
            firstSeenCeilingRef.current = createdMs - 1
          } else if (createdMs <= firstSeenCeilingRef.current) {
            return
          }

          // FE2-M4: de-dupe by notification id, not by timestamp. Realtime
          // can double-deliver the same row during reconnect.
          const seenIds = seenIdsRef.current
          if (seenIds.has(row.id)) return
          seenIds.add(row.id)
          seenOrderRef.current.push(row.id)
          if (seenOrderRef.current.length > SEEN_CAP) {
            const evicted = seenOrderRef.current.shift()
            if (evicted !== undefined) seenIds.delete(evicted)
          }

          const sev = severityOf(row)
          if (sev === 'info') return
          if (SILENT_TYPES.has(row.type)) return
          push(row)
        },
      )
      .subscribe((status, err) => {
        // RESEARCH 04 §11: realtime handshake could silently fail, leaving
        // the toaster inert. Observe status so at least console shows the
        // failure; a future enhancement can auto-resubscribe.
        // CLOSED is normal during logout/unmount — don't log.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[NotificationToaster] realtime', status, err?.message || '')
        }
      })
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.id, instanceId, push])

  // Auto-dismiss after TOAST_TTL_MS. One timer per toast; cleanup on unmount.
  useEffect(() => {
    if (toasts.length === 0) return undefined
    const timers = toasts.map((t) => {
      // FE2-L2: `setTimeout(fn, negative)` fires on the next tick with a 0
      // delay — harmless, but a flat clamp makes the intent explicit and
      // avoids scheduling timers that are already in the past.
      const elapsed = Date.now() - t._shownAt
      const delay = Math.max(0, TOAST_TTL_MS - elapsed)
      return window.setTimeout(() => dismiss(t.id), delay)
    })
    return () => {
      for (const id of timers) window.clearTimeout(id)
    }
  }, [toasts, dismiss])

  if (!user?.id || toasts.length === 0) return null

  function onClick(t) {
    // FE2-M5: linkOf() now returns null for anything that isn't a safe
    // in-app path, so `navigate(to)` can't be hijacked into an open-redirect.
    const to = linkOf(t)
    dismiss(t.id)
    if (to) navigate(to)
  }

  return (
    <div className="notif-toaster" role="region" aria-live="polite" aria-label="Notifications récentes">
      {toasts.map((t) => {
        const sev = severityOf(t)
        const body = bodyOf(t)
        const to = linkOf(t)
        return (
          <div key={t.id} className={`notif-toast notif-toast--${sev}`} role="alert">
            <button
              type="button"
              className="notif-toast__body"
              onClick={() => onClick(t)}
              disabled={!to}
              style={{ cursor: to ? 'pointer' : 'default' }}
            >
              <div className="notif-toast__title">{titleOf(t)}</div>
              {body && <div className="notif-toast__msg">{body}</div>}
            </button>
            <button
              type="button"
              className="notif-toast__close"
              onClick={() => dismiss(t.id)}
              aria-label="Fermer"
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
