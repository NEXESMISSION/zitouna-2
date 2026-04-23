import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase.js'
import { isSafeAppPath } from './safePaths.js'

// ============================================================================
// Central client-side API for the notification system.
// Mirrors database/08_notifications.sql:
//   • list + realtime read through user_notifications
//   • mark / archive via RPCs (SECURITY DEFINER, user-scoped)
//   • preferences through user_notification_prefs
// Keep the UI layer thin — all business rules live in the DB.
// ============================================================================

// Public label map. Frontend-only fallback when a trigger doesn't set a
// payload.title. Category + severity now come from dedicated columns.
const TYPE_LABELS = {
  commission_earned:       'Commission reçue',
  commission_reversed:     'Commission annulée',
  commission_pending:      'Commission en attente',
  payout_requested:        'Demande de virement',
  payout_approved:         'Virement approuvé',
  payout_paid:             'Virement effectué',
  payout_rejected:         'Virement refusé',
  installment_due:         'Échéance à venir',
  installment_paid:        'Échéance réglée',
  installment_overdue:     'Échéance en retard',
  installment_rejected:    'Reçu rejeté',
  sale_confirmed:          'Vente confirmée',
  sale_active:             'Vente activée',
  sale_completed:          'Vente finalisée',
  sale_cancelled:          'Vente annulée',
  new_sale_created:        'Nouvelle vente',
  visit_scheduled:         'Visite planifiée',
  visit_confirmed:         'Visite confirmée',
  visit_cancelled:         'Visite annulée',
  visit_completed:         'Visite effectuée',
  visit_reminder:          'Rappel de visite',
  page_access_granted:     'Nouvel accès',
  new_client_registered:   'Nouveau client',
  kyc_approved:            'Identité vérifiée',
  kyc_rejected:            'Vérification refusée',
}

export const CATEGORIES = ['commission', 'payout', 'sale', 'installment', 'visit', 'kyc', 'access', 'referral', 'system']
export const SCOPES = ['investor', 'admin']

export function labelForType(type) {
  const k = String(type || '').trim()
  if (TYPE_LABELS[k]) return TYPE_LABELS[k]
  const raw = k.replace(/_/g, ' ').trim()
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Notification'
}

export function titleOf(n) {
  const fromPayload = n?.payload?.title
  if (typeof fromPayload === 'string' && fromPayload.trim()) return fromPayload
  return labelForType(n?.type)
}

export function bodyOf(n) {
  const p = n?.payload
  if (!p || typeof p !== 'object') return null
  if (typeof p.body === 'string' && p.body.trim()) return p.body
  if (typeof p.message === 'string' && p.message.trim()) return p.message
  if (typeof p.description === 'string' && p.description.trim()) return p.description
  // Compact summary fallback
  const parts = []
  if (p.amount != null && Number.isFinite(Number(p.amount))) parts.push(`${Number(p.amount).toLocaleString('fr-FR')} DT`)
  if (typeof p.project_title === 'string' && p.project_title) parts.push(p.project_title)
  else if (typeof p.parcel_label === 'string' && p.parcel_label) parts.push(p.parcel_label)
  return parts.length ? parts.join(' • ') : null
}

// FE2-M5 (13_FRONTEND_DEEP_AUDIT): the notification payload is JSON written
// by DB triggers. If anything in the stack ever writes a `link` field
// containing a `javascript:` URL, an absolute external URL, or a
// protocol-relative path (`//evil.com/x`), `navigate(to)` would happily
// follow it (React Router's navigate is partially safe, but `//foo`
// becomes `https://foo` in some routers). Funnel every link through the
// strict allowlist `isSafeAppPath` (already used for the post-login
// redirect in `safePaths.js`). Anything that isn't a known in-app route
// returns null so the menu/toaster click handlers fall through to a no-op.
export function linkOf(n) {
  const raw = n?.payload?.link
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return isSafeAppPath(trimmed) ? trimmed : null
}

export function severityOf(n) {
  return n?.severity || n?.payload?.severity || 'info'
}

export function categoryOf(n) {
  return n?.category || n?.payload?.category || 'system'
}

// ----------------------------------------------------------------------------
// Fetch helpers
// ----------------------------------------------------------------------------
const DEFAULT_LIMIT = 40

