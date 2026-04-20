import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCommissionTracker } from '../lib/useCommissionTracker.js'
import CommissionOrgChart from '../components/CommissionOrgChart.jsx'
import CommissionDetailPanel from '../components/CommissionDetailPanel.jsx'
import CommissionOverrideModal from '../components/CommissionOverrideModal.jsx'
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
            <EmptyState
              icon="🌳"
              title="Aucune commission enregistrée"
              description="Le réseau s'affichera dès qu'un événement de commission sera généré."
            />
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
    </div>
  )
}
