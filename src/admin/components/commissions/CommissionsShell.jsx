import { useMemo } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import './commissions-shell.css'

// Unified shell for everything commission-related. Replaces four independent
// nav entries (Commissions / Ledger / Analytics / Anomalies) with a single
// landing + tab set. Old routes are preserved via redirects in App.jsx.

const TABS = [
  { to: '/admin/commissions',                 label: "Vue d'ensemble", icon: '📊', end: true },
  { to: '/admin/commissions/network',         label: 'Réseau',         icon: '🌳' },
  { to: '/admin/commissions/ledger',          label: 'Journal',        icon: '💰' },
  { to: '/admin/commissions/analytics',       label: 'Analyses',       icon: '📈' },
  { to: '/admin/commissions/reverse-grants',  label: 'Droits acquis',  icon: '⇅' },
  { to: '/admin/commissions/anomalies',       label: 'Anomalies',      icon: '⚠' },
]

export default function CommissionsShell() {
  const loc = useLocation()
  const navigate = useNavigate()

  const activeIndex = useMemo(() => {
    const path = loc.pathname.replace(/\/$/, '')
    let best = 0
    let bestLen = 0
    TABS.forEach((t, i) => {
      if (t.end) {
        if (path === t.to && t.to.length >= bestLen) { best = i; bestLen = t.to.length }
      } else if (path === t.to || path.startsWith(`${t.to}/`)) {
        if (t.to.length > bestLen) { best = i; bestLen = t.to.length }
      }
    })
    return best
  }, [loc.pathname])

  // `fullbleed` variant strips the shell padding so the Network tab (org
  // chart SVG) can fill the viewport edge-to-edge like the previous design.
  const fullbleed = activeIndex === 1

  return (
    <div className={`cxs ${fullbleed ? 'cxs--bleed' : ''}`} dir="ltr">
      <header className="cxs__top">
        <div className="cxs__top-left">
          <button
            type="button"
            className="cxs__back"
            aria-label="Retour"
            title="Retour"
            onClick={() => navigate(-1)}
          >
            <span aria-hidden>←</span>
          </button>
          <div className="cxs__title-block">
            <h1 className="cxs__title">Commissions</h1>
            <p className="cxs__subtitle">
              Suivi, validation, paiement et analyse du réseau de commissions.
            </p>
          </div>
        </div>
      </header>

      <nav className="cxs__tabs" role="tablist" aria-label="Sections commissions">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end || false}
            className={({ isActive }) => `cxs__tab ${isActive ? 'cxs__tab--on' : ''}`}
            role="tab"
          >
            <span className="cxs__tab-icon" aria-hidden>{t.icon}</span>
            <span className="cxs__tab-label">{t.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className={`cxs__body ${fullbleed ? 'cxs__body--bleed' : ''}`} role="tabpanel">
        <Outlet />
      </div>
    </div>
  )
}
