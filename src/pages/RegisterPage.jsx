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
  const [showPassword, setShowPassword]               = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [loading, setLoading]                         = useState(false)
  const [error, setError]                             = useState('')
  const [success, setSuccess]                         = useState('')

  const [form, setForm] = useState({
    firstname: '',
    lastname: '',
    email: '',
    phone: '',
    cin: '',
    password: '',
    confirm: '',
  })

  function handleChange(e) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
    setError('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (form.password !== form.confirm) {
      setError('Les mots de passe ne correspondent pas.')
      return
    }
    if (form.password.length < 6) {
      setError('Le mot de passe doit contenir au moins 6 caractères.')
      return
    }
    if (form.cin && !/^\d{8}$/.test(form.cin)) {
      setError('Le numéro CIN doit contenir exactement 8 chiffres.')
      return
    }
    if (form.phone && !/^\d{8}$/.test(form.phone)) {
      setError('Le numéro de téléphone doit contenir exactement 8 chiffres.')
      return
    }

    if (!isSupabaseConfigured) {
      setError('Supabase n\'est pas configuré. Vérifiez le fichier .env.')
      return
    }

    setLoading(true)
    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: form.email,
        password: form.password,
        options: {
          data: {
            first_name: form.firstname,
            last_name: form.lastname,
            full_name: `${form.firstname} ${form.lastname}`.trim(),
            phone: form.phone ? `+216${form.phone}` : '',
            cin: form.cin,
          },
        },
      })

      if (signUpError) {
        if (signUpError.status === 429 || signUpError.message.includes('rate limit') || signUpError.message.includes('429')) {
          setError('Trop de tentatives d\'inscription. Attendez quelques minutes et réessayez.')
        } else if (
          signUpError.message.includes('already registered') ||
          signUpError.message.includes('already exists') ||
          signUpError.message.includes('User already registered')
        ) {
          setError('Cet e-mail est déjà utilisé. Veuillez vous connecter.')
        } else {
          setError(signUpError.message)
        }
        return
      }

      // Supabase retourne identityData vide si l'email existe déjà en "pending"
      const isAlreadyPending =
        data?.user &&
        data.user.identities &&
        data.user.identities.length === 0

      if (isAlreadyPending) {
        setError(
          'Cet e-mail est déjà enregistré mais en attente de confirmation. ' +
          'Vérifiez votre boîte mail ou contactez l\'administrateur pour supprimer le compte en attente.'
        )
        return
      }

      setSuccess('Compte créé avec succès ! Vous allez être redirigé vers la connexion…')
      setTimeout(() => navigate('/'), 2500)
    } catch (err) {
      if (err?.status === 429 || String(err?.message).includes('429') || String(err?.message).includes('rate limit')) {
        setError('Trop de tentatives. Attendez quelques minutes avant de réessayer.')
      } else {
        setError('Une erreur inattendue s\'est produite. Réessayez.')
      }
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

        {success && (
          <div style={{
            background: 'rgba(40,167,69,0.15)',
            border: '1px solid rgba(40,167,69,0.5)',
            color: '#5cb85c',
            borderRadius: '8px',
            padding: '10px 14px',
            fontSize: '13px',
            marginBottom: '12px',
          }}>
            {success}
          </div>
        )}

        <form className="form login-form" onSubmit={handleSubmit}>
          <div className="reg-name-row">
            <div className="login-field">
              <label htmlFor="reg-firstname">Prénom</label>
              <div className="input-wrap login-input">
                <IconUser />
                <input
                  id="reg-firstname"
                  name="firstname"
                  type="text"
                  placeholder="Lassaad"
                  autoComplete="given-name"
                  required
                  value={form.firstname}
                  onChange={handleChange}
                />
              </div>
            </div>
            <div className="login-field">
              <label htmlFor="reg-lastname">Nom</label>
              <div className="input-wrap login-input">
                <IconUser />
                <input
                  id="reg-lastname"
                  name="lastname"
                  type="text"
                  placeholder="Ben Ali"
                  autoComplete="family-name"
                  required
                  value={form.lastname}
                  onChange={handleChange}
                />
              </div>
            </div>
          </div>

          <div className="login-field">
            <label htmlFor="reg-email">E-mail</label>
            <div className="input-wrap login-input">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
              <input
                id="reg-email"
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

          <div className="login-field">
            <label htmlFor="reg-phone">Numéro de téléphone</label>
            <div className="input-wrap login-input reg-phone-wrap">
              <span className="reg-phone-prefix">+216</span>
              <span className="reg-phone-sep" />
              <IconPhone />
              <input
                id="reg-phone"
                name="phone"
                type="tel"
                placeholder="XX XXX XXX"
                autoComplete="tel"
                maxLength={8}
                value={form.phone}
                onChange={handleChange}
              />
            </div>
          </div>

          <div className="login-field">
            <label htmlFor="reg-cin">Numéro de carte d&apos;identité (CIN)</label>
            <div className="input-wrap login-input">
              <IconIdCard />
              <input
                id="reg-cin"
                name="cin"
                type="text"
                placeholder="XXXXXXXX"
                autoComplete="off"
                maxLength={8}
                value={form.cin}
                onChange={handleChange}
              />
            </div>
          </div>

          <div className="login-field login-field--password">
            <label htmlFor="reg-password">Mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="reg-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
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

          <div className="login-field login-field--password">
            <label htmlFor="reg-confirm">Confirmer le mot de passe</label>
            <div className="input-wrap login-input">
              <IconKey />
              <input
                id="reg-confirm"
                name="confirm"
                type={showConfirmPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
                required
                value={form.confirm}
                onChange={handleChange}
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

          <button
            type="submit"
            className="submit-button login-submit"
            style={{ marginTop: '20px' }}
            disabled={loading}
          >
            {loading ? 'Inscription en cours…' : 'S\'inscrire'}
          </button>
        </form>

        <p className="signup-text login-signup">
          Déjà un compte ?{' '}
          <button type="button" className="link-btn" onClick={() => navigate('/login')}>
            Se connecter
          </button>
        </p>
      </div>
    </main>
  )
}
