import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase.js'
import { ensureCurrentClientProfile, fetchAuthAdminProfile, fetchAuthClientProfile, normalizeCountryCode, normalizePhoneLocal, upsertClient, upsertClientPhoneIdentity } from './db.js'
import {
  canAccessAdminPath,
  canClientAccessAdminPath,
  hasFullPageAccess,
  isClientSuspended,
  isStaffSuspended,
} from './adminAccess.js'
import {
  withAuthTimeout,
  raceAgainstAbort,
  isTransientAuthLockError,
} from './authHelpers.js'
import { onAuth } from './authEventBus.js'

// ----------------------------------------------------------------------------
// AUDIT RULE (PLAN 01 §3): every `await` of a Supabase auth call or
// heal/profile RPC in this file MUST be wrapped in `withAuthTimeout` so a
// stalled request can never pin the auth init (which would leave the UI on
// .app-loader-spinner forever). Storage-only reads (`supabase.auth.getSession()`)
// are exempt from correctness but still benefit from a defensive cap because
// the underlying Web Lock can orphan under React StrictMode double-mount.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// S-L1 — redact known-PII fields from anything we route through console.*
// in production. Dev still gets the full message for debugging.
// ----------------------------------------------------------------------------
const PII_RE = /(?:email|phone|cin|password|token|access_token|refresh_token)[^\s,;]*/gi
function redactForLog(value) {
  if (!import.meta.env?.PROD) return value
  if (value == null) return value
  const s = typeof value === 'string' ? value : String(value)
  return s.replace(PII_RE, '[redacted]').replace(/[\w.-]+@[\w.-]+/g, '[email]')
}
function safeWarn(label, errLike) {
  // Single funnel for auth warnings — easy to swap for a logger later.
  console.warn(label, redactForLog(errLike?.message || errLike))
}
function safeError(label, errLike) {
  console.error(label, redactForLog(errLike?.message || errLike))
}

