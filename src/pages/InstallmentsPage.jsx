import { useCallback, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import { useInstallmentsScoped, useSalesScoped } from '../lib/useSupabase.js'
import { addInstallmentReceiptRecord, updatePaymentStatus, uploadInstallmentReceipt } from '../lib/db.js'
import { computeInstallmentSaleMetrics, formatMoneyTnd } from '../domain/installmentMetrics.js'
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
  const { clientProfile } = useAuth()
  const { plans, loading: plansLoading, refresh } = useInstallmentsScoped({ clientId: clientProfile?.id ?? null })
  const { sales: mySales } = useSalesScoped({ clientId: clientProfile?.id ?? null })

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
    setSubmitting(true)
    setError('')
    try {
      const plan = plans.find((p) => p.id === payTarget.planId)
      const payment = plan?.payments?.find((p) => p.month === payTarget.month)
      if (!payment?.id) throw new Error('Paiement introuvable')
      const url = await uploadInstallmentReceipt({ paymentId: payment.id, file: receiptFile })
      await addInstallmentReceiptRecord({ paymentId: payment.id, receiptUrl: url || '', fileName: receiptName, note: note || '' })
      await updatePaymentStatus(payment.id, 'submitted', { receiptUrl: url || receiptName })
      await refresh()
      closePay()
    } catch (err) {
      setError(err.message || 'Échec envoi')
    } finally {
      setSubmitting(false)
    }
  }, [payTarget, receiptName, receiptFile, submitting, plans, note, refresh, closePay])

  return (
    <main className="screen screen--app">
      <TopBar />
      <div className="ip">
        <button type="button" className="ip__back" onClick={() => (focusedPlan ? navigate('/installments') : navigate('/browse'))}>
          ← {focusedPlan ? 'Tous les plans' : 'Retour accueil'}
        </button>
        <div className="ip__hero">
          <h1 className="ip__hero-title">Mes échéances</h1>
          <p className="ip__hero-sub">Suivez vos facilités en temps réel</p>
          {plansLoading ? (
            <div className="ip__empty" style={{ marginTop: 12 }}>
              <div className="app-loader-spinner" style={{ margin: '0 auto 8px' }} />
              Chargement des plans…
            </div>
          ) : null}
          <div className="ip__hero-kpi">
            <div className="ip__kpi"><span className="ip__kpi-value">{globalStats.totalPlans}</span><span className="ip__kpi-label">Plans</span></div>
            <div className="ip__kpi"><span className="ip__kpi-value">{globalStats.submitted}</span><span className="ip__kpi-label">En révision</span></div>
            <div className="ip__kpi"><span className="ip__kpi-value">{globalStats.rejected}</span><span className="ip__kpi-label">À corriger</span></div>
            <div className="ip__kpi"><span className="ip__kpi-value">{globalStats.approved}</span><span className="ip__kpi-label">Confirmés</span></div>
          </div>
        </div>

        {focusedPlan ? (
          <>
            <div className="ip__detail-head">
              <div className="ip__detail-title">{focusedPlan.projectTitle}</div>
              <div className="ip__detail-ref">{focusedPlan.projectCity} · #{focusedPlan.id}</div>
            </div>
            {focusedMetrics && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
                <div style={{ padding: '10px 12px', borderRadius: 12, background: '#ecfdf5', border: '1px solid #a7f3d0' }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: '#065f46', textTransform: 'uppercase', letterSpacing: '.03em' }}>Validé</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#065f46' }}>{formatMoneyTnd(focusedMetrics.cashValidatedStrict)}</div>
                  <div style={{ fontSize: 10, color: '#047857' }}>Araboun + mensualités confirmées</div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: 12, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: '#1e40af', textTransform: 'uppercase', letterSpacing: '.03em' }}>En révision</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#1e40af' }}>{formatMoneyTnd(focusedMetrics.submittedAmount)}</div>
                  <div style={{ fontSize: 10, color: '#1d4ed8' }}>Reçus envoyés, en attente</div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: 12, background: '#fef2f2', border: '1px solid #fecaca' }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: '#991b1b', textTransform: 'uppercase', letterSpacing: '.03em' }}>À corriger</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#991b1b' }}>{formatMoneyTnd(focusedMetrics.rejectedAmount)}</div>
                  <div style={{ fontSize: 10, color: '#b91c1c' }}>Reçus refusés à renvoyer</div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: 12, background: '#fff', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '.03em' }}>Reste à valider</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>{formatMoneyTnd(focusedMetrics.remainingStrict)}</div>
                  <div style={{ fontSize: 10, color: '#64748b' }}>Sur un total de {formatMoneyTnd(focusedMetrics.saleAgreed)}</div>
                </div>
              </div>
            )}
            <div className="ip__detail-hint">
              <strong>Mode d&apos;emploi :</strong> En attente / Rejeté = envoyez ou corrigez un reçu. En révision = attente validation. Confirmé = rien à faire.
            </div>
            <div className="ip__payments">
              {focusedPlan.payments.map((p) => {
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
          </>
        ) : (
          <>
            {visiblePlans.length === 0 ? (
              installmentSalesMissingPlan.length > 0 ? (
                <div className="ip__empty">
                  <strong>Plan en cours de génération</strong>
                  Votre vente à tempérament est clôturée mais l&apos;échéancier n&apos;a pas encore été généré. Une vérification automatique est en cours — contactez le support si cela persiste plus de quelques minutes.
                  <button
                    type="button"
                    className="ip__pay-btn"
                    style={{ marginTop: 12 }}
                    onClick={() => refresh()}
                  >
                    🔄 Vérifier à nouveau
                  </button>
                </div>
              ) : hasAnyInstallmentSale ? (
                <div className="ip__empty">
                  <strong>Finalisation en cours</strong>
                  Vos échéances apparaîtront ici après la clôture notaire de votre achat à tempérament.
                </div>
              ) : (
                <div className="ip__empty">
                  <strong>Aucun plan d&apos;échéances</strong>
                  Vous n&apos;avez pas d&apos;achat à tempérament pour le moment.
                </div>
              )
            ) : (
              <div className="ip__plan-list">
                {visiblePlans.map((plan) => {
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
                      <div className="ip__plan-head">
                        <span className="ip__plan-title">{plan.projectTitle}</span>
                        <span className="ip__plan-ref">{plan.projectCity}</span>
                      </div>
                      <div className="ip__plan-pills">
                        {metrics.submittedCount > 0 && <span className="ip__pill ip__pill--submitted">{metrics.submittedCount} en révision</span>}
                        {metrics.rejectedCount > 0 && <span className="ip__pill ip__pill--rejected">{metrics.rejectedCount} à corriger</span>}
                        {metrics.submittedCount === 0 && metrics.rejectedCount === 0 && <span className="ip__pill ip__pill--ok">Rythme normal</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 10, color: '#475569', marginTop: 4 }}>
                        <span>Validé : <strong style={{ color: '#065f46' }}>{formatMoneyTnd(metrics.cashValidatedStrict)}</strong></span>
                        <span>·</span>
                        <span>Reste : <strong style={{ color: '#0f172a' }}>{formatMoneyTnd(metrics.remainingStrict)}</strong></span>
                      </div>
                      <div className="ip__progress">
                        <div className="ip__progress-track"><div className="ip__progress-fill" style={{ width: `${Math.max(progress, 2)}%` }} /></div>
                        <span className="ip__progress-label">{metrics.approvedCount}/{metrics.totalMonths}</span>
                      </div>
                      <div className="ip__plan-next">
                        {nextAction ? `Prochaine action : F.${nextAction.month} — ${statusMeta(nextAction.status).label}` : 'Toutes les facilités sont confirmées.'}
                      </div>
                      <div className="ip__plan-cta"><span>Ouvrir le détail</span><span aria-hidden>→</span></div>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}

        {payTarget && (
          <div className="ip__overlay" onClick={closePay}>
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
