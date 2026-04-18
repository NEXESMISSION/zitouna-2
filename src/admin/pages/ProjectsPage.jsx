import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProjects, useOffers } from '../../lib/useSupabase.js'
import { upsertProject } from '../../lib/db.js'
import { emitInvalidate } from '../../lib/dataEvents.js'
import AdminModal from '../components/AdminModal.jsx'
import './zitouna-admin-page.css'
import './projects-admin.css'

const EMPTY_FORM = { title: '', city: '', region: '', area: '', year: String(new Date().getFullYear()), mapUrl: '' }

// Page-scoped styles for a card grid and a few visual polish pieces the
// design system tokens don't cover. Kept purely additive & `.pj-` prefixed so
// it never competes with shared admin CSS or the `.zadm-*` layer.
const LOCAL_STYLES = `
.pj-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.pj-project-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition: border-color 120ms cubic-bezier(0.2, 0.8, 0.2, 1),
              box-shadow 120ms cubic-bezier(0.2, 0.8, 0.2, 1),
              transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pj-project-card:hover {
  border-color: #2563eb;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}
.pj-project-card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
  border-color: #2563eb;
}
.pj-project-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.pj-project-card__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #0f172a;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.pj-project-card__meta {
  margin: 4px 0 0;
  font-size: 13px;
  color: #475569;
  line-height: 1.45;
}
.pj-project-card__pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pj-project-card__foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid #e2e8f0;
  font-size: 12px;
  color: #94a3b8;
}
.pj-project-card__year {
  font-weight: 600;
  color: #0f172a;
}
`

