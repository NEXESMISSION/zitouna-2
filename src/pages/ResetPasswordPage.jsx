import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
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
  const [hasSession, setHasSession] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setHasSession(Boolean(session))
      setChecking(false)
    })
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.')
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
      setSuccess('Mot de passe modifié avec succès ! Redirection…')
      setTimeout(() => navigate('/login', { replace: true }), 1500)
    } finally {
      setLoading(false)
    }
  }

  if (checking) {
    return (
      <main className="screen screen--login reset-password-page">
        <div className="login-content" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
          <div className="app-loader-spinner" />
        </div>
      </main>
    )
  }

  if (!hasSession) {
    return (
      <main className="screen screen--login reset-password-page">
        <div className="auth-bg auth-bg--one" aria-hidden="true" />
        <div className="auth-bg auth-bg--two" aria-hidden="true" />
        <div className="login-content" style={{ textAlign: 'center' }}>
          <h1 className="login-title">Lien expiré</h1>
          <p style={{ color: 'var(--color-text-secondary, #ccc)', marginBottom: '1.5rem' }}>
            Ce lien de réinitialisation n'est plus valide ou a expiré.<br />
            Demandez un nouveau lien.
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

        {error ? <div className="auth-alert auth-alert--error">{error}</div> : null}
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
