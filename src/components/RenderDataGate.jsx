import { useCallback } from 'react'
import { useWatchdog } from '../hooks/useWatchdog.js'
import EmptyState from './EmptyState.jsx'
import ErrorPanel from './ErrorPanel.jsx'
import {
  SkeletonCard,
  SkeletonDetail,
  SkeletonKPI,
  SkeletonLine,
  SkeletonTable,
  SkeletonTree,
} from './skeletons/index.js'

/**
 * Four-state rendering gate. Plan 03 §3.2.
 *
 * Exactly one of these four branches is rendered, driven either by a full
 * `status` object (preferred — the `useStoreStatus` shape from plan 02) or
 * by the `{ loading, error, data }` legacy triple passed as top-level props:
 *
 *   loading -> <skeleton /> (+ stuck banner after `watchdogMs`)
 *   error   -> <ErrorPanel />
 *   empty   -> <EmptyState />
 *   data    -> children(data)
 *
 * Skeleton presets
 * ----------------
 * The `skeleton` prop accepts either a React node (rendered as-is) OR a
 * short preset name. Presets are a stable contract so pages don't hand-roll
 * shimmer markup: `'line' | 'card' | 'table' | 'detail' | 'tree' | 'kpi'`.
 * When a preset is a function, it's invoked with no arguments.
 *
 * Props
 * -----
 * @param {object} props
 * @param {{ state: 'idle'|'loading'|'ready'|'error', error?: unknown, data?: unknown }} [props.status]
 *        Full status object from `useStoreStatus`. Preferred.
 * @param {boolean} [props.loading]  Legacy loading flag (used when `status` absent).
 * @param {unknown} [props.error]    Legacy error value (used when `status` absent).
 * @param {unknown} [props.data]     Legacy data value (used when `status` absent).
 * @param {React.ReactNode|((...args:any[])=>React.ReactNode)|'line'|'card'|'table'|'detail'|'tree'|'kpi'} [props.skeleton]
 * @param {React.ReactNode|((err:unknown, retry?:()=>void)=>React.ReactNode)} [props.errorView]
 * @param {React.ReactNode|(()=>React.ReactNode)} [props.empty]
 * @param {((data:any)=>React.ReactNode)|React.ReactNode} props.children
 * @param {(data:any)=>boolean} [props.isEmpty]  Override empty check.
 * @param {()=>void} [props.onRetry]             Retry callback (stuck banner + error retry).
 * @param {string} [props.label]                 Accessible label for the loading region.
 * @param {number} [props.watchdogMs=8000]       Threshold after which the stuck banner appears.
 */

const SKELETON_PRESETS = {
  line: () => <SkeletonLine height={14} width="60%" />,
  card: () => <SkeletonCard cards={4} />,
  table: () => <SkeletonTable rows={6} columns={4} />,
  detail: () => <SkeletonDetail sections={3} lines={4} />,
  tree: () => <SkeletonTree depth={3} spread={2} />,
  kpi: () => <SkeletonKPI tiles={4} />,
}

function renderSkeleton(skeleton, fallbackLabel) {
  if (skeleton == null) {
    return <SkeletonTable rows={4} columns={3} label={fallbackLabel} />
  }
  if (typeof skeleton === 'string' && SKELETON_PRESETS[skeleton]) {
    return SKELETON_PRESETS[skeleton]()
  }
  if (typeof skeleton === 'function') {
    return skeleton()
  }
  return skeleton
}

function StuckBanner({ onRetry, label }) {
  return (
    <div className="stuck-banner" role="status" aria-live="polite">
      <span className="stuck-banner__msg">
        {label || 'Chargement plus long que prévu\u2026'}
      </span>
      {onRetry ? (
        <button
          type="button"
          className="stuck-banner__btn"
          onClick={onRetry}
        >
          Réessayer
        </button>
      ) : null}
    </div>
  )
}

function deriveStatus(props) {
  if (props.status && typeof props.status === 'object') return props.status
  const { loading, error, data } = props
  if (error) return { state: 'error', error, data }
  if (loading) return { state: 'loading', data }
  return { state: 'ready', data }
}

function defaultIsEmpty(data) {
  if (Array.isArray(data)) return data.length === 0
  if (data == null) return true
  if (typeof data === 'object' && !Array.isArray(data)) {
    // Page objects `{ rows: [...], total }` etc.
    if (Array.isArray(data.rows)) return data.rows.length === 0
    if (Array.isArray(data.items)) return data.items.length === 0
  }
  return false
}

export function RenderDataGate(props) {
  const {
    skeleton,
    errorView,
    empty,
    children,
    isEmpty,
    onRetry,
    label = 'Chargement…',
    watchdogMs = 8000,
  } = props

  const status = deriveStatus(props)
  const { stuck, reset } = useWatchdog(status, watchdogMs)

  const handleRetry = useCallback(() => {
    reset()
    if (typeof onRetry === 'function') onRetry()
  }, [onRetry, reset])

  if (status.state === 'loading' || status.state === 'idle' || status.state === undefined) {
    return (
      <div className="render-gate render-gate--loading" aria-busy="true" aria-live="polite">
        {renderSkeleton(skeleton, label)}
        {stuck ? <StuckBanner onRetry={onRetry ? handleRetry : undefined} /> : null}
      </div>
    )
  }

  if (status.state === 'error') {
    if (typeof errorView === 'function') {
      return errorView(status.error, onRetry)
    }
    if (errorView) return errorView
    return <ErrorPanel error={status.error} onRetry={onRetry} />
  }

  // ready
  const data = status.data
  const checker = typeof isEmpty === 'function' ? isEmpty : defaultIsEmpty
  if (checker(data)) {
    if (typeof empty === 'function') return empty()
    if (empty) return empty
    return <EmptyState title="Aucun résultat" />
  }

  return typeof children === 'function' ? children(data) : children
}

export default RenderDataGate
