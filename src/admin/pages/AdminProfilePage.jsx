import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { navItemsForUser } from '../adminNavConfig.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useSales, useAdminUsers } from '../../lib/useSupabase.js'
import { useToast } from '../components/AdminToast.jsx'
import { runSafeAction } from '../../lib/runSafeAction.js'
import { preloadRoute } from '../../lib/routePreload.js'
import './sell-field.css'
import './admin-profile.css'

// Preserve the canonical workflow / grouping definitions so cards
// render in the same staff-friendly order as before.
const WORKFLOW_ORDER = [
  '/admin/sell',
  '/admin/coordination',
  '/admin/finance',
  '/admin/legal',
  '/admin/juridique',
  '/admin/recouvrement',
  '/admin/recouvrement2',
  '/admin/cash-sales',
]
const ACQUISITION_GROUP = ['/admin/call-center', '/admin/commercial-calendar']
const ASSETS_GROUP = ['/admin/projects', '/admin/clients']
const GOVERNANCE_GROUP = ['/admin/users', '/admin/client-link-repair', '/admin/phone-changes']
const REMUNERATION_GROUP = [
  '/admin/commissions',
  '/admin/commission-ledger',
  '/admin/commissions/analytics',
  '/admin/commissions/anomalies',
  '/admin/audit-log',
]

// Per-module icon + hint — preserved from the previous page so
// no French copy is lost.
const ICON_BY_PATH = {
  '/admin/projects': '📁',
  '/admin/sell': '💼',
  '/admin/cash-sales': '💵',
  '/admin/coordination': '🧭',
  '/admin/finance': '💰',
  '/admin/juridique': '⚖️',
  '/admin/legal': '🖋️',
  '/admin/clients': '🧑‍🤝‍🧑',
  '/admin/recouvrement': '💳',
  '/admin/recouvrement2': '🚨',
  '/admin/call-center': '📞',
  '/admin/commercial-calendar': '🗓️',
  '/admin/commissions': '🌳',
  '/admin/commission-ledger': '📒',
  '/admin/commissions/analytics': '📈',
  '/admin/commissions/anomalies': '🚩',
  '/admin/audit-log': '📜',
  '/admin/users': '🛡️',
  '/admin/client-link-repair': '🔗',
  '/admin/phone-changes': '📞',
}

const HINT_BY_PATH = {
  '/admin/projects': 'Gérer les projets et les lots fonciers.',
  '/admin/sell': 'Enregistrer et suivre les ventes en cours.',
  '/admin/cash-sales': 'Saisir les ventes au comptant.',
  '/admin/coordination': 'Coordonner les étapes entre équipes.',
  '/admin/finance': 'Suivre les encaissements et la trésorerie.',
  '/admin/juridique': 'Préparer les dossiers juridiques.',
  '/admin/legal': 'Finaliser les actes et signatures.',
  '/admin/clients': 'Consulter la base clients.',
  '/admin/recouvrement': 'Relancer les paiements en retard.',
  '/admin/recouvrement2': 'Paiements non réglés depuis 2+ mois.',
  '/admin/call-center': 'Gérer les appels entrants et sortants.',
  '/admin/commercial-calendar': 'Planifier les rendez-vous commerciaux.',
  '/admin/commissions': 'Suivre et analyser les commissions.',
  '/admin/commission-ledger': 'Consulter le registre des commissions.',
  '/admin/commissions/analytics': 'Analyses et tendances des commissions.',
  '/admin/commissions/anomalies': 'Détecter les anomalies de parrainage.',
  '/admin/audit-log': "Visualiser l'historique des actions.",
  '/admin/users': 'Créer et gérer les comptes internes.',
  '/admin/client-link-repair': 'Réparer les liens client orphelins.',
  '/admin/phone-changes': 'Examiner les demandes de changement de téléphone.',
}

