import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { usePublicProjectDetail } from '../lib/useSupabase.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'

const CURRENT_YEAR = 2026
function plotAnnualRevenue(plot) {
  if (!plot.treeBatches?.length) return plot.trees * 90
  return plot.treeBatches.reduce((sum, b) => {
    const age = CURRENT_YEAR - b.year
    const rate = age < 3 ? 0 : age < 6 ? 45 : age < 10 ? 75 : 90
    return sum + b.count * rate
  }, 0)
}
function plotStatusLabel(s) { return s === 'sold' ? 'Vendue' : s === 'reserved' ? 'Réservée' : 'Disponible' }
function plotStatusColor(s) { return s === 'sold' ? '#e74c3c' : s === 'reserved' ? '#f5c842' : '#a8cc50' }

// Plan 04 §3.5 — isolated skeleton so rapid navigation between projects
// presents a fresh shimmer frame instead of the previously-rendered detail.
function ProjectPageSkeleton() {
  return (
    <>
      <div className="sk sk-line sk-line--title" style={{ width: '40%' }} />
      <div className="sk sk-map" style={{ margin: '12px 0 20px' }} />
      <div className="sk sk-line sk-line--title" style={{ width: '30%' }} />
      <div className="sk-grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="sk-card sk-card--light">
            <div className="sk sk-line" style={{ width: '50%' }} />
            <div className="sk sk-line" style={{ width: '80%' }} />
            <div className="sk sk-line" style={{ width: '60%' }} />
            <div className="sk sk-line sk-line--badge" />
          </div>
        ))}
      </div>
    </>
  )
}

