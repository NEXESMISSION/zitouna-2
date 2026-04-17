import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useClients, useSalesScoped, useInstallments, useCommissionData, useSellerRelations } from '../../lib/useSupabase.js'
import { useToast } from '../components/AdminToast.jsx'
import './zitouna-admin-page.css'

function commissionStatusLabel(s) {
  const m = {
    payable: 'À payer',
    paid: 'Payé',
    pending: 'En attente',
    pending_review: 'En revue',
    approved: 'Approuvé',
    rejected: 'Rejeté',
    cancelled: 'Annulé',
  }
  return m[s] || s
}

export default function ClientProfilePage() {
  const navigate = useNavigate()
  const { clientId } = useParams()
  const { addToast } = useToast()
  const { clients } = useClients()
  const { sales } = useSalesScoped({ clientId })
  const { plans } = useInstallments()
  const { commissionEvents } = useCommissionData()
  const { sellerRelations, tryLink } = useSellerRelations()
  const [parentPick, setParentPick] = useState('')
  const [linking, setLinking] = useState(false)

  const client = useMemo(
    () => (clients || []).find((c) => String(c.id) === String(clientId)),
    [clients, clientId],
  )

  const parentRelation = useMemo(
    () => (sellerRelations || []).find((r) => String(r.childClientId) === String(clientId)),
    [sellerRelations, clientId],
  )
  const parentClient = useMemo(
    () => (clients || []).find((c) => String(c.id) === String(parentRelation?.parentClientId)),
    [clients, parentRelation],
  )

  const parentCandidates = useMemo(() => {
    return (clients || [])
      .filter((c) => String(c.id) !== String(clientId))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fr'))
  }, [clients, clientId])

  const submitSellerUpline = async () => {
    const pid = String(parentPick || '').trim()
    if (!pid) {
      addToast('Choisissez un parrain', 'error')
      return
    }
    setLinking(true)
    try {
      const r = await tryLink(clientId, pid, null)
      if (!r?.ok) {
        if (r?.reason === 'already_linked') addToast('Ce client a déjà un parrain enregistré', 'error')
        else if (r?.reason === 'cycle') addToast('Lien refusé : cycle dans la chaîne', 'error')
        else if (r?.reason === 'invalid') addToast('Lien invalide', 'error')
        else addToast('Impossible d’enregistrer le lien', 'error')
        return
      }
      addToast('Parrain enregistré — utilisé pour les commissions en aval')
      setParentPick('')
    } finally {
      setLinking(false)
    }
  }

  const clientPlans = useMemo(() => {
    const saleIds = new Set((sales || []).map((s) => String(s.id)))
    return (plans || []).filter((p) => saleIds.has(String(p.saleId)))
  }, [plans, sales])

  const clientCommissions = useMemo(
    () => (commissionEvents || []).filter((e) => String(e.beneficiaryClientId) === String(clientId)),
    [commissionEvents, clientId],
  )

  const stats = useMemo(() => {
    const totalSales = (sales || []).length
    const totalAmount = (sales || []).reduce((sum, s) => sum + Number(s.agreedPrice || 0), 0)
    const activeSales = (sales || []).filter((s) => s.status === 'active' || s.status === 'completed').length
    const commTotal = clientCommissions.reduce((s, e) => s + Number(e.amount || 0), 0)
    let commPayable = 0
    let commPaid = 0
    for (const e of clientCommissions) {
      const a = Number(e.amount || 0)
      if (e.paidAt || e.status === 'paid') commPaid += a
      else if (e.status === 'payable') commPayable += a
    }
    return { totalSales, totalAmount, activeSales, commTotal, commPayable, commPaid }
  }, [sales, clientCommissions])

  if (!client) {
    return (
      <div className="zitu-page" dir="ltr">
        <div className="zitu-page__column">
          <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
            <span className="ds-back-btn__icon" aria-hidden>←</span>
            <span className="ds-back-btn__label">Back</span>
          </button>
          <div className="zitu-page__empty">
            <strong>Client not found</strong>
            Le client sélectionné est introuvable.
          </div>
          <button
            type="button"
            className="zitu-page__btn zitu-page__btn--primary"
            onClick={() => navigate('/admin/clients')}
            style={{ width: '100%', marginTop: 8 }}
          >
            Go to clients list
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Back</span>
        </button>

        <header className="zitu-page__header">
          <div className="zitu-page__header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="zitu-page__header-text">
            <h1>{client.name || 'Client profile'}</h1>
            <p>CLIENT DETAILS</p>
          </div>
          <div className="zitu-page__header-actions">
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--primary"
              onClick={() => navigate('/admin/sell')}
            >
              New sale
            </button>
          </div>
        </header>

        <div className="zitu-page__stats zitu-page__stats--3">
          <div className="zitu-page__stat">
            <div className="zitu-page__stat-label">Sales</div>
            <div className="zitu-page__stat-value">{stats.totalSales}</div>
          </div>
          <div className="zitu-page__stat">
            <div className="zitu-page__stat-label">Active / done</div>
            <div className="zitu-page__stat-value zitu-page__stat-value--mint">{stats.activeSales}</div>
          </div>
          <div className="zitu-page__stat">
            <div className="zitu-page__stat-label">Volume</div>
            <div className="zitu-page__stat-value">{stats.totalAmount.toLocaleString('fr-FR')} DT</div>
          </div>
        </div>

        {parentClient ? (
          <div className="zitu-page__panel" style={{ marginBottom: 10 }}>
            <div className="zitu-page__section-title">Parrain / vendeur amont</div>
            <div className="zitu-page__detail-row">
              <span className="zitu-page__detail-label">Parent</span>
              <span className="zitu-page__detail-value">{parentClient.name}</span>
            </div>
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--sm"
              style={{ marginTop: 8 }}
              onClick={() => navigate(`/admin/clients/${parentClient.id}`)}
            >
              Fiche parent
            </button>
          </div>
        ) : null}

        {!parentRelation ? (
          <div className="zitu-page__panel" style={{ marginBottom: 10 }}>
            <div className="zitu-page__section-title">Chaîne commission — parrain</div>
            <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 8px' }}>
              Un seul parent par client. Utilisé pour calculer l’upline sur les ventes (sans cycle).
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <select
                className="zitu-page__input"
                style={{ flex: '1 1 200px', fontSize: 13 }}
                value={parentPick}
                onChange={(e) => setParentPick(e.target.value)}
              >
                <option value="">— Choisir le parrain —</option>
                {parentCandidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--primary zitu-page__btn--sm"
                disabled={linking || !parentPick}
                onClick={() => void submitSellerUpline()}
              >
                {linking ? '…' : 'Enregistrer le lien'}
              </button>
            </div>
          </div>
        ) : null}

        {Array.isArray(client.ownedParcelKeys) && client.ownedParcelKeys.length > 0 ? (
          <div className="zitu-page__panel" style={{ marginBottom: 10 }}>
            <div className="zitu-page__section-title">Parcelles (titre — Contrat vendeur)</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {client.ownedParcelKeys.map((k) => (
                <li key={k}>{k.replace(':', ' · parcelle ')}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="zitu-page__panel">
          <div className="zitu-page__detail-row">
            <span className="zitu-page__detail-label">Full name</span>
            <span className="zitu-page__detail-value">{client.name || '-'}</span>
          </div>
          <div className="zitu-page__detail-row">
            <span className="zitu-page__detail-label">Email</span>
            <span className="zitu-page__detail-value">{client.email || '-'}</span>
          </div>
          <div className="zitu-page__detail-row">
            <span className="zitu-page__detail-label">Phone</span>
            <span className="zitu-page__detail-value">{client.phone || '-'}</span>
          </div>
          <div className="zitu-page__detail-row">
            <span className="zitu-page__detail-label">CIN</span>
            <span className="zitu-page__detail-value">{client.cin || '-'}</span>
          </div>
          <div className="zitu-page__detail-row">
            <span className="zitu-page__detail-label">Statut</span>
            <span className="zitu-page__detail-value">{client.suspendedAt ? 'Suspendu' : 'Actif'}</span>
          </div>
        </div>

        <div className="zitu-page__section">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <h3 className="zitu-page__section-title" style={{ margin: 0 }}>
              Commissions
            </h3>
            <button type="button" className="zitu-page__btn zitu-page__btn--sm" onClick={() => navigate('/admin/commission-ledger')}>
              Grand livre &amp; paiements
            </button>
          </div>
          {clientCommissions.length > 0 ? (
            <div className="zitu-page__stats zitu-page__stats--3" style={{ marginTop: 8 }}>
              <div className="zitu-page__stat">
                <div className="zitu-page__stat-label">À payer</div>
                <div className="zitu-page__stat-value">{stats.commPayable.toLocaleString('fr-FR')} TND</div>
              </div>
              <div className="zitu-page__stat">
                <div className="zitu-page__stat-label">Payé</div>
                <div className="zitu-page__stat-value zitu-page__stat-value--mint">{stats.commPaid.toLocaleString('fr-FR')} TND</div>
              </div>
              <div className="zitu-page__stat">
                <div className="zitu-page__stat-label">Total lignes</div>
                <div className="zitu-page__stat-value">{stats.commTotal.toLocaleString('fr-FR')} TND</div>
              </div>
            </div>
          ) : null}
          {clientCommissions.length === 0 ? (
            <div className="zitu-page__empty" style={{ marginTop: 8 }}>
              <strong>Aucune commission</strong>
            </div>
          ) : (
            <div className="zitu-page__card-list">
              {clientCommissions.map((e) => (
                <div key={e.id} className="zitu-page__card zitu-page__card--static">
                  <div className="zitu-page__card-name">
                    {Number(e.amount || 0).toLocaleString('fr-FR')} TND · niveau {e.level}
                  </div>
                  <div className="zitu-page__card-meta">
                    Vente {e.saleId} · {commissionStatusLabel(e.status)}
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 11, fontWeight: 700, marginTop: 6 }}>Total: {stats.commTotal.toLocaleString('fr-FR')} TND</div>
            </div>
          )}
        </div>

        <div className="zitu-page__section">
          <h3 className="zitu-page__section-title">Plans & échéances</h3>
          {clientPlans.length === 0 ? (
            <div className="zitu-page__empty" style={{ marginTop: 8 }}>
              <strong>Aucun plan</strong>
            </div>
          ) : (
            clientPlans.map((plan) => (
              <div key={plan.id} className="zitu-page__panel" style={{ marginBottom: 8 }}>
                <div className="zitu-page__panel-title">{plan.projectTitle || plan.id}</div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Mensualités</span>
                  <span className="zitu-page__detail-value">{(plan.payments || []).length}</span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="zitu-page__section">
          <h3 className="zitu-page__section-title">Sales history</h3>
          {stats.totalSales === 0 ? (
            <div className="zitu-page__empty" style={{ marginTop: 8 }}>
              <strong>No sales yet</strong>
            </div>
          ) : (
            <div className="zitu-page__card-list">
              {sales.map((sale) => (
                <div key={sale.id} className="zitu-page__card zitu-page__card--static">
                  <div className="zitu-page__card-top">
                    <div>
                      <div className="zitu-page__card-name">{sale.projectTitle || sale.projectId || 'Project'}</div>
                      <div className="zitu-page__card-meta">Sale #{String(sale.id).slice(0, 12)}</div>
                    </div>
                    <span className="zitu-page__badge" style={{ background: '#eff6ff', color: '#2563eb' }}>
                      {sale.status || 'pending'}
                    </span>
                  </div>
                  <div className="zitu-page__detail-row" style={{ padding: 0, borderBottom: 'none' }}>
                    <span className="zitu-page__detail-label">Amount</span>
                    <span className="zitu-page__detail-value">{Number(sale.agreedPrice || 0).toLocaleString('fr-FR')} DT</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
