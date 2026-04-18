import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSales } from '../../lib/useSupabase.js'
import AdminModal from '../components/AdminModal.jsx'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import { getPagerPages } from './pager-util.js'
import './sell-field.css'
import './cash-sales.css'

const CASH_PER_PAGE = 15

function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return String(iso)
  }
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

function isCompletedSale(sale) {
  const st = String(sale.status || '').toLowerCase()
  const pipe = String(sale.pipelineStatus || '').toLowerCase()
  return st === 'completed' || pipe === 'completed'
}

function isPostNotaryCashSale(sale) {
  if (String(sale.paymentType || '').toLowerCase() !== 'full') return false
  const dest = sale.postNotaryDestination
  if (dest === 'cash_sales' && isCompletedSale(sale)) return true
  if ((dest === undefined || dest === null || dest === '') && isCompletedSale(sale)) return true
  return false
}

function fmtTND(n) {
  return `${(Number(n) || 0).toLocaleString('fr-FR')} TND`
}

export default function CashSalesPage() {
  const navigate = useNavigate()
  const { sales, loading: salesLoading } = useSales()
  const [search, setSearch] = useState('')
  const [detailSale, setDetailSale] = useState(null)
  const [page, setPage] = useState(1)

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

  const noAnyCash = cashSales.length === 0
  const showSkeletons = salesLoading && cashSales.length === 0

  const pageCount = Math.max(1, Math.ceil(filteredSales.length / CASH_PER_PAGE))
  // Clamp to valid range (if list shrinks or search narrows it) without an effect.
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pagedSales = useMemo(
    () => filteredSales.slice((safePage - 1) * CASH_PER_PAGE, safePage * CASH_PER_PAGE),
    [filteredSales, safePage],
  )
  const onSearchChange = (e) => { setSearch(e.target.value); setPage(1) }

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero cs-hero">
        <div className="sp-hero__avatar cs-hero__icon" aria-hidden>
          <span>💵</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Paiements comptant</h1>
          <p className="sp-hero__role">Ventes réglées en une seule fois</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sp-sk-num sp-sk-num--wide" /> : filteredSales.length}
          </span>
          <span className="sp-hero__kpi-label">vente{filteredSales.length > 1 ? 's' : ''}</span>
        </div>
      </header>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats cs-cat-stats">
          <strong>{showSkeletons ? <span className="sp-sk-num" /> : filteredSales.length}</strong> affichées
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sp-sk-num" /> : todayCount}</strong> aujourd'hui
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sp-sk-num sp-sk-num--wide" /> : totalAmount.toLocaleString('fr-FR')}</strong> TND
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Rechercher client, projet, parcelle…"
            aria-label="Rechercher une vente"
            value={search}
            onChange={onSearchChange}
          />
        </div>
      </div>

      <div className="sp-cards">
        {showSkeletons ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={`sk-${i}`} className="sp-card sp-card--skeleton" aria-hidden>
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials sp-sk-box" />
                  <div style={{ flex: 1 }}>
                    <p className="sp-sk-line sp-sk-line--title" />
                    <p className="sp-sk-line sp-sk-line--sub" />
                  </div>
                </div>
                <span className="sp-sk-line sp-sk-line--badge" />
              </div>
              <div className="sp-card__body">
                <span className="sp-sk-line sp-sk-line--price" />
                <span className="sp-sk-line sp-sk-line--info" />
              </div>
            </div>
          ))
        ) : filteredSales.length === 0 ? (
          <div className="sp-empty">
            <span className="sp-empty__emoji" aria-hidden>{noAnyCash ? '📭' : '🔍'}</span>
            <div className="sp-empty__title">
              {noAnyCash ? 'Aucune vente comptant pour le moment.' : `Aucun résultat pour « ${search} ».`}
            </div>
            {noAnyCash && (
              <p className="cs-empty__text">
                Les ventes comptant apparaîtront ici automatiquement une fois la clôture notaire effectuée.
              </p>
            )}
          </div>
        ) : pagedSales.map((sale) => {
          const parcels = Array.isArray(sale.plotIds) && sale.plotIds.length
            ? sale.plotIds.map((id) => `#${id}`).join(', ')
            : sale.plotId != null ? `#${sale.plotId}` : '—'
          return (
            <button
              key={sale.id}
              type="button"
              className="sp-card sp-card--green"
              onClick={() => setDetailSale(sale)}
              aria-label={`Ouvrir la vente de ${sale.clientName || 'client inconnu'}`}
            >
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials cs-card__initials">{initials(sale.clientName)}</span>
                  <div style={{ minWidth: 0 }}>
                    <p className="sp-card__name">{sale.clientName || '—'}</p>
                    <p className="sp-card__sub">{sale.projectTitle || '—'} · {parcels}</p>
                  </div>
                </div>
                <span className="sp-badge sp-badge--green">Comptant</span>
              </div>
              <div className="sp-card__body">
                <div className="sp-card__price">
                  <span className="sp-card__amount">{(Number(sale.agreedPrice) || 0).toLocaleString('fr-FR')}</span>
                  <span className="sp-card__currency">TND</span>
                </div>
                <div className="sp-card__info">
                  <span>{formatDate(sale.createdAt)}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {!showSkeletons && filteredSales.length > CASH_PER_PAGE && (
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
            {(safePage - 1) * CASH_PER_PAGE + 1}–{Math.min(safePage * CASH_PER_PAGE, filteredSales.length)} / {filteredSales.length}
          </span>
        </div>
      )}

      {detailSale && (
        <AdminModal open onClose={() => setDetailSale(null)} title="">
          <div className="sp-detail cs-detail">
            <div className="sp-detail__banner cs-detail__banner">
              <div className="sp-detail__banner-top">
                <span className="sp-badge sp-badge--green">Comptant</span>
                <span className="sp-detail__date">{formatDate(detailSale.createdAt)}</span>
              </div>
              <div className="sp-detail__price">
                <span className="sp-detail__price-num">{(Number(detailSale.agreedPrice) || 0).toLocaleString('fr-FR')}</span>
                <span className="sp-detail__price-cur">TND</span>
              </div>
              <p className="sp-detail__banner-sub">
                {detailSale.clientName || 'Client'} · Réf. {detailSale.code || detailSale.id}
              </p>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Client</div>
              <div className="sp-detail__row"><span>Nom</span><strong>{detailSale.clientName || '—'}</strong></div>
              <div className="sp-detail__row"><span>Téléphone</span><strong style={{ direction: 'ltr' }}>{detailSale.clientPhone || '—'}</strong></div>
              {detailSale.clientEmail && (
                <div className="sp-detail__row"><span>Email</span><strong style={{ wordBreak: 'break-all' }}>{detailSale.clientEmail}</strong></div>
              )}
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Vente</div>
              <div className="sp-detail__row"><span>Projet</span><strong>{detailSale.projectTitle || '—'}</strong></div>
              <div className="sp-detail__row">
                <span>Parcelles</span>
                <strong>
                  {Array.isArray(detailSale.plotIds) && detailSale.plotIds.length
                    ? detailSale.plotIds.map((id) => `#${id}`).join(', ')
                    : detailSale.plotId != null ? `#${detailSale.plotId}` : '—'}
                </strong>
              </div>
              <div className="sp-detail__row"><span>Mode</span><strong>Comptant</strong></div>
              <div className="sp-detail__row"><span>Statut</span><strong>{detailSale.status || '—'}</strong></div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Montants</div>
              <div className="sp-detail__row"><span>Prix convenu</span><strong>{fmtTND(detailSale.agreedPrice)}</strong></div>
              <div className="sp-detail__row"><span>Acompte</span><strong>{fmtTND(detailSale.deposit)}</strong></div>
              <div className="sp-detail__row sp-detail__row--highlight">
                <span>Reste à payer</span>
                <strong>{fmtTND(Math.max(0, (Number(detailSale.agreedPrice) || 0) - (Number(detailSale.deposit) || 0)))}</strong>
              </div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Étapes internes</div>
              <div className="sp-detail__row"><span>Finance validée</span><strong>{formatDate(detailSale.financeValidatedAt)}</strong></div>
              <div className="sp-detail__row">
                <span>Notaire complété</span>
                <strong>{formatDate(detailSale.notaryCompletedAt || detailSale.completedAt)}</strong>
              </div>
            </div>

            <div className="sp-detail__section">
              <SaleSnapshotTracePanel sale={detailSale} />
            </div>

            {detailSale.notes && (
              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Notes</div>
                <p className="cs-detail__notes">{detailSale.notes}</p>
              </div>
            )}
          </div>
        </AdminModal>
      )}
    </div>
  )
}
