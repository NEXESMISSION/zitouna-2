import { useState, useMemo, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { canonicalRole } from '../../lib/adminRole.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useProjects, useProjectWorkflow } from '../../lib/useSupabase.js'
import { useClients } from '../../lib/useSupabase.js'
import { useOffers } from '../../lib/useSupabase.js'
import { useSales, useAdminUsers, useMySellerParcelAssignments } from '../../lib/useSupabase.js'
import { generatePaymentSchedule } from '../../installmentsStore.js'
import { useToast } from '../components/AdminToast.jsx'
import AdminDrawer from '../components/AdminDrawer.jsx'
import AdminModal from '../components/AdminModal.jsx'
import { SALE_STATUS, getSaleStatusMeta } from '../../domain/workflowModel.js'
import * as db from '../../lib/db.js'
import { emitInvalidate } from '../../lib/dataEvents.js'
import { normalizePhone } from '../../lib/phone.js'
import { getPagerPages } from './pager-util.js'
import '../admin.css'
import './sell-field.css'

function reservationExpiresAtIso(hours) {
  const d = new Date()
  d.setHours(d.getHours() + (Number(hours) || 48))
  return d.toISOString()
}

/** Attache la vente à l'agent ou au responsable pour le reporting et le tableau de bord. */
function saleAttribution(role, adminUser) {
  const r = canonicalRole(role)
  if (r === 'Agent' && adminUser?.id) {
    return { agentId: adminUser.id, managerId: adminUser.managerId || null }
  }
  if ((r === 'Sales Leader' || r === 'Super Admin') && adminUser?.id) {
    return { agentId: null, managerId: adminUser.id }
  }
  return { agentId: null, managerId: null }
}

/** Numéros de parcelle (parcel_number) uniquement, sans NaN. */
export function normalizePlotIds(sale) {
  const raw = Array.isArray(sale.plotIds)
    ? sale.plotIds
    : sale.plotId != null && sale.plotId !== ''
      ? [sale.plotId]
      : []
  const nums = raw.map(x => Number(x)).filter(n => Number.isFinite(n))
  return nums
}

function plotSelectionMatchesSale(sale, formPlotIds) {
  const a = [...normalizePlotIds(sale)].map(Number).filter(n => !Number.isNaN(n)).sort((x, y) => x - y)
  const b = [...formPlotIds].map(Number).filter(n => !Number.isNaN(n)).sort((x, y) => x - y)
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function fmtFrDateTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return String(iso)
  }
}

function normalizePhoneLookup(v) {
  return String(v || '').replace(/\D/g, '').slice(-8)
}

// Country codes for the + Nouveau phone picker. Kept intentionally focused on
// the markets most likely to appear for Zitouna buyers (Maghreb, EU, Gulf,
// North America). Dial code is what we store; the flag + name are for UX.
const PHONE_COUNTRY_CODES = [
  { code: '+216', flag: '🇹🇳', name: 'Tunisie' },
  { code: '+213', flag: '🇩🇿', name: 'Algérie' },
  { code: '+212', flag: '🇲🇦', name: 'Maroc' },
  { code: '+218', flag: '🇱🇾', name: 'Libye' },
  { code: '+20',  flag: '🇪🇬', name: 'Égypte' },
  { code: '+33',  flag: '🇫🇷', name: 'France' },
  { code: '+32',  flag: '🇧🇪', name: 'Belgique' },
  { code: '+41',  flag: '🇨🇭', name: 'Suisse' },
  { code: '+49',  flag: '🇩🇪', name: 'Allemagne' },
  { code: '+39',  flag: '🇮🇹', name: 'Italie' },
  { code: '+34',  flag: '🇪🇸', name: 'Espagne' },
  { code: '+44',  flag: '🇬🇧', name: 'Royaume-Uni' },
  { code: '+31',  flag: '🇳🇱', name: 'Pays-Bas' },
  { code: '+971', flag: '🇦🇪', name: 'Émirats' },
  { code: '+966', flag: '🇸🇦', name: 'Arabie S.' },
  { code: '+974', flag: '🇶🇦', name: 'Qatar' },
  { code: '+965', flag: '🇰🇼', name: 'Koweït' },
  { code: '+973', flag: '🇧🇭', name: 'Bahreïn' },
  { code: '+1',   flag: '🇨🇦', name: 'Canada / USA' },
]

const SALE_WIZARD_STEP_COUNT = 6
const SALE_WIZARD_LABELS = [
  '1. Projet',
  '2. Parcelles',
  '3. Client acheteur',
  '4. Acompte terrain',
  '5. Paiement',
  '6. Vérification',
]
const SALE_WIZARD_HELPERS = [
  'Choisissez le projet concerné par la vente.',
  'Appuyez sur les numéros des parcelles à réserver. Les cases grisées sont déjà prises.',
  'Retrouvez le client par son numéro de téléphone (8 chiffres). Créez sa fiche si besoin.',
  'Montant fixé par les paramètres du projet — simple vérification.',
  "Comptant ou échelonné : choisissez, puis sélectionnez l'offre si nécessaire.",
  "Relisez tout avant d'envoyer la vente à la coordination.",
]

/** Cycle vente (technique) — métier : coordination relance le client en pending_finance ; le notaire n'agit qu'après passage en pending_legal. */
export const STATUS_FLOW = {
  // Note: `draft` transitions keep working as "send to finance", to match the rest of the pipeline.
  [SALE_STATUS.DRAFT]: {
    ...getSaleStatusMeta(SALE_STATUS.DRAFT),
    next: SALE_STATUS.PENDING_FINANCE,
    nextLabel: 'Envoyer à la finance',
  },
  [SALE_STATUS.PENDING_FINANCE]: { ...getSaleStatusMeta(SALE_STATUS.PENDING_FINANCE), next: SALE_STATUS.PENDING_LEGAL, nextLabel: 'Confirmer le paiement et envoyer au notaire' },
  [SALE_STATUS.PENDING_LEGAL]: { ...getSaleStatusMeta(SALE_STATUS.PENDING_LEGAL), next: SALE_STATUS.ACTIVE, nextLabel: 'Finaliser le contrat' },
  [SALE_STATUS.ACTIVE]: { ...getSaleStatusMeta(SALE_STATUS.ACTIVE), next: null, nextLabel: null },
  [SALE_STATUS.COMPLETED]: { ...getSaleStatusMeta(SALE_STATUS.COMPLETED), next: null, nextLabel: null },
  [SALE_STATUS.CANCELLED]: { ...getSaleStatusMeta(SALE_STATUS.CANCELLED), next: null, nextLabel: null },
  [SALE_STATUS.REJECTED]: { ...getSaleStatusMeta(SALE_STATUS.REJECTED), next: null, nextLabel: null },
}

const PAYMENT_TYPE = {
  full:         { label: 'Comptant',  badge: 'blue',   icon: '💵' },
  installments: { label: 'Echelonne', badge: 'orange', icon: '📅' },
}

