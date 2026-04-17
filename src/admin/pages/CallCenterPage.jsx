import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarDays,
  Car,
  CarFront,
  Clock3,
  ClipboardList,
  MapPin,
  Phone,
  Plus,
  Search,
  User,
  Users,
} from 'lucide-react'
import AdminModal from '../components/AdminModal.jsx'
import { useToast } from '../components/AdminToast.jsx'
import { useProjects } from '../../lib/useSupabase.js'
import {
  useCalls,
  callStore,
  initials,
  fmtDateShort,
  fmtDateFull,
  todayIso,
  SLOT_OPTIONS,
} from './commercialStore.js'
import './call-center-page.css'

export default function CallCenterPage() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const calls = useCalls()
  const { projects } = useProjects()
  const PROJECT_OPTIONS = useMemo(() => projects.map(p => ({ id: p.id, title: p.title, city: p.city })), [projects])

  const [search, setSearch] = useState('')
  const [projectFilter, setProjectFilter] = useState('all')
  const [transportFilter, setTransportFilter] = useState('all')
  const [selectedDate, setSelectedDate] = useState(todayIso())
  const [showForm, setShowForm] = useState(false)
  const [detail, setDetail] = useState(null)
  const [form, setForm] = useState({
    name: '',
    phone: '',
    project: PROJECT_OPTIONS[0]?.title || '',
    date: todayIso(),
    time: SLOT_OPTIONS[0],
    motorise: true,
    notes: '',
  })

  const resetForm = () => {
    setForm({
      name: '',
      phone: '',
      project: PROJECT_OPTIONS[0]?.title || '',
      date: todayIso(),
      time: SLOT_OPTIONS[0],
      motorise: true,
      notes: '',
    })
    setShowForm(false)
  }

  const sorted = useMemo(
    () => [...calls].sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`)),
    [calls],
  )

  const filteredCalls = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sorted.filter((call) => {
      const matchesSearch =
        !q ||
        String(call.name || '').toLowerCase().includes(q) ||
        String(call.phone || '').toLowerCase().includes(q) ||
        String(call.project || '').toLowerCase().includes(q)
      const matchesProject = projectFilter === 'all' || call.project === projectFilter
      const matchesTransport =
        transportFilter === 'all' ||
        (transportFilter === 'motorise' && call.motorise) ||
        (transportFilter === 'non-motorise' && !call.motorise)
      const matchesDate = !selectedDate || call.date === selectedDate
      return matchesSearch && matchesProject && matchesTransport && matchesDate
    })
  }, [sorted, search, projectFilter, transportFilter, selectedDate])

  const stats = useMemo(
    () => ({
      total: calls.length,
      today: calls.filter((c) => c.date === todayIso()).length,
      motorise: calls.filter((c) => c.motorise).length,
      nonMotorise: calls.filter((c) => !c.motorise).length,
    }),
    [calls],
  )

  const todayCalls = useMemo(
    () => filteredCalls.filter((c) => c.date === todayIso()).sort((a, b) => String(a.time).localeCompare(String(b.time))),
    [filteredCalls],
  )

  const addCall = async () => {
    if (!form.name.trim() || !form.phone.trim()) {
      addToast('Nom et telephone obligatoires.', 'error')
      return
    }

    await callStore.add({
      ...form,
      name: form.name.trim(),
      phone: form.phone.trim(),
      notes: form.notes.trim(),
    })

    addToast('Appel enregistre avec succes.', 'success')
    resetForm()
  }

  return (
    <div className="cc-page" dir="ltr">
      <div className="cc-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate('/admin')}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        <section className="cc-hero">
          <div className="cc-hero__left">
            <span className="cc-hero__icon" aria-hidden>
              <Phone size={18} />
            </span>
            <div>
              <p className="cc-hero__kicker">Acquisition commerciale</p>
              <h1>Centre d appels CRM</h1>
              <p className="cc-hero__sub">Reception, qualification et planification des visites clients.</p>
            </div>
          </div>
          <button type="button" className="cc-hero__cta" onClick={() => setShowForm(true)}>
            <Plus size={15} /> Ajouter appel
          </button>
        </section>

        <section className="cc-script cc-script--top">
          <div className="cc-script__head">
            <ClipboardList size={14} />
            Script opérateur
          </div>
          <p>
            Bonjour, merci d'avoir contacté Zitouna. Je vais vous accompagner pour planifier votre visite et noter vos
            besoins sur le projet.
          </p>
          <ul>
            <li>Confirmer le nom complet et le téléphone</li>
            <li>Valider le projet + date/heure de visite</li>
            <li>Demander le mode de transport</li>
          </ul>
        </section>

        <section className="cc-kpis cc-kpis--strip" aria-label="Statistiques appels">
          <div className="cc-kpi cc-kpi--strip">
            <span className="cc-kpi__lbl">Total</span>
            <span className="cc-kpi__num">{stats.total}</span>
          </div>
          <div className="cc-kpi cc-kpi--strip">
            <span className="cc-kpi__lbl">Aujourd&apos;hui</span>
            <span className="cc-kpi__num">{stats.today}</span>
          </div>
          <div className="cc-kpi cc-kpi--strip">
            <span className="cc-kpi__lbl">Motorisés</span>
            <span className="cc-kpi__num">{stats.motorise}</span>
          </div>
          <div className="cc-kpi cc-kpi--strip">
            <span className="cc-kpi__lbl">Non motorisés</span>
            <span className="cc-kpi__num">{stats.nonMotorise}</span>
          </div>
        </section>

        <section className="cc-filters" aria-label="Filtres appels">
          <div className="cc-filters__bar">
            <label className="cc-search cc-pill">
              <Search size={12} aria-hidden />
              <input
                type="text"
                placeholder="Rechercher client, telephone, projet..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="cc-filter-chip cc-filter-chip--date">
              <span className="cc-filter-chip__label">Date</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="cc-date-filter"
                title="Date de visite"
              />
            </div>
            <div className="cc-filter-chip">
              <span className="cc-filter-chip__label">Projet</span>
              <select
                className="cc-filter-select"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                title="Projet"
              >
                <option value="all">Tous projets</option>
                {PROJECT_OPTIONS.map((p) => (
                  <option key={p.id} value={p.title}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="cc-segment cc-pill" role="group" aria-label="Transport">
              <button type="button" className={transportFilter === 'all' ? 'on' : ''} onClick={() => setTransportFilter('all')}>
                Tous
              </button>
              <button
                type="button"
                className={transportFilter === 'motorise' ? 'on' : ''}
                onClick={() => setTransportFilter('motorise')}
              >
                Motorise
              </button>
              <button
                type="button"
                className={transportFilter === 'non-motorise' ? 'on' : ''}
                onClick={() => setTransportFilter('non-motorise')}
              >
                Non motorise
              </button>
            </div>
          </div>
        </section>

        <section className="cc-date-panel">
          <div className="cc-date-panel__head">
            <h2>
              <CalendarDays size={15} /> Date active
            </h2>
            <span>{new Date(selectedDate).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
          </div>
          <button type="button" className="cc-date-panel__open" onClick={() => navigate('/admin/call-center-calendar')}>
            Ouvrir la page calendrier
          </button>
        </section>

        <section className="cc-schedule">
          <div className="cc-schedule__head">
            <h2>
              <CalendarDays size={15} /> Planning d'aujourd'hui
            </h2>
            <span>{todayCalls.length} rendez-vous</span>
          </div>

          {todayCalls.length === 0 ? (
            <div className="cc-schedule__empty">Aucune visite prévue pour aujourd'hui.</div>
          ) : (
            <div className="cc-schedule__list">
              {todayCalls.map((call) => (
                <button key={call.id} type="button" className="cc-schedule__item" onClick={() => setDetail(call)}>
                  <span className="time">{call.time}</span>
                  <span className="meta">
                    <strong>{call.name}</strong>
                    <small>{call.project}</small>
                  </span>
                  <span className={`tag ${call.motorise ? 'ok' : 'warn'}`}>{call.motorise ? 'Motorisé' : 'Navette'}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="cc-list">
          {filteredCalls.length === 0 ? (
            <div className="zitu-page__empty">
              <strong>Aucun appel trouve</strong>
              Modifiez les filtres ou ajoutez un nouvel appel.
            </div>
          ) : (
            filteredCalls.map((call) => (
              <article key={call.id} className="cc-card" onClick={() => setDetail(call)}>
                <div className="cc-card__row">
                  <span className="cc-card__avatar">{initials(call.name)}</span>

                  <div className="cc-card__main">
                    <div className="cc-card__title-row">
                      <h3 className="cc-card__name">{call.name}</h3>
                      <span className={`cc-badge ${call.motorise ? 'cc-badge--ok' : 'cc-badge--warn'}`}>
                        {call.motorise ? (
                          <>
                            <Car size={10} /> Motorise
                          </>
                        ) : (
                          <>
                            <CarFront size={10} /> Non motorise
                          </>
                        )}
                      </span>
                    </div>

                    <div className="cc-card__sub">
                      <span className="cc-card__phone">
                        <Phone size={10} /> {call.phone}
                      </span>
                    </div>

                    <div className="cc-card__meta">
                      <span className="cc-card__meta-item">
                        <MapPin size={10} /> {call.project}
                      </span>
                      <span className="cc-card__meta-sep" aria-hidden>
                        ·
                      </span>
                      <span className="cc-card__meta-item">
                        <CalendarDays size={10} /> {fmtDateShort(call.date)} - {call.time}
                      </span>
                    </div>
                  </div>
                </div>

                {call.notes ? <div className="cc-card__note">{call.notes}</div> : null}
              </article>
            ))
          )}
        </section>
      </div>

      <AdminModal open={showForm} onClose={resetForm} title="Nouvel appel" width={680}>
        <div className="cc-modal-body">
          <section className="cc-form-block">
            <h3>Coordonnées client</h3>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Nom complet *</label>
              <input
                className="zitu-page__input"
                placeholder="Ex: Mohamed Ben Ali"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Telephone *</label>
              <input
                className="zitu-page__input"
                placeholder="+216 XX XXX XXX"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </div>
          </div>
          </section>

          <section className="cc-form-block">
            <h3>Détails de visite</h3>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Projet a visiter</label>
              <select
                className="zitu-page__input"
                value={form.project}
                onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}
              >
                {PROJECT_OPTIONS.map((p) => (
                  <option key={p.id} value={p.title}>
                    {p.title} - {p.city}
                  </option>
                ))}
              </select>
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Date de visite</label>
              <input
                className="zitu-page__input"
                type="date"
                value={form.date}
                min={todayIso()}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </div>
          </div>
          </section>

          <section className="cc-form-block">
            <h3>Heure et transport</h3>
          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Heure</label>
            <div className="cc-time-grid">
              {SLOT_OPTIONS.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  className={`cc-time ${form.time === slot ? 'cc-time--on' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, time: slot }))}
                >
                  <Clock3 size={12} /> {slot}
                </button>
              ))}
            </div>
          </div>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Transport</label>
            <div className="cc-transport-grid">
              <button
                type="button"
                className={`cc-transport ${form.motorise ? 'cc-transport--on' : ''}`}
                onClick={() => setForm((f) => ({ ...f, motorise: true }))}
              >
                <Car size={16} />
                <strong>Motorise</strong>
                <small>Vient par ses propres moyens</small>
              </button>
              <button
                type="button"
                className={`cc-transport ${!form.motorise ? 'cc-transport--on' : ''}`}
                onClick={() => setForm((f) => ({ ...f, motorise: false }))}
              >
                <Users size={16} />
                <strong>Non motorise</strong>
                <small>Navette / transport a prevoir</small>
              </button>
            </div>
          </div>
          </section>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Notes (optionnel)</label>
            <textarea
              className="zitu-page__input cc-textarea"
              rows={3}
              placeholder="Remarques, demandes specifiques..."
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>

          <div className="zitu-page__form-actions">
            <button type="button" className="zitu-page__btn" onClick={resetForm}>
              Annuler
            </button>
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--primary"
              disabled={!form.name.trim() || !form.phone.trim()}
              onClick={addCall}
            >
              Enregistrer
            </button>
          </div>
        </div>
      </AdminModal>

      <AdminModal open={!!detail} onClose={() => setDetail(null)} title="Detail de la visite" width={560}>
        {detail ? (
          <div className="cc-modal-body">
            <div className="cc-detail">
              <div className="cc-detail__row">
                <span><User size={12} /> Nom</span>
                <strong>{detail.name}</strong>
              </div>
              <div className="cc-detail__row">
                <span><Phone size={12} /> Telephone</span>
                <strong>{detail.phone}</strong>
              </div>
              <div className="cc-detail__row">
                <span><MapPin size={12} /> Projet</span>
                <strong>{detail.project}</strong>
              </div>
              <div className="cc-detail__row">
                <span><CalendarDays size={12} /> Date</span>
                <strong>{fmtDateFull(detail.date)}</strong>
              </div>
              <div className="cc-detail__row">
                <span><Clock3 size={12} /> Heure</span>
                <strong>{detail.time}</strong>
              </div>
              <div className="cc-detail__row">
                <span>Transport</span>
                <strong>{detail.motorise ? 'Motorise' : 'Non motorise'}</strong>
              </div>
              {detail.notes ? <div className="cc-detail__notes">{detail.notes}</div> : null}
            </div>

            <div className="zitu-page__form-actions">
              <a href={`tel:${detail.phone}`} className="zitu-page__btn zitu-page__btn--primary cc-call-btn">
                <Phone size={14} /> Appeler
              </a>
            </div>
          </div>
        ) : null}
      </AdminModal>
    </div>
  )
}
