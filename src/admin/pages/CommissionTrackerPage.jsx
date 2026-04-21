import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCommissionTracker } from '../lib/useCommissionTracker.js'
import CommissionOrgChart from '../components/CommissionOrgChart.jsx'
import CommissionDetailPanel from '../components/CommissionDetailPanel.jsx'
import CommissionOverrideModal from '../components/CommissionOverrideModal.jsx'
import CommissionDiagnosticsPanel from '../components/CommissionDiagnosticsPanel.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { useAuth } from '../../lib/AuthContext.jsx'
import './zitouna-admin-page.css'
import './commission-tracker.css'

// -- tiny helpers (kept in-file, no shared deps) ------------------------------
function asId(v) { return v == null ? '' : String(v) }

function fmtMoney(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0 TND'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M TND`
  if (v >= 10_000) return `${Math.round(v / 1000)}k TND`
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} TND`
}

function normalizeStatus(e) {
  if (!e) return 'pending'
  if (e.status === 'paid' || e.paid_at || e.paidAt) return 'paid'
  if (e.status === 'cancelled') return 'cancelled'
  if (e.status === 'payable' || e.status === 'approved') return 'payable'
  return 'pending'
}

// -- page --------------------------------------------------------------------
export default function CommissionTrackerPage() {
  const navigate = useNavigate()
  // Plan 03 §4.5: previously destructured `{ data, error, refresh }` and
  // ignored loading — a blank page with no affordance (Pattern D). We now
  // consume loading too and route it through <RenderDataGate>.
  const { data, loading, error, refresh } = useCommissionTracker()
  const { adminUser } = useAuth()

  const [selectedClientId, setSelectedClientId] = useState(null)
  const [overrideEvent, setOverrideEvent] = useState(null)
  const [diagOpen, setDiagOpen] = useState(false)

  // Demo/seed clients (anything with "DEMO" in the name) are pruned from the
  // visualization so the tree doesn't get polluted with fixture rows.
  const demoClientIds = useMemo(() => {
    const s = new Set()
    for (const c of data?.clients || []) {
      const name = String(c.full_name || c.name || '')
      if (/\bDEMO\b/i.test(name)) s.add(asId(c.id))
    }
    return s
  }, [data?.clients])

  const cleanData = useMemo(() => {
    if (!data) return data
    return {
      ...data,
      clients: (data.clients || []).filter((c) => !demoClientIds.has(asId(c.id))),
      sales: (data.sales || []).filter((s) => {
        const buyer = asId(s.client_id || s.clientId)
        const seller = asId(s.seller_client_id || s.sellerClientId)
        return !demoClientIds.has(buyer) && !demoClientIds.has(seller)
      }),
      commissionEvents: (data.commissionEvents || []).filter((e) => {
        const b = asId(e.beneficiary_client_id || e.beneficiaryClientId)
        return !demoClientIds.has(b)
      }),
    }
  }, [data, demoClientIds])

  // Top-bar rollup — 4 numbers that matter at a glance.
  const globalStats = useMemo(() => {
    const totals = { payable: 0, paid: 0, pending: 0, beneficiaries: 0 }
    const seen = new Set()
    for (const e of cleanData?.commissionEvents || []) {
      const amt = Number(e.amount) || 0
      const st = normalizeStatus(e)
      if (st === 'paid') totals.paid += amt
      else if (st === 'payable') totals.payable += amt
      else if (st !== 'cancelled') totals.pending += amt
      const b = asId(e.beneficiary_client_id || e.beneficiaryClientId)
      if (b) seen.add(b)
    }
    totals.beneficiaries = seen.size
    return totals
  }, [cleanData?.commissionEvents])

  const handleOverrideSaved = useCallback(() => {
    setOverrideEvent(null)
    refresh().catch(() => {})
  }, [refresh])

  const canOverride = Boolean(adminUser?.id)
  const hasSelection = Boolean(selectedClientId)

  return (
    <div className="ct-fullscreen" dir="ltr">
      {/* top bar — sticky over the graph */}
      <header className="ct-topbar">
        <button
          type="button"
          className="ct-topbar__back"
          onClick={() => navigate(-1)}
          aria-label="Retour"
          title="Retour"
        >
          ←
        </button>
        <h1 className="ct-topbar__title">Réseau des commissions</h1>
        <div className="ct-topbar__stats" role="group" aria-label="Statistiques globales">
          <span className="ct-topbar__stat ct-topbar__stat--warn" title="À payer">
            <span className="ct-topbar__stat-dot" aria-hidden />
            <strong>{fmtMoney(globalStats.payable)}</strong>
            <span className="ct-topbar__stat-lbl">à payer</span>
          </span>
          <span className="ct-topbar__stat ct-topbar__stat--good" title="Payé">
            <span className="ct-topbar__stat-dot" aria-hidden />
            <strong>{fmtMoney(globalStats.paid)}</strong>
            <span className="ct-topbar__stat-lbl">payé</span>
          </span>
          <span className="ct-topbar__stat ct-topbar__stat--muted" title="Bénéficiaires">
            <strong>{globalStats.beneficiaries}</strong>
            <span className="ct-topbar__stat-lbl">bénéf.</span>
          </span>
        </div>
        <button
          type="button"
          className="ct-topbar__refresh"
          onClick={() => setDiagOpen(true)}
          aria-label="Ouvrir le diagnostic du réseau"
          title="Diagnostic — ventes inversées, orphelins, cycles…"
          style={{ marginRight: 4 }}
        >
          ⚠
        </button>
        <button
          type="button"
          className="ct-topbar__refresh"
          onClick={() => refresh().catch(() => {})}
          aria-label="Rafraîchir"
          title="Rafraîchir les données"
        >
          ↻
        </button>
      </header>

      {/* Plan 03 §4.5: four-state gate replaces the inline error banner and
          unconditional <CommissionOrgChart> render. Empty tree now shows an
          explicit EmptyState; stuck loads surface a Retry affordance. */}
      <div className={`ct-graph-host ${hasSelection ? 'ct-graph-host--with-panel' : ''}`}>
        <RenderDataGate
          loading={loading}
          error={error}
          data={cleanData}
          onRetry={() => refresh().catch(() => {})}
          skeleton="tree"
          isEmpty={(d) => !d || (Array.isArray(d.commissionEvents) && d.commissionEvents.length === 0)}
          empty={
            (() => {
              const notarySales = Array.isArray(cleanData?.sales) ? cleanData.sales : []
              const withSeller = notarySales.filter((s) => s.seller_client_id || s.sellerClientId).length
              const withoutSeller = notarySales.length - withSeller
              const hasStaffOnly = notarySales.length > 0 && withSeller === 0
              const clientNameById = new Map(
                (cleanData?.clients || []).map((c) => [asId(c.id), c.full_name || c.name || ''])
              )
              const projectTitleById = new Map(
                (cleanData?.projects || []).map((p) => [asId(p.id), p.title || ''])
              )
              const staffSales = notarySales
                .filter((s) => !s.seller_client_id && !s.sellerClientId)
                .slice(0, 8)
              return (
            <div className="ct-empty-hero" role="status" aria-live="polite">
              <div className="ct-empty-hero__preview" aria-hidden="true">
                <svg viewBox="0 0 320 180" className="ct-empty-hero__net" preserveAspectRatio="xMidYMid meet">
                  {/* edges */}
                  <g stroke="#cbd5e1" strokeWidth="1.5" fill="none">
                    <path d="M160,36 L80,100" />
                    <path d="M160,36 L240,100" />
                    <path d="M80,100 L40,156" />
                    <path d="M80,100 L120,156" />
                    <path d="M240,100 L200,156" />
                    <path d="M240,100 L280,156" />
                  </g>
                  {/* root */}
                  <circle cx="160" cy="36" r="18" fill="#2563eb" />
                  <text x="160" y="41" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="700">★</text>
                  {/* level 2 */}
                  <circle cx="80" cy="100" r="14" fill="#e0e7ff" stroke="#6366f1" strokeWidth="1.5" />
                  <circle cx="240" cy="100" r="14" fill="#e0e7ff" stroke="#6366f1" strokeWidth="1.5" />
                  {/* level 3 */}
                  {[40, 120, 200, 280].map((cx) => (
                    <circle key={cx} cx={cx} cy="156" r="10" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.2" />
                  ))}
                </svg>
                <div className="ct-empty-hero__badge" aria-hidden>
                  <span>🌳</span>
                </div>
              </div>

              <div className="ct-empty-hero__body">
                <h2 className="ct-empty-hero__title">Aucune commission enregistrée</h2>
                <p className="ct-empty-hero__desc">
                  Le réseau des commissions affichera les relations vendeur-acheteur
                  dès qu'un événement de commission sera généré.
                </p>

                {notarySales.length > 0 && (
                  <div className={`ct-empty-hero__diag${hasStaffOnly ? ' ct-empty-hero__diag--warn' : ''}`}>
                    <div className="ct-empty-hero__diag-head">
                      <span className="ct-empty-hero__diag-icon" aria-hidden>{hasStaffOnly ? '⚠' : 'ℹ'}</span>
                      <strong>Diagnostic</strong>
                    </div>
                    <div className="ct-empty-hero__diag-grid">
                      <div className="ct-empty-hero__diag-row">
                        <span>Ventes finalisées au notariat</span>
                        <strong>{notarySales.length}</strong>
                      </div>
                      <div className="ct-empty-hero__diag-row">
                        <span>Avec vendeur client (MLM)</span>
                        <strong>{withSeller}</strong>
                      </div>
                      <div className="ct-empty-hero__diag-row">
                        <span>Sans vendeur client (staff)</span>
                        <strong>{withoutSeller}</strong>
                      </div>
                    </div>
                    {hasStaffOnly && (
                      <p className="ct-empty-hero__diag-note">
                        Vos ventes ont un <em>agent commercial</em> (staff) mais pas de <em>vendeur client</em>
                        référent. Les commissions multi-niveaux ne se génèrent que pour les ventes entre
                        clients (champ <code>sellerClientId</code> renseigné).
                      </p>
                    )}
                    {staffSales.length > 0 && (
                      <ul className="ct-empty-hero__sale-list" aria-label="Ventes sans vendeur client">
                        {staffSales.map((s) => {
                          const clientName = clientNameById.get(asId(s.client_id || s.clientId)) || 'Client'
                          const projectTitle = projectTitleById.get(asId(s.project_id || s.projectId)) || '—'
                          return (
                            <li key={s.id} className="ct-empty-hero__sale-row">
                              <button
                                type="button"
                                className="ct-empty-hero__sale-btn"
                                onClick={() => {
                                  const cid = asId(s.client_id || s.clientId)
                                  if (cid) navigate(`/admin/clients/${cid}`)
                                }}
                                title="Ouvrir la fiche client pour définir un vendeur client"
                              >
                                <div className="ct-empty-hero__sale-main">
                                  <strong>{clientName}</strong>
                                  <span className="ct-empty-hero__sale-sub">{projectTitle}</span>
                                </div>
                                <div className="ct-empty-hero__sale-meta">
                                  <span className="ct-empty-hero__sale-amount">
                                    {fmtMoney(s.agreed_price || s.agreedPrice)}
                                  </span>
                                  <span className="ct-empty-hero__sale-tag">Staff</span>
                                </div>
                                <span className="ct-empty-hero__sale-chev" aria-hidden>→</span>
                              </button>
                            </li>
                          )
                        })}
                        {notarySales.filter((s) => !s.seller_client_id && !s.sellerClientId).length > staffSales.length && (
                          <li className="ct-empty-hero__sale-more">
                            + {notarySales.filter((s) => !s.seller_client_id && !s.sellerClientId).length - staffSales.length}
                            {' '}autres ventes sans vendeur client
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                )}

                <ul className="ct-empty-hero__steps">
                  <li>
                    <span className="ct-empty-hero__step-num">1</span>
                    <span>Une vente est finalisée au notariat</span>
                  </li>
                  <li>
                    <span className="ct-empty-hero__step-num">2</span>
                    <span>La vente a un <strong>vendeur client</strong> référent</span>
                  </li>
                  <li>
                    <span className="ct-empty-hero__step-num">3</span>
                    <span>L'arbre des bénéficiaires apparaît ici</span>
                  </li>
                </ul>

                <div className="ct-empty-hero__actions">
                  <button
                    type="button"
                    className="ct-empty-hero__btn ct-empty-hero__btn--primary"
                    onClick={() => refresh().catch(() => {})}
                  >
                    <span aria-hidden>↻</span> Actualiser
                  </button>
                  <button
                    type="button"
                    className="ct-empty-hero__btn ct-empty-hero__btn--ghost"
                    onClick={() => navigate('/admin/sales')}
                  >
                    <span aria-hidden>→</span> Voir les ventes
                  </button>
                </div>
              </div>
            </div>
              )
            })()
          }
        >
          {() => (
            <CommissionOrgChart
              data={cleanData}
              selectedClientId={selectedClientId}
              onNodeClick={(id) => setSelectedClientId(id || null)}
            />
          )}
        </RenderDataGate>
      </div>

      {/* right-side detail panel */}
      {hasSelection ? (
        <CommissionDetailPanel
          clientId={selectedClientId}
          data={cleanData}
          onClose={() => setSelectedClientId(null)}
        />
      ) : null}

      {canOverride ? (
        <CommissionOverrideModal
          event={overrideEvent}
          open={Boolean(overrideEvent)}
          onClose={() => setOverrideEvent(null)}
          onSaved={handleOverrideSaved}
        />
      ) : null}

      <CommissionDiagnosticsPanel
        open={diagOpen}
        onClose={() => setDiagOpen(false)}
        data={cleanData}
        onJumpToNode={(id) => {
          setDiagOpen(false)
          if (id) setSelectedClientId(String(id))
        }}
      />
    </div>
  )
}
