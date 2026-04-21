import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInstallments, useSales, useClients } from '../../lib/useSupabase.js'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { getPagerPages } from './pager-util.js'
import './recouvrement-v2.css'

// Auto-captured "severely overdue" list: any installment whose due date is
// more than OVERDUE_MONTHS months in the past AND is still not approved.
// No filters to configure, no buttons to click — the page just shows
// everything that crossed the 2-month bar.
const OVERDUE_MONTHS = 2
const ROWS_PER_PAGE = 25

function todayStart() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function monthsBetween(dueIso, nowDate) {
  if (!dueIso) return 0
  const due = new Date(dueIso)
  if (Number.isNaN(due.getTime())) return 0
  return (nowDate.getFullYear() - due.getFullYear()) * 12
    + (nowDate.getMonth() - due.getMonth())
    + (nowDate.getDate() >= due.getDate() ? 0 : -1)
}

function daysBetween(dueIso, nowDate) {
  if (!dueIso) return 0
  const due = new Date(dueIso)
  if (Number.isNaN(due.getTime())) return 0
  const MS = 24 * 60 * 60 * 1000
  return Math.floor((nowDate.getTime() - due.getTime()) / MS)
}

function fmtMoney(v) { return `${(Number(v) || 0).toLocaleString('fr-FR')} DT` }
function fmtDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) } catch { return iso }
}
function statusLabel(s) {
  if (s === 'rejected') return 'Rejeté'
  if (s === 'submitted') return 'En révision'
  return 'En attente'
}

