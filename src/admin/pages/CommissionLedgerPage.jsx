import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useClients, useCommissionLedger } from '../../lib/useSupabase.js'
import { useToast } from '../components/AdminToast.jsx'
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
  }
  return m[s] || s
}

export default function CommissionLedgerPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { addToast } = useToast()
  const { clients } = useClients()
  const { commissionEvents, payoutRequests, submitPayoutRequest, reviewPayoutRequest } = useCommissionLedger()
  const [payRefByReq, setPayRefByReq] = useState({})
  const [rejectReasonByReq, setRejectReasonByReq] = useState({})

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
      // Date.now() runs inside an async event handler triggered by a user
      // click, never during render, so the purity rule does not apply here.
      // eslint-disable-next-line react-hooks/purity
      opts.paymentRef = payRefByReq[reqId] || `REF-${Date.now()}`
    }
    const r = await reviewPayoutRequest(reqId, decision, opts)
    if (!r.ok) {
      addToast('Action impossible sur cette demande', 'error')
      return
    }
    addToast(decision === 'paid' ? 'Paiement enregistré' : 'Demande mise à jour')
  }

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Back</span>
        </button>
        <header className="zitu-page__header">
          <div className="zitu-page__header-icon" aria-hidden>$</div>
          <div className="zitu-page__header-text">
            <h1>Reglement des commissions</h1>
            <p>
              Evenements, aggregation, validation et cloture de paiement
            </p>
          </div>
        </header>

        <div className="zitu-page__section" style={{ marginTop: 8 }}>
          <div className="zitu-page__section-title">Agrégation par bénéficiaire</div>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 10px' }}>
            Seuil minimum issu des réglages projet. Les lignes déjà dans une demande ouverte sont exclues.
          </p>
          {payableByBeneficiary.length === 0 ? (
            <div className="zitu-page__empty">
              <strong>Aucune ligne payable groupable</strong>
              Complétez une vente au notaire pour générer des commissions.
            </div>
          ) : (
            <div className="zitu-page__card-list">
              {payableByBeneficiary.map((row) => (
                <div key={row.beneficiaryClientId} className="zitu-page__card zitu-page__card--static">
                  <div className="zitu-page__card-top">
                    <div>
                      <div className="zitu-page__card-name">{clientName(row.beneficiaryClientId)}</div>
                      <div className="zitu-page__card-meta">
                        {row.count} ligne(s) · {fmtMoney(row.gross)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="zitu-page__btn zitu-page__btn--primary zitu-page__btn--sm"
                      onClick={() => handleSubmit(row.beneficiaryClientId)}
                    >
                      Créer demande
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="zitu-page__section">
          <div className="zitu-page__section-title">Demandes de paiement</div>
          {sortedRequests.length === 0 ? (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>Aucune demande enregistrée.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sortedRequests.map((req) => (
                <div
                  key={req.id}
                  className="zitu-page__card zitu-page__card--static"
                  style={{ border: '1px solid #e2e8f0' }}
                >
                  <div className="zitu-page__card-top">
                    <div>
                      <div className="zitu-page__card-name">{clientName(req.beneficiaryClientId)}</div>
                      <div className="zitu-page__card-meta">
                        {fmtMoney(req.grossAmount)} · {(req.eventIds || []).length} événement(s) ·{' '}
                        <span style={{ fontWeight: 700 }}>{statusLabel(req.status)}</span>
                      </div>
                      <div style={{ fontSize: 10, color: '#94a3b8' }}>{req.createdAt}</div>
                    </div>
                  </div>
                  {req.status === 'pending_review' ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
                      <input
                        className="zitu-page__input"
                        style={{ flex: '1 1 160px', fontSize: 11 }}
                        placeholder="Motif rejet (si rejet)"
                        value={rejectReasonByReq[req.id] || ''}
                        onChange={(e) => setRejectReasonByReq((m) => ({ ...m, [req.id]: e.target.value }))}
                      />
                      <button type="button" className="zitu-page__btn zitu-page__btn--primary zitu-page__btn--sm" onClick={() => handleReview(req.id, 'approved')}>
                        Approuver
                      </button>
                      <button type="button" className="zitu-page__btn zitu-page__btn--sm" style={{ color: '#b91c1c' }} onClick={() => handleReview(req.id, 'rejected')}>
                        Rejeter
                      </button>
                    </div>
                  ) : null}
                  {req.status === 'approved' ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
                      <input
                        className="zitu-page__input"
                        style={{ flex: '1 1 140px', fontSize: 11 }}
                        placeholder="Réf. paiement"
                        value={payRefByReq[req.id] || ''}
                        onChange={(e) => setPayRefByReq((m) => ({ ...m, [req.id]: e.target.value }))}
                      />
                      <button type="button" className="zitu-page__btn zitu-page__btn--primary zitu-page__btn--sm" onClick={() => handleReview(req.id, 'paid')}>
                        Marquer payé
                      </button>
                    </div>
                  ) : null}
                  {req.status === 'paid' ? (
                    <div style={{ fontSize: 11, color: '#059669', marginTop: 6 }}>
                      Payé {req.paidAt || ''} {req.paymentRef ? `· ${req.paymentRef}` : ''}
                    </div>
                  ) : null}
                  {req.status === 'rejected' && req.reviewReason ? (
                    <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 6 }}>{req.reviewReason}</div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="zitu-page__section">
          <div className="zitu-page__section-title">Tous les événements commission</div>
          {(commissionEvents || []).length === 0 ? (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>Aucun événement.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="zitu-page__table" style={{ width: '100%', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th>Vente</th>
                    <th>Bénéficiaire</th>
                    <th>Niveau</th>
                    <th>Montant</th>
                    <th>Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(commissionEvents || [])]
                    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
                    .map((e) => (
                      <tr key={e.id}>
                        <td>{e.saleId}</td>
                        <td>{clientName(e.beneficiaryClientId)}</td>
                        <td>{e.level}</td>
                        <td>{fmtMoney(e.amount)}</td>
                        <td>{statusLabel(e.status)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
