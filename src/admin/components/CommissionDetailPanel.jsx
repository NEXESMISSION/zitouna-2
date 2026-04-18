import { useEffect, useMemo, useState } from 'react'
import * as tree from '../lib/referralTree.js'
import './commission-detail-panel.css'

const SALES_INITIAL = 8
const EVENTS_INITIAL = 10
const PAGE_STEP = 20

function fmtMoney(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0 TND'
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} TND`
}

function fmtMoneyShort(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v === 0) return '0'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${Math.round(v / 1000)}k`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })
}

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' })
}

function normalizeCommissionStatus(e) {
  if (!e) return 'pending'
  if (e.status === 'paid' || e.paid_at || e.paidAt) return 'paid'
  if (e.status === 'cancelled') return 'cancelled'
  if (e.status === 'payable' || e.status === 'approved') return 'payable'
  return 'pending'
}

function normalizeSaleStatus(s) {
  const raw = String(s?.status || '').toLowerCase()
  // Reuse 4 UI buckets so admins only see a handful of colors.
  if (raw === 'completed') return 'completed'
  if (raw === 'active') return 'active'
  if (raw === 'cancelled' || raw === 'rejected') return 'cancelled'
  return 'pending'
}

const COMMISSION_LABEL = { pending: 'En attente', payable: 'À payer', paid: 'Payé', cancelled: 'Annulé' }
const SALE_LABEL = { completed: 'Terminée', active: 'En cours', pending: 'En attente', cancelled: 'Annulée' }

function asStr(v) { return v == null ? '' : String(v) }

function clientDisplayName(c) {
  if (!c) return ''
  return c.full_name || c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.code || '—'
}

function clientInitials(c) {
  const name = clientDisplayName(c)
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase()
}

