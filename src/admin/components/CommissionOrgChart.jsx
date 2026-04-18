import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as tree from '../lib/referralTree.js'
import './commission-org-chart.css'

// =============================================================================
// Visual constants — tweak these to rescale the whole chart at once.
// =============================================================================
const CARD_W = 200
const CARD_H = 118
const COL_GAP = 36   // space between sibling cards
const ROW_GAP = 72   // vertical space between parent and child rows
const PAGE_PAD = 48  // breathing room around the tree

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

// Right-angle connector: down from parent bottom → horizontal to child column → down to child top.
function connectorPath(parent, child) {
  const x1 = parent.x + CARD_W / 2
  const y1 = parent.y + CARD_H
  const x2 = child.x + CARD_W / 2
  const y2 = child.y
  const midY = y1 + (y2 - y1) / 2
  // Straight vertical if aligned.
  if (Math.abs(x1 - x2) < 1) {
    return `M ${x1} ${y1} L ${x1} ${y2}`
  }
  return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
}

// =============================================================================
// Component
// =============================================================================
export default function CommissionOrgChart({ data, selectedClientId, onNodeClick }) {
  const viewportRef = useRef(null)
  // Single transform state so pan + zoom stay consistent across setState batches.
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const [search, setSearch] = useState('')
  const [isSpaceDown, setIsSpaceDown] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  // Refs for in-flight drag state — kept out of React so we don't re-render 60×/s.
  const panStateRef = useRef(null)
  const suppressNextClickRef = useRef(false)

  // --------- build maps ---------------------------------------------------
  const built = useMemo(() => {
    const clients = data?.clients || []
    const rels = data?.sellerRelations || []
    const events = data?.commissionEvents || []
    const sales = data?.sales || []

    const clientById = new Map(clients.map((c) => [asId(c.id), c]))
    const childrenMap = tree.buildChildrenMap(rels)
    const parentMap = tree.buildParentMap(rels)
    const allIds = clients.map((c) => asId(c.id)).filter(Boolean)

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

    // Edges derived from seller_relations (plus source_sale_id when known)
    const edges = []
    for (const r of rels) {
      const parent = asId(r.parent_client_id ?? r.parentClientId)
      const child = asId(r.child_client_id ?? r.childClientId)
      if (!parent || !child) continue
      if (!clientById.has(parent) || !clientById.has(child)) continue
      edges.push({ parent, child, sourceSaleId: asId(r.source_sale_id ?? r.sourceSaleId) || null })
    }

    return {
      clientById, childrenMap, parentMap, allIds, edges, statsById, salesCountBySeller,
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
    const clickedToolbar = e.target.closest && e.target.closest('.cog-toolbar, .cog-legend')
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
  const selectedId = asId(selectedClientId) || null
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

  // --------- render -------------------------------------------------------
  const clientsCount = built.clientById.size
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
      {/* Top-left floating toolbar */}
      <div className="cog-toolbar">
        <input
          type="search"
          className="cog-toolbar__search"
          placeholder={`Rechercher (${clientsCount}) …`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Rechercher un membre du réseau"
        />
        <button type="button" className="cog-toolbar__btn" onClick={() => zoomBy(-ZOOM_STEP)} aria-label="Zoom arrière" title="Zoom −">−</button>
        <span className="cog-toolbar__zoom" aria-live="polite">{Math.round(view.zoom * 100)}%</span>
        <button type="button" className="cog-toolbar__btn" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom avant" title="Zoom +">+</button>
        <button type="button" className="cog-toolbar__btn cog-toolbar__btn--wide" onClick={fitToScreen} title="Ajuster à l'écran">Ajuster</button>
        <button type="button" className="cog-toolbar__btn cog-toolbar__btn--wide" onClick={zoomReset} title="Centrer à 100%">1:1</button>
      </div>

      {/* Top-right legend */}
      <div className="cog-legend" aria-hidden>
        <div className="cog-legend__title">Générations</div>
        <div className="cog-legend__row"><span className="cog-legend__dot cog-legend__dot--g1" /> G1 — Racine</div>
        <div className="cog-legend__row"><span className="cog-legend__dot cog-legend__dot--g2" /> G2</div>
        <div className="cog-legend__row"><span className="cog-legend__dot cog-legend__dot--g3" /> G3</div>
        <div className="cog-legend__row"><span className="cog-legend__dot cog-legend__dot--g4" /> G4+</div>
        <div className="cog-legend__hint">Flèche = parrain → filleul</div>
        <div className="cog-legend__hint">Molette : zoom · Glisser : déplacer · Espace + glisser : partout</div>
      </div>

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
                <marker
                  id="cog-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
                </marker>
                <marker
                  id="cog-arrow--active"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#1d4ed8" />
                </marker>
              </defs>
              {built.edges.map((edge, i) => {
                const p = layout.positions.get(edge.parent)
                const c = layout.positions.get(edge.child)
                if (!p || !c) return null
                const isActive = selectedId && (selectedId === edge.parent || selectedId === edge.child)
                const isHover = hoverEdge === i
                return (
                  <g
                    key={`${edge.parent}-${edge.child}-${i}`}
                    className={`cog-edge ${isActive ? 'cog-edge--active' : ''} ${isHover ? 'cog-edge--hover' : ''}`}
                    onMouseEnter={() => setHoverEdge(i)}
                    onMouseLeave={() => setHoverEdge((h) => (h === i ? null : h))}
                  >
                    <path
                      d={connectorPath(p, c)}
                      fill="none"
                      stroke={isActive ? '#1d4ed8' : '#cbd5e1'}
                      strokeWidth={isActive ? 2.5 : 1.8}
                      markerEnd={`url(#${isActive ? 'cog-arrow--active' : 'cog-arrow'})`}
                    />
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
              const depth = pos.depth
              const genClass = GEN_CLASSES[Math.min(depth, GEN_CLASSES.length - 1)]
              const genLabel = GEN_LABELS[Math.min(depth, GEN_LABELS.length - 1)]
              const isSelected = selectedId === id
              const isDimmed = searchMatchIds && !searchMatchIds.has(id)
              return (
                <button
                  type="button"
                  key={id}
                  className={`cog-card ${genClass} ${isSelected ? 'cog-card--selected' : ''} ${isDimmed ? 'cog-card--dim' : ''}`}
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
