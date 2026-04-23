import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useClients, useCommissionLedger, useProjects } from '../../lib/useSupabase.js'
import {
  adminDistributeHarvest,
  adminFetchAllHarvests,
  adminPreviewHarvestDistribution,
} from '../../lib/db.js'
import { runSafeAction } from '../../lib/runSafeAction.js'
import { useToast } from '../components/AdminToast.jsx'
import AdminModal from '../components/AdminModal.jsx'
import './distributions-page.css'

/*
 * /admin/distributions — unified admin page for distributing money to clients.
 *
 *   • Commissions tab — review/approve/reject pending payout requests.
 *     Single-click review since this is the "decide fast" queue; deep
 *     editing (overrides, anomalies) still lives in /admin/commissions/*.
 *   • Récoltes tab — list project harvests (across every project) and
 *     distribute them. Preview → distribute matches the per-project
 *     workflow in ProjectHarvestsTab but aggregated.
 *
 *   The split exists because the user wanted a single "retrait + récoltes"
 *   destination separate from the commission graph.
 */

const TABS = [
  { key: 'commissions', label: 'Commissions · retraits', icon: '💸' },
  { key: 'harvests',    label: 'Récoltes',              icon: '🫒' },
]

const PAYOUT_STATUS_META = {
  pending_review: { label: 'En revue', tone: 'amber' },
  approved:       { label: 'Approuvé', tone: 'purple' },
  paid:           { label: 'Payé',     tone: 'green' },
  rejected:       { label: 'Rejeté',   tone: 'red' },
}

const HARVEST_STATUS_META = {
  planned:      { label: 'Prévue',     tone: 'gray' },
  in_progress:  { label: 'En cours',   tone: 'blue' },
  harvested:    { label: 'Récoltée',   tone: 'amber' },
  distributed:  { label: 'Distribuée', tone: 'green' },
  cancelled:    { label: 'Annulée',    tone: 'red' },
}

