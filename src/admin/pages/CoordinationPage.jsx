import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useClients, useSales, useProjects, useWorkspaceAudit } from '../../lib/useSupabase.js'
import * as db from '../../lib/db.js'
import { getSaleStatusMeta, canonicalSaleStatus } from '../../domain/workflowModel.js'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import './coordination-page.css'
import './zitouna-admin-page.css'

const SLOT_OPTIONS = ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00']

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso)
  }
}

function fmtMoney(v) {
  return `${(Number(v) || 0).toLocaleString('fr-FR')} TND`
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

function normalizePlotIds(sale) {
  const ids = Array.isArray(sale?.plotIds)
    ? sale.plotIds
    : sale?.plotId != null
      ? [sale.plotId]
      : []
  return ids.map((x) => Number(x)).filter((n) => Number.isFinite(n))
}

/** Parcel PKs for `parcels.id` / `updateParcelStatus` (not parcel_number). */
function parcelDbIdsFromSale(sale) {
  const raw =
    Array.isArray(sale?.parcelIds) && sale.parcelIds.length > 0
      ? sale.parcelIds
      : sale?.parcelId != null && sale.parcelId !== ''
        ? [sale.parcelId]
        : []
  return [...new Set(raw.map((x) => Number(x)).filter((n) => Number.isFinite(n)))]
}

function typeLabel(type) {
  return type === 'finance' ? 'Finance' : 'Juridique'
}

function dateTimeKey(a) {
  return `${a.date || ''} ${a.time || ''}`
}

/** Parse stored timestamptz into calendar date + HH:MM (local). */
function coordAtToDateTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const date = toIsoDate(d)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return { date, time }
}

function toIsoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function monthGrid(anchorDate) {
  const first = startOfMonth(anchorDate)
  const startWeekday = (first.getDay() + 6) % 7
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = []
  let day = 1 - startWeekday
  for (let i = 0; i < 42; i += 1) {
    const cur = new Date(first.getFullYear(), first.getMonth(), day)
    cells.push({ date: cur, inMonth: day >= 1 && day <= daysInMonth })
    day += 1
  }
  return cells
}

