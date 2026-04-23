import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useCommissionTracker } from '../lib/useCommissionTracker.js'
import {
  asId,
  clientDisplayName,
  clientInitials,
  fmtDate,
  fmtMoney,
  fmtMoneyShort,
  normalizeStatus,
  rollupEvents,
  COMMISSION_LABEL,
  COMMISSION_TONE,
} from '../lib/commissionFormat.js'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import './commissions-overview.css'

const TOP_LIMIT = 8
const RECENT_LIMIT = 10

export default function CommissionsOverviewPage() {
  const navigate = useNavigate()
  const { data, loading, error, refresh } = useCommissionTracker()

  // Demo/seed clients are pruned so totals and top lists aren't polluted.
  const clean = useMemo(() => {
    if (!data) return data
    const demoIds = new Set()
    for (const c of data.clients || []) {
      const name = String(c.full_name || c.name || '')
      if (/\bDEMO\b/i.test(name)) demoIds.add(asId(c.id))
    }
    return {
      ...data,
      clients: (data.clients || []).filter((c) => !demoIds.has(asId(c.id))),
      sales: (data.sales || []).filter((s) => {
        const b = asId(s.client_id || s.clientId)
        const se = asId(s.seller_client_id || s.sellerClientId)
        return !demoIds.has(b) && !demoIds.has(se)
      }),
      commissionEvents: (data.commissionEvents || []).filter((e) => {
        const b = asId(e.beneficiary_client_id || e.beneficiaryClientId)
        return !demoIds.has(b)
      }),
    }
  }, [data])

  const events = clean?.commissionEvents
  const clientsList = clean?.clients

  const totals = useMemo(() => rollupEvents(events || []), [events])

  const clientsById = useMemo(() => {
    const m = new Map()
    for (const c of clientsList || []) m.set(asId(c.id), c)
    return m
  }, [clientsList])

  const topBeneficiaries = useMemo(() => {
    const byClient = new Map()
    for (const e of events || []) {
      const st = normalizeStatus(e)
      if (st === 'cancelled') continue
      const id = asId(e.beneficiary_client_id || e.beneficiaryClientId)
      if (!id) continue
      const prev = byClient.get(id) || { id, total: 0, paid: 0, unpaid: 0, count: 0 }
      const amt = Number(e.amount) || 0
      prev.total += amt
      prev.count += 1
      if (st === 'paid') prev.paid += amt
      else if (st === 'payable' || st === 'pending') prev.unpaid += amt
      byClient.set(id, prev)
    }
    return Array.from(byClient.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_LIMIT)
  }, [events])

  const recentEvents = useMemo(() => {
    return [...(events || [])]
      .sort((a, b) => {
        const ta = String(a.created_at || a.createdAt || '')
        const tb = String(b.created_at || b.createdAt || '')
        return tb.localeCompare(ta)
      })
      .slice(0, RECENT_LIMIT)
  }, [events])

  const statusBreakdown = useMemo(() => {
    const total = totals.total || 1
    return [
      { key: 'paid',     label: 'Payé',      amount: totals.paid,     pct: (totals.paid / total) * 100 },
      { key: 'payable',  label: 'À payer',   amount: totals.payable,  pct: (totals.payable / total) * 100 },
      { key: 'pending',  label: 'En attente', amount: totals.pending, pct: (totals.pending / total) * 100 },
    ]
  }, [totals])

  return (
    <div className="cov">
      <RenderDataGate
        loading={loading}
        error={error}
        data={clean}
        onRetry={() => refresh().catch(() => {})}
        skeleton="page"
        isEmpty={(d) => !d || (Array.isArray(d.commissionEvents) && d.commissionEvents.length === 0)}
        empty={
          <EmptyState
            icon="🌱"
            title="Aucune commission enregistrée"
            description="Les commissions apparaîtront ici dès qu'une vente avec vendeur client est finalisée au notariat."
            action={{
              label: 'Voir les ventes',
              onClick: () => navigate('/admin/sales'),
            }}
          />
        }
      >
        {() => (
          <>
            {/* ── KPI strip ─────────────────────────────────────────── */}
            <section className="cov__kpis" aria-label="Indicateurs clés">
              <KpiTile
                tone="warn"
                icon="⏳"
                label="À payer + en attente"
                value={fmtMoneyShort(totals.unpaid)}
                hint={`${fmtMoney(totals.payable)} à payer · ${fmtMoney(totals.pending)} en attente`}
                href="/admin/commissions/ledger"
              />
              <KpiTile
                tone="good"
                icon="✓"
                label="Déjà payé"
                value={fmtMoneyShort(totals.paid)}
                hint={`${totals.count} événements au total`}
              />
              <KpiTile
                tone="info"
                icon="👥"
                label="Bénéficiaires"
                value={String(totals.beneficiaries)}
                hint={`${(clean.clients || []).length} clients dans le réseau`}
                href="/admin/commissions/network"
              />
              <KpiTile
                tone="muted"
                icon="⚠"
                label="Anomalies"
                value="Diag."
                hint="Ventes inversées, cycles, orphelins"
                href="/admin/commissions/anomalies"
              />
            </section>

            {/* ── Status breakdown bar ──────────────────────────────── */}
            <section className="cov__section">
              <header className="cov__section-head">
                <h2 className="cov__section-title">Répartition des montants</h2>
                <span className="cov__section-sub">{fmtMoney(totals.total)} cumulés</span>
              </header>
              <div className="cov__bar" role="img" aria-label="Répartition payé / à payer / en attente">
                {statusBreakdown.map((s) =>
                  s.pct > 0 ? (
                    <span
                      key={s.key}
                      className={`cov__bar-seg cov__bar-seg--${s.key}`}
                      style={{ width: `${s.pct}%` }}
                      title={`${s.label} — ${fmtMoney(s.amount)} (${s.pct.toFixed(1)}%)`}
                    />
                  ) : null,
                )}
              </div>
              <ul className="cov__bar-legend">
                {statusBreakdown.map((s) => (
                  <li key={s.key} className={`cov__bar-li cov__bar-li--${s.key}`}>
                    <span className="cov__bar-dot" aria-hidden />
                    <span className="cov__bar-label">{s.label}</span>
                    <span className="cov__bar-amt">{fmtMoney(s.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* ── Two-column: top beneficiaries + recent events ─────── */}
            <div className="cov__grid">
              <section className="cov__section">
                <header className="cov__section-head">
                  <h2 className="cov__section-title">Top bénéficiaires</h2>
                  <Link to="/admin/commissions/ledger" className="cov__link">Voir le journal →</Link>
                </header>
                {topBeneficiaries.length === 0 ? (
                  <p className="cov__empty">Aucun bénéficiaire pour le moment.</p>
                ) : (
                  <ul className="cov__top">
                    {topBeneficiaries.map((row, i) => {
                      const c = clientsById.get(row.id)
                      const name = clientDisplayName(c) || row.id
                      return (
                        <li key={row.id} className="cov__top-row">
                          <span className="cov__top-rank">{i + 1}</span>
                          <span className="cov__top-avatar" aria-hidden>{clientInitials(c || { name })}</span>
                          <div className="cov__top-main">
                            <button
                              type="button"
                              className="cov__top-name"
                              onClick={() => navigate(`/admin/commissions/network?focus=${encodeURIComponent(row.id)}`)}
                              title="Ouvrir dans le réseau"
                            >
                              {name}
                            </button>
                            <span className="cov__top-sub">
                              {row.count} événement{row.count > 1 ? 's' : ''}
                              {row.unpaid > 0 ? ` · ${fmtMoneyShort(row.unpaid)} dû` : ''}
                            </span>
                          </div>
                          <div className="cov__top-amt">{fmtMoneyShort(row.total)}</div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>

              <section className="cov__section">
                <header className="cov__section-head">
                  <h2 className="cov__section-title">Événements récents</h2>
                  <Link to="/admin/commissions/ledger" className="cov__link">Journal complet →</Link>
                </header>
                {recentEvents.length === 0 ? (
                  <p className="cov__empty">Aucun événement récent.</p>
                ) : (
                  <ul className="cov__recent">
                    {recentEvents.map((e) => {
                      const st = normalizeStatus(e)
                      const bid = asId(e.beneficiary_client_id || e.beneficiaryClientId)
                      const c = clientsById.get(bid)
                      const name = clientDisplayName(c) || bid || '—'
                      const level = Number(e.level) || 1
                      return (
                        <li key={e.id} className="cov__recent-row">
                          <span className={`cov__recent-lvl cov__recent-lvl--l${Math.min(level, 4)}`}>L{level}</span>
                          <div className="cov__recent-main">
                            <span className="cov__recent-name">{name}</span>
                            <span className="cov__recent-sub">{fmtDate(e.created_at || e.createdAt)}</span>
                          </div>
                          <span className="cov__recent-amt">{fmtMoney(e.amount)}</span>
                          <span className={`cov__recent-st cov__recent-st--${COMMISSION_TONE[st]}`}>
                            {COMMISSION_LABEL[st]}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </RenderDataGate>
    </div>
  )
}

function KpiTile({ tone, icon, label, value, hint, href }) {
  const Inner = (
    <>
      <span className={`cov__kpi-icon cov__kpi-icon--${tone}`} aria-hidden>{icon}</span>
      <span className="cov__kpi-label">{label}</span>
      <span className="cov__kpi-value">{value}</span>
      {hint ? <span className="cov__kpi-hint">{hint}</span> : null}
      {href ? <span className="cov__kpi-chev" aria-hidden>→</span> : null}
    </>
  )
  if (href) {
    return (
      <Link to={href} className={`cov__kpi cov__kpi--${tone} cov__kpi--link`}>
        {Inner}
      </Link>
    )
  }
  return <div className={`cov__kpi cov__kpi--${tone}`}>{Inner}</div>
}
