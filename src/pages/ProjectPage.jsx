import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { projects } from '../projects.js'

export default function ProjectPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const proj = projects.find((p) => p.id === id)
  const [search, setSearch] = useState('')

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

  const totalTrees = proj.plots.reduce((s, p) => s + p.trees, 0)
  const totalArea  = proj.plots.reduce((s, p) => s + p.area, 0)

  const filteredPlots = proj.plots.filter((p) =>
    search === '' || String(p.id).includes(search.trim()),
  )

  return (
    <main className="screen screen--app">
      <section className="dashboard-page">
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

        {/* hero stats */}
        <div className="proj-hero-stats">
          <div className="proj-hero-stat">
            <span>{proj.area}</span>
            <label>Superficie</label>
          </div>
          <div className="proj-hero-stat">
            <span>{totalTrees.toLocaleString()}</span>
            <label>Arbres disponibles</label>
          </div>
          <div className="proj-hero-stat">
            <span>{proj.plots.length}</span>
            <label>Parcelles</label>
          </div>
          <div className="proj-hero-stat">
            <span>{proj.year}</span>
            <label>Plantation</label>
          </div>
          <div className="proj-hero-stat">
            <span>{totalArea.toLocaleString()} m²</span>
            <label>Surface totale</label>
          </div>
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
          <div className="plot-cards-grid">
            {filteredPlots.map((plot, i) => (
              <div key={plot.id} className="plot-card">
                {/* mini map */}
                <div className="plot-card-map">
                  <iframe
                    title={`Parcelle ${plot.id}`}
                    src={plot.mapUrl}
                    loading="lazy"
                    tabIndex={-1}
                  />
                </div>

                <div className="plot-card-body">
                  <div className="plot-card-top">
                    <span className="plot-card-num">Parcelle {i + 1}</span>
                    <span className="plot-card-id">#{plot.id}</span>
                  </div>
                  <div className="plot-card-trees">
                    <strong>{plot.trees}</strong>
                    <span>arbres</span>
                  </div>
                  <div className="plot-card-details">
                    <div className="plot-card-row">
                      <span>Surface</span>
                      <strong>{plot.area.toLocaleString()} m²</strong>
                    </div>
                    <div className="plot-card-row">
                      <span>Prix / arbre</span>
                      <strong>{plot.pricePerTree.toLocaleString()} TND</strong>
                    </div>
                    <div className="plot-card-row">
                      <span>Prix total</span>
                      <strong className="green-text">{plot.totalPrice.toLocaleString()} TND</strong>
                    </div>
                    <div className="plot-card-row">
                      <span>Revenu / an</span>
                      <strong className="green-text">~{(plot.trees * 90).toLocaleString()} DT</strong>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="plot-detail-btn"
                    onClick={() => navigate(`/project/${proj.id}/plot/${plot.id}`)}
                  >
                    Voir le détail →
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