function ProjectPageBody({ project: proj }) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const filteredPlots = proj.plots.filter((p) => {
    if (search === '') return true
    const q = search.trim().toLowerCase()
    return String(p.id).toLowerCase().includes(q) || String(p.label ?? '').toLowerCase().includes(q)
  })
  const availablePlotCount = proj.plots.filter((p) => p.status === 'available').length

  return (
    <section className="dashboard-page project-page-skin plot-page-skin project-page-safe-pad">
      <TopBar />
      <div className="detail-nav">
        <button type="button" className="back-btn" onClick={() => navigate('/browse')}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          Explorer
        </button>
        <span className="detail-breadcrumb">{proj.city} · {proj.title}</span>
      </div>

      <div className="detail-map-wrap">
        <div className="detail-map-label">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11" /></svg>
          Parcelles disponibles
        </div>
        <div className="detail-map"><iframe title={`Carte ${proj.city}`} src={proj.mapUrl} loading="lazy" allowFullScreen /></div>
      </div>

      <div className="plots-header">
        <h3 className="plots-title">Parcelles{filteredPlots.length !== proj.plots.length && <span className="plots-count"> · {filteredPlots.length} résultat{filteredPlots.length !== 1 ? 's' : ''}</span>}</h3>
        <div className="plot-search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input className="plot-search-input" type="text" inputMode="text" placeholder="N° parcelle…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button className="plot-search-clear" onClick={() => setSearch('')} aria-label="Effacer"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>}
        </div>
      </div>

      {filteredPlots.length === 0 ? (
        <EmptyState
          title="Aucune parcelle ne correspond."
          action={{ label: 'Réinitialiser', onClick: () => setSearch('') }}
        />
      ) : (
        <div className="plots-cards-grid plots-cards-grid--two">
          {filteredPlots.map((plot) => (
            <article key={plot.id} className="plot-mini-card">
              <header className="plot-mini-card__head"><span className="plot-mini-card__head-lbl">Parcelle</span><span className="plot-mini-card__head-num">N° {plot.label ?? plot.id}</span><span className="plot-mini-card__status" style={{ color: plotStatusColor(plot.status), fontSize: '0.65rem', fontWeight: 600 }}>{plotStatusLabel(plot.status)}</span></header>
              <div className="plot-mini-card__line"><span className="plot-mini-card__k">Surface</span><span className="plot-mini-card__v">{plot.area.toLocaleString()} m²</span></div>
              <div className="plot-mini-card__line"><span className="plot-mini-card__k">Prix / arbre</span><span className="plot-mini-card__v">{plot.pricePerTree.toLocaleString()} TND</span></div>
              <p className="plot-mini-card__trees">{plot.trees} arbres</p>
              <div className="plot-mini-card__total">
                <div className="plot-mini-card__total-top"><span className="plot-mini-card__total-lbl">Prix total</span><span className="plot-mini-card__total-num">{plot.totalPrice.toLocaleString()} TND</span></div>
                <span className="plot-mini-card__rev">~{plotAnnualRevenue(plot).toLocaleString()} DT/an</span>
              </div>
              <div className="plot-mini-card__actions">
                <button type="button" className="plot-mini-card__btn plot-mini-card__btn--more" onClick={() => navigate(`/project/${proj.id}/plot/${plot.id}`)}>Voir plus</button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="plot-page-actions">
        <button type="button" className="plot-page-btn plot-page-btn--gold" disabled={availablePlotCount === 0} onClick={() => { const ids = proj.plots.filter(p => p.status === 'available').map(p => p.id); navigate(`/project/${proj.id}/visite`, { state: { plotIds: ids } }) }}>
          Prendre un rendez-vous
        </button>
      </div>
    </section>
  )
}

export default function ProjectPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { project: proj, loading, refresh } = usePublicProjectDetail(id)

  // Plan 04 §3.5 — rapid-nav race. When `id` in the URL changes faster than
  // the underlying fetch resolves, the hook briefly still holds the previous
  // project's data. Treat stale cross-id data as loading so we never render
  // the wrong project page for an instant.
  const idMatches = Boolean(proj) && String(proj.id) === String(id)
  const showData = !loading && idMatches

  // Grace window: hold the skeleton up for a few seconds when the project
  // hasn't surfaced yet (stale cache, cold public view, realtime not ready).
  // This stops the "Projet introuvable" empty state from flashing before the
  // project actually arrives.
  const GRACE_MS = 5000
  const RETRY_DELAYS = [300, 900, 1800, 3000]
  const [graceExpired, setGraceExpired] = useState(false)
  const graceKeyRef = useRef('')
  useEffect(() => {
    if (graceKeyRef.current === id) return undefined
    graceKeyRef.current = id
    setGraceExpired(false)
    const t = window.setTimeout(() => setGraceExpired(true), GRACE_MS)
    return () => window.clearTimeout(t)
  }, [id])

  const retryIndexRef = useRef({ key: '', idx: 0 })
  useEffect(() => {
    if (retryIndexRef.current.key !== id) retryIndexRef.current = { key: id, idx: 0 }
    if (graceExpired) return undefined
    if (loading || idMatches) return undefined
    if (!id) return undefined
    const idx = retryIndexRef.current.idx
    if (idx >= RETRY_DELAYS.length) return undefined
    const t = window.setTimeout(() => {
      retryIndexRef.current.idx = idx + 1
      refresh?.()
    }, RETRY_DELAYS[idx])
    return () => window.clearTimeout(t)
  }, [loading, idMatches, id, refresh, graceExpired])

  const showLoading =
    loading
    || (Boolean(proj) && !idMatches)
    || (!proj && !loading && Boolean(id) && !graceExpired)
  // Treat "no id at all" or "hook settled with null past the grace window" as
  // the empty/not-found state. The RenderDataGate empty branch handles the
  // "projet introuvable" panel so we get a single consistent layout.
  const gateData = showData ? proj : null
  const gateLoading = showLoading && !showData
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
            <ProjectPageSkeleton />
          </section>
        }
        empty={
          <section className="dashboard-page">
            <TopBar />
            <EmptyState
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a8cc50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 6v15l7-3 8 3 7-3V3l-7 3-8-3-7 3z"/>
                  <path d="M8 3v15"/>
                  <path d="M16 6v15"/>
                </svg>
              }
              title="Projet introuvable"
              description="Ce projet n'est plus disponible publiquement. Il est peut-être complet, archivé, ou le lien que vous avez ouvert est obsolète."
              action={{ label: 'Explorer les projets', onClick: () => navigate('/browse') }}
              secondary={{ label: 'Réessayer', onClick: () => refresh?.() }}
            />
          </section>
        }
        label="Chargement du projet…"
        watchdogMs={12000}
      >
        {(project) => <ProjectPageBody project={project} />}
      </RenderDataGate>
    </main>
  )
}
