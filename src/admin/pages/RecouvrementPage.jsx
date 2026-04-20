import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInstallments, useSales, useClients } from '../../lib/useSupabase.js'
import { runSafeAction } from '../../lib/runSafeAction.js'
import {
  ensureInstallmentPlanFromSale,
  replayInstallmentPlansFromCompletedSales,
  updatePaymentStatus,
} from '../../lib/db.js'
import { computeInstallmentSaleMetrics, formatMoneyTnd } from '../../domain/installmentMetrics.js'
import AdminModal from '../components/AdminModal.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { SkeletonCard } from '../../components/skeletons/index.js'
import { getPagerPages } from './pager-util.js'
import './sell-field.css'
import './recouvrement.css'

const DOSSIERS_PER_PAGE = 15

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i

function fmtMoney(v) { return `${(Number(v) || 0).toLocaleString('fr-FR')} DT` }
function fmtDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) } catch { return iso }
}
function initials(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean)
  return p.length ? `${p[0][0]}${p[1]?.[0] || ''}`.toUpperCase() : 'CL'
}
function todayIso() { return new Date().toISOString().slice(0, 10) }
function isImageUrl(url) {
  if (!url) return false
  try { return IMAGE_EXT_RE.test(new URL(url).pathname) } catch { return IMAGE_EXT_RE.test(url) }
}
function latestReceipt(payment) {
  if (Array.isArray(payment.receipts) && payment.receipts.length > 0) {
    const r = payment.receipts[0]
    return { url: r.url, name: r.fileName || 'reçu', date: r.createdAt, note: r.note || '' }
  }
  if (payment.receiptUrl && String(payment.receiptUrl).startsWith('http')) {
    return { url: payment.receiptUrl, name: 'reçu', date: null, note: '' }
  }
  return null
}
function isCompletedSale(sale) {
  const st = String(sale.status || '').toLowerCase()
  const pipe = String(sale.pipelineStatus || '').toLowerCase()
  return st === 'completed' || pipe === 'completed'
}

