import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { loadInstallments, saveInstallments } from '../installmentsStore.js'

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

function isPayable(status) {
  return status === 'pending' || status === 'rejected'
}

export default function InstallmentsPage() {
  const navigate = useNavigate()
  const { state } = useLocation()
  const [plans, setPlans] = useState(loadInstallments)
  const [payTarget, setPayTarget] = useState(null) // { planId, month, amount, dueDate }
  const [receiptName, setReceiptName] = useState('')
  const [receiptPreview, setReceiptPreview] = useState('')
  const [note, setNote] = useState('')

  const handleReceiptChange = (file) => {
    if (!file) return
    if (receiptPreview && receiptPreview.startsWith('blob:')) URL.revokeObjectURL(receiptPreview)
    setReceiptName(file.name)
    if (file.type?.startsWith('image/')) {
      setReceiptPreview(URL.createObjectURL(file))
    } else {
      setReceiptPreview('')
    }
  }

  const openPayPopup = (plan, payment) => {
    setPayTarget({ planId: plan.id, month: payment.month, amount: payment.amount, dueDate: payment.dueDate })
    setReceiptName('')
    if (receiptPreview && receiptPreview.startsWith('blob:')) URL.revokeObjectURL(receiptPreview)
    setReceiptPreview('')
    setNote('')
  }

  const closePayPopup = () => {
    setPayTarget(null)
    setReceiptName('')
    if (receiptPreview && receiptPreview.startsWith('blob:')) URL.revokeObjectURL(receiptPreview)
    setReceiptPreview('')
    setNote('')
  }

  const submitSinglePayment = () => {
    if (!payTarget || !receiptName) return
    const next = plans.map((plan) =>
      plan.id !== payTarget.planId
        ? plan
        : {
            ...plan,
            status: 'active',
            payments: plan.payments.map((p) =>
              p.month === payTarget.month
                ? {
                    ...p,
                    status: 'submitted',
                    receiptName,
                    rejectedNote: undefined,
                    note: note || undefined,
                  }
                : p,
            ),
          },
    )
    setPlans(next)
    saveInstallments(next)
    closePayPopup()
  }

  const focusedPlanId = state?.planId || ''
  const visiblePlans = focusedPlanId ? plans.filter((p) => p.id === focusedPlanId) : plans
  const focusedPlan = focusedPlanId ? visiblePlans[0] : null

  return (
    <main className="screen screen--app">
      <section className="dashboard-page installments-page" style={{ paddingBottom: '6rem' }}>
        <TopBar />
        <div className="detail-nav">
          <button type="button" className="back-btn" onClick={() => navigate('/dashboard')}>
            Retour dashboard
          </button>
        </div>

        <div className="installments-head">
          <h2>Mes échéances de paiement</h2>
          <p>
            {focusedPlanId
              ? 'Plan sélectionné: toutes les échéances du début à la fin.'
              : 'Sélectionnez plusieurs mensualités puis envoyez un seul reçu.'}
          </p>
        </div>
        {focusedPlan ? (
          <div className="installments-table-wrap">
            <div className="installments-plan-top" style={{ marginBottom: '0.75rem' }}>
              <strong>{focusedPlan.projectTitle}</strong>
              <span>{focusedPlan.city} · #{focusedPlan.id}</span>
            </div>
            <table className="installments-table">
              <thead>
                <tr>
                  <th>Facilité</th>
                  <th>Échéance</th>
                  <th>Montant</th>
                  <th>Statut</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {focusedPlan.payments.map((p) => (
                  <tr key={`${focusedPlan.id}:${p.month}`}>
                    <td>F.{p.month}</td>
                    <td>{fmtDate(p.dueDate)}</td>
                    <td>{p.amount.toLocaleString()} DT</td>
                    <td>
                      <span className={`inst-item-status inst-item-status--${p.status}`}>
                        {p.status === 'approved' ? 'Confirmé' : p.status === 'submitted' ? 'En révision' : p.status === 'rejected' ? 'Rejeté' : 'En attente'}
                      </span>
                      {p.status === 'rejected' && p.rejectedNote ? (
                        <div className="dpr-reject" style={{ marginTop: '0.25rem' }}>⚠ {p.rejectedNote}</div>
                      ) : null}
                    </td>
                    <td>
                      {isPayable(p.status) ? (
                        <button type="button" className="dpr-btn" onClick={() => openPayPopup(focusedPlan, p)}>
                          Payer
                        </button>
                      ) : (
                        <span className="ap-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="installments-list">
            {visiblePlans.map((plan) => {
              const approvedCount = plan.payments.filter((p) => p.status === 'approved').length
              const progress = (approvedCount / plan.totalMonths) * 100
              return (
                <button
                  key={plan.id}
                  type="button"
                  className="dash-plan-card"
                  onClick={() => navigate('/installments', { state: { planId: plan.id } })}
                >
                  <div className="dash-plan-card__head">
                    <strong>{plan.projectTitle}</strong>
                    <span>{plan.city} · #{plan.id}</span>
                  </div>
                  <div className="dash-plan-card__progress">
                    <div className="dpr-track">
                      <div className="dpr-fill" style={{ width: `${Math.max(progress, 2)}%` }} />
                    </div>
                    <em>{approvedCount}/{plan.totalMonths}</em>
                  </div>
                  <div className="dash-plan-card__cta-strip">
                    <span>Voir toutes les échéances (début → fin)</span>
                    <span className="dash-plan-card__cta-arrow" aria-hidden="true">→</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {payTarget && (
        <div className="modal-overlay" onClick={closePayPopup}>
          <div className="modal-card modal-card--receipt" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">Soumettre votre reçu</h3>
                <p className="modal-title-sub">Validation rapide de votre mensualite</p>
              </div>
              <button type="button" className="modal-close" onClick={closePayPopup}>✕</button>
            </div>
            <p className="upload-subtitle">
              Facilité {payTarget.month} · {payTarget.amount.toLocaleString()} DT · dû le {fmtDate(payTarget.dueDate)}
            </p>
            <div className="upload-actions">
              <label className="upload-action-btn">
                <input
                  type="file"
                  accept="image/*,.pdf"
                  style={{ display: 'none' }}
                  onChange={(e) => { if (e.target.files?.[0]) handleReceiptChange(e.target.files[0]) }}
                />
                Choisir un reçu
              </label>
              <label className="upload-action-btn upload-action-btn--photo">
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={(e) => { if (e.target.files?.[0]) handleReceiptChange(e.target.files[0]) }}
                />
                Prendre une photo
              </label>
            </div>
            <label className={`upload-zone${receiptName ? ' upload-zone--filled' : ''}`}>
              {receiptName ? `Fichier: ${receiptName}` : 'Choisir un reçu pour cette facilité'}
            </label>
            {receiptPreview ? (
              <div className="upload-preview-wrap">
                <img src={receiptPreview} alt="Aperçu du reçu" className="upload-preview-img" />
              </div>
            ) : null}
            <textarea
              className="upload-note"
              placeholder="Note optionnelle…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={closePayPopup}>Annuler</button>
              <button type="button" className={`cta-primary${!receiptName ? ' cta-disabled' : ''}`} disabled={!receiptName} onClick={submitSinglePayment}>
                Envoyer le reçu
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

