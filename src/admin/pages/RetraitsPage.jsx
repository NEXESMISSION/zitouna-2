import { useCallback, useMemo, useState } from 'react'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useClients, useCommissionLedger } from '../../lib/useSupabase.js'
import { runSafeAction } from '../../lib/runSafeAction.js'
import { useToast } from '../components/AdminToast.jsx'
import AdminModal from '../components/AdminModal.jsx'
import './retraits-page.css'

/*
 * /admin/retraits — dedicated admin surface for accepting or rejecting
 * ambassador commission withdrawal requests (retraits des gains).
 *
 * This is a focused companion to /admin/distributions (which also covers
 * harvest distribution). Staff who only handle retrait decisions get a
 * queue-first view with one-click approve / reject and a reason prompt
 * for rejections, so the action is fast and auditable.
 */

const STATUS_META = {
  pending_review: { label: 'En attente', tone: 'amber' },
  approved:       { label: 'Approuvé',   tone: 'purple' },
  paid:           { label: 'Payé',       tone: 'green' },
  rejected:       { label: 'Rejeté',     tone: 'red' },
}

const FILTERS = [
  { k: 'pending_review', lbl: 'À traiter' },
  { k: 'approved',       lbl: 'Approuvées' },
  { k: 'paid',           lbl: 'Payées' },
  { k: 'rejected',       lbl: 'Rejetées' },
  { k: 'all',            lbl: 'Toutes' },
]