function fmtTND(n) {
  const v = Number(n) || 0
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} TND`
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '—' }
}

export default function DistributionsPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { addToast } = useToast()
  const [tab, setTab] = useState('commissions')

  return (
    <div className="dist-page" dir="ltr">
      <header className="dist-header">
        <div>
          <h1 className="dist-title">Distributions</h1>
          <p className="dist-sub">
            Traitez les retraits de commissions et distribuez les revenus des récoltes aux propriétaires de parcelles.
          </p>
        </div>
      </header>

      <div className="dist-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`dist-tab${tab === t.key ? ' dist-tab--on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span className="dist-tab__ico" aria-hidden>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'commissions' ? (
        <CommissionsPanel adminUser={adminUser} addToast={addToast} navigate={navigate} />
      ) : (
        <HarvestsPanel addToast={addToast} navigate={navigate} />
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   Commissions panel — pending payout queue with approve/reject actions.
   ══════════════════════════════════════════════════════════════════════ */
function CommissionsPanel({ adminUser, addToast, navigate }) {
  const { clients } = useClients()
  const {
    payoutRequests,
    reviewPayoutRequest,
    loading,
  } = useCommissionLedger()

  const [busyKey, setBusyKey] = useState(null)
  const [statusFilter, setStatusFilter] = useState('pending_review')
  const [payRefByReq, setPayRefByReq] = useState({})
  const [rejectReasonByReq, setRejectReasonByReq] = useState({})

  const clientName = useCallback((id) => (
    (clients || []).find((c) => String(c.id) === String(id))?.name || id
  ), [clients])

  const filteredRequests = useMemo(() => {
    const list = [...(payoutRequests || [])]
    list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    if (statusFilter === 'all') return list
    return list.filter((r) => r.status === statusFilter)
  }, [payoutRequests, statusFilter])

  const summary = useMemo(() => {
    const list = payoutRequests || []
    const pending = list.filter((r) => r.status === 'pending_review')
    const approved = list.filter((r) => r.status === 'approved')
    const paid = list.filter((r) => r.status === 'paid')
    const sum = (xs) => xs.reduce((s, r) => s + Number(r.grossAmount || 0), 0)
    return {
      pendingCount: pending.length,
      pendingAmt: sum(pending),
      approvedCount: approved.length,
      approvedAmt: sum(approved),
      paidAmt: sum(paid),
    }
  }, [payoutRequests])

  const handleReview = useCallback(async (requestId, decision) => {
    if (!adminUser?.id) {
      addToast('Session admin requise.', 'error')
      return
    }
    const key = `review:${requestId}:${decision}`
    if (busyKey) return
    const opts = { actorUserId: adminUser.id }
    if (decision === 'paid') opts.paymentRef = (payRefByReq[requestId] || '').trim() || null
    if (decision === 'rejected') opts.reason = (rejectReasonByReq[requestId] || '').trim() || null
    await runSafeAction(
      {
        setBusy: (v) => setBusyKey(v ? key : null),
        onError: (msg) => addToast(msg, 'error'),
        label: decision === 'approved' ? 'Approuver la demande'
          : decision === 'paid' ? 'Marquer payé'
          : decision === 'rejected' ? 'Rejeter la demande'
          : 'Mettre à jour la demande',
      },
      async () => {
        const r = await reviewPayoutRequest(requestId, decision, opts)
        if (!r?.ok) throw new Error(r?.reason || 'Erreur serveur')
        addToast(
          decision === 'approved' ? 'Demande approuvée.'
          : decision === 'paid' ? 'Retrait marqué payé.'
          : 'Demande rejetée.',
          'success',
        )
      },
    )
  }, [adminUser?.id, busyKey, payRefByReq, rejectReasonByReq, reviewPayoutRequest, addToast])

  return (
    <section className="dist-panel">
      {/* KPIs */}
      <div className="dist-kpis">
        <div className="dist-kpi dist-kpi--amber">
          <span className="dist-kpi__label">Demandes à traiter</span>
          <span className="dist-kpi__value">{summary.pendingCount}</span>
          <span className="dist-kpi__sub">{fmtTND(summary.pendingAmt)}</span>
        </div>
        <div className="dist-kpi dist-kpi--purple">
          <span className="dist-kpi__label">Approuvées (à payer)</span>
          <span className="dist-kpi__value">{summary.approvedCount}</span>
          <span className="dist-kpi__sub">{fmtTND(summary.approvedAmt)}</span>
        </div>
        <div className="dist-kpi dist-kpi--green">
          <span className="dist-kpi__label">Payé (historique)</span>
          <span className="dist-kpi__value">{fmtTND(summary.paidAmt)}</span>
          <span className="dist-kpi__sub">cumul toutes périodes</span>
        </div>
      </div>

      <div className="dist-toolbar">
        <div className="dist-filter">
          {[
            { k: 'pending_review', lbl: 'À traiter' },
            { k: 'approved',       lbl: 'Approuvées' },
            { k: 'paid',           lbl: 'Payées' },
            { k: 'rejected',       lbl: 'Rejetées' },
            { k: 'all',            lbl: 'Tout' },
          ].map(({ k, lbl }) => (
            <button
              key={k}
              type="button"
              className={`dist-chip${statusFilter === k ? ' dist-chip--on' : ''}`}
              onClick={() => setStatusFilter(k)}
            >
              {lbl}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="dist-link"
          onClick={() => navigate('/admin/commissions/ledger')}
          title="Journal détaillé des commissions (overrides, anomalies)"
        >
          Journal détaillé →
        </button>
      </div>

      {loading && !(payoutRequests || []).length ? (
        <div className="dist-empty">Chargement…</div>
      ) : filteredRequests.length === 0 ? (
        <div className="dist-empty">
          <div className="dist-empty__ico" aria-hidden>🎉</div>
          <div className="dist-empty__t">Rien à traiter</div>
          <div className="dist-empty__s">
            {statusFilter === 'pending_review'
              ? 'Aucune demande de retrait en attente. Les nouvelles demandes apparaîtront ici.'
              : 'Aucune demande ne correspond à ce filtre.'}
          </div>
        </div>
      ) : (
        <div className="dist-list">
          {filteredRequests.map((req) => {
            const meta = PAYOUT_STATUS_META[req.status] || { label: req.status, tone: 'gray' }
            const isPending = req.status === 'pending_review'
            const isApproved = req.status === 'approved'
            return (
              <article key={req.id} className="dist-card">
                <header className="dist-card__head">
                  <div>
                    <div className="dist-card__title">{clientName(req.beneficiaryClientId)}</div>
                    <div className="dist-card__meta">
                      <span>Code {req.code || '—'}</span>
                      <span>·</span>
                      <span>Créée le {fmtDate(req.createdAt)}</span>
                      <span>·</span>
                      <span>{(req.eventIds || []).length} ligne{(req.eventIds || []).length > 1 ? 's' : ''}</span>
                    </div>
                  </div>
                  <div className="dist-card__amt">
                    <span className="dist-card__amt-v">{fmtTND(req.grossAmount)}</span>
                    <span className={`dist-badge dist-badge--${meta.tone}`}>{meta.label}</span>
                  </div>
                </header>

                {isPending && (
                  <div className="dist-card__form">
                    <label className="dist-card__label" htmlFor={`reason-${req.id}`}>Motif (en cas de rejet)</label>
                    <input
                      id={`reason-${req.id}`}
                      className="dist-input"
                      placeholder="Optionnel — précisez si rejeté"
                      value={rejectReasonByReq[req.id] || ''}
                      onChange={(e) => setRejectReasonByReq((p) => ({ ...p, [req.id]: e.target.value }))}
                    />
                    <div className="dist-card__actions">
                      <button
                        type="button"
                        className="dist-btn dist-btn--ghost"
                        onClick={() => handleReview(req.id, 'rejected')}
                        disabled={busyKey === `review:${req.id}:rejected`}
                      >
                        Rejeter
                      </button>
                      <button
                        type="button"
                        className="dist-btn dist-btn--primary"
                        onClick={() => handleReview(req.id, 'approved')}
                        disabled={busyKey === `review:${req.id}:approved`}
                      >
                        {busyKey === `review:${req.id}:approved` ? 'Approbation…' : 'Approuver'}
                      </button>
                    </div>
                  </div>
                )}

                {isApproved && (
                  <div className="dist-card__form">
                    <label className="dist-card__label" htmlFor={`payref-${req.id}`}>Référence paiement</label>
                    <input
                      id={`payref-${req.id}`}
                      className="dist-input"
                      placeholder="Ex : VIR-2026-00042"
                      value={payRefByReq[req.id] || ''}
                      onChange={(e) => setPayRefByReq((p) => ({ ...p, [req.id]: e.target.value }))}
                    />
                    <div className="dist-card__actions">
                      <button
                        type="button"
                        className="dist-btn dist-btn--primary"
                        onClick={() => handleReview(req.id, 'paid')}
                        disabled={busyKey === `review:${req.id}:paid`}
                      >
                        {busyKey === `review:${req.id}:paid` ? 'Enregistrement…' : 'Marquer payé'}
                      </button>
                    </div>
                  </div>
                )}

                {req.reviewReason && (
                  <div className="dist-card__note">
                    <strong>Motif&nbsp;:</strong> {req.reviewReason}
                  </div>
                )}
                {req.paymentRef && (
                  <div className="dist-card__note">
                    <strong>Réf.&nbsp;:</strong> <span dir="ltr">{req.paymentRef}</span>
                    {req.paidAt ? <> · payé le {fmtDate(req.paidAt)}</> : null}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   Harvests panel — every project harvest + distribute action.
   ══════════════════════════════════════════════════════════════════════ */
function HarvestsPanel({ addToast, navigate }) {
  const { projects } = useProjects()
  const [harvests, setHarvests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [busyKey, setBusyKey] = useState(null)
  const [previewing, setPreviewing] = useState(null) // { harvest, rows, loading, error }

  const loadHarvests = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await adminFetchAllHarvests()
      setHarvests(rows)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadHarvests() }, [loadHarvests])

  const projectById = useMemo(() => {
    const map = new Map()
    for (const p of projects || []) map.set(String(p.id), p)
    return map
  }, [projects])

  const filtered = useMemo(() => {
    const list = [...harvests]
    list.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0))
    if (statusFilter === 'all') return list
    return list.filter((h) => h.status === statusFilter)
  }, [harvests, statusFilter])

  const summary = useMemo(() => {
    const ready = harvests.filter((h) => h.status === 'harvested')
    const distributed = harvests.filter((h) => h.status === 'distributed')
    const sumNet = (xs) => xs.reduce((s, h) => {
      const gross = Number(h.actualGrossTnd) || 0
      const costs = Number(h.costsTnd) || 0
      return s + Math.max(0, gross - costs)
    }, 0)
    return {
      readyCount: ready.length,
      readyAmt: sumNet(ready),
      distributedCount: distributed.length,
      distributedAmt: sumNet(distributed),
    }
  }, [harvests])

  const openPreview = useCallback(async (harvest) => {
    setPreviewing({ harvest, rows: [], loading: true, error: null })
    try {
      const rows = await adminPreviewHarvestDistribution(harvest.id)
      setPreviewing({ harvest, rows, loading: false, error: null })
    } catch (e) {
      setPreviewing({ harvest, rows: [], loading: false, error: e?.message || String(e) })
    }
  }, [])

  const closePreview = useCallback(() => setPreviewing(null), [])

  const handleDistribute = useCallback(async (harvest) => {
    if (!harvest?.id) return
    const key = `distribute:${harvest.id}`
    if (busyKey) return
    await runSafeAction(
      {
        setBusy: (v) => setBusyKey(v ? key : null),
        onError: (msg) => addToast(msg, 'error'),
        label: 'Distribuer la récolte',
      },
      async () => {
        await adminDistributeHarvest(harvest.id)
        addToast('Récolte distribuée aux propriétaires.', 'success')
        await loadHarvests()
        setPreviewing(null)
      },
    )
  }, [busyKey, addToast, loadHarvests])

  return (
    <section className="dist-panel">
      <div className="dist-kpis">
        <div className="dist-kpi dist-kpi--amber">
          <span className="dist-kpi__label">Récoltes prêtes à distribuer</span>
          <span className="dist-kpi__value">{summary.readyCount}</span>
          <span className="dist-kpi__sub">{fmtTND(summary.readyAmt)} net</span>
        </div>
        <div className="dist-kpi dist-kpi--green">
          <span className="dist-kpi__label">Distribuées</span>
          <span className="dist-kpi__value">{summary.distributedCount}</span>
          <span className="dist-kpi__sub">{fmtTND(summary.distributedAmt)} versés</span>
        </div>
        <div className="dist-kpi dist-kpi--blue">
          <span className="dist-kpi__label">Projets suivis</span>
          <span className="dist-kpi__value">{projectById.size}</span>
          <span className="dist-kpi__sub">{harvests.length} récolte{harvests.length > 1 ? 's' : ''} enregistrée{harvests.length > 1 ? 's' : ''}</span>
        </div>
      </div>

      <div className="dist-toolbar">
        <div className="dist-filter">
          {[
            { k: 'all',          lbl: 'Toutes' },
            { k: 'harvested',    lbl: 'À distribuer' },
            { k: 'distributed',  lbl: 'Distribuées' },
            { k: 'in_progress',  lbl: 'En cours' },
            { k: 'planned',      lbl: 'Prévues' },
            { k: 'cancelled',    lbl: 'Annulées' },
          ].map(({ k, lbl }) => (
            <button
              key={k}
              type="button"
              className={`dist-chip${statusFilter === k ? ' dist-chip--on' : ''}`}
              onClick={() => setStatusFilter(k)}
            >
              {lbl}
            </button>
          ))}
        </div>
        <button type="button" className="dist-link" onClick={() => loadHarvests()}>
          Rafraîchir ↻
        </button>
      </div>

      {loading ? (
        <div className="dist-empty">Chargement…</div>
      ) : error ? (
        <div className="dist-empty dist-empty--error">
          <div className="dist-empty__t">Erreur de chargement</div>
          <div className="dist-empty__s">{error}</div>
          <button type="button" className="dist-btn dist-btn--ghost" onClick={loadHarvests}>Réessayer</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="dist-empty">
          <div className="dist-empty__ico" aria-hidden>🌱</div>
          <div className="dist-empty__t">Aucune récolte</div>
          <div className="dist-empty__s">
            Créez une récolte depuis un projet (<em>Projets & parcelles → Récoltes</em>) pour la suivre ici.
          </div>
        </div>
      ) : (
        <div className="dist-list">
          {filtered.map((h) => {
            const proj = projectById.get(String(h.projectId))
            const meta = HARVEST_STATUS_META[h.status] || { label: h.status, tone: 'gray' }
            const gross = Number(h.actualGrossTnd) || 0
            const costs = Number(h.costsTnd) || 0
            const net = Math.max(0, gross - costs)
            const canDistribute = h.status === 'harvested' && net > 0
            return (
              <article key={h.id} className="dist-card">
                <header className="dist-card__head">
                  <div>
                    <div className="dist-card__title">
                      {proj ? `${proj.title} — ${proj.city || ''}` : `Projet ${h.projectId}`}
                      <span className="dist-card__year"> · {h.year}</span>
                    </div>
                    <div className="dist-card__meta">
                      <span>Récolte {fmtDate(h.date)}</span>
                      {h.actualKg > 0 ? <><span>·</span><span>{Number(h.actualKg).toLocaleString('fr-FR')} kg</span></> : null}
                      {h.pricePerKgTnd > 0 ? <><span>·</span><span>{Number(h.pricePerKgTnd).toLocaleString('fr-FR')} TND/kg</span></> : null}
                    </div>
                  </div>
                  <div className="dist-card__amt">
                    <span className="dist-card__amt-v">{fmtTND(net)}</span>
                    <span className={`dist-badge dist-badge--${meta.tone}`}>{meta.label}</span>
                  </div>
                </header>
                {costs > 0 && (
                  <div className="dist-card__note">
                    Brut&nbsp;{fmtTND(gross)} − Coûts&nbsp;{fmtTND(costs)} = <strong>Net&nbsp;{fmtTND(net)}</strong>
                  </div>
                )}
                <div className="dist-card__actions">
                  <button
                    type="button"
                    className="dist-btn dist-btn--ghost"
                    onClick={() => proj && navigate(`/admin/projects/${proj.id}`)}
                    disabled={!proj}
                  >
                    Voir le projet
                  </button>
                  <button
                    type="button"
                    className="dist-btn dist-btn--ghost"
                    onClick={() => openPreview(h)}
                    disabled={!canDistribute}
                    title={canDistribute ? 'Prévisualiser la répartition' : 'Disponible uniquement quand la récolte est finalisée avec un revenu net > 0'}
                  >
                    Aperçu répartition
                  </button>
                  <button
                    type="button"
                    className="dist-btn dist-btn--primary"
                    onClick={() => openPreview(h)}
                    disabled={!canDistribute || busyKey === `distribute:${h.id}`}
                  >
                    {busyKey === `distribute:${h.id}` ? 'Distribution…' : 'Distribuer'}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {previewing && (
        <AdminModal open={true} onClose={closePreview} title={`Distribution récolte ${previewing.harvest.year}`}>
          <div className="dist-preview">
            {previewing.loading ? (
              <div className="dist-empty">Calcul de la répartition…</div>
            ) : previewing.error ? (
              <div className="dist-empty dist-empty--error">
                <div className="dist-empty__t">Impossible de prévisualiser</div>
                <div className="dist-empty__s">{previewing.error}</div>
              </div>
            ) : previewing.rows.length === 0 ? (
              <div className="dist-empty">
                <div className="dist-empty__t">Aucun propriétaire éligible</div>
                <div className="dist-empty__s">Aucune parcelle vendue n'est enregistrée pour ce projet à cette date.</div>
              </div>
            ) : (
              <>
                <p className="dist-preview__hint">
                  Confirmation en <strong>{fmtTND(
                    previewing.rows.reduce((s, r) => s + Number(r.amountTnd || 0), 0),
                  )}</strong> répartis sur <strong>{previewing.rows.length}</strong> client{previewing.rows.length > 1 ? 's' : ''}. La commande est idempotente côté base.
                </p>
                <div className="dist-preview__table">
                  <div className="dist-preview__row dist-preview__row--head">
                    <span>Client</span>
                    <span>Surface possédée</span>
                    <span>Part</span>
                    <span>Montant</span>
                  </div>
                  {previewing.rows.map((r) => (
                    <div key={r.clientId} className="dist-preview__row">
                      <span>{r.clientName || r.clientId}</span>
                      <span>{Number(r.ownedAreaM2 || 0).toLocaleString('fr-FR')} m²</span>
                      <span>{Number(r.sharePct || 0).toFixed(2)} %</span>
                      <span><strong>{fmtTND(r.amountTnd)}</strong></span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="dist-preview__actions">
              <button type="button" className="dist-btn dist-btn--ghost" onClick={closePreview}>
                Annuler
              </button>
              <button
                type="button"
                className="dist-btn dist-btn--primary"
                onClick={() => handleDistribute(previewing.harvest)}
                disabled={
                  Boolean(previewing.loading)
                  || Boolean(previewing.error)
                  || previewing.rows.length === 0
                  || busyKey === `distribute:${previewing.harvest.id}`
                }
              >
                {busyKey === `distribute:${previewing.harvest.id}` ? 'Distribution…' : 'Confirmer la distribution'}
              </button>
            </div>
          </div>
        </AdminModal>
      )}
    </section>
  )
}
