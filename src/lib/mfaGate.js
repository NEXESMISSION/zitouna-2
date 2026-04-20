// ----------------------------------------------------------------------------
// MFA step-up gating. Addresses 01_SECURITY_FINDINGS.md S-H3.
//
// Today this module is a NO-OP enforcement layer (it always passes). The
// scaffolding is here so the day MFA enrolment UI ships, only this file
// needs to flip from no-op to real check — RequireStaff already calls it.
//
// Backend prerequisites (DB):
//   • admin_users.mfa_required boolean   ← landed in 09_security_hardening.sql
//   • admin_users.mfa_enrolled boolean   ← same file
//   • Supabase project: enable Multi-Factor Authentication (TOTP) in
//     Authentication → Providers → MFA. Without that, the
//     supabase.auth.mfa.* methods return 'mfa_not_enabled' errors.
//
// What's NOT done yet (requires product input):
//   • TOTP enrolment screen (QR code + verify)
//   • Step-up challenge screen (enter 6-digit code) shown on
//     finance/users/danger-zone navigation
//   • Backup codes
//   • Recovery flow when device is lost
//
// Until those land, ROUTES_REQUIRING_MFA below is consulted but the
// enforcement step always returns "ok". Flip ENFORCE to true once the
// enrolment + challenge screens exist.
// ----------------------------------------------------------------------------

const ENFORCE = false  // ← turn on when MFA UI exists

export const ROUTES_REQUIRING_MFA = [
  '/admin/finance',
  '/admin/users',
  '/admin/danger-zone',
  '/admin/recouvrement',  // financial actions
  '/admin/commissions',   // payout approvals
]

export function routeRequiresMfa(pathname) {
  if (typeof pathname !== 'string') return false
  return ROUTES_REQUIRING_MFA.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

/**
 * Check whether the current session is allowed to access a given route
 * given MFA requirements.
 *
 * @param {object} ctx
 * @param {object} ctx.adminUser  the auth context's `adminUser` (or null)
 * @param {string} ctx.pathname   current route
 * @returns {{ ok: true } | { ok: false, reason: 'mfa_required'|'mfa_step_up_needed' }}
 */
export function checkMfaForRoute({ adminUser, pathname }) {
  if (!ENFORCE) return { ok: true }
  if (!routeRequiresMfa(pathname)) return { ok: true }

  // Normalised admin shape uses camelCase elsewhere in the app; tolerate
  // both during the rollout.
  const required = Boolean(adminUser?.mfaRequired ?? adminUser?.mfa_required)
  const enrolled = Boolean(adminUser?.mfaEnrolled ?? adminUser?.mfa_enrolled)

  if (required && !enrolled) return { ok: false, reason: 'mfa_required' }

  // TODO: when we add the challenge UI, also assert AAL2 here:
  //   const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  //   if (data?.currentLevel !== 'aal2') return { ok: false, reason: 'mfa_step_up_needed' }
  return { ok: true }
}
