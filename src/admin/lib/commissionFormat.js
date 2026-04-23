// Shared format / normalize helpers for every commission surface.
// Previously each page/component re-implemented fmtMoney and normalizeStatus,
// producing inconsistent totals (e.g. 1001 TND in the tracker vs 1000.50 TND
// in the override modal) and silently excluding `pending` events in some
// rollups but not in others. Single source of truth: import from here.

export function asStr(v) { return v == null ? '' : String(v) }
export function asId(v) { return v == null ? '' : String(v) }

/**
 * Canonical commission-event status bucket.
 * Four values — pending | payable | paid | cancelled — map every legacy
 * status string (approved, pending_review, rejected, …) into one of them.
 */
export function normalizeStatus(e) {
  if (!e) return 'pending'
  if (e.status === 'paid' || e.paid_at || e.paidAt) return 'paid'
  if (e.status === 'cancelled' || e.status === 'rejected') return 'cancelled'
  if (e.status === 'payable' || e.status === 'approved') return 'payable'
  return 'pending'
}

export const COMMISSION_LABEL = {
  pending: 'En attente',
  payable: 'À payer',
  paid: 'Payé',
  cancelled: 'Annulé',
}

export const COMMISSION_TONE = {
  pending: 'orange',
  payable: 'blue',
  paid: 'green',
  cancelled: 'gray',
}

/**
 * Full-precision money for modals/detail rows: "1 000,50 TND".
 * Use for anything where the exact amount matters (review, override, audit).
 */
export function fmtMoney(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0,00 TND'
  return `${v.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} TND`
}

/**
 * Bare 2-decimal number for UI cards where the currency suffix is
 * rendered by a separate element (e.g. `<amount>1000,50</amount><cur>TND</cur>`).
 */
export function fmtMoneyBare(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0,00'
  return v.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Short KPI form: "1,2M TND" / "12k TND" / "1 000 TND".
 * Use for top-bar rollups where density beats precision.
 */
export function fmtMoneyShort(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v === 0) return '0 TND'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M TND`
  if (v >= 10_000) return `${Math.round(v / 1000)}k TND`
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} TND`
}

/**
 * Bare numeric short form for axes/tick labels (no currency suffix).
 */
export function fmtShort(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v === 0) return '0'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${Math.round(v / 1000)}k`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(Math.round(v))
}

export function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' })
}

export function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Top-bar rollup. Returns an object with *all four* buckets so `pending` is
 * never silently dropped — previously tracker rollups skipped it and admins
 * saw an under-stated obligation total.
 */
export function rollupEvents(events) {
  const totals = {
    payable: 0,
    paid: 0,
    pending: 0,
    cancelled: 0,
    total: 0,
    unpaid: 0, // pending + payable — what the business still owes
    count: 0,
    beneficiaries: 0,
  }
  const seen = new Set()
  for (const e of events || []) {
    const amt = Number(e.amount) || 0
    const st = normalizeStatus(e)
    totals[st] += amt
    totals.count += 1
    if (st !== 'cancelled') totals.total += amt
    if (st === 'payable' || st === 'pending') totals.unpaid += amt
    const b = e.beneficiary_client_id ?? e.beneficiaryClientId
    if (b) seen.add(String(b))
  }
  totals.beneficiaries = seen.size
  return totals
}

export function clientDisplayName(c) {
  if (!c) return ''
  return (
    c.full_name ||
    c.name ||
    [c.first_name, c.last_name].filter(Boolean).join(' ') ||
    c.email ||
    c.code ||
    '—'
  )
}

export function clientInitials(c) {
  const name = clientDisplayName(c)
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase()
}
