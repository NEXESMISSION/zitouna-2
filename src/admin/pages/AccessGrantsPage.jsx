import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccessGrants, useClients } from '../../lib/useSupabase.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useToast } from '../components/AdminToast.jsx'
import './zitouna-admin-page.css'

export default function AccessGrantsPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { addToast } = useToast()
  const { clients } = useClients()
  const { accessGrants, grantAuditLog, revoke } = useAccessGrants()
  const [tab, setTab] = useState('active')
  const [query, setQuery] = useState('')

  const clientLabel = (id) => (clients || []).find((c) => String(c.id) === String(id))?.name || id

  const activeRows = useMemo(
    () =>
      (accessGrants || [])
        .filter((g) => !g.revokedAt)
        .sort((a, b) => String(b.grantedAt || '').localeCompare(String(a.grantedAt || ''))),
    [accessGrants],
  )

  // Simple client-side filter on current tab's data
  const matches = (g) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [
      g.pageKey,
      clientLabel(g.clientId),
      g.sourceSaleId,
      g.sourceChecklistKey,
    ]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q))
  }

  const filteredActive = activeRows.filter(matches)
  const auditRows = (grantAuditLog || []).filter(matches)

  const handleRevoke = async (g) => {
    if (!window.confirm(`Révoquer l’accès ${g.pageKey} pour le client ${clientLabel(g.clientId)} ?`)) return
    const r = await revoke(g.id, adminUser?.id || null)
    if (!r?.ok) {
      addToast('Révocation impossible', 'error')
      return
    }
    addToast('Accès révoqué — le client perd cette page au prochain chargement de session.')
  }

  // Format ISO-ish date to human French (fallback to raw)
  const fmtDate = (iso) => {
    if (!iso) return '—'
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return iso
      return d.toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return iso
    }
  }

  return (
    <div className="zitu-page" dir="ltr">
      <style>{`
        .ag-wrap { --ag-ink:#0f172a; --ag-muted:#64748b; --ag-line:#e2e8f0; --ag-bg:#f8fafc; --ag-primary:#0f766e; --ag-primary-soft:#ccfbf1; --ag-danger:#b91c1c; --ag-danger-soft:#fee2e2; }
        .ag-intro { background:linear-gradient(135deg,#ecfeff 0%,#f0fdf4 100%); border:1px solid #a7f3d0; border-radius:14px; padding:16px 18px; margin:8px 0 18px; display:flex; gap:14px; align-items:flex-start; }
        .ag-intro__icon { flex:0 0 40px; width:40px; height:40px; border-radius:12px; background:#0f766e; color:#fff; font-weight:800; font-size:20px; display:flex; align-items:center; justify-content:center; }
        .ag-intro__title { font-size:15px; font-weight:700; color:var(--ag-ink); margin:0 0 4px; }
        .ag-intro__text { font-size:13px; color:#334155; line-height:1.55; margin:0; }
        .ag-toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
        .ag-tabs { display:inline-flex; background:#f1f5f9; border-radius:10px; padding:4px; gap:2px; }
        .ag-tab { appearance:none; border:0; background:transparent; padding:9px 14px; font-size:13px; font-weight:600; color:#475569; border-radius:8px; cursor:pointer; display:flex; align-items:center; gap:8px; min-height:40px; }
        .ag-tab[aria-selected="true"] { background:#ffffff; color:var(--ag-primary); box-shadow:0 1px 3px rgba(15,23,42,.08); }
        .ag-tab__count { background:#e2e8f0; color:#334155; border-radius:999px; padding:1px 8px; font-size:12px; font-weight:700; }
        .ag-tab[aria-selected="true"] .ag-tab__count { background:var(--ag-primary-soft); color:var(--ag-primary); }
        .ag-search { flex:1; min-width:200px; position:relative; }
        .ag-search input { width:100%; padding:10px 12px 10px 34px; border-radius:10px; border:1px solid var(--ag-line); font-size:13px; background:#fff; min-height:40px; color:var(--ag-ink); }
        .ag-search input:focus { outline:2px solid #14b8a6; outline-offset:1px; border-color:#14b8a6; }
        .ag-search__icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color:#94a3b8; font-size:14px; pointer-events:none; }
        .ag-section-hint { font-size:13px; color:var(--ag-muted); margin:0 0 10px; line-height:1.5; }
        .ag-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; }
        .ag-card { background:#fff; border:1px solid var(--ag-line); border-radius:14px; padding:14px 16px; display:flex; flex-direction:column; gap:10px; transition:border-color .15s,box-shadow .15s; }
        .ag-card:hover { border-color:#cbd5e1; box-shadow:0 2px 8px rgba(15,23,42,.04); }
        .ag-card__head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
        .ag-card__page { font-size:15px; font-weight:700; color:var(--ag-ink); margin:0; line-height:1.3; word-break:break-word; }
        .ag-card__client { font-size:13px; color:#334155; margin-top:3px; display:flex; align-items:center; gap:6px; }
        .ag-card__client strong { color:var(--ag-ink); font-weight:600; }
        .ag-badge { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; }
        .ag-badge--active { background:var(--ag-primary-soft); color:var(--ag-primary); }
        .ag-badge--revoked { background:var(--ag-danger-soft); color:var(--ag-danger); }
        .ag-badge__dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
        .ag-meta { display:grid; grid-template-columns:1fr 1fr; gap:8px 14px; padding-top:10px; border-top:1px dashed var(--ag-line); }
        .ag-meta__item { display:flex; flex-direction:column; gap:2px; min-width:0; }
        .ag-meta__label { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--ag-muted); font-weight:600; }
        .ag-meta__value { font-size:13px; color:var(--ag-ink); word-break:break-word; }
        .ag-card__actions { display:flex; justify-content:flex-end; padding-top:4px; }
        .ag-btn-revoke { appearance:none; border:1px solid var(--ag-danger-soft); background:#fff; color:var(--ag-danger); font-size:13px; font-weight:600; padding:8px 14px; border-radius:10px; cursor:pointer; min-height:38px; transition:background .15s,border-color .15s; }
        .ag-btn-revoke:hover { background:var(--ag-danger-soft); border-color:var(--ag-danger); }
        .ag-empty { background:#fff; border:1px dashed var(--ag-line); border-radius:14px; padding:32px 20px; text-align:center; }
        .ag-empty__icon { width:48px; height:48px; border-radius:14px; background:#f1f5f9; color:#64748b; font-size:22px; display:flex; align-items:center; justify-content:center; margin:0 auto 12px; }
        .ag-empty__title { display:block; font-size:15px; font-weight:700; color:var(--ag-ink); margin-bottom:4px; }
        .ag-empty__hint { font-size:13px; color:var(--ag-muted); margin:0; line-height:1.55; max-width:380px; margin-inline:auto; }
        @media (max-width:600px) {
          .ag-intro { flex-direction:column; gap:10px; padding:14px; }
          .ag-toolbar { flex-direction:column; align-items:stretch; }
          .ag-tabs { width:100%; }
          .ag-tab { flex:1; justify-content:center; }
          .ag-search { width:100%; }
          .ag-grid { grid-template-columns:1fr; }
          .ag-meta { grid-template-columns:1fr; }
        }
      `}</style>

      <div className="zitu-page__column ag-wrap">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        <header className="zitu-page__header">
          <div className="zitu-page__header-icon">A</div>
          <div className="zitu-page__header-text">
            <h1 style={{ fontSize: 22, lineHeight: 1.25 }}>Droits d’accès des clients</h1>
            <p style={{ fontSize: 13 }}>
              Gérer quelles pages privées chaque client peut voir après une vente ou une élévation administrateur.
            </p>
          </div>
        </header>

        {/* Inline explainer: what is a grant? */}
        <div className="ag-intro" role="note">
          <div className="ag-intro__icon" aria-hidden>i</div>
          <div>
            <p className="ag-intro__title">Qu’est-ce qu’un « accès » ?</p>
            <p className="ag-intro__text">
              Un accès ouvre à un client une page spécifique de son espace privé (ex. suivi de vente, échéancier).
              Il est créé automatiquement quand le notaire valide les étapes de la vente, ou manuellement par un administrateur.
              Vous pouvez le <strong>révoquer</strong> à tout moment — le client perd la page au prochain chargement.
            </p>
          </div>
        </div>

        {/* Toolbar: tabs + search */}
        <div className="ag-toolbar">
          <div className="ag-tabs" role="tablist" aria-label="Filtres">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'active'}
              className="ag-tab"
              onClick={() => setTab('active')}
            >
              Accès actifs
              <span className="ag-tab__count">{activeRows.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className="ag-tab"
              onClick={() => setTab('history')}
            >
              Historique
              <span className="ag-tab__count">{(grantAuditLog || []).length}</span>
            </button>
          </div>
          <label className="ag-search">
            <span className="ag-search__icon" aria-hidden>⌕</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher par client, page ou vente…"
              aria-label="Rechercher un accès"
            />
          </label>
        </div>

        {tab === 'active' ? (
          <>
            <p className="ag-section-hint">
              Liste des accès <strong>en vigueur</strong>. Révoquez ceux qui ne sont plus nécessaires.
            </p>
            {activeRows.length === 0 ? (
              <div className="ag-empty">
                <div className="ag-empty__icon" aria-hidden>∅</div>
                <strong className="ag-empty__title">Aucun accès actif pour le moment</strong>
                <p className="ag-empty__hint">
                  Les accès apparaîtront ici dès qu’une vente sera validée côté notaire, ou qu’un administrateur en aura accordé un.
                </p>
              </div>
            ) : filteredActive.length === 0 ? (
              <div className="ag-empty">
                <div className="ag-empty__icon" aria-hidden>⌕</div>
                <strong className="ag-empty__title">Aucun résultat</strong>
                <p className="ag-empty__hint">
                  Aucun accès ne correspond à « {query} ». Essayez un autre nom ou effacez la recherche.
                </p>
              </div>
            ) : (
              <div className="ag-grid">
                {filteredActive.map((g) => (
                  <article key={g.id} className="ag-card">
                    <div className="ag-card__head">
                      <div style={{ minWidth: 0 }}>
                        <h3 className="ag-card__page">{g.pageKey}</h3>
                        <div className="ag-card__client">
                          Client&nbsp;: <strong>{clientLabel(g.clientId)}</strong>
                        </div>
                      </div>
                      <span className="ag-badge ag-badge--active">
                        <span className="ag-badge__dot" aria-hidden />
                        Actif
                      </span>
                    </div>
                    <div className="ag-meta">
                      <div className="ag-meta__item">
                        <span className="ag-meta__label">Accordé le</span>
                        <span className="ag-meta__value">{fmtDate(g.grantedAt)}</span>
                      </div>
                      <div className="ag-meta__item">
                        <span className="ag-meta__label">Vente</span>
                        <span className="ag-meta__value">{g.sourceSaleId || '—'}</span>
                      </div>
                      <div className="ag-meta__item" style={{ gridColumn: '1 / -1' }}>
                        <span className="ag-meta__label">Règle déclenchée</span>
                        <span className="ag-meta__value">{g.sourceChecklistKey || '—'}</span>
                      </div>
                    </div>
                    <div className="ag-card__actions">
                      <button
                        type="button"
                        className="ag-btn-revoke"
                        onClick={() => handleRevoke(g)}
                        aria-label={`Révoquer l’accès ${g.pageKey} pour ${clientLabel(g.clientId)}`}
                      >
                        Révoquer l’accès
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="ag-section-hint">
              Journal complet — chaque <strong>octroi</strong> et chaque <strong>révocation</strong>, du plus récent au plus ancien.
            </p>
            {(grantAuditLog || []).length === 0 ? (
              <div className="ag-empty">
                <div className="ag-empty__icon" aria-hidden>∅</div>
                <strong className="ag-empty__title">Aucun enregistrement</strong>
                <p className="ag-empty__hint">
                  Les octrois et révocations s’afficheront ici dès qu’une action sera effectuée.
                </p>
              </div>
            ) : auditRows.length === 0 ? (
              <div className="ag-empty">
                <div className="ag-empty__icon" aria-hidden>⌕</div>
                <strong className="ag-empty__title">Aucun résultat</strong>
                <p className="ag-empty__hint">
                  Aucune entrée ne correspond à « {query} ».
                </p>
              </div>
            ) : (
              <div className="ag-grid">
                {auditRows.map((g) => {
                  const revoked = Boolean(g.revokedAt)
                  return (
                    <article key={g.id} className="ag-card">
                      <div className="ag-card__head">
                        <div style={{ minWidth: 0 }}>
                          <h3 className="ag-card__page">{g.pageKey}</h3>
                          <div className="ag-card__client">
                            Client&nbsp;: <strong>{clientLabel(g.clientId)}</strong>
                          </div>
                        </div>
                        <span className={`ag-badge ${revoked ? 'ag-badge--revoked' : 'ag-badge--active'}`}>
                          <span className="ag-badge__dot" aria-hidden />
                          {revoked ? 'Révoqué' : 'Actif'}
                        </span>
                      </div>
                      <div className="ag-meta">
                        <div className="ag-meta__item">
                          <span className="ag-meta__label">Accordé le</span>
                          <span className="ag-meta__value">{fmtDate(g.grantedAt)}</span>
                        </div>
                        <div className="ag-meta__item">
                          <span className="ag-meta__label">Révoqué le</span>
                          <span className="ag-meta__value">{revoked ? fmtDate(g.revokedAt) : '—'}</span>
                        </div>
                        <div className="ag-meta__item">
                          <span className="ag-meta__label">Vente</span>
                          <span className="ag-meta__value">{g.sourceSaleId || '—'}</span>
                        </div>
                        <div className="ag-meta__item">
                          <span className="ag-meta__label">Règle</span>
                          <span className="ag-meta__value">{g.sourceChecklistKey || '—'}</span>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
