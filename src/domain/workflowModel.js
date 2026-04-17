export const SALE_STATUS = Object.freeze({
  DRAFT: 'draft',
  PENDING: 'pending',
  PENDING_COORDINATION: 'pending_coordination',
  PENDING_FINANCE: 'pending_finance',
  PENDING_LEGAL: 'pending_legal',
  SIGNED: 'signed',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
})

export const LEGACY_SALE_STATUS_ALIAS = Object.freeze({
  [SALE_STATUS.PENDING]: SALE_STATUS.PENDING_FINANCE,
  [SALE_STATUS.SIGNED]: SALE_STATUS.PENDING_LEGAL,
})

export function canonicalSaleStatus(status) {
  const s = String(status || '').trim()
  return LEGACY_SALE_STATUS_ALIAS[s] || s || SALE_STATUS.DRAFT
}

export const SALE_STATUS_META = Object.freeze({
  [SALE_STATUS.DRAFT]: { label: 'Brouillon', badge: 'gray' },
  [SALE_STATUS.PENDING_COORDINATION]: { label: 'En attente coordination', badge: 'orange' },
  [SALE_STATUS.PENDING_FINANCE]: { label: 'En attente finance', badge: 'orange' },
  [SALE_STATUS.PENDING_LEGAL]: { label: 'En attente notaire', badge: 'blue' },
  [SALE_STATUS.ACTIVE]: { label: 'Actif', badge: 'green' },
  [SALE_STATUS.COMPLETED]: { label: 'Termine', badge: 'green' },
  [SALE_STATUS.CANCELLED]: { label: 'Annule', badge: 'red' },
  [SALE_STATUS.REJECTED]: { label: 'Refuse', badge: 'red' },
})

export function getSaleStatusMeta(status) {
  const canonical = canonicalSaleStatus(status)
  return SALE_STATUS_META[canonical] || { label: canonical || 'Inconnu', badge: 'gray' }
}

export function isCoordinationVisibleSale(status) {
  const canonical = canonicalSaleStatus(status)
  return (
    canonical === SALE_STATUS.PENDING_COORDINATION
    || canonical === SALE_STATUS.PENDING_FINANCE
    || canonical === SALE_STATUS.PENDING_LEGAL
  )
}

export function isOpenSaleStatus(status) {
  const canonical = canonicalSaleStatus(status)
  return ![SALE_STATUS.ACTIVE, SALE_STATUS.COMPLETED, SALE_STATUS.CANCELLED, SALE_STATUS.REJECTED].includes(canonical)
}

export const APPOINTMENT_TYPE = Object.freeze({
  VISIT: 'visit',
  SIGNING: 'signing',
  FOLLOWUP: 'followup',
  LEGAL_SIGNATURE: 'legal_signature',
  FINANCE: 'finance',
  JURIDIQUE: 'juridique',
})

export function normalizeLegalAppointmentType(type) {
  const t = String(type || '')
  if (t === APPOINTMENT_TYPE.LEGAL_SIGNATURE) return APPOINTMENT_TYPE.JURIDIQUE
  return t
}

export function isJuridiqueAppointment(type) {
  const t = String(type || '')
  return t === APPOINTMENT_TYPE.JURIDIQUE || t === APPOINTMENT_TYPE.LEGAL_SIGNATURE
}

export const PLAN_STATUS = Object.freeze({
  ACTIVE: 'active',
  LATE: 'late',
  COMPLETED: 'completed',
})

export const INSTALLMENT_PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
})