export default function ProjectsPage() {
  const navigate = useNavigate()
  const { projects, loading } = useProjects()
  const { offersByProject } = useOffers()
  const [query, setQuery] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(p => (p.title || '').toLowerCase().includes(q) || (p.city || '').toLowerCase().includes(q) || (p.region || '').toLowerCase().includes(q))
  }, [projects, query])

  const totalParcels = projects.reduce((s, p) => s + (p.plots?.length || 0), 0)
  const totalTrees = projects.reduce((s, p) => s + (p.plots || []).reduce((t, pl) => t + (pl.trees || 0), 0), 0)

  const createProject = async () => {
    if (!form.title.trim() || !form.city.trim() || saving) return
    setSaving(true)
    try {
      await upsertProject({
        title: form.title.trim(),
        city: form.city.trim(),
        region: form.region.trim(),
        area: form.area.trim() || '-',
        year: Number(form.year.trim()) || new Date().getFullYear(),
        mapUrl: form.mapUrl.trim(),
      })
      emitInvalidate('projects')
      setShowCreate(false)
      setForm(EMPTY_FORM)
    } catch (e) {
      console.error('createProject', e)
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = Boolean(form.title.trim() && form.city.trim()) && !saving
  const hasQuery = query.trim().length > 0

  return (
    <div className="zadm-page" dir="ltr">
      <style>{LOCAL_STYLES}</style>

      <header className="zadm-page__head">
        <div className="zadm-page__head-text">
          <h1 className="zadm-page__title">Projets &amp; parcelles</h1>
          <p className="zadm-page__subtitle">Vue d’ensemble de tous les projets fonciers</p>
        </div>
        <div className="zadm-page__head-actions">
          <button
            type="button"
            className="zadm-btn zadm-btn--ghost zadm-btn--sm"
            onClick={() => navigate('/admin')}
          >
            ← Retour
          </button>
          <button
            type="button"
            className="zadm-btn zadm-btn--primary"
            onClick={() => { setForm(EMPTY_FORM); setShowCreate(true) }}
          >
            + Nouveau projet
          </button>
        </div>
      </header>

      <div className="zadm-page__body">

        {/* KPI overview */}
        <section className="zadm-kpi-grid" aria-label="Indicateurs globaux">
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">Projets</span>
            <span className="zadm-kpi__value">{projects.length}</span>
          </div>
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">Parcelles</span>
            <span className="zadm-kpi__value">{totalParcels}</span>
          </div>
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">Arbres</span>
            <span className="zadm-kpi__value">{totalTrees.toLocaleString('fr-FR')}</span>
          </div>
        </section>

        {/* Filters */}
        <section className="zadm-card">
          <div className="zadm-card__body">
            <div className="zadm-filters" role="search">
              <div className="zadm-search">
                <span className="zadm-search__icon" aria-hidden>🔎</span>
                <input
                  type="search"
                  className="zadm-search__input"
                  placeholder="Rechercher un projet, une ville, une région…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  aria-label="Rechercher un projet"
                />
              </div>
              {hasQuery && (
                <button
                  type="button"
                  className="zadm-btn zadm-btn--ghost zadm-btn--sm"
                  onClick={() => setQuery('')}
                >
                  Effacer
                </button>
              )}
              <div className="zadm-spacer" />
              <span className="zadm-muted" style={{ fontSize: 13 }}>
                {filtered.length} résultat{filtered.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </section>

        {/* Projects list */}
        {loading ? (
          <div className="zadm-loading" role="status" aria-live="polite">
            <span className="zadm-loading__spinner" aria-hidden />
            <span>Chargement des projets…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="zadm-empty" role="status">
            <div className="zadm-empty__icon" aria-hidden>📭</div>
            {hasQuery ? (
              <>
                <p className="zadm-empty__title">Aucun projet trouvé</p>
                <p className="zadm-empty__hint">Aucun résultat pour « {query} ». Essayez un autre mot-clé.</p>
                <div className="zadm-empty__actions">
                  <button type="button" className="zadm-btn zadm-btn--secondary" onClick={() => setQuery('')}>
                    Effacer la recherche
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="zadm-empty__title">Aucun projet — créer le premier</p>
                <p className="zadm-empty__hint">Commencez par ajouter votre premier projet foncier.</p>
                <div className="zadm-empty__actions">
                  <button
                    type="button"
                    className="zadm-btn zadm-btn--primary"
                    onClick={() => { setForm(EMPTY_FORM); setShowCreate(true) }}
                  >
                    + Créer un projet
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <section className="pj-card-grid" aria-label="Liste des projets">
            {filtered.map(project => {
              const pl = project.plots || []
              const sold = pl.filter(p => p.status === 'sold').length
              const avail = pl.length - sold
              const offers = offersByProject[project.id] || []
              const locLabel = `${project.city || ''}${project.region ? `, ${project.region}` : ''}`
              return (
                <button
                  key={project.id}
                  type="button"
                  className="pj-project-card"
                  onClick={() => navigate(`/admin/projects/${project.id}`)}
                  aria-label={`Ouvrir le projet ${project.title}`}
                  title={`Ouvrir ${project.title}`}
                >
                  <div className="pj-project-card__head">
                    <div style={{ minWidth: 0 }}>
                      <h3 className="pj-project-card__title zadm-truncate">{project.title}</h3>
                      <p className="pj-project-card__meta zadm-truncate">
                        {locLabel || '—'} · {project.area || '—'}
                      </p>
                    </div>
                  </div>
                  <div className="pj-project-card__pills" aria-hidden>
                    <span className="zadm-pill zadm-pill--neutral" title={`${pl.length} parcelles au total`}>
                      {pl.length} parc.
                    </span>
                    <span className="zadm-pill zadm-pill--success" title={`${avail} parcelles disponibles`}>
                      {avail} dispo
                    </span>
                    {offers.length > 0 && (
                      <span className="zadm-pill zadm-pill--primary" title={`${offers.length} offres actives`}>
                        {offers.length} offres
                      </span>
                    )}
                  </div>
                  <div className="pj-project-card__foot">
                    <span className="pj-project-card__year">{project.year}</span>
                    <span aria-hidden>›</span>
                  </div>
                </button>
              )
            })}
          </section>
        )}
      </div>

      {/* Create modal */}
      <AdminModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Nouveau projet"
        footer={(
          <>
            <button type="button" className="zadm-btn zadm-btn--ghost" onClick={() => setShowCreate(false)}>
              Annuler
            </button>
            <button type="button" className="zadm-btn zadm-btn--primary" disabled={!canSubmit} onClick={createProject}>
              {saving ? 'Création…' : 'Créer le projet'}
            </button>
          </>
        )}
      >
        <div className="zadm-form">
          <p className="zadm-form__help">Les champs marqués d’un * sont obligatoires.</p>

          <div className="zadm-form__row">
            <label className="zadm-form__label" htmlFor="pj-title">Nom du projet *</label>
            <input
              id="pj-title"
              className="zadm-form__input"
              placeholder="Ex : Domaine El Yasmine"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            />
          </div>

          <div className="zadm-form__row">
            <label className="zadm-form__label" htmlFor="pj-city">Ville *</label>
            <input
              id="pj-city"
              className="zadm-form__input"
              placeholder="Ex : Borj Cedria"
              value={form.city}
              onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
            />
          </div>

          <div className="zadm-form__grid">
            <div className="zadm-form__row">
              <label className="zadm-form__label" htmlFor="pj-region">Région</label>
              <input
                id="pj-region"
                className="zadm-form__input"
                placeholder="Ex : Ben Arous"
                value={form.region}
                onChange={e => setForm(f => ({ ...f, region: e.target.value }))}
              />
            </div>
            <div className="zadm-form__row">
              <label className="zadm-form__label" htmlFor="pj-area">Superficie</label>
              <input
                id="pj-area"
                className="zadm-form__input"
                placeholder="Ex : 25 Ha"
                value={form.area}
                onChange={e => setForm(f => ({ ...f, area: e.target.value }))}
              />
            </div>
          </div>

          <div className="zadm-form__grid">
            <div className="zadm-form__row">
              <label className="zadm-form__label" htmlFor="pj-year">Année</label>
              <input
                id="pj-year"
                className="zadm-form__input"
                type="number"
                placeholder="2026"
                value={form.year}
                onChange={e => setForm(f => ({ ...f, year: e.target.value }))}
              />
            </div>
            <div className="zadm-form__row">
              <label className="zadm-form__label" htmlFor="pj-map">URL de la carte</label>
              <input
                id="pj-map"
                className="zadm-form__input"
                placeholder="https://…"
                value={form.mapUrl}
                onChange={e => setForm(f => ({ ...f, mapUrl: e.target.value }))}
              />
              <span className="zadm-form__help">Lien Google Maps (optionnel).</span>
            </div>
          </div>
        </div>
      </AdminModal>
    </div>
  )
}
