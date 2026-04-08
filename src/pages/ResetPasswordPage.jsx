import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
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
  const { state } = useLocation()
  const email = state?.email || ''

  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    setError('')
    if (password.length < 6) {
      setError('Le mot de passe doit contenir au moins 6 caractères.')
      return
    }
    if (password !== confirm) {
      setError('Les mots de passe ne correspondent pas.')
      return
    }
    navigate('/login')
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
        {email ? (
          <p className="login-signup" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
            Compte: <strong style={{ color: '#d7b45a' }}>{email}</strong>
          </p>
        ) : null}

        {error ? <div className="auth-alert auth-alert--error">{error}</div> : null}

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

          <button type="submit" className="submit-button login-submit">
            Confirmer et se connecter
          </button>
        </form>
      </div>
    </main>
  )
}

