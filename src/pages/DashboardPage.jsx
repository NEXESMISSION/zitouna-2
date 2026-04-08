import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { myPurchases } from '../portfolio.js'
import { projects } from '../projects.js'
import { loadInstallments } from '../installmentsStore.js'

const REVENUE_PER_TREE = 90

export default function DashboardPage() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('facilites')
  const [network] = useState([
    { id: 'm-k', name: 'Mohamed Khalil', note: 'Contrat signe (1.5 Ha)', reward: 50, state: 'complete', initials: 'MK' },
    { id: 's-t', name: 'Sofiene Tounsi', note: 'Reservation en attente de signature', reward: 50, state: 'queued', initials: 'ST' },
    { id: 'a-b', name: 'Ali Ben Ahmed', note: 'Inscrit, pas encore de reservation', reward: 0, state: 'pending', initials: 'AB' }
  ])

  // ── Owned plots stats ──
  const totalTrees    = myPurchases.reduce((s, p) => s + p.trees, 0)
  const totalInvested = myPurchases.reduce((s, p) => s + p.invested, 0)
  const totalRevenue  = myPurchases.reduce((s, p) => s + p.annualRevenue, 0)
  const roi           = totalInvested > 0 ? ((totalRevenue / totalInvested) * 100).toFixed(1) : '0.0'

  const [plans] = useState(loadInstallments)
  const allPayments = plans
    .flatMap((plan) => plan.payments.map((p) => ({ ...p, planId: plan.id })))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
  const nextPayment =
    allPayments.find((p) => p.status === 'pending' || p.status === 'rejected' || p.status === 'submitted')
    || allPayments.find((p) => p.status === 'approved')
    || null

  const nextPaymentLabel = nextPayment
    ? `${nextPayment.amount.toLocaleString()} DT - ${new Date(nextPayment.dueDate).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}`
    : 'Aucune echeance disponible'
  const nextPaymentStatus = nextPayment
    ? (nextPayment.status === 'approved'
        ? 'Deja couverte'
        : nextPayment.status === 'submitted'
          ? 'En revision'
          : nextPayment.status === 'rejected'
            ? 'A renvoyer'
            : 'A payer')
    : 'Sans statut'

  return (
    <main className="screen screen--app">
      <section className="dashboard-page dash-page-skin">
        <TopBar />
        <div className="detail-nav" style={{ marginBottom: '0.85rem' }}>
          <button type="button" className="back-btn" onClick={() => navigate('/browse')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Retour a Explorer
          </button>
        </div>

        {/* ── Greeting ── */}
        <div className="dash-greeting dash-hero-card">
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

        <section className="dash-invest-summary">
          <div className="dis-head">
            <h3>Synthese investissement</h3>
            <span>Actif</span>
          </div>
          <div className="dis-grid">
            <article>
              <p>Patrimoine agricole</p>
              <strong>{totalTrees.toLocaleString()} oliviers</strong>
            </article>
            <article>
              <p>Revenus estimes</p>
              <strong>{totalRevenue.toLocaleString()} DT/an</strong>
            </article>
          </div>
          <div className="dis-next">
            <div>
              <p>Prochaine payment</p>
              <strong>{nextPaymentLabel}</strong>
            </div>
            <div className="dis-next-actions">
              <em className={`dis-next-badge dis-next-badge--${nextPayment?.status || 'none'}`}>{nextPaymentStatus}</em>
              <button type="button" className="dis-next-link" onClick={() => navigate('/installments')}>
                Voir echeancier
              </button>
            </div>
          </div>
        </section>

        <section className="dash-ambassador">
          <div className="dash-wallet-card">
            <div className="dw-head">
              <span>Portefeuille Parrainage</span>
              <em>Pret au retrait</em>
            </div>
            <div className="dw-main">
              <h4>50 DT</h4>
              <p>1 commission liberee</p>
            </div>
            <div className="dw-actions">
              <button type="button">Retirer les gains</button>
              <small>Commissions en attente: 100 DT</small>
            </div>
          </div>

          <div className="dash-network">
            <div className="dn-head">
              <h4>Reseau investisseurs</h4>
              <span>4 invites</span>
            </div>
            <div className="dn-list">
              {network.map((person) => (
                <article key={person.id} className={`dn-item${person.state === 'pending' ? ' dn-item--pending' : ''}${person.state === 'queued' ? ' dn-item--queued' : ''}`}>
                  <div className="dn-id">{person.initials}</div>
                  <div className="dn-body">
                    <strong>{person.name}</strong>
                    <p>{person.note}</p>
                  </div>
                  <div className="dn-reward">
                    <strong>{person.reward > 0 ? `+${person.reward} DT` : '0 DT'}</strong>
                    <span>{person.state === 'complete' ? 'Liberee' : person.state === 'queued' ? 'En attente signature' : 'En attente'}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <div className="dash-tabs">
          <button
            type="button"
            className={`dash-tab-btn${activeTab === 'facilites' ? ' dash-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('facilites')}
          >
            Mes facilités
          </button>
          <button
            type="button"
            className={`dash-tab-btn${activeTab === 'parcelles' ? ' dash-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('parcelles')}
          >
            Mes parcelles
          </button>
        </div>

        {/* ── Mes facilités ── */}
        {activeTab === 'facilites' && plans.length > 0 && (
          <>
            <h3 className="dash-section-title">Mes facilités en cours</h3>
            <div style={{ margin: '-0.35rem 0 0.75rem' }}>
              <button type="button" className="link-btn" onClick={() => navigate('/installments')}>
                Gérer toutes les échéances →
              </button>
            </div>
            <div className="dash-plan-cards">
              {plans.map((plan) => {
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
          </>
        )}

        {/* ── Mes parcelles ── */}
        {activeTab === 'parcelles' && <h3 className="dash-section-title" style={{ marginTop: '1.25rem' }}>Mes parcelles</h3>}

        {activeTab === 'parcelles' && myPurchases.length === 0 ? (
          <div className="empty-state">
            <p>Vous ne possédez pas encore de parcelles.</p>
            <button className="cta-primary" onClick={() => navigate('/browse')}>Explorer les projets</button>
          </div>
        ) : activeTab === 'parcelles' ? (
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
        ) : null}

        <footer className="dash-logout-footer">
          <button type="button" className="dash-logout-btn" onClick={() => navigate('/login')}>
            Se déconnecter
          </button>
        </footer>
      </section>

    </main>
  )
}
