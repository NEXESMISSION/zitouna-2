import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, Clock3, MapPin, Phone, ChevronLeft, ChevronRight, Info } from 'lucide-react'
import { useCalls, fmtDateFull, todayIso } from './commercialStore.js'
import EmptyState from '../../components/EmptyState.jsx'
import './call-center-page.css'
import './call-center-calendar.css'

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

  // Today's ISO date to highlight current day in grid
  const today = todayIso()

  // Count of appointments per day (current month) for subtle badges
  const countsByDate = useMemo(() => {
    const map = new Map()
    for (const c of calls) {
      map.set(c.date, (map.get(c.date) || 0) + 1)
    }
    return map
  }, [calls])

  const goToday = () => {
    const d = new Date()
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    setMonthCursor(d)
    setSelectedDate(todayIso())
  }

  return (
    <div className="cc-page" dir="ltr">
      <div className="cc-page__column">
        <button
          type="button"
          className="ds-back-btn"
          onClick={() => navigate('/admin/call-center')}
          title="Revenir au centre d'appels"
        >
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour centre d appels</span>
        </button>

        <section className="cc-cal-page-head">
          <h1 className="cc-cal-page-head__title">
            <CalendarDays size={20} /> Calendrier des visites
          </h1>
          <p className="cc-cal-page-head__subtitle">
            Choisissez un jour pour voir la liste des rendez-vous.
          </p>
        </section>

        <div className="cc-cal-v2">
          {/* Inline guidance — one-liner to orient any staff member */}
          <div className="cc-cal-help" role="note">
            <Info size={16} aria-hidden />
            <span>
              <strong>Astuce :</strong> les jours marqués d un point orange contiennent des rendez-vous. Cliquez sur un jour pour afficher le planning, puis sur « Appeler » pour joindre le client.
            </span>
          </div>

          {/* Month toolbar — previous/next + today shortcut */}
          <section
            className="cc-cal-picker"
            aria-label="Sélecteur de date"
          >
            <div className="cc-cal-toolbar">
              <div className="cc-cal-toolbar__row">
                <div className="cc-cal-nav">
                  <button
                    type="button"
                    className="cc-cal-nav__btn"
                    aria-label="Mois précédent"
                    title="Mois précédent"
                    onClick={() => {
                      const next = new Date(monthCursor)
                      next.setMonth(next.getMonth() - 1)
                      setMonthCursor(next)
                    }}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <button
                    type="button"
                    className="cc-cal-nav__btn"
                    aria-label="Mois suivant"
                    title="Mois suivant"
                    onClick={() => {
                      const next = new Date(monthCursor)
                      next.setMonth(next.getMonth() + 1)
                      setMonthCursor(next)
                    }}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
                <span className="cc-cal-toolbar__title">{monthLabel}</span>
              </div>
              <button
                type="button"
                className="cc-cal-today-btn"
                onClick={goToday}
                title="Revenir à la date d aujourd hui"
              >
                Aujourd hui
              </button>
            </div>

            <div className="cc-cal-weekhead cc-cal-weekhead--spaced">
              {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>

            <div className="cc-cal-grid">
              {monthDays.map((iso, idx) => {
                if (!iso) return <span key={`blank-${idx}`} className="cc-cal-blank" />
                const count = countsByDate.get(iso) || 0
                const isSelected = selectedDate === iso
                const isToday = iso === today
                const cls = [
                  'cc-cal-day',
                  isToday ? 'is-today' : '',
                  isSelected ? 'is-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <button
                    key={iso}
                    type="button"
                    className={cls}
                    onClick={() => setSelectedDate(iso)}
                    aria-label={`Sélectionner le ${iso}${count ? `, ${count} rendez-vous` : ''}`}
                    title={count ? `${count} rendez-vous ce jour` : 'Aucun rendez-vous'}
                  >
                    {new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit' })}
                    {count > 0 && <span className="cc-cal-day__dot" aria-hidden />}
                  </button>
                )
              })}
            </div>
          </section>

          {/* Schedule for selected day */}
          <section className="cc-cal-schedule" aria-live="polite">
            <div className="cc-cal-schedule__head">
              <h2 className="cc-cal-schedule__title">
                <CalendarDays size={18} /> {fmtDateFull(selectedDate)}
              </h2>
              <span className="cc-cal-schedule__count">
                {dayCalls.length} rendez-vous
              </span>
            </div>
            <p className="cc-cal-hint">
              Liste triée par heure. Utilisez le bouton vert pour lancer l appel directement.
            </p>

            {dayCalls.length === 0 ? (
              <EmptyState
                icon="🗓️"
                title="Aucun rendez-vous planifié"
                description="Choisissez une autre date dans le calendrier ci-dessus ou revenez au centre d appels pour en créer un."
              />
            ) : (
              <div className="cc-cal-list">
                {dayCalls.map((call) => (
                  <article key={call.id} className="cc-cal-card">
                    <span className="cc-cal-card__time" title="Heure du rendez-vous">
                      <Clock3 size={13} /> {call.time}
                    </span>
                    <span className="cc-cal-card__body">
                      <span className="cc-cal-card__name">{call.name}</span>
                      <span className="cc-cal-card__meta">
                        <MapPin size={12} /> {call.project}
                      </span>
                    </span>
                    <a
                      href={`tel:${call.phone}`}
                      className="cc-cal-card__call"
                      title={`Appeler ${call.name}`}
                    >
                      <Phone size={14} /> Appeler
                    </a>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
