import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useWorkspaceAudit } from '../../lib/useSupabase.js'
import AdminModal from '../components/AdminModal.jsx'
import { getPagerPages } from './pager-util.js'
import './sell-field.css'
import './audit-log.css'

const AUDIT_PER_PAGE = 20

// Entity filter presets — mirrors the legacy list but rendered as chips now.
const ENTITY_PRESETS = [
  { value: '', label: 'Tout' },
  { value: 'client', label: 'Client' },
  { value: 'sale', label: 'Vente' },
  { value: 'admin_user', label: 'Admin' },
  { value: 'payout_request', label: 'Paiement' },
  { value: 'access_grant', label: 'Accès' },
]

// Short French label used on the card badge.
const ENTITY_LABEL = {
  client: 'Client',
  sale: 'Vente',
  admin_user: 'Admin',
  payout_request: 'Paiement',
  access_grant: 'Accès',
}

// Severity → badge tone (sp-badge--{tone}).
const SEVERITY_TONE = {
  critical: 'red',
  error: 'red',
  warning: 'orange',
  warn: 'orange',
  info: 'blue',
  success: 'green',
  notice: 'blue',
}

function toneForEntry(entry) {
  const sev = String(entry?.severity || '').toLowerCase()
  if (SEVERITY_TONE[sev]) return SEVERITY_TONE[sev]
  const ent = String(entry?.entity || '').toLowerCase()
  if (ent === 'payout_request') return 'orange'
  if (ent === 'access_grant') return 'green'
  if (ent === 'sale') return 'blue'
  if (ent === 'admin_user') return 'purple'
  return 'gray'
}

function formatWhen(value) {
  if (!value) return ''
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(value)
  }
}

function formatWhenShort(value) {
  if (!value) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toLocaleString('fr-FR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(value)
  }
}

