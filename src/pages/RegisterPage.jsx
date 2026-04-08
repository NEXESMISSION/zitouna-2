import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import appLogo from '../../logo.png'
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient.js'
import {
  IconEye,
  IconEyeOff,
  IconFacebook,
  IconGoogle,
  IconKey,
  IconUser,
} from '../LoginDecor.jsx'

function IconPhone() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 5.55 5.55l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function IconIdCard() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <circle cx="9" cy="12" r="2.5" />
      <path d="M14 10h4M14 14h3" />
    </svg>
  )
}

export default function RegisterPage() {
  const navigate = useNavigate()
  const [showPassword, setShowPassword]           = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [cin, setCin] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [oauthLoadingProvider, setOauthLoadingProvider] = useState('')

  async function handleRegister(event) {
    event.preventDefault()
    setErrorMessage('')
    setSuccessMessage('')
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Configuration Supabase manquante. Verifiez le fichier .env.local.')
      return
    }

    if (password !== confirmPassword) {
      setErrorMessage('Les mots de passe ne correspondent pas.')
      return
    }

    setIsSubmitting(true)
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
          phone,
          cin,
        },
      },
    })

    if (error) {
      setErrorMessage(error.message)
      setIsSubmitting(false)
      return
    }

    setSuccessMessage('Compte cree. Verifiez votre email pour confirmer le compte.')
    setIsSubmitting(false)
  }

  async function handleOAuth(provider) {
    setErrorMessage('')
    setSuccessMessage('')
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Configuration Supabase manquante. Verifiez le fichier .env.local.')
      return
    }
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

        <h1 className="login-title">Créer un compte</h1>

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
          onSubmit={handleRegister}
        >
          {/* First name + Last name — side by side */}
          <div className="reg-name-row">
            <div className="login-field">
              <label htmlFor="reg-firstname">Prénom</label>
              <div className="input-wrap login-input">
                <IconUser />
                <input
                  id="reg-firstname"
                  type="text"
                  placeholder="Lassaad"
                  autoComplete="given-name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="login-field">
              <label htmlFor="reg-lastname">Nom</label>
              <div className="input-wrap login-input">
                <IconUser />
                <input
                  id="reg-lastname"
                  type="text"
                  placeholder="Ben Ali"
                  autoComplete="family-name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          {/* Email */}
          <div className="login-field">
            <label htmlFor="reg-email">E-mail</label>
            <div className="input-wrap login-input">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
              <input
                id="reg-email"
                type="email"
                placeholder="Exemple@gmail.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          {/* Phone number */}
          <div className="login-field">
            <label htmlFor="reg-phone">Numéro de téléphone</label>
            <div className="input-wrap login-input reg-phone-wrap">
              <span className="reg-phone-prefix">+216</span>
              <span className="reg-phone-sep" />
              <IconPhone />
              <input
                id="reg-phone"
                type="tel"
                placeholder="XX XXX XXX"
                autoComplete="tel"
                maxLength={8}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>

          {/* CIN */}
          <div className="login-field">
            <label htmlFor="reg-cin">Numéro de carte d&apos;identité (CIN)</label>
            <div className="input-wrap login-input">
              <IconIdCard />
              <input
                id="reg-cin"
                type="text"
                placeholder="XXXXXXXX"
                autoComplete="off"
                maxLength={8}
                value={cin}
                onChange={(e) => setCin(e.target.value)}
              />
            </div>
          </div>

          {/* Password */}
          <div className="login-field login-field--password">
            <label htmlFor="reg-password">Mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="reg-password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
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

          {/* Confirm password */}
          <div className="login-field login-field--password">
            <label htmlFor="reg-confirm">Confirmer le mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="reg-confirm"
                type={showConfirmPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
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

          {errorMessage ? <p className="auth-error">{errorMessage}</p> : null}
          {successMessage ? <p className="auth-success">{successMessage}</p> : null}

          <button type="submit" className="submit-button login-submit" style={{ marginTop: '20px' }}>
            {isSubmitting ? 'Inscription...' : "S'inscrire"}
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
