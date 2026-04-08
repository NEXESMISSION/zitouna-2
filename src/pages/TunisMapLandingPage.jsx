import { useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'

export default function TunisMapLandingPage() {
  const navigate = useNavigate()
  const mapSrc =
    'https://www.google.com/maps/d/embed?mid=1QQeiYeQCN-_ANhvS_Czh-N-KyvS-WB4&hl=fr&ll=33.37987528841141%2C9.385680025224303&z=6'

  return (
    <main className="screen screen--app">
      <section className="dashboard-page map-landing-page">
        <TopBar />
        <div className="map-landing-hero">
          <span className="map-landing-hero__kicker">OPPORTUNITES FONCIERES</span>
          <p className="map-landing-hero__title">Carte des projets disponibles a la vente</p>
          <p className="map-landing-hero__sub">
            Choisissez la parcelle adaptee et commencez votre reservation en quelques clics.
          </p>
        </div>
        <div className="detail-map-wrap map-landing-map-wrap">
          <div className="detail-map map-landing-map">
            <iframe title="Carte Tunisie" src={mapSrc} loading="lazy" allowFullScreen />
            <div className="map-landing-overlay-bottom">
              <button type="button" className="map-landing-browse-btn" onClick={() => navigate('/browse')}>
                Choisissez la parcelle adaptee et commencez votre reservation en quelques clics.
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
