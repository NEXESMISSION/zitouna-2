import { useMemo } from 'react'
import AdminModal from './AdminModal.jsx'
import './commission-diagnostics.css'

// Flags edge cases in the referral graph that the admin tree can't easily
// surface on its own:
//   • reverse sales         buyer was in the seller's upline → commissions
//                             truncated at the buyer (the intended behavior).
//   • staff-only sales      no seller_client_id → no MLM commissions at all.
//   • orphan buyers         notary-complete sale, sellerClientId set, but the
//                             buyer still has no parent in seller_relations
//                             (usually: cycle rejected the upsert).
//   • self sales            buyer === seller (shouldn't happen — loud check).
//   • cycle/duplicate       seller_relations would form a cycle OR buyer
//                             already had a different parent (tree didn't grow).
//
// All computation happens client-side off the already-fetched tracker payload.

function asId(v) { return v == null ? '' : String(v) }
function fmtMoney(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M TND`
  if (v >= 10_000) return `${Math.round(v / 1000)}k TND`
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} TND`
}
function displayName(c) {
  if (!c) return '—'
  return c.full_name || c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.code || c.email || '—'
}

function walkUpline(startId, parentMap, maxDepth = 40) {
  const chain = [asId(startId)]
  const seen = new Set(chain)
  let cursor = chain[0]
  while (chain.length < maxDepth + 1) {
    const parent = asId(parentMap.get(cursor))
    if (!parent || seen.has(parent)) break
    chain.push(parent)
    seen.add(parent)
    cursor = parent
  }
  return chain
}

