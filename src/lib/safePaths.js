// ----------------------------------------------------------------------------
// Strict allowlist of in-app paths for redirect-after-login. Addresses
// 01_SECURITY_FINDINGS.md S-M4 — the previous loose `startsWith('/')` check
// missed backslash traversal, Unicode slashes, and `%2F` encoding.
//
// Rules:
//   • Must be a string starting with a single '/'
//   • Must not start with '//' or '/\' (protocol-relative / backslash)
//   • Must contain no ':', no control chars, no percent-encoded slash
//   • Must match a known route prefix
//
// Updating: add a new prefix here the moment you add a new top-level route
// in App.jsx. Keep the list short — losing a safe path is better than
// opening up an open-redirect.
// ----------------------------------------------------------------------------

const ROUTE_PREFIXES = [
  '/',
  '/browse',
  '/dashboard',
  '/installments',
  '/project/',
  '/admin',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/ref/',
]

export function isSafeAppPath(value) {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!v || v[0] !== '/') return false
  if (v.length > 512) return false
  // Reject protocol-relative (`//evil`), backslash traversal (`/\evil`),
  // explicit scheme (`/http:`), percent-encoded slash (`/%2Fevil`),
  // control chars, newlines, at-signs, backticks.
  if (
    v.startsWith('//') ||
    v.startsWith('/\\') ||
    v.includes('://') ||
    v.includes('\\') ||
    /%2f/i.test(v) ||
    /%5c/i.test(v) ||
    // eslint-disable-next-line no-control-regex -- intentional: reject CR/LF/null and other control chars
    /[\u0000-\u001f\u007f]/.test(v) ||
    v.includes('@')
  ) {
    return false
  }
  return ROUTE_PREFIXES.some((p) => v === p || v.startsWith(p + '/') || v.startsWith(p + '?') || v.startsWith(p + '#'))
}

/** Return `candidate` if it's safe, otherwise the fallback. */
export function pickSafePath(candidate, fallback = '/browse') {
  return isSafeAppPath(candidate) ? candidate : fallback
}