/** Affichage carnet vente : pipeline, réservation, snapshots figés (ou aperçu workflow projet avant création). */
function SaleLedgerPanel({ sale, previewWorkflow, variant = 'wizard' }) {
  const preview = Boolean(previewWorkflow)
  const wrapClass = variant === 'detail' ? 'sp-detail__section' : 'sp-recap-section'
  const titleClass = variant === 'detail' ? 'sp-detail__section-title' : 'sp-recap-section-title'
  const rowClass = variant === 'detail' ? 'sp-detail__row' : 'sp-recap-row'

  const fee = preview
    ? { companyFeePct: previewWorkflow.companyFeePct, notaryFeePct: previewWorkflow.notaryFeePct }
    : sale?.feeSnapshot
  const pricing = sale?.pricingSnapshot
  const chk = sale?.checklistSnapshot
  const rawItems = chk?.items ?? (Array.isArray(chk) ? chk : null)
  const items = preview ? previewWorkflow.signatureChecklist : rawItems
  const comm = preview
    ? previewWorkflow.commissionRules
    : sale?.commissionRuleSnapshot?.levels ?? sale?.commissionRuleSnapshot

  const reservationStatus = sale?.reservationStatus
  const showReservation =
    !preview &&
    sale &&
    ((reservationStatus && reservationStatus !== 'none') || sale.reservationStartedAt || sale.reservationExpiresAt)

  const grantPagesLabel = (pages) => {
    if (pages == null) return ''
    const arr = Array.isArray(pages) ? pages : [pages]
    return arr.filter(Boolean).join(', ')
  }

  return (
    <div className={wrapClass}>
      <div className={titleClass}>{preview ? 'Aperçu règles projet (figées à la création)' : 'Carnet & snapshots (immuable)'}</div>
      {preview ? (
        <p className="sp-wizard__helper sp-wizard__helper--mt0">
          Montants et listes issus du workflow projet au moment de la validation.
        </p>
      ) : null}
      {!preview && sale ? (
        <>
          {(sale.pipelineStatus || sale.postNotaryDestination) && (
            <>
              <div className={rowClass}>
                <span>Pipeline</span>
                <strong>{sale.pipelineStatus || '—'}</strong>
              </div>
              <div className={rowClass}>
                <span>Après notaire</span>
                <strong>{sale.postNotaryDestination || '—'}</strong>
              </div>
            </>
          )}
          {showReservation ? (
            <>
              <div className={rowClass}>
                <span>Réservation</span>
                <strong>{reservationStatus || '—'}</strong>
              </div>
              <div className={rowClass}>
                <span>Début</span>
                <strong>{fmtFrDateTime(sale.reservationStartedAt)}</strong>
              </div>
              <div className={rowClass}>
                <span>Expiration</span>
                <strong>{fmtFrDateTime(sale.reservationExpiresAt)}</strong>
              </div>
            </>
          ) : null}
          <div className={rowClass}>
            <span>Version config</span>
            <strong>{sale.configSnapshotVersion ?? '—'}</strong>
          </div>
        </>
      ) : null}
      {fee && (fee.companyFeePct != null || fee.notaryFeePct != null) ? (
        <div className={rowClass}>
          <span>Frais société / notaire</span>
          <strong>
            {Number(fee.companyFeePct ?? 0)}% / {Number(fee.notaryFeePct ?? 0)}%
          </strong>
        </div>
      ) : null}
      {pricing && !preview ? (
        <>
          <div className={rowClass}>
            <span>Prix convenu (snapshot)</span>
            <strong>{Number(pricing.agreedPrice ?? 0).toLocaleString('fr-FR')} TND</strong>
          </div>
          <div className={rowClass}>
            <span>Mode (snapshot)</span>
            <strong>
              {pricing.paymentMode === 'installments'
                ? 'Echelonne'
                : pricing.paymentMode === 'full'
                  ? 'Comptant'
                  : pricing.paymentMode || '—'}
            </strong>
          </div>
        </>
      ) : null}
      {Array.isArray(items) && items.length > 0 ? (
        <div
          className={rowClass}
          style={
            variant === 'detail'
              ? { flexDirection: 'column', alignItems: 'stretch', gap: 8 }
              : { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }
          }
        >
          <span>Checklist signatures</span>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85em' }}>
            {items.map((it, i) => (
              <li key={it.key || i}>
                <strong>{it.label || it.key}</strong>
                {it.required ? ' (requis)' : ' (opt.)'}
                {grantPagesLabel(it.grantAllowedPages) ? ` → accès ${grantPagesLabel(it.grantAllowedPages)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {Array.isArray(comm) && comm.length > 0 ? (
        <div
          className={rowClass}
          style={
            variant === 'detail'
              ? { flexDirection: 'column', alignItems: 'stretch', gap: 8 }
              : { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }
          }
        >
          <span>Règles commission (snapshot)</span>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85em' }}>
            {comm.map((r, i) => (
              <li key={i}>
                Niveau {r.level}: {r.ruleType === 'fixed' ? `${r.value} TND` : `${r.value}%`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!preview && sale?.arabonPolicySnapshot && Object.keys(sale.arabonPolicySnapshot).length > 0 ? (
        <div className={rowClass}>
          <span>Politique arabon (snapshot)</span>
          <strong style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.72rem', wordBreak: 'break-all' }}>
            {JSON.stringify(sale.arabonPolicySnapshot)}
          </strong>
        </div>
      ) : null}
    </div>
  )
}

function initialsFromName(name) {
  if (!name || !String(name).trim()) return '?'
  const parts = String(name).trim().split(/\s+/).slice(0, 2)
  return parts.map(p => p[0]).join('').toUpperCase().slice(0, 2)
}

function reservationTtlText(sale) {
  if (!sale.reservationExpiresAt) return null
  if (sale.financeConfirmedAt || sale.stampedAt) return null
  if (['active', 'completed', 'cancelled', 'rejected'].includes(sale.status)) return null
  const exp = new Date(sale.reservationExpiresAt).getTime()
  const now = Date.now()
  const diff = exp - now
  if (diff <= 0) return { text: 'Expirée', urgent: true }
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  return { text: `${h}h${String(m).padStart(2, '0')} restantes`, urgent: h < 6 }
}

export default function SellPage() {
  const navigate = useNavigate()
  const { adminUser, user, clientProfile, isSellerClient } = useAuth()
  const role = canonicalRole(adminUser?.role || '')
  const sellerMode = Boolean(isSellerClient && !adminUser)
  const { addToast } = useToast()
  const { projects, updateParcelStatus } = useProjects()
  const { clients, upsert: clientUpsert, refresh: refreshClients } = useClients()

  const myClientId = useMemo(() => {
    if (clientProfile?.id) return clientProfile.id
    if (!user?.id || !clients?.length) return null
    const match = clients.find(c => c.authUserId && String(c.authUserId) === String(user.id))
    return match?.id || null
  }, [clientProfile?.id, user?.id, clients])
  const { offersByProject } = useOffers()
  const { sales, loading: salesLoading, error: salesError, create: salesCreate, update: salesUpdate, refresh: refreshSales } = useSales()
  // Bypass useInstallments() here — it eagerly fetches all plans+payments+receipts, none of which SellPage reads.
  const installmentsCreatePlan = useCallback(async (plan) => {
    const id = await db.createInstallmentPlan(plan)
    emitInvalidate('installmentPlans')
    return id
  }, [])
  const { adminUsers } = useAdminUsers()
  const { assignments: mySellerAssignments } = useMySellerParcelAssignments(sellerMode)

  const resolveAgentForSale = useCallback((sale) => {
    if (sellerMode) return null
    if (sale?.agentId) {
      const u = adminUsers.find(x => String(x.id) === String(sale.agentId))
      if (u) return { name: u.name, email: u.email, phone: u.phone }
    }
    if (sale?.managerId) {
      const u = adminUsers.find(x => String(x.id) === String(sale.managerId))
      if (u) return { name: u.name, email: u.email, phone: u.phone }
    }
    return null
  }, [adminUsers, sellerMode])

  const sellerAssignedParcelDbIds = useMemo(() => {
    if (!sellerMode) return new Set()
    return new Set((mySellerAssignments || []).map((a) => Number(a.parcelId)).filter((n) => Number.isFinite(n)))
  }, [sellerMode, mySellerAssignments])

  const sellerAssignedProjectIds = useMemo(() => {
    if (!sellerMode) return new Set()
    return new Set((mySellerAssignments || []).map((a) => String(a.projectId || '')).filter(Boolean))
  }, [sellerMode, mySellerAssignments])

  const scopedProjects = useMemo(() => {
    if (!sellerMode) return projects
    return projects
      .filter((p) => sellerAssignedProjectIds.has(String(p.id)))
      .map((p) => ({
        ...p,
        plots: (p.plots || []).filter((pl) => sellerAssignedParcelDbIds.has(Number(pl.dbId))),
      }))
  }, [sellerMode, projects, sellerAssignedProjectIds, sellerAssignedParcelDbIds])

  // Per-project arabon: derived from selected project's arabonDefault
  const arabonForProject = useCallback((projId) => {
    const p = scopedProjects.find(x => x.id === projId)
    return Number(p?.arabonDefault) || 50
  }, [scopedProjects])

  const isAdminOrSeller = Boolean(adminUser || sellerMode)
  useEffect(() => {
    if (!isAdminOrSeller) return
    return undefined
  }, [isAdminOrSeller])

  /** Liste affichée : l'agent ne voit que ses ventes ; dispo parcelles reste globale (évite double réservation). */
  const salesForList = useMemo(() => {
    if (sellerMode || (!adminUser && myClientId)) {
      const cid = String(myClientId || '')
      return sales.filter(s => String(s.sellerClientId || '') === cid)
    }
    if (role === 'Agent') {
      if (!adminUser?.id) return []
      return sales.filter(s => String(s.agentId || '') === String(adminUser.id))
    }
    if (role === 'Super Admin' || role === 'Sales Leader' || role === 'Finance' || role === 'Legal') {
      return sales
    }
    return []
  }, [sales, role, adminUser?.id, sellerMode, myClientId])
  const agentMayCancelSale = useCallback((sale) => {
    if (sellerMode) return ['draft', 'pending_finance'].includes(sale.status)
    if (role !== 'Agent') return true
    return ['draft', 'pending_finance'].includes(sale.status)
  }, [role, sellerMode])

  const FORM_STORAGE_KEY = 'sell_wizard_form'
  const STEP_STORAGE_KEY = 'sell_wizard_step'
  const DRAWER_STORAGE_KEY = 'sell_wizard_drawer'

  const [drawer, setDrawerRaw] = useState(() => {
    try { return sessionStorage.getItem(DRAWER_STORAGE_KEY) || null } catch { return null }
  })
  const setDrawer = useCallback((v) => {
    setDrawerRaw(v)
    try { if (v) sessionStorage.setItem(DRAWER_STORAGE_KEY, v); else sessionStorage.removeItem(DRAWER_STORAGE_KEY) } catch { /* */ }
  }, [])
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [page, setPage] = useState(1)
  const SALES_PER_PAGE = 10

  const blankForm = { projectId: '', plotIds: [], clientId: '', offerId: '', notes: '', paymentType: 'installments', deposit: '', useCustomPrice: false, overridePrices: {} }

  // FE-M2 — track which auth user the persisted draft was written under.
  // When the auth user changes (sign out + sign in as someone else), we
  // wipe the draft so the new user never sees the previous seller's
  // in-progress wizard state.
  const FORM_OWNER_KEY = 'sell_wizard_form_owner'

  const [form, setFormRaw] = useState(() => {
    try {
      const owner = sessionStorage.getItem(FORM_OWNER_KEY)
      const currentUid = user?.id || ''
      if (owner && currentUid && owner !== currentUid) {
        sessionStorage.removeItem(FORM_STORAGE_KEY)
        sessionStorage.removeItem(STEP_STORAGE_KEY)
        sessionStorage.removeItem(DRAWER_STORAGE_KEY)
        sessionStorage.setItem(FORM_OWNER_KEY, currentUid)
        return blankForm
      }
      if (currentUid && !owner) sessionStorage.setItem(FORM_OWNER_KEY, currentUid)
      const saved = sessionStorage.getItem(FORM_STORAGE_KEY)
      if (saved) return { ...blankForm, ...JSON.parse(saved) }
    } catch { /* ignore */ }
    return blankForm
  })
  const setForm = useCallback((updater) => {
    setFormRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      try {
        sessionStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(next))
        if (user?.id) sessionStorage.setItem(FORM_OWNER_KEY, user.id)
      } catch { /* ignore */ }
      return next
    })
  }, [user?.id])

  // FE-M2 — react to in-tab user change by wiping the wizard immediately
  // (covers the rare staff-sudo / fast-user-switch case). The check above
  // handles cold-mount; this handles live transitions.
  useEffect(() => {
    if (!user?.id) return
    let owner = null
    try { owner = sessionStorage.getItem(FORM_OWNER_KEY) } catch { /* ignore */ }
    if (owner && owner !== user.id) {
      try {
        sessionStorage.removeItem(FORM_STORAGE_KEY)
        sessionStorage.removeItem(STEP_STORAGE_KEY)
        sessionStorage.removeItem(DRAWER_STORAGE_KEY)
        sessionStorage.setItem(FORM_OWNER_KEY, user.id)
      } catch { /* ignore */ }
      setFormRaw(blankForm)
      setSaleWizardStepRaw(1)
      setDrawerRaw(null)
    } else if (!owner) {
      try { sessionStorage.setItem(FORM_OWNER_KEY, user.id) } catch { /* ignore */ }
    }
  // setForm helpers are stable; only re-run on user change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])
  const { workflow: sellFormProjectWorkflow } = useProjectWorkflow(form.projectId || '')
  const [editId, setEditId] = useState(null)

  const [clientModal, setClientModal] = useState(false)
  const [clientForm, setClientForm] = useState({ name: '', phone: '', phoneCc: '+216', cin: '', city: '' })
  const [clientSaving, setClientSaving] = useState(false)
  const [saleSaving, setSaleSaving] = useState(false)
  const [cinLookup, setCinLookup] = useState('')
  const [cinLookupResult, setCinLookupResult] = useState(null)
  const [actionModal, setActionModal] = useState(null)
  const [detailSale, setDetailSale] = useState(null)

  const withTimeout = useCallback(async (promise, ms, message) => {
    let timer = null
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(message)), ms)
        }),
      ])
    } finally {
      if (timer != null) window.clearTimeout(timer)
    }
  }, [])
  const [saleWizardStep, setSaleWizardStepRaw] = useState(() => {
    try { const s = Number(sessionStorage.getItem(STEP_STORAGE_KEY)); return s >= 1 ? s : 1 } catch { return 1 }
  })
  const setSaleWizardStep = useCallback((v) => {
    setSaleWizardStepRaw(prev => {
      const val = typeof v === 'function' ? v(prev) : v
      try { sessionStorage.setItem(STEP_STORAGE_KEY, String(val)) } catch { /* */ }
      return val
    })
  }, [])
  /** Horodatage figé à l'entrée sur l'étape finale (piste audit / récap). */
  const [recapCapturedAt, setRecapCapturedAt] = useState(null)

  const todayIso = new Date().toISOString().slice(0, 10)
  const salesToday = useMemo(() => {
    return salesForList
      .filter(s => (s.createdAt || '').slice(0, 10) === todayIso && !['cancelled', 'rejected'].includes(s.status))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  }, [salesForList, todayIso])

  const todayDepositTotal = useMemo(() => salesToday.reduce((a, s) => a + (Number(s.deposit) || 0), 0), [salesToday])
  const todaySaleCount = salesToday.length

  const displayAgentName = adminUser?.name || user?.name || 'Commercial'
  const commercialRoleLabel = sellerMode
    ? 'Vendeur partenaire'
    : role === 'Agent'
      ? 'Agent commercial'
      : role === 'Sales Leader'
        ? 'Responsable commercial'
        : 'Équipe commerciale'
  const agentCity = scopedProjects[0]?.city || ''
  const avatarSeed = encodeURIComponent(displayAgentName)
  const goBack = useCallback(() => navigate(-1), [navigate])

  const selectedProject = scopedProjects.find(p => p.id === form.projectId)
  const allProjectPlots = selectedProject?.plots || []

  // In seller-mode, the sponsor/ambassador is automatically the current seller client.
  // For hybrid admin sessions (staff account with a linked clientProfile), we also
  // resolve the seller record so the wizard recap shows who will be credited as L1.
  const sellerClientRecord = useMemo(() => {
    if (!myClientId) return null
    return (clients || []).find((c) => String(c.id) === String(myClientId)) || null
  }, [myClientId, clients])

  // The buyer id currently selected in the wizard. Used to block a seller=buyer
  // assignment which would violate the DB CHECK `sales_seller_neq_buyer` and is
  // also nonsensical business-wise (buyer cannot be their own L1).
  const wizardBuyerClientId = useMemo(() => String(form.clientId || ''), [form.clientId])

  // Effective seller for the sale row. Auto-wires `myClientId` (staff hybrid
  // clientProfile OR seller-mode) unless it would equal the buyer, in which case
  // we drop it so the commission engine can still fall back to the buyer's upline
  // without crediting the buyer themselves.
  const effectiveSellerClientId = useMemo(() => {
    if (!myClientId) return null
    if (String(myClientId) === wizardBuyerClientId) return null
    return myClientId
  }, [myClientId, wizardBuyerClientId])

  // True when the current user has a resolvable client profile and will therefore
  // be credited as L1 on this sale. Drives the wizard recap notice.
  const willBeCreditedAsSellerL1 = Boolean(effectiveSellerClientId)
  const sellerL1BlockedByBuyerEq = Boolean(
    myClientId && wizardBuyerClientId && String(myClientId) === wizardBuyerClientId,
  )

  /** Parcelles indisponibles : statut parcelle + ventes « engagées » (pas brouillon). Les brouillons ne bloquent pas une nouvelle vente. */
  const soldOrReservedIds = useMemo(() => {
    const set = new Set()
    const add = v => {
      const n = Number(v)
      if (Number.isFinite(n)) set.add(n)
      set.add(String(v))
    }
    const pid = String(form.projectId || '')
    for (const s of sales) {
      if (String(s.projectId || '') !== pid) continue
      if (['cancelled', 'rejected', 'draft'].includes(s.status)) continue
      if (editId && String(s.id) === String(editId)) continue
      for (const x of normalizePlotIds(s)) add(x)
    }
    for (const pl of allProjectPlots) {
      const st = String(pl.status || 'available').toLowerCase()
      if (st === 'reserved' || st === 'sold') add(pl.id)
    }
    return set
  }, [sales, form.projectId, allProjectPlots, editId])

  const plotIdTaken = useCallback(
    pl => {
      if (sellerMode && !sellerAssignedParcelDbIds.has(Number(pl.dbId))) return true
      const id = pl.id
      const n = Number(id)
      if (soldOrReservedIds.has(id)) return true
      if (Number.isFinite(n) && soldOrReservedIds.has(n)) return true
      if (soldOrReservedIds.has(String(id))) return true
      return false
    },
    [soldOrReservedIds, sellerMode, sellerAssignedParcelDbIds]
  )

  const isPlotAvailable = useCallback(
    pl => {
      if (editId && form.plotIds.some(pid => Number(pid) === Number(pl.id) || String(pid) === String(pl.id))) return true
      return !plotIdTaken(pl)
    },
    [plotIdTaken, editId, form.plotIds]
  )

  const availablePlots = allProjectPlots.filter(isPlotAvailable)
  const projectOffers = useMemo(() => offersByProject[form.projectId] || [], [offersByProject, form.projectId])

  const selectedPlots = useMemo(() => {
    return form.plotIds
      .map(id => allProjectPlots.find(p => p.id === Number(id) || p.id === id))
      .filter(Boolean)
  }, [form.plotIds, allProjectPlots])

  // Computed per-parcel price coming from the project data (tree batches rolled
  // up into p.totalPrice upstream). The override map (form.overridePrices) is
  // only applied when the staff explicitly opted in via the checkbox.
  const computedPlotPrice = useCallback((pl) => Number(pl?.totalPrice) || 0, [])
  const effectivePlotPrice = useCallback((pl) => {
    if (!pl) return 0
    const base = computedPlotPrice(pl)
    if (!form.useCustomPrice) return base
    const raw = form.overridePrices?.[String(pl.id)]
    if (raw === undefined || raw === null || raw === '') return base
    const num = Number(String(raw).replace(/\s/g, '').replace(',', '.'))
    return Number.isFinite(num) && num >= 0 ? num : base
  }, [form.useCustomPrice, form.overridePrices, computedPlotPrice])

  const totalArea = selectedPlots.reduce((s, p) => s + (p.area || 0), 0)
  const totalPlotPrice = selectedPlots.reduce((s, p) => s + effectivePlotPrice(p), 0)

  const filtered = useMemo(() => salesForList.filter(s => {
    if (filterStatus && s.status !== filterStatus) return false
    if (search) {
      const q = search.toLowerCase()
      const plotLabel = normalizePlotIds(s).map(id => `#${id}`).join(', ')
      if (
        !(s.clientName || '').toLowerCase().includes(q) &&
        !(s.projectTitle || '').toLowerCase().includes(q) &&
        !plotLabel.toLowerCase().includes(q) &&
        !(s.clientCin || '').toLowerCase().includes(q) &&
        !(s.clientEmail || '').toLowerCase().includes(q)
      ) return false
    }
    return true
  }), [salesForList, filterStatus, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / SALES_PER_PAGE))
  // Reset to page 1 when the filter result shrinks below the current page.
  useEffect(() => {
    if (page > pageCount) setPage(1)
  }, [page, pageCount])
  useEffect(() => { setPage(1) }, [search, filterStatus])
  const pagedFiltered = useMemo(
    () => filtered.slice((page - 1) * SALES_PER_PAGE, page * SALES_PER_PAGE),
    [filtered, page],
  )

  // Schema requires sales.client_id NOT NULL (see database/02_schema.sql):
  // there is no "pending phone reservation" at DB level — a client row must
  // exist (staff creates it directly, delegated seller goes through the
  // create_buyer_stub_for_sale RPC). We enforce that here so the wizard
  // cannot reach salesCreate with an empty uuid.
  const saleFormSubmitBlocked =
    !form.projectId ||
    form.plotIds.length === 0 ||
    !form.clientId ||
    (form.paymentType === 'installments' && form.offerId === '' && projectOffers.length > 0)

  const wizardSelectedClient = clients.find(c => c.id === form.clientId)

  const wizardFinancialRecap = useMemo(() => {
    const arabon = Number(form.deposit) || 0
    if (form.paymentType === 'full' && selectedPlots.length > 0) {
      const toPay = Math.max(0, totalPlotPrice - arabon)
      return {
        kind: 'full',
        totalPlotPrice,
        arabon,
        toPay,
        plotCount: selectedPlots.length,
      }
    }
    if (
      form.paymentType === 'installments' &&
      form.offerId !== '' &&
      projectOffers[Number(form.offerId)] &&
      selectedPlots.length > 0
    ) {
      const o = projectOffers[Number(form.offerId)]
      const price = (!form.useCustomPrice && o.price) ? o.price * selectedPlots.length : totalPlotPrice
      const down = Math.round((price * o.downPayment) / 100)
      const remaining = price - down
      const monthly = Math.round(remaining / o.duration)
      const toPay = Math.max(0, down - arabon)
      return {
        kind: 'installments',
        offer: o,
        price,
        down,
        remaining,
        monthly,
        duration: o.duration,
        downPct: o.downPayment,
        arabon,
        toPay,
        plotCount: selectedPlots.length,
      }
    }
    return { kind: 'incomplete' }
  }, [form.deposit, form.paymentType, form.offerId, form.useCustomPrice, selectedPlots, totalPlotPrice, projectOffers])

  const saleBeingEdited = useMemo(
    () => (editId ? sales.find((s) => String(s.id) === String(editId)) : null),
    [editId, sales],
  )

  useEffect(() => {
    if (saleWizardStep === SALE_WIZARD_STEP_COUNT) {
      setRecapCapturedAt(new Date().toISOString())
    }
  }, [saleWizardStep])

  const openNew = () => {
    const firstProjId = scopedProjects[0]?.id || ''
    setForm({ ...blankForm, projectId: firstProjId, deposit: String(arabonForProject(firstProjId)) })
    setCinLookup('')
    setCinLookupResult(null)
    setEditId(null)
    setSaleWizardStep(1)
    setRecapCapturedAt(null)
    setDrawer('form')
  }

  const openEdit = (sale) => {
    const { ambassadorClientId: _omitAmb, ...saleRest } = sale
    setForm({
      ...saleRest,
      plotIds: normalizePlotIds(sale),
      // L acompte terrain est pilote uniquement par les reglages projet.
      // Always display the project default, never the historical/manual value.
      deposit: String(arabonForProject(sale.projectId)),
    })
    setCinLookup(
      sale.clientCin || normalizePhoneLookup(sale.buyerPhoneClaim || sale.buyerPhoneNormalized || sale.clientPhone || ''),
    )
    const found = sale.clientCin
      ? clients.find(c => c.cin === sale.clientCin || normalizePhoneLookup(c.phone) === normalizePhoneLookup(sale.clientPhone))
      : clients.find(c => normalizePhoneLookup(c.phone) === normalizePhoneLookup(sale.clientPhone || sale.buyerPhoneNormalized || ''))
    setCinLookupResult(found || null)
    setEditId(sale.id)
    setSaleWizardStep(1)
    setRecapCapturedAt(null)
    setDrawer('edit')
  }

  const closeSaleDrawer = useCallback(() => {
    setDrawer(null)
    setSaleWizardStep(1)
    setRecapCapturedAt(null)
    setFormRaw(blankForm)
    try {
      sessionStorage.removeItem(FORM_STORAGE_KEY)
      sessionStorage.removeItem(STEP_STORAGE_KEY)
      sessionStorage.removeItem(DRAWER_STORAGE_KEY)
    } catch { /* */ }
  }, [setDrawer, setSaleWizardStep])

  const tryWizardNext = useCallback(() => {
    if (saleWizardStep >= SALE_WIZARD_STEP_COUNT) return
    if (saleWizardStep === 1 && !form.projectId) {
      addToast('Choisissez un projet.', 'error')
      return
    }
    if (saleWizardStep === 2) {
      if (!form.plotIds.length) {
        addToast('Sélectionnez au moins une parcelle.', 'error')
        return
      }
      if (form.useCustomPrice) {
        for (const pl of selectedPlots) {
          const raw = form.overridePrices?.[String(pl.id)]
          const num = Number(String(raw ?? '').replace(/\s/g, '').replace(',', '.'))
          if (!Number.isFinite(num) || num <= 0) {
            addToast(`Saisissez un prix personnalisé valide pour la parcelle #${pl.label ?? pl.id}.`, 'error')
            return
          }
        }
      }
    }
    if (saleWizardStep === 3) {
      if (!form.clientId) {
        addToast(
          "Identifiez le client par téléphone ou créez une fiche (« + Nouveau »). Une vente ne peut pas être enregistrée sans client.",
          'error',
        )
        return
      }
    }
    if (saleWizardStep === 5) {
      if (form.paymentType === 'installments' && projectOffers.length > 0 && !form.offerId) {
        addToast('Choisissez une offre de paiement ou passez en comptant.', 'error')
        return
      }
      if (form.paymentType === 'installments' && form.projectId && projectOffers.length === 0) {
        addToast('Aucune offre pour ce projet : passez en comptant ou configurez les offres.', 'error')
        return
      }
    }
    setSaleWizardStep(s => Math.min(SALE_WIZARD_STEP_COUNT, s + 1))
  }, [saleWizardStep, form, projectOffers.length, addToast, cinLookup.length, cinLookupResult, selectedPlots])

  const plotIdEquals = useCallback((a, b) => {
    if (a == null || b == null) return false
    return Number(a) === Number(b) || String(a) === String(b)
  }, [])

  const togglePlotInline = useCallback(
    pl => {
      if (!isPlotAvailable(pl)) return
      const numId = Number(pl.id)
      const nextVal = Number.isFinite(numId) ? numId : String(pl.id)
      setForm(f => {
        const has = f.plotIds.some(pid => plotIdEquals(pid, pl.id))
        const next = has
          ? f.plotIds.filter(pid => !plotIdEquals(pid, pl.id))
          : [...f.plotIds, nextVal]
        return { ...f, plotIds: next }
      })
    },
    [isPlotAvailable, plotIdEquals]
  )

  const sortedProjectPlots = useMemo(
    () => [...allProjectPlots].sort((a, b) => Number(a.id) - Number(b.id)),
    [allProjectPlots]
  )

  // ── "Sélection rapide" panel state (step 2). Lets the staff auto-pick N
  // adjacent or random available parcels instead of clicking each tile.
  const [quickPickOpen, setQuickPickOpen] = useState(false)
  const [quickPickCount, setQuickPickCount] = useState(1)
  const [quickPickMode, setQuickPickMode] = useState('adjacent') // 'adjacent' | 'random'

  const sortedAvailablePlots = useMemo(
    () => sortedProjectPlots.filter(isPlotAvailable),
    [sortedProjectPlots, isPlotAvailable]
  )
  const quickPickMax = sortedAvailablePlots.length

  const runQuickPick = useCallback(() => {
    const n = Math.max(1, Math.min(Number(quickPickCount) || 1, quickPickMax))
    if (quickPickMax === 0) {
      addToast("Aucune parcelle disponible pour ce projet.", 'info')
      return
    }
    let chosen = []
    if (quickPickMode === 'adjacent') {
      // Find all windows of N consecutive parcel_numbers among available plots.
      // We use the legacy integer id (pl.id) for adjacency — label is cosmetic.
      const windows = []
      const list = sortedAvailablePlots
      for (let i = 0; i + n <= list.length; i++) {
        let ok = true
        for (let k = 1; k < n; k++) {
          if (Number(list[i + k].id) !== Number(list[i + k - 1].id) + 1) { ok = false; break }
        }
        if (ok) windows.push(list.slice(i, i + n))
      }
      if (windows.length > 0) {
        chosen = windows[Math.floor(Math.random() * windows.length)]
      } else {
        chosen = list.slice(0, n)
        addToast('Pas assez de parcelles consécutives — sélection partielle.', 'info')
      }
    } else {
      // Random: pick N distinct available plots (Fisher-Yates partial shuffle).
      const pool = [...sortedAvailablePlots]
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t
      }
      chosen = pool.slice(0, n)
    }
    const ids = chosen.map(pl => {
      const num = Number(pl.id)
      return Number.isFinite(num) ? num : String(pl.id)
    })
    setForm(f => ({ ...f, plotIds: ids }))
    setQuickPickOpen(false)
    addToast(`${ids.length} parcelle${ids.length > 1 ? 's' : ''} sélectionnée${ids.length > 1 ? 's' : ''}.`, 'success')
  }, [quickPickCount, quickPickMax, quickPickMode, sortedAvailablePlots, setForm, addToast])

  // Derived clamp for the "combien" input — avoids a set-state-in-effect.
  const clampedQuickPickCount = Math.max(1, Math.min(quickPickCount, Math.max(1, quickPickMax)))

  const handleSave = useCallback(async () => {
    if (saleSaving) return
    // cinLookupResult is the last successful phone lookup / RPC-created row;
    // the useClients hook may not have refreshed yet, so fall back to it when
    // the local list doesn't contain form.clientId.
    const clientFromList = form.clientId ? clients.find(c => c.id === form.clientId) : null
    const client = clientFromList
      || (cinLookupResult && cinLookupResult.id && String(cinLookupResult.id) === String(form.clientId)
          ? cinLookupResult
          : null)
    const claimNorm = client?.phone
      ? normalizePhone(client.phone)
      : normalizePhone(cinLookup)
    if (!claimNorm) {
      addToast('Téléphone acheteur requis pour enregistrer la vente.', 'error')
      return
    }
    const project = scopedProjects.find(p => p.id === form.projectId)
    const plots = form.plotIds
      .map(id => (project?.plots || []).find(p => p.id === Number(id) || p.id === id))
      .filter(Boolean)
    const isInstallments = form.paymentType === 'installments' && form.offerId !== ''
    const offer = isInstallments ? (projectOffers[Number(form.offerId)] || null) : null

    const plotsTotalPrice = plots.reduce((s, p) => s + effectivePlotPrice(p), 0)
    // When the user manually overrides per-parcel prices, their total is
    // authoritative and supersedes the offer's flat-price multiplication.
    const price = (!form.useCustomPrice && offer && offer.price)
      ? (offer.price * plots.length)
      : plotsTotalPrice
    // Arabon (terrain) is controlled only by project settings (project arabonDefault).
    // Never allow editing from this screen.
    const depositAmount = Number(arabonForProject(form.projectId)) || 0
    const plotDbIds = plots.map(p => p.dbId).filter(Boolean)

    if (sellerMode) {
      if (!plotDbIds.length || plotDbIds.some((id) => !sellerAssignedParcelDbIds.has(Number(id)))) {
        addToast('Vous pouvez uniquement vendre les parcelles assignees a votre compte vendeur.', 'error')
        return
      }
    }

    if (!price || Number(price) <= 0) {
      addToast("Prix convenu invalide : vérifiez les parcelles et l'offre.", 'error')
      return
    }
    const priceNum = Number(price) || 0
    if (depositAmount - priceNum > 0.005) {
      addToast('Acompte terrain ne peut pas dépasser le prix convenu.', 'error')
      return
    }

    setSaleSaving(true)
    let watchdogFired = false
    const watchdog = window.setTimeout(() => {
      watchdogFired = true
      setSaleSaving(false)
      addToast("La création n'a pas répondu à temps (30 s). Vérifiez votre connexion et réessayez.", 'error')
    }, 30000)
    try {
      if (editId) {
        const prevSale = sales.find(s => s.id === editId)
        const canEditStructure = prevSale && ['draft', 'pending_finance'].includes(prevSale.status)
        if (prevSale && !canEditStructure) {
          if (
            form.projectId !== prevSale.projectId ||
            form.clientId !== prevSale.clientId ||
            !plotSelectionMatchesSale(prevSale, form.plotIds)
          ) {
            addToast('Projet, client ou parcelles : ne peuvent plus être modifiés après transmission à la finance ou au notaire.', 'error')
            return
          }
        }

        const structuralPatch = canEditStructure
          ? {
              projectId: form.projectId,
              parcelId: plotDbIds[0],
              parcelIds: plotDbIds,
              offerId: offer?.dbId ?? null,
              clientId: form.clientId,
              ambassadorCin: prevSale?.ambassadorCin || '',
              ambassadorClientId: prevSale?.ambassadorClientId || null,
            }
          : {}

        await salesUpdate(editId, {
          notes: form.notes,
          deposit: depositAmount,
          advancePaid: 0,
          agreedPrice: price,
          plotsTotalPrice,
          paymentType: isInstallments ? 'installments' : 'full',
          offerName: offer?.name || (isInstallments ? '' : 'Comptant'),
          offerDownPayment: offer?.downPayment || 0,
          offerDuration: offer?.duration || 0,
          ambassadorCin: prevSale?.ambassadorCin || '',
          ...structuralPatch,
          // Auto-wire seller for hybrid admin / seller-mode, but never assign the
          // buyer as their own seller (DB CHECK `sales_seller_neq_buyer`).
          ...(effectiveSellerClientId ? { sellerClientId: effectiveSellerClientId } : {}),
        })

        if (canEditStructure && prevSale) {
          const oldDbIds = [...(prevSale.parcelIds || [])].map(Number).filter(Boolean)
          const newDbIds = [...plotDbIds].map(Number).filter(Boolean)
          const newSet = new Set(newDbIds)
          const oldSet = new Set(oldDbIds)
          for (const id of oldDbIds) {
            if (!newSet.has(id)) await updateParcelStatus(id, 'available')
          }
          for (const id of newDbIds) {
            if (!oldSet.has(id)) await updateParcelStatus(id, 'reserved')
          }
        }
      } else {
        const wf = await db.fetchProjectWorkflowConfig(form.projectId)
        const feeSnap = {
          companyFeePct: wf.companyFeePct,
          notaryFeePct: wf.notaryFeePct,
          version: 1,
        }
        const commissionSnap = { levels: JSON.parse(JSON.stringify(wf.commissionRules || [])) }
        const checklistSnap = { items: JSON.parse(JSON.stringify(wf.signatureChecklist || [])) }
        const offerSnap = offer
          ? {
              name: offer.name,
              downPayment: offer.downPayment,
              duration: offer.duration,
              price: offer.price,
            }
          : {}
        const pricingSnap = {
          agreedPrice: priceNum,
          deposit: depositAmount,
          paymentType: isInstallments ? 'installments' : 'full',
          version: 1,
        }
        // Commission is credited to the vendeur (sellerClientId). We mirror that
        // into ambassador_* for legacy surfaces. For a hybrid admin session the
        // staff member is also the L1 beneficiary — but never when they happen to
        // also be the buyer on this sale (guarded by effectiveSellerClientId).
        const ambassadorClientId = effectiveSellerClientId
        const ambassadorCin = effectiveSellerClientId ? (sellerClientRecord?.cin || '') : ''
        const rh = wf.reservationHours || 48
        if (!client?.id) {
          addToast("Client manquant : sélectionnez ou créez une fiche avant de soumettre la vente.", 'error')
          return
        }
        await salesCreate({
          projectId: form.projectId,
          projectTitle: project?.title || '',
          parcelId: plotDbIds[0],
          parcelIds: plotDbIds,
          clientId: client.id,
          clientName: client.name || 'Acheteur',
          buyerPhoneClaim: claimNorm,
          buyerPhoneNormalized: claimNorm,
          buyerUserId: client.id,
          buyerAuthUserId: client.authUserId || null,
          paymentType: isInstallments ? 'installments' : 'full',
          offerId: offer?.dbId || null,
          agreedPrice: price,
          deposit: depositAmount,
          advancePaid: 0,
          plotsTotalPrice,
          offerDownPayment: offer?.downPayment || 0,
          offerDuration: offer?.duration || 0,
          offerName: offer?.name || (isInstallments ? '' : 'Comptant'),
          paymentMethod: isInstallments ? 'Echelonne' : 'Comptant',
          ambassadorCin,
          ambassadorClientId,
          sellerClientId: effectiveSellerClientId,
          notes: form.notes || '',
          // After sell, the dossier is automatically sent to Notary (/admin/legal),
          // and Coordination can still plan/track it.
          // After sell, the dossier stays in Coordination first.
          // Coordination decides when to dispatch to Finance.
          status: 'pending_coordination',
          pipelineStatus: 'pending_coordination',
          postNotaryDestination: isInstallments ? 'plans' : 'cash_sales',
          configSnapshotVersion: 1,
          pricingSnapshot: pricingSnap,
          feeSnapshot: feeSnap,
          checklistSnapshot: checklistSnap,
          commissionRuleSnapshot: commissionSnap,
          offerSnapshot: offerSnap,
          arabonPolicySnapshot: wf.arabonPolicy || {},
          reservationStartedAt: new Date().toISOString(),
          reservationExpiresAt: reservationExpiresAtIso(rh),
          reservationStatus: 'active',
          ...saleAttribution(role, adminUser),
        })
        // Pyramid links are now established at NOTARY COMPLETION (not sale
        // creation) — see NotaryDashboardPage.completeSale. A sale-creation
        // link would pollute the graph with cancelled/expired reservations
        // that never actually moved money.
        for (const p of plots) {
          if (p.dbId) await updateParcelStatus(p.dbId, 'reserved')
        }
      }
      if (!watchdogFired) {
        addToast(editId ? 'Vente mise à jour' : `Vente créée — ${plots.length} parcelle(s)`)
        closeSaleDrawer()
      }
    } catch (err) {
      if (watchdogFired) return
      const msg = String(err?.message || err || '')
      const code = String(err?.code || err?.details || '')
      if (/23505|unique|duplicate|already tied|engagée|overlap/i.test(msg) || /23505/.test(code)) {
        addToast('Une ou plusieurs parcelles sont déjà liées à une vente en cours. La liste a été actualisée.', 'error')
      } else {
        addToast(`Erreur : ${msg}`, 'error')
      }
      try {
        await refreshSales({ force: true })
      } catch {
        /* ignore */
      }
    } finally {
      window.clearTimeout(watchdog)
      if (!watchdogFired) setSaleSaving(false)
    }
  }, [saleSaving, form, editId, clients, scopedProjects, projectOffers, sales, salesCreate, salesUpdate, updateParcelStatus, addToast, role, adminUser, closeSaleDrawer, refreshSales, sellerMode, sellerAssignedParcelDbIds, myClientId, effectiveSellerClientId, cinLookup, sellerClientRecord?.cin, effectivePlotPrice])

  const advanceStatus = useCallback(async (sale) => {
    const flow = STATUS_FLOW[sale.status]
    if (!flow?.next) return
    const nextStatus = flow.next

    try {
      if (sale.status === 'pending_finance' && nextStatus === 'pending_legal') {
        await salesUpdate(sale.id, {
          status: 'pending_legal',
          paymentMethod: sale.paymentMethod || 'other',
          financeConfirmedAt: sale.financeConfirmedAt || new Date().toISOString(),
        })
        addToast(`Dossier transmis au notaire : ${sale.clientName || ''}`.trim())
        setActionModal(null)
        return
      }
      if (nextStatus === 'active') {
        if (sale.paymentType === 'full') {
          await salesUpdate(sale.id, { status: 'completed', paidAt: new Date().toISOString() })
          for (const dbId of (sale.parcelIds || [])) {
            await updateParcelStatus(dbId, 'sold')
          }
          addToast('Paiement confirmé — vente terminée ✓')
          setActionModal(null)
          return
        }
        if (sale.paymentType === 'installments') {
          const duration = Number(sale.offerDuration) || 24
          const downPct = Number(sale.offerDownPayment) || 20
          const agreedPrice = Number(sale.agreedPrice) || 0
          const downAmount = Math.round(agreedPrice * (downPct / 100) * 100) / 100
          const remaining = Math.max(0, agreedPrice - downAmount)
          const monthly = duration > 0
            ? Math.round((remaining / duration) * 100) / 100
            : remaining
          const startDate = new Date().toISOString().slice(0, 10)

          await installmentsCreatePlan({
            code: `INS-${sale.code || sale.id}`,
            saleId: sale.id,
            clientId: sale.clientId,
            projectId: sale.projectId,
            parcelId: sale.parcelId,
            totalPrice: agreedPrice,
            downPayment: downAmount,
            monthlyAmount: monthly,
            totalMonths: duration,
            startDate,
            status: 'active',
            payments: generatePaymentSchedule({
              totalPrice: agreedPrice,
              downPayment: downAmount,
              totalMonths: duration,
              startDate,
            }),
          })
          await salesUpdate(sale.id, { status: 'active' })
          addToast('Vente activée — échéancier créé')
          setActionModal(null)
          return
        }
      }

      await salesUpdate(sale.id, { status: nextStatus })
      addToast(`Statut mis à jour : ${STATUS_FLOW[nextStatus]?.label || nextStatus}`)
      setActionModal(null)
    } catch (err) {
      addToast(`Erreur : ${err.message}`, 'error')
    }
  }, [salesUpdate, installmentsCreatePlan, addToast])

  const handleCancel = useCallback(async () => {
    const sale = actionModal
    if (!sale) { setActionModal(null); return }
    if (!agentMayCancelSale(sale)) {
      addToast('Annulation réservée au responsable une fois le dossier chez la finance ou le notaire.', 'error')
      setActionModal(null)
      return
    }

    try {
      await salesUpdate(sale.id, { status: 'cancelled' })
      for (const dbId of (sale.parcelIds || [])) {
        await updateParcelStatus(dbId, 'available')
      }
      addToast('Vente annulée', 'error')
      setActionModal(null)
    } catch (err) {
      addToast(`Erreur : ${err.message}`, 'error')
    }
  }, [actionModal, salesUpdate, updateParcelStatus, addToast, agentMayCancelSale])

  const handleCreateClient = useCallback(async () => {
    console.log('[Sell] handleCreateClient: click received', { name: clientForm.name, phone: clientForm.phone })
    if (!clientForm.name.trim()) { addToast('Le nom est obligatoire', 'error'); return }
    const localDigits = String(clientForm.phone || '').replace(/\D/g, '')
    if (!localDigits) { addToast('Le téléphone est obligatoire', 'error'); return }
    // E.164 built from picked country code + local digits.
    const ccRaw = String(clientForm.phoneCc || '+216').trim()
    const cc = ccRaw.startsWith('+') ? ccRaw : `+${ccRaw.replace(/\D/g, '')}`
    const phoneE164 = `${cc}${localDigits}`
    // normalizedPhone remains the last-8 form used for local-table dedupe lookups.
    const normalizedPhone = normalizePhoneLookup(phoneE164)

    const cin = clientForm.cin.trim()
    const existing = clients.find(c => normalizePhoneLookup(c.phone) === normalizedPhone)
    if (existing) {
      setForm(f => ({ ...f, clientId: existing.id }))
      setCinLookup(normalizedPhone)
      setCinLookupResult(existing)
      addToast('Client déjà existant (téléphone) — sélectionné automatiquement')
      setClientModal(false)
      return
    }

    // Always use create_buyer_stub_for_sale RPC. It is security-definer and
    // bypasses the RLS lookup storms that make the staff upsert path hang.
    // Internally it authorizes on is_active_staff() OR /admin/sell grants —
    // so staff and delegated sellers both work. If the caller is neither, the
    // RPC returns a specific error we translate to a French toast.
    setClientSaving(true)
    try {
      const payload = {
        code: `CLI-${Date.now()}`,
        name: clientForm.name.trim(),
        email: '',
        phone: phoneE164 || normalizedPhone,
        cin,
        city: clientForm.city.trim(),
      }
      console.log('[Sell] create path: RPC (unified)', payload)
      // Belt and braces. The RPC is the canonical path for both staff and
      // delegated sellers. If it ever hangs or errors on a staff session
      // (where staff_clients_crud would let a direct insert through), we
      // fall back to db.upsertClient with its own short timeout so the user
      // is never stuck waiting for the initial request to die.
      let newClient = null
      try {
        newClient = await withTimeout(
          db.createBuyerStubForSale(payload),
          8_000,
          'rpc_timeout',
        )
      } catch (rpcErr) {
        const rpcMsg = String(rpcErr?.message || rpcErr || '')
        console.warn('[Sell] RPC failed, attempting staff fallback:', rpcMsg)
        if (adminUser?.id) {
          newClient = await withTimeout(
            clientUpsert({
              ...payload,
              ...(role === 'Agent' ? { ownerAgentId: adminUser.id } : {}),
            }),
            8_000,
            'fallback_timeout',
          )
        } else {
          throw rpcErr
        }
      }
      console.log('[Sell] create result:', newClient)
      refreshClients().catch(e => console.warn('[Sell] refreshClients after create failed:', e?.message || e))
      if (!newClient?.id) {
        addToast('Impossible de créer ce client pour le moment.', 'error')
        return
      }
      setForm(f => ({ ...f, clientId: newClient.id }))
      setCinLookup(normalizedPhone)
      setCinLookupResult(newClient)
      addToast('Client créé')
      setClientModal(false)
      setClientForm({ name: '', phone: '', phoneCc: '+216', cin: '', city: '' })
    } catch (err) {
      const raw = String(err?.message || err || '')
      console.error('[Sell] create error:', raw, err)
      if (/no_sell_grant/i.test(raw)) {
        addToast("Création refusée : votre compte n'a ni rôle staff ni grant /admin/sell. Demandez à un administrateur de créer le client.", 'error')
      } else if (/caller_not_linked_to_client/i.test(raw)) {
        addToast("Création refusée : votre session Supabase n'est liée à aucune fiche client. Reconnectez-vous ou demandez un rattachement.", 'error')
      } else if (/phone_required/i.test(raw)) {
        addToast('Téléphone invalide. Saisissez 8 chiffres (Tunisie) ou un numéro E.164.', 'error')
      } else if (/function .* does not exist|Could not find the function|PGRST202/i.test(raw)) {
        addToast('RPC create_buyer_stub_for_sale introuvable en base. Appliquez database/06_buyer_stub_rpc.sql.', 'error')
      } else if (/rpc_timeout|fallback_timeout|timeout/i.test(raw)) {
        addToast('Création: le serveur ne répond pas (>8 s). Vérifiez la connexion Supabase ou réessayez dans quelques secondes.', 'error')
      } else {
        addToast(`Erreur : ${raw}`, 'error')
      }
    }
    finally { setClientSaving(false) }
  }, [clientForm, clients, clientUpsert, addToast, refreshClients, withTimeout, adminUser?.id, role])

  const activeSales = salesForList.filter(s => !['cancelled', 'completed', 'rejected'].includes(s.status)).length
  const totalRevenue = salesForList.filter(s => ['active', 'completed'].includes(s.status)).reduce((s, x) => s + (x.agreedPrice || 0), 0)

  const renderSaleList = () => (
    <>
      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{salesForList.length}</strong> total
          <span className="sp-cat-stat-dot" />
          <strong>{activeSales}</strong> actives
          <span className="sp-cat-stat-dot" />
          <strong>{totalRevenue.toLocaleString('fr-FR')}</strong> TND
        </div>
        <div className="sp-cat-filters">
          <input className="sp-cat-search" placeholder="Rechercher…" value={search} onChange={e => setSearch(e.target.value)} />
          <select className="sp-cat-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(STATUS_FLOW).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      </div>
      {salesError && !salesLoading ? (
        <div className="sp-error-banner" role="alert">
          <div className="sp-error-banner__body">
            <strong>Impossible de charger les ventes.</strong>
            <span>{String(salesError?.message || salesError)}</span>
          </div>
          <button type="button" className="sp-error-banner__retry" onClick={() => refreshSales()}>
            Réessayer
          </button>
        </div>
      ) : null}
      <div className="sp-cards">
        {salesLoading && salesForList.length === 0 ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={`sk-${i}`} className="sp-card sp-card--skeleton" aria-hidden>
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials sk-box" />
                  <div style={{ flex: 1 }}>
                    <p className="sk-line sk-line--title" />
                    <p className="sk-line sk-line--sub" />
                  </div>
                </div>
                <span className="sk-line sk-line--badge" />
              </div>
              <div className="sp-card__body">
                <span className="sk-line sk-line--price" />
                <span className="sk-line sk-line--info" />
              </div>
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="sp-empty">
            <span className="sp-empty__emoji" aria-hidden>{salesForList.length === 0 ? '📭' : '🔍'}</span>
            <div className="sp-empty__title">{salesForList.length === 0 ? 'Aucune vente enregistrée.' : 'Aucun résultat.'}</div>
          </div>
        ) : pagedFiltered.map(s => {
          const flow = STATUS_FLOW[s.status]
          const pt = PAYMENT_TYPE[s.paymentType] || PAYMENT_TYPE.full
          const pIds = normalizePlotIds(s)
          const plotLabel = pIds.length <= 3 ? pIds.map(id => `#${id}`).join(', ') : `${pIds.length} parcelles`
          const deposit = Number(s.deposit) || 0
          const ttl = reservationTtlText(s)
          return (
            <button key={s.id} type="button" className={`sp-card sp-card--${flow?.badge || 'gray'}`} onClick={() => setDetailSale(s)}>
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials">{initialsFromName(s.clientName)}</span>
                  <div>
                    <p className="sp-card__name">{s.clientName || '—'}</p>
                    <p className="sp-card__sub">{s.projectTitle} · {plotLabel}</p>
                  </div>
                </div>
                <div className="sp-card__right">
                  <span className={`sp-badge sp-badge--${flow?.badge || 'gray'}`}>{flow?.label || s.status}</span>
                  {ttl && <span className={`sp-ttl${ttl.urgent ? ' sp-ttl--urgent' : ''}`}>⏱ {ttl.text}</span>}
                </div>
              </div>
              <div className="sp-card__body">
                <div className="sp-card__price">
                  <span className="sp-card__amount">{(s.agreedPrice || 0).toLocaleString('fr-FR')}</span>
                  <span className="sp-card__currency">TND</span>
                </div>
                <div className="sp-card__info">
                  <span>{pt.icon} {pt.label}</span>
                  {deposit > 0 && <span className="sp-card__prepaid">↓ {deposit.toLocaleString('fr-FR')}</span>}
                </div>
              </div>
            </button>
          )
        })}
      </div>
      {filtered.length > SALES_PER_PAGE && (
        <div className="sp-pager" role="navigation" aria-label="Pagination">
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="Page précédente"
          >
            ‹
          </button>
          {getPagerPages(page, pageCount).map((p, i) =>
            p === '…' ? (
              <span key={`dots-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
            ) : (
              <button
                key={p}
                type="button"
                className={`sp-pager__btn${p === page ? ' sp-pager__btn--active' : ''}`}
                onClick={() => setPage(p)}
                aria-current={p === page ? 'page' : undefined}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            aria-label="Page suivante"
          >
            ›
          </button>
          <span className="sp-pager__info">
            {(page - 1) * SALES_PER_PAGE + 1}–{Math.min(page * SALES_PER_PAGE, filtered.length)} / {filtered.length}
          </span>
        </div>
      )}
    </>
  )

  if (role === 'Agent' && !adminUser?.id) {
    return (
      <div className="sell-field" dir="ltr">
        <button type="button" className="sp-back-btn" onClick={goBack}>
          <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
          <span>Back</span>
        </button>
        <div className="adm-empty">
          <div className="adm-empty-icon">⚠️</div>
          <div className="adm-empty-title">Compte agent incomplet</div>
          <div className="adm-empty-text">Identifiant administrateur manquant — les ventes ne peuvent pas être attribuées.</div>
        </div>
      </div>
    )
  }


  // Build a one-line running summary shown at the top of the wizard so the
  // user always sees what they've chosen so far.
  const wizardLiveSummary = (() => {
    const parts = []
    if (selectedProject) parts.push(`Projet : ${selectedProject.title}`)
    if (selectedPlots.length) parts.push(`${selectedPlots.length} parcelle${selectedPlots.length > 1 ? 's' : ''}`)
    if (wizardSelectedClient) parts.push(`Client : ${wizardSelectedClient.name}`)
    if (form.paymentType) parts.push(form.paymentType === 'full' ? 'Comptant' : 'Échelonné')
    return parts
  })()

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={goBack}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>
      <header className="sp-hero">
        <div className="sp-hero__avatar">
          <img src={`https://api.dicebear.com/9.x/initials/svg?seed=${avatarSeed}&backgroundColor=eff6ff&textColor=2563eb&fontSize=42`} alt="" width={52} height={52} />
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">{displayAgentName}</h1>
          <p className="sp-hero__role">{commercialRoleLabel}{agentCity ? ` · ${agentCity}` : ''}</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">{todayDepositTotal.toLocaleString('fr-FR')}</span>
          <span className="sp-hero__kpi-unit">TND</span>
          <span className="sp-hero__kpi-label">{todaySaleCount} vente{todaySaleCount !== 1 ? 's' : ''} aujourd'hui</span>
        </div>
      </header>

      <button
        type="button"
        className="sp-cta-btn"
        onClick={openNew}
        title="Démarrer le formulaire de vente en 6 étapes"
      >
        <span className="sp-cta-btn__icon">+</span>
        <span className="sp-cta-btn__text">Enregistrer une nouvelle vente</span>
        <span className="sp-cta-btn__arrow">→</span>
      </button>

      {renderSaleList()}

      {/* ── Sale Detail Modal ── */}
      {detailSale && (() => {
        const ds = detailSale
        const flow = STATUS_FLOW[ds.status]
        const pt = PAYMENT_TYPE[ds.paymentType] || PAYMENT_TYPE.full
        const pIds = normalizePlotIds(ds)
        const plotLabel = pIds.length <= 3 ? pIds.map(id => `#${id}`).join(', ') : `${pIds.length} parcelles`
        const deposit = Number(ds.deposit) || 0
        const agreed = Number(ds.agreedPrice) || 0
        const downPct = Number(ds.offerDownPayment) || 0
        const duration = Number(ds.offerDuration) || 0
        const isInst = ds.paymentType === 'installments'
        const downAmt = isInst && downPct > 0 ? Math.round(agreed * downPct / 100) : 0
        const remaining = isInst ? agreed - downAmt : 0
        const monthly = isInst && duration > 0 ? Math.round(remaining / duration) : 0
        const balanceDue = isInst ? Math.max(0, downAmt - deposit) : Math.max(0, agreed - deposit)
        const detailTtl = reservationTtlText(ds)
        return (
          <AdminModal open onClose={() => setDetailSale(null)} title="">
            <div className="sp-detail">
              <div className="sp-detail__banner">
                <div className="sp-detail__banner-top">
                  <span className={`sp-badge sp-badge--${flow?.badge || 'gray'}`}>{flow?.label || ds.status}</span>
                  {detailTtl && <span className={`sp-detail__ttl${detailTtl.urgent ? ' sp-detail__ttl--urgent' : ''}`}>⏱ {detailTtl.text}</span>}
                  <span className="sp-detail__date">{fmtFrDateTime(ds.createdAt)}</span>
                </div>
                <div className="sp-detail__price">
                  <span className="sp-detail__price-num">{agreed.toLocaleString('fr-FR')}</span>
                  <span className="sp-detail__price-cur">TND</span>
                </div>
                <p className="sp-detail__banner-sub">{ds.projectTitle} · {plotLabel}</p>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Vendeur</div>
                <div className="sp-detail__row">
                  <span>Nom</span><strong>{resolveAgentForSale(ds)?.name || displayAgentName}</strong>
                </div>
                <div className="sp-detail__row">
                  <span>Contact</span><strong>{resolveAgentForSale(ds)?.email || adminUser?.email || user?.email || '—'}</strong>
                </div>
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Client (acheteur)</div>
                <div className="sp-detail__row">
                  <span>Nom</span><strong>{ds.clientName || '—'}</strong>
                </div>
                {ds.clientPhone && (
                  <div className="sp-detail__row">
                    <span>Téléphone</span><strong style={{ direction: 'ltr' }}>{ds.clientPhone}</strong>
                  </div>
                )}
                {ds.clientEmail && (
                  <div className="sp-detail__row">
                    <span>Email</span><strong style={{ direction: 'ltr', wordBreak: 'break-all' }}>{ds.clientEmail}</strong>
                  </div>
                )}
                {ds.clientCin && (
                  <div className="sp-detail__row">
                    <span>CIN</span><strong style={{ direction: 'ltr' }}>{ds.clientCin}</strong>
                  </div>
                )}
              </div>

              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Offre & paiement</div>
                <div className="sp-detail__row">
                  <span>Mode</span><strong>{pt.icon} {pt.label}</strong>
                </div>
                {isInst && ds.offerName && (
                  <div className="sp-detail__row">
                    <span>Offre</span><strong>{ds.offerName}</strong>
                  </div>
                )}
                <div className="sp-detail__row">
                  <span>Prix convenu</span><strong>{agreed.toLocaleString('fr-FR')} TND</strong>
                </div>
                {isInst && downPct > 0 && (
                  <>
                    <div className="sp-detail__row">
                      <span>1er versement ({downPct}%)</span><strong>{downAmt.toLocaleString('fr-FR')} TND</strong>
                    </div>
                    <div className="sp-detail__row">
                      <span>Capital restant</span><strong>{remaining.toLocaleString('fr-FR')} TND</strong>
                    </div>
                    {duration > 0 && (
                      <div className="sp-detail__row">
                        <span>Mensualité</span><strong>{monthly.toLocaleString('fr-FR')} TND x {duration} mois</strong>
                      </div>
                    )}
                  </>
                )}
                {deposit > 0 && (
                  <div className="sp-detail__row">
                    <span>Acompte</span><strong>{deposit.toLocaleString('fr-FR')} TND</strong>
                  </div>
                )}
                <div className="sp-detail__row sp-detail__row--highlight">
                  <span>Solde finance</span><strong>{balanceDue.toLocaleString('fr-FR')} TND</strong>
                </div>
              </div>

              <SaleLedgerPanel sale={ds} variant="detail" />

              {ds.notes && (
                <div className="sp-detail__section">
                  <div className="sp-detail__section-title">Notes</div>
                  <p className="sp-detail__notes">{ds.notes}</p>
                </div>
              )}

              <div className="sp-detail__actions">
                <button type="button" className="sp-detail__btn sp-detail__btn--edit" onClick={() => { setDetailSale(null); openEdit(ds) }}>Modifier</button>
              </div>
            </div>
          </AdminModal>
        )
      })()}

      {/* ── Edit Sale Modal (flat form) ── */}
      {drawer === 'edit' && editId && (() => {
        const prevSale = sales.find(s => s.id === editId)
        const editProject = scopedProjects.find(p => p.id === form.projectId)
        const editPlotLabel = form.plotIds.length <= 3 ? form.plotIds.map(id => `#${id}`).join(', ') : `${form.plotIds.length} parcelles`
        return (
          <AdminModal open onClose={closeSaleDrawer} title="">
            <div className="sp-edit">
              <div className="sp-edit__banner">
                <p className="sp-edit__banner-title">Modifier la vente</p>
                <p className="sp-edit__banner-sub">{prevSale?.clientName || '—'} · {editProject?.title || prevSale?.projectTitle || '—'} · {editPlotLabel}</p>
              </div>

              <div className="sp-edit__body">
                <div className="sp-edit__field">
                  <label className="sp-edit__label">Acompte (TND)</label>
                  <div className="sp-edit__input" style={{ opacity: 0.8, cursor: 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>
                      {Number(arabonForProject(form.projectId) || 0).toLocaleString('fr-FR')}
                    </strong>
                    <span style={{ fontSize: 12, opacity: 0.8 }}>TND</span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                    Modifiable uniquement depuis les paramètres du projet.
                  </div>
                </div>
                <div className="sp-edit__field">
                  <label className="sp-edit__label">Mode de paiement</label>
                  <div className="sp-edit__toggle">
                    <button type="button" className={`sp-edit__toggle-btn${form.paymentType === 'full' ? ' sp-edit__toggle-btn--on' : ''}`}
                      onClick={() => setForm(f => ({ ...f, paymentType: 'full', offerId: '' }))}>Comptant</button>
                    <button type="button" className={`sp-edit__toggle-btn${form.paymentType === 'installments' ? ' sp-edit__toggle-btn--on' : ''}`}
                      onClick={() => setForm(f => ({ ...f, paymentType: 'installments' }))}>Echelonne</button>
                  </div>
                </div>
                {form.paymentType === 'installments' && projectOffers.length > 0 && (
                  <div className="sp-edit__field sp-edit__field--full">
                    <label className="sp-edit__label">Offre</label>
                    <div className="sp-edit__offer-list">
                      {projectOffers.map((o, i) => {
                        const sel = String(form.offerId) === String(i)
                        const mo = o.duration > 0 ? Math.round((o.price * (1 - o.downPayment / 100)) / o.duration) : 0
                        return (
                          <button key={i} type="button" className={`sp-edit__offer-opt${sel ? ' sp-edit__offer-opt--on' : ''}`}
                            onClick={() => setForm(f => ({ ...f, offerId: String(i) }))}>
                            <span className="sp-edit__offer-opt__radio" />
                            <span className="sp-edit__offer-opt__info">
                              <span className="sp-edit__offer-opt__name">{o.name}{o.price > 0 ? ` — ${o.price.toLocaleString('fr-FR')} TND` : ''}</span>
                              <span className="sp-edit__offer-opt__meta">{o.downPayment}% acompte · {o.duration} mois{mo > 0 ? ` · ~${mo.toLocaleString('fr-FR')}/mois` : ''}</span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div className="sp-edit__field sp-edit__field--full">
                  <label className="sp-edit__label">Notes</label>
                  <textarea className="sp-edit__input sp-edit__textarea" rows={2}
                    placeholder="Ajouter une note…"
                    value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                </div>
              </div>

              <div className="sp-edit__footer">
                <button type="button" className="sp-edit__btn sp-edit__btn--cancel" onClick={closeSaleDrawer}>Annuler</button>
                <button type="button" className="sp-edit__btn sp-edit__btn--save" onClick={handleSave} disabled={saleSaving}>{saleSaving ? 'Enregistrement…' : 'Enregistrer'}</button>
              </div>
            </div>
          </AdminModal>
        )
      })()}

      {/* ── New Sale Wizard Drawer ── */}
      <AdminDrawer
        open={drawer === 'form'}
        onClose={closeSaleDrawer}
        preventOverlayClose
        className="adm-drawer--sell-flow"
        title="Nouvelle vente"
        width={580}
      >
        <div
          className={
            'sp-wizard sp-wizard--stacked' +
            (saleWizardStep === 2 && form.projectId ? ' sp-wizard--plots-grid-only' : '')
          }
          dir="ltr"
        >
          {!(saleWizardStep === 2 && form.projectId) && (
          <div className="sp-wizard__top">
            <div
              className="sp-progress"
              role="progressbar"
              aria-valuenow={saleWizardStep}
              aria-valuemin={1}
              aria-valuemax={SALE_WIZARD_STEP_COUNT}
              aria-label={`Étape ${saleWizardStep} sur ${SALE_WIZARD_STEP_COUNT}`}
            >
              {Array.from({ length: SALE_WIZARD_STEP_COUNT }, (_, i) => (
                <span
                  key={i}
                  className={
                    'sp-progress__pill' +
                    (i + 1 < saleWizardStep ? ' sp-progress__pill--done' : '') +
                    (i + 1 === saleWizardStep ? ' sp-progress__pill--active' : '')
                  }
                />
              ))}
            </div>
            <div className="sp-wizard__steps" aria-hidden>
              {Array.from({ length: SALE_WIZARD_STEP_COUNT }, (_, i) => (
                <div
                  key={i}
                  className={
                    'sp-wizard__step-bubble' +
                    (i + 1 < saleWizardStep ? ' sp-wizard__step-bubble--done' : '') +
                    (i + 1 === saleWizardStep ? ' sp-wizard__step-bubble--active' : '')
                  }
                >
                  {i + 1 < saleWizardStep ? '✓' : i + 1}
                </div>
              ))}
            </div>
            <h2 className="sp-wizard__title">
              {SALE_WIZARD_LABELS[saleWizardStep - 1]}
            </h2>
            <p className="sp-wizard__helper">
              {SALE_WIZARD_HELPERS[saleWizardStep - 1]}
            </p>
            {wizardLiveSummary.length > 0 && saleWizardStep > 1 && (
              <div className="sp-wizard__summary" aria-label="Résumé de la saisie en cours">
                <span aria-hidden>📝</span>
                {wizardLiveSummary.map((p, i) => (
                  <span key={i}><strong>{p}</strong></span>
                ))}
              </div>
            )}
          </div>
          )}

          <div className="sp-wizard__scroll">
          {saleWizardStep === 1 && (
        <div className="sp-wizard__panel">
          <label className="sp-wizard__label" htmlFor="sp-project-select">
            Projet concerné<span className="sp-required" aria-hidden>*</span>
          </label>
          <select
            id="sp-project-select"
            className="sp-wizard__select"
            value={form.projectId}
            onChange={e => {
              const pid = e.target.value
              setForm(f => ({ ...f, projectId: pid, plotIds: [], offerId: '', deposit: String(arabonForProject(pid)) }))
            }}
            title="Sélectionnez le projet où se trouve la parcelle vendue"
          >
            <option value="">— Choisir un projet —</option>
            {scopedProjects.map(p => <option key={p.id} value={p.id}>{p.title} — {p.city}</option>)}
          </select>
          <p className="sp-wizard__helper sp-wizard__helper--mb0">Le projet détermine les parcelles, offres et paramètres d'acompte disponibles.</p>
          {scopedProjects.length === 0 && (
            <div className="sp-empty sp-empty--mt12">
              <span className="sp-empty__emoji" aria-hidden>🏗️</span>
              <div className="sp-empty__title">Aucun projet accessible</div>
              <div>Contactez un administrateur pour qu'un projet vous soit attribué.</div>
            </div>
          )}
        </div>
          )}

          {saleWizardStep === 2 && form.projectId && (
        <div className="sp-wizard__panel sp-wizard__panel--plots sp-wizard__panel--plots-minimal">
            <div className="sp-plot-head">
              <h2 className="sp-panel-title">Choisissez les parcelles</h2>
              <p className="sp-panel-sub">
                {selectedPlots.length === 0
                  ? 'Appuyez sur un numéro pour le sélectionner.'
                  : `${selectedPlots.length} parcelle${selectedPlots.length > 1 ? 's' : ''} sélectionnée${selectedPlots.length > 1 ? 's' : ''}${totalArea > 0 ? ` · ${totalArea.toLocaleString('fr-FR')} m²` : ''}`}
              </p>
              <div className="sp-plot-legend" aria-label="Légende des parcelles">
                <span><span className="sp-plot-legend__dot" style={{ background: '#2563eb' }} />Sélectionnée</span>
                <span><span className="sp-plot-legend__dot" style={{ background: '#f1f5f9', border: '1px solid #cbd5e1' }} />Disponible</span>
                <span><span className="sp-plot-legend__dot" style={{ background: '#e5e7eb' }} />Indisponible</span>
              </div>
              <div className="sp-quickpick" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="sp-quickpick__toggle"
                  aria-expanded={quickPickOpen}
                  aria-controls="sp-quickpick-panel"
                  onClick={() => setQuickPickOpen(v => !v)}
                  disabled={quickPickMax === 0}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', borderRadius: 8,
                    border: '1px solid #cbd5e1', background: quickPickOpen ? '#eff6ff' : '#f8fafc',
                    color: '#0f172a', fontSize: 12, fontWeight: 600,
                    cursor: quickPickMax === 0 ? 'not-allowed' : 'pointer',
                    opacity: quickPickMax === 0 ? 0.5 : 1,
                  }}
                  title={quickPickMax === 0 ? 'Aucune parcelle disponible' : 'Sélectionner plusieurs parcelles en une fois'}
                >
                  <span aria-hidden>⚡</span>
                  <span>Sélection rapide</span>
                </button>
                {quickPickOpen && (
                  <div
                    id="sp-quickpick-panel"
                    className="sp-quickpick__panel"
                    role="group"
                    aria-label="Sélection rapide de parcelles"
                    style={{
                      marginTop: 8, padding: 10, borderRadius: 10,
                      border: '1px solid #e2e8f0', background: '#f8fafc',
                      display: 'grid', gap: 8,
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: '#334155' }}>
                      Combien de parcelles ?
                      <input
                        type="number"
                        min={1}
                        max={quickPickMax || 1}
                        value={clampedQuickPickCount}
                        onChange={e => setQuickPickCount(Math.max(1, Math.min(quickPickMax || 1, Number(e.target.value) || 1)))}
                        style={{
                          width: 72, padding: '4px 8px', borderRadius: 6,
                          border: '1px solid #cbd5e1', fontSize: 13, fontWeight: 600,
                          textAlign: 'center',
                        }}
                      />
                      <span style={{ fontWeight: 400, color: '#64748b' }}>/ {quickPickMax} dispo.</span>
                    </label>
                    <div role="radiogroup" aria-label="Mode de sélection" style={{ display: 'flex', gap: 12, fontSize: 12, color: '#334155' }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="sp-quickpick-mode"
                          value="adjacent"
                          checked={quickPickMode === 'adjacent'}
                          onChange={() => setQuickPickMode('adjacent')}
                        />
                        Adjacentes (côte à côte)
                      </label>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="sp-quickpick-mode"
                          value="random"
                          checked={quickPickMode === 'random'}
                          onChange={() => setQuickPickMode('random')}
                        />
                        Aléatoires
                      </label>
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        onClick={() => setQuickPickOpen(false)}
                        style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                      >
                        Annuler
                      </button>
                      <button
                        type="button"
                        onClick={runQuickPick}
                        disabled={quickPickMax === 0}
                        style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', fontSize: 12, fontWeight: 700, cursor: quickPickMax === 0 ? 'not-allowed' : 'pointer' }}
                      >
                        Sélectionner
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {allProjectPlots.length === 0 ? (
              <div className="sp-empty">
                <span className="sp-empty__emoji" aria-hidden>🗺️</span>
                <div className="sp-empty__title">Aucune parcelle dans ce projet</div>
                <div>Revenez à l'étape précédente pour choisir un autre projet.</div>
              </div>
            ) : (
              <div className="sp-plots-grid-shell--solo">
                <div
                  className="sp-plot-micro-grid"
                  role="group"
                  aria-label={
                    `Parcelles. ${selectedPlots.length} sélectionnée${selectedPlots.length !== 1 ? 's' : ''}. ` +
                    "Touchez un numéro pour l'ajouter ou le retirer. Indisponible si grisé et barré."
                  }
                >
                    {sortedProjectPlots.map(pl => {
                      const numId = Number(pl.id)
                      const selected = form.plotIds.some(pid => Number(pid) === numId || String(pid) === String(pl.id))
                      const available = isPlotAvailable(pl)
                      const plotPrice = computedPlotPrice(pl)
                      return (
                        <button
                          key={pl.id}
                          type="button"
                          className={
                            'sp-plot-micro sp-plot-tile' +
                            (selected ? ' sp-plot-micro--selected' : '') +
                            (!available ? ' sp-plot-micro--taken' : '')
                          }
                          aria-disabled={!available}
                          aria-pressed={selected}
                          tabIndex={available ? 0 : -1}
                          onClick={() => {
                            if (!available) {
                              addToast('Cette parcelle est indisponible (réservée, vendue ou liée à une vente non brouillon).', 'info')
                              return
                            }
                            togglePlotInline(pl)
                          }}
                          title={available ? `${selected ? 'Retirer' : 'Ajouter'} la parcelle ${pl.label ?? pl.id}` : `Parcelle ${pl.label ?? pl.id} indisponible`}
                        >
                          <span className="sp-plot-micro__num">#{pl.label ?? pl.id}</span>
                          {pl.area != null && (
                            <span className="sp-plot-tile__meta">{Number(pl.area).toLocaleString('fr-FR')} m²</span>
                          )}
                          <span className="sp-plot-tile__price">
                            {plotPrice > 0 ? `${plotPrice.toLocaleString('fr-FR')} TND` : '—'}
                          </span>
                        </button>
                      )
                    })}
                </div>
              </div>
            )}
            {allProjectPlots.length > 0 && availablePlots.length === 0 && selectedPlots.length === 0 ? (
              <div className="sp-empty" role="status" style={{ marginTop: 12 }}>
                <span className="sp-empty__emoji" aria-hidden>🚫</span>
                <div className="sp-empty__title">Toutes les parcelles sont indisponibles</div>
                <div>Elles sont réservées, vendues ou liées à une vente en cours. Choisissez un autre projet.</div>
              </div>
            ) : null}
            {selectedPlots.length > 0 && (
              <div className="sp-price-override">
                <label className="sp-price-override__toggle">
                  <input
                    type="checkbox"
                    checked={!!form.useCustomPrice}
                    onChange={(e) => {
                      const on = e.target.checked
                      setForm((f) => {
                        if (!on) return { ...f, useCustomPrice: false }
                        // Seed the overrides with the current computed prices so the
                        // staff edits from a sensible starting point rather than empty.
                        const seeded = { ...(f.overridePrices || {}) }
                        for (const pl of selectedPlots) {
                          const key = String(pl.id)
                          if (seeded[key] === undefined || seeded[key] === '') {
                            seeded[key] = String(computedPlotPrice(pl) || '')
                          }
                        }
                        return { ...f, useCustomPrice: true, overridePrices: seeded }
                      })
                    }}
                  />
                  <span>Utiliser un prix personnalisé par parcelle</span>
                </label>
                {form.useCustomPrice && (
                  <div className="sp-price-override__list" role="group" aria-label="Prix personnalisés par parcelle">
                    {selectedPlots.map((pl) => {
                      const key = String(pl.id)
                      const base = computedPlotPrice(pl)
                      const raw = form.overridePrices?.[key]
                      const val = raw === undefined || raw === null ? String(base || '') : String(raw)
                      return (
                        <div key={pl.id} className="sp-price-override__row">
                          <span className="sp-price-override__label">Parcelle #{pl.label ?? pl.id}</span>
                          <span className="sp-price-override__hint">
                            {base > 0 ? `Calculé : ${base.toLocaleString('fr-FR')} TND` : 'Aucun prix catalogue'}
                          </span>
                          <div className="sp-price-override__input-wrap">
                            <input
                              type="text"
                              inputMode="decimal"
                              className="sp-wizard__input sp-price-override__input"
                              value={val}
                              onChange={(e) => {
                                const next = e.target.value.replace(/[^0-9.,\s]/g, '')
                                setForm((f) => ({
                                  ...f,
                                  overridePrices: { ...(f.overridePrices || {}), [key]: next },
                                }))
                              }}
                              placeholder={String(base || 0)}
                              aria-label={`Prix personnalisé parcelle ${pl.label ?? pl.id}`}
                            />
                            <span className="sp-price-override__unit">TND</span>
                          </div>
                        </div>
                      )
                    })}
                    <div className="sp-price-override__total">
                      <span>Total personnalisé</span>
                      <strong>{totalPlotPrice.toLocaleString('fr-FR')} TND</strong>
                    </div>
                  </div>
                )}
              </div>
            )}
        </div>
          )}

          {saleWizardStep === 3 && (
        <div className="sp-wizard__panel">
          <div className="sp-help-card" style={{ marginBottom: 12 }}>
            <span className="sp-help-card__ico" aria-hidden>💡</span>
            <span>Le téléphone sert de clé unique pour relier la vente au client. Le CIN est facultatif.</span>
          </div>
          {clientProfile?.id && clientProfile?.phone && (
            <button
              type="button"
              className="sp-wizard__mini sp-wizard__mini--ok"
              style={{ width: '100%', marginBottom: 10, cursor: 'pointer', border: 'none', textAlign: 'left' }}
              onClick={() => {
                const ph = normalizePhoneLookup(clientProfile.phone)
                setCinLookup(ph)
                setCinLookupResult(clientProfile)
                setForm(f => ({ ...f, clientId: clientProfile.id }))
              }}
            >
              <span>👤</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>Utiliser mon profil acheteur</div>
                <div style={{ fontSize: 11, marginTop: 2 }}>{clientProfile.name} · {clientProfile.phone}</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700 }}>Sélectionner</span>
            </button>
          )}
          <label className="sp-wizard__label" htmlFor="sp-phone-input">
            Téléphone du client<span className="sp-required" aria-hidden>*</span>
          </label>
          <div className="sp-wizard__row">
            <input
              id="sp-phone-input"
              className={'sp-wizard__input' + (cinLookup.length > 0 && cinLookup.length < 8 ? ' sp-wizard__input--err' : '')}
              value={cinLookup}
              onChange={e => {
                const val = normalizePhoneLookup(e.target.value)
                setCinLookup(val)
                if (val.length >= 4) {
                  // 1) Check if typed phone matches the current user's own clientProfile.
                  const selfMatch = clientProfile?.id && normalizePhoneLookup(clientProfile.phone) === val
                    ? clientProfile : null
                  // 2) Instant match against the local clients list (cached view).
                  const found = selfMatch || clients.find(c => normalizePhoneLookup(c.phone) === val)
                  setCinLookupResult(found || null)
                  if (found) setForm(f => ({ ...f, clientId: found.id }))
                  else setForm(f => ({ ...f, clientId: '' }))
                  // 3) When fully entered and local list has no match, hit the DB
                  //    so we don't invite the user to create a duplicate stub.
                  if (!found && val.length >= 8) {
                    const guard = val
                    db.fetchClientByPhone(val)
                      .then(dbClient => {
                        if (!dbClient) return
                        if (guard !== val) return
                        setCinLookupResult(dbClient)
                        setForm(f => ({ ...f, clientId: dbClient.id }))
                      })
                      .catch(err => {
                        console.warn('[SellPage] fetchClientByPhone:', err?.message || err)
                      })
                  }
                } else {
                  setCinLookupResult(null)
                  setForm(f => ({ ...f, clientId: '' }))
                }
              }}
              placeholder="Téléphone client (8 chiffres)"
              maxLength={8}
              style={{ direction: 'ltr', fontFamily: 'monospace' }}
            />
            <button
              type="button"
              className="sp-wizard__btn sp-wizard__btn--ghost"
              style={{ whiteSpace: 'nowrap', flexShrink: 0, opacity: (!adminUser && sellerMode) ? 0.5 : 1, cursor: (!adminUser && sellerMode) ? 'not-allowed' : 'pointer' }}
              disabled={!adminUser && sellerMode}
              title={(!adminUser && sellerMode) ? "Accès délégué : la création d'une fiche client doit être faite par un staff SQL." : ''}
              onClick={() => {
                if (!adminUser && sellerMode) {
                  addToast("Création de fiche réservée au staff. Demandez à un administrateur d'ajouter le client.", 'error')
                  return
                }
                setClientForm({ name: '', phone: cinLookup || '', phoneCc: '+216', cin: '', city: '' })
                setClientModal(true)
              }}
            >
              + Nouveau
            </button>
          </div>
          {cinLookupResult && cinLookup.length >= 4 && (
            <div className="sp-wizard__mini sp-wizard__mini--ok">
              <span>✓</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{cinLookupResult.name}</div>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  {cinLookupResult.cin && <span>CIN: {cinLookupResult.cin}</span>}
                  {cinLookupResult.phone && <span> · {cinLookupResult.phone}</span>}
                </div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700 }}>OK</span>
            </div>
          )}
          {!cinLookupResult && cinLookup.length >= 8 && (
            <div className="sp-wizard__mini sp-wizard__mini--warn">
              <span>⚠</span>
              <div>
                <div style={{ fontWeight: 700 }}>Aucun client avec ce téléphone</div>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  Créez une fiche avec « Nouveau », ou poursuivez : la vente enregistre une réclamation téléphone et se rattache à l'inscription.
                </div>
              </div>
            </div>
          )}
        </div>
          )}

          {saleWizardStep === 4 && (
        <div className="sp-wizard__panel">
          <label className="sp-wizard__label">Acompte (TND)</label>
          <div className="sp-arabon-display">
            <span className="sp-arabon-value">
              {Number(arabonForProject(form.projectId) || 0).toLocaleString('fr-FR')}
            </span>
            <span className="sp-arabon-unit">TND</span>
          </div>
          <p className="sp-arabon-note">
            Modifiable uniquement depuis les paramètres du projet.
          </p>
        </div>
          )}

          {saleWizardStep === 5 && (
        <>
        <div className="sp-wizard__panel">
          <label className="sp-wizard__label">Mode de paiement</label>
          <div className="sp-pay-grid">
            <button
              type="button"
              className={`sp-pay-card${form.paymentType === 'full' ? ' sp-pay-card--on' : ''}`}
              onClick={() => setForm(f => ({ ...f, paymentType: 'full', offerId: '' }))}
            >
              <div className="sp-pay-card__check">✓</div>
              <div className="sp-pay-card__ico">💵</div>
              <div className="sp-pay-card__name">Comptant</div>
              <div className="sp-pay-card__hint">Montant total en espèces</div>
            </button>
            <button
              type="button"
              className={`sp-pay-card${form.paymentType === 'installments' ? ' sp-pay-card--on' : ''}`}
              onClick={() => setForm(f => ({ ...f, paymentType: 'installments' }))}
            >
              <div className="sp-pay-card__check">✓</div>
              <div className="sp-pay-card__ico">📅</div>
              <div className="sp-pay-card__name">Echelonne</div>
              <div className="sp-pay-card__hint">Acompte + mensualités</div>
            </button>
          </div>
        </div>

        {form.paymentType === 'installments' && form.projectId && projectOffers.length > 0 && (
          <div className="sp-wizard__panel">
            <label className="sp-wizard__label">Offre de paiement</label>
            <div className="sp-offer-list">
              {projectOffers.map((o, i) => {
                const sel = String(form.offerId) === String(i)
                const mo = o.duration > 0 ? Math.round((o.price * (1 - o.downPayment / 100)) / o.duration) : 0
                return (
                  <button key={i} type="button" className={`sp-offer${sel ? ' sp-offer--on' : ''}`}
                    onClick={() => setForm(f => ({ ...f, offerId: String(i) }))}>
                    <div className="sp-offer__radio" />
                    <div className="sp-offer__top">
                      <span className="sp-offer__name">{o.name}</span>
                      {o.price > 0 && <span className="sp-offer__price">{o.price.toLocaleString('fr-FR')} TND</span>}
                    </div>
                    <div className="sp-offer__chips">
                      <span className="sp-offer__chip">{o.downPayment}%</span>
                      <span className="sp-offer__chip">{o.duration} mois</span>
                      {mo > 0 && <span className="sp-offer__chip">~{mo.toLocaleString('fr-FR')}/mois</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {form.paymentType === 'installments' && form.projectId && projectOffers.length === 0 && (
          <div className="sp-fin-warn">⚠️ Aucune offre pour ce projet — passez en comptant ou configurez les offres.</div>
        )}

        {form.paymentType === 'installments' && form.offerId !== '' && projectOffers[Number(form.offerId)] && selectedPlots.length > 0 && (() => {
          const o = projectOffers[Number(form.offerId)]
          const price = (!form.useCustomPrice && o.price) ? (o.price * selectedPlots.length) : totalPlotPrice
          const down = Math.round(price * o.downPayment / 100)
          const remaining = price - down
          const monthly = Math.round(remaining / o.duration)
          const arabonVal = Number(form.deposit) || 0
          const toPay = Math.max(0, down - arabonVal)
          return (
            <div className="sp-wizard__panel">
              <div className="sp-fin-header">Détail des échéances — {selectedPlots.length} parcelle(s)</div>
              {o.price && o.price * selectedPlots.length !== totalPlotPrice && (
                <div className="sp-fin-catalog-note">
                  Prix catalogue : <s>{totalPlotPrice.toLocaleString('fr-FR')} TND</s> → offre : <strong>{price.toLocaleString('fr-FR')} TND</strong>
                </div>
              )}
              <div className="sp-fin-grid">
                <span>Prix convenu :</span> <strong>{price.toLocaleString('fr-FR')} TND</strong>
                <span>1er versement ({o.downPayment} %) :</span> <strong>{down.toLocaleString('fr-FR')} TND</strong>
                <span>Reste :</span> <strong>{remaining.toLocaleString('fr-FR')} TND</strong>
                <span>Mensualité :</span> <strong>{monthly.toLocaleString('fr-FR')} TND × {o.duration}</strong>
              </div>
              {arabonVal > 0 && (
                <div className="sp-fin-deductions">
                  <div className="sp-fin-deduct-row">
                    <span>Acompte terrain :</span>
                    <strong>- {arabonVal.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sp-fin-total-row">
                    <span>Solde à encaisser (finance) :</span>
                    <strong>{toPay.toLocaleString('fr-FR')} TND</strong>
                  </div>
                </div>
              )}
            </div>
          )
        })()}

        {form.paymentType === 'full' && selectedPlots.length > 0 && (() => {
          const arabonVal = Number(form.deposit) || 0
          const toPay = Math.max(0, totalPlotPrice - arabonVal)
          return (
            <div className="sp-wizard__panel">
              <div className="sp-fin-header">Résumé comptant — {selectedPlots.length} parcelle(s)</div>
              <div className="sp-fin-grid">
                <span>Montant total :</span>
                <strong>{totalPlotPrice.toLocaleString('fr-FR')} TND</strong>
              </div>
              {arabonVal > 0 && (
                <div className="sp-fin-deductions">
                  <div className="sp-fin-deduct-row">
                    <span>Acompte terrain :</span>
                    <strong>- {arabonVal.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sp-fin-total-row">
                    <span>Solde à encaisser (finance) :</span>
                    <strong>{toPay.toLocaleString('fr-FR')} TND</strong>
                  </div>
                </div>
              )}
            </div>
          )
        })()}
        </>
          )}

          {saleWizardStep === 6 && (
        <>
          <div className="sp-recap sp-recap--stack">
            <div className="sp-recap-section">
              <div className="sp-recap-section-title">Suivi &amp; horodatage</div>
              <div className="sp-recap-row">
                <span>Récapitulatif établi le</span>
                <strong>{fmtFrDateTime(recapCapturedAt)}</strong>
              </div>
              {editId && (
                <>
                  <div className="sp-recap-row">
                    <span>Réf. vente</span>
                    <strong style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.72rem', wordBreak: 'break-all' }}>{editId}</strong>
                  </div>
                  {saleBeingEdited?.createdAt && (
                    <div className="sp-recap-row">
                      <span>Vente créée le</span>
                      <strong>{fmtFrDateTime(saleBeingEdited.createdAt)}</strong>
                    </div>
                  )}
                  {saleBeingEdited?.updatedAt &&
                    saleBeingEdited?.createdAt &&
                    String(saleBeingEdited.updatedAt) !== String(saleBeingEdited.createdAt) && (
                      <div className="sp-recap-row">
                        <span>Dernière mise à jour</span>
                        <strong>{fmtFrDateTime(saleBeingEdited.updatedAt)}</strong>
                      </div>
                    )}
                </>
              )}
            </div>

            <div className="sp-recap-section">
              <div className="sp-recap-section-title">Commercial (vendeur)</div>
              <div className="sp-recap-row">
                <span>Nom</span>
                <strong>{displayAgentName}</strong>
              </div>
              <div className="sp-recap-row">
                <span>Rôle</span>
                <strong>{commercialRoleLabel}</strong>
              </div>
              <div className="sp-recap-row">
                <span>Contact</span>
                <strong>{adminUser?.email || user?.email || '—'}</strong>
              </div>
              <div className="sp-recap-row">
                <span>Téléphone</span>
                <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>
                  {normalizePhoneLookup(adminUser?.phone || user?.phone || '') || '—'}
                </strong>
              </div>
            </div>

            <div className="sp-recap-section">
              <div className="sp-recap-section-title">Client</div>
              <div className="sp-recap-row">
                <span>Nom</span>
                <strong>
                  {wizardSelectedClient?.name || cinLookupResult?.name || '—'}
                </strong>
              </div>
              <div className="sp-recap-row">
                <span>CIN</span>
                <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>
                  {wizardSelectedClient?.cin || cinLookupResult?.cin || '—'}
                </strong>
              </div>
              <div className="sp-recap-row">
                <span>Téléphone</span>
                <strong style={{ direction: 'ltr' }}>
                  {wizardSelectedClient?.phone || cinLookupResult?.phone || '—'}
                </strong>
              </div>
              <div className="sp-recap-row">
                <span>Email</span>
                <strong style={{ direction: 'ltr', wordBreak: 'break-all' }}>{wizardSelectedClient?.email || '—'}</strong>
              </div>
              <div className="sp-recap-row">
                <span>Ville</span>
                <strong>{wizardSelectedClient?.city || '—'}</strong>
              </div>
            </div>

            <div className="sp-recap-section">
              <div className="sp-recap-section-title">Commission (attribuee au vendeur)</div>
              <p className="sp-wizard__helper">
                Le rattachement se fait par numero de telephone. Le CIN reste une information complementaire.
              </p>
              {willBeCreditedAsSellerL1 ? (
                <p className="sp-wizard__helper" style={{ color: '#0a7a3a', fontWeight: 600 }}>
                  Vous serez crédité comme vendeur (L1) sur cette vente.
                </p>
              ) : sellerL1BlockedByBuyerEq ? (
                <p className="sp-wizard__helper" style={{ color: '#b94a00', fontWeight: 600 }}>
                  Vous êtes l'acheteur sur cette vente : aucune commission L1 ne vous sera attribuée.
                </p>
              ) : (
                <p className="sp-wizard__helper" style={{ color: '#b94a00', fontWeight: 600 }}>
                  Aucun compte client n'est rattaché à votre session : aucune commission L1 ne sera attribuée. Contactez un Super Admin pour rattacher votre CIN/téléphone à un profil client afin d'être crédité.
                </p>
              )}
              <div className="sp-recap-row">
                <span>Vendeur</span>
                <strong>{sellerClientRecord?.name || displayAgentName}</strong>
              </div>
              <div className="sp-recap-row">
                <span>Telephone</span>
                <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>
                  {normalizePhoneLookup(sellerClientRecord?.phone || adminUser?.phone || user?.phone || '') || '—'}
                </strong>
              </div>
              {sellerClientRecord?.cin ? (
                <div className="sp-recap-row">
                  <span>CIN</span>
                  <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>{sellerClientRecord.cin}</strong>
                </div>
              ) : null}
              {!sellerClientRecord && !myClientId ? (
                <div className="sp-recap-row">
                  <span>Compte vendeur (client)</span>
                  <strong>—</strong>
                </div>
              ) : null}
            </div>

            <div className="sp-recap-section">
              <div className="sp-recap-section-title">Projet &amp; parcelles</div>
              <div className="sp-recap-row">
                <span>Projet</span>
                <strong>{selectedProject ? `${selectedProject.title} — ${selectedProject.city || ''}` : '—'}</strong>
              </div>
              <div className="sp-recap-row">
                <span>Parcelles ({selectedPlots.length})</span>
                <strong>
                  {selectedPlots.length
                    ? selectedPlots
                        .map((p) => `#${p.label ?? p.id}${p.area != null ? ` · ${p.area} m²` : ''}${p.trees != null ? ` · ${p.trees} arbres` : ''}`)
                        .join(' · ')
                    : '—'}
                </strong>
              </div>
              <div className="sp-recap-row">
                <span>Surface totale</span>
                <strong>{totalArea > 0 ? `${totalArea.toLocaleString('fr-FR')} m²` : '—'}</strong>
              </div>
            </div>

            <div className="sp-recap-section">
              <div className="sp-recap-section-title">Offre &amp; encaissements</div>
              <div className="sp-recap-row">
                <span>Mode de paiement</span>
                <strong>{form.paymentType === 'full' ? 'Comptant' : 'Echelonne'}</strong>
              </div>
              {wizardFinancialRecap.kind === 'installments' && wizardFinancialRecap.offer && (
                <>
                  <div className="sp-recap-row">
                    <span>Offre commerciale</span>
                    <strong>{wizardFinancialRecap.offer.name}</strong>
                  </div>
                  <div className="sp-recap-row">
                    <span>Prix convenu ({wizardFinancialRecap.plotCount} parcelle(s))</span>
                    <strong>{wizardFinancialRecap.price.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sp-recap-row">
                    <span>1er versement ({wizardFinancialRecap.downPct} %)</span>
                    <strong>{wizardFinancialRecap.down.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sp-recap-row">
                    <span>Capital restant</span>
                    <strong>{wizardFinancialRecap.remaining.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sp-recap-row">
                    <span>Mensualité × durée</span>
                    <strong>
                      {wizardFinancialRecap.monthly.toLocaleString('fr-FR')} TND × {wizardFinancialRecap.duration} mois
                    </strong>
                  </div>
                </>
              )}
              {wizardFinancialRecap.kind === 'full' && (
                <div className="sp-recap-row">
                  <span>Montant total (parcelles)</span>
                  <strong>{wizardFinancialRecap.totalPlotPrice.toLocaleString('fr-FR')} TND</strong>
                </div>
              )}
              <div className="sp-recap-row">
                <span>Acompte (terrain)</span>
                <strong>{wizardFinancialRecap.kind !== 'incomplete' ? wizardFinancialRecap.arabon.toLocaleString('fr-FR') : (Number(form.deposit) || 0).toLocaleString('fr-FR')} TND</strong>
              </div>
              {wizardFinancialRecap.kind !== 'incomplete' && (
                <div className="sp-recap-row sp-recap-row--emph">
                  <span>Solde à encaisser (finance)</span>
                  <strong>{wizardFinancialRecap.toPay.toLocaleString('fr-FR')} TND</strong>
                </div>
              )}
              {wizardFinancialRecap.kind === 'incomplete' && form.paymentType === 'installments' && (
                <div className="sp-recap-note">
                  Complétez le mode et l'offre à l'étape précédente pour le détail des montants.
                </div>
              )}
            </div>

            {editId && saleBeingEdited ? (
              <SaleLedgerPanel sale={saleBeingEdited} variant="wizard" />
            ) : !editId && form.projectId ? (
              <SaleLedgerPanel
                previewWorkflow={sellFormProjectWorkflow}
                variant="wizard"
              />
            ) : null}

          </div>
          <div className="sp-wizard__panel">
            <label className="sp-wizard__label">Notes internes</label>
            <textarea className="sp-wizard__textarea" value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes internes…" />
          </div>
        </>
          )}

          </div>

          <div className="sp-wizard__footer">
            {saleWizardStep > 1 && (
              <button type="button" className="sp-wizard__btn sp-wizard__btn--ghost" onClick={() => setSaleWizardStep(s => Math.max(1, s - 1))}>
                ‹ Retour
              </button>
            )}
            <span className="sp-wizard__footer-spacer" />
            {saleWizardStep < SALE_WIZARD_STEP_COUNT ? (
              <button type="button" className="sp-wizard__btn sp-wizard__btn--primary" onClick={tryWizardNext}>
                Continuer ›
              </button>
            ) : (
              <>
                <button type="button" className="sp-wizard__btn sp-wizard__btn--ghost" onClick={closeSaleDrawer}>
                  Annuler
                </button>
                <button
                  type="button"
                  className="sp-wizard__btn sp-wizard__btn--cta"
                  onClick={handleSave}
                  disabled={saleFormSubmitBlocked || saleSaving}
                >
                  {saleSaving
                    ? (editId ? 'Enregistrement…' : 'Création…')
                    : (editId ? 'Enregistrer' : `Créer la vente (${form.plotIds.length} parcelle(s))`)}
                </button>
              </>
            )}
          </div>
        </div>
      </AdminDrawer>

      {/* ── Create Client Modal ── */}
      <AdminModal open={clientModal} onClose={() => setClientModal(false)} title="Nouveau client" width={420}>
        <div className="adm-field"><label className="adm-label">Nom complet *</label><input className="adm-input" value={clientForm.name} onChange={e => setClientForm(f => ({ ...f, name: e.target.value }))} placeholder="Prénom Nom" autoFocus /></div>
        <div className="adm-field"><label className="adm-label">CIN (optionnel)</label><input className="adm-input" value={clientForm.cin} onChange={e => setClientForm(f => ({ ...f, cin: e.target.value }))} placeholder="XXXXXXXX" maxLength={8} /></div>
        <div className="adm-field">
          <label className="adm-label">Téléphone *</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              className="adm-input"
              value={clientForm.phoneCc || '+216'}
              onChange={e => setClientForm(f => ({ ...f, phoneCc: e.target.value }))}
              style={{ width: 110, flexShrink: 0, fontFamily: 'ui-monospace, monospace' }}
              title="Indicatif pays"
            >
              {PHONE_COUNTRY_CODES.map(c => (
                <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
              ))}
            </select>
            <input
              className="adm-input"
              value={clientForm.phone}
              onChange={e => setClientForm(f => ({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 15) }))}
              placeholder="58 415 520"
              style={{ flex: 1, direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="adm-field"><label className="adm-label">Ville</label><input className="adm-input" value={clientForm.city} onChange={e => setClientForm(f => ({ ...f, city: e.target.value }))} placeholder="Tunis, Sousse…" /></div>
        <div className="adm-form-actions">
          <button className="adm-btn adm-btn--secondary" onClick={() => setClientModal(false)}>Annuler</button>
          <button className="adm-btn adm-btn--primary" onClick={handleCreateClient} disabled={!clientForm.name.trim() || !String(clientForm.phone || '').replace(/\D/g, '') || clientSaving}>{clientSaving ? 'Création…' : 'Créer le client'}</button>
        </div>
      </AdminModal>

      {/* ── Action Confirmation Modal ── */}
      <AdminModal open={!!actionModal} onClose={() => setActionModal(null)} title={actionModal?.action === 'cancel' ? 'Annuler la vente' : 'Faire avancer la vente'} width={480}>
        {actionModal?.action === 'cancel' && (() => {
          const pIds = normalizePlotIds(actionModal)
          return (<>
            <p className="adm-confirm-text">Annuler la vente de {pIds.length > 1 ? `${pIds.length} parcelles` : `la parcelle #${pIds[0]}`} pour <strong>{actionModal.clientName}</strong> ?</p>
            <div style={{ padding: 12, background: 'var(--adm-red-dim)', borderRadius: 'var(--adm-radius)', fontSize: 13, color: 'var(--adm-red)', marginBottom: 16 }}>⚠️ {pIds.length > 1 ? 'Les parcelles redeviendront' : 'La parcelle redeviendra'} disponible(s).</div>
            <div className="adm-form-actions"><button className="adm-btn adm-btn--secondary" onClick={() => setActionModal(null)}>Conserver</button><button className="adm-btn adm-btn--danger" onClick={handleCancel}>Annuler la vente</button></div>
          </>)
        })()}
        {actionModal?.action === 'advance' && (() => {
          const flow = STATUS_FLOW[actionModal.status]
          const isActivation = flow?.next === 'active'
          const isFull = actionModal.paymentType === 'full'
          const pIds = normalizePlotIds(actionModal)
          const plotLabel = pIds.length > 1 ? `${pIds.length} parcelles` : `parcelle #${pIds[0]}`
          return (<>
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>{isActivation ? (isFull ? '💵' : '📅') : '📋'}</div>
              <h3 style={{ fontWeight: 700, fontSize: 16, margin: 0 }}>{flow?.nextLabel}</h3>
              <p style={{ color: 'var(--adm-text-dim)', fontSize: 13, marginTop: 6 }}><strong>{actionModal.clientName}</strong> — {plotLabel}</p>
            </div>
            {isActivation && (
              <div style={{ padding: 14, background: isFull ? 'var(--adm-blue-dim)' : 'var(--adm-accent-dim)', borderRadius: 'var(--adm-radius)', marginBottom: 16, fontSize: 13 }}>
                <div style={{ fontWeight: 600, color: isFull ? 'var(--adm-blue)' : 'var(--adm-accent)', marginBottom: 6 }}>Conséquences :</div>
                <ul style={{ margin: 0, paddingInlineStart: 18, lineHeight: 1.8, color: 'var(--adm-text-dim)' }}>
                  {isFull ? (<>
                    <li>Confirmation du montant encaissé : <strong>{(actionModal.agreedPrice || 0).toLocaleString('fr-FR')} TND</strong></li>
                    <li>Statut des parcelles → <strong>Vendu</strong></li>
                    <li>Statut de la vente → <strong>Terminé</strong></li>
                  </>) : (<>
                    <li>Création du plan d'échéances : <strong>{actionModal.offerDuration} mois</strong></li>
                    <li>Statut de la vente → <strong>Actif</strong></li>
                  </>)}
                </ul>
              </div>
            )}
            {!isActivation && (
              <div style={{ padding: 14, background: 'var(--adm-surface-2)', borderRadius: 'var(--adm-radius)', marginBottom: 16, fontSize: 13, border: '1px solid var(--adm-border)' }}>
                <span style={{ color: 'var(--adm-text-dim)' }}>Actuel :</span> <strong>{STATUS_FLOW[actionModal.status]?.label}</strong>
                <span style={{ margin: '0 8px', color: 'var(--adm-text-muted)' }}>←</span>
                <span style={{ color: 'var(--adm-text-dim)' }}>Nouveau :</span> <strong>{STATUS_FLOW[flow?.next]?.label}</strong>
              </div>
            )}
            <div className="adm-form-actions" style={{ justifyContent: 'center' }}>
              <button className="adm-btn adm-btn--secondary" onClick={() => setActionModal(null)}>Annuler</button>
              <button className="adm-btn adm-btn--primary" onClick={() => advanceStatus(actionModal)}>✓ {flow?.nextLabel}</button>
            </div>
          </>)
        })()}
      </AdminModal>
    </div>
  )
}
