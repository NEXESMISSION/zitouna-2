import { useNavigate, useParams } from 'react-router-dom'
import TopBar from '../TopBar.jsx'

export default function VisitSuccessPage() {
  const navigate = useNavigate()
  const { id } = useParams()

  return (
    <main className="screen screen--app">
      <section className="dashboard-page visit-success-page">
        <TopBar />

        <div className="visit-success-card">
          <div className="visit-success-icon" aria-hidden>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>

          <h1>Rendez-vous envoye avec succes</h1>
          <p>
            Merci. Votre demande de visite pour le projet <strong>{id}</strong> est bien enregistree.
            Notre equipe vous rappellera tres bientot pour confirmer.
          </p>

          <button type="button" className="cta-primary visit-success-btn" onClick={() => navigate('/browse')}>
            Aller à l'accueil
          </button>
        </div>
      </section>
    </main>
  )
}
