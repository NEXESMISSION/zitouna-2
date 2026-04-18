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

// Local styles scoped via a unique wrapper class. Do not touch admin.css/zitouna-admin-page.css.
const LOCAL_STYLES = `
.cp-wrap { --cp-ink:#0f172a; --cp-muted:#64748b; --cp-line:#e2e8f0; --cp-brand:#2563eb; --cp-bg:#f8fafc; }
.cp-wrap h1 { font-size: 22px; line-height: 1.2; margin: 0; color: var(--cp-ink); }
.cp-wrap p, .cp-wrap span, .cp-wrap li, .cp-wrap div { }
.cp-hint { font-size: 13px; color: var(--cp-muted); margin: 4px 0 10px; line-height: 1.45; }
.cp-kicker { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--cp-muted); font-weight: 700; }
.cp-section-title { font-size: 18px; font-weight: 700; color: var(--cp-ink); margin: 0; line-height: 1.25; }
.cp-section-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom: 6px; }
.cp-body { font-size: 13px; color: var(--cp-ink); }
.cp-pill { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:999px; font-size:12px; font-weight:600; }
.cp-pill--ok { background:#ecfdf5; color:#047857; }
.cp-pill--warn { background:#fff7ed; color:#c2410c; }
.cp-quick { display:flex; flex-wrap:wrap; gap:8px; margin: 8px 0 14px; }
.cp-quick a { font-size:12px; color: var(--cp-brand); text-decoration: none; border:1px solid var(--cp-line); padding:5px 10px; border-radius:8px; background:#fff; cursor:pointer; }
.cp-quick a:hover { background: var(--cp-bg); }
.cp-detail-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--cp-line); font-size:13px; }
.cp-detail-row:last-child { border-bottom: none; }
.cp-detail-label { color: var(--cp-muted); font-weight:500; }
.cp-detail-value { color: var(--cp-ink); font-weight:600; text-align:right; word-break: break-word; }
.cp-divider { height:1px; background:var(--cp-line); margin: 16px 0 10px; border:none; }
.cp-empty { font-size:13px; color: var(--cp-muted); background: var(--cp-bg); border: 1px dashed var(--cp-line); border-radius: 10px; padding: 14px; text-align: center; }
.cp-empty strong { display:block; font-size:14px; color: var(--cp-ink); margin-bottom:2px; }
.cp-empty--action { margin-top:10px; display:inline-block; }
.cp-stat-label { font-size: 12px; }
.cp-stat-value { font-size: 18px; font-weight: 700; }
.cp-form-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.cp-form-row > select { flex: 1 1 220px; min-width: 0; font-size: 13px; }
.cp-inline-err { font-size: 12px; color: #b91c1c; margin-top: 6px; }
.cp-sale-amount { font-size: 15px; font-weight: 700; }
@media (max-width: 600px) {
  .cp-wrap h1 { font-size: 20px; }
  .cp-section-title { font-size: 18px; }
  .cp-detail-row { flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 0; }
  .cp-detail-value { text-align: left; }
  .cp-form-row > select, .cp-form-row > button { width: 100%; flex: 1 1 100%; }
  .cp-section-head { align-items: flex-start; }
}
`

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
      <div className="zitu-page cp-wrap" dir="ltr">
        <style>{LOCAL_STYLES}</style>
        <div className="zitu-page__column">
          <button type="button" className="ds-back-btn" onClick={() => navigate(-1)} title="Revenir à la page précédente">
            <span className="ds-back-btn__icon" aria-hidden>←</span>
            <span className="ds-back-btn__label">Retour</span>
          </button>
          <div className="cp-empty" style={{ marginTop: 12 }}>
            <strong>Client introuvable</strong>
            Ce client n’existe plus ou a été supprimé.
          </div>
          <button
            type="button"
            className="zitu-page__btn zitu-page__btn--primary"
            onClick={() => navigate('/admin/clients')}
            style={{ width: '100%', marginTop: 12 }}
          >
            Voir la liste des clients
          </button>
        </div>
      </div>
    )
  }

  const isSuspended = !!client.suspendedAt

  return (
    <div className="zitu-page cp-wrap" dir="ltr">
      <style>{LOCAL_STYLES}</style>
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)} title="Revenir à la liste des clients">
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
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
            <div className="cp-kicker">Fiche client</div>
            <h1>
              {client.name || 'Sans nom'}{' '}
              <span className={`cp-pill ${isSuspended ? 'cp-pill--warn' : 'cp-pill--ok'}`} style={{ marginLeft: 6, verticalAlign: 'middle' }}>
                {isSuspended ? 'Suspendu' : 'Actif'}
              </span>
            </h1>
            <p className="cp-hint" style={{ margin: '4px 0 0' }}>
              Consultez les informations, ventes, plans et commissions de ce client.
            </p>
          </div>
          <div className="zitu-page__header-actions">
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--primary"
              onClick={() => navigate('/admin/sell')}
              title="Démarrer une nouvelle vente pour ce client"
            >
              + Nouvelle vente
            </button>
          </div>
        </header>

        <div className="cp-quick" role="navigation" aria-label="Raccourcis dans la page">
          <a onClick={() => document.getElementById('cp-sec-info')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Coordonnées</a>
          <a onClick={() => document.getElementById('cp-sec-sales')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Ventes</a>
          <a onClick={() => document.getElementById('cp-sec-plans')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Plans</a>
          <a onClick={() => document.getElementById('cp-sec-comm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Commissions</a>
        </div>

        <div className="zitu-page__stats zitu-page__stats--3">
          <div className="zitu-page__stat" title="Nombre total de ventes enregistrées pour ce client">
            <div className="zitu-page__stat-label cp-stat-label">Ventes totales</div>
            <div className="zitu-page__stat-value cp-stat-value">{stats.totalSales}</div>
          </div>
          <div className="zitu-page__stat" title="Ventes actives ou terminées">
            <div className="zitu-page__stat-label cp-stat-label">En cours / terminées</div>
            <div className="zitu-page__stat-value zitu-page__stat-value--mint cp-stat-value">{stats.activeSales}</div>
          </div>
          <div className="zitu-page__stat" title="Somme des prix convenus des ventes">
            <div className="zitu-page__stat-label cp-stat-label">Volume total</div>
            <div className="zitu-page__stat-value cp-stat-value">{stats.totalAmount.toLocaleString('fr-FR')} DT</div>
          </div>
        </div>

        {parentClient ? (
          <div className="zitu-page__panel" style={{ marginBottom: 10 }}>
            <div className="cp-section-head">
              <h3 className="cp-section-title">Parrain de ce client</h3>
              <span className="cp-pill cp-pill--ok">Lien actif</span>
            </div>
            <p className="cp-hint">Les commissions remontent vers ce parrain sur les ventes futures de ce client.</p>
            <div className="cp-detail-row">
              <span className="cp-detail-label">Nom du parrain</span>
              <span className="cp-detail-value">{parentClient.name}</span>
            </div>
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--sm"
              style={{ marginTop: 10 }}
              onClick={() => navigate(`/admin/clients/${parentClient.id}`)}
              title="Ouvrir la fiche du parrain"
            >
              Voir la fiche du parrain →
            </button>
          </div>
        ) : null}

        {!parentRelation ? (
          <div className="zitu-page__panel" style={{ marginBottom: 10 }}>
            <h3 className="cp-section-title">Attribuer un parrain</h3>
            <p className="cp-hint">
              Un seul parrain par client. Il sera utilisé pour calculer automatiquement les commissions. Les cycles sont refusés.
            </p>
            <div className="cp-form-row">
              <select
                className="zitu-page__input"
                aria-label="Choisir un parrain"
                value={parentPick}
                onChange={(e) => setParentPick(e.target.value)}
              >
                <option value="">— Choisir un parrain dans la liste —</option>
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
                title={parentPick ? 'Enregistrer ce lien de parrainage' : 'Choisissez d’abord un parrain'}
              >
                {linking ? 'Enregistrement…' : 'Enregistrer le lien'}
              </button>
            </div>
            {parentCandidates.length === 0 ? (
              <div className="cp-inline-err">Aucun autre client disponible comme parrain.</div>
            ) : null}
          </div>
        ) : null}

        {Array.isArray(client.ownedParcelKeys) && client.ownedParcelKeys.length > 0 ? (
          <div className="zitu-page__panel" style={{ marginBottom: 10 }}>
            <h3 className="cp-section-title">Parcelles détenues</h3>
            <p className="cp-hint">Titres fonciers et parcelles liés à ce client (contrat vendeur).</p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
              {client.ownedParcelKeys.map((k) => (
                <li key={k}>{k.replace(':', ' · parcelle ')}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div id="cp-sec-info" className="zitu-page__panel">
          <h3 className="cp-section-title">Coordonnées</h3>
          <p className="cp-hint">Informations de contact du client. Pour modifier, utilisez la page d’édition client.</p>
          <div className="cp-detail-row">
            <span className="cp-detail-label">Nom complet</span>
            <span className="cp-detail-value">{client.name || '—'}</span>
          </div>
          <div className="cp-detail-row">
            <span className="cp-detail-label">E-mail</span>
            <span className="cp-detail-value">{client.email || '—'}</span>
          </div>
          <div className="cp-detail-row">
            <span className="cp-detail-label">Téléphone</span>
            <span className="cp-detail-value">{client.phone || '—'}</span>
          </div>
          <div className="cp-detail-row">
            <span className="cp-detail-label">CIN</span>
            <span className="cp-detail-value">{client.cin || '—'}</span>
          </div>
          <div className="cp-detail-row">
            <span className="cp-detail-label">Statut du compte</span>
            <span className="cp-detail-value">
              <span className={`cp-pill ${isSuspended ? 'cp-pill--warn' : 'cp-pill--ok'}`}>
                {isSuspended ? 'Suspendu' : 'Actif'}
              </span>
            </span>
          </div>
        </div>

        <div id="cp-sec-comm" className="zitu-page__section">
          <div className="cp-section-head">
            <h3 className="cp-section-title">Commissions</h3>
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--sm"
              onClick={() => navigate('/admin/commission-ledger')}
              title="Ouvrir le grand livre pour payer / auditer"
            >
              Grand livre &amp; paiements →
            </button>
          </div>
          <p className="cp-hint">Gains de parrainage de ce client. Les montants « à payer » doivent être réglés depuis le grand livre.</p>
          {clientCommissions.length > 0 ? (
            <div className="zitu-page__stats zitu-page__stats--3" style={{ marginTop: 4 }}>
              <div className="zitu-page__stat" title="Montants dus mais non encore versés">
                <div className="zitu-page__stat-label cp-stat-label">À payer</div>
                <div className="zitu-page__stat-value cp-stat-value">{stats.commPayable.toLocaleString('fr-FR')} TND</div>
              </div>
              <div className="zitu-page__stat" title="Montants déjà versés au client">
                <div className="zitu-page__stat-label cp-stat-label">Déjà payé</div>
                <div className="zitu-page__stat-value zitu-page__stat-value--mint cp-stat-value">{stats.commPaid.toLocaleString('fr-FR')} TND</div>
              </div>
              <div className="zitu-page__stat" title="Total de toutes les lignes (payées + en attente + à payer)">
                <div className="zitu-page__stat-label cp-stat-label">Total cumulé</div>
                <div className="zitu-page__stat-value cp-stat-value">{stats.commTotal.toLocaleString('fr-FR')} TND</div>
              </div>
            </div>
          ) : null}
          {clientCommissions.length === 0 ? (
            <div className="cp-empty" style={{ marginTop: 8 }}>
              <strong>Aucune commission pour l’instant</strong>
              Les commissions apparaîtront ici dès qu’une vente liée au parrainage sera enregistrée.
            </div>
          ) : (
            <div className="zitu-page__card-list" style={{ marginTop: 8 }}>
              {clientCommissions.map((e) => (
                <div key={e.id} className="zitu-page__card zitu-page__card--static">
                  <div className="zitu-page__card-top">
                    <div>
                      <div className="zitu-page__card-name">
                        {Number(e.amount || 0).toLocaleString('fr-FR')} TND
                      </div>
                      <div className="zitu-page__card-meta">Niveau {e.level} · Vente #{String(e.saleId).slice(0, 8)}</div>
                    </div>
                    <span className="cp-pill cp-pill--ok">{commissionStatusLabel(e.status)}</span>
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8, textAlign: 'right' }}>
                Total cumulé : {stats.commTotal.toLocaleString('fr-FR')} TND
              </div>
            </div>
          )}
        </div>

        <div id="cp-sec-plans" className="zitu-page__section">
          <h3 className="cp-section-title">Plans d’échéance</h3>
          <p className="cp-hint">Paiements programmés (mensualités) liés aux ventes de ce client.</p>
          {clientPlans.length === 0 ? (
            <div className="cp-empty" style={{ marginTop: 8 }}>
              <strong>Aucun plan d’échéance</strong>
              Les plans apparaissent ici après création d’une vente avec paiement échelonné.
            </div>
          ) : (
            clientPlans.map((plan) => (
              <div key={plan.id} className="zitu-page__panel" style={{ marginBottom: 8 }}>
                <div className="zitu-page__panel-title" style={{ fontSize: 14, fontWeight: 700 }}>{plan.projectTitle || plan.id}</div>
                <div className="cp-detail-row">
                  <span className="cp-detail-label">Nombre de mensualités</span>
                  <span className="cp-detail-value">{(plan.payments || []).length}</span>
                </div>
              </div>
            ))
          )}
        </div>

        <div id="cp-sec-sales" className="zitu-page__section">
          <div className="cp-section-head">
            <h3 className="cp-section-title">Historique des ventes</h3>
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--sm"
              onClick={() => navigate('/admin/sell')}
              title="Créer une nouvelle vente"
            >
              + Nouvelle vente
            </button>
          </div>
          <p className="cp-hint">Toutes les ventes associées à ce client, de la plus récente à la plus ancienne.</p>
          {stats.totalSales === 0 ? (
            <div className="cp-empty" style={{ marginTop: 8 }}>
              <strong>Aucune vente enregistrée</strong>
              Cliquez sur « Nouvelle vente » pour en créer une.
            </div>
          ) : (
            <div className="zitu-page__card-list">
              {sales.map((sale) => (
                <div key={sale.id} className="zitu-page__card zitu-page__card--static">
                  <div className="zitu-page__card-top">
                    <div>
                      <div className="zitu-page__card-name" style={{ fontSize: 14 }}>
                        {sale.projectTitle || sale.projectId || 'Projet sans titre'}
                      </div>
                      <div className="zitu-page__card-meta">Vente #{String(sale.id).slice(0, 12)}</div>
                    </div>
                    <span className="zitu-page__badge" style={{ background: '#eff6ff', color: '#2563eb' }}>
                      {sale.status || 'en attente'}
                    </span>
                  </div>
                  <div className="cp-detail-row" style={{ padding: '8px 0 0', borderBottom: 'none' }}>
                    <span className="cp-detail-label">Montant convenu</span>
                    <span className="cp-detail-value cp-sale-amount">{Number(sale.agreedPrice || 0).toLocaleString('fr-FR')} DT</span>
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
