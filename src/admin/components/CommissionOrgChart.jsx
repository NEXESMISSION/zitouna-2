import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { resolveUpline } from '../lib/resolveUpline.js'
import './commission-org-chart.css'

// =============================================================================
// Visual constants — tweak these to rescale the whole chart at once.
// =============================================================================
const CARD_W = 200
const CARD_H = 118
const COL_GAP = 40   // space between sibling cards
const ROW_GAP = 88   // vertical space between parent and child rows — more
                     // breathing room so rounded elbows don't crowd cards
const PAGE_PAD = 56  // breathing room around the tree

const ZOOM_MIN = 0.25
const ZOOM_MAX = 2.5
const ZOOM_STEP = 0.15
const WHEEL_SENSITIVITY = 0.0015  // tune feel of wheel zoom
const PAN_CLICK_THRESHOLD = 4     // px the mouse can move before a click is treated as a drag

const GEN_CLASSES = ['cog-card--g1', 'cog-card--g2', 'cog-card--g3', 'cog-card--g4', 'cog-card--g5']
const GEN_LABELS = ['Gen 1', 'Gen 2', 'Gen 3', 'Gen 4', 'Gen 5+']

// =============================================================================
// Helpers
// =============================================================================
function asId(v) { return v == null ? '' : String(v) }

