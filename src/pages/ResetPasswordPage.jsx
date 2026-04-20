import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { supabase, RECOVERY_FLAG_KEY } from '../lib/supabase.js'
import { validatePassword } from '../lib/passwordPolicy.js'
import { ErrorPanel } from '../components/ErrorPanel.jsx'
import appLogo from '../../logo2.png'
import { IconEye, IconEyeOff, IconKey } from '../LoginDecor.jsx'

function IconShield() {
  return (
    <svg viewBox="0 0 100 115" fill="none" xmlns="http://www.w3.org/2000/svg" width="86" height="98">
      <path
        d="M50 5L8 22V55C8 77 28 94 50 100C72 94 92 77 92 55V22L50 5Z"
        fill="rgba(122,176,32,0.12)"
        stroke="rgba(122,176,32,0.55)"
        strokeWidth="2.5"
      />
    </svg>
  )
}

export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const { resetPassword } = useAuth()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [hasRecoverySession, setHasRecoverySession] = useState(false)
  const [checking, setChecking] = useState(true)
  // FE-H4 — store the redirect timer so we can clear it if the user
  // navigates away (or clicks again) before it fires.
  const redirectTimerRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    // FE-C3 — only proceed if BOTH (a) a Supabase session exists, AND
    // (b) the session was obtained via the password-recovery hash. The
    // recovery flag lives in sessionStorage and is set in lib/supabase.js
    // before the hash is stripped from the URL. Without this check, any
    // logged-in user (including a stolen-laptop scenario) could hit
    // /reset-password and silently overwrite the password.
    Promise.resolve().then(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (cancelled) return
        let recovered = false
        try { recovered = window.sessionStorage.getItem(RECOVERY_FLAG_KEY) === '1' } catch { /* ignore */ }
        setHasRecoverySession(Boolean(session) && recovered)
      } finally {
        if (!cancelled) setChecking(false)
      }
    })
    return () => {
      cancelled = true
      if (redirectTimerRef.current) {
        window.clearTimeout(redirectTimerRef.current)
        redirectTimerRef.current = null
      }
    }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSuccess('')

    const pwCheck = validatePassword(password)
    if (!pwCheck.ok) {
      setError(pwCheck.message)
      return
    }
    if (password !== confirm) {
      setError('Les mots de passe ne correspondent pas.')
      return
    }

    setLoading(true)
    try {
      const result = await resetPassword(password)
      if (!result.ok) {
        setError(result.error || 'Impossible de réinitialiser le mot de passe.')
        return
      }
      // Clear the recovery flag — single-use only.
      try { window.sessionStorage.removeItem(RECOVERY_FLAG_KEY) } catch { /* ignore */ }
      setSuccess('Mot de passe modifié avec succès ! Redirection…')
      // Cancel any pending redirect from a prior submit before scheduling a new one.
      if (redirectTimerRef.current) window.clearTimeout(redirectTimerRef.current)
      redirectTimerRef.current = window.setTimeout(() => {
        redirectTimerRef.current = null
        navigate('/login', { replace: true })
      }, 1500)
    } finally {
      setLoading(false)
    }
  }

  if (checking) {
    return (
      <main className="screen screen--login reset-password-page">
        <div className="app-loader--route" aria-busy="true" aria-live="polite">
          <span className="sr-only">Vérification du lien de réinitialisation…</span>
          <div className="app-loader--route__brand">Zitouna Garden</div>
        </div>
      </main>
    )
  }

  if (!hasRecoverySession) {
    return (
      <main className="screen screen--login reset-password-page">
        <div className="auth-bg auth-bg--one" aria-hidden="true" />
        <div className="auth-bg auth-bg--two" aria-hidden="true" />
        <div className="login-content" style={{ textAlign: 'center' }}>
          <h1 className="login-title">Lien expiré ou invalide</h1>
          <p style={{ color: 'var(--color-text-secondary, #ccc)', marginBottom: '1.5rem' }}>
            Cette page n'est accessible qu'à partir d'un lien de réinitialisation reçu par e-mail.<br />
            Demandez un nouveau lien si nécessaire.
          </p>
          <button className="submit-button login-submit" onClick={() => navigate('/forgot-password', { replace: true })}>
            Demander un nouveau lien
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="screen screen--login reset-password-page">
      <div className="auth-bg auth-bg--one" aria-hidden="true" />
      <div className="auth-bg auth-bg--two" aria-hidden="true" />
      <div className="login-content">
        <div className="forgot-shield-wrap">
          <IconShield />
          <img src={appLogo} alt="" className="forgot-shield-logo" aria-hidden="true" />
        </div>
        <h1 className="login-title">Réinitialiser le mot de passe</h1>

        {error ? (
          <ErrorPanel
            error={error}
            title="Réinitialisation impossible"
            hint={error}
            onRetry={() => setError('')}
            retryLabel="Réessayer"
          />
        ) : null}
        {success ? <div className="auth-alert auth-alert--ok">{success}</div> : null}

        <form className="form login-form" onSubmit={handleSubmit}>
          <div className="login-field login-field--password">
            <label htmlFor="reset-password">Nouveau mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="reset-password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="eye-button login-eye"
                aria-label={showPassword ? 'Masquer' : 'Afficher'}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <IconEye /> : <IconEyeOff />}
              </button>
            </div>
          </div>

          <div className="login-field login-field--password">
            <label htmlFor="reset-confirm">Confirmer le mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="reset-confirm"
                type={showConfirm ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              <button
                type="button"
                className="eye-button login-eye"
                aria-label={showConfirm ? 'Masquer' : 'Afficher'}
                onClick={() => setShowConfirm((v) => !v)}
              >
                {showConfirm ? <IconEye /> : <IconEyeOff />}
              </button>
            </div>
          </div>

          <button type="submit" className="submit-button login-submit" disabled={loading}>
            {loading ? 'Modification…' : 'Confirmer et se connecter'}
          </button>
          {loading ? (
            <p
              className="login-status"
              role="status"
              aria-live="polite"
              style={{ marginTop: 8, textAlign: 'center', opacity: 0.75, fontSize: 13 }}
            >
              Modification du mot de passe…
            </p>
          ) : null}
        </form>

        <div className="forgot-bottom">
          <button type="button" className="forgot-nav-btn" onClick={() => navigate('/login')}>
            ← Retour à la connexion
          </button>
        </div>
      </div>
    </main>
  )
}
