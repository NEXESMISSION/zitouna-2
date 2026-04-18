import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { getSaleSnapshotAuditRows } from '../../lib/saleSnapshotAudit.js'
import { useAdminUsers, useSales } from '../../lib/useSupabase.js'
import AdminModal from '../components/AdminModal.jsx'
import './finance-dashboard.css'
import './sell-field.css'

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
function fmtMoneyShort(v) {
  const n = Number(v) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  return `${n.toLocaleString('fr-FR', { maximumFractionDigits: 0 })}`
}
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
function getPagerPages(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out = [1]
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)
  if (left > 2) out.push('…')
  for (let i = left; i <= right; i++) out.push(i)
  if (right < total - 1) out.push('…')
  out.push(total)
  return out
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function FinanceDashboardPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { sales, update: salesUpdate } = useSales()
  const { adminUsers } = useAdminUsers()

  const [view, setView] = useState('list')
  const [query, setQuery] = useState('')
  const [detailSaleId, setDetailSaleId] = useState(null)
  const [confirmPayment, setConfirmPayment] = useState(null)
  const [toast, setToast] = useState(null)
  const [page, setPage] = useState(1)
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()))

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    window.setTimeout(() => setToast(null), 2800)
  }

  // ---- Pending sales queue -------------------------------------------------
  const pendingSales = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (sales || [])
      .filter((s) => String(s.status || '') === 'pending_finance')
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
    const total = pendingSales.reduce((sum, s) => sum + (Number(s.agreedPrice) || 0), 0)
    const advance = pendingSales.reduce((sum, s) => sum + (Number(s.deposit) || 0), 0)
    return { count: pendingSales.length, total, advance, due: Math.max(0, total - advance) }
  }, [pendingSales])

  // ---- Pager --------------------------------------------------------------
  const pageCount = Math.max(1, Math.ceil(pendingSales.length / PER_PAGE))
  const pagedSales = useMemo(
    () => pendingSales.slice((page - 1) * PER_PAGE, page * PER_PAGE),
    [pendingSales, page],
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

  // ---- Actions -------------------------------------------------------------
  async function approveSale(sale) {
    const now = new Date().toISOString()
    try {
      await salesUpdate(sale.id, {
        status: 'pending_legal',
        pipelineStatus: 'pending_legal',
        financeConfirmedAt: now,
        financeValidatedAt: now,
        financeValidatedBy: adminUser?.id || null,
        paymentMethod: sale.paymentMethod || 'bank_transfer',
        notes: sale.notes || '',
      })
      showToast('Paiement validé. Dossier envoyé au notaire.')
      setDetailSaleId(null)
    } catch (e) {
      console.error('approveSale', e)
      showToast('Erreur lors de la validation', false)
    }
  }

  // ---- Render --------------------------------------------------------------
  return (
    <div className="sell-field fin-v3" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      {/* ── Topbar ─────────────────────────────────────────────── */}
      <header className="fv-topbar">
        <div className="fv-topbar__title">
          <h1 className="fv-topbar__h1">Validation finance</h1>
          <p className="fv-topbar__sub">Vérifier, encaisser et transmettre au notaire.</p>
        </div>
        <div className="fv-topbar__kpis">
          <span className="fv-kpi-pill" title="Dossiers en attente">
            <strong>{kpis.count}</strong><span>dossier{kpis.count > 1 ? 's' : ''}</span>
          </span>
          <span className="fv-kpi-pill fv-kpi-pill--info" title="Valeur totale">
            <strong>{fmtMoneyShort(kpis.total)}</strong><span>TND total</span>
          </span>
          <span className="fv-kpi-pill fv-kpi-pill--good" title="Avances déjà reçues">
            <strong>{fmtMoneyShort(kpis.advance)}</strong><span>avance</span>
          </span>
        </div>
      </header>

      {/* ── Tabs ──────────────────────────────────────────────── */}
      <div className="fv-tabs" role="tablist">
        <button
          type="button" role="tab" aria-selected={view === 'list'}
          className={`fv-tab${view === 'list' ? ' fv-tab--on' : ''}`}
          onClick={() => setView('list')}
        >
          Liste
          <span className="fv-tab__count">{pendingSales.length}</span>
        </button>
        <button
          type="button" role="tab" aria-selected={view === 'calendar'}
          className={`fv-tab${view === 'calendar' ? ' fv-tab--on' : ''}`}
          onClick={() => setView('calendar')}
        >
          Calendrier
        </button>
      </div>

      {view === 'list' && (
        <>
          <div className="fv-search">
            <input
              type="search" value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1) }}
              placeholder="Rechercher un client, projet, code ou parcelle…"
              aria-label="Rechercher un dossier"
            />
          </div>

          <section className="sp-cards fv-queue">
            {pendingSales.length === 0 ? (
              <div className="sp-empty">
                <span className="sp-empty__emoji" aria-hidden>✅</span>
                <div className="sp-empty__title">
                  {query ? 'Aucun résultat' : 'Aucun dossier à valider'}
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }}>
                  {query
                    ? 'Essayez un autre mot-clé.'
                    : 'Les ventes envoyées par la coordination apparaîtront ici.'}
                </p>
              </div>
            ) : (
              pagedSales.map((sale) => {
                const seller = sellerById.get(String(sale.agentId || sale.managerId || ''))
                const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
                return (
                  <article
                    key={sale.id}
                    className="sp-card fv-card"
                    role="button" tabIndex={0}
                    onClick={() => setDetailSaleId(sale.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setDetailSaleId(sale.id)
                      }
                    }}
                  >
                    <div className="sp-card__head">
                      <div className="sp-card__user">
                        <span className="sp-card__initials" aria-hidden>{initials(sale.clientName)}</span>
                        <div>
                          <p className="sp-card__name">{sale.clientName || 'Client'}</p>
                          <p className="sp-card__sub">{sale.projectTitle || 'Projet'} · Parcelle {plotLabel}</p>
                        </div>
                      </div>
                      <span className="sp-badge sp-badge--orange">À valider</span>
                    </div>

                    <div className="fv-card__amount-row">
                      <div className="fv-card__amount">
                        <span className="fv-card__amount-num">{fmtMoney(sale.agreedPrice)}</span>
                        <span className="fv-card__amount-type">
                          {sale.paymentType === 'installments' ? 'Échelonné' : 'Comptant'}
                        </span>
                      </div>
                      <div className="fv-card__meta">
                        <span>Avance : <strong>{fmtMoney(sale.deposit)}</strong></span>
                        <span>Vendeur : {seller?.name || 'Commercial'}</span>
                      </div>
                    </div>
                  </article>
                )
              })
            )}
          </section>

          {pendingSales.length > PER_PAGE && (
            <div className="sp-pager" role="navigation" aria-label="Pagination">
              <button
                type="button" className="sp-pager__btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Page précédente"
              >‹</button>
              {getPagerPages(page, pageCount).map((p, i) =>
                p === '…' ? (
                  <span key={`d-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
                ) : (
                  <button
                    key={p} type="button"
                    className={`sp-pager__btn${p === page ? ' sp-pager__btn--active' : ''}`}
                    onClick={() => setPage(p)}
                    aria-current={p === page ? 'page' : undefined}
                  >{p}</button>
                ),
              )}
              <button
                type="button" className="sp-pager__btn"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                aria-label="Page suivante"
              >›</button>
              <span className="sp-pager__info">
                {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, pendingSales.length)} / {pendingSales.length}
              </span>
            </div>
          )}
        </>
      )}

      {view === 'calendar' && (
        <section className="fv-cal">
          <div className="fv-cal__nav">
            <button type="button" className="fv-cal__nav-btn" onClick={() => setMonthAnchor((d) => addMonths(d, -1))}>‹</button>
            <span className="fv-cal__month">{monthLabel}</span>
            <button type="button" className="fv-cal__nav-btn" onClick={() => setMonthAnchor((d) => addMonths(d, 1))}>›</button>
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
              <div className="fv-cal__agenda-empty">Aucun dossier ce jour.</div>
            ) : (
              dayAgenda.map((sale) => {
                const seller = sellerById.get(String(sale.agentId || sale.managerId || ''))
                const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
                return (
                  <article
                    key={sale.id} className="sp-card fv-card fv-card--agenda"
                    role="button" tabIndex={0}
                    onClick={() => setDetailSaleId(sale.id)}
                  >
                    <div className="sp-card__head">
                      <div className="sp-card__user">
                        <span className="sp-card__initials">{initials(sale.clientName)}</span>
                        <div>
                          <p className="sp-card__name">{sale.clientName || 'Client'}</p>
                          <p className="sp-card__sub">{sale.projectTitle || 'Projet'} · Parcelle {plotLabel}</p>
                        </div>
                      </div>
                      <span className="sp-badge sp-badge--orange">À valider</span>
                    </div>
                    <div className="fv-card__amount-row">
                      <div className="fv-card__amount">
                        <span className="fv-card__amount-num">{fmtMoney(sale.agreedPrice)}</span>
                      </div>
                      <div className="fv-card__meta">
                        <span>Vendeur : {seller?.name || 'Commercial'}</span>
                      </div>
                    </div>
                  </article>
                )
              })
            )}
          </div>
        </section>
      )}

      {/* ── Detail modal ───────────────────────────────────────── */}
      <AdminModal
        open={Boolean(detailSale)}
        onClose={() => setDetailSaleId(null)}
        title="Dossier à valider"
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
          const due = Math.max(0, agreed - advance)
          const net = Math.max(0, due - companyFee - notaryFee)
          return (
            <div className="fv-detail">
              <div className="fv-detail__head">
                <div>
                  <div className="fv-detail__name">{s.clientName || 'Client'}</div>
                  <div className="fv-detail__code">Réf : <code>{s.code || s.id}</code></div>
                </div>
                <span className="sp-badge sp-badge--orange">À valider</span>
              </div>

              {/* Money bar — the ONE big number to anchor the eye. */}
              <div className="fv-detail__money">
                <div className="fv-detail__money-row">
                  <span className="fv-detail__money-lbl">Montant à encaisser</span>
                  <span className="fv-detail__money-val">{fmtMoney(due)}</span>
                </div>
                <div className="fv-detail__money-sub">
                  Prix {fmtMoney(agreed)} · Avance {fmtMoney(advance)} · Net après frais {fmtMoney(net)}
                </div>
              </div>

              <DetailBlock title="Acheteur">
                <Row k="Nom" v={s.clientName || '—'} />
                <Row k="Téléphone" v={s.clientPhone || s.buyerPhoneClaim || s.buyerPhoneNormalized || '—'} />
                <Row k="Email" v={s.clientEmail || '—'} />
                <Row k="CIN" v={s.clientCin || '—'} mono />
              </DetailBlock>

              <DetailBlock title="Vendeur">
                <Row k="Nom" v={seller?.name || 'Commercial'} />
                <Row k="Email" v={seller?.email || '—'} />
                <Row k="Téléphone" v={seller?.phone || '—'} />
              </DetailBlock>

              <DetailBlock title="Vente">
                <Row k="Projet" v={s.projectTitle || '—'} />
                <Row k="Parcelle(s)" v={plotLabel} />
                <Row k="Offre" v={s.offerName || (s.paymentType === 'installments' ? 'Échelonné' : 'Comptant')} />
                <Row k="Mode paiement" v={s.paymentType === 'installments' ? 'Échelonné' : 'Comptant'} />
                <Row k="Date création" v={fmtDate(s.createdAt)} />
              </DetailBlock>

              <DetailBlock title="Coordination">
                <Row k="RDV Finance" v={fmtDateTime(s.coordinationFinanceAt)} />
                <Row k="RDV Juridique" v={fmtDateTime(s.coordinationJuridiqueAt)} />
                {s.coordinationNotes ? (
                  <div className="fv-detail__notes">{s.coordinationNotes}</div>
                ) : null}
              </DetailBlock>

              <DetailBlock title="Détail financier">
                <Row k="Prix de vente" v={fmtMoney(agreed)} />
                <Row k="Acompte reçu" v={fmtMoney(advance)} />
                <Row k={`Frais société (${companyPct}%)`} v={fmtMoney(companyFee)} />
                <Row k={`Frais notaire (${notaryPct}%)`} v={fmtMoney(notaryFee)} />
                <Row k="À encaisser" v={fmtMoney(due)} strong />
                <Row k="Net après frais" v={fmtMoney(net)} strong />
                {s.reservationStatus
                  ? <Row k="Réservation" v={`${s.reservationStatus}${s.reservationExpiresAt ? ` · exp. ${fmtDate(s.reservationExpiresAt)}` : ''}`} />
                  : null}
              </DetailBlock>

              <details className="fv-detail__audit">
                <summary>Snapshots figés (audit)</summary>
                <div className="fv-detail__audit-body">
                  {getSaleSnapshotAuditRows(s).map((row) => (
                    <div key={row.key} className="fv-detail__audit-row">
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                    </div>
                  ))}
                </div>
              </details>

              <div className="fv-detail__footer">
                <button
                  type="button" className="fv-btn fv-btn--ghost"
                  onClick={() => setDetailSaleId(null)}
                >Fermer</button>
                <button
                  type="button" className="fv-btn fv-btn--primary"
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
        onClose={() => setConfirmPayment(null)}
        title="Confirmer le paiement"
        width={420}
      >
        {confirmPayment && (
          <div className="fv-confirm">
            <div className="fv-confirm__icon" aria-hidden>💰</div>
            <div className="fv-confirm__title">Encaisser ce montant ?</div>
            <div className="fv-confirm__amount">{fmtMoney(confirmPayment.amount)}</div>
            <p className="fv-confirm__hint">
              Le dossier passera en statut « En attente juridique » et sera transféré au notaire.
              Cette action est enregistrée dans l’audit.
            </p>
            <div className="fv-confirm__actions">
              <button
                type="button" className="fv-btn fv-btn--ghost"
                onClick={() => setConfirmPayment(null)}
              >Annuler</button>
              <button
                type="button" className="fv-btn fv-btn--primary"
                onClick={async () => {
                  const payload = confirmPayment
                  setConfirmPayment(null)
                  await approveSale(payload.sale)
                }}
              >✓ Confirmer</button>
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

// ---------------------------------------------------------------------------
// Presentational helpers — same as CoordinationPage (copy small & local).
// ---------------------------------------------------------------------------
function DetailBlock({ title, children }) {
  return (
    <section className="fv-detail__block">
      <div className="fv-detail__block-title">{title}</div>
      <div className="fv-detail__block-body">{children}</div>
    </section>
  )
}

function Row({ k, v, mono, strong }) {
  return (
    <div className="fv-detail__row">
      <span className="fv-detail__row-k">{k}</span>
      <span className={`fv-detail__row-v${mono ? ' fv-detail__row-v--mono' : ''}${strong ? ' fv-detail__row-v--strong' : ''}`}>{v}</span>
    </div>
  )
}
