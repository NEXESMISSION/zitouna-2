import SkeletonLine from './SkeletonLine.jsx'

/**
 * Card-grid skeleton — nav cards on AdminProfilePage, dashboard tiles, etc.
 * Plan 03 §3.4. Uses the `.sk-card` wrapper class shipped by plan 06.
 *
 * Props:
 *   - `cards`   number of card placeholders to render (default 4).
 *   - `columns` optional explicit column count; otherwise CSS decides.
 *   - `label`   aria-label announced on the status container.
 */
export function SkeletonCard({ cards = 4, columns, label = 'Chargement…' }) {
  const gridStyle = columns
    ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
    : undefined
  return (
    <div
      className="sk-card-grid"
      aria-busy="true"
      aria-hidden="true"
      data-label={label}
      style={gridStyle}
    >
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="sk-card">
          <div className="sk-card__icon" aria-hidden="true" />
          <SkeletonLine className="sk-card__title" width="70%" height={14} />
          <SkeletonLine className="sk-card__sub" width="90%" height={10} />
        </div>
      ))}
    </div>
  )
}

export default SkeletonCard
