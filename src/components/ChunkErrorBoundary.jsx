import { Component } from 'react'
import { isChunkLoadError, clearChunkReloadFlag } from '../lib/lazyWithRetry.js'

// RESEARCH 05 §2: the app-wide <Suspense> fallback is a bare spinner with no
// timeout / error state — a failed chunk import spins forever. This boundary
// sits INSIDE <Suspense> to catch chunk load errors after lazyWithRetry's
// retries+reload have been exhausted, and surfaces a user-visible "new
// version available" panel instead of a silent hang. Non-chunk errors are
// re-thrown so the outer AppErrorBoundary catches them.

export default class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { chunkError: null }
  }

  static getDerivedStateFromError(error) {
    if (isChunkLoadError(error)) return { chunkError: error }
    // Let other errors bubble.
    throw error
  }

  componentDidCatch(error, info) {
    if (isChunkLoadError(error)) {
      console.warn('[ChunkErrorBoundary] chunk load failed after retries', error?.message || error, info?.componentStack || '')
    } else {
      throw error
    }
  }

  handleReload = () => {
    clearChunkReloadFlag()
    const url = new URL(window.location.href)
    url.searchParams.set('_r', String(Date.now()))
    window.location.href = url.toString()
  }

  render() {
    if (this.state.chunkError) {
      return (
        <main className="screen screen--app" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
          <section className="dashboard-page" style={{ maxWidth: 520, textAlign: 'center' }}>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Une nouvelle version est disponible</h1>
            <p style={{ color: '#64748b', marginBottom: 16 }}>
              Impossible de charger une partie de l&apos;application. Rechargez la page pour obtenir la dernière version.
            </p>
            <button type="button" className="cta-primary" onClick={this.handleReload}>
              Recharger
            </button>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}
