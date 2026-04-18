import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useClients, useCommissionLedger } from '../../lib/useSupabase.js'
import { useToast } from '../components/AdminToast.jsx'
import CommissionOverrideModal from '../components/CommissionOverrideModal.jsx'
import '../admin-v2.css'
import './zitouna-admin-page.css'

function fmtMoney(v) {
  return `${(Number(v) || 0).toLocaleString('fr-FR')} TND`
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

// Map each commission/request status to a ZADM pill tone — single source of
// truth so badges stay consistent between the ledger rows and the table.
function statusTone(s) {
  const m = {
    pending: 'warn',
    pending_review: 'warn',
    payable: 'info',
    approved: 'primary',
    paid: 'success',
    rejected: 'danger',
  }
  return m[s] || 'neutral'
}

function StatusPill({ status }) {
  const tone = statusTone(status)
  return (
    <span className={`zadm-pill zadm-pill--${tone}`}>
      <span className="zadm-pill__dot" aria-hidden />
      {statusLabel(status)}
    </span>
  )
}

export default function CommissionLedgerPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { addToast } = useToast()
  const { clients } = useClients()
  const { commissionEvents, payoutRequests, submitPayoutRequest, reviewPayoutRequest, refresh } =
    useCommissionLedger()
  const [payRefByReq, setPayRefByReq] = useState({})
  const [rejectReasonByReq, setRejectReasonByReq] = useState({})
  const [editingEvent, setEditingEvent] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [query, setQuery] = useState('')

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

  const clientName = (id) => (clients || []).find((c) => String(c.id) === String(id))?.name || id

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

  // High-level KPIs for the header strip
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
    const r = await submitPayoutRequest(beneficiaryClientId, adminUser?.id || null)
    if (!r.ok) {
      if (r.reason === 'below_threshold') {
        addToast(`Seuil minimum ${r.minThresh} TND non atteint (actuel ${r.gross})`, 'error')
      } else if (r.reason === 'no_payable') {
        addToast('Aucune ligne payable libre pour ce bénéficiaire', 'error')
      } else if (r.reason === 'invalid') {
        addToast('Bénéficiaire invalide', 'error')
      } else addToast('Impossible de créer la demande', 'error')
      return
    }
    addToast('Demande de paiement créée — en attente de validation')
  }

  const handleReview = async (reqId, decision) => {
    const opts = { reviewerId: adminUser?.id || null }
    if (decision === 'rejected') opts.reason = rejectReasonByReq[reqId] || 'Rejeté'
    if (decision === 'paid') {
      opts.paymentRef = payRefByReq[reqId] || `REF-${Date.now()}`
    }
    const r = await reviewPayoutRequest(reqId, decision, opts)
    if (!r.ok) {
      addToast('Action impossible sur cette demande', 'error')
      return
    }
    addToast(decision === 'paid' ? 'Paiement enregistré' : 'Demande mise à jour')
  }

  // Sort + filter the full ledger feed; the filter + search inputs live in the
  // card toolbar so they stay near the data they drive.
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
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
    // clientName is derived from clients, which is captured in scope; lint is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedEvents, statusFilter, query, clients])

  return (
    <div className="zadm-page" dir="ltr">
      <button
        type="button"
        className="zadm-btn zadm-btn--ghost zadm-btn--sm"
        onClick={() => navigate(-1)}
        style={{ marginBottom: 12 }}
      >
        <span aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="zadm-page__head">
        <div className="zadm-page__head-text">
          <h1 className="zadm-page__title">Règlement des commissions</h1>
          <p className="zadm-page__subtitle">
            Suivez les commissions, validez les demandes et enregistrez les paiements.
          </p>
        </div>
        <div className="zadm-page__head-actions">
          <button
            type="button"
            className="zadm-btn zadm-btn--secondary zadm-btn--sm"
            onClick={() => {
              if (typeof refresh === 'function') refresh()
            }}
          >
            Rafraîchir
          </button>
        </div>
      </header>

      <div className="zadm-page__body">
        {/* KPI strip — totals first so admins scan amounts before workflow */}
        <div className="zadm-kpi-grid">
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">En attente</span>
            <span className="zadm-kpi__value">{fmtMoney(totals.pendingAmt)}</span>
            <span className="zadm-kpi__hint">Pas encore payables</span>
          </div>
          <div className="zadm-kpi zadm-kpi--accent">
            <span className="zadm-kpi__label">À payer</span>
            <span className="zadm-kpi__value">{fmtMoney(totals.payableAmt)}</span>
            <span className="zadm-kpi__hint">Prêt à regrouper</span>
          </div>
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">Déjà payé</span>
            <span className="zadm-kpi__value">{fmtMoney(totals.paidAmt)}</span>
            <span className="zadm-kpi__hint">Cumul historique</span>
          </div>
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">Demandes ouvertes</span>
            <span className="zadm-kpi__value">{totals.openReqs}</span>
            <span className="zadm-kpi__hint">En revue ou approuvées</span>
          </div>
        </div>

        {/* Section 1: aggregation by beneficiary */}
        <section className="zadm-card">
          <header className="zadm-card__head">
            <div className="zadm-card__head-text">
              <h2 className="zadm-card__title">1. Bénéficiaires à payer</h2>
              <p className="zadm-card__subtitle">
                Regroupez les lignes payables en une demande. Le seuil minimum vient des réglages projet.
              </p>
            </div>
          </header>
          <div className="zadm-card__body">
            {payableByBeneficiary.length === 0 ? (
              <div className="zadm-empty">
                <div className="zadm-empty__icon" aria-hidden>∅</div>
                <div className="zadm-empty__title">Aucun montant à regrouper</div>
                <p className="zadm-empty__hint">
                  Les commissions apparaîtront ici dès qu'une vente sera clôturée au notaire.
                </p>
              </div>
            ) : (
              <div className="zadm-table-wrap">
                <table className="zadm-table">
                  <thead>
                    <tr>
                      <th className="zadm-th">Bénéficiaire</th>
                      <th className="zadm-th">Lignes</th>
                      <th className="zadm-th" style={{ textAlign: 'right' }}>Montant brut</th>
                      <th className="zadm-th" style={{ textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payableByBeneficiary.map((row) => (
                      <tr key={row.beneficiaryClientId} className="zadm-tr">
                        <td className="zadm-td" style={{ fontWeight: 600 }}>{clientName(row.beneficiaryClientId)}</td>
                        <td className="zadm-td zadm-td--muted">
                          {row.count} ligne{row.count > 1 ? 's' : ''} payable{row.count > 1 ? 's' : ''}
                        </td>
                        <td className="zadm-td zadm-td--num" style={{ fontWeight: 700 }}>
                          {fmtMoney(row.gross)}
                        </td>
                        <td className="zadm-td zadm-td--actions">
                          <button
                            type="button"
                            className="zadm-btn zadm-btn--primary zadm-btn--sm"
                            onClick={() => handleSubmit(row.beneficiaryClientId)}
                          >
                            Créer la demande
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Section 2: payout requests lifecycle */}
        <section className="zadm-card">
          <header className="zadm-card__head">
            <div className="zadm-card__head-text">
              <h2 className="zadm-card__title">2. Demandes de paiement</h2>
              <p className="zadm-card__subtitle">
                Approuvez, rejetez ou clôturez chaque demande. Renseignez une référence avant de marquer comme payé.
              </p>
            </div>
          </header>
          <div className="zadm-card__body">
            {sortedRequests.length === 0 ? (
              <div className="zadm-empty">
                <div className="zadm-empty__icon" aria-hidden>◷</div>
                <div className="zadm-empty__title">Aucune demande enregistrée</div>
                <p className="zadm-empty__hint">
                  Créez une demande depuis la section « Bénéficiaires à payer » ci-dessus.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {sortedRequests.map((req) => (
                  <div
                    key={req.id}
                    style={{
                      border: '1px solid var(--zadm-border)',
                      borderRadius: 'var(--zadm-r)',
                      padding: 16,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--zadm-text)' }}>
                          {clientName(req.beneficiaryClientId)}
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--zadm-text-dim)', marginTop: 2 }}>
                          {(req.eventIds || []).length} événement
                          {(req.eventIds || []).length > 1 ? 's' : ''} regroupé
                          {(req.eventIds || []).length > 1 ? 's' : ''}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--zadm-text-muted)', marginTop: 4 }}>
                          Créé le {req.createdAt || '—'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--zadm-text)' }}>
                          {fmtMoney(req.grossAmount)}
                        </div>
                        <StatusPill status={req.status} />
                      </div>
                    </div>

                    {req.status === 'pending_review' ? (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 8,
                          alignItems: 'center',
                          paddingTop: 12,
                          borderTop: '1px dashed var(--zadm-border)',
                        }}
                      >
                        <input
                          className="zadm-filter__control"
                          style={{ flex: '1 1 220px', minWidth: 0 }}
                          placeholder="Motif du rejet (si applicable)"
                          value={rejectReasonByReq[req.id] || ''}
                          onChange={(e) =>
                            setRejectReasonByReq((m) => ({ ...m, [req.id]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="zadm-btn zadm-btn--primary zadm-btn--sm"
                          onClick={() => handleReview(req.id, 'approved')}
                        >
                          Approuver
                        </button>
                        <button
                          type="button"
                          className="zadm-btn zadm-btn--danger zadm-btn--sm"
                          onClick={() => handleReview(req.id, 'rejected')}
                        >
                          Rejeter
                        </button>
                      </div>
                    ) : null}

                    {req.status === 'approved' ? (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 8,
                          alignItems: 'center',
                          paddingTop: 12,
                          borderTop: '1px dashed var(--zadm-border)',
                        }}
                      >
                        <input
                          className="zadm-filter__control"
                          style={{ flex: '1 1 220px', minWidth: 0 }}
                          placeholder="Référence paiement (ex. virement #1234)"
                          value={payRefByReq[req.id] || ''}
                          onChange={(e) =>
                            setPayRefByReq((m) => ({ ...m, [req.id]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="zadm-btn zadm-btn--primary zadm-btn--sm"
                          onClick={() => handleReview(req.id, 'paid')}
                        >
                          Marquer payé
                        </button>
                      </div>
                    ) : null}

                    {req.status === 'paid' ? (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 12px',
                          background: 'var(--zadm-success-50)',
                          borderRadius: 'var(--zadm-r-sm)',
                          fontSize: 13,
                          color: 'var(--zadm-success)',
                          fontWeight: 500,
                        }}
                      >
                        <span aria-hidden>✓</span>
                        <span>
                          Payé le {req.paidAt || '—'}
                          {req.paymentRef ? ` · Réf. ${req.paymentRef}` : ''}
                        </span>
                      </div>
                    ) : null}

                    {req.status === 'rejected' && req.reviewReason ? (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '8px 12px',
                          background: 'var(--zadm-danger-50)',
                          borderRadius: 'var(--zadm-r-sm)',
                          fontSize: 13,
                          color: 'var(--zadm-danger)',
                        }}
                      >
                        <span aria-hidden>✕</span>
                        <span>Rejeté : {req.reviewReason}</span>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Section 3: full ledger table with filters */}
        <section className="zadm-card">
          <header className="zadm-card__head">
            <div className="zadm-card__head-text">
              <h2 className="zadm-card__title">3. Journal des commissions</h2>
              <p className="zadm-card__subtitle">
                {totals.eventsCount} événement{totals.eventsCount > 1 ? 's' : ''} au total · tri du plus récent au plus ancien.
              </p>
            </div>
          </header>
          <div className="zadm-toolbar">
            <div className="zadm-toolbar__left">
              <div className="zadm-search">
                <span className="zadm-search__icon" aria-hidden>⌕</span>
                <input
                  type="search"
                  className="zadm-search__input"
                  placeholder="Rechercher (vente, bénéficiaire, niveau)…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
            <div className="zadm-toolbar__right">
              <div className="zadm-filters">
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
                    className={`zadm-chip${statusFilter === opt.k ? ' zadm-chip--active' : ''}`}
                    onClick={() => setStatusFilter(opt.k)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="zadm-card__body zadm-card__body--flush">
            {filteredEvents.length === 0 ? (
              <div style={{ padding: 16 }}>
                <div className="zadm-empty">
                  <div className="zadm-empty__icon" aria-hidden>∅</div>
                  <div className="zadm-empty__title">Aucun événement</div>
                  <p className="zadm-empty__hint">
                    {sortedEvents.length === 0
                      ? 'Les commissions générées apparaîtront ici.'
                      : 'Aucune ligne ne correspond à vos filtres.'}
                  </p>
                </div>
              </div>
            ) : (
              <div className="zadm-table-wrap">
                <table className="zadm-table">
                  <thead>
                    <tr>
                      <th className="zadm-th">Vente</th>
                      <th className="zadm-th">Bénéficiaire</th>
                      <th className="zadm-th">Niveau</th>
                      <th className="zadm-th" style={{ textAlign: 'right' }}>Montant</th>
                      <th className="zadm-th">Statut</th>
                      {adminUser?.id ? (
                        <th className="zadm-th" style={{ textAlign: 'right' }}>Action</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEvents.map((e) => (
                      <tr key={e.id} className="zadm-tr">
                        <td
                          className="zadm-td zadm-td--muted"
                          style={{
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: 12,
                          }}
                        >
                          {e.saleId}
                        </td>
                        <td className="zadm-td" style={{ fontWeight: 500 }}>
                          {clientName(e.beneficiaryClientId)}
                        </td>
                        <td className="zadm-td zadm-td--muted">N{e.level}</td>
                        <td className="zadm-td zadm-td--num" style={{ fontWeight: 600 }}>
                          {fmtMoney(e.amount)}
                        </td>
                        <td className="zadm-td">
                          <StatusPill status={e.status} />
                        </td>
                        {adminUser?.id ? (
                          <td className="zadm-td zadm-td--actions">
                            <button
                              type="button"
                              className="zadm-btn zadm-btn--ghost zadm-btn--sm"
                              onClick={() => openOverrideFor(e)}
                              title="Ajuster le montant ou le statut"
                            >
                              Modifier
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

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
