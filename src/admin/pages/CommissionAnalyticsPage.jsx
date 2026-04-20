import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useCommissionTracker } from '../lib/useCommissionTracker.js'
import { useToast } from '../components/AdminToast.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import './zitouna-admin-page.css'
import './commission-analytics.css'

// French helper for money formatting — matches the rest of the admin app.
function fmtMoney(v) {
  return `${(Number(v) || 0).toLocaleString('fr-FR')} TND`
}

// `paid_at` and status='paid' both signal a paid event — align with ledger/tracker.
function isPaidEvent(e) {
  return e?.status === 'paid' || Boolean(e?.paid_at || e?.paidAt)
}

function eventMonthKey(e) {
  const iso = e?.created_at || e?.createdAt
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

// Deterministic color from an id — used for project-slice coloring in the donut.
function hashColor(id) {
  const s = String(id || '')
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  const hue = ((h % 360) + 360) % 360
  return `hsl(${hue}, 62%, 48%)`
}

const LEVEL_COLORS = ['#2563eb', '#f59e0b', '#10b981', '#8b5cf6', '#64748b']

export default function CommissionAnalyticsPage() {
  const { data, loading, error, refresh } = useCommissionTracker()
  const { addToast } = useToast()

  const events = data?.commissionEvents || []
  const clients = data?.clients || []
  const sales = data?.sales || []
  const projects = data?.projects || []

  const clientById = useMemo(() => {
    const m = new Map()
    for (const c of clients) m.set(String(c.id), c)
    return m
  }, [clients])

  const saleById = useMemo(() => {
    const m = new Map()
    for (const s of sales) m.set(String(s.id), s)
    return m
  }, [sales])

  const projectById = useMemo(() => {
    const m = new Map()
    for (const p of projects) m.set(String(p.id), p)
    return m
  }, [projects])

  // ---- KPI totals --------------------------------------------------------
  const kpi = useMemo(() => {
    const benefSet = new Set()
    let credited = 0
    let paid = 0
    for (const e of events) {
      const amt = Number(e.amount) || 0
      if (e.status !== 'cancelled') credited += amt
      if (isPaidEvent(e)) paid += amt
      const bid = e.beneficiary_client_id || e.beneficiaryClientId
      if (bid) benefSet.add(String(bid))
    }
    return {
      total: events.length,
      credited,
      paid,
      beneficiaries: benefSet.size,
    }
  }, [events])

  // ---- Chart 1: cumulative TND over time ---------------------------------
  const timeSeries = useMemo(() => {
    const byMonth = new Map()
    for (const e of events) {
      if (e.status === 'cancelled') continue
      const key = eventMonthKey(e)
      if (!key) continue
      byMonth.set(key, (byMonth.get(key) || 0) + (Number(e.amount) || 0))
    }
    const months = [...byMonth.keys()].sort()
    const points = months.reduce((acc, m) => {
      const cumulative = (acc.at(-1)?.cumulative ?? 0) + (byMonth.get(m) || 0)
      acc.push({ month: m, cumulative })
      return acc
    }, [])
    const max = points.reduce((acc, p) => (p.cumulative > acc ? p.cumulative : acc), 0)
    return { points, max }
  }, [events])

  // ---- Chart 2: per-level distribution -----------------------------------
  const byLevel = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0] // L1, L2, L3, L4, L5+
    for (const e of events) {
      if (e.status === 'cancelled') continue
      const lvl = Math.max(1, Number(e.level) || 1)
      const idx = Math.min(lvl, 5) - 1
      buckets[idx] += Number(e.amount) || 0
    }
    const max = buckets.reduce((a, v) => (v > a ? v : a), 0)
    return { buckets, max }
  }, [events])

  // ---- Chart 3: top 10 beneficiaries -------------------------------------
  const topBeneficiaries = useMemo(() => {
    const sums = new Map()
    for (const e of events) {
      if (e.status === 'cancelled') continue
      const bid = String(e.beneficiary_client_id || e.beneficiaryClientId || '')
      if (!bid) continue
      sums.set(bid, (sums.get(bid) || 0) + (Number(e.amount) || 0))
    }
    const rows = [...sums.entries()].map(([bid, total]) => {
      const c = clientById.get(bid)
      return {
        id: bid,
        total,
        name: c?.full_name || c?.name || c?.code || 'Bénéficiaire inconnu',
        code: c?.code || '',
      }
    })
    rows.sort((a, b) => b.total - a.total)
    const top = rows.slice(0, 10)
    const max = top.reduce((a, r) => (r.total > a ? r.total : a), 0)
    return { rows: top, max }
  }, [events, clientById])

  // ---- Chart 4: per-project split ----------------------------------------
  const byProject = useMemo(() => {
    const sums = new Map()
    for (const e of events) {
      if (e.status === 'cancelled') continue
      const saleId = String(e.sale_id || e.saleId || '')
      const sale = saleId ? saleById.get(saleId) : null
      const pid = String(sale?.project_id || 'unknown')
      sums.set(pid, (sums.get(pid) || 0) + (Number(e.amount) || 0))
    }
    const rows = [...sums.entries()].map(([pid, total]) => {
      const p = pid === 'unknown' ? null : projectById.get(pid)
      return {
        id: pid,
        total,
        label: p?.title || (pid === 'unknown' ? 'Non rattaché' : `Projet ${pid.slice(0, 6)}`),
        color: pid === 'unknown' ? '#94a3b8' : hashColor(pid),
      }
    })
    rows.sort((a, b) => b.total - a.total)
    const total = rows.reduce((a, r) => a + r.total, 0)
    return { rows, total }
  }, [events, saleById, projectById])

  const hasEvents = events.length > 0

  const handleRefresh = async () => {
    try {
      await refresh()
      addToast('Analyses mises à jour', 'success')
    } catch {
      addToast('Erreur lors du rafraîchissement', 'error')
    }
  }

  // ---- SVG dimensions ----------------------------------------------------
  const CHART_W = 760
  const CHART_H = 220
  const PAD = { top: 16, right: 16, bottom: 32, left: 56 }

  // Build path for the cumulative line
  const linePath = useMemo(() => {
    const pts = timeSeries.points
    if (pts.length === 0) return ''
    const innerW = CHART_W - PAD.left - PAD.right
    const innerH = CHART_H - PAD.top - PAD.bottom
    const max = timeSeries.max || 1
    const step = pts.length > 1 ? innerW / (pts.length - 1) : 0
    return pts
      .map((p, i) => {
        const x = PAD.left + step * i
        const y = PAD.top + innerH - (p.cumulative / max) * innerH
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }, [timeSeries])

  const areaPath = useMemo(() => {
    const pts = timeSeries.points
    if (pts.length === 0) return ''
    const innerW = CHART_W - PAD.left - PAD.right
    const innerH = CHART_H - PAD.top - PAD.bottom
    const max = timeSeries.max || 1
    const step = pts.length > 1 ? innerW / (pts.length - 1) : 0
    const base = PAD.top + innerH
    const first = `M${PAD.left.toFixed(1)},${base.toFixed(1)}`
    const mids = pts
      .map((p, i) => {
        const x = PAD.left + step * i
        const y = PAD.top + innerH - (p.cumulative / max) * innerH
        return `L${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    const lastX = PAD.left + step * (pts.length - 1)
    return `${first} ${mids} L${lastX.toFixed(1)},${base.toFixed(1)} Z`
  }, [timeSeries])

  // Build donut slice paths (percentage-based)
  const donutSlices = useMemo(() => {
    const total = byProject.total || 0
    if (total <= 0) return []
    const cx = 110
    const cy = 110
    const r = 96
    const rInner = 58
    let cursor = -Math.PI / 2
    return byProject.rows.map((row) => {
      const frac = row.total / total
      const angle = frac * Math.PI * 2
      const end = cursor + angle
      const large = angle > Math.PI ? 1 : 0
      const x1 = cx + r * Math.cos(cursor)
      const y1 = cy + r * Math.sin(cursor)
      const x2 = cx + r * Math.cos(end)
      const y2 = cy + r * Math.sin(end)
      const x3 = cx + rInner * Math.cos(end)
      const y3 = cy + rInner * Math.sin(end)
      const x4 = cx + rInner * Math.cos(cursor)
      const y4 = cy + rInner * Math.sin(cursor)
      const d = `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${x3.toFixed(2)},${y3.toFixed(2)} A${rInner},${rInner} 0 ${large} 0 ${x4.toFixed(2)},${y4.toFixed(2)} Z`
      cursor = end
      return { ...row, path: d, pct: frac * 100 }
    })
  }, [byProject])

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">
        <div className="cli-hero" role="banner">
          <span className="cli-hero__badge" aria-hidden>Σ</span>
          <div>
            <h1 className="cli-hero__title">Analyses des commissions</h1>
            <p className="cli-hero__subtitle">
              Indicateurs, tendances et répartitions sur l'ensemble des commissions générées.
            </p>
          </div>
          <div className="cli-hero__actions">
            <button type="button" className="cli-hero__btn" onClick={handleRefresh}>
              Rafraîchir
            </button>
          </div>
        </div>

        {/* KPI bar renders even while loading — the tiles display 0 cleanly.
            Plan 03 §4.6: charts-or-empty ladder below is collapsed to a single
            <RenderDataGate> that also handles errors + slow-load banner. */}
        <div className="cli-stats">
          <div className="cli-stat cli-stat--info">
            <div className="cli-stat__label">Commissions totales</div>
            <div className="cli-stat__value">{kpi.total.toLocaleString('fr-FR')}</div>
          </div>
          <div className="cli-stat">
            <div className="cli-stat__label">TND crédités</div>
            <div className="cli-stat__value">{fmtMoney(kpi.credited)}</div>
          </div>
          <div className="cli-stat cli-stat--good">
            <div className="cli-stat__label">TND payés</div>
            <div className="cli-stat__value">{fmtMoney(kpi.paid)}</div>
          </div>
          <div className="cli-stat cli-stat--warn">
            <div className="cli-stat__label">Bénéficiaires</div>
            <div className="cli-stat__value">{kpi.beneficiaries.toLocaleString('fr-FR')}</div>
          </div>
        </div>

        <RenderDataGate
          loading={loading && !hasEvents}
          error={error}
          data={events}
          onRetry={() => refresh().catch(() => {})}
          skeleton="kpi"
          isEmpty={() => !hasEvents}
          empty={
            <div className="ca-card ca-card--top-gap">
              <EmptyState
                icon="📊"
                title="Aucune commission à analyser pour l'instant."
                description="Dès qu'une vente notariée générera une commission, les graphiques s'actualiseront."
              >
                <Link
                  to="/docs/COMMISSION_TRACKER.md"
                  className="ca-seed-link"
                  onClick={(e) => {
                    // Plain link to the seed doc — don't break SPA routing if absent.
                    e.preventDefault()
                    window.open('/docs/COMMISSION_TRACKER.md', '_blank', 'noopener')
                  }}
                >
                  Créer des données de test
                </Link>
              </EmptyState>
            </div>
          }
        >
          {() => (
          <div className="ca-grid">
            {/* Chart 1 — cumulative commissions over time */}
            <div className="ca-card ca-card--full">
              <h2 className="ca-card__title">Commissions cumulées dans le temps</h2>
              <p className="ca-card__subtitle">
                Montant cumulé (TND) par mois de création des événements.
              </p>
              {timeSeries.points.length === 0 ? (
                <div className="ca-empty">Pas assez de données temporelles.</div>
              ) : (
                <svg
                  className="ca-chart"
                  viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="Commissions cumulées dans le temps"
                >
                  {/* Y grid (4 steps) */}
                  {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                    const innerH = CHART_H - PAD.top - PAD.bottom
                    const y = PAD.top + innerH * (1 - t)
                    const val = (timeSeries.max || 0) * t
                    return (
                      <g key={t}>
                        <line
                          className="ca-grid-line"
                          x1={PAD.left}
                          x2={CHART_W - PAD.right}
                          y1={y}
                          y2={y}
                        />
                        <text className="ca-axis" x={PAD.left - 6} y={y + 3} textAnchor="end">
                          {fmtMoney(val)}
                        </text>
                      </g>
                    )
                  })}
                  {/* X labels (first, middle, last to avoid overlap) */}
                  {(() => {
                    const pts = timeSeries.points
                    const indices = pts.length <= 6 ? pts.map((_, i) => i) : [0, Math.floor(pts.length / 2), pts.length - 1]
                    const innerW = CHART_W - PAD.left - PAD.right
                    const step = pts.length > 1 ? innerW / (pts.length - 1) : 0
                    return indices.map((i) => {
                      const x = PAD.left + step * i
                      return (
                        <text
                          key={i}
                          className="ca-axis"
                          x={x}
                          y={CHART_H - PAD.bottom + 16}
                          textAnchor="middle"
                        >
                          {pts[i].month}
                        </text>
                      )
                    })
                  })()}
                  <path className="ca-area" d={areaPath} />
                  <path className="ca-line" d={linePath} />
                  {timeSeries.points.map((p, i) => {
                    const innerW = CHART_W - PAD.left - PAD.right
                    const innerH = CHART_H - PAD.top - PAD.bottom
                    const step = timeSeries.points.length > 1 ? innerW / (timeSeries.points.length - 1) : 0
                    const max = timeSeries.max || 1
                    const x = PAD.left + step * i
                    const y = PAD.top + innerH - (p.cumulative / max) * innerH
                    return <circle key={p.month} className="ca-dot" cx={x} cy={y} r={3} />
                  })}
                </svg>
              )}
            </div>

            {/* Chart 2 — per-level distribution */}
            <div className="ca-card">
              <h2 className="ca-card__title">Répartition par niveau</h2>
              <p className="ca-card__subtitle">Montants agrégés par profondeur de parrainage (L1..L5+).</p>
              {byLevel.buckets.every((v) => v === 0) ? (
                <div className="ca-empty">Aucune donnée par niveau.</div>
              ) : (
                byLevel.buckets.map((value, idx) => {
                  const label = idx === 4 ? 'L5+' : `L${idx + 1}`
                  const pct = byLevel.max > 0 ? (value / byLevel.max) * 100 : 0
                  return (
                    <div key={label} className="ca-hbar-row">
                      <div className="ca-hbar-label" style={{ color: LEVEL_COLORS[idx] }}>{label}</div>
                      <div className="ca-hbar-track">
                        <div
                          className="ca-hbar-fill"
                          style={{ width: `${pct}%`, background: LEVEL_COLORS[idx] }}
                        />
                      </div>
                      <div className="ca-hbar-amount">{fmtMoney(value)}</div>
                    </div>
                  )
                })
              )}
            </div>

            {/* Chart 3 — top 10 beneficiaries */}
            <div className="ca-card">
              <h2 className="ca-card__title">Top 10 bénéficiaires</h2>
              <p className="ca-card__subtitle">Les dix plus gros bénéficiaires par montant cumulé.</p>
              {topBeneficiaries.rows.length === 0 ? (
                <div className="ca-empty">Aucun bénéficiaire identifié.</div>
              ) : (
                topBeneficiaries.rows.map((row) => {
                  const pct = topBeneficiaries.max > 0 ? (row.total / topBeneficiaries.max) * 100 : 0
                  return (
                    <div key={row.id} className="ca-hbar-row ca-bene-row">
                      <div>
                        <div className="ca-bene-name" title={row.name}>{row.name}</div>
                        {row.code ? <div className="ca-bene-code">{row.code}</div> : null}
                      </div>
                      <div className="ca-hbar-track">
                        <div
                          className="ca-hbar-fill"
                          style={{ width: `${pct}%`, background: '#2563eb' }}
                        />
                      </div>
                      <div className="ca-hbar-amount">{fmtMoney(row.total)}</div>
                    </div>
                  )
                })
              )}
            </div>

            {/* Chart 4 — per-project split (donut) */}
            <div className="ca-card ca-card--full">
              <h2 className="ca-card__title">Répartition par projet</h2>
              <p className="ca-card__subtitle">Part des commissions rattachées à chaque projet notarié.</p>
              {donutSlices.length === 0 ? (
                <div className="ca-empty">Aucun projet rattaché aux commissions.</div>
              ) : (
                <div className="ca-donut-wrap">
                  <svg
                    viewBox="0 0 220 220"
                    width="220"
                    height="220"
                    role="img"
                    aria-label="Répartition des commissions par projet"
                  >
                    {donutSlices.map((slice) => (
                      <path
                        key={slice.id}
                        d={slice.path}
                        fill={slice.color}
                        stroke="#fff"
                        strokeWidth="1.5"
                      >
                        <title>{`${slice.label} — ${fmtMoney(slice.total)} (${slice.pct.toFixed(1)}%)`}</title>
                      </path>
                    ))}
                    <text x="110" y="108" textAnchor="middle" style={{ fontSize: 14, fontWeight: 700, fill: '#0f172a' }}>
                      {fmtMoney(byProject.total)}
                    </text>
                    <text x="110" y="126" textAnchor="middle" style={{ fontSize: 11, fill: '#64748b' }}>
                      total alloué
                    </text>
                  </svg>
                  <div className="ca-legend">
                    {donutSlices.map((slice) => (
                      <div key={slice.id} className="ca-legend-row">
                        <span className="ca-legend-swatch" style={{ background: slice.color }} />
                        <span className="ca-legend-label" title={slice.label}>{slice.label}</span>
                        <span className="ca-legend-value">
                          {fmtMoney(slice.total)} · {slice.pct.toFixed(1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          )}
        </RenderDataGate>
      </div>
    </div>
  )
}
