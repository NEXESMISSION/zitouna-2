import { myInstallments } from './installments.js'

const STORAGE_KEY = 'zitouna_installments_v1'

function safeParse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(myInstallments))
}

export function loadInstallments() {
  if (typeof window === 'undefined') return cloneDefaults()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return cloneDefaults()
  const parsed = safeParse(raw)
  return Array.isArray(parsed) ? parsed : cloneDefaults()
}

export function saveInstallments(plans) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(plans))
}

