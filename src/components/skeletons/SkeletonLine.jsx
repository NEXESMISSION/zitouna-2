/**
 * Single shimmer line. The workhorse primitive composed by every other
 * skeleton. Plan 03 §3.4 — uses the `.sk-line` class shipped by plan 06's
 * shared skeleton stylesheet (`src/styles/skeletons.css`).
 *
 * Props:
 *   - `width`   CSS width (string or number). Defaults to 100%.
 *   - `height`  CSS height. Defaults to 12px.
 *   - `radius`  Border radius override; otherwise taken from the CSS class.
 *   - `className` Extra classes appended after `sk-line`.
 *   - `style`   Additional inline style merge (avoid if possible).
 *   - `ariaHidden` Defaults to true; set false to keep it in the a11y tree.
 */
export function SkeletonLine({
  width,
  height,
  radius,
  className = '',
  style,
  ariaHidden = true,
}) {
  const merged = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
    borderRadius: radius,
    ...style,
  }
  return (
    <span
      className={`sk-line ${className}`.trim()}
      style={merged}
      aria-hidden={ariaHidden || undefined}
    />
  )
}

export default SkeletonLine
