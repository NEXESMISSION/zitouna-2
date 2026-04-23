import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { usePublicProjectDetail } from '../lib/useSupabase.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import DashboardShell from '../components/DashboardShell.jsx'
import { fetchPublicProjectHarvests, fetchPublicProjectEvents } from '../lib/db.js'
import './dashboard-page.css'

const CONTACT = {
  phone: '+216 22 543 987',
  whatsapp: '21622543987',
  email: 'contact@zitounabladi.tn',
}

const EVENT_KIND_LABELS = {
  planting: 'Plantation',
  pruning: 'Taille',
  irrigation: 'Irrigation',
  treatment: 'Traitement',
  harvest: 'Récolte',
  note: 'Événement',
}

const HARVEST_STATUS_LABELS = {
  planned: 'Prévue',
  in_progress: 'En cours',
  harvested: 'Récoltée',
  distributed: 'Distribuée',
  cancelled: 'Annulée',
}

function ProjectPageSkeleton() {
  return (
    <div className="pd-shell" aria-busy="true" aria-live="polite">
      <div className="pd-kpi-rail">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pd-kpi-cell" style={{ opacity: 0.5 }}>
            <div className="sk sk-line" style={{ width: '60%' }} />
            <div className="sk sk-line" style={{ width: '80%' }} />
          </div>
        ))}
      </div>
      <div className="pd-layout">
        <div className="pd-card" style={{ minHeight: 480, background: '#ECECEC' }} />
        <aside className="pd-side">
          <div className="pd-card" style={{ minHeight: 280 }} />
        </aside>
      </div>
    </div>
  )
}

