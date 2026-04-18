import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useCommissionTracker } from '../lib/useCommissionTracker.js'
import * as tree from '../lib/referralTree.js'
import CommissionNodeGraph from '../components/CommissionNodeGraph.jsx'
import CommissionEventDetailModal from '../components/CommissionEventDetailModal.jsx'
import CommissionOverrideModal from '../components/CommissionOverrideModal.jsx'
import DownlinePerformanceTable from '../components/DownlinePerformanceTable.jsx'
import { useToast } from '../components/AdminToast.jsx'
import { useAuth } from '../../lib/AuthContext.jsx'
import './zitouna-admin-page.css'
import './commission-tracker.css'

// --------------------------------------------------------------------------
// Formatting & small helpers
// --------------------------------------------------------------------------

// Single source of truth for money formatting so every tile / row is identical.
function fmtMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0 TND'
  return `${n.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} TND`
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso)
  }
}

// Relative "il y a X" date helper. Falls back to absolute date past 30 days.
function fmtRelativeDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const diffMs = Date.now() - d.getTime()
  const diffDays = Math.floor(diffMs / 86_400_000)
  if (diffDays <= 0) return "aujourd'hui"
  if (diffDays === 1) return 'hier'
  if (diffDays < 30) return `il y a ${diffDays} j`
  return fmtDate(iso)
}

function absIso(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString()
}

function statusLabel(s) {
  const m = { pending: 'En attente', payable: 'À payer', paid: 'Payé', cancelled: 'Annulé' }
  return m[s] || s || '—'
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

// Inline SVG "copy" icon matching the Coordination/Notary admin button family.
// Stroke uses currentColor so it inherits the button's text colour.
function CopyIcon({ size = 14 }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

// Paid events are tracked both via status='paid' and paid_at; treat either as paid.
function isPaidEvent(e) {
  return e?.status === 'paid' || Boolean(e?.paid_at || e?.paidAt)
}

// Status pill built from CSS tokens (no inline colours).
function StatusPill({ status }) {
  return (
    <span className={`ct-status-pill ct-status--${status || 'pending'}`}>
      <span aria-hidden className="ct-status-pill__dot" />
      {statusLabel(status)}
    </span>
  )
}

function LevelPill({ level }) {
  const lvl = Number(level) || 0
  // Level palette must stay aligned with CommissionNodeGraph:
  // L1=blue, L2=amber, L3=green, L4+=violet.
  const cls = lvl >= 4
    ? 'ct-level-pill-sm--l4'
    : lvl === 3
      ? 'ct-level-pill-sm--l3'
      : lvl === 2
        ? 'ct-level-pill-sm--l2'
        : 'ct-level-pill-sm--l1'
  return (
    <span
      className={`ct-level-pill-sm ${cls}`}
      title={lvl >= 2 ? `Commission de niveau ${lvl}` : 'Commission de niveau 1 (parrain direct)'}
    >
      L{Math.max(lvl, 1)}
    </span>
  )
}

// --------------------------------------------------------------------------
// URL sync — one-shot helper that merges patches into searchParams and also
// deletes any keys whose value is an empty string or null.
// --------------------------------------------------------------------------

function mergeParams(sp, patch) {
  const next = new URLSearchParams(sp)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') next.delete(k)
    else next.set(k, String(v))
  }
  return next
}

// Preset date ranges used by the quick-filter chips. Values are days to look back
// (null = all-time). 30 is the default per the redesign brief.
const RANGE_PRESETS = [
  { key: '7', label: '7 j', days: 7 },
  { key: '30', label: '30 j', days: 30 },
  { key: '90', label: '90 j', days: 90 },
  { key: '365', label: 'Année', days: 365 },
  { key: 'all', label: 'Tout', days: null },
]

const STATUS_OPTIONS = [
  { key: 'pending', label: 'En attente' },
  { key: 'payable', label: 'À payer' },
  { key: 'paid', label: 'Payé' },
  { key: 'cancelled', label: 'Annulé' },
]

const LEVEL_OPTIONS = [
  { key: '1', label: 'L1' },
  { key: '2', label: 'L2' },
  { key: '3', label: 'L3+' },
]

const PAGE_SIZE = 50

// Plain-French explanations shown behind the small "i" icon on each KPI tile.
const KPI_INFO = {
  events: 'Nombre de lignes de commission générées sur la période filtrée.',
  l1: 'Montant des commissions directes (parrain de niveau 1) sur la période filtrée.',
  l2: 'Montant des commissions indirectes (niveau 2 et au-delà) sur la période filtrée.',
  due: 'Commissions à payer : en attente ou validées, mais pas encore réglées.',
  paid: 'Commissions marquées comme payées sur la période filtrée.',
  beneficiaries: 'Nombre de bénéficiaires distincts ayant reçu au moins une commission.',
}

// Tab keys also used as URL values.
const TABS = [
  { key: 'overview', label: "Vue d'ensemble" },
  { key: 'graph', label: 'Arbre parrainage' },
  { key: 'events', label: 'Événements' },
  { key: 'downline', label: 'Filleuls' },
]

// --------------------------------------------------------------------------
// Sparkline — 30-day cumulative series, pure inline SVG. Peaks highlighted.
// --------------------------------------------------------------------------

function Sparkline({ points, previousPoints }) {
  const [hover, setHover] = useState(null) // index of the hovered point or null
  const svgRef = useRef(null)

  if (!points || points.length === 0) {
    return (
      <div className="ct-trend__wrap">
        <svg className="ct-trend__svg" viewBox="0 0 300 40" role="img" aria-label="Aucune tendance">
          <line x1="0" y1="38" x2="300" y2="38" stroke="#e2e8f0" strokeWidth="1" />
        </svg>
      </div>
    )
  }
  const width = 300
  const height = 40
  // Share the Y scale between both series so the comparison reads correctly.
  const prevArr = Array.isArray(previousPoints) ? previousPoints : []
  const maxY = Math.max(
    1,
    ...points.map((p) => p.cumulative),
    ...prevArr.map((p) => p.cumulative || 0),
  )
  const stepX = width / Math.max(points.length - 1, 1)
  const coords = points.map((p, i) => ({
    x: i * stepX,
    y: height - 2 - (p.cumulative / maxY) * (height - 6),
    cumulative: p.cumulative,
    date: p.date,
    daily: p.daily,
  }))
  // Align previous-window points against the current bucket count so both
  // paths span the same horizontal range (width).
  const prevCoords = prevArr.length ? prevArr.map((p, i) => ({
    x: i * (width / Math.max(prevArr.length - 1, 1)),
    y: height - 2 - ((p.cumulative || 0) / maxY) * (height - 6),
    cumulative: p.cumulative || 0,
    date: p.date,
  })) : []
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const prevLinePath = prevCoords.length
    ? prevCoords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
    : ''
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`
  const peakIndex = coords.reduce((best, c, i) => (c.cumulative > coords[best].cumulative ? i : best), 0)
  const peak = coords[peakIndex]
  const peakLabel = peak ? `${peak.date}: ${fmtMoney(peak.cumulative)}` : ''

  // Translate an SVG-level mouse event into the nearest bucket index so the
  // tooltip tracks the pointer even though the path is stretched to 100% width.
  function handleMove(e) {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0) return
    const pxRatio = width / rect.width
    const local = (e.clientX - rect.left) * pxRatio
    const idx = Math.max(0, Math.min(coords.length - 1, Math.round(local / stepX)))
    setHover(idx)
  }
  function handleLeave() { setHover(null) }
  const active = hover != null ? coords[hover] : null

  return (
    <div className="ct-trend__wrap">
      <svg
        ref={svgRef}
        className="ct-trend__svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Tendance cumulée 30 jours. Plus haut: ${peakLabel}`}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        <path className="ct-trend__area" d={areaPath} />
        {prevLinePath ? (
          <path
            className="ct-trend__prev-path"
            d={prevLinePath}
            aria-label="Comparaison avec la période précédente"
          >
            <title>Période précédente</title>
          </path>
        ) : null}
        <path className="ct-trend__path" d={linePath} />
        {peak ? (
          <circle className="ct-trend__peak" cx={peak.x} cy={peak.y} r="2.5">
            <title>{peakLabel}</title>
          </circle>
        ) : null}
        {active ? (
          <>
            <line
              className="ct-trend__cursor"
              x1={active.x}
              x2={active.x}
              y1="0"
              y2={height}
            />
            <circle className="ct-trend__dot" cx={active.x} cy={active.y} r="3" />
          </>
        ) : null}
      </svg>
      {active ? (
        <div
          className="ct-trend__tooltip"
          style={{ left: `${(active.x / width) * 100}%` }}
          role="status"
        >
          <strong>{active.date}</strong>
          <span>Cumulé : {fmtMoney(active.cumulative)}</span>
          <span className="ct-trend__tooltip-sub">+ {fmtMoney(active.daily)} ce jour</span>
        </div>
      ) : null}
    </div>
  )
}

