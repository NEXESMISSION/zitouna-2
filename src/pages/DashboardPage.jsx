import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { myPurchases } from '../portfolio.js'
import { projects } from '../projects.js'
import { myInstallments } from '../installments.js'

const REVENUE_PER_TREE = 90

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
}

const STATUS_LABEL = {
  approved:  '✓ Confirmé',
  submitted: '⏳ En révision',
  rejected:  '✗ Rejeté',
  pending:   '— En attente',
}

export default function DashboardPage() {
  const navigate = useNavigate()

  // ── Owned plots stats ──
  const totalTrees    = myPurchases.reduce((s, p) => s + p.trees, 0)
  const totalInvested = myPurchases.reduce((s, p) => s + p.invested, 0)
  const totalRevenue  = myPurchases.reduce((s, p) => s + p.annualRevenue, 0)
  const roi           = totalInvested > 0 ? ((totalRevenue / totalInvested) * 100).toFixed(1) : '0.0'

  // ── Installment plans (local state so receipt uploads update the UI) ──
  const [plans, setPlans] = useState(myInstallments)

  // ── Upload modal state ──
  const [uploadTarget, setUploadTarget] = useState(null) // { planId, month, amount, dueDate }
  const [uploadFile,   setUploadFile]   = useState(null)
  const [uploadNote,   setUploadNote]   = useState('')

  const openUpload = (plan, payment) => {
    setUploadTarget({ planId: plan.id, month: payment.month, amount: payment.amount, dueDate: payment.dueDate })
    setUploadFile(null)
    setUploadNote('')
  }

  const closeUpload = () => setUploadTarget(null)

  const submitReceipt = () => {
    if (!uploadFile) return
    setPlans((prev) =>
      prev.map((plan) =>
        plan.id !== uploadTarget.planId
          ? plan
          : {
              ...plan,
              status: 'active',
              payments: plan.payments.map((p) =>
                p.month === uploadTarget.month
                  ? { ...p, status: 'submitted', receiptName: uploadFile, rejectedNote: undefined }
                  : p,
              ),
            },
      ),
    )
    closeUpload()
  }

  return (
    <main className="screen screen--app">
      <section className="dashboard-page">
        <TopBar />

        {/* ── Greeting ── */}
        <div className="dash-greeting">
          <div>
            <h2 className="page-title">Bonjour, <strong>Lassaad</strong></h2>
            <p className="page-subtitle">Voici l&apos;état de votre portefeuille d&apos;oliviers</p>
          </div>
          <button type="button" className="cta-primary cta-primary--gold" onClick={() => navigate('/browse')}>
            + Ajouter des oliviers
          </button>
        </div>

        {/* ── KPI strip ── */}
        <div className="dash-kpi-strip">
          <div className="dash-kpi">
            <span className="dash-kpi-val dash-kpi-val--green">{totalTrees.toLocaleString()}</span>
            <span className="dash-kpi-lbl">Oliviers</span>
          </div>
          <div className="dash-kpi-sep" />
          <div className="dash-kpi">
            <span className="dash-kpi-val">{totalInvested.toLocaleString()}</span>
            <span className="dash-kpi-lbl">TND investis</span>
          </div>
          <div className="dash-kpi-sep" />
          <div className="dash-kpi">
            <span className="dash-kpi-val dash-kpi-val--green">{totalRevenue.toLocaleString()}</span>
            <span className="dash-kpi-lbl">TND / an</span>
          </div>
          <div className="dash-kpi-sep" />
          <div className="dash-kpi">
            <span className="dash-kpi-val">{roi}%</span>
            <span className="dash-kpi-lbl">ROI</span>
          </div>
        </div>

        {/* ── Mes facilités ── */}
        {plans.length > 0 && (
          <>
            <h3 className="dash-section-title">Mes facilités en cours</h3>
            <div className="dash-plans-wrap">
              {/* header */}
              <div className="dash-plans-head">
                <span>Projet</span>
                <span>Progression</span>
                <span>Mensualité</span>
                <span>Restant</span>
                <span>Prochain paiement</span>
                <span></span>
              </div>

              {plans.map((plan) => {
                const approvedCount  = plan.payments.filter((p) => p.status === 'approved').length
                const progress       = (approvedCount / plan.totalMonths) * 100
                const totalLeft      = plan.totalPrice - plan.downPayment - approvedCount * plan.monthlyAmount
                const nextPayment    = plan.payments.find((p) => p.status === 'pending' || p.status === 'rejected')
                const submittedPay   = plan.payments.find((p) => p.status === 'submitted')

                return (
                  <div key={plan.id} className={`dash-plan-row dash-plan-row--${plan.status}`}>
                    {/* project */}
                    <div className="dpr-cell dpr-project">
                      <strong>{plan.projectTitle}</strong>
                      <small>{plan.city} · #{plan.id}</small>
                    </div>

                    {/* progress */}
                    <div className="dpr-cell dpr-progress">
                      <div className="dpr-track">
                        <div className="dpr-fill" style={{ width: `${Math.max(progress, 2)}%` }} />
                      </div>
                      <span className="dpr-pct">{approvedCount}/{plan.totalMonths}</span>
                    </div>

                    {/* monthly */}
                    <div className="dpr-cell">
                      <span>{plan.monthlyAmount.toLocaleString()} DT</span>
                    </div>

                    {/* remaining */}
                    <div className="dpr-cell dpr-green">
                      <span>{totalLeft.toLocaleString()} DT</span>
                    </div>

                    {/* next payment info */}
                    <div className="dpr-cell dpr-next">
                      {submittedPay ? (
                        <span className="dpr-tag dpr-tag--review">⏳ En révision</span>
                      ) : nextPayment ? (
                        <span className="dpr-tag">
                          F.{nextPayment.month} · {fmtDate(nextPayment.dueDate)}
                          {nextPayment.status === 'rejected' && nextPayment.rejectedNote && (
                            <span className="dpr-reject"> ⚠ {nextPayment.rejectedNote}</span>
                          )}
                        </span>
                      ) : (
                        <span className="dpr-tag dpr-tag--done">✓ À jour</span>
                      )}
                    </div>

                    {/* action */}
                    <div className="dpr-cell dpr-action">
                      {submittedPay ? null : nextPayment ? (
                        <button type="button" className="dpr-btn"
                          onClick={() => openUpload(plan, nextPayment)}>
                          {nextPayment.status === 'rejected' ? '↩ Resoumettre' : '↑ Payer'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ── Mes parcelles ── */}
        <h3 className="dash-section-title" style={{ marginTop: '2rem' }}>Mes parcelles</h3>

        {myPurchases.length === 0 ? (
          <div className="empty-state">
            <p>Vous ne possédez pas encore de parcelles.</p>
            <button className="cta-primary" onClick={() => navigate('/browse')}>Explorer les projets</button>
          </div>
        ) : (
          <div className="dash-parcels">
            {myPurchases.map((purchase) => {
              const proj        = projects.find((p) => p.id === purchase.projectId)
              const plot        = proj?.plots.find((pl) => pl.id === purchase.plotId)
              const yearsHeld   = new Date().getFullYear() - parseInt(purchase.since.split('-')[0])
              const totalEarned = yearsHeld * purchase.annualRevenue
              return (
                <div key={`${purchase.projectId}-${purchase.plotId}`}
                  className="dash-parcel-card"
                  onClick={() => navigate(`/project/${purchase.projectId}/plot/${purchase.plotId}`)}>

                  {/* map thumbnail */}
                  {plot?.mapUrl && (
                    <div className="dash-parcel-map">
                      <iframe title={`Parcelle ${purchase.plotId}`} src={plot.mapUrl} loading="lazy" tabIndex={-1} />
                    </div>
                  )}

                  {/* info */}
                  <div className="dash-parcel-body">
                    {/* title row */}
                    <div className="dash-parcel-header">
                      <div>
                        <span className="dash-parcel-id">Parcelle #{purchase.plotId}</span>
                        <p className="dash-parcel-name">{proj?.title}</p>
                      </div>
                      <span className="dash-parcel-loc">
                        📍 {purchase.city}
                      </span>
                    </div>

                    {/* stats row */}
                    <div className="dash-parcel-stats">
                      <div className="dash-ps"><span>Arbres</span><strong>{purchase.trees}</strong></div>
                      <div className="dash-ps"><span>Investi</span><strong>{purchase.invested.toLocaleString()} DT</strong></div>
                      <div className="dash-ps"><span>Revenu/an</span><strong className="green-text">{purchase.annualRevenue.toLocaleString()} DT</strong></div>
                      <div className="dash-ps"><span>Gains cumulés</span><strong className="green-text">~{totalEarned.toLocaleString()} DT</strong></div>
                    </div>
                  </div>

                  {/* cta */}
                  <div className="dash-parcel-cta">→</div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Receipt upload modal ── */}
      {uploadTarget && (
        <div className="modal-overlay" onClick={closeUpload}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Soumettre votre reçu</h3>
              <button type="button" className="modal-close" onClick={closeUpload}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <p className="upload-subtitle">
              Facilité {uploadTarget.month} · {uploadTarget.amount.toLocaleString()} DT · dû le {fmtDate(uploadTarget.dueDate)}
            </p>

            <label className={`upload-zone${uploadFile ? ' upload-zone--filled' : ''}`}>
              <input
                type="file" accept="image/*,.pdf"
                style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files[0]) setUploadFile(e.target.files[0].name) }}
              />
              {uploadFile ? (
                <>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#a8cc50' }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="upload-filename">{uploadFile}</span>
                  <span className="upload-change">Changer le fichier</span>
                </>
              ) : (
                <>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'rgba(255,255,255,0.3)' }}>
                    <polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" />
                    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
                  </svg>
                  <span>Cliquez pour sélectionner votre reçu</span>
                  <small>JPG, PNG ou PDF acceptés</small>
                </>
              )}
            </label>

            <textarea
              className="upload-note"
              placeholder="Note pour l'équipe (optionnel)…"
              value={uploadNote}
              onChange={(e) => setUploadNote(e.target.value)}
            />

            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={closeUpload}>Annuler</button>
              <button
                type="button"
                className={`cta-primary${!uploadFile ? ' cta-disabled' : ''}`}
                onClick={submitReceipt}
                disabled={!uploadFile}
              >
                Envoyer le reçu
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
