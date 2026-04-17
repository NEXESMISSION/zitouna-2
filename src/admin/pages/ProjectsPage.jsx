import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProjects, useOffers } from '../../lib/useSupabase.js'
import { upsertProject } from '../../lib/db.js'
import './zitouna-admin-page.css'
import './projects-admin.css'

const EMPTY_FORM = { title: '', city: '', region: '', area: '', year: String(new Date().getFullYear()), mapUrl: '' }

// Scoped local styles — improves clarity, hierarchy, and mobile usability.
// All class names are prefixed with `pp-` so they never collide with shared admin CSS.
const LOCAL_STYLES = `
.pp-scope { --pp-blue:#2563eb; --pp-blue-d:#1d4ed8; --pp-ink:#0f172a; --pp-muted:#64748b; --pp-line:#e2e8f0; --pp-bg:#f8fafc; }
.pp-scope * { box-sizing: border-box; }
.pp-hint { font-size: 13px; color: var(--pp-muted); margin: 4px 0 12px; line-height: 1.4; }
.pp-section-title { display:flex; align-items:baseline; justify-content:space-between; margin: 16px 0 8px; }
.pp-section-title h2 { margin:0; font-size: 18px; font-weight: 800; color: var(--pp-ink); letter-spacing: -.01em; }
.pp-section-title small { font-size: 13px; font-weight: 600; color: var(--pp-muted); }

/* Toolbar: bigger search, labelled primary action */
.pp-toolbar { display:flex; gap:10px; align-items:center; margin: 8px 0 4px; flex-wrap: wrap; }
.pp-search { flex:1 1 260px; position:relative; min-width: 200px; }
.pp-search input { width:100%; height: 44px; padding: 0 14px 0 40px; font-size:14px; border-radius: 10px; border: 1px solid var(--pp-line); background:#fff; outline:none; color: var(--pp-ink); font-family: inherit; }
.pp-search input:focus { border-color: var(--pp-blue); box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.pp-search .pp-search-ico { position:absolute; left:14px; top:50%; transform:translateY(-50%); font-size:16px; opacity:.55; pointer-events:none; }
.pp-search .pp-clear { position:absolute; right:8px; top:50%; transform:translateY(-50%); width:28px; height:28px; border:none; background: #f1f5f9; border-radius:8px; color: var(--pp-muted); cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; }
.pp-search .pp-clear:hover { background:#e2e8f0; color: var(--pp-ink); }
.pp-btn-primary { height: 44px; padding: 0 18px; border-radius: 10px; border: none; background: linear-gradient(135deg,#2563eb,#1d4ed8); color:#fff; font-size: 14px; font-weight: 700; cursor:pointer; display:inline-flex; align-items:center; gap:8px; box-shadow: 0 4px 12px rgba(37,99,235,.25); white-space:nowrap; }
.pp-btn-primary:hover { filter: brightness(1.05); }
.pp-btn-primary:focus-visible { outline: 3px solid rgba(37,99,235,.35); outline-offset: 2px; }
.pp-btn-primary .pp-plus { font-size: 18px; line-height: 1; }

/* Project cards — touch-friendly, clearer hierarchy */
.pp-list { display:flex; flex-direction:column; gap: 8px; margin-top: 4px; }
.pp-card { display:flex; align-items:center; gap: 12px; width:100%; padding: 14px 14px; border: 1px solid var(--pp-line); border-left: 4px solid var(--pp-blue); border-radius: 12px; background:#fff; text-align:left; cursor:pointer; transition: box-shadow .15s, transform .12s, border-color .15s; }
.pp-card:hover { box-shadow: 0 6px 18px rgba(15,23,42,.08); transform: translateY(-1px); border-left-color: var(--pp-blue-d); }
.pp-card:focus-visible { outline: 3px solid rgba(37,99,235,.35); outline-offset: 2px; }
.pp-card__main { flex:1; min-width: 0; }
.pp-card__name { display:block; font-size: 15px; font-weight: 700; color: var(--pp-ink); overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-card__meta { display:block; font-size: 13px; color: var(--pp-muted); margin-top: 2px; overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-card__pills { display:flex; flex-wrap:wrap; gap: 6px; justify-content: flex-end; flex-shrink: 0; }
.pp-pill { font-size: 12px; font-weight: 700; padding: 4px 9px; border-radius: 999px; background: #f1f5f9; color: #475569; white-space:nowrap; }
.pp-pill--ok { background: #ecfdf5; color: #047857; }
.pp-pill--accent { background: rgba(37,99,235,.1); color: var(--pp-blue-d); }
.pp-card__arrow { color:#cbd5e1; font-size: 20px; flex-shrink:0; }

/* Empty state — actionable */
.pp-empty { text-align:center; padding: 32px 18px; background:#fff; border: 1px dashed var(--pp-line); border-radius: 14px; margin-top: 8px; }
.pp-empty__ico { font-size: 38px; margin-bottom: 8px; }
.pp-empty__title { display:block; font-size: 18px; font-weight: 800; color: var(--pp-ink); margin-bottom: 4px; }
.pp-empty__hint { font-size: 13px; color: var(--pp-muted); margin: 0 0 14px; }

.pp-footcount { text-align:center; font-size: 13px; font-weight: 600; color: var(--pp-muted); padding: 14px 0 4px; }

/* Modal — clearer titles, bigger inputs, explicit required hint */
.pp-modal { position:fixed; inset:0; z-index: 1000; background: rgba(15,23,42,.45); backdrop-filter: blur(3px); display:flex; align-items:center; justify-content:center; padding: 16px; }
.pp-sheet { width:100%; max-width: 520px; max-height: 90vh; overflow-y:auto; background:#fff; border-radius: 16px; padding: 20px; box-shadow: 0 20px 50px rgba(0,0,0,.25); }
.pp-sheet__head { display:flex; align-items:flex-start; justify-content:space-between; gap: 10px; margin-bottom: 6px; }
.pp-sheet__title { margin:0; font-size: 20px; font-weight: 800; color: var(--pp-ink); letter-spacing: -.01em; }
.pp-sheet__sub { margin: 2px 0 14px; font-size: 13px; color: var(--pp-muted); }
.pp-sheet__close { width:36px; height:36px; border:none; border-radius: 10px; background:#f1f5f9; color: var(--pp-muted); cursor:pointer; font-size: 16px; flex-shrink:0; }
.pp-sheet__close:hover { background:#e2e8f0; color: var(--pp-ink); }
.pp-field { display:flex; flex-direction:column; gap: 6px; margin-bottom: 12px; }
.pp-field__label { font-size: 13px; font-weight: 700; color: var(--pp-ink); display:flex; align-items:center; gap:6px; }
.pp-field__req { color: #dc2626; font-weight: 800; }
.pp-field__help { font-size: 12px; color: var(--pp-muted); margin-top: -2px; }
.pp-input { height: 44px; width:100%; padding: 0 12px; font-size: 14px; border-radius: 10px; border:1px solid var(--pp-line); background:#fff; color: var(--pp-ink); outline:none; font-family: inherit; }
.pp-input:focus { border-color: var(--pp-blue); box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.pp-row2 { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.pp-actions { display:flex; gap: 10px; margin-top: 16px; }
.pp-btn { flex:1; height: 46px; border-radius: 10px; border:1px solid var(--pp-line); background:#fff; color: var(--pp-ink); font-size: 14px; font-weight: 700; cursor:pointer; }
.pp-btn:hover { background:#f8fafc; }
.pp-btn--primary { flex: 2; border:none; background: linear-gradient(135deg,#2563eb,#1d4ed8); color:#fff; box-shadow: 0 4px 12px rgba(37,99,235,.25); }
.pp-btn--primary:disabled { opacity:.45; cursor:not-allowed; box-shadow:none; }

/* Loading */
.pp-loading { text-align:center; padding: 40px 16px; color: var(--pp-muted); font-size: 14px; }

/* Mobile */
@media (max-width: 600px) {
  .pp-toolbar { flex-direction: column; align-items: stretch; }
  .pp-btn-primary { width: 100%; justify-content: center; }
  .pp-card { flex-direction: column; align-items: flex-start; gap: 10px; }
  .pp-card__pills { justify-content: flex-start; }
  .pp-card__arrow { display: none; }
  .pp-row2 { grid-template-columns: 1fr; }
  .pp-actions { flex-direction: column-reverse; }
  .pp-btn, .pp-btn--primary { flex: 1 1 auto; width: 100%; }
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
    <div className="zitu-page pp-scope" dir="ltr">
      {/* Local scoped styles to improve clarity & mobile UX without touching shared CSS */}
      <style>{LOCAL_STYLES}</style>

      <div className="zitu-page__column">

        <button type="button" className="ds-back-btn" onClick={() => navigate('/admin')} aria-label="Retour au tableau de bord">
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        {/* Hero — clearer title + plain-French subtitle */}
        <div className="ds-hero">
          <div className="ds-hero__top">
            <div className="ds-hero__icon" aria-hidden>🌿</div>
            <div>
              <h1 className="ds-hero__title">Projets & parcelles</h1>
              <p className="ds-hero__sub">Vue d’ensemble de tous les projets fonciers</p>
            </div>
          </div>
          <div className="ds-hero__kpi" aria-label="Indicateurs globaux">
            <div className="ds-hero__kpi-block" title="Nombre total de projets">
              <span className="ds-hero__kpi-num">{projects.length}</span>
              <span className="ds-hero__kpi-unit">PROJETS</span>
            </div>
            <span className="ds-hero__kpi-sep" />
            <div className="ds-hero__kpi-block" title="Nombre total de parcelles">
              <span className="ds-hero__kpi-num">{totalParcels}</span>
              <span className="ds-hero__kpi-unit">PARCELLES</span>
            </div>
            <span className="ds-hero__kpi-sep" />
            <div className="ds-hero__kpi-block" title="Nombre total d’arbres plantés">
              <span className="ds-hero__kpi-num">{totalTrees.toLocaleString('fr-FR')}</span>
              <span className="ds-hero__kpi-unit">ARBRES</span>
            </div>
          </div>
        </div>

        {/* Inline guidance */}
        <p className="pp-hint">Recherchez un projet par nom, ville ou région, ou créez-en un nouveau.</p>

        {/* Toolbar: bigger search + labelled primary action */}
        <div className="pp-toolbar" role="search">
          <label className="pp-search">
            <span className="pp-search-ico" aria-hidden>🔎</span>
            <input
              type="search"
              placeholder="Rechercher un projet, une ville, une région…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Rechercher un projet"
            />
            {hasQuery && (
              <button type="button" className="pp-clear" onClick={() => setQuery('')} aria-label="Effacer la recherche" title="Effacer">✕</button>
            )}
          </label>
          <button
            type="button"
            className="pp-btn-primary"
            onClick={() => { setForm(EMPTY_FORM); setShowCreate(true) }}
            title="Créer un nouveau projet"
          >
            <span className="pp-plus" aria-hidden>+</span>
            <span>Nouveau projet</span>
          </button>
        </div>

        {/* Section heading */}
        <div className="pp-section-title">
          <h2>Liste des projets</h2>
          <small>{filtered.length} résultat{filtered.length !== 1 ? 's' : ''}</small>
        </div>

        {loading ? (
          <div className="pp-loading" role="status" aria-live="polite">⏳ Chargement des projets…</div>
        ) : filtered.length === 0 ? (
          <div className="pp-empty" role="status">
            <div className="pp-empty__ico" aria-hidden>📭</div>
            {hasQuery ? (
              <>
                <strong className="pp-empty__title">Aucun projet trouvé</strong>
                <p className="pp-empty__hint">Aucun résultat pour « {query} ». Essayez un autre mot-clé.</p>
                <button type="button" className="pp-btn-primary" onClick={() => setQuery('')}>
                  <span>Effacer la recherche</span>
                </button>
              </>
            ) : (
              <>
                <strong className="pp-empty__title">Aucun projet — créer le premier</strong>
                <p className="pp-empty__hint">Commencez par ajouter votre premier projet foncier.</p>
                <button type="button" className="pp-btn-primary" onClick={() => { setForm(EMPTY_FORM); setShowCreate(true) }}>
                  <span className="pp-plus" aria-hidden>+</span>
                  <span>Créer un projet</span>
                </button>
              </>
            )}
          </div>
        ) : (
          <section className="pp-list" aria-label="Liste des projets">
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
                  className="pp-card"
                  onClick={() => navigate(`/admin/projects/${project.id}`)}
                  aria-label={`Ouvrir le projet ${project.title}`}
                  title={`Ouvrir ${project.title}`}
                >
                  <div className="pp-card__main">
                    <span className="pp-card__name">{project.title}</span>
                    <span className="pp-card__meta">
                      {locLabel || '—'} · {project.area || '—'} · {project.year}
                    </span>
                  </div>
                  <div className="pp-card__pills" aria-hidden>
                    <span className="pp-pill" title={`${pl.length} parcelles au total`}>{pl.length} parc.</span>
                    <span className="pp-pill pp-pill--ok" title={`${avail} parcelles disponibles`}>{avail} dispo</span>
                    {offers.length > 0 && (
                      <span className="pp-pill pp-pill--accent" title={`${offers.length} offres actives`}>{offers.length} offres</span>
                    )}
                  </div>
                  <span className="pp-card__arrow" aria-hidden>›</span>
                </button>
              )
            })}
          </section>
        )}

        <div className="pp-footcount">
          {filtered.length} projet{filtered.length !== 1 ? 's' : ''} affiché{filtered.length !== 1 ? 's' : ''}
        </div>

        {/* Create modal — clearer labels, required markers, inline help */}
        {showCreate && (
          <div className="pp-modal" onClick={() => setShowCreate(false)} role="dialog" aria-modal="true" aria-labelledby="pp-sheet-title">
            <div className="pp-sheet" onClick={e => e.stopPropagation()}>
              <div className="pp-sheet__head">
                <div>
                  <h3 id="pp-sheet-title" className="pp-sheet__title">Nouveau projet</h3>
                  <p className="pp-sheet__sub">Les champs marqués d’un * sont obligatoires.</p>
                </div>
                <button type="button" className="pp-sheet__close" onClick={() => setShowCreate(false)} aria-label="Fermer">✕</button>
              </div>

              <div className="pp-field">
                <label className="pp-field__label" htmlFor="pp-title">Nom du projet <span className="pp-field__req" aria-hidden>*</span></label>
                <input id="pp-title" className="pp-input" placeholder="Ex : Domaine El Yasmine" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
              </div>

              <div className="pp-field">
                <label className="pp-field__label" htmlFor="pp-city">Ville <span className="pp-field__req" aria-hidden>*</span></label>
                <input id="pp-city" className="pp-input" placeholder="Ex : Borj Cedria" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
              </div>

              <div className="pp-row2">
                <div className="pp-field">
                  <label className="pp-field__label" htmlFor="pp-region">Région</label>
                  <input id="pp-region" className="pp-input" placeholder="Ex : Ben Arous" value={form.region} onChange={e => setForm(f => ({ ...f, region: e.target.value }))} />
                </div>
                <div className="pp-field">
                  <label className="pp-field__label" htmlFor="pp-area">Superficie</label>
                  <input id="pp-area" className="pp-input" placeholder="Ex : 25 Ha" value={form.area} onChange={e => setForm(f => ({ ...f, area: e.target.value }))} />
                </div>
              </div>

              <div className="pp-row2">
                <div className="pp-field">
                  <label className="pp-field__label" htmlFor="pp-year">Année</label>
                  <input id="pp-year" className="pp-input" type="number" placeholder="2026" value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} />
                </div>
                <div className="pp-field">
                  <label className="pp-field__label" htmlFor="pp-map">URL de la carte</label>
                  <input id="pp-map" className="pp-input" placeholder="https://…" value={form.mapUrl} onChange={e => setForm(f => ({ ...f, mapUrl: e.target.value }))} />
                  <span className="pp-field__help">Lien Google Maps (optionnel).</span>
                </div>
              </div>

              <div className="pp-actions">
                <button type="button" className="pp-btn" onClick={() => setShowCreate(false)}>Annuler</button>
                <button type="button" className="pp-btn pp-btn--primary" disabled={!canSubmit} onClick={createProject}>
                  {saving ? 'Création…' : 'Créer le projet'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
