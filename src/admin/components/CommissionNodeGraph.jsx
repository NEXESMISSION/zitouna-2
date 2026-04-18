import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as tree from '../lib/referralTree.js'

// =============================================================================
// Visual constants
// =============================================================================

const COL_STEP = 220 // horizontal spacing per depth (wider: we show numbers)
const ROW_STEP = 96 // vertical spacing per row (taller: 2-line labels + badges)
const MARGIN_X = 70
const MARGIN_Y = 60
const BASE_RADIUS = 14
const MAX_RADIUS_BONUS = 24
const COMMISSION_SCALE = 500 // TND per radius-unit bonus

const ZOOM_MIN = 0.3
const ZOOM_MAX = 4
const ZOOM_STEP = 0.15

const COLOR_MUTED = '#cbd5e1'
const COLOR_TEXT = '#0f172a'
const COLOR_TEXT_MUTED = '#94a3b8'
const COLOR_EDGE = '#cbd5e1'
const COLOR_EDGE_ACTIVE = '#1d4ed8'

// Depth palette — matches commission-tracker.css L1–L4+ pills.
const LEVEL_COLORS = {
  0: '#1e40af', // root — deep blue
  1: '#2563eb', // L1 — blue
  2: '#f59e0b', // L2 — amber
  3: '#10b981', // L3 — green
  4: '#8b5cf6', // L4 — violet
}
const LEVEL_FALLBACK_COLOR = '#64748b'
function colorForDepth(depth) {
  return LEVEL_COLORS[depth] ?? LEVEL_FALLBACK_COLOR
}

// Gains gradient (low → high).  Green → yellow → red.
const GAIN_STOPS = [
  { t: 0.0, c: '#94a3b8' }, // slate when zero
  { t: 0.15, c: '#10b981' }, // green
  { t: 0.55, c: '#f59e0b' }, // amber
  { t: 1.0, c: '#dc2626' }, // red
]

function lerpHex(a, b, t) {
  const ah = a.replace('#', '')
  const bh = b.replace('#', '')
  const ar = parseInt(ah.slice(0, 2), 16)
  const ag = parseInt(ah.slice(2, 4), 16)
  const ab = parseInt(ah.slice(4, 6), 16)
  const br = parseInt(bh.slice(0, 2), 16)
  const bg = parseInt(bh.slice(2, 4), 16)
  const bb = parseInt(bh.slice(4, 6), 16)
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const b2 = Math.round(ab + (bb - ab) * t)
  const h = (n) => n.toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b2)}`
}

function colorForGain(t) {
  const clamp = Math.max(0, Math.min(1, t))
  for (let i = 0; i < GAIN_STOPS.length - 1; i += 1) {
    const s = GAIN_STOPS[i]
    const e = GAIN_STOPS[i + 1]
    if (clamp <= e.t) {
      const span = e.t - s.t || 1
      return lerpHex(s.c, e.c, (clamp - s.t) / span)
    }
  }
  return GAIN_STOPS[GAIN_STOPS.length - 1].c
}

const STATUS_COLOR = {
  paid: '#16a34a',
  payable: '#f59e0b',
  pending: '#94a3b8',
}

// =============================================================================
// Small helpers
// =============================================================================

function asId(value) {
  if (value === null || value === undefined) return null
  const s = String(value)
  return s.length ? s : null
}

function clientName(client) {
  if (!client) return ''
  const full = [client.first_name, client.last_name].filter(Boolean).join(' ').trim()
  return full || client.name || client.display_name || client.full_name || client.email || String(client.id)
}

function clientCode(client) {
  if (!client) return ''
  return (
    client.commission_code ||
    client.parrain_code ||
    client.referral_code ||
    client.code ||
    ''
  )
}

function clientPhone(client) {
  if (!client) return ''
  return client.phone || client.phone_number || client.mobile || ''
}

function fmtMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0 TND'
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)} MTND`
  if (n >= 10000) return `${(n / 1000).toFixed(1)} kTND`
  if (n >= 1000) return `${(n / 1000).toFixed(2)} kTND`
  return `${n.toFixed(n < 10 ? 2 : 0)} TND`
}

function fmtMoneyFull(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0,00 TND'
  return `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TND`
}

function isPaidEvent(e) {
  return e?.status === 'paid' || Boolean(e?.paid_at || e?.paidAt)
}
function isCancelledEvent(e) {
  return e?.status === 'cancelled'
}

function eventStatusFor(e) {
  if (!e) return 'pending'
  if (isPaidEvent(e)) return 'paid'
  if (isCancelledEvent(e)) return 'cancelled'
  // In Zitouna parlance, non-paid non-cancelled with paid_at=null is "payable"
  // (approved) when status hints say so; otherwise it stays "pending".
  if (e.status === 'payable' || e.status === 'approved') return 'payable'
  if (e.status === 'pending' || e.status === 'submitted' || e.status === 'rejected') return 'pending'
  return 'pending'
}

function nodeRadius(total) {
  const tnd = Number.isFinite(total) ? total : 0
  return BASE_RADIUS + Math.min(MAX_RADIUS_BONUS, tnd / COMMISSION_SCALE)
}

// Smooth cubic-bezier edge between two points.
function edgePath(x1, y1, x2, y2) {
  const midX = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
}

// =============================================================================
// Layout algorithm
// =============================================================================
//
// Tree layout with subtree-packing: each subtree is assigned a vertical "slot"
// range equal to its number of leaves. Parents sit centered over their children
// vertically, children flow top→bottom. This is a simplified Reingold-Tilford
// that keeps x=depth (like the old version) but gives nicer parent placement.
// Roots are stacked (blank row between).  Mutates `positions` and returns rows
// consumed so callers can stack multiple trees.