// --------------------------------------------------------------------------
// CSV export — builds a client-side blob of the currently visible events.
// --------------------------------------------------------------------------

function exportEventsToCsv(rows) {
  if (!rows || rows.length === 0) return null
  const header = ['Date', 'Beneficiaire', 'Code beneficiaire', 'Vente', 'Projet', 'Niveau', 'Montant', 'Statut']
  const escape = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      r.createdAt ? new Date(r.createdAt).toISOString() : '',
      r.beneficiaryName || '',
      r.beneficiaryCode || '',
      r.saleCode || '',
      r.projectName || '',
      `L${r.level || 1}`,
      (Number(r.amount) || 0).toFixed(2),
      statusLabel(r.status),
    ].map(escape).join(','))
  }
  return new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
}

// --------------------------------------------------------------------------
// Page component
// --------------------------------------------------------------------------

export default function CommissionTrackerPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { addToast } = useToast()
  const { data, loading, error, refresh } = useCommissionTracker()
  const { adminUser } = useAuth()

  // URL-synced filter state. The page is now fixed on the referral graph view,
  // so `tab` is locked to 'graph' — other tab JSX branches remain in the file
  // for quick restore but never render.
  const tab = 'graph'
  const range = searchParams.get('range') || '30'
  const projectParam = searchParams.get('project') || ''
  const statusParam = searchParams.get('status') || '' // comma-separated
  const levelParam = searchParams.get('level') || '' // comma-separated
  const qParam = searchParams.get('q') || ''
  const sortParam = searchParams.get('sort') || 'date:desc'
  const page = Math.max(1, Number(searchParams.get('page') || '1') | 0)
  const beneficiaryParam = searchParams.get('beneficiary') || ''

  const [search, setSearch] = useState(qParam)
  // Keep the text input in sync if the URL changes (e.g. back/forward navigation).
  useEffect(() => { setSearch(qParam) }, [qParam])

  // Graph-tab local state.
  const [graphMode, setGraphMode] = useState('global') // 'global' | 'byClient'
  const [selectedClientId, setSelectedClientId] = useState(null)

  // Event detail side panel + override modal.
  const [detailEventId, setDetailEventId] = useState(null)
  const [overrideEvent, setOverrideEvent] = useState(null)
  const [fullDetail, setFullDetail] = useState(false) // "Ouvrir en plein" -> modal

  // Menu dropdown (other views).
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = () => setMenuOpen(false)
    window.addEventListener('click', onDoc)
    return () => window.removeEventListener('click', onDoc)
  }, [menuOpen])

  // ------------------------------------------------------------------------
  // URL sync helpers — keep state shareable across refresh / back navigation.
  // ------------------------------------------------------------------------
  const updateParams = useCallback((patch) => {
    setSearchParams((sp) => mergeParams(sp, patch), { replace: true })
  }, [setSearchParams])

  const setRange = useCallback((next) => updateParams({ range: next, page: '' }), [updateParams])
  const setProject = useCallback((next) => updateParams({ project: next, page: '' }), [updateParams])
  const toggleStatus = useCallback((key) => {
    const current = statusParam ? statusParam.split(',').filter(Boolean) : []
    const next = current.includes(key) ? current.filter((x) => x !== key) : [...current, key]
    updateParams({ status: next.join(','), page: '' })
  }, [statusParam, updateParams])
  const toggleLevel = useCallback((key) => {
    const current = levelParam ? levelParam.split(',').filter(Boolean) : []
    const next = current.includes(key) ? current.filter((x) => x !== key) : [...current, key]
    updateParams({ level: next.join(','), page: '' })
  }, [levelParam, updateParams])

  // Debounce the search box -> URL sync at 250 ms so each keystroke does not re-render.
  useEffect(() => {
    if (search === qParam) return
    const t = window.setTimeout(() => updateParams({ q: search, page: '' }), 250)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // ------------------------------------------------------------------------
  // Hide demo/seed fixtures from the commissions view. A client is treated as
  // demo when the word "DEMO" appears anywhere in their name.
  // ------------------------------------------------------------------------
  const demoClientIds = useMemo(() => {
    const s = new Set()
    for (const c of data?.clients || []) {
      const name = String(c.full_name || c.name || '')
      if (/\bDEMO\b/i.test(name)) s.add(String(c.id))
    }
    return s
  }, [data?.clients])

  // ------------------------------------------------------------------------
  // Indexes — built once per data payload, demo clients pruned out.
  // ------------------------------------------------------------------------
  const clientById = useMemo(() => {
    const m = new Map()
    for (const c of data?.clients || []) {
      if (demoClientIds.has(String(c.id))) continue
      m.set(String(c.id), c)
    }
    return m
  }, [data?.clients, demoClientIds])

  const saleById = useMemo(() => {
    const m = new Map()
    for (const s of data?.sales || []) {
      const buyerId = String(s.client_id || s.clientId || '')
      const sellerId = String(s.seller_client_id || s.sellerClientId || '')
      if (demoClientIds.has(buyerId) || demoClientIds.has(sellerId)) continue
      m.set(String(s.id), s)
    }
    return m
  }, [data?.sales, demoClientIds])

  const projectById = useMemo(() => {
    const m = new Map()
    for (const p of data?.projects || []) m.set(String(p.id), p)
    return m
  }, [data?.projects])

  // Cleaned payload forwarded to CommissionNodeGraph so demo clients and any
  // commission events tied to them disappear from the tree + KPIs.
  const cleanData = useMemo(() => {
    if (!data) return data
    return {
      ...data,
      clients: (data.clients || []).filter((c) => !demoClientIds.has(String(c.id))),
      sales: (data.sales || []).filter((s) => {
        const buyerId = String(s.client_id || s.clientId || '')
        const sellerId = String(s.seller_client_id || s.sellerClientId || '')
        return !demoClientIds.has(buyerId) && !demoClientIds.has(sellerId)
      }),
      commissionEvents: (data.commissionEvents || []).filter((e) => {
        const b = String(e.beneficiary_client_id || e.beneficiaryClientId || '')
        const p = String(e.payer_client_id || e.payerClientId || '')
        return !demoClientIds.has(b) && !demoClientIds.has(p)
      }),
    }
  }, [data, demoClientIds])

  // ------------------------------------------------------------------------
  // Decorated events — join beneficiary, sale, project metadata once so
  // every downstream useMemo can share the same shape.
  // ------------------------------------------------------------------------
  const decoratedEvents = useMemo(() => {
    const events = data?.commissionEvents || []
    return events.filter((e) => {
      // Drop events whose beneficiary or payer is a demo fixture.
      const b = String(e.beneficiary_client_id || e.beneficiaryClientId || '')
      const p = String(e.payer_client_id || e.payerClientId || '')
      return !demoClientIds.has(b) && !demoClientIds.has(p)
    }).map((e) => {
      const beneficiaryId = String(e.beneficiary_client_id || e.beneficiaryClientId || '')
      const saleId = String(e.sale_id || e.saleId || '')
      const client = beneficiaryId ? clientById.get(beneficiaryId) : null
      const sale = saleId ? saleById.get(saleId) : null
      const projectId = sale?.project_id ? String(sale.project_id) : ''
      const project = projectId ? projectById.get(projectId) : null
      return {
        id: String(e.id),
        raw: e, // preserved so the override modal receives the full row.
        level: Number(e.level) || 1,
        amount: Number(e.amount) || 0,
        status: e.status || 'pending',
        createdAt: e.created_at || e.createdAt || null,
        beneficiaryId,
        beneficiaryName: client?.full_name || client?.name || 'Bénéficiaire inconnu',
        beneficiaryCode: client?.code || '',
        saleId,
        saleCode: sale?.code || '',
        projectId,
        projectName: project?.title || (projectId ? `Projet ${projectId.slice(0, 6)}` : ''),
        agreedPrice: Number(sale?.agreed_price) || 0,
      }
    })
  }, [data?.commissionEvents, clientById, saleById, projectById, demoClientIds])

  // ------------------------------------------------------------------------
  // Filter windowing helpers. Previous window = same length preceding current.
  // ------------------------------------------------------------------------
  const { rangeStart, prevStart, prevEnd } = useMemo(() => {
    const preset = RANGE_PRESETS.find((p) => p.key === range)
    const days = preset?.days ?? null
    const now = Date.now()
    if (!days) return { rangeStart: null, prevStart: null, prevEnd: null }
    const start = now - days * 86_400_000
    const prevE = start
    const prevS = start - days * 86_400_000
    return { rangeStart: start, prevStart: prevS, prevEnd: prevE }
  }, [range])

  const statusSet = useMemo(() => new Set(statusParam ? statusParam.split(',').filter(Boolean) : []), [statusParam])
  const levelSet = useMemo(() => new Set(levelParam ? levelParam.split(',').filter(Boolean) : []), [levelParam])

  function matchesLevel(ev) {
    if (levelSet.size === 0) return true
    if (levelSet.has('1') && ev.level === 1) return true
    if (levelSet.has('2') && ev.level === 2) return true
    if (levelSet.has('3') && ev.level >= 3) return true
    return false
  }

  // ------------------------------------------------------------------------
  // Filtered events — the heart of every tab's aggregates.
  // ------------------------------------------------------------------------
  const filteredEvents = useMemo(() => {
    const q = qParam.trim().toLowerCase()
    const beneFocus = beneficiaryParam ? String(beneficiaryParam) : null
    return decoratedEvents.filter((ev) => {
      if (rangeStart !== null) {
        const t = ev.createdAt ? new Date(ev.createdAt).getTime() : 0
        if (!t || t < rangeStart) return false
      }
      if (projectParam && ev.projectId !== projectParam) return false
      if (statusSet.size > 0 && !statusSet.has(ev.status)) return false
      if (!matchesLevel(ev)) return false
      if (beneFocus && ev.beneficiaryId !== beneFocus) return false
      if (q) {
        const hay = `${ev.beneficiaryName} ${ev.beneficiaryCode} ${ev.saleCode} ${ev.projectName}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoratedEvents, rangeStart, projectParam, statusSet, levelSet, qParam, beneficiaryParam])

  // Same filters applied to the previous equivalent window for KPI deltas.
  const previousWindowEvents = useMemo(() => {
    if (prevStart === null || prevEnd === null) return []
    const q = qParam.trim().toLowerCase()
    return decoratedEvents.filter((ev) => {
      const t = ev.createdAt ? new Date(ev.createdAt).getTime() : 0
      if (!t || t < prevStart || t >= prevEnd) return false
      if (projectParam && ev.projectId !== projectParam) return false
      if (statusSet.size > 0 && !statusSet.has(ev.status)) return false
      if (!matchesLevel(ev)) return false
      if (q) {
        const hay = `${ev.beneficiaryName} ${ev.beneficiaryCode} ${ev.saleCode} ${ev.projectName}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoratedEvents, prevStart, prevEnd, projectParam, statusSet, levelSet, qParam])

  // ------------------------------------------------------------------------
  // KPI tiles — 6 per the brief.
  // ------------------------------------------------------------------------
  function aggregate(events) {
    const acc = { total: 0, directL1: 0, indirectL2: 0, payable: 0, paid: 0, amount: 0, beneficiaries: new Set() }
    for (const e of events) {
      acc.total += 1
      const amt = e.amount
      acc.amount += amt
      if (e.level === 1) acc.directL1 += amt
      if (e.level >= 2) acc.indirectL2 += amt
      if (!isPaidEvent(e.raw) && e.status !== 'cancelled') acc.payable += amt
      if (isPaidEvent(e.raw)) acc.paid += amt
      if (e.beneficiaryId) acc.beneficiaries.add(e.beneficiaryId)
    }
    return {
      total: acc.total,
      directL1: acc.directL1,
      indirectL2: acc.indirectL2,
      payable: acc.payable,
      paid: acc.paid,
      amount: acc.amount,
      beneficiariesCount: acc.beneficiaries.size,
    }
  }
  const kpi = useMemo(() => aggregate(filteredEvents), [filteredEvents])
  const prevKpi = useMemo(() => aggregate(previousWindowEvents), [previousWindowEvents])

  // Percent delta helper (returns null when the previous window has no data).
  function pctDelta(current, previous) {
    if (!previous) return null
    const diff = current - previous
    if (!previous) return null
    return (diff / previous) * 100
  }

  // ------------------------------------------------------------------------
  // NEW useMemo #2 — Top 10 beneficiaries by total amount over filtered set.
  // Also tracks L1 / L2+ event counts per beneficiary so the overview card
  // can compute a "conversion rate" multiplier and label upline-pure clients.
  // ------------------------------------------------------------------------
  const topBeneficiaries = useMemo(() => {
    const byId = new Map()
    for (const ev of filteredEvents) {
      if (!ev.beneficiaryId) continue
      const bucket = byId.get(ev.beneficiaryId) || {
        id: ev.beneficiaryId,
        name: ev.beneficiaryName,
        code: ev.beneficiaryCode,
        l1: 0,
        l2plus: 0,
        total: 0,
        events: 0,
        l1Events: 0,
        l2plusEvents: 0,
      }
      if (ev.level === 1) { bucket.l1 += ev.amount; bucket.l1Events += 1 }
      else { bucket.l2plus += ev.amount; bucket.l2plusEvents += 1 }
      bucket.total += ev.amount
      bucket.events += 1
      byId.set(ev.beneficiaryId, bucket)
    }
    return Array.from(byId.values())
      .map((b) => {
        // Classify:
        //   - multiplicateur: L2+ events / L1 events >= 2 (indirect network dominates)
        //   - upline pur: no L1 event at all, only inherits from the network
        //   - equilibre: falls between the two
        let ratio = null
        let kind = 'equilibre'
        if (b.l1Events === 0 && b.l2plusEvents > 0) {
          kind = 'upline'
        } else if (b.l1Events > 0) {
          ratio = b.l2plusEvents / b.l1Events
          if (ratio >= 2) kind = 'multiplicateur'
          else if (ratio <= 0.25) kind = 'direct'
        }
        return { ...b, ratio, kind }
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
  }, [filteredEvents])

  // ------------------------------------------------------------------------
  // NEW useMemo #3 — Top 5 projects by total commission volume.
  // ------------------------------------------------------------------------
  const topProjects = useMemo(() => {
    const byId = new Map()
    let grandTotal = 0
    for (const ev of filteredEvents) {
      grandTotal += ev.amount
      const key = ev.projectId || 'unknown'
      const bucket = byId.get(key) || {
        id: ev.projectId,
        name: ev.projectName || (key === 'unknown' ? 'Sans projet' : key),
        events: 0,
        volume: 0,
      }
      bucket.events += 1
      bucket.volume += ev.amount
      byId.set(key, bucket)
    }
    const list = Array.from(byId.values()).sort((a, b) => b.volume - a.volume).slice(0, 5)
    return list.map((p) => ({ ...p, pct: grandTotal > 0 ? (p.volume / grandTotal) * 100 : 0 }))
  }, [filteredEvents])

  // ------------------------------------------------------------------------
  // NEW useMemo #4 — Sorted events for the Événements tab (driven by ?sort=).
  // ------------------------------------------------------------------------
  const sortedEvents = useMemo(() => {
    const [key, dirRaw] = String(sortParam || 'date:desc').split(':')
    const dir = dirRaw === 'asc' ? 1 : -1
    const get = (row) => {
      switch (key) {
        case 'date': return row.createdAt ? new Date(row.createdAt).getTime() : 0
        case 'beneficiary': return String(row.beneficiaryName || '').toLowerCase()
        case 'sale': return String(row.saleCode || '').toLowerCase()
        case 'project': return String(row.projectName || '').toLowerCase()
        case 'level': return row.level || 0
        case 'amount': return row.amount || 0
        case 'status': return String(row.status || '')
        default: return 0
      }
    }
    return [...filteredEvents].sort((a, b) => {
      const va = get(a)
      const vb = get(b)
      if (va === vb) return 0
      return va > vb ? dir : -dir
    })
  }, [filteredEvents, sortParam])

  const pagedEvents = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return sortedEvents.slice(start, start + PAGE_SIZE)
  }, [sortedEvents, page])
  const pageCount = Math.max(1, Math.ceil(sortedEvents.length / PAGE_SIZE))

  // Project <select> options — de-dup across sales + projects payload.
  const projectOptions = useMemo(() => {
    const seen = new Map()
    for (const p of data?.projects || []) seen.set(String(p.id), p.title || String(p.id))
    for (const s of data?.sales || []) {
      if (!s?.project_id) continue
      const pid = String(s.project_id)
      if (!seen.has(pid)) seen.set(pid, pid)
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [data?.projects, data?.sales])

  // ------------------------------------------------------------------------
  // Event handlers
  // ------------------------------------------------------------------------

  const handleRefresh = useCallback(async () => {
    try {
      await refresh()
      addToast('Données rechargées', 'success')
    } catch {
      addToast('Impossible de recharger', 'error')
    }
  }, [refresh, addToast])

  const handleExport = useCallback(() => {
    const blob = exportEventsToCsv(sortedEvents)
    if (!blob) {
      addToast('Aucun événement à exporter', 'info')
      return
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `commissions-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [sortedEvents, addToast])

  const handleCopySaleCode = useCallback(async (code) => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      addToast('Code copié', 'success')
    } catch {
      addToast('Impossible de copier', 'error')
    }
  }, [addToast])

  const handleSortClick = useCallback((key) => {
    const [currentKey, currentDir] = String(sortParam || 'date:desc').split(':')
    const nextDir = currentKey === key ? (currentDir === 'asc' ? 'desc' : 'asc') : 'desc'
    updateParams({ sort: `${key}:${nextDir}` })
  }, [sortParam, updateParams])

  const handleBeneficiaryFocus = useCallback((id) => {
    updateParams({ tab: 'events', beneficiary: id, page: '' })
  }, [updateParams])

  const handleOverrideSaved = useCallback(() => {
    setOverrideEvent(null)
    refresh().catch(() => {})
    addToast('Commission ajustée', 'success')
  }, [refresh, addToast])

  // ------------------------------------------------------------------------
  // Derived helpers for graph + downline tabs.
  // ------------------------------------------------------------------------
  const selectedClient = selectedClientId ? clientById.get(String(selectedClientId)) : null
  const beneficiaryFocusClient = beneficiaryParam ? clientById.get(String(beneficiaryParam)) : null

  // Downline tab root client — reuse the same beneficiary param so focusing a
  // row anywhere on the page deep-links into the correct downline view.
  const [downlineRoot, setDownlineRoot] = useState('')
  const [downlineSearch, setDownlineSearch] = useState('')
  useEffect(() => {
    if (beneficiaryParam && tab === 'downline') setDownlineRoot(beneficiaryParam)
  }, [beneficiaryParam, tab])

  const downlineClientList = useMemo(() => {
    const q = downlineSearch.trim().toLowerCase()
    const base = data?.clients || []
    if (!q) return base.slice(0, 50)
    return base.filter((c) => {
      const hay = `${c.full_name || ''} ${c.name || ''} ${c.code || ''} ${c.phone || ''}`.toLowerCase()
      return hay.includes(q)
    }).slice(0, 50)
  }, [data?.clients, downlineSearch])

  // Upline chain for the current downline root.
  const uplineChain = useMemo(() => {
    if (!downlineRoot) return []
    const parentMap = tree.buildParentMap(data?.sellerRelations || [])
    const ids = tree.resolveUplineChain(downlineRoot, parentMap)
    return ids.map((id) => clientById.get(String(id)) || { id, full_name: String(id) })
  }, [downlineRoot, data?.sellerRelations, clientById])

  const activeEvent = detailEventId
    ? decoratedEvents.find((e) => e.id === String(detailEventId)) || null
    : null

  const canOverride = Boolean(adminUser?.id)

  // ------------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------------
  const activeStatusList = statusParam ? statusParam.split(',').filter(Boolean) : []
  const activeLevelList = levelParam ? levelParam.split(',').filter(Boolean) : []
  const hasAnyEvents = decoratedEvents.length > 0
  // Anything other than the default 30-day range counts as "active" so the
  // reset button shows as soon as an admin starts narrowing the view.
  const hasActiveFilters = (
    range !== '30'
    || Boolean(projectParam)
    || activeStatusList.length > 0
    || activeLevelList.length > 0
    || Boolean(qParam)
    || Boolean(beneficiaryParam)
  )
  const handleResetFilters = () => {
    setSearch('')
    updateParams({ range: '30', project: '', status: '', level: '', q: '', beneficiary: '', page: '' })
  }

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">
        <button
          type="button"
          className="ds-back-btn"
          onClick={() => navigate(-1)}
          title="Revenir à la page précédente"
        >
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        {/* ----------------------------------------------------------------
            Header — title + actions (refresh / other views / export)
           ---------------------------------------------------------------- */}
        <header className="ct-header">
          <div>
            <h1 className="ct-header__title">Suivi des commissions</h1>
            <p className="ct-header__subtitle">
              Explorez chaque événement de commission, l'arbre des parrainages et le volume par projet.
            </p>
          </div>
          <div className="ct-header__actions">
            <button
              type="button"
              className="adm-btn adm-btn--secondary"
              onClick={handleRefresh}
              aria-label="Actualiser les données"
              title="Actualiser les données"
              disabled={loading}
            >
              {loading ? 'Chargement…' : 'Actualiser'}
            </button>
            <div
              className="ct-header__dropdown"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="adm-btn adm-btn--secondary"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                Autres vues ▾
              </button>
              {menuOpen ? (
                <div className="ct-header__menu" role="menu">
                  <Link to="/admin/commissions/analytics" role="menuitem">Analytique</Link>
                  <Link to="/admin/commissions/anomalies" role="menuitem">Anomalies</Link>
                  <Link to="/admin/commission-ledger" role="menuitem">Grand livre</Link>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="adm-btn adm-btn--primary"
              onClick={handleExport}
              aria-label="Exporter les événements visibles"
              title="Exporter les événements visibles"
              disabled={sortedEvents.length === 0}
            >
              Exporter
            </button>
          </div>
        </header>

        {error ? (
          <div className="ct-banner" role="alert">
            <span>Erreur lors du chargement : {error.message || 'inconnue'}</span>
            <button type="button" className="adm-btn adm-btn--secondary" onClick={handleRefresh}>
              Réessayer
            </button>
          </div>
        ) : null}

        {/* ----------------------------------------------------------------
            Quick filters — date range, project, status, level, search.
            All wired to one URL sync so back/forward restores the view.
           ---------------------------------------------------------------- */}
        <div className="ct-filters" role="group" aria-label="Filtres rapides">
          <div className="ct-filters__group" aria-label="Plage de dates">
            <span className="ct-filters__label">Période</span>
            {RANGE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={`ct-chip ${range === preset.key ? 'ct-chip--active' : ''}`}
                onClick={() => setRange(preset.key)}
                aria-pressed={range === preset.key}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="ct-filters__group">
            <span className="ct-filters__label">Projet</span>
            <select
              className="zitu-page__select"
              value={projectParam}
              onChange={(e) => setProject(e.target.value)}
              aria-label="Filtrer par projet"
              style={{ minWidth: 160 }}
            >
              <option value="">Tous les projets</option>
              {projectOptions.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>

          <div className="ct-filters__group" aria-label="Statut">
            <span className="ct-filters__label">Statut</span>
            <div className="ct-multi" role="group">
              {STATUS_OPTIONS.map((opt) => {
                const on = activeStatusList.includes(opt.key)
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className={`ct-multi__btn ${on ? 'ct-multi__btn--on' : ''}`}
                    onClick={() => toggleStatus(opt.key)}
                    aria-pressed={on}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="ct-filters__group" aria-label="Niveau">
            <span className="ct-filters__label">Niveau</span>
            <div className="ct-multi" role="group">
              {LEVEL_OPTIONS.map((opt) => {
                const on = activeLevelList.includes(opt.key)
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className={`ct-multi__btn ${on ? 'ct-multi__btn--on' : ''}`}
                    onClick={() => toggleLevel(opt.key)}
                    aria-pressed={on}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="ct-filters__group" style={{ flexGrow: 1, minWidth: 180 }}>
            <input
              className="zitu-page__search"
              style={{ width: '100%' }}
              placeholder="Nom, code, vente, projet…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Rechercher une commission"
            />
          </div>

          {beneficiaryParam && beneficiaryFocusClient ? (
            <span className="ct-selected-chip" title="Bénéficiaire ciblé">
              {beneficiaryFocusClient.full_name || beneficiaryFocusClient.name || beneficiaryParam}
              <button
                type="button"
                className="ct-selected-chip__clear"
                onClick={() => updateParams({ beneficiary: '' })}
                aria-label="Retirer le filtre bénéficiaire"
              >
                ✕
              </button>
            </span>
          ) : null}
          {hasActiveFilters ? (
            <button
              type="button"
              className="ct-reset-btn"
              onClick={handleResetFilters}
              aria-label="Réinitialiser tous les filtres"
              title="Réinitialiser tous les filtres"
            >
              ↺ Réinitialiser
            </button>
          ) : null}
        </div>

        {/* ----------------------------------------------------------------
            KPI strip (6 tiles) + sparkline
           ---------------------------------------------------------------- */}
        <div className="ct-kpi-6" role="group" aria-label="Statistiques des commissions">
          {loading && !hasAnyEvents ? (
            <>
              <KpiTile loading /><KpiTile loading /><KpiTile loading />
              <KpiTile loading /><KpiTile loading /><KpiTile loading />
            </>
          ) : (
            <>
              <KpiTile
                label="Événements"
                info={`${KPI_INFO.events}\nMoyenne par événement : ${fmtMoney(kpi.total > 0 ? kpi.amount / kpi.total : 0)}`}
                value={kpi.total.toLocaleString('fr-FR')}
                delta={pctDelta(kpi.total, prevKpi.total)}
              />
              <KpiTile
                label="Direct (L1)"
                info={`${KPI_INFO.l1}\nPart du total : ${kpi.amount > 0 ? ((kpi.directL1 / kpi.amount) * 100).toFixed(1) : '0.0'} %`}
                variant="l1"
                value={<>{(kpi.directL1 || 0).toLocaleString('fr-FR')}<span className="ct-kpi-6__unit">TND</span></>}
                delta={pctDelta(kpi.directL1, prevKpi.directL1)}
              />
              <KpiTile
                label="Indirect (L2+)"
                info={`${KPI_INFO.l2}\nPart du total : ${kpi.amount > 0 ? ((kpi.indirectL2 / kpi.amount) * 100).toFixed(1) : '0.0'} %`}
                variant="l2"
                value={<>{(kpi.indirectL2 || 0).toLocaleString('fr-FR')}<span className="ct-kpi-6__unit">TND</span></>}
                delta={pctDelta(kpi.indirectL2, prevKpi.indirectL2)}
              />
              <KpiTile label="Montant dû" info={KPI_INFO.due} variant="info" value={<>{(kpi.payable || 0).toLocaleString('fr-FR')}<span className="ct-kpi-6__unit">TND</span></>} delta={pctDelta(kpi.payable, prevKpi.payable)} />
              <KpiTile label="Payé" info={KPI_INFO.paid} variant="good" value={<>{(kpi.paid || 0).toLocaleString('fr-FR')}<span className="ct-kpi-6__unit">TND</span></>} delta={pctDelta(kpi.paid, prevKpi.paid)} />
              <KpiTile label="Bénéficiaires" info={KPI_INFO.beneficiaries} value={kpi.beneficiariesCount.toLocaleString('fr-FR')} delta={pctDelta(kpi.beneficiariesCount, prevKpi.beneficiariesCount)} />
            </>
          )}
        </div>


        {/* ----------------------------------------------------------------
            Tab A — Vue d'ensemble: Top bénéficiaires + Top projets
           ---------------------------------------------------------------- */}
        {tab === 'overview' ? (
          <section className="ct-overview" role="tabpanel" aria-label="Vue d'ensemble">
            <article className="ct-card ct-top-people">
              <h2 className="ct-card__title">
                Top 10 bénéficiaires
                <span className="ct-badge-muted">{topBeneficiaries.length}</span>
              </h2>
              {topBeneficiaries.length === 0 ? (
                <EmptyState
                  hasData={hasAnyEvents}
                  hasFilters={hasActiveFilters}
                  onResetFilters={handleResetFilters}
                  seedNote="Aucune donnée pour l'instant. Créez des ventes de démonstration via docs/05_seed.sql pour voir les commissions."
                  filteredNote="Aucun bénéficiaire ne correspond aux filtres actuels."
                />
              ) : (
                <table className="ct-top-people__table">
                  <thead>
                    <tr>
                      <th>Bénéficiaire</th>
                      <th className="ct-hidden-xs">Code</th>
                      <th className="ct-num">L1</th>
                      <th className="ct-num">L2+</th>
                      <th className="ct-num">Total</th>
                      <th className="ct-num">Évt.</th>
                      <th className="ct-hidden-xs" aria-label="Actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {topBeneficiaries.map((r) => (
                      <tr
                        key={r.id}
                        className="ct-top-people__row"
                        role="button"
                        tabIndex={0}
                        title={`Voir les événements de ${r.name}`}
                        onClick={() => handleBeneficiaryFocus(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            handleBeneficiaryFocus(r.id)
                          }
                        }}
                      >
                        <td>
                          <span className="ct-top-people__avatar" aria-hidden>{initials(r.name)}</span>
                          {r.name}
                        </td>
                        <td className="ct-mono ct-hidden-xs">{r.code || '—'}</td>
                        <td className="ct-num">{fmtMoney(r.l1)}</td>
                        <td className="ct-num">{fmtMoney(r.l2plus)}</td>
                        <td className="ct-num"><strong>{fmtMoney(r.total)}</strong></td>
                        <td className="ct-num">{r.events}</td>
                        <td className="ct-hidden-xs" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="ct-action-btn ct-action-btn--ghost"
                            onClick={() => {
                              setDownlineRoot(r.id)
                              updateParams({ tab: 'downline', beneficiary: r.id })
                            }}
                            title={`Voir les filleuls de ${r.name}`}
                            aria-label={`Voir les filleuls de ${r.name}`}
                          >
                            Filleuls →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>

            <article className="ct-card ct-top-projects">
              <h2 className="ct-card__title">
                Top 5 projets
                <span className="ct-badge-muted">{topProjects.length}</span>
              </h2>
              {topProjects.length === 0 ? (
                <EmptyState
                  hasData={hasAnyEvents}
                  hasFilters={hasActiveFilters}
                  onResetFilters={handleResetFilters}
                  seedNote="Aucun projet avec commission. Ajoutez une vente rattachée à un projet pour peupler ce palmarès."
                  filteredNote="Aucun projet ne correspond aux filtres actuels."
                />
              ) : (
                <table className="ct-top-projects__table">
                  <thead>
                    <tr>
                      <th>Projet</th>
                      <th className="ct-num">Évt.</th>
                      <th className="ct-num">Volume</th>
                      <th>Part</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topProjects.map((p) => (
                      <tr
                        key={p.id || 'unknown'}
                        className="ct-top-projects__row"
                        role="button"
                        tabIndex={0}
                        title={`Filtrer les événements par ${p.name}`}
                        onClick={() => {
                          if (p.id) updateParams({ project: p.id, tab: 'events' })
                        }}
                        onKeyDown={(e) => {
                          if ((e.key === 'Enter' || e.key === ' ') && p.id) {
                            e.preventDefault()
                            updateParams({ project: p.id, tab: 'events' })
                          }
                        }}
                      >
                        <td>{p.name}</td>
                        <td className="ct-num">{p.events}</td>
                        <td className="ct-num"><strong>{fmtMoney(p.volume)}</strong></td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div className="ct-bar" style={{ flexGrow: 1 }}>
                              <div className="ct-bar__fill" style={{ width: `${Math.min(100, p.pct).toFixed(1)}%` }} />
                            </div>
                            <span style={{ fontSize: 12, color: '#475569', minWidth: 42, textAlign: 'right' }}>
                              {p.pct.toFixed(1)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>
          </section>
        ) : null}

        {/* ----------------------------------------------------------------
            Tab B — Arbre de parrainage (CommissionNodeGraph)
           ---------------------------------------------------------------- */}
        {tab === 'graph' ? (
          <section role="tabpanel" aria-label="Arbre de parrainage">
            <div className="ct-graph-toolbar">
              <div className="ct-multi" role="group" aria-label="Mode du graphe">
                <button
                  type="button"
                  className={`ct-multi__btn ${graphMode === 'global' ? 'ct-multi__btn--on' : ''}`}
                  onClick={() => setGraphMode('global')}
                  aria-pressed={graphMode === 'global'}
                >
                  Global
                </button>
                <button
                  type="button"
                  className={`ct-multi__btn ${graphMode === 'byClient' ? 'ct-multi__btn--on' : ''}`}
                  onClick={() => setGraphMode('byClient')}
                  aria-pressed={graphMode === 'byClient'}
                >
                  Focus client
                </button>
              </div>
              {graphMode === 'byClient' && selectedClient ? (
                <span className="ct-selected-chip" title="Client sélectionné">
                  {selectedClient.full_name || selectedClient.name || selectedClientId}
                  <button
                    type="button"
                    className="ct-selected-chip__clear"
                    onClick={() => setSelectedClientId(null)}
                    aria-label="Effacer la sélection du graphe"
                  >
                    ✕
                  </button>
                </span>
              ) : null}
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>
                Cliquez un nœud pour sélectionner, double-cliquez pour afficher les filleuls.
              </span>
            </div>
            <div className="ct-graph-box--tracker" aria-label="Graphe des parrainages">
              {loading && !hasAnyEvents ? (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 14 }}>
                  Chargement…
                </div>
              ) : (
                <CommissionNodeGraph
                  data={cleanData}
                  selectedClientId={selectedClientId}
                  mode={graphMode}
                  onNodeClick={(id) => setSelectedClientId(id)}
                />
              )}
            </div>
          </section>
        ) : null}

        {/* ----------------------------------------------------------------
            Tab C — Événements (sortable table, row click -> side panel)
           ---------------------------------------------------------------- */}
        {tab === 'events' ? (
          <section role="tabpanel" aria-label="Événements">
            <div className="ct-events-card">
              <div className="ct-events-scroll">
                <table className="ct-events-table" role="grid" aria-label="Événements de commission">
                  <thead>
                    <tr>
                      <SortableTh sortParam={sortParam} onSort={handleSortClick} columnKey="date">Date</SortableTh>
                      <SortableTh sortParam={sortParam} onSort={handleSortClick} columnKey="beneficiary">Bénéficiaire</SortableTh>
                      <SortableTh sortParam={sortParam} onSort={handleSortClick} columnKey="sale">Vente</SortableTh>
                      <SortableTh sortParam={sortParam} onSort={handleSortClick} columnKey="project" className="ct-hidden-xs">Projet</SortableTh>
                      <SortableTh sortParam={sortParam} onSort={handleSortClick} columnKey="level" align="center">Niveau</SortableTh>
                      <SortableTh sortParam={sortParam} onSort={handleSortClick} columnKey="amount" align="right">Montant</SortableTh>
                      <SortableTh sortParam={sortParam} onSort={handleSortClick} columnKey="status">Statut</SortableTh>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && !hasAnyEvents ? (
                      <>
                        {[0, 1, 2, 3, 4].map((i) => (
                          <tr key={`sk-${i}`} className="ct-events-table__skeleton-row">
                            <td colSpan={8}><div className="ct-skeleton-bar" /></td>
                          </tr>
                        ))}
                      </>
                    ) : pagedEvents.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <EmptyState
                            hasData={hasAnyEvents}
                            hasFilters={hasActiveFilters}
                            onResetFilters={handleResetFilters}
                            seedNote="Aucun événement de commission pour l'instant. Créez des ventes de démonstration via docs/05_seed.sql."
                            filteredNote="Aucun événement ne correspond aux filtres actuels."
                          />
                        </td>
                      </tr>
                    ) : pagedEvents.map((row) => (
                      <tr
                        key={row.id}
                        onClick={() => { setDetailEventId(row.id); setFullDetail(false) }}
                      >
                        <td title={absIso(row.createdAt)}>{fmtRelativeDate(row.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="ct-action-btn ct-action-btn--ghost"
                            onClick={(e) => { e.stopPropagation(); handleBeneficiaryFocus(row.beneficiaryId) }}
                            style={{ padding: 0 }}
                            title="Filtrer sur ce bénéficiaire"
                            aria-label={`Filtrer sur ${row.beneficiaryName}`}
                          >
                            <strong style={{ color: '#0f172a' }}>{row.beneficiaryName}</strong>
                          </button>
                          {row.beneficiaryCode ? (
                            <div className="ct-mono" style={{ fontSize: 11, color: '#64748b' }}>
                              {row.beneficiaryCode}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {row.saleCode ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <span className="ct-mono">{row.saleCode}</span>
                              <button
                                type="button"
                                className="ct-copy-btn"
                                onClick={(e) => { e.stopPropagation(); handleCopySaleCode(row.saleCode) }}
                                aria-label="Copier le code vente"
                                title="Copier le code vente"
                              >⧉</button>
                            </span>
                          ) : '—'}
                        </td>
                        <td className="ct-hidden-xs">{row.projectName || '—'}</td>
                        <td style={{ textAlign: 'center' }}><LevelPill level={row.level} /></td>
                        <td className="ct-num"><strong>{fmtMoney(row.amount)}</strong></td>
                        <td><StatusPill status={row.status} /></td>
                        <td>
                          <div className="ct-events-table__actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="ct-action-btn ct-action-btn--primary"
                              onClick={() => { setDetailEventId(row.id); setFullDetail(false) }}
                              aria-label={`Voir le détail de la commission pour ${row.beneficiaryName}`}
                              title="Voir le détail"
                            >
                              Détail
                            </button>
                            {canOverride ? (
                              <button
                                type="button"
                                className="ct-action-btn"
                                onClick={() => setOverrideEvent(row.raw)}
                                aria-label={`Ajuster la commission de ${row.beneficiaryName}`}
                                title="Ajuster la commission"
                              >
                                ✏ Ajuster
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="ct-footer">
              <div>
                {sortedEvents.length > 0
                  ? `Affichage ${(page - 1) * PAGE_SIZE + 1} – ${Math.min(page * PAGE_SIZE, sortedEvents.length)} sur ${sortedEvents.length}`
                  : 'Aucun événement'}
              </div>
              <div className="ct-footer__pager" aria-label="Pagination">
                <button
                  type="button"
                  className="ct-footer__btn"
                  disabled={page <= 1}
                  onClick={() => updateParams({ page: String(Math.max(1, page - 1)) })}
                  aria-label="Page précédente"
                >
                  ← Précédent
                </button>
                <span>Page {page} / {pageCount}</span>
                <button
                  type="button"
                  className="ct-footer__btn"
                  disabled={page >= pageCount}
                  onClick={() => updateParams({ page: String(Math.min(pageCount, page + 1)) })}
                  aria-label="Page suivante"
                >
                  Suivant →
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {/* ----------------------------------------------------------------
            Tab D — Filleuls d'un client (DownlinePerformanceTable)
           ---------------------------------------------------------------- */}
        {tab === 'downline' ? (
          <section role="tabpanel" aria-label="Filleuls d'un client">
            <div className="ct-card" style={{ marginBottom: 12 }}>
              <h2 className="ct-card__title">
                Choisir un parrain
                {downlineRoot ? (
                  <button
                    type="button"
                    className="adm-btn adm-btn--secondary"
                    onClick={() => { setDownlineRoot(''); updateParams({ beneficiary: '' }) }}
                    aria-label="Retirer la sélection parrain"
                  >
                    Effacer la sélection
                  </button>
                ) : null}
              </h2>
              <input
                className="zitu-page__search"
                placeholder="Rechercher un parrain (nom, code, téléphone)…"
                value={downlineSearch}
                onChange={(e) => setDownlineSearch(e.target.value)}
                aria-label="Rechercher un parrain"
                style={{ marginBottom: 10 }}
              />
              {downlineClientList.length === 0 ? (
                <div className="ct-card__empty">Aucun client ne correspond à la recherche.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {downlineClientList.slice(0, 20).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`ct-chip ${String(downlineRoot) === String(c.id) ? 'ct-chip--active' : ''}`}
                      onClick={() => { setDownlineRoot(c.id); updateParams({ beneficiary: c.id }) }}
                      aria-pressed={String(downlineRoot) === String(c.id)}
                    >
                      {c.full_name || c.name || c.code || c.id}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {downlineRoot ? (
              <>
                {uplineChain.length > 1 ? (
                  <nav className="ct-upline" aria-label="Chaîne de parrainage ascendante">
                    {uplineChain.slice().reverse().map((c, i, arr) => (
                      <span key={String(c.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span className="ct-upline__step">
                          L{arr.length - 1 - i} · {c.full_name || c.name || c.code || c.id}
                        </span>
                        {i < arr.length - 1 ? <span className="ct-upline__sep">›</span> : null}
                      </span>
                    ))}
                  </nav>
                ) : null}
                <div className="ct-card">
                  <DownlinePerformanceTable
                    rootClientId={downlineRoot}
                    data={data}
                    onNodeClick={(id) => { setDownlineRoot(id); updateParams({ beneficiary: id }) }}
                  />
                </div>
              </>
            ) : (
              <div className="ct-card" role="status">
                <EmptyState
                  hasData={hasAnyEvents}
                  hasFilters={false}
                  filteredNote="Sélectionnez un parrain ci-dessus pour afficher ses filleuls et leurs performances."
                  seedNote="Aucun client enregistré. Ajoutez d'abord un client parrain pour consulter son réseau."
                />
              </div>
            )}
          </section>
        ) : null}
      </div>

      {/* -----------------------------------------------------------------
          Side panel for event detail. Reuses the data already fetched so
          no extra round-trip. Falls back to centered modal when the user
          explicitly promotes it via "Ouvrir en plein".
         ----------------------------------------------------------------- */}
      {detailEventId && !fullDetail && activeEvent ? (
        <div className="ct-panel-backdrop" role="dialog" aria-label="Détail de la commission" onClick={() => setDetailEventId(null)}>
          <aside className="ct-panel" onClick={(e) => e.stopPropagation()}>
            <header className="ct-panel__header">
              <h3 className="ct-panel__title">Détail commission</h3>
              <button
                type="button"
                className="ct-panel__close"
                onClick={() => setDetailEventId(null)}
                aria-label="Fermer le panneau"
              >×</button>
            </header>
            <div className="ct-panel__body">
              <EventDetailPanel
                event={activeEvent}
                clientById={clientById}
                sellerRelations={data?.sellerRelations || []}
                projectById={projectById}
                saleById={saleById}
                onCopySaleCode={handleCopySaleCode}
              />
            </div>
            <footer className="ct-panel__footer">
              {canOverride ? (
                <button
                  type="button"
                  className="adm-btn adm-btn--secondary"
                  onClick={() => { setOverrideEvent(activeEvent.raw); setDetailEventId(null) }}
                >
                  ✏ Ajuster
                </button>
              ) : null}
              <button
                type="button"
                className="adm-btn adm-btn--secondary"
                onClick={() => setFullDetail(true)}
              >
                Ouvrir en plein
              </button>
              <button
                type="button"
                className="adm-btn adm-btn--primary"
                onClick={() => setDetailEventId(null)}
              >
                Fermer
              </button>
            </footer>
          </aside>
        </div>
      ) : null}

      {/* Full-screen fallback modal (delegated to the shared component). */}
      <CommissionEventDetailModal
        eventId={fullDetail ? detailEventId : null}
        open={Boolean(fullDetail && detailEventId)}
        onClose={() => { setFullDetail(false); setDetailEventId(null) }}
        data={data}
      />

      {/* Staff-only override modal. Wired from event actions + side panel. */}
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

// --------------------------------------------------------------------------
// Sub-components kept in-file for locality (each <80 lines).
// --------------------------------------------------------------------------

function KpiTile({ label, value, variant, delta, info, loading }) {
  const variantCls = variant ? `ct-kpi-6__value--${variant}` : ''
  let deltaCls = ''
  let deltaLabel = null
  if (delta !== null && delta !== undefined && Number.isFinite(delta)) {
    const rounded = Math.round(delta)
    if (rounded > 0) { deltaCls = 'ct-kpi-6__delta--up'; deltaLabel = `▲ ${rounded}%` }
    else if (rounded < 0) { deltaCls = 'ct-kpi-6__delta--down'; deltaLabel = `▼ ${Math.abs(rounded)}%` }
    else { deltaLabel = '= 0%' }
  }
  if (loading) {
    return (
      <div className="ct-kpi-6__tile ct-kpi-6__tile--skeleton" aria-busy="true">
        <div className="ct-kpi-6__skeleton-label" />
        <div className="ct-kpi-6__skeleton-value" />
        <div className="ct-kpi-6__skeleton-delta" />
      </div>
    )
  }
  return (
    <div className="ct-kpi-6__tile">
      <div className="ct-kpi-6__label">
        <span className="ct-kpi-6__label-text" title={label}>{label}</span>
        {info ? (
          <span
            className="ct-kpi-6__info"
            role="img"
            aria-label={info}
            title={info}
            tabIndex={0}
          >
            i
          </span>
        ) : null}
      </div>
      <div className={`ct-kpi-6__value ${variantCls}`}>{value}</div>
      <div className={`ct-kpi-6__delta ${deltaCls}`}>
        {deltaLabel || '—'} <span style={{ color: '#94a3b8', fontWeight: 500 }}>vs précédent</span>
      </div>
    </div>
  )
}

// Friendly empty / first-run state shared by every tab. Distinguishes "no data
// at all in the database" from "filters hid every row", so the admin knows
// whether to seed demo data or tweak their filters.
function EmptyState({ hasData, hasFilters, onResetFilters, seedNote, filteredNote }) {
  const showReset = hasFilters && typeof onResetFilters === 'function'
  const message = hasData ? filteredNote : seedNote
  return (
    <div className="ct-empty" role="status">
      <div className="ct-empty__icon" aria-hidden>✨</div>
      <div className="ct-empty__message">{message}</div>
      {showReset ? (
        <button type="button" className="ct-reset-btn ct-reset-btn--cta" onClick={onResetFilters}>
          ↺ Réinitialiser les filtres
        </button>
      ) : !hasData ? (
        <a
          className="ct-empty__link"
          href="https://github.com/"
          onClick={(e) => e.preventDefault()}
          title="Voir docs/05_seed.sql pour peupler la base"
        >
          Voir docs/05_seed.sql
        </a>
      ) : null}
    </div>
  )
}

function SortableTh({ columnKey, sortParam, onSort, children, align, className }) {
  const [curKey, curDir] = String(sortParam || 'date:desc').split(':')
  const active = curKey === columnKey
  const arrow = !active ? '' : (curDir === 'asc' ? '▲' : '▼')
  const style = align === 'right' ? { textAlign: 'right' } : align === 'center' ? { textAlign: 'center' } : undefined
  return (
    <th
      style={style}
      className={className}
      role="columnheader"
      aria-sort={active ? (curDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="ct-action-btn ct-action-btn--ghost"
        onClick={() => onSort(columnKey)}
        style={{ fontWeight: 600, padding: 0, background: 'transparent' }}
      >
        {children}
        {arrow ? <span className="ct-events-table__sort">{arrow}</span> : null}
      </button>
    </th>
  )
}

function EventDetailPanel({ event, clientById, sellerRelations, projectById, saleById, onCopySaleCode }) {
  if (!event) return null
  const sale = event.saleId ? saleById.get(event.saleId) : null
  const project = event.projectId ? projectById.get(event.projectId) : null
  const parentMap = tree.buildParentMap(sellerRelations)
  const uplineIds = event.beneficiaryId ? tree.resolveUplineChain(event.beneficiaryId, parentMap) : []
  const uplineLabels = uplineIds
    .map((id) => clientById.get(String(id)))
    .map((c) => c?.full_name || c?.name || c?.code || '')
    .filter(Boolean)
  return (
    <>
      <section className="ct-panel__section">
        <div className="ct-panel__section-title">Événement</div>
        <div className="ct-panel__row"><span className="ct-panel__row-label">Niveau</span><span className="ct-panel__row-value"><LevelPill level={event.level} /></span></div>
        <div className="ct-panel__row"><span className="ct-panel__row-label">Montant</span><span className="ct-panel__row-value">{fmtMoney(event.amount)}</span></div>
        <div className="ct-panel__row"><span className="ct-panel__row-label">Statut</span><span className="ct-panel__row-value"><StatusPill status={event.status} /></span></div>
        <div className="ct-panel__row"><span className="ct-panel__row-label">Créé le</span><span className="ct-panel__row-value" title={absIso(event.createdAt)}>{fmtRelativeDate(event.createdAt)}</span></div>
      </section>
      <section className="ct-panel__section">
        <div className="ct-panel__section-title">Bénéficiaire</div>
        <div className="ct-panel__row"><span className="ct-panel__row-label">Nom</span><span className="ct-panel__row-value">{event.beneficiaryName}</span></div>
        <div className="ct-panel__row"><span className="ct-panel__row-label">Code</span><span className="ct-panel__row-value ct-mono">{event.beneficiaryCode || '—'}</span></div>
      </section>
      <section className="ct-panel__section">
        <div className="ct-panel__section-title">Vente</div>
        <div className="ct-panel__row">
          <span className="ct-panel__row-label">Code vente</span>
          <span className="ct-panel__row-value ct-mono" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            {event.saleCode || '—'}
            {event.saleCode ? (
              <button
                type="button"
                className="ct-copy-btn"
                onClick={() => onCopySaleCode(event.saleCode)}
                aria-label="Copier le code vente"
                title="Copier le code vente"
              >⧉</button>
            ) : null}
          </span>
        </div>
        <div className="ct-panel__row"><span className="ct-panel__row-label">Projet</span><span className="ct-panel__row-value">{project?.title || event.projectName || '—'}</span></div>
        <div className="ct-panel__row"><span className="ct-panel__row-label">Prix convenu</span><span className="ct-panel__row-value">{fmtMoney(event.agreedPrice || sale?.agreed_price || 0)}</span></div>
      </section>
      <section className="ct-panel__section">
        <div className="ct-panel__section-title">Chaîne parrainage</div>
        {uplineLabels.length ? (
          <div className="ct-panel__chain">
            {uplineLabels.map((label, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span className="ct-panel__chain-step">L{i} · {label}</span>
                {i < uplineLabels.length - 1 ? <span className="ct-panel__chain-sep">›</span> : null}
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#64748b' }}>Pas de chaîne de parrainage disponible.</div>
        )}
      </section>
    </>
  )
}
