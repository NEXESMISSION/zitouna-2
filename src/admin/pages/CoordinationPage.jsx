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
import './sell-field.css'

const SLOT_OPTIONS = ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00']
const PER_PAGE = 10

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
        const hay = `${s.clientName || ''} ${s.projectTitle || ''} ${s.code || s.id || ''} ${normalizePlotIds(s).join(',')}`.toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  }, [sales, query])

  const planningBySale = useMemo(() => {
    const map = new Map()
    for (const a of appointments) map.set(`${a.saleId}:${a.type}`, a)
    return map
  }, [appointments])

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
  useEffect(() => { setPage(1) }, [query])
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

  // Reservation expiry auto-queueing (unchanged from v1)
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
    } catch (e) { console.error(e) }
  }

  const releaseExpiredReservation = async (sale) => {
    const parcelDbIds = parcelDbIdsFromSale(sale)
    const prevSt = String(sale.reservationStatus || '')
    await salesUpdate(sale.id, {
      reservationStatus: 'released',
      reservationReleasedAt: new Date().toISOString(),
      reservationReleaseReason: 'manual_release_after_expiry',
      status: 'cancelled', pipelineStatus: 'cancelled',
    })
    for (const pid of parcelDbIds) {
      try { await updateParcelStatus(pid, 'available') } catch { /* ignore */ }
    }
    await appendAuditLog({
      action: 'reservation_released', entity: 'sale', entityId: String(sale.id),
      actorUserId: adminUser?.id || null, actorEmail: adminUser?.email || '',
      details: 'File expirée — libération parcelle(s)',
    })
    try {
      await db.insertSaleReservationEvent({
        saleId: sale.id, eventType: 'reservation_released',
        fromStatus: prevSt, toStatus: 'released',
        actorUserId: adminUser?.id || null,
        details: 'Libération manuelle après expiration',
      })
    } catch (e) { console.error(e) }
  }

  // ---- render --------------------------------------------------------------
  const dateError = scheduler.open && scheduler.date && scheduler.time
    && new Date(`${scheduler.date}T${scheduler.time}:00`).getTime() < Date.now()
    ? 'La date et l’heure doivent être dans le futur.' : ''

  return (
    <div className="sell-field coord-v3" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      {/* ── Topbar: title + compact KPIs ─────────────────────────────── */}
      <header className="cv-topbar">
        <div className="cv-topbar__title">
          <h1 className="cv-topbar__h1">Coordination</h1>
          <p className="cv-topbar__sub">Planifier les rendez-vous Finance et Juridique.</p>
        </div>
        <div className="cv-topbar__kpis">
          <span className="cv-kpi-pill" title="Dossiers en attente de rendez-vous">
            <strong>{salesForCoordination.length}</strong>
            <span>à planifier</span>
          </span>
          <span className="cv-kpi-pill cv-kpi-pill--good" title="Rendez-vous planifiés">
            <strong>{plannedCount}</strong>
            <span>planifiés</span>
          </span>
          {reservationExpiryQueue.length > 0 ? (
            <button
              type="button"
              className="cv-kpi-pill cv-kpi-pill--warn"
              onClick={() => setExpiryOpen(true)}
              title="Réservations expirées — cliquez pour gérer"
            >
              ⚠ <strong>{reservationExpiryQueue.length}</strong>
              <span>expirée{reservationExpiryQueue.length > 1 ? 's' : ''}</span>
            </button>
          ) : null}
        </div>
      </header>

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <div className="cv-tabs" role="tablist">
        <button
          type="button" role="tab" aria-selected={view === 'sales'}
          className={`cv-tab${view === 'sales' ? ' cv-tab--on' : ''}`}
          onClick={() => setView('sales')}
        >
          Dossiers
          <span className="cv-tab__count">{salesForCoordination.length}</span>
        </button>
        <button
          type="button" role="tab" aria-selected={view === 'calendar'}
          className={`cv-tab${view === 'calendar' ? ' cv-tab--on' : ''}`}
          onClick={() => setView('calendar')}
        >
          Calendrier
          <span className="cv-tab__count">{plannedCount}</span>
        </button>
      </div>

      {view === 'sales' && (
        <>
          <div className="cv-search">
            <input
              type="search" value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher un client, projet, code ou parcelle…"
              aria-label="Rechercher un dossier"
            />
          </div>

          <section className="sp-cards cv-queue">
            {salesLoading && salesForCoordination.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => (
                <article key={`sk-${i}`} className="sp-card sp-card--skeleton" aria-hidden>
                  <div className="sp-card__head">
                    <div className="sp-card__user">
                      <span className="sp-sk-box" />
                      <div>
                        <span className="sp-sk-line sp-sk-line--title" />
                        <span className="sp-sk-line sp-sk-line--sub" />
                      </div>
                    </div>
                    <span className="sp-sk-line sp-sk-line--badge" />
                  </div>
                </article>
              ))
            ) : salesForCoordination.length === 0 ? (
              <div className="sp-empty">
                <span className="sp-empty__emoji" aria-hidden>📭</span>
                <div className="sp-empty__title">Aucun dossier à coordonner</div>
                <p style={{ margin: '4px 0 10px', fontSize: 12, color: '#64748b' }}>
                  Dès qu’une vente passe en « En attente coordination », elle apparaîtra ici.
                </p>
                <button type="button" className="sp-cta-btn" onClick={() => setView('calendar')}>
                  <span className="sp-cta-btn__icon">📅</span>
                  <span className="sp-cta-btn__text">Ouvrir le calendrier</span>
                  <span className="sp-cta-btn__arrow">→</span>
                </button>
              </div>
            ) : (
              pagedSales.map((sale) => {
                const client = clients.find((c) => String(c.id) === String(sale.clientId))
                const sellerClient = sale.sellerClientId ? clients.find((c) => String(c.id) === String(sale.sellerClientId)) : null
                const sellerAgent = sale.agentId ? adminUsers.find((u) => String(u.id) === String(sale.agentId)) : null
                const statusMeta = getSaleStatusMeta(sale.status)
                const plotLabel = normalizePlotIds(sale).map((id) => `#${id}`).join(', ') || '—'
                const financePlan = planningBySale.get(`${sale.id}:finance`)
                const juridiquePlan = planningBySale.get(`${sale.id}:juridique`)
                return (
                  <article
                    key={sale.id}
                    className="sp-card cv-card"
                    role="button" tabIndex={0}
                    onClick={() => setDetailSale({ sale, client, sellerClient, sellerAgent })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setDetailSale({ sale, client, sellerClient, sellerAgent })
                      }
                    }}
                  >
                    <div className="sp-card__head">
                      <div className="sp-card__user">
                        <span className="sp-card__initials" aria-hidden>{initials(sale.clientName)}</span>
                        <div>
                          <p className="sp-card__name">{sale.clientName || 'Client'}</p>
                          <p className="sp-card__sub">{sale.projectTitle || 'Projet'} · Parcelle {plotLabel}</p>
                        </div>
                      </div>
                      <span className={`sp-badge sp-badge--${statusMeta.badge || 'gray'}`}>
                        {statusMeta.label}
                      </span>
                    </div>

                    <div className="cv-card__plan">
                      <div className={`cv-card__plan-row${financePlan ? ' cv-card__plan-row--ok' : ''}`}>
                        <span className="cv-card__plan-dot" aria-hidden />
                        <span className="cv-card__plan-lbl">Finance</span>
                        <span className="cv-card__plan-val">
                          {financePlan ? `${fmtDate(financePlan.date)} · ${financePlan.time}` : 'À planifier'}
                        </span>
                      </div>
                      <div className={`cv-card__plan-row${juridiquePlan ? ' cv-card__plan-row--ok' : ''}`}>
                        <span className="cv-card__plan-dot" aria-hidden />
                        <span className="cv-card__plan-lbl">Juridique</span>
                        <span className="cv-card__plan-val">
                          {juridiquePlan ? `${fmtDate(juridiquePlan.date)} · ${juridiquePlan.time}` : 'À planifier'}
                        </span>
                      </div>
                    </div>

                    <div className="cv-card__actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className={`cv-btn${financePlan ? ' cv-btn--ghost' : ' cv-btn--primary'}`}
                        onClick={(e) => { e.stopPropagation(); openScheduler(sale, 'finance') }}
                      >
                        {financePlan ? 'Modifier Finance' : 'Planifier Finance'}
                      </button>
                      <button
                        type="button"
                        className={`cv-btn${juridiquePlan ? ' cv-btn--ghost' : ' cv-btn--primary'}`}
                        onClick={(e) => { e.stopPropagation(); openScheduler(sale, 'juridique') }}
                      >
                        {juridiquePlan ? 'Modifier Juridique' : 'Planifier Juridique'}
                      </button>
                    </div>
                  </article>
                )
              })
            )}
          </section>

          {salesForCoordination.length > PER_PAGE && (
            <div className="sp-pager" role="navigation" aria-label="Pagination">
              <button
                type="button" className="sp-pager__btn"
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
                type="button" className="sp-pager__btn"
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
              <p style={{ margin: '4px 0 10px', fontSize: 12, color: '#64748b' }}>
                Commencez par planifier un rendez-vous depuis l’onglet « Dossiers ».
              </p>
              <button type="button" className="sp-cta-btn" onClick={() => setView('sales')}>
                <span className="sp-cta-btn__icon">📋</span>
                <span className="sp-cta-btn__text">Aller aux dossiers</span>
                <span className="sp-cta-btn__arrow">→</span>
              </button>
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
        title="Détails de la vente"
        width={560}
      >
        {detailSale && (() => {
          const s = detailSale.sale
          const c = detailSale.client
          const sc = detailSale.sellerClient
          const sa = detailSale.sellerAgent
          const plots = normalizePlotIds(s).map((id) => `#${id}`).join(', ') || '—'
          const stMeta = getSaleStatusMeta(s.status)
          return (
            <div className="cv-detail">
              <div className="cv-detail__head">
                <div>
                  <div className="cv-detail__name">{s.clientName || 'Client'}</div>
                  <div className="cv-detail__code">Code : <code>{s.code || s.id}</code></div>
                </div>
                <span className={`sp-badge sp-badge--${stMeta.badge || 'gray'}`}>{stMeta.label}</span>
              </div>

              <DetailBlock title="Vendeur">
                <Row k="Nom" v={sc?.name || sa?.name || sa?.email || '—'} />
                <Row k="Rôle" v={sa?.role ? `Staff — ${sa.role}` : (sc ? 'Vendeur délégué (client)' : '—')} />
                {(sc?.phone || sa?.phone) && <Row k="Téléphone" v={sc?.phone || sa?.phone} />}
                {(sc?.email || sa?.email) && <Row k="Email" v={sc?.email || sa?.email} />}
              </DetailBlock>

              <DetailBlock title="Acheteur">
                <Row k="Nom" v={c?.name || s.clientName || '—'} />
                <Row k="Téléphone" v={c?.phone || s.buyerPhoneNormalized || '—'} />
                {c?.cin && <Row k="CIN" v={c.cin} mono />}
                {c?.email && <Row k="Email" v={c.email} />}
                {c?.city && <Row k="Ville" v={c.city} />}
              </DetailBlock>

              <DetailBlock title="Projet & parcelles">
                <Row k="Projet" v={s.projectTitle || s.projectId || '—'} />
                <Row k="Parcelle(s)" v={plots} />
              </DetailBlock>

              <DetailBlock title="Montants">
                <Row k="Prix convenu" v={fmtMoney(s.agreedPrice)} />
                <Row k="Acompte" v={fmtMoney(s.deposit)} />
                <Row k="Mode" v={s.paymentType === 'installments' ? `Échelonné — ${s.offerName || ''}` : 'Comptant'} />
                {s.paymentType === 'installments' && (
                  <Row k="Durée" v={`${s.offerDuration || 0} mois · ${s.offerDownPayment || 0}% apport`} />
                )}
              </DetailBlock>

              <DetailBlock title="Planification">
                <Row k="Finance"
                  v={s.coordinationFinanceAt
                    ? `${fmtDate(s.coordinationFinanceAt)} ${new Date(s.coordinationFinanceAt).toTimeString().slice(0, 5)}`
                    : <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>À planifier</span>
                  } />
                <Row k="Juridique"
                  v={s.coordinationJuridiqueAt
                    ? `${fmtDate(s.coordinationJuridiqueAt)} ${new Date(s.coordinationJuridiqueAt).toTimeString().slice(0, 5)}`
                    : <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>À planifier</span>
                  } />
                {s.coordinationNotes && (
                  <div className="cv-detail__notes">{s.coordinationNotes}</div>
                )}
              </DetailBlock>

              <div className="cv-detail__footer">
                <button className="cv-btn cv-btn--ghost" onClick={() => setDetailSale(null)}>Fermer</button>
                <button className="cv-btn cv-btn--primary" onClick={() => { setDetailSale(null); openScheduler(s, 'finance') }}>Planifier Finance</button>
                <button className="cv-btn cv-btn--primary" onClick={() => { setDetailSale(null); openScheduler(s, 'juridique') }}>Planifier Juridique</button>
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
        width={500}
      >
        <div className="cv-expiry">
          <p className="cv-expiry__hint">
            Ces dossiers n’ont pas été validés à temps. Prolongez la réservation ou libérez la parcelle.
          </p>
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
                      <button className="cv-btn cv-btn--ghost" onClick={() => extendReservation(sale, 24)}>
                        Prolonger 24 h
                      </button>
                      <button className="cv-btn cv-btn--danger" onClick={() => releaseExpiredReservation(sale)}>
                        Libérer la parcelle
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
        width={480}
      >
        {scheduler.sale && (
          <div className="cv-sched">
            <div className="cv-sched__recap">
              <div className="cv-sched__recap-lbl">Dossier</div>
              <div className="cv-sched__recap-val">
                <strong>{scheduler.sale.clientName || 'Client'}</strong>
                <span className="cv-sched__recap-dim"> · {scheduler.sale.projectTitle || 'Projet'}</span>
              </div>
              <div className="cv-sched__recap-meta">{fmtMoney(scheduler.sale.agreedPrice)}</div>
            </div>

            <div className="cv-sched__trace"><SaleSnapshotTracePanel sale={scheduler.sale} /></div>

            <label className="cv-sched__label">Type</label>
            <div className="cv-sched__pills" role="radiogroup">
              <button
                type="button" role="radio" aria-checked={scheduler.type === 'finance'}
                className={`cv-pill${scheduler.type === 'finance' ? ' cv-pill--on' : ''}`}
                onClick={() => setScheduler((p) => ({ ...p, type: 'finance' }))}
              >Finance</button>
              <button
                type="button" role="radio" aria-checked={scheduler.type === 'juridique'}
                className={`cv-pill${scheduler.type === 'juridique' ? ' cv-pill--on' : ''}`}
                onClick={() => setScheduler((p) => ({ ...p, type: 'juridique' }))}
              >Juridique</button>
            </div>

            <label className="cv-sched__label" htmlFor="cv-date">Date</label>
            <input
              id="cv-date" type="date"
              className={`cv-sched__input${dateError ? ' cv-sched__input--err' : ''}`}
              value={scheduler.date} min={todayIso()}
              aria-invalid={Boolean(dateError)}
              onChange={(e) => setScheduler((p) => ({ ...p, date: e.target.value }))}
            />

            <label className="cv-sched__label" htmlFor="cv-time">
              Heure
              <span className="cv-sched__label-hint"> — n’importe quelle heure, à la minute près.</span>
            </label>
            <div className="cv-sched__time-row">
              <input
                id="cv-time"
                type="time"
                className="cv-sched__input cv-sched__time-input"
                step="300"
                value={scheduler.time}
                onChange={(e) => setScheduler((p) => ({ ...p, time: e.target.value || '09:00' }))}
              />
              <div className="cv-sched__time-quick" role="radiogroup" aria-label="Créneaux rapides">
                {SLOT_OPTIONS.map((slot) => (
                  <button
                    key={slot} type="button" role="radio"
                    aria-checked={scheduler.time === slot}
                    className={`cv-time${scheduler.time === slot ? ' cv-time--on' : ''}`}
                    onClick={() => setScheduler((p) => ({ ...p, time: slot }))}
                  >{slot}</button>
                ))}
              </div>
            </div>

            <label className="cv-sched__label" htmlFor="cv-notes">Notes</label>
            <textarea
              id="cv-notes" rows={3}
              className="cv-sched__input"
              value={scheduler.notes}
              placeholder="Pièces à apporter, contexte…"
              onChange={(e) => setScheduler((p) => ({ ...p, notes: e.target.value }))}
            />

            {dateError ? <div className="cv-sched__err">⚠ {dateError}</div> : null}

            <div className="cv-sched__actions">
              <button type="button" className="cv-btn cv-btn--ghost" onClick={closeScheduler}>Annuler</button>
              <button
                type="button" className="cv-btn cv-btn--primary"
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
        width={460}
      >
        {selectedAppointment && (
          <div className="cv-apt">
            {selectedAppointmentSale && (
              <div style={{ marginBottom: 12 }}>
                <SaleSnapshotTracePanel sale={selectedAppointmentSale} />
              </div>
            )}
            <Row k="Type" v={typeLabel(selectedAppointment.type)} />
            <Row k="Client" v={selectedAppointment.clientName} />
            <Row k="Projet" v={selectedAppointment.projectTitle} />
            <Row k="Parcelles" v={selectedAppointment.plotLabel} />
            <Row k="Date" v={fmtDate(selectedAppointment.date)} />
            <Row k="Heure" v={selectedAppointment.time} />
            <Row k="Montant" v={fmtMoney(selectedAppointment.amount)} />
            <Row k="Agent" v={selectedAppointment.agentName} />
            {selectedAppointment.coordinationNotes ? (
              <div className="cv-detail__notes">{selectedAppointment.coordinationNotes}</div>
            ) : null}
          </div>
        )}
      </AdminModal>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Small presentational helpers used only inside the detail/appt modals.
// ----------------------------------------------------------------------------
function DetailBlock({ title, children }) {
  return (
    <section className="cv-detail__block">
      <div className="cv-detail__block-title">{title}</div>
      <div className="cv-detail__block-body">{children}</div>
    </section>
  )
}

function Row({ k, v, mono }) {
  return (
    <div className="cv-detail__row">
      <span className="cv-detail__row-k">{k}</span>
      <span className={`cv-detail__row-v${mono ? ' cv-detail__row-v--mono' : ''}`}>{v}</span>
    </div>
  )
}
