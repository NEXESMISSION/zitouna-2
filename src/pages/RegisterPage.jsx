import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { validatePassword } from '../lib/passwordPolicy.js'
import { useAuthLocale } from './authLocale.js'
import headerLogo from '../../logo-header2.png'
import './auth.css'

// Rough password strength (0–4) for the segmented meter. Intentionally more
// permissive than validatePassword() — this is only a visual hint; the real
// policy gate still runs on submit.
function gradePassword(pw) {
  const s = String(pw || '')
  if (!s) return 0
  let score = 0
  if (s.length >= 8) score += 1
  if (s.length >= 12) score += 1
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score += 1
  if (/\d/.test(s) && /[^A-Za-z0-9]/.test(s)) score += 1
  return Math.min(4, score)
}

export default function RegisterPage() {
  const navigate = useNavigate()
  const { register } = useAuth()
  const { t, dir, lang } = useAuthLocale()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  // FE-C1 — synchronous double-submit guard (parallel signUp can duplicate
  // client rows for one auth user — see AUDIT H1).
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
      // Strip leading international prefix if the user pasted +216… or 00216…
      // into the local-number field, so the final E.164 doesn't double the CC.
      const raw = String(value || '')
      const hasIntlPrefix = /^\s*(\+|00)/.test(raw)
      let digits = raw.replace(/\D/g, '')
      const ccDigits = String(form.countryCode || '').replace(/\D/g, '')
      if (hasIntlPrefix && ccDigits && digits.startsWith(ccDigits) && digits.length > ccDigits.length) {
        digits = digits.slice(ccDigits.length)
      }
      setForm((prev) => ({ ...prev, phoneLocal: digits.slice(0, 15) }))
      return
    }
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  const phonePreview = useMemo(() => {
    const cc = String(form.countryCode || '').replace(/\D/g, '')
    const local = String(form.phoneLocal || '').replace(/\D/g, '')
    if (!cc || !local) return ''
    return `+${cc}${local}`
  }, [form.countryCode, form.phoneLocal])

  const pwStrength = gradePassword(form.password)
  const strengthLabel = (t('strengthLabels') || [])[pwStrength] || ''

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

    let validationError = null
    if (!firstname || !lastname)         validationError = t('valNameRequired')
    else if (!email)                     validationError = t('valEmailInvalid')
    else {
      const pwCheck = validatePassword(form.password)
      if (!pwCheck.ok) validationError = pwCheck.message
    }
    if (!validationError && !/^\+\d{1,4}$/.test(countryCode)) validationError = t('valCountryCode')
    if (!validationError && phoneDigits && phoneDigits.length < 6) validationError = t('valPhoneShort')
    if (!validationError && form.password !== form.confirm) validationError = t('valPwdMismatch')

    if (validationError) {
      setError(validationError)
      submittingRef.current = false
      return
    }

    setLoading(true)
    // Hard 20 s cap on the whole chain so a stalled RPC never locks the form.
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
        const reason = result.reason || ''
        let message
        switch (reason) {
          case 'phone_conflict':
            message = t('reasonPhoneConflict')
            break
          case 'email_conflict':
            message = t('reasonEmailConflict')
            break
          case 'weak_password':
            message = t('reasonWeakPwd')
            break
          case 'invalid_email':
            message = t('reasonInvalidEmail')
            break
          case 'profile_unavailable':
            message = t('reasonProfileUnavailable')
            break
          default:
            message = /permissions db|creation du profil client refusee/i.test(rawError)
              ? t('reasonProfileUnavailable')
              : (rawError || t('registerError'))
        }
        setError(message)
        return
      }

      if (result.needsConfirmation) {
        setSuccess(t('successConfirm'))
        setTimeout(() => navigate('/login', { replace: true }), 2500)
        return
      }

      setSuccess(t('successCreated'))
      setTimeout(() => navigate(result.redirectTo || '/dashboard', { replace: true }), 800)
    } catch (err) {
      const raw = String(err?.message || err || '')
      console.error('[Register] signup error:', raw, err)
      if (raw === 'signup_total_timeout') {
        setError(t('signupTimeout'))
      } else {
        setError(raw || t('registerError'))
      }
    } finally {
      setLoading(false)
      submittingRef.current = false
    }
  }

  const tos = t('tosText') || []

  return (
    <main className="auth-page auth-page--solo" lang={lang} dir={dir}>
      <section className="auth-pane">
        <div className="auth-pane__top">
          <div className="auth-pane__brand" aria-hidden="true">
            <div className="auth-pane__brand-mark">
              <img src={headerLogo} alt="" />
            </div>
            <span className="auth-pane__brand-name">Zitouna Bladi</span>
          </div>
        </div>

        <div className="auth-form-wrap">
          <div className="auth-seg" role="tablist" aria-label="Authentification">
            <button type="button" role="tab" aria-selected="false" onClick={() => navigate('/login')}>{t('tabLogin')}</button>
            <button type="button" className="is-active" role="tab" aria-selected="true">{t('tabRegister')}</button>
          </div>

          {error ? (
            <div className="auth-alert auth-alert--error" role="alert">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
              <button type="button" className="auth-alert__retry" onClick={() => setError('')}>{t('retry')}</button>
            </div>
          ) : null}
          {success ? (
            <div className="auth-alert auth-alert--success" role="status">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>{success}</span>
            </div>
          ) : null}

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <div className="auth-row-2">
              <div className="auth-field">
                <label className="auth-field__label" htmlFor="reg-firstname">{t('firstname')}</label>
                <div className="auth-input">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
                  </svg>
                  <input
                    id="reg-firstname"
                    name="firstname"
                    type="text"
                    placeholder={t('firstnamePh')}
                    autoComplete="given-name"
                    required
                    value={form.firstname}
                    onChange={handleChange}
                  />
                </div>
              </div>
              <div className="auth-field">
                <label className="auth-field__label" htmlFor="reg-lastname">{t('lastname')}</label>
                <div className="auth-input">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
                  </svg>
                  <input
                    id="reg-lastname"
                    name="lastname"
                    type="text"
                    placeholder={t('lastnamePh')}
                    autoComplete="family-name"
                    required
                    value={form.lastname}
                    onChange={handleChange}
                  />
                </div>
              </div>
            </div>

            <div className="auth-field">
              <label className="auth-field__label" htmlFor="reg-email">{t('email')}</label>
              <div className="auth-input">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M3 7l9 6 9-6" />
                </svg>
                <input
                  id="reg-email"
                  name="email"
                  type="email"
                  placeholder="saif@gmail.com"
                  autoComplete="email"
                  required
                  dir="ltr"
                  value={form.email}
                  onChange={handleChange}
                />
              </div>
            </div>

            <div className="auth-field">
              <label className="auth-field__label" htmlFor="reg-phone">{t('phone')}</label>
              <div className="auth-input auth-input--phone" dir="ltr">
                <span className="auth-input__prefix" aria-hidden="true">🇹🇳</span>
                <input
                  id="reg-country-code"
                  name="countryCode"
                  type="text"
                  inputMode="tel"
                  placeholder="+216"
                  autoComplete="tel-country-code"
                  maxLength={5}
                  value={form.countryCode}
                  onChange={handleChange}
                  className="auth-input__cc"
                />
                <span className="auth-input__divider" aria-hidden="true" />
                <input
                  id="reg-phone"
                  name="phoneLocal"
                  type="tel"
                  inputMode="tel"
                  placeholder={t('phonePh')}
                  autoComplete="tel"
                  maxLength={15}
                  value={form.phoneLocal}
                  onChange={handleChange}
                />
              </div>
              {phonePreview ? (
                <div className="auth-hint" aria-live="polite">
                  {t('phonePreviewLabel')} <strong dir="ltr">{phonePreview}</strong>
                </div>
              ) : null}
            </div>

            <div className="auth-field">
              <label className="auth-field__label" htmlFor="reg-password">{t('password')}</label>
              <div className="auth-input">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <rect x="4" y="11" width="16" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 1 1 8 0v4" />
                </svg>
                <input
                  id="reg-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t('passwordPh')}
                  autoComplete="new-password"
                  required
                  dir="ltr"
                  value={form.password}
                  onChange={handleChange}
                />
                <button
                  type="button"
                  className="auth-input__suffix"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t('hidePwdAria') : t('showPwdAria')}
                >
                  {showPassword ? t('hidePwd') : t('showPwd')}
                </button>
              </div>
              {form.password ? (
                <>
                  <div className={`auth-strength is-w${pwStrength}`} aria-hidden="true">
                    <span /><span /><span /><span />
                  </div>
                  <div className="auth-strength-hint">{strengthLabel}</div>
                </>
              ) : null}
            </div>

            <div className="auth-field">
              <label className="auth-field__label" htmlFor="reg-confirm">{t('confirmPwd')}</label>
              <div className="auth-input">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <rect x="4" y="11" width="16" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 1 1 8 0v4" />
                </svg>
                <input
                  id="reg-confirm"
                  name="confirm"
                  type={showConfirm ? 'text' : 'password'}
                  placeholder={t('confirmPh')}
                  autoComplete="new-password"
                  required
                  dir="ltr"
                  value={form.confirm}
                  onChange={handleChange}
                />
                <button
                  type="button"
                  className="auth-input__suffix"
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? t('hidePwdAria') : t('showPwdAria')}
                >
                  {showConfirm ? t('hidePwd') : t('showPwd')}
                </button>
              </div>
            </div>

            <div className="auth-tos">
              {tos[0]}<a href="#/terms" onClick={(e) => e.preventDefault()}>{tos[1]}</a>{tos[2]}<a href="#/privacy" onClick={(e) => e.preventDefault()}>{tos[3]}</a>{tos[4]}
            </div>

            <button type="submit" className="auth-btn auth-btn--primary" disabled={loading}>
              {loading ? t('registerPending') : (
                <>
                  {t('registerBtn')}
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden style={{ transform: dir === 'rtl' ? 'scaleX(-1)' : 'none' }}>
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </>
              )}
            </button>

            {loading ? (
              <p className="auth-status" role="status" aria-live="polite">{t('registerPending')}</p>
            ) : null}
          </form>
        </div>

        <div className="auth-pane__foot">
          <div>{t('footCopy', { year: new Date().getFullYear() })}</div>
          <div className="auth-pane__foot-links">
            <a href="#/privacy" onClick={(e) => e.preventDefault()}>{t('privacy')}</a>
            <a href="#/terms" onClick={(e) => e.preventDefault()}>{t('terms')}</a>
            <a href="#/help" onClick={(e) => e.preventDefault()}>{t('help')}</a>
          </div>
        </div>
      </section>
    </main>
  )
}
