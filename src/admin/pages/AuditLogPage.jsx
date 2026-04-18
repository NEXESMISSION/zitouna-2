import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useWorkspaceAudit } from '../../lib/useSupabase.js'
import './zitouna-admin-page.css'

const ENTITY_PRESETS = [
  { value: '', label: 'Toutes entités' },
  { value: 'client', label: 'Client' },
  { value: 'sale', label: 'Vente' },
  { value: 'admin_user', label: 'Utilisateur admin' },
  { value: 'payout_request', label: 'Demande de paiement' },
  { value: 'access_grant', label: 'Accès accordé' },
]

// Short French labels for entity pills
const ENTITY_LABEL = {
  client: 'Client',
  sale: 'Vente',
  admin_user: 'Admin',
  payout_request: 'Paiement',
  access_grant: 'Accès',
}

// Format an ISO date into a short readable FR string; safe for non-dates
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

// Shorten long identifiers for display without losing the trailing digits
function shortId(id) {
  const s = String(id || '')
  if (s.length <= 10) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

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

  const totalCount = (audit || []).length
  const hasActiveFilters = Boolean(query || entityFilter || subjectFilter)

  return (
    <div className="zitu-page" dir="ltr">
      <style>{`
        /* Local styles for the audit log — scoped to this page only */
        .audit-hint {
          font-size: 13px;
          line-height: 1.5;
          color: #475569;
          background: #f0f9ff;
          border: 1px solid #bae6fd;
          border-left: 4px solid #0ea5e9;
          border-radius: 10px;
          padding: 10px 14px;
          margin: 0 0 14px;
        }
        .audit-hint strong { color: #0c4a6e; }
        .audit-filters {
          display: flex;
          flex-direction: column;
          gap: 10px;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 14px;
          margin-bottom: 16px;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        }
        .audit-filters__row {
          display: grid;
          grid-template-columns: 1fr 220px 220px;
          gap: 10px;
        }
        @media (max-width: 900px) {
          .audit-filters__row { grid-template-columns: 1fr; }
        }
        .audit-field { display: flex; flex-direction: column; gap: 4px; }
        .audit-field__label {
          font-size: 12px;
          font-weight: 600;
          color: #334155;
          letter-spacing: 0.02em;
        }
        .audit-field input,
        .audit-field select {
          width: 100%;
          font-size: 13px;
          padding: 9px 12px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          background: #fff;
          color: #0f172a;
          transition: border-color 120ms ease, box-shadow 120ms ease;
        }
        .audit-field input:focus,
        .audit-field select:focus {
          outline: none;
          border-color: #0ea5e9;
          box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.18);
        }
        .audit-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }
        .audit-count {
          font-size: 13px;
          color: #475569;
        }
        .audit-count strong { color: #0f172a; }
        .audit-reset {
          font-size: 12px;
          font-weight: 600;
          color: #0369a1;
          background: transparent;
          border: 1px solid #bae6fd;
          border-radius: 999px;
          padding: 6px 12px;
          cursor: pointer;
          transition: background 120ms ease;
        }
        .audit-reset:hover { background: #e0f2fe; }
        .audit-reset[disabled] {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .audit-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .audit-row {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          padding: 12px 14px;
          transition: border-color 120ms ease, box-shadow 120ms ease;
        }
        .audit-row:hover {
          border-color: #cbd5e1;
          box-shadow: 0 2px 6px rgba(15, 23, 42, 0.05);
        }
        .audit-row__head {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .audit-badge {
          display: inline-flex;
          align-items: center;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          padding: 3px 9px;
          border-radius: 999px;
          background: #eef2ff;
          color: #3730a3;
          border: 1px solid #c7d2fe;
          white-space: nowrap;
        }
        .audit-action {
          font-size: 14px;
          font-weight: 600;
          color: #0f172a;
          flex: 1 1 200px;
          min-width: 0;
          word-break: break-word;
        }
        .audit-when {
          font-size: 12px;
          color: #64748b;
          white-space: nowrap;
        }
        .audit-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px 14px;
          margin-top: 6px;
          font-size: 12px;
          color: #475569;
        }
        .audit-meta__item { display: inline-flex; gap: 4px; }
        .audit-meta__key { color: #94a3b8; font-weight: 500; }
        .audit-meta__val {
          color: #334155;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11.5px;
        }
        .audit-details {
          margin-top: 8px;
          font-size: 13px;
          color: #334155;
          line-height: 1.45;
        }
        .audit-json {
          margin: 8px 0 0;
          padding: 8px 10px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          font-size: 11px;
          color: #1e293b;
          overflow: auto;
          max-height: 120px;
        }
        .audit-empty {
          text-align: center;
          padding: 36px 20px;
          background: #ffffff;
          border: 1px dashed #cbd5e1;
          border-radius: 12px;
          color: #475569;
        }
        .audit-empty__title {
          font-size: 16px;
          font-weight: 600;
          color: #0f172a;
          margin-bottom: 4px;
        }
        .audit-empty__sub { font-size: 13px; }
        .audit-page-title { font-size: 20px; font-weight: 700; color: #0f172a; }
        .audit-page-sub { font-size: 13px; color: #475569; margin-top: 2px; }
        @media (max-width: 600px) {
          .audit-row { padding: 12px; }
          .audit-action { font-size: 13.5px; flex-basis: 100%; }
          .audit-when { font-size: 11.5px; }
          .audit-meta { font-size: 11.5px; gap: 4px 10px; }
        }
      `}</style>
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>
        <header className="zitu-page__header">
          <div className="zitu-page__header-icon">L</div>
          <div className="zitu-page__header-text">
            <h1 className="audit-page-title">Journal d’audit</h1>
            <p className="audit-page-sub">
              Historique en lecture seule de toutes les actions : comptes, ventes, accès et paiements.
            </p>
          </div>
        </header>

        <div className="audit-hint" role="note">
          <strong>À quoi sert cette page ?</strong> Un « événement » est une action enregistrée automatiquement
          (création, modification, accès). Utilisez les filtres ci-dessous pour retrouver une action précise.
        </div>

        <div className="audit-filters">
          <div className="audit-filters__row">
            <div className="audit-field">
              <label className="audit-field__label" htmlFor="audit-search">Recherche libre</label>
              <input
                id="audit-search"
                type="text"
                placeholder="Action, détail, acteur…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="audit-field">
              <label className="audit-field__label" htmlFor="audit-entity">Type d’entité</label>
              <select
                id="audit-entity"
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value)}
              >
                {ENTITY_PRESETS.map((o) => (
                  <option key={o.value || 'all'} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="audit-field">
              <label className="audit-field__label" htmlFor="audit-subject">Sujet / identifiant</label>
              <input
                id="audit-subject"
                type="text"
                placeholder="ID utilisateur ou entité"
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
              />
            </div>
          </div>
          <div className="audit-toolbar">
            <div className="audit-count">
              <strong>{filtered.length}</strong> événement{filtered.length > 1 ? 's' : ''} affiché
              {filtered.length > 1 ? 's' : ''}
              {totalCount ? <> sur {totalCount}</> : null}
              {filtered.length >= 300 ? <> (limité à 300)</> : null}
            </div>
            <button
              type="button"
              className="audit-reset"
              disabled={!hasActiveFilters}
              onClick={() => {
                setQuery('')
                setEntityFilter('')
                setSubjectFilter('')
              }}
            >
              Réinitialiser les filtres
            </button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="audit-empty">
            <div className="audit-empty__title">Aucun événement</div>
            <div className="audit-empty__sub">
              {hasActiveFilters
                ? 'Aucun événement — ajustez les filtres.'
                : 'Les actions (ventes, accès, clients) apparaîtront ici dès qu’elles seront enregistrées.'}
            </div>
          </div>
        ) : (
          <div className="audit-list">
            {filtered.map((a) => {
              const entityLabel = ENTITY_LABEL[a.entity] || a.entity || 'autre'
              const hasMeta = a.metadata && Object.keys(a.metadata).length > 0
              return (
                <div key={a.id} className="audit-row">
                  <div className="audit-row__head">
                    <span className="audit-badge" title={a.entity || ''}>{entityLabel}</span>
                    <span className="audit-action">{a.action || 'Action inconnue'}</span>
                    <span className="audit-when">{formatWhen(a.createdAt)}</span>
                  </div>
                  <div className="audit-meta">
                    {a.entityId ? (
                      <span className="audit-meta__item" title={String(a.entityId)}>
                        <span className="audit-meta__key">Réf :</span>
                        <span className="audit-meta__val">#{shortId(a.entityId)}</span>
                      </span>
                    ) : null}
                    {a.actorUserId ? (
                      <span className="audit-meta__item" title={String(a.actorUserId)}>
                        <span className="audit-meta__key">Acteur :</span>
                        <span className="audit-meta__val">{shortId(a.actorUserId)}</span>
                      </span>
                    ) : null}
                    {a.subjectUserId ? (
                      <span className="audit-meta__item" title={String(a.subjectUserId)}>
                        <span className="audit-meta__key">Sujet :</span>
                        <span className="audit-meta__val">{shortId(a.subjectUserId)}</span>
                      </span>
                    ) : null}
                  </div>
                  {a.details ? <div className="audit-details">{a.details}</div> : null}
                  {hasMeta ? (
                    <pre className="audit-json">{JSON.stringify(a.metadata, null, 2)}</pre>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
