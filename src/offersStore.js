import { mockOffersByProject } from './adminData.js'

const STORAGE_KEY = 'zitouna_offers_by_project_v1'

function safeParse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(mockOffersByProject))
}

export function loadOffersByProject() {
  if (typeof window === 'undefined') return cloneDefaults()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return cloneDefaults()
  const parsed = safeParse(raw)
  return parsed && typeof parsed === 'object' ? parsed : cloneDefaults()
}

export function saveOffersByProject(offersByProject) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(offersByProject))
}

