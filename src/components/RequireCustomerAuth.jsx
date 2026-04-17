import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'

export default function RequireCustomerAuth({ children }) {
  const { loading, ready, isAuthenticated, adminUser, clientProfile, authError, logout, refreshAuth } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

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

  if (!adminUser && !clientProfile) {
    return (
      <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 440, textAlign: 'center', padding: '2rem' }}>
          <h2 style={{ marginBottom: '1rem', color: 'var(--color-text, #fff)' }}>Profil introuvable</h2>
          <p style={{ marginBottom: '1rem', color: 'var(--color-text-secondary, #ccc)', lineHeight: 1.5 }}>
            {authError
              ? `Erreur : ${authError}`
              : "Votre profil client n'a pas pu être chargé. Il est possible qu'il n'ait pas encore été créé ou qu'il y ait un problème temporaire."}
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              className="submit-button"
              style={{ minWidth: 120 }}
              onClick={async () => {
                await refreshAuth()
                navigate(0)
              }}
            >
              Réessayer
            </button>
            <button
              className="submit-button"
              style={{ minWidth: 120, background: 'var(--color-danger, #e74c3c)' }}
              onClick={async () => {
                await logout()
                navigate('/login', { replace: true })
              }}
            >
              Se déconnecter
            </button>
          </div>
        </div>
      </div>
    )
  }

  return children
}