// ----------------------------------------------------------------------------
// S-M1 — names of sessionStorage keys that may carry buyer PII (Sell wizard
// drafts, etc.). Wiped on every sign-out so kiosk/shared machines don't
// leak the previous seller's in-flight transaction to the next user.
// ----------------------------------------------------------------------------
const PII_SESSION_KEYS = [
  'sell_wizard_form',
  'sell_wizard_step',
  'sell_wizard_drawer',
]
function purgePiiSessionStorage() {
  if (typeof window === 'undefined') return
  try {
    for (const k of PII_SESSION_KEYS) sessionStorage.removeItem(k)
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------------------------
// S-M5 — Supabase persists the auth token at `sb-<project-ref>-auth-token`
// in localStorage. If signOut() times out on a flaky network the client
// sometimes leaves it in place, and the next page load rehydrates a
// half-session. We derive the key from VITE_SUPABASE_URL and force-clear
// it ourselves as a belt-and-braces step.
// ----------------------------------------------------------------------------
function forceClearSupabaseToken() {
  if (typeof window === 'undefined') return
  try {
    const url = String(import.meta.env?.VITE_SUPABASE_URL || '')
    const m = url.match(/^https?:\/\/([^.]+)\./)
    const ref = m?.[1] || ''
    if (ref) {
      try { window.localStorage.removeItem(`sb-${ref}-auth-token`) } catch { /* ignore */ }
    }
    // Defensive: scan any leftover sb-*-auth-token keys regardless of env.
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i)
      if (k && /^sb-.*-auth-token$/.test(k)) {
        try { window.localStorage.removeItem(k) } catch { /* ignore */ }
      }
    }
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------------------------
// S-M6 — In production, hardcode the canonical app origin so a Vercel
// preview URL or attacker-controlled subdomain cannot become the
// password-reset target. In dev we still use window.location.origin.
// ----------------------------------------------------------------------------
function getCanonicalOrigin() {
  if (import.meta.env?.PROD) {
    const fromEnv = String(import.meta.env?.VITE_APP_ORIGIN || '').trim().replace(/\/$/, '')
    if (fromEnv) return fromEnv
  }
  if (typeof window !== 'undefined') return window.location.origin
  return ''
}

const AuthContext = createContext(null)

function isExpectedNoSessionError(errorLike) {
  const msg = String(errorLike?.message || errorLike || '').toLowerCase()
  return msg.includes('auth session missing') || msg.includes('session missing') || msg.includes('no verified user')
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
  //
  // PLAN 01 §3: each profile fetch is a network call that can hang; the
  // `Promise.all` itself does not add a timeout. Wrap individually so one
  // slow call doesn't let the other also hang.
  const [admin, initialClient] = await Promise.all([
    withAuthTimeout(fetchAuthAdminProfile(email), 8_000, 'fetchAuthAdminProfile').catch((e) => {
      safeWarn('resolveProfiles fetchAuthAdminProfile failed:', e)
      return null
    }),
    withAuthTimeout(fetchAuthClientProfile(authUser.id), 8_000, 'fetchAuthClientProfile[initial]').catch((e) => {
      safeWarn('resolveProfiles fetchAuthClientProfile[initial] failed:', e)
      return { __profileError: true, message: String(e?.message || e) }
    }),
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
      // RESEARCH 01 §3: run heal and post-refresh in parallel. The heal RPC
      // mutates the buyer row server-side; the client fetch right after reads
      // the post-heal snapshot. Doing these sequentially added ~8s to every
      // login. Parallel is safe because the refresh is idempotent; if it
      // happens before the heal commits, the heal's realtime/refresh triggers
      // pick up the diff.
      const [healed, refreshed] = await Promise.all([
        withAuthTimeout(ensureCurrentClientProfile(), 8_000, 'ensureCurrentClientProfile[admin]'),
        withAuthTimeout(
          fetchAuthClientProfile(authUser.id),
          8_000,
          'fetchAuthClientProfile[admin-refresh]',
        ),
      ])
      healMigrated = healed?.migrated || null
      if (healed && !healed.ok) {
        profileStatus = {
          reason: healed.reason || 'unknown',
          ambiguous: healed.ambiguous,
          phoneConflict: healed.phoneConflict,
          migrated: healed.migrated || null,
        }
      }
      if (refreshed && !refreshed.__profileError) client = refreshed
      else if (refreshed?.__profileError) healError = refreshed.message || null
    } catch (e) {
      // A thrown RPC is a real technical failure — never swallow it as
      // "admin has no buyer profile", that would mask session / RLS / network
      // problems. Surface as rpc_error so the dashboard shows red with detail.
      safeWarn('resolveProfiles[admin] ensureCurrentClientProfile failed:', e)
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
        // PLAN 01 §3: each upsert / link call is a network round-trip.
        const savedClient = await withAuthTimeout(
          upsertClient({
            authUserId: authUser.id,
            name: fullName,
            email: authUser.email || null,
            phone: phoneRaw || (cc && local ? `${cc}${local}` : ''),
            phoneCountryCode: cc,
            phoneLocal: local,
          }),
          6_000,
          'upsertClient[admin-link]',
        )
        let linked
        if (savedClient?.id && cc && local) {
          const [, linkedRes] = await Promise.all([
            withAuthTimeout(
              upsertClientPhoneIdentity({
                countryCode: cc,
                phoneLocal: local,
                clientId: savedClient.id,
                authUserId: authUser.id,
                verificationStatus: 'verified',
                verificationReason: null,
              }),
              6_000,
              'upsertClientPhoneIdentity[admin-link]',
            ),
            withAuthTimeout(
              fetchAuthClientProfile(authUser.id),
              8_000,
              'fetchAuthClientProfile[admin-link]',
            ),
          ])
          linked = linkedRes
        } else {
          linked = await withAuthTimeout(
            fetchAuthClientProfile(authUser.id),
            8_000,
            'fetchAuthClientProfile[admin-link]',
          )
        }
        if (linked && !linked.__profileError) client = linked
      } catch (e) {
        safeWarn('resolveProfiles[admin] auto-link failed:', e)
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
  //
  // RESEARCH 01 §3: must be timeout-wrapped; otherwise a hanging heal RPC
  // pins the entire auth init.
  try {
    // Parallelize heal + refresh (see admin path above for rationale): both
    // are independent network round-trips on the same session; serialising
    // them cost ~8s of login latency.
    const [healed, refreshed] = await Promise.all([
      withAuthTimeout(ensureCurrentClientProfile(), 8_000, 'ensureCurrentClientProfile[buyer]'),
      withAuthTimeout(
        fetchAuthClientProfile(authUser.id),
        8_000,
        'fetchAuthClientProfile[buyer-refresh]',
      ),
    ])
    if (healed && !healed.ok) {
      profileStatus = {
        reason: healed.reason || 'unknown',
        ambiguous: healed.ambiguous,
        phoneConflict: healed.phoneConflict,
        migrated: healed.migrated || null,
      }
    } else if (healed?.migrated) {
      profileStatus = { reason: null, migrated: healed.migrated }
    }
    if (refreshed && !refreshed.__profileError) {
      client = refreshed
    } else if (refreshed?.__profileError) {
      safeWarn('resolveProfiles post-ensure client fetch:', refreshed)
    }
  } catch (e) {
    safeWarn('resolveProfiles ensureCurrentClientProfile failed:', e)
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
      // PLAN 01 §3: each network call wrapped individually so one stalled
      // RPC cannot pin the auto-link path.
      const savedClient = await withAuthTimeout(
        upsertClient({
          authUserId: authUser.id,
          name: fullName,
          email: authUser.email || null,
          phone: phoneRaw || (cc && local ? `${cc}${local}` : ''),
          phoneCountryCode: cc,
          phoneLocal: local,
        }),
        6_000,
        'upsertClient[buyer-link]',
      )
      if (savedClient?.id && cc && local) {
        const [, linkedRes] = await Promise.all([
          withAuthTimeout(
            upsertClientPhoneIdentity({
              countryCode: cc,
              phoneLocal: local,
              clientId: savedClient.id,
              authUserId: authUser.id,
              verificationStatus: 'verified',
              verificationReason: null,
            }),
            6_000,
            'upsertClientPhoneIdentity[buyer-link]',
          ),
          withAuthTimeout(
            fetchAuthClientProfile(authUser.id),
            8_000,
            'fetchAuthClientProfile[buyer-link]',
          ),
        ])
        client = linkedRes
      } else {
        client = await withAuthTimeout(
          fetchAuthClientProfile(authUser.id),
          8_000,
          'fetchAuthClientProfile[buyer-link]',
        )
      }
    } catch (e) {
      safeWarn('resolveProfiles auto-link failed:', e)
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
  // FE-C2 — syncSession mutex. init(), onAuthStateChange, the safety-net
  // interval, login(), and register() all call syncSession; without
  // serialisation, two concurrent runs invoke the SECURITY DEFINER heal
  // RPC twice and can double-insert phone identities. The ref carries
  // both the userId and the in-flight promise so concurrent callers for
  // the SAME user share the result; a different userId starts a new run.
  const syncInflightRef = useRef(null)

  const clearState = useCallback(() => {
    setUser(null)
    setAdminUser(null)
    setClientProfile(null)
    setAuthError(null)
    setProfileStatus(null)
    // S-M1 — wipe any in-flight wizard drafts so a kiosk session can't
    // hand PII to the next user.
    purgePiiSessionStorage()
  }, [])

  const hardLogout = useCallback(async (reason = '') => {
    try {
      if (reason) safeWarn(`[auth] force signOut`, reason)
      // PLAN 01 §9: wrap with a 5s timeout (aligned with logout()). If
      // signOut() hangs inside init()'s catch block, the outer finally
      // never runs and setLoading never flips to false — .app-loader-spinner
      // forever. forceClearSupabaseToken below handles the storage cleanup
      // the signOut would otherwise do.
      await withAuthTimeout(supabase.auth.signOut(), 5_000, 'hardLogout.signOut')
    } catch (e) {
      safeWarn('[auth] signOut failed or timed out (continuing):', e)
    } finally {
      // S-M5 — even if signOut() succeeded we belt-and-braces clear the
      // sb-*-auth-token key ourselves; some Supabase versions skip it on
      // partial network failures.
      forceClearSupabaseToken()
      clearState()
    }
  }, [clearState])

  const syncSession = useCallback(async (supabaseUser) => {
    const uid = supabaseUser?.id ?? null
    if (!uid) {
      // PLAN 01 §7: null-uid path always clears state; never coalesces. We
      // defensively null the inflight ref so a subsequent authenticated
      // sync can't accidentally return a stale no-uid promise.
      syncInflightRef.current = null
      clearState()
      return { admin: null, client: null, profileStatus: null }
    }
    const inflight = syncInflightRef.current
    if (inflight) {
      if (inflight.userId === uid) {
        // Same-user concurrent call — share the in-flight promise.
        return inflight.promise
      }
      // PLAN 01 §7: different uid is already inflight. Rare but possible
      // with rapid cross-tab identity switches. Log it so we notice if it
      // becomes a pattern. We DO NOT coalesce mismatched uids — the new
      // user's promise takes over; the old one settles into dead state.
      if (!import.meta.env?.PROD) {
        console.warn('[auth] syncSession race: prior inflight uid=', inflight.userId, 'new uid=', uid)
      }
    }
    const promise = (async () => {
      setUser(extractUser(supabaseUser))
      const { admin, client, error, profileStatus: ps } = await resolveProfiles(supabaseUser)
      setAdminUser(admin)
      setClientProfile(client)
      setAuthError(error)
      setProfileStatus(ps || null)
      return { admin, client, profileStatus: ps || null }
    })().finally(() => {
      if (syncInflightRef.current?.userId === uid) {
        syncInflightRef.current = null
      }
    })
    syncInflightRef.current = { userId: uid, promise }
    return promise
  }, [clearState])

  // PLAN 01 §4: events that arrive during init() are buffered here and
  // replayed after initDone=true. The latest meaningful event always wins;
  // older buffered events are discarded because the freshest session is the
  // only one that matters.
  const pendingAuthEventRef = useRef(null)
  // PLAN 01 §5: a revalidation request that lands before init() finishes
  // is recorded here; init's finally drains it so the tab still catches up
  // on what it missed.
  const pendingRevalidationRef = useRef(null)

  useEffect(() => {
    let active = true
    // PLAN 01 §2: AbortController ties ALL in-flight auth work to this
    // effect's lifetime. React StrictMode double-mounts the provider in dev
    // — the first effect's pending getSession()/getUser() used to compete
    // with the second for the Web Lock, and its clearState() path would
    // bounce an already-signed-in user to /login. ac.abort() in cleanup
    // makes the racing awaits short-circuit via raceAgainstAbort().
    //
    // NOTE: we do NOT propagate the signal into the Supabase SDK itself —
    // supabase-js v2 doesn't accept AbortSignal on auth calls, and a
    // rejection inside its Web Lock path could orphan the lock. We only
    // race the SDK's promise against the signal at our level.
    const ac = new AbortController()
    let validateTimer = null

    async function init(lockRetriesLeft = 3) {
      try {
        // Fast path: read the cached session from storage first. getSession()
        // holds the Web Lock only briefly; getUser() holds it across a network
        // round-trip. For unauthenticated visitors (the common case in dev
        // where React Strict Mode double-mounts this provider) we can skip
        // the heavy-lock path entirely and avoid orphan-lock warnings.
        const { data: { session } } = await raceAgainstAbort(
          withAuthTimeout(supabase.auth.getSession(), 10_000, 'init.getSession'),
          ac.signal,
        )
        if (!active || ac.signal.aborted) return
        if (!session?.user) {
          clearState()
          return
        }
        // Session exists — validate server-side once per tab. getUser() is
        // the JWT revocation check; getSession() alone cannot detect it.
        // Timeout is 6s (under the 8s RequireCustomerAuth watchdog) so a slow
        // or stale-JWT validation self-heals into /login before the stuck UI
        // appears. Previous 10s caused the watchdog to fire first and strand
        // the user on the "Préparation de votre compte" panel.
        const { data: { user: verifiedUser }, error: userErr } = await raceAgainstAbort(
          withAuthTimeout(supabase.auth.getUser(), 6_000, 'init.getUser'),
          ac.signal,
        )
        if (!active || ac.signal.aborted) return
        if (userErr || !verifiedUser) {
          // Normal case for visitors: no active session. Avoid noisy forced-logout logs.
          clearState()
          return
        }

        const { admin, client } = await syncSession(verifiedUser)
        if (!active || ac.signal.aborted) return
        if (admin && isStaffSuspended(admin)) {
          await hardLogout('staff suspended')
        } else if (client && isClientSuspended(client)) {
          await hardLogout('client suspended')
        } else if (!admin && !client) {
          await hardLogout('session exists but no profile found')
        }
      } catch (e) {
        // PLAN 01 §2: treat abort as a clean short-circuit — the effect is
        // tearing down, not an auth failure.
        if (e?.name === 'AbortError' || ac.signal.aborted) return
        // RESEARCH 01 §2: transient Web Lock contention under React Strict
        // Mode / cross-tab steal was previously retried just once with a
        // 200ms delay — if both attempts hit an orphaned lock, clearState()
        // ran and the user saw the login page despite a valid session.
        // Retry up to 3x with exponential backoff (200ms, 500ms, 1200ms)
        // so we outlast Supabase's own 5s orphaned-lock timeout.
        if (isTransientAuthLockError(e)) {
          if (lockRetriesLeft > 0 && active && !ac.signal.aborted) {
            const delay = lockRetriesLeft === 3 ? 200 : lockRetriesLeft === 2 ? 500 : 1200
            safeWarn('[auth] transient lock on init — retrying', `${delay}ms (${lockRetriesLeft} left)`)
            await new Promise((r) => setTimeout(r, delay))
            if (active && !ac.signal.aborted) {
              await init(lockRetriesLeft - 1)
              return
            }
          }
          if (active && !ac.signal.aborted) {
            safeWarn('[auth] lock-retry budget exhausted; clearing state to recover', '')
            clearState()
          }
          return
        }
        safeError('auth init error:', e)
        if (active && !ac.signal.aborted) await hardLogout(e?.message || 'init error')
      } finally {
        if (active && !ac.signal.aborted) {
          initDone.current = true
          setLoading(false)
          // PLAN 01 §4: drain any event that arrived during init(). Do this
          // AFTER initDone=true so the handler's initDone gate no longer
          // short-circuits.
          const pending = pendingAuthEventRef.current
          pendingAuthEventRef.current = null
          if (pending) {
            queueMicrotask(() => {
              if (!active || ac.signal.aborted) return
              handleAuthEvent(pending.event, pending.session).catch(() => { /* handled inside */ })
            })
          }
          // PLAN 01 §5: run the deferred revalidation request the visibility/
          // focus listener skipped while init was mid-flight.
          const pendingReason = pendingRevalidationRef.current
          pendingRevalidationRef.current = null
          if (pendingReason) {
            queueMicrotask(() => {
              if (!active || ac.signal.aborted) return
              revalidateNow(`post-init:${pendingReason}`)
            })
          }
          // PLAN 01 §5: arm the safety-net interval AFTER init so its first
          // tick can't race the initial getUser(). Gated on visibility per
          // PLAN 01 §11 so hidden tabs don't burn requests.
          if (!validateTimer) {
            validateTimer = window.setInterval(() => {
              // PLAN 01 §11: hidden tabs have no UI to refresh. Skip.
              if (document.visibilityState === 'visible') revalidateNow('safety-net')
            }, 15 * 60_000)
          }
        }
      }
    }

    // PLAN 01 §4 REFACTOR: extract the body of the onAuthStateChange handler
    // so both the subscribe callback AND the post-init drain can call it.
    async function handleAuthEvent(event, session) {
      if (!active || ac.signal.aborted) return
      try {
        if (event === 'SIGNED_OUT' || !session?.user) {
          clearState()
          return
        }

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          // Extra safety: validate server-side user before trusting session cache.
          const { data: { user: verifiedUser }, error: userErr } = await raceAgainstAbort(
            withAuthTimeout(supabase.auth.getUser(), 10_000, `authEvent.${event}.getUser`),
            ac.signal,
          )
          // FE-H1 / FE-M4 — re-check `!active` after every await. If the
          // provider unmounted (route change, tab close) during the network
          // round-trip we must NOT proceed to call hardLogout/syncSession
          // and we must NOT leak a sign-out the user didn't ask for.
          if (!active || ac.signal.aborted) return
          if (userErr || !verifiedUser) {
            if (isExpectedNoSessionError(userErr)) {
              clearState()
              return
            }
            if (isTransientAuthLockError(userErr)) return
            await hardLogout(userErr?.message || `auth event ${event}: no verified user`)
            return
          }

          const { admin, client } = await syncSession(verifiedUser)
          if (!active || ac.signal.aborted) return
          // PLAN 01 §13 / RESEARCH #13: this verifiedUser re-check is
          // intentionally raw (no extra abort-guard needed). `syncSession`
          // already propagates via its own cleanup, and the downstream
          // hardLogout/clearState paths are idempotent. Verified in
          // research/01-auth-session-races.md #13 — no bug here, kept as
          // an explicit comment so future auditors don't re-open it.
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
      } catch (e) {
        if (e?.name === 'AbortError' || ac.signal.aborted) return
        // Swallow transient lock errors (strict-mode orphan, cross-tab steal).
        // The inflight getUser() can reject with AbortError when another tab
        // or the second strict-mode effect invocation steals the Web Lock.
        // Letting it propagate would surface as "Uncaught (in promise)".
        if (isTransientAuthLockError(e)) return
        safeWarn(`auth event ${event} error:`, e)
      }
    }

    // S-L2 — revalidate auth ONLY when the tab becomes visible (and on a
    // long-interval safety net), instead of every 60 s. Cuts ~1440
    // /token requests per day per idle tab and removes the traffic-pattern
    // info-leak the auditor flagged.
    async function revalidateNow(reason) {
      if (!active || ac.signal.aborted) return
      // PLAN 01 §5: if init is still mid-flight, defer the revalidation. The
      // visibility listener racing a pending init used to trigger concurrent
      // getUser() calls, both fighting for the same Web Lock — one would
      // orphan and clearState() would bounce the user to /login.
      if (!initDone.current) {
        pendingRevalidationRef.current = reason
        return
      }
      try {
        const { data: { user: verifiedUser }, error } = await raceAgainstAbort(
          withAuthTimeout(supabase.auth.getUser(), 10_000, `revalidate.${reason}.getUser`),
          ac.signal,
        )
        if (!active || ac.signal.aborted) return
        if (error || !verifiedUser) {
          if (isExpectedNoSessionError(error)) { clearState(); return }
          if (isTransientAuthLockError(error)) return
          await hardLogout(redactForLog(error?.message) || `revalidate (${reason}) returned no user`)
        }
      } catch (e) {
        if (!active || ac.signal.aborted) return
        if (e?.name === 'AbortError') return
        if (isExpectedNoSessionError(e)) { clearState(); return }
        // Transient lock errors (strict-mode orphan / cross-tab steal) are
        // recoverable — next revalidation will retry. Do NOT force-logout.
        if (isTransientAuthLockError(e)) return
        await hardLogout(redactForLog(e?.message) || `revalidate (${reason}) error`)
      }
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') revalidateNow('visibilitychange')
    }
    document.addEventListener('visibilitychange', onVisibility)

    // PLAN 01 §10: subscribe via the shared authEventBus so there's exactly
    // ONE outer onAuthStateChange listener for the whole app. The bus
    // replaces the same-named handler on re-registration (StrictMode
    // remount), so we don't double-handle events.
    const unsubscribeBus = onAuth('auth-context-sync', (event, session) => {
      if (!active || ac.signal.aborted) return
      // PLAN 01 §4: buffer events that fire while init is still running.
      // Previously these were silently dropped via `if (!initDone.current) return`.
      // If init() itself failed and clearState() ran, the dropped SIGNED_IN
      // was never replayed — user stuck on "Profil introuvable".
      if (!initDone.current) {
        if (
          event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' ||
          event === 'USER_UPDATED' || event === 'SIGNED_OUT' ||
          event === 'INITIAL_SESSION'
        ) {
          pendingAuthEventRef.current = { event, session }
        }
        return
      }
      // Post-init: dispatch directly.
      handleAuthEvent(event, session).catch(() => { /* handled inside */ })
    })

    init()

    return () => {
      active = false
      // PLAN 01 §2: abort any pending awaits. The underlying Supabase
      // request may still complete in the background; we just don't
      // process its result. See raceAgainstAbort note in authHelpers.js.
      try { ac.abort() } catch { /* ignore */ }
      // RESEARCH 01 #13 — in-flight async work in revalidateNow /
      // handleAuthEvent is guarded by `if (!active || ac.signal.aborted) return`
      // after every await. We do not need to abort those promises at the
      // Supabase SDK level; they settle into dead code. Verified in
      // research/01-auth-session-races.md #13.
      if (validateTimer) { window.clearInterval(validateTimer); validateTimer = null }
      document.removeEventListener('visibilitychange', onVisibility)
      try { unsubscribeBus?.() } catch { /* ignore */ }
    }
  }, [syncSession, clearState, hardLogout])

  const login = useCallback(async (email, password) => {
    // PLAN 01 §3: signInWithPassword is a network call — wrap with a timeout
    // so a flaky network can't pin the login form on its spinner forever.
    let signInResult
    try {
      signInResult = await withAuthTimeout(
        supabase.auth.signInWithPassword({
          email: String(email || '').trim(),
          password: String(password || ''),
        }),
        12_000,
        'login.signInWithPassword',
      )
    } catch (e) {
      return { ok: false, error: e?.message || 'Erreur réseau. Réessayez.' }
    }
    const { data, error } = signInResult

    if (error) return { ok: false, error: error.message }
    if (!data?.user) return { ok: false, error: 'Réponse inattendue du serveur.' }

    const { admin, client, error: profileErr } = await syncSession(data.user)

    if (admin && isStaffSuspended(admin)) {
      try { await withAuthTimeout(supabase.auth.signOut(), 5_000, 'login.signOut[staffSuspended]') } catch { /* ignore */ }
      forceClearSupabaseToken()
      clearState()
      return { ok: false, error: 'Ce compte est suspendu. Contactez un administrateur.' }
    }

    if (client && isClientSuspended(client)) {
      try { await withAuthTimeout(supabase.auth.signOut(), 5_000, 'login.signOut[clientSuspended]') } catch { /* ignore */ }
      forceClearSupabaseToken()
      clearState()
      return { ok: false, error: "Ce compte est suspendu. Contactez l'administration." }
    }

    if (!admin && !client) {
      // Retry server-side auto-link once before returning "profil introuvable".
      try {
        await withAuthTimeout(ensureCurrentClientProfile(), 6_000, 'ensureCurrentClientProfile[login-retry]')
        const retried = await syncSession(data.user)
        if (retried?.admin || retried?.client) {
          const redirectTo = retried.admin ? '/admin' : '/dashboard'
          return { ok: true, redirectTo }
        }
      } catch (healErr) {
        safeWarn('login ensureCurrentClientProfile failed:', healErr)
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
    // PLAN 01 §8 / RESEARCH 01 §8: the function has many return paths. The
    // try/finally is the single source of truth for clearing the flag — every
    // manual `registrationInProgressRef.current = false` inside the body has
    // been removed. This guarantees the ref is reset exactly once on every
    // exit path (return, throw, synchronous-throw-before-first-await).
    try {
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

      let signedInUser = data?.user
      let session = data?.session

      if (error) {
        const msg = String(error.message || '').toLowerCase()
        let reason = 'signup_failed'
        if (msg.includes('already registered') || msg.includes('user already') || msg.includes('duplicate')) reason = 'email_conflict'
        else if (msg.includes('password')) reason = 'weak_password'
        else if (msg.includes('email')) reason = 'invalid_email'

        // Orphan-recovery: a prior signup attempt created the auth user but
        // failed at profile upsert (e.g. PHONE_LINK_CONFLICT), leaving the
        // user unable to retry with the same email. If the caller provides
        // the matching password we can re-authenticate, then continue to
        // profile upsert below with the (now-corrected) phone.
        if (reason === 'email_conflict') {
          const { data: siData } = await withAuthTimeout(
            supabase.auth.signInWithPassword({ email, password }),
            10_000,
            'signInWithPassword[orphanRecovery]',
          ).catch((e) => ({ data: null, error: e }))
          if (siData?.session && siData?.user) {
            signedInUser = siData.user
            session = siData.session
          } else {
            // Wrong password → genuine email collision with someone else's
            // account. Preserve original email_conflict signal.
            return { ok: false, reason, error: error.message }
          }
        } else {
          return { ok: false, reason, error: error.message }
        }
      }

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
          safeError('register: upsertClient failed', e)
          if (e?.code === 'PHONE_LINK_CONFLICT') {
            try {
              if (cc && local) {
                // PLAN 01 §3: pending-verification upsert is a network call;
                // wrap so it can't pin the register flow.
                await withAuthTimeout(
                  upsertClientPhoneIdentity({
                    countryCode: cc,
                    phoneLocal: local,
                    authUserId: signedInUser.id,
                    verificationStatus: 'pending_verification',
                    verificationReason: 'signup_phone_conflict',
                  }),
                  6_000,
                  'upsertClientPhoneIdentity[pending]',
                )
              }
            } catch (pendingErr) {
              safeError('register: pending phone verification failed', pendingErr)
            }
            try { await withAuthTimeout(supabase.auth.signOut(), 5_000, 'register.signOut[phoneConflict]') } catch { /* ignore */ }
            forceClearSupabaseToken()
            clearState()
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
              try { await withAuthTimeout(supabase.auth.signOut(), 5_000, 'register.signOut[healPhoneConflict]') } catch { /* ignore */ }
              forceClearSupabaseToken()
              clearState()
              return {
                ok: false,
                reason: 'phone_conflict',
                error: "Ce numéro est déjà lié à un autre compte. Contactez le support pour vérification.",
              }
            }
            const { admin, client } = await syncSession(signedInUser)
            if (admin || client) {
              return { ok: true, needsConfirmation: false, redirectTo: '/dashboard' }
            }
          } catch (healErr) {
            safeWarn('register: ensureCurrentClientProfile failed', healErr)
          }
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
        if (!admin && !client) {
          try { await withAuthTimeout(supabase.auth.signOut(), 5_000, 'register.signOut[noProfile]') } catch { /* ignore */ }
          forceClearSupabaseToken()
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
        return { ok: true, needsConfirmation: true }
      }

      return { ok: false, error: 'Inscription interrompue. Réessayez.' }
    } finally {
      // PLAN 01 §8: single source of truth. The body never sets this back to
      // false itself — the finally always runs, even if a synchronous throw
      // escapes before the first await.
      registrationInProgressRef.current = false
    }
  }, [syncSession, clearState])

  const logout = useCallback(async () => {
    // signOut() can stall on a flaky network or orphaned nav lock — always
    // clear local state regardless so the UI doesn't appear still logged-in.
    try {
      await withAuthTimeout(supabase.auth.signOut(), 5_000, 'signOut')
    } catch (e) {
      safeWarn('[auth] signOut failed or timed out — clearing state anyway:', e)
    } finally {
      // S-M5 — defensive token wipe regardless of signOut() outcome
      forceClearSupabaseToken()
      clearState()
    }
    return { ok: true }
  }, [clearState])

  const forgotPassword = useCallback(async (email) => {
    // S-M6 — canonical origin only in prod, never window.origin (which can
    // be a Vercel preview or attacker-controlled subdomain).
    const origin = getCanonicalOrigin()
    try {
      // PLAN 01 §3: resetPasswordForEmail is a network call; wrap with timeout.
      const { error } = await withAuthTimeout(
        supabase.auth.resetPasswordForEmail(
          String(email || '').trim(),
          { redirectTo: `${origin}/reset-password` },
        ),
        10_000,
        'resetPasswordForEmail',
      )
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'Erreur réseau. Réessayez.' }
    }
  }, [])

  const resetPassword = useCallback(async (newPassword) => {
    try {
      // PLAN 01 §3: updateUser is a network call; wrap with timeout.
      const { error } = await withAuthTimeout(
        supabase.auth.updateUser({ password: newPassword }),
        10_000,
        'updateUser.password',
      )
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'Erreur réseau. Réessayez.' }
    }
  }, [])

  const refreshAuth = useCallback(async () => {
    try {
      // PLAN 01 §3: getUser is a network round-trip; wrap with timeout.
      const { data: { user: freshUser }, error } = await withAuthTimeout(
        supabase.auth.getUser(),
        10_000,
        'refreshAuth.getUser',
      )
      if (error || !freshUser) {
        clearState()
        return { ok: false, error: error?.message || 'Session introuvable' }
      }
      await syncSession(freshUser)
      return { ok: true }
    } catch (e) {
      clearState()
      return { ok: false, error: e?.message || 'Session introuvable' }
    }
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
      (hasFullPageAccess(clientProfile.allowedPages) ||
        (Array.isArray(clientProfile.allowedPages) && clientProfile.allowedPages.length > 0)),
    )
    const hasAdminAccess = canAccessAdmin || clientHasAdminPages
    const adminTarget = canAccessAdmin
      ? '/admin'
      : clientHasAdminPages
        ? (canClientAccessAdminPath(sellPath, clientProfile)
          ? sellPath
          : (Array.isArray(clientProfile.allowedPages) && clientProfile.allowedPages.length > 0
            ? clientProfile.allowedPages[0]
            : '/admin'))
        : '/admin'

    // Without this, `adminUser?.allowedPages ?? null` leaked `null` into the
    // admin shell for clients with limited page access — nav rendered EVERY
    // module instead of the two the client was actually granted.
    const effectiveAllowedPages = adminUser
      ? (adminUser.allowedPages ?? null)
      : clientProfile
        ? (clientProfile.allowedPages ?? null)
        : []

    return {
      loading,
      ready: !loading,
      user,
      adminUser,
      allowedPages: effectiveAllowedPages,
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
