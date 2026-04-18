import { NavLink } from 'react-router-dom'
import { navItemsForUser } from '../adminNavConfig.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import './zitouna-admin-page.css'

// Workflow / grouping definitions — unchanged business logic
const WORKFLOW_ORDER = [
  '/admin/sell',
  '/admin/coordination',
  '/admin/finance',
  '/admin/juridique',
  '/admin/legal',
  '/admin/recouvrement',
  '/admin/cash-sales',
]
const ACQUISITION_GROUP = ['/admin/call-center', '/admin/commercial-calendar']
// Backward-compat alias (some bundles referenced this old constant name).
const COMMERCIAL_GROUP = ACQUISITION_GROUP
const GOVERNANCE_GROUP = ['/admin/users']
const ASSETS_GROUP = ['/admin/projects', '/admin/clients']
const REMUNERATION_GROUP = [
  '/admin/referral-settings',
  '/admin/commission-ledger',
  '/admin/audit-log',
  '/admin/access-grants',
  '/admin/ui-elements',
]

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
  '/admin/call-center': '📞',
  '/admin/commercial-calendar': '🗓️',
  '/admin/referral-settings': '🏷️',
  '/admin/commission-ledger': '💰',
  '/admin/audit-log': '📜',
  '/admin/access-grants': '🔑',
  '/admin/users': '🛡️',
  '/admin/ui-elements': '🎨',
}

// One-line French helper text per module — guidance for first-time staff
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
  '/admin/call-center': 'Gérer les appels entrants et sortants.',
  '/admin/commercial-calendar': 'Planifier les rendez-vous commerciaux.',
  '/admin/referral-settings': 'Configurer les règles de parrainage.',
  '/admin/commission-ledger': 'Consulter le registre des commissions.',
  '/admin/audit-log': "Visualiser l'historique des actions.",
  '/admin/access-grants': 'Gérer les accès temporaires.',
  '/admin/users': 'Créer et gérer les comptes internes.',
  '/admin/ui-elements': "Personnaliser l'apparence de l'interface.",
}

// Greeting by current hour — simple, locale-friendly
function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Bonjour'
  if (h < 18) return 'Bon après-midi'
  return 'Bonsoir'
}

// Extract a friendly first name from full name / email
function getFirstName(adminUser) {
  const name = adminUser?.name?.trim()
  if (name) return name.split(/\s+/)[0]
  const email = adminUser?.email || ''
  if (email.includes('@')) return email.split('@')[0]
  return ''
}

