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

  // Local override of the incoming plotIds — lets the client re-pick parcels
  // on this screen via the "Sélection rapide" panel without navigating back.
  const [plotIdsOverride, setPlotIdsOverride] = useState(null)
  const effectivePlotIds = plotIdsOverride ?? plotIdsFromState

  const selectedPlots = useMemo(() => {
    if (!proj || !Array.isArray(effectivePlotIds) || effectivePlotIds.length === 0) return []
    const set = new Set(effectivePlotIds.map(Number))
    return proj.plots.filter(pl => set.has(pl.id))
  }, [proj, effectivePlotIds])

  // "Sélection rapide" panel state.
  const [quickPickOpen, setQuickPickOpen] = useState(false)
  const [quickPickCount, setQuickPickCount] = useState(1)
  const [quickPickMode, setQuickPickMode] = useState('adjacent')

  const availablePlotsSorted = useMemo(() => {
    if (!proj) return []
    return [...proj.plots]
      .filter(p => p.status === 'available')
      .sort((a, b) => Number(a.id) - Number(b.id))
  }, [proj])
  const quickPickMax = availablePlotsSorted.length
  // Derived clamp (avoids the set-state-in-effect lint rule).
  const clampedQuickPickCount = Math.max(1, Math.min(quickPickCount, Math.max(1, quickPickMax)))

  const runQuickPick = () => {
    const n = Math.max(1, Math.min(Number(clampedQuickPickCount) || 1, quickPickMax))
    if (quickPickMax === 0) return
    let chosen = []
    if (quickPickMode === 'adjacent') {
      const list = availablePlotsSorted
      const windows = []
      for (let i = 0; i + n <= list.length; i++) {
        let ok = true
        for (let k = 1; k < n; k++) {
          if (Number(list[i + k].id) !== Number(list[i + k - 1].id) + 1) { ok = false; break }
        }
        if (ok) windows.push(list.slice(i, i + n))
      }
      chosen = windows.length > 0
        ? windows[Math.floor(Math.random() * windows.length)]
        : list.slice(0, n)
    } else {
      const pool = [...availablePlotsSorted]
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t
      }
      chosen = pool.slice(0, n)
    }
    setPlotIdsOverride(chosen.map(pl => Number(pl.id)))
    setQuickPickOpen(false)
  }

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
          <div className="empty-state empty-state--loading-pad">
            <div className="app-loader-spinner empty-state__spinner-gap" />
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

          <section className="mandat-section mandat-section--light mandat-section--pt-sm">
            <div className="quickpick-header-row">
              <div>
                <h2 className="mandat-section-title mandat-section-title--tight">Parcelles retenues</h2>
                <p className="mandat-selected-plots">
                  {selectedPlots.length} parcelle{selectedPlots.length > 1 ? 's' : ''} ·{' '}
                  {selectedPlots.map(p => `#${p.label ?? p.id}`).join(', ')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setQuickPickOpen(v => !v)}
                disabled={quickPickMax === 0}
                aria-expanded={quickPickOpen}
                aria-controls="mandat-quickpick-panel"
                className={`quickpick-toggle-btn${quickPickOpen ? ' is-open' : ''}`}
                title={quickPickMax === 0 ? 'Aucune parcelle disponible' : 'Sélection rapide'}
              >
                <span aria-hidden>⚡</span>
                <span>Sélection rapide</span>
              </button>
            </div>
            {quickPickOpen && (
              <div
                id="mandat-quickpick-panel"
                role="group"
                aria-label="Sélection rapide de parcelles"
                className="quickpick-panel quickpick-panel--md"
              >
                <label className="quickpick-label">
                  Combien de parcelles ?
                  <input
                    type="number"
                    min={1}
                    max={quickPickMax || 1}
                    value={clampedQuickPickCount}
                    onChange={e => setQuickPickCount(Math.max(1, Math.min(quickPickMax || 1, Number(e.target.value) || 1)))}
                    className="quickpick-count-input"
                  />
                  <span className="quickpick-help-text">/ {quickPickMax} dispo.</span>
                </label>
                <div role="radiogroup" aria-label="Mode de sélection" className="quickpick-radio-group">
                  <label className="quickpick-radio-label">
                    <input type="radio" name="mandat-quickpick-mode" value="adjacent" checked={quickPickMode === 'adjacent'} onChange={() => setQuickPickMode('adjacent')} />
                    Adjacentes (côte à côte)
                  </label>
                  <label className="quickpick-radio-label">
                    <input type="radio" name="mandat-quickpick-mode" value="random" checked={quickPickMode === 'random'} onChange={() => setQuickPickMode('random')} />
                    Aléatoires
                  </label>
                </div>
                <div className="quickpick-actions">
                  <button type="button" onClick={() => setQuickPickOpen(false)} className="quickpick-btn quickpick-btn--ghost">Annuler</button>
                  <button type="button" onClick={runQuickPick} disabled={quickPickMax === 0} className="quickpick-btn quickpick-btn--primary">Sélectionner</button>
                </div>
              </div>
            )}
          </section>

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