export default function CoordinationPage() {
  const navigate = useNavigate()
  const { adminUser, user } = useAuth()
  const { sales, update: salesUpdate } = useSales()
  const { clients } = useClients()
  const { updateParcelStatus } = useProjects()
  const { append: appendAuditLog } = useWorkspaceAudit()

  const [query, setQuery] = useState('')
  const [view, setView] = useState('sales')
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()))
  const [scheduler, setScheduler] = useState({
    open: false,
    sale: null,
    type: 'finance',
    date: todayIso(),
    time: SLOT_OPTIONS[0],
    notes: '',
  })
  const [selectedAppointment, setSelectedAppointment] = useState(null)
  const [schedulingSaving, setSchedulingSaving] = useState(false)

  const appointments = useMemo(() => {
    const agentName = adminUser?.name || user?.name || 'Equipe coordination'
    const rows = []
    for (const sale of sales || []) {
      if (['cancelled', 'rejected', 'completed'].includes(String(sale.status || ''))) continue
      const fin = coordAtToDateTime(sale.coordinationFinanceAt)
      if (fin) {
        rows.push({
          id: `APT-${sale.id}-finance`,
          saleId: sale.id,
          type: 'finance',
          date: fin.date,
          time: fin.time,
          notes: '',
          clientName: sale.clientName || 'Client',
          projectTitle: sale.projectTitle || 'Projet',
          plotLabel: normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—',
          amount: sale.agreedPrice || 0,
          agentName,
          status: 'planned',
          coordinationNotes: sale.coordinationNotes || '',
        })
      }
      const jur = coordAtToDateTime(sale.coordinationJuridiqueAt)
      if (jur) {
        rows.push({
          id: `APT-${sale.id}-juridique`,
          saleId: sale.id,
          type: 'juridique',
          date: jur.date,
          time: jur.time,
          notes: '',
          clientName: sale.clientName || 'Client',
          projectTitle: sale.projectTitle || 'Projet',
          plotLabel: normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—',
          amount: sale.agreedPrice || 0,
          agentName,
          status: 'planned',
          coordinationNotes: sale.coordinationNotes || '',
        })
      }
    }
    return rows.sort((a, b) => dateTimeKey(a).localeCompare(dateTimeKey(b)))
  }, [sales, adminUser?.name, user?.name])

  const salesForCoordination = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (sales || [])
      .filter((s) => !['cancelled', 'rejected', 'completed'].includes(String(s.status || '')))
      .filter((s) => {
        const st = canonicalSaleStatus(s.status)
        return st === 'pending_coordination' || st === 'pending_finance' || st === 'pending_legal'
      })
      .filter((s) => {
        if (!q) return true
        const client = String(s.clientName || '').toLowerCase()
        const project = String(s.projectTitle || '').toLowerCase()
        const code = String(s.code || s.id || '').toLowerCase()
        const plots = normalizePlotIds(s).join(',').toLowerCase()
        return client.includes(q) || project.includes(q) || code.includes(q) || plots.includes(q)
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  }, [sales, query])

  const planningBySale = useMemo(() => {
    const map = new Map()
    for (const apt of appointments) {
      const key = `${apt.saleId}:${apt.type}`
      map.set(key, apt)
    }
    return map
  }, [appointments])

  const selectedAppointmentSale = useMemo(() => {
    if (!selectedAppointment) return null
    return (sales || []).find((s) => String(s.id) === String(selectedAppointment.saleId)) || null
  }, [selectedAppointment, sales])

  const openScheduler = (sale, type) => {
    const existing = planningBySale.get(`${sale.id}:${type}`)
    setScheduler({
      open: true,
      sale,
      type,
      date: existing?.date || todayIso(),
      time: existing?.time || SLOT_OPTIONS[0],
      notes: existing?.notes || '',
    })
  }

  const closeScheduler = () => {
    setScheduler((prev) => ({ ...prev, open: false, sale: null, notes: '' }))
  }

  const confirmSchedule = async () => {
    if (!scheduler.sale || schedulingSaving) return
    const sale = scheduler.sale
    const atIso = new Date(`${scheduler.date}T${scheduler.time}:00`).toISOString()
    const tag = scheduler.type === 'finance' ? 'Finance' : 'Juridique'
    const addition = scheduler.notes.trim()
      ? `[${scheduler.date} ${scheduler.time} ${tag}] ${scheduler.notes.trim()}`
      : ''
    const prevNotes = String(sale.coordinationNotes || '').trim()
    const coordinationNotes = addition ? (prevNotes ? `${prevNotes}\n${addition}` : addition) : prevNotes
    const patch = { coordinationNotes }
    if (scheduler.type === 'finance') {
      patch.coordinationFinanceAt = atIso
      // Keep a single action for finance: planning dispatches to finance queue.
      if (canonicalSaleStatus(sale.status) === 'pending_coordination') {
        patch.status = 'pending_finance'
        patch.pipelineStatus = 'pending_finance'
      }
    }
    else patch.coordinationJuridiqueAt = atIso
    setSchedulingSaving(true)
    try {
      await salesUpdate(sale.id, patch)
      await appendAuditLog({
        action: 'coordination_appointment_set',
        entity: 'sale',
        entityId: String(sale.id),
        actorUserId: adminUser?.id || null,
        actorEmail: adminUser?.email || '',
        details: `${tag} ${scheduler.date} ${scheduler.time}`,
      })
      closeScheduler()
    } catch (e) {
      console.error(e)
    } finally {
      setSchedulingSaving(false)
    }
  }

  const plannedCount = appointments.length
  const appointmentsByDate = useMemo(() => {
    const map = new Map()
    for (const apt of appointments) {
      const key = apt.date || ''
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(apt)
    }
    for (const [, list] of map) {
      list.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
    }
    return map
  }, [appointments])
  const monthCells = useMemo(() => monthGrid(monthAnchor), [monthAnchor])
  const dayAgenda = useMemo(() => appointmentsByDate.get(selectedDate) || [], [appointmentsByDate, selectedDate])
  const monthLabel = monthAnchor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  const reservationExpiryQueue = useMemo(() => {
    const now = Date.now()
    return (sales || []).filter((s) => {
      if (!s.reservationExpiresAt) return false
      if (s.financeConfirmedAt || s.stampedAt) return false
      if (['completed', 'cancelled', 'rejected'].includes(String(s.status))) return false
      if (s.reservationReleasedAt) return false
      const exp = new Date(s.reservationExpiresAt).getTime()
      const timedOut = exp < now
      if (s.reservationStatus === 'expired_pending_review') return true
      if (!timedOut) return false
      const st = String(s.reservationStatus || '')
      return st === 'active' || st === 'extended' || st === 'none'
    })
  }, [sales])

  useEffect(() => {
    if (!sales?.length) return
    let cancelled = false
    ;(async () => {
      const now = Date.now()
      for (const s of sales) {
        if (cancelled) return
        if (!s.reservationExpiresAt || s.reservationReleasedAt) continue
        if (s.financeConfirmedAt || s.stampedAt) continue
        if (['completed', 'cancelled', 'rejected'].includes(String(s.status))) continue
        const exp = new Date(s.reservationExpiresAt).getTime()
        if (exp >= now) continue
        const st = String(s.reservationStatus || '')
        if (st === 'released' || st === 'expired_pending_review') continue
        if (st !== 'active' && st !== 'extended' && st !== 'none') continue
        try {
          await salesUpdate(s.id, { reservationStatus: 'expired_pending_review' })
          try {
            await db.insertSaleReservationEvent({
              saleId: s.id,
              eventType: 'reservation_expired_queue',
              fromStatus: st,
              toStatus: 'expired_pending_review',
              actorUserId: null,
              details: 'Délai dépassé — file revue manuelle (pas de libération auto)',
            })
          } catch (e) {
            console.error(e)
          }
        } catch (e) {
          console.error(e)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sales, salesUpdate])

  const extendReservation = async (sale, hours = 24) => {
    const prevSt = String(sale.reservationStatus || '')
    const next = new Date(Date.now() + hours * 3600000).toISOString()
    await salesUpdate(sale.id, {
      reservationExpiresAt: next,
      reservationStatus: 'extended',
    })
    await appendAuditLog({
      action: 'reservation_extended',
      entity: 'sale',
      entityId: String(sale.id),
      actorUserId: adminUser?.id || null,
      actorEmail: adminUser?.email || '',
      details: `+${hours}h`,
    })
    try {
      await db.insertSaleReservationEvent({
        saleId: sale.id,
        eventType: 'reservation_extended',
        fromStatus: prevSt,
        toStatus: 'extended',
        actorUserId: adminUser?.id || null,
        details: `Prolongation ${hours}h`,
        metadata: { newExpiresAt: next },
      })
    } catch (e) {
      console.error(e)
    }
  }

  const releaseExpiredReservation = async (sale) => {
    const parcelDbIds = parcelDbIdsFromSale(sale)
    const prevSt = String(sale.reservationStatus || '')
    await salesUpdate(sale.id, {
      reservationStatus: 'released',
      reservationReleasedAt: new Date().toISOString(),
      reservationReleaseReason: 'manual_release_after_expiry',
      status: 'cancelled',
      pipelineStatus: 'cancelled',
    })
    for (const pid of parcelDbIds) {
      try {
        await updateParcelStatus(pid, 'available')
      } catch {
        /* ignore */
      }
    }
    await appendAuditLog({
      action: 'reservation_released',
      entity: 'sale',
      entityId: String(sale.id),
      actorUserId: adminUser?.id || null,
      actorEmail: adminUser?.email || '',
      details: 'File expirée — libération parcelle(s)',
    })
    try {
      await db.insertSaleReservationEvent({
        saleId: sale.id,
        eventType: 'reservation_released',
        fromStatus: prevSt,
        toStatus: 'released',
        actorUserId: adminUser?.id || null,
        details: 'Libération manuelle après expiration',
      })
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="coord-page coord-page--v2">
      <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
        <span className="ds-back-btn__icon" aria-hidden>←</span>
        <span className="ds-back-btn__label">Retour</span>
      </button>

      {/* Hero: clearer primary title + single KPI summary line */}
      <section className="cp-hero cp-hero--v2">
        <div className="cp-hero__top">
          <div className="cp-hero__icon" aria-hidden>🧭</div>
          <div>
            <h1 className="cp-hero__name">Coordination des ventes</h1>
            <p className="cp-hero__role">Planifier les rendez-vous Finance et Juridique</p>
          </div>
        </div>
        <div className="cp-hero__kpi" role="group" aria-label="Résumé">
          <div className="cp-hero__kpi-block">
            <span className="cp-hero__kpi-num">{salesForCoordination.length}</span>
            <span className="cp-hero__kpi-unit">À traiter</span>
          </div>
          <span className="cp-hero__kpi-sep" />
          <div className="cp-hero__kpi-block">
            <span className="cp-hero__kpi-num">{plannedCount}</span>
            <span className="cp-hero__kpi-unit">Planifiés</span>
          </div>
        </div>
      </section>

      {/* Inline guidance: one clear sentence explaining what the admin does here */}
      <div className="cp-guide" role="note">
        <span className="cp-guide__ico" aria-hidden>ℹ️</span>
        <div>
          <strong>Votre mission :</strong> pour chaque dossier, fixez un rendez-vous
          Finance puis un rendez-vous Juridique. Le calendrier récapitule tout.
        </div>
      </div>

      {reservationExpiryQueue.length > 0 ? (
        <section className="cp-alert">
          <div className="cp-alert__head">
            <span className="cp-alert__ico" aria-hidden>⚠️</span>
            <div>
              <h2 className="cp-alert__title">Réservations expirées — à revoir</h2>
              <p className="cp-alert__sub">
                {reservationExpiryQueue.length} dossier(s) sans validation Finance après 48h.
                Prolongez la réservation ou libérez la parcelle.
              </p>
            </div>
          </div>
          <div className="cp-alert__list">
            {reservationExpiryQueue.map((sale) => {
              const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
              return (
                <article key={sale.id} className="cp-card cp-card--warn">
                  <div className="cp-card__top">
                    <span className="cp-card__initials">{initials(sale.clientName)}</span>
                    <div className="cp-card__info">
                      <p className="cp-card__name">{sale.clientName || 'Client'}</p>
                      <p className="cp-card__sub">{sale.projectTitle || 'Projet'} • Parcelle {plotLabel}</p>
                    </div>
                    <span className="cp-card__badge cp-detail__badge--orange">Expirée</span>
                  </div>
                  <div className="cp-card__actions cp-card__actions--stack">
                    <div className="cp-card__actions-inline">
                      <button
                        type="button"
                        className="cp-card__btn"
                        title="Accorder 24h supplémentaires avant libération"
                        onClick={() => extendReservation(sale, 24)}
                      >
                        Prolonger de 24 h
                      </button>
                      <button
                        type="button"
                        className="cp-card__btn cp-card__btn--secondary"
                        title="Rendre la parcelle disponible et annuler la vente"
                        onClick={() => releaseExpiredReservation(sale)}
                      >
                        Libérer la parcelle
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* Tabs — clearer labels, touch-friendly */}
      <div className="cp-tabs cp-tabs--v2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'sales'}
          className={`cp-tab${view === 'sales' ? ' cp-tab--on' : ''}`}
          onClick={() => setView('sales')}
        >
          <span className="cp-tab__main">Dossiers à planifier</span>
          <span className="cp-tab__sub">Fixer les rendez-vous</span>
          <span className="cp-tab__badge" aria-label={`${salesForCoordination.length} dossier(s)`}>
            {salesForCoordination.length}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'calendar'}
          className={`cp-tab${view === 'calendar' ? ' cp-tab--on' : ''}`}
          onClick={() => setView('calendar')}
        >
          <span className="cp-tab__main">Calendrier</span>
          <span className="cp-tab__sub">Voir tous les rendez-vous</span>
          <span className="cp-tab__badge" aria-label={`${plannedCount} rendez-vous`}>
            {plannedCount}
          </span>
        </button>
      </div>

      {view === 'sales' && (
        <>
          {/* Section summary — what the admin does in this view */}
          <p className="cp-section-lede">
            Liste des dossiers en attente de coordination. Planifiez Finance puis Juridique.
          </p>

          <div className="cp-search">
            <span className="cp-search__ico" aria-hidden>🔎</span>
            <input
              className="cp-search__input"
              type="search"
              aria-label="Rechercher un dossier"
              placeholder="Rechercher par client, projet, code ou parcelle…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <section className="cp-queue">
            {salesForCoordination.length === 0 ? (
              <div className="cp-empty">
                <div className="cp-empty__ico" aria-hidden>📭</div>
                <p className="cp-empty__title">Aucun dossier à coordonner</p>
                <p className="cp-empty__hint">
                  Dès qu’une vente passe en « En attente coordination », elle apparaîtra ici.
                </p>
                <button
                  type="button"
                  className="cp-empty__cta"
                  onClick={() => setView('calendar')}
                >
                  Ouvrir le calendrier
                </button>
              </div>
            ) : (
              salesForCoordination.map((sale) => {
                const client = clients.find((c) => String(c.id) === String(sale.clientId))
                const statusMeta = getSaleStatusMeta(sale.status)
                const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
                const financePlan = planningBySale.get(`${sale.id}:finance`)
                const juridiquePlan = planningBySale.get(`${sale.id}:juridique`)
                return (
                  <article key={sale.id} className="cp-card">
                    <div className="cp-card__top">
                      <span className="cp-card__initials" aria-hidden>{initials(sale.clientName)}</span>
                      <div className="cp-card__info">
                        <p className="cp-card__name">{sale.clientName || 'Client'}</p>
                        <p className="cp-card__sub">{sale.projectTitle || 'Projet'} • Parcelle {plotLabel}</p>
                      </div>
                      <span className={`cp-card__badge cp-detail__badge--${statusMeta.badge || 'gray'}`}>
                        {statusMeta.label}
                      </span>
                    </div>

                    <div className="cp-card__grid">
                      <div>
                        <div className="cp-card__lbl" title="Prix total convenu avec le client">Montant</div>
                        <div className="cp-card__val">{fmtMoney(sale.agreedPrice)}</div>
                      </div>
                      <div>
                        <div className="cp-card__lbl" title="Somme déjà versée par le client">Acompte</div>
                        <div className="cp-card__val">{fmtMoney(sale.deposit)}</div>
                      </div>
                      <div>
                        <div className="cp-card__lbl" title="Statut de la validation Finance">Finance</div>
                        <div className="cp-card__val">
                          {sale.financeValidatedAt
                            ? `Validé (${fmtDate(sale.financeValidatedAt)})`
                            : (sale.financeConfirmedAt ? `Confirmé (${fmtDate(sale.financeConfirmedAt)})` : 'En attente')}
                        </div>
                      </div>
                      <div>
                        <div className="cp-card__lbl" title="Statut du passage chez le notaire">Notaire</div>
                        <div className="cp-card__val">
                          {sale.notaryCompletedAt ? `Terminé (${fmtDate(sale.notaryCompletedAt)})` : 'En cours'}
                        </div>
                      </div>
                      <div>
                        <div className="cp-card__lbl">Parcelle(s)</div>
                        <div className="cp-card__val cp-card__plot">{plotLabel}</div>
                      </div>
                      <div>
                        <div className="cp-card__lbl">Contact client</div>
                        <div className="cp-card__val">
                          {client?.phone
                            ? <a href={`tel:${client.phone}`} className="cp-card__phone">{client.phone}</a>
                            : <span className="cp-card__muted">Non renseigné</span>}
                        </div>
                      </div>
                    </div>

                    {/* Scheduled status — visible at a glance before actions */}
                    <div className="cp-card__status">
                      <div className={`cp-card__status-item${financePlan ? ' cp-card__status-item--ok' : ''}`}>
                        <span className="cp-card__status-dot" aria-hidden />
                        <span className="cp-card__status-lbl">Finance</span>
                        <span className="cp-card__status-val">
                          {financePlan ? `${fmtDate(financePlan.date)} • ${financePlan.time}` : 'À planifier'}
                        </span>
                      </div>
                      <div className={`cp-card__status-item${juridiquePlan ? ' cp-card__status-item--ok' : ''}`}>
                        <span className="cp-card__status-dot" aria-hidden />
                        <span className="cp-card__status-lbl">Juridique</span>
                        <span className="cp-card__status-val">
                          {juridiquePlan ? `${fmtDate(juridiquePlan.date)} • ${juridiquePlan.time}` : 'À planifier'}
                        </span>
                      </div>
                    </div>

                    <div className="cp-card__actions cp-card__actions--stack">
                      <div className="cp-card__actions-inline">
                        <button
                          type="button"
                          className={`cp-card__btn${financePlan ? ' cp-card__btn--secondary' : ''}`}
                          title="Fixer (ou modifier) le rendez-vous Finance"
                          onClick={() => openScheduler(sale, 'finance')}
                        >
                          {financePlan ? 'Modifier Finance' : 'Planifier Finance'}
                        </button>
                        <button
                          type="button"
                          className={`cp-card__btn${juridiquePlan ? ' cp-card__btn--secondary' : ''}`}
                          title="Fixer (ou modifier) le rendez-vous Juridique"
                          onClick={() => openScheduler(sale, 'juridique')}
                        >
                          {juridiquePlan ? 'Modifier Juridique' : 'Planifier Juridique'}
                        </button>
                      </div>
                    </div>
                  </article>
                )
              })
            )}
          </section>
        </>
      )}

      {view === 'calendar' && (
        <section className="cp-block cp-block--calendar" style={{ marginTop: 10 }}>
          <div className="cp-block__head">
            <span className="cp-block__ico" aria-hidden>📅</span>
            <div>
              <h2 className="cp-block__title">Calendrier des rendez-vous</h2>
              <p className="cp-block__sub">Finance et Juridique</p>
            </div>
          </div>
          <p className="cp-section-lede cp-section-lede--in-block">
            Cliquez sur un jour pour voir les rendez-vous, puis sur un rendez-vous pour son détail.
          </p>
          <div className="cp-cal-wrap">
            {appointments.length === 0 ? (
              <div className="cp-empty">
                <div className="cp-empty__ico" aria-hidden>🗓️</div>
                <p className="cp-empty__title">Aucun rendez-vous planifié</p>
                <p className="cp-empty__hint">Commencez par planifier un rendez-vous depuis l’onglet « Dossiers à planifier ».</p>
                <button
                  type="button"
                  className="cp-empty__cta"
                  onClick={() => setView('sales')}
                >
                  Aller aux dossiers
                </button>
              </div>
            ) : (
              <>
                <div className="cp-cal-toolbar">
                  <button type="button" className="cp-cal-nav" onClick={() => setMonthAnchor((d) => addMonths(d, -1))}>‹</button>
                  <span className="cp-cal-month">{monthLabel}</span>
                  <button type="button" className="cp-cal-nav" onClick={() => setMonthAnchor((d) => addMonths(d, 1))}>›</button>
                </div>

                <div className="cp-cal-weekhead">
                  {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
                    <span key={d} className="cp-cal-weekday">{d}</span>
                  ))}
                </div>

                <div className="cp-cal-grid-month">
                  {monthCells.map((cell) => {
                    const iso = toIsoDate(cell.date)
                    const count = (appointmentsByDate.get(iso) || []).length
                    const isSel = iso === selectedDate
                    return (
                      <button
                        key={`${iso}-${cell.inMonth ? 'in' : 'out'}`}
                        type="button"
                        className={`cp-cal-day${cell.inMonth ? '' : ' cp-cal-day--muted'}${isSel ? ' cp-cal-day--selected' : ''}`}
                        onClick={() => setSelectedDate(iso)}
                      >
                        <span className="cp-cal-day__num">{cell.date.getDate()}</span>
                        {count > 0 ? <span className="cp-cal-day__dot">{count}</span> : null}
                      </button>
                    )
                  })}
                </div>

                <div className="cp-cal-agenda">
                  <div className="cp-cal-agenda__head">{fmtDate(selectedDate)}</div>
                  {dayAgenda.length === 0 ? (
                    <div className="cp-empty" style={{ border: 'none', borderRadius: 0, padding: 16 }}>
                      Aucun rendez-vous ce jour.
                    </div>
                  ) : (
                    dayAgenda.map((apt) => (
                      <button
                        key={`${apt.id}-${dateTimeKey(apt)}`}
                        type="button"
                        className="cp-cal-item"
                        onClick={() => setSelectedAppointment(apt)}
                      >
                        <span className="cp-cal-item__time">{apt.time}</span>
                        <span className="cp-cal-item__body">
                          <span className="cp-cal-item__kind">{typeLabel(apt.type)}</span>
                          <span className="cp-cal-item__name">{apt.clientName}</span>
                          <span className="cp-cal-item__sub">{apt.projectTitle} • {apt.plotLabel}</span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {scheduler.open && scheduler.sale && (
        <div className="cp-overlay" role="presentation" onClick={closeScheduler}>
          <div className="cp-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="cp-sheet__head">
              <h3 className="cp-sheet__title">Planifier {typeLabel(scheduler.type)}</h3>
              <button type="button" className="cp-sheet__close" onClick={closeScheduler}>✕</button>
            </div>
            <div className="cp-sheet__recap">
              <div className="cp-sheet__recap-lbl">Vente selectionnee</div>
              <div className="cp-sheet__recap-line">
                <strong>{scheduler.sale.clientName || 'Client'}</strong>
                <span className="cp-recap-dim">• {scheduler.sale.projectTitle || 'Projet'}</span>
              </div>
              <div className="cp-sheet__recap-meta">Montant: {fmtMoney(scheduler.sale.agreedPrice)}</div>
            </div>

            <div style={{ margin: '0 0 12px' }}>
              <SaleSnapshotTracePanel sale={scheduler.sale} />
            </div>

            <label className="cp-sheet__label">Type de rendez-vous</label>
            <div className="cp-sheet__pills">
              <button type="button" className={`cp-pill${scheduler.type === 'finance' ? ' cp-pill--on' : ''}`} onClick={() => setScheduler((p) => ({ ...p, type: 'finance' }))}>
                Finance
              </button>
              <button type="button" className={`cp-pill${scheduler.type === 'juridique' ? ' cp-pill--on' : ''}`} onClick={() => setScheduler((p) => ({ ...p, type: 'juridique' }))}>
                Juridique
              </button>
            </div>

            <label className="cp-sheet__label">Date</label>
            <input
              className="cp-sheet__date-input"
              type="date"
              value={scheduler.date}
              min={todayIso()}
              onChange={(e) => setScheduler((p) => ({ ...p, date: e.target.value }))}
            />
            <div className="cp-sheet__date-hint">Choisissez le jour du rendez-vous.</div>

            <label className="cp-sheet__label">Heure</label>
            <div className="cp-sheet__times">
              {SLOT_OPTIONS.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  className={`cp-time${scheduler.time === slot ? ' cp-time--on' : ''}`}
                  onClick={() => setScheduler((p) => ({ ...p, time: slot }))}
                >
                  {slot}
                </button>
              ))}
            </div>

            <label className="cp-sheet__label">Notes (optionnel)</label>
            <textarea
              className="cp-sheet__date-input"
              rows={3}
              value={scheduler.notes}
              onChange={(e) => setScheduler((p) => ({ ...p, notes: e.target.value }))}
              placeholder="Contexte du rendez-vous, pieces demandees..."
            />

            <div className="cp-sheet__notice">
              <span>ℹ</span>
              <div>
                Le rendez-vous sera ajoute au calendrier de coordination.
                <strong> Vous pouvez le reprogrammer a tout moment.</strong>
              </div>
            </div>

            <button
              type="button"
              className="cp-sheet__confirm"
              disabled={schedulingSaving}
              onClick={() => void confirmSchedule()}
            >
              {schedulingSaving ? 'Enregistrement…' : 'Confirmer le rendez-vous'}
            </button>
          </div>
        </div>
      )}

      {selectedAppointment && (
        <div className="cp-overlay" role="presentation" onClick={() => setSelectedAppointment(null)}>
          <div className="cp-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="cp-sheet__head">
              <h3 className="cp-sheet__title">Detail du rendez-vous</h3>
              <button type="button" className="cp-sheet__close" onClick={() => setSelectedAppointment(null)}>✕</button>
            </div>
            <div className="cp-cal-modal">
              {selectedAppointmentSale ? (
                <div style={{ marginBottom: 12 }}>
                  <SaleSnapshotTracePanel sale={selectedAppointmentSale} />
                </div>
              ) : null}
              <div className="cp-cal-modal__row"><span>Type</span><strong>{typeLabel(selectedAppointment.type)}</strong></div>
              <div className="cp-cal-modal__row"><span>Client</span><strong>{selectedAppointment.clientName}</strong></div>
              <div className="cp-cal-modal__row"><span>Projet</span><strong>{selectedAppointment.projectTitle}</strong></div>
              <div className="cp-cal-modal__row"><span>Parcelles</span><strong>{selectedAppointment.plotLabel}</strong></div>
              <div className="cp-cal-modal__row"><span>Date</span><strong>{fmtDate(selectedAppointment.date)}</strong></div>
              <div className="cp-cal-modal__row"><span>Heure</span><strong>{selectedAppointment.time}</strong></div>
              <div className="cp-cal-modal__row"><span>Montant vente</span><strong>{fmtMoney(selectedAppointment.amount)}</strong></div>
              <div className="cp-cal-modal__row"><span>Agent</span><strong>{selectedAppointment.agentName}</strong></div>
              {selectedAppointment.coordinationNotes ? (
                <div className="cp-cal-modal__notes">{selectedAppointment.coordinationNotes}</div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
