import { useMemo, useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { projects } from '../projects.js'
import { mockRendezvousHours } from '../purchaseMandatData.js'
import { addVisitRequest } from '../visitRequestsStore.js'

function localISODate(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export default function PurchaseMandatPage() {
  const { id: projectId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()

  const plotIdsFromState = location.state?.plotIds

  const proj = projects.find((p) => p.id === projectId)

  const selectedPlots = useMemo(() => {
    if (!proj || !Array.isArray(plotIdsFromState) || plotIdsFromState.length === 0) return []
    const set = new Set(plotIdsFromState.map(Number))
    return proj.plots.filter((pl) => set.has(pl.id))
  }, [proj, plotIdsFromState])

  const [rendezvousDate, setRendezvousDate] = useState(() => localISODate())
  const [rendezvousHourId, setRendezvousHourId] = useState(mockRendezvousHours[0]?.id ?? '')

  const selectedHour = mockRendezvousHours.find((h) => h.id === rendezvousHourId) ?? mockRendezvousHours[0]

  const submitVisitRequest = () => {
    addVisitRequest({
      userName: 'Lassaad',
      projectId: projectId,
      projectTitle: proj.title,
      city: proj.city,
      region: proj.region,
      plotIds: selectedPlots.map((p) => p.id),
      date: rendezvousDate,
      slotId: rendezvousHourId,
      slotLabel: selectedHour?.label || '',
      slotHint: selectedHour?.hint || '',
    })
    navigate(`/project/${projectId}/visite/success`)
  }

  if (!proj) {
    return (
      <main className="screen screen--app">
        <section className="dashboard-page">
          <TopBar />
          <div className="empty-state">
            <p>Projet introuvable.</p>
            <button type="button" className="cta-primary" onClick={() => navigate('/browse')}>
              Retour
            </button>
          </div>
        </section>
      </main>
    )
  }

  if (selectedPlots.length === 0) {
    return (
      <main className="screen screen--app">
        <section className="dashboard-page">
          <TopBar />
          <div className="empty-state">
            <p>Aucune parcelle sélectionnée.</p>
            <button type="button" className="cta-primary" onClick={() => navigate(`/project/${projectId}`)}>
              Choisir des parcelles
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="screen screen--app">
      <section className="dashboard-page mandat-page">
        <TopBar />

        <p className="mandat-greeting">Bonjour, Lassaad</p>

        <div className="detail-nav">
          <button type="button" className="back-btn" onClick={() => navigate(`/project/${projectId}`)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Retour au projet
          </button>
        </div>

        <div className="mandat-card">
          <div className="mandat-card-header">
            <div className="mandat-card-header-inner">
              <h1 className="mandat-card-title">DEMANDE DE RENDEZ-VOUS DE VISITE (GROUPE S.A.)</h1>
            </div>
          </div>
          <div className="mandat-card-lead">
            <p className="mandat-card-sub">{proj.title} · {proj.city}, {proj.region}</p>
          </div>

          <section className="mandat-section mandat-section--light mandat-section--loc">
            <div className="mandat-loc-head-row">
              <h2 className="mandat-section-title mandat-section-title--with-icons mandat-loc-title">
                <span className="mandat-loc-icons" aria-hidden>
                  <span className="mandat-loc-ico">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </span>
                  <span className="mandat-loc-ico">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 2"><path d="M3 17c3-6 5-9 9-12 4 3 6 6 9 12"/></svg>
                  </span>
                </span>
                Localisation et état
              </h2>
              <span className="mandat-loc-drone-corner" aria-hidden title="Drone">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="5" cy="7" r="2" />
                  <circle cx="19" cy="7" r="2" />
                  <circle cx="5" cy="17" r="2" />
                  <circle cx="19" cy="17" r="2" />
                  <path d="M7 7h10M7 17h10M12 7v3M9 12h6M12 12v5" />
                </svg>
              </span>
            </div>
            <div className="mandat-loc-layout">
              <div className="mandat-map-mini">
                <iframe title={`Carte ${proj.city}`} src={proj.mapUrl} loading="lazy" allowFullScreen />
              </div>
              <div className="mandat-loc-fields">
                <div className="mandat-loc-block">
                  <span className="mandat-loc-lbl">Site de plantation</span>
                  <p className="mandat-loc-plain">{proj.city} — {proj.region}</p>
                </div>
                <div className="mandat-loc-block">
                  <span className="mandat-loc-lbl">État sanitaire</span>
                  <div className="mandat-loc-fakefield">Conforme</div>
                </div>
                <div className="mandat-loc-block mandat-loc-block--row">
                  <span className="mandat-loc-lbl">Statut GPS arbres</span>
                  <span className="mandat-loc-strong">Actif</span>
                </div>
                <div className="mandat-loc-block">
                  <span className="mandat-loc-lbl">Rapport de drone</span>
                  <div className="mandat-loc-fakefield">Validé (95%)</div>
                </div>
              </div>
            </div>
          </section>

          <section className="mandat-section mandat-section--light">
            <h2 className="mandat-section-title">
              <span className="mandat-section-ico-row" aria-hidden>
                <span className="mandat-section-ico mandat-section-ico--green">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                </span>
                <span className="mandat-section-ico mandat-section-ico--green">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </span>
              </span>
              Date et heure de la visite
            </h2>
            <div className="mandat-rdv-row">
              <div className="mandat-kv">
                <span className="mandat-kv-label">Date proposée</span>
                <input
                  type="date"
                  className="mandat-date-input"
                  value={rendezvousDate}
                  min="2020-01-01"
                  onChange={(e) => setRendezvousDate(e.target.value)}
                />
              </div>
              <div className="mandat-kv mandat-kv--creneau">
                <span className="mandat-kv-label">Créneau horaire</span>
                <div className="mandat-select-wrap">
                  <select
                    className="mandat-select mandat-select--creneau"
                    value={rendezvousHourId}
                    onChange={(e) => setRendezvousHourId(e.target.value)}
                    aria-describedby="mandat-creneau-hint"
                  >
                    {mockRendezvousHours.map((h) => (
                      <option key={h.id} value={h.id}>{h.label}</option>
                    ))}
                  </select>
                </div>
                <p id="mandat-creneau-hint" className="mandat-creneau-detail">
                  {selectedHour?.hint}
                </p>
              </div>
            </div>
          </section>

          <p className="mandat-team-note">
            <span className="mandat-team-note-title">Instructions à l&apos;équipe</span>
            Organiser la visite sur site avec le client à la date choisie et au créneau choisi ; les parcelles présélectionnées restent réservées le temps de la prise de contact.
          </p>

          <div className="mandat-actions">
            <button
              type="button"
              className="mandat-btn mandat-btn--gold mandat-btn--single"
              onClick={submitVisitRequest}
            >
              CONFIRMER LE RENDEZ-VOUS DE VISITE
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}
