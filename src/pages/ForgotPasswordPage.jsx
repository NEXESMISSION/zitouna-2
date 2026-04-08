import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  const [email, setEmail] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!email) return
    navigate('/reset-password', { state: { email } })
  }

  return (
    <main className="screen screen--login forgot-password-page">
      <div className="login-content">

        {/* Info card — white card with shield */}
        <div className="forgot-info-card">
          <div className="forgot-shield-wrap">
            <IconShield />
            <img src={appLogo} alt="" className="forgot-shield-logo" aria-hidden="true" />
          </div>
          <h2 className="forgot-card-title">Récupération du mot de passe</h2>
          <p className="forgot-card-desc">
            Veuillez entrer votre nom d&apos;utilisateur ou adresse e-mail pour recevoir un lien
            de réinitialisation de votre mot de passe.
          </p>
        </div>

        <form className="form login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="forgot-email">Nom d&apos;utilisateur / E-mail</label>
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

          <button type="submit" className="submit-button login-submit">
            Envoyer le lien de récupération
          </button>
        </form>

        {/* Bottom navigation — two pill buttons like the image */}
        <div className="forgot-bottom">
          <button type="button" className="forgot-nav-btn" onClick={() => navigate('/login')}>
            ← Connexion
          </button>
          <button type="button" className="forgot-nav-btn">
            Nous contacter
          </button>
        </div>

      </div>
    </main>
  )
}
