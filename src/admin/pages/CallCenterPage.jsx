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

  // Counters for clearer empty states and filter indicator
  const activeFiltersCount = (projectFilter !== 'all' ? 1 : 0) + (transportFilter !== 'all' ? 1 : 0) + (search.trim() ? 1 : 0)
  const isSameDayAsToday = selectedDate === todayIso()
  const resetFilters = () => {
    setSearch('')
    setProjectFilter('all')
    setTransportFilter('all')
    setSelectedDate(todayIso())
  }

  return (
    <div className="zadm-page" dir="ltr">
      <header className="zadm-page__head">
        <div className="zadm-page__head-text">
          <button
            type="button"
            className="zadm-btn zadm-btn--ghost zadm-btn--sm"
            onClick={() => navigate('/admin')}
            title="Revenir au tableau de bord administrateur"
            aria-label="Retour au tableau de bord"
            style={{ marginBottom: 8, paddingLeft: 0 }}
          >
            <span aria-hidden>←</span> Retour
          </button>
          <h1 id="cc-hero-title" className="zadm-page__title">Centre d'appels CRM</h1>
          <p className="zadm-page__subtitle">
            Recevez l'appel, qualifiez le client, puis planifiez sa visite. Cliquez sur « Ajouter un appel » pour commencer.
          </p>
        </div>
        <div className="zadm-page__head-actions">
          <button
            type="button"
            className="zadm-btn zadm-btn--primary"
            onClick={() => setShowForm(true)}
            title="Ouvrir le formulaire d'enregistrement d'un nouvel appel entrant"
          >
            <Plus size={16} aria-hidden /> Ajouter un appel
          </button>
        </div>
      </header>

      <div className="zadm-page__body">
        <section className="cc-script cc-script--top" aria-label="Guide script opérateur">
          <div className="cc-script__head">
            <ClipboardList size={16} aria-hidden />
            <span>Guide de l'appel</span>
            <span className="cc-script__hint">Suivez ces 3 étapes pour chaque client.</span>
          </div>
          <p className="cc-script__greeting">
            « Bonjour, merci d'avoir contacté Zitouna. Je vais vous accompagner pour planifier votre visite. »
          </p>
          <ol className="cc-script__steps">
            <li><strong>1.</strong> Confirmer le nom complet et le numéro de téléphone.</li>
            <li><strong>2.</strong> Choisir le projet, la date et l'heure de la visite.</li>
            <li><strong>3.</strong> Demander le mode de transport (véhicule personnel ou navette).</li>
          </ol>
        </section>

        <section className="zadm-kpi-grid" aria-label="Statistiques des appels">
          <div className="zadm-kpi" title="Nombre total d'appels enregistrés dans le CRM">
            <span className="zadm-kpi__label">Total appels</span>
            <span className="zadm-kpi__value">{stats.total}</span>
          </div>
          <div className="zadm-kpi" title="Appels enregistrés aujourd'hui">
            <span className="zadm-kpi__label">Aujourd'hui</span>
            <span className="zadm-kpi__value">{stats.today}</span>
          </div>
          <div className="zadm-kpi" title="Clients venant avec leur propre véhicule">
            <span className="zadm-kpi__label">Motorisés</span>
            <span className="zadm-kpi__value">{stats.motorise}</span>
          </div>
          <div className="zadm-kpi" title="Clients nécessitant une navette">
            <span className="zadm-kpi__label">Navette</span>
            <span className="zadm-kpi__value">{stats.nonMotorise}</span>
          </div>
        </section>

        <section className="cc-filters" aria-label="Filtres des appels">
          <div className="cc-filters__intro">
            <strong>Rechercher et filtrer</strong>
            <span>Affinez la liste par nom, date, projet ou mode de transport.</span>
          </div>
          <div className="cc-filters__bar">
            <label className="cc-search cc-pill" title="Rechercher par nom, téléphone ou projet">
              <Search size={16} aria-hidden />
              <input
                type="text"
                placeholder="Rechercher un client, un téléphone ou un projet..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Rechercher un appel"
              />
            </label>
            <div className="cc-filter-chip cc-filter-chip--date" title="Filtrer par date de visite">
              <span className="cc-filter-chip__label">Date</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="cc-date-filter"
                aria-label="Date de visite"
              />
            </div>
            <div className="cc-filter-chip" title="Filtrer par projet immobilier">
              <span className="cc-filter-chip__label">Projet</span>
              <select
                className="cc-filter-select"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                aria-label="Projet"
              >
                <option value="all">Tous les projets</option>
                {PROJECT_OPTIONS.map((p) => (
                  <option key={p.id} value={p.title}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="cc-segment cc-pill" role="group" aria-label="Mode de transport">
              <button
                type="button"
                className={transportFilter === 'all' ? 'on' : ''}
                onClick={() => setTransportFilter('all')}
                title="Afficher tous les clients"
              >
                Tous
              </button>
              <button
                type="button"
                className={transportFilter === 'motorise' ? 'on' : ''}
                onClick={() => setTransportFilter('motorise')}
                title="Uniquement les clients motorisés"
              >
                Motorisé
              </button>
              <button
                type="button"
                className={transportFilter === 'non-motorise' ? 'on' : ''}
                onClick={() => setTransportFilter('non-motorise')}
                title="Uniquement les clients nécessitant une navette"
              >
                Navette
              </button>
            </div>
          </div>
          {activeFiltersCount > 0 ? (
            <div className="cc-filters__active">
              <span>{activeFiltersCount} filtre{activeFiltersCount > 1 ? 's' : ''} actif{activeFiltersCount > 1 ? 's' : ''}</span>
              <button type="button" className="cc-filters__reset" onClick={resetFilters}>
                Réinitialiser
              </button>
            </div>
          ) : null}
        </section>

        <section className="cc-date-panel" aria-label="Date sélectionnée">
          <div className="cc-date-panel__head">
            <h2>
              <CalendarDays size={18} aria-hidden /> Date sélectionnée
            </h2>
            <span>
              {new Date(selectedDate).toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
            </span>
          </div>
          <p className="cc-date-panel__hint">Pour une vue complète du calendrier et gérer plusieurs jours d'un coup.</p>
          <button
            type="button"
            className="cc-date-panel__open"
            onClick={() => navigate('/admin/call-center-calendar')}
            title="Accéder à la vue calendrier complète"
          >
            <CalendarDays size={16} aria-hidden /> Ouvrir le calendrier complet
          </button>
        </section>

        <section className="cc-schedule" aria-label="Planning du jour">
          <div className="cc-schedule__head">
            <h2>
              <CalendarDays size={18} aria-hidden /> Planning d'aujourd'hui
            </h2>
            <span className="cc-schedule__count">
              {todayCalls.length} visite{todayCalls.length > 1 ? 's' : ''}
            </span>
          </div>
          <p className="cc-schedule__hint">Visites prévues pour aujourd'hui, triées par heure. Cliquez pour voir le détail.</p>

          {todayCalls.length === 0 ? (
            <div className="cc-schedule__empty">
              <strong>Aucune visite prévue aujourd'hui.</strong>
              <span>
                {isSameDayAsToday
                  ? 'Utilisez « Ajouter un appel » pour créer un nouveau rendez-vous.'
                  : 'Réglez le filtre Date sur aujourd\'hui pour voir vos rendez-vous du jour.'}
              </span>
            </div>
          ) : (
            <div className="cc-schedule__list">
              {todayCalls.map((call) => (
                <button
                  key={call.id}
                  type="button"
                  className="cc-schedule__item"
                  onClick={() => setDetail(call)}
                  title={`Voir le détail de ${call.name}`}
                >
                  <span className="time">{call.time}</span>
                  <span className="meta">
                    <strong>{call.name}</strong>
                    <small>{call.project}</small>
                  </span>
                  <span className={`tag ${call.motorise ? 'ok' : 'warn'}`}>
                    {call.motorise ? 'Motorisé' : 'Navette'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="cc-list" aria-label="Liste des appels filtrés">
          <div className="cc-list__head">
            <h2>Tous les appels enregistrés</h2>
            <span>{filteredCalls.length} résultat{filteredCalls.length > 1 ? 's' : ''}</span>
          </div>
          {filteredCalls.length === 0 ? (
            <div className="cc-empty">
              <strong>Aucun appel ne correspond à vos critères.</strong>
              <span>Essayez de modifier les filtres ci-dessus ou ajoutez un nouvel appel pour démarrer.</span>
              <div className="cc-empty__actions">
                {activeFiltersCount > 0 ? (
                  <button type="button" className="cc-empty__btn" onClick={resetFilters}>
                    Réinitialiser les filtres
                  </button>
                ) : null}
                <button type="button" className="cc-empty__btn cc-empty__btn--primary" onClick={() => setShowForm(true)}>
                  <Plus size={14} aria-hidden /> Ajouter un appel
                </button>
              </div>
            </div>
          ) : (
            filteredCalls.map((call) => (
              <article
                key={call.id}
                className="cc-card"
                onClick={() => setDetail(call)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(call) }
                }}
                title={`Voir le détail de ${call.name}`}
              >
                <div className="cc-card__row">
                  <span className="cc-card__avatar" aria-hidden>{initials(call.name)}</span>

                  <div className="cc-card__main">
                    <div className="cc-card__title-row">
                      <h3 className="cc-card__name">{call.name}</h3>
                      <span className={`cc-badge ${call.motorise ? 'cc-badge--ok' : 'cc-badge--warn'}`}>
                        {call.motorise ? (
                          <>
                            <Car size={12} aria-hidden /> Motorisé
                          </>
                        ) : (
                          <>
                            <CarFront size={12} aria-hidden /> Navette
                          </>
                        )}
                      </span>
                    </div>

                    <div className="cc-card__sub">
                      <span className="cc-card__phone" title="Numéro de téléphone du client">
                        <Phone size={12} aria-hidden /> {call.phone}
                      </span>
                    </div>

                    <div className="cc-card__meta">
                      <span className="cc-card__meta-item" title="Projet concerné">
                        <MapPin size={12} aria-hidden /> {call.project}
                      </span>
                      <span className="cc-card__meta-sep" aria-hidden>·</span>
                      <span className="cc-card__meta-item" title="Date et heure de visite">
                        <CalendarDays size={12} aria-hidden /> {fmtDateShort(call.date)} — {call.time}
                      </span>
                    </div>
                  </div>
                </div>

                {call.notes ? <div className="cc-card__note" title="Note opérateur">{call.notes}</div> : null}
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
