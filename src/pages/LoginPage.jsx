import { useRef, useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { useAuthLocale } from './authLocale.js'
import headerLogo from '../../logo-header2.png'
import './auth.css'

export default function LoginPage() {
  const navigate = useNavigate()
  const { loading: authLoading, ready, isAuthenticated, adminUser, clientProfile, login } = useAuth()
  const { t, dir, lang } = useAuthLocale()
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ email: '', password: '' })
  // Plan 04 §3.7 — hold the login result until AuthContext commits the new
  // session state. This avoids the one-frame spinner flash (and potential
  // redirect ping-pong) caused by navigating before `isAuthenticated` flips.
  const [loginResult, setLoginResult] = useState(null)
  // FE-C1 — ref-based guard against double-submit.
  const submittingRef = useRef(false)

  // Trust a fresh successful login result first — login() only returns
  // ok=true AFTER syncSession has resolved at least one profile, so the
  // redirect is safe even if React hasn't yet flushed the AuthContext
  // state into our subscribed value. Waiting for `adminUser || clientProfile`
  // to flip here caused a user-visible bounce: the onAuthStateChange
  // listener fires a second syncSession on SIGNED_IN, and if that second
  // call races to null profiles (transient RLS/network hiccup), hardLogout
  // runs and the user ends up back at /login. Navigating on the result
  // avoids that whole window.
  if (loginResult?.ok) {
    return <Navigate to={loginResult.redirectTo || '/dashboard'} replace />
  }
  if (ready && isAuthenticated && (adminUser || clientProfile)) {
    return <Navigate to="/dashboard" replace />
  }

  function handleChange(e) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
    setError('')
    setSubmitting(true)
    try {
      const result = await login(form.email, form.password)
      if (!result.ok) {
        setError(result.error || t('loginError'))
        return
      }
      setLoginResult(result)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const pendingAuthFlush = Boolean(loginResult?.ok) && !(ready && isAuthenticated && (adminUser || clientProfile))
  const submitPending = submitting || pendingAuthFlush

  if (authLoading && !loginResult) {
    return (
      <main className="auth-page auth-page--solo" lang={lang} dir={dir}>
        <section className="auth-pane">
          <div className="auth-form-wrap" aria-busy="true" aria-live="polite">
            <p className="auth-status">{t('sessionCheck')}</p>
          </div>
        </section>
      </main>
    )
  }

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
            <button type="button" className="is-active" role="tab" aria-selected="true">{t('tabLogin')}</button>
            <button type="button" role="tab" aria-selected="false" onClick={() => navigate('/register')}>{t('tabRegister')}</button>
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

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <div className="auth-field">
              <label className="auth-field__label" htmlFor="login-email">{t('email')}</label>
              <div className="auth-input">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M3 7l9 6 9-6" />
                </svg>
                <input
                  id="login-email"
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
              <label className="auth-field__label" htmlFor="login-password">{t('password')}</label>
              <div className="auth-input">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <rect x="4" y="11" width="16" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 1 1 8 0v4" />
                </svg>
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••"
                  autoComplete="current-password"
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
            </div>

            <div className="auth-opts">
              <label className="auth-check">
                <input type="checkbox" defaultChecked />
                {t('keepLogged')}
              </label>
              <button type="button" className="auth-forgot" onClick={() => navigate('/forgot-password')}>
                {t('forgotPwd')}
              </button>
            </div>

            <button type="submit" className="auth-btn auth-btn--primary" disabled={submitPending}>
              {submitPending ? t('loginPending') : (
                <>
                  {t('loginBtn')}
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden style={{ transform: dir === 'rtl' ? 'scaleX(-1)' : 'none' }}>
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </>
              )}
            </button>

            {pendingAuthFlush ? (
              <p className="auth-status" role="status" aria-live="polite">{t('loginPending')}</p>
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
