import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePublicBrowseProjects } from '../lib/useSupabase.js'
import { useAuth } from '../lib/AuthContext.jsx'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import DashboardShell from '../components/DashboardShell.jsx'
import './dashboard-page.css'

const GOOGLE_MAP_TUNISIA_OVERVIEW =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d800000!2d9.5!3d35.5!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zMzXCsDMwJzAwLjAiTiA5wrAzMCcwMC4wIkU!5e0!3m2!1sfr!2stn!4v1'

const REGION_FILTERS = [
  { key: 'all', label: 'Tous' },
  { key: 'nord', label: 'Nord', match: ['tunis', 'ariana', 'ben arous', 'nabeul', 'bizerte', 'manouba', 'beja', 'jendouba'] },
  { key: 'sahel', label: 'Sahel', match: ['sousse', 'monastir', 'mahdia'] },
  { key: 'sud', label: 'Sud', match: ['sfax', 'gabes', 'medenine', 'tataouine', 'gafsa', 'kebili', 'tozeur'] },
]

function matchRegion(project, key) {
  if (key === 'all') return true
  const bucket = REGION_FILTERS.find((r) => r.key === key)
  if (!bucket?.match) return true
  const hay = `${project.city || ''} ${project.region || ''}`.toLowerCase()
  return bucket.match.some((s) => hay.includes(s))
}

