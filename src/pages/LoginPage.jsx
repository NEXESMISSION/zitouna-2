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
import { supabase, isSupabaseConfigured } from '../lib/supabase.js'

export default function LoginPage() {
  const navigate = useNavigate()
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState('')

  const [form, setForm] = useState({ email: '', password: '' })

  function handleChange(e) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
    setError('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (!isSupabaseConfigured) {
      setError("Supabase n'est pas configuré. Vérifiez le fichier .env.")
      return
    }

    setLoading(true)
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: form.email,
        password: form.password,
      })

      if (signInError) {
        if (
          signInError.message.includes('Invalid login credentials') ||
          signInError.message.includes('invalid_credentials')
        ) {
          setError('E-mail ou mot de passe incorrect.')
        } else {
          setError(signInError.message)
        }
        return
      }

      navigate('/browse')
    } catch {
      setError('Une erreur inattendue s\'est produite. Réessayez.')
    } finally {
      setLoading(false)
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

        <h1 className="login-title">Connexion</h1>

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

        {error && (
          <div style={{
            background: 'rgba(220,53,69,0.15)',
            border: '1px solid rgba(220,53,69,0.5)',
            color: '#ff6b7a',
            borderRadius: '8px',
            padding: '10px 14px',
            fontSize: '13px',
            marginBottom: '12px',
          }}>
            {error}
          </div>
        )}

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

          <button
            type="submit"
            className="submit-button login-submit"
            disabled={loading}
          >
            {loading ? 'Connexion en cours…' : 'Se connecter'}
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
