import { Component } from 'react'
import { Link } from 'react-router-dom'
import { clearChunkReloadFlag } from '../lib/lazyWithRetry.js'

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('AppErrorBoundary caught error:', error, info)
  }

  handleReload = () => {
    // PLAN 05 §7: full bypass-cache reload. `window.location.reload()` is
    // spec'd as "reload using the browser cache", which can trip a
    // stale-chunk error → error-boundary → reload loop. Two defences:
    //   1. Clear the lazyWithRetry session flag, so that if the user lands
    //      back on a chunk error after this reload, lazyWithRetry's own
    //      one-shot recovery is available again.
    //   2. Rebuild the URL with a `_r=<ts>` query param. This forces a
    //      fresh navigation, which revalidates index.html against the CDN
    //      (no-cache header in vercel.json) and picks up the new manifest.
    try { clearChunkReloadFlag() } catch { /* ignore */ }
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('_r', String(Date.now()))
      window.location.href = url.toString()
    } catch {
      window.location.reload()
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="screen screen--app" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
          <section className="dashboard-page" style={{ maxWidth: 520, textAlign: 'center' }}>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Une erreur est survenue</h1>
            <p style={{ color: '#64748b', marginBottom: 16 }}>
              L'application a rencontré une erreur inattendue. Rechargez la page ou revenez à l'accueil.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="cta-primary" onClick={this.handleReload}>
                Recharger
              </button>
              <Link to="/browse" className="link-btn">
                Aller à l'accueil
              </Link>
            </div>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}
