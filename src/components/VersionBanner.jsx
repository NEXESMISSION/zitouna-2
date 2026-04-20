import useVersionPoller, { markReloadTargetBuild } from '../lib/useVersionPoller.js'
import './version-banner.css'

// PLAN 05 §4: slim "new version available" strip pinned to the top of the
// viewport. Rendered once near the app root; hidden until the poller detects
// a new build SHA, then offers a cache-busting reload.

export default function VersionBanner() {
  const { updateAvailable, latestBuild } = useVersionPoller()
  if (!updateAvailable) return null

  const handleReload = () => {
    // Record the SHA we're reloading *for* so the poller can detect a
    // reload loop (deploy hasn't propagated; mismatch persists) and suppress
    // the banner until a different SHA shows up upstream.
    markReloadTargetBuild(latestBuild)
    // Same technique as AppErrorBoundary / ChunkErrorBoundary: a cache-busting
    // query param forces the browser to revalidate index.html and pick up the
    // new manifest. `href = href` alone is sometimes served from the BFCache;
    // the `_r` param guarantees a fresh navigation.
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('_r', String(Date.now()))
      window.location.href = url.toString()
    } catch {
      window.location.reload()
    }
  }

  return (
    <div className="version-banner" role="status" aria-live="polite">
      <span className="version-banner__text">Une nouvelle version est disponible.</span>
      <button type="button" className="version-banner__btn" onClick={handleReload}>
        Recharger
      </button>
    </div>
  )
}
