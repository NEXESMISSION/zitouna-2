import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useWorkspaceAudit } from '../../lib/useSupabase.js'
import './zitouna-admin-page.css'

const ENTITY_PRESETS = [
  { value: '', label: 'Toutes entités' },
  { value: 'client', label: 'client' },
  { value: 'sale', label: 'sale' },
  { value: 'admin_user', label: 'admin_user' },
  { value: 'payout_request', label: 'payout_request' },
  { value: 'access_grant', label: 'access_grant' },
]

export default function AuditLogPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { audit } = useWorkspaceAudit()
  const [query, setQuery] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  // Seed the filter from ?subject= on first render so deep-links land
  // pre-filtered without triggering a cascading re-render from useEffect.
  const [subjectFilter, setSubjectFilter] = useState(() => searchParams.get('subject') || '')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const subj = subjectFilter.trim().toLowerCase()
    const list = audit || []
    let out = list
    if (entityFilter) {
      out = out.filter((a) => String(a.entity || '') === entityFilter)
    }
    if (subj) {
      out = out.filter(
        (a) =>
          String(a.subjectUserId || '').toLowerCase().includes(subj) ||
          String(a.entityId || '').toLowerCase().includes(subj),
      )
    }
    if (q) {
      out = out.filter(
        (a) =>
          String(a.action || '').toLowerCase().includes(q) ||
          String(a.entity || '').toLowerCase().includes(q) ||
          String(a.details || '').toLowerCase().includes(q) ||
          String(a.entityId || '').toLowerCase().includes(q) ||
          String(a.actorUserId || '').toLowerCase().includes(q) ||
          String(a.subjectUserId || '').toLowerCase().includes(q),
      )
    }
    return out.slice(0, 300)
  }, [audit, query, entityFilter, subjectFilter])

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Back</span>
        </button>
        <header className="zitu-page__header">
          <div className="zitu-page__header-icon">L</div>
          <div className="zitu-page__header-text">
            <h1>Journal d audit immuable</h1>
            <p>Cycle de vie des comptes, ventes, permissions et commissions — journal Supabase en temps reel.</p>
          </div>
        </header>
        <div className="zitu-page__filters" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="zitu-page__search-wrap zitu-page__filters-grow">
            <input
              className="zitu-page__search"
              placeholder="Recherche libre (action, détail, acteur…)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            className="zitu-page__input"
            style={{ maxWidth: 200, fontSize: 12 }}
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
          >
            {ENTITY_PRESETS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            className="zitu-page__input"
            style={{ maxWidth: 160, fontSize: 12 }}
            placeholder="Sujet / entity id"
            value={subjectFilter}
            onChange={(e) => setSubjectFilter(e.target.value)}
          />
        </div>
        {filtered.length === 0 ? (
          <div className="zitu-page__empty">
            <strong>Aucun événement</strong>
            Les actions (ventes, accès, clients) apparaîtront ici.
          </div>
        ) : (
          <div className="zitu-page__card-list">
            {filtered.map((a) => (
              <div key={a.id} className="zitu-page__card zitu-page__card--static">
                <div className="zitu-page__card-name">{a.action}</div>
                <div className="zitu-page__card-meta">
                  {a.entity} {a.entityId ? `#${a.entityId}` : ''} · {a.createdAt || ''}
                </div>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                  {a.actorUserId ? <>Acteur: {a.actorUserId} · </> : null}
                  {a.subjectUserId ? <>Sujet: {a.subjectUserId}</> : null}
                </div>
                {a.details ? <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>{a.details}</div> : null}
                {a.metadata && Object.keys(a.metadata).length > 0 ? (
                  <pre
                    style={{
                      fontSize: 9,
                      margin: '6px 0 0',
                      padding: 6,
                      background: '#f8fafc',
                      borderRadius: 6,
                      overflow: 'auto',
                      maxHeight: 72,
                    }}
                  >
                    {JSON.stringify(a.metadata, null, 0)}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
