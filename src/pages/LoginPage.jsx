import { useState } from 'react'
import { useNavigate, useLocation, Navigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
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

  if (ready && isAuthenticated && (adminUser || clientProfile)) {
    const dest = adminUser ? '/admin' : '/dashboard'
    return <Navigate to={dest} replace />
  }

  function handleChange(e) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const result = await login(form.email, form.password)
      if (!result.ok) {
        setError(result.error || 'Connexion impossible.')
        return
      }
      const fromPath = typeof location.state?.from === 'string' ? location.state.from : null
      const safePath =
        fromPath && fromPath.startsWith('/') && !fromPath.startsWith('//') && !fromPath.includes('://')
          ? fromPath
          : null
      navigate(result.redirectTo || safePath || '/browse', { replace: true })
    } finally {
      setSubmitting(false)
    }
  }

  if (authLoading) {
    return (
      <main className="screen screen--login">
        <div className="login-content" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '40vh' }}>
          <div className="app-loader-spinner" />
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

        {error ? <div className="auth-alert auth-alert--error">{error}</div> : null}

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

          <button type="submit" className="submit-button login-submit" disabled={submitting}>
            {submitting ? 'Connexion en cours…' : 'Se connecter'}
          </button>
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
