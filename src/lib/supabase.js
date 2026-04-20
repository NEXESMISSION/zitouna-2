import { createClient } from '@supabase/supabase-js'

// ----------------------------------------------------------------------------
// Env-var validation (S-M2).
// In production a missing/placeholder env is a fatal configuration error —
// refuse to create the client rather than silently 401 every request against
// placeholder.supabase.co. In dev we still warn loudly but allow the app to
// mount so contributors get a readable error instead of a blank screen.
// ----------------------------------------------------------------------------
const rawUrl = String(import.meta.env?.VITE_SUPABASE_URL || '').trim()
const rawKey = String(import.meta.env?.VITE_SUPABASE_ANON_KEY || '').trim()

function isPlaceholder(value) {
  if (!value) return true
  const v = value.toLowerCase()
  return v.includes('placeholder') || v === 'changeme' || v === 'todo'
}

const urlMissing = !rawUrl || isPlaceholder(rawUrl)
const keyMissing = !rawKey || isPlaceholder(rawKey)

if (urlMissing || keyMissing) {
  const missing = [urlMissing && 'VITE_SUPABASE_URL', keyMissing && 'VITE_SUPABASE_ANON_KEY']
    .filter(Boolean)
    .join(' and ')
  if (import.meta.env?.PROD) {
    // Fatal in prod. Surface via the error boundary and fail the build pipeline
    // if any pre-deploy smoke test hits this path.
    throw new Error(
      `[Zitouna] Supabase env misconfigured (${missing}). ` +
      `Refuse to boot with placeholder credentials.`,
    )
  }
  // Dev fallback: still boot, but loud.
  console.error(
    `[Zitouna] Missing ${missing} in .env — using placeholder values. ` +
    `Supabase calls WILL fail until you set these.`,
  )
}

// ----------------------------------------------------------------------------
// Supabase client. Uses the default Web Locks implementation for cross-tab
// token refresh serialization (S-H5 previously swapped this for a no-op,
// which caused refresh-token races between tabs). Strict-mode orphaned
// lock issues are caught upstream in AuthContext via isTransientAuthLockError
// and retried — do not shim the lock here.
// ----------------------------------------------------------------------------
export const supabase = createClient(
  rawUrl || 'https://placeholder.supabase.co',
  rawKey || 'placeholder',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // Do NOT override `lock`. Default Web Locks serialize correctly across
      // tabs; overriding with a no-op breaks S-H5 invariant.
    },
  },
)

// ----------------------------------------------------------------------------
// S-H2 — clear the access-token hash from the URL as soon as Supabase has
// consumed it. Prevents token leakage via third-party scripts, analytics,
// and `<a target="_blank">` that read `window.location.hash`.
// Runs once at module load; a belt-and-braces listener re-runs on
// SIGNED_IN/USER_UPDATED since the token lands in the hash during password-
// reset / magic-link flows.
//
// FE-C3 — Before stripping, detect `type=recovery` in the hash (Supabase
// sets this when the link came from resetPasswordForEmail). Persist a
// session-scoped flag so the /reset-password page can refuse a normal
// interactive session — preventing a 30-second walk-up attacker from
// changing the victim's password while logged in elsewhere.
// ----------------------------------------------------------------------------
export const RECOVERY_FLAG_KEY = 'sb_recovery_flow'

function detectAndFlagRecoveryHash() {
  if (typeof window === 'undefined') return
  const hash = window.location.hash || ''
  if (!hash) return
  if (/(?:^|[#&])type=recovery(?:&|$)/.test(hash)) {
    try { window.sessionStorage.setItem(RECOVERY_FLAG_KEY, '1') } catch { /* ignore */ }
  }
}

function maybeStripAuthHash() {
  if (typeof window === 'undefined') return
  const hash = window.location.hash || ''
  if (!hash) return
  // Only touch hashes that look like Supabase auth payloads. Leave app
  // anchors (#section) alone.
  if (
    hash.includes('access_token=') ||
    hash.includes('refresh_token=') ||
    hash.includes('provider_token=') ||
    hash.startsWith('#type=')
  ) {
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    } catch {
      /* ignore */
    }
  }
}

// Detect type=recovery FIRST so the flag survives the hash strip.
detectAndFlagRecoveryHash()
// Strip on first module evaluation — covers the reset-password landing page
// where the hash is present but Supabase reads it synchronously.
maybeStripAuthHash()

// FE-C4 — This subscriber is intentionally registered at MODULE SCOPE, not
// inside any React effect. Two reasons:
//   1. StrictMode double-mounts AuthProvider in dev, which would otherwise
//      attach/detach a duplicate listener and cause the recovery flag to be
//      toggled twice. Module scope means a single registration per page load.
//   2. The hash-strip + PASSWORD_RECOVERY flag must survive every AuthContext
//      remount (route change wrapping the provider, StrictMode, HMR). We do
//      NOT unsubscribe here for the same reason — the listener is meant to
//      outlive every React tree in the page.
// Do NOT refactor this into an effect or context — it is load-bearing for
// the reset-password security boundary.
//
// PLAN 01 §10: routed through the shared authEventBus so only ONE outer
// `onAuthStateChange` subscription exists per page load. The bus imports
// from this file, so this registration happens via a dynamic import() to
// break the circular dep without awaiting (we only need the side-effect
// of registration; the listener is invoked by the bus on every future
// auth event).
import('./authEventBus.js').then(({ onAuth }) => {
  onAuth('recovery-hash-strip', (event) => {
    if (event === 'PASSWORD_RECOVERY') {
      // FE-C4 — re-run hash detection here as well. The module-load detection
      // at line 108 covers the normal case (hash already present), but if the
      // page mounts before Supabase finishes parsing `detectSessionInUrl`, the
      // hash may only surface at PASSWORD_RECOVERY time. Idempotent: if the
      // flag is already set the sessionStorage write is a no-op overwrite.
      detectAndFlagRecoveryHash()
      try { window.sessionStorage.setItem(RECOVERY_FLAG_KEY, '1') } catch { /* ignore */ }
    }
    if (event === 'SIGNED_OUT') {
      // PLAN 01 §12: don't clear the recovery flag if we're already on the
      // reset-password page. Otherwise a cross-tab sign-out (e.g. user
      // signs out of another tab while this one is mid-recovery) would
      // prematurely demote the reset page to an interactive session and
      // let a walk-up attacker change the password.
      try {
        const onResetPage = typeof window !== 'undefined' &&
          window.location.pathname.startsWith('/reset-password')
        if (!onResetPage) window.sessionStorage.removeItem(RECOVERY_FLAG_KEY)
      } catch { /* ignore */ }
    }
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED' || event === 'PASSWORD_RECOVERY') {
      maybeStripAuthHash()
    }
  })
}).catch(() => { /* bus unavailable — non-fatal */ })
