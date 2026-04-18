// Compact pager: 1 2 3 4 5 … 12, or 1 … 5 6 7 … 12 depending on where we are.
// Used by SellPage, NotaryDashboardPage, CashSalesPage, RecouvrementPage.
export function getPagerPages(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out = [1]
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)
  if (left > 2) out.push('…')
  for (let i = left; i <= right; i++) out.push(i)
  if (right < total - 1) out.push('…')
  out.push(total)
  return out
}
