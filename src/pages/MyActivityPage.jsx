import { useMemo, useState } from 'react'
import DashboardShell from '../components/DashboardShell.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import {
  useMyCommissionLedger,
  useInstallmentsScoped,
} from '../lib/useSupabase.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import './dashboard-page.css'

/*
 * /my/activity — full chronological activity feed.
 *
 *   Merges two streams into a single time-sorted list so the user sees
 *   every money-related event on one page:
 *     · commission events (credits + payouts) from the commission ledger
 *     · installment payments (pending / submitted / approved / rejected)
 *   Each row is color-coded (green = credit, red = debit, blue = scheduled),
 *   with a status chip and a relative date. A simple filter lets the user
 *   narrow by category.
 */

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso || '')
  }
}

export default function MyActivityPage() {
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

  const { events: myCommissionEvents, loading: ledgerLoading, refresh: refreshLedger } =
    useMyCommissionLedger({ clientId: clientId || null, enabled: Boolean(clientId) })
  const { plans: myPlans, loading: plansLoading } = useInstallmentsScoped({ clientId })

  const [filter, setFilter] = useState('all')

  // Flatten both streams into a shared activity shape so we can sort,
  // filter, and render them uniformly.
  const activity = useMemo(() => {
    const out = []

    for (const ev of myCommissionEvents || []) {
      const isPayout = ev.kind === 'payout'
      const dateIso = ev.createdAt || ev.sale?.notaryCompletedAt || ev.paidAt || ev.reviewedAt
      if (!dateIso) continue
      out.push({
        id: `cm-${ev.id}`,
        kind: isPayout ? 'payout' : 'commission',
        category: isPayout ? 'payout' : 'commission',
        title: isPayout
          ? 'Demande de retrait'
          : `Commission L${ev.level || '?'} · ${ev.project?.title || 'Vente'}`,
        sub: isPayout
          ? (ev.code ? `Code ${ev.code}` : 'En traitement finance')
          : (ev.seller?.name ? `Vendeur ${ev.seller.name}` : ''),
        amount: Number(ev.amount || 0),
        sign: isPayout ? '−' : '+',
        iconType: isPayout ? 'out' : 'in',
        status: ev.status,
        dateIso,
      })
    }

    for (const plan of myPlans || []) {
      for (const p of plan.payments || []) {
        if (!p.dueDate) continue
        // Only surface payments that actually moved — skip the pure "pending"
        // scheduled-only entries unless the user filters to "installments".
        out.push({
          id: `ip-${plan.id}-${p.month}`,
          kind: 'installment',
          category: 'installment',
          title: `Facilité ${p.month} · ${plan.projectTitle || 'Plan'}`,
          sub: plan.projectCity || '',
          amount: Number(p.amount || 0),
          sign: p.status === 'approved' ? '−' : '',
          iconType: p.status === 'approved' ? 'out' : 'schedule',
          status: p.status,
          dateIso: p.dueDate,
        })
      }
    }

    out.sort((a, b) => new Date(b.dateIso) - new Date(a.dateIso))
    return out
  }, [myCommissionEvents, myPlans])

  const filtered = useMemo(() => {
    if (filter === 'all') return activity
    return activity.filter((a) => a.category === filter)
  }, [activity, filter])

  const counts = useMemo(() => ({
    all: activity.length,
    commission: activity.filter((a) => a.category === 'commission').length,
    payout: activity.filter((a) => a.category === 'payout').length,
    installment: activity.filter((a) => a.category === 'installment').length,
  }), [activity])

  const statusLabels = {
    paid: { label: 'Payé', tone: 'zb-status-paid' },
    payable: { label: 'À virer', tone: 'zb-status-up' },
    pending: { label: 'En attente', tone: 'zb-status-due' },
    cancelled: { label: 'Annulé', tone: 'zb-status-bad' },
    pending_review: { label: 'En revue', tone: 'zb-status-due' },
    approved: { label: 'Confirmé', tone: 'zb-status-paid' },
    rejected: { label: 'Refusé', tone: 'zb-status-bad' },
    submitted: { label: 'En révision', tone: 'zb-status-up' },
  }

  const loading = ledgerLoading && myCommissionEvents.length === 0 && plansLoading

  const tabs = [
    { key: 'all',         label: 'Tout' },
    { key: 'commission',  label: 'Commissions' },
    { key: 'payout',      label: 'Retraits' },
    { key: 'installment', label: 'Échéances' },
  ]

  return (
    <DashboardShell active="dashboard">
          <div className="zb-greeting">
            <h1 className="zb-greeting-h1">Activité récente</h1>
          </div>

          {/* Filter chips (spark-tabs style) */}
          <div className="zb-spark-tabs" style={{ alignSelf: 'flex-start' }}>
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                className={filter === t.key ? 'zb-active' : ''}
                onClick={() => setFilter(t.key)}
              >
                {t.label}
                {counts[t.key] > 0 && (
                  <span style={{ marginLeft: 6, color: 'var(--zb-faint)', fontWeight: 500 }}>
                    {counts[t.key]}
                  </span>
                )}
              </button>
            ))}
          </div>

          <RenderDataGate
            loading={loading}
            data={filtered}
            skeleton="table"
            watchdogMs={4000}
            onRetry={refreshLedger}
            empty={
              <EmptyState
                title="Aucune activité"
                description="Aucun événement à afficher pour ce filtre."
              />
            }
          >
            {(list) => (
              <div className="zb-card zb-act" style={{ padding: '8px 20px' }}>
                {list.map((a) => {
                  const st = statusLabels[a.status] || null
                  return (
                    <div key={a.id} className="zb-act-row">
                      <div className={`zb-act-ic ${
                        a.iconType === 'in' ? 'zb-act-ic-in'
                          : a.iconType === 'out' ? 'zb-act-ic-out'
                            : 'zb-act-ic-tree'
                      }`}>
                        {a.iconType === 'in' && (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7 7 7-7" /></svg>
                        )}
                        {a.iconType === 'out' && (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12l7-7 7 7" /></svg>
                        )}
                        {a.iconType === 'schedule' && (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                        )}
                      </div>
                      <div className="zb-info">
                        <div className="zb-info-t">{a.title}</div>
                        <div className="zb-info-s">
                          {fmtDate(a.dateIso)}
                          {a.sub ? ` · ${a.sub}` : ''}
                          {st && <span className={`zb-status ${st.tone}`} style={{ marginLeft: 8 }}>{st.label}</span>}
                        </div>
                      </div>
                      <div className={`zb-a ${a.iconType === 'in' ? 'zb-in' : 'zb-out'}`}>
                        {a.sign}{Math.round(Math.abs(a.amount)).toLocaleString('fr-FR')}
                        <span className="zb-u">DT</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </RenderDataGate>
    </DashboardShell>
  )
}
