import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { canAccessAdminPath, canClientAccessAdminPath } from '../lib/adminAccess.js'
import { checkMfaForRoute } from '../lib/mfaGate.js'

/**
 * Gate for the /admin/* area.
 *
 * Allowed when the session has:
 *   - an active `adminUser`, or
 *   - a `clientProfile` whose `allowedPages` covers the current path.
 *
 * Otherwise the user is silently redirected — to /login if unauthenticated,
 * or to /dashboard if authenticated but lacking permission / MFA. No error
 * panel is shown; the router transparently drops them on a page they can use.
 */
export default function RequireStaff({ children }) {
  const { loading, ready, isAuthenticated, adminUser, clientProfile } = useAuth()
  const location = useLocation()

  if (loading || !ready) {
    return (
      <div className="app-loader" style={{ minHeight: '50vh' }}>
        <div className="app-loader-spinner" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  const path = location.pathname || '/admin'
  const allowed = Boolean(
    (adminUser && canAccessAdminPath(path, adminUser.allowedPages))
    || (clientProfile && canClientAccessAdminPath(path, clientProfile)),
  )

  if (!allowed) {
    return <Navigate to="/dashboard" replace />
  }

  const mfa = checkMfaForRoute({ adminUser, pathname: path })
  if (!mfa.ok) {
    return <Navigate to="/dashboard" replace />
  }

  return children
}
