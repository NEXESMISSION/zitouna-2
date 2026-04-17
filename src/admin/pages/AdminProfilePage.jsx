import { NavLink } from 'react-router-dom'
import { navItemsForUser } from '../adminNavConfig.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import './zitouna-admin-page.css'

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

export default function AdminProfilePage() {
  const { adminUser } = useAuth()
  const availableItems = navItemsForUser(adminUser?.allowedPages ?? null)
  const availableByPath = new Map(availableItems.map((item) => [item.to, item]))

  const acquisitionItems = ACQUISITION_GROUP
    .map((path) => availableByPath.get(path))
    .filter(Boolean)

  const governanceItems = GOVERNANCE_GROUP
    .map((path) => availableByPath.get(path))
    .filter(Boolean)

  const workflowItems = WORKFLOW_ORDER
    .map((path) => availableByPath.get(path))
    .filter(Boolean)

  const assetsItems = ASSETS_GROUP
    .map((path) => availableByPath.get(path))
    .filter(Boolean)

  const remunerationItems = REMUNERATION_GROUP
    .map((path) => availableByPath.get(path))
    .filter(Boolean)

  return (
    <div className="zitu-page">
      <div className="zitu-page__column">
        <header className="zitu-page__header">
          <div className="zitu-page__header-icon">⚙️</div>
          <div className="zitu-page__header-text">
            <h1>Console d'administration</h1>
            <p>Unites operationnelles du systeme</p>
          </div>
        </header>

        <div className="zitu-page__section" style={{ padding: 12 }}>
          <div className="zitu-page__section-desc" style={{ marginBottom: 10 }}>
            {adminUser?.name ? `Connecte : ${adminUser.name}` : 'Connecte en tant qu administrateur'} • {availableItems.length} modules
          </div>

          {acquisitionItems.length > 0 && (
            <>
              <div className="zp-section">Acquisition</div>
              <div className="zp-modules" style={{ marginBottom: 10 }}>
                {acquisitionItems.map((item) => (
                  <NavLink key={item.to} to={item.to} className="zp-mod zp-mod--primary">
                    <span className="zp-mod__left">
                      <span className="zp-mod__ico" aria-hidden>{ICON_BY_PATH[item.to] || '•'}</span>
                      <span className="zp-mod__label">{item.label}</span>
                    </span>
                    <span className="zp-mod__chevron" aria-hidden>←</span>
                  </NavLink>
                ))}
              </div>
            </>
          )}

          {governanceItems.length > 0 && (
            <>
              <div className="zp-section">Gouvernance & permissions</div>
              <div className="zp-modules" style={{ marginBottom: 10 }}>
                {governanceItems.map((item) => (
                  <NavLink key={item.to} to={item.to} className="zp-mod zp-mod--primary">
                    <span className="zp-mod__left">
                      <span className="zp-mod__ico" aria-hidden>{ICON_BY_PATH[item.to] || '•'}</span>
                      <span className="zp-mod__label">{item.label}</span>
                    </span>
                    <span className="zp-mod__chevron" aria-hidden>←</span>
                  </NavLink>
                ))}
              </div>
            </>
          )}

          <div className="zp-section">Flux operationnel principal</div>
          <div className="zp-modules" style={{ marginBottom: 10 }}>
            {workflowItems.map((item, index) => (
              <NavLink key={item.to} to={item.to} className="zp-mod zp-mod--primary">
                <span className="zp-mod__left">
                  <span className="zp-mod__step zp-mod__step--primary">{index + 1}</span>
                  <span className="zp-mod__ico" aria-hidden>{ICON_BY_PATH[item.to] || '•'}</span>
                  <span className="zp-mod__label">{item.label}</span>
                </span>
                <span className="zp-mod__chevron" aria-hidden>←</span>
              </NavLink>
            ))}
          </div>

          <div className="zp-section zp-section--secondary">Actifs & clients</div>
          <div className="zp-modules" style={{ marginBottom: 10 }}>
            {assetsItems.map((item) => (
              <NavLink key={item.to} to={item.to} className="zp-mod">
                <span className="zp-mod__left">
                  <span className="zp-mod__ico" aria-hidden>{ICON_BY_PATH[item.to] || '•'}</span>
                  <span className="zp-mod__label">{item.label}</span>
                </span>
                <span className="zp-mod__chevron" aria-hidden>←</span>
              </NavLink>
            ))}
          </div>

          <div className="zp-section zp-section--secondary">Controle & journaux</div>
          {remunerationItems.length === 0 ? (
            <div className="zitu-page__empty" style={{ padding: '14px 10px' }}>
              <strong>Aucun module disponible</strong>
              Tous les acces sont centralises dans le flux principal.
            </div>
          ) : (
            <div className="zp-modules">
              {remunerationItems.map((item) => (
                <NavLink key={item.to} to={item.to} className="zp-mod">
                  <span className="zp-mod__left">
                    <span className="zp-mod__ico" aria-hidden>{ICON_BY_PATH[item.to] || '•'}</span>
                    <span className="zp-mod__label">{item.label}</span>
                  </span>
                  <span className="zp-mod__chevron" aria-hidden>←</span>
                </NavLink>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