function ProjectPageBody({ project: proj }) {
  const navigate = useNavigate()
  const [harvests, setHarvests] = useState([])
  const [events, setEvents] = useState([])
  const [calcSurface, setCalcSurface] = useState(100)
  const [openFaq, setOpenFaq] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [h, e] = await Promise.all([
          fetchPublicProjectHarvests(proj.id),
          fetchPublicProjectEvents(proj.id, { limit: 12 }),
        ])
        if (cancelled) return
        setHarvests(h)
        setEvents(e)
      } catch (err) {
        console.warn('[ProjectPage] harvests/events fetch failed', err?.message || err)
      }
    })()
    return () => { cancelled = true }
  }, [proj.id])

  const publicPlots = proj.plots.filter((p) => p.status === 'available')
  const availablePlotCount = publicPlots.length
  const totalPlots = (proj.plots || []).length
  const soldPlots = totalPlots - availablePlotCount
  const soldPct = totalPlots > 0 ? Math.round((soldPlots / totalPlots) * 100) : 0
  const totalArea = (proj.plots || []).reduce((s, p) => s + (Number(p.area) || 0), 0)
  const availableArea = publicPlots.reduce((s, p) => s + (Number(p.area) || 0), 0)
  // Each parcel owns its own trees. Project total = sum of parcel counts.
  const totalTrees = (proj.plots || []).reduce((s, p) => s + (Number(p.trees) || 0), 0)
    || Number(proj.totalTrees) || 0
  const currentYear = new Date().getFullYear()

  // Health scores — admin-entered on the project. Used by the "Santé du
  // projet" block.
  const healthScores = [
    { id: 'trees', label: 'Santé des arbres', value: proj.treeHealthPct, icon: 'tree' },
    { id: 'humidity', label: 'Humidité du sol', value: proj.soilHumidityPct, icon: 'drop' },
    { id: 'nutrients', label: 'Nutriments', value: proj.nutrientsPct, icon: 'seed' },
  ].filter((h) => h.value != null && Number.isFinite(Number(h.value)))
  const scoreTier = (v) => {
    const n = Number(v) || 0
    if (n >= 85) return { label: 'Excellent', className: 'pd-health--great' }
    if (n >= 70) return { label: 'Bon', className: 'pd-health--good' }
    if (n >= 50) return { label: 'Moyen', className: 'pd-health--fair' }
    return { label: 'Critique', className: 'pd-health--low' }
  }

  // Per-parcel cohorts aggregated to project level for the inventory chart.
  const batches = (() => {
    const map = new Map()
    for (const plot of proj.plots || []) {
      for (const b of plot.treeBatches || []) {
        const key = String(b.year)
        map.set(key, (map.get(key) || 0) + (Number(b.count) || 0))
      }
    }
    if (map.size > 0) {
      return Array.from(map.entries())
        .map(([year, count]) => ({ year: Number(year), count }))
        .sort((a, b) => a.year - b.year)
    }
    if (Array.isArray(proj.treeBatches) && proj.treeBatches.length) {
      return proj.treeBatches
        .map((b) => ({ year: Number(b?.year) || currentYear, count: Number(b?.count) || 0 }))
        .filter((b) => b.count > 0)
        .sort((a, b) => a.year - b.year)
    }
    return []
  })()

  // Cultivar distribution (legacy — only the old per-parcel batches carry
  // cultivar). Empty for project-level cohorts unless re-modelled later.
  const cultivarMap = new Map()
  for (const plot of proj.plots || []) {
    for (const b of plot.treeBatches || []) {
      const key = b.cultivar || 'Variété mixte'
      cultivarMap.set(key, (cultivarMap.get(key) || 0) + (Number(b.count) || 0))
    }
  }
  const cultivarDist = Array.from(cultivarMap.entries())
    .map(([cultivar, count]) => ({ cultivar, count }))
    .sort((a, b) => b.count - a.count)
  const cultivarColors = ['#4A7043', '#6FA36A', '#B7791F', '#1E5CFF', '#6B7280']
  const cultivarTotal = cultivarDist.reduce((s, c) => s + c.count, 0) || 1

  const formatArea = (m2) => {
    if (m2 >= 10000) return { value: (m2 / 10000).toFixed(m2 % 10000 === 0 ? 0 : 2).replace(/\.?0+$/, ''), unit: 'ha' }
    return { value: m2.toLocaleString('fr-FR'), unit: 'm²' }
  }
  const surfaceDisp = formatArea(totalArea)

  const upcomingHarvest = harvests.find((h) => h.status === 'planned' || h.status === 'in_progress')
  const pastHarvests = harvests.filter((h) => h.status === 'harvested' || h.status === 'distributed')

  // Maturity curve (same default as plotAnnualRevenue in db.js).
  const yieldAtAge = (age) => {
    if (age < 3) return 0
    if (age < 6) return 45
    if (age < 10) return 75
    return 90
  }
  const steadyYield = Array.from({ length: 10 }, (_, i) => {
    const year = currentYear + i
    return batches.reduce((s, b) => s + b.count * yieldAtAge(year - b.year), 0)
  }).reduce((a, b) => Math.max(a, b), 0)

  const plantedBatches = batches.filter((b) => b.year <= currentYear)
  const plantedTotalTrees = plantedBatches.reduce((s, b) => s + b.count, 0) || 1
  const avgTreeAge = Math.round(
    plantedBatches.reduce((s, b) => s + (currentYear - b.year) * b.count, 0) / plantedTotalTrees,
  )
  const firstBatchYear = batches[0]?.year ?? currentYear
  const inventoryYearLabel = firstBatchYear <= currentYear ? `${firstBatchYear}` : `Plantation ${firstBatchYear}`
  const inventoryCaption = avgTreeAge <= 0
    ? 'Plantés cette saison'
    : `Âge moyen : ${avgTreeAge} an${avgTreeAge > 1 ? 's' : ''}`

  // Pricing.
  const totalValueTnd = (proj.plots || []).reduce((s, p) => s + (Number(p.totalPrice) || 0), 0)
  const pricePerM2 = totalArea > 0 ? totalValueTnd / totalArea : 0
  const yieldPerM2PerYear = totalArea > 0 ? steadyYield / totalArea : 0
  const MIN_SURFACE = 50
  const MAX_SURFACE_CAP = 500
  const maxSurface = Math.min(MAX_SURFACE_CAP, Math.max(MIN_SURFACE, Math.round(availableArea || totalArea) || MIN_SURFACE))
  const boundedCalcSurface = Math.max(MIN_SURFACE, Math.min(calcSurface || MIN_SURFACE, maxSurface))
  const calcShare = totalArea > 0 ? (boundedCalcSurface / totalArea) * 100 : 0
  const calcInvest = Math.round(boundedCalcSurface * pricePerM2)
  const calcRevenue = Math.round(boundedCalcSurface * yieldPerM2PerYear)
  const whatsappMsg = encodeURIComponent(`Bonjour, je suis intéressé par le projet "${proj.title}" à ${proj.city}.`)

  const faqs = [
    {
      q: 'Que se passe-t-il si un olivier meurt ?',
      a: 'Chaque arbre est couvert par notre garantie de remplacement. En cas de perte, un nouvel olivier est planté sans frais supplémentaires pour vous.',
    },
    {
      q: 'Puis-je visiter ma parcelle quand je veux ?',
      a: "Oui. Vous pouvez organiser une visite avec notre équipe à tout moment pendant les heures d'ouverture. Contactez-nous pour réserver un créneau.",
    },
    {
      q: 'Comment sont fixés les prix et le rendement ?',
      a: "Le prix au m² et le rendement estimé sont fixés par projet, selon la variété d'olivier, l'âge des arbres et l'historique de production local.",
    },
    {
      q: 'Puis-je revendre ma part ?',
      a: "Oui. Après un délai initial, votre part peut être revendue à un autre investisseur ou rachetée par l'opérateur, selon les conditions du contrat.",
    },
  ]

  return (
    <div className="pd-shell">
      {/* Breadcrumb */}
      <div className="pd-breadcrumb">
        <button type="button" onClick={() => navigate('/browse')}>Explorer</button>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 6l6 6-6 6"/></svg>
        <span>{proj.city}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 6l6 6-6 6"/></svg>
        <b>{proj.title}</b>
      </div>

      {/* ═══ HEADER — kicker, title, meta chips, actions ═══ */}
      <header className="pd-head">
        <div className="pd-head-left">
          <div className="pd-eyebrow">Projet foncier{proj.year ? ` · ${proj.year}` : ''}</div>
          <h1 className="pd-title">{proj.title}</h1>
          <div className="pd-meta">
            <span className="pd-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 22s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>
              {proj.city}{proj.region ? ` · ${proj.region}` : ''}
            </span>
            <span className="pd-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>
              {surfaceDisp.value} {surfaceDisp.unit}
            </span>
            <span className="pd-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2c3 4 5 7 5 10a5 5 0 0 1-10 0c0-3 2-6 5-10z"/></svg>
              {totalTrees.toLocaleString('fr-FR')} oliviers
            </span>
            {(proj.bio_certified || proj.bioCertified) ? (
              <span className="pd-chip pd-chip--ok">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12l5 5 9-11"/></svg>
                Certifié Bio{proj.certification_body || proj.certificationBody ? ` — ${proj.certification_body || proj.certificationBody}` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <div className="pd-head-actions">
          <a className="pd-btn pd-btn-primary" href={`https://wa.me/${CONTACT.whatsapp}?text=${whatsappMsg}`} target="_blank" rel="noopener noreferrer">
            Nous contacter
          </a>
        </div>
      </header>

      {/* ═══ KPI RAIL — 4 tiles ═══ */}
      <div className="pd-kpi-rail">
        <div className="pd-kpi-cell">
          <div className="pd-kpi-k">Âge moyen des arbres</div>
          <div className="pd-kpi-v">
            {avgTreeAge}<span className="pd-kpi-u">an{avgTreeAge !== 1 ? 's' : ''}</span>
          </div>
          <div className="pd-kpi-delta">
            {avgTreeAge <= 0 ? 'Plantation cette saison' : `Depuis ${firstBatchYear}`}
          </div>
        </div>
        <div className="pd-kpi-cell">
          <div className="pd-kpi-k">Rendement estimé</div>
          <div className="pd-kpi-v">
            {yieldPerM2PerYear.toFixed(2).replace('.', ',')}
            <span className="pd-kpi-u">DT / m² / an</span>
          </div>
        </div>
        <div className="pd-kpi-cell pd-kpi-cell--rich">
          <div className="pd-kpi-k">Disponibilité</div>
          {totalPlots > 0 ? (
            <>
              <p className="pd-kpi-desc">
                {soldPct}% des parts ont déjà trouvé preneur. Réservez la vôtre avant la fermeture du projet.
              </p>
              <div className="pd-avail">
                <div className="pd-avail-row">
                  <span className="pd-avail-pct">{soldPct}% vendu</span>
                </div>
                <div className="pd-avail-bar"><span style={{ width: `${soldPct}%` }} /></div>
                <div className="pd-avail-foot">
                  <span>{availablePlotCount} part{availablePlotCount !== 1 ? 's' : ''} encore disponible{availablePlotCount !== 1 ? 's' : ''}</span>
                  <span>{proj.year ? `Projet lancé en ${proj.year}` : ''}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="pd-kpi-v">
              <span className="pd-kpi-u">Bientôt disponible</span>
            </div>
          )}
        </div>
      </div>

      {/* ═══ TWO-COLUMN LAYOUT — main + sticky side panel ═══ */}
      <div className="pd-layout">

        {/* ─── MAIN COLUMN ─── */}
        <div className="pd-main">

          {/* Map card */}
          <div className="pd-card pd-map-card">
            <div className="pd-map-wrap">
              {proj.mapUrl ? (
                <iframe title={`Carte ${proj.city}`} src={proj.mapUrl} loading="lazy" allowFullScreen />
              ) : (
                <div className="pd-map-fallback" />
              )}
              <div className="pd-map-tags">
                <span className="pd-map-tag pd-map-tag--active">Foncier</span>
                <span className="pd-map-tag">Satellite</span>
                <span className="pd-map-tag">Parcelles</span>
              </div>
              <div className="pd-map-legend">
                <span className="pd-map-legend-it"><span className="pd-map-sw" style={{ background: '#1E5CFF' }} /> Parcelle du projet</span>
                <span className="pd-map-legend-it"><span className="pd-map-sw" style={{ background: '#6FA36A' }} /> Oliviers plantés</span>
                <span className="pd-map-legend-it"><span className="pd-map-sw" style={{ background: '#D5DECF' }} /> Terres voisines</span>
              </div>
            </div>
            <div className="pd-map-info">
              <span>Localisation : <b>{proj.city}{proj.region ? ` · ${proj.region}` : ''}</b></span>
              <span className="pd-map-gps">{proj.address || '—'}</span>
            </div>
          </div>

          {/* Health — Santé du projet */}
          {healthScores.length > 0 && (
            <div className="pd-card pd-health-card">
              <div className="pd-health-head">
                <span className="pd-health-star">✦</span>
                <h2>Santé du projet</h2>
              </div>
              <div className="pd-health-grid">
                {healthScores.map((h) => {
                  const tier = scoreTier(h.value)
                  return (
                    <div key={h.id} className={`pd-health-cell ${tier.className}`}>
                      <div className="pd-health-ic">
                        {h.icon === 'tree' ? (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 3c4 3 6 7 6 11a6 6 0 0 1-12 0c0-4 2-8 6-11z" />
                            <path d="M12 14v6" />
                          </svg>
                        ) : h.icon === 'drop' ? (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 3c4 5 7 9 7 12a7 7 0 0 1-14 0c0-3 3-7 7-12z" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 22V8" />
                            <path d="M5 12a7 7 0 0 1 7-4 7 7 0 0 1 7 4" />
                            <path d="M12 14c-2-3-4-4-7-4M12 14c2-3 4-4 7-4" />
                          </svg>
                        )}
                      </div>
                      <div className="pd-health-v">{Math.round(Number(h.value) || 0)}%</div>
                      <div className="pd-health-k">{h.label}</div>
                      <div className="pd-health-tier">{tier.label}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Single card with stacked sections */}
          <div className="pd-card">

            {/* Simulator */}
            {yieldPerM2PerYear > 0 && pricePerM2 > 0 && (
              <section className="pd-section">
                <h2>Simulez votre investissement</h2>
                <p className="pd-section-s">Ajustez la surface — nous calculons votre part, votre investissement et le revenu annuel estimé à pleine maturité.</p>

                <div className="pd-sim-input">
                  <div className="pd-sim-label">
                    <span>Surface souhaitée</span>
                    <b>{boundedCalcSurface.toLocaleString('fr-FR')} m²</b>
                  </div>
                  <input
                    type="range"
                    min={MIN_SURFACE}
                    max={maxSurface}
                    step={10}
                    value={boundedCalcSurface}
                    onChange={(e) => setCalcSurface(Number(e.target.value))}
                    className="pd-sim-range"
                  />
                  <div className="pd-sim-range-legend">
                    <span>{MIN_SURFACE} m²</span>
                    <span>{maxSurface} m² · {Math.round(availableArea || totalArea).toLocaleString('fr-FR')} m² dispo</span>
                  </div>
                </div>

                <div className="pd-sim-out">
                  <div className="pd-sim-out-cell">
                    <div className="pd-k">Votre part</div>
                    <div className="pd-sim-v">{calcShare.toFixed(2).replace('.', ',')}%</div>
                    <div className="pd-s">{boundedCalcSurface} / {Math.round(totalArea).toLocaleString('fr-FR')} m²</div>
                  </div>
                  <div className="pd-sim-out-cell">
                    <div className="pd-k">Investissement</div>
                    <div className="pd-sim-v">
                      {calcInvest.toLocaleString('fr-FR')}<span className="pd-sim-u"> DT</span>
                    </div>
                    <div className="pd-s">{Math.round(pricePerM2)} DT/m² · paiement 1x</div>
                  </div>
                  <div className="pd-sim-out-cell">
                    <div className="pd-k">Revenu annuel estimé</div>
                    <div className="pd-sim-v pd-sim-v--blue">
                      {calcRevenue.toLocaleString('fr-FR')}<span className="pd-sim-u"> DT</span>
                    </div>
                    <div className="pd-s">À pleine maturité{(proj.bio_certified || proj.bioCertified) ? ' · Bio certifié' : ''}</div>
                  </div>
                </div>
              </section>
            )}

            {/* Trees inventory */}
            {totalTrees > 0 && (
              <section className="pd-section">
                <h2>Inventaire des arbres</h2>
                <p className="pd-section-s">
                  {totalTrees.toLocaleString('fr-FR')} oliviers répartis sur {surfaceDisp.value} {surfaceDisp.unit}
                  {cultivarDist.length > 1 ? ' — variétés sélectionnées pour le climat local.' : '.'}
                </p>
                <div className="pd-trees">
                  <div className="pd-trees-big">
                    <div className="pd-trees-y">{inventoryYearLabel}</div>
                    <div className="pd-trees-n">{totalTrees.toLocaleString('fr-FR')}</div>
                    <div className="pd-trees-u">oliviers</div>
                    <div className="pd-trees-cap">{inventoryCaption}</div>
                  </div>
                  <div className="pd-trees-dist">
                    {cultivarDist.map((c, i) => {
                      const pct = (c.count / cultivarTotal) * 100
                      const color = cultivarColors[i % cultivarColors.length]
                      return (
                        <div key={c.cultivar} className="pd-trees-row">
                          <span className="pd-trees-sw" style={{ background: color }} />
                          <span className="pd-trees-lbl">{c.cultivar}</span>
                          <span className="pd-trees-bar"><span style={{ width: `${pct}%`, background: color }} /></span>
                          <span className="pd-trees-num">{c.count.toLocaleString('fr-FR')}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {batches.length > 0 && (
                  <div className="pd-cohorts">
                    <div className="pd-cohorts-head">
                      <h3>Composition du verger</h3>
                      <span className="pd-cohorts-total">
                        {batches.reduce((s, b) => s + b.count, 0).toLocaleString('fr-FR')} arbres
                        {' · '}{batches.length} génération{batches.length > 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="pd-cohorts-list">
                      {[...batches].sort((a, b) => b.year - a.year).map((b) => {
                        const age = Math.max(0, currentYear - b.year)
                        const tier =
                          age < 3 ? { label: 'Jeune · Non prod.', cls: 'pd-cohort-chip--young' }
                          : age < 6 ? { label: 'En production', cls: 'pd-cohort-chip--prod' }
                          : age < 10 ? { label: 'Croissance', cls: 'pd-cohort-chip--growth' }
                          : { label: 'Mature', cls: 'pd-cohort-chip--mature' }
                        return (
                          <div key={b.year} className="pd-cohort-row">
                            <div className="pd-cohort-year">
                              <div className="pd-cohort-year-k">Année</div>
                              <div className="pd-cohort-year-v">{b.year}</div>
                            </div>
                            <div className="pd-cohort-count">
                              <div className="pd-cohort-count-k">Arbres</div>
                              <div className="pd-cohort-count-v">{b.count.toLocaleString('fr-FR')}</div>
                            </div>
                            <div className="pd-cohort-meta">
                              <span className="pd-cohort-age">{age}a</span>
                              <span className={`pd-cohort-chip ${tier.cls}`}>{tier.label}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Upcoming harvest */}
            {upcomingHarvest && (
              <section className="pd-section">
                <h2>Prochaine récolte</h2>
                <div className="pd-next-harvest">
                  <div className="pd-next-harvest-bubble">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                  </div>
                  <div>
                    <div className="pd-next-harvest-v">
                      {upcomingHarvest.date
                        ? new Date(upcomingHarvest.date).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
                        : upcomingHarvest.year}
                    </div>
                    <div className="pd-next-harvest-s">
                      {HARVEST_STATUS_LABELS[upcomingHarvest.status] || upcomingHarvest.status}
                      {upcomingHarvest.projectedGrossTnd > 0
                        ? ` · ≈ ${Math.round(upcomingHarvest.projectedGrossTnd).toLocaleString('fr-FR')} DT prévus`
                        : ''}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* How it works */}
            <section className="pd-section">
              <h2>Comment ça marche ?</h2>
              <p className="pd-section-s">Trois étapes — de la réservation à la récolte. Aucune gestion de votre côté.</p>
              <div className="pd-steps">
                <div className="pd-step">
                  <span className="pd-step-num">01</span>
                  <div className="pd-step-ic"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg></div>
                  <div className="pd-step-t">Choisissez une part</div>
                  <div className="pd-step-s">Sélectionnez la surface qui vous convient. Vous recevez un titre de propriété enregistré à votre nom.</div>
                </div>
                <div className="pd-step pd-step--g">
                  <span className="pd-step-num">02</span>
                  <div className="pd-step-ic"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2c3 4 5 7 5 10a5 5 0 0 1-10 0c0-3 2-6 5-10z"/></svg></div>
                  <div className="pd-step-t">Nous cultivons pour vous</div>
                  <div className="pd-step-s">Nos agronomes s'occupent de tout : plantation, irrigation, taille, récolte. Un rapport vous est envoyé à chaque étape.</div>
                </div>
                <div className="pd-step pd-step--a">
                  <span className="pd-step-num">03</span>
                  <div className="pd-step-ic"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 17l6-6 4 4 8-8M14 7h7v7"/></svg></div>
                  <div className="pd-step-t">Vous percevez vos revenus</div>
                  <div className="pd-step-s">Chaque année après la récolte, votre part du revenu net est virée sur votre portefeuille, prête à être retirée.</div>
                </div>
              </div>
            </section>

            {/* Past harvests table */}
            {pastHarvests.length > 0 && (
              <section className="pd-section">
                <h2>Historique des récoltes</h2>
                <div className="pd-harvests">
                  <div className="pd-harvests-head">
                    <span>Année</span>
                    <span>Kg récoltés</span>
                    <span>Montant brut</span>
                    <span>Statut</span>
                  </div>
                  {pastHarvests.map((h) => (
                    <div key={h.id} className="pd-harvests-row">
                      <span className="pd-harvests-year">{h.year}</span>
                      <span>{h.actualKg > 0 ? `${Math.round(h.actualKg).toLocaleString('fr-FR')} kg` : '—'}</span>
                      <span>
                        {h.actualGrossTnd > 0
                          ? <>{Math.round(h.actualGrossTnd).toLocaleString('fr-FR')}<span className="pd-u"> DT</span></>
                          : '—'}
                      </span>
                      <span className={`pd-harvests-status pd-harvests-status--${h.status}`}>
                        {HARVEST_STATUS_LABELS[h.status] || h.status}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Operational timeline */}
            {events.length > 0 && (
              <section className="pd-section">
                <h2>Calendrier</h2>
                <div className="pd-timeline">
                  {events.map((e) => (
                    <div key={e.id} className={`pd-event pd-event--${e.kind}`}>
                      <div className="pd-event-date">
                        {new Date(e.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </div>
                      <div>
                        <div className="pd-event-kind">{EVENT_KIND_LABELS[e.kind] || e.kind}</div>
                        <div className="pd-event-title">{e.title}</div>
                        {e.description ? <div className="pd-event-desc">{e.description}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* FAQ */}
            <section className="pd-section pd-faq">
              <h2>Questions fréquentes</h2>
              {faqs.map((f, i) => (
                <div key={i} className={`pd-faq-item${openFaq === i ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="pd-faq-q"
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                    aria-expanded={openFaq === i}
                  >
                    <span className="pd-faq-q-t">{f.q}</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                  {openFaq === i ? <div className="pd-faq-a">{f.a}</div> : null}
                </div>
              ))}
            </section>

          </div>
        </div>

        {/* ─── SIDE PANEL — sticky ─── */}
        <aside className="pd-side">

          {/* Contact */}
          <div className="pd-card pd-contact">
            <h3>Une question ? Parlons-en.</h3>
            <a className="pd-contact-row pd-contact-row--wa" href={`https://wa.me/${CONTACT.whatsapp}?text=${whatsappMsg}`} target="_blank" rel="noopener noreferrer">
              <span className="pd-contact-ic">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.1s-.8.9-.9 1.1c-.2.2-.3.2-.6.1-.3-.1-1.2-.4-2.3-1.4-.8-.7-1.4-1.7-1.6-1.9-.2-.3 0-.4.1-.6.1-.1.3-.3.4-.5.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5-.1-.1-.7-1.7-.9-2.3-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4 0 1.4 1 2.8 1.2 3 .1.2 2 3 4.8 4.2.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.7-.7 1.9-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.3zM12 2C6.5 2 2 6.5 2 12c0 1.9.5 3.7 1.5 5.3L2 22l4.8-1.3c1.5.9 3.3 1.3 5.2 1.3 5.5 0 10-4.5 10-10S17.5 2 12 2z"/></svg>
              </span>
              <div className="pd-contact-info">
                <div className="pd-contact-l">WhatsApp</div>
                <div className="pd-contact-n">Discuter maintenant</div>
              </div>
              <svg className="pd-contact-arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6"/></svg>
            </a>
            <a className="pd-contact-row pd-contact-row--ph" href={`tel:${CONTACT.phone.replace(/\s+/g, '')}`}>
              <span className="pd-contact-ic">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.5 2L8 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2-.5c.9.3 1.8.5 2.7.6a2 2 0 0 1 1.7 2z"/></svg>
              </span>
              <div className="pd-contact-info">
                <div className="pd-contact-l">Appeler</div>
                <div className="pd-contact-n">{CONTACT.phone}</div>
              </div>
              <svg className="pd-contact-arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6"/></svg>
            </a>
            <a className="pd-contact-row pd-contact-row--em" href={`mailto:${CONTACT.email}?subject=${encodeURIComponent(`Projet ${proj.title}`)}`}>
              <span className="pd-contact-ic">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>
              </span>
              <div className="pd-contact-info">
                <div className="pd-contact-l">E-mail</div>
                <div className="pd-contact-n">{CONTACT.email}</div>
              </div>
              <svg className="pd-contact-arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6"/></svg>
            </a>
          </div>

          {/* Guarantees */}
          <div className="pd-card pd-guar">
            <div className="pd-guar-row">
              <span className="pd-guar-ic"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12l5 5 9-11"/></svg></span>
              <div>
                <b>Titre foncier enregistré</b>
                <div className="pd-guar-s">Votre part notariée à votre nom</div>
              </div>
            </div>
            <div className="pd-guar-row">
              <span className="pd-guar-ic"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12l5 5 9-11"/></svg></span>
              <div>
                <b>Rapport drone mensuel</b>
                <div className="pd-guar-s">Suivi visuel de vos arbres</div>
              </div>
            </div>
            <div className="pd-guar-row">
              <span className="pd-guar-ic"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12l5 5 9-11"/></svg></span>
              <div>
                <b>Garantie de remplacement</b>
                <div className="pd-guar-s">Arbre mort remplacé sans frais</div>
              </div>
            </div>
          </div>

        </aside>
      </div>
    </div>
  )
}

export default function ProjectPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { project: proj, loading, refresh } = usePublicProjectDetail(id)

  const idMatches = Boolean(proj) && String(proj.id) === String(id)
  const showData = !loading && idMatches

  const GRACE_MS = 5000
  const RETRY_DELAYS = [300, 900, 1800, 3000]
  const [graceExpired, setGraceExpired] = useState(false)
  const graceKeyRef = useRef('')
  useEffect(() => {
    if (graceKeyRef.current === id) return undefined
    graceKeyRef.current = id
    setGraceExpired(false)
    const t = window.setTimeout(() => setGraceExpired(true), GRACE_MS)
    return () => window.clearTimeout(t)
  }, [id])

  const retryIndexRef = useRef({ key: '', idx: 0 })
  useEffect(() => {
    if (retryIndexRef.current.key !== id) retryIndexRef.current = { key: id, idx: 0 }
    if (graceExpired) return undefined
    if (loading || idMatches) return undefined
    if (!id) return undefined
    const idx = retryIndexRef.current.idx
    if (idx >= RETRY_DELAYS.length) return undefined
    const t = window.setTimeout(() => {
      retryIndexRef.current.idx = idx + 1
      refresh?.()
    }, RETRY_DELAYS[idx])
    return () => window.clearTimeout(t)
  }, [loading, idMatches, id, refresh, graceExpired])

  const showLoading =
    loading
    || (Boolean(proj) && !idMatches)
    || (!proj && !loading && Boolean(id) && !graceExpired)
  const gateData = showData ? proj : null
  const gateLoading = showLoading && !showData
  const isEmptyGate = (d) => d == null

  return (
    <DashboardShell active="browse">
      <RenderDataGate
        loading={gateLoading}
        data={gateData}
        isEmpty={isEmptyGate}
        onRetry={refresh}
        skeleton={<ProjectPageSkeleton />}
        empty={
          <div className="pd-shell">
            <EmptyState
              title="Projet introuvable"
              description="Ce projet n'est plus disponible publiquement. Il est peut-être complet, archivé, ou le lien que vous avez ouvert est obsolète."
              action={{ label: 'Explorer les projets', onClick: () => navigate('/browse') }}
              secondary={{ label: 'Réessayer', onClick: () => refresh?.() }}
            />
          </div>
        }
        label="Chargement du projet…"
        watchdogMs={12000}
      >
        {(project) => <ProjectPageBody project={project} />}
      </RenderDataGate>
    </DashboardShell>
  )
}