// Tone used for the left border of each nav card. Picked to keep
// the dashboard easy to scan: blue = core flow, orange =
// acquisition, green = assets, red = governance, purple =
// commissions / audit.
const TONE_BY_PATH = {
  '/admin/sell': 'blue',
  '/admin/coordination': 'blue',
  '/admin/finance': 'blue',
  '/admin/juridique': 'blue',
  '/admin/legal': 'blue',
  '/admin/recouvrement': 'blue',
  '/admin/recouvrement2': 'red',
  '/admin/cash-sales': 'blue',
  '/admin/call-center': 'orange',
  '/admin/commercial-calendar': 'orange',
  '/admin/projects': 'green',
  '/admin/clients': 'green',
  '/admin/users': 'red',
  '/admin/client-link-repair': 'red',
  '/admin/phone-changes': 'red',
  '/admin/commissions': 'purple',
  '/admin/commission-ledger': 'purple',
  '/admin/commissions/analytics': 'purple',
  '/admin/commissions/anomalies': 'purple',
  '/admin/audit-log': 'purple',
}

// Greeting by current hour — simple, locale-friendly
function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Bonjour'
  if (h < 18) return 'Bon après-midi'
  return 'Bonsoir'
}

function getFirstName(adminUser) {
  const name = adminUser?.name?.trim()
  if (name) return name.split(/\s+/)[0]
  const email = adminUser?.email || ''
  if (email.includes('@')) return email.split('@')[0]
  return ''
}

function initials(nameOrEmail) {
  const raw = String(nameOrEmail || '').trim()
  if (!raw) return 'AD'
  const parts = raw.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase()
  }
  const base = parts[0] || ''
  return base.slice(0, 2).toUpperCase() || 'AD'
}

// Pending-count derivation per module. Uses already-loaded sales
// so we don't trigger any extra network roundtrips just for badges.
function computeSalesBadges(sales) {
  const out = Object.create(null)
  for (const s of sales || []) {
    const st = String(s.status || '')
    if (st === 'pending_coordination') out.coordination = (out.coordination || 0) + 1
    if (st === 'pending_finance')      out.finance      = (out.finance      || 0) + 1
    if (st === 'pending_legal') {
      // pending_legal covers both the legal/juridique and notary screens
      // depending on project workflow — count once per screen.
      out.legal     = (out.legal     || 0) + 1
      out.juridique = (out.juridique || 0) + 1
    }
  }
  return out
}

function badgeForPath(path, sales) {
  const s = computeSalesBadges(sales)
  switch (path) {
    case '/admin/coordination': return s.coordination || 0
    case '/admin/finance':      return s.finance      || 0
    case '/admin/legal':        return s.legal        || 0
    case '/admin/juridique':    return s.juridique    || 0
    default: return 0
  }
}

