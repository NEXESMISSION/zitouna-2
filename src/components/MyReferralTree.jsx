import { useMemo, useState } from 'react'
import './my-referral-tree.css'

// Compact per-user referral tree driven by the user's own commission_events.
// Each event carries `rule_snapshot.meta.chainPath` = [seller, ...ancestors, me]
// where I'm at the top. From N such paths we reconstruct the subtree below me.
//
// Props:
//   myClientId: string      the signed-in user's client id
//   ledger:     Array       output of useMyCommissionLedger() — enriched events
//                            with {id, level, amount, status, seller, buyer, sale}
//   loading:    boolean     skeleton toggle

function asId(v) { return v == null ? '' : String(v) }
function fmtMoney(n) {
  const v = Number(n) || 0
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} TND`
}

// Walk each event's chainPath and flatten into parent → child edges below me.
// My direct children are the nodes at chainPath[level-2] (or chainPath[0] if
// level is 2; or the seller at chainPath[0] if level is 1 since the seller IS
// my direct descendant in that case).
function buildTree(myId, ledger) {
  const me = asId(myId)
  const childrenByParent = new Map()      // parentId -> Set<childId>
  const earningsFromNode = new Map()      // nodeId (in my subtree) -> TND earned by me attributable to that node
  const salesByNode = new Map()           // nodeId -> count of sales where node is seller/buyer
  const nameById = new Map()              // nodeId -> display name
  const phoneById = new Map()
  const levelByNode = new Map()           // nodeId -> shortest depth under me (1-based)

  function noteName(id, name, phone) {
    const key = asId(id)
    if (!key) return
    if (!nameById.has(key) && name) nameById.set(key, String(name))
    if (!phoneById.has(key) && phone) phoneById.set(key, String(phone))
  }
  function addEdge(parent, child) {
    const p = asId(parent)
    const c = asId(child)
    if (!p || !c || p === c) return
    let set = childrenByParent.get(p)
    if (!set) { set = new Set(); childrenByParent.set(p, set) }
    set.add(c)
  }
  function setLevel(id, depth) {
    const key = asId(id)
    if (!key || !Number.isFinite(depth) || depth < 1) return
    const prev = levelByNode.get(key)
    if (prev == null || depth < prev) levelByNode.set(key, depth)
  }

  for (const ev of Array.isArray(ledger) ? ledger : []) {
    if (ev?.kind !== 'commission') continue
    const level = Number(ev.level) || 0
    const chain = Array.isArray(ev?.rule_snapshot?.meta?.chainPath)
      ? ev.rule_snapshot.meta.chainPath.map(asId)
      : Array.isArray(ev?.ruleSnapshot?.meta?.chainPath)
        ? ev.ruleSnapshot.meta.chainPath.map(asId)
        : []

    const sellerId = asId(ev.seller?.id)
    const buyerId  = asId(ev.buyer?.id)
    noteName(sellerId, ev.seller?.name, ev.seller?.phone)
    noteName(buyerId, ev.buyer?.name, ev.buyer?.phone)

    // Build edges from chainPath if available; otherwise infer based on level.
    if (chain.length >= 2) {
      // chain = [seller, ..., me] walking upward. In my subtree, direct
      // parent/child edges go downward: me → chain[chain.length-2] → … → chain[0].
      for (let i = chain.length - 1; i > 0; i -= 1) {
        addEdge(chain[i], chain[i - 1])
        setLevel(chain[i - 1], chain.length - 1 - (i - 1))
      }
    } else if (level === 1 && sellerId) {
      // Level 1: I AM the seller — no subtree edge. Credit this sale to me
      // but don't add a node.
    } else if (level === 2 && sellerId) {
      // chainPath absent but we know the seller is my direct child.
      addEdge(me, sellerId)
      setLevel(sellerId, 1)
    }

    // The buyer is always one step below the direct seller in future terms.
    // Render them as a leaf under the seller so the tree shows "who bought".
    if (sellerId && buyerId) {
      addEdge(sellerId, buyerId)
    }

    // Attribute earnings + sale count to the nearest node in my subtree
    // (the direct seller — that's where the sale actually happened).
    if (sellerId) {
      const amt = Number(ev.amount) || 0
      earningsFromNode.set(sellerId, (earningsFromNode.get(sellerId) || 0) + amt)
      salesByNode.set(sellerId, (salesByNode.get(sellerId) || 0) + 1)
    }
  }

  // Convert to nested structure rooted at `me`. BFS, bounded to avoid loops.
  const seen = new Set([me])
  function build(id, depth) {
    const kids = Array.from(childrenByParent.get(id) || [])
      .filter((k) => !seen.has(k))
      .sort((a, b) => {
        const ea = earningsFromNode.get(a) || 0
        const eb = earningsFromNode.get(b) || 0
        if (ea !== eb) return eb - ea
        return String(nameById.get(a) || a).localeCompare(String(nameById.get(b) || b))
      })
    const nodes = []
    for (const k of kids) {
      if (seen.has(k)) continue
      seen.add(k)
      nodes.push({
        id: k,
        name: nameById.get(k) || '—',
        phone: phoneById.get(k) || '',
        depth,
        earnings: earningsFromNode.get(k) || 0,
        sales: salesByNode.get(k) || 0,
        children: depth >= 6 ? [] : build(k, depth + 1),
      })
    }
    return nodes
  }

  const root = build(me, 1)
  let totalNodes = 0
  let totalEarnings = 0
  function walk(nodes) {
    for (const n of nodes) {
      totalNodes += 1
      totalEarnings += n.earnings
      walk(n.children)
    }
  }
  walk(root)
  return { root, totalNodes, totalEarnings }
}

function TreeNode({ node, expandedDefault }) {
  const [open, setOpen] = useState(Boolean(expandedDefault))
  const hasKids = node.children && node.children.length > 0
  const initials = String(node.name || '—')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0] || '')
    .join('')
    .toUpperCase() || '?'
  return (
    <li className={`mrt-node mrt-node--d${Math.min(node.depth, 5)}`}>
      <div className="mrt-card">
        <button
          type="button"
          className={`mrt-card__toggle${hasKids ? '' : ' mrt-card__toggle--leaf'}`}
          onClick={() => hasKids && setOpen((v) => !v)}
          aria-expanded={hasKids ? open : undefined}
          aria-label={hasKids ? (open ? 'Réduire' : 'Développer') : 'Aucun filleul'}
        >
          {hasKids ? (open ? '−' : '+') : '•'}
        </button>
        <span className="mrt-card__avatar" aria-hidden>{initials}</span>
        <div className="mrt-card__body">
          <div className="mrt-card__name">{node.name}</div>
          <div className="mrt-card__meta">
            <span>Niv. {node.depth}</span>
            {node.sales > 0 ? <span>· {node.sales} vente{node.sales > 1 ? 's' : ''}</span> : null}
            {node.phone ? <span className="mrt-card__phone">· {node.phone}</span> : null}
          </div>
        </div>
        <div className="mrt-card__amount">
          <strong>{fmtMoney(node.earnings)}</strong>
          <span>de commissions</span>
        </div>
      </div>
      {hasKids && open ? (
        <ul className="mrt-children">
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} expandedDefault={node.depth < 2} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export default function MyReferralTree({ myClientId, myName, ledger, loading = false }) {
  const { root, totalNodes, totalEarnings } = useMemo(
    () => buildTree(myClientId, ledger),
    [myClientId, ledger],
  )
  const myInitials = String(myName || 'Moi')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0] || '')
    .join('')
    .toUpperCase() || 'M'

  if (loading) {
    return (
      <div className="mrt" aria-busy="true">
        <div className="mrt__header">
          <h3 className="mrt__title">Mon arbre de parrainage</h3>
        </div>
        <div className="mrt__stats">
          {[0, 1, 2].map((i) => (
            <span key={i} className="sk sk-card sk-card--light mrt__stat-sk" />
          ))}
        </div>
        <ul className="mrt-root">
          {[0, 1, 2].map((i) => (
            <li key={i} className="mrt-node mrt-node--d1">
              <div className="mrt-card mrt-card--sk">
                <span className="sk sk-box" />
                <div className="mrt-card__body">
                  <span className="sk sk-line sk-line--title" />
                  <span className="sk sk-line sk-line--sub" />
                </div>
                <span className="sk sk-line sk-line--price" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const isEmpty = !myClientId || root.length === 0

  return (
    <div className="mrt">
      <div className="mrt__header">
        <h3 className="mrt__title">Mon arbre de commissions</h3>
        {!isEmpty && (
          <span className="mrt__subtitle">
            {totalNodes} personne{totalNodes > 1 ? 's' : ''} · {fmtMoney(totalEarnings)} générés
          </span>
        )}
      </div>

      {!isEmpty && (
        <div className="mrt__stats">
          <div className="mrt__stat">
            <span className="mrt__stat-num">{root.length}</span>
            <span className="mrt__stat-lbl">Filleul{root.length > 1 ? 's' : ''} directs</span>
          </div>
          <div className="mrt__stat">
            <span className="mrt__stat-num">{totalNodes}</span>
            <span className="mrt__stat-lbl">Total du réseau</span>
          </div>
          <div className="mrt__stat mrt__stat--good">
            <span className="mrt__stat-num">{fmtMoney(totalEarnings)}</span>
            <span className="mrt__stat-lbl">Total généré</span>
          </div>
        </div>
      )}

      {/* Personal root card — "you" sit at the top of your tree. */}
      <div className="mrt-me">
        <span className="mrt-me__avatar" aria-hidden>{myInitials}</span>
        <div className="mrt-me__body">
          <div className="mrt-me__name">{myName || 'Vous'}</div>
          <div className="mrt-me__meta">
            {isEmpty
              ? 'Racine de votre réseau — personne en dessous pour l’instant.'
              : `Racine · ${root.length} filleul${root.length > 1 ? 's' : ''} directs`}
          </div>
        </div>
        <span className="mrt-me__tag">Vous</span>
      </div>

      {isEmpty ? (
        <div className="mrt__empty">
          <div className="mrt__empty-emoji" aria-hidden>🌱</div>
          <p className="mrt__empty-title">Aucun filleul pour l'instant.</p>
          <p className="mrt__empty-desc">
            Dès qu'une personne que vous avez parrainée achètera une parcelle,
            elle apparaîtra ici avec ses propres filleuls.
          </p>
        </div>
      ) : (
        <ul className="mrt-root mrt-root--attached">
          {root.map((n) => (
            <TreeNode key={n.id} node={n} expandedDefault />
          ))}
        </ul>
      )}
    </div>
  )
}
