import { Component } from 'react'
import { Link } from 'react-router-dom'

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
              <button type="button" className="cta-primary" onClick={() => window.location.reload()}>
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
