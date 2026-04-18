import { useMemo } from 'react'
import {
  buildChildrenMap,
  resolveDownlineTree,
  flattenTree,
} from '../lib/referralTree.js'

// Normalize id-ish values so Map lookups work across uuid/int/string inputs.
function asId(value) {
  if (value === null || value === undefined) return null
  const s = String(value)
  return s.length ? s : null
}

function clientName(client) {
  if (!client) return ''
  if (client.full_name) return client.full_name
  const combo = [client.first_name, client.last_name].filter(Boolean).join(' ').trim()
  return combo || client.name || client.display_name || client.email || ''
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function formatTnd(amount) {
  const n = toNumber(amount)
  return `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TND`
}

const STYLE = `
.dpt-wrap { width: 100%; overflow-x: auto; }
.dpt-table { width: 100%; border-collapse: collapse; font-size: 13px; color: #0f172a; }
.dpt-table th, .dpt-table td {
  border: 1px solid #e2e8f0;
  padding: 6px 10px;
  text-align: left;
  white-space: nowrap;
}
.dpt-table thead th {
  background: #f1f5f9;
  font-weight: 600;
  color: #334155;
  position: sticky;
  top: 0;
}
.dpt-table tbody tr:nth-child(even) { background: #f8fafc; }
.dpt-table tbody tr:hover { background: #e2e8f0; cursor: pointer; }
.dpt-num { text-align: right; font-variant-numeric: tabular-nums; }
.dpt-depth {
  display: inline-block;
  min-width: 24px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #dbeafe;
  color: #1e40af;
  font-weight: 600;
  text-align: center;
}
.dpt-muted { color: #94a3b8; }
`

export default function DownlinePerformanceTable({
  rootClientId,
  data,
  onNodeClick,
}) {
  const rows = useMemo(() => {
    const rootId = asId(rootClientId)
    if (!rootId) return []

    const clients = Array.isArray(data?.clients) ? data.clients : []
    const sellerRelations = Array.isArray(data?.sellerRelations) ? data.sellerRelations : []
    const sales = Array.isArray(data?.sales) ? data.sales : []
    const commissionEvents = Array.isArray(data?.commissionEvents) ? data.commissionEvents : []

    const childrenMap = buildChildrenMap(sellerRelations)
    const tree = resolveDownlineTree(rootId, childrenMap)
    const flat = flattenTree(tree)
      .filter((r) => r && asId(r.id) !== rootId) // exclude the root itself

    if (!flat.length) return []

    // Client lookup by id.
    const clientIndex = new Map()
    for (const c of clients) {
      const id = asId(c?.id)
      if (id) clientIndex.set(id, c)
    }

    // Bucket sales by seller so we can aggregate per descendant in one pass.
    // Only count sales that reached the notary completion milestone.
    const salesBySeller = new Map()
    for (const s of sales) {
      if (!s || !s.notary_completed_at) continue
      const sellerId = asId(s.seller_client_id)
      if (!sellerId) continue
      const bucket = salesBySeller.get(sellerId)
      if (bucket) bucket.push(s)
      else salesBySeller.set(sellerId, [s])
    }

    // For each commission event, index by sale_id and by beneficiary so we can
    // both sum personal earnings and root-reversed commissions efficiently.
    const eventsBySale = new Map()
    const earnedByBeneficiary = new Map()
    for (const ev of commissionEvents) {
      if (!ev) continue
      const amount = toNumber(ev.amount ?? ev.commission_amount)
      const beneficiary = asId(ev.beneficiary_client_id ?? ev.client_id)
      if (beneficiary) {
        earnedByBeneficiary.set(beneficiary, (earnedByBeneficiary.get(beneficiary) || 0) + amount)
      }
      const saleId = asId(ev.sale_id ?? ev.saleId)
      if (saleId) {
        const bucket = eventsBySale.get(saleId)
        if (bucket) bucket.push(ev)
        else eventsBySale.set(saleId, [ev])
      }
    }

    const built = flat.map((r) => {
      const id = asId(r.id)
      const client = clientIndex.get(id)
      const mySales = salesBySeller.get(id) || []
      const salesCount = mySales.length
      let salesRevenue = 0
      let commissionsGeneratedForRoot = 0
      for (const s of mySales) {
        salesRevenue += toNumber(s.agreed_price)
        const saleId = asId(s.id)
        const evs = saleId ? eventsBySale.get(saleId) : null
        if (!evs) continue
        for (const ev of evs) {
          const beneficiary = asId(ev.beneficiary_client_id ?? ev.client_id)
          if (beneficiary === rootId) {
            commissionsGeneratedForRoot += toNumber(ev.amount ?? ev.commission_amount)
          }
        }
      }
      return {
        id,
        name: clientName(client) || id,
        code: client?.code || '',
        depth: r.depth,
        parentId: asId(r.parentId),
        salesCount,
        salesRevenue,
        commissionsEarnedByThem: earnedByBeneficiary.get(id) || 0,
        commissionsGeneratedForRoot,
      }
    })

    // Default sort: depth asc, then revenue desc for quick top-performer scan.
    built.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth
      return b.salesRevenue - a.salesRevenue
    })
    return built
  }, [rootClientId, data])

  if (!rows.length) {
    return <div className="zitu-page__empty">Aucun filleul pour l'instant.</div>
  }

  const handleRowClick = (id) => {
    if (typeof onNodeClick === 'function') onNodeClick(id)
  }

  return (
    <div className="dpt-wrap">
      <style>{STYLE}</style>
      <table className="dpt-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Niveau</th>
            <th>Nom</th>
            <th>Code</th>
            <th className="dpt-num">Ventes</th>
            <th className="dpt-num">Revenu généré</th>
            <th className="dpt-num">Gains personnels</th>
            <th className="dpt-num">Commissions reversées au parrain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.id} onClick={() => handleRowClick(row.id)}>
              <td>{idx + 1}</td>
              <td>
                <span className="dpt-depth">L{row.depth}</span>
              </td>
              <td>{row.name}</td>
              <td>{row.code || <span className="dpt-muted">—</span>}</td>
              <td className="dpt-num">{row.salesCount}</td>
              <td className="dpt-num">{formatTnd(row.salesRevenue)}</td>
              <td className="dpt-num">{formatTnd(row.commissionsEarnedByThem)}</td>
              <td className="dpt-num">{formatTnd(row.commissionsGeneratedForRoot)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
