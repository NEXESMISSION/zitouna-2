/**
 * Uniform empty-state panel — visual distinct from the shimmer skeleton so
 * users can't confuse the two. Plan 03 §3.5.
 *
 * Props:
 *   - `icon`         React node or emoji string rendered above the title.
 *   - `title`        required short label.
 *   - `description`  optional longer hint line (alias: `hint`).
 *   - `action`       optional `{ label, onClick, variant?, icon? }`.
 *   - `secondary`    optional `{ label, onClick, icon? }` rendered next to action.
 *   - `className`    extra class appended after `empty-state`.
 *   - `children`     optional extra slot below the action buttons.
 *
 * Renders with `role="status"` and `aria-live="polite"` so screen readers
 * announce the empty condition after the skeleton disappears. CSS lives in
 * the shared admin stylesheet (plan 06 / App.css).
 */
export function EmptyState({
  icon,
  title,
  description,
  hint,
  action,
  secondary,
  className = '',
  children,
}) {
  const body = description ?? hint
  return (
    <div
      className={`empty-state ${className}`.trim()}
      role="status"
      aria-live="polite"
    >
      {icon != null ? (
        <div className="empty-state__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      {title ? <div className="empty-state__title">{title}</div> : null}
      {body ? <div className="empty-state__hint">{body}</div> : null}
      {(action || secondary) ? (
        <div className="empty-state__actions">
          {action ? (
            <button
              type="button"
              className={`empty-state__btn empty-state__btn--${action.variant || 'primary'}`}
              onClick={action.onClick}
            >
              {action.icon ? (
                <span className="empty-state__btn-icon" aria-hidden="true">
                  {action.icon}
                </span>
              ) : null}
              {action.label}
            </button>
          ) : null}
          {secondary ? (
            <button
              type="button"
              className="empty-state__btn empty-state__btn--ghost"
              onClick={secondary.onClick}
            >
              {secondary.icon ? (
                <span className="empty-state__btn-icon" aria-hidden="true">
                  {secondary.icon}
                </span>
              ) : null}
              {secondary.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  )
}

export default EmptyState
