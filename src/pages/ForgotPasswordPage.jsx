import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import appLogo from '../../logo-header2.png'
import { IconUser } from '../LoginDecor.jsx'

function IconShield() {
  return (
    <svg viewBox="0 0 100 115" fill="none" xmlns="http://www.w3.org/2000/svg" width="62" height="72">
      <path
        d="M50 5L8 22V55C8 77 28 94 50 100C72 94 92 77 92 55V22L50 5Z"
        fill="rgba(122,176,32,0.12)"
        stroke="rgba(122,176,32,0.55)"
        strokeWidth="2.5"
      />
    </svg>
  )
}

export default function ForgotPasswordPage() {
  const navigate = useNavigate()
  const { forgotPassword } = useAuth()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSuccess('')

    const trimmed = String(email || '').trim()
    if (!trimmed) {
      setError('Veuillez saisir votre adresse e-mail.')
      return
    }

    setLoading(true)
    try {
      const result = await forgotPassword(trimmed)
      if (!result.ok) {
        setError(result.error || 'Impossible d\'envoyer le lien.')
        return
      }
      setSuccess('Un lien de réinitialisation a été envoyé à votre adresse e-mail. Vérifiez votre boîte de réception.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="screen screen--login forgot-password-page">
      <div className="login-content">

        <div className="forgot-info-card">
          <div className="forgot-shield-wrap">
            <IconShield />
            <img src={appLogo} alt="" className="forgot-shield-logo" aria-hidden="true" />
          </div>
          <h2 className="forgot-card-title">Récupération du mot de passe</h2>
          <p className="forgot-card-desc">
            Veuillez entrer votre adresse e-mail pour recevoir un lien
            de réinitialisation de votre mot de passe.
          </p>
        </div>

        {error ? <div className="auth-alert auth-alert--error">{error}</div> : null}
        {success ? <div className="auth-alert auth-alert--ok">{success}</div> : null}

        <form className="form login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="forgot-email">E-mail</label>
            <div className="input-wrap login-input">
              <IconUser />
              <input
                id="forgot-email"
                type="email"
                placeholder="Exemple@gmail.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          <button type="submit" className="submit-button login-submit" disabled={loading}>
            {loading ? 'Envoi en cours…' : 'Envoyer le lien de récupération'}
          </button>
        </form>

        <div className="forgot-bottom">
          <button type="button" className="forgot-nav-btn" onClick={() => navigate('/login')}>
            ← Connexion
          </button>
          <button type="button" className="forgot-nav-btn" onClick={() => navigate('/register')}>
            Créer un compte
          </button>
        </div>

      </div>
    </main>
  )
}
