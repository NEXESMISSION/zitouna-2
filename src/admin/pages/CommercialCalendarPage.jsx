import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCalls, callStore, fmtDateFull, todayIso, initials } from './commercialStore.js'
import './sell-field.css'
import './call-center-page.css'
import './commercial-calendar-page.css'

const DAYS_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']
const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
]

function getMonthGrid(year, month) {
  const first = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0).getDate()
  const startDay = (first.getDay() + 6) % 7
  const cells = []
  for (let i = 0; i < startDay; i++) cells.push(null)
  for (let d = 1; d <= lastDay; d++) cells.push(d)
  return cells
}

function pad(n) { return String(n).padStart(2, '0') }

export default function CommercialCalendarPage() {
  const navigate = useNavigate()
  const calls = useCalls()
  const today = todayIso()

  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })
  const [selectedDate, setSelectedDate] = useState(today)
  const [detail, setDetail] = useState(null)

  const countsByDate = useMemo(() => {
    const map = {}
    for (const c of calls) map[c.date] = (map[c.date] || 0) + 1
    return map
  }, [calls])

  const grid = useMemo(
    () => getMonthGrid(viewMonth.year, viewMonth.month),
    [viewMonth.year, viewMonth.month],
  )

  const selectedCalls = useMemo(
    () =>
      calls
        .filter((c) => c.date === selectedDate)
        .sort((a, b) => String(a.time || '').localeCompare(String(b.time || ''))),
    [calls, selectedDate],
  )

  const stats = useMemo(
    () => ({
      total: calls.length,
      today: calls.filter((c) => c.date === today).length,
      motorise: calls.filter((c) => c.motorise).length,
      nonMotorise: calls.filter((c) => !c.motorise).length,
    }),
    [calls, today],
  )

  const prevMonth = () => {
    setViewMonth((prev) =>
      prev.month === 0 ? { year: prev.year - 1, month: 11 } : { year: prev.year, month: prev.month - 1 }
    )
  }
  const nextMonth = () => {
    setViewMonth((prev) =>
      prev.month === 11 ? { year: prev.year + 1, month: 0 } : { year: prev.year, month: prev.month + 1 }
    )
  }
  const goToday = () => {
    const d = new Date()
    setViewMonth({ year: d.getFullYear(), month: d.getMonth() })
    setSelectedDate(today)
  }

  const removeCall = async (id) => {
    await callStore.remove(id)
    setDetail(null)
  }

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate('/admin')}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero cc-hero">
        <div className="sp-hero__avatar cc-hero__icon" aria-hidden><span>🗓️</span></div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Agenda commercial</h1>
          <p className="sp-hero__role">Planning des visites terrain</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">{stats.today}</span>
          <span className="sp-hero__kpi-label">aujourd'hui</span>
        </div>
      </header>

      <button
        type="button"
        className="sp-cta-btn"
        onClick={() => navigate('/admin/call-center')}
        title="Retour au Centre d'appels CRM"
      >
        <span className="sp-cta-btn__icon">📞</span>
        <span className="sp-cta-btn__text">Centre d'appels</span>
        <span className="sp-cta-btn__arrow">→</span>
      </button>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats cc-cat-stats">
          <strong>{stats.total}</strong> total
          <span className="sp-cat-stat-dot" />
          <strong>{stats.today}</strong> aujourd'hui
          <span className="sp-cat-stat-dot" />
          <strong>{stats.motorise}</strong> motorisés
          <span className="sp-cat-stat-dot" />
          <strong>{stats.nonMotorise}</strong> navette
        </div>
      </div>

      {/* Month calendar */}
      <section className="cal-month">
        <div className="cal-month__head">
          <button type="button" className="cal-month__arrow" onClick={prevMonth} aria-label="Mois précédent">‹</button>
          <button type="button" className="cal-month__title" onClick={goToday}>
            {MONTHS_FR[viewMonth.month]} {viewMonth.year}
          </button>
          <button type="button" className="cal-month__arrow" onClick={nextMonth} aria-label="Mois suivant">›</button>
        </div>
        <div className="cal-month__dow">
          {DAYS_FR.map((d) => <span key={d}>{d}</span>)}
        </div>
        <div className="cal-month__grid">
          {grid.map((day, i) => {
            if (day === null) return <span key={`e${i}`} className="cal-month__cell cal-month__cell--empty" />
            const dateStr = `${viewMonth.year}-${pad(viewMonth.month + 1)}-${pad(day)}`
            const count = countsByDate[dateStr] || 0
            const isToday = dateStr === today
            const isSelected = dateStr === selectedDate
            const classes = [
              'cal-month__cell',
              isToday && 'cal-month__cell--today',
              isSelected && 'cal-month__cell--selected',
              count > 0 && 'cal-month__cell--has',
            ].filter(Boolean).join(' ')
            return (
              <button
                key={dateStr}
                type="button"
                className={classes}
                onClick={() => setSelectedDate(dateStr)}
              >
                <span className="cal-month__day">{day}</span>
                {count > 0 && (
                  <span className="cal-month__count">{count}</span>
                )}
              </button>
            )
          })}
        </div>
      </section>

      {/* Selected day list */}
      <div className="cal-day__head">
        <strong>{fmtDateFull(selectedDate)}</strong>
        <span>{selectedCalls.length} visite{selectedCalls.length > 1 ? 's' : ''}</span>
      </div>

      <div className="sp-cards">
        {selectedCalls.length === 0 ? (
          <div className="sp-empty">
            <span className="sp-empty__emoji" aria-hidden>📭</span>
            <div className="sp-empty__title">Aucune visite ce jour.</div>
            <p className="cc-empty__text">
              Sélectionnez un autre jour ou ajoutez un appel depuis le Centre d'appels.
            </p>
          </div>
        ) : selectedCalls.map((call) => (
          <button
            key={call.id}
            type="button"
            className={`sp-card sp-card--${call.motorise ? 'blue' : 'orange'}`}
            onClick={() => setDetail(call)}
            aria-label={`Détail de ${call.name}`}
          >
            <div className="sp-card__head">
              <div className="sp-card__user">
                <span className="sp-card__initials cc-card__initials">{initials(call.name)}</span>
                <div style={{ minWidth: 0 }}>
                  <p className="sp-card__name">{call.name}</p>
                  <p className="sp-card__sub">{call.phone} · {call.project}</p>
                </div>
              </div>
              <span className={`sp-badge sp-badge--${call.motorise ? 'blue' : 'orange'}`}>
                {call.motorise ? 'Motorisé' : 'Navette'}
              </span>
            </div>
            <div className="sp-card__body">
              <div className="sp-card__price">
                <span className="sp-card__amount">{call.time}</span>
                <span className="sp-card__currency">h</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      {detail && (
        <div className="cal-sheet-wrap" role="presentation" onClick={() => setDetail(null)}>
          <div className="cal-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="cal-sheet__head">
              <strong>Détail de la visite</strong>
              <button type="button" className="cal-sheet__close" onClick={() => setDetail(null)} aria-label="Fermer">✕</button>
            </div>
            <div className="cal-sheet__body">
              <div className="sp-detail__row"><span>Nom</span><strong>{detail.name}</strong></div>
              <div className="sp-detail__row"><span>Téléphone</span><strong style={{ direction: 'ltr' }}>{detail.phone}</strong></div>
              <div className="sp-detail__row"><span>Projet</span><strong>{detail.project}</strong></div>
              <div className="sp-detail__row"><span>Date</span><strong>{fmtDateFull(detail.date)}</strong></div>
              <div className="sp-detail__row"><span>Heure</span><strong>{detail.time}</strong></div>
              <div className="sp-detail__row">
                <span>Transport</span>
                <span className={`sp-badge sp-badge--${detail.motorise ? 'green' : 'orange'}`}>
                  {detail.motorise ? 'Motorisé' : 'Navette'}
                </span>
              </div>
              {detail.notes && (
                <p className="cc-detail__notes" style={{ marginTop: 8 }}>{detail.notes}</p>
              )}
            </div>
            <div className="cal-sheet__actions">
              <a href={`tel:${detail.phone}`} className="cc-btn cc-btn--primary cc-call" style={{ flex: 1 }}>
                📞 Appeler
              </a>
              <button type="button" className="cc-btn cal-sheet__del" onClick={() => removeCall(detail.id)}>
                Supprimer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
