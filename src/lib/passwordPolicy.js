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

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_POLICY_HINT =
  `Au moins ${PASSWORD_MIN_LENGTH} caractères, avec au moins une lettre et un chiffre.`

/**
 * Validate a candidate password.
 * @param {string} password
 * @returns {{ ok: true } | { ok: false, reason: string, message: string }}
 */
export function validatePassword(password) {
  const pw = String(password ?? '')
  if (pw.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      reason: 'too_short',
      message: `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères.`,
    }
  }
  if (!/[A-Za-z]/.test(pw)) {
    return {
      ok: false,
      reason: 'no_letter',
      message: 'Le mot de passe doit contenir au moins une lettre.',
    }
  }
  if (!/[0-9]/.test(pw)) {
    return {
      ok: false,
      reason: 'no_digit',
      message: 'Le mot de passe doit contenir au moins un chiffre.',
    }
  }
  // Reject a small set of obvious bad passwords regardless of length/class.
  // Not a substitute for a proper compromised-password check (zxcvbn or HIBP
  // API), but cheap defense against the worst offenders.
  const lower = pw.toLowerCase()
  const OBVIOUS_BAD = [
    'password', 'motdepasse', '1234567890', '0123456789', 'azertyuiop', 'qwertyuiop',
  ]
  if (OBVIOUS_BAD.some((b) => lower.includes(b))) {
    return {
      ok: false,
      reason: 'too_common',
      message: 'Ce mot de passe est trop courant. Choisissez quelque chose de plus unique.',
    }
  }
  return { ok: true }
}
