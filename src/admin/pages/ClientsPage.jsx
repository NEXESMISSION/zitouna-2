import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useClients, useSales } from '../../lib/useSupabase.js'
import { isClientSuspended } from '../../lib/adminAccess.js'

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
    <div className="zadm-page" dir="ltr">
      <div className="zadm-page__head">
        <div className="zadm-page__head-text">
          <h1 className="zadm-page__title">Clients</h1>
          <p className="zadm-page__subtitle">
            Consultez et recherchez tous les clients. Cliquez sur une ligne pour ouvrir la fiche.
          </p>
        </div>
        <div className="zadm-page__head-actions">
          <button
            type="button"
            className="zadm-btn zadm-btn--ghost zadm-btn--sm"
            onClick={() => navigate(-1)}
            title="Revenir à la page précédente"
          >
            ← Retour
          </button>
        </div>
      </div>

      <div className="zadm-page__body">
        <div className="zadm-kpi-grid" role="group" aria-label="Statistiques clients">
          <div className="zadm-kpi" title="Nombre total de clients enregistrés">
            <span className="zadm-kpi__label">Total clients</span>
            <span className="zadm-kpi__value">{totalClients}</span>
          </div>
          <div className="zadm-kpi" title="Clients inscrits via le formulaire public">
            <span className="zadm-kpi__label">Inscriptions auto.</span>
            <span className="zadm-kpi__value">{selfRegCount}</span>
          </div>
          <div className="zadm-kpi" title="Comptes actuellement suspendus">
            <span className="zadm-kpi__label">Suspendus</span>
            <span className="zadm-kpi__value">{suspendedCount}</span>
          </div>
        </div>

        <div className="zadm-card">
          <div className="zadm-card__head">
            <div className="zadm-card__head-text">
              <h2 className="zadm-card__title">Liste des clients</h2>
              <p className="zadm-card__subtitle">
                Recherche par nom, email, téléphone ou CIN.
              </p>
            </div>
            <div className="zadm-card__head-actions">
              <span className="zadm-pill zadm-pill--neutral" aria-label={`${filtered.length} résultats`}>
                {filtered.length} résultat{filtered.length > 1 ? 's' : ''}
              </span>
            </div>
          </div>
          <div className="zadm-toolbar">
            <div className="zadm-toolbar__left">
              <div className="zadm-filter" style={{ flex: 1 }}>
                <label htmlFor="cli-search" style={{ position: 'absolute', left: -9999, top: 'auto' }}>
                  Rechercher un client
                </label>
                <input
                  id="cli-search"
                  className="zadm-filter__control"
                  placeholder="Ex. Ben Ali, 27xxxxxx, AB123456…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Rechercher un client par nom, email, téléphone ou CIN"
                />
              </div>
            </div>
            {search ? (
              <div className="zadm-toolbar__right">
                <button
                  type="button"
                  className="zadm-btn zadm-btn--ghost zadm-btn--sm"
                  onClick={() => setSearch('')}
                  title="Effacer la recherche"
                >
                  Effacer
                </button>
              </div>
            ) : null}
          </div>

          {filtered.length === 0 ? (
            <div className="zadm-card__body">
              <div className="zadm-empty" role="status">
                <span className="zadm-empty__icon" aria-hidden>?</span>
                <p className="zadm-empty__title">
                  {search ? 'Aucun client ne correspond à votre recherche' : 'Aucun client pour le moment'}
                </p>
                <p className="zadm-empty__hint">
                  {search
                    ? "Vérifiez l'orthographe ou essayez un autre terme (nom, téléphone, CIN)."
                    : 'Les nouveaux clients apparaîtront ici automatiquement.'}
                </p>
                {search ? (
                  <div className="zadm-empty__actions">
                    <button
                      type="button"
                      className="zadm-btn zadm-btn--primary zadm-btn--sm"
                      onClick={() => setSearch('')}
                    >
                      Effacer la recherche
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="zadm-card__body zadm-card__body--flush">
              <div className="zadm-table-wrap">
                <table className="zadm-table">
                  <thead>
                    <tr>
                      <th className="zadm-th">Client</th>
                      <th className="zadm-th">Téléphone</th>
                      <th className="zadm-th">CIN</th>
                      <th className="zadm-th">Code</th>
                      <th className="zadm-th">Ventes</th>
                      <th className="zadm-th">Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => {
                      const suspended = isClientSuspended(c)
                      const nSales = saleCountByClient.get(String(c.id)) || 0
                      const selfReg = String(c.id || '').startsWith('c-reg-')
                      const clientName = c.name || 'Client sans nom'
                      return (
                        <tr
                          key={c.id}
                          className="zadm-tr"
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
                          style={{ cursor: 'pointer' }}
                        >
                          <td className="zadm-td">
                            <div style={{ fontWeight: 600 }}>{c.name || '—'}</div>
                            <div style={{ fontSize: 12, color: 'var(--zadm-text-muted)' }}>
                              {c.email || 'Email non renseigné'}
                            </div>
                          </td>
                          <td className="zadm-td">{c.phone || '—'}</td>
                          <td className="zadm-td zadm-mono">{c.cin || '—'}</td>
                          <td className="zadm-td zadm-mono">{c.code || c.id}</td>
                          <td className="zadm-td zadm-td--num">
                            <span className="zadm-pill zadm-pill--neutral" title="Nombre de ventes liées à ce client">
                              {nSales}
                            </span>
                          </td>
                          <td className="zadm-td">
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {suspended ? (
                                <span className="zadm-pill zadm-pill--danger" title="Ce compte ne peut pas se connecter">
                                  Suspendu
                                </span>
                              ) : (
                                <span className="zadm-pill zadm-pill--success">Actif</span>
                              )}
                              {selfReg ? (
                                <span className="zadm-pill zadm-pill--info" title="Client inscrit via le formulaire public">
                                  Auto.
                                </span>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
