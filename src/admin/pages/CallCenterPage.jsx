import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AdminModal from '../components/AdminModal.jsx'
import { useToast } from '../components/AdminToast.jsx'
import { useProjects } from '../../lib/useSupabase.js'
import {
  useCalls,
  callStore,
  initials,
  fmtDateFull,
  fmtDateShort,
  todayIso,
  SLOT_OPTIONS,
} from './commercialStore.js'
import { getPagerPages } from './pager-util.js'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { SkeletonCard } from '../../components/skeletons/index.js'
import './sell-field.css'
import './call-center-page.css'

const CALLS_PER_PAGE = 15

export default function CallCenterPage() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const calls = useCalls()
  const { projects } = useProjects()
  // `useCalls` is a sync external-store hook with no `loading` flag; gate the
  // initial skeleton on a brief first-mount window so the page doesn't flash
  // an empty state before `refreshCalls()` resolves.
  const [initialCallsLoad, setInitialCallsLoad] = useState(true)
  useEffect(() => {
    // Initial-load window: skeleton hides once calls arrive OR after 1500ms.
    // setState-in-effect is intentional here — this is a one-shot boot gate.
    if (calls.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInitialCallsLoad(false)
      return
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    const id = setTimeout(() => setInitialCallsLoad(false), 1500)
    return () => clearTimeout(id)
  }, [calls.length])
  const PROJECT_OPTIONS = useMemo(
    () => projects.map((p) => ({ id: p.id, title: p.title, city: p.city })),
    [projects],
  )

  const [search, setSearch] = useState('')
  const [projectFilter, setProjectFilter] = useState('all')
  const [transportFilter, setTransportFilter] = useState('all')
  const [selectedDate, setSelectedDate] = useState(todayIso())
  const [showForm, setShowForm] = useState(false)
  const [detail, setDetail] = useState(null)
  const [page, setPage] = useState(1)
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
      addToast('Nom et téléphone obligatoires.', 'error')
      return
    }
    await callStore.add({
      ...form,
      name: form.name.trim(),
      phone: form.phone.trim(),
      notes: form.notes.trim(),
    })
    addToast('Appel enregistré avec succès.', 'success')
    resetForm()
  }

  const activeFiltersCount =
    (projectFilter !== 'all' ? 1 : 0) +
    (transportFilter !== 'all' ? 1 : 0) +
    (search.trim() ? 1 : 0)
  const isSameDayAsToday = selectedDate === todayIso()
  const resetFilters = () => {
    setSearch('')
    setProjectFilter('all')
    setTransportFilter('all')
    setSelectedDate(todayIso())
    setPage(1)
  }

  // Pagination (apply to "Tous les appels" list only).
  const pageCount = Math.max(1, Math.ceil(filteredCalls.length / CALLS_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pagedCalls = useMemo(
    () => filteredCalls.slice((safePage - 1) * CALLS_PER_PAGE, safePage * CALLS_PER_PAGE),
    [filteredCalls, safePage],
  )
  const onSearchChange = (e) => { setSearch(e.target.value); setPage(1) }
  // Plan 03 §6.3 — the skeleton should gate on calls data, not on projects
  // (which is a filter-dropdown concern). Projects loading is handled inline
  // in the dropdown as a brief disabled state.
  const showSkeletons = initialCallsLoad && calls.length === 0

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate('/admin')}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero cc-hero">
        <div className="sp-hero__avatar cc-hero__icon" aria-hidden><span>📞</span></div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Centre d'appels</h1>
          <p className="sp-hero__role">Qualifiez puis planifiez la visite</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : stats.today}
          </span>
          <span className="sp-hero__kpi-label">aujourd'hui</span>
        </div>
      </header>

      <button type="button" className="sp-cta-btn" onClick={() => setShowForm(true)}>
        <span className="sp-cta-btn__icon">+</span>
        <span className="sp-cta-btn__text">Ajouter un appel</span>
        <span className="sp-cta-btn__arrow">→</span>
      </button>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats cc-cat-stats">
          <strong>{showSkeletons ? <span className="sk-num" /> : stats.total}</strong> total
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : stats.today}</strong> aujourd'hui
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : stats.motorise}</strong> motorisés
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : stats.nonMotorise}</strong> navette
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Rechercher nom, téléphone, projet…"
            aria-label="Rechercher un appel"
            value={search}
            onChange={onSearchChange}
          />
        </div>
      </div>

      {/* Secondary filter row: date, project, transport */}
      <div className="cc-filter-row">
        <label className="cc-filter-chip" title="Filtrer par date">
          <span>Date</span>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => { setSelectedDate(e.target.value); setPage(1) }}
            aria-label="Date de visite"
          />
        </label>
        <label className="cc-filter-chip" title="Filtrer par projet">
          <span>Projet</span>
          <select
            value={projectFilter}
            onChange={(e) => { setProjectFilter(e.target.value); setPage(1) }}
            aria-label="Projet"
          >
            <option value="all">Tous</option>
            {PROJECT_OPTIONS.map((p) => <option key={p.id} value={p.title}>{p.title}</option>)}
          </select>
        </label>
        <div className="cc-segment" role="group" aria-label="Transport">
          {[['all','Tous'],['motorise','Motorisé'],['non-motorise','Navette']].map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              className={`cc-segment__btn${transportFilter === k ? ' cc-segment__btn--on' : ''}`}
              onClick={() => { setTransportFilter(k); setPage(1) }}
            >
              {lbl}
            </button>
          ))}
        </div>
        {activeFiltersCount > 0 && (
          <button type="button" className="cc-filter-reset" onClick={resetFilters}>
            Réinitialiser
          </button>
        )}
      </div>

      {/* Today's schedule — only shown when current date is today */}
      {isSameDayAsToday && todayCalls.length > 0 && (
        <div className="cc-today">
          <div className="cc-today__head">
            <strong>Planning d'aujourd'hui</strong>
            <span>{todayCalls.length} visite{todayCalls.length > 1 ? 's' : ''}</span>
          </div>
          <div className="cc-today__list">
            {todayCalls.map((call) => (
              <button
                key={`td-${call.id}`}
                type="button"
                className="cc-today__item"
                onClick={() => setDetail(call)}
              >
                <span className="cc-today__time">{call.time}</span>
                <div className="cc-today__meta">
                  <strong>{call.name}</strong>
                  <small>{call.project}</small>
                </div>
                <span className={`sp-badge sp-badge--${call.motorise ? 'green' : 'orange'}`}>
                  {call.motorise ? 'Motorisé' : 'Navette'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="sp-cards">
        <RenderDataGate
          loading={showSkeletons}
          data={calls}
          skeleton={<SkeletonCard cards={5} />}
          isEmpty={() => filteredCalls.length === 0}
          empty={
            <EmptyState
              icon={activeFiltersCount > 0 || !isSameDayAsToday ? '🔍' : '📞'}
              title={calls.length === 0 ? 'Aucun appel enregistré.' : 'Aucun résultat.'}
              description={
                calls.length === 0
                  ? 'Cliquez sur « Ajouter un appel » pour enregistrer une première visite.'
                  : 'Essayez de modifier les filtres ou réinitialisez-les.'
              }
              action={
                activeFiltersCount > 0
                  ? { label: 'Réinitialiser', onClick: resetFilters }
                  : null
              }
            />
          }
        >
          {() => pagedCalls.map((call) => (
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
              <div className="sp-card__info">
                <span>{fmtDateShort(call.date)}</span>
              </div>
            </div>
            {call.notes && <p className="cc-card__note">{call.notes}</p>}
          </button>
        ))}
        </RenderDataGate>
      </div>

      {!showSkeletons && filteredCalls.length > CALLS_PER_PAGE && (
        <div className="sp-pager" role="navigation" aria-label="Pagination">
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage <= 1}
            onClick={() => setPage(Math.max(1, safePage - 1))}
            aria-label="Page précédente"
          >‹</button>
          {getPagerPages(safePage, pageCount).map((p, i) =>
            p === '…' ? (
              <span key={`dots-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
            ) : (
              <button
                key={p}
                type="button"
                className={`sp-pager__btn${p === safePage ? ' sp-pager__btn--active' : ''}`}
                onClick={() => setPage(p)}
                aria-current={p === safePage ? 'page' : undefined}
              >{p}</button>
            ),
          )}
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage >= pageCount}
            onClick={() => setPage(Math.min(pageCount, safePage + 1))}
            aria-label="Page suivante"
          >›</button>
          <span className="sp-pager__info">
            {(safePage - 1) * CALLS_PER_PAGE + 1}–{Math.min(safePage * CALLS_PER_PAGE, filteredCalls.length)} / {filteredCalls.length}
          </span>
        </div>
      )}

      {/* New call form */}
      <AdminModal open={showForm} onClose={resetForm} title="Nouvel appel">
        <div className="cc-form">
          <div className="cc-form__row cc-form__row--2">
            <label className="cc-form__field">
              <span>Nom complet *</span>
              <input
                className="cc-form__input"
                placeholder="Ex : Mohamed Ben Ali"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="cc-form__field">
              <span>Téléphone *</span>
              <input
                className="cc-form__input"
                placeholder="+216 XX XXX XXX"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </label>
          </div>

          <div className="cc-form__row cc-form__row--2">
            <label className="cc-form__field">
              <span>Projet</span>
              <select
                className="cc-form__input"
                value={form.project}
                onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}
              >
                {PROJECT_OPTIONS.map((p) => (
                  <option key={p.id} value={p.title}>{p.title} — {p.city}</option>
                ))}
              </select>
            </label>
            <label className="cc-form__field">
              <span>Date</span>
              <input
                className="cc-form__input"
                type="date"
                value={form.date}
                min={todayIso()}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </label>
          </div>

          <div className="cc-form__field">
            <span>Heure</span>
            <div className="cc-slots">
              {SLOT_OPTIONS.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  className={`cc-slot${form.time === slot ? ' cc-slot--on' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, time: slot }))}
                >
                  {slot}
                </button>
              ))}
            </div>
          </div>

          <div className="cc-form__field">
            <span>Transport</span>
            <div className="cc-transport">
              <button
                type="button"
                className={`cc-transport__btn${form.motorise ? ' cc-transport__btn--on' : ''}`}
                onClick={() => setForm((f) => ({ ...f, motorise: true }))}
              >
                <strong>Motorisé</strong>
                <small>Vient par ses propres moyens</small>
              </button>
              <button
                type="button"
                className={`cc-transport__btn${!form.motorise ? ' cc-transport__btn--on' : ''}`}
                onClick={() => setForm((f) => ({ ...f, motorise: false }))}
              >
                <strong>Navette</strong>
                <small>Transport à prévoir</small>
              </button>
            </div>
          </div>

          <label className="cc-form__field">
            <span>Notes (optionnel)</span>
            <textarea
              className="cc-form__input cc-form__textarea"
              rows={3}
              placeholder="Remarques, demandes spécifiques…"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </label>

          <div className="cc-form__actions">
            <button type="button" className="cc-btn" onClick={resetForm}>Annuler</button>
            <button
              type="button"
              className="cc-btn cc-btn--primary"
              disabled={!form.name.trim() || !form.phone.trim()}
              onClick={addCall}
            >
              Enregistrer
            </button>
          </div>
        </div>
      </AdminModal>

      {/* Call detail */}
      {detail && (
        <AdminModal open onClose={() => setDetail(null)} title="">
          <div className="sp-detail">
            <div className="sp-detail__banner cc-detail__banner">
              <div className="sp-detail__banner-top">
                <span className={`sp-badge sp-badge--${detail.motorise ? 'green' : 'orange'}`}>
                  {detail.motorise ? 'Motorisé' : 'Navette'}
                </span>
                <span className="sp-detail__date">{fmtDateFull(detail.date)}</span>
              </div>
              <div className="sp-detail__price">
                <span className="sp-detail__price-num">{detail.time}</span>
                <span className="sp-detail__price-cur">h</span>
              </div>
              <p className="sp-detail__banner-sub">{detail.name} · {detail.project}</p>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Client</div>
              <div className="sp-detail__row"><span>Nom</span><strong>{detail.name}</strong></div>
              <div className="sp-detail__row">
                <span>Téléphone</span>
                <strong style={{ direction: 'ltr' }}>{detail.phone}</strong>
              </div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Visite</div>
              <div className="sp-detail__row"><span>Projet</span><strong>{detail.project}</strong></div>
              <div className="sp-detail__row"><span>Date</span><strong>{fmtDateFull(detail.date)}</strong></div>
              <div className="sp-detail__row"><span>Heure</span><strong>{detail.time}</strong></div>
              <div className="sp-detail__row">
                <span>Transport</span>
                <strong>{detail.motorise ? 'Motorisé' : 'Navette'}</strong>
              </div>
            </div>

            {detail.notes && (
              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Notes</div>
                <p className="cc-detail__notes">{detail.notes}</p>
              </div>
            )}

            <div className="sp-detail__actions">
              <a
                href={`tel:${detail.phone}`}
                className="sp-detail__btn sp-detail__btn--edit cc-call"
              >
                📞 Appeler
              </a>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
