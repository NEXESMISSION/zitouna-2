/**
 * Shared, pure helper that computes every money bucket needed by admin and
 * buyer UI for an installment sale. Deliberately framework-agnostic so it
 * can be unit-tested without React or Supabase in scope.
 *
 * Data source precedence (see amounts_logic_hardening plan):
 *   1. snapshots on the sale (`pricingSnapshot`, `offerSnapshot`) — frozen at
 *      sale creation, authoritative for historical sales
 *   2. frozen sale fields (`agreedPrice`, `offerDownPayment`, `offerDuration`)
 *   3. never falls back to live project settings — those apply only to
 *      brand-new sales via the sale-creation path
 *
 * Returns numbers rounded to 2 decimals; negatives clamped to 0 for display.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const clampPositive = (n) => (n < 0 ? 0 : n)

function pickSaleTerms(sale) {
  const pricing = (sale?.pricingSnapshot && typeof sale.pricingSnapshot === 'object') ? sale.pricingSnapshot : {}
  const offer = (sale?.offerSnapshot && typeof sale.offerSnapshot === 'object') ? sale.offerSnapshot : {}
  const saleAgreed = round2(pricing.agreedPrice ?? sale?.agreedPrice ?? sale?.amount ?? 0)
  const downPct = Number(offer.downPayment ?? sale?.offerDownPayment ?? 0)
  const duration = Number(offer.duration ?? sale?.offerDuration ?? 0)
  const terrainDeposit = round2(pricing.deposit ?? sale?.deposit ?? 0)
  return { saleAgreed, downPct, duration, terrainDeposit }
}

/**
 * @param {object} sale    App-shaped sale (mapSaleFromDb)
 * @param {object} plan    App-shaped installment plan; payments array expected in `plan.payments`
 * @returns {object} metrics — see body for field list
 */
export function computeInstallmentSaleMetrics(sale, plan) {
  const { saleAgreed, downPct, duration, terrainDeposit } = pickSaleTerms(sale)
  const payments = Array.isArray(plan?.payments) ? plan.payments : []

  const downPaymentPlanned = round2((saleAgreed * downPct) / 100)
  const capitalRemainingPlanned = round2(clampPositive(saleAgreed - downPaymentPlanned))
  const financeBalanceAtSale = round2(clampPositive(downPaymentPlanned - terrainDeposit))

  let submittedAmount = 0
  let approvedAmount = 0
  let rejectedAmount = 0
  let pendingAmount = 0
  let submittedCount = 0
  let approvedCount = 0
  let rejectedCount = 0
  let pendingCount = 0

  for (const p of payments) {
    const amt = Number(p?.amount) || 0
    const st = String(p?.status || '').toLowerCase()
    if (st === 'approved') { approvedAmount += amt; approvedCount += 1 }
    else if (st === 'submitted') { submittedAmount += amt; submittedCount += 1 }
    else if (st === 'rejected') { rejectedAmount += amt; rejectedCount += 1 }
    else { pendingAmount += amt; pendingCount += 1 }
  }

  submittedAmount = round2(submittedAmount)
  approvedAmount = round2(approvedAmount)
  rejectedAmount = round2(rejectedAmount)
  pendingAmount = round2(pendingAmount)

  // An installment plan only exists after the sale is closed by the notary,
  // which means Finance has already validated the 1st installment
  // (downPaymentPlanned, of which terrainDeposit was an advance). So the
  // down payment is counted as validated cash from day 1; each approved
  // monthly installment adds to it.
  //
  // Strict = full 1st installment (= terrainDeposit + financeBalanceAtSale)
  //        + admin-validated monthly installments.
  const cashValidatedStrict = round2(Math.max(terrainDeposit, downPaymentPlanned) + approvedAmount)
  // Operational = strict + receipts awaiting validation.
  const cashReceivedOperational = round2(cashValidatedStrict + submittedAmount)

  const remainingStrict = round2(clampPositive(saleAgreed - cashValidatedStrict))
  const remainingOperational = round2(clampPositive(saleAgreed - cashReceivedOperational))

  const totalMonths = Number(plan?.totalMonths) || payments.length || duration || 0
  const approvedPct = totalMonths > 0 ? round2((approvedCount / totalMonths) * 100) : 0

  return {
    // Contract base
    saleAgreed,
    downPct,
    duration,
    terrainDeposit,
    downPaymentPlanned,
    capitalRemainingPlanned,
    financeBalanceAtSale,
    // Lifecycle sums
    submittedAmount,
    approvedAmount,
    rejectedAmount,
    pendingAmount,
    submittedCount,
    approvedCount,
    rejectedCount,
    pendingCount,
    // Rollups
    cashValidatedStrict,
    cashReceivedOperational,
    remainingStrict,
    remainingOperational,
    // Progress
    totalMonths,
    approvedPct,
  }
}

/**
 * Index of the next installment needing attention (rejected → pending → submitted → first non-approved).
 */
export function getNextDuePaymentIndex(payments) {
  const list = Array.isArray(payments) ? payments : []
  if (!list.length) return -1
  const idx = list.findIndex((p) => p.status === 'rejected')
  if (idx >= 0) return idx
  const i = list.findIndex((p) => p.status === 'pending')
  if (i >= 0) return i
  const j = list.findIndex((p) => p.status === 'submitted')
  if (j >= 0) return j
  return list.findIndex((p) => p.status !== 'approved')
}

/** 1-based page number containing that installment (for paginated lists). */
export function getPaymentPageForNextDue(payments, perPage) {
  const list = payments || []
  if (!list.length || perPage < 1) return 1
  const k = getNextDuePaymentIndex(list)
  if (k < 0) return 1
  return Math.floor(k / perPage) + 1
}

/** French currency format helper (kept here so every consumer renders the same way). */
export function formatMoneyTnd(n) {
  return `${(Number(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} DT`
}
