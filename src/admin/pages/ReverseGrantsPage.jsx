import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  fetchReverseGrantsAdmin,
  revokeReverseGrant,
  runBackfillReverseGrants,
  runBackfillReverseGrantCommissions,
} from '../../lib/db.js'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { SkeletonCard } from '../../components/skeletons/index.js'
import './zitouna-admin-page.css'
import './reverse-grants.css'

function asId(v) { return v == null ? '' : String(v) }

function clientName(c) {
  if (!c) return '—'
  return c.full_name || c.name || c.code || '—'
}

function fmtDate(d) {
  if (!d) return '—'
  try { return new Date(d).toLocaleDateString('fr-FR') } catch { return '—' }
}

function fmtMoney(n) {
  const v = Number(n) || 0
  return v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })
}

const STATUS_LABEL = {
  active: 'Actif',
  revoked: 'Révoqué',
  superseded: 'Dépassé',
}

export default function ReverseGrantsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const highlightGrantId = searchParams.get('grant') || null

  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [statusFilter, setStatusFilter] = useState('active')
  const [search, setSearch] = useState('')
  const [backfillBusy, setBackfillBusy] = useState(false)
  const [backfillReport, setBackfillReport] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const data = await fetchReverseGrantsAdmin()
      setPayload(data)
    } catch (e) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const clientsById = useMemo(() => {
    const m = new Map()
    for (const c of payload?.clients || []) m.set(asId(c.id), c)
    return m
  }, [payload?.clients])

  const salesById = useMemo(() => {
    const m = new Map()
    for (const s of payload?.sales || []) m.set(asId(s.id), s)
    return m
  }, [payload?.sales])

  const totalsByGrantId = useMemo(() => {
    const m = new Map()
    for (const ev of payload?.commissionEvents || []) {
      const gid = ev?.rule_snapshot?.meta?.grantId
      if (!gid) continue
      const cur = m.get(String(gid)) || { count: 0, total: 0 }
      cur.count += 1
      cur.total += Number(ev.amount) || 0
      m.set(String(gid), cur)
    }
    return m
  }, [payload?.commissionEvents])

  const filtered = useMemo(() => {
    const grants = payload?.grants || []
    const q = search.trim().toLowerCase()
    return grants.filter((g) => {
      if (statusFilter !== 'all' && g.status !== statusFilter) return false
      if (!q) return true
      const src = clientsById.get(asId(g.source_client_id))
      const ben = clientsById.get(asId(g.beneficiary_client_id))
      const sale = salesById.get(asId(g.trigger_sale_id))
      const hay = [
        clientName(src), clientName(ben),
        src?.phone_normalized, ben?.phone_normalized,
        sale?.code, g.id,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [payload?.grants, statusFilter, search, clientsById, salesById])

  const stats = useMemo(() => {
    const grants = payload?.grants || []
    const active = grants.filter((g) => g.status === 'active').length
    const revoked = grants.filter((g) => g.status === 'revoked').length
    const superseded = grants.filter((g) => g.status === 'superseded').length
    let commissionsTotal = 0
    let commissionsCount = 0
    for (const v of totalsByGrantId.values()) {
      commissionsTotal += v.total
      commissionsCount += v.count
    }
    return { active, revoked, superseded, commissionsTotal, commissionsCount }
  }, [payload?.grants, totalsByGrantId])

  async function handleRevoke(grantId) {
    const reason = window.prompt('Motif de révocation (optionnel) :') ?? ''
    if (!window.confirm('Révoquer ce droit ? Les commissions non payées seront annulées.')) return
    try {
      await revokeReverseGrant({ grantId, reason: reason || null })
      await refresh()
    } catch (e) {
      alert(`Échec de la révocation : ${String(e?.message || e)}`)
    }
  }

  async function handleBackfillGrants() {
    if (!window.confirm('Scanner toutes les ventes complétées et créer les droits manquants ?')) return
    setBackfillBusy(true)
    try {
      const report = await runBackfillReverseGrants()
      setBackfillReport({ kind: 'grants', report })
      await refresh()
    } catch (e) {
      alert(`Échec : ${String(e?.message || e)}`)
    } finally {
      setBackfillBusy(false)
    }
  }

  async function handleBackfillCommissions() {
    if (!window.confirm('Générer rétroactivement les commissions manquantes pour les droits actifs ?')) return
    setBackfillBusy(true)
    try {
      const report = await runBackfillReverseGrantCommissions()
      setBackfillReport({ kind: 'commissions', report })
      await refresh()
    } catch (e) {
      alert(`Échec : ${String(e?.message || e)}`)
    } finally {
      setBackfillBusy(false)
    }
  }

  return (
    <div className="zitu-page" dir="ltr">
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

        <section className="cli-hero rg-hero" aria-label="En-tête droits acquis">
          <span className="cli-hero__badge" aria-hidden>⇅</span>
          <div>
            <h1 className="cli-hero__title">Droits acquis via ventes inversées</h1>
            <p className="cli-hero__subtitle">
              Chaque ligne représente un droit perpétuel : le bénéficiaire touche
              une commission L1 sur les ventes des nouvelles recrues de la source,
              postérieures à la date d'effet.
            </p>
          </div>
        </section>

        <div className="rg-stats" role="group" aria-label="Synthèse des droits">
          <div className="rg-stat rg-stat--ok">
            <div className="rg-stat__label">Actifs</div>
            <div className="rg-stat__value">{stats.active}</div>
          </div>
          <div className="rg-stat">
            <div className="rg-stat__label">Révoqués</div>
            <div className="rg-stat__value">{stats.revoked}</div>
          </div>
          <div className="rg-stat">
            <div className="rg-stat__label">Dépassés</div>
            <div className="rg-stat__value">{stats.superseded}</div>
          </div>
          <div className="rg-stat rg-stat--accent">
            <div className="rg-stat__label">Commissions générées</div>
            <div className="rg-stat__value">
              {fmtMoney(stats.commissionsTotal)} <small>TND</small>
            </div>
            <div className="rg-stat__foot">{stats.commissionsCount} événement(s)</div>
          </div>
        </div>

        <div className="rg-toolbar">
          <input
            type="search"
            className="rg-search"
            placeholder="Rechercher (nom, téléphone, code vente)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="rg-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filtrer par statut"
          >
            <option value="active">Actifs</option>
            <option value="revoked">Révoqués</option>
            <option value="superseded">Dépassés</option>
            <option value="all">Tous</option>
          </select>
          <button
            type="button"
            className="adm-btn adm-btn--secondary"
            onClick={refresh}
            disabled={loading}
          >
            {loading ? 'Actualisation…' : 'Actualiser'}
          </button>
          <button
            type="button"
            className="adm-btn"
            onClick={handleBackfillGrants}
            disabled={backfillBusy}
            title="Scanner les ventes complétées et créer les droits manquants"
          >
            Backfill droits
          </button>
          <button
            type="button"
            className="adm-btn"
            onClick={handleBackfillCommissions}
            disabled={backfillBusy}
            title="Générer rétroactivement les commissions manquantes sous droits actifs"
          >
            Backfill commissions
          </button>
        </div>

        {backfillReport ? (
          <div className="rg-backfill-report">
            <strong>
              {backfillReport.kind === 'grants' ? 'Backfill droits :' : 'Backfill commissions :'}
            </strong>
            <pre>{JSON.stringify(backfillReport.report, null, 2)}</pre>
          </div>
        ) : null}

        <RenderDataGate
          loading={loading && !payload}
          error={err ? new Error(err) : null}
          data={payload}
          onRetry={refresh}
          skeleton={<SkeletonCard cards={5} />}
          isEmpty={() => filtered.length === 0}
          empty={
            <EmptyState
              icon="⇅"
              title="Aucun droit acquis"
              description={
                statusFilter === 'active'
                  ? "Aucune vente inversée n'a déclenché de droit. Utilisez « Backfill droits » pour scanner les ventes historiques."
                  : 'Aucun droit ne correspond au filtre.'
              }
            />
          }
        >
          {() => (
            <div className="rg-table-wrap">
              <table className="rg-table">
                <thead>
                  <tr>
                    <th>Statut</th>
                    <th>Bénéficiaire</th>
                    <th>Source</th>
                    <th>Vente déclenchante</th>
                    <th>Effectif depuis</th>
                    <th>Commissions versées</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((g) => {
                    const src = clientsById.get(asId(g.source_client_id))
                    const ben = clientsById.get(asId(g.beneficiary_client_id))
                    const sale = salesById.get(asId(g.trigger_sale_id))
                    const totals = totalsByGrantId.get(String(g.id)) || { count: 0, total: 0 }
                    const isHighlighted = highlightGrantId && String(g.id) === String(highlightGrantId)
                    return (
                      <tr
                        key={g.id}
                        className={`rg-row rg-row--${g.status} ${isHighlighted ? 'rg-row--highlighted' : ''}`}
                      >
                        <td>
                          <span className={`rg-badge rg-badge--${g.status}`}>
                            {STATUS_LABEL[g.status] || g.status}
                          </span>
                        </td>
                        <td>
                          <div className="rg-who">
                            <strong>{clientName(ben)}</strong>
                            <small>{ben?.phone_normalized || ben?.code}</small>
                          </div>
                        </td>
                        <td>
                          <div className="rg-who">
                            <strong>{clientName(src)}</strong>
                            <small>{src?.phone_normalized || src?.code}</small>
                          </div>
                        </td>
                        <td>
                          {sale?.code ? (
                            <code className="rg-sale-code">{sale.code}</code>
                          ) : (
                            <span className="rg-muted">—</span>
                          )}
                        </td>
                        <td>{fmtDate(g.effective_from)}</td>
                        <td>
                          {totals.count > 0 ? (
                            <div className="rg-totals">
                              <strong>{fmtMoney(totals.total)}</strong> <small>TND</small>
                              <div className="rg-totals__count">{totals.count} événement(s)</div>
                            </div>
                          ) : (
                            <span className="rg-muted">0</span>
                          )}
                        </td>
                        <td>
                          {g.status === 'active' ? (
                            <button
                              type="button"
                              className="adm-btn adm-btn--danger"
                              onClick={() => handleRevoke(g.id)}
                            >
                              Révoquer
                            </button>
                          ) : g.revoke_reason ? (
                            <span className="rg-muted" title={g.revoke_reason}>
                              {g.revoke_reason.slice(0, 30)}
                              {g.revoke_reason.length > 30 ? '…' : ''}
                            </span>
                          ) : (
                            <span className="rg-muted">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </RenderDataGate>
      </div>
    </div>
  )
}