function fmtTND(n) {
  const v = Number(n) || 0
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} TND`
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '—' }
}

export default function RetraitsPage() {
  const { adminUser } = useAuth()
  const { addToast } = useToast()
  const { clients } = useClients()
  const { payoutRequests, reviewPayoutRequest, loading } = useCommissionLedger()

  const [statusFilter, setStatusFilter] = useState('pending_review')
  const [query, setQuery] = useState('')
  const [busyKey, setBusyKey] = useState(null)
  const [payRefByReq, setPayRefByReq] = useState({})
  const [rejectModal, setRejectModal] = useState(null) // { request, reason }

  const clientName = useCallback(
    (id) => (clients || []).find((c) => String(c.id) === String(id))?.name || String(id || ''),
    [clients],
  )

  const sortedRequests = useMemo(() => {
    const list = [...(payoutRequests || [])]
    list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    return list
  }, [payoutRequests])

  const filteredRequests = useMemo(() => {
    const base = statusFilter === 'all'
      ? sortedRequests
      : sortedRequests.filter((r) => r.status === statusFilter)
    const q = query.trim().toLowerCase()
    if (!q) return base
    return base.filter((r) => {
      const name = clientName(r.beneficiaryClientId).toLowerCase()
      const code = String(r.code || '').toLowerCase()
      return name.includes(q) || code.includes(q)
    })
  }, [sortedRequests, statusFilter, query, clientName])

  const summary = useMemo(() => {
    const list = payoutRequests || []
    const pending  = list.filter((r) => r.status === 'pending_review')
    const approved = list.filter((r) => r.status === 'approved')
    const paid     = list.filter((r) => r.status === 'paid')
    const rejected = list.filter((r) => r.status === 'rejected')
    const sum = (xs) => xs.reduce((s, r) => s + Number(r.grossAmount || 0), 0)
    return {
      pendingCount:  pending.length,
      pendingAmt:    sum(pending),
      approvedCount: approved.length,
      approvedAmt:   sum(approved),
      paidCount:     paid.length,
      paidAmt:       sum(paid),
      rejectedCount: rejected.length,
    }
  }, [payoutRequests])

  const handleReview = useCallback(async (requestId, decision, opts = {}) => {
    if (!adminUser?.id) {
      addToast('Session admin requise.', 'error')
      return { ok: false }
    }
    const key = `review:${requestId}:${decision}`
    if (busyKey) return { ok: false }
    const payload = { actorUserId: adminUser.id, ...opts }
    let successful = false
    await runSafeAction(
      {
        setBusy: (v) => setBusyKey(v ? key : null),
        onError: (msg) => addToast(msg, 'error'),
        label: decision === 'approved' ? 'Approuver le retrait'
          : decision === 'paid' ? 'Marquer payé'
          : decision === 'rejected' ? 'Rejeter le retrait'
          : 'Mettre à jour la demande',
      },
      async () => {
        const r = await reviewPayoutRequest(requestId, decision, payload)
        if (!r?.ok) {
          if (r?.reason === 'not_admin') throw new Error('Action réservée aux administrateurs')
          throw new Error('Action impossible sur cette demande')
        }
        successful = true
        addToast(
          decision === 'approved' ? 'Retrait approuvé.'
          : decision === 'paid'   ? 'Retrait marqué payé.'
          : 'Retrait rejeté.',
          'success',
        )
      },
    )
    return { ok: successful }
  }, [adminUser?.id, busyKey, reviewPayoutRequest, addToast])

  const handleApprove = (request) => {
    void handleReview(request.id, 'approved')
  }

  const openRejectModal = (request) => {
    setRejectModal({ request, reason: '' })
  }

  const closeRejectModal = () => setRejectModal(null)

  const confirmReject = async () => {
    if (!rejectModal?.request) return
    const reason = (rejectModal.reason || '').trim()
    if (!reason) {
      addToast('Indiquez un motif pour ce rejet.', 'error')
      return
    }
    const res = await handleReview(rejectModal.request.id, 'rejected', { reason })
    if (res.ok) closeRejectModal()
  }

  const handleMarkPaid = (request) => {
    const ref = (payRefByReq[request.id] || '').trim() || `REF-${Date.now()}`
    void handleReview(request.id, 'paid', { paymentRef: ref })
  }

  const showSkeleton = loading && !(payoutRequests || []).length
  const isEmpty = !showSkeleton && filteredRequests.length === 0

  return (
    <div className="ret-page" dir="ltr">
      <header className="ret-header">
        <div>
          <h1 className="ret-title">Retraits des gains</h1>
          <p className="ret-sub">
            Validez ou refusez les demandes de retrait des ambassadeurs. Chaque décision est journalisée et met à jour le portefeuille du bénéficiaire.
          </p>
        </div>
      </header>

      <div className="ret-kpis">
        <div className="ret-kpi ret-kpi--amber">
          <span className="ret-kpi__label">À traiter</span>
          <span className="ret-kpi__value">{summary.pendingCount}</span>
          <span className="ret-kpi__sub">{fmtTND(summary.pendingAmt)}</span>
        </div>
        <div className="ret-kpi ret-kpi--purple">
          <span className="ret-kpi__label">Approuvées (à payer)</span>
          <span className="ret-kpi__value">{summary.approvedCount}</span>
          <span className="ret-kpi__sub">{fmtTND(summary.approvedAmt)}</span>
        </div>
        <div className="ret-kpi ret-kpi--green">
          <span className="ret-kpi__label">Payées</span>
          <span className="ret-kpi__value">{summary.paidCount}</span>
          <span className="ret-kpi__sub">{fmtTND(summary.paidAmt)}</span>
        </div>
        <div className="ret-kpi ret-kpi--red">
          <span className="ret-kpi__label">Rejetées</span>
          <span className="ret-kpi__value">{summary.rejectedCount}</span>
          <span className="ret-kpi__sub">historique</span>
        </div>
      </div>

      <div className="ret-toolbar">
        <div className="ret-filter" role="tablist" aria-label="Filtrer par statut">
          {FILTERS.map(({ k, lbl }) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={statusFilter === k}
              className={`ret-chip${statusFilter === k ? ' ret-chip--on' : ''}`}
              onClick={() => setStatusFilter(k)}
            >
              {lbl}
            </button>
          ))}
        </div>
        <div className="ret-search">
          <input
            type="search"
            className="ret-input ret-input--search"
            placeholder="Chercher par nom ou code…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Chercher un retrait"
          />
        </div>
      </div>

      {showSkeleton ? (
        <div className="ret-list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="ret-card ret-card--sk">
              <span className="sp-sk sp-sk-line sp-sk-line--title" />
              <span className="sp-sk sp-sk-line" />
              <span className="sp-sk sp-sk-line sp-sk-line--short" />
            </div>
          ))}
        </div>
      ) : isEmpty ? (
        <div className="ret-empty">
          <div className="ret-empty__ico" aria-hidden>🎉</div>
          <div className="ret-empty__t">
            {statusFilter === 'pending_review' ? 'Aucun retrait en attente' : 'Aucune demande'}
          </div>
          <div className="ret-empty__s">
            {statusFilter === 'pending_review'
              ? 'Les nouvelles demandes des ambassadeurs apparaîtront ici pour validation.'
              : 'Aucune demande ne correspond à ce filtre.'}
          </div>
        </div>
      ) : (
        <ul className="ret-list">
          {filteredRequests.map((req) => {
            const meta = STATUS_META[req.status] || { label: req.status, tone: 'gray' }
            const isPending  = req.status === 'pending_review'
            const isApproved = req.status === 'approved'
            return (
              <li key={req.id} className="ret-card">
                <header className="ret-card__head">
                  <div className="ret-card__who">
                    <div className="ret-card__title">{clientName(req.beneficiaryClientId)}</div>
                    <div className="ret-card__meta">
                      <span>Code {req.code || '—'}</span>
                      <span aria-hidden>·</span>
                      <span>Demandé le {fmtDate(req.createdAt)}</span>
                      <span aria-hidden>·</span>
                      <span>
                        {(req.eventIds || []).length} ligne{(req.eventIds || []).length > 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  <div className="ret-card__amt">
                    <span className="ret-card__amt-v">{fmtTND(req.grossAmount)}</span>
                    <span className={`ret-badge ret-badge--${meta.tone}`}>{meta.label}</span>
                  </div>
                </header>

                {isPending && (
                  <div className="ret-card__actions">
                    <button
                      type="button"
                      className="ret-btn ret-btn--danger"
                      onClick={() => openRejectModal(req)}
                      disabled={busyKey === `review:${req.id}:rejected`}
                    >
                      Rejeter
                    </button>
                    <button
                      type="button"
                      className="ret-btn ret-btn--primary"
                      onClick={() => handleApprove(req)}
                      disabled={busyKey === `review:${req.id}:approved`}
                    >
                      {busyKey === `review:${req.id}:approved` ? 'Approbation…' : 'Accepter'}
                    </button>
                  </div>
                )}

                {isApproved && (
                  <div className="ret-card__form">
                    <label className="ret-card__label" htmlFor={`payref-${req.id}`}>
                      Référence paiement (virement, chèque…)
                    </label>
                    <div className="ret-card__row">
                      <input
                        id={`payref-${req.id}`}
                        className="ret-input"
                        placeholder="Ex : VIR-2026-00042"
                        value={payRefByReq[req.id] || ''}
                        onChange={(e) => setPayRefByReq((p) => ({ ...p, [req.id]: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="ret-btn ret-btn--primary"
                        onClick={() => handleMarkPaid(req)}
                        disabled={busyKey === `review:${req.id}:paid`}
                      >
                        {busyKey === `review:${req.id}:paid` ? 'Enregistrement…' : 'Marquer payé'}
                      </button>
                    </div>
                  </div>
                )}

                {req.reviewReason && (
                  <div className="ret-card__note ret-card__note--danger">
                    <strong>Motif du rejet&nbsp;:</strong> {req.reviewReason}
                  </div>
                )}
                {req.paymentRef && (
                  <div className="ret-card__note">
                    <strong>Réf.&nbsp;:</strong> <span dir="ltr">{req.paymentRef}</span>
                    {req.paidAt ? <> · payé le {fmtDate(req.paidAt)}</> : null}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {rejectModal && (
        <AdminModal open={true} onClose={closeRejectModal} title="Rejeter la demande">
          <div className="ret-modal">
            <p className="ret-modal__desc">
              Le bénéficiaire <strong>{clientName(rejectModal.request.beneficiaryClientId)}</strong> demande un retrait de{' '}
              <strong>{fmtTND(rejectModal.request.grossAmount)}</strong>. Précisez le motif de rejet — il sera visible par l'ambassadeur.
            </p>
            <label className="ret-card__label" htmlFor="reject-reason">Motif</label>
            <textarea
              id="reject-reason"
              className="ret-input ret-input--textarea"
              rows={4}
              value={rejectModal.reason}
              onChange={(e) => setRejectModal((p) => p ? { ...p, reason: e.target.value } : p)}
              placeholder="Ex : seuil non atteint, justificatifs manquants…"
              autoFocus
            />
            <div className="ret-modal__actions">
              <button type="button" className="ret-btn ret-btn--ghost" onClick={closeRejectModal}>
                Annuler
              </button>
              <button
                type="button"
                className="ret-btn ret-btn--danger"
                onClick={confirmReject}
                disabled={busyKey === `review:${rejectModal.request.id}:rejected`}
              >
                {busyKey === `review:${rejectModal.request.id}:rejected` ? 'Rejet…' : 'Confirmer le rejet'}
              </button>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
