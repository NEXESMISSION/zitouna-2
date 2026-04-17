/**
 * Role constants matching the `app_role` PostgreSQL enum.
 * Only two values: SUPER_ADMIN (full access) and STAFF (manual page grants).
 */
export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  STAFF: 'STAFF',
}

export const ROLE_LABELS = {
  [ROLES.SUPER_ADMIN]: 'Super Admin',
  [ROLES.STAFF]: 'Staff',
}

export function canonicalRole(role) {
  if (!role) return ''
  const key = String(role).trim().toUpperCase().replace(/\s+/g, '_')
  if (ROLE_LABELS[key]) return ROLE_LABELS[key]
  if (key.includes('SUPER') || key.includes('ADMIN')) return ROLE_LABELS.SUPER_ADMIN
  return ROLE_LABELS.STAFF
}
