import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import appLogo from '../../logo.png'
import { supabase } from '../lib/supabaseClient.js'
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
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [oauthLoadingProvider, setOauthLoadingProvider] = useState('')

  async function handleLogin(event) {
    event.preventDefault()
    setErrorMessage('')
    setIsSubmitting(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setErrorMessage(error.message)
      setIsSubmitting(false)
      return
    }

    navigate('/browse')
  }

  async function handleOAuth(provider) {
    setErrorMessage('')
    setOauthLoadingProvider(provider)

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/browse`,
      },
    })

    if (error) {
      setErrorMessage(error.message)
      setOauthLoadingProvider('')
    }
  }

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
          <button
            type="button"
            className="social-button login-social-btn"
            onClick={() => handleOAuth('google')}
            disabled={oauthLoadingProvider !== ''}
          >
            <IconGoogle />
            {oauthLoadingProvider === 'google' ? 'Google...' : 'Google'}
          </button>
          <button
            type="button"
            className="social-button login-social-btn"
            onClick={() => handleOAuth('facebook')}
            disabled={oauthLoadingProvider !== ''}
          >
            <IconFacebook />
            {oauthLoadingProvider === 'facebook' ? 'Facebook...' : 'Facebook'}
          </button>
        </div>

        <div className="divider login-divider">
          <span>Ou continuer avec</span>
        </div>

        <form
          className="form login-form"
          onSubmit={handleLogin}
        >
          <div className="login-field">
            <label htmlFor="email">E-mail</label>
            <div className="input-wrap login-input">
              <IconUser />
              <input
                id="email"
                type="email"
                placeholder="Exemple@gmail.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
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

          {errorMessage ? <p className="auth-error">{errorMessage}</p> : null}

          <button type="submit" className="submit-button login-submit">
            {isSubmitting ? 'Connexion...' : 'Se connecter'}
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
