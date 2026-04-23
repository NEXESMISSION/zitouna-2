// ----------------------------------------------------------------------------
// Central password policy. Addresses 01_SECURITY_FINDINGS.md S-M3.
//
// Keep ONE source of truth so register / reset / admin-create flows stay in
// lockstep. Supabase enforces server-side rules on top (min length from the
// dashboard Auth settings); this module is the client's pre-submit gate.
//
// Rationale for the current thresholds:
//   • 10 chars  — NIST SP 800-63B allows any length ≥8 if an unpredictable
//                 check is done. We pick 10 as a friendly bump that still
//                 passes users who hate very long passwords.
//   • No max    — per NIST, max-length caps are actively harmful.
//   • Class mix — one letter + one digit. Weaker than "all four classes"
//                 but far more usable, and combined with length it's fine.
// ----------------------------------------------------------------------------

// TEMPORARY — password policy disabled for testing. Restore by reverting this
// commit; the original rules (min 10, letter + digit, common-password block)
// are preserved in git history. Supabase's dashboard-level min-length still
// applies server-side, so empty/very-short passwords will be rejected there.
export const PASSWORD_MIN_LENGTH = 1
export const PASSWORD_POLICY_HINT = 'Saisissez un mot de passe.'

/**
 * Validate a candidate password.
 * @param {string} password
 * @returns {{ ok: true } | { ok: false, reason: string, message: string }}
 */
export function validatePassword(password) {
  const pw = String(password ?? '')
  if (pw.length === 0) {
    return {
      ok: false,
      reason: 'empty',
      message: 'Le mot de passe ne peut pas être vide.',
    }
  }
  return { ok: true }
}
