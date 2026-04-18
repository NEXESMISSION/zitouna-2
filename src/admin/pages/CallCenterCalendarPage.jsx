import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, Clock3, MapPin, Phone, ChevronLeft, ChevronRight, Info } from 'lucide-react'
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
      <style>{`
        /* Local polish for calendar page — keeps admin.css untouched */
        .cc-cal-v2 { display: flex; flex-direction: column; gap: 16px; }
        .cc-cal-v2 .cc-cal-help {
          display: flex; align-items: flex-start; gap: 8px;
          padding: 10px 12px; border-radius: 10px;
          background: rgba(37, 99, 235, 0.06);
          color: #1e3a8a; font-size: 13px; line-height: 1.4;
          border: 1px solid rgba(37, 99, 235, 0.15);
        }
        .cc-cal-v2 .cc-cal-help svg { flex-shrink: 0; margin-top: 2px; }
        .cc-cal-v2 .cc-cal-toolbar {
          display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
          justify-content: space-between;
        }
        .cc-cal-v2 .cc-cal-toolbar__title {
          font-size: 15px; font-weight: 700; text-transform: capitalize;
          color: #111827; min-width: 140px; text-align: center;
        }
        .cc-cal-v2 .cc-cal-nav {
          display: inline-flex; align-items: center; gap: 6px;
        }
        .cc-cal-v2 .cc-cal-nav__btn {
          display: inline-flex; align-items: center; justify-content: center;
          width: 34px; height: 34px; border-radius: 8px;
          border: 1px solid #e5e7eb; background: #fff; color: #111827;
          cursor: pointer; transition: background .15s;
        }
        .cc-cal-v2 .cc-cal-nav__btn:hover { background: #f3f4f6; }
        .cc-cal-v2 .cc-cal-today-btn {
          height: 34px; padding: 0 12px; border-radius: 8px;
          border: 1px solid #2563eb; background: #2563eb; color: #fff;
          font-size: 13px; font-weight: 600; cursor: pointer;
        }
        .cc-cal-v2 .cc-cal-today-btn:hover { background: #1d4ed8; }
        .cc-cal-v2 .cc-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
        .cc-cal-v2 .cc-cal-weekhead {
          display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px;
          font-size: 12px; font-weight: 600; color: #6b7280; text-align: center;
          padding: 6px 0;
        }
        .cc-cal-v2 .cc-cal-day {
          position: relative;
          aspect-ratio: 1/1; min-height: 40px;
          border-radius: 8px; border: 1px solid #e5e7eb; background: #fff;
          color: #111827; font-size: 13px; font-weight: 500;
          cursor: pointer; transition: all .15s;
          display: flex; align-items: center; justify-content: center;
        }
        .cc-cal-v2 .cc-cal-day:hover { background: #f3f4f6; border-color: #d1d5db; }
        .cc-cal-v2 .cc-cal-day.is-today { border-color: #2563eb; color: #2563eb; font-weight: 700; }
        .cc-cal-v2 .cc-cal-day.is-selected {
          background: #2563eb; color: #fff; border-color: #2563eb;
          box-shadow: 0 2px 6px rgba(37, 99, 235, 0.3);
        }
        .cc-cal-v2 .cc-cal-day__dot {
          position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%);
          width: 5px; height: 5px; border-radius: 50%; background: #f97316;
        }
        .cc-cal-v2 .cc-cal-day.is-selected .cc-cal-day__dot { background: #fff; }
        .cc-cal-v2 .cc-cal-blank { aspect-ratio: 1/1; }

        .cc-cal-v2 .cc-cal-schedule {
          background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
          padding: 14px; display: flex; flex-direction: column; gap: 12px;
        }
        .cc-cal-v2 .cc-cal-schedule__head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 8px; flex-wrap: wrap;
        }
        .cc-cal-v2 .cc-cal-schedule__title {
          display: flex; align-items: center; gap: 8px;
          font-size: 18px; font-weight: 700; color: #111827;
          text-transform: capitalize; margin: 0;
        }
        .cc-cal-v2 .cc-cal-schedule__count {
          font-size: 13px; font-weight: 600; color: #2563eb;
          background: rgba(37, 99, 235, 0.08); padding: 4px 10px; border-radius: 999px;
        }
        .cc-cal-v2 .cc-cal-hint { font-size: 13px; color: #6b7280; margin: 0; }

        .cc-cal-v2 .cc-cal-empty {
          display: flex; flex-direction: column; align-items: center; gap: 8px;
          padding: 28px 16px; text-align: center;
          border: 1px dashed #d1d5db; border-radius: 10px; background: #f9fafb;
          color: #4b5563; font-size: 13px;
        }
        .cc-cal-v2 .cc-cal-empty strong { color: #111827; font-size: 14px; }

        .cc-cal-v2 .cc-cal-list { display: flex; flex-direction: column; gap: 8px; }
        .cc-cal-v2 .cc-cal-card {
          display: grid; grid-template-columns: auto 1fr auto;
          align-items: center; gap: 12px;
          padding: 12px; border: 1px solid #e5e7eb; border-radius: 10px;
          background: #fff; transition: border-color .15s, box-shadow .15s;
        }
        .cc-cal-v2 .cc-cal-card:hover { border-color: #2563eb; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
        .cc-cal-v2 .cc-cal-card__time {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 10px; border-radius: 8px;
          background: #eff6ff; color: #1d4ed8;
          font-size: 13px; font-weight: 700; letter-spacing: 0.5px;
        }
        .cc-cal-v2 .cc-cal-card__body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .cc-cal-v2 .cc-cal-card__name {
          font-size: 14px; font-weight: 600; color: #111827;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .cc-cal-v2 .cc-cal-card__meta {
          display: inline-flex; align-items: center; gap: 4px;
          font-size: 12px; color: #6b7280;
        }
        .cc-cal-v2 .cc-cal-card__call {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 8px 14px; border-radius: 8px;
          background: #10b981; color: #fff; font-size: 13px; font-weight: 600;
          text-decoration: none; transition: background .15s;
          white-space: nowrap;
        }
        .cc-cal-v2 .cc-cal-card__call:hover { background: #059669; }

        @media (max-width: 599px) {
          .cc-cal-v2 .cc-cal-toolbar { flex-direction: column; align-items: stretch; }
          .cc-cal-v2 .cc-cal-toolbar__row {
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
          }
          .cc-cal-v2 .cc-cal-today-btn { width: 100%; }
          .cc-cal-v2 .cc-cal-card {
            grid-template-columns: 1fr;
            gap: 8px;
          }
          .cc-cal-v2 .cc-cal-card__call { justify-content: center; }
          .cc-cal-v2 .cc-cal-card__time { justify-self: start; }
        }
      `}</style>

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
          <h1 style={{ fontSize: 20, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CalendarDays size={20} /> Calendrier des visites
          </h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '6px 0 0' }}>
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
            style={{ padding: 14, borderRadius: 12, border: '1px solid #e5e7eb', background: '#fff' }}
          >
            <div className="cc-cal-toolbar">
              <div className="cc-cal-toolbar__row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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

            <div className="cc-cal-weekhead" style={{ marginTop: 10 }}>
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
              <div className="cc-cal-empty">
                <strong>Aucun rendez-vous planifié</strong>
                <span>
                  Choisissez une autre date dans le calendrier ci-dessus ou revenez au centre d appels pour en créer un.
                </span>
              </div>
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
