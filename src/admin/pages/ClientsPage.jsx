import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useClients, useSales } from '../../lib/useSupabase.js'
import { isClientSuspended } from '../../lib/adminAccess.js'
import './zitouna-admin-page.css'

export default function ClientsPage() {
  const navigate = useNavigate()
  const { clients } = useClients()
  const { sales } = useSales()
  const [search, setSearch] = useState('')

  // Count sales per client for the "Ventes" badge
  const saleCountByClient = useMemo(() => {
    const m = new Map()
    for (const s of sales || []) {
      const id = String(s.clientId || '')
      if (!id) continue
      m.set(id, (m.get(id) || 0) + 1)
    }
    return m
  }, [sales])

  // Filter clients by name, email, phone, or CIN
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return (clients || []).filter((c) => {
      if (!q) return true
      const name = (c.name || '').toLowerCase()
      const email = (c.email || '').toLowerCase()
      const phone = (c.phone || '').toLowerCase()
      const cin = (c.cin || '').toLowerCase()
      return name.includes(q) || email.includes(q) || phone.includes(q) || cin.includes(q)
    })
  }, [clients, search])

  // Quick KPIs for the overview strip
  const totalClients = (clients || []).length
  const suspendedCount = useMemo(
    () => (clients || []).filter((c) => isClientSuspended(c)).length,
    [clients]
  )
  const selfRegCount = useMemo(
    () => (clients || []).filter((c) => String(c.id || '').startsWith('c-reg-')).length,
    [clients]
  )

  return (
    <div className="zitu-page" dir="ltr">
      {/* Local page styles — scoped overrides only, no changes to shared CSS */}
      <style>{`
        .cli-hero {
          background: linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%);
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          padding: 18px 20px;
          margin-top: 8px;
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .cli-hero__badge {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          background: #1d4ed8;
          color: #fff;
          font-size: 20px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .cli-hero__title { font-size: 20px; font-weight: 700; color: #0f172a; line-height: 1.2; margin: 0; }
        .cli-hero__subtitle { font-size: 13px; color: #475569; margin: 4px 0 0; }

        .cli-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
          margin: 12px 0 6px;
        }
        .cli-stat {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 12px 14px;
        }
        .cli-stat__label { font-size: 12px; color: #64748b; font-weight: 500; }
        .cli-stat__value { font-size: 22px; font-weight: 700; color: #0f172a; margin-top: 4px; line-height: 1; }
        .cli-stat--warn .cli-stat__value { color: #b91c1c; }
        .cli-stat--info .cli-stat__value { color: #1d4ed8; }

        .cli-section-hint {
          font-size: 13px;
          color: #64748b;
          margin: 14px 0 8px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .cli-section-hint strong { color: #0f172a; font-weight: 600; }

        .cli-count-pill {
          display: inline-block;
          background: #f1f5f9;
          color: #475569;
          border: 1px solid #e2e8f0;
          border-radius: 999px;
          padding: 2px 10px;
          font-size: 12px;
          font-weight: 600;
          margin-left: 4px;
        }

        .cli-card-wrap { position: relative; }
        .cli-card-wrap .zitu-page__card { transition: box-shadow .15s ease, transform .15s ease, border-color .15s ease; }
        .cli-card-wrap:hover .zitu-page__card {
          box-shadow: 0 6px 18px rgba(15, 23, 42, 0.08);
          border-color: #cbd5e1;
        }
        .cli-open-hint {
          position: absolute;
          top: 12px;
          right: 12px;
          font-size: 11px;
          color: #94a3b8;
          font-weight: 500;
          pointer-events: none;
          opacity: 0;
          transition: opacity .15s ease;
        }
        .cli-card-wrap:hover .cli-open-hint { opacity: 1; }

        .cli-empty {
          text-align: center;
          padding: 28px 18px;
        }
        .cli-empty__icon {
          width: 48px; height: 48px;
          margin: 0 auto 10px;
          border-radius: 50%;
          background: #f1f5f9;
          color: #64748b;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 22px;
        }
        .cli-empty__title { font-size: 15px; font-weight: 600; color: #0f172a; margin: 0 0 4px; }
        .cli-empty__text { font-size: 13px; color: #64748b; margin: 0 0 12px; }
        .cli-empty__btn {
          background: #1d4ed8;
          color: #fff;
          border: 0;
          border-radius: 8px;
          padding: 8px 14px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .cli-empty__btn:hover { background: #1e40af; }

        @media (max-width: 600px) {
          .cli-stats { grid-template-columns: 1fr; }
          .cli-hero { flex-direction: row; padding: 14px 16px; }
          .cli-hero__title { font-size: 18px; }
        }
      `}</style>

      <div className="zitu-page__column">
        <button
          type="button"
          className="ds-back-btn"
          onClick={() => navigate(-1)}
          title="Revenir à la page précédente"
        >
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        {/* Hero — clear page purpose */}
        <section className="cli-hero" aria-label="En-tête de la page clients">
          <span className="cli-hero__badge" aria-hidden>C</span>
          <div>
            <h1 className="cli-hero__title">Clients</h1>
            <p className="cli-hero__subtitle">
              Consultez et recherchez tous les clients. Cliquez sur une carte pour ouvrir la fiche.
            </p>
          </div>
        </section>

        {/* KPI strip — at-a-glance numbers */}
        <div className="cli-stats" role="group" aria-label="Statistiques clients">
          <div className="cli-stat" title="Nombre total de clients enregistrés">
            <div className="cli-stat__label">Total clients</div>
            <div className="cli-stat__value">{totalClients}</div>
          </div>
          <div className="cli-stat cli-stat--info" title="Clients inscrits via le formulaire public">
            <div className="cli-stat__label">Inscriptions auto.</div>
            <div className="cli-stat__value">{selfRegCount}</div>
          </div>
          <div className="cli-stat cli-stat--warn" title="Comptes actuellement suspendus">
            <div className="cli-stat__label">Suspendus</div>
            <div className="cli-stat__value">{suspendedCount}</div>
          </div>
        </div>

        {/* Search — labelled + helper text */}
        <div className="cli-section-hint">
          <strong>Rechercher un client</strong>
          <span>· par nom, email, téléphone ou CIN</span>
        </div>
        <div className="zitu-page__filters">
          <div className="zitu-page__search-wrap zitu-page__filters-grow">
            <label htmlFor="cli-search" style={{ position: 'absolute', left: -9999, top: 'auto' }}>
              Rechercher un client
            </label>
            <input
              id="cli-search"
              className="zitu-page__search"
              placeholder="Ex. Ben Ali, 27xxxxxx, AB123456..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Rechercher un client par nom, email, téléphone ou CIN"
            />
            <span className="zitu-page__search-icon" aria-hidden>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </span>
          </div>
        </div>

        {/* Results section title + count */}
        <div className="cli-section-hint" style={{ marginTop: 18 }}>
          <strong>Liste des clients</strong>
          <span className="cli-count-pill" aria-label={`${filtered.length} résultats`}>
            {filtered.length}
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className="zitu-page__empty cli-empty" role="status">
            <div className="cli-empty__icon" aria-hidden>?</div>
            <p className="cli-empty__title">
              {search ? 'Aucun client ne correspond à votre recherche' : 'Aucun client pour le moment'}
            </p>
            <p className="cli-empty__text">
              {search
                ? 'Vérifiez l\'orthographe ou essayez un autre terme (nom, téléphone, CIN).'
                : 'Les nouveaux clients apparaîtront ici automatiquement.'}
            </p>
            {search ? (
              <button
                type="button"
                className="cli-empty__btn"
                onClick={() => setSearch('')}
              >
                Effacer la recherche
              </button>
            ) : null}
          </div>
        ) : (
          <div className="zitu-page__card-list">
            {filtered.map((c) => {
              const suspended = isClientSuspended(c)
              const nSales = saleCountByClient.get(String(c.id)) || 0
              const selfReg = String(c.id || '').startsWith('c-reg-')
              const clientName = c.name || 'Client sans nom'
              return (
                <div className="cli-card-wrap" key={c.id}>
                  <div
                    className="zitu-page__card"
                    role="button"
                    tabIndex={0}
                    aria-label={`Ouvrir la fiche de ${clientName}`}
                    title={`Ouvrir la fiche de ${clientName}`}
                    onClick={() => navigate(`/admin/clients/${c.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigate(`/admin/clients/${c.id}`)
                      }
                    }}
                    style={{ borderRadius: 12, cursor: 'pointer' }}
                  >
                    <div className="zitu-page__card-top">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        <span
                          aria-hidden
                          style={{
                            width: 38,
                            height: 38,
                            borderRadius: 10,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: suspended ? '#fef2f2' : '#dbeafe',
                            border: `1px solid ${suspended ? '#fecaca' : '#bfdbfe'}`,
                            color: suspended ? '#b91c1c' : '#1d4ed8',
                            fontWeight: 800,
                            fontSize: 14,
                            flexShrink: 0,
                          }}
                        >
                          {(c.name || '?')[0].toUpperCase()}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div
                            className="zitu-page__card-name"
                            style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}
                          >
                            {c.name || '—'}
                          </div>
                          <div className="zitu-page__card-meta" style={{ fontSize: 13 }}>
                            {c.email || 'Email non renseigné'}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                        {suspended ? (
                          <span
                            className="zitu-page__badge"
                            title="Ce compte ne peut pas se connecter"
                            style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}
                          >
                            Suspendu
                          </span>
                        ) : null}
                        {selfReg ? (
                          <span
                            className="zitu-page__badge"
                            title="Client inscrit via le formulaire public"
                            style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}
                          >
                            Inscription auto.
                          </span>
                        ) : null}
                        <span
                          className="zitu-page__badge"
                          title="Nombre de ventes liées à ce client"
                          style={{ background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' }}
                        >
                          {nSales} vente{nSales > 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>
                    <div className="zitu-page__inset">
                      <div className="zitu-page__detail-row">
                        <span className="zitu-page__detail-label">Téléphone</span>
                        <span className="zitu-page__detail-value">{c.phone || '—'}</span>
                      </div>
                      <div className="zitu-page__detail-row">
                        <span className="zitu-page__detail-label">CIN</span>
                        <span
                          className="zitu-page__detail-value"
                          style={{ fontFamily: 'ui-monospace, monospace' }}
                        >
                          {c.cin || '—'}
                        </span>
                      </div>
                      <div className="zitu-page__detail-row">
                        <span className="zitu-page__detail-label">Code client</span>
                        <span className="zitu-page__detail-value">{c.code || c.id}</span>
                      </div>
                      <div className="zitu-page__detail-row">
                        <span className="zitu-page__detail-label" title="Pages d'administration auxquelles ce client a accès">
                          Accès admin
                        </span>
                        <span className="zitu-page__detail-value">
                          {Array.isArray(c.allowedPages) && c.allowedPages.length > 0
                            ? `${c.allowedPages.length} page(s)`
                            : 'Aucun'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <span className="cli-open-hint" aria-hidden>Ouvrir →</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
