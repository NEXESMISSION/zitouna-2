import SkeletonLine from './SkeletonLine.jsx'

/**
 * Detail-page skeleton — hero + N sections with heading and body lines.
 * Plan 03 §3.4. Used by ClientProfilePage, ProjectDetailPage, etc. Uses the
 * `.sk-detail` classes shipped by plan 06.
 *
 * Props:
 *   - `sections` number of content sections under the hero (default 3).
 *   - `lines`    body lines per section (default 4).
 *   - `label`    aria-label for the status region.
 */
export function SkeletonDetail({ sections = 3, lines = 4, label = 'Chargement…' }) {
  return (
    <div
      className="sk-detail"
      aria-busy="true"
      aria-hidden="true"
      data-label={label}
    >
      <div className="sk-detail__hero">
        <div className="sk-detail__avatar" aria-hidden="true" />
        <div className="sk-detail__hero-body">
          <SkeletonLine className="sk-detail__title" height={20} width="55%" />
          <SkeletonLine className="sk-detail__sub" height={12} width="35%" />
          <SkeletonLine className="sk-detail__sub" height={12} width="28%" />
        </div>
      </div>
      {Array.from({ length: Math.max(1, sections) }).map((_, s) => (
        <section key={s} className="sk-detail__section">
          <SkeletonLine className="sk-detail__section-title" height={14} width="30%" />
          {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
            <SkeletonLine
              key={`${s}-${i}`}
              className="sk-detail__line"
              height={10}
              width={i === lines - 1 ? '55%' : '95%'}
            />
          ))}
        </section>
      ))}
    </div>
  )
}

export default SkeletonDetail
