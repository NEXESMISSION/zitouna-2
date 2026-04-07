import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { projects } from '../projects.js'

export default function BrowsePage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const filtered = projects.filter(
    (p) =>
      p.city.toLowerCase().includes(query.toLowerCase()) ||
      p.region.toLowerCase().includes(query.toLowerCase()) ||
      p.title.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <main className="screen screen--app">
      <section className="dashboard-page">
        <TopBar />

        <div className="browse-greeting">
          <p className="browse-greeting-hello">Bonjour, Lassaad</p>
          <p className="browse-greeting-sub">Voici l&apos;état de votre portefeuille d&apos;oliviers</p>
        </div>

        <div className="browse-header">
          <div>
            <h2 className="page-title">Explorer les projets</h2>
            <p className="page-subtitle">
              {filtered.length} projet{filtered.length !== 1 ? 's' : ''} disponible{filtered.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="search-wrap">
            <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="search-input"
              type="text"
              placeholder="Rechercher par ville ou région…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            <p>Aucun projet ne correspond à votre recherche.</p>
            <button className="link-btn" onClick={() => setQuery('')}>Réinitialiser</button>
          </div>
        ) : (
          <div className="projects-grid">
            {filtered.map((project) => {
              const totalTrees = project.plots.reduce((s, p) => s + p.trees, 0)
              const minPrice = Math.min(...project.plots.map((p) => p.pricePerTree))
              const maxPrice = Math.max(...project.plots.map((p) => p.pricePerTree))
              return (
                <article
                  key={project.id}
                  className="proj-card"
                  onClick={() => navigate(`/project/${project.id}`)}
                >
                  <div className="proj-card-map">
                    <iframe
                      title={`Carte ${project.city}`}
                      src={project.mapUrl}
                      loading="lazy"
                      tabIndex={-1}
                    />
                    <span className="proj-card-badge">{project.city}</span>
                  </div>

                  <div className="proj-card-body">
                    <div className="proj-card-top">
                      <h3 className="proj-card-title">{project.title}</h3>
                      <span className="proj-card-year">{project.year}</span>
                    </div>

                    <div className="proj-card-stats">
                      <div className="proj-stat">
                        <span className="proj-stat-label">Superficie</span>
                        <strong>{project.area}</strong>
                      </div>
                      <div className="proj-stat">
                        <span className="proj-stat-label">Arbres disponibles</span>
                        <strong>{totalTrees.toLocaleString()}</strong>
                      </div>
                      <div className="proj-stat">
                        <span className="proj-stat-label">Parcelles</span>
                        <strong>{project.plots.length}</strong>
                      </div>
                      <div className="proj-stat">
                        <span className="proj-stat-label">Prix / arbre</span>
                        <strong>
                          {minPrice === maxPrice
                            ? `${minPrice.toLocaleString()} TND`
                            : `${minPrice.toLocaleString()} – ${maxPrice.toLocaleString()} TND`}
                        </strong>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="proj-card-cta"
                      onClick={(e) => {
                        e.stopPropagation()
                        navigate(`/project/${project.id}`)
                      }}
                    >
                      Voir les parcelles →
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </main>
  )
}
