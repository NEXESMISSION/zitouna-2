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
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
            </button>
          )}

          <NotificationsMenu />

          <button
            type="button"
            className={`portfolio-nav-btn icon-action${onDashboard ? ' portfolio-nav-btn--explore' : ''}`}
            title={onDashboard ? 'Explorer' : 'Mon espace'}
            aria-label={onDashboard ? 'Explorer' : 'Mon espace'}
            onClick={portfolioMobileNavigate}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 9.5V21h14V9.5" />
              <path d="M10 21v-6h4v6" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}
