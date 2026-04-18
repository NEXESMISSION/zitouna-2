import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase.js'
import { ensureCurrentClientProfile, fetchAuthAdminProfile, fetchAuthClientProfile, normalizeCountryCode, normalizePhoneLocal, upsertClient, upsertClientPhoneIdentity } from './db.js'
import {
  canAccessAdminPath,
  canClientAccessAdminPath,
  isClientSuspended,
  isStaffSuspended,
} from './adminAccess.js'

const AuthContext = createContext(null)

function isExpectedNoSessionError(errorLike) {
  const msg = String(errorLike?.message || errorLike || '').toLowerCase()
  return msg.includes('auth session missing') || msg.includes('session missing') || msg.includes('no verified user')
}

/**
 * Await a promise with a hard cap. If it doesn't settle within `ms`, reject
 * with an Error tagged by `label`. Used throughout AuthContext to ensure no
 * single Supabase call can make the whole auth flow hang indefinitely.
 */
function withAuthTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`auth_timeout:${label}`)), ms)),
  ])
}

function isTransientAuthLockError(errorLike) {
  const name = String(errorLike?.name || '')
  const msg = String(errorLike?.message || errorLike || '').toLowerCase()
  return (
    name === 'NavigatorLockAcquireTimeoutError'
    || name === 'AbortError'
    || msg.includes('navigatorlock')
    || msg.includes('lock broken')
    || msg.includes('orphaned lock')
    || msg.includes('steal')
  )
}

function extractUser(supabaseUser) {
  if (!supabaseUser) return null
  const md = supabaseUser.user_metadata || {}
  const name =
    md.name ||
    [md.firstname || md.first_name, md.lastname || md.last_name].filter(Boolean).join(' ').trim() ||
    supabaseUser.email ||
    'User'
  return {
    id: supabaseUser.id,
    email: supabaseUser.email || '',
    firstname: md.firstname || md.first_name || '',
    lastname: md.lastname || md.last_name || '',
    name,
    phone: md.phone || '',
  }
}

