import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../lib/AuthContext.jsx'

// Map the notification row's `type` enum to a human-friendly French label.
// Falls back to the raw type if we don't yet have a localized label.
const TYPE_LABELS = {
  commission_earned: 'Commission reçue',
  commission_credited: 'Commission créditée',
  commission_pending: 'Commission en attente',
  commission_reversed: 'Commission annulée',
  payout_requested: 'Demande de virement',
  payout_approved: 'Virement approuvé',
  payout_paid: 'Virement effectué',
  payout_rejected: 'Virement refusé',
  installment_due: 'Échéance à venir',
  installment_paid: 'Échéance réglée',
  installment_overdue: 'Échéance en retard',
  sale_confirmed: 'Vente confirmée',
  visit_scheduled: 'Visite planifiée',
}

function titleFor(n) {
  if (!n) return 'Notification'
  const label = TYPE_LABELS[n.type]
  if (label) return label
  const raw = String(n.type || '').replace(/_/g, ' ').trim()
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Notification'
}

function bodyFor(n) {
  const p = n?.payload
  if (!p || typeof p !== 'object') return null
  // Prefer explicit human-friendly fields when the backend provides them.
  if (typeof p.message === 'string' && p.message.trim()) return p.message
  if (typeof p.body === 'string' && p.body.trim()) return p.body
  if (typeof p.description === 'string' && p.description.trim()) return p.description
  // Surface a compact summary for common payout/commission payloads so users
  // can tell rows apart without opening a detail view.
  const parts = []
  if (p.amount != null) {
    const amt = Number(p.amount)
    if (Number.isFinite(amt)) parts.push(`${amt.toLocaleString('fr-FR')} TND`)
  }
  if (typeof p.project_title === 'string') parts.push(p.project_title)
  else if (typeof p.parcel_label === 'string') parts.push(p.parcel_label)
  return parts.length > 0 ? parts.join(' • ') : null
}

// Map a notification `type` enum to a coarse severity bucket used purely for
// presentation (colored dot in the dropdown). Keeps payload shape unchanged.
function severityFor(type) {
  const t = String(type || '')
  if (t.startsWith('commission_')) return 'commission'
  if (t.startsWith('payout_')) return 'payout'
  if (t.startsWith('installment_')) return 'installment'
  if (t.startsWith('sale_')) return 'sale'
  return 'info'
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('fr-FR')
}

export default function NotificationsMenu() {
  const { user } = useAuth()
  const [notifs, setNotifs] = useState([])
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  const refresh = useCallback(async () => {
    if (!user?.id) return
    const { data, error } = await supabase
      .from('user_notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) {
      console.warn('NotificationsMenu: fetch failed', error.message || error)
      return
    }
    setNotifs(Array.isArray(data) ? data : [])
  }, [user?.id])

  useEffect(() => {
    if (!user?.id) {
      setNotifs([])
      return
    }
    refresh()
  }, [user?.id, refresh])

  useEffect(() => {
    if (!user?.id) return undefined
    const channel = supabase
      .channel(`notif-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_notifications',
          filter: `user_id=eq.${user.id}`,
        },
        () => refresh(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.id, refresh])

  // Close the dropdown when clicking outside of it so it behaves like a menu.
  useEffect(() => {
    if (!open) return undefined
    function onDocClick(event) {
      if (!rootRef.current) return
      if (!rootRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const unread = notifs.filter((n) => !n.read_at).length

  const markAllRead = useCallback(async () => {
    if (!user?.id) return
    const nowIso = new Date().toISOString()
    // Optimistic update for instant UI feedback; the realtime channel will
    // reconcile if the server-side update diverges.
    setNotifs((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: nowIso })))
    const { error } = await supabase
      .from('user_notifications')
      .update({ read_at: nowIso })
      .eq('user_id', user.id)
      .is('read_at', null)
    if (error) {
      console.warn('NotificationsMenu: markAllRead failed', error.message || error)
      refresh()
    }
  }, [user?.id, refresh])

  const markOneRead = useCallback(
    async (notif) => {
      if (!user?.id || !notif || notif.read_at) return
      const nowIso = new Date().toISOString()
      setNotifs((prev) => prev.map((n) => (n.id === notif.id ? { ...n, read_at: nowIso } : n)))
      const { error } = await supabase
        .from('user_notifications')
        .update({ read_at: nowIso })
        .eq('id', notif.id)
        .eq('user_id', user.id)
      if (error) {
        console.warn('NotificationsMenu: markOneRead failed', error.message || error)
        refresh()
      }
    },
    [user?.id, refresh],
  )

  if (!user?.id) return null

  return (
    <div className="notif-menu" ref={rootRef}>
      <button
        type="button"
        className="notif-menu__bell"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        aria-expanded={open}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2a6 6 0 0 0-6 6v3.586l-1.707 1.707A1 1 0 0 0 5 15h14a1 1 0 0 0 .707-1.707L18 11.586V8a6 6 0 0 0-6-6z" />
          <path d="M10 19a2 2 0 1 0 4 0" />
        </svg>
        {unread > 0 && (
          <span className="notif-menu__badge" aria-label={`${unread} non lues`}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="notif-menu__panel" role="menu">
          <div className="notif-menu__head">
            <span>Notifications</span>
            {unread > 0 && (
              <button type="button" className="notif-menu__link" onClick={markAllRead}>
                Tout marquer lu
              </button>
            )}
          </div>
          {notifs.length === 0 ? (
            <div className="notif-menu__empty">Aucune notification.</div>
          ) : (
            <ul className="notif-menu__list">
              {notifs.map((n) => {
                const body = bodyFor(n)
                const isUnread = !n.read_at
                const severity = severityFor(n.type)
                const rowClass = [
                  'notif-menu__row',
                  `notif-menu__row--${severity}`,
                  isUnread ? 'notif-menu__row--unread' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <li
                    key={n.id}
                    className={rowClass}
                  >
                    <button
                      type="button"
                      className="notif-menu__rowbtn"
                      onClick={() => markOneRead(n)}
                    >
                      <div className="notif-menu__title">{titleFor(n)}</div>
                      {body && <div className="notif-menu__body">{body}</div>}
                      <div className="notif-menu__time">{formatTime(n.created_at)}</div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
