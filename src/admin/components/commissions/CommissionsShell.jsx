import { useMemo } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import './commissions-shell.css'

// /admin/commissions shell. The index route is the network tree and runs
// chromeless (no header, no tabs) so the chart owns the full viewport — the
// tree has its own toolbar with a "⋯ Autres vues" menu linking to the sub-
// routes below. Sub-routes (ledger, analytics, etc.) get the standard shell:
// back arrow + title + tab strip.

const SUB_TABS = [
  { to: '/admin/commissions/ledger',         label: 'Journal',       icon: '💰' },
  { to: '/admin/commissions/analytics',      label: 'Analyses',      icon: '📈' },
  { to: '/admin/commissions/reverse-grants', label: 'Droits acquis', icon: '⇅' },
  { to: '/admin/commissions/anomalies',      label: 'Anomalies',     icon: '⚠' },
]

export default function CommissionsShell() {
  const loc = useLocation()
  const navigate = useNavigate()

  // The index path IS the tree — render chromeless so the chart fills the page.
  const isTreeRoute = useMemo(() => {
    const path = loc.pathname.replace(/\/$/, '')
    return path === '/admin/commissions'
  }, [loc.pathname])

  if (isTreeRoute) {
    return (
      <div className="cxs cxs--tree" dir="ltr">
        <Outlet />
      </div>
    )
  }

  return (
    <div className="cxs" dir="ltr">
      <header className="cxs__top">
        <button
          type="button"
          className="cxs__back"
          aria-label="Retour à l'arbre des commissions"
          title="Retour à l'arbre"
          onClick={() => navigate('/admin/commissions')}
        >
          <span aria-hidden>←</span>
        </button>
        <h1 className="cxs__title">Commissions</h1>
      </header>

      <nav className="cxs__tabs" role="tablist" aria-label="Sections commissions">
        {SUB_TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) => `cxs__tab ${isActive ? 'cxs__tab--on' : ''}`}
            role="tab"
          >
            <span className="cxs__tab-icon" aria-hidden>{t.icon}</span>
            <span className="cxs__tab-label">{t.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="cxs__body" role="tabpanel">
        <Outlet />
      </div>
    </div>
  )
}