async function resolveProfiles(authUser) {
  if (!authUser?.id) return { admin: null, client: null, error: null, profileStatus: null }

  const email = (authUser.email || '').trim().toLowerCase()

  // Fetch both profiles. A single user can legitimately be staff AND a buyer
  // (hybrid account): returning the client row alongside admin lets the buyer
  // dashboard still display their portfolio and parrainage wallet.
  const [admin, initialClient] = await Promise.all([
    fetchAuthAdminProfile(email),
    fetchAuthClientProfile(authUser.id),
  ])

  // Staff / hybrid accounts: run the same heal pipeline as a buyer so phone
  // identities, stub re-attachment, and commission migration also apply.
  // Previously the admin short-circuit meant a staff user who also bought a
  // parcel never got their buyer profile rebuilt → Parrainage stayed blocked.
  if (admin) {
    let client = initialClient && !initialClient.__profileError ? initialClient : null
    let profileStatus = null
    let healMigrated = null
    let healError = null
    try {
      const healed = await ensureCurrentClientProfile()
      healMigrated = healed?.migrated || null
      if (healed && !healed.ok) {
        profileStatus = {
          reason: healed.reason || 'unknown',
          ambiguous: healed.ambiguous,
          phoneConflict: healed.phoneConflict,
          migrated: healed.migrated || null,
        }
      }
      const refreshed = await fetchAuthClientProfile(authUser.id)
      if (refreshed && !refreshed.__profileError) client = refreshed
      else if (refreshed?.__profileError) healError = refreshed.message || null
    } catch (e) {
      // A thrown RPC is a real technical failure — never swallow it as
      // "admin has no buyer profile", that would mask session / RLS / network
      // problems. Surface as rpc_error so the dashboard shows red with detail.
      console.warn('resolveProfiles[admin] ensureCurrentClientProfile failed:', e?.message || e)
      healError = String(e?.message || e)
    }
    if (healError && !profileStatus) {
      profileStatus = { reason: 'rpc_error', message: healError, migrated: healMigrated }
    }

    const healBlocksAutoLink =
      Boolean(profileStatus?.reason) &&
      ['ambiguous_client_profile', 'phone_conflict', 'rpc_error', 'not_authenticated'].includes(
        profileStatus.reason,
      )

    // Same fallback as the pure-buyer path: if heal did not attach a row but
    // metadata has phone/email, create/link via upsert so hybrid staff accounts
    // still get a buyer profile without an infinite "admin_no_buyer_profile".
    if (!client && !healBlocksAutoLink) {
      try {
        const md = authUser.user_metadata || {}
        const fullName =
          md.name ||
          [md.firstname || md.first_name, md.lastname || md.last_name].filter(Boolean).join(' ').trim() ||
          authUser.email ||
          'Client'
        const phoneRaw = String(md.phone || '').trim()
        const cc = normalizeCountryCode(phoneRaw.startsWith('+') ? phoneRaw.replace(/(\+\d{1,3}).*$/, '$1') : '+216')
        const local = normalizePhoneLocal(phoneRaw)
        const savedClient = await upsertClient({
          authUserId: authUser.id,
          name: fullName,
          email: authUser.email || null,
          phone: phoneRaw || (cc && local ? `${cc}${local}` : ''),
          phoneCountryCode: cc,
          phoneLocal: local,
        })
        if (savedClient?.id && cc && local) {
          await upsertClientPhoneIdentity({
            countryCode: cc,
            phoneLocal: local,
            clientId: savedClient.id,
            authUserId: authUser.id,
            verificationStatus: 'verified',
            verificationReason: null,
          })
        }
        const linked = await fetchAuthClientProfile(authUser.id)
        if (linked && !linked.__profileError) client = linked
      } catch (e) {
        console.warn('resolveProfiles[admin] auto-link failed:', e?.message || e)
      }
    }

    // Staff session with no buyer profile AND heal ran cleanly → legitimate
    // "nothing linked yet" state. Attach migrated counters so support sees
    // exactly what the heal touched (or didn't) on this login.
    if (!client && !profileStatus) {
      profileStatus = {
        reason: 'admin_no_buyer_profile',
        ambiguous: false,
        phoneConflict: false,
        migrated: healMigrated,
      }
    }
    return { admin, client, error: null, profileStatus }
  }

  let client = initialClient
  let profileStatus = null

  if (client?.__profileError) {
    return {
      admin: null, client: null,
      error: client.message || 'Erreur base de données',
      profileStatus: { reason: 'rpc_error', message: client.message || null },
    }
  }

  // Replay server-side heal on every session resolve: links phone identities and re-attaches
  // `sales` / `installment_plans` / `commission_events` that still point at a pre-signup stub
  // `clients` row. Returns a structured result we surface to the UI for diagnostics.
  try {
    const healed = await ensureCurrentClientProfile()
    if (healed && !healed.ok) {
      profileStatus = {
        reason: healed.reason || 'unknown',
        ambiguous: healed.ambiguous,
        phoneConflict: healed.phoneConflict,
        migrated: healed.migrated || null,
      }
    } else if (healed?.migrated) {
      // Successful heal — still attach counters so the dashboard can show
      // "Heal a rattaché N vente(s)" if non-zero migrations happened.
      profileStatus = { reason: null, migrated: healed.migrated }
    }
    const refreshed = await fetchAuthClientProfile(authUser.id)
    if (refreshed && !refreshed.__profileError) {
      client = refreshed
    } else if (refreshed?.__profileError) {
      console.warn('resolveProfiles post-ensure client fetch:', refreshed.message)
    }
  } catch (e) {
    console.warn('resolveProfiles ensureCurrentClientProfile failed:', e?.message || e)
    profileStatus = { reason: 'rpc_error', message: String(e?.message || e) }
  }

  if (!client) {
    // Auto-heal profile linking after registration/login:
    // if auth exists but client row is missing, attempt to create/link by auth + email + phone.
    try {
      const md = authUser.user_metadata || {}
      const fullName =
        md.name ||
        [md.firstname || md.first_name, md.lastname || md.last_name].filter(Boolean).join(' ').trim() ||
        authUser.email ||
        'Client'
      const phoneRaw = String(md.phone || '').trim()
      const cc = normalizeCountryCode(phoneRaw.startsWith('+') ? phoneRaw.replace(/(\+\d{1,3}).*$/, '$1') : '+216')
      const local = normalizePhoneLocal(phoneRaw)
      const savedClient = await upsertClient({
        authUserId: authUser.id,
        name: fullName,
        email: authUser.email || null,
        phone: phoneRaw || (cc && local ? `${cc}${local}` : ''),
        phoneCountryCode: cc,
        phoneLocal: local,
      })
      if (savedClient?.id && cc && local) {
        await upsertClientPhoneIdentity({
          countryCode: cc,
          phoneLocal: local,
          clientId: savedClient.id,
          authUserId: authUser.id,
          verificationStatus: 'verified',
          verificationReason: null,
        })
      }
      client = await fetchAuthClientProfile(authUser.id)
    } catch (e) {
      console.warn('resolveProfiles auto-link failed:', e?.message || e)
    }
  }

  // If no admin/client profile is resolvable, caller decides whether to logout.
  return { admin: null, client: client || null, error: null, profileStatus }
}

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState(null)
  const [adminUser, setAdminUser] = useState(null)
  const [clientProfile, setClientProfile] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [profileStatus, setProfileStatus] = useState(null)
  const initDone = useRef(false)
  const registrationInProgressRef = useRef(false)

  const clearState = useCallback(() => {
    setUser(null)
    setAdminUser(null)
    setClientProfile(null)
    setAuthError(null)
    setProfileStatus(null)
  }, [])

  const hardLogout = useCallback(async (reason = '') => {
    try {
      if (reason) console.warn(`[auth] force signOut: ${reason}`)
      // This clears the persisted session in local storage as well.
      await supabase.auth.signOut()
    } catch (e) {
      console.warn('[auth] signOut failed (continuing):', e?.message || e)
    } finally {
      clearState()
    }
  }, [clearState])

  const syncSession = useCallback(async (supabaseUser) => {
    if (!supabaseUser) {
      clearState()
      return { admin: null, client: null, profileStatus: null }
    }
    setUser(extractUser(supabaseUser))
    const { admin, client, error, profileStatus: ps } = await resolveProfiles(supabaseUser)
    setAdminUser(admin)
    setClientProfile(client)
    setAuthError(error)
    setProfileStatus(ps || null)
    return { admin, client, profileStatus: ps || null }
  }, [clearState])

  useEffect(() => {
    let active = true
    let validateTimer = null

    async function init(allowLockRetry = true) {
      try {
        // IMPORTANT: do not trust cached getSession() after DB resets or user deletion.
        // getUser() validates the JWT against Supabase and returns null if invalid.
        const { data: { user: verifiedUser }, error: userErr } = await supabase.auth.getUser()
        if (!active) return
        if (userErr || !verifiedUser) {
          // Normal case for visitors: no active session. Avoid noisy forced-logout logs.
          clearState()
          return
        }

        const { admin, client } = await syncSession(verifiedUser)
          if (admin && isStaffSuspended(admin)) {
            await hardLogout('staff suspended')
          } else if (client && isClientSuspended(client)) {
            await hardLogout('client suspended')
          } else if (!admin && !client) {
            await hardLogout('session exists but no profile found')
          }
      } catch (e) {
        console.error('auth init error:', e)
        if (allowLockRetry && active && isTransientAuthLockError(e)) {
          await new Promise((r) => setTimeout(r, 200))
          if (active) {
            await init(false)
            return
          }
        }
        if (active) await hardLogout(e?.message || 'init error')
      } finally {
        if (active) {
          initDone.current = true
          setLoading(false)
        }
      }
    }

    init()

    // Periodically revalidate auth with the server to avoid "stuck logged-in"
    // when tokens are revoked / user is deleted / DB was reset.
    validateTimer = window.setInterval(async () => {
      if (!active || !initDone.current) return
      try {
        const { data: { user: verifiedUser }, error } = await supabase.auth.getUser()
        if (error || !verifiedUser) {
          if (isExpectedNoSessionError(error)) {
            clearState()
            return
          }
          await hardLogout(error?.message || 'periodic getUser returned no user')
        }
      } catch (e) {
        if (isExpectedNoSessionError(e)) {
          clearState()
          return
        }
        await hardLogout(e?.message || 'periodic validation error')
      }
    }, 60_000)

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!active || !initDone.current) return

      if (event === 'SIGNED_OUT' || !session?.user) {
        clearState()
        return
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        // Extra safety: validate server-side user before trusting session cache.
        const { data: { user: verifiedUser }, error: userErr } = await supabase.auth.getUser()
        if (userErr || !verifiedUser) {
          if (isExpectedNoSessionError(userErr)) {
            clearState()
            return
          }
          await hardLogout(userErr?.message || `auth event ${event}: no verified user`)
          return
        }

        const { admin, client } = await syncSession(verifiedUser)
        if (admin && isStaffSuspended(admin)) {
          await hardLogout('staff suspended')
        } else if (client && isClientSuspended(client)) {
          await hardLogout('client suspended')
        } else if (!admin && !client) {
          // During registration, SIGNED_IN can fire before the client profile row is inserted.
          if (registrationInProgressRef.current && event === 'SIGNED_IN') return
          // Session exists but no resolved application profile => treat as "no access" and logout.
          await hardLogout(`no profile found (${event})`)
        }
      }
    })

    return () => {
      active = false
      if (validateTimer) window.clearInterval(validateTimer)
      subscription?.unsubscribe?.()
    }
  }, [syncSession, clearState, hardLogout])

  const login = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: String(email || '').trim(),
      password: String(password || ''),
    })

    if (error) return { ok: false, error: error.message }
    if (!data?.user) return { ok: false, error: 'Réponse inattendue du serveur.' }

    const { admin, client, error: profileErr } = await syncSession(data.user)

    if (admin && isStaffSuspended(admin)) {
      await supabase.auth.signOut()
      clearState()
      return { ok: false, error: 'Ce compte est suspendu. Contactez un administrateur.' }
    }

    if (client && isClientSuspended(client)) {
      await supabase.auth.signOut()
      clearState()
      return { ok: false, error: "Ce compte est suspendu. Contactez l'administration." }
    }

    if (!admin && !client) {
      // Retry server-side auto-link once before returning "profil introuvable".
      try {
        await ensureCurrentClientProfile()
        const retried = await syncSession(data.user)
        if (retried?.admin || retried?.client) {
          const redirectTo = retried.admin ? '/admin' : '/dashboard'
          return { ok: true, redirectTo }
        }
      } catch (healErr) {
        console.warn('login ensureCurrentClientProfile failed:', healErr?.message || healErr)
      }
      if (profileErr) {
        return { ok: false, error: `Erreur de profil : ${profileErr}` }
      }
      return { ok: false, error: 'Profil introuvable. Veuillez vous inscrire ou contactez le support.' }
    }

    const redirectTo = admin ? '/admin' : '/dashboard'
    return { ok: true, redirectTo }
  }, [syncSession, clearState])

  const register = useCallback(async ({ firstname, lastname, email, phone, countryCode, phoneLocal, password }) => {
    registrationInProgressRef.current = true
    const fullName = `${firstname} ${lastname}`.trim()
    const cc = normalizeCountryCode(countryCode || '+216')
    const local = normalizePhoneLocal(phoneLocal || phone || '')
    const phoneE164 = cc && local ? `${cc}${local}` : ''

    const { data, error } = await withAuthTimeout(
      supabase.auth.signUp({
        email,
        password,
        options: {
          data: { firstname, lastname, name: fullName, phone: phoneE164 },
        },
      }),
      10_000,
      'signUp',
    ).catch((e) => ({ data: null, error: e }))

    if (error) {
      registrationInProgressRef.current = false
      const msg = String(error.message || '').toLowerCase()
      let reason = 'signup_failed'
      if (msg.includes('already registered') || msg.includes('user already') || msg.includes('duplicate')) reason = 'email_conflict'
      else if (msg.includes('password')) reason = 'weak_password'
      else if (msg.includes('email')) reason = 'invalid_email'
      return { ok: false, reason, error: error.message }
    }

    const signedInUser = data?.user
    const session = data?.session

    if (signedInUser && session) {
      try {
        const savedClient = await withAuthTimeout(
          upsertClient({
            authUserId: signedInUser.id,
            name: fullName,
            email,
            phone: phoneE164,
            phoneCountryCode: cc,
            phoneLocal: local,
          }),
          6_000,
          'upsertClient',
        )
        if (cc && local) {
          await withAuthTimeout(
            upsertClientPhoneIdentity({
              countryCode: cc,
              phoneLocal: local,
              clientId: savedClient?.id || null,
              authUserId: signedInUser.id,
              verificationStatus: 'verified',
              verificationReason: null,
            }),
            6_000,
            'upsertClientPhoneIdentity',
          )
        }
      } catch (e) {
        console.error('register: upsertClient failed', e)
        if (e?.code === 'PHONE_LINK_CONFLICT') {
          try {
            if (cc && local) {
              await upsertClientPhoneIdentity({
                countryCode: cc,
                phoneLocal: local,
                authUserId: signedInUser.id,
                verificationStatus: 'pending_verification',
                verificationReason: 'signup_phone_conflict',
              })
            }
          } catch (pendingErr) {
            console.error('register: pending phone verification failed', pendingErr)
          }
          await supabase.auth.signOut()
          clearState()
          registrationInProgressRef.current = false
          return {
            ok: false,
            reason: 'phone_conflict',
            error:
              "Ce numero est deja associe a un autre compte. Une demande de verification a ete creee pour traitement administratif.",
          }
        }
        // Do not hard-fail registration on profile-write race/permission issues.
        // Try server-side self-heal and continue if profile becomes resolvable.
        try {
          const healed = await withAuthTimeout(ensureCurrentClientProfile(), 5_000, 'ensureCurrentClientProfile')
          if (healed?.reason === 'phone_conflict') {
            await supabase.auth.signOut()
            clearState()
            registrationInProgressRef.current = false
            return {
              ok: false,
              reason: 'phone_conflict',
              error: "Ce numéro est déjà lié à un autre compte. Contactez le support pour vérification.",
            }
          }
          const { admin, client } = await syncSession(signedInUser)
          registrationInProgressRef.current = false
          if (admin || client) {
            return { ok: true, needsConfirmation: false, redirectTo: '/dashboard' }
          }
        } catch (healErr) {
          console.warn('register: ensureCurrentClientProfile failed', healErr?.message || healErr)
        }
        registrationInProgressRef.current = false
        return {
          ok: false,
          reason: 'profile_unavailable',
          error:
            "Compte cree mais profil client encore indisponible. Connectez-vous ensuite et le rattachement automatique par telephone sera rejoue.",
        }
      }
      const { admin, client, error: profileErr } = await withAuthTimeout(
        syncSession(signedInUser), 6_000, 'syncSession',
      )
      registrationInProgressRef.current = false
      if (!admin && !client) {
        await supabase.auth.signOut()
        clearState()
        return {
          ok: false,
          error: profileErr
            ? `Erreur de profil: ${profileErr}`
            : "Inscription terminee, mais aucun profil applicatif n'a ete trouve. Verifiez les policies SQL.",
        }
      }
      return { ok: true, needsConfirmation: false, redirectTo: '/dashboard' }
    }

    if (signedInUser && !session) {
      registrationInProgressRef.current = false
      return { ok: true, needsConfirmation: true }
    }

    registrationInProgressRef.current = false
    return { ok: false, error: 'Inscription interrompue. Réessayez.' }
  }, [syncSession, clearState])

  const logout = useCallback(async () => {
    // signOut() can stall on a flaky network or orphaned nav lock — always
    // clear local state regardless so the UI doesn't appear still logged-in.
    try {
      await withAuthTimeout(supabase.auth.signOut(), 5_000, 'signOut')
    } catch (e) {
      console.warn('[auth] signOut failed or timed out — clearing state anyway:', e?.message || e)
    } finally {
      clearState()
    }
    return { ok: true }
  }, [clearState])

  const forgotPassword = useCallback(async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(
      String(email || '').trim(),
      { redirectTo: `${window.location.origin}/reset-password` },
    )
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  }, [])

  const resetPassword = useCallback(async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  }, [])

  const refreshAuth = useCallback(async () => {
    const { data: { user: freshUser }, error } = await supabase.auth.getUser()
    if (error || !freshUser) {
      clearState()
      return { ok: false, error: error?.message || 'Session introuvable' }
    }
    await syncSession(freshUser)
    return { ok: true }
  }, [syncSession, clearState])

  const setStaffSession = useCallback((partial) => {
    setAdminUser((prev) => (prev ? { ...prev, ...partial } : prev))
  }, [])

  const value = useMemo(() => {
    const suspended = Boolean(adminUser?.suspendedAt || adminUser?.status === 'suspended')
    // Consider the user "authenticated" only when we can resolve at least one
    // application profile row (admin_users or clients).
    // Otherwise, DB reset / missing rows would still pass "session exists"
    // and let protected pages render.
    const isAuthenticated = Boolean(user?.id) && (Boolean(adminUser) || Boolean(clientProfile))
    const canAccessAdmin = Boolean(adminUser && !suspended)
    const sellPath = '/admin/sell'
    const canAccessSellPortal = Boolean(
      (adminUser && !suspended && canAccessAdminPath(sellPath, adminUser.allowedPages)) ||
      (clientProfile && !isClientSuspended(clientProfile) && canClientAccessAdminPath(sellPath, clientProfile)),
    )

    const clientHasAdminPages = Boolean(
      clientProfile &&
      !isClientSuspended(clientProfile) &&
      Array.isArray(clientProfile.allowedPages) &&
      clientProfile.allowedPages.length > 0,
    )
    const hasAdminAccess = canAccessAdmin || clientHasAdminPages
    const adminTarget = canAccessAdmin
      ? '/admin'
      : clientHasAdminPages
        ? (canClientAccessAdminPath(sellPath, clientProfile) ? sellPath : clientProfile.allowedPages[0])
        : '/admin'

    return {
      loading,
      ready: !loading,
      user,
      adminUser,
      allowedPages: adminUser?.allowedPages ?? null,
      clientProfile,
      isAuthenticated,
      adminReady: Boolean(adminUser),
      canAccessAdmin,
      canAccessSellPortal,
      hasAdminAccess,
      adminTarget,
      isSellerClient: Boolean(clientProfile?.sellerEnabled),
      authError,
      profileStatus,
      login,
      register,
      logout,
      forgotPassword,
      resetPassword,
      refreshAuth,
      setStaffSession,
    }
  }, [loading, user, adminUser, clientProfile, authError, profileStatus, login, register, logout, forgotPassword, resetPassword, refreshAuth, setStaffSession])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