// Shorten a long id/uuid to 4…4 so it fits on one line.
function shortId(id) {
  const s = String(id || '')
  if (s.length <= 10) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

// Initials for the actor block — falls back to the entity letter.
function initialsFor(entry) {
  const raw = String(entry?.actorEmail || entry?.user || entry?.actorUserId || entry?.entity || '?').trim()
  if (!raw) return '?'
  // If it looks like an email, use first 2 letters before @.
  const atIdx = raw.indexOf('@')
  const head = atIdx > 0 ? raw.slice(0, atIdx) : raw
  const parts = head.split(/[\s._-]+/).filter(Boolean)
  const a = parts[0]?.[0] || head[0] || '?'
  const b = parts[1]?.[0] || head[1] || ''
  return `${a}${b}`.toUpperCase()
}

// Short actor label for the card sub-line.
function actorLabel(entry) {
  return entry?.actorEmail || entry?.user || (entry?.actorUserId ? shortId(entry.actorUserId) : 'Système')
}

export default function AuditLogPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { audit, loading, error, refresh } = useWorkspaceAudit()
  const [query, setQuery] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  const [subjectFilter, setSubjectFilter] = useState(() => searchParams.get('subject') || '')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(null)

  const list = useMemo(() => (Array.isArray(audit) ? audit : []), [audit])

  // Counts per entity type — used both for the top KPI and the chip badges.
  const entityCounts = useMemo(() => {
    const map = { '': list.length }
    for (const e of list) {
      const k = String(e?.entity || '')
      map[k] = (map[k] || 0) + 1
    }
    return map
  }, [list])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const subj = subjectFilter.trim().toLowerCase()
    let out = list
    if (entityFilter) out = out.filter((a) => String(a.entity || '') === entityFilter)
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
          String(a.actorEmail || '').toLowerCase().includes(q) ||
          String(a.subjectUserId || '').toLowerCase().includes(q),
      )
    }
    return out
  }, [list, query, entityFilter, subjectFilter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / AUDIT_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * AUDIT_PER_PAGE, safePage * AUDIT_PER_PAGE),
    [filtered, safePage],
  )

  const totalCount = list.length
  const todayCount = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return list.filter((a) => {
      try { return new Date(a.createdAt).getTime() >= today.getTime() } catch { return false }
    }).length
  }, [list])

  const hasActiveFilters = Boolean(query || entityFilter || subjectFilter)
  const showSkeletons = loading && list.length === 0
  const onQueryChange = (e) => { setQuery(e.target.value); setPage(1) }
  const onSubjectChange = (e) => { setSubjectFilter(e.target.value); setPage(1) }
  const onEntityChange = (v) => { setEntityFilter(v); setPage(1) }
  const resetFilters = () => { setQuery(''); setEntityFilter(''); setSubjectFilter(''); setPage(1) }

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero">
        <div className="sp-hero__avatar al-hero__icon" aria-hidden>
          <span>📜</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Journal d'audit</h1>
          <p className="sp-hero__role">Historique en lecture seule des actions</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : totalCount}
          </span>
          <span className="sp-hero__kpi-label">événement{totalCount > 1 ? 's' : ''}</span>
        </div>
      </header>

      {error && !loading && (
        <div className="sp-error-banner" role="alert">
          <div className="sp-error-banner__body">
            <strong>Impossible de charger le journal.</strong>
            <span>{String(error.message || error)}</span>
          </div>
          <button type="button" className="sp-error-banner__retry" onClick={() => refresh()}>
            Réessayer
          </button>
        </div>
      )}

      <div className="al-hint" role="note">
        <strong>À quoi sert cette page ?</strong> Chaque ligne est une action enregistrée automatiquement
        (création, modification, accès). Utilisez les filtres pour retrouver une action précise.
      </div>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{showSkeletons ? <span className="sk-num" /> : filtered.length}</strong> affiché{filtered.length > 1 ? 's' : ''}
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : totalCount}</strong> total
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : todayCount}</strong> aujourd'hui
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Action, détail, acteur, identifiant…"
            aria-label="Rechercher dans le journal"
            value={query}
            onChange={onQueryChange}
          />
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Filtrer par sujet ou identifiant d'entité"
            aria-label="Filtrer par sujet ou identifiant"
            value={subjectFilter}
            onChange={onSubjectChange}
          />
        </div>
        <div className="al-chips" role="tablist" aria-label="Filtrer par type d'entité">
          {ENTITY_PRESETS.map((o) => (
            <button
              key={o.value || 'all'}
              type="button"
              role="tab"
              aria-selected={entityFilter === o.value}
              className={`al-chip${entityFilter === o.value ? ' al-chip--active' : ''}`}
              onClick={() => onEntityChange(o.value)}
            >
              {o.label}
              <span className="al-chip__count">{entityCounts[o.value] || 0}</span>
            </button>
          ))}
        </div>
        <div className="al-toolbar">
          <div>
            <strong>{filtered.length}</strong> résultat{filtered.length > 1 ? 's' : ''}
            {totalCount ? <> sur {totalCount}</> : null}
          </div>
          <button
            type="button"
            className="al-reset"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
          >
            Réinitialiser les filtres
          </button>
        </div>
      </div>

      <div className="sp-cards">
        {showSkeletons ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={`sk-${i}`} className="sp-card sp-card--skeleton" aria-hidden>
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials sk-box" />
                  <div style={{ flex: 1 }}>
                    <p className="sk-line sk-line--title" />
                    <p className="sk-line sk-line--sub" />
                  </div>
                </div>
                <span className="sk-line sk-line--badge" />
              </div>
              <div className="sp-card__body">
                <span className="sk-line sk-line--price" />
                <span className="sk-line sk-line--info" />
              </div>
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="sp-empty">
            <span className="sp-empty__emoji" aria-hidden>{hasActiveFilters ? '🔍' : '📭'}</span>
            <div className="sp-empty__title">
              {hasActiveFilters ? 'Aucun événement ne correspond aux filtres.' : 'Aucun événement.'}
            </div>
            {!hasActiveFilters && (
              <p style={{ margin: '6px 0 0', fontSize: 12, color: '#94a3b8' }}>
                Les actions (ventes, accès, clients) apparaîtront ici dès qu'elles seront enregistrées.
              </p>
            )}
          </div>
        ) : (
          paged.map((entry) => {
            const tone = toneForEntry(entry)
            const entityLabel = ENTITY_LABEL[entry.entity] || entry.entity || 'autre'
            return (
              <button
                key={entry.id}
                type="button"
                className={`sp-card sp-card--${tone}`}
                onClick={() => setSelected(entry)}
                aria-label={`Ouvrir l'événement ${entry.action || ''}`}
              >
                <div className="sp-card__head">
                  <div className="sp-card__user">
                    <span className="sp-card__initials">{initialsFor(entry)}</span>
                    <div style={{ minWidth: 0 }}>
                      <p className="al-card__action">{entry.action || 'Action inconnue'}</p>
                      <p className="sp-card__sub">
                        {actorLabel(entry)} · {formatWhenShort(entry.createdAt)}
                      </p>
                    </div>
                  </div>
                  <span className={`sp-badge sp-badge--${tone}`}>{entityLabel}</span>
                </div>
                <div className="al-card__meta">
                  {entry.entityId ? (
                    <span title={String(entry.entityId)}>
                      <span className="al-card__meta-key">Réf</span>
                      <span className="al-card__meta-val">#{shortId(entry.entityId)}</span>
                    </span>
                  ) : null}
                  {entry.subjectUserId ? (
                    <span title={String(entry.subjectUserId)}>
                      <span className="al-card__meta-key">Sujet</span>
                      <span className="al-card__meta-val">{shortId(entry.subjectUserId)}</span>
                    </span>
                  ) : null}
                  {entry.category ? (
                    <span>
                      <span className="al-card__meta-key">Cat.</span>
                      <span className="al-card__meta-val">{entry.category}</span>
                    </span>
                  ) : null}
                </div>
              </button>
            )
          })
        )}
      </div>

      {!showSkeletons && filtered.length > AUDIT_PER_PAGE && (
        <div className="sp-pager" role="navigation" aria-label="Pagination">
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage <= 1}
            onClick={() => setPage(Math.max(1, safePage - 1))}
            aria-label="Page précédente"
          >
            ‹
          </button>
          {getPagerPages(safePage, pageCount).map((p, i) =>
            p === '…' ? (
              <span key={`dots-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
            ) : (
              <button
                key={p}
                type="button"
                className={`sp-pager__btn${p === safePage ? ' sp-pager__btn--active' : ''}`}
                onClick={() => setPage(p)}
                aria-current={p === safePage ? 'page' : undefined}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage >= pageCount}
            onClick={() => setPage(Math.min(pageCount, safePage + 1))}
            aria-label="Page suivante"
          >
            ›
          </button>
          <span className="sp-pager__info">
            {(safePage - 1) * AUDIT_PER_PAGE + 1}–{Math.min(safePage * AUDIT_PER_PAGE, filtered.length)} / {filtered.length}
          </span>
        </div>
      )}

      {selected && (
        <AdminModal open onClose={() => setSelected(null)} title="">
          <div className="sp-detail">
            <div className="sp-detail__banner">
              <div className="sp-detail__banner-top">
                <span className={`sp-badge sp-badge--${toneForEntry(selected)}`}>
                  {ENTITY_LABEL[selected.entity] || selected.entity || 'autre'}
                </span>
                <span className="sp-detail__date">{formatWhen(selected.createdAt)}</span>
              </div>
              <div className="sp-detail__price">
                <span className="sp-detail__price-num" style={{ fontSize: 18, wordBreak: 'break-word' }}>
                  {selected.action || 'Action inconnue'}
                </span>
              </div>
              <p className="sp-detail__banner-sub">
                {actorLabel(selected)}
                {selected.severity ? ` · Sévérité : ${selected.severity}` : ''}
              </p>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Contexte</div>
              <div className="sp-detail__row">
                <span>Entité</span>
                <strong>{ENTITY_LABEL[selected.entity] || selected.entity || '—'}</strong>
              </div>
              {selected.entityId && (
                <div className="sp-detail__row">
                  <span>Identifiant entité</span>
                  <strong style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' }}>
                    {String(selected.entityId)}
                  </strong>
                </div>
              )}
              {selected.category && (
                <div className="sp-detail__row"><span>Catégorie</span><strong>{selected.category}</strong></div>
              )}
              {selected.source && (
                <div className="sp-detail__row"><span>Source</span><strong>{selected.source}</strong></div>
              )}
              {selected.severity && (
                <div className="sp-detail__row"><span>Sévérité</span><strong>{selected.severity}</strong></div>
              )}
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Acteur</div>
              <div className="sp-detail__row">
                <span>Email</span>
                <strong style={{ wordBreak: 'break-all' }}>{selected.actorEmail || selected.user || '—'}</strong>
              </div>
              {selected.actorUserId && (
                <div className="sp-detail__row">
                  <span>ID acteur</span>
                  <strong style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' }}>
                    {String(selected.actorUserId)}
                  </strong>
                </div>
              )}
              {selected.subjectUserId && (
                <div className="sp-detail__row">
                  <span>ID sujet</span>
                  <strong style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' }}>
                    {String(selected.subjectUserId)}
                  </strong>
                </div>
              )}
            </div>

            {selected.details && (
              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Détails</div>
                <p className="al-detail__details">{selected.details}</p>
              </div>
            )}

            {selected.metadata && typeof selected.metadata === 'object' && Object.keys(selected.metadata).length > 0 && (
              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Métadonnées</div>
                <pre className="al-detail__json">{JSON.stringify(selected.metadata, null, 2)}</pre>
              </div>
            )}

            <div className="sp-detail__actions">
              <button
                type="button"
                className="sp-detail__btn sp-detail__btn--edit"
                onClick={() => setSelected(null)}
              >
                Fermer
              </button>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