export default function CommissionDiagnosticsPanel({ open, onClose, data, onJumpToNode }) {
  const findings = useMemo(() => {
    const clients = data?.clients || []
    const sales = data?.sales || []
    const relations = data?.sellerRelations || []
    const events = data?.commissionEvents || []

    const clientById = new Map(clients.map((c) => [asId(c.id), c]))
    const parentMap = new Map()
    for (const r of relations) {
      const c = asId(r.child_client_id)
      const p = asId(r.parent_client_id)
      if (c && p && c !== p) parentMap.set(c, p)
    }
    const hasParent = new Set(parentMap.keys())

    // Sales grouped by flavor.
    const reverseSales = []   // buyer was in seller's upline (at time of query)
    const staffOnly = []      // no sellerClientId
    const selfSales = []      // buyer === seller
    const orphanBuyers = []   // completed sale with seller, buyer still has no parent
    const cycleBlocked = []   // would have formed a cycle (seller is in buyer's current upline)

    for (const s of sales) {
      const buyer = asId(s.client_id || s.clientId)
      const seller = asId(s.seller_client_id || s.sellerClientId)
      if (!buyer) continue
      if (!seller) {
        staffOnly.push(s)
        continue
      }
      if (buyer === seller) {
        selfSales.push(s)
        continue
      }
      // Reverse sale: buyer appears somewhere in the seller's upline.
      const sellerChain = walkUpline(seller, parentMap)
      if (sellerChain.includes(buyer)) {
        reverseSales.push({ sale: s, chain: sellerChain })
        continue
      }
      // Cycle check: if the seller is already in buyer's upline, the upsert
      // (child=buyer, parent=seller) would have created a cycle, so no link
      // was created → buyer may still be orphaned or have a different parent.
      const buyerChain = walkUpline(buyer, parentMap)
      if (buyerChain.includes(seller) && buyerChain[1] !== seller) {
        // seller is in buyer's chain but isn't the direct parent.
        cycleBlocked.push({ sale: s, chain: buyerChain })
      }
      if (!hasParent.has(buyer)) {
        orphanBuyers.push(s)
      }
    }

    // Event summary — how much money is at stake behind each flag.
    const eventsBySale = new Map()
    for (const e of events) {
      const sid = asId(e.sale_id || e.saleId)
      if (!sid) continue
      let list = eventsBySale.get(sid)
      if (!list) { list = []; eventsBySale.set(sid, list) }
      list.push(e)
    }
    const totalAmtFor = (salesList) => {
      let total = 0
      for (const s of salesList) {
        const evs = eventsBySale.get(asId(s.id || s.sale?.id)) || []
        for (const e of evs) total += Number(e.amount) || 0
      }
      return total
    }

    return {
      reverseSales,
      staffOnly,
      selfSales,
      orphanBuyers,
      cycleBlocked,
      totals: {
        reverseSalesAmt: totalAmtFor(reverseSales.map((x) => x.sale)),
        staffOnlyAmt: totalAmtFor(staffOnly),
        selfSalesAmt: totalAmtFor(selfSales),
      },
      clientById,
    }
  }, [data])

  const hasAny = findings.reverseSales.length
    || findings.staffOnly.length
    || findings.selfSales.length
    || findings.orphanBuyers.length
    || findings.cycleBlocked.length

  const nameOf = (id) => displayName(findings.clientById.get(asId(id)))

  const renderSaleRow = (sale, extra) => {
    const buyer = asId(sale.client_id || sale.clientId)
    const seller = asId(sale.seller_client_id || sale.sellerClientId)
    return (
      <li key={sale.id} className="cd-row">
        <div className="cd-row__main">
          <div className="cd-row__line">
            <span className="cd-row__lbl">Acheteur</span>
            <button
              type="button"
              className="cd-row__link"
              onClick={() => onJumpToNode?.(buyer)}
              disabled={!buyer}
            >
              {nameOf(buyer) || '—'}
            </button>
          </div>
          {seller ? (
            <div className="cd-row__line">
              <span className="cd-row__lbl">Vendeur</span>
              <button
                type="button"
                className="cd-row__link"
                onClick={() => onJumpToNode?.(seller)}
              >
                {nameOf(seller)}
              </button>
            </div>
          ) : (
            <div className="cd-row__line cd-row__line--muted">
              <span className="cd-row__lbl">Vendeur</span>
              <span>— (agent commercial / staff)</span>
            </div>
          )}
          <div className="cd-row__meta">
            {sale.code || sale.id} · {fmtMoney(sale.agreed_price || sale.agreedPrice || 0)}
          </div>
          {extra}
        </div>
      </li>
    )
  }

  return (
    <AdminModal open={open} onClose={onClose} title="Diagnostic du réseau" width={640}>
      <div className="cd-panel">
        <p className="cd-panel__intro">
          Cas limites détectés dans les ventes notariées et les liens de parrainage.
          Les montants indiqués sont les commissions générées (ou manquantes) pour ces dossiers.
        </p>

        {!hasAny && (
          <div className="cd-empty">
            <span aria-hidden>✓</span>
            <div>
              <strong>Aucune anomalie détectée</strong>
              <p>Toutes les ventes suivent la chaîne vendeur-client-acheteur attendue.</p>
            </div>
          </div>
        )}

        {findings.reverseSales.length > 0 && (
          <section className="cd-section cd-section--info">
            <div className="cd-section__head">
              <div>
                <h4>Ventes inversées</h4>
                <p>
                  L'acheteur se trouvait déjà dans la lignée du vendeur : la chaîne
                  a été tronquée à l'acheteur (les ancêtres au-dessus ne perçoivent pas).
                </p>
              </div>
              <span className="cd-badge cd-badge--info">{findings.reverseSales.length}</span>
            </div>
            <ul className="cd-list">
              {findings.reverseSales.slice(0, 8).map(({ sale, chain }) =>
                renderSaleRow(sale, (
                  <div className="cd-chain">
                    {chain.map((id, i) => (
                      <span key={`${id}-${i}`} className="cd-chain__node">
                        {nameOf(id)}
                        {i < chain.length - 1 ? <span aria-hidden> → </span> : null}
                      </span>
                    ))}
                  </div>
                )),
              )}
              {findings.reverseSales.length > 8 && (
                <li className="cd-more">+ {findings.reverseSales.length - 8} autres</li>
              )}
            </ul>
          </section>
        )}

        {findings.staffOnly.length > 0 && (
          <section className="cd-section cd-section--warn">
            <div className="cd-section__head">
              <div>
                <h4>Ventes sans vendeur client</h4>
                <p>
                  Effectuées par un agent commercial (staff) — aucun événement
                  de commission multi-niveaux n'est généré pour ces dossiers.
                </p>
              </div>
              <span className="cd-badge cd-badge--warn">{findings.staffOnly.length}</span>
            </div>
            <ul className="cd-list">
              {findings.staffOnly.slice(0, 6).map((s) => renderSaleRow(s))}
              {findings.staffOnly.length > 6 && (
                <li className="cd-more">+ {findings.staffOnly.length - 6} autres</li>
              )}
            </ul>
          </section>
        )}

        {findings.orphanBuyers.length > 0 && (
          <section className="cd-section cd-section--warn">
            <div className="cd-section__head">
              <div>
                <h4>Acheteurs orphelins</h4>
                <p>
                  Vente notariée avec un vendeur client, mais l'acheteur n'a pas été
                  attaché à l'arbre (upsert refusé — probablement cycle ou doublon).
                </p>
              </div>
              <span className="cd-badge cd-badge--warn">{findings.orphanBuyers.length}</span>
            </div>
            <ul className="cd-list">
              {findings.orphanBuyers.slice(0, 6).map((s) => renderSaleRow(s))}
              {findings.orphanBuyers.length > 6 && (
                <li className="cd-more">+ {findings.orphanBuyers.length - 6} autres</li>
              )}
            </ul>
          </section>
        )}

        {findings.cycleBlocked.length > 0 && (
          <section className="cd-section cd-section--err">
            <div className="cd-section__head">
              <div>
                <h4>Cycles évités</h4>
                <p>
                  Le vendeur figure déjà dans la lignée montante de l'acheteur —
                  le lien aurait formé un cycle et a été refusé par la base.
                </p>
              </div>
              <span className="cd-badge cd-badge--err">{findings.cycleBlocked.length}</span>
            </div>
            <ul className="cd-list">
              {findings.cycleBlocked.slice(0, 6).map(({ sale }) => renderSaleRow(sale))}
              {findings.cycleBlocked.length > 6 && (
                <li className="cd-more">+ {findings.cycleBlocked.length - 6} autres</li>
              )}
            </ul>
          </section>
        )}

        {findings.selfSales.length > 0 && (
          <section className="cd-section cd-section--err">
            <div className="cd-section__head">
              <div>
                <h4>Auto-ventes</h4>
                <p>Acheteur et vendeur identiques — à corriger.</p>
              </div>
              <span className="cd-badge cd-badge--err">{findings.selfSales.length}</span>
            </div>
            <ul className="cd-list">
              {findings.selfSales.slice(0, 6).map((s) => renderSaleRow(s))}
            </ul>
          </section>
        )}
      </div>
    </AdminModal>
  )
}
