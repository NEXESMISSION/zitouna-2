import SkeletonLine from './SkeletonLine.jsx'

/**
 * Hierarchical/tree skeleton — CommissionTrackerPage upline, org charts.
 * Plan 03 §3.4. Uses the `.sk-tree` classes shipped by plan 06.
 *
 * Props:
 *   - `depth`   nesting depth of the placeholder (default 3).
 *   - `spread`  children per node (default 2).
 *   - `label`   aria-label for the status region.
 */
export function SkeletonTree({ depth = 3, spread = 2, label = 'Chargement de l\u2019arborescence…' }) {
  const node = (level, key) => (
    <li key={key} className="sk-tree__node">
      <div className="sk-tree__row">
        <span className="sk-tree__dot" aria-hidden="true" />
        <SkeletonLine className="sk-tree__label" height={12} width={`${70 - level * 8}%`} />
      </div>
      {level < depth ? (
        <ul className="sk-tree__children">
          {Array.from({ length: Math.max(1, spread) }).map((_, i) =>
            node(level + 1, `${key}-${i}`),
          )}
        </ul>
      ) : null}
    </li>
  )
  return (
    <div
      className="sk-tree"
      aria-busy="true"
      aria-hidden="true"
      data-label={label}
    >
      <ul className="sk-tree__root">{node(1, 'root')}</ul>
    </div>
  )
}

export default SkeletonTree
