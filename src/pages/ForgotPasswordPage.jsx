import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import appLogo from '../../logo.png'
import { IconUser, IconEye, IconEyeOff } from '../LoginDecor.jsx'

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

function IconCheckCircle() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#a8cc50" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  )
}

export default function ForgotPasswordPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!email) return
    setSent(true)
  }

  return (
    <main className="screen screen--login">
      <div className="login-content">

        {/* Logo header — same as login */}
        <header className="login-brand">
          <div className="login-logo-wrap">
            <img src={appLogo} alt="Zitouna Bladi logo" className="login-logo-image" />
          </div>
        </header>

        {/* Page title */}
        <h1 className="login-title">Mot de passe oublié&nbsp;?</h1>

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

        {/* Form / success */}
        {!sent ? (
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

            <div className="login-field">
              <label htmlFor="forgot-pass">Mot de passe électronique</label>
              <div className="input-wrap login-input">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                <input
                  id="forgot-pass"
                  type={showPass ? 'text' : 'password'}
                  placeholder="••••••••"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="eye-button login-eye"
                  aria-label={showPass ? 'Masquer' : 'Afficher'}
                  onClick={() => setShowPass((v) => !v)}
                >
                  {showPass ? <IconEye /> : <IconEyeOff />}
                </button>
              </div>
            </div>

            <button type="submit" className="submit-button login-submit">
              Envoyer le lien de récupération
            </button>
          </form>
        ) : (
          <div className="forgot-success">
            <IconCheckCircle />
            <p>Lien envoyé avec succès</p>
            <strong>{email}</strong>
            <p className="forgot-success-note">
              Vérifiez votre boîte de réception et suivez les instructions pour réinitialiser votre mot de passe.
            </p>
            <button type="button" className="submit-button login-submit" style={{ marginTop: '0.5rem' }} onClick={() => navigate('/login')}>
              Retour à la connexion
            </button>
          </div>
        )}

        {/* Bottom navigation — two pill buttons like the image */}
        {!sent && (
          <div className="forgot-bottom">
            <button type="button" className="forgot-nav-btn" onClick={() => navigate('/login')}>
              ← Connexion
            </button>
            <button type="button" className="forgot-nav-btn">
              Nous contacter
            </button>
          </div>
        )}

      </div>
    </main>
  )
}
