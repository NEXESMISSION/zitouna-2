import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProjects, useOffers } from '../../lib/useSupabase.js'
import { upsertProject } from '../../lib/db.js'
import { emitInvalidate } from '../../lib/dataEvents.js'
import { runSafeAction } from '../../lib/runSafeAction.js'
import AdminModal from '../components/AdminModal.jsx'
import { useToast } from '../components/AdminToast.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { SkeletonCard } from '../../components/skeletons/index.js'
import { getPagerPages } from './pager-util.js'
import './sell-field.css'
import './projects-admin.css'

const EMPTY_FORM = { title: '', city: '', region: '', address: '', mapUrl: '', annualRevenueTotal: '' }
const PROJECTS_PER_PAGE = 12

function initials(title) {
  const parts = String(title || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'P'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

// Decide the accent tone for a project card based on availability health.
// Empty projects → gray/blue (no data yet), healthy (>50% avail) → green,
// running low (<=20% avail) → orange, sold out → red.
function projectTone(total, avail) {
  if (!total) return 'blue'
  const ratio = avail / total
  if (ratio === 0) return 'red'
  if (ratio <= 0.2) return 'orange'
  if (ratio >= 0.5) return 'green'
  return 'blue'
}

// Sum of parcel surfaces (area_m2 — exposed on the UI shape as `plot.area`).
// Formatted as "X Ha" once >= 10 000 m², otherwise "Y m²". Returns '' when
// no parcels yet so the caller can substitute a dash.
function formatProjectArea(plots) {
  const total = (plots || []).reduce((s, x) => s + (Number(x.area) || 0), 0)
  if (!total) return ''
  if (total >= 10000) {
    const ha = total / 10000
    const rounded = ha >= 10 ? Math.round(ha) : Math.round(ha * 10) / 10
    return `${rounded.toLocaleString('fr-FR')} Ha`
  }
  return `${Math.round(total).toLocaleString('fr-FR')} m²`
}

function projectBadge(total, avail) {
  if (!total) return { label: 'Nouveau', tone: 'blue' }
  if (avail === 0) return { label: 'Complet', tone: 'red' }
  if (avail / total <= 0.2) return { label: 'Derniers lots', tone: 'orange' }
  return { label: `${avail} dispo`, tone: 'green' }
}

export default function ProjectsPage() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const { projects, loading, error, refresh } = useProjects()
  const { offersByProject } = useOffers()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all') // all | available | soldout | offers
  const [page, setPage] = useState(1)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // Enriched projects w/ aggregates
  const enriched = useMemo(() => (
    (projects || []).map((p) => {
      const pl = p.plots || []
      const sold = pl.filter((x) => x.status === 'sold').length
      const reserved = pl.filter((x) => x.status === 'reserved').length
      const avail = pl.length - sold - reserved
      const trees = pl.reduce((t, x) => t + (Number(x.trees) || 0), 0)
      const revenue = pl.reduce((t, x) => t + (x.status === 'sold' ? (Number(x.totalPrice) || 0) : 0), 0)
      const offers = (offersByProject[p.id] || []).length
      return { ...p, _sold: sold, _reserved: reserved, _avail: Math.max(0, avail), _plotsTotal: pl.length, _trees: trees, _revenue: revenue, _offers: offers }
    })
  ), [projects, offersByProject])

  // Counts for the filter chips, always computed over the full (un-queried) set
  const counts = useMemo(() => ({
    all: enriched.length,
    available: enriched.filter((p) => p._avail > 0).length,
    soldout: enriched.filter((p) => p._plotsTotal > 0 && p._avail === 0).length,
    offers: enriched.filter((p) => p._offers > 0).length,
  }), [enriched])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return enriched
      .filter((p) => {
        if (filter === 'available') return p._avail > 0
        if (filter === 'soldout') return p._plotsTotal > 0 && p._avail === 0
        if (filter === 'offers') return p._offers > 0
        return true
      })
      .filter((p) => !q
        || String(p.title || '').toLowerCase().includes(q)
        || String(p.city || '').toLowerCase().includes(q)
        || String(p.region || '').toLowerCase().includes(q))
  }, [enriched, query, filter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PROJECTS_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pagedProjects = useMemo(
    () => filtered.slice((safePage - 1) * PROJECTS_PER_PAGE, safePage * PROJECTS_PER_PAGE),
    [filtered, safePage],
  )

  const totalParcels = enriched.reduce((s, p) => s + p._plotsTotal, 0)
  const totalTrees = enriched.reduce((s, p) => s + p._trees, 0)

  const canSubmit = Boolean(form.title.trim() && form.city.trim()) && !saving
  const hasQuery = query.trim().length > 0

  const onQueryChange = (e) => { setQuery(e.target.value); setPage(1) }
  const onFilterChange = (v) => { setFilter(v); setPage(1) }

  const createProject = async () => {
    if (!canSubmit) return
    const res = await runSafeAction(
      {
        setBusy: setSaving,
        onError: (msg) => addToast(msg, 'error'),
        label: 'Créer le projet',
      },
      async () => {
        // Superficie is computed from parcels at read time (no input on create).
        // year_started defaults server-side to current year; we no longer expose it.
        await upsertProject({
          title: form.title.trim(),
          city: form.city.trim(),
          region: form.region.trim(),
          mapUrl: form.mapUrl.trim(),
          annualRevenueTotal: Number(form.annualRevenueTotal) || 0,
        })
        emitInvalidate('projects')
      },
    )
    if (res.ok) {
      addToast('Projet créé', 'success')
      setShowCreate(false)
      setForm(EMPTY_FORM)
    }
  }

  // Plan 03 §3.1: keep the inline `showSkeletons` only for small hero-level
  // KPI placeholders (<strong>). The main project grid is now gated by
  // <RenderDataGate> below so we never flash the "Aucun projet" empty state
  // before the first fetch resolves.
  const kpiLoading = loading && enriched.length === 0

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate('/admin')}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero">
        <div className="sp-hero__avatar" aria-hidden style={{ background: 'rgba(255,255,255,0.14)' }}>
          <span style={{ fontSize: 20 }}>🌳</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Projets &amp; parcelles</h1>
          <p className="sp-hero__role">Vue d'ensemble de tous les projets fonciers</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {kpiLoading ? <span className="sk-num sk-num--wide" /> : enriched.length}
          </span>
          <span className="sp-hero__kpi-label">projet{enriched.length > 1 ? 's' : ''}</span>
        </div>
        <button
          type="button"
          className="pa-hero-action"
          onClick={() => { setForm(EMPTY_FORM); setShowCreate(true) }}
          disabled={saving}
          title="Créer un nouveau projet"
        >
          <span aria-hidden>＋</span>
          <span>Nouveau</span>
        </button>
      </header>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{kpiLoading ? <span className="sk-num" /> : enriched.length}</strong> projet{enriched.length > 1 ? 's' : ''}
          <span className="sp-cat-stat-dot" />
          <strong>{kpiLoading ? <span className="sk-num" /> : totalParcels}</strong> parcelles
          <span className="sp-cat-stat-dot" />
          <strong>{kpiLoading ? <span className="sk-num" /> : totalTrees.toLocaleString('fr-FR')}</strong> arbres
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Rechercher un projet, une ville, une région…"
            value={query}
            onChange={onQueryChange}
            aria-label="Rechercher un projet"
          />
          <select
            className="sp-cat-select"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            aria-label="Filtrer les projets"
          >
            <option value="all">Tous ({counts.all})</option>
            <option value="available">Disponibles ({counts.available})</option>
            <option value="soldout">Complets ({counts.soldout})</option>
            <option value="offers">Avec offres ({counts.offers})</option>
          </select>
        </div>
      </div>

      <div className="sp-cards">
        <RenderDataGate
          loading={kpiLoading}
          error={error}
          data={filtered}
          onRetry={refresh}
          skeleton={<SkeletonCard cards={6} />}
          empty={
            <EmptyState
              icon="📭"
              title={hasQuery || filter !== 'all' ? 'Aucun projet trouvé.' : 'Aucun projet — créez le premier.'}
              hint={hasQuery || filter !== 'all' ? 'Essayez un autre terme ou réinitialisez les filtres.' : undefined}
              action={
                !hasQuery && filter === 'all'
                  ? {
                      label: '＋ Créer un projet',
                      onClick: () => { setForm(EMPTY_FORM); setShowCreate(true) },
                    }
                  : undefined
              }
            />
          }
        >
          {() => pagedProjects.map((p) => {
            const tone = projectTone(p._plotsTotal, p._avail)
            const badge = projectBadge(p._plotsTotal, p._avail)
            const loc = `${p.city || ''}${p.region ? `, ${p.region}` : ''}`
            const areaLabel = formatProjectArea(p.plots)
            return (
              <button
                key={p.id}
                type="button"
                className={`sp-card sp-card--${tone}`}
                onClick={() => navigate(`/admin/projects/${p.id}`)}
                aria-label={`Ouvrir le projet ${p.title}`}
                title={`Ouvrir ${p.title}`}
              >
                <div className="sp-card__head">
                  <div className="sp-card__user">
                    <span className="pa-card-thumb" aria-hidden>
                      {p.mapUrl
                        ? <iframe loading="lazy" src={p.mapUrl} title="" tabIndex={-1} />
                        : initials(p.title)}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <p className="sp-card__name">{p.title}</p>
                      <p className="sp-card__sub">
                        {loc || '—'}{areaLabel ? ` · ${areaLabel}` : ''}
                      </p>
                    </div>
                  </div>
                  <span className={`sp-badge sp-badge--${badge.tone}`}>{badge.label}</span>
                </div>

                <div className="sp-card__body" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  <div className="pa-stats">
                    <div className="pa-stat">
                      <span className="pa-stat__lbl">Parcelles</span>
                      <span className="pa-stat__val">{p._plotsTotal}</span>
                    </div>
                    <div className="pa-stat pa-stat--green">
                      <span className="pa-stat__lbl">Dispo</span>
                      <span className="pa-stat__val">{p._avail}</span>
                    </div>
                    <div className="pa-stat pa-stat--red">
                      <span className="pa-stat__lbl">Vendues</span>
                      <span className="pa-stat__val">{p._sold}</span>
                    </div>
                    <div className="pa-stat pa-stat--blue">
                      <span className="pa-stat__lbl">Arbres</span>
                      <span className="pa-stat__val">{p._trees.toLocaleString('fr-FR')}</span>
                    </div>
                  </div>
                  {(p._revenue > 0 || p._offers > 0) && (
                    <div className="sp-card__info" style={{ justifyContent: 'space-between' }}>
                      {p._revenue > 0 ? (
                        <span>
                          Recettes <strong style={{ color: '#0f172a' }}>{p._revenue.toLocaleString('fr-FR')} TND</strong>
                        </span>
                      ) : <span />}
                      {p._offers > 0 && (
                        <span className="sp-card__prepaid">{p._offers} offre{p._offers > 1 ? 's' : ''}</span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </RenderDataGate>
      </div>

      {!kpiLoading && filtered.length > PROJECTS_PER_PAGE && (
        <div className="sp-pager" role="navigation" aria-label="Pagination">
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage <= 1}
            onClick={() => setPage(Math.max(1, safePage - 1))}
            aria-label="Page précédente"
          >
            ‹
          </button>
          {getPagerPages(safePage, pageCount).map((pg, i) =>
            pg === '…' ? (
              <span key={`dots-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
            ) : (
              <button
                key={pg}
                type="button"
                className={`sp-pager__btn${pg === safePage ? ' sp-pager__btn--active' : ''}`}
                onClick={() => setPage(pg)}
                aria-current={pg === safePage ? 'page' : undefined}
              >
                {pg}
              </button>
            ),
          )}
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage >= pageCount}
            onClick={() => setPage(Math.min(pageCount, safePage + 1))}
            aria-label="Page suivante"
          >
            ›
          </button>
          <span className="sp-pager__info">
            {(safePage - 1) * PROJECTS_PER_PAGE + 1}–{Math.min(safePage * PROJECTS_PER_PAGE, filtered.length)} / {filtered.length}
          </span>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <AdminModal
          open
          onClose={() => { if (!saving) setShowCreate(false) }}
          title="Nouveau projet"
        >
          <div className="sp-detail">
            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Informations</div>
              <ProjectForm form={form} onChange={setForm} />
            </div>
            <div className="sp-detail__actions">
              <button
                type="button"
                className="sp-detail__btn"
                onClick={() => setShowCreate(false)}
                disabled={saving}
              >
                Annuler
              </button>
              <button
                type="button"
                className="sp-detail__btn sp-detail__btn--edit"
                disabled={!canSubmit}
                onClick={createProject}
              >
                {saving ? 'Création…' : 'Créer le projet'}
              </button>
            </div>
          </div>
        </AdminModal>
      )}

    </div>
  )
}

/* ───────────────────── helpers / sub-renderers ───────────────────── */

function ProjectForm({ form, onChange }) {
  const set = (k) => (e) => onChange((f) => ({ ...f, [k]: e.target.value }))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Field id="pj-title" label="Nom du projet *">
        <input id="pj-title" className="sp-cat-search" placeholder="Ex : Domaine El Yasmine" value={form.title} onChange={set('title')} />
      </Field>
      <Field id="pj-city" label="Ville *">
        <input id="pj-city" className="sp-cat-search" placeholder="Ex : Borj Cedria" value={form.city} onChange={set('city')} />
      </Field>
      <Field id="pj-region" label="Région">
        <input id="pj-region" className="sp-cat-search" placeholder="Ex : Ben Arous" value={form.region} onChange={set('region')} />
      </Field>
      <Field id="pj-address" label="Adresse">
        <input id="pj-address" className="sp-cat-search" placeholder="Ex : 12 rue des Oliviers, Borj Cedria" value={form.address || ''} onChange={set('address')} />
      </Field>
      <Field
        id="pj-annual-revenue"
        label="Revenu annuel total estimé (DT / an)"
        hint="Fallback global : utilisé seulement quand une parcelle n'a pas encore ses propres cohortes d'arbres. Sinon, le revenu est calculé par parcelle."
      >
        <input
          id="pj-annual-revenue"
          className="sp-cat-search"
          type="number"
          inputMode="numeric"
          min="0"
          step="100"
          placeholder="Ex : 120000"
          value={form.annualRevenueTotal ?? ''}
          onChange={set('annualRevenueTotal')}
        />
      </Field>
      <Field id="pj-map" label="URL de la carte (Google Maps)">
        <input id="pj-map" className="sp-cat-search" placeholder="https://…" value={form.mapUrl} onChange={set('mapUrl')} />
      </Field>
    </div>
  )
}

function Field({ id, label, children, hint }) {
  return (
    <label htmlFor={id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.03em' }}>
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
          {hint}
        </span>
      )}
    </label>
  )
}
