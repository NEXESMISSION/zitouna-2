import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useClients, useSales, useProjects, useAdminUsers } from '../../lib/useSupabase.js'
import * as db from '../../lib/db.js'
import { getSaleStatusMeta, canonicalSaleStatus } from '../../domain/workflowModel.js'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import AdminModal from '../components/AdminModal.jsx'
import './coordination-page.css'
import './zitouna-admin-page.css'

const SLOT_OPTIONS = ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00']

function todayIso() {
  // Local-date ISO (YYYY-MM-DD) — NOT toISOString(), which converts to UTC
  // and can return yesterday around midnight for users east of UTC.
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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

function getPagerPages(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out = [1]
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)
  if (left > 2) out.push('…')
  for (let i = left; i <= right; i++) out.push(i)
  if (right < total - 1) out.push('…')
  out.push(total)
  return out
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
  const { sales, loading: salesLoading, update: salesUpdate } = useSales()
  const { clients } = useClients()
  const { adminUsers } = useAdminUsers()
  const { updateParcelStatus } = useProjects()
  // Write-only audit: call db directly. Avoids useWorkspaceAudit() eagerly fetching 8000 log rows we never display here.
  const appendAuditLog = useCallback(async (entry) => {
    try {
      await db.appendAuditEntry({
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId != null ? String(entry.entityId) : '',
        details: entry.details || '',
        metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {},
        actorUserId: entry.actorUserId || null,
        user: entry.actorEmail || entry.user || '',
        actorEmail: entry.actorEmail || entry.user || '',
        subjectUserId: entry.subjectUserId || null,
        severity: entry.severity || 'info',
        category: entry.category || 'business',
        source: entry.source || 'admin_ui',
      })
    } catch (e) { console.error('appendAuditEntry', e) }
  }, [])

  const [query, setQuery] = useState('')
  const [view, setView] = useState('sales')
  const [page, setPage] = useState(1)
  const COORD_PER_PAGE = 10
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
  const [detailSale, setDetailSale] = useState(null)

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

  const coordPageCount = Math.max(1, Math.ceil(salesForCoordination.length / COORD_PER_PAGE))
  useEffect(() => {
    if (page > coordPageCount) setPage(1)
  }, [page, coordPageCount])
  useEffect(() => { setPage(1) }, [query])
  const pagedSales = useMemo(
    () => salesForCoordination.slice((page - 1) * COORD_PER_PAGE, page * COORD_PER_PAGE),
    [salesForCoordination, page],
  )

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
    const withTimeout = (p, ms, label) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
    ])
    try {
      await withTimeout(salesUpdate(sale.id, patch), 15_000, 'salesUpdate')
      // audit log is best-effort — never block the appointment save on it.
      withTimeout(
        appendAuditLog({
          action: 'coordination_appointment_set',
          entity: 'sale',
          entityId: String(sale.id),
          actorUserId: adminUser?.id || null,
          actorEmail: adminUser?.email || '',
          details: `${tag} ${scheduler.date} ${scheduler.time}`,
        }),
        8_000,
        'appendAuditLog',
      ).catch((e) => console.warn('[Coord] appendAuditLog (non-blocking):', e?.message || e))
      closeScheduler()
    } catch (e) {
      console.error('[Coord] confirmSchedule failed:', e?.message || e, e)
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
            {salesLoading && salesForCoordination.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => (
                <article key={`cp-sk-${i}`} className="cp-card cp-card--skeleton" aria-hidden>
                  <div className="cp-card__top">
                    <span className="cp-card__initials cp-sk-box" />
                    <div className="cp-card__info">
                      <p className="cp-sk-line cp-sk-line--title" />
                      <p className="cp-sk-line cp-sk-line--sub" />
                    </div>
                    <span className="cp-sk-line cp-sk-line--badge" />
                  </div>
                  <div className="cp-card__grid">
                    <div><span className="cp-sk-line cp-sk-line--cell" /></div>
                    <div><span className="cp-sk-line cp-sk-line--cell" /></div>
                    <div><span className="cp-sk-line cp-sk-line--cell" /></div>
                    <div><span className="cp-sk-line cp-sk-line--cell" /></div>
                  </div>
                  <div className="cp-card__actions">
                    <div className="cp-card__actions-inline">
                      <span className="cp-sk-line cp-sk-line--btn" />
                      <span className="cp-sk-line cp-sk-line--btn" />
                    </div>
                  </div>
                </article>
              ))
            ) : salesForCoordination.length === 0 ? (
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
              pagedSales.map((sale) => {
                const client = clients.find((c) => String(c.id) === String(sale.clientId))
                const sellerClient = sale.sellerClientId ? clients.find((c) => String(c.id) === String(sale.sellerClientId)) : null
                const sellerAgent = sale.agentId ? adminUsers.find((u) => String(u.id) === String(sale.agentId)) : null
                const sellerName = sellerClient?.name || sellerAgent?.name || sellerAgent?.email || '—'
                const sellerPhone = sellerClient?.phone || sellerAgent?.phone || ''
                const statusMeta = getSaleStatusMeta(sale.status)
                const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
                const financePlan = planningBySale.get(`${sale.id}:finance`)
                const juridiquePlan = planningBySale.get(`${sale.id}:juridique`)
                return (
                  <article
                    key={sale.id}
                    className={`cp-card cp-card--${statusMeta.badge || 'gray'}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailSale({ sale, client, sellerClient, sellerAgent })}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailSale({ sale, client, sellerClient, sellerAgent }) } }}
                    style={{ cursor: 'pointer' }}
                  >
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
                            ? <a href={`tel:${client.phone}`} className="cp-card__phone" onClick={(e) => e.stopPropagation()}>{client.phone}</a>
                            : <span className="cp-card__muted">Non renseigné</span>}
                        </div>
                      </div>
                      <div>
                        <div className="cp-card__lbl" title="Qui a réalisé cette vente">Vendeur</div>
                        <div className="cp-card__val" style={{ fontWeight: 600 }}>
                          {sellerName}
                          {sellerPhone && (
                            <div className="cp-card__muted" style={{ fontWeight: 400, fontSize: 11, marginTop: 2 }}>{sellerPhone}</div>
                          )}
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

                    <div className="cp-card__actions cp-card__actions--stack" onClick={(e) => e.stopPropagation()}>
                      <div className="cp-card__actions-inline">
                        <button
                          type="button"
                          className={`cp-card__btn${financePlan ? ' cp-card__btn--secondary' : ''}`}
                          title="Fixer (ou modifier) le rendez-vous Finance"
                          onClick={(e) => { e.stopPropagation(); openScheduler(sale, 'finance') }}
                        >
                          {financePlan ? 'Modifier Finance' : 'Planifier Finance'}
                        </button>
                        <button
                          type="button"
                          className={`cp-card__btn${juridiquePlan ? ' cp-card__btn--secondary' : ''}`}
                          title="Fixer (ou modifier) le rendez-vous Juridique"
                          onClick={(e) => { e.stopPropagation(); openScheduler(sale, 'juridique') }}
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
          {salesForCoordination.length > COORD_PER_PAGE && (
            <div className="cp-pager" role="navigation" aria-label="Pagination">
              <button
                type="button"
                className="cp-pager__btn cp-pager__btn--nav"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Page précédente"
              >
                ‹
              </button>
              {getPagerPages(page, coordPageCount).map((p, i) =>
                p === '…' ? (
                  <span key={`dots-${i}`} className="cp-pager__ellipsis" aria-hidden>…</span>
                ) : (
                  <button
                    key={p}
                    type="button"
                    className={`cp-pager__btn${p === page ? ' cp-pager__btn--active' : ''}`}
                    onClick={() => setPage(p)}
                    aria-current={p === page ? 'page' : undefined}
                  >
                    {p}
                  </button>
                ),
              )}
              <button
                type="button"
                className="cp-pager__btn cp-pager__btn--nav"
                disabled={page >= coordPageCount}
                onClick={() => setPage((p) => Math.min(coordPageCount, p + 1))}
                aria-label="Page suivante"
              >
                ›
              </button>
              <span className="cp-pager__info">
                {(page - 1) * COORD_PER_PAGE + 1}–{Math.min(page * COORD_PER_PAGE, salesForCoordination.length)} / {salesForCoordination.length}
              </span>
            </div>
          )}
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

      <AdminModal open={Boolean(detailSale)} onClose={() => setDetailSale(null)} title="Détails de la vente" width={560}>
        {detailSale && (() => {
          const s = detailSale.sale
          const c = detailSale.client
          const sc = detailSale.sellerClient
          const sa = detailSale.sellerAgent
          const plots = normalizePlotIds(s).map((id) => `#${id}`).join(', ') || '—'
          const stMeta = getSaleStatusMeta(s.status)
          return (
            <div className="cp-detail" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{s.clientName || 'Client'}</div>
                  <span className={`cp-card__badge cp-detail__badge--${stMeta.badge || 'gray'}`}>{stMeta.label}</span>
                </div>
                <div style={{ color: 'var(--adm-text-dim)', fontSize: 13 }}>Code vente : <code>{s.code || s.id}</code></div>
              </div>

              <section style={{ border: '1px solid var(--adm-border)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13, letterSpacing: 0.3 }}>VENDEUR</div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 6, fontSize: 13 }}>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Nom</div>
                  <div style={{ fontWeight: 600 }}>{sc?.name || sa?.name || sa?.email || '—'}</div>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Rôle</div>
                  <div>{sa?.role ? `Staff — ${sa.role}` : (sc ? 'Vendeur délégué (client)' : '—')}</div>
                  {(sc?.phone || sa?.phone) && (<>
                    <div style={{ color: 'var(--adm-text-dim)' }}>Téléphone</div>
                    <div style={{ direction: 'ltr' }}>{sc?.phone || sa?.phone}</div>
                  </>)}
                  {(sc?.email || sa?.email) && (<>
                    <div style={{ color: 'var(--adm-text-dim)' }}>Email</div>
                    <div>{sc?.email || sa?.email}</div>
                  </>)}
                </div>
              </section>

              <section style={{ border: '1px solid var(--adm-border)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13, letterSpacing: 0.3 }}>ACHETEUR</div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 6, fontSize: 13 }}>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Nom</div>
                  <div style={{ fontWeight: 600 }}>{c?.name || s.clientName || '—'}</div>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Téléphone</div>
                  <div style={{ direction: 'ltr' }}>{c?.phone || s.buyerPhoneNormalized || '—'}</div>
                  {c?.cin && (<>
                    <div style={{ color: 'var(--adm-text-dim)' }}>CIN</div>
                    <div style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>{c.cin}</div>
                  </>)}
                  {c?.email && (<>
                    <div style={{ color: 'var(--adm-text-dim)' }}>Email</div>
                    <div>{c.email}</div>
                  </>)}
                  {c?.city && (<>
                    <div style={{ color: 'var(--adm-text-dim)' }}>Ville</div>
                    <div>{c.city}</div>
                  </>)}
                </div>
              </section>

              <section style={{ border: '1px solid var(--adm-border)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13, letterSpacing: 0.3 }}>PROJET & PARCELLES</div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 6, fontSize: 13 }}>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Projet</div>
                  <div style={{ fontWeight: 600 }}>{s.projectTitle || s.projectId || '—'}</div>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Parcelle(s)</div>
                  <div>{plots}</div>
                </div>
              </section>

              <section style={{ border: '1px solid var(--adm-border)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13, letterSpacing: 0.3 }}>MONTANTS</div>
                <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 6, fontSize: 13 }}>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Prix convenu</div>
                  <div style={{ fontWeight: 600 }}>{fmtMoney(s.agreedPrice)}</div>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Acompte</div>
                  <div>{fmtMoney(s.deposit)}</div>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Mode</div>
                  <div>{s.paymentType === 'installments' ? `Échelonné — ${s.offerName || ''}` : 'Comptant'}</div>
                  {s.paymentType === 'installments' && (<>
                    <div style={{ color: 'var(--adm-text-dim)' }}>Durée</div>
                    <div>{s.offerDuration || 0} mois · {s.offerDownPayment || 0}% apport</div>
                  </>)}
                </div>
              </section>

              <section style={{ border: '1px solid var(--adm-border)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13, letterSpacing: 0.3 }}>PLANIFICATION</div>
                <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 6, fontSize: 13 }}>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Finance</div>
                  <div>{s.coordinationFinanceAt ? `${fmtDate(s.coordinationFinanceAt)} ${new Date(s.coordinationFinanceAt).toTimeString().slice(0, 5)}` : <span className="cp-card__muted">À planifier</span>}</div>
                  <div style={{ color: 'var(--adm-text-dim)' }}>Juridique</div>
                  <div>{s.coordinationJuridiqueAt ? `${fmtDate(s.coordinationJuridiqueAt)} ${new Date(s.coordinationJuridiqueAt).toTimeString().slice(0, 5)}` : <span className="cp-card__muted">À planifier</span>}</div>
                </div>
                {s.coordinationNotes && (
                  <div style={{ marginTop: 10, padding: 8, background: 'var(--adm-bg-subtle, #f8f9fa)', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                    {s.coordinationNotes}
                  </div>
                )}
              </section>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="adm-btn adm-btn--secondary" onClick={() => setDetailSale(null)}>Fermer</button>
                <button className="adm-btn adm-btn--primary" onClick={() => { setDetailSale(null); openScheduler(s, 'finance') }}>Planifier Finance</button>
                <button className="adm-btn adm-btn--primary" onClick={() => { setDetailSale(null); openScheduler(s, 'juridique') }}>Planifier Juridique</button>
              </div>
            </div>
          )
        })()}
      </AdminModal>

      {scheduler.open && scheduler.sale && (() => {
        // Validation: the chosen date/time must be in the future.
        const chosen = scheduler.date && scheduler.time
          ? new Date(`${scheduler.date}T${scheduler.time}:00`)
          : null
        const dateError = chosen && chosen.getTime() < Date.now()
          ? 'La date et l’heure doivent être dans le futur.'
          : ''
        return (
        <div className="cp-overlay" role="presentation" onClick={closeScheduler}>
          <div className="cp-sheet cp-sheet--v2" role="dialog" aria-modal="true" aria-labelledby="cp-sheet-title" onClick={(e) => e.stopPropagation()}>
            <div className="cp-sheet__head">
              <h3 id="cp-sheet-title" className="cp-sheet__title">
                Planifier un rendez-vous {typeLabel(scheduler.type)}
              </h3>
              <button
                type="button"
                className="cp-sheet__close"
                aria-label="Fermer"
                onClick={closeScheduler}
              >
                ✕
              </button>
            </div>

            <p className="cp-sheet__lede">
              Choisissez le type, la date et l’heure. Le rendez-vous apparaîtra immédiatement dans le calendrier.
            </p>

            <div className="cp-sheet__recap">
              <div className="cp-sheet__recap-lbl">Dossier concerné</div>
              <div className="cp-sheet__recap-line">
                <strong>{scheduler.sale.clientName || 'Client'}</strong>
                <span className="cp-recap-dim">• {scheduler.sale.projectTitle || 'Projet'}</span>
              </div>
              <div className="cp-sheet__recap-meta">Montant convenu : {fmtMoney(scheduler.sale.agreedPrice)}</div>
            </div>

            <div style={{ margin: '0 0 12px' }}>
              <SaleSnapshotTracePanel sale={scheduler.sale} />
            </div>

            <label className="cp-sheet__label" htmlFor="cp-type">
              Type de rendez-vous
              <span className="cp-sheet__hint"> — Finance valide le paiement, Juridique prépare le contrat.</span>
            </label>
            <div id="cp-type" className="cp-sheet__pills" role="radiogroup" aria-label="Type de rendez-vous">
              <button
                type="button"
                role="radio"
                aria-checked={scheduler.type === 'finance'}
                className={`cp-pill${scheduler.type === 'finance' ? ' cp-pill--on' : ''}`}
                onClick={() => setScheduler((p) => ({ ...p, type: 'finance' }))}
              >
                Finance
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={scheduler.type === 'juridique'}
                className={`cp-pill${scheduler.type === 'juridique' ? ' cp-pill--on' : ''}`}
                onClick={() => setScheduler((p) => ({ ...p, type: 'juridique' }))}
              >
                Juridique
              </button>
            </div>

            <label className="cp-sheet__label" htmlFor="cp-date">Date du rendez-vous</label>
            <input
              id="cp-date"
              className={`cp-sheet__date-input${dateError ? ' cp-sheet__date-input--err' : ''}`}
              type="date"
              value={scheduler.date}
              min={todayIso()}
              aria-invalid={Boolean(dateError)}
              onChange={(e) => setScheduler((p) => ({ ...p, date: e.target.value }))}
            />
            <div className="cp-sheet__date-hint">Sélectionnez le jour souhaité (aujourd’hui ou plus tard).</div>

            <label className="cp-sheet__label">Créneau horaire</label>
            <div className="cp-sheet__times" role="radiogroup" aria-label="Créneau horaire">
              {SLOT_OPTIONS.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  role="radio"
                  aria-checked={scheduler.time === slot}
                  className={`cp-time${scheduler.time === slot ? ' cp-time--on' : ''}`}
                  onClick={() => setScheduler((p) => ({ ...p, time: slot }))}
                >
                  {slot}
                </button>
              ))}
            </div>

            <label className="cp-sheet__label" htmlFor="cp-notes">Notes (facultatif)</label>
            <textarea
              id="cp-notes"
              className="cp-sheet__date-input"
              rows={3}
              value={scheduler.notes}
              onChange={(e) => setScheduler((p) => ({ ...p, notes: e.target.value }))}
              placeholder="Ex. : pièces à apporter, contexte particulier…"
            />

            {dateError ? (
              <div className="cp-sheet__error" role="alert">
                <span aria-hidden>⚠</span>
                <div>{dateError}</div>
              </div>
            ) : null}

            <div className="cp-sheet__notice">
              <span aria-hidden>ℹ</span>
              <div>
                Le rendez-vous sera ajouté au calendrier de coordination.
                <strong> Vous pouvez le modifier plus tard.</strong>
              </div>
            </div>

            <button
              type="button"
              className="cp-sheet__confirm"
              disabled={schedulingSaving || Boolean(dateError)}
              onClick={() => void confirmSchedule()}
            >
              {schedulingSaving ? 'Enregistrement…' : 'Confirmer le rendez-vous'}
            </button>
          </div>
        </div>
        )
      })()}

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
