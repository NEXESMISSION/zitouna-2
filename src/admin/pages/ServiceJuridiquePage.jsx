import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSales } from '../../lib/useSupabase.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import { canonicalRole } from '../../lib/adminRole.js'
import AdminModal from '../components/AdminModal.jsx'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import { getPagerPages } from './pager-util.js'
import './sell-field.css'
import './service-juridique.css'
import './finance-dashboard.css'

const PER_PAGE = 15

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtMoney(v) { return `${(Number(v) || 0).toLocaleString('fr-FR')} TND` }
function fmtDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return String(iso) }
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}
function normalizePlotIds(sale) {
  const ids = Array.isArray(sale?.plotIds) ? sale.plotIds : sale?.plotId != null ? [sale.plotId] : []
  return ids.map((x) => Number(x)).filter((n) => Number.isFinite(n))
}
function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1) }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1) }
function monthGrid(anchor) {
  const first = startOfMonth(anchor)
  const startWeekday = (first.getDay() + 6) % 7
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = []
  let day = 1 - startWeekday
  for (let i = 0; i < 42; i += 1) {
    cells.push({ date: new Date(first.getFullYear(), first.getMonth(), day), inMonth: day >= 1 && day <= daysInMonth })
    day += 1
  }
  return cells
}
function juridiqueScheduleFromSale(iso) {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  return {
    date: toIsoDate(d),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ServiceJuridiquePage() {
  const navigate = useNavigate()
  const { sales, loading: salesLoading } = useSales()
  const { adminUser } = useAuth()
  // Per-file assignment: each juridique user only sees the cases assigned
  // to them in /admin/coordination. Super Admin sees everything (incl.
  // unassigned files). Falls back to "see nothing" if no admin context.
  const isSuperAdmin = canonicalRole(adminUser?.role) === 'Super Admin'
  const myAdminId = adminUser?.id ? String(adminUser.id) : ''

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState(null)
  const [view, setView] = useState('calendar')
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()))

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // ── Filter: sales awaiting Juridique validation ───────────────────────────
  // Data-driven filter: any active sale with a Juridique appointment booked
  // and not yet validated by the legal team. Doesn't require a specific
  // status string — the RDV being planned in Coordination is the signal
  // that juridique needs visibility on the file.
  const legalEntries = useMemo(() => {
    return (sales || [])
      .filter((s) => {
        const st = String(s.status || '')
        if (['cancelled', 'rejected', 'completed'].includes(st)) return false
        if (!s.coordinationJuridiqueAt) return false
        if (s.juridiqueValidatedAt) return false
        // Per-file assignment guard: a juridique staffer only sees the
        // dossiers assigned to them. Super Admin sees everything,
        // including unassigned files.
        if (!isSuperAdmin) {
          const assigned = String(s.juridiqueUserId || '')
          if (!assigned) return false
          if (assigned !== myAdminId) return false
        }
        return true
      })
      .map((sale) => {
        const plotIds = normalizePlotIds(sale)
        const { date, time } = juridiqueScheduleFromSale(sale.coordinationJuridiqueAt)
        if (!date || !time) return null
        const total = Number(sale.agreedPrice) || 0
        const unit = plotIds.length > 0 ? Math.round(total / plotIds.length) : total
        return {
          id: sale.id,
          sale,
          saleCode: sale.code || sale.id,
          clientName: sale.clientName || 'Client',
          projectTitle: sale.projectTitle || 'Projet',
          plotIds,
          plotLabel: plotIds.map((id) => `#${id}`).join(', ') || '—',
          priceTotal: total,
          pricePerPiece: unit,
          offerName: sale.offerName || (sale.paymentType === 'installments' ? 'Échelonné' : 'Comptant'),
          paymentType: sale.paymentType === 'installments' ? 'Échelonné' : 'Comptant',
          date,
          time,
          notes: sale.notes || '',
          coordinationNotes: sale.coordinationNotes || '',
        }
      })
      .filter(Boolean)
      .sort((a, b) => {
        const c = `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
        if (c !== 0) return c
        return String(a.clientName).localeCompare(String(b.clientName))
      })
  }, [sales, isSuperAdmin, myAdminId])

  // ── Status partition ──────────────────────────────────────────────────────
  const entryStatus = (e) => {
    if (e.date === todayIso) return 'today'
    if (e.date < todayIso) return 'overdue'
    return 'upcoming'
  }

  const totals = useMemo(() => {
    const all = legalEntries.length
    let today = 0, overdue = 0, upcoming = 0
    for (const e of legalEntries) {
      const s = entryStatus(e)
      if (s === 'today') today += 1
      else if (s === 'overdue') overdue += 1
      else upcoming += 1
    }
    return { all, today, overdue, upcoming }
  }, [legalEntries, todayIso])

  // ── Search + filter ───────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = legalEntries
    if (q) {
      list = list.filter((e) => {
        const hay = `${e.clientName} ${e.projectTitle} ${e.saleCode} ${e.plotIds.join(',')}`.toLowerCase()
        return hay.includes(q)
      })
    }
    if (statusFilter !== 'all') {
      list = list.filter((e) => entryStatus(e) === statusFilter)
    }
    return list
  }, [legalEntries, query, statusFilter, todayIso])

  // ── Paging ────────────────────────────────────────────────────────────────
  const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE),
    [filtered, safePage],
  )

  const selected = useMemo(
    () => (selectedId ? legalEntries.find((e) => String(e.id) === String(selectedId)) : null),
    [selectedId, legalEntries],
  )

  // ── Calendar derived ──────────────────────────────────────────────────────
  const entriesByDate = useMemo(() => {
    const m = new Map()
    for (const e of legalEntries) {
      if (!e.date) continue
      if (!m.has(e.date)) m.set(e.date, [])
      m.get(e.date).push(e)
    }
    return m
  }, [legalEntries])
  const monthCells = useMemo(() => monthGrid(monthAnchor), [monthAnchor])
  const dayAgenda = useMemo(() => entriesByDate.get(selectedDate) || [], [entriesByDate, selectedDate])
  const monthLabel = monthAnchor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  const onQueryChange = (e) => { setQuery(e.target.value); setPage(1) }
  const onStatusFilterChange = (key) => { setStatusFilter(key); setPage(1) }

  const showSkeletons = salesLoading && legalEntries.length === 0

  const statusFilters = [
    ['all',      'Tous',         totals.all],
    ['today',    "Aujourd'hui",  totals.today],
    ['overdue',  'En retard',    totals.overdue],
    ['upcoming', 'À venir',      totals.upcoming],
  ]

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero">
        <div className="sp-hero__avatar sj-hero__icon" aria-hidden>
          <span>⚖️</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Service juridique</h1>
          <p className="sp-hero__role">Valider les dossiers avant le notaire</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : totals.all}
          </span>
          <span className="sp-hero__kpi-label">dossier{totals.all > 1 ? 's' : ''}</span>
        </div>
      </header>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{showSkeletons ? <span className="sk-num" /> : totals.all}</strong> total
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : totals.today}</strong> aujourd'hui
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : totals.overdue}</strong> en retard
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Rechercher un client, projet, référence…"
            value={query}
            onChange={onQueryChange}
            aria-label="Rechercher un dossier"
          />
        </div>
        <div className="sj-chips" role="tablist" aria-label="Filtrer par statut">
          {statusFilters.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={statusFilter === key}
              className={`sj-chip${statusFilter === key ? ' sj-chip--active' : ''}`}
              onClick={() => onStatusFilterChange(key)}
            >
              {label}
              <span className="sj-chip__count">{count}</span>
            </button>
          ))}
        </div>
        <div className="fv-chips" role="tablist" aria-label="Vue">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'list'}
            className={`fv-chip${view === 'list' ? ' fv-chip--active' : ''}`}
            onClick={() => setView('list')}
          >
            Liste
            <span className="fv-chip__count">{filtered.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'calendar'}
            className={`fv-chip${view === 'calendar' ? ' fv-chip--active' : ''}`}
            onClick={() => setView('calendar')}
          >
            Calendrier
          </button>
        </div>
      </div>

      {view === 'list' && (
      <>
      <div className="sp-cards">
        <RenderDataGate
          loading={showSkeletons}
          error={null}
          data={paged}
          isEmpty={() => filtered.length === 0}
          skeleton={
            <>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={`sk-${i}`} className="sp-card sp-card--skeleton" aria-hidden>
                  <div className="sp-card__head">
                    <div className="sp-card__user">
                      <span className="sp-card__initials sk-box" />
                      <div style={{ flex: 1 }}>
                        <p className="sk-line sk-line--title" />
                        <p className="sk-line sk-line--sub" />
                      </div>
                    </div>
                    <span className="sk-line sk-line--badge" />
                  </div>
                  <div className="sp-card__body">
                    <span className="sk-line sk-line--price" />
                    <span className="sk-line sk-line--info" />
                  </div>
                </div>
              ))}
            </>
          }
          empty={
            <div className="sp-empty">
              <span className="sp-empty__emoji" aria-hidden>📭</span>
              <div className="sp-empty__title">
                {query || statusFilter !== 'all'
                  ? 'Aucun résultat.'
                  : 'Aucun dossier en attente.'}
              </div>
              {!query && statusFilter === 'all' && (
                <p className="sj-empty__text">
                  La coordination n'a planifié aucun rendez-vous juridique.
                </p>
              )}
            </div>
          }
        >
          {(rows) => rows.map((entry) => {
          const st = entryStatus(entry)
          const tone = st === 'today' ? 'orange' : st === 'overdue' ? 'red' : 'blue'
          const badgeLabel = st === 'today'
            ? "Aujourd'hui"
            : st === 'overdue'
              ? `Retard · ${fmtDate(entry.date)}`
              : fmtDate(entry.date)
          return (
            <button
              key={entry.id}
              type="button"
              className={`sp-card sp-card--${tone}`}
              onClick={() => setSelectedId(entry.id)}
              aria-label={`Ouvrir le dossier de ${entry.clientName}`}
            >
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials">{initials(entry.clientName)}</span>
                  <div style={{ minWidth: 0 }}>
                    <p className="sp-card__name">{entry.clientName}</p>
                    <p className="sp-card__sub">
                      {entry.projectTitle} · Parcelle {entry.plotLabel}
                    </p>
                  </div>
                </div>
                <span className={`sp-badge sp-badge--${tone}`}>{badgeLabel}</span>
              </div>

              <div className="sp-card__body">
                <div className="sp-card__price">
                  <span className="sp-card__amount">{(entry.priceTotal || 0).toLocaleString('fr-FR')}</span>
                  <span className="sp-card__currency">TND</span>
                </div>
                <div className="sp-card__info">
                  <span>{entry.time} · {entry.paymentType}</span>
                </div>
              </div>
            </button>
          )
          })}
        </RenderDataGate>
      </div>

      {!showSkeletons && filtered.length > PER_PAGE && (
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
            {(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, filtered.length)} / {filtered.length}
          </span>
        </div>
      )}
      </>
      )}

      {view === 'calendar' && (
        <section className="fv-cal">
          <div className="fv-cal__nav">
            <button type="button" className="fv-cal__nav-btn" onClick={() => setMonthAnchor((d) => addMonths(d, -1))} aria-label="Mois précédent">‹</button>
            <span className="fv-cal__month">{monthLabel}</span>
            <button type="button" className="fv-cal__nav-btn" onClick={() => setMonthAnchor((d) => addMonths(d, 1))} aria-label="Mois suivant">›</button>
          </div>
          <div className="fv-cal__week">
            {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
              <span key={d} className="fv-cal__weekday">{d}</span>
            ))}
          </div>
          <div className="fv-cal__grid">
            {monthCells.map((cell) => {
              const iso = toIsoDate(cell.date)
              const count = (entriesByDate.get(iso) || []).length
              const isSel = iso === selectedDate
              return (
                <button
                  key={`${iso}-${cell.inMonth ? 'in' : 'out'}`}
                  type="button"
                  className={`fv-cal__day${cell.inMonth ? '' : ' fv-cal__day--muted'}${isSel ? ' fv-cal__day--sel' : ''}`}
                  onClick={() => setSelectedDate(iso)}
                >
                  <span className="fv-cal__day-num">{cell.date.getDate()}</span>
                  {count > 0 ? <span className="fv-cal__day-dot">{count}</span> : null}
                </button>
              )
            })}
          </div>
          <div className="fv-cal__agenda">
            <div className="fv-cal__agenda-head">{fmtDate(selectedDate)}</div>
            {dayAgenda.length === 0 ? (
              <div className="sp-empty" style={{ marginTop: 8 }}>
                <span className="sp-empty__emoji" aria-hidden>📭</span>
                <div className="sp-empty__title">Aucun rendez-vous juridique ce jour.</div>
              </div>
            ) : (
              <div className="sp-cards">
                {dayAgenda.map((entry) => {
                  const st = entryStatus(entry)
                  const tone = st === 'today' ? 'orange' : st === 'overdue' ? 'red' : 'blue'
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={`sp-card sp-card--${tone}`}
                      onClick={() => setSelectedId(entry.id)}
                      aria-label={`Ouvrir le dossier de ${entry.clientName}`}
                    >
                      <div className="sp-card__head">
                        <div className="sp-card__user">
                          <span className="sp-card__initials">{initials(entry.clientName)}</span>
                          <div style={{ minWidth: 0 }}>
                            <p className="sp-card__name">{entry.clientName}</p>
                            <p className="sp-card__sub">{entry.projectTitle} · Parcelle {entry.plotLabel}</p>
                          </div>
                        </div>
                        <span className={`sp-badge sp-badge--${tone}`}>{entry.time}</span>
                      </div>
                      <div className="sp-card__body">
                        <div className="sp-card__price">
                          <span className="sp-card__amount">{(entry.priceTotal || 0).toLocaleString('fr-FR')}</span>
                          <span className="sp-card__currency">TND</span>
                        </div>
                        <div className="sp-card__info">
                          <span>{entry.paymentType}</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {selected && (
        <AdminModal open onClose={() => setSelectedId(null)} title="">
          <div className="sp-detail">
            <div className="sp-detail__banner">
              <div className="sp-detail__banner-top">
                <span className="sp-badge sp-badge--blue">Juridique</span>
                <span className="sp-detail__date">
                  {fmtDate(selected.date)} · {selected.time}
                </span>
              </div>
              <div className="sp-detail__price">
                <span className="sp-detail__price-num">{(selected.priceTotal || 0).toLocaleString('fr-FR')}</span>
                <span className="sp-detail__price-cur">TND</span>
              </div>
              <p className="sp-detail__banner-sub">
                {selected.clientName} · Réf. {selected.saleCode}
              </p>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Client</div>
              <div className="sp-detail__row"><span>Nom</span><strong>{selected.clientName}</strong></div>
              <div className="sp-detail__row"><span>Projet</span><strong>{selected.projectTitle}</strong></div>
              <div className="sp-detail__row"><span>Parcelle(s)</span><strong>{selected.plotLabel}</strong></div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Vente</div>
              <div className="sp-detail__row"><span>Prix total</span><strong>{fmtMoney(selected.priceTotal)}</strong></div>
              <div className="sp-detail__row"><span>Prix / parcelle</span><strong>{fmtMoney(selected.pricePerPiece)}</strong></div>
              <div className="sp-detail__row"><span>Offre</span><strong>{selected.offerName}</strong></div>
              <div className="sp-detail__row"><span>Mode</span><strong>{selected.paymentType}</strong></div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Juridique</div>
              <div className="sp-detail__row">
                <span>Rendez-vous</span>
                <strong>{fmtDate(selected.date)} · {selected.time}</strong>
              </div>
              {selected.coordinationNotes && (
                <div className="sp-detail__row">
                  <span>Notes coordination</span>
                  <strong style={{ whiteSpace: 'pre-wrap' }}>{selected.coordinationNotes}</strong>
                </div>
              )}
              {selected.notes && (
                <div className="sp-detail__row">
                  <span>Notes dossier</span>
                  <strong style={{ whiteSpace: 'pre-wrap' }}>{selected.notes}</strong>
                </div>
              )}
            </div>

            {selected.sale && (
              <div className="sp-detail__section">
                <SaleSnapshotTracePanel sale={selected.sale} />
              </div>
            )}

            <div className="sp-detail__actions">
              <button
                type="button"
                className="sp-detail__btn"
                onClick={() => setSelectedId(null)}
              >
                Fermer
              </button>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
