import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useClients, useSales, useProjects, useAdminUsers } from '../../lib/useSupabase.js'
import { runSafeAction } from '../../lib/runSafeAction.js'
import * as db from '../../lib/db.js'
import { getSaleStatusMeta, canonicalSaleStatus } from '../../domain/workflowModel.js'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import AdminModal from '../components/AdminModal.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import { getPagerPages } from './pager-util.js'
import './sell-field.css'
import './coordination-page.css'

const SLOT_OPTIONS = ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00']
const PER_PAGE = 15

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return String(iso) }
}
function fmtMoney(v) { return `${(Number(v) || 0).toLocaleString('fr-FR')} TND` }
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}
function normalizePlotIds(sale) {
  const ids = Array.isArray(sale?.plotIds) ? sale.plotIds : sale?.plotId != null ? [sale.plotId] : []
  return ids.map((x) => Number(x)).filter((n) => Number.isFinite(n))
}
function parcelDbIdsFromSale(sale) {
  const raw = Array.isArray(sale?.parcelIds) && sale.parcelIds.length > 0
    ? sale.parcelIds
    : sale?.parcelId != null && sale.parcelId !== '' ? [sale.parcelId] : []
  return [...new Set(raw.map((x) => Number(x)).filter((n) => Number.isFinite(n)))]
}
function typeLabel(t) { return t === 'finance' ? 'Finance' : 'Juridique' }
function coordAtToDateTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return { date: toIsoDate(d), time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1) }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1) }
function monthGrid(anchor) {
  const first = startOfMonth(anchor)
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

// Map a sale's canonical status to an `sp-card--{tone}` + badge.
function toneForSale(sale, hasFin, hasJur) {
  const st = canonicalSaleStatus(sale.status)
  if (st === 'pending_coordination') return hasFin || hasJur ? 'orange' : 'red'
  if (hasFin && hasJur) return 'green'
  if (hasFin || hasJur) return 'blue'
  return 'orange'
}

// ----------------------------------------------------------------------------
// Page
// ----------------------------------------------------------------------------
export default function CoordinationPage() {
  const navigate = useNavigate()
  const { adminUser, user } = useAuth()
  const { sales, loading: salesLoading, update: salesUpdate } = useSales()
  const { clients } = useClients()
  const { adminUsers } = useAdminUsers()
  const { updateParcelStatus } = useProjects()

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
  const [statusFilter, setStatusFilter] = useState('all')
  const [view, setView] = useState('sales')
  const [page, setPage] = useState(1)
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()))
  const [scheduler, setScheduler] = useState({
    open: false, sale: null, type: 'finance',
    date: todayIso(), time: SLOT_OPTIONS[0], notes: '',
  })
  const [schedulingSaving, setSchedulingSaving] = useState(false)
  const [selectedAppointment, setSelectedAppointment] = useState(null)
  const [detailSale, setDetailSale] = useState(null)
  const [expiryOpen, setExpiryOpen] = useState(false)
  const [reservationBusy, setReservationBusy] = useState(null)
  const [reservationNotice, setReservationNotice] = useState('')
  // Cancel-sale modal state. Sale stays in DB with status='cancelled' so the
  // audit log + commission history + buyer snapshot remain queryable later.
  const [cancelTarget, setCancelTarget] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelBusy, setCancelBusy] = useState(false)

  // ---- derived lists -------------------------------------------------------
  const appointments = useMemo(() => {
    const agentName = adminUser?.name || user?.name || 'Equipe coordination'
    const rows = []
    for (const sale of sales || []) {
      if (['cancelled', 'rejected', 'completed'].includes(String(sale.status || ''))) continue
      const fin = coordAtToDateTime(sale.coordinationFinanceAt)
      if (fin) rows.push({
        id: `APT-${sale.id}-finance`, saleId: sale.id, type: 'finance',
        date: fin.date, time: fin.time, notes: '',
        clientName: sale.clientName || 'Client', projectTitle: sale.projectTitle || 'Projet',
        plotLabel: normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—',
        amount: sale.agreedPrice || 0, agentName, status: 'planned',
        coordinationNotes: sale.coordinationNotes || '',
      })
      const jur = coordAtToDateTime(sale.coordinationJuridiqueAt)
      if (jur) rows.push({
        id: `APT-${sale.id}-juridique`, saleId: sale.id, type: 'juridique',
        date: jur.date, time: jur.time, notes: '',
        clientName: sale.clientName || 'Client', projectTitle: sale.projectTitle || 'Projet',
        plotLabel: normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—',
        amount: sale.agreedPrice || 0, agentName, status: 'planned',
        coordinationNotes: sale.coordinationNotes || '',
      })
    }
    return rows.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
  }, [sales, adminUser?.name, user?.name])

  const salesInScope = useMemo(() => {
    return (sales || [])
      .filter((s) => !['cancelled', 'rejected', 'completed'].includes(String(s.status || '')))
      .filter((s) => {
        const st = canonicalSaleStatus(s.status)
        return st === 'pending_coordination' || st === 'pending_finance' || st === 'pending_legal'
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  }, [sales])

  // Cancelled archive: sales keep their data and snapshot so the coordinator
  // can still look them up for tracking / reconciliation. Sorted by most
  // recent cancel (falls back to createdAt when no releasedAt recorded).
  const cancelledSales = useMemo(() => {
    return (sales || [])
      .filter((s) => String(s.status || '') === 'cancelled')
      .sort((a, b) => {
        const aT = String(a.reservationReleasedAt || a.updatedAt || a.createdAt || '')
        const bT = String(b.reservationReleasedAt || b.updatedAt || b.createdAt || '')
        return bT.localeCompare(aT)
      })
  }, [sales])

  const planningBySale = useMemo(() => {
    const map = new Map()
    for (const a of appointments) map.set(`${a.saleId}:${a.type}`, a)
    return map
  }, [appointments])

  const statusCounts = useMemo(() => {
    let unplanned = 0, partial = 0, planned = 0
    for (const s of salesInScope) {
      const fin = planningBySale.has(`${s.id}:finance`)
      const jur = planningBySale.has(`${s.id}:juridique`)
      if (fin && jur) planned += 1
      else if (fin || jur) partial += 1
      else unplanned += 1
    }
    return { unplanned, partial, planned, total: salesInScope.length }
  }, [salesInScope, planningBySale])

  const salesForCoordination = useMemo(() => {
    const q = query.trim().toLowerCase()
    // 'cancelled' is a read-only archive view: pull from cancelledSales
    // instead of the active scope.
    const source = statusFilter === 'cancelled' ? cancelledSales : salesInScope
    return source
      .filter((s) => {
        if (statusFilter === 'all' || statusFilter === 'cancelled') return true
        const fin = planningBySale.has(`${s.id}:finance`)
        const jur = planningBySale.has(`${s.id}:juridique`)
        if (statusFilter === 'unplanned') return !fin && !jur
        if (statusFilter === 'partial') return (fin || jur) && !(fin && jur)
        if (statusFilter === 'planned') return fin && jur
        return true
      })
      .filter((s) => {
        if (!q) return true
        const hay = `${s.clientName || ''} ${s.projectTitle || ''} ${s.code || s.id || ''} ${normalizePlotIds(s).join(',')}`.toLowerCase()
        return hay.includes(q)
      })
  }, [salesInScope, cancelledSales, planningBySale, statusFilter, query])

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

  const pageCount = Math.max(1, Math.ceil(salesForCoordination.length / PER_PAGE))
  useEffect(() => { if (page > pageCount) setPage(1) }, [page, pageCount])
  useEffect(() => { setPage(1) }, [query, statusFilter])
  const pagedSales = useMemo(
    () => salesForCoordination.slice((page - 1) * PER_PAGE, page * PER_PAGE),
    [salesForCoordination, page],
  )

  const selectedAppointmentSale = useMemo(() => {
    if (!selectedAppointment) return null
    return (sales || []).find((s) => String(s.id) === String(selectedAppointment.saleId)) || null
  }, [selectedAppointment, sales])

  const appointmentsByDate = useMemo(() => {
    const map = new Map()
    for (const a of appointments) {
      if (!map.has(a.date)) map.set(a.date, [])
      map.get(a.date).push(a)
    }
    for (const [, list] of map) list.sort((a, b) => String(a.time).localeCompare(String(b.time)))
    return map
  }, [appointments])
  const monthCells = useMemo(() => monthGrid(monthAnchor), [monthAnchor])
  const dayAgenda = useMemo(() => appointmentsByDate.get(selectedDate) || [], [appointmentsByDate, selectedDate])
  const monthLabel = monthAnchor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
  const plannedCount = appointments.length

  const showSkeletons = salesLoading && salesInScope.length === 0

  // ---- actions -------------------------------------------------------------
  const openScheduler = (sale, type) => {
    const existing = planningBySale.get(`${sale.id}:${type}`)
    setScheduler({
      open: true, sale, type,
      date: existing?.date || todayIso(),
      time: existing?.time || SLOT_OPTIONS[0],
      notes: existing?.notes || '',
    })
  }
  const closeScheduler = () => setScheduler((p) => ({ ...p, open: false, sale: null, notes: '' }))

  const confirmSchedule = async () => {
    if (!scheduler.sale || schedulingSaving) return
    const sale = scheduler.sale
    const atIso = new Date(`${scheduler.date}T${scheduler.time}:00`).toISOString()
    const tag = typeLabel(scheduler.type)
    const addition = scheduler.notes.trim()
      ? `[${scheduler.date} ${scheduler.time} ${tag}] ${scheduler.notes.trim()}`
      : ''
    const prevNotes = String(sale.coordinationNotes || '').trim()
    const coordinationNotes = addition ? (prevNotes ? `${prevNotes}\n${addition}` : addition) : prevNotes
    const patch = { coordinationNotes }
    if (scheduler.type === 'finance') {
      patch.coordinationFinanceAt = atIso
      if (canonicalSaleStatus(sale.status) === 'pending_coordination') {
        patch.status = 'pending_finance'
        patch.pipelineStatus = 'pending_finance'
      }
    } else {
      patch.coordinationJuridiqueAt = atIso
    }
    setSchedulingSaving(true)
    const withTimeout = (p, ms, label) => Promise.race([
      p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
    ])
    try {
      await withTimeout(salesUpdate(sale.id, patch), 15_000, 'salesUpdate')
      withTimeout(
        appendAuditLog({
          action: 'coordination_appointment_set', entity: 'sale', entityId: String(sale.id),
          actorUserId: adminUser?.id || null, actorEmail: adminUser?.email || '',
          details: `${tag} ${scheduler.date} ${scheduler.time}`,
        }), 8_000, 'appendAuditLog',
      ).catch((e) => console.warn('[Coord] audit:', e?.message || e))
      closeScheduler()
    } catch (e) {
      console.error('[Coord] confirmSchedule failed:', e?.message || e)
    } finally {
      setSchedulingSaving(false)
    }
  }

  // Reservation expiry auto-queueing (unchanged)
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
              saleId: s.id, eventType: 'reservation_expired_queue',
              fromStatus: st, toStatus: 'expired_pending_review',
              actorUserId: null, details: 'Délai dépassé — file revue manuelle',
            })
          } catch (e) { console.error(e) }
        } catch (e) { console.error(e) }
      }
    })()
    return () => { cancelled = true }
  }, [sales, salesUpdate])

  const extendReservation = async (sale, hours = 24) => {
    if (reservationBusy) return
    const key = `extend:${sale.id}`
    await runSafeAction({
      setBusy: (v) => setReservationBusy(v ? key : null),
      onError: (msg) => { setReservationNotice(msg); window.setTimeout(() => setReservationNotice(''), 6000) },
      label: 'Prolonger la réservation',
    }, async () => {
      const prevSt = String(sale.reservationStatus || '')
      const next = new Date(Date.now() + hours * 3600000).toISOString()
      await salesUpdate(sale.id, { reservationExpiresAt: next, reservationStatus: 'extended' })
      await appendAuditLog({
        action: 'reservation_extended', entity: 'sale', entityId: String(sale.id),
        actorUserId: adminUser?.id || null, actorEmail: adminUser?.email || '', details: `+${hours}h`,
      })
      try {
        await db.insertSaleReservationEvent({
          saleId: sale.id, eventType: 'reservation_extended',
          fromStatus: prevSt, toStatus: 'extended',
          actorUserId: adminUser?.id || null, details: `Prolongation ${hours}h`,
          metadata: { newExpiresAt: next },
        })
      } catch (e) { console.warn('[coord] insertSaleReservationEvent failed:', e?.message || e) }
    })
  }

  const releaseExpiredReservation = async (sale) => {
    if (reservationBusy) return
    const key = `release:${sale.id}`
    await runSafeAction({
      setBusy: (v) => setReservationBusy(v ? key : null),
      onError: (msg) => { setReservationNotice(msg); window.setTimeout(() => setReservationNotice(''), 6000) },
      label: 'Libérer la parcelle',
    }, async () => {
      const parcelDbIds = parcelDbIdsFromSale(sale)
      const prevSt = String(sale.reservationStatus || '')
      await salesUpdate(sale.id, {
        reservationStatus: 'released',
        reservationReleasedAt: new Date().toISOString(),
        reservationReleaseReason: 'manual_release_after_expiry',
        status: 'cancelled', pipelineStatus: 'cancelled',
      })
      for (const pid of parcelDbIds) {
        try { await updateParcelStatus(pid, 'available') } catch (e) {
          console.warn('[coord] updateParcelStatus failed:', e?.message || e, { pid })
        }
      }
      try {
        await appendAuditLog({
          action: 'reservation_released', entity: 'sale', entityId: String(sale.id),
          actorUserId: adminUser?.id || null, actorEmail: adminUser?.email || '',
          details: 'File expirée — libération parcelle(s)',
        })
      } catch (e) { console.warn('[coord] appendAuditLog failed:', e?.message || e) }
      try {
        await db.insertSaleReservationEvent({
          saleId: sale.id, eventType: 'reservation_released',
          fromStatus: prevSt, toStatus: 'released',
          actorUserId: adminUser?.id || null,
          details: 'Libération manuelle après expiration',
        })
      } catch (e) { console.warn('[coord] insertSaleReservationEvent failed:', e?.message || e) }
    })
  }

  // Coordinator cancel: marks the sale cancelled but leaves the row + its
  // buyer snapshot, commission events, and audit trail in place so the user
  // can still look it up later. Reason is appended to coordination_notes so
  // it surfaces in the detail drawer.
  const cancelSaleFromCoordination = async () => {
    if (!cancelTarget || cancelBusy) return
    const reason = cancelReason.trim()
    if (!reason) {
      setReservationNotice('Indiquez un motif d\u2019annulation.')
      window.setTimeout(() => setReservationNotice(''), 5000)
      return
    }
    setCancelBusy(true)
    try {
      const sale = cancelTarget
      const parcelDbIds = parcelDbIdsFromSale(sale)
      const prevSt = String(sale.status || '')
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      const notePrefix = `[Annulée ${stamp}] ${reason}`
      const nextNotes = sale.coordinationNotes
        ? `${notePrefix}\n---\n${sale.coordinationNotes}`
        : notePrefix
      await salesUpdate(sale.id, {
        status: 'cancelled',
        pipelineStatus: 'cancelled',
        reservationStatus: 'released',
        reservationReleasedAt: new Date().toISOString(),
        reservationReleaseReason: 'coordination_manual_cancel',
        coordinationNotes: nextNotes,
      })
      for (const pid of parcelDbIds) {
        try { await updateParcelStatus(pid, 'available') } catch (e) {
          console.warn('[coord] cancel parcel release failed:', e?.message || e, { pid })
        }
      }
      try {
        await appendAuditLog({
          action: 'sale_cancelled',
          entity: 'sale',
          entityId: String(sale.id),
          actorUserId: adminUser?.id || null,
          actorEmail: adminUser?.email || '',
          details: `Annulation coordination — ${reason}`,
          metadata: { previousStatus: prevSt, parcelDbIds },
          severity: 'warn',
        })
      } catch (e) { console.warn('[coord] appendAuditLog failed:', e?.message || e) }
      try {
        await db.insertSaleReservationEvent({
          saleId: sale.id,
          eventType: 'reservation_released',
          fromStatus: prevSt,
          toStatus: 'cancelled',
          actorUserId: adminUser?.id || null,
          details: `Annulation coordination: ${reason}`,
        })
      } catch (e) { console.warn('[coord] insertSaleReservationEvent failed:', e?.message || e) }
      setCancelTarget(null)
      setCancelReason('')
      setDetailSale(null)
    } catch (e) {
      setReservationNotice(`Annulation impossible : ${e?.message || e}`)
      window.setTimeout(() => setReservationNotice(''), 6000)
    } finally {
      setCancelBusy(false)
    }
  }

  // ---- render --------------------------------------------------------------
  const dateError = scheduler.open && scheduler.date && scheduler.time
    && new Date(`${scheduler.date}T${scheduler.time}:00`).getTime() < Date.now()
    ? 'La date et l\u2019heure doivent être dans le futur.' : ''

  const statusFilters = [
    ['all',       'Tous',          statusCounts.total],
    ['unplanned', 'À planifier',   statusCounts.unplanned],
    ['partial',   'Partiellement', statusCounts.partial],
    ['planned',   'Planifiés',     statusCounts.planned],
    ['cancelled', 'Annulées',      cancelledSales.length],
  ]

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero">
        <div className="sp-hero__avatar" aria-hidden>
          <span style={{ fontSize: 28 }}>🧭</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Coordination</h1>
          <p className="sp-hero__role">Planifier les rendez-vous Finance et Juridique</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : salesInScope.length}
          </span>
          <span className="sp-hero__kpi-label">dossier{salesInScope.length > 1 ? 's' : ''}</span>
        </div>
      </header>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{showSkeletons ? <span className="sk-num" /> : salesInScope.length}</strong> total
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : plannedCount}</strong> RDV planifié{plannedCount > 1 ? 's' : ''}
          {reservationExpiryQueue.length > 0 && (
            <>
              <span className="sp-cat-stat-dot" />
              <button
                type="button"
                className="cv-expiry-link"
                onClick={() => setExpiryOpen(true)}
                title="Réservations expirées — cliquez pour gérer"
              >
                ⚠ <strong>{reservationExpiryQueue.length}</strong> expirée{reservationExpiryQueue.length > 1 ? 's' : ''}
              </button>
            </>
          )}
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Rechercher client, projet, code ou parcelle…"
            aria-label="Rechercher un dossier"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="cv-chips" role="tablist" aria-label="Vue">
          <button
            type="button" role="tab" aria-selected={view === 'sales'}
            className={`cv-chip${view === 'sales' ? ' cv-chip--active' : ''}`}
            onClick={() => setView('sales')}
          >
            Dossiers
            <span className="cv-chip__count">{salesInScope.length}</span>
          </button>
          <button
            type="button" role="tab" aria-selected={view === 'calendar'}
            className={`cv-chip${view === 'calendar' ? ' cv-chip--active' : ''}`}
            onClick={() => setView('calendar')}
          >
            Calendrier
            <span className="cv-chip__count">{plannedCount}</span>
          </button>
        </div>
        {view === 'sales' && (
          <div className="cv-chips" role="tablist" aria-label="Filtrer par statut">
            {statusFilters.map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={statusFilter === key}
                className={`cv-chip${statusFilter === key ? ' cv-chip--active' : ''}`}
                onClick={() => setStatusFilter(key)}
              >
                {label}
                <span className="cv-chip__count">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {view === 'sales' && (
        <>
          <div className="sp-cards">
            <RenderDataGate
              loading={showSkeletons}
              error={null}
              data={pagedSales}
              isEmpty={() => salesForCoordination.length === 0}
              skeleton={
                <>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={`sk-${i}`} className="sp-card sp-card--skeleton" aria-hidden>
                      <div className="sp-card__head">
                        <div className="sp-card__user">
                          <span className="sp-card__initials sk-box" />
                          <div style={{ flex: 1 }}>
                            <p className="sk-line sk-line--title" />
                            <p className="sk-line sk-line--sub" />
                          </div>
                        </div>
                        <span className="sk-line sk-line--badge" />
                      </div>
                      <div className="sp-card__body">
                        <span className="sk-line sk-line--price" />
                        <span className="sk-line sk-line--info" />
                      </div>
                    </div>
                  ))}
                </>
              }
              empty={
                <div className="sp-empty">
                  <span className="sp-empty__emoji" aria-hidden>📭</span>
                  <div className="sp-empty__title">
                    {query || statusFilter !== 'all' ? 'Aucun résultat.' : 'Aucun dossier à coordonner.'}
                  </div>
                  {!query && statusFilter === 'all' && (
                    <p className="cv-empty__text">
                      Dès qu’une vente passe en « En attente coordination », elle apparaîtra ici.
                    </p>
                  )}
                </div>
              }
            >
              {(rows) => rows.map((sale) => {
                const client = clients.find((c) => String(c.id) === String(sale.clientId))
                const sellerClient = sale.sellerClientId ? clients.find((c) => String(c.id) === String(sale.sellerClientId)) : null
                const sellerAgent = sale.agentId ? adminUsers.find((u) => String(u.id) === String(sale.agentId)) : null
                const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
                const financePlan = planningBySale.get(`${sale.id}:finance`)
                const juridiquePlan = planningBySale.get(`${sale.id}:juridique`)
                const hasFin = Boolean(financePlan)
                const hasJur = Boolean(juridiquePlan)
                const tone = toneForSale(sale, hasFin, hasJur)
                const steps = (hasFin ? 1 : 0) + (hasJur ? 1 : 0)
                const pct = (steps / 2) * 100
                const statusMeta = getSaleStatusMeta(sale.status)
                const badgeLabel = hasFin && hasJur
                  ? 'RDV planifiés'
                  : hasFin || hasJur
                    ? (hasFin ? 'Juridique manquant' : 'Finance manquant')
                    : (statusMeta.label || 'À planifier')
                return (
                  <button
                    key={sale.id}
                    type="button"
                    className={`sp-card sp-card--${tone} cv-card`}
                    onClick={() => setDetailSale({ sale, client, sellerClient, sellerAgent })}
                    aria-label={`Ouvrir le dossier de ${sale.clientName || 'client'}`}
                  >
                    <div className="sp-card__head">
                      <div className="sp-card__user">
                        <span className="sp-card__initials">{initials(sale.clientName)}</span>
                        <div style={{ minWidth: 0 }}>
                          <p className="sp-card__name">{sale.clientName || 'Client'}</p>
                          <p className="sp-card__sub">
                            {sale.projectTitle || 'Projet'} · Parcelle {plotLabel}
                          </p>
                        </div>
                      </div>
                      <span className={`sp-badge sp-badge--${tone}`}>{badgeLabel}</span>
                    </div>

                    <div className="sp-card__body">
                      <div className="sp-card__price">
                        <span className="sp-card__amount">{(Number(sale.agreedPrice) || 0).toLocaleString('fr-FR')}</span>
                        <span className="sp-card__currency">TND</span>
                      </div>
                      <div className="sp-card__info">
                        <span>{steps}/2 RDV</span>
                      </div>
                    </div>

                    <div className="cv-plan">
                      <div className={`cv-plan__row${hasFin ? ' cv-plan__row--ok' : ''}`}>
                        <span className="cv-plan__dot" aria-hidden />
                        <span className="cv-plan__lbl">Finance</span>
                        <span className="cv-plan__val">
                          {financePlan ? `${fmtDate(financePlan.date)} · ${financePlan.time}` : 'À planifier'}
                        </span>
                      </div>
                      <div className={`cv-plan__row${hasJur ? ' cv-plan__row--ok' : ''}`}>
                        <span className="cv-plan__dot" aria-hidden />
                        <span className="cv-plan__lbl">Juridique</span>
                        <span className="cv-plan__val">
                          {juridiquePlan ? `${fmtDate(juridiquePlan.date)} · ${juridiquePlan.time}` : 'À planifier'}
                        </span>
                      </div>
                    </div>

                    <div className="nd-progress" aria-hidden>
                      <span className="nd-progress__fill" style={{ width: `${pct}%` }} />
                    </div>
                  </button>
                )
              })}
            </RenderDataGate>
          </div>

          {!showSkeletons && salesForCoordination.length > PER_PAGE && (
            <div className="sp-pager" role="navigation" aria-label="Pagination">
              <button
                type="button" className="sp-pager__btn sp-pager__btn--nav"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Page précédente"
              >‹</button>
              {getPagerPages(page, pageCount).map((p, i) =>
                p === '…' ? (
                  <span key={`dots-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
                ) : (
                  <button
                    key={p} type="button"
                    className={`sp-pager__btn${p === page ? ' sp-pager__btn--active' : ''}`}
                    onClick={() => setPage(p)}
                    aria-current={p === page ? 'page' : undefined}
                  >{p}</button>
                ),
              )}
              <button
                type="button" className="sp-pager__btn sp-pager__btn--nav"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                aria-label="Page suivante"
              >›</button>
              <span className="sp-pager__info">
                {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, salesForCoordination.length)} / {salesForCoordination.length}
              </span>
            </div>
          )}
        </>
      )}

      {view === 'calendar' && (
        <section className="cv-cal">
          {appointments.length === 0 ? (
            <div className="sp-empty">
              <span className="sp-empty__emoji" aria-hidden>🗓️</span>
              <div className="sp-empty__title">Aucun rendez-vous planifié</div>
              <p className="cv-empty__text">
                Commencez par planifier un rendez-vous depuis l’onglet « Dossiers ».
              </p>
            </div>
          ) : (
            <>
              <div className="cv-cal__nav">
                <button type="button" className="cv-cal__nav-btn" onClick={() => setMonthAnchor((d) => addMonths(d, -1))}>‹</button>
                <span className="cv-cal__month">{monthLabel}</span>
                <button type="button" className="cv-cal__nav-btn" onClick={() => setMonthAnchor((d) => addMonths(d, 1))}>›</button>
              </div>
              <div className="cv-cal__week">
                {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
                  <span key={d} className="cv-cal__weekday">{d}</span>
                ))}
              </div>
              <div className="cv-cal__grid">
                {monthCells.map((cell) => {
                  const iso = toIsoDate(cell.date)
                  const count = (appointmentsByDate.get(iso) || []).length
                  const isSel = iso === selectedDate
                  return (
                    <button
                      key={`${iso}-${cell.inMonth ? 'in' : 'out'}`}
                      type="button"
                      className={`cv-cal__day${cell.inMonth ? '' : ' cv-cal__day--muted'}${isSel ? ' cv-cal__day--sel' : ''}`}
                      onClick={() => setSelectedDate(iso)}
                    >
                      <span className="cv-cal__day-num">{cell.date.getDate()}</span>
                      {count > 0 ? <span className="cv-cal__day-dot">{count}</span> : null}
                    </button>
                  )
                })}
              </div>
              <div className="cv-cal__agenda">
                <div className="cv-cal__agenda-head">{fmtDate(selectedDate)}</div>
                {dayAgenda.length === 0 ? (
                  <div className="cv-cal__agenda-empty">Aucun rendez-vous ce jour.</div>
                ) : (
                  dayAgenda.map((apt) => (
                    <button
                      key={apt.id} type="button"
                      className="cv-cal__item"
                      onClick={() => setSelectedAppointment(apt)}
                    >
                      <span className="cv-cal__item-time">{apt.time}</span>
                      <span className="cv-cal__item-body">
                        <span className={`cv-cal__item-kind cv-cal__item-kind--${apt.type}`}>{typeLabel(apt.type)}</span>
                        <span className="cv-cal__item-name">{apt.clientName}</span>
                        <span className="cv-cal__item-sub">{apt.projectTitle} · {apt.plotLabel}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </section>
      )}

      {/* ── Detail modal (opens on card click) ────────────────────────── */}
      <AdminModal
        open={Boolean(detailSale)}
        onClose={() => setDetailSale(null)}
        title=""
      >
        {detailSale && (() => {
          const s = detailSale.sale
          const c = detailSale.client
          const sc = detailSale.sellerClient
          const sa = detailSale.sellerAgent
          const plots = normalizePlotIds(s).map((id) => `#${id}`).join(', ') || '—'
          const stMeta = getSaleStatusMeta(s.status)
          const financePlan = planningBySale.get(`${s.id}:finance`)
          const juridiquePlan = planningBySale.get(`${s.id}:juridique`)
          return (
            <div className="sp-detail">
              <div className="sp-detail__banner">
                <div className="sp-detail__banner-top">
                  <span className={`sp-badge sp-badge--${stMeta.badge || 'blue'}`}>{stMeta.label}</span>
                  <span className="sp-detail__date">{fmtDate(s.createdAt)}</span>
                </div>
                <div className="sp-detail__price">
                  <span className="sp-detail__price-num">{(Number(s.agreedPrice) || 0).toLocaleString('fr-FR')}</span>
                  <span className="sp-detail__price-cur">TND</span>
                </div>
                <p className="sp-detail__banner-sub">
                  {s.clientName || 'Client'} · Réf. {s.code || s.id}
                </p>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Vendeur</div>
                <div className="sp-detail__row"><span>Nom</span><strong>{sc?.name || sa?.name || sa?.email || '—'}</strong></div>
                <div className="sp-detail__row"><span>Rôle</span><strong>{sa?.role ? `Staff — ${sa.role}` : (sc ? 'Vendeur délégué (client)' : '—')}</strong></div>
                {(sc?.phone || sa?.phone) && (
                  <div className="sp-detail__row"><span>Téléphone</span><strong style={{ direction: 'ltr' }}>{sc?.phone || sa?.phone}</strong></div>
                )}
                {(sc?.email || sa?.email) && (
                  <div className="sp-detail__row"><span>Email</span><strong style={{ wordBreak: 'break-all' }}>{sc?.email || sa?.email}</strong></div>
                )}
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Acheteur</div>
                <div className="sp-detail__row"><span>Nom</span><strong>{c?.name || s.clientName || '—'}</strong></div>
                <div className="sp-detail__row"><span>Téléphone</span><strong style={{ direction: 'ltr' }}>{c?.phone || s.clientPhone || s.buyerPhoneNormalized || '—'}</strong></div>
                {(c?.cin || s.clientCin) && <div className="sp-detail__row"><span>CIN</span><strong style={{ direction: 'ltr' }}>{c?.cin || s.clientCin}</strong></div>}
                {(c?.email || s.clientEmail) && <div className="sp-detail__row"><span>Email</span><strong style={{ wordBreak: 'break-all' }}>{c?.email || s.clientEmail}</strong></div>}
                {c?.city && <div className="sp-detail__row"><span>Ville</span><strong>{c.city}</strong></div>}
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Projet & parcelles</div>
                <div className="sp-detail__row"><span>Projet</span><strong>{s.projectTitle || s.projectId || '—'}</strong></div>
                <div className="sp-detail__row"><span>Parcelle(s)</span><strong>{plots}</strong></div>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Montants</div>
                <div className="sp-detail__row"><span>Prix convenu</span><strong>{fmtMoney(s.agreedPrice)}</strong></div>
                <div className="sp-detail__row"><span>Acompte</span><strong>{fmtMoney(s.deposit)}</strong></div>
                <div className="sp-detail__row">
                  <span>Mode</span>
                  <strong>{s.paymentType === 'installments' ? `Échelonné — ${s.offerName || ''}` : 'Comptant'}</strong>
                </div>
                {s.paymentType === 'installments' && (
                  <div className="sp-detail__row">
                    <span>Durée</span>
                    <strong>{s.offerDuration || 0} mois · {s.offerDownPayment || 0}% apport</strong>
                  </div>
                )}
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Planification</div>
                <div className="sp-detail__row">
                  <span>Finance</span>
                  <strong style={{ color: financePlan ? '#059669' : '#94a3b8' }}>
                    {financePlan
                      ? `${fmtDate(financePlan.date)} · ${financePlan.time}`
                      : 'À planifier'}
                  </strong>
                </div>
                <div className="sp-detail__row">
                  <span>Juridique</span>
                  <strong style={{ color: juridiquePlan ? '#059669' : '#94a3b8' }}>
                    {juridiquePlan
                      ? `${fmtDate(juridiquePlan.date)} · ${juridiquePlan.time}`
                      : 'À planifier'}
                  </strong>
                </div>
                {s.coordinationNotes && (
                  <div className="cv-notes">{s.coordinationNotes}</div>
                )}
              </div>

              <div className="sp-detail__actions">
                <button
                  type="button"
                  className="sp-detail__btn"
                  onClick={() => setDetailSale(null)}
                >
                  Fermer
                </button>
                <button
                  type="button"
                  className="sp-detail__btn sp-detail__btn--edit"
                  onClick={() => { setDetailSale(null); openScheduler(s, 'finance') }}
                >
                  {financePlan ? 'Modifier Finance' : 'Planifier Finance'}
                </button>
                <button
                  type="button"
                  className="sp-detail__btn sp-detail__btn--edit"
                  onClick={() => { setDetailSale(null); openScheduler(s, 'juridique') }}
                >
                  {juridiquePlan ? 'Modifier Juridique' : 'Planifier Juridique'}
                </button>
                {!['cancelled', 'rejected', 'completed'].includes(String(s.status)) && (
                  <button
                    type="button"
                    className="sp-detail__btn"
                    style={{ color: '#b91c1c', borderColor: '#fecaca' }}
                    onClick={() => { setCancelTarget(s); setCancelReason('') }}
                    title="Annule la vente ; les données restent pour le suivi."
                  >
                    Annuler la vente
                  </button>
                )}
              </div>
            </div>
          )
        })()}
      </AdminModal>

      {/* ── Expired reservations modal ──────────────────────────────── */}
      <AdminModal
        open={expiryOpen}
        onClose={() => setExpiryOpen(false)}
        title={`Réservations expirées (${reservationExpiryQueue.length})`}
      >
        <div className="cv-expiry">
          <p className="cv-expiry__hint">
            Ces dossiers n’ont pas été validés à temps. Prolongez la réservation ou libérez la parcelle.
          </p>
          {reservationNotice && (
            <div
              role="alert"
              style={{
                margin: '8px 0', padding: '10px 12px', borderRadius: 8,
                background: '#fef3c7', color: '#92400e', fontSize: 13,
                border: '1px solid #fde68a',
              }}
            >
              {reservationNotice}
            </div>
          )}
          {reservationExpiryQueue.length === 0 ? (
            <div className="cv-expiry__empty">Aucune réservation expirée.</div>
          ) : (
            <ul className="cv-expiry__list">
              {reservationExpiryQueue.map((sale) => {
                const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
                return (
                  <li key={sale.id} className="cv-expiry__item">
                    <div className="cv-expiry__item-head">
                      <span className="sp-card__initials">{initials(sale.clientName)}</span>
                      <div>
                        <div className="cv-expiry__item-name">{sale.clientName || 'Client'}</div>
                        <div className="cv-expiry__item-sub">{sale.projectTitle || 'Projet'} · Parcelle {plotLabel}</div>
                      </div>
                    </div>
                    <div className="cv-expiry__item-actions">
                      <button
                        type="button"
                        className="sp-detail__btn"
                        onClick={() => extendReservation(sale, 24)}
                        disabled={Boolean(reservationBusy)}
                      >
                        {reservationBusy === `extend:${sale.id}` ? 'Prolongation…' : 'Prolonger 24 h'}
                      </button>
                      <button
                        type="button"
                        className="sp-detail__btn sp-detail__btn--danger"
                        onClick={() => releaseExpiredReservation(sale)}
                        disabled={Boolean(reservationBusy)}
                      >
                        {reservationBusy === `release:${sale.id}` ? 'Libération…' : 'Libérer la parcelle'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </AdminModal>

      {/* ── Scheduler modal ─────────────────────────────────────────── */}
      <AdminModal
        open={scheduler.open && Boolean(scheduler.sale)}
        onClose={closeScheduler}
        title={`Planifier un rendez-vous ${typeLabel(scheduler.type)}`}
      >
        {scheduler.sale && (
          <div className="sp-detail cv-sched">
            <div className="sp-detail__banner">
              <div className="sp-detail__banner-top">
                <span className="sp-badge sp-badge--blue">{typeLabel(scheduler.type)}</span>
                <span className="sp-detail__date">Dossier</span>
              </div>
              <div className="sp-detail__price">
                <span className="sp-detail__price-num">{(Number(scheduler.sale.agreedPrice) || 0).toLocaleString('fr-FR')}</span>
                <span className="sp-detail__price-cur">TND</span>
              </div>
              <p className="sp-detail__banner-sub">
                {scheduler.sale.clientName || 'Client'} · {scheduler.sale.projectTitle || 'Projet'}
              </p>
            </div>

            <div className="sp-detail__section">
              <SaleSnapshotTracePanel sale={scheduler.sale} />
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Type</div>
              <div className="cv-chips" role="radiogroup">
                <button
                  type="button" role="radio" aria-checked={scheduler.type === 'finance'}
                  className={`cv-chip${scheduler.type === 'finance' ? ' cv-chip--active' : ''}`}
                  onClick={() => setScheduler((p) => ({ ...p, type: 'finance' }))}
                >Finance</button>
                <button
                  type="button" role="radio" aria-checked={scheduler.type === 'juridique'}
                  className={`cv-chip${scheduler.type === 'juridique' ? ' cv-chip--active' : ''}`}
                  onClick={() => setScheduler((p) => ({ ...p, type: 'juridique' }))}
                >Juridique</button>
              </div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Date</div>
              <input
                id="cv-date" type="date"
                className={`cv-input${dateError ? ' cv-input--err' : ''}`}
                value={scheduler.date} min={todayIso()}
                aria-invalid={Boolean(dateError)}
                onChange={(e) => setScheduler((p) => ({ ...p, date: e.target.value }))}
              />
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">
                Heure <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: '#94a3b8' }}>
                  — à la minute près
                </span>
              </div>
              <input
                id="cv-time"
                type="time"
                className="cv-input cv-input--time"
                step="300"
                value={scheduler.time}
                onChange={(e) => setScheduler((p) => ({ ...p, time: e.target.value || '09:00' }))}
              />
              <div className="cv-chips" role="radiogroup" aria-label="Créneaux rapides" style={{ marginTop: 6 }}>
                {SLOT_OPTIONS.map((slot) => (
                  <button
                    key={slot} type="button" role="radio"
                    aria-checked={scheduler.time === slot}
                    className={`cv-chip${scheduler.time === slot ? ' cv-chip--active' : ''}`}
                    onClick={() => setScheduler((p) => ({ ...p, time: slot }))}
                  >{slot}</button>
                ))}
              </div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Notes</div>
              <textarea
                id="cv-notes" rows={3}
                className="cv-input"
                value={scheduler.notes}
                placeholder="Pièces à apporter, contexte…"
                onChange={(e) => setScheduler((p) => ({ ...p, notes: e.target.value }))}
              />
            </div>

            {dateError ? <div className="cv-err">⚠ {dateError}</div> : null}

            <div className="sp-detail__actions">
              <button type="button" className="sp-detail__btn" onClick={closeScheduler}>Annuler</button>
              <button
                type="button" className="sp-detail__btn sp-detail__btn--edit"
                disabled={schedulingSaving || Boolean(dateError)}
                onClick={() => void confirmSchedule()}
              >
                {schedulingSaving ? 'Enregistrement…' : 'Confirmer'}
              </button>
            </div>
          </div>
        )}
      </AdminModal>

      {/* ── Appointment detail modal (from calendar) ────────────────── */}
      <AdminModal
        open={Boolean(selectedAppointment)}
        onClose={() => setSelectedAppointment(null)}
        title="Détail du rendez-vous"
      >
        {selectedAppointment && (
          <div className="sp-detail">
            <div className="sp-detail__banner">
              <div className="sp-detail__banner-top">
                <span className={`sp-badge sp-badge--${selectedAppointment.type === 'finance' ? 'blue' : 'purple'}`}>
                  {typeLabel(selectedAppointment.type)}
                </span>
                <span className="sp-detail__date">{fmtDate(selectedAppointment.date)} · {selectedAppointment.time}</span>
              </div>
              <div className="sp-detail__price">
                <span className="sp-detail__price-num">{(Number(selectedAppointment.amount) || 0).toLocaleString('fr-FR')}</span>
                <span className="sp-detail__price-cur">TND</span>
              </div>
              <p className="sp-detail__banner-sub">
                {selectedAppointment.clientName}
              </p>
            </div>

            {selectedAppointmentSale && (
              <div className="sp-detail__section">
                <SaleSnapshotTracePanel sale={selectedAppointmentSale} />
              </div>
            )}

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Rendez-vous</div>
              <div className="sp-detail__row"><span>Projet</span><strong>{selectedAppointment.projectTitle}</strong></div>
              <div className="sp-detail__row"><span>Parcelles</span><strong>{selectedAppointment.plotLabel}</strong></div>
              <div className="sp-detail__row"><span>Agent</span><strong>{selectedAppointment.agentName}</strong></div>
              {selectedAppointment.coordinationNotes ? (
                <div className="cv-notes">{selectedAppointment.coordinationNotes}</div>
              ) : null}
            </div>
          </div>
        )}
      </AdminModal>

      {/* ── Cancel sale confirmation modal ──────────────────────────── */}
      <AdminModal
        open={Boolean(cancelTarget)}
        onClose={() => { if (!cancelBusy) { setCancelTarget(null); setCancelReason('') } }}
        title="Annuler la vente"
        width={440}
      >
        {cancelTarget && (
          <div className="sp-detail">
            <p className="adm-confirm-text" style={{ marginBottom: 10 }}>
              <strong>{cancelTarget.clientName || 'Client'}</strong> · {cancelTarget.projectTitle || 'Projet'}
            </p>
            <div style={{
              padding: 10, borderRadius: 8, background: '#fef3c7', color: '#92400e',
              fontSize: 12.5, lineHeight: 1.5, marginBottom: 12, border: '1px solid #fde68a',
            }}>
              La vente est conservée dans la base avec le statut « annulée ».
              L'historique (acheteur, commissions, audit) reste consultable.
              Les parcelles redeviennent disponibles.
            </div>
            <label className="adm-label" style={{ display: 'block', marginBottom: 6 }}>
              Motif d&apos;annulation *
            </label>
            <textarea
              className="adm-input"
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Ex : acheteur s'est rétracté, parcelle finalement indisponible…"
              style={{ width: '100%', resize: 'vertical' }}
              autoFocus
              disabled={cancelBusy}
            />
            <div className="sp-detail__actions" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="sp-detail__btn"
                onClick={() => { setCancelTarget(null); setCancelReason('') }}
                disabled={cancelBusy}
              >
                Conserver
              </button>
              <button
                type="button"
                className="sp-detail__btn"
                style={{ background: '#b91c1c', color: '#fff', borderColor: '#b91c1c' }}
                onClick={cancelSaleFromCoordination}
                disabled={cancelBusy || !cancelReason.trim()}
              >
                {cancelBusy ? 'Annulation…' : 'Confirmer l\u2019annulation'}
              </button>
            </div>
          </div>
        )}
      </AdminModal>
    </div>
  )
}
