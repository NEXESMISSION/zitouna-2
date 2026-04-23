import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import NotificationsMenu from './NotificationsMenu.jsx'
import headerLogo from '../../logo-header2.png'

/*
 * DashboardShell — shared sidebar + topbar used across the customer-facing
 * dashboard pages (Tableau de bord, Portefeuille, Échéances, Commissions,
 * Arbre, Retirer). Mirrors the layout defined inline in DashboardPage.
 *
 * Props:
 *   active   — id of the nav item to highlight. One of:
 *              'dashboard' | 'browse' | 'installments' | 'commissions'
 *              | 'tree' | 'payout'
 *   children — page content rendered in the main column, below the topbar.
 *
 * The "Profil" nav item navigates to /dashboard?profile=1 — DashboardPage
 * watches that query param and opens the profile popup automatically, so
 * the edit experience stays in one place without duplicating 400 lines of
 * phone-change / profile-form state in every page.
 */

const NAV_ITEMS = [
  {
    id: 'dashboard',
    label: 'Tableau de bord',
    path: '/dashboard',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
    ),
  },
  {
    id: 'browse',
    label: 'Portefeuille',
    path: '/browse',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20l8-16 8 16H4z"/><path d="M8 16l4-8 4 8"/></svg>
    ),
  },
  {
    id: 'installments',
    label: 'Échéances',
    path: '/installments',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7h18M3 12h18M3 17h12"/></svg>
    ),
  },
  {
    id: 'harvests',
    label: 'Récoltes',
    path: '/my/harvests',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3c4 3 6 7 6 11a6 6 0 0 1-12 0c0-4 2-8 6-11z"/>
        <path d="M12 14v6"/>
      </svg>
    ),
  },
  {
    id: 'commissions',
    label: 'Commissions',
    path: '/my/commissions',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/></svg>
    ),
  },
  {
    id: 'tree',
    label: 'Arbre',
    path: '/my/tree',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.8 7.8l3.4 8.4M16.2 7.8l-3.4 8.4"/></svg>
    ),
  },
  {
    id: 'payout',
    label: 'Retirer',
    path: '/my/payout',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12h12M12 5l7 7-7 7"/></svg>
    ),
  },
]

export default function DashboardShell({ active, children }) {
  const navigate = useNavigate()
  const auth = useAuth()
  const { user, adminUser, logout } = auth

  const hasAdminAccess = auth?.hasAdminAccess
  const canAccessSellPortal = auth?.canAccessSellPortal
  const adminTarget = auth?.adminTarget || '/admin'
  const showAdminEntry = Boolean(hasAdminAccess || canAccessSellPortal)
  const adminEntryTarget = hasAdminAccess ? adminTarget : '/admin/sell'

  const displayName = adminUser?.name || user?.firstname || user?.name || 'Investisseur'
  const initials =
    (displayName || 'ZB')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'ZB'

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  const openProfile = () => navigate('/my/profile')

  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
  const avatarMenuRef = useRef(null)
  useEffect(() => {
    if (!avatarMenuOpen) return undefined
    const onDoc = (e) => {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target)) {
        setAvatarMenuOpen(false)
      }
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setAvatarMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [avatarMenuOpen])

  return (
    <main className="screen screen--app">
      <section className="zb-dash">
        <div className="zb-page">
          <aside className="zb-side">
            <div className="zb-brand">
              <div className="zb-brand-mark" aria-hidden>
                <img src={headerLogo} alt="" />
              </div>
              <div>
                <div className="zb-brand-name">Zitouna Bladi</div>
                <div className="zb-brand-sub">Smart Agriculture</div>
              </div>
            </div>

            <nav className="zb-nav">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={active === item.id ? 'zb-nav-active' : undefined}
                  onClick={() => navigate(item.path)}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}

              <div className="zb-nav-group-title">Compte</div>
              <button
                type="button"
                className={active === 'profile' ? 'zb-nav-active' : undefined}
                onClick={openProfile}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>
                Profil
              </button>
              {showAdminEntry && (
                <button type="button" onClick={() => navigate(adminEntryTarget)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                  {hasAdminAccess ? 'Admin' : 'Ventes'}
                </button>
              )}
              <button type="button" onClick={handleLogout}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Déconnexion
              </button>
            </nav>
          </aside>

          <main className="zb-main">
            <div className="zb-topbar">
              <button
                type="button"
                className="zb-back"
                onClick={() => navigate('/dashboard')}
                aria-label="Retour au tableau de bord"
                title="Retour au tableau de bord"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <div className="zb-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
                <input type="text" placeholder="Rechercher une parcelle, un projet…" readOnly />
              </div>
              <div className="zb-topbar-actions">
                <NotificationsMenu />
                <div className="zb-avatar-wrap" ref={avatarMenuRef}>
                  <button
                    type="button"
                    className="zb-avatar"
                    onClick={() => setAvatarMenuOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={avatarMenuOpen}
                    aria-label="Menu du compte"
                    title={displayName}
                  >
                    {initials}
                  </button>
                  {avatarMenuOpen && (
                    <div className="zb-avatar-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setAvatarMenuOpen(false)
                          openProfile()
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>
                        Mon profil
                      </button>
                      {showAdminEntry && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setAvatarMenuOpen(false)
                            navigate(adminEntryTarget)
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>
                          {hasAdminAccess ? 'Admin' : 'Ventes'}
                        </button>
                      )}
                      <hr />
                      <button
                        type="button"
                        role="menuitem"
                        className="zb-danger"
                        onClick={() => {
                          setAvatarMenuOpen(false)
                          handleLogout()
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                        Déconnexion
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {children}
          </main>
        </div>
      </section>
    </main>
  )
}