export default function RecouvrementV2Page() {
  const navigate = useNavigate()
  const { plans, loading: plansLoading, refresh } = useInstallments()
  const { sales } = useSales()
  const { clients } = useClients()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const overdueRows = useMemo(() => {
    const now = todayStart()
    const salesById = new Map((sales || []).map((s) => [String(s.id), s]))
    const clientsById = new Map((clients || []).map((c) => [String(c.id), c]))
    const rows = []
    for (const plan of plans || []) {
      const sale = salesById.get(String(plan.saleId))
      const client = sale ? clientsById.get(String(sale.clientId)) : null
      for (const p of plan.payments || []) {
        if (p.status === 'approved') continue
        const monthsLate = monthsBetween(p.dueDate, now)
        if (monthsLate < OVERDUE_MONTHS) continue
        rows.push({
          key: `${plan.id}:${p.month}`,
          planId: plan.id,
          saleId: plan.saleId,
          clientId: sale?.clientId,
          clientName: sale?.clientName || client?.name || 'Client inconnu',
          clientPhone: client?.phone || sale?.buyerPhone || '',
          clientEmail: client?.email || '',
          projectTitle: plan.projectTitle || sale?.projectTitle || '—',
          projectCity: plan.projectCity || sale?.projectCity || '',
          plotId: sale?.plotId || '',
          facility: p.month,
          dueDate: p.dueDate,
          amount: p.amount,
          status: p.status,
          monthsLate,
          daysLate: daysBetween(p.dueDate, now),
        })
      }
    }
    // Sort: most overdue first, then largest amount.
    rows.sort((a, b) => (b.daysLate - a.daysLate) || (Number(b.amount) - Number(a.amount)))
    return rows
  }, [plans, sales, clients])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return overdueRows
    return overdueRows.filter((r) =>
      r.clientName.toLowerCase().includes(q)
      || r.projectTitle.toLowerCase().includes(q)
      || String(r.clientPhone).toLowerCase().includes(q)
      || String(r.plotId).toLowerCase().includes(q),
    )
  }, [overdueRows, query])

  const totalOverdueAmount = useMemo(
    () => filtered.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    [filtered],
  )
  const affectedClients = useMemo(
    () => new Set(filtered.map((r) => r.clientId).filter(Boolean)).size,
    [filtered],
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const pageSlice = filtered.slice((safePage - 1) * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE)
  const pagerPages = getPagerPages(safePage, totalPages)

  return (
    <section className="recouvrement-page">
      <button type="button" className="sp-back-btn" onClick={() => navigate('/admin')}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="recouvrement-page__hero">
        <div className="recouvrement-page__hero-icon" aria-hidden>⚠️</div>
        <div className="recouvrement-page__hero-main">
          <h1 className="recouvrement-page__title">Recouvrement 2+ mois</h1>
          <p className="recouvrement-page__sub">
            Paiements non réglés depuis au moins {OVERDUE_MONTHS} mois — capture automatique.
          </p>
        </div>
        <button
          type="button"
          className="recouvrement-page__refresh"
          onClick={() => refresh?.()}
          title="Rafraîchir"
        >
          <span className="recouvrement-page__refresh-icon" aria-hidden>↻</span>
          <span>Rafraîchir</span>
        </button>
      </header>

      <div className="recouvrement-page__kpis">
        <div className="recouvrement-page__kpi recouvrement-page__kpi--danger">
          <span className="recouvrement-page__kpi-icon" aria-hidden>⏱</span>
          <span className="recouvrement-page__kpi-label">Retards détectés</span>
          <span className="recouvrement-page__kpi-value">{filtered.length}</span>
        </div>
        <div className="recouvrement-page__kpi">
          <span className="recouvrement-page__kpi-icon" aria-hidden>👤</span>
          <span className="recouvrement-page__kpi-label">Clients concernés</span>
          <span className="recouvrement-page__kpi-value">{affectedClients}</span>
        </div>
        <div className="recouvrement-page__kpi recouvrement-page__kpi--amount">
          <span className="recouvrement-page__kpi-icon" aria-hidden>💰</span>
          <span className="recouvrement-page__kpi-label">Montant total</span>
          <span className="recouvrement-page__kpi-value">{fmtMoney(totalOverdueAmount)}</span>
        </div>
      </div>

      <div className="recouvrement-page__toolbar">
        <div className="recouvrement-page__search-wrap">
          <span className="recouvrement-page__search-icon" aria-hidden>🔍</span>
          <input
            type="search"
            className="recouvrement-page__search"
            placeholder="Rechercher par client, projet, téléphone, parcelle…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1) }}
          />
          {query && (
            <button
              type="button"
              className="recouvrement-page__search-clear"
              onClick={() => { setQuery(''); setPage(1) }}
              aria-label="Effacer la recherche"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <RenderDataGate
        loading={plansLoading}
        data={filtered}
        onRetry={refresh}
        skeleton="table"
        empty={
          <EmptyState
            icon="✅"
            title="Aucun paiement en retard de 2 mois ou plus."
            description="Tous les échéanciers sont à jour dans cette fenêtre."
          />
        }
      >
        {() => (
          <>
            <ul className="recouvrement-page__list">
              {pageSlice.map((r) => (
                <li key={r.key} className="recouvrement-page__row">
                  <button
                    type="button"
                    className="recouvrement-page__row-btn"
                    onClick={() => {
                      if (r.clientId) navigate(`/admin/clients/${r.clientId}`)
                    }}
                    title="Ouvrir la fiche client"
                  >
                    <div className="recouvrement-page__row-main">
                      <div className="recouvrement-page__row-name">
                        {r.clientName}
                        <span className={`recouvrement-page__row-status recouvrement-page__row-status--${r.status}`}>
                          {statusLabel(r.status)}
                        </span>
                      </div>
                      <div className="recouvrement-page__row-sub">
                        <span>{r.projectTitle}{r.projectCity ? ` · ${r.projectCity}` : ''}</span>
                        <span>Facilité {r.facility}</span>
                        {r.clientPhone && <span>☎ {r.clientPhone}</span>}
                      </div>
                    </div>
                    <div className="recouvrement-page__row-right">
                      <div className="recouvrement-page__row-amount">{fmtMoney(r.amount)}</div>
                      <div className="recouvrement-page__row-late">
                        {r.monthsLate >= 12
                          ? `${Math.floor(r.monthsLate / 12)} an(s) de retard`
                          : `${r.monthsLate} mois de retard`}
                      </div>
                      <div className="recouvrement-page__row-due">
                        Échéance : {fmtDate(r.dueDate)} · {r.daysLate} j
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            {totalPages > 1 && (
              <nav className="recouvrement-page__pager" aria-label="Pagination">
                <button
                  type="button"
                  className="recouvrement-page__pager-btn"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  aria-label="Précédent"
                >‹</button>
                {pagerPages.map((n, i) =>
                  n === '…' ? (
                    <span key={`gap-${i}`} className="recouvrement-page__pager-gap">…</span>
                  ) : (
                    <button
                      key={n}
                      type="button"
                      className={`recouvrement-page__pager-btn${n === safePage ? ' recouvrement-page__pager-btn--active' : ''}`}
                      onClick={() => setPage(n)}
                    >{n}</button>
                  ),
                )}
                <button
                  type="button"
                  className="recouvrement-page__pager-btn"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  aria-label="Suivant"
                >›</button>
                <span className="recouvrement-page__pager-hint">
                  {(safePage - 1) * ROWS_PER_PAGE + 1}–{Math.min(safePage * ROWS_PER_PAGE, filtered.length)} / {filtered.length}
                </span>
              </nav>
            )}
          </>
        )}
      </RenderDataGate>
    </section>
  )
}
