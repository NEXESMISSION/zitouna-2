/**
 * Immutable snapshot fields frozen at sale creation — for audit rows outside zitu-themed panels.
 * @param {object|null|undefined} sale
 * @returns {{ key: string, label: string, value: string }[]}
 */
export function getSaleSnapshotAuditRows(sale) {
  if (!sale) return []
  const fee = sale.feeSnapshot || {}
  const levels = sale.commissionRuleSnapshot?.levels
  const nComm = Array.isArray(levels) ? levels.length : 0
  const items = sale.checklistSnapshot?.items
  const nCheck = Array.isArray(items) ? items.length : 0
  const pricing = sale.pricingSnapshot || {}
  const offer = sale.offerSnapshot || {}
  const priceLine =
    pricing.agreedPrice != null
      ? `v${pricing.version ?? '?'} · ${Number(pricing.agreedPrice).toLocaleString('fr-FR')} TND`
      : pricing.version != null
        ? `v${pricing.version}`
        : '—'
  return [
    { key: 'cfg', label: 'Version config', value: String(sale.configSnapshotVersion ?? '—') },
    {
      key: 'fee',
      label: 'Frais (snapshot)',
      value: `Société ${fee.companyFeePct ?? '—'}% · Notaire ${fee.notaryFeePct ?? '—'}%`,
    },
    { key: 'comm', label: 'Règles commission', value: nComm ? `${nComm} niveau(x)` : '—' },
    { key: 'chk', label: 'Checklist notaire', value: nCheck ? `${nCheck} item(s)` : '—' },
    { key: 'price', label: 'Pricing (snapshot)', value: priceLine },
    { key: 'off', label: 'Offre (snapshot)', value: offer.name ? String(offer.name) : '—' },
  ]
}
