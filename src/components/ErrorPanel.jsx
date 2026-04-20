import { useState } from 'react'

/**
 * Uniform error panel with a retry button and a collapsible technical-details
 * block. Plan 03 §3.6. Replaces the blank-page / stuck-skeleton outcome for
 * any page whose primary store errors out.
 *
 * Props:
 *   - `error`     `Error | string | { message, code, details }` — primary error.
 *   - `title`     short label; defaults to "Impossible de charger".
 *   - `hint`      optional longer description. Falls back to error.message.
 *   - `onRetry`   optional click handler. Omit to hide the retry button
 *                 (only valid for terminal errors).
 *   - `retryLabel` label override; defaults to "Réessayer".
 *   - `details`   optional extra string to show in the technical panel.
 *   - `className` extra class appended after `error-panel`.
 *
 * Uses `role="alert"` so screen readers announce errors immediately.
 */
function formatDetails(error, extra) {
  const parts = []
  if (error && typeof error === 'object') {
    if (error.code) parts.push(`code: ${error.code}`)
    if (error.details) parts.push(`details: ${error.details}`)
    if (error.hint) parts.push(`hint: ${error.hint}`)
    if (error.stack) parts.push(String(error.stack))
  }
  if (extra) parts.push(String(extra))
  return parts.join('\n')
}

export function ErrorPanel({
  error,
  title,
  hint,
  onRetry,
  retryLabel = 'Réessayer',
  details,
  className = '',
}) {
  const [open, setOpen] = useState(false)
  const message =
    (error && typeof error === 'object' ? error.message : error) ||
    'Erreur inconnue'
  const technical = formatDetails(error, details)
  return (
    <div className={`error-panel ${className}`.trim()} role="alert">
      <div className="error-panel__title">{title || 'Impossible de charger'}</div>
      <div className="error-panel__hint">{hint || message}</div>
      {onRetry || technical ? (
        <div className="error-panel__actions">
          {onRetry ? (
            <button
              type="button"
              className="error-panel__btn error-panel__btn--primary"
              onClick={onRetry}
            >
              {retryLabel}
            </button>
          ) : null}
          {technical ? (
            <button
              type="button"
              className="error-panel__btn error-panel__btn--ghost"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Masquer les détails' : 'Afficher les détails'}
            </button>
          ) : null}
        </div>
      ) : null}
      {open && technical ? (
        <pre className="error-panel__details" aria-label="Détails techniques">
          {technical}
        </pre>
      ) : null}
    </div>
  )
}

export default ErrorPanel
