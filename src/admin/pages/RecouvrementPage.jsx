import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInstallments, useSales, useClients } from '../../lib/useSupabase.js'
import {
  ensureInstallmentPlanFromSale,
  replayInstallmentPlansFromCompletedSales,
  updatePaymentStatus,
} from '../../lib/db.js'
import { computeInstallmentSaleMetrics, formatMoneyTnd } from '../../domain/installmentMetrics.js'
import AdminModal from '../components/AdminModal.jsx'
import './zitouna-admin-page.css'

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
  const { sales } = useSales()
  const { clients } = useClients()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [rejectTarget, setRejectTarget] = useState(null)
  const [rejectNote, setRejectNote] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [reviewTarget, setReviewTarget] = useState(null) // { paymentId, amount, month, dueDate, receipt, status }
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef(null)
  const canvasRef = useRef(null)
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairStatus, setRepairStatus] = useState('')
  const [repairSingleBusy, setRepairSingleBusy] = useState(null)
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
    () => (sales || []).filter((s) =>
      String(s.paymentType || '').toLowerCase() === 'installments'
      && isCompletedSale(s)
      && !planBySaleId.has(String(s.id)),
    ),
    [sales, planBySaleId],
  )

  // One-shot best-effort auto-repair when the page mounts and data is loaded.
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
    return list.sort((a, b) => {
      const sa = dossierStatus(a), sb = dossierStatus(b)
      const order = { 'has-recu': 0, overdue: 1, ok: 2 }
      return (order[sa] ?? 2) - (order[sb] ?? 2)
    })
  }, [dossiers, query])

  const filteredMissingPlan = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return missingPlanSales
    return missingPlanSales.filter((s) => (
      String(s.clientName || '').toLowerCase().includes(q)
      || String(s.projectTitle || '').toLowerCase().includes(q)
    ))
  }, [missingPlanSales, query])

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

  function dossierStatus(d) {
    const hasSubmitted = d.payments.some((p) => p.status === 'submitted')
    const hasOverdue = d.payments.some((p) => (p.status === 'pending' && p.dueDate < TODAY) || p.status === 'rejected')
    if (hasSubmitted) return 'has-recu'
    if (hasOverdue) return 'overdue'
    return 'ok'
  }

  const approve = async (paymentId) => {
    setActionBusy(true)
    try {
      await updatePaymentStatus(paymentId, 'approved')
      await refreshPlans({ force: true })
      setReviewTarget(null)
    } catch (e) { console.error('approve', e) }
    finally { setActionBusy(false) }
  }

  const resetPayment = async (paymentId, toStatus = 'submitted') => {
    setActionBusy(true)
    try {
      await updatePaymentStatus(paymentId, toStatus, { rejectedNote: '' })
      await refreshPlans({ force: true })
    } catch (e) { console.error('resetPayment', e) }
    finally { setActionBusy(false) }
  }

  const confirmReject = async () => {
    if (!rejectTarget || !rejectNote.trim()) return
    setActionBusy(true)
    try {
      await updatePaymentStatus(rejectTarget.paymentId, 'rejected', { rejectedNote: rejectNote.trim() })
      await refreshPlans({ force: true })
      setRejectTarget(null)
      setRejectNote('')
      setReviewTarget(null)
    } catch (e) { console.error('confirmReject', e) }
    finally { setActionBusy(false) }
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

  // Wheel zoom has to be bound as a non-passive native listener so preventDefault
  // actually blocks page scroll. React attaches wheel as passive by default.
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

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">

        <button type="button" className="ds-back-btn" onClick={() => navigate('/admin')}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Back</span>
        </button>

        <div className="ds-hero">
          <div className="ds-hero__top">
            <div className="ds-hero__icon">💳</div>
            <div>
              <h1 className="ds-hero__title">Echéanciers & recouvrement</h1>
              <p className="ds-hero__sub">Suivi des reglements par client — actions admin</p>
            </div>
          </div>
          <div className="ds-hero__kpi">
            <div className="ds-hero__kpi-block"><span className="ds-hero__kpi-num">{dossiers.length}</span><span className="ds-hero__kpi-unit">DOSSIERS</span></div>
            <span className="ds-hero__kpi-sep" />
            <div className="ds-hero__kpi-block"><span className="ds-hero__kpi-num">{totalSubmitted}</span><span className="ds-hero__kpi-unit">RECUS</span></div>
            <span className="ds-hero__kpi-sep" />
            <div className="ds-hero__kpi-block"><span className="ds-hero__kpi-num">{totalOverdue}</span><span className="ds-hero__kpi-unit">IMPAYES</span></div>
          </div>
        </div>

        {missingPlanSales.length > 0 && (
          <div
            role="alert"
            style={{
              marginBottom: 10,
              padding: '10px 12px',
              borderRadius: 10,
              background: '#fef3c7',
              color: '#92400e',
              border: '1px solid #fde68a',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span aria-hidden>⚠</span>
            <span style={{ fontWeight: 700 }}>
              {missingPlanSales.length} vente{missingPlanSales.length > 1 ? 's' : ''} clôturée{missingPlanSales.length > 1 ? 's' : ''} sans plan d’échéances.
            </span>
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--sm zitu-page__btn--primary"
              disabled={repairBusy}
              onClick={runBulkRepair}
              style={{ marginLeft: 'auto' }}
            >
              {repairBusy ? 'Réparation…' : 'Réparer automatiquement'}
            </button>
          </div>
        )}
        {repairStatus && (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 10, background: '#e0f2fe', color: '#075985', fontSize: 12 }}>
            {repairStatus}
          </div>
        )}

        {totalSubmitted > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px', marginBottom: 8, borderRadius: 10,
            background: 'linear-gradient(135deg,#ecfdf5,#d1fae5)', border: '1px solid #a7f3d0',
            animation: 'recouv-pulse 2s infinite',
          }}>
            <span style={{ fontSize: 18 }}>📩</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#065f46' }}>{totalSubmitted} recu{totalSubmitted > 1 ? 's' : ''} en attente de validation</div>
              <div style={{ fontSize: 9, color: '#047857' }}>Les dossiers avec recus sont en vert ci-dessous</div>
            </div>
          </div>
        )}
        <style>{`@keyframes recouv-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(16,185,129,.2) } 50% { box-shadow: 0 0 0 6px rgba(16,185,129,0) } }`}</style>

        <div className="zitu-page__search-wrap">
          <input className="zitu-page__search" placeholder="Rechercher client, projet..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="zitu-page__search-icon" aria-hidden>🔎</span>
        </div>

        {plansLoading ? (
          <div className="ds-empty"><div className="ds-empty__icon">⏳</div><strong className="ds-empty__title">Chargement…</strong></div>
        ) : (
          <div className="zitu-page__card-list">
            {filteredMissingPlan.map((sale) => {
              const isBusy = repairSingleBusy === sale.id
              return (
                <div
                  key={`missing-${sale.id}`}
                  className="zitu-page__card"
                  style={{
                    borderLeft: '4px solid #d97706',
                    background: 'linear-gradient(135deg,#fff,#fffbeb)',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{
                      width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                      background: 'linear-gradient(135deg,#fef3c7,#fde68a)',
                      color: '#92400e', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: 10, fontWeight: 800,
                    }}>{initials(sale.clientName || '')}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {sale.clientName || 'Client'}
                      </div>
                      <div style={{ fontSize: 9, color: '#94a3b8' }}>{sale.projectTitle || 'Projet'} · {sale.code || sale.id}</div>
                    </div>
                    <span className="zitu-page__badge" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                      sans plan
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#92400e', marginBottom: 8 }}>
                    ⚠ Vente à tempérament clôturée — l’échéancier n’a pas été généré.
                  </div>
                  <button
                    type="button"
                    className="zitu-page__btn zitu-page__btn--sm zitu-page__btn--primary"
                    disabled={isBusy}
                    onClick={() => runSingleRepair(sale)}
                  >
                    {isBusy ? 'Réparation…' : '🛠 Réparer ce dossier'}
                  </button>
                </div>
              )
            })}

            {filtered.length === 0 && filteredMissingPlan.length === 0 ? (
              <div className="ds-empty"><div className="ds-empty__icon">📭</div><strong className="ds-empty__title">Aucun dossier</strong></div>
            ) : (
              filtered.map((d) => {
                const status = dossierStatus(d)
                const m = d.metrics
                const overdueCount = d.payments.filter((p) => (p.status === 'pending' && p.dueDate < TODAY) || p.status === 'rejected').length
                const progressPct = m.totalMonths ? (m.approvedCount / m.totalMonths) * 100 : 0
                const cardStyle = status === 'has-recu'
                  ? { borderLeft: '4px solid #10b981', background: 'linear-gradient(135deg,#fff,#ecfdf5)' }
                  : status === 'overdue'
                    ? { borderLeft: '4px solid #dc2626', background: 'linear-gradient(135deg,#fff,#fef2f2)' }
                    : {}
                return (
                  <button
                    key={d.id}
                    type="button"
                    className="zitu-page__card"
                    style={{ ...cardStyle, textAlign: 'left', width: '100%' }}
                    onClick={() => { setSelectedId(d.id); setPaymentFilter('all') }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, background: status === 'has-recu' ? 'linear-gradient(135deg,#d1fae5,#a7f3d0)' : status === 'overdue' ? 'linear-gradient(135deg,#fecaca,#fca5a5)' : 'linear-gradient(135deg,#dbeafe,#bfdbfe)', color: status === 'has-recu' ? '#065f46' : status === 'overdue' ? '#991b1b' : '#1d4ed8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800 }}>{initials(d.name)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
                        <div style={{ fontSize: 9, color: '#94a3b8' }}>{d.project} · Parcelle #{d.plotId}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0, alignItems: 'flex-end' }}>
                        {m.submittedCount > 0 && <span className="zitu-page__badge" style={{ background: '#ecfdf5', color: '#059669', border: '1px solid #a7f3d0' }}>{m.submittedCount} reçu{m.submittedCount > 1 ? 's' : ''}</span>}
                        {overdueCount > 0 && <span className="zitu-page__badge" style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>{overdueCount} impayé{overdueCount > 1 ? 's' : ''}</span>}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                      {m.approvedAmount > 0 && (
                        <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 999, background: '#d1fae5', color: '#065f46' }}>{formatMoneyTnd(m.approvedAmount)} validés</span>
                      )}
                      {m.submittedAmount > 0 && (
                        <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 999, background: '#dbeafe', color: '#1e40af' }}>{formatMoneyTnd(m.submittedAmount)} en révision</span>
                      )}
                      {m.rejectedAmount > 0 && (
                        <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }}>{formatMoneyTnd(m.rejectedAmount)} rejetés</span>
                      )}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, padding: '5px 6px', background: '#f8fafc', borderRadius: 6, marginBottom: 4 }}>
                      <div>
                        <div style={{ fontSize: 8, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Validé (strict)</div>
                        <div style={{ fontSize: 11, fontWeight: 800, color: '#059669' }}>{formatMoneyTnd(m.cashValidatedStrict)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 8, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Reste (opér.)</div>
                        <div style={{ fontSize: 11, fontWeight: 800, color: '#0f172a' }}>{formatMoneyTnd(m.remainingOperational)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 8, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Mois</div>
                        <div style={{ fontSize: 11, fontWeight: 800, color: '#0f172a' }}>{m.approvedCount}<span style={{ color: '#94a3b8', fontWeight: 500 }}>/{m.totalMonths}</span></div>
                      </div>
                    </div>
                    <div style={{ height: 4, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${progressPct}%`, background: status === 'has-recu' ? '#10b981' : status === 'overdue' ? '#f87171' : '#3b82f6', borderRadius: 2 }} />
                    </div>
                  </button>
                )
              })
            )}
          </div>
        )}

        <AdminModal open={!!selected} onClose={() => { setSelectedId(null); setPaymentFilter('all') }} title={selected ? selected.name : ''}>
          {selected && (() => {
            const m = selected.metrics
            const progressPct = m.totalMonths ? (m.approvedCount / m.totalMonths) * 100 : 0
            return (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg,#dbeafe,#bfdbfe)', border: '1.5px solid #93c5fd', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, color: '#1d4ed8' }}>{initials(selected.name)}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{selected.name}</div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>{selected.project} · Parcelle #{selected.plotId}</div>
                  </div>
                </div>

                <div className="zitu-page__inset" style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 6 }}>Contrat</div>
                  <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Téléphone</span><span className="zitu-page__detail-value">{selected.phone || '—'}</span></div>
                  <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Prix convenu</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.saleAgreed)}</span></div>
                  <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">1er versement prévu ({m.downPct}%)</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.downPaymentPlanned)}</span></div>
                  <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Acompte terrain (araboun)</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.terrainDeposit)}</span></div>
                  <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Solde finance à encaisser</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.financeBalanceAtSale)}</span></div>
                  <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Capital restant planifié</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.capitalRemainingPlanned)}</span></div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                  <div style={{ padding: '8px 10px', borderRadius: 10, background: '#ecfdf5', border: '1px solid #a7f3d0' }}>
                    <div style={{ fontSize: 8, fontWeight: 800, color: '#065f46', textTransform: 'uppercase' }}>Validé (strict)</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#065f46' }}>{formatMoneyTnd(m.cashValidatedStrict)}</div>
                    <div style={{ fontSize: 9, color: '#047857' }}>Araboun + mensualités approuvées</div>
                  </div>
                  <div style={{ padding: '8px 10px', borderRadius: 10, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                    <div style={{ fontSize: 8, fontWeight: 800, color: '#1e40af', textTransform: 'uppercase' }}>Reçu (opérationnel)</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#1e40af' }}>{formatMoneyTnd(m.cashReceivedOperational)}</div>
                    <div style={{ fontSize: 9, color: '#1d4ed8' }}>Validé + reçus soumis</div>
                  </div>
                  <div style={{ padding: '8px 10px', borderRadius: 10, background: '#fff', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 8, fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>Restant (strict)</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a' }}>{formatMoneyTnd(m.remainingStrict)}</div>
                    <div style={{ fontSize: 9, color: '#94a3b8' }}>Après approbation finance</div>
                  </div>
                  <div style={{ padding: '8px 10px', borderRadius: 10, background: '#fff', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 8, fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>Restant (opérationnel)</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a' }}>{formatMoneyTnd(m.remainingOperational)}</div>
                    <div style={{ fontSize: 9, color: '#94a3b8' }}>Si reçus en cours sont validés</div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 999, background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}>
                    {formatMoneyTnd(m.approvedAmount)} validés
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 999, background: '#dbeafe', color: '#1e40af', border: '1px solid #93c5fd' }}>
                    {formatMoneyTnd(m.submittedAmount)} en révision
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 999, background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
                    {formatMoneyTnd(m.rejectedAmount)} rejetés
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 999, background: '#f1f5f9', color: '#475569', border: '1px solid #cbd5e1' }}>
                    {formatMoneyTnd(m.pendingAmount)} en attente
                  </span>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, fontWeight: 700, color: '#475569', marginBottom: 3 }}><span>{m.approvedCount}/{m.totalMonths} mois approuvés</span><span>{Math.round(progressPct)}%</span></div>
                  <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden' }}><div style={{ height: '100%', width: `${progressPct}%`, background: 'linear-gradient(90deg,#2563eb,#3b82f6)', borderRadius: 3 }} /></div>
                </div>

                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                  {[
                    ['all', 'Tous'],
                    ['submitted', 'À réviser'],
                    ['overdue', 'En retard'],
                    ['rejected', 'Rejetés'],
                    ['pending', 'En attente'],
                    ['approved', 'Validés'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`zitu-page__btn zitu-page__btn--sm ${paymentFilter === key ? 'zitu-page__btn--primary' : ''}`}
                      onClick={() => setPaymentFilter(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div style={{ fontSize: 9, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 4 }}>Echeances</div>
                {visiblePayments.length === 0 ? (
                  <div style={{ fontSize: 11, color: '#94a3b8', padding: '6px 0' }}>Aucune échéance dans cette vue.</div>
                ) : visiblePayments.map((p) => {
                  const isOverdue = (p.status === 'pending' && p.dueDate < TODAY)
                  const isRejected = p.status === 'rejected'
                  const isSubmitted = p.status === 'submitted'
                  const isPaid = p.status === 'approved'
                  let rowBg = '#fff', leftBorder = '#e2e8f0'
                  if (isSubmitted) { rowBg = '#ecfdf5'; leftBorder = '#10b981' }
                  if (isOverdue) { rowBg = '#fef2f2'; leftBorder = '#dc2626' }
                  if (isRejected) { rowBg = '#fef2f2'; leftBorder = '#dc2626' }
                  if (isPaid) { rowBg = '#f8fafc'; leftBorder = '#059669' }
                  const receipt = latestReceipt(p)
                  const receiptIsImage = receipt && isImageUrl(receipt.url)
                  return (
                    <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', marginBottom: 4, borderRadius: 8, background: rowBg, borderLeft: `3px solid ${leftBorder}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#0f172a' }}>Mois {p.month}</span>
                            <span style={{ fontSize: 9, color: '#94a3b8' }}>{fmtDate(p.dueDate)}</span>
                          </div>
                          {p.rejectedNote && <div style={{ fontSize: 9, color: '#dc2626', marginTop: 1 }}>⚠ {p.rejectedNote}</div>}
                          {isOverdue && !isRejected && <div style={{ fontSize: 8, color: '#dc2626', fontWeight: 700, marginTop: 1 }}>EN RETARD</div>}
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', flexShrink: 0 }}>{fmtMoney(p.amount)}</span>
                      </div>

                      {receipt ? (
                        <button
                          type="button"
                          onClick={() => openReview(p)}
                          style={{
                            display: 'flex',
                            gap: 10,
                            alignItems: 'center',
                            background: '#f8fafc',
                            padding: 8,
                            borderRadius: 8,
                            border: '1px solid #e2e8f0',
                            cursor: 'pointer',
                            textAlign: 'left',
                            width: '100%',
                          }}
                        >
                          {receiptIsImage ? (
                            <img src={receipt.url} alt="Reçu" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e8f0' }} />
                          ) : (
                            <div style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e2e8f0', borderRadius: 6, fontSize: 20 }}>📄</div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{receipt.name}</div>
                            {receipt.date && <div style={{ fontSize: 9, color: '#64748b' }}>{fmtDate(receipt.date)}</div>}
                            {receipt.note && <div style={{ fontSize: 9, color: '#475569', fontStyle: 'italic' }}>« {receipt.note} »</div>}
                          </div>
                          <span style={{ fontSize: 10, color: '#2563eb', fontWeight: 800, flexShrink: 0 }}>
                            Voir le reçu →
                          </span>
                        </button>
                      ) : (
                        <div style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>En attente du reçu du client.</div>
                      )}

                      {(isRejected || isPaid) && (
                        <div>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => resetPayment(p.id, 'pending')}
                            style={{ border: 'none', borderRadius: 5, padding: '5px 12px', fontSize: 10, fontWeight: 700, background: '#eff6ff', color: '#2563eb', cursor: 'pointer' }}
                          >
                            Réinitialiser
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
                {selected.phone && (
                  <a href={`tel:${selected.phone}`} className="zitu-page__btn zitu-page__btn--primary" style={{ display: 'flex', justifyContent: 'center', width: '100%', marginTop: 10, textDecoration: 'none' }}>Appeler {selected.phone}</a>
                )}
              </>
            )
          })()}
        </AdminModal>

        <AdminModal open={!!rejectTarget} onClose={() => setRejectTarget(null)} title="Refuser le recu">
          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Motif du refus *</label>
            <textarea className="zitu-page__input" rows={3} placeholder="Ex: Montant incorrect, recu illisible..." value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          <div className="zitu-page__form-actions">
            <button type="button" className="zitu-page__btn" onClick={() => setRejectTarget(null)}>Annuler</button>
            <button type="button" className="zitu-page__btn zitu-page__btn--danger" disabled={!rejectNote.trim() || actionBusy} onClick={confirmReject}>Confirmer</button>
          </div>
        </AdminModal>

        {reviewTarget && (() => {
          const { receipt, paymentId, amount, month, dueDate, status, rejectedNote } = reviewTarget
          const imageMode = isImageUrl(receipt.url)
          const isPaid = status === 'approved'
          const isRejected = status === 'rejected'
          return (
            <div
              onMouseUp={onPanEnd}
              onMouseLeave={onPanEnd}
              onMouseMove={onPanMove}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(15,23,42,.92)',
                zIndex: 2200,
                display: 'flex',
                flexDirection: 'column',
                userSelect: 'none',
              }}
            >
              {/* Top toolbar */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                background: 'linear-gradient(180deg, rgba(15,23,42,.95), rgba(15,23,42,.6))',
                color: '#fff',
                flexWrap: 'wrap',
              }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontSize: 13, fontWeight: 800 }}>Mois {month} · {fmtMoney(amount)}</div>
                  <div style={{ fontSize: 10, color: '#cbd5e1' }}>Échéance : {fmtDate(dueDate)} · {receipt.name}</div>
                  {rejectedNote && <div style={{ fontSize: 10, color: '#fecaca', marginTop: 2 }}>⚠ {rejectedNote}</div>}
                </div>

                {imageMode && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      onClick={zoomOut}
                      disabled={zoom <= 1}
                      style={{ border: '1px solid rgba(255,255,255,.2)', background: 'rgba(255,255,255,.08)', color: '#fff', borderRadius: 6, padding: '4px 10px', fontSize: 14, fontWeight: 800, cursor: zoom <= 1 ? 'not-allowed' : 'pointer', opacity: zoom <= 1 ? 0.5 : 1 }}
                    >−</button>
                    <span style={{ fontSize: 11, fontWeight: 700, minWidth: 42, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
                    <button
                      type="button"
                      onClick={zoomIn}
                      disabled={zoom >= 5}
                      style={{ border: '1px solid rgba(255,255,255,.2)', background: 'rgba(255,255,255,.08)', color: '#fff', borderRadius: 6, padding: '4px 10px', fontSize: 14, fontWeight: 800, cursor: zoom >= 5 ? 'not-allowed' : 'pointer', opacity: zoom >= 5 ? 0.5 : 1 }}
                    >+</button>
                    <button
                      type="button"
                      onClick={zoomReset}
                      style={{ border: '1px solid rgba(255,255,255,.2)', background: 'rgba(255,255,255,.08)', color: '#fff', borderRadius: 6, padding: '4px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer', marginLeft: 4 }}
                    >Reset</button>
                  </div>
                )}

                <a
                  href={receipt.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 11, fontWeight: 700, color: '#93c5fd', textDecoration: 'none', padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(147,197,253,.4)' }}
                >
                  Ouvrir dans un onglet ↗
                </a>

                <button
                  type="button"
                  onClick={closeReview}
                  style={{ border: 'none', background: 'rgba(255,255,255,.12)', color: '#fff', width: 32, height: 32, borderRadius: 8, fontSize: 16, cursor: 'pointer' }}
                  aria-label="Fermer"
                >
                  ✕
                </button>
              </div>

              {/* Action bar — approve/reject on top of the receipt */}
              <div style={{
                display: 'flex',
                gap: 8,
                padding: '10px 14px',
                background: 'rgba(15,23,42,.6)',
                borderBottom: '1px solid rgba(255,255,255,.08)',
                flexWrap: 'wrap',
              }}>
                <button
                  type="button"
                  disabled={actionBusy || isPaid}
                  onClick={() => approve(paymentId)}
                  style={{
                    flex: 1,
                    minWidth: 120,
                    border: 'none',
                    borderRadius: 8,
                    padding: '10px 14px',
                    fontSize: 13,
                    fontWeight: 800,
                    background: isPaid ? '#065f46' : 'linear-gradient(180deg, #10b981, #059669)',
                    color: '#fff',
                    cursor: actionBusy || isPaid ? 'not-allowed' : 'pointer',
                    opacity: isPaid ? 0.7 : 1,
                    boxShadow: '0 4px 12px rgba(16,185,129,.35)',
                  }}
                >
                  {isPaid ? '✓ Déjà approuvé' : (actionBusy ? '…' : '✓ Approuver')}
                </button>
                <button
                  type="button"
                  disabled={actionBusy || isRejected}
                  onClick={() => { setRejectTarget({ paymentId }); setRejectNote(rejectedNote || '') }}
                  style={{
                    flex: 1,
                    minWidth: 120,
                    border: 'none',
                    borderRadius: 8,
                    padding: '10px 14px',
                    fontSize: 13,
                    fontWeight: 800,
                    background: isRejected ? '#7f1d1d' : 'linear-gradient(180deg, #ef4444, #dc2626)',
                    color: '#fff',
                    cursor: actionBusy || isRejected ? 'not-allowed' : 'pointer',
                    opacity: isRejected ? 0.7 : 1,
                    boxShadow: '0 4px 12px rgba(220,38,38,.35)',
                  }}
                >
                  {isRejected ? '✗ Déjà rejeté' : 'Rejeter'}
                </button>
              </div>

              {/* Image canvas */}
              <div
                ref={canvasRef}
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                }}
              >
                {imageMode ? (
                  <img
                    src={receipt.url}
                    alt={receipt.name}
                    onMouseDown={onPanStart}
                    onDoubleClick={() => setZoom((z) => z === 1 ? 2.5 : 1)}
                    draggable={false}
                    style={{
                      maxWidth: '92vw',
                      maxHeight: '100%',
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      transformOrigin: 'center center',
                      transition: dragRef.current ? 'none' : 'transform 0.15s ease-out',
                      cursor: zoom > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'zoom-in',
                      boxShadow: '0 20px 60px rgba(0,0,0,.5)',
                      borderRadius: 8,
                    }}
                  />
                ) : (
                  <div style={{ color: '#e2e8f0', textAlign: 'center' }}>
                    <div style={{ fontSize: 64 }}>📄</div>
                    <div style={{ fontSize: 13, marginTop: 12 }}>Ce reçu est un fichier non-image.</div>
                    <a
                      href={receipt.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'inline-block', marginTop: 16, padding: '10px 20px', background: '#2563eb', color: '#fff', borderRadius: 8, fontWeight: 700, textDecoration: 'none' }}
                    >
                      Ouvrir le fichier
                    </a>
                  </div>
                )}
              </div>

              {imageMode && zoom === 1 && (
                <div style={{ textAlign: 'center', color: 'rgba(255,255,255,.5)', fontSize: 10, padding: '6px 10px' }}>
                  Double-clic pour zoomer · molette pour ajuster
                </div>
              )}
            </div>
          )
        })()}

      </div>
    </div>
  )
}
