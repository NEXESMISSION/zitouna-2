import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, Clock3, MapPin, Phone } from 'lucide-react'
import { useCalls, fmtDateFull, todayIso } from './commercialStore.js'
import './call-center-page.css'

export default function CallCenterCalendarPage() {
  const navigate = useNavigate()
  const calls = useCalls()
  const [selectedDate, setSelectedDate] = useState(todayIso())
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date()
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d
  })

  const monthLabel = useMemo(
    () => monthCursor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
    [monthCursor],
  )

  const monthDays = useMemo(() => {
    const y = monthCursor.getFullYear()
    const m = monthCursor.getMonth()
    const first = new Date(y, m, 1)
    const firstWeekday = (first.getDay() + 6) % 7
    const daysInMonth = new Date(y, m + 1, 0).getDate()
    const cells = []

    for (let i = 0; i < firstWeekday; i += 1) cells.push(null)
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dt = new Date(y, m, d)
      cells.push(dt.toISOString().slice(0, 10))
    }
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [monthCursor])

  const dayCalls = useMemo(
    () =>
      calls
        .filter((c) => c.date === selectedDate)
        .sort((a, b) => String(a.time).localeCompare(String(b.time))),
    [calls, selectedDate],
  )

  return (
    <div className="cc-page" dir="ltr">
      <div className="cc-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate('/admin/call-center')}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour centre d appels</span>
        </button>

        <section className="cc-cal-page-head">
          <h1>
            <CalendarDays size={18} /> Calendrier des visites
          </h1>
          <p>Sélectionnez une date puis visualisez tous les rendez-vous planifiés.</p>
        </section>

        <section className="cc-cal-picker">
          <div className="cc-cal-picker__toolbar">
            <button
              type="button"
              className="cc-cal-picker__arrow"
              onClick={() => {
                const next = new Date(monthCursor)
                next.setMonth(next.getMonth() - 1)
                setMonthCursor(next)
              }}
            >
              ←
            </button>
            <strong>{monthLabel}</strong>
            <button
              type="button"
              className="cc-cal-picker__arrow"
              onClick={() => {
                const next = new Date(monthCursor)
                next.setMonth(next.getMonth() + 1)
                setMonthCursor(next)
              }}
            >
              →
            </button>
          </div>

          <div className="cc-cal-picker__week">
            {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>

          <div className="cc-cal-picker__grid">
            {monthDays.map((iso, idx) =>
              iso ? (
                <button
                  key={iso}
                  type="button"
                  className={selectedDate === iso ? 'on' : ''}
                  onClick={() => setSelectedDate(iso)}
                >
                  {new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit' })}
                </button>
              ) : (
                <span key={`blank-${idx}`} className="cc-cal-picker__blank" />
              ),
            )}
          </div>
        </section>

        <section className="cc-schedule">
          <div className="cc-schedule__head">
            <h2>
              <CalendarDays size={15} /> {fmtDateFull(selectedDate)}
            </h2>
            <span>{dayCalls.length} rendez-vous</span>
          </div>

          {dayCalls.length === 0 ? (
            <div className="cc-schedule__empty">Aucun rendez-vous pour cette date.</div>
          ) : (
            <div className="cc-schedule__list">
              {dayCalls.map((call) => (
                <article key={call.id} className="cc-schedule__item cc-schedule__item--card">
                  <span className="time">
                    <Clock3 size={11} /> {call.time}
                  </span>
                  <span className="meta">
                    <strong>{call.name}</strong>
                    <small>
                      <MapPin size={11} /> {call.project}
                    </small>
                  </span>
                  <a href={`tel:${call.phone}`} className="cc-cal-call-btn">
                    <Phone size={12} /> Appeler
                  </a>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