function layoutSubtree(rootId, childrenMap, seen, positions, startRow) {
  // First pass: pre-order DFS to compute leaf counts per node.
  const leaves = new Map()
  function countLeaves(id) {
    if (!id || seen.has(id)) return 0
    seen.add(id)
    const kidsRaw = childrenMap.get(id) || []
    const kids = []
    for (const kRaw of kidsRaw) {
      const k = asId(kRaw)
      if (!k || seen.has(k)) continue
      kids.push(k)
    }
    if (kids.length === 0) {
      leaves.set(id, 1)
      return 1
    }
    let count = 0
    for (const k of kids) count += countLeaves(k)
    leaves.set(id, Math.max(1, count))
    return leaves.get(id)
  }
  seen.delete(rootId) // countLeaves will re-add it
  const totalLeaves = countLeaves(rootId)

  // Second pass: assign positions.
  const seen2 = new Set()
  function assign(id, depth, slotStart) {
    if (!id || seen2.has(id)) return
    seen2.add(id)
    const myLeaves = leaves.get(id) || 1
    const kidsRaw = childrenMap.get(id) || []
    const kids = []
    for (const kRaw of kidsRaw) {
      const k = asId(kRaw)
      if (!k || seen2.has(k)) continue
      kids.push(k)
    }
    if (kids.length === 0) {
      positions.set(id, { x: depth, y: startRow + slotStart, depth })
      return
    }
    let slot = slotStart
    for (const k of kids) {
      const kLeaves = leaves.get(k) || 1
      assign(k, depth + 1, slot)
      slot += kLeaves
    }
    // Parent centered over its children's vertical span.
    const center = slotStart + (myLeaves - 1) / 2
    positions.set(id, { x: depth, y: startRow + center, depth })
  }
  assign(rootId, 0, 0)
  return totalLeaves
}

// =============================================================================
// Component
// =============================================================================

