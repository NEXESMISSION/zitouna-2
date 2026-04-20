// ----------------------------------------------------------------------------
// Storage + format helpers. Addresses 04_FRONTEND_CORRECTNESS_FINDINGS.md
// FE-M1 (sessionStorage JSON parse safety) and FE-L2 (date formatting).
//
// Use these instead of inline JSON.parse / new Date() to avoid silent
// SyntaxError cascades and Invalid Date strings reaching the UI.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react'

/**
 * Read a JSON value from sessionStorage. Returns `fallback` on missing
 * key, parse error, or non-browser environment. Never throws.
 *
 * @template T
 * @param {string} key
 * @param {T}      fallback
 * @returns {T}
 */
export function safeSessionJson(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.sessionStorage.getItem(key)
    if (raw == null || raw === '') return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** Same shape for localStorage. */
export function safeLocalJson(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null || raw === '') return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** Write JSON; swallow quota / disabled-storage errors. */
export function safeSessionSet(key, value) {
  if (typeof window === 'undefined') return false
  try {
    window.sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** Remove key without throwing. */
export function safeSessionRemove(key) {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.removeItem(key) } catch { /* ignore */ }
}

// ----------------------------------------------------------------------------
// Date formatting. The app shows French dates everywhere; isolate the
// format string so reformatting later is one diff. Safe against null,
// undefined, and "Invalid Date" inputs.
// ----------------------------------------------------------------------------

/**
 * Format an ISO timestamp as a French short date (DD/MM/YYYY).
 *
 * @param {string|Date|null|undefined} value
 * @param {string} [fallback='—']
 * @returns {string}
 */
export function formatDate(value, fallback = '—') {
  if (value == null || value === '') return fallback
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return fallback
  try {
    return d.toLocaleDateString('fr-FR')
  } catch {
    return fallback
  }
}

/**
 * Format an ISO timestamp as a French date+time short string.
 *
 * @param {string|Date|null|undefined} value
 * @param {string} [fallback='—']
 */
export function formatDateTime(value, fallback = '—') {
  if (value == null || value === '') return fallback
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return fallback
  try {
    return d.toLocaleString('fr-FR')
  } catch {
    return fallback
  }
}

// ----------------------------------------------------------------------------
// useNow — tick hook. Returns a counter that increments every `intervalMs`,
// usable as a useMemo/useEffect dependency to force time-dependent labels
// (relative timestamps, countdown displays) to recompute on a schedule.
//
// Addresses FE2-L1 (13_FRONTEND_DEEP_AUDIT): `formatRelative` was being
// computed once per render. A row stamped "À l'instant" stayed that label
// for the entire menu lifetime even though the wallclock kept moving.
//
// Cheap by design — one timer per component mount, no event listeners.
// Default 60s interval matches the relative formatter's resolution.
// ----------------------------------------------------------------------------
export function useNow(intervalMs = 60_000) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return tick
}

/**
 * "Il y a 5 min" relative formatter. Falls back to formatDate for
 * anything older than ~7 days.
 */
export function formatRelative(value, fallback = '—') {
  if (value == null || value === '') return fallback
  const d = value instanceof Date ? value : new Date(value)
  const t = d.getTime()
  if (Number.isNaN(t)) return fallback
  const diffMs = Date.now() - t
  const min = Math.round(diffMs / 60000)
  if (min < 1) return "À l'instant"
  if (min < 60) return `il y a ${min} min`
  const hr = Math.round(min / 60)
  if (hr < 24) return `il y a ${hr} h`
  const day = Math.round(hr / 24)
  if (day < 7) return `il y a ${day} j`
  return formatDate(d, fallback)
}
