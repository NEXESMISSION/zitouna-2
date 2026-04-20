import SkeletonLine from './SkeletonLine.jsx'

/**
 * Tabular skeleton — list pages, ledgers, user management tables.
 * Plan 03 §3.4. Uses the `.sk-table` classes shipped by plan 06.
 *
 * Props:
 *   - `rows`     number of row placeholders (default 6).
 *   - `columns`  number of columns per row (default 4).
 *   - `density`  `'compact' | 'comfortable'` — forwards as modifier class.
 *   - `header`   whether to render a header row (default true).
 *   - `label`    aria-label for screen readers.
 */
export function SkeletonTable({
  rows = 6,
  columns = 4,
  density = 'comfortable',
  header = true,
  label = 'Chargement du tableau…',
}) {
  const cols = Math.max(1, columns)
  return (
    <div
      className={`sk-table sk-table--${density}`}
      aria-busy="true"
      aria-hidden="true"
      data-label={label}
    >
      {header ? (
        <div className="sk-table__row sk-table__row--head">
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonLine key={`h-${c}`} className="sk-table__cell" height={10} width="60%" />
          ))}
        </div>
      ) : null}
      {Array.from({ length: Math.max(1, rows) }).map((_, r) => (
        <div key={`r-${r}`} className="sk-table__row">
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonLine
              key={`c-${r}-${c}`}
              className="sk-table__cell"
              height={12}
              width={c === 0 ? '80%' : c === cols - 1 ? '40%' : '70%'}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export default SkeletonTable
