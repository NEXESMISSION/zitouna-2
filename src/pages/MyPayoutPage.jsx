import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DashboardShell from '../components/DashboardShell.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import { useAmbassadorReferralSummary } from '../lib/useSupabase.js'
import { requestAmbassadorPayout } from '../lib/db.js'
import './dashboard-page.css'

/*
 * /my/payout — standalone "Retirer" page.
 *
 *   Replaces the old modal inside the dashboard. Shows the wallet hero,
 *   explains what happens when a payout is requested, and submits it.
 *   On success, navigates back to /my/commissions so the user sees the
 *   new "Demande de retrait" row in their history.
 */

export default function MyPayoutPage() {
  const navigate = useNavigate()
  const { clientProfile, profileStatus, ready } = useAuth()

  const terminalProfileReason = profileStatus?.reason
  const profileResolutionFinalized =
    Boolean(terminalProfileReason) &&
    ['rpc_error', 'ambiguous_client_profile', 'phone_conflict', 'admin_no_buyer_profile', 'not_authenticated'].includes(
      terminalProfileReason,
    )
  const clientId =
    ready
      ? (clientProfile?.id || (profileResolutionFinalized ? '' : null))
      : null

  const showAmbassadorCard = Boolean(clientId)
  const { summary: referralSummary, loading: referralLoading, refresh: refreshReferralSummary } =
    useAmbassadorReferralSummary(showAmbassadorCard)

  const referralVerificationBlocked = referralSummary?.identityVerificationBlocked === true
  const balance = Number(referralSummary?.walletBalance ?? 0)
  const minPayout = Number(referralSummary?.minPayoutAmount ?? 0)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const idempotencyRef = useRef(null)

  const disabled =
    busy
    || referralLoading
    || referralVerificationBlocked
    || balance <= 0
    || balance < minPayout

  let reason = ''
  if (referralLoading) reason = 'Chargement du portefeuille…'
  else if (referralVerificationBlocked) reason = "Vérification d'identité requise."
  else if (balance <= 0) reason = 'Aucun gain disponible à retirer pour le moment.'
  else if (balance < minPayout) reason = `Seuil minimum non atteint (${minPayout.toLocaleString('fr-FR')} DT).`

  const handleSubmit = useCallback(async () => {
    if (disabled) return
    if (!idempotencyRef.current) idempotencyRef.current = crypto.randomUUID()
    setBusy(true)
    setError('')
    try {
      await requestAmbassadorPayout(balance, idempotencyRef.current)
      idempotencyRef.current = null
      setSuccess(true)
      try { await refreshReferralSummary({ force: true }) } catch { /* ignore */ }
    } catch (e) {
      setError(e?.message || 'Erreur')
    } finally {
      setBusy(false)
    }
  }, [disabled, balance, refreshReferralSummary])

  return (
    <DashboardShell active="payout">
      <div className="zb-greeting">
        <h1 className="zb-greeting-h1">Retirer mes gains</h1>
      </div>

          {success ? (
            <div className="zb-card" style={{ padding: 32, textAlign: 'center' }}>
              <div style={{ width: 64, height: 64, borderRadius: 999, background: 'var(--zb-green-soft)', color: 'var(--zb-green)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </div>
              <h2 style={{ fontFamily: "'Inter Tight',sans-serif", fontSize: 22, letterSpacing: '-0.025em', margin: '0 0 6px' }}>
                Demande envoyée
              </h2>
              <p style={{ color: 'var(--zb-muted)', fontSize: 14, lineHeight: 1.5, maxWidth: 380, margin: '0 auto 20px' }}>
                L&apos;équipe finance examine votre demande. Le virement bancaire arrive habituellement sous 3 à 7 jours ouvrés.
              </p>
              <button type="button" className="zb-btn zb-btn-primary" onClick={() => navigate('/my/commissions')}>
                Retour à mes commissions
              </button>
            </div>
          ) : (
            <>
              {/* Balance card */}
              <div
                className="zb-card"
                style={{ padding: 28, textAlign: 'center' }}
                aria-busy={referralLoading || undefined}
              >
                <div className="zb-eyebrow" style={{ justifyContent: 'center' }}>
                  <span className="zb-dot-live" /> Montant à retirer
                </div>
                {referralLoading ? (
                  <>
                    <div className="zb-payout-sk-balance" aria-hidden="true">
                      <span className="sk sk-line zb-payout-sk-amount" />
                      <span className="sk sk-line zb-payout-sk-unit" />
                    </div>
                    <div className="zb-payout-sk-sub" aria-hidden="true">
                      <span className="sk sk-line" />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="zb-balance" style={{ textAlign: 'center', marginTop: 14 }}>
                      {balance.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}
                      <span className="zb-balance-unit">TND</span>
                    </div>
                    <div style={{ color: 'var(--zb-muted)', fontSize: 13, marginTop: 10 }}>
                      Seuil minimum : {minPayout.toLocaleString('fr-FR')} DT
                    </div>
                  </>
                )}
              </div>

              {/* Notes */}
              <div className="zb-card" style={{ padding: '14px 18px' }}>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {[
                    ['Seuil minimum', `${minPayout.toLocaleString('fr-FR')} DT — vous êtes ${balance >= minPayout ? 'au-dessus, la demande peut partir' : 'en-dessous, continuez à accumuler'}.`],
                    ['Validation interne', "L'équipe finance vérifie puis déclenche le virement. Délai habituel : 3 à 7 jours ouvrés."],
                    ['Commissions bloquées', "Pendant le traitement, les gains inclus dans la demande sont verrouillés et n'apparaissent plus comme disponibles."],
                    ['Traçabilité', 'Une ligne "Demande de retrait" apparaît dans votre historique, avec le statut mis à jour à chaque étape.'],
                    ['En cas de refus', 'Les gains retournent automatiquement dans votre portefeuille, vous pouvez redemander plus tard.'],
                  ].map(([title, desc]) => (
                    <li key={title} style={{ fontSize: 13, color: 'var(--zb-muted)', lineHeight: 1.5, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <span style={{ width: 6, height: 6, background: 'var(--zb-blue)', borderRadius: 999, flexShrink: 0, marginTop: 7 }} />
                      <span><strong style={{ color: 'var(--zb-ink)' }}>{title} :</strong> {desc}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {error && (
                <div className="zb-card" style={{ padding: 14, background: 'var(--zb-red-soft)', border: '1px solid #FCA5A5', color: 'var(--zb-red)', fontSize: 13 }}>
                  Erreur : {error}
                </div>
              )}

              {reason && !error && (
                <div style={{ color: 'var(--zb-muted)', fontSize: 13, textAlign: 'center' }}>
                  {reason}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10 }}>
                <button type="button" className="zb-btn zb-btn-ghost" onClick={() => navigate('/my/commissions')} disabled={busy}>
                  Annuler
                </button>
                <button type="button" className="zb-btn zb-btn-primary" onClick={handleSubmit} disabled={disabled}>
                  {busy ? 'Envoi…' : `Confirmer le retrait de ${balance.toLocaleString('fr-FR')} DT`}
                </button>
              </div>
            </>
          )}
    </DashboardShell>
  )
}
