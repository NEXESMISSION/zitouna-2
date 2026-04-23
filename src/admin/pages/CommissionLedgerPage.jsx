import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useClients, useCommissionLedger } from '../../lib/useSupabase.js'
import { runSafeAction } from '../../lib/runSafeAction.js'
import { useToast } from '../components/AdminToast.jsx'
import AdminModal from '../components/AdminModal.jsx'
import CommissionOverrideModal from '../components/CommissionOverrideModal.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { SkeletonCard } from '../../components/skeletons/index.js'
import { getPagerPages } from './pager-util.js'
import { fmtMoney, fmtMoneyBare, fmtDate } from '../lib/commissionFormat.js'
import './sell-field.css'
import './commission-ledger.css'

const EVENTS_PER_PAGE = 15

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

function statusLabel(s) {
  const m = {
    payable: 'À payer',
    paid: 'Payé',
    pending_review: 'En revue',
    approved: 'Approuvé',
    rejected: 'Rejeté',
    pending: 'En attente',
  }
  return m[s] || s
}

// Map status → sp-card/sp-badge tone so badges stay consistent across views.
function statusTone(s) {
  const m = {
    pending: 'orange',
    pending_review: 'orange',
    payable: 'blue',
    approved: 'purple',
    paid: 'green',
    rejected: 'red',
  }
  return m[s] || 'gray'
}

