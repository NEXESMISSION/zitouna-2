import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import headerLogo from '../logo-header2.png'
import { useAuth } from './lib/AuthContext.jsx'
import NotificationsMenu from './components/NotificationsMenu.jsx'

export default function TopBar() {
  const navigate = useNavigate()
  const location = useLocation()
  const onDashboard = location.pathname === '/dashboard'
  const auth = useAuth()
  const hasAdminAccess = auth?.hasAdminAccess
  const canAccessSellPortal = auth?.canAccessSellPortal
  const adminTarget = auth?.adminTarget || '/admin'
  const showAdminEntry = Boolean(hasAdminAccess || canAccessSellPortal)
  const adminEntryTarget = hasAdminAccess ? adminTarget : '/admin/sell'
  const portfolioMobileNavigate = () => {
    if (onDashboard) navigate('/browse')
    else navigate('/dashboard')
  }

  return (
    <header className="top-bar-wrap">
      <div className="top-bar">
        <div className="brand-inline">
          <img src={headerLogo} alt="Zitouna Bladi" className="top-logo" />
          <div>
            <p className="company">ZITOUNA BLADI</p>
            <p className="company-subtitle">Smart Agriculture</p>
          </div>
        </div>

        <nav className="top-nav">
          <NavLink
            to="/browse"
            className={({ isActive }) => 'top-nav-link' + (isActive ? ' active' : '')}
          >
            Explorer
          </NavLink>
          <NavLink
            to="/dashboard"
            className={({ isActive }) => 'top-nav-link' + (isActive ? ' active' : '')}
          >
            Mon Portfolio
          </NavLink>
        </nav>

        <div className="top-actions">
          {showAdminEntry && (
            <button
              type="button"
              className="icon-action top-admin-switch"
              title={hasAdminAccess ? 'Accès admin' : 'Espace ventes (accès notaire)'}
              aria-label={hasAdminAccess ? 'Accès admin' : 'Espace ventes'}
              onClick={() => navigate(adminEntryTarget)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4Z" />
              </svg>
            </button>
          )}

          <NotificationsMenu />

          <button
            type="button"
            className={`portfolio-nav-btn icon-action${onDashboard ? ' portfolio-nav-btn--home' : ' portfolio-nav-btn--profile'}`}
            title={onDashboard ? 'Accueil catalogue' : 'Mon espace'}
            aria-label={onDashboard ? "Aller à l'accueil catalogue" : 'Ouvrir mon espace client'}
            onClick={portfolioMobileNavigate}
          >
            {onDashboard ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 11.5 12 4l9 7.5" />
                <path d="M5.5 10.5V20a1 1 0 0 0 1 1h3v-6h5v6h3a1 1 0 0 0 1-1v-9.5" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5 21a7 7 0 0 1 14 0" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </header>
  )
}
