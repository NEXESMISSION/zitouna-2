import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import appLogo from '../../logo.png'
import {
  IconEye,
  IconEyeOff,
  IconFacebook,
  IconGoogle,
  IconKey,
  IconUser,
} from '../LoginDecor.jsx'

export default function RegisterPage() {
  const navigate = useNavigate()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  return (
    <main className="screen screen--login">
      <div className="login-content">
        <header className="login-brand">
          <div className="login-logo-wrap">
            <img src={appLogo} alt="Zitouna Bladi logo" className="login-logo-image" />
          </div>
        </header>

        <h1 className="login-title">Créer un compte</h1>

        <div className="social-row login-social">
          <button type="button" className="social-button login-social-btn">
            <IconGoogle />
            Google
          </button>
          <button type="button" className="social-button login-social-btn">
            <IconFacebook />
            Facebook
          </button>
        </div>

        <div className="divider login-divider">
          <span>Ou continuer avec</span>
        </div>

        <form
          className="form login-form"
          onSubmit={(e) => {
            e.preventDefault()
            navigate('/browse')
          }}
        >
          <div className="login-field">
            <label htmlFor="reg-name">Nom complet</label>
            <div className="input-wrap login-input">
              <IconUser />
              <input id="reg-name" type="text" placeholder="Prénom Nom" autoComplete="name" />
            </div>
          </div>

          <div className="login-field">
            <label htmlFor="reg-email">E-mail</label>
            <div className="input-wrap login-input">
              <IconUser />
              <input id="reg-email" type="email" placeholder="Exemple@gmail.com" autoComplete="email" />
            </div>
          </div>

          <div className="login-field login-field--password">
            <label htmlFor="reg-password">Mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="reg-password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
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
            <label htmlFor="reg-confirm">Confirmer le mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="reg-confirm"
                type={showConfirmPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="eye-button login-eye"
                aria-label={showConfirmPassword ? 'Masquer' : 'Afficher'}
                onClick={() => setShowConfirmPassword((v) => !v)}
              >
                {showConfirmPassword ? <IconEye /> : <IconEyeOff />}
              </button>
            </div>
          </div>

          <button type="submit" className="submit-button login-submit" style={{ marginTop: '20px' }}>
            S&apos;inscrire
          </button>
        </form>

        <p className="signup-text login-signup">
          Déjà un compte ?{' '}
          <button type="button" className="link-btn" onClick={() => navigate('/')}>
            Se connecter
          </button>
        </p>
      </div>
    </main>
  )
}
