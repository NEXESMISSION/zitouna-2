/**
 * Keep only the most relevant data-access request per (userId, requestedCin) pair.
 * Priority: approved > pending > rejected, then most recent created_at.
 */
export function dedupeVerificationRequestsByUserAndCin(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return []

  const STATUS_PRIORITY = { approved: 0, pending: 1, rejected: 2 }
  const map = new Map()

  for (const row of rows) {
    const key = `${row.userId || ''}::${row.requestedCin || ''}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, row)
      continue
    }
    const pNew = STATUS_PRIORITY[row.status] ?? 3
    const pOld = STATUS_PRIORITY[existing.status] ?? 3
    if (pNew < pOld || (pNew === pOld && String(row.createdAt || '') > String(existing.createdAt || ''))) {
      map.set(key, row)
    }
  }

  return [...map.values()]
}