export default function CommissionDetailPanel({ clientId, data, onClose }) {
  // Per-list "show more" limits — reset whenever the selected client changes.
  // React's "reset state when a prop changes" pattern: compare against a
  // stored previous value during render and reset inline. This avoids the
  // cascading-render warning from useEffect+setState.
  const [sellerLimit, setSellerLimit] = useState(SALES_INITIAL)
  const [buyerLimit, setBuyerLimit] = useState(SALES_INITIAL)
  const [eventsLimit, setEventsLimit] = useState(EVENTS_INITIAL)
  const [prevClientId, setPrevClientId] = useState(clientId)
  if (prevClientId !== clientId) {
    setPrevClientId(clientId)
    setSellerLimit(SALES_INITIAL)
    setBuyerLimit(SALES_INITIAL)
    setEventsLimit(EVENTS_INITIAL)
  }

  // Close on Escape — panel is not a modal but keyboard parity with one is nice.
  useEffect(() => {
    if (!clientId) return undefined
    const handler = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [clientId, onClose])

  const payload = useMemo(() => {
    if (!clientId || !data) return null
    const clients = data.clients || []
    const events = data.commissionEvents || []
    const rels = data.sellerRelations || []
    const sales = data.sales || []
    const projects = data.projects || []

    const idStr = asStr(clientId)
    const client = clients.find((c) => asStr(c.id) === idStr)
    if (!client) return null

    const parentMap = tree.buildParentMap(rels)
    const childMap = tree.buildChildrenMap(rels)

    // resolveUplineChain returns [self, parent, grandparent, ...]. Drop self.
    const chain = tree.resolveUplineChain(idStr, parentMap)
    const ancestors = chain.slice(1)
      .map((id) => clients.find((c) => asStr(c.id) === asStr(id)))
      .filter(Boolean)

    const directChildIds = childMap.get(idStr) || []
    const directChildren = directChildIds
      .map((id) => clients.find((c) => asStr(c.id) === asStr(id)))
      .filter(Boolean)
    // Add per-filleul sales count so the admin sees who's active.
    const filleulSalesCount = new Map()
    for (const s of sales) {
      const seller = asStr(s.seller_client_id ?? s.sellerClientId)
      if (!seller) continue
      filleulSalesCount.set(seller, (filleulSalesCount.get(seller) || 0) + 1)
    }

    const clientById = new Map(clients.map((c) => [asStr(c.id), c]))
    const projectById = new Map(projects.map((p) => [asStr(p.id), p]))

    // Sales where this client was the seller
    const salesAsSeller = sales
      .filter((s) => asStr(s.seller_client_id ?? s.sellerClientId) === idStr)
      .map((s) => ({
        id: s.id,
        code: s.code,
        buyer: clientById.get(asStr(s.client_id ?? s.clientId)),
        project: projectById.get(asStr(s.project_id ?? s.projectId)),
        agreedPrice: Number(s.agreed_price ?? s.agreedPrice) || 0,
        status: normalizeSaleStatus(s),
        notaryAt: s.notary_completed_at || s.notaryCompletedAt,
      }))
      .sort((a, b) => String(b.notaryAt || '').localeCompare(String(a.notaryAt || '')))

    // Purchases (this client was the buyer)
    const purchases = sales
      .filter((s) => asStr(s.client_id ?? s.clientId) === idStr)
      .map((s) => ({
        id: s.id,
        code: s.code,
        seller: clientById.get(asStr(s.seller_client_id ?? s.sellerClientId)),
        project: projectById.get(asStr(s.project_id ?? s.projectId)),
        agreedPrice: Number(s.agreed_price ?? s.agreedPrice) || 0,
        status: normalizeSaleStatus(s),
        notaryAt: s.notary_completed_at || s.notaryCompletedAt,
      }))
      .sort((a, b) => String(b.notaryAt || '').localeCompare(String(a.notaryAt || '')))

    const myEvents = events
      .filter((e) => asStr(e.beneficiary_client_id ?? e.beneficiaryClientId) === idStr)
      .map((e) => {
        const sale = sales.find((s) => asStr(s.id) === asStr(e.sale_id ?? e.saleId))
        const project = sale ? projectById.get(asStr(sale.project_id)) : null
        return {
          id: e.id,
          level: Number(e.level) || 1,
          amount: Number(e.amount) || 0,
          status: normalizeCommissionStatus(e),
          createdAt: e.created_at || e.createdAt,
          saleCode: sale?.code || null,
          projectTitle: project?.title || null,
        }
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))

    const stats = { total: 0, paid: 0, payable: 0, pending: 0, cancelled: 0, byLevel: {} }
    for (const e of myEvents) {
      if (e.status === 'cancelled') { stats.cancelled += e.amount; continue }
      stats.total += e.amount
      stats[e.status] += e.amount
      stats.byLevel[e.level] = (stats.byLevel[e.level] || 0) + e.amount
    }

    // Aggregate seller totals so the admin can see volume sold + buyers count.
    const sellerTotals = {
      salesCount: salesAsSeller.length,
      uniqueBuyers: new Set(salesAsSeller.map((s) => asStr(s.buyer?.id))).size,
      volume: salesAsSeller.reduce((sum, s) => sum + s.agreedPrice, 0),
    }
    const buyerTotals = {
      purchasesCount: purchases.length,
      volume: purchases.reduce((sum, s) => sum + s.agreedPrice, 0),
    }

    // Generation = depth in tree (ancestors.length + 1). Root = Gen 1.
    const gen = ancestors.length + 1

    return {
      client, ancestors, directChildren, filleulSalesCount,
      salesAsSeller, purchases,
      events: myEvents, stats, sellerTotals, buyerTotals, gen,
    }
  }, [clientId, data])

  if (!clientId) return null
  if (!payload) {
    return (
      <aside className="cdp" role="complementary" aria-label="Détails bénéficiaire">
        <header className="cdp__header">
          <h2 className="cdp__title">Introuvable</h2>
          <button type="button" className="cdp__close" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <div className="cdp__body">
          <p className="cdp__empty">Ce client n’est pas présent dans le jeu de données actuel.</p>
        </div>
      </aside>
    )
  }

  const {
    client, ancestors, directChildren, filleulSalesCount,
    salesAsSeller, purchases,
    events, stats, sellerTotals, buyerTotals, gen,
  } = payload
  const genClass = gen === 1 ? 'cdp__gen--root'
    : gen === 2 ? 'cdp__gen--l1'
    : gen === 3 ? 'cdp__gen--l2'
    : gen === 4 ? 'cdp__gen--l3'
    : 'cdp__gen--l4'

  const levelEntries = Object.entries(stats.byLevel)
    .map(([lvl, amt]) => ({ lvl: Number(lvl), amt }))
    .sort((a, b) => a.lvl - b.lvl)

  return (
    <aside className="cdp" role="complementary" aria-label={`Détails ${clientDisplayName(client)}`}>
      <header className="cdp__header">
        <div className="cdp__avatar" aria-hidden="true">{clientInitials(client)}</div>
        <div className="cdp__head-text">
          <h2 className="cdp__title">{clientDisplayName(client)}</h2>
          <div className="cdp__subtitle">
            <span className={`cdp__gen ${genClass}`}>Gen {gen}</span>
            {client.code ? <span className="cdp__code">{client.code}</span> : null}
          </div>
        </div>
        <button type="button" className="cdp__close" onClick={onClose} aria-label="Fermer le panneau">×</button>
      </header>

      <div className="cdp__body">
        {/* ========== COMMISSIONS SUMMARY ========== */}
        <section className="cdp__group">
          <h3 className="cdp__group-title">💰 Commissions perçues</h3>
          <div className="cdp__kpis">
            <div className="cdp__kpi cdp__kpi--info">
              <span className="cdp__kpi-label">Total gagné</span>
              <span className="cdp__kpi-value">{fmtMoney(stats.total)}</span>
            </div>
            <div className="cdp__kpi cdp__kpi--good">
              <span className="cdp__kpi-label">Payé</span>
              <span className="cdp__kpi-value">{fmtMoney(stats.paid)}</span>
            </div>
            <div className="cdp__kpi cdp__kpi--warn">
              <span className="cdp__kpi-label">À payer</span>
              <span className="cdp__kpi-value">{fmtMoney(stats.payable)}</span>
            </div>
            <div className="cdp__kpi cdp__kpi--muted">
              <span className="cdp__kpi-label">En attente</span>
              <span className="cdp__kpi-value">{fmtMoney(stats.pending)}</span>
            </div>
          </div>

          {levelEntries.length > 0 ? (
            <div className="cdp__levels">
              {levelEntries.map(({ lvl, amt }) => (
                <div key={lvl} className={`cdp__level cdp__level--l${Math.min(lvl, 4)}`}>
                  <span className="cdp__level-tag">L{lvl}</span>
                  <span className="cdp__level-amt">{fmtMoney(amt)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {/* ========== SALES AS SELLER ========== */}
        <section className="cdp__group">
          <h3 className="cdp__group-title">
            🧑‍💼 Ventes réalisées
            <span className="cdp__group-sub">
              {sellerTotals.salesCount} vente{sellerTotals.salesCount > 1 ? 's' : ''} ·
              {' '}{fmtMoneyShort(sellerTotals.volume)} TND volume
            </span>
          </h3>
          {salesAsSeller.length === 0 ? (
            <p className="cdp__empty">Aucune vente réalisée.</p>
          ) : (
            <>
              <ul className="cdp__sales">
                {salesAsSeller.slice(0, sellerLimit).map((s) => (
                  <li key={s.id} className="cdp__sale">
                    <div className="cdp__sale-head">
                      <span className="cdp__sale-role cdp__sale-role--seller">à</span>
                      <span className="cdp__sale-counterpart">{clientDisplayName(s.buyer) || '—'}</span>
                      <span className="cdp__sale-amount">{fmtMoney(s.agreedPrice)}</span>
                    </div>
                    <div className="cdp__sale-meta">
                      <span className={`cdp__sale-status cdp__sale-status--${s.status}`}>{SALE_LABEL[s.status]}</span>
                      {s.project?.title ? <span>{s.project.title}</span> : null}
                      <span>{fmtDate(s.notaryAt)}</span>
                      {s.code ? <span className="cdp__sale-code">{s.code}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
              <ShowMoreButton
                shown={Math.min(sellerLimit, salesAsSeller.length)}
                total={salesAsSeller.length}
                onMore={() => setSellerLimit((n) => n + PAGE_STEP)}
                onCollapse={() => setSellerLimit(SALES_INITIAL)}
                noun="ventes"
              />
            </>
          )}
        </section>

        {/* ========== PURCHASES (AS BUYER) ========== */}
        <section className="cdp__group">
          <h3 className="cdp__group-title">
            🛒 Achats
            <span className="cdp__group-sub">
              {buyerTotals.purchasesCount} achat{buyerTotals.purchasesCount > 1 ? 's' : ''} ·
              {' '}{fmtMoneyShort(buyerTotals.volume)} TND
            </span>
          </h3>
          {purchases.length === 0 ? (
            <p className="cdp__empty">Aucun achat.</p>
          ) : (
            <>
              <ul className="cdp__sales">
                {purchases.slice(0, buyerLimit).map((s) => (
                  <li key={s.id} className="cdp__sale">
                    <div className="cdp__sale-head">
                      <span className="cdp__sale-role cdp__sale-role--buyer">de</span>
                      <span className="cdp__sale-counterpart">{clientDisplayName(s.seller) || '—'}</span>
                      <span className="cdp__sale-amount">{fmtMoney(s.agreedPrice)}</span>
                    </div>
                    <div className="cdp__sale-meta">
                      <span className={`cdp__sale-status cdp__sale-status--${s.status}`}>{SALE_LABEL[s.status]}</span>
                      {s.project?.title ? <span>{s.project.title}</span> : null}
                      <span>{fmtDate(s.notaryAt)}</span>
                      {s.code ? <span className="cdp__sale-code">{s.code}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
              <ShowMoreButton
                shown={Math.min(buyerLimit, purchases.length)}
                total={purchases.length}
                onMore={() => setBuyerLimit((n) => n + PAGE_STEP)}
                onCollapse={() => setBuyerLimit(SALES_INITIAL)}
                noun="achats"
              />
            </>
          )}
        </section>

        {/* ========== NETWORK: UPLINE + DOWNLINE ========== */}
        <section className="cdp__group">
          <h3 className="cdp__group-title">🌳 Réseau</h3>

          <div className="cdp__subsection">
            <div className="cdp__subsection-title">
              Chaîne de parrainage
              <span className="cdp__section-sub">
                {ancestors.length === 0 ? 'racine' : `${ancestors.length} au-dessus`}
              </span>
            </div>
            {ancestors.length === 0 ? (
              <p className="cdp__empty">Racine du réseau — aucun parrain.</p>
            ) : (
              <ol className="cdp__chain">
                {ancestors.map((c, i) => (
                  <li key={c.id} className="cdp__chain-item">
                    <span className="cdp__chain-step">{i + 1}</span>
                    <span className="cdp__chain-name">{clientDisplayName(c)}</span>
                    {c.code ? <span className="cdp__chain-code">{c.code}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="cdp__subsection">
            <div className="cdp__subsection-title">
              Filleuls directs
              <span className="cdp__section-sub">{directChildren.length}</span>
            </div>
            {directChildren.length === 0 ? (
              <p className="cdp__empty">Aucun filleul direct.</p>
            ) : (
              <ul className="cdp__children">
                {directChildren.map((c) => {
                  const n = filleulSalesCount.get(asStr(c.id)) || 0
                  return (
                    <li key={c.id} className="cdp__child">
                      <span className="cdp__child-avatar" aria-hidden="true">{clientInitials(c)}</span>
                      <span className="cdp__child-name">{clientDisplayName(c)}</span>
                      {n > 0 ? <span className="cdp__child-meta">{n} vente{n > 1 ? 's' : ''}</span> : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>

        {/* ========== RECENT COMMISSION EVENTS ========== */}
        <section className="cdp__group">
          <h3 className="cdp__group-title">
            📜 Dernières commissions reçues
            <span className="cdp__group-sub">{events.length}</span>
          </h3>
          {events.length === 0 ? (
            <p className="cdp__empty">Aucune commission enregistrée.</p>
          ) : (
            <>
              <ul className="cdp__events">
                {events.slice(0, eventsLimit).map((e) => (
                  <li key={e.id} className="cdp__event">
                    <div className="cdp__event-head">
                      <span className={`cdp__event-level cdp__event-level--l${Math.min(e.level, 4)}`}>L{e.level}</span>
                      <span className="cdp__event-amount">{fmtMoney(e.amount)}</span>
                      <span className={`cdp__event-status cdp__event-status--${e.status}`}>{COMMISSION_LABEL[e.status] || e.status}</span>
                    </div>
                    <div className="cdp__event-meta">
                      <span>{fmtDate(e.createdAt)}</span>
                      {e.saleCode ? <span className="cdp__event-sale">{e.saleCode}</span> : null}
                      {e.projectTitle ? <span className="cdp__event-project">{e.projectTitle}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
              <ShowMoreButton
                shown={Math.min(eventsLimit, events.length)}
                total={events.length}
                onMore={() => setEventsLimit((n) => n + PAGE_STEP)}
                onCollapse={() => setEventsLimit(EVENTS_INITIAL)}
                noun="commissions"
              />
            </>
          )}
        </section>
      </div>
    </aside>
  )
}

// ShowMoreButton — expand a list in PAGE_STEP chunks; collapse when done.
function ShowMoreButton({ shown, total, onMore, onCollapse, noun }) {
  const hasMore = shown < total
  const isExpanded = !hasMore && shown > Math.min(SALES_INITIAL, EVENTS_INITIAL)
  if (!hasMore && !isExpanded) return null
  if (hasMore) {
    const nextChunk = Math.min(PAGE_STEP, total - shown)
    return (
      <div className="cdp__more-wrap">
        <button type="button" className="cdp__more-btn" onClick={onMore}>
          <span>Voir les {nextChunk} suivant{nextChunk > 1 ? 's' : ''}</span>
          <span className="cdp__more-count">{shown} / {total} {noun}</span>
        </button>
      </div>
    )
  }
  return (
    <div className="cdp__more-wrap">
      <button type="button" className="cdp__more-btn cdp__more-btn--collapse" onClick={onCollapse}>
        <span>↑ Réduire la liste</span>
        <span className="cdp__more-count">tous affichés · {total} {noun}</span>
      </button>
    </div>
  )
}
