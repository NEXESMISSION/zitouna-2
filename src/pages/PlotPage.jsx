import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { projects } from '../projects.js'

const REVENUE_PER_TREE = 90

export default function PlotPage() {
  const { projectId, plotId } = useParams()
  const navigate = useNavigate()

  const proj = projects.find((p) => p.id === projectId)
  const plot = proj?.plots.find((pl) => String(pl.id) === String(plotId))

  // Purchase modal state
  const [showBuyModal, setShowBuyModal] = useState(false)
  const [downPct, setDownPct]           = useState(20)
  const [duration, setDuration]         = useState(24)
  const [buySuccess, setBuySuccess]     = useState(false)

  if (!proj || !plot) {
    return (
      <main className="screen screen--app">
        <section className="dashboard-page">
          <TopBar />
          <div className="empty-state">
            <p>Parcelle introuvable.</p>
            <button className="cta-primary" onClick={() => navigate('/browse')}>
              Retour aux projets
            </button>
          </div>
        </section>
      </main>
    )
  }

  const annualRevenue = plot.trees * REVENUE_PER_TREE
  const roi           = ((annualRevenue / plot.totalPrice) * 100).toFixed(1)
  const paybackYears  = Math.ceil(plot.totalPrice / annualRevenue)

  // Purchase plan calculations
  const downAmount = Math.round(plot.totalPrice * downPct / 100)
  const remaining  = plot.totalPrice - downAmount
  const monthly    = Math.round(remaining / duration)

  const closeModal = () => {
    setShowBuyModal(false)
    setBuySuccess(false)
    setDownPct(20)
    setDuration(24)
  }

  return (
    <main className="screen screen--app">
      <section className="dashboard-page">
        <TopBar />

        {/* breadcrumb */}
        <div className="detail-nav">
          <button type="button" className="back-btn" onClick={() => navigate(`/project/${proj.id}`)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {proj.city}
          </button>
          <span className="detail-breadcrumb">Parcelle #{plot.id}</span>
        </div>

        {/* plot title */}
        <div className="plot-page-header">
          <div>
            <h2 className="page-title">Parcelle #{plot.id}</h2>
            <p className="page-subtitle">{proj.title} · {proj.city}, {proj.region}</p>
          </div>
          <span className="inline-badge">Disponible</span>
        </div>

        {/* key stats row */}
        <div className="proj-hero-stats" style={{ marginBottom: '1.5rem' }}>
          <div className="proj-hero-stat">
            <span style={{ color: '#a8cc50' }}>{plot.trees}</span>
            <label>Arbres</label>
          </div>
          <div className="proj-hero-stat">
            <span>{plot.area.toLocaleString()} m²</span>
            <label>Surface</label>
          </div>
          <div className="proj-hero-stat">
            <span>{plot.pricePerTree.toLocaleString()} TND</span>
            <label>Prix / arbre</label>
          </div>
          <div className="proj-hero-stat">
            <span style={{ color: '#a8cc50' }}>{plot.totalPrice.toLocaleString()} TND</span>
            <label>Prix total</label>
          </div>
        </div>

        {/* large map */}
        <div className="detail-map-wrap">
          <div className="detail-map-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
            </svg>
            Emplacement de la parcelle
          </div>
          <div className="detail-map" style={{ height: '360px' }}>
            <iframe
              title={`Parcelle ${plot.id} — ${proj.city}`}
              src={plot.mapUrl}
              loading="lazy"
              allowFullScreen
            />
          </div>
        </div>

        {/* ── Purchase CTA ── */}
        <div className="plot-purchase-cta">
          <div className="plot-purchase-left">
            <span className="plot-purchase-price">
              {plot.totalPrice.toLocaleString()} <small>DT</small>
            </span>
            <span className="plot-purchase-label">Prix total · Parcelle #{plot.id} · {plot.trees} oliviers</span>
          </div>
          <div className="plot-purchase-btns">
            <button type="button" className="plot-purchase-cash">
              Payer comptant
            </button>
            <button type="button" className="cta-primary" onClick={() => setShowBuyModal(true)}>
              Acheter en versements →
            </button>
          </div>
        </div>

        {/* investment breakdown */}
        <h3 className="section-heading">Analyse de l&apos;investissement</h3>
        <div className="plot-invest-grid">
          <div className="invest-card invest-card--highlight">
            <div className="invest-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </div>
            <span className="invest-card-label">Revenu annuel estimé</span>
            <p className="invest-card-value">{annualRevenue.toLocaleString()} DT</p>
            <span className="invest-card-sub">basé sur {REVENUE_PER_TREE} DT / arbre / an</span>
          </div>

          <div className="invest-card">
            <div className="invest-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" />
              </svg>
            </div>
            <span className="invest-card-label">Rendement estimé (ROI)</span>
            <p className="invest-card-value">{roi}%</p>
            <span className="invest-card-sub">par an sur le capital investi</span>
          </div>

          <div className="invest-card">
            <div className="invest-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </div>
            <span className="invest-card-label">Retour sur investissement</span>
            <p className="invest-card-value">{paybackYears} ans</p>
            <span className="invest-card-sub">délai de remboursement estimé</span>
          </div>

          <div className="invest-card">
            <div className="invest-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <span className="invest-card-label">Arbres inclus</span>
            <p className="invest-card-value">{plot.trees}</p>
            <span className="invest-card-sub">oliviers à pleine maturité</span>
          </div>
        </div>

        {/* revenue projection */}
        <h3 className="section-heading" style={{ marginTop: '1.75rem' }}>Projection sur 5 ans</h3>
        <div className="projection-table-wrap">
          <table className="projection-table">
            <thead>
              <tr>
                <th>Année</th>
                <th>Revenu estimé</th>
                <th>Cumulé</th>
                <th>% capital récupéré</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5].map((yr) => {
                const cumulative = yr * annualRevenue
                const pct = ((cumulative / plot.totalPrice) * 100).toFixed(0)
                return (
                  <tr key={yr}>
                    <td className="plot-id">An {yr}</td>
                    <td>{annualRevenue.toLocaleString()} DT</td>
                    <td className="green-text">{cumulative.toLocaleString()} DT</td>
                    <td>
                      <div className="pct-bar-wrap">
                        <div className="pct-bar" style={{ width: `${Math.min(pct, 100)}%` }} />
                        <span>{pct}%</span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <p className="revenue-note" style={{ marginTop: '1rem', marginBottom: '2rem' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          Estimations basées sur {REVENUE_PER_TREE} DT/arbre/an (30 kg × 3 DT/kg). Les revenus réels dépendent des conditions de récolte et du marché.
        </p>
      </section>

      {/* ── Purchase / Installment modal ── */}
      {showBuyModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            {!buySuccess ? (
              <>
                <div className="modal-header">
                  <h3 className="modal-title">Plan de versements</h3>
                  <button type="button" className="modal-close" onClick={closeModal}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>

                <div className="modal-plot-info">
                  <span>{proj.title} · #{plot.id}</span>
                  <strong>{plot.totalPrice.toLocaleString()} DT</strong>
                </div>

                <div className="plan-config">
                  {/* Advance payment */}
                  <div className="plan-config-group">
                    <div className="plan-config-row">
                      <span className="plan-config-label">Avance initiale</span>
                      <strong className="plan-config-value">{downPct}% — {downAmount.toLocaleString()} DT</strong>
                    </div>
                    <input
                      type="range" min="10" max="50" step="5"
                      value={downPct}
                      onChange={(e) => setDownPct(Number(e.target.value))}
                      className="plan-slider"
                    />
                    <div className="plan-slider-marks">
                      <span>10%</span><span>30%</span><span>50%</span>
                    </div>
                  </div>

                  {/* Duration */}
                  <div className="plan-config-group">
                    <span className="plan-config-label">Durée du plan</span>
                    <div className="plan-duration-btns">
                      {[12, 24, 36, 48, 60].map((m) => (
                        <button
                          key={m} type="button"
                          className={`plan-duration-btn${duration === m ? ' active' : ''}`}
                          onClick={() => setDuration(m)}
                        >
                          {m} mois
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Summary */}
                <div className="plan-summary">
                  <div className="plan-summary-row">
                    <span>Avance à verser</span>
                    <strong>{downAmount.toLocaleString()} DT</strong>
                  </div>
                  <div className="plan-summary-row">
                    <span>Montant restant</span>
                    <strong>{remaining.toLocaleString()} DT</strong>
                  </div>
                  <div className="plan-summary-row">
                    <span>Durée</span>
                    <strong>{duration} mois</strong>
                  </div>
                  <div className="plan-summary-row plan-summary-row--total">
                    <span>Mensualité estimée</span>
                    <strong className="green-text">{monthly.toLocaleString()} DT / mois</strong>
                  </div>
                </div>

                <button type="button" className="cta-primary modal-submit" onClick={() => setBuySuccess(true)}>
                  Valider ce plan
                </button>
              </>
            ) : (
              <div className="modal-success">
                <div className="modal-success-icon">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h3>Demande enregistrée !</h3>
                <p>Votre plan de versements est en cours de validation. Suivez vos paiements depuis votre tableau de bord.</p>
                <button type="button" className="cta-primary modal-submit" onClick={() => { closeModal(); navigate('/dashboard') }}>
                  Voir mes versements →
                </button>
                <button type="button" className="modal-cancel" onClick={closeModal}>
                  Rester sur cette page
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
