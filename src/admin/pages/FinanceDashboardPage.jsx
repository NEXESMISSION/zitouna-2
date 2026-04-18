import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { getSaleSnapshotAuditRows } from '../../lib/saleSnapshotAudit.js'
import { useAdminUsers, useSales } from '../../lib/useSupabase.js'
import './finance-dashboard.css'

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

function fmtMoney(v) {
  return `${(Number(v) || 0).toLocaleString('fr-FR')} TND`
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso)
  }
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

function normalizePlotIds(sale) {
  const ids = Array.isArray(sale?.plotIds)
    ? sale.plotIds
    : sale?.plotId != null
      ? [sale.plotId]
      : []
  return ids.map((x) => Number(x)).filter((n) => Number.isFinite(n))
}

function toIsoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function monthGrid(anchorDate) {
  const first = startOfMonth(anchorDate)
  const startWeekday = (first.getDay() + 6) % 7
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = []
  let day = 1 - startWeekday
  for (let i = 0; i < 42; i += 1) {
    const cur = new Date(first.getFullYear(), first.getMonth(), day)
    cells.push({ date: cur, inMonth: day >= 1 && day <= daysInMonth })
    day += 1
  }
  return cells
}

function saleDateKey(sale) {
  const iso = sale?.createdAt || ''
  return iso ? iso.slice(0, 10) : ''
}