function fmtMoney(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v === 0) return '0'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${Math.round(v / 1000)}k`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })
}

function clientName(c) {
  if (!c) return '—'
  return c.full_name || c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.code || '—'
}

function clientInitials(c) {
  const name = clientName(c)
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase()
}

function normalizeStatus(e) {
  if (!e) return 'pending'
  if (e.status === 'paid' || e.paid_at || e.paidAt) return 'paid'
  if (e.status === 'cancelled') return 'cancelled'
  if (e.status === 'payable' || e.status === 'approved') return 'payable'
  return 'pending'
}

// =============================================================================
// Top-down tree layout with subtree packing.
// Returns: Map<clientId, { x, y, depth }>, plus bounds.
// Robust to messy data: orphans, cycles, and parent pointers to nodes that
// aren't in the client set are all handled — every client always gets placed.
// =============================================================================
function layoutForest(clientIds, childrenMap, parentMap) {
  const positions = new Map() // id -> {x, y, depth}
  const leafCount = new Map() // id -> int
  const globalSeen = new Set()
  const idSet = new Set(clientIds)
  let maxDepth = 0

  // Filter childrenMap to valid endpoints only.
  const validChildren = new Map()
  for (const [parent, children] of childrenMap.entries()) {
    if (!idSet.has(parent)) continue
    const kept = children.filter((c) => idSet.has(c))
    if (kept.length) validChildren.set(parent, kept)
  }

  function countLeaves(id, seen) {
    if (seen.has(id)) return 0
    seen.add(id)
    const kids = (validChildren.get(id) || []).filter((k) => !seen.has(k))
    if (kids.length === 0) { leafCount.set(id, 1); return 1 }
    let n = 0
    for (const k of kids) n += countLeaves(k, seen)
    leafCount.set(id, Math.max(1, n))
    return leafCount.get(id)
  }

  // Assign relative slot positions (float), then convert to px at the end.
  // globalSeen guards against cycles AND against a node being placed twice
  // (e.g. when data has multiple parent entries for the same child).
  function assignSlots(id, depth, slotStart) {
    if (globalSeen.has(id)) return
    globalSeen.add(id)
    maxDepth = Math.max(maxDepth, depth)
    const kids = (validChildren.get(id) || []).filter((k) => !globalSeen.has(k))
    const myLeaves = leafCount.get(id) || 1
    if (kids.length === 0) {
      positions.set(id, { slot: slotStart, depth })
      return
    }
    let s = slotStart
    for (const k of kids) {
      const kLeaves = leafCount.get(k) || 1
      assignSlots(k, depth + 1, s)
      s += kLeaves
    }
    // parent centered over children span
    const center = slotStart + (myLeaves - 1) / 2
    positions.set(id, { slot: center, depth })
    if (kids.length === 1) {
      const onlyChild = positions.get(kids[0])
      if (onlyChild) positions.set(id, { slot: onlyChild.slot, depth })
    }
  }

  let slotCursor = 0

  // Phase 1 — true roots: clients whose parent either doesn't exist or isn't
  // in the visible set.
  const trueRoots = clientIds.filter((id) => {
    const p = parentMap.get(id)
    return !p || !idSet.has(p)
  })
  for (const rootId of trueRoots) {
    if (globalSeen.has(rootId)) continue
    const leaves = countLeaves(rootId, new Set())
    assignSlots(rootId, 0, slotCursor)
    slotCursor += leaves + 1
  }

  // Phase 2 — anyone still unplaced is stuck in a cycle (A → B → A) or in
  // a chain isolated from any true root. Pick them as pseudo-roots so every
  // client is visible; the cycle stops naturally via globalSeen.
  for (const id of clientIds) {
    if (globalSeen.has(id)) continue
    const leaves = countLeaves(id, new Set())
    assignSlots(id, 0, slotCursor)
    slotCursor += leaves + 1
  }

  // Convert slot → px
  const slotWidth = CARD_W + COL_GAP
  const pxPositions = new Map()
  for (const [id, { slot, depth }] of positions.entries()) {
    pxPositions.set(id, {
      x: Math.round(PAGE_PAD + slot * slotWidth),
      y: Math.round(PAGE_PAD + depth * (CARD_H + ROW_GAP)),
      depth,
    })
  }

  const totalSlots = slotCursor > 0 ? slotCursor - 1 : 0
  const width = Math.round(PAGE_PAD * 2 + Math.max(totalSlots * slotWidth + CARD_W, CARD_W))
  const height = Math.round(PAGE_PAD * 2 + (maxDepth + 1) * (CARD_H + ROW_GAP) - ROW_GAP)
  return { positions: pxPositions, width, height, maxDepth }
}

// Rounded-elbow connector (admin-clean look): parent bottom → down to the
// row gutter → horizontal run to the child column → down to just above the
// child card. Corners are rounded with a constant radius so the path reads
// like a routed PCB trace instead of a jagged L-shape. Direction is
// seller/sponsor (parent) → buyer/filleul (child).
const ARROW_GAP = 14
const ELBOW_R = 14
function connectorPath(parent, child) {
  const x1 = parent.x + CARD_W / 2
  const y1 = parent.y + CARD_H
  const x2 = child.x + CARD_W / 2
  const y2 = child.y - ARROW_GAP
  const midY = y1 + (y2 - y1) / 2
  // Same column → single straight vertical segment, no elbow needed.
  if (Math.abs(x1 - x2) < 1) return `M ${x1} ${y1} L ${x1} ${y2}`
  // Clamp the corner radius so tight rows or narrow horizontal runs still
  // render cleanly (never overshoot the elbow segment lengths).
  const dx = x2 - x1
  const xSign = dx > 0 ? 1 : -1
  const r = Math.max(2, Math.min(ELBOW_R, Math.abs(dx) / 2, midY - y1, y2 - midY))
  return [
    `M ${x1} ${y1}`,
    `L ${x1} ${midY - r}`,
    `Q ${x1} ${midY} ${x1 + r * xSign} ${midY}`,
    `L ${x2 - r * xSign} ${midY}`,
    `Q ${x2} ${midY} ${x2} ${midY + r}`,
    `L ${x2} ${y2}`,
  ].join(' ')
}

// =============================================================================
// Component
// =============================================================================
export default function CommissionOrgChart({ data, selectedClientId, onNodeClick }) {
  const navigate = useNavigate()
  const viewportRef = useRef(null)
  // Single transform state so pan + zoom stay consistent across setState batches.
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const [search, setSearch] = useState('')
  const [isSpaceDown, setIsSpaceDown] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)   // "⋯ more views" dropdown
  const [legendOpen, setLegendOpen] = useState(false) // legend collapsed by default
  // Refs for in-flight drag state — kept out of React so we don't re-render 60×/s.
  const panStateRef = useRef(null)
  const suppressNextClickRef = useRef(false)
  const menuRef = useRef(null)

  // --------- build maps ---------------------------------------------------
  const built = useMemo(() => {
    const clients = data?.clients || []
    const authRels = data?.sellerRelations || []
    const events = data?.commissionEvents || []
    const sales = data?.sales || []
    const reverseGrants = data?.reverseGrants || []

    const clientById = new Map(clients.map((c) => [asId(c.id), c]))

    // Synthetic seller_relations derived from sales. Mirrors the
    // trg_sales_auto_parrainage semantics: first sale's seller becomes the
    // buyer's upline parent. We only add a synthetic row when no
    // authoritative seller_relations row exists for that buyer — this patches
    // over cases where the DB trigger missed (legacy sale, seller added via
    // UPDATE after insert, trigger disabled on migration, etc.) so the chart
    // reflects the real commercial network instead of showing orphan nodes.
    // Shared resolver — stable tie-breaker (see resolveUpline.js) so the
    // tree chart and the detail panel never disagree about a client's
    // parent when two sales share the same notary_completed_at timestamp.
    const { rels, parentMap, childrenMap, syntheticChildSet } = resolveUpline({
      sellerRelations: authRels,
      sales,
    })
    const syntheticEdgeKeys = new Set()
    for (const r of rels) {
      const child = asId(r.child_client_id ?? r.childClientId)
      if (syntheticChildSet.has(child)) {
        const parent = asId(r.parent_client_id ?? r.parentClientId)
        syntheticEdgeKeys.add(`${parent}→${child}`)
      }
    }
    const allIdsRaw = clients.map((c) => asId(c.id)).filter(Boolean)

    // Relevance filter — a client is "in the network" iff it participates in
    // a seller_relation (as parent or child), is the beneficiary of a
    // commission_event, or is the seller on a finalized sale. Clients that
    // match none of these are noise that turns the chart into a wasteland of
    // disconnected single-node forests. Filtering here preserves clientById
    // for the detail panel lookups that use the full dataset.
    const relevantIds = new Set()
    for (const r of rels) {
      const p = asId(r.parent_client_id ?? r.parentClientId)
      const c = asId(r.child_client_id ?? r.childClientId)
      if (p) relevantIds.add(p)
      if (c) relevantIds.add(c)
    }
    for (const e of events) {
      const b = asId(e.beneficiary_client_id ?? e.beneficiaryClientId)
      if (b) relevantIds.add(b)
    }
    for (const s of sales) {
      const seller = asId(s.seller_client_id ?? s.sellerClientId)
      if (seller) relevantIds.add(seller)
    }
    const allIds = allIdsRaw.filter((id) => relevantIds.has(id) && clientById.has(id))
    const hiddenCount = allIdsRaw.length - allIds.length

    // Stats per client: total, paid, payable, pending, per-level, sales_made
    const statsById = new Map()
    for (const cid of allIds) {
      statsById.set(cid, {
        total: 0, paid: 0, payable: 0, pending: 0,
        l1: 0, l2: 0, l3: 0, l4: 0,
        events: 0,
      })
    }
    for (const e of events) {
      const b = asId(e.beneficiary_client_id ?? e.beneficiaryClientId)
      const s = statsById.get(b)
      if (!s) continue
      const amt = Number(e.amount) || 0
      const st = normalizeStatus(e)
      if (st === 'cancelled') continue
      s.total += amt
      s[st] += amt
      const lvl = Number(e.level) || 1
      if (lvl === 1) s.l1 += amt
      else if (lvl === 2) s.l2 += amt
      else if (lvl === 3) s.l3 += amt
      else if (lvl >= 4) s.l4 += amt
      s.events += 1
    }

    // Sales made by each client (as seller)
    const salesCountBySeller = new Map()
    for (const s of sales) {
      const seller = asId(s.seller_client_id ?? s.sellerClientId)
      if (!seller) continue
      salesCountBySeller.set(seller, (salesCountBySeller.get(seller) || 0) + 1)
    }

    // Reverse sales: the buyer is already an ancestor of the seller in the
    // upline tree, so the sale flows "up" the hierarchy instead of down.
    // The commission engine truncates the chain at the buyer (see
    // compute_and_insert_commissions_for_sale in database/03_functions.sql)
    // so there's no illegal payout — but the forward parrainage edge alone
    // hides that a second, reverse commercial transaction happened between
    // these two clients. Surface it explicitly here.
    const reverseEdges = [] // [{ saleId, seller, buyer }]
    const reverseSalesById = new Map() // clientId -> count
    const reverseEdgeKeys = new Set()  // dedupe on (seller→buyer)
    for (const s of sales) {
      const seller = asId(s.seller_client_id ?? s.sellerClientId)
      const buyer  = asId(s.client_id ?? s.clientId)
      if (!seller || !buyer || seller === buyer) continue
      if (!clientById.has(seller) || !clientById.has(buyer)) continue
      // Walk up from the seller — if we hit the buyer, the buyer sits above
      // the seller in the tree, i.e. the sale is reverse relative to the
      // parrainage direction. `seen` also guards against cycles.
      const seen = new Set([seller])
      let cur = parentMap.get(seller)
      let isReverse = false
      while (cur && !seen.has(cur)) {
        if (cur === buyer) { isReverse = true; break }
        seen.add(cur)
        cur = parentMap.get(cur)
      }
      if (!isReverse) continue
      const key = `${seller}→${buyer}`
      reverseSalesById.set(seller, (reverseSalesById.get(seller) || 0) + 1)
      reverseSalesById.set(buyer,  (reverseSalesById.get(buyer)  || 0) + 1)
      if (reverseEdgeKeys.has(key)) continue
      reverseEdgeKeys.add(key)
      reverseEdges.push({ saleId: asId(s.id), seller, buyer })
    }

    // Edges derived from seller_relations (plus source_sale_id when known).
    // `synthetic` flags the ones we inferred from sales above — styled
    // dashed in render so reviewers can tell authoritative parrainage edges
    // from sale-inferred ones.
    const edges = []
    for (const r of rels) {
      const parent = asId(r.parent_client_id ?? r.parentClientId)
      const child = asId(r.child_client_id ?? r.childClientId)
      if (!parent || !child) continue
      if (!clientById.has(parent) || !clientById.has(child)) continue
      const key = `${parent}→${child}`
      edges.push({
        parent,
        child,
        sourceSaleId: asId(r.source_sale_id ?? r.sourceSaleId) || null,
        synthetic: syntheticEdgeKeys.has(key),
      })
    }

    // Reverse-sale grants: purple directed edge from source → beneficiary
    // representing the acquired right (distinct from the red dashed arrow,
    // which is the transaction). For hover-highlight we precompute the
    // qualifying subtree — descendants of `source` whose incoming edge from
    // their parent was linked AFTER the grant's effective_from.
    const grantEdges = []
    const grantCountsBySource = new Map()       // sourceId -> active grant count
    const grantCountsByBeneficiary = new Map()  // beneficiaryId -> active grant count
    const grantQualifyingNodesById = new Map()  // grantId -> Set<nodeId>
    const edgeLinkedAtByKey = new Map()
    for (const r of rels) {
      const p = asId(r.parent_client_id ?? r.parentClientId)
      const c = asId(r.child_client_id ?? r.childClientId)
      const at = r.linked_at ?? r.linkedAt
      if (p && c && at) edgeLinkedAtByKey.set(`${p}→${c}`, Date.parse(at))
    }
    for (const g of reverseGrants) {
      if ((g?.status || 'active') !== 'active') continue
      const source = asId(g.source_client_id ?? g.sourceClientId)
      const beneficiary = asId(g.beneficiary_client_id ?? g.beneficiaryClientId)
      if (!source || !beneficiary) continue
      if (!clientById.has(source) || !clientById.has(beneficiary)) continue
      const effTs = Date.parse(g.effective_from ?? g.effectiveFrom ?? '')
      grantCountsBySource.set(source, (grantCountsBySource.get(source) || 0) + 1)
      grantCountsByBeneficiary.set(beneficiary, (grantCountsByBeneficiary.get(beneficiary) || 0) + 1)

      // BFS descendants of source in the parent/children graph. Include a
      // descendant in the qualifying set when the edge (parent → this node)
      // was linked AFTER effective_from.
      const qualifying = new Set()
      const seen = new Set([source])
      const queue = [source]
      while (queue.length) {
        const cur = queue.shift()
        const kids = childrenMap.get(cur)
        if (!kids) continue
        for (const rawKid of kids) {
          const kid = asId(rawKid)
          if (!kid || seen.has(kid)) continue
          seen.add(kid)
          const edgeAt = edgeLinkedAtByKey.get(`${cur}→${kid}`)
          if (Number.isFinite(edgeAt) && Number.isFinite(effTs) && edgeAt > effTs) {
            qualifying.add(kid)
            // Descendants of a qualifying node also inherit eligibility.
            const sub = [kid]
            const subSeen = new Set([kid])
            while (sub.length) {
              const n = sub.shift()
              const nk = childrenMap.get(n)
              if (!nk) continue
              for (const rk of nk) {
                const kk = asId(rk)
                if (!kk || subSeen.has(kk)) continue
                subSeen.add(kk); qualifying.add(kk); sub.push(kk)
              }
            }
          }
          queue.push(kid)
        }
      }

      grantEdges.push({
        id: asId(g.id),
        source,
        beneficiary,
        effectiveFrom: g.effective_from ?? g.effectiveFrom,
        triggerSaleId: asId(g.trigger_sale_id ?? g.triggerSaleId),
      })
      grantQualifyingNodesById.set(asId(g.id), qualifying)
    }

    return {
      clientById, childrenMap, parentMap, allIds, edges, statsById, salesCountBySeller,
      hiddenCount,
      syntheticCount: syntheticChildSet.size,
      reverseEdges, reverseSalesById,
      grantEdges, grantCountsBySource, grantCountsByBeneficiary, grantQualifyingNodesById,
    }
  }, [data])

  const layout = useMemo(() => {
    return layoutForest(built.allIds, built.childrenMap, built.parentMap)
  }, [built.allIds, built.childrenMap, built.parentMap])

  // --------- search highlights --------------------------------------------
  const searchMatchIds = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    const s = new Set()
    for (const [id, c] of built.clientById.entries()) {
      const hay = `${clientName(c)} ${c.code || ''} ${c.phone || c.phone_normalized || ''}`.toLowerCase()
      if (hay.includes(q)) s.add(id)
    }
    return s
  }, [search, built.clientById])

  // --------- lineage (ancestors + descendants of selected) ----------------
  // When the user clicks a node we highlight its full vertical lineage so the
  // "who refers whom" story is legible even when the tree is messy. Null when
  // nothing is selected → normal (un-dimmed) view.
  const selectedIdNorm = asId(selectedClientId) || null
  const lineageIds = useMemo(() => {
    if (!selectedIdNorm) return null
    const s = new Set([selectedIdNorm])
    // ancestors — walk up until parent is missing or we loop
    let cur = selectedIdNorm
    const seenUp = new Set([selectedIdNorm])
    // DEFAULT_MAX_DEPTH is 40 in referralTree.js; same bound here guards cycles.
    for (let i = 0; i < 40; i += 1) {
      const p = built.parentMap.get(cur)
      if (!p || seenUp.has(p)) break
      seenUp.add(p); s.add(p); cur = p
    }
    // descendants — BFS, bounded by seen set (also kills cycles)
    const queue = [selectedIdNorm]
    const seenDown = new Set([selectedIdNorm])
    while (queue.length) {
      const node = queue.shift()
      const kids = built.childrenMap.get(node)
      if (!kids) continue
      for (const k of kids) {
        const kid = asId(k)
        if (!kid || seenDown.has(kid)) continue
        seenDown.add(kid); s.add(kid); queue.push(kid)
      }
    }
    return s
  }, [selectedIdNorm, built.parentMap, built.childrenMap])

  // --------- zoom + pan (transform-based: drag to pan, wheel to zoom) ------
  // Zoom toward a specific screen point, keeping that point "anchored" under
  // the cursor. Used by wheel and by the +/− buttons (which anchor to center).
  const zoomAtPoint = useCallback((newZoomRaw, anchorX, anchorY) => {
    setView((v) => {
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoomRaw))
      if (newZoom === v.zoom) return v
      // Solve for pan so the world point under (anchorX, anchorY) stays put:
      //   world = (anchor - pan) / zoom   ⇒   newPan = anchor - world * newZoom
      const worldX = (anchorX - v.x) / v.zoom
      const worldY = (anchorY - v.y) / v.zoom
      return {
        zoom: newZoom,
        x: anchorX - worldX * newZoom,
        y: anchorY - worldY * newZoom,
      }
    })
  }, [])

  const zoomBy = useCallback((factor) => {
    const box = viewportRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    zoomAtPoint(view.zoom * (1 + factor), rect.width / 2, rect.height / 2)
  }, [view.zoom, zoomAtPoint])

  const zoomReset = useCallback(() => {
    const box = viewportRef.current
    if (!box) { setView({ x: 0, y: 0, zoom: 1 }); return }
    const rect = box.getBoundingClientRect()
    // center the canvas at 100%
    setView({
      x: (rect.width - layout.width) / 2,
      y: (rect.height - layout.height) / 2,
      zoom: 1,
    })
  }, [layout.width, layout.height])

  const fitToScreen = useCallback(() => {
    const box = viewportRef.current
    if (!box || layout.width === 0) return
    const rect = box.getBoundingClientRect()
    const scaleW = (rect.width - 40) / layout.width
    const scaleH = (rect.height - 40) / layout.height
    const next = Math.min(1.0, Math.max(ZOOM_MIN, Math.min(scaleW, scaleH)))
    // Center the scaled canvas inside the viewport.
    setView({
      zoom: next,
      x: (rect.width - layout.width * next) / 2,
      y: (rect.height - layout.height * next) / 2,
    })
  }, [layout.width, layout.height])

  // Fit on first load so the full tree is visible.
  // `layout.width` is the right trigger — we want to re-fit when the tree
  // shape changes (data reload), not when fitToScreen's identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fitToScreen() }, [layout.width, layout.height])

  // ---- Wheel zoom (non-passive so we can preventDefault the page scroll) ---
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return undefined
    const onWheel = (e) => {
      // Only zoom when the cursor is actually over the canvas.
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const anchorX = e.clientX - rect.left
      const anchorY = e.clientY - rect.top
      setView((v) => {
        const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY)
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor))
        if (newZoom === v.zoom) return v
        const worldX = (anchorX - v.x) / v.zoom
        const worldY = (anchorY - v.y) / v.zoom
        return { zoom: newZoom, x: anchorX - worldX * newZoom, y: anchorY - worldY * newZoom }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- Spacebar tracking (held = cursor becomes grab, click anywhere pans) -
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === 'Space' && !e.repeat) {
        // Don't steal space from inputs / textareas.
        const t = e.target
        const tag = t?.tagName || ''
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
        setIsSpaceDown(true)
        e.preventDefault()
      }
    }
    const onKeyUp = (e) => {
      if (e.code === 'Space') setIsSpaceDown(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // ---- Mouse pan (left-drag on empty area OR anywhere while space is held)
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return // left button only
    const clickedCard = e.target.closest && e.target.closest('.cog-card')
    const clickedToolbar = e.target.closest && e.target.closest('.cog-toolbar, .cog-tools, .cog-legend, .cog-menu')
    if (clickedToolbar) return
    // If user clicks on a card and space isn't held → let the card handle it.
    if (clickedCard && !isSpaceDown) return
    panStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: view.x,
      origY: view.y,
      moved: 0,
    }
    setIsPanning(true)
    // Space+drag should suppress the click from firing on whatever card we release over.
    if (isSpaceDown) e.preventDefault()
  }, [isSpaceDown, view.x, view.y])

  useEffect(() => {
    if (!isPanning) return undefined
    const onMove = (e) => {
      const st = panStateRef.current
      if (!st) return
      const dx = e.clientX - st.startX
      const dy = e.clientY - st.startY
      st.moved = Math.max(st.moved, Math.abs(dx) + Math.abs(dy))
      setView((v) => ({ ...v, x: st.origX + dx, y: st.origY + dy }))
    }
    const onUp = () => {
      const st = panStateRef.current
      if (st && st.moved > PAN_CLICK_THRESHOLD) suppressNextClickRef.current = true
      panStateRef.current = null
      setIsPanning(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isPanning])

  // --------- selection highlight ------------------------------------------
  const selectedId = selectedIdNorm
  const handleCardClick = useCallback((id) => {
    // Suppress the click that fires at the end of a pan-drag.
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }
    onNodeClick?.(id)
  }, [onNodeClick])

  // --------- edge hover ---------------------------------------------------
  const [hoverEdge, setHoverEdge] = useState(null)
  // Grant arcs were removed — the purple card badges carry the same info
  // without adding a second curve between the same pair of nodes. Keeping a
  // constant `null` here lets the qualifying-highlight code below stay
  // inert without rewiring all the grant metadata downstream.
  const hoverGrantId = null

  // Close the "more views" menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return undefined
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // --------- render -------------------------------------------------------
  // `allIds.length` = laid-out cards (post relevance-filter). `clientById.size`
  // counts every client ever loaded — we want the visible count for empty
  // detection so a fully-noise dataset still resolves to "empty network".
  const clientsCount = built.allIds.length
  const isEmpty = clientsCount === 0

  const cursorClass = isPanning
    ? 'cog--grabbing'
    : isSpaceDown
      ? 'cog--grab'
      : ''

  return (
    <div
      className={`cog ${cursorClass}`}
      role="application"
      aria-label="Organigramme des commissions"
      ref={viewportRef}
      onMouseDown={handleMouseDown}
    >
      {/* ── Top-left toolbar: back + title + search + zoom ─────────────── */}
      <div className="cog-toolbar">
        <button
          type="button"
          className="cog-toolbar__btn cog-toolbar__btn--ghost"
          onClick={() => navigate('/admin')}
          aria-label="Retour"
          title="Retour"
        >
          <span aria-hidden>←</span>
        </button>
        <div className="cog-toolbar__title" title="Réseau des commissions">
          <span className="cog-toolbar__title-main">Réseau</span>
          <span className="cog-toolbar__title-sub">
            {built.hiddenCount > 0
              ? `${clientsCount} actifs · ${built.hiddenCount} hors réseau`
              : `${clientsCount} nœud${clientsCount > 1 ? 's' : ''}`}
          </span>
        </div>
        <div className="cog-toolbar__sep" aria-hidden />
        <input
          type="search"
          className="cog-toolbar__search"
          placeholder="Rechercher…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Rechercher un membre du réseau"
          title={
            built.hiddenCount > 0
              ? `${built.hiddenCount} clients sans rôle dans le réseau (aucun parrainage, aucune vente, aucune commission) sont masqués pour la lisibilité.`
              : undefined
          }
        />
        <div className="cog-toolbar__zoomgroup" role="group" aria-label="Zoom">
          <button type="button" className="cog-toolbar__btn" onClick={() => zoomBy(-ZOOM_STEP)} aria-label="Zoom arrière" title="Zoom −">−</button>
          <span className="cog-toolbar__zoom" aria-live="polite">{Math.round(view.zoom * 100)}%</span>
          <button type="button" className="cog-toolbar__btn" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom avant" title="Zoom +">+</button>
        </div>
        <button type="button" className="cog-toolbar__btn cog-toolbar__btn--wide" onClick={fitToScreen} title="Ajuster à l'écran">Ajuster</button>
      </div>

      {/* ── Top-right: legend toggle + more-views menu ───────────────────── */}
      <div className="cog-tools" ref={menuRef}>
        <button
          type="button"
          className={`cog-tools__btn ${legendOpen ? 'cog-tools__btn--on' : ''}`}
          onClick={() => setLegendOpen((v) => !v)}
          aria-expanded={legendOpen}
          aria-label="Afficher/masquer la légende"
          title="Légende"
        >
          <span className="cog-tools__ico" aria-hidden>ⓘ</span>
          <span className="cog-tools__lbl">Légende</span>
        </button>
        <button
          type="button"
          className={`cog-tools__btn ${menuOpen ? 'cog-tools__btn--on' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="Autres vues"
        >
          <span className="cog-tools__ico" aria-hidden>⋯</span>
          <span className="cog-tools__lbl">Autres vues</span>
        </button>
        {menuOpen ? (
          <div className="cog-menu" role="menu">
            <div className="cog-menu__head">Vues détaillées</div>
            <Link to="/admin/commissions/ledger"         className="cog-menu__item" role="menuitem" onClick={() => setMenuOpen(false)}>
              <span className="cog-menu__ico" aria-hidden>💰</span>
              <span className="cog-menu__text"><strong>Journal</strong><small>Événements de commission détaillés</small></span>
            </Link>
            <Link to="/admin/commissions/analytics"      className="cog-menu__item" role="menuitem" onClick={() => setMenuOpen(false)}>
              <span className="cog-menu__ico" aria-hidden>📈</span>
              <span className="cog-menu__text"><strong>Analyses</strong><small>Tendances et répartitions</small></span>
            </Link>
            <Link to="/admin/commissions/reverse-grants" className="cog-menu__item" role="menuitem" onClick={() => setMenuOpen(false)}>
              <span className="cog-menu__ico" aria-hidden>⇅</span>
              <span className="cog-menu__text"><strong>Droits acquis</strong><small>Ventes inversées qualifiantes</small></span>
            </Link>
            <Link to="/admin/commissions/anomalies"      className="cog-menu__item" role="menuitem" onClick={() => setMenuOpen(false)}>
              <span className="cog-menu__ico" aria-hidden>⚠</span>
              <span className="cog-menu__text"><strong>Anomalies</strong><small>Cycles, orphelins, incohérences</small></span>
            </Link>
          </div>
        ) : null}
      </div>

      {/* ── Legend — collapsed by default so the tree reads first ──────── */}
      {legendOpen ? (
        <div className="cog-legend" role="note">
          <div className="cog-legend__group">
            <div className="cog-legend__title">Générations</div>
            <div className="cog-legend__row"><span className="cog-legend__dot cog-legend__dot--g1" /> G1 — Racine</div>
            <div className="cog-legend__row"><span className="cog-legend__dot cog-legend__dot--g2" /> G2</div>
            <div className="cog-legend__row"><span className="cog-legend__dot cog-legend__dot--g3" /> G3</div>
            <div className="cog-legend__row"><span className="cog-legend__dot cog-legend__dot--g4" /> G4+</div>
          </div>
          <div className="cog-legend__group">
            <div className="cog-legend__title">Liens</div>
            <div className="cog-legend__row">
              <svg width="34" height="10" aria-hidden className="cog-legend__swatch">
                <line x1="2" y1="5" x2="28" y2="5" stroke="#2563eb" strokeWidth="2.4" strokeLinecap="round" />
                <path d="M 28 2 L 34 5 L 28 8 z" fill="#1d4ed8" />
              </svg>
              <span>Parrain → filleul</span>
            </div>
            {built.syntheticCount > 0 ? (
              <div className="cog-legend__row" title="Lien déduit d'une vente (aucun parrainage enregistré).">
                <svg width="34" height="10" aria-hidden className="cog-legend__swatch">
                  <line x1="2" y1="5" x2="34" y2="5" stroke="#94a3b8" strokeWidth="1.8" strokeDasharray="4 4" />
                </svg>
                <span>Déduit d'une vente</span>
              </div>
            ) : null}
            {built.reverseEdges.length > 0 ? (
              <div className="cog-legend__row" title="Vente inversée — un filleul a vendu à son parrain (ou à un ascendant).">
                <svg width="38" height="12" aria-hidden className="cog-legend__swatch">
                  <path d="M 4 9 C 18 9, 26 3, 34 3" fill="none" stroke="#dc2626" strokeWidth="1.6" strokeLinecap="round" />
                  <path d="M 30 0.5 L 36 3 L 30 5.5 z" fill="#dc2626" />
                </svg>
                <span>Vente inversée ({built.reverseEdges.length})</span>
              </div>
            ) : null}
          </div>
          <div className="cog-legend__hint">
            Cliquer : lignée · Molette : zoom · Glisser : déplacer
          </div>
        </div>
      ) : null}

      <div className="cog-viewport">
        {isEmpty ? (
          <div className="cog-empty">
            <div className="cog-empty__icon" aria-hidden>🌱</div>
            <div className="cog-empty__title">Aucune donnée</div>
            <div className="cog-empty__sub">Créez des clients et des ventes pour voir l’organigramme.</div>
          </div>
        ) : (
          <div
            className="cog-canvas"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            }}
          >
            {/* Connectors layer */}
            <svg
              className="cog-edges"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-hidden
            >
              <defs>
                {/* Clean, slim arrowhead (M 0 0 L 8 4 L 0 8 z) sized so the
                    tip nests neatly in the gap above the child card without
                    dwarfing the stroke. Triangles share geometry; only the
                    fill changes per edge type. */}
                <marker id="cog-arrow" viewBox="0 0 8 8" refX="7.5" refY="4"
                        markerWidth="9" markerHeight="9" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="#64748b" />
                </marker>
                <marker id="cog-arrow--active" viewBox="0 0 8 8" refX="7.5" refY="4"
                        markerWidth="10" markerHeight="10" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="#1d4ed8" />
                </marker>
                <marker id="cog-arrow--reverse" viewBox="0 0 8 8" refX="7.5" refY="4"
                        markerWidth="9" markerHeight="9" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="#dc2626" />
                </marker>
              </defs>
              {/* Reverse-sale arrows — a filleul sold to their parrain
                  (or an ancestor). The arrow points seller → buyer so the
                  direction of the transaction reads at a glance. Routed
                  along the RIGHT edge of both cards with a tight bow so it
                  lives alongside the forward parrainage spine instead of
                  bowing wide across the tree. The purple grant arcs (acquired
                  rights) were dropped — the purple card badges already
                  signal them and adding a second curve for the same pair
                  was the source of the "double arrows" confusion. */}
              {built.reverseEdges.map((re, i) => {
                const sp = layout.positions.get(re.seller)
                const bp = layout.positions.get(re.buyer)
                if (!sp || !bp) return null
                // Anchor on the right edges so the forward parrainage arrows
                // (which enter/exit via card centers) don't collide.
                const x1 = sp.x + CARD_W - 6
                const y1 = sp.y + 14
                const x2 = bp.x + CARD_W - 6
                const y2 = bp.y + CARD_H - 14
                // Tight bow: 36–60 px outward. Keeps the curve close to the
                // cards so it never crosses unrelated nodes.
                const bow = Math.max(36, Math.min(72, Math.abs(y1 - y2) * 0.22))
                const cx = Math.max(x1, x2) + bow
                const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`
                return (
                  <g key={`rev-${re.saleId}-${i}`} className="cog-edge cog-edge--reverse">
                    <path
                      d={d}
                      fill="none"
                      stroke="#dc2626"
                      strokeWidth={1.6}
                      strokeLinecap="round"
                      markerEnd="url(#cog-arrow--reverse)"
                    >
                      <title>
                        Vente inversée — le vendeur a vendu à son propre parrain
                        (ou à un ancêtre). Le chaînage des commissions est tronqué
                        au niveau de l'acheteur.
                      </title>
                    </path>
                  </g>
                )
              })}
              {built.edges.map((edge, i) => {
                const p = layout.positions.get(edge.parent)
                const c = layout.positions.get(edge.child)
                if (!p || !c) return null
                // An edge is "active" when BOTH endpoints are in the selected
                // node's lineage — i.e. it's part of the path linking the
                // selection to its ancestors or descendants. This lights up
                // the entire vertical spine instead of a single hop.
                const isActive = Boolean(
                  lineageIds && lineageIds.has(edge.parent) && lineageIds.has(edge.child),
                )
                const isHover = hoverEdge === i
                const isDimmed = Boolean(lineageIds) && !isActive
                // Tooltip: "<sponsor/seller> → <buyer/filleul>". Makes the
                // arrow's meaning unambiguous — the visual arrowhead already
                // points from parent down to child, but the tooltip spells
                // out the direction for reviewers.
                const parentName = built.clientById.get(edge.parent)?.full_name
                  || built.clientById.get(edge.parent)?.name
                  || edge.parent
                const childName = built.clientById.get(edge.child)?.full_name
                  || built.clientById.get(edge.child)?.name
                  || edge.child
                const tooltipText = edge.synthetic
                  ? `${parentName} → ${childName} (lien déduit d'une vente — pas de parrainage enregistré)`
                  : `${parentName} → ${childName}`
                // Idle strokes are a quiet slate so the tree reads as
                // "structure" rather than "noise"; the active lineage lifts
                // to crisp blue so the spine pops out on selection.
                const stroke = isActive ? '#1d4ed8' : (isHover ? '#475569' : '#94a3b8')
                const width  = isActive ? 2.4 : (isHover ? 2 : 1.6)
                return (
                  <g
                    key={`${edge.parent}-${edge.child}-${i}`}
                    className={`cog-edge ${isActive ? 'cog-edge--active' : ''} ${isHover ? 'cog-edge--hover' : ''} ${isDimmed ? 'cog-edge--dim' : ''} ${edge.synthetic ? 'cog-edge--synthetic' : ''}`}
                    onMouseEnter={() => setHoverEdge(i)}
                    onMouseLeave={() => setHoverEdge((h) => (h === i ? null : h))}
                  >
                    <path
                      d={connectorPath(p, c)}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={width}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray={edge.synthetic ? '4 5' : undefined}
                      markerEnd={`url(#${isActive ? 'cog-arrow--active' : 'cog-arrow'})`}
                    >
                      <title>{tooltipText}</title>
                    </path>
                  </g>
                )
              })}
            </svg>

            {/* Cards layer */}
            {Array.from(layout.positions.entries()).map(([id, pos]) => {
              const c = built.clientById.get(id)
              if (!c) return null
              const s = built.statsById.get(id) || { total: 0, paid: 0, payable: 0, pending: 0, l1: 0, l2: 0, l3: 0, l4: 0 }
              const salesMade = built.salesCountBySeller.get(id) || 0
              const reverseCount = built.reverseSalesById.get(id) || 0
              const grantsGiven  = built.grantCountsBySource.get(id) || 0
              const grantsGot    = built.grantCountsByBeneficiary.get(id) || 0
              const qualifyingSet = hoverGrantId ? built.grantQualifyingNodesById.get(hoverGrantId) : null
              const isQualifying = qualifyingSet && qualifyingSet.has(id)
              const depth = pos.depth
              const genClass = GEN_CLASSES[Math.min(depth, GEN_CLASSES.length - 1)]
              const genLabel = GEN_LABELS[Math.min(depth, GEN_LABELS.length - 1)]
              const isSelected = selectedId === id
              // Dim if it fails the search filter OR (when something is
              // selected) isn't in that node's upline/downline lineage.
              const isDimmed =
                (searchMatchIds && !searchMatchIds.has(id))
                || (lineageIds && !lineageIds.has(id))
              return (
                <button
                  type="button"
                  key={id}
                  className={`cog-card ${genClass} ${isSelected ? 'cog-card--selected' : ''} ${isDimmed ? 'cog-card--dim' : ''} ${reverseCount > 0 ? 'cog-card--reverse' : ''} ${isQualifying ? 'cog-card--grant-qualifying' : ''}`}
                  style={{ left: pos.x, top: pos.y, width: CARD_W, height: CARD_H }}
                  onClick={() => handleCardClick(id)}
                  aria-label={`${clientName(c)}, ${genLabel}, total ${fmtMoney(s.total)} TND`}
                >
                  <div className="cog-card__head">
                    <span className="cog-card__avatar" aria-hidden>{clientInitials(c)}</span>
                    <div className="cog-card__head-text">
                      <div className="cog-card__name" title={clientName(c)}>{clientName(c)}</div>
                      <div className="cog-card__meta">
                        <span className="cog-card__gen">{genLabel}</span>
                        {salesMade > 0 ? <span className="cog-card__sales">· {salesMade} vente{salesMade > 1 ? 's' : ''}</span> : null}
                        {reverseCount > 0 ? (
                          <span
                            className="cog-card__reverse-badge"
                            title={`${reverseCount} vente${reverseCount > 1 ? 's' : ''} inversée${reverseCount > 1 ? 's' : ''} — un parrain et son filleul ont aussi effectué une transaction dans l'autre sens.`}
                          >
                            ⇅ {reverseCount}
                          </span>
                        ) : null}
                        {grantsGiven > 0 ? (
                          <span
                            className="cog-card__grant-badge cog-card__grant-badge--source"
                            title={`${grantsGiven} droit${grantsGiven > 1 ? 's' : ''} acquis — ce client a vendu à un filleul, qui perçoit désormais une commission L1 sur les nouvelles recrues de ce client.`}
                          >
                            +{grantsGiven} droit{grantsGiven > 1 ? 's' : ''}
                          </span>
                        ) : null}
                        {grantsGot > 0 ? (
                          <span
                            className="cog-card__grant-badge cog-card__grant-badge--beneficiary"
                            title={`${grantsGot} droit${grantsGot > 1 ? 's' : ''} hérité${grantsGot > 1 ? 's' : ''} — ce client touche une commission L1 sur les nouvelles ventes issues des recrues de la source du droit.`}
                          >
                            {grantsGot} hérité{grantsGot > 1 ? 's' : ''}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="cog-card__total">
                    <span className="cog-card__total-value">{fmtMoney(s.total)}</span>
                    <span className="cog-card__total-unit">TND</span>
                  </div>
                  <div className="cog-card__levels">
                    {s.l1 > 0 ? <span className="cog-card__lvl cog-card__lvl--l1" title={`L1 ${fmtMoney(s.l1)} TND`}>L1 {fmtMoney(s.l1)}</span> : null}
                    {s.l2 > 0 ? <span className="cog-card__lvl cog-card__lvl--l2" title={`L2 ${fmtMoney(s.l2)} TND`}>L2 {fmtMoney(s.l2)}</span> : null}
                    {s.l3 > 0 ? <span className="cog-card__lvl cog-card__lvl--l3" title={`L3 ${fmtMoney(s.l3)} TND`}>L3 {fmtMoney(s.l3)}</span> : null}
                    {s.l4 > 0 ? <span className="cog-card__lvl cog-card__lvl--l4" title={`L4+ ${fmtMoney(s.l4)} TND`}>L4+ {fmtMoney(s.l4)}</span> : null}
                    {s.l1 === 0 && s.l2 === 0 && s.l3 === 0 && s.l4 === 0 ? (
                      <span className="cog-card__lvl cog-card__lvl--empty">Aucune commission</span>
                    ) : null}
                  </div>
                  {s.payable > 0 ? (
                    <div className="cog-card__due" title={`${fmtMoney(s.payable)} TND à payer`}>
                      <span className="cog-card__due-dot" aria-hidden />
                      {fmtMoney(s.payable)} à payer
                    </div>
                  ) : null}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
