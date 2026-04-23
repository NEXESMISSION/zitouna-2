import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { usePublicProjectDetail } from '../lib/useSupabase.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { useTheme } from '../lib/ThemeContext.jsx'

const CURRENT_YEAR = 2026
// Centralised brand accent so hardcoded greens can be swapped for the
// admin-blue palette when the user flips to light mode. `treeRevRate`
// and `plotStatusColor` both flow through this helper.
function brandAccents(isLight) {
  return {
    accent:  isLight ? '#2563eb' : '#a8cc50',
    accent2: isLight ? '#1e40af' : '#7ab020',
    // "In progress" / mid-range accent. Dark mode keeps the amber tone
    // (it reads well on the deep-green base); light mode swaps it for a
    // cool slate so the page stays gold-free.
    caution: isLight ? '#64748b' : '#f5c842',
  }
}
function treeRevRate(plantYear, palette) {
  const age = CURRENT_YEAR - plantYear
  if (age < 3)  return { rate: 0,  label: 'Jeune',             color: '#888' }
  if (age < 6)  return { rate: 45, label: 'En développement',  color: palette.caution }
  if (age < 10) return { rate: 75, label: 'Pleine croissance', color: palette.accent }
  return               { rate: 90, label: 'Pleine production', color: palette.accent2 }
}
// Per-plot annual revenue projection.
//
// Preferred path — when the project admin has set a `annualRevenueTotal`
// on the project, each parcelle gets its share of that total pro-rata to
// its own surface (area_m2) versus the sum of all parcelles' surfaces.
// This matches the business model: the project owner announces a global
// yearly yield, and every buyer earns in proportion to the land they own.
//
// Fallback — older projects without a configured total still return a
// synthetic tree-age based estimate so existing plots don't display 0 DT.
// Each parcel owns its own tree cohorts. Revenue =
//   sum(cohort.count × age_rate) for the parcel's batches.
//
// Falls back to a tree-count share of the project annualRevenueTotal
// when the parcel has no batches yet.
function plotAnnualRevenue(plot, project) {
  const myBatches = Array.isArray(plot?.treeBatches) ? plot.treeBatches : []
  if (myBatches.length) {
    return Math.round(myBatches.reduce((s, b) => {
      const age = CURRENT_YEAR - (Number(b?.year) || CURRENT_YEAR)
      const rate = age < 3 ? 0 : age < 6 ? 45 : age < 10 ? 75 : 90
      return s + (Number(b?.count) || 0) * rate
    }, 0))
  }
  const projRev = Number(project?.annualRevenueTotal) || 0
  if (projRev <= 0) return 0
  const totalTrees = (project?.plots || []).reduce((s, p) => s + (Number(p?.trees) || 0), 0)
  const myTrees = Number(plot?.trees) || 0
  if (totalTrees <= 0 || myTrees <= 0) return 0
  return Math.round((myTrees / totalTrees) * projRev)
}
function HealthRing({ value, color, label }) {
  const circ = 2 * Math.PI * 42
  const off = circ - (Math.max(0, Math.min(100, value)) / 100) * circ
  return (
    <div className="ppv2-ring">
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="none" stroke="#F1F1EE" strokeWidth="8" />
        <circle
          cx="50" cy="50" r="42" fill="none"
          stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={off}
          transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      <div className="center"><div className="v">{value}%</div><div className="l">{label}</div></div>
    </div>
  )
}
function Co2Sparkline({ data, gradientId }) {
  if (!data?.length) return null
  const w = 160, h = 40
  const max = Math.max(...data), min = Math.min(...data), range = max - min || 1
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 10) - 4
    return [x, y]
  })
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  const [lx, ly] = pts[pts.length - 1]
  return (
    <svg className="ppv2-co2-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#0FA968" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#0FA968" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke="#0FA968" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="3" fill="#0FA968" />
    </svg>
  )
}
function plotStatusLabel(s) { return s === 'sold' ? 'Vendue' : s === 'reserved' ? 'Réservée' : 'Disponible' }
function plotStatusClass(s) { return s === 'sold' ? 'is-sold' : s === 'reserved' ? 'is-reserved' : 'is-avail' }

