/**
 * In-process data-invalidation bus.
 *
 * When a hook mutates a resource (e.g. useSales.create / useClients.upsert),
 * it calls `emitInvalidate('sales')`. Every hook instance currently mounted
 * in the app — on any page — listens via `onInvalidate('sales', fn)` and
 * re-fetches. This makes cross-page updates near-instant (<10 ms) and does
 * not depend on Supabase realtime replication being configured server-side.
 *
 * Known resource keys — keep in sync with the hooks that emit/listen:
 *   sales, clients, projects, offers, adminUsers,
 *   installmentPlans, commissions, auditLog,
 *   callCenter, commercialCalendar, accessGrants,
 *   sellerRelations, sellerAssignments, notifications
 */
const TOPIC = 'zitouna:data-invalidate'

export function emitInvalidate(resource) {
  if (typeof window === 'undefined') return
  const key = String(resource || '').trim()
  if (!key) return
  window.dispatchEvent(new CustomEvent(TOPIC, { detail: { resource: key } }))
}

/**
 * Subscribe to invalidations for one or more resources. Returns an
 * unsubscribe function — call it in your useEffect cleanup.
 */
export function onInvalidate(resources, handler) {
  if (typeof window === 'undefined') return () => {}
  const list = Array.isArray(resources) ? resources : [resources]
  const keys = new Set(list.map((r) => String(r || '').trim()).filter(Boolean))
  if (keys.size === 0 || typeof handler !== 'function') return () => {}

  const listener = (evt) => {
    const resource = evt?.detail?.resource
    if (resource && keys.has(resource)) handler(resource)
  }
  window.addEventListener(TOPIC, listener)
  return () => window.removeEventListener(TOPIC, listener)
}
