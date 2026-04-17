import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { canAccessAdminPath, canClientAccessAdminPath } from '../lib/adminAccess.js'

/**
 * Gate for the /admin/* area.
 *
 * Allowed when the session has:
 *   - an active `adminUser`, or
 *   - a `clientProfile` whose `allowedPages` covers the current path.
 *
 * Otherwise the user is redirected to /login (no session) or /dashboard
 * (authenticated but lacking admin access). This stops the UI from rendering
 * a "working" wizard that then fails silently on RLS.
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
    return <Navigate to="/dashboard" replace state={{ from: path, reason: 'admin_access_denied' }} />
  }

  return children
}
