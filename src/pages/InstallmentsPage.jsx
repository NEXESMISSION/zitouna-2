import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import { useInstallmentsScoped, useSalesScoped } from '../lib/useSupabase.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { runSafeAction } from '../lib/runSafeAction.js'
import { addInstallmentReceiptRecord, updatePaymentStatus, uploadInstallmentReceipt } from '../lib/db.js'
import { computeInstallmentSaleMetrics, formatMoneyTnd, getPaymentPageForNextDue } from '../domain/installmentMetrics.js'
import './installments-page.css'

const MAX_IMAGE_DIMENSION = 1600
const IMAGE_QUALITY = 0.76
const MAX_IMAGE_BYTES = 450 * 1024
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
      finalFile = await optimizeImageFile(file)
      if (finalFile.size > MAX_IMAGE_BYTES) throw new Error('Image trop lourde')
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

  return (
    <main className="screen screen--app">
      <TopBar />
      <div className="ip">
        <button type="button" className="ip__back" onClick={() => (focusedPlan ? navigate('/installments') : navigate('/browse'))}>
          <span className="ip__back-icon" aria-hidden>←</span>
          <span className="ip__back-label">{focusedPlan ? 'Tous les plans' : 'Retour accueil'}</span>
        </button>
        <div className="ip__hero ip__hero--standalone">
          <div className="ip__hero-intro">
            <span className="ip__hero-icon" aria-hidden>📅</span>
            <div>
              <h1 className="ip__hero-title">Mes échéances</h1>
              <p className="ip__hero-sub">Suivez vos facilités en temps réel</p>
            </div>
          </div>
          <div className="ip__hero-kpi ip__hero-kpi--strip" role="list">
            <div className="ip__kpi" role="listitem"><span className="ip__kpi-value">{globalStats.totalPlans}</span><span className="ip__kpi-label">Plans</span></div>
            <div className="ip__kpi" role="listitem"><span className="ip__kpi-value">{globalStats.submitted}</span><span className="ip__kpi-label">En révision</span></div>
            <div className="ip__kpi" role="listitem"><span className="ip__kpi-value">{globalStats.rejected}</span><span className="ip__kpi-label">À corriger</span></div>
            <div className="ip__kpi" role="listitem"><span className="ip__kpi-value">{globalStats.approved}</span><span className="ip__kpi-label">Confirmés</span></div>
          </div>
        </div>

        {focusedPlan ? (
          <>
            <div className="ip__detail-head">
              <div className="ip__detail-title">{focusedPlan.projectTitle}</div>
              <div className="ip__detail-ref">{focusedPlan.projectCity} · #{focusedPlan.id}</div>
            </div>
            {focusedMetrics && (
              <div className="ip__metric-grid">
                <div className="ip__metric ip__metric--validated">
                  <span className="ip__metric-kicker">Validé</span>
                  <span className="ip__metric-value">{formatMoneyTnd(focusedMetrics.cashValidatedStrict)}</span>
                  <span className="ip__metric-hint">1er versement + mensualités confirmées</span>
                </div>
                <div className="ip__metric ip__metric--review">
                  <span className="ip__metric-kicker">En révision</span>
                  <span className="ip__metric-value">{formatMoneyTnd(focusedMetrics.submittedAmount)}</span>
                  <span className="ip__metric-hint">Reçus envoyés, en attente</span>
                </div>
                <div className="ip__metric ip__metric--rejected">
                  <span className="ip__metric-kicker">À corriger</span>
                  <span className="ip__metric-value">{formatMoneyTnd(focusedMetrics.rejectedAmount)}</span>
                  <span className="ip__metric-hint">Reçus refusés à renvoyer</span>
                </div>
                <div className="ip__metric ip__metric--remaining">
                  <span className="ip__metric-kicker">Reste à valider</span>
                  <span className="ip__metric-value">{formatMoneyTnd(focusedMetrics.remainingStrict)}</span>
                  <span className="ip__metric-hint">Sur un total de {formatMoneyTnd(focusedMetrics.saleAgreed)}</span>
                </div>
              </div>
            )}
            <div className="ip__detail-hint">
              <strong>Mode d&apos;emploi :</strong> En attente / Rejeté = envoyez ou corrigez un reçu. En révision = attente validation. Confirmé = rien à faire.
            </div>
            <div className="ip__payments">
              {visiblePayments.map((p) => {
                const meta = statusMeta(p.status)
                const receipt = lastReceipt(p)
                const receiptIsImage = receipt && isImageUrl(receipt.url)
                return (
                  <div key={`${focusedPlan.id}:${p.month}`} className="ip__pay-card">
                    <div className="ip__pay-top">
                      <span className="ip__pay-month">Facilité {p.month}</span>
                      <span className="ip__pay-due">{fmtDate(p.dueDate)}</span>
                    </div>
                    <div className="ip__pay-mid">
                      <span className="ip__pay-amount">{p.amount.toLocaleString()} <small>DT</small></span>
                      <span className={`ip__status ip__status--${meta.tone}`}>{meta.label}</span>
                    </div>
                    <div className="ip__pay-hint">{meta.hint}</div>
                    {p.status === 'rejected' && p.rejectedNote && <div className="ip__pay-reject">⚠ {p.rejectedNote}</div>}
                    {receipt && (
                      <div className="ip__receipt">
                        {receiptIsImage
                          ? <img src={receipt.url} alt="Reçu" className="ip__receipt-thumb" />
                          : <div className="ip__receipt-file-icon">📄</div>}
                        <div className="ip__receipt-info">
                          <div className="ip__receipt-name">{receipt.name}</div>
                          {receipt.date && <div className="ip__receipt-date">{fmtDate(receipt.date)}</div>}
                        </div>
                        <a href={receipt.url} target="_blank" rel="noreferrer" className="ip__receipt-link">Voir</a>
                      </div>
                    )}
                    {isPayable(p.status) && (
                      <button
                        type="button"
                        className={`ip__pay-btn${p.status === 'submitted' ? ' ip__pay-btn--correct' : ''}`}
                        onClick={() => openPay(focusedPlan, p)}
                      >
                        {p.status === 'submitted' ? '📝 Corriger le reçu' : '📤 Envoyer un reçu'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            {totalPaymentPages > 1 && (
              <nav className="ip__pager" aria-label="Pagination des facilités">
                <button
                  type="button"
                  className="ip__pager-btn ip__pager-btn--nav"
                  onClick={() => setPaymentPage((p) => Math.max(1, p - 1))}
                  disabled={safePaymentPage <= 1}
                  aria-label="Page précédente"
                >
                  ‹
                </button>
                {Array.from({ length: totalPaymentPages }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`ip__pager-btn${n === safePaymentPage ? ' ip__pager-btn--active' : ''}`}
                    onClick={() => setPaymentPage(n)}
                    aria-current={n === safePaymentPage ? 'page' : undefined}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  className="ip__pager-btn ip__pager-btn--nav"
                  onClick={() => setPaymentPage((p) => Math.min(totalPaymentPages, p + 1))}
                  disabled={safePaymentPage >= totalPaymentPages}
                  aria-label="Page suivante"
                >
                  ›
                </button>
                <span className="ip__pager-hint">
                  Facilités {(safePaymentPage - 1) * PAYMENTS_PER_PAGE + 1}–
                  {Math.min(safePaymentPage * PAYMENTS_PER_PAGE, paymentCount)} / {paymentCount}
                </span>
              </nav>
            )}
          </>
        ) : (
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
                    action={{ label: '🔄 Vérifier à nouveau', onClick: () => refresh() }}
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
              <div className="ip__plan-list">
                {list.map((plan) => {
                  const metrics = computeInstallmentSaleMetrics(saleForPlan(plan) || {}, plan)
                  const progress = metrics.approvedPct
                  const nextAction = plan.payments.find((p) => p.status === 'rejected' || p.status === 'pending' || p.status === 'submitted')
                  return (
                    <button
                      key={plan.id}
                      type="button"
                      className="ip__plan-card"
                      onClick={() => navigate('/installments', { state: { planId: plan.id } })}
                    >
                      <div className="ip__plan-card__header">
                        <div className="ip__plan-card__titles">
                          <span className="ip__plan-title">{plan.projectTitle}</span>
                          <span className="ip__plan-ref">{plan.projectCity}</span>
                        </div>
                        <div className="ip__plan-pills">
                          {metrics.submittedCount > 0 && <span className="ip__pill ip__pill--submitted">{metrics.submittedCount} en révision</span>}
                          {metrics.rejectedCount > 0 && <span className="ip__pill ip__pill--rejected">{metrics.rejectedCount} à corriger</span>}
                          {metrics.submittedCount === 0 && metrics.rejectedCount === 0 && <span className="ip__pill ip__pill--ok">Rythme normal</span>}
                        </div>
                      </div>
                      <div className="ip__plan-money" aria-label="Montants validés et restants">
                        <div className="ip__plan-money__item ip__plan-money__item--ok">
                          <span className="ip__plan-money__label">Validé</span>
                          <span className="ip__plan-money__value">{formatMoneyTnd(metrics.cashValidatedStrict)}</span>
                        </div>
                        <div className="ip__plan-money__item">
                          <span className="ip__plan-money__label">Reste</span>
                          <span className="ip__plan-money__value">{formatMoneyTnd(metrics.remainingStrict)}</span>
                        </div>
                      </div>
                      <div className="ip__plan-progress-block">
                        <div className="ip__plan-progress-head">
                          <span className="ip__plan-progress-title">Facilités confirmées</span>
                          <span className="ip__progress-label">{metrics.approvedCount}/{metrics.totalMonths}</span>
                        </div>
                        <div className="ip__progress">
                          <div className="ip__progress-track">
                            <div className="ip__progress-fill" style={{ width: `${Math.max(progress, 2)}%` }} />
                          </div>
                        </div>
                      </div>
                      <div className="ip__plan-next">
                        {nextAction ? (
                          <>
                            <span className="ip__plan-next__kicker">Prochaine action</span>
                            <span className="ip__plan-next__text">F.{nextAction.month} — {statusMeta(nextAction.status).label}</span>
                          </>
                        ) : (
                          <span className="ip__plan-next__text ip__plan-next__text--done">Toutes les facilités sont confirmées.</span>
                        )}
                      </div>
                      <div className="ip__plan-cta">
                        <span>Ouvrir le détail</span>
                        <span className="ip__plan-cta__arrow" aria-hidden>→</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </RenderDataGate>
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
    </main>
  )
}
