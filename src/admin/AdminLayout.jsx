import { Outlet, useLocation, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { canAccessAdminPath, canClientAccessAdminPath, isClientSuspended, isStaffSuspended } from '../lib/adminAccess.js'
import { ToastProvider } from './components/AdminToast.jsx'
import './admin.css'

function AdminAccessGate() {
  const { loading, ready, isAuthenticated, adminUser, clientProfile } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()

  if (loading || !ready) {
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

  return <Navigate to="/browse" replace />
}

export default function AdminLayout() {
  return (
    <div className="adm-shell adm-standalone-layout" lang="fr">
      <main className="adm-main adm-main--standalone">
        <ToastProvider>
          <AdminAccessGate />
        </ToastProvider>
      </main>
    </div>
  )
}
