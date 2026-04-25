import './plot-health-panel.css'

/*
 * PlotHealthPanel — the 4-cell health ring block used on the plot detail
 * page, extracted into a shared component so the project detail page can
 * render the same visuals for its aggregated health scores.
 *
 * Props:
 *   trees     — tree-health % (0..100)
 *   humidity  — soil-humidity %
 *   nutrients — nutrients %
 *   co2       — captured CO₂ in kg over 30 days (number)
 *   co2Trend  — array of numbers for the sparkline
 *   gradientId — unique suffix so multiple panels on the same page don't
 *                clash on <defs> ids
 */

const TIER_COLORS = {
  trees: '#0FA968',      // green
  humidity: '#1E5CFF',   // blue
  nutrients: '#B7791F',  // amber
}

function tierLabel(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  if (n >= 85) return 'Excellent'
  if (n >= 70) return 'Bon'
  if (n >= 50) return 'Moyen'
  return 'Critique'
}

function HealthRing({ value, color, label }) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
  const circ = 2 * Math.PI * 42
  const off = circ - (clamped / 100) * circ
  return (
    <div className="ph-ring">
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="none" stroke="#F1F1EE" strokeWidth="8" />
        <circle
          cx="50" cy="50" r="42" fill="none"
          stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={off}
          transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      <div className="center">
        <div className="v">{clamped}%</div>
        <div className="l">{label}</div>
      </div>
    </div>
  )
}

function Co2Sparkline({ data, gradientId }) {
  if (!data?.length) return null
  const w = 160, h = 40
  const max = Math.max(...data), min = Math.min(...data), range = max - min || 1
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 10) - 4
    return [x, y]
  })
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  const [lx, ly] = pts[pts.length - 1]
  return (
    <svg className="ph-co2-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#0FA968" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#0FA968" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke="#0FA968" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="3" fill="#0FA968" />
    </svg>
  )
}

export default function PlotHealthPanel({
  trees = 0,
  humidity = 0,
  nutrients = 0,
  co2 = 4.2,
  co2Trend = [1.8, 2.4, 2.9, 3.4, 3.8, 4.2],
  gradientId = 'ph-co2',
}) {
  return (
    <div className="ph-panel">
      <div className="ph-cell">
        <div className="k">Santé · arbre</div>
        <HealthRing value={trees} color={TIER_COLORS.trees} label={tierLabel(trees)} />
      </div>
      <div className="ph-cell">
        <div className="k">Humidité du sol</div>
        <HealthRing value={humidity} color={TIER_COLORS.humidity} label={tierLabel(humidity)} />
      </div>
      <div className="ph-cell">
        <div className="k">Nutriments</div>
        <HealthRing value={nutrients} color={TIER_COLORS.nutrients} label={tierLabel(nutrients)} />
      </div>
      <div className="ph-cell">
        <div className="k">CO₂ capturé (30 j)</div>
        <div className="ph-co2-col">
          <div className="ph-co2-fig">
            {String(co2).replace('.', ',')}
            <span className="u">kg</span>
          </div>
          <Co2Sparkline data={co2Trend} gradientId={gradientId} />
          <div className="ph-co2-delta">+0,3 kg vs mois dernier</div>
        </div>
      </div>
    </div>
  )
}

