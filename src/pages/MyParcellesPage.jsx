import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import DashboardShell from '../components/DashboardShell.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import {
  useProjectsScoped,
  useSalesScoped,
} from '../lib/useSupabase.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { buildMyPurchases } from '../lib/buildMyPurchases.js'
import './dashboard-page.css'

function isCompletedNotarized(s) {
  const statusOk = String(s?.status || '').toLowerCase() === 'completed'
  const notaryOk = Boolean(s?.notaryCompletedAt)
  return statusOk && notaryOk
}

export default function MyParcellesPage() {
  const navigate = useNavigate()
  const { clientProfile, profileStatus, ready } = useAuth()

  const terminalProfileReason = profileStatus?.reason
  const profileResolutionFinalized =
    Boolean(terminalProfileReason) &&
    ['rpc_error', 'ambiguous_client_profile', 'phone_conflict', 'admin_no_buyer_profile', 'not_authenticated'].includes(
      terminalProfileReason,
    )
  const clientId =
    ready
      ? (clientProfile?.id || (profileResolutionFinalized ? '' : null))
      : null

  const { sales: mySalesRaw, loading: salesLoading, refresh: refreshSales } = useSalesScoped({ clientId })

  const mySales = useMemo(() => {
    if (!clientId) return []
    const cidStr = String(clientId)
    const out = []
    for (const s of mySalesRaw || []) {
      if (s.status === 'cancelled' || s.status === 'rejected') continue
      const sellerBound =
        String(s.ambassadorClientId || '') === cidStr ||
        String(s.sellerClientId || '') === cidStr
      if (sellerBound) continue
      if (isCompletedNotarized(s)) out.push(s)
    }
    return out
  }, [mySalesRaw, clientId])

  const scopedProjectIds = useMemo(
    () => [...new Set((mySales || []).map((s) => s.projectId).filter(Boolean))],
    [mySales],
  )
  const { projects: allProjects, refresh: refreshProjects } = useProjectsScoped(scopedProjectIds)

  const myPurchases = useMemo(
    () => buildMyPurchases(mySales, allProjects),
    [mySales, allProjects],
  )

  const portfolioLoading = Boolean(clientId) && salesLoading && (mySalesRaw?.length || 0) === 0

  const totalInvested = myPurchases.reduce((s, p) => s + (Number(p.invested) || 0), 0)
  const totalAnnual = myPurchases.reduce((s, p) => s + (Number(p.annualRevenue) || 0), 0)

  return (
    <DashboardShell active="browse">
          <div className="zb-greeting">
            <h1 className="zb-greeting-h1">Mes parcelles</h1>
          </div>

          <section>
            <div className="zb-section-head">
              <h2>Toutes vos parcelles</h2>
              <span style={{ color: 'var(--zb-muted)', fontSize: 13 }}>
                {myPurchases.length} parcelle{myPurchases.length !== 1 ? 's' : ''}
                {myPurchases.length > 0 && ` · ${Math.round(totalInvested).toLocaleString('fr-FR')} DT investis · ${Math.round(totalAnnual).toLocaleString('fr-FR')} DT/an`}
              </span>
            </div>

            <RenderDataGate
              loading={portfolioLoading}
              data={myPurchases}
              watchdogMs={4000}
              skeleton={() => (
                <div className="zb-parcelles zb-parcelles--slim" aria-busy="true">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="zb-card zb-parcelle zb-parcelle--slim">
                      <div className="zb-parcelle-body">
                        <div className="zb-parcelle-head">
                          <div className="sk sk-line sk-line--title" style={{ width: '55%' }} />
                          <div className="sk sk-line sk-line--sub" style={{ width: '30%' }} />
                        </div>
                        <div className="sk sk-line sk-line--sub" style={{ width: '70%' }} />
                        <div className="sk sk-line sk-line--sub" style={{ width: '50%' }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              onRetry={() => {
                try { refreshSales?.() } catch { /* ignore */ }
                try { refreshProjects?.() } catch { /* ignore */ }
              }}
              empty={
                <EmptyState
                  title="Aucune parcelle"
                  description="Vos parcelles s'afficheront ici après finalisation notaire."
                  action={{ label: 'Explorer les projets', onClick: () => navigate('/browse') }}
                />
              }
            >
              {(purchases) => (
                <div className="zb-parcelles zb-parcelles--slim">
                  {purchases.map((parcel) => {
                    const progress = Math.min(100, Math.max(8, (parcel.annualRevenue / (parcel.invested || 1)) * 100))
                    return (
                      <div
                        key={`${parcel.saleId}-${parcel.plotId}`}
                        className="zb-card zb-parcelle zb-parcelle--slim"
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/project/${parcel.projectId}/plot/${parcel.plotId}`)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            navigate(`/project/${parcel.projectId}/plot/${parcel.plotId}`)
                          }
                        }}
                      >
                        <div className="zb-parcelle-body">
                          <div className="zb-parcelle-head">
                            <div className="zb-parcelle-title">Parcelle #{parcel.plotId}</div>
                            {parcel.city && (
                              <span className="zb-parcelle-city">
                                <span className="zb-d" />{parcel.city}
                              </span>
                            )}
                          </div>
                          <div className="zb-parcelle-subtitle">{parcel.projectTitle}</div>
                          <div className="zb-parcelle-stats">
                            <div className="zb-kv">
                              <span className="zb-k">Investi</span>
                              <span className="zb-v">{Math.round(parcel.invested).toLocaleString('fr-FR')}<span className="zb-v-unit">DT</span></span>
                            </div>
                            <div className="zb-kv">
                              <span className="zb-k">Revenu / an</span>
                              <span className="zb-v zb-blue">{Math.round(parcel.annualRevenue).toLocaleString('fr-FR')}<span className="zb-v-unit">DT</span></span>
                            </div>
                          </div>
                          <div className="zb-parcelle-foot">
                            <div className="zb-progress"><span style={{ width: `${progress}%` }} /></div>
                            <button
                              type="button"
                              className="zb-parcelle-detail"
                              onClick={(e) => { e.stopPropagation(); navigate(`/project/${parcel.projectId}/plot/${parcel.plotId}`) }}
                            >
                              Détail
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </RenderDataGate>
          </section>
    </DashboardShell>
  )
}
