import { NAV_ITEMS, pathnameMatchesAllowed } from '../admin/adminNavConfig.js'

/**
 * Staff session: allowedPages === null means all admin routes.
 * allowedPages === [] means only projects + explicit entries (very locked).
 */
export function hasFullPageAccess(allowedPages) {
  return allowedPages === null || allowedPages === undefined
}

/**
 * Whether pathname is allowed for staff (prefix match for nested routes).
 */
export function canAccessAdminPath(pathname, allowedPages) {
  return pathnameMatchesAllowed(pathname, allowedPages)
}

export function isStaffSuspended(adminUser) {
  return Boolean(adminUser?.suspendedAt || adminUser?.status === 'suspended')
}

/** Client promoted to admin pages: optional allowedPages on client record */
export function canClientAccessAdminPath(pathname, clientRecord) {
  if (!clientRecord || isClientSuspended(clientRecord)) return false
  return canAccessAdminPath(pathname, clientRecord.allowedPages ?? [])
}

export function isClientSuspended(client) {
  return Boolean(client?.suspendedAt || client?.status === 'suspended')
}

export function navItemsForSession(allowedPages) {
  if (hasFullPageAccess(allowedPages)) return NAV_ITEMS
  if (!Array.isArray(allowedPages)) return NAV_ITEMS.filter((n) => n.to === '/admin/projects')
  const set = new Set(allowedPages)
  return NAV_ITEMS.filter((item) => item.to === '/admin/projects' || set.has(item.to))
}