export default function RecouvrementPage() {
  const navigate = useNavigate()
  const { plans, loading: plansLoading, refresh: refreshPlans } = useInstallments()
  const { sales, loading: salesLoading } = useSales()
  const { clients, loading: clientsLoading } = useClients()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [rejectTarget, setRejectTarget] = useState(null)
  const [rejectNote, setRejectNote] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [reviewTarget, setReviewTarget] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef(null)
  const canvasRef = useRef(null)
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairStatus, setRepairStatus] = useState('')
  const [repairSingleBusy, setRepairSingleBusy] = useState(null)
  const [page, setPage] = useState(1)
  const autoReplayRan = useRef(false)

  const TODAY = todayIso()

  const planBySaleId = useMemo(() => {
    const m = new Map()
    for (const p of plans || []) {
      if (p?.saleId) m.set(String(p.saleId), p)
    }
    return m
  }, [plans])

  const missingPlanSales = useMemo(
    () => {
      if (plansLoading || salesLoading) return []
      return (sales || []).filter((s) => {
        if (String(s.paymentType || '').toLowerCase() !== 'installments') return false
        if (!isCompletedSale(s)) return false
        if (planBySaleId.has(String(s.id))) return false
        // Only sales routed to plans (default) should appear — skip sales
        // explicitly redirected post-notary elsewhere (e.g. cash_sales).
        const dest = String(s.postNotaryDestination || '').toLowerCase()
        if (dest && dest !== 'plans') return false
        return true
      })
    },
    [sales, planBySaleId, plansLoading, salesLoading],
  )

  useEffect(() => {
    if (autoReplayRan.current) return
    if (plansLoading) return
    if (missingPlanSales.length === 0) return
    autoReplayRan.current = true
    ;(async () => {
      try {
        const res = await replayInstallmentPlansFromCompletedSales(null)
        if (res.created.length > 0) {
          await refreshPlans({ force: true })
          setRepairStatus(`Auto-réparation : ${res.created.length} plan(s) créé(s).`)
          setTimeout(() => setRepairStatus(''), 5000)
        }
      } catch (e) {
        console.warn('[recouvrement] auto-repair failed', e?.message || e)
      }
    })()
  }, [plansLoading, missingPlanSales.length, refreshPlans])

  function dossierStatus(d) {
    const hasSubmitted = d.payments.some((p) => p.status === 'submitted')
    const hasOverdue = d.payments.some((p) => (p.status === 'pending' && p.dueDate < TODAY) || p.status === 'rejected')
    if (hasSubmitted) return 'submitted'
    if (hasOverdue) return 'overdue'
    return 'ok'
  }

  const dossiers = useMemo(() => {
    return (plans || []).map((plan) => {
      const sale = (sales || []).find((s) => String(s.id) === String(plan.saleId))
      const client = sale
        ? (clients || []).find((c) => String(c.id) === String(sale.clientId))
        : null
      const metrics = computeInstallmentSaleMetrics(sale || {}, plan)
      return {
        id: plan.id,
        saleId: plan.saleId,
        sale,
        name: sale?.clientName || client?.name || 'Client',
        phone: client?.phone || sale?.buyerPhone || '',
        email: client?.email || '',
        project: plan.projectTitle || sale?.projectTitle || 'Projet',
        plotId: sale?.plotId,
        payments: (plan.payments || []).map((p) => ({ ...p })),
        metrics,
      }
    })
  }, [plans, sales, clients])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = q ? dossiers.filter((d) => d.name.toLowerCase().includes(q) || d.project.toLowerCase().includes(q)) : dossiers
    if (statusFilter !== 'all' && statusFilter !== 'missing') {
      list = list.filter((d) => dossierStatus(d) === statusFilter)
    } else if (statusFilter === 'missing') {
      list = []
    }
    return list.sort((a, b) => {
      const sa = dossierStatus(a), sb = dossierStatus(b)
      const order = { submitted: 0, overdue: 1, ok: 2 }
      return (order[sa] ?? 2) - (order[sb] ?? 2)
    })
  }, [dossiers, query, statusFilter])

  const filteredMissingPlan = useMemo(() => {
    if (statusFilter !== 'all' && statusFilter !== 'missing') return []
    const q = query.trim().toLowerCase()
    if (!q) return missingPlanSales
    return missingPlanSales.filter((s) => (
      String(s.clientName || '').toLowerCase().includes(q)
      || String(s.projectTitle || '').toLowerCase().includes(q)
    ))
  }, [missingPlanSales, query, statusFilter])

  const totalSubmitted = dossiers.reduce((s, d) => s + d.payments.filter((p) => p.status === 'submitted').length, 0)
  const totalOverdue = dossiers.reduce((s, d) => s + d.payments.filter((p) => (p.status === 'pending' && p.dueDate < TODAY) || p.status === 'rejected').length, 0)

  const selected = selectedId ? dossiers.find((d) => d.id === selectedId) : null

  const visiblePayments = useMemo(() => {
    const list = selected?.payments || []
    if (paymentFilter === 'submitted') return list.filter((p) => p.status === 'submitted')
    if (paymentFilter === 'rejected') return list.filter((p) => p.status === 'rejected')
    if (paymentFilter === 'pending') return list.filter((p) => p.status === 'pending')
    if (paymentFilter === 'approved') return list.filter((p) => p.status === 'approved')
    if (paymentFilter === 'overdue') return list.filter((p) => p.status === 'pending' && p.dueDate < TODAY)
    return list
  }, [selected, paymentFilter])

  const showActionError = (msg) => {
    setActionError(msg)
    window.setTimeout(() => setActionError(''), 6000)
  }

  const approve = async (paymentId) => {
    if (actionBusy) return
    const res = await runSafeAction({
      setBusy: setActionBusy,
      onError: showActionError,
      label: 'Approuver le paiement',
    }, async () => {
      await updatePaymentStatus(paymentId, 'approved')
      await refreshPlans({ force: true })
    })
    if (res.ok) setReviewTarget(null)
  }

  const resetPayment = async (paymentId, toStatus = 'submitted') => {
    if (actionBusy) return
    await runSafeAction({
      setBusy: setActionBusy,
      onError: showActionError,
      label: 'Réinitialiser le paiement',
    }, async () => {
      await updatePaymentStatus(paymentId, toStatus, { rejectedNote: '' })
      await refreshPlans({ force: true })
    })
  }

  const confirmReject = async () => {
    if (!rejectTarget || !rejectNote.trim() || actionBusy) return
    const res = await runSafeAction({
      setBusy: setActionBusy,
      onError: showActionError,
      label: 'Rejeter le paiement',
    }, async () => {
      await updatePaymentStatus(rejectTarget.paymentId, 'rejected', { rejectedNote: rejectNote.trim() })
      await refreshPlans({ force: true })
    })
    if (res.ok) {
      setRejectTarget(null)
      setRejectNote('')
      setReviewTarget(null)
    }
  }

  const openReview = useCallback((payment) => {
    const receipt = latestReceipt(payment)
    if (!receipt) return
    setReviewTarget({
      paymentId: payment.id,
      amount: payment.amount,
      month: payment.month,
      dueDate: payment.dueDate,
      receipt,
      status: payment.status,
      rejectedNote: payment.rejectedNote || '',
    })
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const closeReview = useCallback(() => {
    setReviewTarget(null)
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const zoomIn = useCallback(() => setZoom((z) => Math.min(5, Math.round((z + 0.5) * 10) / 10)), [])
  const zoomOut = useCallback(() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 10) / 10)), [])
  const zoomReset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  useEffect(() => {
    if (!reviewTarget) return
    const node = canvasRef.current
    if (!node) return
    const handler = (e) => {
      e.preventDefault()
      setZoom((z) => {
        const delta = e.deltaY < 0 ? 0.2 : -0.2
        return Math.max(1, Math.min(5, Math.round((z + delta) * 10) / 10))
      })
    }
    node.addEventListener('wheel', handler, { passive: false })
    return () => node.removeEventListener('wheel', handler)
  }, [reviewTarget])

  const onPanStart = useCallback((e) => {
    if (zoom <= 1) return
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y }
  }, [pan.x, pan.y, zoom])

  const onPanMove = useCallback((e) => {
    if (!dragRef.current) return
    setPan({
      x: dragRef.current.panX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.panY + (e.clientY - dragRef.current.startY),
    })
  }, [])

  const onPanEnd = useCallback(() => { dragRef.current = null }, [])

  const runBulkRepair = useCallback(async () => {
    if (repairBusy) return
    setRepairBusy(true)
    setRepairStatus('Réparation en cours…')
    try {
      const res = await replayInstallmentPlansFromCompletedSales(null)
      await refreshPlans({ force: true })
      setRepairStatus(`Réparation terminée : ${res.created.length} plan(s) créé(s), ${res.errors.length} erreur(s).`)
      setTimeout(() => setRepairStatus(''), 5000)
    } catch (e) {
      setRepairStatus(`Échec : ${e?.message || e}`)
      setTimeout(() => setRepairStatus(''), 6000)
    } finally {
      setRepairBusy(false)
    }
  }, [repairBusy, refreshPlans])

  const runSingleRepair = useCallback(async (sale) => {
    setRepairSingleBusy(sale.id)
    try {
      const planId = await ensureInstallmentPlanFromSale(sale)
      await refreshPlans({ force: true })
      if (!planId) {
        setRepairStatus('Réparation impossible : champs snapshot manquants.')
        setTimeout(() => setRepairStatus(''), 5000)
      }
    } catch (e) {
      setRepairStatus(`Échec : ${e?.message || e}`)
      setTimeout(() => setRepairStatus(''), 6000)
    } finally {
      setRepairSingleBusy(null)
    }
  }, [refreshPlans])

  const hasAnyDossier = (filtered.length + filteredMissingPlan.length) > 0
  const isInitialLoading = (plansLoading || salesLoading || clientsLoading)
    && dossiers.length === 0
  const showSkeletons = isInitialLoading

  // Pagination applies to regular dossiers only; missing-plan cards always
  // render up top (they need the repair CTA visible).
  const pageCount = Math.max(1, Math.ceil(filtered.length / DOSSIERS_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pagedFiltered = useMemo(
    () => filtered.slice((safePage - 1) * DOSSIERS_PER_PAGE, safePage * DOSSIERS_PER_PAGE),
    [filtered, safePage],
  )
  const onQueryChange = (e) => { setQuery(e.target.value); setPage(1) }
  const onStatusFilterChange = (key) => { setStatusFilter(key); setPage(1) }

  const statusFilters = [
    ['all',       'Tous',       dossiers.length + missingPlanSales.length],
    ['submitted', 'À valider',  dossiers.filter((d) => dossierStatus(d) === 'submitted').length],
    ['overdue',   'En retard',  dossiers.filter((d) => dossierStatus(d) === 'overdue').length],
    ['ok',        'À jour',     dossiers.filter((d) => dossierStatus(d) === 'ok').length],
    ['missing',   'Sans plan',  missingPlanSales.length],
  ]

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate('/admin')}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero rv-hero">
        <div className="sp-hero__avatar rv-hero__icon" aria-hidden>
          <span>💳</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Recouvrement</h1>
          <p className="sp-hero__role">Validez les reçus et suivez les impayés</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : totalSubmitted}
          </span>
          <span className="sp-hero__kpi-label">à valider</span>
        </div>
      </header>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats rv-cat-stats">
          <strong>{showSkeletons ? <span className="sk-num" /> : dossiers.length}</strong> dossiers
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : totalSubmitted}</strong> à valider
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : totalOverdue}</strong> impayé{totalOverdue > 1 ? 's' : ''}
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Rechercher client ou projet…"
            aria-label="Rechercher un dossier"
            value={query}
            onChange={onQueryChange}
          />
        </div>
        <div className="rv-chips" role="tablist" aria-label="Filtrer par statut">
          {statusFilters.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={statusFilter === key}
              disabled={key === 'missing' && count === 0}
              className={`rv-chip${statusFilter === key ? ' rv-chip--active' : ''}`}
              onClick={() => onStatusFilterChange(key)}
            >
              {label}
              <span className="rv-chip__count">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {missingPlanSales.length > 0 && (
        <div className="rv-alert rv-alert--warn" role="alert">
          <span aria-hidden className="rv-alert__icon">⚠️</span>
          <div className="rv-alert__body">
            <strong>{missingPlanSales.length} vente{missingPlanSales.length > 1 ? 's' : ''} sans échéancier</strong>
            <span>Ventes clôturées à tempérament sans plan de paiement.</span>
          </div>
          <button
            type="button"
            className="rv-alert__btn"
            disabled={repairBusy}
            onClick={runBulkRepair}
          >
            {repairBusy ? 'Réparation…' : 'Tout réparer'}
          </button>
        </div>
      )}

      {repairStatus && (
        <div className="rv-alert rv-alert--info" role="status">
          <span aria-hidden className="rv-alert__icon">ℹ️</span>
          <div className="rv-alert__body"><span>{repairStatus}</span></div>
        </div>
      )}

      {actionError && (
        <div className="rv-alert rv-alert--info" role="alert" style={{ background: '#fef3c7', borderColor: '#fde68a', color: '#92400e' }}>
          <span aria-hidden className="rv-alert__icon">⚠️</span>
          <div className="rv-alert__body"><span>{actionError}</span></div>
        </div>
      )}

      {totalSubmitted > 0 && (
        <div className="rv-alert rv-alert--ok" role="status">
          <span aria-hidden className="rv-alert__icon">📩</span>
          <div className="rv-alert__body">
            <strong>{totalSubmitted} reçu{totalSubmitted > 1 ? 's' : ''} en attente de validation</strong>
            <span>Les dossiers concernés sont marqués en vert ci-dessous.</span>
          </div>
        </div>
      )}

      <div className="sp-cards">
        {showSkeletons ? (
          Array.from({ length: 6 }).map((_, i) => (
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
          ))
        ) : (
          <>
            {filteredMissingPlan.map((sale) => {
              const isBusy = repairSingleBusy === sale.id
              return (
                <div
                  key={`missing-${sale.id}`}
                  className="sp-card sp-card--orange rv-card rv-card--missing"
                >
                  <div className="sp-card__head">
                    <div className="sp-card__user">
                      <span className="sp-card__initials rv-card__initials rv-card__initials--orange">
                        {initials(sale.clientName || '')}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <p className="sp-card__name">{sale.clientName || 'Client'}</p>
                        <p className="sp-card__sub">{sale.projectTitle || 'Projet'} · {sale.code || sale.id}</p>
                      </div>
                    </div>
                    <span className="sp-badge sp-badge--orange">Sans plan</span>
                  </div>
                  <p className="rv-card__hint">
                    Vente à tempérament clôturée sans échéancier.
                  </p>
                  <button
                    type="button"
                    className="rv-btn rv-btn--primary"
                    disabled={isBusy}
                    onClick={() => runSingleRepair(sale)}
                    style={{ width: '100%' }}
                  >
                    {isBusy ? 'Réparation…' : 'Générer l\u2019échéancier'}
                  </button>
                </div>
              )
            })}

            {!hasAnyDossier ? (
              <div className="sp-empty">
                <span className="sp-empty__emoji" aria-hidden>📭</span>
                <div className="sp-empty__title">
                  {query ? 'Aucun résultat.' : 'Aucun dossier à afficher.'}
                </div>
                {!query && (
                  <p className="rv-empty__text">
                    Les nouveaux dossiers apparaîtront ici après la clôture des ventes à tempérament.
                  </p>
                )}
              </div>
            ) : (
              pagedFiltered.map((d) => {
                const status = dossierStatus(d)
                const m = d.metrics
                const overdueCount = d.payments.filter((p) => (p.status === 'pending' && p.dueDate < TODAY) || p.status === 'rejected').length
                const progressPct = m.totalMonths ? (m.approvedCount / m.totalMonths) * 100 : 0
                const tone = status === 'submitted' ? 'green' : status === 'overdue' ? 'red' : 'blue'
                return (
                  <button
                    key={d.id}
                    type="button"
                    className={`sp-card sp-card--${tone} rv-card`}
                    onClick={() => { setSelectedId(d.id); setPaymentFilter('all') }}
                    title="Ouvrir le dossier pour valider les reçus"
                  >
                    <div className="sp-card__head">
                      <div className="sp-card__user">
                        <span className={`sp-card__initials rv-card__initials rv-card__initials--${tone}`}>
                          {initials(d.name)}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <p className="sp-card__name">{d.name}</p>
                          <p className="sp-card__sub">{d.project}{d.plotId != null ? ` · Parcelle #${d.plotId}` : ''}</p>
                        </div>
                      </div>
                      {m.submittedCount > 0 ? (
                        <span className="sp-badge sp-badge--green">{m.submittedCount} reçu{m.submittedCount > 1 ? 's' : ''}</span>
                      ) : overdueCount > 0 ? (
                        <span className="sp-badge sp-badge--red">{overdueCount} impayé{overdueCount > 1 ? 's' : ''}</span>
                      ) : (
                        <span className="sp-badge sp-badge--gray">À jour</span>
                      )}
                    </div>

                    <div className="rv-stats">
                      <div className="rv-stat">
                        <span className="rv-stat__label">Encaissé</span>
                        <span className="rv-stat__value rv-stat__value--green">{formatMoneyTnd(m.cashValidatedStrict)}</span>
                      </div>
                      <div className="rv-stat">
                        <span className="rv-stat__label">Reste dû</span>
                        <span className="rv-stat__value">{formatMoneyTnd(m.remainingOperational)}</span>
                      </div>
                      <div className="rv-stat">
                        <span className="rv-stat__label">Mois</span>
                        <span className="rv-stat__value">
                          {m.approvedCount}<span className="rv-stat__sep">/{m.totalMonths}</span>
                        </span>
                      </div>
                    </div>

                    <div className={`rv-progress rv-progress--${tone}`} aria-label={`Avancement ${Math.round(progressPct)}%`}>
                      <span className="rv-progress__fill" style={{ width: `${progressPct}%` }} />
                    </div>
                  </button>
                )
              })
            )}
          </>
        )}
      </div>

      {!showSkeletons && filtered.length > DOSSIERS_PER_PAGE && (
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
            {(safePage - 1) * DOSSIERS_PER_PAGE + 1}–{Math.min(safePage * DOSSIERS_PER_PAGE, filtered.length)} / {filtered.length}
          </span>
        </div>
      )}

      <AdminModal open={!!selected} onClose={() => { setSelectedId(null); setPaymentFilter('all') }} title={selected ? selected.name : ''}>
        {selected && (() => {
          const m = selected.metrics
          const progressPct = m.totalMonths ? (m.approvedCount / m.totalMonths) * 100 : 0
          return (
            <div className="sp-detail rv-detail">
              <div className="sp-detail__banner rv-detail__banner">
                <div className="sp-detail__banner-top">
                  <span className="sp-badge sp-badge--blue">Échéancier</span>
                  <span className="sp-detail__date">
                    {m.approvedCount}/{m.totalMonths} mois · {Math.round(progressPct)}%
                  </span>
                </div>
                <div className="sp-detail__price">
                  <span className="sp-detail__price-num">{formatMoneyTnd(m.remainingOperational)}</span>
                </div>
                <p className="sp-detail__banner-sub">
                  {selected.name} · {selected.project}{selected.plotId != null ? ` · #${selected.plotId}` : ''}
                </p>
                <div className="rv-detail__progress" aria-hidden>
                  <span className="rv-detail__progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Résumé</div>
                <div className="rv-summary">
                  <div className="rv-summary__card">
                    <span className="rv-summary__label">Prix total</span>
                    <span className="rv-summary__value">{formatMoneyTnd(m.saleAgreed)}</span>
                  </div>
                  <div className="rv-summary__card rv-summary__card--green">
                    <span className="rv-summary__label">Déjà payé</span>
                    <span className="rv-summary__value">{formatMoneyTnd(m.cashValidatedStrict)}</span>
                    <span className="rv-summary__hint">
                      {m.terrainDeposit > 0 ? `Araboun ${formatMoneyTnd(m.terrainDeposit)} · ` : ''}
                      {m.financeBalanceAtSale > 0 ? `Finance ${formatMoneyTnd(m.financeBalanceAtSale)}` : ''}
                      {m.approvedAmount > 0 ? ` · Mensualités ${formatMoneyTnd(m.approvedAmount)}` : ''}
                    </span>
                  </div>
                  <div className="rv-summary__card">
                    <span className="rv-summary__label">Reste à payer</span>
                    <span className="rv-summary__value">{formatMoneyTnd(m.remainingStrict)}</span>
                    <span className="rv-summary__hint">
                      {m.totalMonths > 0 ? `${m.totalMonths - m.approvedCount} mensualité${(m.totalMonths - m.approvedCount) > 1 ? 's' : ''} restante${(m.totalMonths - m.approvedCount) > 1 ? 's' : ''}` : ''}
                    </span>
                  </div>
                </div>
                {(m.cashReceivedOperational - m.cashValidatedStrict) > 0 && (
                  <div className="rv-summary__note">
                    <span aria-hidden>📩</span>
                    <span>
                      Reçus en attente de validation : <strong>{formatMoneyTnd(m.cashReceivedOperational - m.cashValidatedStrict)}</strong>
                      {' · '}après validation, reste <strong>{formatMoneyTnd(m.remainingOperational)}</strong>
                    </span>
                  </div>
                )}
              </div>

              <div className="sp-detail__section">
                <details className="rv-details">
                  <summary>Détails du contrat</summary>
                  <div className="rv-details__body">
                    <div className="sp-detail__row"><span>Téléphone</span><strong style={{ direction: 'ltr' }}>{selected.phone || '—'}</strong></div>
                    <div className="sp-detail__row"><span>Prix convenu</span><strong>{formatMoneyTnd(m.saleAgreed)}</strong></div>
                    <div className="sp-detail__row"><span>1er versement ({m.downPct}%)</span><strong>{formatMoneyTnd(m.downPaymentPlanned)}</strong></div>
                    <div className="sp-detail__row"><span>Araboun</span><strong>{formatMoneyTnd(m.terrainDeposit)}</strong></div>
                    <div className="sp-detail__row"><span>Solde finance</span><strong>{formatMoneyTnd(m.financeBalanceAtSale)}</strong></div>
                    <div className="sp-detail__row"><span>Capital planifié</span><strong>{formatMoneyTnd(m.capitalRemainingPlanned)}</strong></div>
                  </div>
                </details>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Échéances</div>
                <div className="rv-chips">
                  {[
                    ['all', 'Tous'],
                    ['submitted', 'À valider'],
                    ['overdue', 'En retard'],
                    ['rejected', 'Rejetés'],
                    ['pending', 'À venir'],
                    ['approved', 'Validés'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`rv-chip ${paymentFilter === key ? 'rv-chip--active' : ''}`}
                      onClick={() => setPaymentFilter(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {visiblePayments.length === 0 ? (
                  <div className="sp-empty" style={{ marginTop: 8 }}>
                    <span className="sp-empty__emoji" aria-hidden>📭</span>
                    <div className="sp-empty__title">Aucune échéance dans cette vue.</div>
                  </div>
                ) : (
                  <div className="rv-rows">
                    {visiblePayments.map((p) => {
                      const isOverdue = (p.status === 'pending' && p.dueDate < TODAY)
                      const isRejected = p.status === 'rejected'
                      const isSubmitted = p.status === 'submitted'
                      const isPaid = p.status === 'approved'
                      let rowTone = 'gray'
                      let statusLabel = 'À venir'
                      if (isSubmitted) { rowTone = 'green'; statusLabel = 'Reçu à valider' }
                      if (isOverdue) { rowTone = 'red'; statusLabel = 'En retard' }
                      if (isRejected) { rowTone = 'red'; statusLabel = 'Rejeté' }
                      if (isPaid) { rowTone = 'green'; statusLabel = 'Validé' }
                      const receipt = latestReceipt(p)
                      const receiptIsImage = receipt && isImageUrl(receipt.url)
                      return (
                        <div key={p.id} className={`rv-row rv-row--${rowTone}`}>
                          <div className="rv-row__head">
                            <div>
                              <span className="rv-row__month">Mois {p.month}</span>
                              <span className="rv-row__due">Échéance : {fmtDate(p.dueDate)}</span>
                            </div>
                            <span className="rv-row__amount">{fmtMoney(p.amount)}</span>
                          </div>
                          <span className={`sp-badge sp-badge--${rowTone}`}>{statusLabel}</span>
                          {p.rejectedNote && (
                            <p className="rv-row__note">Motif : {p.rejectedNote}</p>
                          )}

                          {receipt ? (
                            <button
                              type="button"
                              onClick={() => openReview(p)}
                              className="rv-receipt"
                              aria-label={`Examiner le reçu du mois ${p.month}`}
                            >
                              {receiptIsImage ? (
                                <img src={receipt.url} alt="" className="rv-receipt__thumb" />
                              ) : (
                                <div className="rv-receipt__thumb rv-receipt__thumb--doc" aria-hidden>📄</div>
                              )}
                              <div className="rv-receipt__body">
                                <div className="rv-receipt__name">{receipt.name}</div>
                                {receipt.date && <div className="rv-receipt__date">Reçu le {fmtDate(receipt.date)}</div>}
                                {receipt.note && <div className="rv-receipt__note">« {receipt.note} »</div>}
                              </div>
                              <span className="rv-receipt__cta">Examiner →</span>
                            </button>
                          ) : (
                            <p className="rv-row__pending">En attente du reçu du client.</p>
                          )}

                          {(isRejected || isPaid) && (
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => resetPayment(p.id, 'pending')}
                              className="rv-btn rv-btn--ghost"
                              title="Remettre cette échéance en attente"
                            >
                              ↺ Réinitialiser
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {selected.phone && (
                <div className="sp-detail__actions">
                  <a href={`tel:${selected.phone}`} className="sp-detail__btn sp-detail__btn--edit rv-call">
                    📞 Appeler {selected.phone}
                  </a>
                </div>
              )}
            </div>
          )
        })()}
      </AdminModal>

      <AdminModal open={!!rejectTarget} onClose={() => setRejectTarget(null)} title="Refuser le reçu">
        <div className="rv-reject">
          <p className="rv-reject__intro">
            Expliquez clairement au client pourquoi le reçu est refusé. Il verra ce motif dans son espace.
          </p>
          <label className="rv-reject__label">
            Motif du refus <span style={{ color: '#dc2626' }}>*</span>
          </label>
          <textarea
            className="rv-reject__input"
            rows={4}
            placeholder="Ex : Montant incorrect, reçu illisible, banque non reconnue…"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
          />
          {!rejectNote.trim() && (
            <p className="rv-reject__hint">Le motif est obligatoire pour refuser un reçu.</p>
          )}
          <div className="rv-reject__actions">
            <button type="button" className="rv-btn" onClick={() => setRejectTarget(null)}>Annuler</button>
            <button
              type="button"
              className="rv-btn rv-btn--danger"
              disabled={!rejectNote.trim() || actionBusy}
              onClick={confirmReject}
            >
              {actionBusy ? 'Envoi…' : 'Confirmer le refus'}
            </button>
          </div>
        </div>
      </AdminModal>

      {reviewTarget && (() => {
        const { receipt, paymentId, amount, month, dueDate, status, rejectedNote } = reviewTarget
        const imageMode = isImageUrl(receipt.url)
        const isPaid = status === 'approved'
        const isRejected = status === 'rejected'
        return (
          <div
            className="rv-viewer"
            onMouseUp={onPanEnd}
            onMouseLeave={onPanEnd}
            onMouseMove={onPanMove}
          >
            <div className="rv-viewer__top">
              <div className="rv-viewer__info">
                <strong>Mois {month} · {fmtMoney(amount)}</strong>
                <span>Échéance : {fmtDate(dueDate)} · {receipt.name}</span>
                {rejectedNote && <span className="rv-viewer__prev">⚠ Motif précédent : {rejectedNote}</span>}
              </div>

              {imageMode && (
                <div className="rv-viewer__zoom">
                  <button type="button" onClick={zoomOut} disabled={zoom <= 1} aria-label="Dézoomer">−</button>
                  <span>{Math.round(zoom * 100)}%</span>
                  <button type="button" onClick={zoomIn} disabled={zoom >= 5} aria-label="Zoomer">+</button>
                  <button type="button" onClick={zoomReset} className="rv-viewer__reset">Reset</button>
                </div>
              )}

              <a href={receipt.url} target="_blank" rel="noreferrer" className="rv-viewer__open">
                Ouvrir ↗
              </a>
              <button
                type="button"
                onClick={closeReview}
                className="rv-viewer__close"
                aria-label="Fermer"
                title="Fermer"
              >
                ✕
              </button>
            </div>

            <div className="rv-viewer__actions">
              <button
                type="button"
                disabled={actionBusy || isPaid}
                onClick={() => approve(paymentId)}
                className="rv-viewer__btn rv-viewer__btn--approve"
              >
                {isPaid ? '✓ Déjà approuvé' : (actionBusy ? 'Validation…' : '✓ Approuver le reçu')}
              </button>
              <button
                type="button"
                disabled={actionBusy || isRejected}
                onClick={() => { setRejectTarget({ paymentId }); setRejectNote(rejectedNote || '') }}
                className="rv-viewer__btn rv-viewer__btn--reject"
              >
                {isRejected ? '✗ Déjà rejeté' : '✗ Refuser le reçu'}
              </button>
            </div>

            <div ref={canvasRef} className="rv-viewer__canvas">
              {imageMode ? (
                <img
                  src={receipt.url}
                  alt={receipt.name}
                  onMouseDown={onPanStart}
                  onDoubleClick={() => setZoom((z) => z === 1 ? 2.5 : 1)}
                  draggable={false}
                  className="rv-viewer__img"
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transition: dragRef.current ? 'none' : 'transform 0.15s ease-out',
                    cursor: zoom > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'zoom-in',
                  }}
                />
              ) : (
                <div className="rv-viewer__doc">
                  <div className="rv-viewer__doc-icon" aria-hidden>📄</div>
                  <p>Ce reçu est un fichier PDF ou un document non-image.</p>
                  <a href={receipt.url} target="_blank" rel="noreferrer" className="rv-viewer__doc-open">
                    Ouvrir le fichier
                  </a>
                </div>
              )}
            </div>

            {imageMode && zoom === 1 && (
              <div className="rv-viewer__hint">
                Double-clic pour zoomer · molette pour ajuster · glisser pour déplacer
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}
