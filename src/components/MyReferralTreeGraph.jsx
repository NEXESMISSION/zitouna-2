import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './my-referral-tree-graph.css'

// Visual pan/zoom tree rendered inside the MyReferralTree popup. Mirrors the
// admin CommissionOrgChart's UX (drag to pan, wheel to zoom, click a card to
// see its details) but works off the per-user subtree the dashboard already
// builds from the signed-in user's own commission_events — no extra fetches.

const CARD_W = 200
const CARD_H = 100
const COL_GAP = 32
const ROW_GAP = 70
const PAGE_PAD = 56
const ZOOM_MIN = 0.3
const ZOOM_MAX = 2.5
const WHEEL_SENSITIVITY = 0.0015

function fmtMoney(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${Math.round(v / 1000)}k`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })
}

function nodeInitials(name) {
  return String(name || '—').trim().split(/\s+/).slice(0, 2)
    .map((s) => s[0] || '').join('').toUpperCase() || '?'
}

// Layout a nested tree top-down with subtree packing. Each node in the input
// carries `{ id, name, depth, earnings, sales, phone, children }`. Returns a
// flat list of placed nodes `{ id, x, y, ...node }` plus canvas bounds.
function layoutTree(rootNode) {
  const placed = []
  let maxX = 0
  let maxY = 0

  function countLeaves(node) {
    const kids = Array.isArray(node.children) ? node.children : []
    if (kids.length === 0) return 1
    let sum = 0
    for (const k of kids) sum += countLeaves(k)
    return sum
  }

  function place(node, xOffset, depth) {
    const leaves = countLeaves(node)
    const subtreeWidth = leaves * (CARD_W + COL_GAP) - COL_GAP
    const cx = xOffset + subtreeWidth / 2
    const x = cx - CARD_W / 2
    const y = depth * (CARD_H + ROW_GAP)
    const placedNode = { ...node, x, y, cx, cy: y + CARD_H / 2 }
    placed.push(placedNode)
    if (x + CARD_W > maxX) maxX = x + CARD_W
    if (y + CARD_H > maxY) maxY = y + CARD_H
    const kids = Array.isArray(node.children) ? node.children : []
    let cursor = xOffset
    for (const k of kids) {
      const kLeaves = countLeaves(k)
      const kWidth = kLeaves * (CARD_W + COL_GAP) - COL_GAP
      const kPlaced = place(k, cursor, depth + 1)
      placedNode.childRefs = placedNode.childRefs || []
      placedNode.childRefs.push(kPlaced)
      cursor += kWidth + COL_GAP
    }
    return placedNode
  }

  place(rootNode, 0, 0)

  // Build edge list (parent-center-bottom → child-center-top, smooth curve).
  const edges = []
  for (const n of placed) {
    if (!Array.isArray(n.childRefs)) continue
    for (const c of n.childRefs) {
      edges.push({ from: n, to: c })
    }
  }

  return {
    nodes: placed,
    edges,
    width: maxX + PAGE_PAD * 2,
    height: maxY + PAGE_PAD * 2,
  }
}

function NodeCard({ node, selected, highlighted, onClick, isRoot }) {
  const tone = isRoot
    ? 'root'
    : node.depth === 1 ? 'd1'
      : node.depth === 2 ? 'd2'
        : node.depth === 3 ? 'd3'
          : node.depth === 4 ? 'd4' : 'd5'
  return (
    <div
      className={[
        'mrg-card',
        `mrg-card--${tone}`,
        selected ? 'mrg-card--sel' : '',
        highlighted ? 'mrg-card--hl' : '',
      ].filter(Boolean).join(' ')}
      style={{
        left: node.x + PAGE_PAD,
        top: node.y + PAGE_PAD,
        width: CARD_W,
        height: CARD_H,
      }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.() } }}
    >
      {isRoot ? <span className="mrg-card__tag">Vous</span> : null}
      <div className="mrg-card__head">
        <span className="mrg-card__avatar" aria-hidden>{nodeInitials(node.name)}</span>
        <div className="mrg-card__body">
          <div className="mrg-card__name">{node.name || (isRoot ? 'Vous' : '—')}</div>
          <div className="mrg-card__meta">
            {isRoot ? 'Racine' : `Niv. ${node.depth}`}
            {node.sales > 0 ? ` · ${node.sales} vente${node.sales > 1 ? 's' : ''}` : ''}
          </div>
        </div>
      </div>
      <div className="mrg-card__foot">
        <strong>{fmtMoney(node.earnings)}</strong>
        <span>TND</span>
      </div>
    </div>
  )
}

export default function MyReferralTreeGraph({
  myClientId,
  myName,
  root,          // array of direct-children nodes
  totalNodes,
  totalEarnings,
}) {
  const viewportRef = useRef(null)
  const panStateRef = useRef(null)
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const [isPanning, setIsPanning] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [search, setSearch] = useState('')

  // Wrap the user's direct children under a synthetic root = "me" so the graph
  // has a single root card. The inner nodes keep their original depth.
  const tree = useMemo(() => {
    const me = {
      id: `me:${myClientId || 'self'}`,
      name: myName || 'Vous',
      depth: 0,
      earnings: 0,
      sales: 0,
      phone: '',
      children: Array.isArray(root) ? root : [],
      __isRoot: true,
    }
    return layoutTree(me)
  }, [myClientId, myName, root])

  const nodeById = useMemo(() => {
    const m = new Map()
    for (const n of tree.nodes) m.set(n.id, n)
    return m
  }, [tree.nodes])

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    const s = new Set()
    for (const n of tree.nodes) {
      const hay = `${n.name || ''} ${n.phone || ''}`.toLowerCase()
      if (hay.includes(q)) s.add(n.id)
    }
    return s
  }, [search, tree.nodes])

  const selectedNode = selectedId ? nodeById.get(selectedId) : null

  // --- pan / zoom ------------------------------------------------------------
  const zoomAtPoint = useCallback((nextZoomRaw, anchorX, anchorY) => {
    setView((v) => {
      const nextZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoomRaw))
      if (nextZoom === v.zoom) return v
      const worldX = (anchorX - v.x) / v.zoom
      const worldY = (anchorY - v.y) / v.zoom
      return {
        zoom: nextZoom,
        x: anchorX - worldX * nextZoom,
        y: anchorY - worldY * nextZoom,
      }
    })
  }, [])

  const zoomBy = useCallback((factor) => {
    const box = viewportRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    zoomAtPoint(view.zoom * (1 + factor), rect.width / 2, rect.height / 2)
  }, [view.zoom, zoomAtPoint])

  const fitToScreen = useCallback(() => {
    const box = viewportRef.current
    if (!box || tree.width === 0) return
    const rect = box.getBoundingClientRect()
    const scaleW = (rect.width - 40) / tree.width
    const scaleH = (rect.height - 40) / tree.height
    const next = Math.min(1.1, Math.max(ZOOM_MIN, Math.min(scaleW, scaleH)))
    setView({
      zoom: next,
      x: (rect.width - tree.width * next) / 2,
      y: (rect.height - tree.height * next) / 2,
    })
  }, [tree.width, tree.height])

  useEffect(() => {
    fitToScreen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.width, tree.height])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return undefined
    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const anchorX = e.clientX - rect.left
      const anchorY = e.clientY - rect.top
      setView((v) => {
        const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY)
        const nextZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor))
        if (nextZoom === v.zoom) return v
        const worldX = (anchorX - v.x) / v.zoom
        const worldY = (anchorY - v.y) / v.zoom
        return { zoom: nextZoom, x: anchorX - worldX * nextZoom, y: anchorY - worldY * nextZoom }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- Touch: single-finger pan + two-finger pinch zoom ---------------------
  // Attached via addEventListener with passive:false so we can preventDefault
  // and stop the browser from scrolling/zooming the page while the user is
  // interacting with the canvas. React's synthetic touch events are passive
  // by default and can't call preventDefault cleanly.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return undefined
    // Transient gesture state lives in a closure so the handlers share it
    // without triggering re-renders every frame.
    const state = {
      mode: null,            // 'pan' | 'pinch' | null
      startX: 0,
      startY: 0,
      origX: 0,
      origY: 0,
      pinchStartDist: 0,
      pinchStartZoom: 1,
      pinchAnchorX: 0,
      pinchAnchorY: 0,
      pinchWorldX: 0,
      pinchWorldY: 0,
      moved: 0,
      startedOnCard: false,
    }

    const isInteractive = (target) =>
      target && target.closest && (
        target.closest('.mrg-card')
        || target.closest('.mrg-toolbar')
        || target.closest('.mrg-detail')
        || target.closest('.mrg-matches')
      )

    const dist = (t1, t2) => {
      const dx = t1.clientX - t2.clientX
      const dy = t1.clientY - t2.clientY
      return Math.hypot(dx, dy)
    }
    const midpoint = (t1, t2, rect) => ({
      x: (t1.clientX + t2.clientX) / 2 - rect.left,
      y: (t1.clientY + t2.clientY) / 2 - rect.top,
    })

    const onTouchStart = (e) => {
      const rect = el.getBoundingClientRect()
      if (e.touches.length === 2) {
        // Two fingers → pinch (always prevent default, even if started on a card).
        e.preventDefault()
        const [a, b] = e.touches
        const mid = midpoint(a, b, rect)
        // Capture the current view so we can base the pinch on its initial
        // zoom rather than the most recent frame — avoids compounding drift.
        state.mode = 'pinch'
        state.pinchStartDist = Math.max(1, dist(a, b))
        state.pinchStartZoom = view.zoom
        state.pinchAnchorX = mid.x
        state.pinchAnchorY = mid.y
        state.pinchWorldX = (mid.x - view.x) / view.zoom
        state.pinchWorldY = (mid.y - view.y) / view.zoom
        return
      }
      if (e.touches.length === 1) {
        const t = e.touches[0]
        const startedOnCard = Boolean(isInteractive(t.target))
        state.startedOnCard = startedOnCard
        // If the finger landed on a card/toolbar, let the tap go through so
        // the card can be selected. Only start panning if it touched empty
        // canvas. preventDefault on move keeps the page from scrolling.
        if (startedOnCard) { state.mode = null; return }
        e.preventDefault()
        state.mode = 'pan'
        state.startX = t.clientX
        state.startY = t.clientY
        state.origX = view.x
        state.origY = view.y
        state.moved = 0
      }
    }

    const onTouchMove = (e) => {
      if (state.mode === 'pinch' && e.touches.length >= 2) {
        e.preventDefault()
        const [a, b] = e.touches
        const d = Math.max(1, dist(a, b))
        const ratio = d / state.pinchStartDist
        setView(() => {
          const nextZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.pinchStartZoom * ratio))
          return {
            zoom: nextZoom,
            x: state.pinchAnchorX - state.pinchWorldX * nextZoom,
            y: state.pinchAnchorY - state.pinchWorldY * nextZoom,
          }
        })
        return
      }
      if (state.mode === 'pan' && e.touches.length === 1) {
        e.preventDefault()
        const t = e.touches[0]
        const dx = t.clientX - state.startX
        const dy = t.clientY - state.startY
        state.moved = Math.max(state.moved, Math.abs(dx) + Math.abs(dy))
        setView((v) => ({ ...v, x: state.origX + dx, y: state.origY + dy }))
      }
    }

    const onTouchEnd = (e) => {
      // If fingers drop from 2 → 1, transition cleanly into pan with the
      // remaining finger as the new anchor (common mobile expectation).
      if (state.mode === 'pinch' && e.touches.length === 1) {
        const t = e.touches[0]
        state.mode = 'pan'
        state.startX = t.clientX
        state.startY = t.clientY
        state.origX = view.x
        state.origY = view.y
        state.moved = 0
        return
      }
      if (e.touches.length === 0) {
        state.mode = null
      }
    }

    const onTouchCancel = () => { state.mode = null }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: false })
    el.addEventListener('touchcancel', onTouchCancel, { passive: false })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
    // view.zoom/x/y intentionally captured via state — we re-attach on each
    // change so the pinch baseline stays correct.
  }, [view.x, view.y, view.zoom])

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    const onCard = e.target.closest && e.target.closest('.mrg-card')
    const onToolbar = e.target.closest && e.target.closest('.mrg-toolbar, .mrg-detail')
    if (onCard || onToolbar) return
    panStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: view.x,
      origY: view.y,
    }
    setIsPanning(true)
  }, [view.x, view.y])

  useEffect(() => {
    if (!isPanning) return undefined
    const onMove = (e) => {
      const st = panStateRef.current
      if (!st) return
      setView((v) => ({ ...v, x: st.origX + (e.clientX - st.startX), y: st.origY + (e.clientY - st.startY) }))
    }
    const onUp = () => {
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

  // Jump camera to a node (search hit, etc.)
  const centerOnNode = useCallback((nodeId) => {
    const box = viewportRef.current
    const n = nodeById.get(nodeId)
    if (!box || !n) return
    const rect = box.getBoundingClientRect()
    const targetX = rect.width / 2 - (n.x + PAGE_PAD + CARD_W / 2) * view.zoom
    const targetY = rect.height / 2 - (n.y + PAGE_PAD + CARD_H / 2) * view.zoom
    setView((v) => ({ ...v, x: targetX, y: targetY }))
    setSelectedId(nodeId)
  }, [nodeById, view.zoom])

  // ---------------------------------------------------------------------------
  return (
    <div className="mrg">
      <div className="mrg-toolbar" role="toolbar" aria-label="Contrôles de l'arbre">
        <div className="mrg-stats">
          <span className="mrg-stats__item">
            <strong>{totalNodes || 0}</strong>
            <span>Filleuls</span>
          </span>
          <span className="mrg-stats__item mrg-stats__item--good">
            <strong>{fmtMoney(totalEarnings || 0)}</strong>
            <span>TND générés</span>
          </span>
        </div>
        <div className="mrg-toolbar__search">
          <input
            type="search"
            className="mrg-toolbar__input"
            placeholder="Chercher un filleul…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Chercher dans l'arbre"
          />
          {matches && matches.size > 0 ? (
            <span className="mrg-toolbar__match">{matches.size} match</span>
          ) : null}
        </div>
        <div className="mrg-toolbar__zoom">
          <button type="button" className="mrg-toolbar__btn" onClick={() => zoomBy(-0.15)} title="Zoom arrière" aria-label="Zoom arrière">−</button>
          <span className="mrg-toolbar__pct" aria-live="polite">{Math.round(view.zoom * 100)}%</span>
          <button type="button" className="mrg-toolbar__btn" onClick={() => zoomBy(0.15)} title="Zoom avant" aria-label="Zoom avant">+</button>
          <button type="button" className="mrg-toolbar__btn mrg-toolbar__btn--wide" onClick={fitToScreen} title="Ajuster à l'écran">Ajuster</button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className={`mrg-viewport${isPanning ? ' mrg-viewport--panning' : ''}`}
        onMouseDown={handleMouseDown}
      >
        <div
          className="mrg-canvas"
          style={{
            width: tree.width,
            height: tree.height,
            transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <svg
            className="mrg-edges"
            width={tree.width}
            height={tree.height}
            viewBox={`0 0 ${tree.width} ${tree.height}`}
            aria-hidden
          >
            {tree.edges.map((e, i) => {
              const x1 = e.from.cx + PAGE_PAD
              const y1 = e.from.y + CARD_H + PAGE_PAD
              const x2 = e.to.cx + PAGE_PAD
              const y2 = e.to.y + PAGE_PAD
              const midY = y1 + (y2 - y1) / 2
              const selected = selectedId && (selectedId === e.from.id || selectedId === e.to.id)
              return (
                <path
                  key={`${e.from.id}-${e.to.id}-${i}`}
                  d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                  className={selected ? 'mrg-edge mrg-edge--sel' : 'mrg-edge'}
                />
              )
            })}
          </svg>
          {tree.nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              isRoot={Boolean(n.__isRoot)}
              selected={selectedId === n.id}
              highlighted={matches ? matches.has(n.id) : false}
              onClick={() => setSelectedId((cur) => cur === n.id ? null : n.id)}
            />
          ))}
        </div>

        {matches && matches.size > 0 ? (
          <div className="mrg-matches">
            {Array.from(matches).slice(0, 6).map((id) => {
              const n = nodeById.get(id)
              if (!n) return null
              return (
                <button
                  key={id}
                  type="button"
                  className="mrg-matches__btn"
                  onClick={() => centerOnNode(id)}
                >
                  {n.name || '—'}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {selectedNode ? (
        <aside className="mrg-detail" aria-label="Détails du filleul">
          <header className="mrg-detail__head">
            <span className="mrg-detail__avatar" aria-hidden>{nodeInitials(selectedNode.name)}</span>
            <div>
              <div className="mrg-detail__name">{selectedNode.name || '—'}</div>
              <div className="mrg-detail__sub">
                {selectedNode.__isRoot ? 'Vous — racine de votre réseau' : `Niveau ${selectedNode.depth}`}
              </div>
            </div>
            <button
              type="button"
              className="mrg-detail__close"
              onClick={() => setSelectedId(null)}
              aria-label="Fermer les détails"
            >✕</button>
          </header>
          <dl className="mrg-detail__rows">
            <div>
              <dt>Commissions générées</dt>
              <dd>{fmtMoney(selectedNode.earnings || 0)} TND</dd>
            </div>
            <div>
              <dt>Ventes effectuées</dt>
              <dd>{selectedNode.sales || 0}</dd>
            </div>
            {selectedNode.phone ? (
              <div>
                <dt>Téléphone</dt>
                <dd style={{ direction: 'ltr' }}>{selectedNode.phone}</dd>
              </div>
            ) : null}
            <div>
              <dt>Filleuls directs</dt>
              <dd>{Array.isArray(selectedNode.children) ? selectedNode.children.length : 0}</dd>
            </div>
          </dl>
        </aside>
      ) : null}

      <div className="mrg-hint" aria-hidden>
        Glissez pour déplacer · molette pour zoomer · cliquez une carte pour voir les détails
      </div>
    </div>
  )
}
