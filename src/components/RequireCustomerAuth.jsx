import { useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { ensureCurrentClientProfile } from '../lib/db.js'
import { useWatchdog } from '../hooks/useWatchdog.js'

// Plan 04 §3.3 — profile-heal UX trap
// After N seconds of the initial auth loading spinner, surface a
// "Réessayer / Se déconnecter" affordance so the user can escape the
// silent loop. Paired with the existing retry flow that already runs
// `ensureCurrentClientProfile()` before `refreshAuth()`.
const AUTH_HEAL_WATCHDOG_MS = 8000

export default function RequireCustomerAuth({ children }) {
  const { loading, ready, isAuthenticated, adminUser, clientProfile, authError, logout, refreshAuth } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  // FE-H3 — local "retry in flight" flag so the user gets visible
  // feedback during the refresh without us nuking the React tree via
  // navigate(0). A successful refreshAuth() updates the AuthContext
  // state, this component re-renders, and the gate naturally falls
  // through to `children`.
  const [retrying, setRetrying] = useState(false)
  // RESEARCH 04 §13: after several failed retries, surface a support
  // contact. Without this, users get stuck in a silent loop.
  const retryCountRef = useRef(0)
  const [showSupport, setShowSupport] = useState(false)

  // Watchdog on the bootstrap loading state. If `loading || !ready` persists
  // past the threshold, we swap the bare spinner for the explicit retry /
  // sign-out panel so a stuck initial session never traps the user.
  const isBootstrapping = Boolean(loading || !ready)
  const { stuck: bootstrapStuck, reset: resetWatchdog } = useWatchdog(isBootstrapping, AUTH_HEAL_WATCHDOG_MS)

  const retryHeal = async () => {
    setRetrying(true)
    try {
      // RESEARCH 04 §13 / Plan 04 §3.3: previously only called refreshAuth(),
      // which does getUser() + syncSession() but does NOT re-run the
      // server-side heal. For a buyer whose clients row is not linked yet,
      // the heal is what creates the link — so the retry was a no-op. Now
      // we run the heal FIRST, then refreshAuth() to pick up the newly
      // attached profile.
      try { await ensureCurrentClientProfile() } catch { /* heal may fail; refreshAuth still worth a try */ }
      await refreshAuth()
      retryCountRef.current += 1
      if (retryCountRef.current >= 3) setShowSupport(true)
    } finally {
      setRetrying(false)
      resetWatchdog()
    }
  }

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  // Bootstrapping — show the spinner for a short grace window, then upgrade
  // to the retry/sign-out panel.
  if (isBootstrapping) {
    if (!bootstrapStuck) {
      return (
        <div className="app-loader" style={{ minHeight: '50vh' }}>
          <div className="app-loader-spinner" />
        </div>
      )
    }
    return (
      <AuthStuckCard
        retrying={retrying}
        onRetry={retryHeal}
        onLogout={handleLogout}
      />
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  if (!adminUser && !clientProfile) {
    return (
      <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 440, textAlign: 'center', padding: '2rem' }}>
          <h2 style={{ marginBottom: '1rem', color: 'var(--color-text, #fff)' }}>Profil introuvable</h2>
          <p style={{ marginBottom: '1rem', color: 'var(--color-text-secondary, #ccc)', lineHeight: 1.5 }}>
            {authError
              ? `Erreur : ${authError}`
              : "Votre profil client n'a pas pu être chargé. Il est possible qu'il n'ait pas encore été créé ou qu'il y ait un problème temporaire."}
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              className="submit-button"
              style={{ minWidth: 120 }}
              disabled={retrying}
              onClick={retryHeal}
            >
              {retrying ? 'Vérification…' : 'Réessayer'}
            </button>
            <button
              className="submit-button"
              style={{ minWidth: 120, background: 'var(--color-danger, #e74c3c)' }}
              onClick={handleLogout}
            >
              Se déconnecter
            </button>
          </div>
          {showSupport ? (
            <p style={{ marginTop: 20, fontSize: 13, color: 'var(--color-text-secondary, #ccc)' }}>
              Toujours bloqué ? <a href="mailto:support@zitounabladi.com" style={{ color: 'var(--color-primary, #2e7d32)' }}>Contactez le support</a>.
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  return children
}

// ----------------------------------------------------------------------------
// Polished "auth is stuck" card. Replaces the bare ErrorPanel + extra button
// the user saw when the bootstrap watchdog fired (typically a stale JWT in
// localStorage after a DB reset). Inline styles on purpose — this screen is
// rare and outside the usual admin/customer CSS scopes.
// ----------------------------------------------------------------------------
function AuthStuckCard({ retrying, onRetry, onLogout }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [])

  const card = {
    width: '100%',
    maxWidth: 460,
    background: 'rgba(22,41,23,0.72)',
    border: '1px solid rgba(168,204,80,0.28)',
    borderRadius: 16,
    padding: '28px 26px',
    boxShadow: '0 20px 48px rgba(0,0,0,0.35)',
    backdropFilter: 'blur(8px)',
    color: '#e7efe0',
    textAlign: 'center',
  }
  const badge = {
    width: 56, height: 56, borderRadius: '50%',
    margin: '0 auto 18px',
    display: 'grid', placeItems: 'center',
    background: 'rgba(168,204,80,0.14)',
    border: '1px solid rgba(168,204,80,0.35)',
  }
  const dot = {
    width: 10, height: 10, borderRadius: '50%',
    background: '#a8cc50',
    boxShadow: '0 0 0 0 rgba(168,204,80,0.6)',
    animation: 'auth-stuck-pulse 1.6s ease-in-out infinite',
  }
  const title = { fontSize: 20, fontWeight: 600, margin: '0 0 6px', color: '#f4f9ec' }
  const hint  = { fontSize: 14, lineHeight: 1.55, margin: '0 0 18px', color: 'rgba(231,239,224,0.78)' }
  const timer = { fontSize: 12, color: 'rgba(231,239,224,0.55)', margin: '0 0 22px' }
  const row   = { display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }
  const btnBase = {
    minWidth: 148, padding: '10px 18px', borderRadius: 10,
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
    border: '1px solid transparent', transition: 'transform .1s ease',
  }
  const btnPrimary = {
    ...btnBase,
    background: 'linear-gradient(135deg,#a8cc50 0%,#7aa132 100%)',
    color: '#14210b',
    opacity: retrying ? 0.7 : 1,
  }
  const btnGhost = {
    ...btnBase,
    background: 'transparent',
    color: '#e7efe0',
    borderColor: 'rgba(231,239,224,0.3)',
  }

  return (
    <div
      style={{
        minHeight: '70vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px 16px',
      }}
    >
      <style>{`@keyframes auth-stuck-pulse {
        0%   { transform: scale(1);   box-shadow: 0 0 0 0   rgba(168,204,80,0.55); }
        70%  { transform: scale(1.2); box-shadow: 0 0 0 14px rgba(168,204,80,0); }
        100% { transform: scale(1);   box-shadow: 0 0 0 0   rgba(168,204,80,0); }
      }`}</style>
      <div style={card} role="alert" aria-live="polite">
        <div style={badge}><span style={dot} /></div>
        <h2 style={title}>Préparation de votre compte</h2>
        <p style={hint}>
          La vérification prend plus de temps que prévu. Réessayez,
          ou déconnectez-vous puis reconnectez-vous.
        </p>
        <p style={timer}>Temps écoulé : {elapsed}s</p>
        <div style={row}>
          <button
            type="button"
            style={btnPrimary}
            disabled={retrying}
            onClick={onRetry}
          >
            {retrying ? 'Vérification…' : 'Réessayer'}
          </button>
          <button
            type="button"
            style={btnGhost}
            onClick={onLogout}
          >
            Se déconnecter
          </button>
        </div>
      </div>
    </div>
  )
}
