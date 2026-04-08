import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { projects } from '../projects.js'

const CURRENT_YEAR = 2026
function plotAnnualRevenue(plot) {
  if (!plot.treeBatches?.length) return plot.trees * 90
  return plot.treeBatches.reduce((sum, b) => {
    const age = CURRENT_YEAR - b.year
    const rate = age < 3 ? 0 : age < 6 ? 45 : age < 10 ? 75 : 90
    return sum + b.count * rate
  }, 0)
}

export default function ProjectPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const proj = projects.find((p) => p.id === id)
  const [search, setSearch] = useState('')

  const callAgency = () => {
    window.location.href = 'tel:+21655123456'
  }

  const finalizeWithExpert = () => {
    const allPlotIds = proj?.plots?.map((p) => p.id) ?? []
    if (allPlotIds.length === 0) return
    navigate(`/project/${proj.id}/visite`, { state: { plotIds: allPlotIds } })
  }

  if (!proj) {
    return (
      <main className="screen screen--app">
        <section className="dashboard-page">
          <TopBar />
          <div className="empty-state">
            <p>Projet introuvable.</p>
            <button className="cta-primary" onClick={() => navigate('/browse')}>
              Retour aux projets
            </button>
          </div>
        </section>
      </main>
    )
  }

  const filteredPlots = proj.plots.filter((p) =>
    search === '' || String(p.id).includes(search.trim()),
  )

  return (
    <main className="screen screen--app">
      <section className="dashboard-page project-page-skin" style={{ paddingBottom: 'calc(6.5rem + env(safe-area-inset-bottom, 0px))' }}>
        <TopBar />

        {/* breadcrumb */}
        <div className="detail-nav">
          <button type="button" className="back-btn" onClick={() => navigate('/browse')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Explorer
          </button>
          <span className="detail-breadcrumb">{proj.city} · {proj.title}</span>
        </div>

        {/* project map */}
        <div className="detail-map-wrap">
          <div className="detail-map-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="3 11 22 2 13 21 11 13 3 11" />
            </svg>
            محفظة المقاسم المتاحة للبيع
          </div>
          <div className="detail-map">
            <iframe title={`Carte ${proj.city}`} src={proj.mapUrl} loading="lazy" allowFullScreen />
          </div>
        </div>

        {/* search + plot cards */}
        <div className="plots-header">
          <h3 className="plots-title">
            Parcelles
            {filteredPlots.length !== proj.plots.length && (
              <span className="plots-count"> · {filteredPlots.length} résultat{filteredPlots.length !== 1 ? 's' : ''}</span>
            )}
          </h3>
          <div className="plot-search-wrap">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="plot-search-input"
              type="text"
              inputMode="numeric"
              placeholder="N° parcelle…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="plot-search-clear" onClick={() => setSearch('')} aria-label="Effacer">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {filteredPlots.length === 0 ? (
          <div className="empty-state" style={{ padding: '2rem 1rem' }}>
            <p>Aucune parcelle ne correspond à « {search} ».</p>
            <button className="link-btn" onClick={() => setSearch('')}>Réinitialiser</button>
          </div>
        ) : (
          <div
            className="plots-cards-grid"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.45rem' }}
          >
            {filteredPlots.map((plot) => {
              return (
                <article key={plot.id} className="plot-mini-card">
                  <header className="plot-mini-card__head">
                    <span className="plot-mini-card__head-lbl">Parcelle</span>
                    <span className="plot-mini-card__head-num">N° {plot.id}</span>
                  </header>

                  <div className="plot-mini-card__line">
                    <span className="plot-mini-card__k">Surface</span>
                    <span className="plot-mini-card__v">{plot.area.toLocaleString()} m²</span>
                  </div>

                  <div className="plot-mini-card__line">
                    <span className="plot-mini-card__k">Prix / arbre</span>
                    <span className="plot-mini-card__v">{plot.pricePerTree.toLocaleString()} TND</span>
                  </div>

                  <p className="plot-mini-card__trees">{plot.trees} arbres</p>

                  <div className="plot-mini-card__total">
                    <div className="plot-mini-card__total-top">
                      <span className="plot-mini-card__total-lbl">Prix total</span>
                      <span className="plot-mini-card__total-num">{plot.totalPrice.toLocaleString()} TND</span>
                    </div>
                    <span className="plot-mini-card__rev">~{plotAnnualRevenue(plot).toLocaleString()} DT/an</span>
                  </div>

                  <div className="plot-mini-card__actions">
                    <button
                      type="button"
                      className="plot-mini-card__btn plot-mini-card__btn--more"
                      onClick={() => navigate(`/project/${proj.id}/plot/${plot.id}`)}
                    >
                      Voir plus
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}

        <div className="project-page-actions">
          <button type="button" className="project-page-btn project-page-btn--gold" onClick={finalizeWithExpert}>
            Prendre de visite
          </button>
          <button type="button" className="project-page-btn project-page-btn--outline" onClick={callAgency}>
            Contacter nous
          </button>
        </div>
      </section>
    </main>
  )
}
