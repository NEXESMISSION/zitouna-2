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

  // Local styles: mobile-first, accessible, larger tap targets.
  const localStyles = `
    @keyframes recouv-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(16,185,129,.25) } 50% { box-shadow: 0 0 0 8px rgba(16,185,129,0) } }
    .rcv-guide { font-size: 13px; color: #475569; line-height: 1.45; margin: 4px 0 10px; }
    .rcv-section-title { font-size: 13px; font-weight: 800; color: #0f172a; letter-spacing: .02em; text-transform: uppercase; margin: 14px 0 4px; display: flex; align-items: center; gap: 8px; }
    .rcv-section-hint { font-size: 12px; color: #64748b; margin: 0 0 10px; }
    .rcv-legend { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .rcv-legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #334155; background: #f8fafc; border: 1px solid #e2e8f0; padding: 4px 10px; border-radius: 999px; }
    .rcv-legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .rcv-search { position: relative; }
    .rcv-search input { width: 100%; min-height: 44px; padding: 10px 14px 10px 40px; border-radius: 10px; border: 1.5px solid #e2e8f0; font-size: 14px; background: #fff; }
    .rcv-search input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
    .rcv-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); font-size: 16px; color: #94a3b8; pointer-events: none; }
    .rcv-alert { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 12px; margin-bottom: 10px; font-size: 13px; }
    .rcv-alert--warn { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
    .rcv-alert--info { background: #eff6ff; color: #075985; border: 1px solid #bae6fd; }
    .rcv-alert__title { font-weight: 800; font-size: 13px; margin-bottom: 2px; }
    .rcv-alert__sub { font-size: 12px; opacity: .85; }
    .rcv-submitted-banner { display: flex; align-items: center; gap: 10px; padding: 12px 14px; margin-bottom: 10px; border-radius: 12px; background: linear-gradient(135deg,#ecfdf5,#d1fae5); border: 1px solid #a7f3d0; animation: recouv-pulse 2s infinite; }
    .rcv-submitted-banner__icon { font-size: 22px; }
    .rcv-submitted-banner__title { font-size: 13px; font-weight: 800; color: #065f46; }
    .rcv-submitted-banner__sub { font-size: 12px; color: #047857; }
    .rcv-card { text-align: left; width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid #e2e8f0; background: #fff; cursor: pointer; transition: transform .12s ease, box-shadow .12s ease; }
    .rcv-card:hover { box-shadow: 0 4px 14px rgba(15,23,42,.08); transform: translateY(-1px); }
    .rcv-card__head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .rcv-avatar { width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; }
    .rcv-card__name { font-size: 14px; font-weight: 800; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rcv-card__sub { font-size: 12px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rcv-badge { font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
    .rcv-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; padding: 8px 10px; background: #f8fafc; border-radius: 8px; margin-bottom: 6px; border: 1px solid #eef2f7; }
    .rcv-stat__label { font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .02em; }
    .rcv-stat__value { font-size: 13px; font-weight: 800; color: #0f172a; }
    .rcv-progress { height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; }
    .rcv-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; border: 1px solid #e2e8f0; background: #fff; color: #0f172a; }
    .rcv-btn--primary { background: linear-gradient(180deg, #3b82f6, #2563eb); color: #fff; border-color: transparent; box-shadow: 0 2px 8px rgba(37,99,235,.2); }
    .rcv-btn--primary:hover:not(:disabled) { filter: brightness(1.05); }
    .rcv-btn--danger { background: linear-gradient(180deg, #ef4444, #dc2626); color: #fff; border-color: transparent; box-shadow: 0 2px 8px rgba(220,38,38,.2); }
    .rcv-btn--success { background: linear-gradient(180deg, #10b981, #059669); color: #fff; border-color: transparent; box-shadow: 0 2px 8px rgba(16,185,129,.25); }
    .rcv-btn--ghost { background: #f1f5f9; color: #334155; }
    .rcv-btn:disabled { opacity: .55; cursor: not-allowed; }
    .rcv-chip { display: inline-flex; align-items: center; min-height: 36px; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; border: 1.5px solid #e2e8f0; background: #fff; color: #475569; cursor: pointer; }
    .rcv-chip--active { background: #2563eb; color: #fff; border-color: #2563eb; }
    .rcv-row { display: flex; flex-direction: column; gap: 8px; padding: 12px; margin-bottom: 6px; border-radius: 10px; background: #fff; border: 1px solid #e2e8f0; }
    .rcv-row__line { display: flex; align-items: center; gap: 10px; }
    .rcv-row__month { font-size: 14px; font-weight: 800; color: #0f172a; }
    .rcv-row__due { font-size: 12px; color: #64748b; }
    .rcv-row__amount { font-size: 14px; font-weight: 800; color: #0f172a; }
    .rcv-pill { font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 999px; }
    .rcv-receipt-btn { display: flex; gap: 10px; align-items: center; background: #f8fafc; padding: 10px; border-radius: 10px; border: 1px solid #e2e8f0; cursor: pointer; text-align: left; width: 100%; min-height: 56px; }
    .rcv-receipt-btn:hover { background: #f1f5f9; border-color: #cbd5e1; }
    .rcv-empty { text-align: center; padding: 28px 16px; color: #64748b; background: #f8fafc; border-radius: 12px; border: 1px dashed #cbd5e1; }
    .rcv-empty__icon { font-size: 36px; margin-bottom: 8px; }
    .rcv-empty__title { font-size: 15px; font-weight: 800; color: #334155; display: block; margin-bottom: 4px; }
    .rcv-empty__hint { font-size: 12px; color: #64748b; }
    .rcv-summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
    .rcv-summary-card { padding: 10px 12px; border-radius: 10px; border: 1px solid #e2e8f0; }
    .rcv-summary-card__label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .02em; margin-bottom: 2px; }
    .rcv-summary-card__value { font-size: 16px; font-weight: 800; }
    .rcv-summary-card__hint { font-size: 11px; opacity: .8; margin-top: 2px; }
    @media (max-width: 600px) {
      .rcv-summary-grid { grid-template-columns: 1fr; }
      .rcv-stats { grid-template-columns: 1fr 1fr; }
    }
  `

  const hasAnyDossier = (filtered.length + filteredMissingPlan.length) > 0

  return (
    <div className="zitu-page" dir="ltr">
      <style>{localStyles}</style>
      <div className="zitu-page__column">

        <button type="button" className="ds-back-btn" onClick={() => navigate('/admin')}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        <div className="ds-hero">
          <div className="ds-hero__top">
            <div className="ds-hero__icon" aria-hidden>💳</div>
            <div>
              <h1 className="ds-hero__title" style={{ fontSize: 20 }}>Recouvrement des échéances</h1>
              <p className="ds-hero__sub" style={{ fontSize: 13 }}>Validez les reçus envoyés par les clients et suivez les impayés.</p>
            </div>
          </div>
          <div className="ds-hero__kpi">
            <div className="ds-hero__kpi-block" title="Nombre total de dossiers en cours">
              <span className="ds-hero__kpi-num">{dossiers.length}</span>
              <span className="ds-hero__kpi-unit">Dossiers</span>
            </div>
            <span className="ds-hero__kpi-sep" />
            <div className="ds-hero__kpi-block" title="Reçus en attente de votre validation">
              <span className="ds-hero__kpi-num">{totalSubmitted}</span>
              <span className="ds-hero__kpi-unit">À valider</span>
            </div>
            <span className="ds-hero__kpi-sep" />
            <div className="ds-hero__kpi-block" title="Échéances dépassées ou rejetées">
              <span className="ds-hero__kpi-num">{totalOverdue}</span>
              <span className="ds-hero__kpi-unit">Impayés</span>
            </div>
          </div>
        </div>

        {/* Mode d'emploi rapide : aide pour un staff qui arrive la première fois */}
        <p className="rcv-guide">
          <strong>Comment utiliser&nbsp;:</strong> cliquez sur un dossier pour voir ses échéances. Les dossiers en <span style={{ color: '#059669', fontWeight: 700 }}>vert</span> ont un reçu à valider, ceux en <span style={{ color: '#dc2626', fontWeight: 700 }}>rouge</span> ont un impayé. Utilisez la recherche pour retrouver un client.
        </p>

        {/* Légende des statuts */}
        <div className="rcv-legend" aria-label="Légende des statuts">
          <span className="rcv-legend-item"><span className="rcv-legend-dot" style={{ background: '#10b981' }} />Reçu à valider</span>
          <span className="rcv-legend-item"><span className="rcv-legend-dot" style={{ background: '#dc2626' }} />Impayé / rejeté</span>
          <span className="rcv-legend-item"><span className="rcv-legend-dot" style={{ background: '#3b82f6' }} />À jour</span>
        </div>

        {/* Alerte plans manquants */}
        {missingPlanSales.length > 0 && (
          <div className="rcv-alert rcv-alert--warn" role="alert">
            <span aria-hidden style={{ fontSize: 18 }}>⚠️</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="rcv-alert__title">
                {missingPlanSales.length} vente{missingPlanSales.length > 1 ? 's' : ''} sans échéancier
              </div>
              <div className="rcv-alert__sub">
                Ces ventes clôturées à tempérament n’ont pas encore de plan. Cliquez pour générer automatiquement.
              </div>
            </div>
            <button
              type="button"
              className="rcv-btn rcv-btn--primary"
              disabled={repairBusy}
              onClick={runBulkRepair}
            >
              {repairBusy ? 'Réparation…' : '🛠 Tout réparer'}
            </button>
          </div>
        )}

        {repairStatus && (
          <div className="rcv-alert rcv-alert--info" role="status">
            <span aria-hidden>ℹ️</span>
            <span>{repairStatus}</span>
          </div>
        )}

        {/* Bandeau action prioritaire : reçus à valider */}
        {totalSubmitted > 0 && (
          <div className="rcv-submitted-banner" role="status">
            <span className="rcv-submitted-banner__icon" aria-hidden>📩</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="rcv-submitted-banner__title">
                {totalSubmitted} reçu{totalSubmitted > 1 ? 's' : ''} en attente de validation
              </div>
              <div className="rcv-submitted-banner__sub">
                Les dossiers concernés sont signalés en vert ci-dessous.
              </div>
            </div>
          </div>
        )}

        {/* Recherche */}
        <div className="rcv-section-title"><span aria-hidden>🔎</span>Rechercher un dossier</div>
        <p className="rcv-section-hint">Tapez un nom de client ou un nom de projet.</p>
        <div className="rcv-search" style={{ marginBottom: 12 }}>
          <span className="rcv-search-icon" aria-hidden>🔎</span>
          <input
            aria-label="Rechercher un client ou un projet"
            placeholder="Ex : Ahmed Ben Ali, Résidence Zitouna…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* Liste des dossiers */}
        <div className="rcv-section-title"><span aria-hidden>📂</span>Dossiers clients</div>
        <p className="rcv-section-hint">Cliquez sur un dossier pour voir les échéances et valider les reçus.</p>

        {plansLoading ? (
          <div className="rcv-empty">
            <div className="rcv-empty__icon" aria-hidden>⏳</div>
            <strong className="rcv-empty__title">Chargement des dossiers…</strong>
            <div className="rcv-empty__hint">Merci de patienter quelques instants.</div>
          </div>
        ) : (
          <div className="zitu-page__card-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredMissingPlan.map((sale) => {
              const isBusy = repairSingleBusy === sale.id
              return (
                <div
                  key={`missing-${sale.id}`}
                  className="rcv-card"
                  style={{
                    borderLeft: '4px solid #d97706',
                    background: 'linear-gradient(135deg,#fff,#fffbeb)',
                  }}
                >
                  <div className="rcv-card__head">
                    <span
                      className="rcv-avatar"
                      style={{ background: 'linear-gradient(135deg,#fef3c7,#fde68a)', color: '#92400e' }}
                    >
                      {initials(sale.clientName || '')}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="rcv-card__name">{sale.clientName || 'Client'}</div>
                      <div className="rcv-card__sub">{sale.projectTitle || 'Projet'} · {sale.code || sale.id}</div>
                    </div>
                    <span className="rcv-badge" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                      Sans plan
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: '#92400e', marginBottom: 10, lineHeight: 1.4 }}>
                    Vente à tempérament clôturée, mais aucun échéancier n’a été généré.
                  </div>
                  <button
                    type="button"
                    className="rcv-btn rcv-btn--primary"
                    disabled={isBusy}
                    onClick={() => runSingleRepair(sale)}
                    style={{ width: '100%' }}
                  >
                    {isBusy ? 'Réparation en cours…' : '🛠 Générer l’échéancier'}
                  </button>
                </div>
              )
            })}

            {!hasAnyDossier ? (
              <div className="rcv-empty">
                <div className="rcv-empty__icon" aria-hidden>📭</div>
                <strong className="rcv-empty__title">Aucun dossier à afficher</strong>
                <div className="rcv-empty__hint">
                  {query ? 'Essayez un autre terme de recherche ou effacez le champ.' : 'Les nouveaux dossiers apparaîtront ici après la clôture des ventes à tempérament.'}
                </div>
                {query && (
                  <button
                    type="button"
                    className="rcv-btn rcv-btn--ghost"
                    onClick={() => setQuery('')}
                    style={{ marginTop: 12 }}
                  >
                    Effacer la recherche
                  </button>
                )}
              </div>
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
                    : { borderLeft: '4px solid #cbd5e1' }
                const avatarStyle = status === 'has-recu'
                  ? { background: 'linear-gradient(135deg,#d1fae5,#a7f3d0)', color: '#065f46' }
                  : status === 'overdue'
                    ? { background: 'linear-gradient(135deg,#fecaca,#fca5a5)', color: '#991b1b' }
                    : { background: 'linear-gradient(135deg,#dbeafe,#bfdbfe)', color: '#1d4ed8' }
                return (
                  <button
                    key={d.id}
                    type="button"
                    className="rcv-card"
                    style={cardStyle}
                    onClick={() => { setSelectedId(d.id); setPaymentFilter('all') }}
                    title="Ouvrir le dossier pour valider les reçus"
                  >
                    <div className="rcv-card__head">
                      <span className="rcv-avatar" style={avatarStyle}>{initials(d.name)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="rcv-card__name">{d.name}</div>
                        <div className="rcv-card__sub">{d.project} · Parcelle #{d.plotId}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0, alignItems: 'flex-end' }}>
                        {m.submittedCount > 0 && (
                          <span className="rcv-badge" style={{ background: '#ecfdf5', color: '#059669', border: '1px solid #a7f3d0' }}>
                            {m.submittedCount} reçu{m.submittedCount > 1 ? 's' : ''}
                          </span>
                        )}
                        {overdueCount > 0 && (
                          <span className="rcv-badge" style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>
                            {overdueCount} impayé{overdueCount > 1 ? 's' : ''}
                          </span>
                        )}
                        {m.submittedCount === 0 && overdueCount === 0 && (
                          <span className="rcv-badge" style={{ background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' }}>
                            À jour
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="rcv-stats">
                      <div>
                        <div className="rcv-stat__label">Encaissé</div>
                        <div className="rcv-stat__value" style={{ color: '#059669' }}>{formatMoneyTnd(m.cashValidatedStrict)}</div>
                      </div>
                      <div>
                        <div className="rcv-stat__label">Reste dû</div>
                        <div className="rcv-stat__value">{formatMoneyTnd(m.remainingOperational)}</div>
                      </div>
                      <div>
                        <div className="rcv-stat__label">Mois</div>
                        <div className="rcv-stat__value">
                          {m.approvedCount}
                          <span style={{ color: '#94a3b8', fontWeight: 600 }}>/{m.totalMonths}</span>
                        </div>
                      </div>
                    </div>

                    <div className="rcv-progress" aria-label={`Avancement ${Math.round(progressPct)}%`}>
                      <div style={{
                        height: '100%',
                        width: `${progressPct}%`,
                        background: status === 'has-recu' ? '#10b981' : status === 'overdue' ? '#f87171' : '#3b82f6',
                        borderRadius: 3,
                      }} />
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
                {/* En-tête dossier */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <span
                    className="rcv-avatar"
                    style={{ width: 44, height: 44, background: 'linear-gradient(135deg,#dbeafe,#bfdbfe)', color: '#1d4ed8', fontSize: 15 }}
                  >
                    {initials(selected.name)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>{selected.name}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{selected.project} · Parcelle #{selected.plotId}</div>
                  </div>
                </div>

                {/* Résumé rapide */}
                <div className="rcv-summary-grid">
                  <div className="rcv-summary-card" style={{ background: '#ecfdf5', borderColor: '#a7f3d0' }}>
                    <div className="rcv-summary-card__label" style={{ color: '#065f46' }}>Encaissé validé</div>
                    <div className="rcv-summary-card__value" style={{ color: '#065f46' }}>{formatMoneyTnd(m.cashValidatedStrict)}</div>
                    <div className="rcv-summary-card__hint" style={{ color: '#047857' }}>Araboun + mensualités approuvées</div>
                  </div>
                  <div className="rcv-summary-card" style={{ background: '#eff6ff', borderColor: '#bfdbfe' }}>
                    <div className="rcv-summary-card__label" style={{ color: '#1e40af' }}>Reçu (en cours)</div>
                    <div className="rcv-summary-card__value" style={{ color: '#1e40af' }}>{formatMoneyTnd(m.cashReceivedOperational)}</div>
                    <div className="rcv-summary-card__hint" style={{ color: '#1d4ed8' }}>Inclut reçus non encore validés</div>
                  </div>
                  <div className="rcv-summary-card" style={{ background: '#fff', borderColor: '#e2e8f0' }}>
                    <div className="rcv-summary-card__label" style={{ color: '#475569' }}>Reste dû (strict)</div>
                    <div className="rcv-summary-card__value" style={{ color: '#0f172a' }}>{formatMoneyTnd(m.remainingStrict)}</div>
                    <div className="rcv-summary-card__hint" style={{ color: '#94a3b8' }}>Après validation finance</div>
                  </div>
                  <div className="rcv-summary-card" style={{ background: '#fff', borderColor: '#e2e8f0' }}>
                    <div className="rcv-summary-card__label" style={{ color: '#475569' }}>Reste dû (opérationnel)</div>
                    <div className="rcv-summary-card__value" style={{ color: '#0f172a' }}>{formatMoneyTnd(m.remainingOperational)}</div>
                    <div className="rcv-summary-card__hint" style={{ color: '#94a3b8' }}>Si reçus en cours sont validés</div>
                  </div>
                </div>

                {/* Progression */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 4 }}>
                    <span>{m.approvedCount} / {m.totalMonths} mois validés</span>
                    <span>{Math.round(progressPct)}%</span>
                  </div>
                  <div className="rcv-progress" style={{ height: 8 }}>
                    <div style={{ height: '100%', width: `${progressPct}%`, background: 'linear-gradient(90deg,#2563eb,#3b82f6)', borderRadius: 4 }} />
                  </div>
                </div>

                {/* Détails contrat */}
                <details style={{ marginBottom: 12, background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                  <summary style={{ cursor: 'pointer', padding: '10px 12px', fontSize: 13, fontWeight: 800, color: '#334155' }}>
                    📋 Détails du contrat
                  </summary>
                  <div style={{ padding: '4px 12px 12px' }}>
                    <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Téléphone</span><span className="zitu-page__detail-value">{selected.phone || '—'}</span></div>
                    <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Prix convenu</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.saleAgreed)}</span></div>
                    <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">1er versement prévu ({m.downPct}%)</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.downPaymentPlanned)}</span></div>
                    <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Acompte terrain (araboun)</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.terrainDeposit)}</span></div>
                    <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Solde finance à encaisser</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.financeBalanceAtSale)}</span></div>
                    <div className="zitu-page__detail-row"><span className="zitu-page__detail-label">Capital restant planifié</span><span className="zitu-page__detail-value">{formatMoneyTnd(m.capitalRemainingPlanned)}</span></div>
                  </div>
                </details>

                {/* Filtres échéances */}
                <div className="rcv-section-title" style={{ margin: '4px 0 2px' }}><span aria-hidden>📅</span>Échéances</div>
                <p className="rcv-section-hint">Filtrez la liste puis cliquez sur un reçu pour le valider ou le refuser.</p>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {[
                    ['all', 'Tous', '📋'],
                    ['submitted', 'À valider', '📩'],
                    ['overdue', 'En retard', '⚠️'],
                    ['rejected', 'Rejetés', '✗'],
                    ['pending', 'À venir', '⏳'],
                    ['approved', 'Validés', '✓'],
                  ].map(([key, label, icon]) => (
                    <button
                      key={key}
                      type="button"
                      className={`rcv-chip ${paymentFilter === key ? 'rcv-chip--active' : ''}`}
                      onClick={() => setPaymentFilter(key)}
                      title={`Filtrer : ${label}`}
                    >
                      <span style={{ marginRight: 4 }} aria-hidden>{icon}</span>{label}
                    </button>
                  ))}
                </div>

                {visiblePayments.length === 0 ? (
                  <div className="rcv-empty" style={{ padding: 20 }}>
                    <div className="rcv-empty__icon" aria-hidden>📭</div>
                    <strong className="rcv-empty__title">Aucune échéance dans cette vue</strong>
                    <div className="rcv-empty__hint">Changez de filtre pour voir d’autres mois.</div>
                  </div>
                ) : visiblePayments.map((p) => {
                  const isOverdue = (p.status === 'pending' && p.dueDate < TODAY)
                  const isRejected = p.status === 'rejected'
                  const isSubmitted = p.status === 'submitted'
                  const isPaid = p.status === 'approved'
                  let leftBorder = '#e2e8f0'
                  let rowBg = '#fff'
                  let statusLabel = 'À venir'
                  let statusColor = '#64748b'
                  if (isSubmitted) { leftBorder = '#10b981'; rowBg = '#ecfdf5'; statusLabel = 'Reçu à valider'; statusColor = '#059669' }
                  if (isOverdue) { leftBorder = '#dc2626'; rowBg = '#fef2f2'; statusLabel = 'En retard'; statusColor = '#dc2626' }
                  if (isRejected) { leftBorder = '#dc2626'; rowBg = '#fef2f2'; statusLabel = 'Rejeté'; statusColor = '#dc2626' }
                  if (isPaid) { leftBorder = '#059669'; rowBg = '#f0fdf4'; statusLabel = 'Validé'; statusColor = '#065f46' }
                  const receipt = latestReceipt(p)
                  const receiptIsImage = receipt && isImageUrl(receipt.url)
                  return (
                    <div
                      key={p.id}
                      className="rcv-row"
                      style={{ background: rowBg, borderLeft: `4px solid ${leftBorder}` }}
                    >
                      <div className="rcv-row__line">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                            <span className="rcv-row__month">Mois {p.month}</span>
                            <span className="rcv-row__due">Échéance : {fmtDate(p.dueDate)}</span>
                          </div>
                          <span className="rcv-pill" style={{ background: 'rgba(255,255,255,.7)', color: statusColor, border: `1px solid ${leftBorder}33` }}>
                            {statusLabel}
                          </span>
                          {p.rejectedNote && (
                            <div style={{ fontSize: 12, color: '#dc2626', marginTop: 4 }}>
                              <strong>Motif :</strong> {p.rejectedNote}
                            </div>
                          )}
                        </div>
                        <span className="rcv-row__amount">{fmtMoney(p.amount)}</span>
                      </div>

                      {receipt ? (
                        <button
                          type="button"
                          onClick={() => openReview(p)}
                          className="rcv-receipt-btn"
                          aria-label={`Examiner le reçu du mois ${p.month}`}
                        >
                          {receiptIsImage ? (
                            <img src={receipt.url} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e8f0' }} />
                          ) : (
                            <div style={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e2e8f0', borderRadius: 8, fontSize: 22 }} aria-hidden>📄</div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#0f172a' }}>{receipt.name}</div>
                            {receipt.date && <div style={{ fontSize: 12, color: '#64748b' }}>Reçu le {fmtDate(receipt.date)}</div>}
                            {receipt.note && <div style={{ fontSize: 12, color: '#475569', fontStyle: 'italic' }}>« {receipt.note} »</div>}
                          </div>
                          <span style={{ fontSize: 12, color: '#2563eb', fontWeight: 800, flexShrink: 0, whiteSpace: 'nowrap' }}>
                            Examiner →
                          </span>
                        </button>
                      ) : (
                        <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic', padding: '4px 2px' }}>
                          En attente du reçu du client.
                        </div>
                      )}

                      {(isRejected || isPaid) && (
                        <div>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => resetPayment(p.id, 'pending')}
                            className="rcv-btn rcv-btn--ghost"
                            title="Remettre cette échéance en attente de paiement"
                          >
                            ↺ Réinitialiser
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}

                {selected.phone && (
                  <a
                    href={`tel:${selected.phone}`}
                    className="rcv-btn rcv-btn--primary"
                    style={{ width: '100%', marginTop: 12, textDecoration: 'none', fontSize: 14, minHeight: 44 }}
                  >
                    📞 Appeler {selected.phone}
                  </a>
                )}
              </>
            )
          })()}
        </AdminModal>

        <AdminModal open={!!rejectTarget} onClose={() => setRejectTarget(null)} title="Refuser le reçu">
          <p style={{ fontSize: 13, color: '#475569', margin: '0 0 10px' }}>
            Expliquez clairement au client pourquoi le reçu est refusé. Il verra ce motif dans son espace.
          </p>
          <div className="zitu-page__field">
            <label className="zitu-page__field-label" style={{ fontSize: 13, fontWeight: 700 }}>
              Motif du refus <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <textarea
              className="zitu-page__input"
              rows={4}
              placeholder="Ex : Montant incorrect, reçu illisible, banque non reconnue…"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 13, minHeight: 80 }}
            />
            {!rejectNote.trim() && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
                Le motif est obligatoire pour refuser un reçu.
              </div>
            )}
          </div>
          <div className="zitu-page__form-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="rcv-btn" onClick={() => setRejectTarget(null)}>Annuler</button>
            <button
              type="button"
              className="rcv-btn rcv-btn--danger"
              disabled={!rejectNote.trim() || actionBusy}
              onClick={confirmReject}
            >
              {actionBusy ? 'Envoi…' : 'Confirmer le refus'}
            </button>
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
                background: 'rgba(15,23,42,.95)',
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
                gap: 10,
                padding: '12px 16px',
                background: 'linear-gradient(180deg, rgba(15,23,42,.95), rgba(15,23,42,.6))',
                color: '#fff',
                flexWrap: 'wrap',
              }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 15, fontWeight: 800 }}>Mois {month} · {fmtMoney(amount)}</div>
                  <div style={{ fontSize: 12, color: '#cbd5e1' }}>Échéance : {fmtDate(dueDate)} · {receipt.name}</div>
                  {rejectedNote && <div style={{ fontSize: 12, color: '#fecaca', marginTop: 3 }}>⚠ Motif précédent : {rejectedNote}</div>}
                </div>

                {imageMode && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      onClick={zoomOut}
                      disabled={zoom <= 1}
                      aria-label="Dézoomer"
                      style={{ border: '1px solid rgba(255,255,255,.25)', background: 'rgba(255,255,255,.08)', color: '#fff', borderRadius: 8, minWidth: 36, minHeight: 36, padding: '4px 10px', fontSize: 16, fontWeight: 800, cursor: zoom <= 1 ? 'not-allowed' : 'pointer', opacity: zoom <= 1 ? 0.5 : 1 }}
                    >−</button>
                    <span style={{ fontSize: 12, fontWeight: 700, minWidth: 48, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
                    <button
                      type="button"
                      onClick={zoomIn}
                      disabled={zoom >= 5}
                      aria-label="Zoomer"
                      style={{ border: '1px solid rgba(255,255,255,.25)', background: 'rgba(255,255,255,.08)', color: '#fff', borderRadius: 8, minWidth: 36, minHeight: 36, padding: '4px 10px', fontSize: 16, fontWeight: 800, cursor: zoom >= 5 ? 'not-allowed' : 'pointer', opacity: zoom >= 5 ? 0.5 : 1 }}
                    >+</button>
                    <button
                      type="button"
                      onClick={zoomReset}
                      style={{ border: '1px solid rgba(255,255,255,.25)', background: 'rgba(255,255,255,.08)', color: '#fff', borderRadius: 8, padding: '8px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', minHeight: 36 }}
                    >Reset</button>
                  </div>
                )}

                <a
                  href={receipt.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 13, fontWeight: 700, color: '#93c5fd', textDecoration: 'none', padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(147,197,253,.4)', minHeight: 36, display: 'inline-flex', alignItems: 'center' }}
                >
                  Ouvrir ↗
                </a>

                <button
                  type="button"
                  onClick={closeReview}
                  style={{ border: 'none', background: 'rgba(255,255,255,.15)', color: '#fff', width: 40, height: 40, borderRadius: 10, fontSize: 18, cursor: 'pointer' }}
                  aria-label="Fermer"
                  title="Fermer (Échap)"
                >
                  ✕
                </button>
              </div>

              {/* Action bar : approuver / rejeter — grand et prioritaire */}
              <div style={{
                display: 'flex',
                gap: 10,
                padding: '12px 16px',
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
                    minWidth: 140,
                    minHeight: 48,
                    border: 'none',
                    borderRadius: 10,
                    padding: '12px 18px',
                    fontSize: 15,
                    fontWeight: 800,
                    background: isPaid ? '#065f46' : 'linear-gradient(180deg, #10b981, #059669)',
                    color: '#fff',
                    cursor: actionBusy || isPaid ? 'not-allowed' : 'pointer',
                    opacity: isPaid ? 0.7 : 1,
                    boxShadow: '0 4px 14px rgba(16,185,129,.35)',
                  }}
                  title="Valider ce reçu comme paiement reçu"
                >
                  {isPaid ? '✓ Déjà approuvé' : (actionBusy ? 'Validation…' : '✓ Approuver le reçu')}
                </button>
                <button
                  type="button"
                  disabled={actionBusy || isRejected}
                  onClick={() => { setRejectTarget({ paymentId }); setRejectNote(rejectedNote || '') }}
                  style={{
                    flex: 1,
                    minWidth: 140,
                    minHeight: 48,
                    border: 'none',
                    borderRadius: 10,
                    padding: '12px 18px',
                    fontSize: 15,
                    fontWeight: 800,
                    background: isRejected ? '#7f1d1d' : 'linear-gradient(180deg, #ef4444, #dc2626)',
                    color: '#fff',
                    cursor: actionBusy || isRejected ? 'not-allowed' : 'pointer',
                    opacity: isRejected ? 0.7 : 1,
                    boxShadow: '0 4px 14px rgba(220,38,38,.35)',
                  }}
                  title="Refuser ce reçu (un motif sera demandé)"
                >
                  {isRejected ? '✗ Déjà rejeté' : '✗ Refuser le reçu'}
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
                  <div style={{ color: '#e2e8f0', textAlign: 'center', padding: 20 }}>
                    <div style={{ fontSize: 64 }} aria-hidden>📄</div>
                    <div style={{ fontSize: 14, marginTop: 12 }}>Ce reçu est un fichier PDF ou un document non-image.</div>
                    <a
                      href={receipt.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'inline-block', marginTop: 16, padding: '12px 22px', background: '#2563eb', color: '#fff', borderRadius: 10, fontWeight: 800, textDecoration: 'none', fontSize: 14 }}
                    >
                      Ouvrir le fichier
                    </a>
                  </div>
                )}
              </div>

              {imageMode && zoom === 1 && (
                <div style={{ textAlign: 'center', color: 'rgba(255,255,255,.6)', fontSize: 12, padding: '8px 10px' }}>
                  Astuce : double-clic pour zoomer · molette pour ajuster · glisser pour déplacer une fois zoomé
                </div>
              )}
            </div>
          )
        })()}

      </div>
    </div>
  )
}
