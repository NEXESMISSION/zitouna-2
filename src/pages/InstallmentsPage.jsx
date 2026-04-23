import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import DashboardShell from '../components/DashboardShell.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import { useInstallmentsScoped, useSalesScoped } from '../lib/useSupabase.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { runSafeAction } from '../lib/runSafeAction.js'
import { addInstallmentReceiptRecord, updatePaymentStatus, uploadInstallmentReceipt } from '../lib/db.js'
import { computeInstallmentSaleMetrics, formatMoneyTnd, getPaymentPageForNextDue } from '../domain/installmentMetrics.js'
import './installments-page.css'
import './dashboard-page.css'

const MAX_IMAGE_DIMENSION = 1600
const IMAGE_QUALITY = 0.76
// See DashboardPage.jsx — 450 KB was too tight and silently blocked real
// camera shots after compression. 2 MB matches the dashboard ceiling.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_NON_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i

function fmtDate(iso) { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) }
function statusMeta(status) {
  if (status === 'approved') return { label: 'Confirmé', hint: 'Paiement validé par l\'administration.', tone: 'approved' }
  if (status === 'submitted') return { label: 'En révision', hint: 'Reçu envoyé, en attente de validation.', tone: 'submitted' }
  if (status === 'rejected') return { label: 'Rejeté', hint: 'Action requise : corriger et renvoyer.', tone: 'rejected' }
  return { label: 'En attente', hint: 'Vous pouvez envoyer le reçu.', tone: 'pending' }
}
function isPayable(status) { return status === 'pending' || status === 'rejected' || status === 'submitted' }
function isImageUrl(url) {
  if (!url) return false
  try { return IMAGE_EXT_RE.test(new URL(url).pathname) } catch { return IMAGE_EXT_RE.test(url) }
}
function lastReceipt(payment) {
  if (Array.isArray(payment.receipts) && payment.receipts.length > 0) {
    const r = payment.receipts[0]
    return { url: r.url, name: r.fileName || 'reçu', date: r.createdAt }
  }
  if (payment.receiptUrl && String(payment.receiptUrl).startsWith('http')) {
    return { url: payment.receiptUrl, name: payment.fileName || 'reçu', date: null }
  }
  return null
}
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Impossible de lire l\'image')) }
    img.src = url
  })
}
async function optimizeImageFile(file) {
  const img = await loadImageFromFile(file)
  const maxSide = Math.max(img.width, img.height)
  const ratio = maxSide > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / maxSide : 1
  const w = Math.max(1, Math.round(img.width * ratio))
  const h = Math.max(1, Math.round(img.height * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) throw new Error('Canvas non disponible')
  ctx.drawImage(img, 0, 0, w, h)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', IMAGE_QUALITY))
  if (!blob) throw new Error('Échec compression image')
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'receipt'}.webp`, { type: 'image/webp' })
}

export default function InstallmentsPage() {
  const navigate = useNavigate()
  const { state } = useLocation()
  const { clientProfile, ready } = useAuth()
  // Plan 04 §3.2 — block the scoped fetch until auth has fully resolved
  // AND the clientId is set. `useInstallmentsScoped` short-circuits on a
  // null/empty clientId (loading=false + empty plans) so passing `null`
  // here is safe and no longer produces a stuck skeleton on first mount.
  const clientId = (ready && clientProfile?.id) ? clientProfile.id : null
  const { plans, loading: plansLoading, refresh } = useInstallmentsScoped({ clientId })
  const { sales: mySales } = useSalesScoped({ clientId })

  const planSaleIds = useMemo(() => new Set((plans || []).map((p) => String(p.saleId || ''))), [plans])
  const installmentSalesMissingPlan = useMemo(
    () => (mySales || []).filter((s) => {
      if (String(s.paymentType || '').toLowerCase() !== 'installments') return false
      const st = String(s.status || '').toLowerCase()
      const pipe = String(s.pipelineStatus || '').toLowerCase()
      const isCompleted = st === 'completed' || pipe === 'completed'
      if (!isCompleted) return false
      return !planSaleIds.has(String(s.id))
    }),
    [mySales, planSaleIds],
  )
  const hasAnyInstallmentSale = useMemo(
    () => (mySales || []).some((s) => String(s.paymentType || '').toLowerCase() === 'installments'),
    [mySales],
  )

  const focusedPlanId = state?.planId || ''
  const visiblePlans = focusedPlanId ? plans.filter((p) => p.id === focusedPlanId) : plans
  const focusedPlan = focusedPlanId ? visiblePlans[0] : null

  const saleForPlan = useCallback(
    (plan) => (mySales || []).find((s) => String(s.id) === String(plan?.saleId)) || null,
    [mySales],
  )
  const focusedMetrics = useMemo(
    () => (focusedPlan ? computeInstallmentSaleMetrics(saleForPlan(focusedPlan) || {}, focusedPlan) : null),
    [focusedPlan, saleForPlan],
  )

  const [payTarget, setPayTarget] = useState(null)
  const [receiptName, setReceiptName] = useState('')
  const [receiptFile, setReceiptFile] = useState(null)
  const [receiptPreview, setReceiptPreview] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Detail-view facility filter — matches the ech-tabs in the reference.
  const [facilityFilter, setFacilityFilter] = useState('all')

  // Pagination for the payments list — open on the page that contains the next due installment.
  const PAYMENTS_PER_PAGE = 5
  const [paymentPager, setPaymentPager] = useState({ planId: '', page: 1 })
  useLayoutEffect(() => {
    if (!focusedPlanId || !focusedPlan?.payments?.length) return
    setPaymentPager({
      planId: focusedPlanId,
      page: getPaymentPageForNextDue(focusedPlan.payments, PAYMENTS_PER_PAGE),
    })
  }, [focusedPlanId, focusedPlan?.id, focusedPlan?.payments?.length])
  const paymentPage = paymentPager.planId === focusedPlanId ? paymentPager.page : 1
  const setPaymentPage = useCallback((next) => {
    setPaymentPager((prev) => {
      const currentPage = prev.planId === focusedPlanId ? prev.page : 1
      const resolved = typeof next === 'function' ? next(currentPage) : next
      return { planId: focusedPlanId, page: resolved }
    })
  }, [focusedPlanId])
  const paymentCount = focusedPlan?.payments?.length || 0
  const totalPaymentPages = Math.max(1, Math.ceil(paymentCount / PAYMENTS_PER_PAGE))
  const safePaymentPage = Math.min(Math.max(1, paymentPage), totalPaymentPages)
  const visiblePayments = useMemo(() => {
    if (!focusedPlan?.payments) return []
    const start = (safePaymentPage - 1) * PAYMENTS_PER_PAGE
    return focusedPlan.payments.slice(start, start + PAYMENTS_PER_PAGE)
  }, [focusedPlan, safePaymentPage])

  const globalStats = useMemo(() => {
    const all = plans.flatMap((p) => p.payments || [])
    return {
      totalPlans: plans.length,
      submitted: all.filter((p) => p.status === 'submitted').length,
      rejected: all.filter((p) => p.status === 'rejected').length,
      approved: all.filter((p) => p.status === 'approved').length,
    }
  }, [plans])

  const handleReceiptChange = useCallback(async (file) => {
    if (!file) return
    setError('')
    let finalFile = file
    if (file.type?.startsWith('image/')) {
      try {
        finalFile = await optimizeImageFile(file)
      } catch {
        // Compression can fail for odd formats (HEIC on older Chrome, etc.);
        // fall back to the raw file rather than blocking the submit.
        finalFile = file
      }
      if (finalFile.size > MAX_IMAGE_BYTES) throw new Error('Image trop lourde (max 2 Mo après compression).')
    } else if (file.size > MAX_NON_IMAGE_BYTES) throw new Error('Fichier trop volumineux (max 5 Mo)')
    setReceiptFile(finalFile)
    if (receiptPreview?.startsWith('blob:')) URL.revokeObjectURL(receiptPreview)
    setReceiptName(finalFile.name)
    setReceiptPreview(finalFile.type?.startsWith('image/') ? URL.createObjectURL(finalFile) : '')
  }, [receiptPreview])

  const openPay = useCallback((plan, payment) => {
    setPayTarget({ planId: plan.id, month: payment.month, amount: payment.amount, dueDate: payment.dueDate })
    setReceiptName('')
    setReceiptFile(null)
    if (receiptPreview?.startsWith('blob:')) URL.revokeObjectURL(receiptPreview)
    setReceiptPreview('')
    setNote('')
    setError('')
  }, [receiptPreview])

  const closePay = useCallback(() => {
    setPayTarget(null)
    setReceiptName('')
    setReceiptFile(null)
    if (receiptPreview?.startsWith('blob:')) URL.revokeObjectURL(receiptPreview)
    setReceiptPreview('')
    setNote('')
    setError('')
  }, [receiptPreview])

  const submit = useCallback(async () => {
    if (!payTarget || !receiptName || !receiptFile || submitting) return
    setError('')
    // The 4-step upload (storage → record → status → refresh) can get stuck
    // on any single step if Supabase Storage or the DB stalls. Watchdog
    // prevents the modal from locking on "Envoi…" forever.
    const res = await runSafeAction({
      setBusy: setSubmitting,
      onError: (msg) => setError(msg),
      label: 'Envoi du reçu',
    }, async () => {
      const plan = plans.find((p) => p.id === payTarget.planId)
      const payment = plan?.payments?.find((p) => p.month === payTarget.month)
      if (!payment?.id) throw new Error('Paiement introuvable')
      const url = await uploadInstallmentReceipt({ paymentId: payment.id, file: receiptFile })
      await addInstallmentReceiptRecord({ paymentId: payment.id, receiptUrl: url || '', fileName: receiptName, note: note || '' })
      await updatePaymentStatus(payment.id, 'submitted', { receiptUrl: url || receiptName })
      await refresh()
    })
    if (res.ok) closePay()
  }, [payTarget, receiptName, receiptFile, submitting, plans, note, refresh, closePay])

  // Facility filter buckets for the detail view. The labels match the
  // reference HTML ("Toutes · En révision · À corriger · Confirmées · À venir").
  const detailFacilities = useMemo(() => {
    if (!focusedPlan?.payments) return []
    const all = focusedPlan.payments
    const review = all.filter((p) => p.status === 'submitted')
    const rejected = all.filter((p) => p.status === 'rejected')
    const approved = all.filter((p) => p.status === 'approved')
    const upcoming = all.filter((p) => p.status === 'pending')
    let list
    if (facilityFilter === 'review') list = review
    else if (facilityFilter === 'rejected') list = rejected
    else if (facilityFilter === 'approved') list = approved
    else if (facilityFilter === 'upcoming') list = upcoming
    else list = all
    return { list, counts: { all: all.length, review: review.length, rejected: rejected.length, approved: approved.length, upcoming: upcoming.length } }
  }, [focusedPlan, facilityFilter])
  const filteredFacilities = detailFacilities.list || []
  const filterCounts = detailFacilities.counts || { all: 0, review: 0, rejected: 0, approved: 0, upcoming: 0 }

  // Re-derive visiblePayments from the filtered list so pagination works
  // against the filter.
  const totalFilteredPages = Math.max(1, Math.ceil(filteredFacilities.length / PAYMENTS_PER_PAGE))
  const safeFilteredPage = Math.min(Math.max(1, paymentPage), totalFilteredPages)
  const visibleFilteredPayments = useMemo(() => {
    const start = (safeFilteredPage - 1) * PAYMENTS_PER_PAGE
    return filteredFacilities.slice(start, start + PAYMENTS_PER_PAGE)
  }, [filteredFacilities, safeFilteredPage])

  const overviewStatusTone = (plan) => {
    const m = computeInstallmentSaleMetrics(saleForPlan(plan) || {}, plan)
    if (m.rejectedCount > 0) return { tone: 'ech-status-red', label: `${m.rejectedCount} à corriger` }
    if (m.submittedCount > 0) return { tone: 'ech-status-amber', label: `${m.submittedCount} en révision` }
    if (m.approvedCount === m.totalMonths && m.totalMonths > 0) return { tone: 'ech-status-green', label: 'Plan terminé' }
    return { tone: 'ech-status-blue', label: 'Rythme normal' }
  }

  const FilterSvg = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
  const ExportSvg = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v12M6 9l6 6 6-6M5 21h14"/></svg>
  const LocSvg = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 22s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>
  const CalSvg = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>

  return (
    <DashboardShell active="installments">
        <div className="ech-shell">
          <div className="ech-topnav">
            <button type="button" className="ech-back" onClick={() => (focusedPlan ? navigate('/installments') : navigate('/dashboard'))}>
              <span className="ech-back-ic" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
              </span>
              {focusedPlan ? 'Tous les plans' : 'Retour accueil'}
            </button>
            <div className="ech-actions">
              <button type="button" className="ech-chip"><FilterSvg /> Filtres</button>
              <button type="button" className="ech-chip"><ExportSvg /> Exporter</button>
            </div>
          </div>

        {focusedPlan ? (
          <>
            <div className="ech-detail-head">
              <div className="ech-title-block">
                <h1>{focusedPlan.projectTitle}</h1>
                <div className="ech-loc">
                  <LocSvg />
                  {focusedPlan.projectCity || 'Projet'} · Réf. {String(focusedPlan.id).slice(0, 8)}
                </div>
                {focusedMetrics && (focusedMetrics.submittedCount > 0 || focusedMetrics.rejectedCount > 0) && (
                  <span className={`ech-status ${focusedMetrics.rejectedCount > 0 ? 'ech-status-red' : 'ech-status-amber'}`}>
                    <span className="ech-d" />
                    {focusedMetrics.rejectedCount > 0
                      ? `${focusedMetrics.rejectedCount} facilité${focusedMetrics.rejectedCount > 1 ? 's' : ''} à corriger`
                      : `${focusedMetrics.submittedCount} facilité${focusedMetrics.submittedCount > 1 ? 's' : ''} en révision`}
                  </span>
                )}
              </div>
              {focusedMetrics && (
                <>
                  <div className="ech-cell">
                    <div className="ech-k">Validé</div>
                    <div className="ech-v ech-green">{formatMoneyTnd(focusedMetrics.cashValidatedStrict).replace(' DT', '')}<span className="ech-u">DT</span></div>
                    <div className="ech-s">Reçu &amp; contrôlé</div>
                  </div>
                  <div className="ech-cell">
                    <div className="ech-k">En révision</div>
                    <div className="ech-v ech-amber">{formatMoneyTnd(focusedMetrics.submittedAmount).replace(' DT', '')}<span className="ech-u">DT</span></div>
                    <div className="ech-s">Reçu, en attente</div>
                  </div>
                  <div className="ech-cell">
                    <div className="ech-k">À corriger</div>
                    <div className={`ech-v ${focusedMetrics.rejectedCount > 0 ? 'ech-red' : 'ech-muted'}`} style={focusedMetrics.rejectedCount > 0 ? { color: 'var(--zb-red)' } : undefined}>
                      {formatMoneyTnd(focusedMetrics.rejectedAmount).replace(' DT', '')}<span className="ech-u">DT</span>
                    </div>
                    <div className="ech-s">Reçus refusés</div>
                  </div>
                  <div className="ech-cell">
                    <div className="ech-k">Reste à valider</div>
                    <div className="ech-v ech-blue">{formatMoneyTnd(focusedMetrics.remainingStrict).replace(' DT', '')}<span className="ech-u">DT</span></div>
                    <div className="ech-s">sur {formatMoneyTnd(focusedMetrics.saleAgreed)}</div>
                  </div>
                </>
              )}
            </div>

            <div className="ech-mode">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
              <span><b>Mode d&apos;emploi.</b> En attente = envoyez un reçu. En révision = attendez la validation. Confirmé = rien à faire. Rejeté = corrigez le reçu.</span>
            </div>

            <div className="ech-filters">
              <div className="ech-tabs" role="tablist">
                {[
                  { key: 'all',       label: 'Toutes',     count: filterCounts.all },
                  { key: 'review',    label: 'En révision', count: filterCounts.review },
                  { key: 'rejected',  label: 'À corriger', count: filterCounts.rejected },
                  { key: 'approved',  label: 'Confirmées', count: filterCounts.approved },
                  { key: 'upcoming',  label: 'À venir',    count: filterCounts.upcoming },
                ].map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={facilityFilter === t.key}
                    className={facilityFilter === t.key ? 'ech-tab-active' : ''}
                    onClick={() => { setFacilityFilter(t.key); setPaymentPage(1) }}
                  >
                    {t.label}{t.count > 0 && <span className="ech-count">{t.count}</span>}
                  </button>
                ))}
              </div>
              <div className="ech-count-info">
                {filteredFacilities.length} facilité{filteredFacilities.length !== 1 ? 's' : ''}
                {filterCounts.all !== filteredFacilities.length && ` · ${filterCounts.all} au total`}
              </div>
            </div>

            <div className="ech-fac-list">
              {visibleFilteredPayments.length === 0 ? (
                <div className="ech-proj" style={{ justifyContent: 'center', color: 'var(--zb-muted)', fontSize: 13 }}>
                  Aucune facilité pour ce filtre.
                </div>
              ) : visibleFilteredPayments.map((p) => {
                const meta = statusMeta(p.status)
                const receipt = lastReceipt(p)
                const receiptIsImage = receipt && isImageUrl(receipt.url)
                const hasExtras = Boolean(receipt) || (p.status === 'rejected' && p.rejectedNote)
                const statusToneClass =
                  meta.tone === 'approved' ? 'ech-green'
                    : meta.tone === 'submitted' ? 'ech-amber'
                      : meta.tone === 'rejected' ? 'ech-red'
                        : 'ech-blue'
                const payable = isPayable(p.status)

                const header = (
                  <>
                    <div className="ech-fac-idx">Facilité<span className="ech-n">{String(p.month).padStart(2, '0')}</span></div>
                    <div className="ech-fac-meta">
                      <div className="ech-fac-date">
                        <CalSvg />
                        Échéance · {fmtDate(p.dueDate)}
                      </div>
                      <div className="ech-fac-note">
                        {p.status === 'submitted' ? 'Reçu envoyé · en attente de validation'
                          : p.status === 'approved' ? 'Paiement validé par l\'administration'
                            : p.status === 'rejected' ? <><span style={{ color: 'var(--zb-red)' }}>Action requise</span> · corrigez et renvoyez le reçu</>
                              : <span className="ech-muted">Reçu à envoyer le jour du paiement</span>}
                      </div>
                    </div>
                    <div className="ech-fac-amount">
                      {p.amount.toLocaleString('fr-FR')}<span className="ech-u">DT</span>
                      <span className={`ech-fac-status ${statusToneClass}`}>● {meta.label}</span>
                    </div>
                  </>
                )

                if (!hasExtras) {
                  return (
                    <div key={`${focusedPlan.id}:${p.month}`} className="ech-fac">
                      {header}
                      <div className="ech-fac-cta">
                        {payable ? (
                          <button type="button" className="ech-btn-primary" onClick={() => openPay(focusedPlan, p)}>
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v14M5 10l7 7 7-7"/></svg>
                            Envoyer un reçu
                          </button>
                        ) : (
                          <span style={{ color: 'var(--zb-muted)', fontSize: 12 }}>—</span>
                        )}
                      </div>
                    </div>
                  )
                }

                return (
                  <div key={`${focusedPlan.id}:${p.month}`} className="ech-fac ech-fac-expanded">
                    <div className="ech-fac-top">
                      {header}
                    </div>
                    {p.status === 'rejected' && p.rejectedNote && (
                      <div className="ech-fac-reject">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                        <span>{p.rejectedNote}</span>
                      </div>
                    )}
                    {receipt && (
                      <div className="ech-fac-receipt">
                        <div className="ech-thumb">
                          {receiptIsImage
                            ? <img src={receipt.url} alt="Reçu" />
                            : <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 3h9l5 5v13H6z"/><path d="M14 3v6h6"/><path d="M9 14h6M9 17h4"/></svg>
                          }
                        </div>
                        <div className="ech-info">
                          <div className="ech-t">{receipt.name}</div>
                          <div className="ech-s">
                            {receipt.date ? `Envoyé le ${fmtDate(receipt.date)}` : 'Reçu en attente de validation'}
                          </div>
                        </div>
                        <a href={receipt.url} target="_blank" rel="noreferrer" className="ech-btn-ghost">
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/></svg>
                          Voir
                        </a>
                      </div>
                    )}
                    {payable && (
                      <div className="ech-fac-actions">
                        {p.status === 'rejected' ? (
                          <button type="button" className="ech-btn-dark" onClick={() => openPay(focusedPlan, p)}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                            Renvoyer un reçu
                          </button>
                        ) : p.status === 'submitted' ? (
                          <button type="button" className="ech-btn-dark" onClick={() => openPay(focusedPlan, p)}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h16v16H4z"/><path d="M4 8h16M8 14l3 3 5-5"/></svg>
                            Remplacer le reçu
                          </button>
                        ) : (
                          <button type="button" className="ech-btn-primary" onClick={() => openPay(focusedPlan, p)}>
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v14M5 10l7 7 7-7"/></svg>
                            Envoyer un reçu
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {totalFilteredPages > 1 && (
              <nav className="ech-pager" aria-label="Pagination des facilités">
                <span className="ech-label">
                  Facilités {(safeFilteredPage - 1) * PAYMENTS_PER_PAGE + 1}–
                  {Math.min(safeFilteredPage * PAYMENTS_PER_PAGE, filteredFacilities.length)}
                  {' · '}{filteredFacilities.length} au total
                </span>
                <div className="ech-dots">
                  <button
                    type="button"
                    className="ech-page-arrow"
                    onClick={() => setPaymentPage((p) => Math.max(1, p - 1))}
                    disabled={safeFilteredPage <= 1}
                    aria-label="Page précédente"
                  >‹</button>
                  {Array.from({ length: totalFilteredPages }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={n === safeFilteredPage ? 'ech-page-active' : ''}
                      onClick={() => setPaymentPage(n)}
                      aria-current={n === safeFilteredPage ? 'page' : undefined}
                    >
                      {n}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="ech-page-arrow"
                    onClick={() => setPaymentPage((p) => Math.min(totalFilteredPages, p + 1))}
                    disabled={safeFilteredPage >= totalFilteredPages}
                    aria-label="Page suivante"
                  >›</button>
                </div>
              </nav>
            )}
          </>
        ) : (
          <>
            <div className="ech-header">
              <h1>Mes échéances</h1>
              <div className="ech-sub">Suivez vos facilités en temps réel, projet par projet.</div>
            </div>

            <div className="ech-kpi-card">
              <div className="ech-kpi-head">
                <div className="ech-kpi-head-ic" aria-hidden>
                  <CalSvg />
                </div>
                <div>
                  <h2>Vue d&apos;ensemble</h2>
                  <div className="ech-s">
                    {plansLoading ? 'Chargement…' : `${globalStats.totalPlans} plan${globalStats.totalPlans !== 1 ? 's' : ''} actif${globalStats.totalPlans !== 1 ? 's' : ''}`}
                  </div>
                </div>
              </div>
              <div className="ech-kpi-rail">
                <div>
                  <div className="ech-kpi-k">Plans actifs</div>
                  <div className="ech-kpi-v">{globalStats.totalPlans}</div>
                </div>
                <div>
                  <div className="ech-kpi-k">En révision</div>
                  <div className={`ech-kpi-v ${globalStats.submitted > 0 ? 'ech-amber' : 'ech-muted'}`}>{globalStats.submitted}</div>
                </div>
                <div>
                  <div className="ech-kpi-k">À corriger</div>
                  <div className={`ech-kpi-v ${globalStats.rejected > 0 ? 'ech-red' : 'ech-muted'}`} style={globalStats.rejected > 0 ? { color: 'var(--zb-red)' } : undefined}>{globalStats.rejected}</div>
                </div>
                <div>
                  <div className="ech-kpi-k">Confirmés</div>
                  <div className={`ech-kpi-v ${globalStats.approved > 0 ? 'ech-green' : 'ech-muted'}`}>
                    {globalStats.approved}
                    {(() => {
                      const total = plans.reduce((s, p) => s + (p.payments?.length || 0), 0)
                      return total > 0 ? <span className="ech-total"> / {total}</span> : null
                    })()}
                  </div>
                </div>
              </div>
            </div>

            <RenderDataGate
              loading={plansLoading}
              error={null}
              data={visiblePlans}
              skeleton="table"
              onRetry={refresh}
              empty={(() => {
                if (installmentSalesMissingPlan.length > 0) {
                  return (
                    <EmptyState
                      title="Plan en cours de génération"
                      description="Votre vente à tempérament est clôturée mais l'échéancier n'a pas encore été généré. Une vérification automatique est en cours — contactez le support si cela persiste plus de quelques minutes."
                      action={{ label: 'Vérifier à nouveau', onClick: () => refresh() }}
                    />
                  )
                }
                if (hasAnyInstallmentSale) {
                  return (
                    <EmptyState
                      title="Finalisation en cours"
                      description="Vos échéances apparaîtront ici après la clôture notaire de votre achat à tempérament."
                    />
                  )
                }
                return (
                  <EmptyState
                    title="Aucun plan d'échéances"
                    description="Vous n'avez pas d'achat à tempérament pour le moment."
                  />
                )
              })()}
            >
              {(list) => (
                <div className="ech-projects">
                  {list.map((plan) => {
                    const metrics = computeInstallmentSaleMetrics(saleForPlan(plan) || {}, plan)
                    const progress = metrics.approvedPct
                    const nextAction = plan.payments.find((p) => p.status === 'rejected' || p.status === 'pending' || p.status === 'submitted')
                    const tone = overviewStatusTone(plan)
                    const nextActionLabel = nextAction
                      ? `F.${nextAction.month} — ${statusMeta(nextAction.status).label}`
                      : 'Toutes les facilités sont confirmées'
                    return (
                      <button
                        key={plan.id}
                        type="button"
                        className="ech-proj"
                        onClick={() => navigate('/installments', { state: { planId: plan.id } })}
                      >
                        <div className="ech-ident">
                          <div className="ech-title">{plan.projectTitle}</div>
                          <div className="ech-loc"><LocSvg />{plan.projectCity || 'Plan'}</div>
                          <span className={`ech-status ${tone.tone}`}>
                            <span className="ech-d" />{tone.label}
                          </span>
                        </div>

                        <div className="ech-figs">
                          <div>
                            <div className="ech-k">Validé</div>
                            <div className="ech-v ech-green">
                              {formatMoneyTnd(metrics.cashValidatedStrict).replace(' DT', '')}
                              <span className="ech-u">DT</span>
                            </div>
                          </div>
                          <div>
                            <div className="ech-k">Reste à valider</div>
                            <div className="ech-v">
                              {formatMoneyTnd(metrics.remainingStrict).replace(' DT', '')}
                              <span className="ech-u">DT</span>
                            </div>
                          </div>
                        </div>

                        <div className="ech-progress-block">
                          <div className="ech-progress-row">
                            <span>Facilités confirmées</span>
                            <span className="ech-n">{metrics.approvedCount}<span className="ech-n-total"> / {metrics.totalMonths}</span></span>
                          </div>
                          <div className="ech-bar">
                            <span style={{ width: `${Math.max(progress, 2)}%` }} />
                          </div>
                          <div className="ech-next">Prochaine action · <b>{nextActionLabel}</b></div>
                        </div>

                        <span className="ech-cta">
                          Ouvrir le détail
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </RenderDataGate>
          </>
        )}

        {payTarget && (
          <div className="ip__overlay ip__overlay--receipt" onClick={closePay}>
            <div className="ip__modal" onClick={(e) => e.stopPropagation()}>
              <div className="ip__modal-header">
                <div>
                  <h3 className="ip__modal-title">Soumettre votre reçu</h3>
                  <p className="ip__modal-sub">Validation rapide de votre mensualité</p>
                </div>
                <button type="button" className="ip__modal-close" onClick={closePay}>✕</button>
              </div>
              <div className="ip__modal-body">
                <div className="ip__modal-info ip__modal-info--receipt">
                  <span className="ip__modal-info-kicker">Mensualité sélectionnée</span>
                  <strong className="ip__modal-info-main">
                    Facilité {payTarget.month} · {payTarget.amount.toLocaleString()} DT
                  </strong>
                  <span className="ip__modal-info-meta">Échéance : {fmtDate(payTarget.dueDate)}</span>
                </div>
                <div className="ip__upload-label">Choisir le justificatif</div>
                <div className="ip__upload-btns">
                  <label className="ip__upload-btn">
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      onChange={async (e) => {
                        try { if (e.target.files?.[0]) await handleReceiptChange(e.target.files[0]) }
                        catch (err) { setError(err.message || 'Erreur') }
                      }}
                    />
                    Fichier (image/PDF)
                  </label>
                  <label className="ip__upload-btn">
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={async (e) => {
                        try { if (e.target.files?.[0]) await handleReceiptChange(e.target.files[0]) }
                        catch (err) { setError(err.message || 'Erreur') }
                      }}
                    />
                    Prendre une photo
                  </label>
                </div>
                {receiptName ? (
                  <div className="ip__upload-status ip__upload-status--ok">
                    <span className="ip__upload-status-title">Fichier prêt</span>
                    <span className="ip__upload-status-name">{receiptName}</span>
                  </div>
                ) : (
                  <div className="ip__upload-status ip__upload-status--empty">Aucun fichier sélectionné</div>
                )}
                {receiptPreview && <div className="ip__upload-preview"><img src={receiptPreview} alt="Aperçu" /></div>}
                {receiptFile && <div className="ip__upload-size">Taille optimisée : {(receiptFile.size / 1024).toFixed(0)} Ko</div>}
                {error && <div className="ip__upload-error">⚠ {error}</div>}
                <div className="ip__upload-label">Note (optionnelle)</div>
                <textarea
                  className="ip__upload-note"
                  placeholder="Ajouter un commentaire pour l'équipe finance…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <div className="ip__modal-footer">
                <button type="button" className="ip__modal-cancel" onClick={closePay}>Annuler</button>
                <button
                  type="button"
                  className="ip__modal-submit"
                  disabled={!receiptName || submitting}
                  onClick={submit}
                >
                  {submitting ? 'Envoi…' : 'Envoyer le reçu'}
                </button>
              </div>
            </div>
          </div>
        )}
        </div>
    </DashboardShell>
  )
}
