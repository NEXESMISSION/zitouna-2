import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSales } from '../../lib/useSupabase.js'
import AdminModal from '../components/AdminModal.jsx'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import './zitouna-admin-page.css'

// Format ISO date to a readable French date + time
function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return String(iso)
  }
}

// True when a sale has been marked completed by either flag
function isCompletedSale(sale) {
  const st = String(sale.status || '').toLowerCase()
  const pipe = String(sale.pipelineStatus || '').toLowerCase()
  return st === 'completed' || pipe === 'completed'
}

// Aligned with plan: after notary, comptant sales whose destination is cash_sales.
function isPostNotaryCashSale(sale) {
  if (String(sale.paymentType || '').toLowerCase() !== 'full') return false
  const dest = sale.postNotaryDestination
  if (dest === 'cash_sales' && isCompletedSale(sale)) return true
  if ((dest === undefined || dest === null || dest === '') && isCompletedSale(sale)) return true
  return false
}

// Format TND amount with French grouping
function fmtTND(n) {
  return `${(Number(n) || 0).toLocaleString('fr-FR')} TND`
}

export default function CashSalesPage() {
  const navigate = useNavigate()
  const { sales } = useSales()
  const [search, setSearch] = useState('')
  const [detailSale, setDetailSale] = useState(null)

  const cashSales = useMemo(() => {
    const full = (sales || []).filter((sale) => String(sale.paymentType || '').toLowerCase() === 'full')
    return full.filter(isPostNotaryCashSale)
  }, [sales])

  const filteredSales = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return cashSales
    return cashSales.filter((sale) => {
      const parcels = Array.isArray(sale.plotIds)
        ? sale.plotIds.join(', ')
        : sale.plotId != null
          ? String(sale.plotId)
          : ''
      return (
        String(sale.clientName || '').toLowerCase().includes(q) ||
        String(sale.projectTitle || '').toLowerCase().includes(q) ||
        String(sale.status || '').toLowerCase().includes(q) ||
        parcels.toLowerCase().includes(q)
      )
    })
  }, [cashSales, search])

  const totalAmount = useMemo(
    () => filteredSales.reduce((sum, sale) => sum + (Number(sale.agreedPrice) || 0), 0),
    [filteredSales],
  )

  const todayIso = new Date().toISOString().slice(0, 10)
  const todayCount = useMemo(
    () => filteredSales.filter((sale) => String(sale.createdAt || '').slice(0, 10) === todayIso).length,
    [filteredSales, todayIso],
  )

  const hasSearch = search.trim().length > 0
  const noAnyCash = cashSales.length === 0

  return (
    <div className="zitu-page" dir="ltr">
      {/* Local styles: small UX tweaks without touching shared CSS */}
      <style>{`
        .cs-help { font-size: 13px; color: #4b5563; background: #f8fafc;
          border: 1px solid #e5e7eb; border-left: 3px solid #10b981;
          border-radius: 8px; padding: 10px 12px; margin: 8px 0 14px;
          line-height: 1.45; }
        .cs-help b { color: #111827; }
        .cs-section-title { font-size: 15px; font-weight: 700; color: #111827;
          margin: 6px 0 8px; display: flex; align-items: center; gap: 8px; }
        .cs-section-title .cs-count { font-size: 12px; font-weight: 600;
          color: #065f46; background: #d1fae5; padding: 2px 8px;
          border-radius: 999px; }
        .cs-search-hint { font-size: 12px; color: #6b7280; margin-top: 6px; }
        .cs-clear-btn { background: transparent; border: 1px solid #e5e7eb;
          color: #374151; border-radius: 8px; padding: 6px 10px;
          font-size: 13px; cursor: pointer; min-height: 40px; }
        .cs-clear-btn:hover { background: #f3f4f6; }
        .cs-amount-strong { font-weight: 700; color: #065f46; }
        .cs-card-cta { font-size: 12px; color: #059669; font-weight: 600;
          margin-top: 8px; }
        @media (max-width: 600px) {
          .cs-filters-row { flex-direction: column; align-items: stretch !important; gap: 8px; }
          .zitu-page__search { min-height: 40px; font-size: 14px; }
          .cs-clear-btn { width: 100%; }
        }
      `}</style>

      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        <header className="zitu-page__header">
          <div className="zitu-page__header-icon">💵</div>
          <div className="zitu-page__header-text">
            <h1 style={{ fontSize: 20 }}>Paiements comptant</h1>
            <p style={{ fontSize: 13 }}>
              Liste des ventes réglées en une seule fois, après clôture du notaire.
            </p>
          </div>
        </header>

        {/* Plain-language explainer for first-time users */}
        <div className="cs-help" role="note">
          <b>À quoi sert cette page ?</b> Elle affiche les ventes <b>100% comptant</b> une fois
          le notaire finalisé. Cliquez sur une carte pour voir le détail complet
          (client, parcelles, montants, traçabilité).
        </div>

        <div className="zitu-page__stats zitu-page__stats--3" style={{ marginBottom: 12 }}>
          <div className="zitu-page__stat" title="Nombre de ventes comptant visibles avec le filtre actuel">
            <div className="zitu-page__stat-label">Ventes affichées</div>
            <div className="zitu-page__stat-value">{filteredSales.length}</div>
          </div>
          <div className="zitu-page__stat" title="Ventes comptant enregistrées aujourd'hui">
            <div className="zitu-page__stat-label">Aujourd'hui</div>
            <div className="zitu-page__stat-value zitu-page__stat-value--mint">{todayCount}</div>
          </div>
          <div className="zitu-page__stat" title="Somme des montants convenus des ventes affichées">
            <div className="zitu-page__stat-label">Total encaissé</div>
            <div className="zitu-page__stat-value">{totalAmount.toLocaleString('fr-FR')} TND</div>
          </div>
        </div>

        <div
          className="zitu-page__filters cs-filters-row"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <div className="zitu-page__search-wrap zitu-page__filters-grow">
            <input
              className="zitu-page__search"
              placeholder="Rechercher un client, projet, parcelle ou statut…"
              aria-label="Rechercher une vente"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ minHeight: 40, fontSize: 14 }}
            />
            <span className="zitu-page__search-icon" aria-hidden>🔎</span>
          </div>
          {hasSearch && (
            <button
              type="button"
              className="cs-clear-btn"
              onClick={() => setSearch('')}
              title="Effacer la recherche"
            >
              Effacer
            </button>
          )}
        </div>
        <div className="cs-search-hint">
          Astuce : tapez un nom, un numéro de parcelle (#12) ou un titre de projet.
        </div>

        {filteredSales.length > 0 && (
          <div className="cs-section-title" style={{ marginTop: 14 }}>
            <span>Ventes comptant</span>
            <span className="cs-count">{filteredSales.length}</span>
          </div>
        )}

        {filteredSales.length === 0 ? (
          <div className="zitu-page__empty" role="status">
            {noAnyCash ? (
              <>
                <strong>Aucune vente comptant pour le moment</strong>
                <div style={{ marginTop: 6, fontSize: 13, color: '#4b5563' }}>
                  Les ventes comptant apparaîtront ici automatiquement une fois
                  la clôture notaire effectuée.
                </div>
              </>
            ) : (
              <>
                <strong>Aucun résultat pour « {search} »</strong>
                <div style={{ marginTop: 6, fontSize: 13, color: '#4b5563' }}>
                  Essayez un autre mot-clé ou
                  {' '}
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    style={{
                      background: 'none', border: 'none', color: '#059669',
                      textDecoration: 'underline', cursor: 'pointer', padding: 0,
                      font: 'inherit',
                    }}
                  >
                    réinitialisez le filtre
                  </button>.
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="zitu-page__card-list">
            {filteredSales.map((sale) => {
              const parcels = Array.isArray(sale.plotIds)
                ? sale.plotIds.map((id) => `#${id}`).join(', ')
                : sale.plotId != null
                  ? `#${sale.plotId}`
                  : '—'
              return (
                <div
                  key={sale.id}
                  className="zitu-page__card zitu-page__card--clickable"
                  onClick={() => setDetailSale(sale)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Ouvrir le détail de la vente de ${sale.clientName || 'client inconnu'}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setDetailSale(sale)
                  }}
                >
                  <div className="zitu-page__card-top">
                    <div>
                      <div className="zitu-page__card-name" style={{ fontSize: 15 }}>
                        {sale.clientName || '—'}
                      </div>
                      <div className="zitu-page__card-meta" style={{ fontSize: 13 }}>
                        {sale.code || sale.id} • {sale.projectTitle || '—'}
                      </div>
                    </div>
                    <span className="zitu-page__badge" title="Statut de la vente">
                      {sale.status || '—'}
                    </span>
                  </div>

                  <div className="zitu-page__detail-row">
                    <span className="zitu-page__detail-label">Parcelles</span>
                    <span className="zitu-page__detail-value">{parcels}</span>
                  </div>
                  <div className="zitu-page__detail-row">
                    <span className="zitu-page__detail-label">Montant</span>
                    <span className="zitu-page__detail-value cs-amount-strong">
                      {fmtTND(sale.agreedPrice)}
                    </span>
                  </div>
                  <div className="zitu-page__detail-row">
                    <span className="zitu-page__detail-label">Créée le</span>
                    <span className="zitu-page__detail-value">{formatDate(sale.createdAt)}</span>
                  </div>

                  <div className="cs-card-cta">Voir le détail →</div>
                </div>
              )
            })}
          </div>
        )}

        <AdminModal
          open={!!detailSale}
          onClose={() => setDetailSale(null)}
          title="Détail de la vente comptant"
          width={620}
        >
          {detailSale && (
            <div className="zitu-page__inset">
              <div className="zitu-page__panel">
                <div className="zitu-page__panel-title">Informations générales</div>
                <div className="zitu-page__section-desc" style={{ fontSize: 13 }}>
                  Identifiant et statut de la vente.
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Code</span>
                  <span className="zitu-page__detail-value">{detailSale.code || detailSale.id}</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Statut</span>
                  <span className="zitu-page__detail-value">{detailSale.status || '—'}</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Créée le</span>
                  <span className="zitu-page__detail-value">{formatDate(detailSale.createdAt)}</span>
                </div>
              </div>

              <div className="zitu-page__panel">
                <div className="zitu-page__panel-title">Client</div>
                <div className="zitu-page__section-desc" style={{ fontSize: 13 }}>
                  Coordonnées de l'acheteur.
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Nom</span>
                  <span className="zitu-page__detail-value">{detailSale.clientName || '—'}</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Téléphone</span>
                  <span className="zitu-page__detail-value">{detailSale.clientPhone || '—'}</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Email</span>
                  <span className="zitu-page__detail-value">{detailSale.clientEmail || '—'}</span>
                </div>
              </div>

              <div className="zitu-page__panel">
                <div className="zitu-page__panel-title">Vente</div>
                <div className="zitu-page__section-desc" style={{ fontSize: 13 }}>
                  Projet, parcelles et montants.
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Projet</span>
                  <span className="zitu-page__detail-value">{detailSale.projectTitle || '—'}</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Parcelles</span>
                  <span className="zitu-page__detail-value">
                    {Array.isArray(detailSale.plotIds)
                      ? detailSale.plotIds.map((id) => `#${id}`).join(', ')
                      : detailSale.plotId != null
                        ? `#${detailSale.plotId}`
                        : '—'}
                  </span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Mode de paiement</span>
                  <span className="zitu-page__detail-value">Comptant</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Montant convenu</span>
                  <span className="zitu-page__detail-value cs-amount-strong">
                    {fmtTND(detailSale.agreedPrice)}
                  </span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Acompte</span>
                  <span className="zitu-page__detail-value">{fmtTND(detailSale.deposit)}</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Reste à payer</span>
                  <span className="zitu-page__detail-value">
                    {fmtTND(Math.max(0, (Number(detailSale.agreedPrice) || 0) - (Number(detailSale.deposit) || 0)))}
                  </span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Pipeline</span>
                  <span className="zitu-page__detail-value">{detailSale.pipelineStatus || '—'}</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Après notaire</span>
                  <span className="zitu-page__detail-value">{detailSale.postNotaryDestination || '—'}</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Finance validée</span>
                  <span className="zitu-page__detail-value">{formatDate(detailSale.financeValidatedAt)}</span>
                </div>
                <div className="zitu-page__detail-row">
                  <span className="zitu-page__detail-label">Notaire complété</span>
                  <span className="zitu-page__detail-value">
                    {formatDate(detailSale.notaryCompletedAt || detailSale.completedAt)}
                  </span>
                </div>
              </div>

              <SaleSnapshotTracePanel sale={detailSale} />

              {detailSale.notes ? (
                <div className="zitu-page__panel">
                  <div className="zitu-page__panel-title">Notes</div>
                  <div className="zitu-page__section-desc">{detailSale.notes}</div>
                </div>
              ) : null}
            </div>
          )}
        </AdminModal>
      </div>
    </div>
  )
}
