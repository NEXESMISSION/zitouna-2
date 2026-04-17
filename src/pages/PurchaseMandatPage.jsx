import { useMemo, useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { usePublicProjectDetail, usePublicVisitSlotOptions } from '../lib/useSupabase.js'

function localISODate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

export default function PurchaseMandatPage() {
  const { id: projectId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const plotIdsFromState = location.state?.plotIds
  const { project: proj, loading } = usePublicProjectDetail(projectId)
  const { options: slotOptions, loading: slotsLoading } = usePublicVisitSlotOptions()

  const selectedPlots = useMemo(() => {
    if (!proj || !Array.isArray(plotIdsFromState) || plotIdsFromState.length === 0) return []
    const set = new Set(plotIdsFromState.map(Number))
    return proj.plots.filter(pl => set.has(pl.id))
  }, [proj, plotIdsFromState])

  const [rendezvousDate, setRendezvousDate] = useState(() => localISODate())
  const [rendezvousHourId, setRendezvousHourId] = useState('')
  // Derive the effective slot id instead of syncing state via an effect: when
  // the user hasn't picked yet (empty string), fall back to the first option.
  const effectiveHourId =
    rendezvousHourId || (slotOptions && slotOptions.length ? slotOptions[0].id : '')
  const selectedHour =
    slotOptions?.find((h) => h.id === effectiveHourId) ||
    (slotOptions && slotOptions.length ? slotOptions[0] : null)

  if (loading && !proj) {
    return (
      <main className="screen screen--app">
        <section className="dashboard-page">
          <TopBar />
          <div className="empty-state" style={{ padding: '3rem 1rem' }}>
            <div className="app-loader-spinner" style={{ margin: '0 auto 12px' }} />
            <p>Chargement…</p>
          </div>
        </section>
      </main>
    )
  }

  if (!proj) return (<main className="screen screen--app"><section className="dashboard-page"><TopBar /><div className="empty-state"><p>Projet introuvable.</p><button className="cta-primary" onClick={() => navigate('/browse')}>Retour</button></div></section></main>)
  if (selectedPlots.length === 0) return (<main className="screen screen--app"><section className="dashboard-page"><TopBar /><div className="empty-state"><p>Aucune parcelle sélectionnée.</p><button className="cta-primary" onClick={() => navigate(`/project/${projectId}`)}>Choisir des parcelles</button></div></section></main>)

  return (
    <main className="screen screen--app">
      <section className="dashboard-page mandat-page">
        <TopBar />
        <p className="mandat-greeting">Bonjour, Visiteur</p>
        <div className="detail-nav"><button type="button" className="back-btn" onClick={() => navigate(`/project/${projectId}`)}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>Retour au projet</button></div>

        <div className="mandat-card">
          <div className="mandat-card-header"><div className="mandat-card-header-inner"><h1 className="mandat-card-title">DEMANDE DE RENDEZ-VOUS DE VISITE</h1></div></div>
          <div className="mandat-card-lead"><p className="mandat-card-sub">{proj.title} · {proj.city}, {proj.region}</p></div>

          <section className="mandat-section mandat-section--light mandat-section--loc">
            <h2 className="mandat-section-title">Localisation et état</h2>
            <div className="mandat-loc-layout">
              <div className="mandat-map-mini"><iframe title={`Carte ${proj.city}`} src={proj.mapUrl} loading="lazy" allowFullScreen/></div>
              <div className="mandat-loc-fields">
                <div className="mandat-loc-block"><span className="mandat-loc-lbl">Site de plantation</span><p className="mandat-loc-plain">{proj.city} — {proj.region}</p></div>
                <div className="mandat-loc-block"><span className="mandat-loc-lbl">État sanitaire</span><div className="mandat-loc-fakefield">Conforme</div></div>
                <div className="mandat-loc-block mandat-loc-block--row"><span className="mandat-loc-lbl">Statut GPS arbres</span><span className="mandat-loc-strong">Actif</span></div>
                <div className="mandat-loc-block"><span className="mandat-loc-lbl">Rapport de drone</span><div className="mandat-loc-fakefield">Validé (95%)</div></div>
              </div>
            </div>
          </section>

          <section className="mandat-section mandat-section--light">
            <h2 className="mandat-section-title">Date et heure de la visite</h2>
            <div className="mandat-rdv-row">
              <div className="mandat-kv"><span className="mandat-kv-label">Date proposée</span><input type="date" className="mandat-date-input" value={rendezvousDate} min="2020-01-01" onChange={e => setRendezvousDate(e.target.value)}/></div>
              <div className="mandat-kv mandat-kv--creneau">
                <span className="mandat-kv-label">Créneau horaire</span>
                <div className="mandat-select-wrap">
                  <select
                    className="mandat-select mandat-select--creneau"
                    value={effectiveHourId}
                    disabled={slotsLoading || !slotOptions?.length}
                    onChange={(e) => setRendezvousHourId(e.target.value)}
                  >
                    {slotOptions?.map((h) => (
                      <option key={h.id} value={h.id}>{h.label}</option>
                    ))}
                  </select>
                </div>
                <p className="mandat-creneau-detail">{selectedHour?.hint || (slotsLoading ? 'Chargement…' : '—')}</p>
              </div>
            </div>
          </section>

          <div className="mandat-actions">
            <button type="button" className="mandat-btn mandat-btn--gold mandat-btn--single" onClick={() => navigate(`/project/${projectId}/visite/success`)}>
              CONFIRMER LE RENDEZ-VOUS DE VISITE
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}