export async function fetchNotifications({
  userId,
  scope = null,
  category = null,
  includeArchived = false,
  limit = DEFAULT_LIMIT,
} = {}) {
  if (!userId) return []
  let q = supabase
    .from('user_notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (scope) q = q.eq('role_scope', scope)
  if (category) q = q.eq('category', category)
  if (!includeArchived) q = q.is('archived_at', null)
  const { data, error } = await q
  if (error) {
    console.warn('[notifications.fetch]', error.message || error)
    return []
  }
  return Array.isArray(data) ? data : []
}

export async function markRead(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : []
  if (list.length === 0) return 0
  const { data, error } = await supabase.rpc('mark_notifications_read', { p_ids: list })
  if (error) {
    console.warn('[notifications.markRead]', error.message || error)
    return 0
  }
  return Number(data || 0)
}

export async function markAllRead({ scope = null, category = null } = {}) {
  const { data, error } = await supabase.rpc('mark_all_notifications_read', {
    p_scope: scope,
    p_category: category,
  })
  if (error) {
    console.warn('[notifications.markAllRead]', error.message || error)
    // Throw so useNotifications' doMarkAllRead catch can revert the
    // optimistic update. Previously this silently returned 0 and the
    // optimistic "read" state would stick in the UI until a page refresh,
    // even though the DB was never updated — hence user reports of the
    // button "not working".
    throw new Error(error.message || String(error))
  }
  return Number(data || 0)
}

// FE2-H6 (13_FRONTEND_DEEP_AUDIT): the original `markAllRead` only takes a
// SINGLE category, so the multi-category "Commissions" tab (which covers
// both `commission` and `payout`) only marked half its items read. This
// helper accepts an array of categories and dispatches to:
//   • `mark_all_notifications_read_categories(p_scope, p_categories text[])`
//     when the SQL agent's new RPC exists (database/12_notifications_security_patch.sql),
//   • the legacy single-category RPC when categories has length 1,
//   • the all-categories RPC when categories is null/empty.
//
// We try the array RPC first and fall back automatically if the function
// isn't deployed yet, so the frontend ships independently of the SQL patch.
export async function markAllReadByCategories({ scope = null, categories = null } = {}) {
  const list = Array.isArray(categories) ? categories.filter(Boolean) : null

  if (!list || list.length === 0) {
    // No categories specified → mark everything (within scope).
    return markAllRead({ scope, category: null })
  }
  if (list.length === 1) {
    // Single category → use the existing RPC; cheaper than spinning up
    // the new array-based one for one element.
    return markAllRead({ scope, category: list[0] })
  }

  // Multi-category → call the new RPC. If it doesn't exist on the server
  // yet (SQL patch not deployed), fall back to N parallel single-category
  // calls so the UI still works.
  const { data, error } = await supabase.rpc('mark_all_notifications_read_categories', {
    p_scope: scope,
    p_categories: list,
  })
  if (error) {
    const msg = String(error?.message || error)
    // PostgREST returns "Could not find the function" (PGRST202) or 404 when
    // the RPC isn't deployed yet — fall back to per-category calls so the
    // bell still empties out.
    if (/not find|does not exist|PGRST202|404/i.test(msg)) {
      const counts = await Promise.all(list.map((c) => markAllRead({ scope, category: c })))
      return counts.reduce((a, b) => a + Number(b || 0), 0)
    }
    console.warn('[notifications.markAllReadByCategories]', msg)
    throw new Error(msg)
  }
  return Number(data || 0)
}

export async function archive(id) {
  if (!id) return false
  const { data, error } = await supabase.rpc('archive_notification', { p_id: id })
  if (error) {
    console.warn('[notifications.archive]', error.message || error)
    return false
  }
  return Boolean(data)
}

// ----------------------------------------------------------------------------
// Preferences — per (user, category, channel) opt-outs. Default "enabled".
// ----------------------------------------------------------------------------
export async function fetchChannels() {
  const { data, error } = await supabase.from('notification_channels').select('*').order('channel_key')
  if (error) {
    console.warn('[notifications.fetchChannels]', error.message || error)
    return []
  }
  return Array.isArray(data) ? data : []
}

export async function fetchPrefs(userId) {
  if (!userId) return []
  const { data, error } = await supabase
    .from('user_notification_prefs')
    .select('*')
    .eq('user_id', userId)
  if (error) {
    console.warn('[notifications.fetchPrefs]', error.message || error)
    return []
  }
  return Array.isArray(data) ? data : []
}

export async function setPref({ userId, category, channelKey, enabled }) {
  if (!userId || !category || !channelKey) return false
  const { error } = await supabase
    .from('user_notification_prefs')
    .upsert(
      { user_id: userId, category, channel_key: channelKey, enabled: Boolean(enabled), updated_at: new Date().toISOString() },
      { onConflict: 'user_id,category,channel_key' },
    )
  if (error) {
    console.warn('[notifications.setPref]', error.message || error)
    return false
  }
  return true
}

// ----------------------------------------------------------------------------
// Hook — stateful list with realtime + optimistic mark-read. One Supabase
// channel per (user, scope) so the two TopBar bells don't step on each other.
// ----------------------------------------------------------------------------
export function useNotifications({ userId, scope = null, category = null, limit = DEFAULT_LIMIT } = {}) {
  const [notifs, setNotifs] = useState([])
  const [loading, setLoading] = useState(() => Boolean(userId))
  const refreshSeqRef = useRef(0)
  // FE2-M2 (13_FRONTEND_DEEP_AUDIT): if two NotificationsMenu instances ever
  // mount with the same `(userId, scope)`, they would race for the channel
  // name `notif:${userId}:${scope}` and Supabase silently dedupes
  // identically-named channels — second mount's cleanup ends up tearing
  // down the first mount's still-active channel. Append a per-instance
  // useId() so each hook owns a unique channel namespace.
  const instanceId = useId()

  // refresh() is defined async so all setState calls below fire after the
  // initial microtask boundary — never synchronously during an effect.
  const refresh = useCallback(async () => {
    if (!userId) {
      // defer across a microtask to keep useEffect bodies clean per the
      // react-hooks/set-state-in-effect rule
      await Promise.resolve()
      setNotifs([])
      setLoading(false)
      return
    }
    const seq = ++refreshSeqRef.current
    const rows = await fetchNotifications({ userId, scope, category, limit })
    if (seq !== refreshSeqRef.current) return
    setNotifs(rows)
    setLoading(false)
  }, [userId, scope, category, limit])

  // FE2-C2: previously the realtime effect deps were [userId, scope, refresh],
  // and `refresh` is recreated whenever `category`/`limit` change. That tore
  // down and re-subscribed the realtime channel on every category-tab click
  // and every parent re-render where deps shifted reference — so messages
  // arriving in the reconnect window were silently dropped, which manifests
  // as a bell badge stuck at zero.
  //
  // Fix: stash `refresh` in a ref. The channel handler reads
  // `refreshRef.current()` so it always invokes the freshest closure, and
  // the effect's deps shrink to [userId, scope, instanceId] — only changing
  // when the actual subscription target changes.
  const refreshRef = useRef(refresh)
  useEffect(() => { refreshRef.current = refresh }, [refresh])

  useEffect(() => {
    // Schedule the initial fetch on a microtask so no setState fires
    // synchronously inside the effect body.
    queueMicrotask(() => { refreshRef.current() })
    if (!userId) return undefined
    // Channel name: stable per (user, scope, mount). instanceId guards
    // against collision between two simultaneous mounts (FE2-M2).
    const channelName = `notif:${userId}:${scope || 'all'}:${instanceId}`
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_notifications', filter: `user_id=eq.${userId}` },
        () => refreshRef.current(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [userId, scope, instanceId])

  const unreadCount = useMemo(
    () => notifs.reduce((acc, n) => acc + (n.read_at ? 0 : 1), 0),
    [notifs],
  )

  const unreadByCategory = useMemo(() => {
    const out = {}
    for (const n of notifs) {
      if (n.read_at) continue
      const k = categoryOf(n)
      out[k] = (out[k] || 0) + 1
    }
    return out
  }, [notifs])

  const doMarkOneRead = useCallback(
    async (id) => {
      if (!id) return
      setNotifs((prev) => prev.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n)))
      await markRead([id])
    },
    [],
  )

  // FE2-H6: accept either `category` (legacy single string) OR `categories`
  // (new array). NotificationsMenu now passes `categories` for multi-cat
  // tabs like "Commissions" → ['commission', 'payout'] so the mark-all
  // actually clears every row in the tab.
  const doMarkAllRead = useCallback(
    async (opts = {}) => {
      const nowIso = new Date().toISOString()
      const catList = Array.isArray(opts.categories)
        ? opts.categories.filter(Boolean)
        : (opts.category ? [opts.category] : null)
      const catSet = catList && catList.length > 0 ? new Set(catList) : null
      const prevSnapshot = notifs

      setNotifs((prev) =>
        prev.map((n) => {
          if (n.read_at) return n
          if (catSet && !catSet.has(categoryOf(n))) return n
          if (opts.scope && n.role_scope !== opts.scope) return n
          return { ...n, read_at: nowIso }
        }),
      )
      // Split the try/catch so ONLY the RPC failure rolls back the
      // optimistic update. Previously `refreshRef.current()` lived in the
      // same try — a transient network blip during the refetch reverted a
      // successful mark-read, which is exactly the "Tout marquer lu
      // doesn't work" symptom users reported. The refresh is a
      // nice-to-have (realtime usually handles it), not a correctness
      // precondition.
      try {
        await markAllReadByCategories({
          scope: opts.scope ?? scope,
          categories: catList,
        })
      } catch (err) {
        console.warn('[notifications.markAllRead] RPC failed, reverting optimistic state', err)
        setNotifs(prevSnapshot)
        return
      }
      try {
        // Realtime postgres_changes should trigger a refetch on its own,
        // but replication lag / dropped channels can delay it. A manual
        // refresh here keeps the UI honest without touching the
        // already-persisted DB state if the refetch itself errors.
        await refreshRef.current()
      } catch (err) {
        console.warn('[notifications.markAllRead] post-mark refresh failed (RPC succeeded; rows are read server-side)', err)
      }
    },
    [scope, notifs],
  )

  const doArchive = useCallback(
    async (id) => {
      if (!id) return
      setNotifs((prev) => prev.filter((n) => n.id !== id))
      await archive(id)
    },
    [],
  )

  return {
    notifs,
    loading,
    unreadCount,
    unreadByCategory,
    refresh,
    markOneRead: doMarkOneRead,
    markAllRead: doMarkAllRead,
    archive: doArchive,
  }
}
