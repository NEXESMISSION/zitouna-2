export default function SalesAgentAppPage() {
  return (
    <div className="zadm-page">
      <header className="zadm-page__head">
        <div className="zadm-page__head-text">
          <h1 className="zadm-page__title">Agent commercial</h1>
          <p className="zadm-page__subtitle">Espace dédié à l'équipe commerciale terrain.</p>
        </div>
      </header>
      <div className="zadm-page__body">
        <div className="zadm-empty">
          <div className="zadm-empty__icon" aria-hidden>📭</div>
          <p className="zadm-empty__title">Page vide</p>
          <p className="zadm-empty__hint">Aucune donnée backend n'est encore branchée.</p>
        </div>
      </div>
    </div>
  )
}