// Plan 04 §3.5 — isolated skeleton so rapid navigation between plots
// presents a fresh shimmer frame instead of the previously-rendered detail.
function PlotPageSkeleton() {
  return (
    <>
      <div className="sk sk-line sk-line--title" style={{ width: '35%' }} />
      <div className="sk sk-map" style={{ margin: '12px 0 20px' }} />
      <div className="sk-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="sk-card sk-card--light">
            <div className="sk sk-line" style={{ width: '55%' }} />
            <div className="sk sk-line" style={{ width: '70%' }} />
            <div className="sk sk-line" style={{ width: '45%' }} />
          </div>
        ))}
      </div>
    </>
  )
}

function PlotPageBody({ project: proj, plot }) {
  const navigate = useNavigate()
  const { theme } = useTheme()
  const palette = brandAccents(theme === 'light')
  // Health metrics come from the admin-edited project columns
  // (tree_health_pct / soil_humidity_pct / nutrients_pct). The labels follow
  // the same tiers used on ProjectPage so plot and project stay in sync.
  const santeTier = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return ''
    if (n >= 85) return 'Excellent'
    if (n >= 70) return 'Bon'
    if (n >= 50) return 'Moyen'
    return 'Critique'
  }
  const health = {
    treeSante: Number(proj?.treeHealthPct ?? 0),
    santeLabel: santeTier(proj?.treeHealthPct),
    humidity: Number(proj?.soilHumidityPct ?? 0),
    humidityLabel: santeTier(proj?.soilHumidityPct),
    nutrients: Number(proj?.nutrientsPct ?? 0),
    nutrientsLabel: santeTier(proj?.nutrientsPct),
    co2: 4.2, co2Trend: [1.8, 2.4, 2.9, 3.4, 3.8, 4.2],
    lastWatering: { pct: 70, info: 'il y a 2 heures · 0,5 L / arbre' },
    lastDrone: { pct: 15, info: 'à refaire dans 10 j' },
  }
  const annualRevenue = plotAnnualRevenue(plot, proj)
  // Parcel surface as a percentage of the project total (used in side panel).
  const projectTotalArea = (proj?.plots || []).reduce((s, p) => s + (Number(p.area) || 0), 0)
  const sharePct = projectTotalArea > 0 && Number(plot?.area) > 0
    ? (Number(plot.area) / projectTotalArea) * 100
    : 0
  // Each parcel owns its own tree count + cohorts.
  const plotBatches = Array.isArray(plot?.treeBatches) ? plot.treeBatches : []
  const cohortSum = plotBatches.reduce((s, b) => s + (Number(b?.count) || 0), 0)
  const totalTrees = Number(plot?.trees) > 0
    ? Number(plot.trees)
    : cohortSum
  // Earliest planting cohort (displayed as "Plantation" year on the side panel).
  const firstBatch = plotBatches.length
    ? plotBatches.reduce((acc, b) => {
        const y = Number(b?.year)
        if (!Number.isFinite(y) || y <= 0) return acc
        return !acc || y < acc.year ? { year: y, count: Number(b?.count) || 0 } : acc
      }, null)
    : null

  return (
    <section className="ppv2">
      <TopBar />
      <div className="ppv2-shell">

        {/* Sub-topnav: back + breadcrumb */}
        <div className="ppv2-topnav">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button type="button" className="ppv2-back" onClick={() => navigate(`/project/${proj.id}`)}>
              <span className="ic">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
              </span>
              {proj.city}
            </button>
            <div className="ppv2-crumb">
              {proj.region && <>
                <span>{proj.region}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 6l6 6-6 6"/></svg>
              </>}
              <span>{proj.city}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 6l6 6-6 6"/></svg>
              <b>Parcelle #{plot.label ?? plot.id}</b>
            </div>
          </div>
        </div>

        <main className="ppv2-main">

          {/* Hero header */}
          <div className="ppv2-hero">
            <div>
              <h1>Parcelle #{plot.label ?? plot.id}</h1>
              <div className="sub">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 22s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>
                <span>{proj.title} · {proj.city}{proj.region ? ` · ${proj.region}` : ''}</span>
              </div>
            </div>
            <div className="ppv2-hero-right">
              <span className={`ppv2-status ${plotStatusClass(plot.status)}`}>
                <span className="d"></span> {plotStatusLabel(plot.status)}
              </span>
              <div className="ppv2-iconrow">
                <button type="button" className="ppv2-iconbtn" title="Imprimer" onClick={() => window.print()}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="9" rx="2"/><path d="M6 14h12v7H6z"/></svg>
                </button>
                <button type="button" className="ppv2-iconbtn" title="Partager" onClick={() => { if (navigator.share) { navigator.share({ title: `Parcelle #${plot.label ?? plot.id}`, url: window.location.href }).catch(() => {}) } else if (navigator.clipboard) { navigator.clipboard.writeText(window.location.href) } }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>
                </button>
              </div>
            </div>
          </div>

          {/* Map */}
          <div className="ppv2-map-card">
            <div className="ppv2-map-head">
              <div className="lbl"><span className="dot"></span> Emplacement de la parcelle</div>
              <div className="ppv2-map-controls">
                <button type="button" title="Satellite"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18"/></svg></button>
                <button type="button" title="Calques"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5M3 17l9 5 9-5"/></svg></button>
                <button type="button" title="Plein écran" onClick={() => { if (proj.mapUrl) window.open(proj.mapUrl, '_blank', 'noopener') }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
              </div>
            </div>
            <div className="ppv2-map-body">
              <iframe title={`Parcelle ${plot.label ?? plot.id}`} src={proj.mapUrl} loading="lazy" allowFullScreen />
            </div>
          </div>

          {/* Section Santé */}
          <div className="ppv2-section-head">
            <h2><span className="dot"></span> Santé de l&apos;arbre individualisée</h2>
          </div>

          <div className="ppv2-health">
            <div className="ppv2-health-cell">
              <div className="k">Santé · arbre</div>
              <HealthRing value={health.treeSante} color="#0FA968" label={health.santeLabel} />
            </div>
            <div className="ppv2-health-cell">
              <div className="k">Humidité du sol</div>
              <HealthRing value={health.humidity} color="#1E5CFF" label={health.humidityLabel} />
            </div>
            <div className="ppv2-health-cell">
              <div className="k">Nutriments</div>
              <HealthRing value={health.nutrients} color="#B7791F" label={health.nutrientsLabel} />
            </div>
            <div className="ppv2-health-cell">
              <div className="k">CO₂ capturé (30 j)</div>
              <div className="ppv2-co2-col">
                <div className="ppv2-co2-fig">{health.co2.toString().replace('.', ',')}<span className="u">kg</span></div>
                <Co2Sparkline data={health.co2Trend} gradientId={`gCO2-${plot.id}`} />
                <div className="ppv2-co2-delta">+0,3 kg vs mois dernier</div>
              </div>
            </div>
          </div>

          {/* Progress row */}
          <div className="ppv2-pgrow">
            <div className="ppv2-pg">
              <div className="ppv2-pg-head">
                <div className="ic"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12z"/></svg></div>
                <div>
                  <div className="t">Dernier arrosage</div>
                  <div className="s">Automatisé · système goutte-à-goutte</div>
                </div>
              </div>
              <div className="meta">
                <div className="pct blue">{health.lastWatering.pct}%</div>
                <div className="s">{health.lastWatering.info}</div>
              </div>
              <div className="bar"><span className="blue" style={{ width: `${health.lastWatering.pct}%` }} /></div>
            </div>

            <div className="ppv2-pg">
              <div className="ppv2-pg-head">
                <div className="ic olive"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18M12 3c3 3 5 5 5 8a5 5 0 1 1-10 0c0-3 2-5 5-8z"/></svg></div>
                <div>
                  <div className="t">Dernier traitement · Dacus oleae</div>
                  <div className="s">Bio · phéromone</div>
                </div>
              </div>
              <div className="meta">
                <div className="pct amber">{health.lastDrone.pct}%</div>
                <div className="s amber">{health.lastDrone.info}</div>
              </div>
              <div className="bar"><span className="amber" style={{ width: `${health.lastDrone.pct}%` }} /></div>
            </div>
          </div>

          {/* Next action */}
          <div className="ppv2-next">
            <div className="ic">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            </div>
            <div className="txt">
              <div className="k">Prochaine action prévue</div>
              <div className="t"><b>Arrosage automatisé</b> · 0,5 L par arbre · secteur Nord</div>
            </div>
            <div className="eta">dans 4 h</div>
          </div>

          {/* Share of the project (surface-based) */}
          {(() => {
            const totalArea = (proj?.plots || []).reduce((s, p) => s + (Number(p.area) || 0), 0)
            const myArea = Number(plot?.area) || 0
            if (totalArea <= 0 || myArea <= 0) return null
            const sharePct = (myArea / totalArea) * 100
            return (
              <div className="ppv2-compo">
                <div className="ppv2-compo-head">
                  <div className="ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 3v18"/></svg></div>
                  <div>
                    <h3>Part dans le projet</h3>
                    <div className="s">Surface de la parcelle ÷ surface totale du projet</div>
                  </div>
                </div>
                <div className="ppv2-compo-card">
                  <div className="year">{myArea.toLocaleString('fr-FR')} m²</div>
                  <div className="bar-col">
                    <div className="trees">{sharePct.toFixed(sharePct >= 10 ? 1 : 2)}<span className="u">% du projet</span></div>
                    <div className="st">sur {totalArea.toLocaleString('fr-FR')} m²</div>
                  </div>
                  <div className="age">{annualRevenue > 0 ? `~${annualRevenue.toLocaleString('fr-FR')} DT/an` : '—'}</div>
                </div>
              </div>
            )
          })()}
        </main>

        {/* Side panel */}
        <aside className="ppv2-side">
          <div className="ppv2-side-card ppv2-price">
            <div className="k">Prix total de la parcelle</div>
            <div className="price">{plot.totalPrice.toLocaleString('fr-FR')}<span className="u">TND</span></div>
            <div className="sub">
              {plot.area > 0
                ? <>soit {Math.round((Number(plot.totalPrice) || 0) / Number(plot.area)).toLocaleString('fr-FR')} TND / m²</>
                : null}
            </div>

            <div className="row">
              <div className="cell">
                <div className="k">Surface</div>
                <div className="v">{plot.area.toLocaleString('fr-FR')} m²</div>
              </div>
              <div className="cell">
                <div className="k">Part projet</div>
                <div className="v blue">{sharePct > 0 ? `${sharePct.toFixed(sharePct >= 10 ? 1 : 2)} %` : '—'}</div>
              </div>
              <div className="cell">
                <div className="k">Revenu / an</div>
                <div className="v green">~{annualRevenue.toLocaleString('fr-FR')} DT</div>
              </div>
            </div>

            <div className="ppv2-note">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
              {annualRevenue > 0
                ? <span>Revenu estimé ~{annualRevenue.toLocaleString('fr-FR')} DT/an d'après les arbres de cette parcelle.</span>
                : <span>Projet en démarrage — pas encore de revenu annuel configuré.</span>}
            </div>
          </div>

          <div className="ppv2-side-card">
            <div className="ppv2-facts">
              <div className="ppv2-facts-title">Caractéristiques</div>
              <div className="ppv2-fact"><span className="k">Projet</span><span className="v">{proj.title}</span></div>
              <div className="ppv2-fact"><span className="k">Localisation</span><span className="v">{proj.city}{proj.region ? `, ${proj.region}` : ''}</span></div>
              <div className="ppv2-fact"><span className="k">Surface</span><span className="v">{plot.area.toLocaleString('fr-FR')} m²</span></div>
              <div className="ppv2-fact"><span className="k">Oliviers</span><span className="v blue">{totalTrees}</span></div>
              <div className="ppv2-fact"><span className="k">Prix / arbre</span><span className="v">{plot.pricePerTree.toLocaleString('fr-FR')} TND</span></div>
              {firstBatch && (
                <div className="ppv2-fact"><span className="k">Plantation</span><span className="v">{firstBatch.year}</span></div>
              )}
              <div className="ppv2-fact"><span className="k">Statut</span><span className={`v ${plot.status === 'sold' ? '' : plot.status === 'reserved' ? '' : 'green'}`}>{plotStatusLabel(plot.status)}</span></div>
            </div>
          </div>
        </aside>

      </div>
    </section>
  )
}

export default function PlotPage() {
  const { projectId, plotId } = useParams()
  const navigate = useNavigate()
  const { project: proj, loading, refresh } = usePublicProjectDetail(projectId)

  // Plan 04 §3.5 — rapid-nav race. If `projectId` in the URL changes before
  // the previous fetch resolves, the hook briefly still has the old project.
  // Treat cross-id data as still loading so the stale plot never flashes.
  // §3.8 — the hook's `parcel_tree_batches` realtime subscription is
  // unfiltered in useSupabase.js (line 942); because that primitive is
  // out-of-scope for this page task, a short note is in the plan summary.
  const idMatches = Boolean(proj) && String(proj.id) === String(projectId)
  const plot = idMatches ? proj?.plots?.find((pl) => String(pl.id) === String(plotId)) : null

  // Grace window before we declare "not found". The public_parcels view and
  // realtime channel can take multiple seconds to propagate after a nav from
  // BrowsePage or a DB change. Instead of flashing the empty state as soon as
  // one fetch settles, keep the skeleton up and keep retrying until either the
  // plot shows up or the grace window is exhausted.
  const GRACE_MS = 5000
  const RETRY_DELAYS = [250, 700, 1500, 2800]
  const key = `${projectId}:${plotId}`
  const [graceExpired, setGraceExpired] = useState(false)
  const graceKeyRef = useRef('')

  useEffect(() => {
    if (graceKeyRef.current === key) return undefined
    graceKeyRef.current = key
    setGraceExpired(false)
    const t = window.setTimeout(() => setGraceExpired(true), GRACE_MS)
    return () => window.clearTimeout(t)
  }, [key])

  // Fire up to N retries while the project has loaded but the plot hasn't
  // surfaced yet. Each retry is scheduled independently so we don't stall
  // the render. Cancelled on key change / plot arrival.
  const retryIndexRef = useRef({ key: '', idx: 0 })
  useEffect(() => {
    if (retryIndexRef.current.key !== key) {
      retryIndexRef.current = { key, idx: 0 }
    }
    if (graceExpired) return undefined
    if (loading || !idMatches || plot) return undefined
    const idx = retryIndexRef.current.idx
    if (idx >= RETRY_DELAYS.length) return undefined
    const t = window.setTimeout(() => {
      retryIndexRef.current.idx = idx + 1
      refresh?.()
    }, RETRY_DELAYS[idx])
    return () => window.clearTimeout(t)
  }, [loading, idMatches, plot, key, refresh, graceExpired])

  // "Ready" is when: fetch settled, id matches route, and plot exists.
  const gateData = !loading && idMatches && plot ? { proj, plot } : null
  // Keep the skeleton up while:
  //  - the underlying hook is fetching, OR
  //  - we have stale cross-id data, OR
  //  - the plot is missing and the grace window hasn't expired yet.
  const gateLoading =
    loading
    || (Boolean(proj) && !idMatches)
    || (!proj && Boolean(projectId) && loading)
    || (idMatches && !plot && !graceExpired)
    || (!proj && Boolean(projectId) && !graceExpired)
  const isEmptyGate = (d) => d == null

  return (
    <main className="screen screen--app">
      <RenderDataGate
        loading={gateLoading}
        data={gateData}
        isEmpty={isEmptyGate}
        onRetry={refresh}
        skeleton={
          <section className="dashboard-page" aria-busy="true" aria-live="polite">
            <TopBar />
            <PlotPageSkeleton />
          </section>
        }
        empty={
          <section className="dashboard-page">
            <TopBar />
            <EmptyState
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--zb-primary, #a8cc50)' }}>
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
              }
              title="Parcelle introuvable"
              description="Cette parcelle n'existe plus ou a peut-être été renommée. Elle a pu être vendue, réassignée, ou le lien que vous avez ouvert est obsolète."
              action={{ label: 'Explorer les projets', onClick: () => navigate('/browse') }}
              secondary={
                projectId
                  ? { label: 'Revenir au projet', onClick: () => navigate(`/project/${projectId}`) }
                  : { label: 'Réessayer', onClick: () => refresh?.() }
              }
            />
          </section>
        }
        label="Chargement de la parcelle…"
        watchdogMs={12000}
      >
        {({ proj: p, plot: pl }) => <PlotPageBody project={p} plot={pl} />}
      </RenderDataGate>
    </main>
  )
}
