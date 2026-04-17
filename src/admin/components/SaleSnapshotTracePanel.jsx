/** Immutable sale fields frozen at creation — plan traceability. */
export default function SaleSnapshotTracePanel({ sale }) {
  if (!sale) return null
  const signed = sale.notaryChecklistSigned && typeof sale.notaryChecklistSigned === 'object' ? sale.notaryChecklistSigned : {}
  const signedKeys = signed.docKeys && typeof signed.docKeys === 'object' ? signed.docKeys : null
  const signedSummary = signedKeys
    ? Object.entries(signedKeys)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ')
    : ''
  const fee = sale.feeSnapshot || {}
  const levels = sale.commissionRuleSnapshot?.levels
  const nComm = Array.isArray(levels) ? levels.length : 0
  const items = sale.checklistSnapshot?.items
  const nCheck = Array.isArray(items) ? items.length : 0
  const pricing = sale.pricingSnapshot || {}
  const offer = sale.offerSnapshot || {}
  return (
    <div className="zitu-page__panel">
      <div className="zitu-page__panel-title">Snapshots &amp; traçabilité</div>
      <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 8px' }}>
        Données figées à la création de la vente — les changements de projet n’altèrent pas l’historique.
      </p>
      <div className="zitu-page__detail-row">
        <span className="zitu-page__detail-label">Version config</span>
        <span className="zitu-page__detail-value">{sale.configSnapshotVersion ?? '—'}</span>
      </div>
      <div className="zitu-page__detail-row">
        <span className="zitu-page__detail-label">Frais (snapshot)</span>
        <span className="zitu-page__detail-value">
          Société {fee.companyFeePct ?? '—'}% · Notaire {fee.notaryFeePct ?? '—'}%
        </span>
      </div>
      <div className="zitu-page__detail-row">
        <span className="zitu-page__detail-label">Règles commission</span>
        <span className="zitu-page__detail-value">{nComm ? `${nComm} niveau(x)` : '—'}</span>
      </div>
      <div className="zitu-page__detail-row">
        <span className="zitu-page__detail-label">Checklist notaire</span>
        <span className="zitu-page__detail-value">{nCheck ? `${nCheck} item(s)` : '—'}</span>
      </div>
      <div className="zitu-page__detail-row">
        <span className="zitu-page__detail-label">Signatures notaire (tracé)</span>
        <span className="zitu-page__detail-value">
          {signed.finalizedAt
            ? `Finalisé · ${signedSummary || '—'}`
            : signed.savedAt
              ? `Brouillon sauvegardé · ${signedSummary || '—'}`
              : '—'}
        </span>
      </div>
      <div className="zitu-page__detail-row">
        <span className="zitu-page__detail-label">Pricing (snapshot)</span>
        <span className="zitu-page__detail-value">
          {pricing.version != null ? `v${pricing.version}` : '—'} ·{' '}
          {pricing.agreedPrice != null ? `${Number(pricing.agreedPrice).toLocaleString('fr-FR')} TND` : '—'}
        </span>
      </div>
      <div className="zitu-page__detail-row">
        <span className="zitu-page__detail-label">Offre (snapshot)</span>
        <span className="zitu-page__detail-value">{offer.name || '—'}</span>
      </div>
    </div>
  )
}
