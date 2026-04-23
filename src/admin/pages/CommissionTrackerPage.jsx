import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCommissionTracker } from '../lib/useCommissionTracker.js'
import CommissionOrgChart from '../components/CommissionOrgChart.jsx'
import CommissionDetailPanel from '../components/CommissionDetailPanel.jsx'
import CommissionOverrideModal from '../components/CommissionOverrideModal.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import { useAuth } from '../../lib/AuthContext.jsx'
import { asId } from '../lib/commissionFormat.js'
import './zitouna-admin-page.css'
import './commission-tracker.css'

// -- page --------------------------------------------------------------------
// Slimmed down per user request: only the network graph (nodes + lines) is
// rendered here. The stats bar, diagnostics button, refresh button, and the
// verbose onboarding empty-hero were removed — the chart handles clicking a
// node for details via CommissionDetailPanel, which slides in from the side.
export default function CommissionTrackerPage() {
  const { data, loading, error, refresh } = useCommissionTracker()
  const { adminUser } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [selectedClientId, setSelectedClientId] = useState(null)
  const [overrideEvent, setOverrideEvent] = useState(null)

  // Support deep-linking from the Overview page: /admin/commissions/network?focus=<clientId>
  const focusParam = searchParams.get('focus')
  useEffect(() => {
    if (focusParam && selectedClientId !== focusParam) setSelectedClientId(String(focusParam))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam])

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

  const handleOverrideSaved = useCallback(() => {
    setOverrideEvent(null)
    refresh().catch(() => {})
  }, [refresh])

  const canOverride = Boolean(adminUser?.id)
  const hasSelection = Boolean(selectedClientId)

  return (
    <div className="ct-fullscreen ct-fullscreen--embedded ct-fullscreen--bare" dir="ltr">
      <div className={`ct-graph-host ${hasSelection ? 'ct-graph-host--with-panel' : ''}`}>
        <RenderDataGate
          loading={loading}
          error={error}
          data={cleanData}
          onRetry={() => refresh().catch(() => {})}
          skeleton="tree"
          isEmpty={(d) => !d || (Array.isArray(d.commissionEvents) && d.commissionEvents.length === 0)}
          empty={
            <div className="ct-empty-bare" role="status" aria-live="polite">
              <svg viewBox="0 0 320 180" className="ct-empty-bare__net" preserveAspectRatio="xMidYMid meet" aria-hidden>
                <g stroke="#cbd5e1" strokeWidth="1.5" fill="none">
                  <path d="M160,36 L80,100" />
                  <path d="M160,36 L240,100" />
                  <path d="M80,100 L40,156" />
                  <path d="M80,100 L120,156" />
                  <path d="M240,100 L200,156" />
                  <path d="M240,100 L280,156" />
                </g>
                <circle cx="160" cy="36" r="18" fill="#2563eb" />
                <circle cx="80"  cy="100" r="14" fill="#e0e7ff" stroke="#6366f1" strokeWidth="1.5" />
                <circle cx="240" cy="100" r="14" fill="#e0e7ff" stroke="#6366f1" strokeWidth="1.5" />
                {[40, 120, 200, 280].map((cx) => (
                  <circle key={cx} cx={cx} cy="156" r="10" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.2" />
                ))}
              </svg>
              <div className="ct-empty-bare__title">Aucune commission à afficher</div>
            </div>
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

      {hasSelection ? (
        <CommissionDetailPanel
          clientId={selectedClientId}
          data={cleanData}
          onClose={() => {
            setSelectedClientId(null)
            if (searchParams.get('focus')) {
              const next = new URLSearchParams(searchParams)
              next.delete('focus')
              setSearchParams(next, { replace: true })
            }
          }}
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
