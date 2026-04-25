import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DashboardShell from '../components/DashboardShell.jsx'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import { fetchMyHarvestDistributions, fetchUpcomingHarvestsForClient } from '../lib/db.js'
import './dashboard-page.css'

/*
 * /my/harvests — customer's harvest income history.
 *
 *   Lists past harvest distributions (credited / paid out) plus the totals
 *   per year. Also surfaces upcoming planned/in-progress harvests for
 *   projects the client owns parcels in, so the page isn't a flat "rien ici"
 *   when the first distribution hasn't happened yet.
 *
 *   Harvest income is tracked separately from referral commissions so the
 *   user can see where each stream comes from, even though both credit the
 *   same withdrawable wallet.
 */

const STATUS_LABELS = {
  pending: 'En attente',
  credited: 'Crédité',
  paid_out: 'Retiré',
}

const HARVEST_STATUS_LABELS = {
  planned: 'Prévue',
  in_progress: 'En cours',
  harvested: 'Récoltée',
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso)
  }
}

function HarvestsBody({ distributions, upcoming }) {
  const navigate = useNavigate()
  const byYear = distributions.reduce((acc, d) => {
    const y = d.harvestYear || new Date(d.creditedAt || Date.now()).getFullYear()
    acc[y] = (acc[y] || 0) + d.amountTnd
    return acc
  }, {})
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a)
  const totalAll = distributions.reduce((s, d) => s + d.amountTnd, 0)

  return (
    <>
      {/* Header totals */}
      <section className="zb-mh-hero">
        <div>
          <div className="zb-k">Total</div>
          <div className="zb-mh-hero-v">
            {Math.round(totalAll).toLocaleString('fr-FR')}
            <span className="zb-s">TND</span>
          </div>
          <div className="zb-mh-hero-s">
            {distributions.length === 0
              ? 'Rien distribué'
              : `sur ${distributions.length} récolte${distributions.length > 1 ? 's' : ''}`}
          </div>
        </div>
        <button type="button" className="zb-btn zb-btn-dark" onClick={() => navigate('/my/payout')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12h12M12 5l7 7-7 7" /></svg>
          Retirer
        </button>
      </section>

      {/* Per-year totals rail */}
      {years.length > 1 && (
        <div className="zb-mh-years">
          {years.map((y) => (
            <div key={y} className="zb-mh-year">
              <div className="zb-k">{y}</div>
              <div className="zb-v">
                {Math.round(byYear[y]).toLocaleString('fr-FR')}<span className="zb-s">TND</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upcoming — planned / in_progress / harvested-but-not-distributed */}
      {upcoming.length > 0 && (
        <section>
          <div className="zb-section-head">
            <h2>À venir</h2>
          </div>
          <div className="zb-mh-list">
            {upcoming.map((h) => (
              <div
                key={h.id}
                className="zb-mh-row"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/project/${h.projectId}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/project/${h.projectId}`) }}
              >
                <div className="zb-mh-row-ic">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
                  </svg>
                </div>
                <div className="zb-mh-row-body">
                  <div className="zb-mh-row-t">Récolte {h.year || '—'}</div>
                  <div className="zb-mh-row-s">
                    Projet {h.projectId || '—'}
                    {h.projectedGrossTnd > 0
                      ? ` · ≈ ${Math.round(h.projectedGrossTnd).toLocaleString('fr-FR')} DT prévus`
                      : ''}
                  </div>
                </div>
                <div className="zb-mh-row-side">
                  <div className="zb-mh-row-status zb-mh-row-status--pending">
                    {HARVEST_STATUS_LABELS[h.status] || h.status}
                  </div>
                  <div className="zb-mh-row-date">{fmtDate(h.date) || h.year}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Distributions list */}
      {distributions.length > 0 && (
        <section>
          <div className="zb-section-head">
            <h2>Distribuées</h2>
          </div>
          <div className="zb-mh-list">
            {distributions.map((d) => (
              <div key={d.id} className="zb-mh-row">
                <div className="zb-mh-row-ic">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" />
                    <path d="M7.8 7.8l3.4 8.4M16.2 7.8l-3.4 8.4" />
                  </svg>
                </div>
                <div className="zb-mh-row-body">
                  <div className="zb-mh-row-t">Récolte {d.harvestYear || '—'}</div>
                  <div className="zb-mh-row-s">
                    Projet {d.projectId || '—'} · {d.ownedAreaM2.toLocaleString('fr-FR')} m² ({d.sharePct.toFixed(2)}%)
                  </div>
                </div>
                <div className="zb-mh-row-side">
                  <div className="zb-mh-row-a">
                    +{Math.round(d.amountTnd).toLocaleString('fr-FR')}<span className="zb-s">TND</span>
                  </div>
                  <div className={`zb-mh-row-status zb-mh-row-status--${d.creditStatus}`}>
                    {STATUS_LABELS[d.creditStatus] || d.creditStatus}
                  </div>
                  <div className="zb-mh-row-date">{fmtDate(d.creditedAt)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

export default function MyHarvestsPage() {
  const navigate = useNavigate()
  const { clientProfile, ready } = useAuth()
  const [payload, setPayload] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!ready) return undefined
    const clientId = clientProfile?.id
    if (!clientId) {
      setPayload({ distributions: [], upcoming: [] })
      return undefined
    }
    let cancelled = false
    ;(async () => {
      try {
        const [distributions, upcoming] = await Promise.all([
          fetchMyHarvestDistributions({ clientId }),
          fetchUpcomingHarvestsForClient(clientId),
        ])
        if (!cancelled) {
          setPayload({
            distributions: distributions || [],
            upcoming: (upcoming || []).filter((h) => h.status !== 'distributed'),
          })
        }
      } catch (e) {
        if (!cancelled) {
          console.error('[MyHarvests] fetch failed', e)
          setError(e?.message || 'Impossible de charger vos récoltes.')
          setPayload({ distributions: [], upcoming: [] })
        }
      }
    })()
    return () => { cancelled = true }
  }, [ready, clientProfile?.id])

  const gateLoading = payload === null
  const isEmptyGate = (p) => !p || ((p.distributions?.length || 0) === 0 && (p.upcoming?.length || 0) === 0)

  return (
    <DashboardShell active="harvests">
      <div className="zb-greeting">
        <h1 className="zb-greeting-h1">Mes récoltes 🌳</h1>
        <p className="zb-greeting-sub">Revenu annuel des oliviers.</p>
      </div>

      <RenderDataGate
        loading={gateLoading}
        error={error || null}
        data={payload}
        isEmpty={isEmptyGate}
        empty={
          <EmptyState
            title="Aucune récolte pour le moment"
            description="Récoltes visibles dès vos premières parcelles."
            action={{ label: 'Explorer les projets', onClick: () => navigate('/browse') }}
          />
        }
        label="Chargement de vos récoltes…"
      >
        {(data) => <HarvestsBody distributions={data.distributions} upcoming={data.upcoming} />}
      </RenderDataGate>
    </DashboardShell>
  )
}