export default function CommissionNodeGraph({
  data,
  selectedClientId,
  mode = 'global',
  onNodeClick,
  colorMode: colorModeProp,
  onColorModeChange,
  onSelectionChange,
}) {
  // --------- local UI state -------------------------------------------------
  const [colorModeLocal, setColorModeLocal] = useState('depth') // 'depth' | 'gain' | 'status'
  const colorMode = colorModeProp || colorModeLocal
  const setColorMode = useCallback(
    (m) => {
      if (typeof onColorModeChange === 'function') onColorModeChange(m)
      setColorModeLocal(m)
    },
    [onColorModeChange],
  )

  const [hoverId, setHoverId] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [showSearchResults, setShowSearchResults] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [tooltipPos, setTooltipPos] = useState(null) // {x,y} in screen space

  // Zoom + pan state (pure React — transforms applied on outer <g>).
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef(null) // { startX, startY, originX, originY }
  const containerRef = useRef(null)
  const [tooltipContainer, setTooltipContainer] = useState(null)

  // --------- derived layout + indexes (heavy, memoized) --------------------
  const computed = useMemo(() => {
    const commissionEvents = Array.isArray(data?.commissionEvents) ? data.commissionEvents : []
    const clients = Array.isArray(data?.clients) ? data.clients : []
    const sellerRelations = Array.isArray(data?.sellerRelations) ? data.sellerRelations : []
    const sales = Array.isArray(data?.sales) ? data.sales : []

    const parentMap = tree.buildParentMap(sellerRelations)
    const childrenMap = tree.buildChildrenMap(sellerRelations)

    const clientIndex = new Map()
    for (const c of clients) {
      const id = asId(c?.id)
      if (id) clientIndex.set(id, c)
    }

    // De-duplicate client records that describe the same person — the tree
    // used to render doubles when the DB stored two rows for one human (e.g.
    // an old stub client + their later full profile). We pick a canonical id
    // per (normalised name, trimmed phone) bucket and rewrite every reference
    // below (parent/child maps, events, sales seller) to use it.
    const canonicalIdByKey = new Map()
    const idAlias = new Map() // duplicateId -> canonicalId
    const normaliseKey = (c) => {
      const name = String(clientName(c) || '').toLowerCase().replace(/\s+/g, ' ').trim()
      const phone = String(clientPhone(c) || '').replace(/\D/g, '')
      if (!name) return null
      return `${name}|${phone}`
    }
    for (const c of clients) {
      const id = asId(c?.id)
      if (!id) continue
      const key = normaliseKey(c)
      if (!key) continue
      const existing = canonicalIdByKey.get(key)
      if (!existing) {
        canonicalIdByKey.set(key, id)
      } else if (existing !== id) {
        idAlias.set(id, existing)
      }
    }
    const canonicalise = (rawId) => {
      const id = asId(rawId)
      if (!id) return null
      return idAlias.get(id) || id
    }

    // Sale → seller index (used to compute per-edge flow amounts).
    const saleSellerById = new Map()
    for (const s of sales) {
      const id = asId(s?.id)
      if (!id) continue
      const seller = asId(s?.seller_client_id ?? s?.sellerClientId ?? s?.seller_id)
      if (seller) saleSellerById.set(id, seller)
    }

    // Gather every id that may appear anywhere in data.
    const allIds = new Set()
    for (const id of clientIndex.keys()) allIds.add(id)
    for (const [child, parent] of parentMap) {
      allIds.add(child)
      allIds.add(parent)
    }
    for (const ev of commissionEvents) {
      const b = asId(ev?.beneficiary_client_id ?? ev?.beneficiaryClientId ?? ev?.client_id)
      if (b) allIds.add(b)
    }

    // Roots = any id without a parent in the map.
    const roots = []
    for (const id of allIds) {
      if (!parentMap.has(id)) roots.push(id)
    }
    roots.sort((a, b) =>
      clientName(clientIndex.get(a)).localeCompare(clientName(clientIndex.get(b))),
    )

    // Run layout per root.
    const positions = new Map()
    const seen = new Set()
    let cursor = 0
    for (const root of roots) {
      const rows = layoutSubtree(root, childrenMap, seen, positions, cursor)
      if (rows > 0) cursor += rows + 1
    }
    // Orphan safety net.
    for (const id of allIds) {
      if (!positions.has(id)) {
        positions.set(id, { x: 0, y: cursor, depth: 0 })
        cursor += 1
      }
    }

    // --------- ancestors + descendants sets (for hover path highlight) -----
    const descendants = new Map() // id -> Set(id) of all descendants (exclusive)
    function collectDescendants(id) {
      if (descendants.has(id)) return descendants.get(id)
      const out = new Set()
      const stack = [id]
      const local = new Set([id])
      while (stack.length) {
        const cur = stack.pop()
        const kids = childrenMap.get(cur) || []
        for (const kRaw of kids) {
          const k = asId(kRaw)
          if (!k || local.has(k)) continue
          local.add(k)
          out.add(k)
          stack.push(k)
        }
      }
      descendants.set(id, out)
      return out
    }
    for (const id of positions.keys()) collectDescendants(id)

    // --------- per-node commission totals ---------------------------------
    // Walks events once, indexes by beneficiary so the 200-node target remains
    // cheap. Also builds an auxiliary "events-grouped-by-beneficiary" index.
    const eventsByBeneficiary = new Map()
    for (const ev of commissionEvents) {
      const b = asId(ev?.beneficiary_client_id ?? ev?.beneficiaryClientId ?? ev?.client_id)
      if (!b) continue
      const bucket = eventsByBeneficiary.get(b) || []
      bucket.push(ev)
      eventsByBeneficiary.set(b, bucket)
    }

    const totalsById = new Map()
    for (const id of positions.keys()) {
      const bucket = eventsByBeneficiary.get(id) || []
      let l1 = 0
      let l2plus = 0
      let paid = 0
      let payable = 0
      let pending = 0
      let eventsCount = 0
      for (const ev of bucket) {
        if (isCancelledEvent(ev)) continue
        const amt = Number(ev.amount ?? ev.commission_amount ?? 0)
        if (!Number.isFinite(amt)) continue
        const rawLevel = ev.level ?? ev.tier
        const lvl = typeof rawLevel === 'string'
          ? Number(rawLevel.toLowerCase().replace(/^l/, '')) || 1
          : Number(rawLevel) || 1
        if (lvl <= 1) l1 += amt
        else l2plus += amt
        const s = eventStatusFor(ev)
        if (s === 'paid') paid += amt
        else if (s === 'payable') payable += amt
        else pending += amt
        eventsCount += 1
      }
      totalsById.set(id, {
        l1,
        l2: l2plus,
        total: l1 + l2plus,
        paid,
        payable,
        pending,
        events: eventsCount,
      })
    }

    // Fallback status color input.
    function statusForNode(totals) {
      if (totals.paid > 0) return 'paid'
      if (totals.payable > 0) return 'payable'
      return 'pending'
    }

    // --------- sales count per node ---------------------------------------
    const salesCountById = new Map()
    for (const s of sales) {
      const seller = asId(s?.seller_client_id ?? s?.sellerClientId ?? s?.seller_id)
      if (!seller) continue
      salesCountById.set(seller, (salesCountById.get(seller) || 0) + 1)
    }

    // --------- per-edge amount (and "pending-only" flag) ------------------
    // For edge parent→child, count events where beneficiary=parent AND the sale
    // seller is child OR in child's subtree.
    const edgeFlow = new Map() // key = `${parent}->${child}` -> {amount, hasActive}
    for (const [childId, parentId] of parentMap) {
      if (!positions.has(childId) || !positions.has(parentId)) continue
      const subtree = descendants.get(childId) || new Set()
      const bucket = eventsByBeneficiary.get(parentId) || []
      let amount = 0
      let hasActive = false
      for (const ev of bucket) {
        if (isCancelledEvent(ev)) continue
        const saleId = asId(ev.sale_id ?? ev.saleId)
        const seller = saleId ? saleSellerById.get(saleId) : null
        const fromSubtree = seller ? seller === childId || subtree.has(seller) : false
        if (!fromSubtree) continue
        const amt = Number(ev.amount ?? ev.commission_amount ?? 0)
        if (!Number.isFinite(amt)) continue
        amount += amt
        const s = eventStatusFor(ev)
        if (s === 'paid' || s === 'payable') hasActive = true
      }
      edgeFlow.set(`${parentId}->${childId}`, { amount, hasActive })
    }
    const maxEdgeAmount = Array.from(edgeFlow.values()).reduce(
      (m, v) => Math.max(m, v.amount),
      0,
    )

    // --------- focus set (byClient) + search resolution -------------------
    const selectedId = asId(selectedClientId)
    const selectedExists = selectedId && positions.has(selectedId)

    let focusIds = null
    if (mode === 'byClient' && selectedExists) {
      focusIds = new Set()
      const upline = tree.resolveUplineChain(selectedId, parentMap)
      for (const id of upline) focusIds.add(asId(id))
      const down = tree.resolveDownlineTree(selectedId, childrenMap)
      for (const row of tree.flattenTree(down)) focusIds.add(asId(row.id))
      focusIds.delete(null)
    }

    // --------- max total for gain colormode -------------------------------
    let maxTotal = 0
    for (const t of totalsById.values()) {
      if (t.total > maxTotal) maxTotal = t.total
    }

    // --------- build node + edge arrays -----------------------------------
    const nodes = []
    for (const [id, pos] of positions) {
      if (focusIds && !focusIds.has(id)) continue
      const client = clientIndex.get(id)
      const totals = totalsById.get(id) || { l1: 0, l2: 0, total: 0, paid: 0, payable: 0, pending: 0, events: 0 }
      const salesCount = salesCountById.get(id) || 0
      const directCount = (childrenMap.get(id) || []).length
      const descCount = (descendants.get(id) || new Set()).size
      const depthForColor = pos.depth >= 4 ? 4 : pos.depth
      const status = statusForNode(totals)
      nodes.push({
        id,
        x: MARGIN_X + pos.x * COL_STEP,
        y: MARGIN_Y + pos.y * ROW_STEP,
        depth: pos.depth,
        client,
        label: clientName(client) || id,
        code: clientCode(client),
        phone: clientPhone(client),
        totals,
        salesCount,
        directCount,
        descCount,
        status,
        radius: nodeRadius(totals.total),
        colorDepth: colorForDepth(depthForColor),
        colorGain: colorForGain(maxTotal > 0 ? totals.total / maxTotal : 0),
        colorStatus: STATUS_COLOR[status],
      })
    }

    const edges = []
    for (const [childId, parentId] of parentMap) {
      if (focusIds && (!focusIds.has(childId) || !focusIds.has(parentId))) continue
      const cPos = positions.get(childId)
      const pPos = positions.get(parentId)
      if (!cPos || !pPos) continue
      const flow = edgeFlow.get(`${parentId}->${childId}`) || { amount: 0, hasActive: false }
      const depthForColor = cPos.depth >= 4 ? 4 : cPos.depth
      edges.push({
        id: `${parentId}->${childId}`,
        parentId,
        childId,
        x1: MARGIN_X + pPos.x * COL_STEP,
        y1: MARGIN_Y + pPos.y * ROW_STEP,
        x2: MARGIN_X + cPos.x * COL_STEP,
        y2: MARGIN_Y + cPos.y * ROW_STEP,
        color: colorForDepth(depthForColor),
        amount: flow.amount,
        hasActive: flow.hasActive,
      })
    }

    // Compute bounding box.
    let maxX = 0
    let maxY = 0
    for (const node of nodes) {
      if (node.x > maxX) maxX = node.x
      if (node.y > maxY) maxY = node.y
    }
    const width = Math.max(maxX + MARGIN_X + 160, 400)
    const height = Math.max(maxY + MARGIN_Y + 80, 280)

    // Global stats (used when nothing hovered/selected).
    let gTotal = 0
    let gPaid = 0
    let gPayable = 0
    let gPending = 0
    let gEvents = 0
    for (const t of totalsById.values()) {
      gTotal += t.total
      gPaid += t.paid
      gPayable += t.payable
      gPending += t.pending
      gEvents += t.events
    }

    // Top-N nodes by earnings.
    const topNodes = []
    for (const n of nodes) topNodes.push(n)
    topNodes.sort((a, b) => b.totals.total - a.totals.total)

    return {
      nodes,
      edges,
      width,
      height,
      parentMap,
      childrenMap,
      descendants,
      clientIndex,
      totalsById,
      salesCountById,
      eventsByBeneficiary,
      saleSellerById,
      maxEdgeAmount,
      maxTotal,
      focusIds,
      selectedExists,
      selectedId,
      isEmpty: nodes.length === 0,
      global: {
        total: gTotal,
        paid: gPaid,
        payable: gPayable,
        pending: gPending,
        events: gEvents,
        nodes: nodes.length,
      },
      topNodes,
    }
  }, [data, selectedClientId, mode])

  const {
    nodes,
    edges,
    width,
    height,
    parentMap,
    childrenMap,
    descendants,
    maxEdgeAmount,
    selectedExists,
    isEmpty,
    global: globalStats,
    topNodes,
  } = computed

  // --------- hover chain sets (upline + downline) for the currently hovered
  //   or selected node. Cheap: one ancestor walk + one subtree lookup.  -----
  const highlightSet = useMemo(() => {
    const id = hoverId || (selectedExists ? asId(selectedClientId) : null)
    if (!id) return null
    const set = new Set([id])
    // ancestors
    let cursor = id
    while (cursor) {
      const p = parentMap.get(cursor)
      if (!p || set.has(p)) break
      set.add(p)
      cursor = p
    }
    // descendants
    const desc = descendants.get(id)
    if (desc) for (const d of desc) set.add(d)
    return set
  }, [hoverId, selectedClientId, selectedExists, parentMap, descendants])

  // --------- search results -------------------------------------------------
  const searchResults = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    if (!q) return []
    const hits = []
    for (const n of nodes) {
      const hay = [n.label, n.code, n.phone].filter(Boolean).join(' ').toLowerCase()
      if (hay.includes(q)) hits.push(n)
      if (hits.length >= 12) break
    }
    return hits
  }, [searchTerm, nodes])

  // --------- zoom/pan handlers ---------------------------------------------
  const handleWheel = useCallback((ev) => {
    // Only react when the pointer is inside the SVG container to avoid
    // hijacking page scroll when the user is merely scrolling past.
    ev.preventDefault()
    setZoom((z) => {
      const delta = ev.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z + delta))
      return Math.round(next * 100) / 100
    })
  }, [])

  // Attach the non-passive wheel listener once.  React's onWheel is passive by
  // default which prevents preventDefault from stopping container scroll.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const listener = (ev) => handleWheel(ev)
    el.addEventListener('wheel', listener, { passive: false })
    return () => el.removeEventListener('wheel', listener)
  }, [handleWheel])

  const onMouseDown = (ev) => {
    if (ev.button !== 0) return
    dragRef.current = {
      startX: ev.clientX,
      startY: ev.clientY,
      originX: pan.x,
      originY: pan.y,
    }
  }
  const onMouseMove = (ev) => {
    setTooltipPos({ x: ev.clientX, y: ev.clientY })
    const d = dragRef.current
    if (!d) return
    const dx = ev.clientX - d.startX
    const dy = ev.clientY - d.startY
    setPan({ x: d.originX + dx, y: d.originY + dy })
  }
  const onMouseUp = () => {
    dragRef.current = null
  }
  const onMouseLeave = () => {
    dragRef.current = null
    setHoverId(null)
    setTooltipPos(null)
  }

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // Center on a node: translate so its position sits in container middle.
  const centerOnNode = useCallback(
    (node) => {
      const el = containerRef.current
      if (!el || !node) return
      const rect = el.getBoundingClientRect()
      setZoom((z) => Math.max(z, 0.9))
      // After zoom, place the node at the container center:
      //   pan = containerCenter - (node.x * zoom)
      const targetZoom = Math.max(zoom, 0.9)
      setPan({
        x: rect.width / 2 - node.x * targetZoom,
        y: rect.height / 2 - node.y * targetZoom,
      })
    },
    [zoom],
  )

  // --------- selection helpers ---------------------------------------------
  const handleNodeClick = useCallback(
    (ev, id) => {
      ev.stopPropagation()
      if (typeof onNodeClick === 'function') onNodeClick(id)
      if (typeof onSelectionChange === 'function') onSelectionChange(id)
    },
    [onNodeClick, onSelectionChange],
  )

  // --------- color resolver by mode ----------------------------------------
  const fillForNode = useCallback(
    (node) => {
      if (node.totals.total === 0 && colorMode !== 'status') return COLOR_MUTED
      if (colorMode === 'gain') return node.colorGain
      if (colorMode === 'status') return node.colorStatus
      return node.colorDepth
    },
    [colorMode],
  )

  // --------- subtree rollup for the right-side panel -----------------------
  const panelData = useMemo(() => {
    const id = hoverId || (selectedExists ? asId(selectedClientId) : null)
    if (!id) return null
    const node = nodes.find((n) => n.id === id)
    if (!node) return null
    // Rollup: sum across node + descendants.
    const subtreeIds = new Set([id, ...(descendants.get(id) || [])])
    let rollTotal = 0
    let rollPaid = 0
    let rollPayable = 0
    let rollPending = 0
    let rollEvents = 0
    let rollSales = 0
    const childTotals = [] // [{id,label,total}]
    for (const sid of subtreeIds) {
      const t = computed.totalsById.get(sid) || {
        total: 0, paid: 0, payable: 0, pending: 0, events: 0,
      }
      rollTotal += t.total
      rollPaid += t.paid
      rollPayable += t.payable
      rollPending += t.pending
      rollEvents += t.events
      rollSales += computed.salesCountById.get(sid) || 0
    }
    // Direct filleuls' totals (one-hop children only).
    const directKids = childrenMap.get(id) || []
    for (const kRaw of directKids) {
      const k = asId(kRaw)
      if (!k) continue
      const kNode = nodes.find((n) => n.id === k)
      const kTotal = (computed.totalsById.get(k) || { total: 0 }).total
      childTotals.push({ id: k, label: kNode ? kNode.label : k, total: kTotal })
    }
    childTotals.sort((a, b) => b.total - a.total)
    const uplineDepth = tree.resolveUplineChain(id, parentMap).length - 1
    return {
      node,
      rollup: {
        total: rollTotal,
        paid: rollPaid,
        payable: rollPayable,
        pending: rollPending,
        events: rollEvents,
        sales: rollSales,
        members: subtreeIds.size,
      },
      topChildren: childTotals.slice(0, 3),
      uplineDepth,
    }
  }, [
    hoverId,
    selectedClientId,
    selectedExists,
    nodes,
    descendants,
    childrenMap,
    parentMap,
    computed.totalsById,
    computed.salesCountById,
  ])

  // --------- render: empty state -------------------------------------------
  if (!data || isEmpty) {
    return (
      <div className="cg-root cg-root--empty" role="img" aria-label="Arbre vide">
        <svg viewBox="0 0 360 180" className="cg-empty__art" aria-hidden="true">
          <defs>
            <linearGradient id="cg-empty-grad" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor="#dbeafe" />
              <stop offset="1" stopColor="#e0e7ff" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="360" height="180" fill="url(#cg-empty-grad)" rx="16" />
          <circle cx="90" cy="90" r="18" fill="#fff" stroke="#1d4ed8" strokeWidth="2" />
          <circle cx="200" cy="50" r="12" fill="#fff" stroke="#2563eb" strokeWidth="2" />
          <circle cx="200" cy="130" r="12" fill="#fff" stroke="#2563eb" strokeWidth="2" />
          <circle cx="300" cy="40" r="9" fill="#fff" stroke="#f59e0b" strokeWidth="2" />
          <circle cx="300" cy="90" r="9" fill="#fff" stroke="#f59e0b" strokeWidth="2" />
          <circle cx="300" cy="140" r="9" fill="#fff" stroke="#10b981" strokeWidth="2" />
          <path d="M108 90 L188 50" stroke="#93c5fd" strokeWidth="1.5" fill="none" />
          <path d="M108 90 L188 130" stroke="#93c5fd" strokeWidth="1.5" fill="none" />
          <path d="M212 50 L291 40" stroke="#bfdbfe" strokeWidth="1.2" fill="none" strokeDasharray="4 3" />
          <path d="M212 50 L291 90" stroke="#bfdbfe" strokeWidth="1.2" fill="none" strokeDasharray="4 3" />
          <path d="M212 130 L291 140" stroke="#bfdbfe" strokeWidth="1.2" fill="none" strokeDasharray="4 3" />
        </svg>
        <div className="cg-empty__msg">
          <strong>Aucune donnée de commission.</strong>
          <span>Le graphe s’activera dès que des parrainages ou ventes seront enregistrés.</span>
        </div>
        <InlineStyles />
      </div>
    )
  }

  // --------- zoom label helpers --------------------------------------------
  const zoomPct = Math.round(zoom * 100)

  // --------- stroke width for edges ----------------------------------------
  function edgeStrokeWidth(amount) {
    if (maxEdgeAmount <= 0 || amount <= 0) return 1.4
    const t = Math.min(1, amount / maxEdgeAmount)
    return 2 + t * 3 // 2..5
  }

  // --------- render --------------------------------------------------------

  return (
    <div
      className="cg-root"
      ref={(el) => {
        containerRef.current = el
        setTooltipContainer(el)
      }}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
    >
      <InlineStyles />

      {/* ------- TOP TOOLBAR -------------------------------------------- */}
      <div className="cg-toolbar">
        <div className="cg-toolbar__left">
          <div className="cg-pillbar" role="group" aria-label="Mode de couleur">
            {[
              { key: 'depth', label: 'Par niveau' },
              { key: 'gain', label: 'Par gains' },
              { key: 'status', label: 'Par statut' },
            ].map((m) => (
              <button
                key={m.key}
                type="button"
                className={`cg-pillbar__btn ${colorMode === m.key ? 'cg-pillbar__btn--on' : ''}`}
                onClick={() => setColorMode(m.key)}
                aria-pressed={colorMode === m.key}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="cg-search">
            <input
              type="search"
              placeholder="Rechercher un nom, un code, un téléphone…"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value)
                setShowSearchResults(true)
              }}
              onFocus={() => setShowSearchResults(true)}
              onBlur={() => setTimeout(() => setShowSearchResults(false), 150)}
              className="cg-search__input"
              aria-label="Rechercher un filleul"
            />
            {showSearchResults && searchResults.length > 0 ? (
              <ul className="cg-search__menu" role="listbox">
                {searchResults.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="cg-search__item"
                      onMouseDown={(ev) => {
                        ev.preventDefault()
                        centerOnNode(n)
                        if (typeof onNodeClick === 'function') onNodeClick(n.id)
                        setShowSearchResults(false)
                        setSearchTerm('')
                      }}
                    >
                      <span className="cg-search__item-name">{n.label}</span>
                      <span className="cg-search__item-meta">
                        {n.code ? `· ${n.code}` : ''}{n.phone ? ` · ${n.phone}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
        <div className="cg-toolbar__right">
          <span className="cg-zoom-label" aria-live="polite">{zoomPct}%</span>
          <button
            type="button"
            className="cg-icon-btn"
            onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))}
            aria-label="Zoom arrière"
            title="Zoom arrière"
          >
            −
          </button>
          <button
            type="button"
            className="cg-icon-btn"
            onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))}
            aria-label="Zoom avant"
            title="Zoom avant"
          >
            +
          </button>
          <button
            type="button"
            className="cg-icon-btn cg-icon-btn--primary"
            onClick={resetView}
            aria-label="Ajuster"
            title="Ajuster"
          >
            ⌂ Ajuster
          </button>
          <button
            type="button"
            className="cg-icon-btn"
            onClick={() => setPanelCollapsed((v) => !v)}
            aria-label="Basculer le panneau"
            title={panelCollapsed ? 'Afficher le panneau' : 'Masquer le panneau'}
          >
            {panelCollapsed ? '«' : '»'}
          </button>
        </div>
      </div>

      {/* ------- MAIN CANVAS -------------------------------------------- */}
      <div className="cg-canvas">
        <div
          className={`cg-stage ${panelCollapsed ? 'cg-stage--wide' : ''}`}
          onMouseDown={onMouseDown}
        >
          <svg
            className="cg-svg"
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            role="img"
            aria-label="Arbre des commissions"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
            }}
          >
            {/* EDGES */}
            <g>
              {edges.map((edge) => {
                const highlighted =
                  highlightSet && highlightSet.has(edge.parentId) && highlightSet.has(edge.childId)
                const faded = highlightSet && !highlightSet.has(edge.childId)
                const stroke = highlighted ? COLOR_EDGE_ACTIVE : edge.color
                const sw = edgeStrokeWidth(edge.amount)
                // Dash an edge when it has no paid/payable flow: either pure
                // pending activity or no flow at all (structural-only link).
                const dash = !edge.hasActive ? '4 4' : undefined
                return (
                  <g key={edge.id} opacity={faded ? 0.25 : 1}>
                    <path
                      d={edgePath(edge.x1, edge.y1, edge.x2, edge.y2)}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={highlighted ? sw + 1.2 : sw}
                      strokeOpacity={highlighted ? 1 : 0.75}
                      strokeDasharray={dash}
                      strokeLinecap="round"
                    />
                    {/* Edge amount labels removed — they added visual noise.
                        Per-flow amounts are still available in the hover tooltip. */}
                  </g>
                )
              })}
            </g>

            {/* NODES */}
            <g>
              {nodes.map((node) => {
                const isSelected = asId(selectedClientId) === node.id
                const faded = highlightSet && !highlightSet.has(node.id)
                const r = node.radius
                const fill = fillForNode(node)
                const stroke = isSelected ? '#0f172a' : '#ffffff'
                const strokeWidth = isSelected ? 2.2 : 1.6
                return (
                  <g
                    key={node.id}
                    transform={`translate(${node.x},${node.y})`}
                    style={{ cursor: 'pointer' }}
                    opacity={faded ? 0.35 : 1}
                    onMouseEnter={() => setHoverId(node.id)}
                    onMouseLeave={() => setHoverId((cur) => (cur === node.id ? null : cur))}
                    onClick={(ev) => handleNodeClick(ev, node.id)}
                  >
                    {/* big circle */}
                    <circle r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
                    {/* status dot (tiny, top-left) — paid/payable/pending at a glance */}
                    <circle r={3.6} cx={-r + 5} cy={-r + 5} fill={STATUS_COLOR[node.status]} stroke="#fff" strokeWidth={1} />
                    {/* Name below circle — only surface we keep on the node itself.
                        Amount + counts (sales, filleuls, descendants) live in the
                        hover tooltip so the tree reads like a clean org-chart. */}
                    <text
                      y={r + 16}
                      textAnchor="middle"
                      fontSize={12}
                      fontWeight={600}
                      fill={COLOR_TEXT}
                    >
                      {node.label.length > 22 ? `${node.label.slice(0, 20)}…` : node.label}
                    </text>
                  </g>
                )
              })}
            </g>
          </svg>
        </div>

        {/* ------- STATS PANEL --------------------------------------------- */}
        {!panelCollapsed ? (
          <aside className="cg-panel" aria-label="Statistiques">
            {panelData ? (
              <NodeStatsPanel data={panelData} />
            ) : (
              <GlobalStatsPanel stats={globalStats} topNodes={topNodes} />
            )}
          </aside>
        ) : null}
      </div>

      {/* ------- HOVER TOOLTIP ------------------------------------------- */}
      {hoverId && tooltipPos ? (
        <HoverTooltip
          node={nodes.find((n) => n.id === hoverId)}
          descCount={(descendants.get(hoverId) || new Set()).size}
          uplineDepth={tree.resolveUplineChain(hoverId, parentMap).length - 1}
          pos={tooltipPos}
          container={tooltipContainer}
        />
      ) : null}
    </div>
  )
}

// =============================================================================
// Subcomponents
// =============================================================================

function EdgeAmountLabel({ x, y, amount, highlighted }) {
  const text = fmtMoney(amount)
  const w = 10 + text.length * 5.6
  return (
    <g transform={`translate(${x},${y})`} pointerEvents="none">
      <rect
        x={-w / 2}
        y={-8}
        width={w}
        height={16}
        rx={8}
        ry={8}
        fill={highlighted ? '#1d4ed8' : '#ffffff'}
        stroke={highlighted ? '#1d4ed8' : '#cbd5e1'}
        strokeWidth={1}
      />
      <text
        y={3}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        fill={highlighted ? '#ffffff' : '#0f172a'}
      >
        {text}
      </text>
    </g>
  )
}

function HoverTooltip({ node, descCount, uplineDepth, pos, container }) {
  if (!node || !pos || !container) return null
  const rect = container.getBoundingClientRect()
  const x = pos.x - rect.left + 14
  const y = pos.y - rect.top + 14
  // Clamp inside container (240px tooltip width).
  const left = Math.min(x, rect.width - 252)
  const top = Math.min(y, rect.height - 200)
  return (
    <div
      className="cg-tooltip"
      style={{ left: `${Math.max(4, left)}px`, top: `${Math.max(4, top)}px` }}
      role="tooltip"
    >
      <div className="cg-tooltip__name">{node.label}</div>
      <div className="cg-tooltip__sub">
        {node.code ? `Code ${node.code}` : '—'}{node.phone ? ` · ${node.phone}` : ''}
      </div>
      <hr className="cg-tooltip__sep" />
      <dl className="cg-tooltip__grid">
        <dt>L1 gagné</dt><dd>{fmtMoneyFull(node.totals.l1)}</dd>
        <dt>L2+ gagné</dt><dd>{fmtMoneyFull(node.totals.l2)}</dd>
        <dt>Total payé</dt><dd>{fmtMoneyFull(node.totals.paid)}</dd>
        <dt>À payer</dt><dd>{fmtMoneyFull(node.totals.payable)}</dd>
        <dt>En attente</dt><dd>{fmtMoneyFull(node.totals.pending)}</dd>
        <dt>Ventes</dt><dd>{node.salesCount}</dd>
        <dt>Filleuls directs</dt><dd>{node.directCount}</dd>
        <dt>Descendants</dt><dd>{descCount}</dd>
        <dt>Profondeur</dt><dd>L{uplineDepth}</dd>
      </dl>
    </div>
  )
}

function StatRow({ label, value, accent }) {
  return (
    <div className="cg-stat">
      <span className="cg-stat__label">{label}</span>
      <span className={`cg-stat__value ${accent ? `cg-stat__value--${accent}` : ''}`}>{value}</span>
    </div>
  )
}

function NodeStatsPanel({ data }) {
  const { node, rollup, topChildren, uplineDepth } = data
  return (
    <div className="cg-panel__body">
      <header className="cg-panel__header">
        <div>
          <div className="cg-panel__title">{node.label}</div>
          <div className="cg-panel__sub">
            {node.code ? `Code ${node.code}` : '—'} · L{uplineDepth} · {node.directCount} filleul(s) directs
          </div>
        </div>
      </header>
      <section className="cg-panel__section">
        <h4>Ce nœud</h4>
        <StatRow label="L1" value={fmtMoneyFull(node.totals.l1)} accent="info" />
        <StatRow label="L2+" value={fmtMoneyFull(node.totals.l2)} />
        <StatRow label="Payé" value={fmtMoneyFull(node.totals.paid)} accent="ok" />
        <StatRow label="À payer" value={fmtMoneyFull(node.totals.payable)} accent="warn" />
        <StatRow label="En attente" value={fmtMoneyFull(node.totals.pending)} accent="muted" />
        <StatRow label="Ventes" value={node.salesCount} />
      </section>
      <section className="cg-panel__section">
        <h4>Sous-arbre ({rollup.members} membre{rollup.members > 1 ? 's' : ''})</h4>
        <StatRow label="Commissions générées" value={fmtMoneyFull(rollup.total)} />
        <StatRow label="Payé" value={fmtMoneyFull(rollup.paid)} accent="ok" />
        <StatRow label="À payer" value={fmtMoneyFull(rollup.payable)} accent="warn" />
        <StatRow label="Ventes (sous-arbre)" value={rollup.sales} />
        <StatRow label="Événements" value={rollup.events} />
      </section>
      {topChildren.length > 0 ? (
        <section className="cg-panel__section">
          <h4>Top filleuls directs</h4>
          <ol className="cg-panel__top">
            {topChildren.map((c) => (
              <li key={c.id}>
                <span className="cg-panel__top-name">{c.label}</span>
                <span className="cg-panel__top-amount">{fmtMoney(c.total)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  )
}

function GlobalStatsPanel({ stats, topNodes }) {
  return (
    <div className="cg-panel__body">
      <header className="cg-panel__header">
        <div>
          <div className="cg-panel__title">Vue globale</div>
          <div className="cg-panel__sub">{stats.nodes} nœud{stats.nodes > 1 ? 's' : ''} · {stats.events} événements</div>
        </div>
      </header>
      <section className="cg-panel__section">
        <h4>Totaux système</h4>
        <StatRow label="Commissions" value={fmtMoneyFull(stats.total)} accent="info" />
        <StatRow label="Payé" value={fmtMoneyFull(stats.paid)} accent="ok" />
        <StatRow label="À payer" value={fmtMoneyFull(stats.payable)} accent="warn" />
        <StatRow label="En attente" value={fmtMoneyFull(stats.pending)} accent="muted" />
      </section>
      {topNodes && topNodes.length > 0 ? (
        <section className="cg-panel__section">
          <h4>Top 5 par gains</h4>
          <ol className="cg-panel__top">
            {topNodes.slice(0, 5).map((n) => (
              <li key={n.id}>
                <span className="cg-panel__top-name">{n.label}</span>
                <span className="cg-panel__top-amount">{fmtMoney(n.totals.total)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <p className="cg-panel__hint">Passez sur un nœud ou cliquez pour voir le détail et la chaîne de parrainage.</p>
    </div>
  )
}

// =============================================================================
// Inline styles — kept here to keep the component self-contained.
// They use the .cg- prefix and don't conflict with .ct- styles in the page.
// =============================================================================

function InlineStyles() {
  return (
    <style>{`
      .cg-root { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; background: #f8fafc; border-radius: 12px; overflow: hidden; user-select: none; }
      .cg-root--empty { align-items: center; justify-content: center; gap: 12px; padding: 24px; }
      .cg-empty__art { width: 280px; max-width: 80%; height: auto; }
      .cg-empty__msg { text-align: center; color: #475569; font-size: 13px; display: flex; flex-direction: column; gap: 4px; }
      .cg-empty__msg strong { color: #0f172a; font-size: 14px; font-weight: 700; }

      .cg-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; background: #ffffff; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; z-index: 2; }
      .cg-toolbar__left, .cg-toolbar__right { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }

      .cg-pillbar { display: inline-flex; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 999px; padding: 3px; }
      .cg-pillbar__btn { border: 0; background: transparent; padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; color: #475569; cursor: pointer; }
      .cg-pillbar__btn--on { background: #fff; color: #0f172a; box-shadow: 0 1px 2px rgba(15,23,42,.08); }
      .cg-pillbar__btn:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }

      .cg-search { position: relative; }
      .cg-search__input { width: 260px; max-width: 52vw; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 999px; background: #fff; font-size: 12px; color: #0f172a; }
      .cg-search__input:focus { outline: none; border-color: #1d4ed8; box-shadow: 0 0 0 3px rgba(29,78,216,0.12); }
      .cg-search__menu { position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; box-shadow: 0 10px 30px rgba(15,23,42,0.12); list-style: none; padding: 4px; margin: 0; z-index: 10; max-height: 260px; overflow: auto; }
      .cg-search__item { width: 100%; text-align: left; background: transparent; border: 0; padding: 6px 10px; border-radius: 6px; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
      .cg-search__item:hover { background: #eff6ff; }
      .cg-search__item-name { font-weight: 600; color: #0f172a; }
      .cg-search__item-meta { color: #64748b; font-size: 11px; }

      .cg-zoom-label { font-size: 12px; color: #475569; font-weight: 600; min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
      .cg-icon-btn { border: 1px solid #cbd5e1; background: #fff; color: #0f172a; padding: 5px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; line-height: 1; }
      .cg-icon-btn:hover { background: #f1f5f9; }
      .cg-icon-btn--primary { color: #1d4ed8; border-color: #bfdbfe; background: #eff6ff; }
      .cg-icon-btn--primary:hover { background: #dbeafe; }
      .cg-icon-btn:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }

      .cg-canvas { position: relative; flex: 1; display: flex; min-height: 0; }
      .cg-stage { flex: 1; position: relative; overflow: hidden; cursor: grab; background: radial-gradient(ellipse at top left, #f1f5f9, #e2e8f0 70%); }
      .cg-stage:active { cursor: grabbing; }
      .cg-stage--wide { /* nothing extra — flex:1 already fills */ }
      .cg-svg { display: block; transition: none; }

      .cg-panel { width: 300px; max-width: 40%; background: #ffffff; border-left: 1px solid #e2e8f0; overflow: auto; font-size: 13px; color: #0f172a; }
      .cg-panel__body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
      .cg-panel__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding-bottom: 6px; border-bottom: 1px solid #f1f5f9; }
      .cg-panel__title { font-size: 14px; font-weight: 700; color: #0f172a; }
      .cg-panel__sub { font-size: 11px; color: #64748b; margin-top: 2px; }
      .cg-panel__section { border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 10px; background: #f8fafc; }
      .cg-panel__section h4 { margin: 0 0 6px; font-size: 11px; font-weight: 700; color: #475569; letter-spacing: .3px; text-transform: uppercase; }
      .cg-panel__top { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
      .cg-panel__top li { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
      .cg-panel__top-name { color: #0f172a; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 170px; }
      .cg-panel__top-amount { color: #1d4ed8; font-weight: 700; font-variant-numeric: tabular-nums; }
      .cg-panel__hint { margin: 0; font-size: 11px; color: #94a3b8; line-height: 1.4; }

      .cg-stat { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 12px; }
      .cg-stat__label { color: #64748b; }
      .cg-stat__value { color: #0f172a; font-weight: 700; font-variant-numeric: tabular-nums; }
      .cg-stat__value--info { color: #1d4ed8; }
      .cg-stat__value--ok { color: #166534; }
      .cg-stat__value--warn { color: #b45309; }
      .cg-stat__value--muted { color: #64748b; }

      .cg-tooltip { position: absolute; z-index: 20; background: #0f172a; color: #f8fafc; border-radius: 10px; padding: 10px 12px; width: 240px; box-shadow: 0 10px 30px rgba(15,23,42,0.35); font-size: 11px; line-height: 1.5; pointer-events: none; }
      .cg-tooltip__name { font-size: 13px; font-weight: 700; color: #ffffff; }
      .cg-tooltip__sub { font-size: 11px; color: #94a3b8; margin-top: 2px; }
      .cg-tooltip__sep { border: 0; border-top: 1px solid #1e293b; margin: 6px 0; }
      .cg-tooltip__grid { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; margin: 0; }
      .cg-tooltip__grid dt { color: #94a3b8; }
      .cg-tooltip__grid dd { margin: 0; color: #f8fafc; font-weight: 600; font-variant-numeric: tabular-nums; }

      @media (max-width: 700px) {
        .cg-panel { display: none; }
        .cg-search__input { width: 180px; }
      }
    `}</style>
  )
}
