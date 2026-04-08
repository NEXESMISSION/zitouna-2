import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import headerLogo from '../logo-header .png'
import { IconLogout } from './LoginDecor.jsx'
import { isSupabaseConfigured, supabase } from './lib/supabaseClient.js'

export default function TopBar() {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  function close() { setMenuOpen(false) }

  async function handleLogout() {
    close()
    if (isSupabaseConfigured && supabase) {
      await supabase.auth.signOut()
    }
    navigate('/', { replace: true })
  }

  return (
    <header className="top-bar-wrap">
      <div className="top-bar">
        <div className="brand-inline">
          <img src={headerLogo} alt="Zitouna Bladi" className="top-logo" />
          <div>
            <p className="company">ZITOUNA BLADI S.A.</p>
            <p className="company-subtitle">Smart Agriculture</p>
          </div>
        </div>

        {/* desktop nav */}
        <nav className="top-nav">
          <NavLink
            to="/browse"
            className={({ isActive }) => 'top-nav-link' + (isActive ? ' active' : '')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Explorer
          </NavLink>
          <NavLink
            to="/dashboard"
            className={({ isActive }) => 'top-nav-link' + (isActive ? ' active' : '')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            </svg>
            Mon Portfolio
          </NavLink>
        </nav>

        <div className="top-actions">
          <button
            type="button"
            className="icon-action"
            title="Déconnexion"
            onClick={handleLogout}
          >
            <IconLogout />
          </button>

          {/* burger — mobile only */}
          <button
            type="button"
            className="burger-btn icon-action"
            aria-label="Menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* mobile dropdown */}
      {menuOpen && (
        <nav className="mobile-menu">
          <NavLink
            to="/browse"
            className={({ isActive }) => 'mobile-menu-link' + (isActive ? ' active' : '')}
            onClick={close}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Explorer les projets
          </NavLink>
          <NavLink
            to="/dashboard"
            className={({ isActive }) => 'mobile-menu-link' + (isActive ? ' active' : '')}
            onClick={close}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            </svg>
            Mon Portfolio
          </NavLink>
        </nav>
      )}
    </header>
  )
}
