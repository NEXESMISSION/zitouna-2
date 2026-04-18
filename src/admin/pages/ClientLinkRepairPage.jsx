import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../components/AdminToast.jsx'
import { useClients, useSales } from '../../lib/useSupabase.js'
import { relinkAuthToClientWithTicket, reassignSaleClientWithTicket } from '../../lib/db.js'
import './zitouna-admin-page.css'

function parsePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return { countryCode: '+216', phoneLocal: '' }
  if (String(raw || '').trim().startsWith('+') && digits.length > 8) {
    return { countryCode: `+${digits.slice(0, digits.length - 8)}`, phoneLocal: digits.slice(-8) }
  }
  if (digits.length > 8) return { countryCode: `+${digits.slice(0, digits.length - 8)}`, phoneLocal: digits.slice(-8) }
  return { countryCode: '+216', phoneLocal: digits }
}

// Small inline info tooltip component (CSS-only)
function InfoTip({ text }) {
  return (
    <span className="clr-tip" tabIndex={0} aria-label={text}>
      <span className="clr-tip__icon" aria-hidden>?</span>
      <span className="clr-tip__bubble" role="tooltip">{text}</span>
    </span>
  )
}

export default function ClientLinkRepairPage() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const { clients } = useClients()
  const { sales } = useSales()

  const [clientId, setClientId] = useState('')
  const [authUserId, setAuthUserId] = useState('')
  const [ticket, setTicket] = useState('')
  const [reason, setReason] = useState('')

  const [saleId, setSaleId] = useState('')
  const [targetClientId, setTargetClientId] = useState('')
  const [saleTicket, setSaleTicket] = useState('')
  const [saleReason, setSaleReason] = useState('')

  const [busy, setBusy] = useState(false)

  const clientOptions = useMemo(
    () => (clients || []).map((c) => ({ id: String(c.id), label: `${c.name || 'Client'} • ${c.phone || '—'}` })),
    [clients],
  )
  const saleOptions = useMemo(
    () =>
      (sales || []).slice(0, 500).map((s) => ({
        id: String(s.id),
        label: `${s.code || s.id} • ${s.clientName || 'Client'} • ${s.projectTitle || 'Projet'}`,
      })),
    [sales],
  )

  const selectedClient = useMemo(
    () => (clients || []).find((c) => String(c.id) === String(clientId)) || null,
    [clients, clientId],
  )
  const selectedSale = useMemo(
    () => (sales || []).find((s) => String(s.id) === String(saleId)) || null,
    [sales, saleId],
  )
  const selectedTargetClient = useMemo(
    () => (clients || []).find((c) => String(c.id) === String(targetClientId)) || null,
    [clients, targetClientId],
  )

  const relinkHelp = useMemo(() => {
    if (!selectedClient) return 'Choisissez un client, puis collez le UUID auth.'
    return `Client sélectionné : ${selectedClient.name || 'Client'}`
  }, [selectedClient])

  // UUID v4 heuristic validator for user feedback only
  const isLikelyUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '').trim())
  const relinkReady = Boolean(clientId && authUserId.trim())
  const saleReady = Boolean(saleId && targetClientId && String(saleId) !== '' && String(targetClientId) !== '')
  const saleSameClientWarning = selectedSale && selectedTargetClient && String(selectedSale.clientId || '') === String(selectedTargetClient.id || '')

  async function handleQuickRelink() {
    if (!clientId || !authUserId.trim()) {
      addToast('Client et Auth User ID sont requis.', 'error')
      return
    }
    // Confirm before performing a destructive/irreversible relink
    const confirmMsg = `Confirmer : relier le compte auth\n${authUserId.trim()}\nau client « ${selectedClient?.name || ''} » (${selectedClient?.phone || '—'}) ?\n\nCette action est tracée (ticket/raison) et peut modifier l'accès de l'utilisateur.`
    if (!window.confirm(confirmMsg)) return
    const p = parsePhone(selectedClient?.phone || '')
    setBusy(true)
    try {
      const res = await relinkAuthToClientWithTicket({
        clientId,
        authUserId: authUserId.trim(),
        countryCode: p.countryCode,
        phoneLocal: p.phoneLocal,
        ticket: ticket.trim(),
        reason: reason.trim(),
      })
      if (!res?.ok) throw new Error(res?.reason || 'relink_failed')
      addToast('Compte relié au client avec succès.')
      setTicket('')
      setReason('')
    } catch (e) {
      addToast(`Erreur: ${e.message || e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function handleSaleReassign() {
    if (!saleId || !targetClientId) {
      addToast('Vente et client cible sont requis.', 'error')
      return
    }
    // Confirm before changing sale ownership
    const confirmMsg = `Confirmer : réaffecter la vente « ${selectedSale?.code || selectedSale?.id || ''} » au client « ${selectedTargetClient?.name || ''} » ?\n\nLe client actuel sera remplacé. Action tracée.`
    if (!window.confirm(confirmMsg)) return
    setBusy(true)
    try {
      const res = await reassignSaleClientWithTicket({
        saleId,
        targetClientId,
        ticket: saleTicket.trim(),
        reason: saleReason.trim(),
      })
      if (!res?.ok) throw new Error(res?.reason || 'sale_reassign_failed')
      addToast('Vente réaffectée au bon client.')
      setSaleTicket('')
      setSaleReason('')
    } catch (e) {
      addToast(`Erreur: ${e.message || e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const noClients = !clients || clients.length === 0
  const noSales = !sales || sales.length === 0

  return (
    <div className="zitu-page" dir="ltr">
      {/* Local redesign styles — scoped to this page via .clr-* classes */}
      <style>{`
        .clr-wrap { max-width: 860px; margin: 0 auto; padding: 0 4px; }
        .clr-hero { display: flex; gap: 14px; align-items: flex-start; padding: 18px 18px 16px; border-radius: 14px; background: linear-gradient(135deg, #eef4ff 0%, #f7fafc 100%); border: 1px solid #dbe4f3; margin-bottom: 18px; }
        .clr-hero__icon { font-size: 28px; line-height: 1; }
        .clr-hero h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.01em; }
        .clr-hero p { margin: 0; font-size: 13.5px; color: #475569; line-height: 1.5; }
        .clr-steps { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
        .clr-step-chip { font-size: 12px; background: #ffffff; border: 1px solid #dbe4f3; color: #334155; padding: 4px 10px; border-radius: 999px; }

        .clr-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 18px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(15,23,42,0.03); }
        .clr-card__head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
        .clr-card__badge { width: 28px; height: 28px; border-radius: 8px; background: #2563eb; color: #fff; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
        .clr-card__badge--alt { background: #0d9488; }
        .clr-card__title { font-size: 18px; font-weight: 700; color: #0f172a; margin: 0; }
        .clr-card__lead { font-size: 13.5px; color: #475569; margin: 2px 0 14px; line-height: 1.5; }
        .clr-callout { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: #1e3a8a; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; line-height: 1.45; }
        .clr-callout--warn { color: #92400e; background: #fffbeb; border-color: #fde68a; }
        .clr-callout__dot { font-size: 14px; line-height: 1; margin-top: 1px; }

        .clr-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @media (max-width: 600px) { .clr-row { grid-template-columns: 1fr; } .clr-hero { padding: 14px; } .clr-card { padding: 14px; } }

        .clr-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
        .clr-field__label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: #1f2937; }
        .clr-field__hint { font-size: 12px; color: #64748b; margin-top: -2px; }
        .clr-input, .clr-select, .clr-textarea { width: 100%; box-sizing: border-box; font-size: 14px; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 10px; background: #fff; color: #0f172a; transition: border-color 0.15s, box-shadow 0.15s; }
        .clr-input:focus, .clr-select:focus, .clr-textarea:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
        .clr-input--bad { border-color: #ef4444; }
        .clr-textarea { min-height: 72px; resize: vertical; font-family: inherit; }
        .clr-req { color: #ef4444; font-weight: 700; }
        .clr-opt { color: #94a3b8; font-weight: 500; font-size: 12px; }

        .clr-tip { position: relative; display: inline-flex; outline: none; }
        .clr-tip__icon { width: 16px; height: 16px; border-radius: 50%; background: #e2e8f0; color: #475569; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; cursor: help; }
        .clr-tip:hover .clr-tip__bubble, .clr-tip:focus .clr-tip__bubble { opacity: 1; transform: translateY(0); pointer-events: auto; }
        .clr-tip__bubble { position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translate(-50%, 4px); opacity: 0; pointer-events: none; background: #0f172a; color: #fff; font-size: 12px; line-height: 1.4; padding: 8px 10px; border-radius: 8px; min-width: 220px; max-width: 280px; white-space: normal; z-index: 10; box-shadow: 0 6px 20px rgba(15,23,42,0.2); transition: opacity 0.15s, transform 0.15s; }

        .clr-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
        .clr-btn { font-size: 14px; font-weight: 600; padding: 12px 18px; border-radius: 10px; border: 1px solid transparent; cursor: pointer; transition: background 0.15s, transform 0.05s; }
        .clr-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .clr-btn--primary { background: #2563eb; color: #fff; box-shadow: 0 1px 2px rgba(37,99,235,0.3); font-size: 15px; padding: 13px 22px; }
        .clr-btn--primary:hover:not(:disabled) { background: #1d4ed8; }
        .clr-btn--primary:active { transform: translateY(1px); }
        .clr-btn--ghost { background: transparent; color: #475569; border-color: #e2e8f0; }
        .clr-btn--ghost:hover { background: #f8fafc; }

        .clr-summary { background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px; padding: 10px 12px; font-size: 13px; color: #334155; margin-bottom: 12px; line-height: 1.5; }
        .clr-summary strong { color: #0f172a; }

        .clr-empty { font-size: 13px; color: #64748b; padding: 10px 12px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px; }
      `}</style>

      <div className="zitu-page__column clr-wrap">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        <header className="clr-hero" role="banner">
          <div className="clr-hero__icon" aria-hidden>🔗</div>
          <div>
            <h1>Correction des liens client</h1>
            <p>
              Outil de dépannage pour le support : reconnecter un compte utilisateur à la bonne fiche client,
              ou corriger une vente attribuée au mauvais client. Chaque action est enregistrée automatiquement (ticket et raison).
            </p>
            <div className="clr-steps">
              <span className="clr-step-chip">1. Relier un compte</span>
              <span className="clr-step-chip">2. Réaffecter une vente</span>
            </div>
          </div>
        </header>

        {/* Section 1 — Relink auth user to client */}
        <section className="clr-card" aria-labelledby="clr-section-1">
          <div className="clr-card__head">
            <span className="clr-card__badge" aria-hidden>1</span>
            <h2 id="clr-section-1" className="clr-card__title">Relier un compte utilisateur à un client</h2>
          </div>
          <p className="clr-card__lead">
            Utilisez ceci lorsque le compte de connexion (auth) n'est pas rattaché à la bonne fiche client.
            Le numéro de téléphone du client sert de clé d'identification (ticket de liaison par téléphone).
          </p>

          <div className="clr-callout" role="note">
            <span className="clr-callout__dot" aria-hidden>ℹ️</span>
            <span>
              <strong>Ce que fait cette action :</strong> elle associe l'identifiant <em>auth.users</em> fourni
              à la fiche client choisie, en utilisant le téléphone du client comme ticket de vérification.
              L'utilisateur verra alors les données de ce client à sa prochaine connexion.
            </span>
          </div>

          {noClients ? (
            <div className="clr-empty">Aucun client disponible pour l'instant. Rechargez la page ou vérifiez votre accès.</div>
          ) : (
            <>
              <div className="clr-field">
                <label className="clr-field__label" htmlFor="clr-client">
                  Client <span className="clr-req" aria-hidden>*</span>
                  <InfoTip text="La fiche client à laquelle le compte doit être rattaché. Le téléphone de cette fiche sera utilisé comme ticket." />
                </label>
                <select
                  id="clr-client"
                  className="clr-select"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                >
                  <option value="">— Sélectionner un client —</option>
                  {clientOptions.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
                <div className="clr-field__hint">{relinkHelp}</div>
              </div>

              <div className="clr-field">
                <label className="clr-field__label" htmlFor="clr-auth">
                  Auth User ID (UUID) <span className="clr-req" aria-hidden>*</span>
                  <InfoTip text="L'identifiant unique du compte dans Supabase auth.users. Format UUID : 8-4-4-4-12 caractères hexadécimaux." />
                </label>
                <input
                  id="clr-auth"
                  className={`clr-input${authUserId && !isLikelyUuid(authUserId) ? ' clr-input--bad' : ''}`}
                  value={authUserId}
                  onChange={(e) => setAuthUserId(e.target.value)}
                  placeholder="ex. 3f2a9b4e-1234-4abc-9def-0123456789ab"
                  autoComplete="off"
                  spellCheck={false}
                />
                {authUserId && !isLikelyUuid(authUserId) && (
                  <div className="clr-field__hint" style={{ color: '#b91c1c' }}>Le format UUID ne semble pas valide.</div>
                )}
              </div>

              <div className="clr-row">
                <div className="clr-field">
                  <label className="clr-field__label" htmlFor="clr-ticket">
                    Ticket <span className="clr-opt">(optionnel)</span>
                    <InfoTip text="Référence du ticket de support (ex. INC-1234). Utile pour tracer l'origine de la demande." />
                  </label>
                  <input id="clr-ticket" className="clr-input" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="INC-1234" />
                </div>
                <div className="clr-field">
                  <label className="clr-field__label" htmlFor="clr-reason">
                    Raison <span className="clr-opt">(optionnel)</span>
                    <InfoTip text="Courte explication de la correction, conservée dans le journal d'audit." />
                  </label>
                  <textarea id="clr-reason" className="clr-textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex. Compte créé avec un mauvais numéro" />
                </div>
              </div>

              {relinkReady && (
                <div className="clr-summary">
                  Vous allez relier le compte auth <strong>{authUserId.trim().slice(0, 8)}…</strong> au client <strong>{selectedClient?.name || '—'}</strong> ({selectedClient?.phone || '—'}).
                </div>
              )}

              <div className="clr-actions">
                <button
                  type="button"
                  className="clr-btn clr-btn--primary"
                  onClick={handleQuickRelink}
                  disabled={busy || !relinkReady}
                  title={!relinkReady ? 'Sélectionnez un client et saisissez un UUID' : 'Relier le compte au client'}
                >
                  {busy ? 'Traitement en cours…' : 'Relier le compte'}
                </button>
                {!relinkReady && (
                  <span style={{ fontSize: 12.5, color: '#64748b' }}>Remplissez les champs obligatoires (*) pour continuer.</span>
                )}
              </div>
            </>
          )}
        </section>

        {/* Section 2 — Reassign sale to correct client */}
        <section className="clr-card" aria-labelledby="clr-section-2">
          <div className="clr-card__head">
            <span className="clr-card__badge clr-card__badge--alt" aria-hidden>2</span>
            <h2 id="clr-section-2" className="clr-card__title">Réaffecter une vente au bon client</h2>
          </div>
          <p className="clr-card__lead">
            Utilisez ceci si une vente est rattachée au mauvais client. Choisissez la vente puis le client correct.
          </p>

          <div className="clr-callout" role="note">
            <span className="clr-callout__dot" aria-hidden>ℹ️</span>
            <span>
              <strong>Ce que fait cette action :</strong> elle remplace le client lié à la vente sélectionnée par le client cible.
              L'historique de la vente reste intact et un enregistrement d'audit est créé.
            </span>
          </div>

          {noSales ? (
            <div className="clr-empty">Aucune vente disponible. Rechargez la page ou vérifiez votre accès.</div>
          ) : (
            <>
              <div className="clr-field">
                <label className="clr-field__label" htmlFor="clr-sale">
                  Vente <span className="clr-req" aria-hidden>*</span>
                  <InfoTip text="La vente actuellement attribuée au mauvais client. La liste affiche les 500 ventes les plus récentes." />
                </label>
                <select id="clr-sale" className="clr-select" value={saleId} onChange={(e) => setSaleId(e.target.value)}>
                  <option value="">— Sélectionner une vente —</option>
                  {saleOptions.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
                {selectedSale && (
                  <div className="clr-field__hint">
                    Client actuel : <strong>{selectedSale.clientName || '—'}</strong>
                  </div>
                )}
              </div>

              <div className="clr-field">
                <label className="clr-field__label" htmlFor="clr-target">
                  Client cible <span className="clr-req" aria-hidden>*</span>
                  <InfoTip text="Le client qui devrait réellement être associé à cette vente." />
                </label>
                <select id="clr-target" className="clr-select" value={targetClientId} onChange={(e) => setTargetClientId(e.target.value)}>
                  <option value="">— Sélectionner un client —</option>
                  {clientOptions.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </div>

              {saleSameClientWarning && (
                <div className="clr-callout clr-callout--warn" role="alert">
                  <span className="clr-callout__dot" aria-hidden>⚠️</span>
                  <span>La vente est déjà attribuée à ce client. Aucun changement ne sera effectué.</span>
                </div>
              )}

              <div className="clr-row">
                <div className="clr-field">
                  <label className="clr-field__label" htmlFor="clr-sticket">
                    Ticket <span className="clr-opt">(optionnel)</span>
                    <InfoTip text="Référence du ticket de support (ex. INC-1234)." />
                  </label>
                  <input id="clr-sticket" className="clr-input" value={saleTicket} onChange={(e) => setSaleTicket(e.target.value)} placeholder="INC-1234" />
                </div>
                <div className="clr-field">
                  <label className="clr-field__label" htmlFor="clr-sreason">
                    Raison <span className="clr-opt">(optionnel)</span>
                    <InfoTip text="Courte explication de la réaffectation, conservée dans l'audit." />
                  </label>
                  <textarea id="clr-sreason" className="clr-textarea" value={saleReason} onChange={(e) => setSaleReason(e.target.value)} placeholder="ex. Vente saisie sur le mauvais dossier" />
                </div>
              </div>

              {saleReady && selectedSale && selectedTargetClient && !saleSameClientWarning && (
                <div className="clr-summary">
                  Vous allez réaffecter la vente <strong>{selectedSale.code || selectedSale.id}</strong> de <strong>{selectedSale.clientName || '—'}</strong> vers <strong>{selectedTargetClient.name || '—'}</strong>.
                </div>
              )}

              <div className="clr-actions">
                <button
                  type="button"
                  className="clr-btn clr-btn--primary"
                  onClick={handleSaleReassign}
                  disabled={busy || !saleReady}
                  title={!saleReady ? 'Sélectionnez une vente et un client cible' : 'Réaffecter la vente'}
                >
                  {busy ? 'Traitement en cours…' : 'Réaffecter la vente'}
                </button>
                {!saleReady && (
                  <span style={{ fontSize: 12.5, color: '#64748b' }}>Sélectionnez la vente et le client cible pour continuer.</span>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
