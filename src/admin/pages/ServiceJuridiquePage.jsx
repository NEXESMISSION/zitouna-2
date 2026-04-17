import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useSales } from '../../lib/useSupabase.js'
import AdminModal from '../components/AdminModal.jsx'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import './zitouna-admin-page.css'
import './service-juridique.css'

function fmtMoney(v) {
  return `${(Number(v) || 0).toLocaleString('fr-FR')} TND`
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso)
  }
}

function normalizePlotIds(sale) {
  const ids = Array.isArray(sale?.plotIds)
    ? sale.plotIds
    : sale?.plotId != null
      ? [sale.plotId]
      : []
  return ids.map((x) => Number(x)).filter((n) => Number.isFinite(n))
}

function toIsoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** @param {string} [iso] timestamptz */
function juridiqueScheduleFromSale(iso) {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const date = `${y}-${m}-${day}`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return { date, time }
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

export default function ServiceJuridiquePage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { sales, update: salesUpdate } = useSales()
  const [view, setView] = useState('list')
  const [selected, setSelected] = useState(null)
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()))
  const [jurSaving, setJurSaving] = useState(false)

  const legalEntries = useMemo(() => {
    const candidates = (sales || []).filter((s) => {
      const st = String(s.status || '')
      // Juridique can work on dossiers planned by Coordination, even before notary step.
      if (st !== 'pending_finance' && st !== 'pending_legal') return false
      // Juridique is only accessible when coordination actually scheduled it.
      // If no coordination time was set, keep the dossier out of this page.
      if (!s.coordinationJuridiqueAt) return false
      if (s.juridiqueValidatedAt) return false
      return true
    })
    return candidates
      .map((sale) => {
        const plotIds = normalizePlotIds(sale)
        const { date, time } = juridiqueScheduleFromSale(sale.coordinationJuridiqueAt)
        if (!date || !time) return null
        const total = Number(sale.agreedPrice) || 0
        const unit = plotIds.length > 0 ? Math.round(total / plotIds.length) : total
        return {
          id: sale.id,
          saleCode: sale.code || sale.id,
          clientName: sale.clientName || 'Client',
          projectTitle: sale.projectTitle || 'Projet',
          plotIds,
          priceTotal: total,
          pricePerPiece: unit,
          offerName: sale.offerName || (sale.paymentType === 'installments' ? 'Echelonne' : 'Comptant'),
          paymentType: sale.paymentType === 'installments' ? 'Echelonne' : 'Comptant',
          date,
          time,
          notes: sale.notes || '',
          coordinationNotes: sale.coordinationNotes || '',
        }
      })
      .filter(Boolean)
      .sort((a, b) => {
        const da = a.date || '9999-99-99'
        const db = b.date || '9999-99-99'
        const c = `${da} ${a.time || '99:99'}`.localeCompare(`${db} ${b.time || '99:99'}`)
        if (c !== 0) return c
        return String(a.clientName || '').localeCompare(String(b.clientName || ''))
      })
  }, [sales])

  const todayCount = useMemo(() => {
    const iso = new Date().toISOString().slice(0, 10)
    return legalEntries.filter((e) => e.date && e.date === iso).length
  }, [legalEntries])

  const appointmentsByDate = useMemo(() => {
    const map = new Map()
    for (const e of legalEntries) {
      const key = e.date || ''
      if (!key) continue
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(e)
    }
    for (const [, list] of map) {
      list.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
    }
    return map
  }, [legalEntries])

  const monthCells = useMemo(() => monthGrid(monthAnchor), [monthAnchor])
  const dayAgenda = useMemo(() => appointmentsByDate.get(selectedDate) || [], [appointmentsByDate, selectedDate])
  const monthLabel = monthAnchor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  const selectedFullSale = useMemo(
    () => (selected ? (sales || []).find((s) => String(s.id) === String(selected.id)) : null),
    [sales, selected],
  )

  async function stampReadyForNotary() {
    if (!selected?.id) return
    setJurSaving(true)
    try {
      const now = new Date().toISOString()
      await salesUpdate(selected.id, {
        juridiqueValidatedAt: now,
        juridiqueValidatedBy: adminUser?.id || null,
      })
      setSelected(null)
    } finally {
      setJurSaving(false)
    }
  }

  return (
    <div className="sj-page" dir="ltr">
      <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
        <span className="ds-back-btn__icon" aria-hidden>←</span>
        <span className="ds-back-btn__label">Back</span>
      </button>

      <section className="sj-hero">
        <div className="sj-hero__top">
          <div className="sj-hero__icon">⚖️</div>
          <div className="sj-hero__text">
            <h1 className="sj-hero__title">Service juridique & conformite</h1>
            <p className="sj-hero__sub">Dossiers planifies par la coordination, avec suivi des rendez-vous et validations de conformite.</p>
          </div>
        </div>
        <div className="sj-hero__kpi">
          <div className="sj-hero__kpi-block">
            <span className="sj-hero__kpi-num">{legalEntries.length}</span>
            <span className="sj-hero__kpi-unit">Dossiers</span>
          </div>
          <span className="sj-hero__kpi-sep" />
          <div className="sj-hero__kpi-block">
            <span className="sj-hero__kpi-num">{todayCount}</span>
            <span className="sj-hero__kpi-unit">Aujourd'hui</span>
          </div>
        </div>
      </section>

      <div className="sj-tabs sj-tabs--2col">
        <button type="button" className={`sj-tab${view === 'list' ? ' sj-tab--on' : ''}`} onClick={() => setView('list')}>
          <span className="sj-tab__main">Liste</span>
        </button>
        <button type="button" className={`sj-tab${view === 'calendar' ? ' sj-tab--on' : ''}`} onClick={() => setView('calendar')}>
          <span className="sj-tab__main">Calendrier</span>
        </button>
      </div>

      {view === 'list' && (
        <>
          <p className="sj-section">Rendez-vous juridiques</p>
          {legalEntries.length === 0 ? (
            <div className="sj-empty">Aucun dossier juridique planifie.</div>
          ) : (
            <div className="sj-cal-grid">
              {legalEntries.map((entry) => (
                <button key={entry.id} type="button" className="sj-agenda__row" onClick={() => setSelected(entry)}>
                  <span className="sj-agenda__time">{entry.time || '—'}</span>
                  <span className="sj-agenda__body">
                    <span className="sj-pill sj-pill--juridique">Service juridique</span>
                    <div className="sj-agenda__title">{entry.clientName}</div>
                    <div className="sj-agenda__sub">
                      {entry.projectTitle} • {entry.plotIds.map((id) => `#${id}`).join(', ') || '—'} • {entry.date ? fmtDate(entry.date) : 'Non planifie'}
                    </div>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {view === 'calendar' && (
        <>
          <p className="sj-section">Calendrier juridique</p>
          <div className="sj-cal-wrap">
            <div className="sj-cal-toolbar">
              <button type="button" className="sj-cal-nav" onClick={() => setMonthAnchor((d) => addMonths(d, -1))}>‹</button>
              <span className="sj-cal-month">{monthLabel}</span>
              <button type="button" className="sj-cal-nav" onClick={() => setMonthAnchor((d) => addMonths(d, 1))}>›</button>
            </div>

            <div className="sj-cal-weekhead">
              {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
                <span key={d} className="sj-cal-weekday">{d}</span>
              ))}
            </div>
            <div className="sj-cal-grid-month">
              {monthCells.map((cell) => {
                const iso = toIsoDate(cell.date)
                const count = (appointmentsByDate.get(iso) || []).length
                const isSel = iso === selectedDate
                return (
                  <button
                    key={`${iso}-${cell.inMonth ? 'in' : 'out'}`}
                    type="button"
                    className={`sj-cal-day${cell.inMonth ? '' : ' sj-cal-day--muted'}${isSel ? ' sj-cal-day--selected' : ''}`}
                    onClick={() => setSelectedDate(iso)}
                  >
                    <span className="sj-cal-day__num">{cell.date.getDate()}</span>
                    {count > 0 ? <span className="sj-cal-day__dot">{count}</span> : null}
                  </button>
                )
              })}
            </div>

            <div className="sj-cal-agenda">
              <div className="sj-cal-agenda__head">{fmtDate(selectedDate)}</div>
              {dayAgenda.length === 0 ? (
                <div className="sj-empty" style={{ border: 'none', borderRadius: 0, padding: 16 }}>Aucun rendez-vous ce jour.</div>
              ) : (
                dayAgenda.map((entry) => (
                  <button key={`${entry.id}-${entry.time}`} type="button" className="sj-agenda__row" onClick={() => setSelected(entry)}>
                    <span className="sj-agenda__time">{entry.time || '—'}</span>
                    <span className="sj-agenda__body">
                      <span className="sj-pill sj-pill--juridique">Service juridique</span>
                      <div className="sj-agenda__title">{entry.clientName}</div>
                      <div className="sj-agenda__sub">
                        {entry.projectTitle} • {entry.plotIds.map((id) => `#${id}`).join(', ') || '—'}
                      </div>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}

      <p className="sj-footnote">
        Vue juridique simple: utilisez <strong>Liste</strong> pour traiter rapidement les dossiers et
        <strong> Calendrier</strong> pour planifier visuellement.
      </p>

      {selected && (
        <AdminModal
          open
          onClose={() => setSelected(null)}
          title={`Dossier ${selected.saleCode}`}
        >
          <div className="sj-detail">
            {selectedFullSale ? (
              <div style={{ marginBottom: 14 }}>
                <SaleSnapshotTracePanel sale={selectedFullSale} />
              </div>
            ) : null}
            <div className="sj-detail__row"><span>Client</span><strong>{selected.clientName}</strong></div>
            <div className="sj-detail__row"><span>Projet</span><strong>{selected.projectTitle}</strong></div>
            <div className="sj-detail__row"><span>Pieces</span><strong>{selected.plotIds.map((id) => `#${id}`).join(', ') || '—'}</strong></div>
            <div className="sj-detail__row"><span>Prix par piece</span><strong>{fmtMoney(selected.pricePerPiece)}</strong></div>
            <div className="sj-detail__row"><span>Prix total</span><strong>{fmtMoney(selected.priceTotal)}</strong></div>
            <div className="sj-detail__row"><span>Offre</span><strong>{selected.offerName}</strong></div>
            <div className="sj-detail__row"><span>Paiement</span><strong>{selected.paymentType}</strong></div>
            <div className="sj-detail__row">
              <span>Date / heure (coordination)</span>
              <strong>
                {selected.date ? `${fmtDate(selected.date)} • ${selected.time || '—'}` : 'Non planifie — voir Coordination'}
              </strong>
            </div>
            {selected.coordinationNotes ? <div className="sj-detail__notes">{selected.coordinationNotes}</div> : null}
            {selected.notes ? <div className="sj-detail__notes">{selected.notes}</div> : null}
            <div className="zitu-page__form-actions" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--primary"
                disabled={jurSaving}
                onClick={stampReadyForNotary}
              >
                {jurSaving ? 'Enregistrement…' : 'Timbre juridique — prêt pour notaire'}
              </button>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
