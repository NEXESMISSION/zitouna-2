/** Canonical admin path for RLS / grants / checklist config (always leading slash, no trailing slash). */
export function normalizeAdminPagePath(raw) {
  if (raw == null) return ''
  let p = String(raw).trim()
  if (!p) return ''
  p = p.replace(/\/+/g, '/')
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/\/$/, '')
  if (p === '') return '/'
  return p
}

export const NAV_ITEMS = [
  // Projets & actifs
  { to: '/admin/projects', label: 'Projets & parcelles', icon: 'folder' },

  // Flux principal
  { to: '/admin/sell', label: 'Ventes', icon: 'shopping-bag' },
  { to: '/admin/coordination', label: 'Coordination', icon: 'calendar-check' },
  { to: '/admin/finance', label: 'Finance', icon: 'dollar-sign' },
  { to: '/admin/juridique', label: 'Juridique', icon: 'scale' },
  { to: '/admin/legal', label: 'Notaire', icon: 'shield' },

  // Clients & paiements
  { to: '/admin/clients', label: 'Clients', icon: 'users' },
  { to: '/admin/recouvrement', label: 'Echeanciers & recouvrement', icon: 'credit-card' },
  { to: '/admin/cash-sales', label: 'Paiements cash', icon: 'dollar-sign' },

  // Acquisition commerciale
  { to: '/admin/call-center', label: "Centre d'appels", icon: 'phone' },
  { to: '/admin/commercial-calendar', label: 'Calendrier commercial', icon: 'calendar-clock' },

  // Commissions & controle
  { to: '/admin/referral-settings', label: 'Regles de commission', icon: 'tag' },
  { to: '/admin/commission-ledger', label: 'Journal des commissions', icon: 'wallet' },
  { to: '/admin/commissions', label: 'Commissions', icon: 'git-branch' },
  { to: '/admin/commissions/analytics', label: 'Analyses commissions', icon: 'tag' },
  { to: '/admin/commissions/anomalies', label: 'Anomalies parrainage', icon: 'shield' },
  { to: '/admin/audit-log', label: "Journal d'activite", icon: 'file-text' },
  { to: '/admin/access-grants', label: "Droits d'acces pages", icon: 'key' },

  // Gouvernance
  { to: '/admin/users', label: 'Utilisateurs & permissions', icon: 'user-cog' },
  { to: '/admin/client-link-repair', label: 'Reparation des liens client', icon: 'link' },
]

/**
 * Check if a nav item is accessible for the given allowedPages.
 * Projects is always visible.
 * allowedPages === null means all pages (unrestricted admin).
 */
export function isNavItemAllowed(itemPath, allowedPages) {
  const normItem = normalizeAdminPagePath(itemPath)
  if (normItem === '/admin/projects' || normItem.startsWith('/admin/projects/')) return true
  if (normItem === '/admin/users' || normItem.startsWith('/admin/users/')) return allowedPages === null
  if (allowedPages === null || allowedPages === undefined) return true
  if (!Array.isArray(allowedPages)) return false
  return allowedPages.some((p) => normalizeAdminPagePath(p) === normItem)
}

export function navItemsForUser(allowedPages) {
  return NAV_ITEMS.filter((item) => isNavItemAllowed(item.to, allowedPages))
}

/** Route guard: nested paths (e.g. /admin/clients/u1) allowed if base path is allowed. */
export function pathnameMatchesAllowed(pathname, allowedPages) {
  const path = normalizeAdminPagePath(String(pathname || '').replace(/\/$/, '') || '/admin')
  /** Staff full access uses `null` from DB. `undefined` = caller did not provide a staff profile — deny by default. */
  if (allowedPages === undefined) return false
  if (allowedPages === null) return true
  if (path.startsWith('/admin/projects')) return true
  if (path === '/admin' || path === '/admin/profile' || path === '/admin/dashboard') return true
  /** Super-admin only (aligned with isNavItemAllowed for Utilisateurs). */
  if (path === '/admin/users' || path.startsWith('/admin/users/')) return false
  if (!Array.isArray(allowedPages) || allowedPages.length === 0) return false
  return allowedPages.some((p) => {
    const base = normalizeAdminPagePath(p)
    return path === base || path.startsWith(`${base}/`)
  })
}