function BrowsePageSkeleton() {
  return (
    <div className="xp-projects" aria-busy="true" aria-live="polite">
      {[0, 1, 2].map((i) => (
        <div key={i} className="xp-proj" style={{ opacity: 0.6 }}>
          <div className="xp-thumb xp-thumb-fallback" />
          <div className="xp-body">
            <div className="xp-head">
              <div className="sk sk-line sk-line--title" style={{ width: '60%' }} />
            </div>
            <div className="xp-stats">
              {[0, 1, 2, 3, 4].map((j) => (
                <div key={j}>
                  <div className="sk sk-line" style={{ width: '60%', height: 10 }} />
                  <div className="sk sk-line sk-line--title" style={{ width: '80%' }} />
                </div>
              ))}
            </div>
          </div>
          <div className="xp-ctas">
            <div className="sk sk-line" style={{ height: 40, width: 120 }} />
            <div className="sk sk-line" style={{ height: 40, width: 120 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function BrowsePage() {
  const navigate = useNavigate()
  const { user, adminUser } = useAuth()
  const displayName = adminUser?.name || user?.firstname || user?.name || ''
  const greetingName = displayName ? displayName.split(/\s+/)[0] : null
  const initials =
    (displayName || 'ZB')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'ZB'

  const { projects: catalogProjects, loading: catalogLoading, error: catalogError, refresh: refreshCatalog } = usePublicBrowseProjects()
  const [query, setQuery] = useState('')
  const [regionFilter, setRegionFilter] = useState('all')

  const filtered = useMemo(
    () =>
      catalogProjects.filter((p) => {
        if (!matchRegion(p, regionFilter)) return false
        if (query.trim() === '') return true
        const q = query.toLowerCase()
        return (
          (p.city || '').toLowerCase().includes(q) ||
          (p.region || '').toLowerCase().includes(q) ||
          (p.title || '').toLowerCase().includes(q)
        )
      }),
    [catalogProjects, query, regionFilter],
  )

  const hasData = Array.isArray(catalogProjects) && catalogProjects.length > 0
  const isSearching = query.trim().length > 0 || regionFilter !== 'all'
  const gateLoading = catalogLoading && !hasData
  const isEmptyGate = (d) => hasData && Array.isArray(d) && d.length === 0 && isSearching

  // Aggregate mini-stats for the hero.
  const totalProjects = catalogProjects.length
  const totalPlots = catalogProjects.reduce((s, p) => s + (p.plots?.length || 0), 0)
  const totalTrees = catalogProjects.reduce(
    (s, p) => s + (p.plots || []).reduce((ss, pp) => ss + (pp.trees || 0), 0),
    0,
  )
  const totalAvailable = catalogProjects.reduce(
    (s, p) => s + (p.plots || []).filter((pp) => pp.status === 'available').length,
    0,
  )

  return (
    <DashboardShell active="browse">
      <div className="xp-shell xp-shell--embedded">
        <div className="xp-header">
          <h1>{greetingName ? `Bonjour ${greetingName} 👋` : 'Explorer'}</h1>
          <div className="xp-sub">Projets en Tunisie.</div>
        </div>

        {/* Hero map */}
        <div className="xp-hero-map">
          <div className="xp-map-viz">
            <iframe title="Carte des projets" src={GOOGLE_MAP_TUNISIA_OVERVIEW} loading="lazy" />
            <div className="xp-map-legend">
              <span className="xp-map-legend-d" /> {totalProjects} projet{totalProjects !== 1 ? 's' : ''} · {totalPlots} parcelles
            </div>
          </div>
          <div className="xp-hero-copy">
            <div className="xp-eyebrow">Carte interactive</div>
            <h2>Trouvez votre prochain olivier.</h2>
            <p>Disponible en parts ou en parcelles entières.</p>
            <div className="xp-mini-stats">
              <div>
                <div className="xp-k">Projets</div>
                <div className="xp-v">{totalProjects}</div>
              </div>
              <div>
                <div className="xp-k">Parcelles</div>
                <div className="xp-v xp-blue">{totalAvailable}</div>
              </div>
              <div>
                <div className="xp-k">Arbres</div>
                <div className="xp-v">{totalTrees.toLocaleString('fr-FR')}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Search + filters */}
        <div className="xp-search-row">
          <div className="xp-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
            <input
              type="text"
              placeholder="Rechercher (ville, région, variété)…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button type="button" className="xp-search-clear" onClick={() => setQuery('')} aria-label="Effacer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            )}
          </div>
          <div className="xp-filter-pills">
            {REGION_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`xp-pill${regionFilter === f.key ? ' xp-pill-active' : ''}`}
                onClick={() => setRegionFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
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
              title="Aucun résultat."
              action={{ label: 'Réinitialiser', onClick: () => { setQuery(''); setRegionFilter('all') } }}
            />
          }
        >
          {(list) => (
            <div className="xp-projects">
              {list.map((project) => {
                const projectTrees = (project.plots || []).reduce((s, p) => s + (p.trees || 0), 0)
                const prices = (project.plots || []).map((p) => p.pricePerTree).filter((x) => Number.isFinite(x))
                const minPrice = prices.length ? Math.min(...prices) : 0
                const maxPrice = prices.length ? Math.max(...prices) : 0
                const priceLabel = minPrice === maxPrice
                  ? minPrice.toLocaleString('fr-FR')
                  : `${minPrice.toLocaleString('fr-FR')}–${maxPrice.toLocaleString('fr-FR')}`
                return (
                  <article
                    key={project.id}
                    className="xp-proj"
                    onClick={() => navigate(`/project/${project.id}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigate(`/project/${project.id}`)
                      }
                    }}
                  >
                    <div className="xp-thumb">
                      {project.mapUrl ? (
                        <iframe title={`Carte ${project.city}`} src={project.mapUrl} loading="lazy" tabIndex={-1} />
                      ) : (
                        <div className="xp-thumb-fallback" aria-hidden />
                      )}
                      {project.city && (
                        <div className="xp-thumb-badge">
                          <span className="xp-thumb-badge-d" /> {project.city}
                        </div>
                      )}
                    </div>
                    <div className="xp-body">
                      <div className="xp-head">
                        <h3 className="xp-title">
                          <svg className="xp-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 22s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>
                          {project.title}
                        </h3>
                        {project.region && <span className="xp-loc-pill">{project.region}</span>}
                      </div>
                      <div className="xp-stats">
                        {project.area != null && (
                          <div>
                            <div className="xp-k">Superficie</div>
                            <div className="xp-v">{project.area}{typeof project.area === 'number' && <span className="xp-u">Ha</span>}</div>
                          </div>
                        )}
                        <div>
                          <div className="xp-k">Arbres</div>
                          <div className="xp-v">{projectTrees.toLocaleString('fr-FR')}</div>
                        </div>
                        <div>
                          <div className="xp-k">Parcelles</div>
                          <div className="xp-v">{project.plots?.length || 0}</div>
                        </div>
                        {project.year && (
                          <div>
                            <div className="xp-k">Plantation</div>
                            <div className="xp-v">{project.year}</div>
                          </div>
                        )}
                        {prices.length > 0 && (
                          <div>
                            <div className="xp-k">Prix / arbre</div>
                            <div className="xp-v xp-blue">{priceLabel}<span className="xp-u">TND</span></div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="xp-ctas" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="xp-btn xp-btn-primary" onClick={() => navigate(`/project/${project.id}`)}>
                        Voir plus
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </RenderDataGate>
      </div>
    </DashboardShell>
  )
}