export default function CommissionLedgerPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { addToast } = useToast()
  const { clients } = useClients()
  const {
    commissionEvents,
    payoutRequests,
    submitPayoutRequest,
    reviewPayoutRequest,
    refresh,
    loading,
  } = useCommissionLedger()

  const [tab, setTab] = useState('beneficiaries')
  const [statusFilter, setStatusFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  // Per-row busy keys: 'submit:<beneficiaryId>' or 'review:<requestId>:<decision>'.
  // A string (or null) lets us disable the exact button being clicked without a
  // blanket disabled-everything-while-any-action-is-pending sledgehammer.
  const [busyKey, setBusyKey] = useState(null)
  const [payRefByReq, setPayRefByReq] = useState({})
  const [rejectReasonByReq, setRejectReasonByReq] = useState({})
  const [editingEvent, setEditingEvent] = useState(null)
  const [selectedRequest, setSelectedRequest] = useState(null)
  const [selectedBeneficiary, setSelectedBeneficiary] = useState(null)

  const clientName = (id) => (clients || []).find((c) => String(c.id) === String(id))?.name || id

  // Remap the camelCase hook shape back to the snake_case DB shape the override
  // modal and audit log expect. Keeps the modal decoupled from the hook's view.
  const openOverrideFor = (e) => {
    if (!e) return
    setEditingEvent({
      id: e.id,
      sale_id: e.saleId,
      beneficiary_client_id: e.beneficiaryClientId,
      level: e.level,
      amount: Number(e.amount || 0),
      status: e.status,
    })
  }

  const eventsByBeneficiary = useMemo(() => {
    const map = new Map()
    for (const e of commissionEvents || []) {
      const k = String(e.beneficiaryClientId || '')
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(e)
    }
    return map
  }, [commissionEvents])

  const claimedEventIds = useMemo(() => {
    const ids = new Set()
    for (const r of payoutRequests || []) {
      if (['pending_review', 'approved'].includes(r.status)) {
        for (const id of r.eventIds || []) ids.add(id)
      }
    }
    return ids
  }, [payoutRequests])

  const payableByBeneficiary = useMemo(() => {
    const out = []
    for (const [bid, list] of eventsByBeneficiary.entries()) {
      if (!bid) continue
      const payable = list.filter(
        (e) => e.status === 'payable' && !e.paidAt && !claimedEventIds.has(e.id),
      )
      const gross = payable.reduce((s, e) => s + Number(e.amount || 0), 0)
      if (payable.length) out.push({ beneficiaryClientId: bid, count: payable.length, gross })
    }
    out.sort((a, b) => b.gross - a.gross)
    return out
  }, [eventsByBeneficiary, claimedEventIds])

  const sortedRequests = useMemo(
    () =>
      [...(payoutRequests || [])].sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
      ),
    [payoutRequests],
  )

  // High-level KPIs for the hero strip
  const totals = useMemo(() => {
    const events = commissionEvents || []
    const reqs = payoutRequests || []
    const pendingAmt = events
      .filter((e) => e.status === 'pending')
      .reduce((s, e) => s + Number(e.amount || 0), 0)
    const payableAmt = events
      .filter((e) => e.status === 'payable' && !e.paidAt && !claimedEventIds.has(e.id))
      .reduce((s, e) => s + Number(e.amount || 0), 0)
    const paidAmt = events
      .filter((e) => e.status === 'paid' || e.paidAt)
      .reduce((s, e) => s + Number(e.amount || 0), 0)
    const openReqs = reqs.filter((r) => ['pending_review', 'approved'].includes(r.status)).length
    return { pendingAmt, payableAmt, paidAmt, openReqs, eventsCount: events.length }
  }, [commissionEvents, payoutRequests, claimedEventIds])

  const handleSubmit = async (beneficiaryClientId) => {
    const key = `submit:${beneficiaryClientId}`
    if (busyKey) return
    const res = await runSafeAction({
      setBusy: (v) => setBusyKey(v ? key : null),
      onError: (msg) => addToast(msg, 'error'),
      label: 'Créer la demande de paiement',
    }, async () => {
      const r = await submitPayoutRequest(beneficiaryClientId, adminUser?.id || null)
      if (!r.ok) {
        if (r.reason === 'below_threshold') {
          throw new Error(`Seuil minimum ${r.minThresh} TND non atteint (actuel ${r.gross})`)
        } else if (r.reason === 'no_payable') {
          throw new Error('Aucune ligne payable libre pour ce bénéficiaire')
        } else if (r.reason === 'invalid') {
          throw new Error('Bénéficiaire invalide')
        } else if (r.reason === 'not_admin') {
          throw new Error('Action réservée aux administrateurs')
        } else {
          throw new Error('Impossible de créer la demande')
        }
      }
    })
    if (res.ok) addToast('Demande de paiement créée — en attente de validation')
  }

  const handleReview = async (reqId, decision) => {
    const key = `review:${reqId}:${decision}`
    if (busyKey) return
    const res = await runSafeAction({
      setBusy: (v) => setBusyKey(v ? key : null),
      onError: (msg) => addToast(msg, 'error'),
      label: decision === 'paid'
        ? 'Marquer payé'
        : `${decision === 'approved' ? 'Approuver' : 'Rejeter'} la demande`,
    }, async () => {
      const opts = { reviewerId: adminUser?.id || null }
      if (decision === 'rejected') opts.reason = rejectReasonByReq[reqId] || 'Rejeté'
      if (decision === 'paid') opts.paymentRef = payRefByReq[reqId] || `REF-${Date.now()}`
      const r = await reviewPayoutRequest(reqId, decision, opts)
      if (!r.ok) {
        if (r.reason === 'not_admin') throw new Error('Action réservée aux administrateurs')
        throw new Error('Action impossible sur cette demande')
      }
    })
    if (res.ok) {
      addToast(decision === 'paid' ? 'Paiement enregistré' : 'Demande mise à jour')
      // Close the detail modal once the action resolved — the caller saw the
      // toast and the background list updates via the hook refresh.
      setSelectedRequest(null)
    }
  }

  // Sort + filter the full ledger feed
  const sortedEvents = useMemo(
    () =>
      [...(commissionEvents || [])].sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
      ),
    [commissionEvents],
  )

  const filteredEvents = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sortedEvents.filter((e) => {
      if (statusFilter !== 'all' && e.status !== statusFilter) return false
      if (!q) return true
      const haystack = [
        String(e.saleId || ''),
        clientName(e.beneficiaryClientId),
        `n${e.level || ''}`,
        statusLabel(e.status),
      ].join(' ').toLowerCase()
      return haystack.includes(q)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedEvents, statusFilter, query, clients])

  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / EVENTS_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pagedEvents = useMemo(
    () => filteredEvents.slice((safePage - 1) * EVENTS_PER_PAGE, safePage * EVENTS_PER_PAGE),
    [filteredEvents, safePage],
  )

  const onQueryChange = (e) => { setQuery(e.target.value); setPage(1) }
  const onStatusFilterChange = (k) => { setStatusFilter(k); setPage(1) }
  const onTabChange = (t) => { setTab(t); setPage(1) }

  // Plan 03 §4.3: shared underlying store means the hero KPIs and the
  // per-tab gate both key off the same `loading` value. Once the first tick
  // resolves, the KPI numbers render for real. The tab bodies below use
  // independent <RenderDataGate> so a broken tab doesn't mask the others.
  const kpiLoading = loading && (commissionEvents || []).length === 0

  // Tab counts
  const counts = {
    beneficiaries: payableByBeneficiary.length,
    requests: sortedRequests.length,
    events: (commissionEvents || []).length,
  }

  // Events belonging to the selected beneficiary (for the side panel)
  const selectedBeneficiaryEvents = useMemo(() => {
    if (!selectedBeneficiary) return []
    return (eventsByBeneficiary.get(String(selectedBeneficiary)) || [])
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  }, [selectedBeneficiary, eventsByBeneficiary])

  return (
    <div className="sell-field" dir="ltr">
      <div className="led-topbar">
        <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
          <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
          <span>Retour</span>
        </button>
        <button
          type="button"
          className="led-refresh"
          onClick={() => { if (typeof refresh === 'function') refresh() }}
        >
          <span aria-hidden>⟳</span>
          <span>Rafraîchir</span>
        </button>
      </div>

      <header className="sp-hero">
        <div className="sp-hero__avatar" aria-hidden>
          <span style={{
            width: '100%', height: '100%', display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 24,
          }}>💰</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Règlement des commissions</h1>
          <p className="sp-hero__role">
            Suivez les commissions, validez les demandes et enregistrez les paiements.
          </p>
        </div>
        <div className="led-hero-kpis">
          <div className="led-hero-kpi">
            <span className="led-hero-kpi__num">
              {kpiLoading ? <span className="sk-num sk-num--wide" /> : fmtMoney(totals.payableAmt)}
            </span>
            <span className="led-hero-kpi__label">À payer</span>
          </div>
          <span className="led-hero-kpi__sep" aria-hidden />
          <div className="led-hero-kpi">
            <span className="led-hero-kpi__num">
              {kpiLoading ? <span className="sk-num" /> : totals.openReqs}
            </span>
            <span className="led-hero-kpi__label">Demandes</span>
          </div>
          <span className="led-hero-kpi__sep" aria-hidden />
          <div className="led-hero-kpi">
            <span className="led-hero-kpi__num">
              {kpiLoading ? <span className="sk-num" /> : totals.eventsCount}
            </span>
            <span className="led-hero-kpi__label">Événements</span>
          </div>
        </div>
      </header>

      <div className="led-tabs" role="tablist" aria-label="Sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'beneficiaries'}
          className={`led-tab ${tab === 'beneficiaries' ? 'led-tab--on' : ''}`}
          onClick={() => onTabChange('beneficiaries')}
        >
          <span>Bénéficiaires</span>
          <span className="led-tab__count">{counts.beneficiaries}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'requests'}
          className={`led-tab ${tab === 'requests' ? 'led-tab--on' : ''}`}
          onClick={() => onTabChange('requests')}
        >
          <span>Demandes</span>
          <span className="led-tab__count">{counts.requests}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'events'}
          className={`led-tab ${tab === 'events' ? 'led-tab--on' : ''}`}
          onClick={() => onTabChange('events')}
        >
          <span>Événements</span>
          <span className="led-tab__count">{counts.events}</span>
        </button>
      </div>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{kpiLoading ? <span className="sk-num" /> : fmtMoney(totals.pendingAmt)}</strong> en attente
          <span className="sp-cat-stat-dot" />
          <strong>{kpiLoading ? <span className="sk-num" /> : fmtMoney(totals.payableAmt)}</strong> à payer
          <span className="sp-cat-stat-dot" />
          <strong>{kpiLoading ? <span className="sk-num" /> : fmtMoney(totals.paidAmt)}</strong> payé
        </div>
        {tab === 'events' && (
          <>
            <div className="sp-cat-filters">
              <input
                className="sp-cat-search"
                placeholder="Rechercher (vente, bénéficiaire, niveau)…"
                value={query}
                onChange={onQueryChange}
                aria-label="Rechercher un événement"
              />
            </div>
            <div className="led-chips" role="group" aria-label="Filtrer par statut">
              {[
                { k: 'all', label: 'Tous' },
                { k: 'pending', label: 'En attente' },
                { k: 'payable', label: 'À payer' },
                { k: 'paid', label: 'Payé' },
                { k: 'rejected', label: 'Rejeté' },
              ].map((opt) => (
                <button
                  key={opt.k}
                  type="button"
                  className={`led-chip${statusFilter === opt.k ? ' led-chip--on' : ''}`}
                  onClick={() => onStatusFilterChange(opt.k)}
                  aria-pressed={statusFilter === opt.k}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ─────────── TAB: BÉNÉFICIAIRES ─────────── */}
      {tab === 'beneficiaries' && (
        <div className="sp-cards">
          <RenderDataGate
            loading={loading && (commissionEvents || []).length === 0}
            data={payableByBeneficiary}
            onRetry={refresh}
            skeleton={<SkeletonCard cards={4} />}
            empty={
              <EmptyState
                icon="📭"
                title="Aucun montant à regrouper"
                description="Les commissions apparaîtront ici dès qu'une vente sera clôturée au notaire."
              />
            }
          >
            {(rows) => rows.map((row) => {
            const name = clientName(row.beneficiaryClientId)
            const busy = busyKey === `submit:${row.beneficiaryClientId}`
            return (
              <div
                key={row.beneficiaryClientId}
                className="sp-card sp-card--blue"
                style={{ cursor: 'default' }}
              >
                <div className="sp-card__head">
                  <div className="sp-card__user">
                    <span className="sp-card__initials">{initials(name)}</span>
                    <div style={{ minWidth: 0 }}>
                      <p className="sp-card__name">{name}</p>
                      <p className="sp-card__sub">
                        {row.count} ligne{row.count > 1 ? 's' : ''} payable{row.count > 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <span className="sp-badge sp-badge--blue">À regrouper</span>
                </div>

                <div className="sp-card__body">
                  <div className="sp-card__price">
                    <span className="sp-card__amount">{fmtMoneyBare(row.gross)}</span>
                    <span className="sp-card__currency">TND</span>
                  </div>
                  <div className="sp-card__info" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="led-card-cta led-card-cta--ghost"
                      onClick={() => setSelectedBeneficiary(row.beneficiaryClientId)}
                      disabled={Boolean(busyKey)}
                      title="Voir les lignes payables"
                    >
                      Détail
                    </button>
                    <button
                      type="button"
                      className="led-card-cta"
                      onClick={() => handleSubmit(row.beneficiaryClientId)}
                      disabled={Boolean(busyKey)}
                    >
                      {busy ? 'Création…' : 'Créer la demande'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
          </RenderDataGate>
        </div>
      )}

      {/* ─────────── TAB: DEMANDES ─────────── */}
      {tab === 'requests' && (
        <div className="sp-cards">
          <RenderDataGate
            loading={loading && (commissionEvents || []).length === 0}
            data={sortedRequests}
            onRetry={refresh}
            skeleton={<SkeletonCard cards={4} />}
            empty={
              <EmptyState
                icon="📭"
                title="Aucune demande enregistrée"
                description="Créez une demande depuis l'onglet « Bénéficiaires »."
              />
            }
          >
            {(reqs) => reqs.map((req) => {
            const name = clientName(req.beneficiaryClientId)
            const tone = statusTone(req.status)
            const nEv = (req.eventIds || []).length
            return (
              <button
                key={req.id}
                type="button"
                className={`sp-card sp-card--${tone}`}
                onClick={() => setSelectedRequest(req)}
                aria-label={`Ouvrir la demande de ${name}`}
              >
                <div className="sp-card__head">
                  <div className="sp-card__user">
                    <span className="sp-card__initials">{initials(name)}</span>
                    <div style={{ minWidth: 0 }}>
                      <p className="sp-card__name">{name}</p>
                      <p className="sp-card__sub">
                        {nEv} événement{nEv > 1 ? 's' : ''} · {fmtDate(req.createdAt)}
                      </p>
                    </div>
                  </div>
                  <span className={`sp-badge sp-badge--${tone}`}>{statusLabel(req.status)}</span>
                </div>

                <div className="sp-card__body">
                  <div className="sp-card__price">
                    <span className="sp-card__amount">{fmtMoneyBare(req.grossAmount)}</span>
                    <span className="sp-card__currency">TND</span>
                  </div>
                  <div className="sp-card__info">
                    <span>
                      {req.status === 'pending_review' && 'Validation requise'}
                      {req.status === 'approved' && 'À payer'}
                      {req.status === 'paid' && (req.paymentRef ? `Réf. ${req.paymentRef}` : 'Payé')}
                      {req.status === 'rejected' && 'Rejetée'}
                    </span>
                  </div>
                </div>
              </button>
            )
          })}
          </RenderDataGate>
        </div>
      )}

      {/* ─────────── TAB: ÉVÉNEMENTS ─────────── */}
      {tab === 'events' && (
        <>
          <div className="sp-cards">
            <RenderDataGate
              loading={loading && (commissionEvents || []).length === 0}
              data={filteredEvents}
              onRetry={refresh}
              skeleton={<SkeletonCard cards={6} />}
              empty={
                <EmptyState
                  icon={sortedEvents.length === 0 ? '📭' : '🔍'}
                  title={sortedEvents.length === 0 ? 'Aucun événement' : 'Aucun événement ne correspond'}
                  description={
                    sortedEvents.length === 0
                      ? 'Les commissions générées apparaîtront ici.'
                      : 'Essayez un autre terme ou réinitialisez les filtres.'
                  }
                />
              }
            >
              {() => pagedEvents.map((e) => {
              const name = clientName(e.beneficiaryClientId)
              const tone = statusTone(e.status)
              return (
                <div key={e.id} className={`sp-card sp-card--${tone}`} style={{ cursor: 'default' }}>
                  <div className="sp-card__head">
                    <div className="sp-card__user">
                      <span className="sp-card__initials">{initials(name)}</span>
                      <div style={{ minWidth: 0 }}>
                        <p className="sp-card__name">{name}</p>
                        <p className="sp-card__sub">
                          N{e.level} · <span className="led-mono">{e.saleId}</span>
                        </p>
                      </div>
                    </div>
                    <span className={`sp-badge sp-badge--${tone}`}>{statusLabel(e.status)}</span>
                  </div>

                  <div className="sp-card__body">
                    <div className="sp-card__price">
                      <span className="sp-card__amount">{fmtMoneyBare(e.amount)}</span>
                      <span className="sp-card__currency">TND</span>
                    </div>
                    <div className="sp-card__info">
                      {adminUser?.id ? (
                        <button
                          type="button"
                          className="led-card-cta led-card-cta--ghost"
                          onClick={() => openOverrideFor(e)}
                          title="Ajuster le montant ou le statut"
                        >
                          Modifier
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
            </RenderDataGate>
          </div>

          {!kpiLoading && filteredEvents.length > EVENTS_PER_PAGE && (
            <div className="sp-pager" role="navigation" aria-label="Pagination">
              <button
                type="button"
                className="sp-pager__btn sp-pager__btn--nav"
                disabled={safePage <= 1}
                onClick={() => setPage(Math.max(1, safePage - 1))}
                aria-label="Page précédente"
              >
                ‹
              </button>
              {getPagerPages(safePage, pageCount).map((p, i) =>
                p === '…' ? (
                  <span key={`dots-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
                ) : (
                  <button
                    key={p}
                    type="button"
                    className={`sp-pager__btn${p === safePage ? ' sp-pager__btn--active' : ''}`}
                    onClick={() => setPage(p)}
                    aria-current={p === safePage ? 'page' : undefined}
                  >
                    {p}
                  </button>
                ),
              )}
              <button
                type="button"
                className="sp-pager__btn sp-pager__btn--nav"
                disabled={safePage >= pageCount}
                onClick={() => setPage(Math.min(pageCount, safePage + 1))}
                aria-label="Page suivante"
              >
                ›
              </button>
              <span className="sp-pager__info">
                {(safePage - 1) * EVENTS_PER_PAGE + 1}–{Math.min(safePage * EVENTS_PER_PAGE, filteredEvents.length)} / {filteredEvents.length}
              </span>
            </div>
          )}
        </>
      )}

      {/* ─────────── REQUEST DETAIL MODAL ─────────── */}
      {selectedRequest && (() => {
        const req = selectedRequest
        const name = clientName(req.beneficiaryClientId)
        const tone = statusTone(req.status)
        const nEv = (req.eventIds || []).length
        return (
          <AdminModal open onClose={() => setSelectedRequest(null)} title="">
            <div className="sp-detail">
              <div className="sp-detail__banner">
                <div className="sp-detail__banner-top">
                  <span className={`sp-badge sp-badge--${tone}`}>{statusLabel(req.status)}</span>
                  <span className="sp-detail__date">{fmtDate(req.createdAt)}</span>
                </div>
                <div className="sp-detail__price">
                  <span className="sp-detail__price-num">{fmtMoneyBare(req.grossAmount)}</span>
                  <span className="sp-detail__price-cur">TND</span>
                </div>
                <p className="sp-detail__banner-sub">
                  {name} · {nEv} événement{nEv > 1 ? 's' : ''} regroupé{nEv > 1 ? 's' : ''}
                </p>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Demande</div>
                <div className="sp-detail__row"><span>Bénéficiaire</span><strong>{name}</strong></div>
                <div className="sp-detail__row"><span>Événements</span><strong>{nEv}</strong></div>
                <div className="sp-detail__row"><span>Créé le</span><strong>{fmtDate(req.createdAt)}</strong></div>
                <div className="sp-detail__row"><span>Statut</span><strong>{statusLabel(req.status)}</strong></div>
                {req.paidAt ? (
                  <div className="sp-detail__row"><span>Payé le</span><strong>{fmtDate(req.paidAt)}</strong></div>
                ) : null}
                {req.paymentRef ? (
                  <div className="sp-detail__row"><span>Référence</span><strong>{req.paymentRef}</strong></div>
                ) : null}
              </div>

              {req.status === 'pending_review' && (
                <div className="sp-detail__section">
                  <div className="sp-detail__section-title">Validation</div>
                  <input
                    className="led-action-input"
                    placeholder="Motif du rejet (si applicable)"
                    value={rejectReasonByReq[req.id] || ''}
                    onChange={(ev) =>
                      setRejectReasonByReq((m) => ({ ...m, [req.id]: ev.target.value }))
                    }
                  />
                  <div className="led-actions">
                    <button
                      type="button"
                      className="led-btn led-btn--primary"
                      onClick={() => handleReview(req.id, 'approved')}
                      disabled={Boolean(busyKey)}
                    >
                      {busyKey === `review:${req.id}:approved` ? 'Approbation…' : 'Approuver'}
                    </button>
                    <button
                      type="button"
                      className="led-btn led-btn--danger"
                      onClick={() => handleReview(req.id, 'rejected')}
                      disabled={Boolean(busyKey)}
                    >
                      {busyKey === `review:${req.id}:rejected` ? 'Rejet…' : 'Rejeter'}
                    </button>
                  </div>
                </div>
              )}

              {req.status === 'approved' && (
                <div className="sp-detail__section">
                  <div className="sp-detail__section-title">Paiement</div>
                  <input
                    className="led-action-input"
                    placeholder="Référence paiement (ex. virement #1234)"
                    value={payRefByReq[req.id] || ''}
                    onChange={(ev) =>
                      setPayRefByReq((m) => ({ ...m, [req.id]: ev.target.value }))
                    }
                  />
                  <div className="led-actions">
                    <button
                      type="button"
                      className="led-btn led-btn--primary"
                      onClick={() => handleReview(req.id, 'paid')}
                      disabled={Boolean(busyKey)}
                    >
                      {busyKey === `review:${req.id}:paid` ? 'Enregistrement…' : 'Marquer payé'}
                    </button>
                  </div>
                </div>
              )}

              {req.status === 'paid' && (
                <div className="sp-detail__section">
                  <div className="led-status-banner led-status-banner--ok">
                    <span aria-hidden>✓</span>
                    <span>
                      Payé le {fmtDate(req.paidAt)}
                      {req.paymentRef ? ` · Réf. ${req.paymentRef}` : ''}
                    </span>
                  </div>
                </div>
              )}

              {req.status === 'rejected' && req.reviewReason ? (
                <div className="sp-detail__section">
                  <div className="led-status-banner led-status-banner--err">
                    <span aria-hidden>✕</span>
                    <span>Rejeté : {req.reviewReason}</span>
                  </div>
                </div>
              ) : null}

              <div className="sp-detail__actions">
                <button
                  type="button"
                  className="sp-detail__btn"
                  onClick={() => setSelectedRequest(null)}
                >
                  Fermer
                </button>
              </div>
            </div>
          </AdminModal>
        )
      })()}

      {/* ─────────── BENEFICIARY DETAIL MODAL (payable events) ─────────── */}
      {selectedBeneficiary && (() => {
        const name = clientName(selectedBeneficiary)
        const rows = selectedBeneficiaryEvents.filter(
          (e) => e.status === 'payable' && !e.paidAt && !claimedEventIds.has(e.id),
        )
        const gross = rows.reduce((s, e) => s + Number(e.amount || 0), 0)
        const busy = busyKey === `submit:${selectedBeneficiary}`
        return (
          <AdminModal open onClose={() => setSelectedBeneficiary(null)} title="">
            <div className="sp-detail">
              <div className="sp-detail__banner">
                <div className="sp-detail__banner-top">
                  <span className="sp-badge sp-badge--blue">À regrouper</span>
                  <span className="sp-detail__date">{rows.length} ligne{rows.length > 1 ? 's' : ''}</span>
                </div>
                <div className="sp-detail__price">
                  <span className="sp-detail__price-num">{fmtMoneyBare(gross)}</span>
                  <span className="sp-detail__price-cur">TND</span>
                </div>
                <p className="sp-detail__banner-sub">{name}</p>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Lignes payables</div>
                {rows.length === 0 ? (
                  <p className="sp-detail__notes">Aucune ligne payable libre.</p>
                ) : rows.map((ev) => (
                  <div key={ev.id} className="sp-detail__row">
                    <span>
                      N{ev.level} · <span className="led-mono">{ev.saleId}</span>
                    </span>
                    <strong>{fmtMoney(ev.amount)}</strong>
                  </div>
                ))}
                <div className="sp-detail__row sp-detail__row--highlight">
                  <span>Total brut</span><strong>{fmtMoney(gross)}</strong>
                </div>
              </div>

              <div className="sp-detail__actions">
                <button
                  type="button"
                  className="sp-detail__btn"
                  onClick={() => setSelectedBeneficiary(null)}
                  disabled={Boolean(busyKey)}
                >
                  Fermer
                </button>
                <button
                  type="button"
                  className="sp-detail__btn sp-detail__btn--edit"
                  onClick={async () => {
                    await handleSubmit(selectedBeneficiary)
                    setSelectedBeneficiary(null)
                  }}
                  disabled={Boolean(busyKey) || rows.length === 0}
                >
                  {busy ? 'Création…' : 'Créer la demande'}
                </button>
              </div>
            </div>
          </AdminModal>
        )
      })()}

      <CommissionOverrideModal
        event={editingEvent}
        open={!!editingEvent}
        onClose={() => setEditingEvent(null)}
        onSaved={() => {
          if (typeof refresh === 'function') refresh()
          addToast('Commission mise à jour')
        }}
      />
    </div>
  )
}
