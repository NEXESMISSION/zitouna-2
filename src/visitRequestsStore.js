const STORAGE_KEY = 'zitouna_visit_requests_v1'

function safeParse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return []
  }
}

export function loadVisitRequests() {
  if (typeof window === 'undefined') return []
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  const parsed = safeParse(raw)
  return Array.isArray(parsed) ? parsed : []
}

export function saveVisitRequests(requests) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(requests))
}

export function addVisitRequest(request) {
  const current = loadVisitRequests()
  const next = [{ ...request, id: `RDV-${Date.now()}`, status: 'new', createdAt: new Date().toISOString() }, ...current]
  saveVisitRequests(next)
  return next
}

