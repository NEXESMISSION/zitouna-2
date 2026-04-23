import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DashboardShell from '../components/DashboardShell.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
import {
  fetchMyPhoneChangeRequest,
  submitPhoneChangeRequest,
} from '../lib/db.js'
import './dashboard-page.css'
import './my-profile-page.css'

/*
 * /my/profile — standalone profile page.
 *
 *   Replaces the old popup inside DashboardPage. Uses the DashboardShell
 *   (sidebar + topbar) like the other /my/* pages. Profile fields are shown
 *   on the left card, phone-change flow on the right card. On mobile the
 *   two cards stack.
 *
 *   Phone changes still require admin review — the CTA opens an inline
 *   form view, and on submit we show a success confirmation.
 */

export default function MyProfilePage() {
  const navigate = useNavigate()
  const { user, adminUser, refreshAuth } = useAuth()

  const [profileForm, setProfileForm] = useState({})
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')
  const [profileMsgKind, setProfileMsgKind] = useState('info') // 'info' | 'err' | 'ok'

  // Phone-change state — same state machine as the old modal:
  //   'idle' — phone card with status + CTA
  //   'form' — inline change-phone form
  //   'success' — post-submit confirmation
  const [phoneChange, setPhoneChange] = useState({
    view: 'idle',
    cc: '+216',
    local: '',
    reason: '',
    saving: false,
    error: '',
    request: null,
    loading: false,
    successPhone: '',
  })

  const loadMyPhoneChangeRequest = useCallback(async () => {
    try {
      setPhoneChange((p) => ({ ...p, loading: true }))
      const req = await fetchMyPhoneChangeRequest()
      setPhoneChange((p) => ({ ...p, request: req || null, loading: false }))
    } catch (err) {
      console.warn('[my-profile] fetchMyPhoneChangeRequest:', err?.message || err)
      setPhoneChange((p) => ({ ...p, loading: false }))
    }
  }, [])

  useEffect(() => {
    loadMyPhoneChangeRequest()
  }, [loadMyPhoneChangeRequest])

  const profileFields = useMemo(() => {
    const u = user || {}
    const adm = adminUser || {}
    const nameParts = (adm.name || '').split(/\s+/)
    const admFirst = nameParts.length >= 2 ? nameParts.slice(0, -1).join(' ') : (adm.name || '')
    const admLast = nameParts.length >= 2 ? nameParts[nameParts.length - 1] : ''
    const approvedPhone = phoneChange.request?.status === 'approved'
      ? (phoneChange.request.requested_phone || '')
      : ''
    return [
      { key: 'firstname', label: 'Prénom', value: admFirst || u.firstname || '' },
      { key: 'lastname', label: 'Nom', value: admLast || u.lastname || '' },
      { key: 'email', label: 'Email', value: adm.email || u.email || '', locked: true },
      { key: 'phone', label: 'Téléphone', value: approvedPhone || adm.phone || u.phone || '', locked: true },
    ]
  }, [user, adminUser, phoneChange.request])

  // Hydrate editable form fields once profile values are known / change.
  useEffect(() => {
    const init = {}
    for (const f of profileFields) init[f.key] = f.value
    setProfileForm(init)
  }, [profileFields])

  const phoneChangePreview = (() => {
    const ccDigits = String(phoneChange.cc || '').replace(/\D/g, '')
    const localDigits = String(phoneChange.local || '').replace(/\D/g, '')
    if (!ccDigits || !localDigits) return ''
    return `+${ccDigits}${localDigits}`
  })()

  const openPhoneChangeForm = useCallback(() => {
    setPhoneChange((p) => ({
      ...p, view: 'form', local: '', reason: '', error: '',
      cc: p.cc || '+216',
    }))
  }, [])

  const cancelPhoneChangeForm = useCallback(() => {
    setPhoneChange((p) => ({ ...p, view: 'idle', error: '' }))
  }, [])

  const dismissPhoneChangeSuccess = useCallback(() => {
    setPhoneChange((p) => ({ ...p, view: 'idle', successPhone: '' }))
  }, [])

  const handleSubmitPhoneChange = useCallback(async () => {
    const e164 = phoneChangePreview
    const localDigits = String(phoneChange.local || '').replace(/\D/g, '')
    if (localDigits.length < 6) {
      setPhoneChange((p) => ({ ...p, error: 'Le numéro local doit contenir au moins 6 chiffres.' }))
      return
    }
    if (!e164) {
      setPhoneChange((p) => ({ ...p, error: 'Numéro invalide.' }))
      return
    }
    setPhoneChange((p) => ({ ...p, saving: true, error: '' }))
    try {
      await submitPhoneChangeRequest({ newPhone: e164, reason: phoneChange.reason || '' })
      setPhoneChange((p) => ({
        ...p, saving: false, view: 'success',
        successPhone: e164, local: '', reason: '', error: '',
      }))
      await loadMyPhoneChangeRequest()
    } catch (err) {
      const raw = String(err?.message || err || '')
      let error = raw
      if (/PHONE_UNCHANGED/i.test(raw)) error = 'Le nouveau numéro est identique à l\'actuel.'
      else if (/PHONE_TAKEN/i.test(raw)) error = 'Ce numéro est déjà utilisé par un autre compte. Choisissez-en un autre.'
      else if (/INVALID_PHONE/i.test(raw)) error = 'Numéro invalide.'
      else if (/NOT_AUTHENTICATED/i.test(raw)) error = 'Session expirée : reconnectez-vous.'
      setPhoneChange((p) => ({ ...p, saving: false, error }))
    }
  }, [phoneChangePreview, phoneChange.local, phoneChange.reason, loadMyPhoneChangeRequest])

  const handleProfileSave = useCallback(async () => {
    setProfileSaving(true)
    setProfileMsg('')
    setProfileMsgKind('info')
    try {
      const meta = {}
      let changed = false
      for (const f of profileFields) {
        if (f.locked) continue
        const original = f.value || ''
        const current = (profileForm[f.key] || '').trim()
        // Same rule as the old modal: we only allow filling in missing values
        // (auth metadata isn't a free-edit field — phone + email go through
        // their own flows).
        if (!original && current) {
          meta[f.key] = current
          changed = true
        }
      }
      if (!changed) {
        setProfileMsg('Aucune modification à enregistrer.')
        setProfileMsgKind('info')
        setProfileSaving(false)
        return
      }
      if (meta.firstname || meta.lastname) {
        const fn = meta.firstname || profileForm.firstname || ''
        const ln = meta.lastname || profileForm.lastname || ''
        meta.name = `${fn} ${ln}`.trim()
      }
      const { error } = await supabase.auth.updateUser({ data: meta })
      if (error) throw error
      refreshAuth()
      setProfileMsg('Profil mis à jour.')
      setProfileMsgKind('ok')
    } catch (e) {
      setProfileMsg(e?.message || 'Erreur.')
      setProfileMsgKind('err')
    } finally {
      setProfileSaving(false)
    }
  }, [profileFields, profileForm, refreshAuth])

  const currentPhone = profileFields.find((f) => f.key === 'phone')?.value || ''
  const localDigits = String(phoneChange.local || '').replace(/\D/g, '')
  const canSubmitPhone = localDigits.length >= 6 && !phoneChange.saving

  return (
    <DashboardShell active="profile">
      <div className="zb-greeting">
        <div className="zb-greeting-sub">Compte</div>
        <h1 className="zb-greeting-title">Mon profil</h1>
      </div>

      <div className="mp-grid">
        {/* ── Identité ─────────────────────────────────────────────── */}
        <section className="zb-card mp-card">
          <header className="mp-card-head">
            <div className="mp-card-head-ic" aria-hidden>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>
            </div>
            <div>
              <h2 className="mp-card-title">Identité</h2>
              <p className="mp-card-sub">Ces informations figurent sur vos documents.</p>
            </div>
          </header>

          <div className="mp-fields">
            {profileFields.map((f) => {
              const original = f.value || ''
              const isLocked = f.locked || Boolean(original)
              return (
                <div key={f.key} className="mp-field">
                  <label className="mp-label" htmlFor={`mp-${f.key}`}>{f.label}</label>
                  <div className="mp-input-wrap">
                    <input
                      id={`mp-${f.key}`}
                      type={f.key === 'email' ? 'email' : 'text'}
                      className={`mp-input${isLocked ? ' mp-input--locked' : ''}`}
                      value={profileForm[f.key] ?? f.value ?? ''}
                      readOnly={isLocked}
                      dir={f.key === 'phone' || f.key === 'email' ? 'ltr' : undefined}
                      placeholder={isLocked ? '—' : `Saisir ${f.label.toLowerCase()}…`}
                      onChange={(e) => {
                        if (isLocked) return
                        setProfileForm((p) => ({ ...p, [f.key]: e.target.value }))
                      }}
                    />
                    {isLocked && (
                      <span className="mp-lock" aria-hidden title="Champ protégé">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {profileMsg && (
            <p className={`mp-msg mp-msg--${profileMsgKind}`}>{profileMsg}</p>
          )}

          <div className="mp-card-actions">
            <button
              type="button"
              className="zb-btn zb-btn-ghost"
              onClick={() => navigate('/dashboard')}
              disabled={profileSaving}
            >
              Retour
            </button>
            <button
              type="button"
              className="zb-btn zb-btn-primary"
              onClick={handleProfileSave}
              disabled={profileSaving}
            >
              {profileSaving ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="mp-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  Enregistrement…
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Enregistrer
                </>
              )}
            </button>
          </div>
        </section>

        {/* ── Phone-change ─────────────────────────────────────────── */}
        <section className="zb-card mp-card">
          <header className="mp-card-head">
            <div className="mp-card-head-ic mp-card-head-ic--gold" aria-hidden>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 5.55 5.55l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            </div>
            <div>
              <h2 className="mp-card-title">Numéro de téléphone</h2>
              <p className="mp-card-sub">Un administrateur valide chaque changement.</p>
            </div>
          </header>

          {phoneChange.view === 'idle' && (
            <>
              {currentPhone && (
                <div className="mp-phone-current">
                  <span className="mp-phone-current-k">Numéro actuel</span>
                  <span className="mp-phone-current-v" dir="ltr">{currentPhone}</span>
                </div>
              )}

              {phoneChange.request?.status === 'pending' && (
                <div className="mp-status mp-status--pending">
                  <strong>Demande en cours</strong>
                  <span>Nouveau numéro : <span dir="ltr">{phoneChange.request.requested_phone}</span></span>
                  <span className="mp-status-note">En attente de validation par un administrateur.</span>
                </div>
              )}
              {phoneChange.request?.status === 'approved' && (
                <div className="mp-status mp-status--approved">
                  <strong>Dernière demande approuvée</strong>
                  <span>Numéro actuel : <span dir="ltr">{phoneChange.request.requested_phone}</span></span>
                </div>
              )}
              {phoneChange.request?.status === 'rejected' && (
                <div className="mp-status mp-status--rejected">
                  <strong>Dernière demande refusée</strong>
                  {phoneChange.request.reviewer_note && (
                    <span className="mp-status-note">Motif : {phoneChange.request.reviewer_note}</span>
                  )}
                </div>
              )}

              <div className="mp-card-actions mp-card-actions--end">
                <button
                  type="button"
                  className="zb-btn zb-btn-primary"
                  onClick={openPhoneChangeForm}
                  disabled={phoneChange.request?.status === 'pending'}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                  {phoneChange.request?.status === 'pending'
                    ? 'En attente de validation…'
                    : phoneChange.request?.status === 'rejected'
                      ? 'Nouvelle demande'
                      : phoneChange.request?.status === 'approved'
                        ? 'Demander un nouveau changement'
                        : 'Changer le numéro'}
                </button>
              </div>
            </>
          )}

          {phoneChange.view === 'form' && (
            <div className="mp-phone-form">
              <label className="mp-label" htmlFor="mp-phone-cc">Nouveau numéro</label>
              <div className="mp-phone-row">
                <input
                  id="mp-phone-cc"
                  type="text"
                  dir="ltr"
                  className="mp-input mp-phone-cc"
                  value={phoneChange.cc}
                  placeholder="+216"
                  maxLength={5}
                  aria-label="Indicatif pays"
                  onChange={(e) => {
                    const digits = String(e.target.value || '').replace(/\D/g, '').slice(0, 4)
                    setPhoneChange((p) => ({ ...p, cc: digits ? `+${digits}` : '+' }))
                  }}
                />
                <input
                  type="tel"
                  dir="ltr"
                  className="mp-input mp-phone-local"
                  placeholder="Numéro local"
                  maxLength={15}
                  value={phoneChange.local}
                  aria-label="Numéro local"
                  onChange={(e) => {
                    // Strip a duplicated country-code if the user pastes a
                    // full international form into the local input.
                    const raw = String(e.target.value || '')
                    const hasIntlPrefix = /^\s*(\+|00)/.test(raw)
                    let digits = raw.replace(/\D/g, '')
                    const ccDigits = String(phoneChange.cc || '').replace(/\D/g, '')
                    if (hasIntlPrefix && ccDigits && digits.startsWith(ccDigits) && digits.length > ccDigits.length) {
                      digits = digits.slice(ccDigits.length)
                    }
                    setPhoneChange((p) => ({ ...p, local: digits.slice(0, 15), error: '' }))
                  }}
                />
              </div>
              {phoneChangePreview && (
                <div className="mp-phone-preview">
                  Sera enregistré : <strong dir="ltr">{phoneChangePreview}</strong>
                </div>
              )}

              <label className="mp-label" htmlFor="mp-phone-reason" style={{ marginTop: 12 }}>
                Motif (optionnel)
              </label>
              <textarea
                id="mp-phone-reason"
                className="mp-input mp-textarea"
                rows={3}
                placeholder="Pourquoi voulez-vous changer de numéro ?"
                value={phoneChange.reason}
                onChange={(e) => setPhoneChange((p) => ({ ...p, reason: e.target.value }))}
              />

              {phoneChange.error && (
                <p className="mp-msg mp-msg--err">{phoneChange.error}</p>
              )}

              <div className="mp-card-actions">
                <button
                  type="button"
                  className="zb-btn zb-btn-ghost"
                  onClick={cancelPhoneChangeForm}
                  disabled={phoneChange.saving}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  className="zb-btn zb-btn-primary"
                  onClick={handleSubmitPhoneChange}
                  disabled={!canSubmitPhone}
                >
                  {phoneChange.saving ? 'Envoi…' : 'Envoyer la demande'}
                </button>
              </div>
            </div>
          )}

          {phoneChange.view === 'success' && (
            <div className="mp-phone-success">
              <div className="mp-phone-success-ic" aria-hidden>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </div>
              <h3 className="mp-phone-success-title">Demande envoyée</h3>
              <p className="mp-phone-success-desc">
                Un administrateur examinera votre demande. Votre numéro actuel reste valide jusqu&apos;à la validation.
              </p>
              {phoneChange.successPhone && (
                <div className="mp-phone-success-summary">
                  <span>Nouveau numéro demandé</span>
                  <strong dir="ltr">{phoneChange.successPhone}</strong>
                </div>
              )}
              <button
                type="button"
                className="zb-btn zb-btn-primary"
                onClick={dismissPhoneChangeSuccess}
              >
                Retour au profil
              </button>
            </div>
          )}
        </section>
      </div>
    </DashboardShell>
  )
}
