import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { projects } from '../projects.js'
import { GOOGLE_MAP_TUNISIA_OVERVIEW } from '../mapUrls.js'

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
        </div>

        {/* overview map showing all project locations across Tunisia */}
        <div className="browse-overview-map">
          <iframe
            title="Carte des projets"
            src={GOOGLE_MAP_TUNISIA_OVERVIEW}
            loading="lazy"
          />
          <div className="browse-map-pins">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="browse-map-pin"
                onClick={() => navigate(`/project/${p.id}`)}
              >
                📍 {p.city}
              </button>
            ))}
          </div>
        </div>

        <div className="browse-search-bar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                  {/* title row — full width across card */}
                  <div className="proj-card-header">
                    {/* location pin icon */}
                    <svg className="proj-card-map-icon" width="13" height="15" viewBox="0 0 24 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 0C7.589 0 4 3.589 4 8c0 5.25 7.2 13.875 7.508 14.25a.75.75 0 0 0 .984 0C12.8 21.875 20 13.25 20 8c0-4.411-3.589-8-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/>
                    </svg>
                    <h3 className="proj-card-title">{project.title}</h3>
                    <span className="proj-card-region">{project.region}</span>
                  </div>

                  {/* lower row: map thumbnail | details */}
                  <div className="proj-card-lower">
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
                      <div className="proj-card-stats">
                        <div className="proj-stat">
                          <span className="proj-stat-label">Superficie</span>
                          <strong>{project.area}</strong>
                        </div>
                        <div className="proj-stat">
                          <span className="proj-stat-label">Arbres</span>
                          <strong>{totalTrees.toLocaleString()}</strong>
                        </div>
                        <div className="proj-stat">
                          <span className="proj-stat-label">Parcelles</span>
                          <strong>{project.plots.length}</strong>
                        </div>
                        <div className="proj-stat">
                          <span className="proj-stat-label">Année de plantation</span>
                          <strong>{project.year}</strong>
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

                      <div className="proj-card-btns">
                        <button
                          type="button"
                          className="proj-card-cta proj-card-cta--gold"
                          onClick={(e) => { e.stopPropagation(); navigate(`/project/${project.id}`) }}
                        >
                          Voir les parcelles →
                        </button>
                      </div>
                    </div>
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
