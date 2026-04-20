import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { usePublicBrowseProjects } from '../lib/useSupabase.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'

const GOOGLE_MAP_TUNISIA_OVERVIEW =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d800000!2d9.5!3d35.5!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zMzXCsDMwJzAwLjAiTiA5wrAzMCcwMC4wIkU!5e0!3m2!1sfr!2stn!4v1'

// Plan 04 §3.6 — extracted skeleton so the RenderDataGate path stays tidy.
// Classes unchanged so the shimmer visual matches the prior inline markup.
function BrowsePageSkeleton() {
  return (
    <div className="sk-grid" aria-busy="true" aria-live="polite">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="sk-card sk-card--light">
          <div className="sk sk-line sk-line--title" />
          <div className="sk sk-map" />
          <div className="sk sk-line" style={{ width: '70%' }} />
          <div className="sk sk-line" style={{ width: '45%' }} />
          <div className="sk sk-line sk-line--badge" />
        </div>
      ))}
    </div>
  )
}

export default function BrowsePage() {
  const navigate = useNavigate()
  // Plan 04 §3.6 — the hook already surfaces `error`; the page previously
  // ignored it and fell through to the "search empty" branch, which made
  // network failures look like "the catalog is empty". Route error->ErrorPanel.
  const { projects: catalogProjects, loading: catalogLoading, error: catalogError, refresh: refreshCatalog } = usePublicBrowseProjects()
  const [query, setQuery] = useState('')

  const filtered = useMemo(
    () =>
      catalogProjects.filter((p) => {
        const q = query.toLowerCase()
        return (
          p.city.toLowerCase().includes(q) ||
          p.region.toLowerCase().includes(q) ||
          p.title.toLowerCase().includes(q)
        )
      }),
    [catalogProjects, query],
  )

  const hasData = Array.isArray(catalogProjects) && catalogProjects.length > 0
  const isSearching = query.trim().length > 0
  // Only show the initial skeleton when we truly have nothing yet. A pending
  // background refresh with cached data present should not blank the grid.
  const gateLoading = catalogLoading && !hasData
  // Empty condition limited to "active search with no matches" — a legitimate
  // "no projects at all" state still renders the (empty) grid rather than the
  // reset-search CTA, matching prior business behavior.
  const isEmptyGate = (d) => hasData && Array.isArray(d) && d.length === 0 && isSearching

  return (
    <main className="screen screen--app browse-page-bg">
      <div className="browse-bg-orb browse-bg-orb--1" aria-hidden="true" />
      <div className="browse-bg-orb browse-bg-orb--2" aria-hidden="true" />
      <div className="browse-bg-orb browse-bg-orb--3" aria-hidden="true" />
      <section className="dashboard-page">
        <TopBar />

        <div className="browse-greeting">
          <p className="browse-greeting-hello">Bonjour</p>
        </div>

        <div className="browse-overview-map">
          <iframe title="Carte des projets" src={GOOGLE_MAP_TUNISIA_OVERVIEW} loading="lazy" />
        </div>

        <div className="browse-search-bar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input className="search-input" type="text" placeholder="Rechercher par ville ou région…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <RenderDataGate
          loading={gateLoading}
          error={catalogError}
          data={filtered}
          isEmpty={isEmptyGate}
          onRetry={refreshCatalog}
          skeleton={<BrowsePageSkeleton />}
          label="Chargement du catalogue…"
          watchdogMs={12000}
          empty={
            <EmptyState
              title="Aucun projet ne correspond à votre recherche."
              action={{ label: 'Réinitialiser', onClick: () => setQuery('') }}
            />
          }
        >
          {(list) => (
            <div className="projects-grid">
              {list.map((project) => {
                const totalTrees = project.plots.reduce((s, p) => s + p.trees, 0)
                const minPrice = Math.min(...project.plots.map((p) => p.pricePerTree))
                const maxPrice = Math.max(...project.plots.map((p) => p.pricePerTree))
                return (
                  <article key={project.id} className="proj-card" onClick={() => navigate(`/project/${project.id}`)}>
                    <div className="proj-card-header">
                      <svg className="proj-card-map-icon" width="13" height="15" viewBox="0 0 24 28" fill="currentColor"><path d="M12 0C7.589 0 4 3.589 4 8c0 5.25 7.2 13.875 7.508 14.25a.75.75 0 0 0 .984 0C12.8 21.875 20 13.25 20 8c0-4.411-3.589-8-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/></svg>
                      <h3 className="proj-card-title">{project.title}</h3>
                      <span className="proj-card-region">{project.region}</span>
                    </div>
                    <div className="proj-card-lower">
                      <div className="proj-card-map">
                        {project.mapUrl ? (
                          <iframe title={`Carte ${project.city}`} src={project.mapUrl} loading="lazy" tabIndex={-1} />
                        ) : (
                          <div className="proj-card-map-fallback" aria-hidden="true" />
                        )}
                        <span className="proj-card-badge">{project.city}</span>
                      </div>
                      <div className="proj-card-body">
                        <div className="proj-card-stats">
                          <div className="proj-stat"><span className="proj-stat-label">Superficie</span><strong>{project.area}</strong></div>
                          <div className="proj-stat"><span className="proj-stat-label">Arbres</span><strong>{totalTrees.toLocaleString()}</strong></div>
                          <div className="proj-stat"><span className="proj-stat-label">Parcelles</span><strong>{project.plots.length}</strong></div>
                          <div className="proj-stat"><span className="proj-stat-label">Année de plantation</span><strong>{project.year}</strong></div>
                          <div className="proj-stat"><span className="proj-stat-label">Prix / arbre</span><strong>{minPrice === maxPrice ? `${minPrice.toLocaleString()} TND` : `${minPrice.toLocaleString()} – ${maxPrice.toLocaleString()} TND`}</strong></div>
                        </div>
                        <div className="proj-card-btns">
                          <button type="button" className="proj-card-cta" onClick={(e) => { e.stopPropagation(); navigate(`/project/${project.id}`) }}>Voir plus</button>
                          <button type="button" className="proj-card-cta proj-card-cta--gold" onClick={(e) => { e.stopPropagation(); const ids = project.plots.filter(p => p.status === 'available').map(p => p.id); navigate(ids.length ? `/project/${project.id}/visite` : `/project/${project.id}`, { state: { plotIds: ids } }) }}>Prendre un rendez-vous</button>
                        </div>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </RenderDataGate>
      </section>
    </main>
  )
}
