/**
 * Canonical phone for Tunisia-centric matching (exact match after normalize).
 * Strips spaces, keeps leading + and digits.
 */
export function normalizePhone(raw) {
  if (raw == null) return ''
  let s = String(raw).trim()
  if (!s) return ''
  s = s.replace(/\s+/g, '')
  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  if (s.startsWith('+')) return `+${digits}`
  if (digits.length === 8 && !s.startsWith('216')) return `+216${digits}`
  if (digits.startsWith('216')) return `+${digits}`
  return `+${digits}`
}

export function phonesMatch(a, b) {
  return normalizePhone(a) === normalizePhone(b) && normalizePhone(a) !== ''
}
