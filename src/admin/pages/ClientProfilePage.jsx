import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useClients, useSalesScoped, useInstallments, useCommissionData, useSellerRelations } from '../../lib/useSupabase.js'
import { useToast } from '../components/AdminToast.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { computeInstallmentSaleMetrics, formatMoneyTnd } from '../../domain/installmentMetrics.js'
import './zitouna-admin-page.css'
import './admin-patterns.css'
import './client-profile.css'

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

function commissionStatusLabel(s) {
  const m = {
    payable: 'À payer', paid: 'Payé', pending: 'En attente',
    pending_review: 'En revue', approved: 'Approuvé',
    rejected: 'Rejeté', cancelled: 'Annulé',
  }
  return m[s] || s
}

export default function ClientProfilePage() {
  const navigate = useNavigate()
  const { clientId } = useParams()
  const { addToast } = useToast()

  const { clients, loading: clientsLoading, refresh: refreshClients } = useClients()
  const { sales } = useSalesScoped({ clientId })
  const { plans } = useInstallments()
  const { commissionEvents } = useCommissionData()
  const { sellerRelations, tryLink } = useSellerRelations()

  const [parentPick, setParentPick] = useState('')
  const [linking, setLinking] = useState(false)
  const [showRefForm, setShowRefForm] = useState(false)
  const [showCommList, setShowCommList] = useState(false)
  const [showDetails, setShowDetails] = useState(false)

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
    if (!pid) { addToast('Choisissez un parrain', 'error'); return }
    setLinking(true)
    try {
      const r = await tryLink(clientId, pid, null)
      if (!r?.ok) {
        if (r?.reason === 'already_linked') addToast('Ce client a déjà un parrain enregistré', 'error')
        else if (r?.reason === 'cycle') addToast('Lien refusé : cycle dans la chaîne', 'error')
        else if (r?.reason === 'invalid') addToast('Lien invalide', 'error')
        else addToast('Impossible d\u2019enregistrer le lien', 'error')
        return
      }
      addToast('Parrain enregistré')
      setParentPick('')
      setShowRefForm(false)
    } finally {
      setLinking(false)
    }
  }

  const plansBySaleId = useMemo(() => {
    const m = new Map()
    for (const p of plans || []) m.set(String(p.saleId), p)
    return m
  }, [plans])

  const salesWithMetrics = useMemo(() => {
    return (sales || []).map((sale) => {
      const plan = plansBySaleId.get(String(sale.id))
      const metrics = plan ? computeInstallmentSaleMetrics(sale, plan) : null
      return { sale, plan, metrics }
    })
  }, [sales, plansBySaleId])

  const clientCommissions = useMemo(
    () => (commissionEvents || []).filter((e) => String(e.beneficiaryClientId) === String(clientId)),
    [commissionEvents, clientId],
  )

  const stats = useMemo(() => {
    const totalSales = (sales || []).length
    const totalAmount = (sales || []).reduce((sum, s) => sum + Number(s.agreedPrice || 0), 0)
    const activeSales = (sales || []).filter((s) => s.status === 'active' || s.status === 'completed').length

    let paid = 0, remaining = 0
    for (const { metrics, sale } of salesWithMetrics) {
      if (metrics) { paid += metrics.cashValidatedStrict; remaining += metrics.remainingStrict }
      else remaining += Number(sale.agreedPrice || 0)
    }

    let commPayable = 0, commPaid = 0, commTotal = 0
    for (const e of clientCommissions) {
      const a = Number(e.amount || 0)
      commTotal += a
      if (e.paidAt || e.status === 'paid') commPaid += a
      else if (e.status === 'payable') commPayable += a
    }

    return { totalSales, totalAmount, activeSales, paid, remaining, commTotal, commPayable, commPaid }
  }, [sales, salesWithMetrics, clientCommissions])

  const client = (clients || []).find((c) => String(c.id) === String(clientId))
  const clientsStatus = {
    state: clientsLoading && !(clients && clients.length > 0) ? 'loading' : 'ready',
    data: clients || [],
  }

  const isSuspended = Boolean(client?.suspendedAt)

  const progressColor = (pct) => {
    if (pct >= 80) return 'cp2-bar__fill'
    if (pct >= 40) return 'cp2-bar__fill cp2-bar__fill--warn'
    if (pct > 0) return 'cp2-bar__fill cp2-bar__fill--danger'
    return 'cp2-bar__fill cp2-bar__fill--neutral'
  }

  return (
    <div className="zitu-page cp2" dir="ltr">
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)} title="Revenir à la liste">
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        <RenderDataGate
          status={clientsStatus}
          skeleton="detail"
          onRetry={refreshClients}
          isEmpty={() => !client}
          empty={
            <EmptyState
              icon="🔎"
              title="Client introuvable"
              description="Ce client n'existe plus ou a été supprimé."
              action={{ label: 'Voir la liste des clients', onClick: () => navigate('/admin/clients') }}
            />
          }
        >
          {() => (
            <>
              {/* Hero */}
              <div className="cp2-hero">
                <div className="cp2-hero__avatar">{initials(client.name)}</div>
                <div className="cp2-hero__info">
                  <h1 className="cp2-hero__name">{client.name || 'Sans nom'}</h1>
                  <div className="cp2-hero__sub">
                    <span className={`adm-pill ${isSuspended ? 'adm-pill--danger' : 'adm-pill--ok'}`}>
                      {isSuspended ? 'Suspendu' : 'Actif'}
                    </span>
                    {client.phone ? <a href={`tel:${client.phone}`}>📞 {client.phone}</a> : null}
                    {client.email ? <a href={`mailto:${client.email}`}>✉️ {client.email}</a> : null}
                  </div>
                </div>
              </div>

              {/* Quick actions */}
              <div className="cp2-actions">
                <button
                  type="button"
                  className="cp2-actions__primary"
                  onClick={() => navigate('/admin/sell')}
                  title="Démarrer une nouvelle vente"
                >
                  + Nouvelle vente
                </button>
                {client.phone ? (
                  <a href={`tel:${client.phone}`} title="Appeler">📞 Appeler</a>
                ) : null}
                {client.phone ? (
                  <a href={`sms:${client.phone}`} title="Envoyer un SMS">💬 SMS</a>
                ) : null}
                {client.email ? (
                  <a href={`mailto:${client.email}`} title="Envoyer un e-mail">✉️ Email</a>
                ) : null}
              </div>

              {/* Money snapshot */}
              <div className="cp2-money">
                <div className="cp2-money__tile">
                  <div className="cp2-money__tile-label">Volume vendu</div>
                  <div className="cp2-money__tile-val">{formatMoneyTnd(stats.totalAmount)}</div>
                  <div className="cp2-money__tile-sub">{stats.totalSales} vente{stats.totalSales > 1 ? 's' : ''}</div>
                </div>
                <div className="cp2-money__tile">
                  <div className="cp2-money__tile-label">Encaissé</div>
                  <div className="cp2-money__tile-val cp2-money__tile-val--ok">{formatMoneyTnd(stats.paid)}</div>
                  <div className="cp2-money__tile-sub">
                    {stats.totalAmount > 0 ? `${Math.round((stats.paid / stats.totalAmount) * 100)} % payé` : '—'}
                  </div>
                </div>
                <div className="cp2-money__tile">
                  <div className="cp2-money__tile-label">Reste à payer</div>
                  <div className="cp2-money__tile-val cp2-money__tile-val--warn">{formatMoneyTnd(stats.remaining)}</div>
                  <div className="cp2-money__tile-sub">Capital restant dû</div>
                </div>
                <div className="cp2-money__tile">
                  <div className="cp2-money__tile-label">Ventes actives</div>
                  <div className="cp2-money__tile-val">{stats.activeSales}</div>
                  <div className="cp2-money__tile-sub">en cours / terminées</div>
                </div>
              </div>

              {/* Sales list with progress */}
              <div className="cp2-sec">
                <div className="cp2-sec__head">
                  <h3 className="cp2-sec__title">Ventes</h3>
                  <span className="cp2-sec__count">{stats.totalSales} au total</span>
                </div>
                {stats.totalSales === 0 ? (
                  <div className="adm-empty">
                    <strong>Aucune vente enregistrée</strong>
                    Cliquez sur « Nouvelle vente » ci-dessus pour en créer une.
                  </div>
                ) : (
                  salesWithMetrics.map(({ sale, plan, metrics }) => {
                    const agreed = metrics ? metrics.saleAgreed : Number(sale.agreedPrice || 0)
                    const pct = metrics && agreed > 0
                      ? Math.round((metrics.cashValidatedStrict / agreed) * 100)
                      : 0
                    const paid = metrics ? metrics.cashValidatedStrict : 0
                    const rem = metrics ? metrics.remainingStrict : agreed
                    const target = plan?.id ? `/admin/recouvrement` : (sale.projectId ? `/admin/projects/${sale.projectId}` : '/admin/recouvrement')
                    return (
                      <div
                        key={sale.id}
                        className="cp2-sale"
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(target)}
                        onKeyDown={(e) => { if (e.key === 'Enter') navigate(target) }}
                        title="Ouvrir le suivi / recouvrement"
                      >
                        <div className="cp2-sale__top">
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="cp2-sale__title">{sale.projectTitle || sale.projectId || 'Projet sans titre'}</div>
                            <div className="cp2-sale__meta">#{String(sale.id).slice(0, 8)} · {sale.status || 'en attente'}</div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div className="cp2-sale__amt">{formatMoneyTnd(agreed)}</div>
                            <div className="cp2-sale__amt-sub">prix convenu</div>
                          </div>
                        </div>
                        {metrics ? (
                          <>
                            <div className="cp2-bar" title={`${pct} % encaissé`}>
                              <div className={progressColor(pct)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                            </div>
                            <div className="cp2-sale__stats">
                              <div className="cp2-sale__stat">
                                <span className="cp2-sale__stat-lbl">Encaissé</span>
                                <span className="cp2-sale__stat-val cp2-sale__stat-val--ok">{formatMoneyTnd(paid)}</span>
                              </div>
                              <div className="cp2-sale__stat">
                                <span className="cp2-sale__stat-lbl">Restant</span>
                                <span className="cp2-sale__stat-val cp2-sale__stat-val--warn">{formatMoneyTnd(rem)}</span>
                              </div>
                              <div className="cp2-sale__stat" style={{ textAlign: 'right' }}>
                                <span className="cp2-sale__stat-lbl">Mensualités</span>
                                <span className="cp2-sale__stat-val">{metrics.approvedCount}/{metrics.totalMonths || '—'}</span>
                              </div>
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 4 }}>
                            Pas de plan d'échéance — vente au comptant ou plan non créé.
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>

              {/* Parrainage */}
              <div className="cp2-sec">
                <div className="cp2-sec__head">
                  <h3 className="cp2-sec__title">Parrainage</h3>
                </div>
                {parentClient ? (
                  <div className="adm-callout">
                    <div className="adm-callout__main">
                      <div className="adm-callout__lead">Parrain : {parentClient.name}</div>
                      <div className="adm-callout__hint">Les commissions remontent vers lui sur les ventes futures.</div>
                    </div>
                    <button
                      type="button"
                      className="cp2-sec__link"
                      onClick={() => navigate(`/admin/clients/${parentClient.id}`)}
                    >
                      Fiche →
                    </button>
                  </div>
                ) : (
                  <>
                    {!showRefForm ? (
                      <div className="adm-callout">
                        <div className="adm-callout__main">
                          <div className="adm-callout__lead">Aucun parrain</div>
                          <div className="adm-callout__hint">Ajoutez-en un pour attribuer automatiquement les commissions.</div>
                        </div>
                        <button
                          type="button"
                          className="cp2-sec__link"
                          onClick={() => setShowRefForm(true)}
                        >
                          + Ajouter
                        </button>
                      </div>
                    ) : (
                      <div className="cp2-ref-form">
                        <div className="adm-callout__hint" style={{ margin: 0 }}>
                          Un seul parrain par client. Les cycles sont refusés.
                        </div>
                        <div className="cp2-ref-form__row">
                          <select
                            aria-label="Choisir un parrain"
                            value={parentPick}
                            onChange={(e) => setParentPick(e.target.value)}
                          >
                            <option value="">— Choisir un parrain —</option>
                            {parentCandidates.map((c) => (
                              <option key={c.id} value={c.id}>{c.name || c.id}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={linking || !parentPick}
                            onClick={() => void submitSellerUpline()}
                          >
                            {linking ? '…' : 'Enregistrer'}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setShowRefForm(false); setParentPick('') }}
                            style={{ background: 'transparent', color: 'var(--muted)', borderColor: 'var(--line)' }}
                          >
                            Annuler
                          </button>
                        </div>
                        {parentCandidates.length === 0 ? (
                          <div className="cp2-ref-form__err">Aucun autre client disponible.</div>
                        ) : null}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Commissions (collapsible) */}
              <div className="cp2-sec">
                <div className="cp2-sec__head">
                  <h3 className="cp2-sec__title">Commissions reçues</h3>
                  <button
                    type="button"
                    className="cp2-sec__link"
                    onClick={() => navigate('/admin/commission-ledger')}
                  >
                    Grand livre →
                  </button>
                </div>
                {clientCommissions.length === 0 ? (
                  <div className="adm-empty">
                    <strong>Aucune commission pour l'instant</strong>
                    Elles apparaîtront automatiquement dès qu'une vente liée au parrainage sera enregistrée.
                  </div>
                ) : (
                  <div className="cp2-comm">
                    <div className="cp2-comm__row">
                      <div className="cp2-comm__cell">
                        <div className="cp2-comm__cell-lbl">À payer</div>
                        <div className="cp2-comm__cell-val cp2-comm__cell-val--warn">{formatMoneyTnd(stats.commPayable)}</div>
                      </div>
                      <div className="cp2-comm__cell">
                        <div className="cp2-comm__cell-lbl">Déjà payé</div>
                        <div className="cp2-comm__cell-val cp2-comm__cell-val--ok">{formatMoneyTnd(stats.commPaid)}</div>
                      </div>
                      <div className="cp2-comm__cell">
                        <div className="cp2-comm__cell-lbl">Total</div>
                        <div className="cp2-comm__cell-val">{formatMoneyTnd(stats.commTotal)}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="cp2-toggle"
                      onClick={() => setShowCommList((v) => !v)}
                    >
                      {showCommList ? '▾ Masquer' : '▸ Voir'} les {clientCommissions.length} ligne{clientCommissions.length > 1 ? 's' : ''}
                    </button>
                    {showCommList ? (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {clientCommissions.map((e) => (
                          <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: 'var(--bg)', borderRadius: 8, fontSize: 11 }}>
                            <div>
                              <strong style={{ fontSize: 12 }}>{formatMoneyTnd(e.amount)}</strong>
                              <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 1 }}>Niveau {e.level} · Vente #{String(e.saleId).slice(0, 8)}</div>
                            </div>
                            <span className={`adm-pill ${e.status === 'paid' ? 'adm-pill--ok' : e.status === 'payable' ? 'adm-pill--warn' : 'adm-pill--neutral'}`}>
                              {commissionStatusLabel(e.status)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              {/* Identité & contact (collapsible) */}
              <div className="cp2-sec">
                <div className="cp2-sec__head">
                  <h3 className="cp2-sec__title">Identité & contact</h3>
                  <button
                    type="button"
                    className="cp2-sec__link"
                    onClick={() => setShowDetails((v) => !v)}
                  >
                    {showDetails ? '▾ Masquer' : '▸ Voir'}
                  </button>
                </div>
                {showDetails ? (
                  <div className="cp2-details">
                    <div className="cp2-details__row">
                      <span className="cp2-details__label">Nom complet</span>
                      <span className="cp2-details__value">{client.name || '—'}</span>
                    </div>
                    <div className="cp2-details__row">
                      <span className="cp2-details__label">Téléphone</span>
                      <span className="cp2-details__value">
                        {client.phone ? <a href={`tel:${client.phone}`}>{client.phone}</a> : '—'}
                      </span>
                    </div>
                    <div className="cp2-details__row">
                      <span className="cp2-details__label">E-mail</span>
                      <span className="cp2-details__value">
                        {client.email ? <a href={`mailto:${client.email}`}>{client.email}</a> : '—'}
                      </span>
                    </div>
                    <div className="cp2-details__row">
                      <span className="cp2-details__label">CIN</span>
                      <span className="cp2-details__value">{client.cin || '—'}</span>
                    </div>
                    <div className="cp2-details__row">
                      <span className="cp2-details__label">Statut du compte</span>
                      <span className="cp2-details__value">
                        <span className={`adm-pill ${isSuspended ? 'adm-pill--danger' : 'adm-pill--ok'}`}>
                          {isSuspended ? 'Suspendu' : 'Actif'}
                        </span>
                      </span>
                    </div>
                    {Array.isArray(client.ownedParcelKeys) && client.ownedParcelKeys.length > 0 ? (
                      <div className="cp2-details__row">
                        <span className="cp2-details__label">Parcelles détenues</span>
                        <span className="cp2-details__value" style={{ fontSize: 11 }}>
                          {client.ownedParcelKeys.map((k) => k.replace(':', ' · ')).join(', ')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </RenderDataGate>
      </div>
    </div>
  )
}
