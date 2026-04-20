import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { canAccessAdminPath, canClientAccessAdminPath } from '../lib/adminAccess.js'
import { checkMfaForRoute } from '../lib/mfaGate.js'

// ----------------------------------------------------------------------------
// FE-H2 — Inline NotAllowed panel. Replacing the previous silent
// `<Navigate to="/dashboard">` that dropped the user on the dashboard
// with no explanation — they would assume the app was broken. The panel
// surfaces *why* access is denied, the offending path, and gives them
// "Logout" / "Return to dashboard" buttons.
// ----------------------------------------------------------------------------
function NotAllowedPanel({ reason, path, profileStatus }) {
  const { logout } = useAuth()
  const navigate = useNavigate()

  let title = 'Accès refusé'
  let message = "Vous n'avez pas la permission d'accéder à cette page."

  if (reason === 'mfa_required') {
    title = 'Vérification en deux étapes requise'
    message = "Cette page exige l'activation de la double authentification (2FA). Activez-la dans votre profil avant d'y revenir."
  } else if (reason === 'mfa_step_up_needed') {
    title = 'Réauthentification requise'
    message = 'Pour accéder à cette page, confirmez à nouveau votre identité avec votre code 2FA.'
  } else if (profileStatus?.reason === 'ambiguous_client_profile') {
    title = 'Profil ambigu'
    message = "Plusieurs profils sont liés à votre compte. Le support doit fusionner les profils avant d'accéder à cette page."
  } else if (profileStatus?.reason === 'phone_conflict') {
    title = 'Téléphone en conflit'
    message = "Votre numéro est déjà associé à un autre compte. Le support doit valider le rattachement."
  }

  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ maxWidth: 480, textAlign: 'center', padding: '2rem' }}>
        <h2 style={{ marginBottom: '1rem' }}>{title}</h2>
        <p style={{ marginBottom: '1rem', color: 'var(--color-text-secondary, #ccc)', lineHeight: 1.5 }}>
          {message}
        </p>
        <p style={{ marginBottom: '1.5rem', fontSize: 12, color: 'var(--color-text-muted, #888)' }}>
          Page demandée : <code>{path}</code>
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="submit-button"
            style={{ minWidth: 140 }}
            onClick={() => navigate('/dashboard', { replace: true })}
          >
            Aller au dashboard
          </button>
          <button
            type="button"
            className="submit-button"
            style={{ minWidth: 140, background: 'var(--color-danger, #e74c3c)' }}
            onClick={async () => { await logout(); navigate('/login', { replace: true }) }}
          >
            Se déconnecter
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Gate for the /admin/* area.
 *
 * Allowed when the session has:
 *   - an active `adminUser`, or
 *   - a `clientProfile` whose `allowedPages` covers the current path.
 *
 * Otherwise the user is sent to /login (no session) or sees an inline
 * NotAllowed panel (authenticated but lacking permission), so they
 * understand WHY they are blocked instead of bouncing into a bare
 * dashboard with no context.
 */
export default function RequireStaff({ children }) {
  const { loading, ready, isAuthenticated, adminUser, clientProfile, profileStatus } = useAuth()
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
    return <NotAllowedPanel reason="admin_access_denied" path={path} profileStatus={profileStatus} />
  }

  // S-H3 — MFA step-up gate for high-risk admin routes (finance, users,
  // danger-zone, commissions, recouvrement). Returns ok=true today
  // because ENFORCE=false in mfaGate.js until the enrolment UI ships.
  const mfa = checkMfaForRoute({ adminUser, pathname: path })
  if (!mfa.ok) {
    return <NotAllowedPanel reason={mfa.reason} path={path} profileStatus={profileStatus} />
  }

  return children
}
