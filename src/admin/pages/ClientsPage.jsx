import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useClients, useSales } from '../../lib/useSupabase.js'
import { isClientSuspended } from '../../lib/adminAccess.js'
import { getPagerPages } from './pager-util.js'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { SkeletonCard } from '../../components/skeletons/index.js'
import './sell-field.css'
import './clients-admin.css'

const CLIENTS_PER_PAGE = 15

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

// Status/origin filter buckets for the chip bar.
const FILTERS = [
  { key: 'all',       label: 'Tous' },
  { key: 'active',    label: 'Actifs' },
  { key: 'suspended', label: 'Suspendus' },
  { key: 'auto',      label: 'Inscriptions auto.' },
]

function matchesFilter(key, c) {
  const suspended = isClientSuspended(c)
  const selfReg = String(c.id || '').startsWith('c-reg-')
  switch (key) {
    case 'active':    return !suspended
    case 'suspended': return suspended
    case 'auto':      return selfReg
    default:          return true
  }
}

export default function ClientsPage() {
  const navigate = useNavigate()
  const { clients, loading: clientsLoading, refresh: refreshClients } = useClients()
  const { sales } = useSales()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(1)

  // Count sales per client for the per-card "Ventes" badge.
  const saleCountByClient = useMemo(() => {
    const m = new Map()
    for (const s of sales || []) {
      const id = String(s.clientId || '')
      if (!id) continue
      m.set(id, (m.get(id) || 0) + 1)
    }
    return m
  }, [sales])

  // Pre-compute filter counts (on the full list, ignoring search) so the chip
  // counts reflect the whole dataset and don't jitter with every keystroke.
  const counts = useMemo(() => {
    const out = { all: 0, active: 0, suspended: 0, auto: 0 }
    for (const c of clients || []) {
      out.all += 1
      if (isClientSuspended(c)) out.suspended += 1
      else out.active += 1
      if (String(c.id || '').startsWith('c-reg-')) out.auto += 1
    }
    return out
  }, [clients])

  // Apply filter chip + free-text search.
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return (clients || []).filter((c) => {
      if (!matchesFilter(filter, c)) return false
      if (!q) return true
      const name = (c.name || '').toLowerCase()
      const email = (c.email || '').toLowerCase()
      const phone = (c.phone || '').toLowerCase()
      const cin = (c.cin || '').toLowerCase()
      return name.includes(q) || email.includes(q) || phone.includes(q) || cin.includes(q)
    })
  }, [clients, search, filter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / CLIENTS_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pagedClients = useMemo(
    () => filtered.slice((safePage - 1) * CLIENTS_PER_PAGE, safePage * CLIENTS_PER_PAGE),
    [filtered, safePage],
  )

  const onSearchChange = (e) => { setSearch(e.target.value); setPage(1) }
  const onFilterChange = (key) => { setFilter(key); setPage(1) }

  const showSkeletons = clientsLoading && (clients || []).length === 0

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero">
        <div className="sp-hero__avatar" aria-hidden>
          <span style={{
            width: '100%', height: '100%', display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 24,
          }}>👥</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Clients</h1>
          <p className="sp-hero__role">Répertoire des clients enregistrés</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : counts.all}
          </span>
          <span className="sp-hero__kpi-label">client{counts.all > 1 ? 's' : ''}</span>
        </div>
      </header>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{showSkeletons ? <span className="sk-num" /> : counts.all}</strong> total
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : counts.active}</strong> actif{counts.active > 1 ? 's' : ''}
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : counts.suspended}</strong> suspendu{counts.suspended > 1 ? 's' : ''}
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : counts.auto}</strong> auto.
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Rechercher par nom, CIN, téléphone, email…"
            value={search}
            onChange={onSearchChange}
            aria-label="Rechercher un client"
          />
        </div>
        <div className="cl-chips" role="group" aria-label="Filtrer par statut">
          {FILTERS.map((f) => {
            const active = filter === f.key
            return (
              <button
                key={f.key}
                type="button"
                className={`cl-chip${active ? ' cl-chip--on' : ''}`}
                onClick={() => onFilterChange(f.key)}
                aria-pressed={active}
              >
                <span>{f.label}</span>
                <span className="cl-chip__count">{counts[f.key] ?? 0}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="sp-cards">
        <RenderDataGate
          loading={clientsLoading && (clients || []).length === 0}
          data={clients || []}
          skeleton={<SkeletonCard cards={6} />}
          onRetry={() => refreshClients()}
          isEmpty={() => filtered.length === 0}
          empty={
            <EmptyState
              icon={search || filter !== 'all' ? '🔍' : '🧑‍🤝‍🧑'}
              title={
                search || filter !== 'all'
                  ? 'Aucun client ne correspond aux filtres.'
                  : 'Aucun client enregistré pour le moment.'
              }
              description={
                search || filter !== 'all'
                  ? 'Essayez un autre terme ou réinitialisez les filtres.'
                  : null
              }
            />
          }
        >
          {() => pagedClients.map((c) => {
          const suspended = isClientSuspended(c)
          const selfReg = String(c.id || '').startsWith('c-reg-')
          const nSales = saleCountByClient.get(String(c.id)) || 0
          const tone = suspended ? 'red' : (nSales > 0 ? 'green' : 'blue')
          const badgeTone = suspended ? 'red' : 'green'
          const badgeLabel = suspended ? 'Suspendu' : 'Actif'
          const clientName = c.name || 'Client sans nom'
          return (
            <button
              key={c.id}
              type="button"
              className={`sp-card sp-card--${tone}`}
              onClick={() => navigate(`/admin/clients/${c.id}`)}
              aria-label={`Ouvrir la fiche de ${clientName}`}
              title={`Ouvrir la fiche de ${clientName}`}
            >
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials">{initials(clientName)}</span>
                  <div style={{ minWidth: 0 }}>
                    <p className="sp-card__name">{clientName}</p>
                    <p className="sp-card__sub">
                      {c.phone || c.email || 'Contact non renseigné'}
                    </p>
                    {(c.cin || selfReg) && (
                      <div className="cl-card-tags">
                        {c.cin ? (
                          <span className="cl-card-tag" title="CIN">CIN · {c.cin}</span>
                        ) : null}
                        {selfReg ? (
                          <span className="cl-card-tag cl-card-tag--auto" title="Inscription via formulaire public">
                            Auto.
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
                <span className={`sp-badge sp-badge--${badgeTone}`}>{badgeLabel}</span>
              </div>

              <div className="sp-card__body">
                <div className="cl-card-meta">
                  <span className="cl-card-meta__item" title="Code client">
                    <span className="cl-card-meta__label">Code</span>
                    <span className="cl-card-meta__value" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>
                      {c.code || c.id}
                    </span>
                  </span>
                  {c.email ? (
                    <>
                      <span className="cl-card-meta__dot" />
                      <span className="cl-card-meta__item" title={c.email}>
                        <span className="cl-card-meta__value" style={{ fontWeight: 500, color: '#64748b' }}>
                          {c.email}
                        </span>
                      </span>
                    </>
                  ) : null}
                </div>
                <span className="cl-sales-pill" title="Nombre de ventes liées à ce client">
                  <span className="cl-sales-pill__num">{nSales}</span>
                  <span className="cl-sales-pill__label">vente{nSales > 1 ? 's' : ''}</span>
                </span>
              </div>
            </button>
          )
        })}
        </RenderDataGate>
      </div>

      {!showSkeletons && filtered.length > CLIENTS_PER_PAGE && (
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
          {getPagerPages(safePage, pageCount).map((p, i) =>
            p === '…' ? (
              <span key={`dots-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
            ) : (
              <button
                key={p}
                type="button"
                className={`sp-pager__btn${p === safePage ? ' sp-pager__btn--active' : ''}`}
                onClick={() => setPage(p)}
                aria-current={p === safePage ? 'page' : undefined}
              >
                {p}
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
            {(safePage - 1) * CLIENTS_PER_PAGE + 1}–{Math.min(safePage * CLIENTS_PER_PAGE, filtered.length)} / {filtered.length}
          </span>
        </div>
      )}
    </div>
  )
}
