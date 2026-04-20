// ----------------------------------------------------------------------------
// Number coercion helpers. Addresses 04_FRONTEND_CORRECTNESS_FINDINGS.md
// FE-M6 — Number("") = 0, Number(null) = 0, Number(undefined) = NaN
// inconsistencies. Use these everywhere money or percentages flow.
// ----------------------------------------------------------------------------

/**
 * Coerce any value to a finite number, returning `fallback` for null,
 * undefined, empty string, NaN, or Infinity.
 *
 * @param {unknown} value
 * @param {number}  [fallback=0]
 * @returns {number}
 */
export function toNum(value, fallback = 0) {
  if (value == null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Same as toNum but clamps negatives to 0. Use for money totals where
 * a negative value would silently corrupt sums (see DB-H4).
 */
export function toNumNonNeg(value, fallback = 0) {
  const n = toNum(value, fallback)
  return n < 0 ? 0 : n
}

/**
 * Format a number as a French TND amount.
 *
 * @example formatTnd(1234.5) // "1 234,50 DT"
 */
export function formatTnd(value, { decimals = 2, fallback = '—' } = {}) {
  const n = toNum(value, NaN)
  if (!Number.isFinite(n)) return fallback
  try {
    return `${n.toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })} DT`
  } catch {
    return `${n.toFixed(decimals)} DT`
  }
}

/**
 * Coerce a percentage (0..100) to a number. Treats >100 as already-out-of-100;
 * NaN / null / undefined / '' fall back to `fallback`.
 */
export function toPct(value, fallback = 0) {
  return toNum(value, fallback)
}
