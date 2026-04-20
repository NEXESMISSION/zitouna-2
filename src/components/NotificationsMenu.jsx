import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import {
  useNotifications,
  titleOf,
  bodyOf,
  linkOf,
  severityOf,
  categoryOf,
} from '../lib/notifications.js'
import { useNow } from '../lib/safeStorage.js'

// ----------------------------------------------------------------------------
// Tabs: "Tout" is the default catch-all; the rest mirror the `category`
// column from database/08_notifications.sql. Count badges use
// `unreadByCategory` so the UI never has to filter twice.
// ----------------------------------------------------------------------------
const TABS = [
  { key: 'all',          label: 'Tout',        categories: null },
  { key: 'commission',   label: 'Commissions', categories: ['commission', 'payout'] },
  { key: 'sale',         label: 'Ventes',      categories: ['sale'] },
  { key: 'installment',  label: 'Échéances',   categories: ['installment'] },
  { key: 'visit',        label: 'Visites',     categories: ['visit'] },
]

function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const t = d.getTime()
  if (Number.isNaN(t)) return ''
  const diffMs = Date.now() - t
  const min = Math.round(diffMs / 60000)
  if (min < 1) return "À l'instant"
  if (min < 60) return `il y a ${min} min`
  const hr = Math.round(min / 60)
  if (hr < 24) return `il y a ${hr} h`
  const day = Math.round(hr / 24)
  if (day < 7) return `il y a ${day} j`
  return d.toLocaleDateString('fr-FR')
}

// Severity → row colour accent. Kept in sync with App.css (.notif-menu__row--*).
function rowSeverityClass(sev) {
  switch (sev) {
    case 'success': return 'notif-menu__row--success'
    case 'warning': return 'notif-menu__row--warning'
    case 'danger':  return 'notif-menu__row--danger'
    default:        return 'notif-menu__row--info'
  }
}

/**
 * Notification bell + dropdown.
 *
 * @param {'investor'|'admin'|null} scope  null = show both (default for users
 *   who wear two hats, e.g. staff who are also ambassadors)
 */
export default function NotificationsMenu({ scope = null, label = 'Notifications' } = {}) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const rootRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('all')

  const { notifs, unreadCount, unreadByCategory, markOneRead, markAllRead, archive } =
    useNotifications({ userId: user?.id, scope })

  // FE2-L1 (13_FRONTEND_DEEP_AUDIT): formatRelative is a pure function of
  // (Date.now() - created_at) and was being computed once at render time
  // and never updated. A row stamped "À l'instant" stayed that label
  // forever until new notifs arrived. `useNow(60_000)` increments a tick
  // counter every minute, which we feed into the `tabUnread`/labels
  // useMemos as a dependency so React rerenders the rows every minute.
  const nowTick = useNow(60_000)

  // Close on ESC for accessibility
  useEffect(() => {
    if (!open) return undefined
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Lock body scroll while the full-screen panel is open so the page
  // underneath doesn't scroll on touch.
  useEffect(() => {
    if (!open) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  const filtered = useMemo(() => {
    const tab = TABS.find((t) => t.key === activeTab) || TABS[0]
    if (!tab.categories) return notifs
    const allow = new Set(tab.categories)
    return notifs.filter((n) => allow.has(categoryOf(n)))
  }, [notifs, activeTab])

  // FE2-L1: precompute relative-time labels with `nowTick` as a dependency.
  // `useNow` ticks every 60s, so this map rebuilds and React re-renders the
  // rows even when `notifs` itself hasn't changed.
  const relLabelById = useMemo(() => {
    // Read nowTick so React tracks it as a dep — its value isn't used inside
    // the loop, the act of including it forces this useMemo to recompute
    // every minute (see useNow in safeStorage.js).
    void nowTick
    const out = {}
    for (const n of filtered) out[n.id] = formatRelative(n.created_at)
    return out
  }, [filtered, nowTick])

  const tabUnread = useMemo(() => {
    const out = {}
    for (const t of TABS) {
      if (!t.categories) { out[t.key] = unreadCount; continue }
      let n = 0
      for (const cat of t.categories) n += unreadByCategory[cat] || 0
      out[t.key] = n
    }
    return out
  }, [unreadCount, unreadByCategory])

  if (!user?.id) return null

  function onRowClick(n) {
    markOneRead(n.id)
    const to = linkOf(n)
    if (to) {
      setOpen(false)
      navigate(to)
    }
  }

  function onArchiveClick(e, id) {
    e.stopPropagation()
    archive(id)
  }

  const currentTab = TABS.find((t) => t.key === activeTab) || TABS[0]

  return (
    <div className="notif-menu" ref={rootRef}>
      <button
        type="button"
        className="notif-menu__bell"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2a6 6 0 0 0-6 6v3.586l-1.707 1.707A1 1 0 0 0 5 15h14a1 1 0 0 0 .707-1.707L18 11.586V8a6 6 0 0 0-6-6z" />
          <path d="M10 19a2 2 0 1 0 4 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            className="notif-menu__badge"
            aria-label={`${unreadCount} non lues`}
            title={`${unreadCount} non lues`}
          />
        )}
      </button>

      {open && (
        <div
          className="notif-menu__overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
        <div
          className="notif-menu__panel"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="notif-menu__head">
            <span className="notif-menu__head-title">{label}</span>
            <div className="notif-menu__head-actions">
              {tabUnread[activeTab] > 0 && (
                <button
                  type="button"
                  className="notif-menu__link"
                  onClick={() => markAllRead({ categories: currentTab.categories })}
                >
                  Tout marquer lu
                </button>
              )}
              <button
                type="button"
                className="notif-menu__close"
                onClick={() => setOpen(false)}
                aria-label="Fermer"
                title="Fermer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          </div>

          <div className="notif-menu__tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                type="button"
                aria-selected={activeTab === t.key}
                className={`notif-menu__tab${activeTab === t.key ? ' notif-menu__tab--active' : ''}`}
                onClick={() => setActiveTab(t.key)}
              >
                {t.label}
                {tabUnread[t.key] > 0 && (
                  <span
                    className="notif-menu__tab-dot"
                    aria-label={`${tabUnread[t.key]} non lues`}
                    title={`${tabUnread[t.key]} non lues`}
                  />
                )}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div className="notif-menu__empty">Aucune notification.</div>
          ) : (
            <ul className="notif-menu__list">
              {filtered.map((n) => {
                const isUnread = !n.read_at
                const sev = severityOf(n)
                const cat = categoryOf(n)
                const body = bodyOf(n)
                const cls = [
                  'notif-menu__row',
                  `notif-menu__row--${cat}`,
                  rowSeverityClass(sev),
                  isUnread ? 'notif-menu__row--unread' : '',
                ].filter(Boolean).join(' ')
                return (
                  <li key={n.id} className={cls}>
                    <button type="button" className="notif-menu__rowbtn" onClick={() => onRowClick(n)}>
                      <div className="notif-menu__title">{titleOf(n)}</div>
                      {body && <div className="notif-menu__body">{body}</div>}
                      <div className="notif-menu__time">{relLabelById[n.id] ?? formatRelative(n.created_at)}</div>
                    </button>
                    <button
                      type="button"
                      className="notif-menu__archive"
                      onClick={(e) => onArchiveClick(e, n.id)}
                      aria-label="Archiver"
                      title="Archiver"
                    >
                      ×
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        </div>
      )}
    </div>
  )
}
