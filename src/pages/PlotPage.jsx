import { useNavigate, useParams } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { projects } from '../projects.js'
import { getPlotHealthReport } from '../healthReportsStore.js'

const REVENUE_PER_TREE = 90
const CURRENT_YEAR = 2026

/* ── Age-based revenue rate per tree per year ── */
function treeRevRate(plantYear) {
  const age = CURRENT_YEAR - plantYear
  if (age < 3)  return { rate: 0,  label: 'Jeune',             color: '#888' }
  if (age < 6)  return { rate: 45, label: 'En développement',  color: '#f5c842' }
  if (age < 10) return { rate: 75, label: 'Pleine croissance', color: '#a8cc50' }
  return               { rate: 90, label: 'Pleine production', color: '#7ab020' }
}

function plotAnnualRevenue(plot) {
  if (!plot.treeBatches?.length) return plot.trees * REVENUE_PER_TREE
  return plot.treeBatches.reduce((sum, b) => sum + b.count * treeRevRate(b.year).rate, 0)
}

/* ── Circular donut progress ── */
function CircularProgress({ value, size = 56, stroke = 5, color = '#a8cc50' }) {
  const r    = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const off  = circ - (value / 100) * circ
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={stroke} />
      <circle
        cx={size/2} cy={size/2} r={r}
        fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={off}
        strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition: 'stroke-dashoffset 600ms ease' }}
      />
    </svg>
  )
}