export default function FinanceDashboardPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { sales, update: salesUpdate } = useSales()
  const { adminUsers } = useAdminUsers()

  const [view, setView] = useState('list')
  const [query, setQuery] = useState('')
  const [selectedSaleId, setSelectedSaleId] = useState(null)
  const [toast, setToast] = useState(null)
  const [confirmPayment, setConfirmPayment] = useState(null)
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()))

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    window.setTimeout(() => setToast(null), 2800)
  }

  const pendingSales = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (sales || [])
      .filter((s) => {
        const st = String(s.status || '')
        if (['cancelled', 'rejected', 'completed'].includes(st)) return false
        // Finance queue is explicit: Coordination must dispatch the dossier to Finance.
        return st === 'pending_finance'
      })
      .filter((s) => {
        if (!q) return true
        const client = String(s.clientName || '').toLowerCase()
        const project = String(s.projectTitle || '').toLowerCase()
        const code = String(s.code || s.id || '').toLowerCase()
        const plotText = normalizePlotIds(s).join(',').toLowerCase()
        return client.includes(q) || project.includes(q) || code.includes(q) || plotText.includes(q)
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  }, [sales, query])

  const selectedSale = useMemo(
    () => pendingSales.find((s) => String(s.id) === String(selectedSaleId)) || null,
    [pendingSales, selectedSaleId],
  )

  const sellerById = useMemo(() => {
    const map = new Map()
    for (const u of adminUsers || []) map.set(String(u.id), u)
    return map
  }, [adminUsers])

  const totalPendingAmount = useMemo(
    () => pendingSales.reduce((sum, s) => sum + (Number(s.agreedPrice) || 0), 0),
    [pendingSales],
  )

  const totalAdvance = useMemo(
    () => pendingSales.reduce((sum, s) => sum + (Number(s.deposit) || 0), 0),
    [pendingSales],
  )

  const salesByDate = useMemo(() => {
    const map = new Map()
    for (const s of pendingSales) {
      const key = saleDateKey(s)
      if (!key) continue
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(s)
    }
    return map
  }, [pendingSales])

  const monthCells = useMemo(() => monthGrid(monthAnchor), [monthAnchor])
  const dayAgenda = useMemo(() => salesByDate.get(selectedDate) || [], [salesByDate, selectedDate])
  const monthLabel = monthAnchor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  async function approveSale(sale) {
    const now = new Date().toISOString()
    await salesUpdate(sale.id, {
      status: 'pending_legal',
      pipelineStatus: 'pending_legal',
      financeConfirmedAt: now,
      financeValidatedAt: now,
      financeValidatedBy: adminUser?.id || null,
      paymentMethod: sale.paymentMethod || 'bank_transfer',
      notes: sale.notes || '',
    })
    showToast('Paiement valide. Vente envoyee au notaire.')
    setSelectedSaleId(null)
  }

  function renderSaleCard(sale) {
    const seller = sellerById.get(String(sale.agentId || sale.managerId || ''))
    const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
    return (
      <article
        key={sale.id}
        className="fd-card"
        onClick={() => setSelectedSaleId(sale.id)}
        role="button"
        tabIndex={0}
        title="Ouvrir le dossier pour valider le paiement"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedSaleId(sale.id) } }}
      >
        <div className="fd-card__top">
          <span className="fd-card__initials" aria-hidden>{initials(sale.clientName)}</span>
          <div className="fd-card__info">
            <p className="fd-card__name">{sale.clientName || 'Client'}</p>
            <p className="fd-card__sub">{sale.projectTitle || 'Projet'} • Parcelle {plotLabel}</p>
          </div>
          <div className="fd-card__right">
            <span className="fd-card__badge" title="Ce dossier attend votre validation">À valider</span>
          </div>
        </div>
        <div className="fd-card__amount-bar" title="Prix total convenu pour cette vente">
          <span className="fd-card__amount-num">{fmtMoney(sale.agreedPrice)}</span>
          <span className="fd-card__amount-type">{sale.paymentType === 'installments' ? 'Échelonné' : 'Comptant'}</span>
        </div>
        <div className="fd-card__footer">
          <span className="fd-card__agent-label">
            Vendeur : {seller?.name || 'Commercial'} · Avance déjà reçue : {fmtMoney(sale.deposit)}
          </span>
        </div>
      </article>
    )
  }

  return (
    <div className="finance-dash" dir="ltr">
      <div className="finance-dash__column">
        <button
          type="button"
          className="ds-back-btn"
          onClick={() => {
            if (selectedSale) { setSelectedSaleId(null); return }
            navigate(-1)
          }}
        >
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Back</span>
        </button>

        {!selectedSale ? (
          <>
            <section className="fd-hero">
              <div className="fd-hero__top">
                <div className="fd-hero__user">
                  <div className="fd-hero__icon" aria-hidden>💰</div>
                  <div>
                    <h1 className="fd-hero__name">Validation finance</h1>
                    <p className="fd-hero__role">Bonjour {adminUser?.name || 'équipe finance'}</p>
                  </div>
                </div>
              </div>
              <div className="fd-hero__hint">
                Vérifiez les dossiers ci-dessous, confirmez l'encaissement, puis transmettez au notaire.
              </div>
              <div className="fd-hero__kpi" role="group" aria-label="Résumé des dossiers en attente">
                <div className="fd-hero__kpi-block" title="Nombre de dossiers en attente de validation">
                  <span className="fd-hero__kpi-num">{pendingSales.length}</span>
                  <span className="fd-hero__kpi-unit">Dossiers</span>
                </div>
                <span className="fd-hero__kpi-sep" aria-hidden />
                <div className="fd-hero__kpi-block" title="Montant total des ventes à encaisser">
                  <span className="fd-hero__kpi-num">{fmtMoney(totalPendingAmount)}</span>
                  <span className="fd-hero__kpi-unit">Total ventes</span>
                </div>
                <span className="fd-hero__kpi-sep" aria-hidden />
                <div className="fd-hero__kpi-block" title="Avances déjà versées par les clients">
                  <span className="fd-hero__kpi-num">{fmtMoney(totalAdvance)}</span>
                  <span className="fd-hero__kpi-unit">Avances reçues</span>
                </div>
              </div>
            </section>

            {/* Tabs: Liste / Calendrier */}
            <div className="fd-tabs" role="tablist" aria-label="Mode d'affichage">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'list'}
                className={`fd-tab${view === 'list' ? ' fd-tab--on' : ''}`}
                onClick={() => setView('list')}
                title="Afficher la liste des dossiers en attente"
              >
                <span className="fd-tab__ico" aria-hidden>📋</span>
                <span>Liste des dossiers</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'calendar'}
                className={`fd-tab${view === 'calendar' ? ' fd-tab--on' : ''}`}
                onClick={() => setView('calendar')}
                title="Afficher le calendrier des dossiers"
              >
                <span className="fd-tab__ico" aria-hidden>📅</span>
                <span>Calendrier</span>
              </button>
            </div>

            {view === 'list' && (
              <>
                <p className="fd-section-hint">
                  Cliquez sur un dossier pour consulter le détail financier et valider le paiement.
                </p>
                <div className="fd-search">
                  <span className="fd-search__ico" aria-hidden>🔎</span>
                  <input
                    className="fd-search__input"
                    placeholder="Rechercher par client, projet, parcelle ou référence…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Rechercher un dossier"
                  />
                </div>

                <section className="fd-queue" aria-label="Liste des dossiers en attente">
                  {pendingSales.length === 0 ? (
                    <div className="fd-queue__empty">
                      <span className="fd-queue__empty-ico" aria-hidden>✅</span>
                      <strong>{query ? 'Aucun résultat' : 'Aucun dossier à valider'}</strong>
                      {query
                        ? 'Essayez un autre mot-clé ou effacez la recherche.'
                        : 'Les ventes envoyées par la coordination apparaîtront ici automatiquement.'}
                    </div>
                  ) : (
                    pendingSales.map(renderSaleCard)
                  )}
                </section>
              </>
            )}

            {view === 'calendar' && (
              <>
                <p className="fd-section-hint">
                  Sélectionnez une date pour voir les dossiers créés ce jour.
                </p>
                <div className="fd-cal-wrap">
                  <div className="fd-cal-toolbar">
                    <button
                      type="button"
                      className="fd-cal-nav"
                      onClick={() => setMonthAnchor((d) => addMonths(d, -1))}
                      aria-label="Mois précédent"
                      title="Mois précédent"
                    >‹</button>
                    <span className="fd-cal-month">{monthLabel}</span>
                    <button
                      type="button"
                      className="fd-cal-nav"
                      onClick={() => setMonthAnchor((d) => addMonths(d, 1))}
                      aria-label="Mois suivant"
                      title="Mois suivant"
                    >›</button>
                  </div>

                  <div className="fd-cal-weekhead" aria-hidden>
                    {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
                      <span key={d} className="fd-cal-weekday">{d}</span>
                    ))}
                  </div>
                  <div className="fd-cal-grid-month" role="grid" aria-label="Calendrier">
                    {monthCells.map((cell) => {
                      const iso = toIsoDate(cell.date)
                      const count = (salesByDate.get(iso) || []).length
                      const isSel = iso === selectedDate
                      const dayTitle = count > 0
                        ? `${fmtDate(iso)} — ${count} dossier${count > 1 ? 's' : ''}`
                        : fmtDate(iso)
                      return (
                        <button
                          key={`${iso}-${cell.inMonth ? 'in' : 'out'}`}
                          type="button"
                          className={`fd-cal-day${cell.inMonth ? '' : ' fd-cal-day--muted'}${isSel ? ' fd-cal-day--selected' : ''}`}
                          onClick={() => setSelectedDate(iso)}
                          title={dayTitle}
                          aria-pressed={isSel}
                        >
                          <span className="fd-cal-day__num">{cell.date.getDate()}</span>
                          {count > 0 ? <span className="fd-cal-day__dot" aria-label={`${count} dossier${count > 1 ? 's' : ''}`}>{count}</span> : null}
                        </button>
                      )
                    })}
                  </div>

                  <div className="fd-cal-agenda">
                    <div className="fd-cal-agenda__head">{fmtDate(selectedDate)}</div>
                    {dayAgenda.length === 0 ? (
                      <div className="fd-cal-agenda__empty">Aucun dossier à valider ce jour-là.</div>
                    ) : (
                      dayAgenda.map(renderSaleCard)
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          (() => {
            const sale = selectedSale
            const seller = sellerById.get(String(sale.agentId || sale.managerId || ''))
            const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
            const agreed = Number(sale.agreedPrice) || 0
            const advance = Number(sale.deposit) || 0
            const { company: cr, notary: nr, companyPct, notaryPct } = feeRatesFromSale(sale)
            const companyFee = Math.round(agreed * cr)
            const notaryFee = Math.round(agreed * nr)
            const dueAmount = Math.max(0, agreed - advance)
            const netAfterFees = Math.max(0, dueAmount - companyFee - notaryFee)
            return (
              <>
                <section className="fd-detail__sale-info">
                  <div className="fd-detail__sale-row"><span>Client</span><strong>{sale.clientName || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Téléphone client</span><strong>{sale.clientPhone || sale.buyerPhoneClaim || sale.buyerPhoneNormalized || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Email client</span><strong>{sale.clientEmail || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>CIN client</span><strong>{sale.clientCin || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Vendeur</span><strong>{seller?.name || 'Commercial'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Email vendeur</span><strong>{seller?.email || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Téléphone vendeur</span><strong>{seller?.phone || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Projet</span><strong>{sale.projectTitle || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Parcelles</span><strong>{plotLabel}</strong></div>
                  <div className="fd-detail__sale-row"><span>Offre</span><strong>{sale.offerName || (sale.paymentType === 'installments' ? 'Echelonne' : 'Comptant')}</strong></div>
                  <div className="fd-detail__sale-row"><span>Mode paiement</span><strong>{sale.paymentType === 'installments' ? 'Echelonne' : 'Comptant'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Référence</span><strong>{sale.code || sale.id || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Statut actuel</span><strong>{sale.status || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Date création</span><strong>{fmtDate(sale.createdAt)}</strong></div>
                  <div className="fd-detail__sale-row"><span>RDV Finance (coord.)</span><strong>{sale.coordinationFinanceAt ? `${fmtDate(sale.coordinationFinanceAt)} ${new Date(sale.coordinationFinanceAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>RDV Juridique (coord.)</span><strong>{sale.coordinationJuridiqueAt ? `${fmtDate(sale.coordinationJuridiqueAt)} ${new Date(sale.coordinationJuridiqueAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Notes coordination</span><strong>{sale.coordinationNotes || '—'}</strong></div>
                  <div className="fd-detail__sale-row"><span>Notes vente</span><strong>{sale.notes || '—'}</strong></div>
                </section>

                <section className="fd-detail__sale-info fd-detail__sale-info--audit" aria-label="Snapshots figés à la création">
                  <div className="fd-detail__audit-head" style={{ padding: '8px 12px', borderBottom: '1px solid var(--100)' }}>
                    Snapshots figés (audit)
                  </div>
                  {getSaleSnapshotAuditRows(sale).map((row) => (
                    <div key={row.key} className="fd-detail__sale-row">
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                    </div>
                  ))}
                </section>

                <section className="fd-collect">
                  <div className="fd-collect__header">
                    <span className="fd-collect__header-ico">🧾</span>
                    <div>
                      <p className="fd-collect__header-title">Detail financier</p>
                      <p className="fd-collect__header-name">Validation du dossier {sale.code || sale.id}</p>
                    </div>
                  </div>

                  <div className="fd-detail__sale-info">
                    <div className="fd-detail__sale-row"><span>Prix de vente</span><strong>{fmtMoney(agreed)}</strong></div>
                    <div className="fd-detail__sale-row"><span>Acompte</span><strong>{fmtMoney(advance)}</strong></div>
                    <div className="fd-detail__sale-row">
                      <span>Frais société ({companyPct}% · snapshot)</span>
                      <strong>{fmtMoney(companyFee)}</strong>
                    </div>
                    <div className="fd-detail__sale-row">
                      <span>Frais notaire ({notaryPct}% · snapshot)</span>
                      <strong>{fmtMoney(notaryFee)}</strong>
                    </div>
                    <div className="fd-detail__sale-row"><span>Montant a encaisser</span><strong>{fmtMoney(dueAmount)}</strong></div>
                    <div className="fd-detail__sale-row"><span>Net apres frais</span><strong>{fmtMoney(netAfterFees)}</strong></div>
                    <div className="fd-detail__sale-row"><span>Réservation (statut)</span><strong>{sale.reservationStatus || '—'}</strong></div>
                    <div className="fd-detail__sale-row"><span>Expiration réservation</span><strong>{fmtDate(sale.reservationExpiresAt)}</strong></div>
                  </div>

                  <div className="fd-collect__warn">
                    Verifiez tous les champs avant validation. "Pay" transfere le dossier au notaire.
                  </div>

                  <button
                    type="button"
                    className="fd-collect__btn"
                    onClick={() => setConfirmPayment({ sale, amount: dueAmount })}
                  >
                    Pay (valider le paiement)
                  </button>
                </section>
              </>
            )
          })()
        )}

        {confirmPayment ? (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1800, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,.45)', backdropFilter: 'blur(5px)' }} onClick={() => setConfirmPayment(null)}>
            <div style={{ padding: '20px 24px', borderRadius: 12, textAlign: 'center', background: 'linear-gradient(135deg, #0f172a, #1e293b)', color: '#fff', boxShadow: '0 20px 56px rgba(0,0,0,.24)', minWidth: 260, maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(255,255,255,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, margin: '0 auto 10px' }}>💰</div>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>Confirmation paiement</div>
              <div style={{ fontSize: 12, fontWeight: 500, opacity: .9, lineHeight: 1.45 }}>
                Confirmer l'encaissement de <strong>{fmtMoney(confirmPayment.amount)}</strong> ?
              </div>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button
                  type="button"
                  onClick={() => setConfirmPayment(null)}
                  style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.12)', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const payload = confirmPayment
                    setConfirmPayment(null)
                    await approveSale(payload.sale, payload.amount)
                  }}
                  style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,.22)', background: '#059669', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                >
                  Confirmer
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {toast ? (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1800, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,.45)', backdropFilter: 'blur(5px)' }} onClick={() => setToast(null)}>
            <div style={{ padding: '20px 28px', borderRadius: 12, textAlign: 'center', background: toast.ok ? '#059669' : '#dc2626', color: '#fff', boxShadow: '0 20px 56px rgba(0,0,0,.14)', minWidth: 240, maxWidth: 320, animation: 'pp-pop .22s cubic-bezier(.16,1,.3,1)' }} onClick={(e) => e.stopPropagation()}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, margin: '0 auto 10px' }}>{toast.ok ? '✓' : '✕'}</div>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{toast.ok ? 'Success' : 'Error'}</div>
              <div style={{ fontSize: 11, fontWeight: 500, opacity: .85, lineHeight: 1.45 }}>{toast.msg}</div>
              <button type="button" onClick={() => setToast(null)} style={{ marginTop: 14, padding: '8px 24px', borderRadius: 8, border: '1px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>OK</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
