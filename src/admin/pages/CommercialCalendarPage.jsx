import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, Car, CarFront, ChevronLeft, ChevronRight, Phone, X } from 'lucide-react'
import { useCalls, callStore, fmtDateFull, todayIso } from './commercialStore.js'
import './call-center-page.css'
import './commercial-du-jour.css'

const DAYS_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']
const MONTHS_FR = [
  'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre',
]

function getMonthGrid(year, month) {
  const first = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0).getDate()
  let startDay = (first.getDay() + 6) % 7
  const cells = []
  for (let i = 0; i < startDay; i++) cells.push(null)
  for (let d = 1; d <= lastDay; d++) cells.push(d)
  return cells
}

function pad(n) {
  return String(n).padStart(2, '0')
}

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
    for (const c of calls) {
      map[c.date] = (map[c.date] || 0) + 1
    }
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
    setViewMonth((prev) => {
      if (prev.month === 0) return { year: prev.year - 1, month: 11 }
      return { year: prev.year, month: prev.month - 1 }
    })
  }
  const nextMonth = () => {
    setViewMonth((prev) => {
      if (prev.month === 11) return { year: prev.year + 1, month: 0 }
      return { year: prev.year, month: prev.month + 1 }
    })
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
    <div className="zadm-page commercial-calendar-page" dir="ltr">
      <header className="zadm-page__head">
        <div className="zadm-page__head-text">
          <button
            type="button"
            className="zadm-btn zadm-btn--ghost zadm-btn--sm"
            onClick={() => navigate('/admin')}
            style={{ marginBottom: 8, paddingLeft: 0 }}
          >
            <span aria-hidden>←</span> Retour
          </button>
          <h1 className="zadm-page__title">Agenda commercial terrain</h1>
          <p className="zadm-page__subtitle">Calendrier des visites planifiées et suivi quotidien.</p>
        </div>
        <div className="zadm-page__head-actions">
          <button
            type="button"
            className="zadm-btn zadm-btn--primary"
            onClick={() => navigate('/admin/call-center')}
          >
            <Phone size={15} aria-hidden /> CRM
          </button>
        </div>
      </header>

      <div className="zadm-page__body">
        <section className="zadm-kpi-grid" aria-label="Statistiques visites">
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">Total</span>
            <span className="zadm-kpi__value">{stats.total}</span>
          </div>
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">Aujourd&apos;hui</span>
            <span className="zadm-kpi__value">{stats.today}</span>
          </div>
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">Motorisés</span>
            <span className="zadm-kpi__value">{stats.motorise}</span>
          </div>
          <div className="zadm-kpi">
            <span className="zadm-kpi__label">Non motorisés</span>
            <span className="zadm-kpi__value">{stats.nonMotorise}</span>
          </div>
        </section>

        <section className="cdj-month cdj-month--panel">
          <div className="cdj-month__header">
            <button type="button" className="cdj-month__arrow" onClick={prevMonth} aria-label="Mois précédent">
              <ChevronLeft size={18} strokeWidth={2.5} />
            </button>
            <button type="button" className="cdj-month__title" onClick={goToday}>
              {MONTHS_FR[viewMonth.month]} {viewMonth.year}
            </button>
            <button type="button" className="cdj-month__arrow" onClick={nextMonth} aria-label="Mois suivant">
              <ChevronRight size={18} strokeWidth={2.5} />
            </button>
          </div>

          <div className="cdj-month__dow">
            {DAYS_FR.map((d) => (
              <span key={d} className="cdj-month__dow-cell">
                {d}
              </span>
            ))}
          </div>

          <div className="cdj-month__grid">
            {grid.map((day, i) => {
              if (day === null) return <span key={`e${i}`} className="cdj-month__cell cdj-month__cell--empty" />
              const dateStr = `${viewMonth.year}-${pad(viewMonth.month + 1)}-${pad(day)}`
              const count = countsByDate[dateStr] || 0
              const isToday = dateStr === today
              const isSelected = dateStr === selectedDate
              return (
                <button
                  key={dateStr}
                  type="button"
                  className={
                    'cdj-month__cell' +
                    (isToday ? ' cdj-month__cell--today' : '') +
                    (isSelected ? ' cdj-month__cell--selected' : '') +
                    (count > 0 ? ' cdj-month__cell--has' : '')
                  }
                  onClick={() => setSelectedDate(dateStr)}
                >
                  <span className="cdj-month__day">{day}</span>
                  {count > 0 && (
                    <span className="cdj-month__dots">
                      {count <= 3 ? (
                        Array.from({ length: count }, (_, j) => <span key={j} className="cdj-month__dot" />)
                      ) : (
                        <span className="cdj-month__count">{count}</span>
                      )}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </section>

        <section className="cdj-day-detail">
          <div className="cdj-cal-day__head cdj-cal-day__head--panel">
            <span className="cdj-cal-day__ico" aria-hidden>
              <CalendarDays size={18} />
            </span>
            <div>
              <h2 className="cdj-cal-day__title">{fmtDateFull(selectedDate)}</h2>
              <p className="cdj-cal-day__sub">
                {selectedCalls.length} visite{selectedCalls.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          {selectedCalls.length === 0 ? (
            <div className="cdj-empty">
              <div className="cdj-empty__ico" aria-hidden>
                <CalendarDays size={28} strokeWidth={1.5} />
              </div>
              <p className="cdj-empty__title">Aucune visite ce jour</p>
              <p className="cdj-empty__hint">
                Sélectionnez un autre jour ou ajoutez un appel depuis le Centre d&apos;appel.
              </p>
            </div>
          ) : (
            <div className="cdj-cal-slots">
              {selectedCalls.map((call) => (
                <button key={call.id} type="button" className="cdj-cal-item" onClick={() => setDetail(call)}>
                  <span className="cdj-cal-item__time">{call.time}</span>
                  <span className="cdj-cal-item__body">
                    <span className="cdj-cal-item__name">{call.name}</span>
                    <span className="cdj-cal-item__project">{call.project}</span>
                    <span className="cdj-cal-item__phone">{call.phone}</span>
                  </span>
                  <span className={`cdj-cal-item__tag cdj-cal-item__tag--${call.motorise ? 'green' : 'amber'}`}>
                    {call.motorise ? '���' : '���'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {detail && (
        <div className="cdj-overlay" role="presentation" onClick={() => setDetail(null)}>
          <div className="cdj-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="cdj-sheet__head">
              <h3 className="cdj-sheet__title">Détail de la visite</h3>
              <button type="button" className="cdj-sheet__close" onClick={() => setDetail(null)} aria-label="Fermer">
                <X size={16} aria-hidden />
              </button>
            </div>
            <div className="cdj-detail">
              <div className="cdj-detail__row">
                <span>Nom</span>
                <strong>{detail.name}</strong>
              </div>
              <div className="cdj-detail__row">
                <span>Téléphone</span>
                <strong>{detail.phone}</strong>
              </div>
              <div className="cdj-detail__row">
                <span>Projet</span>
                <strong>{detail.project}</strong>
              </div>
              <div className="cdj-detail__row">
                <span>Date</span>
                <strong>{fmtDateFull(detail.date)}</strong>
              </div>
              <div className="cdj-detail__row">
                <span>Heure</span>
                <strong>{detail.time}</strong>
              </div>
              <div className="cdj-detail__row">
                <span>Transport</span>
                <span className={`cdj-badge cdj-badge--${detail.motorise ? 'green' : 'amber'}`}>
                  {detail.motorise ? (
                    <>
                      <Car size={10} aria-hidden /> Motorisé
                    </>
                  ) : (
                    <>
                      <CarFront size={10} aria-hidden /> Non motorisé
                    </>
                  )}
                </span>
              </div>
              {detail.notes && <div className="cdj-detail__notes">{detail.notes}</div>}
            </div>
            <div className="cdj-detail__actions">
              <a href={`tel:${detail.phone}`} className="cdj-detail__btn cdj-detail__btn--call">
                <Phone size={14} aria-hidden /> Appeler
              </a>
              <button type="button" className="cdj-detail__btn cdj-detail__btn--del" onClick={() => removeCall(detail.id)}>
                Supprimer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