export default function AdminProfilePage() {
  const navigate = useNavigate()
  const { adminUser, allowedPages, logout, forgotPassword } = useAuth()
  const { addToast } = useToast()
  const { sales, loading: salesLoading } = useSales()
  const { adminUsers, loading: adminUsersLoading } = useAdminUsers()

  const [loggingOut, setLoggingOut] = useState(false)
  const [sendingReset, setSendingReset] = useState(false)

  const availableItems = useMemo(
    () => navItemsForUser(allowedPages ?? null),
    [allowedPages],
  )
  const availableByPath = useMemo(
    () => new Map(availableItems.map((item) => [item.to, item])),
    [availableItems],
  )
  const pickItems = (paths) => paths.map((p) => availableByPath.get(p)).filter(Boolean)

  const workflowItems     = pickItems(WORKFLOW_ORDER)
  const acquisitionItems  = pickItems(ACQUISITION_GROUP)
  const assetsItems       = pickItems(ASSETS_GROUP)
  const governanceItems   = pickItems(GOVERNANCE_GROUP)
  const remunerationItems = pickItems(REMUNERATION_GROUP)

  // After the admin hub has painted, warm up the top-of-funnel pages so the
  // first click into the daily workflow feels instant. Staggered via
  // requestIdleCallback to avoid contending with post-login data fetches.
  useEffect(() => {
    const hotPaths = [
      '/admin/sell',
      '/admin/coordination',
      '/admin/finance',
      '/admin/legal',
      '/admin/juridique',
      '/admin/clients',
      '/admin/recouvrement',
      '/admin/projects',
    ].filter((p) => availableByPath.has(p))
    if (hotPaths.length === 0) return
    const ric = window.requestIdleCallback || ((cb) => window.setTimeout(cb, 200))
    const cancel = window.cancelIdleCallback || window.clearTimeout
    const handles = hotPaths.map((path, i) =>
      ric(() => preloadRoute(path), { timeout: 1500 + i * 200 }),
    )
    return () => handles.forEach((h) => { try { cancel(h) } catch { /* ignore */ } })
  }, [availableByPath])

  const firstName   = getFirstName(adminUser)
  const greeting    = getGreeting()
  const displayName = adminUser?.name || adminUser?.email || 'Administrateur'
  const roleLabel   = allowedPages === null
    ? 'Super Administrateur'
    : 'Administrateur'

  // KPI summary: total modules, sales in progress (pending
  // coordination / finance / legal), staff count (super admin only).
  const inProgressCount = useMemo(() => {
    const inFlight = new Set(['pending_coordination', 'pending_finance', 'pending_legal'])
    return (sales || []).filter((s) => inFlight.has(String(s.status || ''))).length
  }, [sales])

  const totalModules = availableItems.length
  const hasAnyModule = totalModules > 0
  const staffCount   = (adminUsers || []).length

  const handleLogout = async () => {
    await runSafeAction(
      {
        setBusy: setLoggingOut,
        onError: (m) => addToast(m, 'error'),
        label: 'Déconnexion',
      },
      async () => {
        await logout()
        // AuthProvider clears state — App.jsx will redirect to /login.
        addToast('Déconnexion effectuée')
      },
    )
  }

  const handlePasswordReset = async () => {
    if (!adminUser?.email) {
      addToast("Aucune adresse e-mail associée à ce compte.", 'error')
      return
    }
    await runSafeAction(
      {
        setBusy: setSendingReset,
        onError: (m) => addToast(m, 'error'),
        label: 'Envoi du lien de réinitialisation',
      },
      async () => {
        const res = await forgotPassword(adminUser.email)
        if (!res?.ok) throw new Error(res?.error || 'Échec de l\'envoi')
        addToast('Lien de réinitialisation envoyé par e-mail')
      },
    )
  }

  const showSalesSkeleton = salesLoading && (sales || []).length === 0
  const isSuperAdmin = allowedPages === null
  const showStaffSkeleton = isSuperAdmin && adminUsersLoading && (adminUsers || []).length === 0

  const renderNavCard = (item) => {
    const tone  = TONE_BY_PATH[item.to] || 'gray'
    const icon  = ICON_BY_PATH[item.to] || '•'
    const hint  = HINT_BY_PATH[item.to] || 'Accéder au module.'
    const count = badgeForPath(item.to, sales)
    const warmUp = () => preloadRoute(item.to)
    return (
      <button
        key={item.to}
        type="button"
        className={`ap-nav-card ap-nav-card--${tone}`}
        onClick={() => navigate(item.to)}
        onMouseEnter={warmUp}
        onFocus={warmUp}
        onTouchStart={warmUp}
        aria-label={item.label}
      >
        <span className="ap-nav-card__icon" aria-hidden>{icon}</span>
        <span className="ap-nav-card__body">
          <span className="ap-nav-card__name">{item.label}</span>
          <span className="ap-nav-card__hint">{hint}</span>
        </span>
        <span className="ap-nav-card__right">
          {count > 0 ? (
            <span className={`sp-badge sp-badge--${tone === 'blue' ? 'orange' : tone}`}>
              {count} en attente
            </span>
          ) : null}
          <span className="ap-nav-card__arrow" aria-hidden>→</span>
        </span>
      </button>
    )
  }

  const renderSection = (title, desc, items) => {
    if (!items || items.length === 0) return null
    return (
      <section className="ap-section">
        <div className="ap-section__head">
          <h2 className="ap-section__title">{title}</h2>
          {desc ? <span className="ap-section__desc">{desc}</span> : null}
        </div>
        <div className="sp-cards">
          {items.map(renderNavCard)}
        </div>
      </section>
    )
  }

  return (
    <div className="sell-field" dir="ltr">
      <button
        type="button"
        className="sp-back-btn"
        onClick={() => navigate('/browse')}
        aria-label="Retour au site public"
      >
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour au site</span>
      </button>

      <header className="sp-hero">
        <div className="sp-hero__avatar" aria-hidden>
          <span className="ap-hero__initials">{initials(displayName)}</span>
        </div>
        <div className="sp-hero__info">
          <p className="ap-hero__greet">
            {greeting}{firstName ? `, ${firstName}` : ''}
          </p>
          <h1 className="sp-hero__name">{displayName}</h1>
          <p className="sp-hero__role">{roleLabel}</p>
        </div>
        <div className="sp-hero__kpis ap-hero__kpi-group">
          <div className="ap-hero__kpi">
            <span className="ap-hero__kpi-num">
              {showSalesSkeleton ? <span className="sk-num sk-num--wide" /> : inProgressCount}
            </span>
            <span className="ap-hero__kpi-label">en cours</span>
          </div>
          <div className="ap-hero__kpi">
            <span className="ap-hero__kpi-num">{totalModules}</span>
            <span className="ap-hero__kpi-label">module{totalModules > 1 ? 's' : ''}</span>
          </div>
        </div>
      </header>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{totalModules}</strong> module{totalModules > 1 ? 's' : ''} accessible{totalModules > 1 ? 's' : ''}
          <span className="sp-cat-stat-dot" />
          <strong>{showSalesSkeleton ? <span className="sk-num" /> : inProgressCount}</strong>
          {' '}vente{inProgressCount > 1 ? 's' : ''} à traiter
          {isSuperAdmin ? (
            <>
              <span className="sp-cat-stat-dot" />
              <strong>{showStaffSkeleton ? <span className="sk-num" /> : staffCount}</strong>
              {' '}membre{staffCount > 1 ? 's' : ''} staff
            </>
          ) : null}
        </div>
      </div>

      {!hasAnyModule ? (
        <div className="sp-empty">
          <span className="sp-empty__emoji" aria-hidden>🔒</span>
          <div className="sp-empty__title">Aucun module accessible</div>
          <p style={{ margin: '4px 0 0' }}>
            Contactez un administrateur pour obtenir les accès nécessaires.
          </p>
        </div>
      ) : (
        <>
          {renderSection(
            'Flux opérationnel',
            'Étapes de la vente',
            workflowItems,
          )}

          {renderSection(
            'Acquisition',
            'Prospection et rendez-vous',
            acquisitionItems,
          )}

          {renderSection(
            'Actifs & clients',
            'Projets, lots et fichier clients',
            assetsItems,
          )}

          {renderSection(
            'Gouvernance',
            'Comptes et droits d\'accès',
            governanceItems,
          )}

          {renderSection(
            'Contrôle & journaux',
            'Commissions, audits et analyses',
            remunerationItems,
          )}
        </>
      )}

      <section className="ap-account" aria-label="Mon compte">
        <h2 className="ap-account__title">Mon compte</h2>
        <div className="ap-account__row">
          <span>Nom</span>
          <strong>{adminUser?.name || '—'}</strong>
        </div>
        <div className="ap-account__row">
          <span>E-mail</span>
          <strong>{adminUser?.email || '—'}</strong>
        </div>
        <div className="ap-account__row">
          <span>Rôle</span>
          <strong>{roleLabel}</strong>
        </div>
        <div className="ap-account__row">
          <span>Authentification à deux facteurs</span>
          <strong style={{ color: 'var(--sp-500)', fontWeight: 600 }}>
            Bientôt disponible
          </strong>
        </div>

        <div className="ap-account__actions">
          <button
            type="button"
            className="ap-account__btn"
            onClick={handlePasswordReset}
            disabled={sendingReset || !adminUser?.email}
            title="Recevoir un lien de réinitialisation par e-mail"
          >
            {sendingReset ? 'Envoi…' : 'Changer le mot de passe'}
          </button>
          <button
            type="button"
            className="ap-account__btn ap-account__btn--danger"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {loggingOut ? 'Déconnexion…' : 'Se déconnecter'}
          </button>
        </div>
      </section>
    </div>
  )
}
