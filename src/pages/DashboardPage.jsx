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

        {/* Greeting */}
        <div className="dash-greeting">
          <div>
            <h2 className="page-title">Bonjour, <strong>Lassaad</strong></h2>
            <p className="page-subtitle">Voici l&apos;état de votre portefeuille d&apos;oliviers</p>
          </div>
          <button type="button" className="cta-primary" onClick={() => navigate('/browse')}>
            + Ajouter des oliviers
          </button>
        </div>

        {/* Stats */}
        <div className="stats-grid">
          <div className="stat-card stat-card--green">
            <span className="stat-label">Arbres possédés</span>
            <p className="stat-value">{totalTrees.toLocaleString()}</p>
            <span className="stat-sub">oliviers actifs</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Total investi</span>
            <p className="stat-value">{totalInvested.toLocaleString()}</p>
            <span className="stat-sub">TND</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Revenu annuel estimé</span>
            <p className="stat-value">{totalRevenue.toLocaleString()}</p>
            <span className="stat-sub">TND / an</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Rendement estimé</span>
            <p className="stat-value">{roi}%</p>
            <span className="stat-sub">ROI annuel</span>
          </div>
        </div>

        {/* ══════════════════════════════
            MES VERSEMENTS EN COURS
        ══════════════════════════════ */}
        {plans.length > 0 && (
          <>
            <h3 className="section-heading" style={{ marginTop: '2rem' }}>Mes facilités en cours</h3>
            <div className="ic-grid">
              {plans.map((plan) => {
                const approvedCount = plan.payments.filter((p) => p.status === 'approved').length
                const progress      = (approvedCount / plan.totalMonths) * 100
                const totalLeft     = plan.totalPrice - plan.downPayment - approvedCount * plan.monthlyAmount
                const needsAction   = plan.payments.filter((p) => p.status === 'pending' || p.status === 'rejected' || p.status === 'submitted')

                return (
                  <div key={plan.id} className={`ic-card ic-card--${plan.status}`}>

                    {/* Header: title + badge */}
                    <div className="ic-header">
                      <div className="ic-title-block">
                        <span className="ic-ref">{plan.id} · {plan.city}</span>
                        <span className="ic-title">{plan.projectTitle}</span>
                      </div>
                      <span className={`inst-badge inst-badge--${plan.status}`}>
                        {plan.status === 'active' ? 'Actif' : plan.status === 'late' ? 'En retard' : 'Terminé'}
                      </span>
                    </div>

                    {/* Progress bar */}
                    <div className="ic-progress-row">
                      <div className="ic-track">
                        <div className="ic-bar" style={{ width: `${Math.max(progress, 2)}%` }} />
                      </div>
                      <span className="ic-progress-label">{approvedCount}/{plan.totalMonths} mois</span>
                    </div>

                    {/* Key numbers inline */}
                    <div className="ic-meta">
                      <span>{plan.monthlyAmount.toLocaleString()} DT/mois</span>
                      <span className="ic-sep">·</span>
                      <span className="green-text">{totalLeft.toLocaleString()} DT restant</span>
                    </div>

                    {/* Actionable payments only */}
                    {needsAction.length > 0 && (
                      <div className="ic-actions">
                        {needsAction.map((payment) => (
                          <div key={payment.month} className={`ic-action ic-action--${payment.status}`}>
                            <div className="ic-action-left">
                              <span className={`payment-status-dot psd--${payment.status}`} />
                              <span className="ic-action-label">
                                V.{payment.month}
                                <span className="ic-action-date"> · {fmtDate(payment.dueDate)}</span>
                              </span>
                            </div>
                            <div className="ic-action-right">
                              <span className="ic-action-amount">{payment.amount.toLocaleString()} DT</span>
                              {payment.status === 'submitted' ? (
                                <span className="ic-submitted-tag">⏳ En révision</span>
                              ) : (
                                <button type="button" className="ic-upload-btn" onClick={() => openUpload(plan, payment)}>
                                  {payment.status === 'rejected' ? '↩ Resoumettre' : '↑ Envoyer'}
                                </button>
                              )}
                            </div>
                            {payment.status === 'rejected' && payment.rejectedNote && (
                              <p className="ic-reject-note">⚠ {payment.rejectedNote}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ══════════════════════════════
            MES PARCELLES (owned)
        ══════════════════════════════ */}
        <h3 className="section-heading" style={{ marginTop: '2.5rem' }}>Mes parcelles</h3>

        {myPurchases.length === 0 ? (
          <div className="empty-state">
            <p>Vous ne possédez pas encore de parcelles.</p>
            <button className="cta-primary" onClick={() => navigate('/browse')}>
              Explorer les projets
            </button>
          </div>
        ) : (
          <div className="owned-plots">
            {myPurchases.map((purchase) => {
              const proj = projects.find((p) => p.id === purchase.projectId)
              const plot = proj?.plots.find((pl) => pl.id === purchase.plotId)
              const yearsHeld  = new Date().getFullYear() - parseInt(purchase.since.split('-')[0])
              const totalEarned = yearsHeld * purchase.annualRevenue
              return (
                <div key={`${purchase.projectId}-${purchase.plotId}`} className="owned-plot-card">
                  {plot?.mapUrl && (
                    <div className="owned-plot-map">
                      <iframe title={`Parcelle ${purchase.plotId}`} src={plot.mapUrl} loading="lazy" tabIndex={-1} />
                    </div>
                  )}
                  <div className="owned-plot-info">
                    <div className="owned-plot-id">
                      <span className="status-dot" />
                      Parcelle #{purchase.plotId}
                    </div>
                    <p className="owned-plot-project">{proj?.title}</p>
                    <p className="owned-plot-location">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
                      </svg>
                      {purchase.city}, {purchase.region}
                    </p>
                    {plot?.treeBatches?.length > 0 && (
                      <div className="owned-plot-batches">
                        {plot.treeBatches.map(b => {
                          const age = new Date().getFullYear() - b.year
                          const color = age < 3 ? '#888' : age < 6 ? '#f5c842' : age < 10 ? '#a8cc50' : '#7ab020'
                          return (
                            <span key={b.year} className="plot-year-tag" style={{ borderColor: color, color }}>
                              {b.year} · {b.count}🌿
                            </span>
                          )
                        })}
                      </div>
                    )}
                    <div className="owned-plot-stats">
                      <div className="owned-stat"><span>Arbres</span><strong>{purchase.trees}</strong></div>
                      <div className="owned-stat"><span>Surface</span><strong>{plot?.area ?? '—'} m²</strong></div>
                      <div className="owned-stat"><span>Investi</span><strong>{purchase.invested.toLocaleString()} DT</strong></div>
                      <div className="owned-stat"><span>Revenu / an</span><strong className="green-text">{purchase.annualRevenue.toLocaleString()} DT</strong></div>
                      <div className="owned-stat"><span>Gains cumulés</span><strong className="green-text">~{totalEarned.toLocaleString()} DT</strong></div>
                      <div className="owned-stat"><span>Depuis</span><strong>{purchase.since}</strong></div>
                    </div>
                  </div>
                  <button type="button" className="owned-plot-action"
                    onClick={() => navigate(`/project/${purchase.projectId}/plot/${purchase.plotId}`)}>
                    Voir le détail →
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* Revenue breakdown */}
        {myPurchases.length > 0 && (
          <>
            <h3 className="section-heading" style={{ marginTop: '2rem' }}>Estimation des revenus</h3>
            <div className="revenue-note">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              Estimation basée sur {REVENUE_PER_TREE} DT / arbre / an (30 kg huile × 3 DT/kg).
            </div>
            <div className="revenue-rows">
              {myPurchases.map((p) => (
                <div key={p.plotId} className="revenue-row">
                  <span className="revenue-row-label">Parcelle #{p.plotId} · {p.city}</span>
                  <div className="revenue-row-bar-wrap">
                    <div className="revenue-row-bar" style={{ width: `${Math.min((p.annualRevenue / totalRevenue) * 100, 100)}%` }} />
                  </div>
                  <span className="revenue-row-amount">{p.annualRevenue.toLocaleString()} DT/an</span>
                </div>
              ))}
            </div>
          </>
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
