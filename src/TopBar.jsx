import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import headerLogo from '../logo-header2.png'
import { loadInstallments } from './installmentsStore.js'
import { loadVisitRequests } from './visitRequestsStore.js'

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
}

export default function TopBar() {
  const navigate = useNavigate()
  const location = useLocation()
  const onDashboard = location.pathname === '/dashboard'
  const [alertsOpen, setAlertsOpen] = useState(false)
  const alertsRef = useRef(null)

  const alerts = useMemo(() => {
    const plans = loadInstallments()
    const allPayments = plans.flatMap((plan) =>
      plan.payments.map((p) => ({
        ...p,
        planId: plan.id,
        projectTitle: plan.projectTitle,
      })),
    )
    const sortedByDue = [...allPayments].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    const pendingPayments = allPayments.filter((p) => p.status === 'pending')
    const rejectedPayments = allPayments.filter((p) => p.status === 'rejected')
    const underReview = allPayments.filter((p) => p.status === 'submitted')
    const approvedPayments = allPayments.filter((p) => p.status === 'approved')
    const pendingVisits = loadVisitRequests().filter((v) => v.status === 'new')
    const nextDue = sortedByDue.find((p) => p.status === 'pending' || p.status === 'rejected' || p.status === 'submitted')
    const nextReview = underReview[0]
    const latestApproved = approvedPayments.sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate))[0]

    const built = [
      nextDue ? {
        id: 'next-due',
        tone: nextDue.status === 'rejected' ? 'critical' : nextDue.status === 'pending' ? 'warn' : 'info',
        title: `Prochaine échéance: ${nextDue.amount.toLocaleString()} DT`,
        subtitle: `${nextDue.projectTitle} · F.${nextDue.month} · dû le ${fmtDate(nextDue.dueDate)}`,
        action: () => navigate('/installments'),
      } : null,
      {
        id: 'payments-pending',
        tone: (pendingPayments.length + rejectedPayments.length) > 0 ? 'warn' : 'ok',
        title: `${pendingPayments.length} paiement(s) à traiter`,
        subtitle: (pendingPayments.length + rejectedPayments.length) > 0
          ? `${rejectedPayments.length} reçu(x) rejeté(s), ${pendingPayments.length} en attente.`
          : 'Aucun paiement en attente.',
        action: () => navigate('/installments'),
      },
      {
        id: 'payments-review',
        tone: underReview.length > 0 ? 'info' : 'ok',
        title: `${underReview.length} reçu(s) en révision`,
        subtitle: underReview.length > 0
          ? `${nextReview?.projectTitle || 'Reçu'} · F.${nextReview?.month || '—'} en attente de validation.`
          : 'Aucun reçu en révision.',
        action: () => navigate('/installments'),
      },
      latestApproved ? {
        id: 'payments-approved',
        tone: 'success',
        title: 'Dernier reçu validé',
        subtitle: `${latestApproved.projectTitle} · F.${latestApproved.month} (${latestApproved.amount.toLocaleString()} DT)`,
        action: () => navigate('/installments'),
      } : null,
      {
        id: 'visits-pending',
        tone: pendingVisits.length > 0 ? 'warn' : 'ok',
        title: `${pendingVisits.length} rendez-vous non traités`,
        subtitle: pendingVisits.length > 0
          ? 'Nouveaux rendez-vous enregistrés.'
          : 'Aucun nouveau rendez-vous.',
        action: () => navigate('/admin'),
      },
      {
        id: 'explore-cta',
        tone: 'ok',
        title: 'Nouveaux projets disponibles',
        subtitle: 'Explorer les parcelles et opportunités récentes.',
        action: () => navigate('/browse'),
      },
    ]
    return built.filter(Boolean)
  }, [navigate])

  const unreadCount = alerts.filter((a) => a.tone !== 'ok').length

  const portfolioMobileNavigate = () => {
    if (onDashboard) navigate('/browse')
    else navigate('/dashboard')
  }

  useEffect(() => {
    if (!alertsOpen) return
    const onPointerDown = (e) => {
      if (!alertsRef.current?.contains(e.target)) setAlertsOpen(false)
    }
    const onEsc = (e) => {
      if (e.key === 'Escape') setAlertsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [alertsOpen])

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
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Mon Portfolio
          </NavLink>
        </nav>

        <div className="top-actions">
          {/* map projects shortcut */}
          <NavLink
            to="/maps"
            className={({ isActive }) => 'icon-action top-map-action' + (isActive ? ' active' : '')}
            title="Carte des projets"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
          </NavLink>

          {/* notification bell — always visible */}
          <button
            type="button"
            className={`icon-action top-alert-btn${alertsOpen ? ' active' : ''}`}
            title="Notifications"
            aria-label="Notifications"
            onClick={() => setAlertsOpen((v) => !v)}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {unreadCount > 0 ? <span className="top-alert-badge">{unreadCount}</span> : null}
          </button>

          {/* profil — mobile: sur le dashboard → Explorer, sinon → profil / portfolio */}
          <button
            type="button"
            className={`portfolio-nav-btn icon-action${onDashboard ? ' portfolio-nav-btn--explore' : ''}`}
            title={onDashboard ? 'Explorer' : 'Mon profil'}
            aria-label={onDashboard ? 'Explorer' : 'Mon profil'}
            onClick={portfolioMobileNavigate}
          >
            {onDashboard ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {alertsOpen && (
        <div className="top-alert-pop" ref={alertsRef}>
          <div className="top-alert-pop__head">
            <strong>Notifications</strong>
            <span>{unreadCount} non lue(s)</span>
          </div>
          <div className="top-alert-pop__list">
            {alerts.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`top-alert-item top-alert-item--${item.tone}`}
                onClick={() => {
                  setAlertsOpen(false)
                  item.action()
                }}
              >
                <p>{item.title}</p>
                <small>{item.subtitle}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </header>
  )
}
