import { Outlet, useLocation, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { canAccessAdminPath, canClientAccessAdminPath, isClientSuspended, isStaffSuspended } from '../lib/adminAccess.js'
import { useConnectionHealth } from '../lib/useSupabase.js'
import { useWatchdog } from '../hooks/useWatchdog.js'
import EmptyState from '../components/EmptyState.jsx'
import { ToastProvider } from './components/AdminToast.jsx'
import './admin.css'
import './admin-v2.css'

function ConnectionHealthBanner() {
  const { slow, errored } = useConnectionHealth()
  if (!slow && !errored) return null
  const isError = errored && !slow
  return (
    <div
      role="status"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        padding: '6px 12px', fontSize: 13, fontWeight: 500,
        textAlign: 'center',
        background: isError ? '#fee2e2' : '#fef3c7',
        color: isError ? '#991b1b' : '#92400e',
        borderBottom: `1px solid ${isError ? '#fca5a5' : '#fde68a'}`,
      }}
    >
      {isError
        ? '⚠ Problème de connexion — certaines données ne sont pas disponibles. Vérifiez votre connexion.'
        : '⏳ Connexion lente — le chargement prend plus de temps que d’habitude…'}
    </div>
  )
}

function AuthStuckPanel({ onRetry, onSignOut }) {
  return (
    <div
      className="zitu-page"
      dir="ltr"
      style={{ padding: 24, maxWidth: 480, margin: '0 auto' }}
      role="alert"
    >
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Authentification bloquée</h1>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
        Le chargement de votre session prend plus de temps que prévu. Veuillez
        réessayer ou vous reconnecter.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onRetry}
          style={{
            padding: '8px 14px', borderRadius: 10, border: '1px solid #2563eb',
            background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Réessayer
        </button>
        <button
          type="button"
          onClick={onSignOut}
          style={{
            padding: '8px 14px', borderRadius: 10, border: '1px solid #cbd5e1',
            background: '#fff', color: '#0f172a', fontSize: 13, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Se déconnecter
        </button>
      </div>
    </div>
  )
}

function AdminAccessGate() {
  const { loading, ready, isAuthenticated, adminUser, clientProfile, refreshAuth, logout } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()

  // Plan 03 §5: component-level watchdog on the auth gate. If the auth init
  // pin hangs longer than 10s, surface AuthStuckPanel with retry + sign-out
  // instead of keeping the user behind a permanent spinner (the single
  // highest-impact bug — blocks every admin page).
  const isAuthLoading = Boolean(loading || !ready)
  const { stuck: authStuck, reset: resetAuthWatchdog } = useWatchdog(
    { state: isAuthLoading ? 'loading' : 'ready' },
    10_000,
  )

  if (isAuthLoading) {
    if (authStuck) {
      return (
        <AuthStuckPanel
          onRetry={() => {
            resetAuthWatchdog()
            if (typeof refreshAuth === 'function') refreshAuth().catch(() => {})
          }}
          onSignOut={() => {
            if (typeof logout === 'function') {
              logout().finally(() => navigate('/login', { replace: true }))
            } else {
              navigate('/login', { replace: true })
            }
          }}
        />
      )
    }
    return (
      <div className="app-loader" style={{ minHeight: '40vh' }}>
        <div className="app-loader-spinner" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: pathname }} />
  }

  if (adminUser) {
    if (isStaffSuspended(adminUser)) {
      return (
        <div className="zitu-page" dir="ltr" style={{ padding: 24, maxWidth: 480, margin: '0 auto' }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>Compte suspendu</h1>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            Ce compte administrateur est désactivé. Contactez un super administrateur.
          </p>
        </div>
      )
    }

    if (!canAccessAdminPath(pathname, adminUser.allowedPages)) {
      return <Navigate to="/admin" replace />
    }
    return (
      <>
        <button
          type="button"
          className="adm-page-back-btn"
          onClick={() => navigate('/dashboard')}
          aria-label="Retour au dashboard"
        >
          ← Dashboard
        </button>
        <Outlet />
      </>
    )
  }

  if (clientProfile) {
    if (isClientSuspended(clientProfile)) {
      return (
        <div className="zitu-page" dir="ltr" style={{ padding: 24, maxWidth: 520, margin: '0 auto' }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>Compte client suspendu</h1>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            L'accès à l'espace administration est désactivé pour ce compte. Votre historique est conservé. Contactez le support.
          </p>
        </div>
      )
    }

    const clientPages = Array.isArray(clientProfile.allowedPages) ? clientProfile.allowedPages : []
    const cleanPath = pathname.replace(/\/$/, '') || '/admin'

    if (cleanPath === '/admin' || cleanPath === '/admin/dashboard') {
      if (clientPages.length > 0) {
        return <Navigate to={clientPages[0]} replace />
      }
      return <Navigate to="/dashboard" replace />
    }

    if (canClientAccessAdminPath(pathname, clientProfile)) {
      return (
        <>
          <button
            type="button"
            className="adm-page-back-btn"
            onClick={() => navigate('/dashboard')}
            aria-label="Retour au dashboard"
          >
            ← Dashboard
          </button>
          <Outlet />
        </>
      )
    }
  }

  // Plan 03 §5: authenticated but no admin/client profile with admin access.
  // Previously fell through silently to /browse — a confused redirect the user
  // couldn't diagnose. Render a dedicated empty state so support can see the
  // state at a glance.
  if (isAuthenticated) {
    return (
      <div
        className="zitu-page"
        dir="ltr"
        style={{ padding: 24, maxWidth: 560, margin: '0 auto' }}
      >
        <EmptyState
          icon="🔒"
          title="Aucun rôle assigné"
          description="Votre compte n'a pas encore accès à l'espace d'administration. Contactez un administrateur pour obtenir les autorisations nécessaires."
          action={{
            label: 'Retour au dashboard',
            onClick: () => navigate('/dashboard'),
          }}
          secondary={{
            label: 'Parcourir les projets',
            onClick: () => navigate('/browse'),
          }}
        />
      </div>
    )
  }

  return <Navigate to="/browse" replace />
}

export default function AdminLayout() {
  return (
    <div className="adm-shell adm-standalone-layout zadm-shell" lang="fr">
      <ConnectionHealthBanner />
      <main className="adm-main adm-main--standalone">
        <ToastProvider>
          <AdminAccessGate />
        </ToastProvider>
      </main>
    </div>
  )
}
