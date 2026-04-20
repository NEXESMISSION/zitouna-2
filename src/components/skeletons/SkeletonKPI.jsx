import SkeletonLine from './SkeletonLine.jsx'

/**
 * KPI tile skeleton — dashboard number tiles (FinanceDashboard,
 * CommissionAnalytics, AdminProfile headline). Plan 03 §3.4. Uses the
 * `.sk-kpi` classes shipped by plan 06.
 *
 * Props:
 *   - `tiles`   number of KPI tiles to render (default 4).
 *   - `columns` optional explicit column count.
 *   - `label`   aria-label for the status region.
 */
export function SkeletonKPI({ tiles = 4, columns, label = 'Chargement des indicateurs…' }) {
  const gridStyle = columns
    ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
    : undefined
  return (
    <div
      className="sk-kpi-grid"
      aria-busy="true"
      aria-hidden="true"
      data-label={label}
      style={gridStyle}
    >
      {Array.from({ length: Math.max(1, tiles) }).map((_, i) => (
        <div key={i} className="sk-kpi">
          <SkeletonLine className="sk-kpi__label" height={10} width="55%" />
          <SkeletonLine className="sk-kpi__value" height={22} width="70%" />
          <SkeletonLine className="sk-kpi__delta" height={10} width="35%" />
        </div>
      ))}
    </div>
  )
}

export default SkeletonKPI