/* ── Tiny sparkline ── */
function Sparkline({ data, color = '#a8cc50', w = 46, h = 28 }) {
  const max = Math.max(...data), min = Math.min(...data), range = max - min || 1
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 8) - 2}`
  ).join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function PlotPage() {
  const { projectId, plotId } = useParams()
  const navigate = useNavigate()

  const proj = projects.find((p) => p.id === projectId)
  const plot = proj?.plots.find((pl) => String(pl.id) === String(plotId))


  if (!proj || !plot) {
    return (
      <main className="screen screen--app">
        <section className="dashboard-page">
          <TopBar />
          <div className="empty-state">
            <p>Parcelle introuvable.</p>
            <button className="cta-primary" onClick={() => navigate('/browse')}>
              Retour aux projets
            </button>
          </div>
        </section>
      </main>
    )
  }

  const annualRevenue = plotAnnualRevenue(plot)
  const health = getPlotHealthReport(projectId, plot.id)

  const goReserveVisite = () => {
    navigate(`/project/${proj.id}/visite`, { state: { plotIds: [plot.id] } })
  }

  const goCall = () => {
    window.location.href = 'tel:+21655123456'
  }

  return (
    <main className="screen screen--app">
      <section className="dashboard-page" style={{ paddingBottom: 'calc(6.5rem + env(safe-area-inset-bottom, 0px))' }}>
        <TopBar />

        {/* breadcrumb */}
        <div className="detail-nav">
          <button type="button" className="back-btn" onClick={() => navigate(`/project/${proj.id}`)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {proj.city}
          </button>
          <span className="detail-breadcrumb">Parcelle #{plot.id}</span>
        </div>

        {/* large map */}
        <div className="detail-map-wrap">
          <div className="detail-map-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
            </svg>
            Emplacement de la parcelle
          </div>
          <div className="detail-map" style={{ height: '360px' }}>
            <iframe
              title={`Parcelle ${plot.id} — ${proj.city}`}
              src={plot.mapUrl}
              loading="lazy"
              allowFullScreen
            />
          </div>
        </div>

        {/* ── Tree health ── */}
        <div className="health-section">
          <p className="health-section-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z"/><path d="M12 6v6l4 2"/>
            </svg>
            Santé de l&apos;arbre individualisé
          </p>

          {/* 4 metric cards */}
          <div className="health-grid">
            <div className="health-card">
              <span className="health-card-label">Santé de l&apos;arbre</span>
              <div className="health-circular-wrap">
                <CircularProgress value={health.treeSante} color="#a8cc50" />
                <span className="health-pct-overlay">{health.treeSante}%</span>
              </div>
              <span className="health-card-sub health-card-sub--green">{health.santeLabel}</span>
            </div>

            <div className="health-card">
              <span className="health-card-label">Humidité du sol</span>
              <div className="health-circular-wrap">
                <CircularProgress value={health.humidity} color="#4db8ff" />
                <span className="health-pct-overlay health-pct-overlay--blue">{health.humidity}%</span>
              </div>
              <span className="health-card-sub health-card-sub--blue">{health.humidityLabel}</span>
            </div>

            <div className="health-card">
              <span className="health-card-label">Nutriments</span>
              <div className="health-circular-wrap">
                <CircularProgress value={health.nutrients} color="#f5c842" />
                <span className="health-pct-overlay health-pct-overlay--yellow">{health.nutrients}%</span>
              </div>
              <span className="health-card-sub health-card-sub--yellow">{health.nutrientsLabel}</span>
            </div>

            <div className="health-card">
              <span className="health-card-label">CO₂ capturé</span>
              <div className="health-sparkline-wrap">
                <Sparkline data={health.co2Trend} />
              </div>
              <span className="health-co2-value">{health.co2} kg</span>
              <span className="health-card-sub">ce mois</span>
            </div>
          </div>

          {/* Watering / drone bars */}
          <div className="health-bars">
            <div className="health-bar-item">
              <div className="health-bar-header">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4db8ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2C6 8 4 12 4 15a8 8 0 0016 0c0-3-2-7-8-13z"/>
                </svg>
                <span>Dernier Arrosage</span>
              </div>
              <div className="health-bar-track">
                <div className="health-bar-fill health-bar-fill--blue" style={{ width: `${health.lastWatering.pct}%` }} />
              </div>
              <div className="health-bar-footer">
                <span className="health-bar-pct">{health.lastWatering.pct}%</span>
                <span className="health-bar-info">{health.lastWatering.info}</span>
              </div>
            </div>

            <div className="health-bar-item">
              <div className="health-bar-header">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f5c842" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
                <span>Dernier Traitement Droniste</span>
              </div>
              <div className="health-bar-track">
                <div className="health-bar-fill health-bar-fill--yellow" style={{ width: `${health.lastDrone.pct}%` }} />
              </div>
              <div className="health-bar-footer">
                <span className="health-bar-pct">{health.lastDrone.pct}%</span>
                <span className="health-bar-info">{health.lastDrone.info}</span>
              </div>
            </div>
          </div>

          {/* Next action */}
          <div className="health-next-action">
            <span className="health-next-label">Prochaine action prévue</span>
            <span className="health-next-value">{health.nextAction}</span>
          </div>
        </div>

        {/* simple parcel details */}
        <div className="plot-details-card">
          <div className="plot-detail-row plot-detail-row--header">
            <div className="plot-detail-id-block">
              <span className="plot-detail-id">Parcelle #{plot.id}</span>
              <span className="plot-detail-project">{proj.title} · {proj.city}, {proj.region}</span>
            </div>
            <span className="inline-badge">Disponible</span>
          </div>
          <div className="plot-detail-row">
            <span className="plot-detail-label">Surface</span>
            <span className="plot-detail-value">{plot.area.toLocaleString()} m²</span>
          </div>
          <div className="plot-detail-row">
            <span className="plot-detail-label">Nombre d&apos;arbres</span>
            <span className="plot-detail-value" style={{ color: '#a8cc50' }}>{plot.trees} oliviers</span>
          </div>
          <div className="plot-detail-row">
            <span className="plot-detail-label">Prix / arbre</span>
            <span className="plot-detail-value">{plot.pricePerTree.toLocaleString()} TND</span>
          </div>
          <div className="plot-detail-row plot-detail-row--total">
            <span className="plot-detail-label">Prix total</span>
            <span className="plot-detail-value" style={{ color: '#a8cc50' }}>{plot.totalPrice.toLocaleString()} TND</span>
          </div>
          <div className="plot-detail-row">
            <span className="plot-detail-label">Revenu estimé / an</span>
            <span className="plot-detail-value">~{annualRevenue.toLocaleString()} DT</span>
          </div>
        </div>

        {/* ── Plantation composition ── */}
        {plot.treeBatches?.length > 0 && (
          <div className="plantation-section">
            <p className="plantation-section-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22V12m0 0C12 7 7 4 3 6m9 6c0-5 5-8 9-6"/>
              </svg>
              Composition du verger · {plot.treeBatches.length} génération{plot.treeBatches.length > 1 ? 's' : ''}
            </p>
            <div className="plantation-grid">
              {plot.treeBatches.map((batch) => {
                const age  = CURRENT_YEAR - batch.year
                const info = treeRevRate(batch.year)
                const batchRevenue = batch.count * info.rate
                return (
                  <div key={batch.year} className="plantation-card">
                    <div className="plantation-card-top">
                      <span className="plantation-year">{batch.year}</span>
                      <span className="plantation-age-badge" style={{ color: info.color, borderColor: info.color }}>
                        {age} an{age > 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="plantation-trees">
                      <strong>{batch.count}</strong>
                      <span>arbres</span>
                    </div>
                    <div className="plantation-status" style={{ color: info.color }}>{info.label}</div>
                    <div className="plantation-revenue">
                      {info.rate === 0
                        ? <span className="plantation-revenue--zero">Pas encore productif</span>
                        : <><span>~{batchRevenue.toLocaleString()} DT / an</span><em>{info.rate} DT/arbre</em></>
                      }
                    </div>
                  </div>
                )
              })}
            </div>
            {plot.treeBatches.length > 1 && (
              <div className="plantation-total">
                <span>Revenu total estimé</span>
                <strong style={{ color: '#a8cc50' }}>~{annualRevenue.toLocaleString()} DT / an</strong>
              </div>
            )}
          </div>
        )}

        <div className="plot-page-actions">
          <button type="button" className="plot-page-btn plot-page-btn--gold" onClick={goCall}>
            Contacter nous
          </button>
        </div>
      </section>
    </main>
  )
}
