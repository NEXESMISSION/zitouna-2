import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DashboardShell from '../components/DashboardShell.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import {
  useAmbassadorReferralSummary,
  useMyCommissionLedger,
  useSalesBySellerClientId,
} from '../lib/useSupabase.js'
import { requestAmbassadorPayout } from '../lib/db.js'
import ErrorPanel from '../components/ErrorPanel.jsx'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import './dashboard-page.css'

/*
 * /my/commissions — standalone page for ambassador commissions.
 *
 *   Splits off what used to be the "parrainage" tab inside the dashboard.
 *   Renders the wallet hero, referral tree, and the commission ledger.
 *   The "Retirer" flow has moved to /my/payout — a button on the hero
 *   takes the user there instead of opening a local modal.
 */

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso || '')
  }
}

export default function MyCommissionsPage() {
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
  const { events: myCommissionEvents, loading: ledgerLoading, refresh: refreshLedger } =
    useMyCommissionLedger({ clientId: clientId || null, enabled: showAmbassadorCard })
  const { sales: ambassadorSales } = useSalesBySellerClientId(clientId || '')

  const referralHasError = referralSummary?.reason === 'rpc_error'
  const referralVerificationBlocked = referralSummary?.identityVerificationBlocked === true

  const ambassadorReferralRows = useMemo(() => {
    if (!clientId) return []
    return (ambassadorSales || []).filter(
      (s) => s.status !== 'cancelled' && s.status !== 'rejected' && s.status === 'completed' && s.notaryCompletedAt,
    )
  }, [clientId, ambassadorSales])

  const referralLevelsExposed = (ambassadorReferralRows || []).some((r) => r && r.level != null)
  const referralDirectCount = (ambassadorReferralRows || []).filter((r) => r && (r.level === 1 || !r.level)).length
  const referralIndirectCount = (ambassadorReferralRows || []).filter((r) => r && r.level && r.level !== 1).length

  const balance = Number(referralSummary?.walletBalance ?? 0)
  const minPayout = Number(referralSummary?.minPayoutAmount ?? 0)
  const canWithdraw =
    showAmbassadorCard
    && !referralLoading
    && !referralVerificationBlocked
    && balance > 0
    && balance >= minPayout

  const statusLabels = {
    paid: { label: 'Payé', tone: 'zb-status-paid' },
    payable: { label: 'À virer', tone: 'zb-status-up' },
    pending: { label: 'En attente', tone: 'zb-status-due' },
    cancelled: { label: 'Annulé', tone: 'zb-status-bad' },
    pending_review: { label: 'En revue', tone: 'zb-status-due' },
    approved: { label: 'Approuvé', tone: 'zb-status-up' },
    rejected: { label: 'Refusé', tone: 'zb-status-bad' },
  }

  return (
    <DashboardShell active="commissions">
      <div className="zb-greeting">
        <h1 className="zb-greeting-h1">Mes commissions</h1>
      </div>

          {/* Wallet hero */}
          <section className="zb-hero">
            <div
              className="zb-card zb-hero-left"
              aria-busy={referralLoading || undefined}
            >
              <div className="zb-eyebrow"><span className="zb-dot-live" /> Disponible au retrait</div>
              <div>
                <div className="zb-balance">
                  {referralLoading ? (
                    <span className="sk sk-line zb-hero-sk-balance" aria-hidden="true" />
                  ) : (
                    balance.toLocaleString('fr-FR', { maximumFractionDigits: 2 })
                  )}
                  <span className="zb-balance-unit">TND</span>
                </div>
                <div className="zb-balance-sub">
                  <span className="zb-pill-up" style={{ background: 'var(--zb-blue-softer)', color: 'var(--zb-blue)' }}>
                    Seuil min. {minPayout.toLocaleString('fr-FR')} DT
                  </span>
                  {referralLoading ? (
                    <span className="sk sk-line" style={{ height: 12, width: 110 }} aria-hidden="true" />
                  ) : referralLevelsExposed ? (
                    <span>{referralDirectCount} direct · {referralIndirectCount} indirect</span>
                  ) : (
                    <span>{ambassadorReferralRows.length} filleul{ambassadorReferralRows.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>

              <div className="zb-actions">
                <button
                  className="zb-btn zb-btn-primary"
                  type="button"
                  onClick={() => navigate('/my/payout')}
                  disabled={!canWithdraw}
                  style={!canWithdraw ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                  title={!canWithdraw && balance > 0 && balance < minPayout ? `Seuil minimum non atteint (${minPayout.toLocaleString('fr-FR')} DT).` : undefined}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12h12M12 5l7 7-7 7" /></svg>
                  Ouvrir la demande de retrait
                </button>
              </div>

              <div className="zb-rail">
                {[
                  { k: 'En attente', v: Number(referralSummary?.gainsAccrued ?? 0), cls: '' },
                  { k: 'Crédit légal', v: Number(referralSummary?.commissionsReleased ?? 0), cls: '' },
                  { k: 'Direct (L1)', v: Number(referralSummary?.l1Total ?? 0), cls: 'zb-blue' },
                  { k: 'Indirect (L2+)', v: Number(referralSummary?.l2Total ?? 0), cls: '' },
                ].map((row) => (
                  <div key={row.k}>
                    <div className="zb-k">{row.k}</div>
                    <div className={`zb-v ${row.cls}`}>
                      {referralLoading ? (
                        <span className="sk sk-num sk-num--wide" aria-hidden="true" />
                      ) : (
                        row.v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })
                      )}
                      <span className="zb-s">TND</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="zb-card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <h3 style={{ margin: 0, fontFamily: "'Inter Tight',sans-serif", fontSize: 16, letterSpacing: '-0.02em' }}>
                  Votre réseau de filleuls
                </h3>
                <p style={{ margin: '6px 0 0', color: 'var(--zb-muted)', fontSize: 13, lineHeight: 1.5 }}>
                  Visualisez l&apos;ensemble de votre réseau et les commissions générées par chaque filleul, sur une page dédiée.
                </p>
              </div>
              <button
                type="button"
                className="zb-btn zb-btn-ghost"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => navigate('/my/tree')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.8 7.8l3.4 8.4M16.2 7.8l-3.4 8.4"/></svg>
                Ouvrir mon arbre de commissions
              </button>
            </div>
          </section>

          {referralHasError && (
            <ErrorPanel
              title="Impossible de charger le portefeuille"
              hint="Vérifiez votre connexion puis réessayez."
              onRetry={() => refreshReferralSummary()}
            />
          )}

          {referralVerificationBlocked && (
            <div className="zb-card" style={{ padding: 14, background: 'var(--zb-amber-soft)', border: '1px solid #F3E0A7', color: 'var(--zb-amber)', fontSize: 13 }}>
              Vérification d&apos;identité requise avant tout retrait bancaire. Le portefeuille reste visible.
            </div>
          )}

          {/* Ledger */}
          <section>
            <div className="zb-section-head">
              <h2>Historique des commissions</h2>
              <span style={{ color: 'var(--zb-muted)', fontSize: 13 }}>{myCommissionEvents.length} ligne{myCommissionEvents.length !== 1 ? 's' : ''}</span>
            </div>

            <RenderDataGate
              loading={ledgerLoading && myCommissionEvents.length === 0}
              data={myCommissionEvents}
              skeleton="table"
              watchdogMs={4000}
              onRetry={refreshLedger}
              empty={
                <EmptyState
                  title="Aucune commission"
                  description="Les montants s'affichent après clôture notaire des ventes concernées."
                />
              }
            >
              {(events) => (
                <div className="zb-card zb-act" style={{ padding: '8px 20px' }}>
                  {events.map((ev) => {
                    const isPayout = ev?.kind === 'payout'
                    const st = statusLabels[ev.status] || { label: ev.status || '—', tone: 'zb-status-up' }
                    const amt = Number(ev.amount || 0)
                    const dateIso = ev?.createdAt || ev?.sale?.notaryCompletedAt || ev?.paidAt || ev?.reviewedAt
                    return (
                      <div key={ev.id} className="zb-act-row">
                        <div className={`zb-act-ic ${isPayout ? 'zb-act-ic-out' : 'zb-act-ic-in'}`}>
                          {isPayout ? (
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12h12M12 5l7 7-7 7" /></svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7 7 7-7" /></svg>
                          )}
                        </div>
                        <div className="zb-info">
                          <div className="zb-info-t">
                            {isPayout
                              ? 'Demande de retrait'
                              : `Commission L${ev.level || '?'} · ${ev.project?.title || 'Vente'}`}
                          </div>
                          <div className="zb-info-s">
                            {dateIso ? fmtDate(dateIso) : ''}
                            {ev.seller?.name && !isPayout && ` · Vendeur ${ev.seller.name}`}
                            <span className={`zb-status ${st.tone}`} style={{ marginLeft: 8 }}>{st.label}</span>
                          </div>
                        </div>
                        <div className={`zb-a ${isPayout ? 'zb-out' : 'zb-in'}`}>
                          {isPayout ? '−' : '+'}{Math.abs(amt).toLocaleString('fr-FR')}
                          <span className="zb-u">DT</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </RenderDataGate>
          </section>
    </DashboardShell>
  )
}
