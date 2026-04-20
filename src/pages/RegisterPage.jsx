import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { validatePassword, PASSWORD_POLICY_HINT } from '../lib/passwordPolicy.js'
import { ErrorPanel } from '../components/ErrorPanel.jsx'
import {
  IconEye,
  IconEyeOff,
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

export default function RegisterPage() {
  const navigate = useNavigate()
  const { register } = useAuth()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  // FE-C1 — synchronous double-submit guard, see LoginPage for the rationale.
  // The register flow has the worst blast radius — a parallel signUp can
  // create two clients rows for one auth user (see AUDIT_RELATIONS_PROBLEMES H1).
  const submittingRef = useRef(false)

  const [form, setForm] = useState({
    firstname: '',
    lastname: '',
    email: '',
    countryCode: '+216',
    phoneLocal: '',
    password: '',
    confirm: '',
  })

  function handleChange(e) {
    const { name, value } = e.target
    if (name === 'countryCode') {
      const digits = String(value || '').replace(/\D/g, '').slice(0, 4)
      setForm((prev) => ({ ...prev, countryCode: digits ? `+${digits}` : '+' }))
      return
    }
    if (name === 'phoneLocal') {
      setForm((prev) => ({ ...prev, phoneLocal: String(value || '').replace(/\D/g, '').slice(0, 15) }))
      return
    }
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
    setError('')
    setSuccess('')
    const firstname = String(form.firstname || '').trim()
    const lastname = String(form.lastname || '').trim()
    const email = String(form.email || '').trim().toLowerCase()
    const countryCode = String(form.countryCode || '').trim()
    const phoneDigits = String(form.phoneLocal || '').replace(/\D/g, '')

    // Validation gate — release the ref on every early-return so the user
    // can retry after fixing the form. (Without this, a failed validation
    // would lock the submit button forever.)
    let validationError = null
    if (!firstname || !lastname)         validationError = 'Prénom et nom sont obligatoires.'
    else if (!email)                     validationError = 'Adresse e-mail invalide.'
    else {
      const pwCheck = validatePassword(form.password)
      if (!pwCheck.ok) validationError = pwCheck.message
    }
    if (!validationError && !/^\+\d{1,4}$/.test(countryCode)) validationError = 'Indicatif pays invalide.'
    if (!validationError && phoneDigits && phoneDigits.length < 6) validationError = 'Le numéro local doit contenir au moins 6 chiffres.'
    if (!validationError && form.password !== form.confirm) validationError = 'Les mots de passe ne correspondent pas.'

    if (validationError) {
      setError(validationError)
      submittingRef.current = false
      return
    }

    setLoading(true)
    // Hard total-time cap: the register flow chains auth.signUp + upsertClient
    // + upsertClientPhoneIdentity + syncSession + ensureCurrentClientProfile.
    // If ANY of those hangs (RLS stall, realtime handshake, network blip) the
    // form must still recover — no infinite "Inscription en cours…". We race
    // the whole chain against a 20 s ceiling and surface a retry message.
    const totalTimeoutMs = 20_000
    const hardTimeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('signup_total_timeout')), totalTimeoutMs),
    )
    try {
      const result = await Promise.race([
        register({
          firstname,
          lastname,
          email,
          countryCode,
          phoneLocal: phoneDigits,
          password: form.password,
        }),
        hardTimeout,
      ])

      if (!result.ok) {
        const rawError = String(result.error || '')
        // Typed reasons from AuthContext.register take priority over the raw
        // message so we can show exactly what's wrong (and what to do next).
        const reason = result.reason || ''
        let message
        switch (reason) {
          case 'phone_conflict':
            message = "Ce numéro est déjà lié à un autre compte. Contactez le support pour vérification."
            break
          case 'email_conflict':
            message = "Cette adresse e-mail est déjà utilisée. Essayez « Mot de passe oublié » ou utilisez une autre adresse."
            break
          case 'weak_password':
            message = "Mot de passe trop faible. Utilisez au moins 8 caractères avec une combinaison lettres / chiffres."
            break
          case 'invalid_email':
            message = "Adresse e-mail invalide. Vérifiez la saisie."
            break
          case 'profile_unavailable':
            message = "Compte créé. Connectez-vous : le rattachement automatique du profil client sera terminé à la connexion."
            break
          default:
            message = /permissions db|creation du profil client refusee/i.test(rawError)
              ? "Compte créé. Connectez-vous : le rattachement automatique du profil client sera terminé à la connexion."
              : (rawError || "Inscription impossible.")
        }
        setError(message)
        return
      }

      if (result.needsConfirmation) {
        setSuccess('Vérifiez votre boîte e-mail pour confirmer le compte, puis connectez-vous.')
        setTimeout(() => navigate('/login', { replace: true }), 2500)
        return
      }

      setSuccess('Compte créé avec succès !')
      setTimeout(() => navigate(result.redirectTo || '/dashboard', { replace: true }), 800)
    } catch (err) {
      const raw = String(err?.message || err || '')
      console.error('[Register] signup error:', raw, err)
      if (raw === 'signup_total_timeout') {
        setError(
          "Inscription: le serveur ne répond pas (>20 s). Votre compte a peut-être été créé — essayez de vous connecter, sinon réessayez dans un instant.",
        )
      } else {
        setError(raw || "Inscription impossible.")
      }
    } finally {
      setLoading(false)
      submittingRef.current = false
    }
  }

  return (
    <main className="screen screen--login">
      <div className="auth-bg auth-bg--one" aria-hidden="true" />
      <div className="auth-bg auth-bg--two" aria-hidden="true" />
      <div className="login-content login-content--register">

        <h1 className="login-title">Créer un compte</h1>

        <div className="divider login-divider">
          <span>Remplissez vos informations</span>
        </div>

        {error ? (
          <ErrorPanel
            error={error}
            title="Inscription impossible"
            hint={error}
            onRetry={() => setError('')}
            retryLabel="Réessayer"
          />
        ) : null}
        {success ? <div className="auth-alert auth-alert--ok">{success}</div> : null}

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
              <input
                id="reg-country-code"
                name="countryCode"
                type="text"
                placeholder="+216"
                autoComplete="tel-country-code"
                maxLength={5}
                value={form.countryCode}
                onChange={handleChange}
                style={{ width: 70, border: 'none', background: 'transparent', color: 'inherit' }}
              />
              <span className="reg-phone-sep" />
              <IconPhone />
              <input
                id="reg-phone"
                name="phoneLocal"
                type="tel"
                placeholder="Numéro local"
                autoComplete="tel"
                maxLength={15}
                value={form.phoneLocal}
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

          <button type="submit" className="submit-button login-submit" disabled={loading}>
            {loading ? 'Inscription en cours…' : 'S\'inscrire'}
          </button>
          {loading ? (
            <p
              className="login-status"
              role="status"
              aria-live="polite"
              style={{ marginTop: 8, textAlign: 'center', opacity: 0.75, fontSize: 13 }}
            >
              Inscription en cours…
            </p>
          ) : null}
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