export default function AdminProfilePage() {
  const { adminUser } = useAuth()
  const availableItems = navItemsForUser(adminUser?.allowedPages ?? null)
  const availableByPath = new Map(availableItems.map((item) => [item.to, item]))

  const pickItems = (paths) => paths.map((p) => availableByPath.get(p)).filter(Boolean)

  const acquisitionItems = pickItems(ACQUISITION_GROUP)
  const governanceItems = pickItems(GOVERNANCE_GROUP)
  const workflowItems = pickItems(WORKFLOW_ORDER)
  const assetsItems = pickItems(ASSETS_GROUP)
  const remunerationItems = pickItems(REMUNERATION_GROUP)

  const firstName = getFirstName(adminUser)
  const greeting = getGreeting()
  const totalModules = availableItems.length
  const hasAnyModule = totalModules > 0

  // Render a single quick-access card with icon, label, and one-line hint
  const renderCard = (item, options = {}) => {
    const hint = HINT_BY_PATH[item.to] || 'Accéder au module.'
    return (
      <NavLink key={item.to} to={item.to} className="ap-card" aria-label={item.label}>
        {options.step ? <span className="ap-card__step">{options.step}</span> : null}
        <span className="ap-card__icon" aria-hidden>{ICON_BY_PATH[item.to] || '•'}</span>
        <span className="ap-card__body">
          <span className="ap-card__title">{item.label}</span>
          <span className="ap-card__hint">{hint}</span>
        </span>
        <span className="ap-card__arrow" aria-hidden>→</span>
      </NavLink>
    )
  }

  const renderSection = (title, description, items, { numbered = false } = {}) => {
    if (!items || items.length === 0) return null
    return (
      <section className="ap-section" aria-labelledby={`ap-h-${title}`}>
        <div className="ap-section__head">
          <h2 id={`ap-h-${title}`} className="ap-section__title">{title}</h2>
          {description ? <p className="ap-section__desc">{description}</p> : null}
        </div>
        <div className="ap-grid">
          {items.map((item, index) =>
            renderCard(item, numbered ? { step: index + 1 } : {})
          )}
        </div>
      </section>
    )
  }

  return (
    <div className="zitu-page ap-page">
      {/* Local scoped styles — keep global CSS untouched */}
      <style>{`
        .ap-page { --ap-fg:#0f172a; --ap-muted:#64748b; --ap-border:#e2e8f0; --ap-bg:#f8fafc; --ap-surface:#ffffff; --ap-accent:#2563eb; --ap-accent-soft:#eff6ff; color:var(--ap-fg); }
        .ap-wrap { max-width: 960px; margin: 0 auto; padding: 16px 14px 40px; }
        .ap-hero { background: linear-gradient(135deg, #ffffff 0%, #eff6ff 100%); border:1px solid var(--ap-border); border-radius:16px; padding:20px 22px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
        .ap-hero__eyebrow { font-size:13px; color:var(--ap-muted); letter-spacing:.02em; margin:0 0 4px; }
        .ap-hero__title { margin:0 0 6px; font-size:24px; line-height:1.25; font-weight:700; color:var(--ap-fg); }
        .ap-hero__lead { margin:0; font-size:14px; line-height:1.5; color:#334155; max-width:62ch; }
        .ap-hero__meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
        .ap-pill { display:inline-flex; align-items:center; gap:6px; background:var(--ap-surface); border:1px solid var(--ap-border); border-radius:999px; padding:5px 10px; font-size:13px; color:#334155; }
        .ap-pill strong { color:var(--ap-accent); font-weight:600; }

        .ap-section { margin-top:22px; }
        .ap-section__head { margin:0 0 10px; }
        .ap-section__title { margin:0; font-size:18px; line-height:1.3; font-weight:700; color:var(--ap-fg); }
        .ap-section__desc { margin:2px 0 0; font-size:13px; color:var(--ap-muted); }

        .ap-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:10px; }

        .ap-card { position:relative; display:flex; align-items:center; gap:12px; padding:12px 14px; background:var(--ap-surface); border:1px solid var(--ap-border); border-radius:12px; text-decoration:none; color:var(--ap-fg); transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; min-height:64px; }
        .ap-card:hover { border-color: var(--ap-accent); box-shadow: 0 4px 14px rgba(37,99,235,.10); transform: translateY(-1px); }
        .ap-card:focus-visible { outline: 2px solid var(--ap-accent); outline-offset: 2px; }
        .ap-card__step { flex:0 0 auto; width:24px; height:24px; border-radius:999px; background:var(--ap-accent-soft); color:var(--ap-accent); font-size:13px; font-weight:700; display:flex; align-items:center; justify-content:center; }
        .ap-card__icon { flex:0 0 auto; width:36px; height:36px; border-radius:10px; background:var(--ap-accent-soft); display:flex; align-items:center; justify-content:center; font-size:18px; }
        .ap-card__body { flex:1 1 auto; display:flex; flex-direction:column; min-width:0; }
        .ap-card__title { font-size:14px; font-weight:600; color:var(--ap-fg); line-height:1.3; }
        .ap-card__hint { font-size:13px; color:var(--ap-muted); line-height:1.35; margin-top:2px; overflow:hidden; text-overflow:ellipsis; }
        .ap-card__arrow { flex:0 0 auto; color:var(--ap-muted); font-size:16px; transition: transform .15s ease, color .15s ease; }
        .ap-card:hover .ap-card__arrow { color:var(--ap-accent); transform: translateX(2px); }

        .ap-empty { border:1px dashed var(--ap-border); background:var(--ap-surface); border-radius:12px; padding:16px; text-align:center; color:var(--ap-muted); font-size:13px; }
        .ap-empty strong { display:block; color:var(--ap-fg); font-size:14px; margin-bottom:2px; }

        @media (max-width: 600px) {
          .ap-wrap { padding: 12px 10px 32px; }
          .ap-hero { padding: 16px; border-radius: 14px; }
          .ap-hero__title { font-size: 20px; }
          .ap-grid { grid-template-columns: 1fr; }
          .ap-section__title { font-size: 18px; }
        }
      `}</style>

      <div className="ap-wrap">
        {/* Friendly greeting — plain French, staff-friendly */}
        <header className="ap-hero" role="banner">
          <p className="ap-hero__eyebrow">Espace administrateur</p>
          <h1 className="ap-hero__title">
            {greeting}
            {firstName ? `, ${firstName}` : ''}. Voici votre espace admin.
          </h1>
          <p className="ap-hero__lead">
            Choisissez un module pour commencer. Chaque carte indique à quoi elle sert.
          </p>
          <div className="ap-hero__meta">
            <span className="ap-pill">
              <strong>{totalModules}</strong> module{totalModules > 1 ? 's' : ''} disponible{totalModules > 1 ? 's' : ''}
            </span>
            {adminUser?.name ? (
              <span className="ap-pill">Connecté : {adminUser.name}</span>
            ) : (
              <span className="ap-pill">Connecté en tant qu'administrateur</span>
            )}
          </div>
        </header>

        {/* Empty state — no modules at all */}
        {!hasAnyModule ? (
          <section className="ap-section" aria-label="Aucun module">
            <div className="ap-empty">
              <strong>Aucun module accessible pour le moment</strong>
              Contactez un administrateur pour obtenir les accès nécessaires.
            </div>
          </section>
        ) : (
          <>
            {renderSection(
              'Flux opérationnel principal',
              'Suivez les étapes dans l\'ordre, du 1 au dernier.',
              workflowItems,
              { numbered: true }
            )}

            {renderSection(
              'Acquisition',
              'Appels, prospection et rendez-vous commerciaux.',
              acquisitionItems
            )}

            {renderSection(
              'Actifs & clients',
              'Projets, lots et fichier clients.',
              assetsItems
            )}

            {renderSection(
              'Gouvernance & permissions',
              'Comptes internes et droits d\'accès.',
              governanceItems
            )}

            {renderSection(
              'Contrôle & journaux',
              'Commissions, audits et réglages avancés.',
              remunerationItems
            )}
          </>
        )}
      </div>
    </div>
  )
}
