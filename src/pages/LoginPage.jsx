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

export default function LoginPage() {
  const navigate = useNavigate()
  const [showPassword, setShowPassword] = useState(false)

  return (
    <main className="screen screen--login">
      <div className="login-content">
        <header className="login-brand">
          <div className="login-logo-wrap">
            <img src={appLogo} alt="Zitouna Bladi logo" className="login-logo-image" />
          </div>
        </header>

        <h1 className="login-title">Se connecter</h1>

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
            <label htmlFor="email">E-mail</label>
            <div className="input-wrap login-input">
              <IconUser />
              <input id="email" type="email" placeholder="Exemple@gmail.com" autoComplete="email" />
            </div>
          </div>

          <div className="login-field login-field--password">
            <label htmlFor="password">Mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="current-password"
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
            <button type="button" className="link-btn forgot-password" onClick={() => navigate('/forgot-password')}>
              Mot de passe oublié ?
            </button>
          </div>

          <button type="submit" className="submit-button login-submit">
            Se connecter
          </button>
        </form>

        <p className="signup-text login-signup">
          Vous n&apos;avez pas de compte ?{' '}
          <button type="button" className="link-btn" onClick={() => navigate('/register')}>
            Inscrivez-vous
          </button>
        </p>
      </div>
    </main>
  )
}
