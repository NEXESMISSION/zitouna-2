import { useRef, useState } from 'react'
import { useNavigate, useLocation, Navigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { pickSafePath } from '../lib/safePaths.js'
import { ErrorPanel } from '../components/ErrorPanel.jsx'
import appLogo from '../../logo2.png'
import {
  IconEye,
  IconEyeOff,
  IconKey,
  IconUser,
} from '../LoginDecor.jsx'

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { loading: authLoading, ready, isAuthenticated, adminUser, clientProfile, login } = useAuth()
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ email: '', password: '' })
  // Plan 04 §3.7 — hold the login result until AuthContext commits the new
  // session state. This avoids the one-frame spinner flash (and potential
  // redirect ping-pong) caused by navigating before `isAuthenticated` flips.
  const [loginResult, setLoginResult] = useState(null)
  // FE-C1 — ref-based guard. React state batches update on the next
  // render, so a fast double-Enter can fire two parallel submits before
  // `disabled={submitting}` reaches the DOM. The ref flips synchronously.
  const submittingRef = useRef(false)

  if (ready && isAuthenticated && (adminUser || clientProfile)) {
    // Plan 04 §3.7 — when a login has just succeeded, prefer its redirectTo.
    // Otherwise this also handles "already logged in" visits to /login.
    if (loginResult?.ok) {
      const fromPath = typeof location.state?.from === 'string' ? location.state.from : null
      // S-M4 — strict allowlist, rejects backslash / %2F / protocol-relative
      const safePath = pickSafePath(fromPath, null)
      return <Navigate to={loginResult.redirectTo || safePath || '/browse'} replace />
    }
    const dest = adminUser ? '/admin' : '/dashboard'
    return <Navigate to={dest} replace />
  }

  function handleChange(e) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
    setError('')
    setSubmitting(true)
    try {
      const result = await login(form.email, form.password)
      if (!result.ok) {
        setError(result.error || 'Connexion impossible.')
        return
      }
      // Plan 04 §3.7 — DON'T navigate yet. Stash the result and let the
      // `ready && isAuthenticated` branch above fire a <Navigate> on the
      // next render, once AuthContext has flushed its state.
      setLoginResult(result)
    } finally {
      // Release the synchronous guard and the local `submitting` flag.
      // `pendingAuthFlush` (computed below) keeps the button disabled and
      // its label on "Connexion en cours…" until the Navigate fires, so
      // there's no mid-flight flash back to the interactive form.
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  // Plan 04 §3.7 — keep the submit button disabled/pending while we wait
  // for AuthContext to become ready+authenticated, so there's no mid-flight
  // flash back to the interactive form after a successful submit.
  const pendingAuthFlush = Boolean(loginResult?.ok) && !(ready && isAuthenticated && (adminUser || clientProfile))
  const submitPending = submitting || pendingAuthFlush

  if (authLoading && !loginResult) {
    return (
      <main className="screen screen--login">
        <div className="app-loader--route" aria-busy="true" aria-live="polite">
          <span className="sr-only">Vérification de la session…</span>
          <div className="app-loader--route__brand">Zitouna Garden</div>
        </div>
      </main>
    )
  }

  return (
    <main className="screen screen--login">
      <div className="auth-bg auth-bg--one" aria-hidden="true" />
      <div className="auth-bg auth-bg--two" aria-hidden="true" />
      <div className="login-content">
        <header className="login-brand">
          <div className="login-logo-wrap">
            <img src={appLogo} alt="Zitounat Bladi logo" className="login-logo-image" />
          </div>
        </header>

        <h1 className="login-title">Connexion</h1>

        <div className="divider login-divider">
          <span>Connectez-vous à votre compte</span>
        </div>

        {error ? (
          <ErrorPanel
            error={error}
            title="Connexion impossible"
            hint={error}
            onRetry={() => setError('')}
            retryLabel="Réessayer"
          />
        ) : null}

        <form className="form login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="login-email">E-mail</label>
            <div className="input-wrap login-input">
              <IconUser />
              <input
                id="login-email"
                name="email"
                type="email"
                placeholder="Exemple@gmail.com"
                autoComplete="email"
                required
                value={form.email}
                onChange={handleChange}
              />
            </div>
          </div>

          <div className="login-field login-field--password">
            <label htmlFor="login-password">Mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="login-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                value={form.password}
                onChange={handleChange}
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

          <div className="login-forgot-wrap">
            <button
              type="button"
              className="forgot-password link-btn"
              onClick={() => navigate('/forgot-password')}
            >
              Mot de passe oublié ?
            </button>
          </div>

          <button type="submit" className="submit-button login-submit" disabled={submitPending}>
            {submitPending ? 'Connexion en cours…' : 'Se connecter'}
          </button>
          {pendingAuthFlush ? (
            <p
              className="login-status"
              role="status"
              aria-live="polite"
              style={{ marginTop: 8, textAlign: 'center', opacity: 0.75, fontSize: 13 }}
            >
              Connexion en cours…
            </p>
          ) : null}
        </form>

        <p className="signup-text login-signup">
          Pas encore de compte ?{' '}
          <button type="button" className="link-btn" onClick={() => navigate('/register')}>
            S&apos;inscrire
          </button>
        </p>
      </div>
    </main>
  )
}
