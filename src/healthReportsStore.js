const STORAGE_KEY = 'zitouna_health_reports_v1'

const DEFAULT_REPORT = {
  treeSante: 95,
  santeLabel: 'Excellent',
  humidity: 65,
  humidityLabel: 'Optimale',
  nutrients: 80,
  nutrientsLabel: 'Equilibres',
  co2: 4.2,
  co2Trend: [1.8, 2.4, 2.9, 3.4, 3.8, 4.2],
  lastWatering: { pct: 70, info: '2 heures' },
  lastDrone: { pct: 15, info: '10 jours' },
  nextAction: '"Arrosage automatise (0.5 L)" dans 4 heures',
}

function safeParse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

export function reportKey(projectId, plotId) {
  return `${projectId}:${plotId}`
}

export function loadHealthReports() {
  if (typeof window === 'undefined') return {}
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return {}
  const parsed = safeParse(raw)
  return parsed && typeof parsed === 'object' ? parsed : {}
}

export function saveHealthReports(reports) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reports))
}

export function getPlotHealthReport(projectId, plotId) {
  const all = loadHealthReports()
  return all[reportKey(projectId, plotId)] || DEFAULT_REPORT
}

export function upsertPlotHealthReport(projectId, plotId, report) {
  const all = loadHealthReports()
  const next = { ...all, [reportKey(projectId, plotId)]: report }
  saveHealthReports(next)
  return next
}

