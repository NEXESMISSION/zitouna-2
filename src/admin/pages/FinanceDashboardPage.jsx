import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { getSaleSnapshotAuditRows } from '../../lib/saleSnapshotAudit.js'
import { useAdminUsers, useSales } from '../../lib/useSupabase.js'
import { runSafeAction } from '../../lib/runSafeAction.js'
import AdminModal from '../components/AdminModal.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import { getPagerPages } from './pager-util.js'
import './sell-field.css'
import './finance-dashboard.css'

const PER_PAGE = 10

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function feeRatesFromSale(sale) {
  const f = sale?.feeSnapshot || {}
  const c = Number(f.companyFeePct)
  const n = Number(f.notaryFeePct)
  return {
    company: Number.isFinite(c) ? c / 100 : 0.05,
    notary: Number.isFinite(n) ? n / 100 : 0.02,
    companyPct: Number.isFinite(c) ? c : 5,
    notaryPct: Number.isFinite(n) ? n : 2,
  }
}
function fmtMoney(v) { return `${(Number(v) || 0).toLocaleString('fr-FR')} TND` }
function fmtDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return String(iso) }
}
function fmtDateTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
  } catch { return String(iso) }
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
function saleDateKey(sale) {
  const iso = sale?.createdAt || ''
  return iso ? iso.slice(0, 10) : ''
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function FinanceDashboardPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { sales, loading: salesLoading, update: salesUpdate } = useSales()
  const { adminUsers } = useAdminUsers()

  const [view, setView] = useState('list')
  const [query, setQuery] = useState('')
  const [detailSaleId, setDetailSaleId] = useState(null)
  const [confirmPayment, setConfirmPayment] = useState(null)
  const [toast, setToast] = useState(null)
  const [approving, setApproving] = useState(false)
  const [page, setPage] = useState(1)
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()))

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    window.setTimeout(() => setToast(null), 2800)
  }

  // ---- Pending sales queue -------------------------------------------------
  // Data-driven filter: any active sale that has a Finance appointment booked
  // and hasn't been validated by finance yet. Avoids relying on status-string
  // transitions that can be skipped (e.g. juridique planned before finance,
  // legacy 'pending' rows aliased to pending_finance, etc.).
  const pendingSales = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (sales || [])
      .filter((s) => {
        const st = String(s.status || '')
        if (['cancelled', 'rejected', 'completed'].includes(st)) return false
        if (!s.coordinationFinanceAt) return false
        if (s.financeValidatedAt || s.financeConfirmedAt) return false
        return true
      })
      .filter((s) => {
        if (!q) return true
        const hay = `${s.clientName || ''} ${s.projectTitle || ''} ${s.code || s.id || ''} ${normalizePlotIds(s).join(',')}`.toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  }, [sales, query])

  const sellerById = useMemo(() => {
    const m = new Map()
    for (const u of adminUsers || []) m.set(String(u.id), u)
    return m
  }, [adminUsers])

  const detailSale = useMemo(
    () => (sales || []).find((s) => String(s.id) === String(detailSaleId)) || null,
    [sales, detailSaleId],
  )

  // ---- KPIs ---------------------------------------------------------------
  const kpis = useMemo(() => {
    let total = 0
    let advance = 0
    let companyFees = 0
    let notaryFees = 0
    for (const s of pendingSales) {
      const agreed = Number(s.agreedPrice) || 0
      const dep = Number(s.deposit) || 0
      total += agreed
      advance += dep
      const { company, notary } = feeRatesFromSale(s)
      companyFees += agreed * company
      notaryFees += agreed * notary
    }
    return {
      count: pendingSales.length,
      total,
      advance,
      due: Math.max(0, total - advance),
      companyFees: Math.round(companyFees),
      notaryFees: Math.round(notaryFees),
    }
  }, [pendingSales])

  // ---- Pager --------------------------------------------------------------
  const pageCount = Math.max(1, Math.ceil(pendingSales.length / PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pagedSales = useMemo(
    () => pendingSales.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE),
    [pendingSales, safePage],
  )

  // ---- Calendar -----------------------------------------------------------
  const salesByDate = useMemo(() => {
    const m = new Map()
    for (const s of pendingSales) {
      const key = saleDateKey(s)
      if (!key) continue
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(s)
    }
    return m
  }, [pendingSales])
  const monthCells = useMemo(() => monthGrid(monthAnchor), [monthAnchor])
  const dayAgenda = useMemo(() => salesByDate.get(selectedDate) || [], [salesByDate, selectedDate])
  const monthLabel = monthAnchor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  const showSkeletons = salesLoading && pendingSales.length === 0

  // ---- Actions -------------------------------------------------------------
  async function approveSale(sale) {
    if (approving) return
    const now = new Date().toISOString()
    const res = await runSafeAction({
      setBusy: setApproving,
      onError: (msg) => showToast(msg, false),
      label: 'Valider le paiement',
    }, async () => {
      await salesUpdate(sale.id, {
        status: 'pending_legal',
        pipelineStatus: 'pending_legal',
        financeConfirmedAt: now,
        financeValidatedAt: now,
        financeValidatedBy: adminUser?.id || null,
        paymentMethod: sale.paymentMethod || 'bank_transfer',
        notes: sale.notes || '',
      })
    })
    if (res.ok) {
      showToast('Paiement validé. Dossier envoyé au notaire.')
      setDetailSaleId(null)
    }
  }

  const onQueryChange = (e) => { setQuery(e.target.value); setPage(1) }

  const renderSaleCard = (sale) => {
    const seller = sellerById.get(String(sale.agentId || sale.managerId || ''))
    const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
    return (
      <button
        key={sale.id}
        type="button"
        className="sp-card sp-card--orange"
        onClick={() => setDetailSaleId(sale.id)}
        aria-label={`Ouvrir le dossier de ${sale.clientName || 'client'}`}
      >
        <div className="sp-card__head">
          <div className="sp-card__user">
            <span className="sp-card__initials">{initials(sale.clientName)}</span>
            <div style={{ minWidth: 0 }}>
              <p className="sp-card__name">{sale.clientName || 'Client'}</p>
              <p className="sp-card__sub">
                {sale.projectTitle || 'Projet'} · Parcelle {plotLabel}
              </p>
            </div>
          </div>
          <span className="sp-badge sp-badge--orange">À valider</span>
        </div>

        <div className="sp-card__body">
          <div className="sp-card__price">
            <span className="sp-card__amount">{(Number(sale.agreedPrice) || 0).toLocaleString('fr-FR')}</span>
            <span className="sp-card__currency">TND</span>
          </div>
          <div className="sp-card__info">
            <span>{sale.paymentType === 'installments' ? 'Échelonné' : 'Comptant'}</span>
            <span> · Vendeur : {seller?.name || 'Commercial'}</span>
          </div>
        </div>
      </button>
    )
  }

  // ---- Render --------------------------------------------------------------
  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero fv-hero">
        <div className="sp-hero__avatar fv-hero__icon" aria-hidden>
          <span>💰</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Finance</h1>
          <p className="sp-hero__role">Vérifier, encaisser et transmettre au notaire</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : kpis.count}
          </span>
          <span className="sp-hero__kpi-label">à valider</span>
        </div>
      </header>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{showSkeletons ? <span className="sk-num" /> : kpis.count}</strong> dossier{kpis.count > 1 ? 's' : ''}
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num sk-num--wide" /> : kpis.total.toLocaleString('fr-FR')}</strong> TND total
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num sk-num--wide" /> : kpis.advance.toLocaleString('fr-FR')}</strong> TND avance
          <span className="sp-cat-stat-dot" />
          <strong title="Somme des frais société (commission Zitouna) sur les dossiers en attente">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : kpis.companyFees.toLocaleString('fr-FR')}
          </strong> TND frais société
          <span className="sp-cat-stat-dot" />
          <strong title="Somme des frais notaire transférés sur les dossiers en attente">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : kpis.notaryFees.toLocaleString('fr-FR')}
          </strong> TND frais notaire
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Rechercher un client, projet, code ou parcelle…"
            aria-label="Rechercher un dossier"
            value={query}
            onChange={onQueryChange}
          />
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
            <span className="fv-chip__count">{pendingSales.length}</span>
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
              data={pagedSales}
              isEmpty={() => pendingSales.length === 0}
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
                  <span className="sp-empty__emoji" aria-hidden>{query ? '🔍' : '✅'}</span>
                  <div className="sp-empty__title">
                    {query ? 'Aucun résultat.' : 'Aucun dossier à valider.'}
                  </div>
                  <p className="fv-empty__text">
                    {query
                      ? 'Essayez un autre mot-clé.'
                      : 'Les ventes envoyées par la coordination apparaîtront ici.'}
                  </p>
                </div>
              }
            >
              {(rows) => rows.map((sale) => renderSaleCard(sale))}
            </RenderDataGate>
          </div>

          {!showSkeletons && pendingSales.length > PER_PAGE && (
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
                {(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, pendingSales.length)} / {pendingSales.length}
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
              const count = (salesByDate.get(iso) || []).length
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
                <div className="sp-empty__title">Aucun dossier ce jour.</div>
              </div>
            ) : (
              <div className="sp-cards">
                {dayAgenda.map((sale) => renderSaleCard(sale))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Detail modal ───────────────────────────────────────── */}
      <AdminModal
        open={Boolean(detailSale)}
        onClose={() => setDetailSaleId(null)}
        title=""
        width={560}
      >
        {detailSale && (() => {
          const s = detailSale
          const seller = sellerById.get(String(s.agentId || s.managerId || ''))
          const plotLabel = normalizePlotIds(s).map((id) => `#${id}`).join(', ') || '—'
          const agreed = Number(s.agreedPrice) || 0
          const advance = Number(s.deposit) || 0
          const { companyPct, notaryPct, company: cr, notary: nr } = feeRatesFromSale(s)
          const companyFee = Math.round(agreed * cr)
          const notaryFee = Math.round(agreed * nr)
          const isInst = s.paymentType === 'installments'
          const downPct = Number(s.offerDownPayment) || 0
          const firstInstallment = isInst && downPct > 0 ? Math.round(agreed * downPct / 100) : agreed
          const due = Math.max(0, firstInstallment - advance)
          const net = Math.max(0, due - companyFee - notaryFee)

          // Projected monthly schedule for "Échelonné" sales. The real plan is
          // only generated at notary stage, so this is a preview based on the
          // frozen offer terms anchored at the Finance RDV (or today as
          // fallback). Matches `ensureInstallmentPlanFromSale`: month 1 due =
          // anchor, month N due = anchor + (duration - 1) months.
          const duration = Math.max(0, Number(s.offerDuration) || 0)
          const principal = Math.max(0, agreed - firstInstallment)
          const monthly = isInst && duration > 0 ? Math.round(principal / duration) : 0
          const scheduleAnchor = (() => {
            const raw = s.financeValidatedAt || s.financeConfirmedAt || s.coordinationFinanceAt
            const d = raw ? new Date(raw) : new Date()
            return Number.isNaN(d.getTime()) ? new Date() : d
          })()
          const addMonthsDate = (d, n) => {
            const copy = new Date(d)
            copy.setMonth(copy.getMonth() + n)
            return copy
          }
          const firstMonthlyDue = isInst && duration > 0 ? addMonthsDate(scheduleAnchor, 0) : null
          const lastMonthlyDue = isInst && duration > 0 ? addMonthsDate(scheduleAnchor, duration - 1) : null
          return (
            <div className="sp-detail fv-detail">
              <div className="sp-detail__banner">
                <div className="sp-detail__banner-top">
                  <span className="sp-badge sp-badge--orange">À valider</span>
                  <span className="sp-detail__date">{fmtDate(s.createdAt)}</span>
                </div>
                <div className="sp-detail__price">
                  <span className="sp-detail__price-num">{due.toLocaleString('fr-FR')}</span>
                  <span className="sp-detail__price-cur">TND</span>
                </div>
                <p className="sp-detail__banner-sub">
                  {s.clientName || 'Client'} · Réf. {s.code || s.id}
                </p>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Acheteur</div>
                <div className="sp-detail__row"><span>Nom</span><strong>{s.clientName || '—'}</strong></div>
                <div className="sp-detail__row"><span>Téléphone</span><strong style={{ direction: 'ltr' }}>{s.clientPhone || s.buyerPhoneClaim || s.buyerPhoneNormalized || '—'}</strong></div>
                {s.clientEmail && (
                  <div className="sp-detail__row"><span>Email</span><strong style={{ wordBreak: 'break-all' }}>{s.clientEmail}</strong></div>
                )}
                <div className="sp-detail__row"><span>CIN</span><strong style={{ direction: 'ltr' }}>{s.clientCin || '—'}</strong></div>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Vendeur</div>
                <div className="sp-detail__row"><span>Nom</span><strong>{seller?.name || 'Commercial'}</strong></div>
                <div className="sp-detail__row"><span>Email</span><strong style={{ wordBreak: 'break-all' }}>{seller?.email || '—'}</strong></div>
                <div className="sp-detail__row"><span>Téléphone</span><strong style={{ direction: 'ltr' }}>{seller?.phone || '—'}</strong></div>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Vente</div>
                <div className="sp-detail__row"><span>Projet</span><strong>{s.projectTitle || '—'}</strong></div>
                <div className="sp-detail__row"><span>Parcelle(s)</span><strong>{plotLabel}</strong></div>
                <div className="sp-detail__row"><span>Offre</span><strong>{s.offerName || (s.paymentType === 'installments' ? 'Échelonné' : 'Comptant')}</strong></div>
                <div className="sp-detail__row"><span>Mode paiement</span><strong>{s.paymentType === 'installments' ? 'Échelonné' : 'Comptant'}</strong></div>
                <div className="sp-detail__row"><span>Date création</span><strong>{fmtDate(s.createdAt)}</strong></div>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Coordination</div>
                <div className="sp-detail__row"><span>RDV Finance</span><strong>{fmtDateTime(s.coordinationFinanceAt)}</strong></div>
                <div className="sp-detail__row"><span>RDV Juridique</span><strong>{fmtDateTime(s.coordinationJuridiqueAt)}</strong></div>
                {s.coordinationNotes ? (
                  <p className="fv-detail__notes">{s.coordinationNotes}</p>
                ) : null}
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Détail financier</div>
                <div className="sp-detail__row"><span>Prix de vente</span><strong>{fmtMoney(agreed)}</strong></div>
                {isInst && downPct > 0 && (
                  <>
                    <div className="sp-detail__row">
                      <span>1er versement ({downPct}%)</span>
                      <strong>{fmtMoney(firstInstallment)}</strong>
                    </div>
                    <div className="sp-detail__row">
                      <span>Capital restant</span>
                      <strong>{fmtMoney(Math.max(0, agreed - firstInstallment))}</strong>
                    </div>
                    {duration > 0 && (
                      <>
                        <div className="sp-detail__row">
                          <span>Durée échelonnement</span>
                          <strong>{duration} mois · {fmtMoney(monthly)} / mois</strong>
                        </div>
                        <div className="sp-detail__row">
                          <span>1ère mensualité (prévue)</span>
                          <strong>{fmtDate(firstMonthlyDue?.toISOString())}</strong>
                        </div>
                        <div className="sp-detail__row">
                          <span>Dernière mensualité (prévue)</span>
                          <strong>{fmtDate(lastMonthlyDue?.toISOString())}</strong>
                        </div>
                      </>
                    )}
                  </>
                )}
                <div className="sp-detail__row"><span>Acompte reçu</span><strong>{fmtMoney(advance)}</strong></div>
                <div className="sp-detail__row"><span>Frais société ({companyPct}%)</span><strong>{fmtMoney(companyFee)}</strong></div>
                <div className="sp-detail__row"><span>Frais notaire ({notaryPct}%)</span><strong>{fmtMoney(notaryFee)}</strong></div>
                <div className="sp-detail__row sp-detail__row--highlight">
                  <span>À encaisser{isInst && downPct > 0 ? ' (1er versement)' : ''}</span>
                  <strong>{fmtMoney(due)}</strong>
                </div>
                <div className="sp-detail__row"><span>Net après frais</span><strong>{fmtMoney(net)}</strong></div>
                {s.reservationStatus ? (
                  <div className="sp-detail__row">
                    <span>Réservation</span>
                    <strong>{s.reservationStatus}{s.reservationExpiresAt ? ` · exp. ${fmtDate(s.reservationExpiresAt)}` : ''}</strong>
                  </div>
                ) : null}
              </div>

              <div className="sp-detail__section">
                <details className="fv-audit">
                  <summary>Snapshots figés (audit)</summary>
                  <div className="fv-audit__body">
                    {getSaleSnapshotAuditRows(s).map((row) => (
                      <div key={row.key} className="fv-audit__row">
                        <span>{row.label}</span>
                        <strong>{row.value}</strong>
                      </div>
                    ))}
                  </div>
                </details>
              </div>

              <div className="sp-detail__actions">
                <button
                  type="button"
                  className="sp-detail__btn"
                  onClick={() => setDetailSaleId(null)}
                >
                  Fermer
                </button>
                <button
                  type="button"
                  className="sp-detail__btn sp-detail__btn--edit"
                  onClick={() => setConfirmPayment({ sale: s, amount: due })}
                >
                  ✓ Valider le paiement
                </button>
              </div>
            </div>
          )
        })()}
      </AdminModal>

      {/* ── Confirm payment modal ─────────────────────────────── */}
      <AdminModal
        open={Boolean(confirmPayment)}
        onClose={() => { if (!approving) setConfirmPayment(null) }}
        title="Confirmer le paiement"
        width={420}
      >
        {confirmPayment && (
          <div className="sp-detail fv-confirm">
            <div className="fv-confirm__icon" aria-hidden>💰</div>
            <div className="fv-confirm__title">Encaisser ce montant ?</div>
            <div className="fv-confirm__amount">{fmtMoney(confirmPayment.amount)}</div>
            <p className="fv-confirm__hint">
              Le dossier passera en statut « En attente juridique » et sera transféré au notaire.
              Cette action est enregistrée dans l'audit.
            </p>
            <div className="sp-detail__actions">
              <button
                type="button"
                className="sp-detail__btn"
                onClick={() => setConfirmPayment(null)}
                disabled={approving}
              >
                Annuler
              </button>
              <button
                type="button"
                className="sp-detail__btn sp-detail__btn--edit"
                onClick={async () => {
                  const payload = confirmPayment
                  setConfirmPayment(null)
                  await approveSale(payload.sale)
                }}
                disabled={approving}
              >
                {approving ? 'Validation…' : '✓ Confirmer'}
              </button>
            </div>
          </div>
        )}
      </AdminModal>

      {/* ── Toast (flash notification, top of page) ───────────── */}
      {toast ? (
        <div
          className={`fv-toast${toast.ok ? ' fv-toast--ok' : ' fv-toast--err'}`}
          role="status"
          onClick={() => setToast(null)}
        >
          <span className="fv-toast__icon" aria-hidden>{toast.ok ? '✓' : '✕'}</span>
          <span className="fv-toast__msg">{toast.msg}</span>
        </div>
      ) : null}
    </div>
  )
}
