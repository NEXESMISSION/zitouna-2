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
import './my-activity-page.css'

/*
 * /my/activity — chronological activity feed for the signed-in client.
 *
 *   Shows only events the user ACTUALLY did something with:
 *     · commission credits + payout requests from the ledger
 *     · installment payments the user has sent / had reviewed / settled
 *   "Scheduled-only" installments (status='pending', nothing sent yet) are
 *   intentionally hidden — they belong on /installments, not in history.
 *
 *   Rows are grouped by month so the feed reads like a statement. Each row
 *   shows a circular icon (colored by flow), a title + sub-line, a status
 *   chip, and a right-aligned amount with sign.
 */

const MONTH_FMT = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' })
const DAY_FMT = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' })

function monthKey(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'inconnu'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function monthLabel(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const s = MONTH_FMT.format(d)
  return s.charAt(0).toUpperCase() + s.slice(1)
}
function dayLabel(iso) {
  try { return DAY_FMT.format(new Date(iso)) } catch { return '' }
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

    // Only surface installments the user actually acted on — an installment
    // with status='pending' is a scheduled future payment (nothing sent,
    // nothing settled) and does NOT belong in activity history.
    const movedStatuses = new Set(['submitted', 'approved', 'rejected', 'paid', 'pending_review'])
    for (const plan of myPlans || []) {
      for (const p of plan.payments || []) {
        if (!p.dueDate) continue
        if (!p.status || !movedStatuses.has(p.status)) continue
        const settled = p.status === 'approved' || p.status === 'paid'
        out.push({
          id: `ip-${plan.id}-${p.month}`,
          kind: 'installment',
          category: 'installment',
          title: `Facilité ${p.month} · ${plan.projectTitle || 'Plan'}`,
          sub: plan.projectCity || '',
          amount: Number(p.amount || 0),
          sign: settled ? '−' : '',
          iconType: settled ? 'out' : 'schedule',
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

  // Group filtered list by month for the statement-style layout.
  const groups = useMemo(() => {
    const map = new Map()
    for (const a of filtered) {
      const k = monthKey(a.dateIso)
      if (!map.has(k)) map.set(k, { key: k, label: monthLabel(a.dateIso), rows: [] })
      map.get(k).rows.push(a)
    }
    return Array.from(map.values())
  }, [filtered])

  const totals = useMemo(() => {
    let inflow = 0, outflow = 0
    for (const a of filtered) {
      if (a.sign === '+') inflow += Math.abs(a.amount)
      else if (a.sign === '−') outflow += Math.abs(a.amount)
    }
    return { inflow, outflow, net: inflow - outflow }
  }, [filtered])

  const statusLabels = {
    paid: { label: 'Payé', tone: 'zb-status-paid' },
    payable: { label: 'À virer', tone: 'zb-status-up' },
    cancelled: { label: 'Annulé', tone: 'zb-status-bad' },
    pending_review: { label: 'En revue', tone: 'zb-status-due' },
    approved: { label: 'Confirmé', tone: 'zb-status-paid' },
    rejected: { label: 'Refusé', tone: 'zb-status-bad' },
    submitted: { label: 'Reçu envoyé', tone: 'zb-status-up' },
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
        <p className="zb-greeting-sub">
          Chaque mouvement financier — commissions, retraits, et échéances
          que vous avez envoyées.
        </p>
      </div>

      {/* Totals rail — quick picture of what's in view */}
      <div className="ma-rail">
        <div className="ma-rail-cell">
          <div className="ma-rail-k">Entrées</div>
          <div className="ma-rail-v ma-pos">
            +{Math.round(totals.inflow).toLocaleString('fr-FR')}
            <span className="ma-rail-u">DT</span>
          </div>
        </div>
        <div className="ma-rail-cell">
          <div className="ma-rail-k">Sorties</div>
          <div className="ma-rail-v ma-neg">
            −{Math.round(totals.outflow).toLocaleString('fr-FR')}
            <span className="ma-rail-u">DT</span>
          </div>
        </div>
        <div className="ma-rail-cell">
          <div className="ma-rail-k">Net</div>
          <div className={`ma-rail-v ${totals.net >= 0 ? 'ma-pos' : 'ma-neg'}`}>
            {totals.net >= 0 ? '+' : '−'}
            {Math.round(Math.abs(totals.net)).toLocaleString('fr-FR')}
            <span className="ma-rail-u">DT</span>
          </div>
        </div>
      </div>

      {/* Filter chips */}
      <div className="zb-spark-tabs ma-tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={filter === t.key ? 'zb-active' : ''}
            onClick={() => setFilter(t.key)}
          >
            {t.label}
            {counts[t.key] > 0 && (
              <span className="ma-tab-count">{counts[t.key]}</span>
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
        {() => (
          <div className="ma-feed">
            {groups.map((g) => (
              <section key={g.key} className="ma-group">
                <header className="ma-group-head">
                  <span className="ma-group-label">{g.label}</span>
                  <span className="ma-group-count">{g.rows.length}</span>
                </header>
                <div className="ma-list">
                  {g.rows.map((a) => {
                    const st = statusLabels[a.status] || null
                    const amountClass =
                      a.sign === '+' ? 'ma-amount ma-pos'
                        : a.sign === '−' ? 'ma-amount ma-neg'
                          : 'ma-amount ma-muted'
                    const iconClass =
                      a.iconType === 'in' ? 'ma-ic ma-ic-in'
                        : a.iconType === 'out' ? 'ma-ic ma-ic-out'
                          : 'ma-ic ma-ic-schedule'
                    return (
                      <div key={a.id} className="ma-row">
                        <div className={iconClass} aria-hidden="true">
                          {a.iconType === 'in' && (
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 19V5M5 12l7 7 7-7" />
                            </svg>
                          )}
                          {a.iconType === 'out' && (
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 5v14M5 12l7-7 7 7" />
                            </svg>
                          )}
                          {a.iconType === 'schedule' && (
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="4" width="18" height="17" rx="2" />
                              <path d="M16 2v4M8 2v4M3 10h18" />
                            </svg>
                          )}
                        </div>
                        <div className="ma-body">
                          <div className="ma-title">{a.title}</div>
                          <div className="ma-meta">
                            <span className="ma-date">{dayLabel(a.dateIso)}</span>
                            {a.sub ? <span className="ma-dot">·</span> : null}
                            {a.sub ? <span className="ma-sub">{a.sub}</span> : null}
                            {st && (
                              <span className={`zb-status ${st.tone} ma-chip`}>{st.label}</span>
                            )}
                          </div>
                        </div>
                        <div className={amountClass}>
                          {a.sign}
                          {Math.round(Math.abs(a.amount)).toLocaleString('fr-FR')}
                          <span className="ma-unit">DT</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </RenderDataGate>
    </DashboardShell>
  )
}
