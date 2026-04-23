// Single source of truth for parent/child relations used everywhere the
// commission system draws a lineage. The org chart and the detail panel
// used to re-derive this independently with non-stable sorting — if two
// sales completed at the same timestamp the two surfaces could show
// *different* uplines for the same client. This util fixes that.
//
// Design:
//   1. Start with the authoritative seller_relations rows.
//   2. Fill gaps synthetically from `sales` (first-sale-wins). We sort by
//      (notary_completed_at, id) so ties are broken deterministically.
//      If a buyer already has an auth parent or an earlier synthetic
//      claim, skip.
//   3. Return { rels, parentMap, childrenMap, syntheticChildSet }.
//
// Source-of-truth note: the DB trigger `trg_sales_auto_parrainage` should
// materialize these into seller_relations. When it misses (legacy rows,
// constraint violation, etc.) the client-side fallback below keeps the UI
// coherent — the detail panel already flags such rows as "déduit".

import { asStr } from './commissionFormat.js'

function saleTs(s) {
  const iso = s?.notary_completed_at || s?.notaryCompletedAt
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : 0
}

function buildParentMap(rels) {
  const m = new Map()
  for (const r of rels) {
    const child = asStr(r.child_client_id ?? r.childClientId)
    const parent = asStr(r.parent_client_id ?? r.parentClientId)
    if (!child || !parent || child === parent) continue
    if (!m.has(child)) m.set(child, parent)
  }
  return m
}

function buildChildrenMap(rels) {
  const m = new Map()
  for (const r of rels) {
    const child = asStr(r.child_client_id ?? r.childClientId)
    const parent = asStr(r.parent_client_id ?? r.parentClientId)
    if (!child || !parent || child === parent) continue
    const arr = m.get(parent) || []
    if (!arr.includes(child)) arr.push(child)
    m.set(parent, arr)
  }
  return m
}

/**
 * @param {{sellerRelations: Array, sales: Array}} data
 * @returns {{
 *   rels: Array,
 *   parentMap: Map<string,string>,
 *   childrenMap: Map<string,string[]>,
 *   syntheticChildSet: Set<string>,
 * }}
 */
export function resolveUpline(data) {
  const authRels = data?.sellerRelations || []
  const sales = data?.sales || []

  const authChildSet = new Set()
  for (const r of authRels) {
    const c = asStr(r.child_client_id ?? r.childClientId)
    if (c) authChildSet.add(c)
  }

  // Stable ordering: timestamp first, then sale id as tie-breaker.
  const sorted = [...sales].sort((a, b) => {
    const ta = saleTs(a)
    const tb = saleTs(b)
    if (ta !== tb) return ta - tb
    return asStr(a.id).localeCompare(asStr(b.id))
  })

  const syntheticRels = []
  const syntheticClaimed = new Set()
  for (const s of sorted) {
    const buyer = asStr(s.client_id ?? s.clientId)
    const seller = asStr(s.seller_client_id ?? s.sellerClientId)
    if (!buyer || !seller || buyer === seller) continue
    if (authChildSet.has(buyer) || syntheticClaimed.has(buyer)) continue
    syntheticClaimed.add(buyer)
    syntheticRels.push({
      parent_client_id: seller,
      child_client_id: buyer,
      source_sale_id: asStr(s.id) || null,
      synthetic: true,
    })
  }

  const rels = authRels.concat(syntheticRels)
  return {
    rels,
    parentMap: buildParentMap(rels),
    childrenMap: buildChildrenMap(rels),
    syntheticChildSet: syntheticClaimed,
  }
}

export function resolveUplineChain(clientId, parentMap) {
  const chain = []
  const seen = new Set()
  let cur = asStr(clientId)
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    chain.push(cur)
    cur = parentMap.get(cur) || ''
  }
  return chain
}
