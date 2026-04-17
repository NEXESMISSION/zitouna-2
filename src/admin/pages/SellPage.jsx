import { useState, useMemo, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { canonicalRole } from '../../lib/adminRole.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useProjects, useProjectWorkflow } from '../../lib/useSupabase.js'
import { useClients } from '../../lib/useSupabase.js'
import { useOffers } from '../../lib/useSupabase.js'
import { useSales, useInstallments, useAdminUsers, useMySellerParcelAssignments } from '../../lib/useSupabase.js'
import { generatePaymentSchedule } from '../../installmentsStore.js'
import { useToast } from '../components/AdminToast.jsx'
import AdminDrawer from '../components/AdminDrawer.jsx'
import AdminModal from '../components/AdminModal.jsx'
import { SALE_STATUS, getSaleStatusMeta, canonicalSaleStatus } from '../../domain/workflowModel.js'
import * as db from '../../lib/db.js'
import { normalizePhone } from '../../lib/phone.js'
import '../admin.css'
import './sell-field.css'

function reservationExpiresAtIso(hours) {
  const d = new Date()
  d.setHours(d.getHours() + (Number(hours) || 48))
  return d.toISOString()
}

/** Attache la vente à l’agent ou au responsable pour le reporting et le tableau de bord. */
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
  'Comptant ou échelonné : choisissez, puis sélectionnez l’offre si nécessaire.',
  'Relisez tout avant d’envoyer la vente à la coordination.',
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
  const wrapClass = variant === 'detail' ? 'sell-detail__section' : 'sell-wizard__recap-section'
  const titleClass = variant === 'detail' ? 'sell-detail__section-title' : 'sell-wizard__recap-section-title'
  const rowClass = variant === 'detail' ? 'sell-detail__row' : 'sell-wizard__recap-row'

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
        <p className="sell-wizard__hint" style={{ marginTop: 0 }}>
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

function salePlotsMeta(sale, projects) {
  const ids = normalizePlotIds(sale)
  const proj = projects.find(p => p.id === sale.projectId)
  const plots = proj?.plots || []
  let area = 0
  for (const id of ids) {
    const pl = plots.find(x => String(x.id) === String(id) || Number(x.id) === Number(id))
    if (pl) area += Number(pl.area) || 0
  }
  return { count: ids.length, area }
}

function fieldStatusHint(sale) {
  const st = canonicalSaleStatus(sale.status)
  if (st === SALE_STATUS.COMPLETED) return { done: true, text: 'Vente clôturée' }
  if (st === SALE_STATUS.ACTIVE) return { done: true, text: 'Contrat actif — échéancier en cours' }
  if (st === SALE_STATUS.PENDING_FINANCE) return { done: false, text: 'À traiter par la finance (caisse)' }
  if (st === SALE_STATUS.PENDING_LEGAL) return { done: false, text: 'Chez le notaire — signature' }
  if (st === SALE_STATUS.DRAFT) return { done: false, text: 'Brouillon — compléter la vente' }
  return { done: false, text: STATUS_FLOW[st]?.label || st }
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
  const { clients, upsert: clientUpsert } = useClients()

  const myClientId = useMemo(() => {
    if (clientProfile?.id) return clientProfile.id
    if (!user?.id || !clients?.length) return null
    const match = clients.find(c => c.authUserId && String(c.authUserId) === String(user.id))
    return match?.id || null
  }, [clientProfile?.id, user?.id, clients])
  const { offersByProject } = useOffers()
  const { sales, create: salesCreate, update: salesUpdate, refresh: refreshSales } = useSales()
  const { createPlan: installmentsCreatePlan } = useInstallments()
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

  // Per-project arabon: derived from selected project’s arabonDefault
  const arabonForProject = useCallback((projId) => {
    const p = scopedProjects.find(x => x.id === projId)
    return Number(p?.arabonDefault) || 50
  }, [scopedProjects])

  const isAdminOrSeller = Boolean(adminUser || sellerMode)
  useEffect(() => {
    if (!isAdminOrSeller) return
    return undefined
  }, [isAdminOrSeller])

  /** Liste affichée : l’agent ne voit que ses ventes ; dispo parcelles reste globale (évite double réservation). */
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
  const canAdvanceWorkflow = !sellerMode && role !== 'Agent'
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

  const blankForm = { projectId: '', plotIds: [], clientId: '', offerId: '', notes: '', paymentType: 'installments', deposit: '' }

  const [form, setFormRaw] = useState(() => {
    try {
      const saved = sessionStorage.getItem(FORM_STORAGE_KEY)
      if (saved) return { ...blankForm, ...JSON.parse(saved) }
    } catch { /* ignore */ }
    return blankForm
  })
  const setForm = useCallback((updater) => {
    setFormRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      try { sessionStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])
  const { workflow: sellFormProjectWorkflow } = useProjectWorkflow(form.projectId || '')
  const [editId, setEditId] = useState(null)

  const [clientModal, setClientModal] = useState(false)
  const [clientForm, setClientForm] = useState({ name: '', email: '', phone: '', cin: '', city: '' })
  const [clientSaving, setClientSaving] = useState(false)
  const [cinLookup, setCinLookup] = useState('')
  const [cinLookupResult, setCinLookupResult] = useState(null)
  const [actionModal, setActionModal] = useState(null)
  const [detailSale, setDetailSale] = useState(null)
  const [sellTab, setSellTab] = useState('field')

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
  /** Horodatage figé à l’entrée sur l’étape finale (piste audit / récap). */
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

  const totalArea = selectedPlots.reduce((s, p) => s + (p.area || 0), 0)
  const totalPlotPrice = selectedPlots.reduce((s, p) => s + (p.totalPrice || 0), 0)

  const filtered = salesForList.filter(s => {
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
  })

  const pendingPhoneReservation =
    !form.clientId && cinLookup.length >= 8 && !cinLookupResult
  const saleFormSubmitBlocked =
    !form.projectId ||
    form.plotIds.length === 0 ||
    (!form.clientId && !pendingPhoneReservation) ||
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
      const price = o.price ? o.price * selectedPlots.length : totalPlotPrice
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
  }, [form.deposit, form.paymentType, form.offerId, selectedPlots, totalPlotPrice, projectOffers])

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
    }
    if (saleWizardStep === 3) {
      const allowPendingPhone = !form.clientId && cinLookup.length >= 8 && !cinLookupResult
      if (!form.clientId && !allowPendingPhone) {
        addToast(
          'Identifiez le client par téléphone, créez une fiche, ou saisissez 8 chiffres inconnus pour une réservation avec rattachement ultérieur.',
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
  }, [saleWizardStep, form, projectOffers.length, addToast, cinLookup.length, cinLookupResult])

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

  const handleSave = useCallback(async () => {
    const client = form.clientId ? clients.find(c => c.id === form.clientId) : null
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

    const plotsTotalPrice = plots.reduce((s, p) => s + (p.totalPrice || 0), 0)
    const price = (offer && offer.price) ? (offer.price * plots.length) : plotsTotalPrice
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
      addToast('Prix convenu invalide : vérifiez les parcelles et l’offre.', 'error')
      return
    }
    const priceNum = Number(price) || 0
    if (depositAmount - priceNum > 0.005) {
      addToast('Acompte terrain ne peut pas dépasser le prix convenu.', 'error')
      return
    }

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
        const created = await salesCreate({
          projectId: form.projectId,
          projectTitle: project?.title || '',
          parcelId: plotDbIds[0],
          parcelIds: plotDbIds,
          clientId: client?.id || '',
          clientName: client?.name || 'Acheteur — rattachement en attente',
          buyerPhoneClaim: claimNorm,
          buyerPhoneNormalized: claimNorm,
          buyerUserId: client?.id || null,
          buyerAuthUserId: client?.authUserId || null,
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
        try {
          const sid = created?.sellerClientId || myClientId || null
          if (sid) {
            const sellerClient = clients.find((c) => String(c.id) === String(sid))
            const pid = sellerClient?.referredByClientId || ''
            if (pid && String(pid) !== String(sid)) {
              await db.upsertSellerRelation({
                childClientId: sid,
                parentClientId: pid,
                sourceSaleId: created.id,
              })
            }
          }
        } catch (e) {
          console.warn('seller_upline_autolink', e)
        }
        for (const p of plots) {
          if (p.dbId) await updateParcelStatus(p.dbId, 'reserved')
        }
      }
      addToast(editId ? 'Vente mise à jour' : `Vente créée — ${plots.length} parcelle(s)`)
      closeSaleDrawer()
    } catch (err) {
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
    }
  }, [form, editId, clients, scopedProjects, projectOffers, sales, salesCreate, salesUpdate, updateParcelStatus, addToast, role, adminUser, closeSaleDrawer, refreshSales, sellerMode, sellerAssignedParcelDbIds, myClientId, effectiveSellerClientId, cinLookup, sellerClientRecord?.cin])

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
    if (!clientForm.name.trim()) { addToast('Le nom est obligatoire', 'error'); return }
    const normalizedPhone = normalizePhoneLookup(clientForm.phone)
    if (!normalizedPhone) { addToast('Le téléphone est obligatoire', 'error'); return }
    // Store E.164 (+216…) on the client row so it matches `buyer_phone_normalized` and signup metadata.
    const phoneE164 = normalizePhone(String(clientForm.phone || '').trim()) || normalizePhone(normalizedPhone)

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

    setClientSaving(true)
    try {
      const newClient = await withTimeout(
        clientUpsert({
          code: `CLI-${Date.now()}`,
          name: clientForm.name.trim(),
          email: clientForm.email.trim().toLowerCase(),
          phone: phoneE164 || normalizedPhone,
          cin,
          city: clientForm.city.trim(),
          ...(role === 'Agent' && adminUser?.id ? { ownerAgentId: adminUser.id } : {}),
        }),
        15_000,
        'Création client: délai dépassé. Vérifiez la connexion / permissions (RLS) puis réessayez.',
      )
      if (!newClient?.id) {
        addToast('Impossible de créer ce client pour le moment.', 'error')
        return
      }
      setForm(f => ({ ...f, clientId: newClient.id }))
      setCinLookup(normalizedPhone)
      setCinLookupResult(newClient)
      addToast('Client créé')
      setClientModal(false)
      setClientForm({ name: '', email: '', phone: '', cin: '', city: '' })
    } catch (err) {
      // Surface RLS / permission denials distinctly so the user understands
      // it's NOT a transient glitch: their session doesn't hold staff rights.
      const raw = String(err?.message || err || '')
      const code = String(err?.code || '')
      const isRls = /row-level security|permission denied|not allowed|forbidden/i.test(raw) || code === '42501'
      if (isRls) {
        addToast(
          "Création client refusée (droits insuffisants). Votre compte n'est pas reconnu comme staff actif — contactez un administrateur.",
          'error',
        )
        // Keep the modal open so the user sees the failed fields and can retry
        // after the admin fixes their admin_users entry.
        return
      }
      addToast(`Erreur : ${raw}`, 'error')
    }
    finally { setClientSaving(false) }
  }, [clientForm, clients, clientUpsert, addToast, role, adminUser?.id, withTimeout])

  const activeSales = salesForList.filter(s => !['cancelled', 'completed', 'rejected'].includes(s.status)).length
  const fullPaymentCount = salesForList.filter(s => s.paymentType === 'full' && s.status !== 'cancelled').length
  const installmentCount = salesForList.filter(s => s.paymentType === 'installments' && s.status !== 'cancelled').length
  const totalRevenue = salesForList.filter(s => ['active', 'completed'].includes(s.status)).reduce((s, x) => s + (x.agreedPrice || 0), 0)

  const renderSaleList = () => (
    <>
      <div className="sell-cat__bar">
        <div className="sell-cat__stats">
          <span className="sell-cat__stat"><strong>{salesForList.length}</strong> total</span>
          <span className="sell-cat__stat-dot" />
          <span className="sell-cat__stat"><strong>{activeSales}</strong> actives</span>
          <span className="sell-cat__stat-dot" />
          <span className="sell-cat__stat"><strong>{totalRevenue.toLocaleString('fr-FR')}</strong> TND</span>
        </div>
        <div className="sell-cat__filters">
          <input className="sell-cat__search" placeholder="Rechercher…" value={search} onChange={e => setSearch(e.target.value)} />
          <select className="sell-cat__select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(STATUS_FLOW).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      </div>
      <div className="sell-cat__list">
        {filtered.length === 0 ? (
          <div className="sell-field__empty">
            {salesForList.length === 0 ? 'Aucune vente enregistrée.' : 'Aucun résultat.'}
          </div>
        ) : filtered.map(s => {
          const flow = STATUS_FLOW[s.status]
          const pt = PAYMENT_TYPE[s.paymentType] || PAYMENT_TYPE.full
          const pIds = normalizePlotIds(s)
          const plotLabel = pIds.length <= 3 ? pIds.map(id => `#${id}`).join(', ') : `${pIds.length} parcelles`
          const deposit = Number(s.deposit) || 0
          const ttl = reservationTtlText(s)
          return (
            <div key={s.id} className="sell-cat__card" onClick={() => setDetailSale(s)} role="presentation">
              <div className="sell-cat__card-head">
                <div className="sell-cat__card-user">
                  <span className="sell-cat__card-initials">{initialsFromName(s.clientName)}</span>
                  <div>
                    <p className="sell-cat__card-name">{s.clientName || '—'}</p>
                    <p className="sell-cat__card-sub">{s.projectTitle} · {plotLabel}</p>
                  </div>
                </div>
                <div className="sell-cat__card-status">
                  <span className={`sell-cat__badge sell-cat__badge--${flow?.badge || 'gray'}`}>{flow?.label || s.status}</span>
                  {ttl && <span className={`sell-cat__ttl${ttl.urgent ? ' sell-cat__ttl--urgent' : ''}`}>⏱ {ttl.text}</span>}
                </div>
              </div>
              <div className="sell-cat__card-body">
                <div className="sell-cat__card-price">
                  <span className="sell-cat__card-amount">{(s.agreedPrice || 0).toLocaleString('fr-FR')}</span>
                  <span className="sell-cat__card-currency">TND</span>
                </div>
                <div className="sell-cat__card-info">
                  <span>{pt.icon} {pt.label}</span>
                  {deposit > 0 && <span className="sell-cat__card-prepaid">↓ {deposit.toLocaleString('fr-FR')}</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )

  if (role === 'Agent' && !adminUser?.id) {
    return (
      <div className="sell-field" dir="ltr">
        <button type="button" className="ds-back-btn" onClick={goBack}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Back</span>
        </button>
        <div className="adm-empty">
          <div className="adm-empty-icon">⚠️</div>
          <div className="adm-empty-title">Compte agent incomplet</div>
          <div className="adm-empty-text">Identifiant administrateur manquant — les ventes ne peuvent pas être attribuées.</div>
        </div>
      </div>
    )
  }

  // Local style block scoped via unique class prefixes. We never modify the
  // shared admin.css / zitouna-admin-page.css files.
  const localStyles = `
    .sp2-help { font-size: 12px; color: #64748b; margin-top: 4px; line-height: 1.45; }
    .sp2-required { color: #dc2626; margin-left: 2px; }
    .sp2-section-title { font-size: 18px; font-weight: 700; margin: 0 0 4px; color: #0f172a; }
    .sp2-section-sub { font-size: 13px; color: #475569; margin: 0 0 12px; }
    .sp2-progress { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
    .sp2-progress-pill { flex: 1 1 40px; min-width: 36px; height: 6px; border-radius: 999px; background: #e2e8f0; transition: background .2s; }
    .sp2-progress-pill--done { background: #10b981; }
    .sp2-progress-pill--active { background: #2563eb; }
    .sp2-live-summary { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 12px; font-size: 12px; color: #334155; margin: 8px 0 14px; display: flex; flex-wrap: wrap; gap: 6px 14px; line-height: 1.5; }
    .sp2-live-summary strong { color: #0f172a; font-weight: 600; }
    .sp2-input-err { border-color: #dc2626 !important; background: #fef2f2 !important; }
    .sp2-err-msg { color: #dc2626; font-size: 12px; margin-top: 6px; display: flex; align-items: center; gap: 6px; }
    .sp2-empty { text-align: center; padding: 24px 16px; color: #64748b; font-size: 13px; border: 1px dashed #cbd5e1; border-radius: 12px; background: #f8fafc; }
    .sp2-empty-emoji { font-size: 28px; margin-bottom: 6px; display: block; }
    .sp2-empty-title { color: #0f172a; font-weight: 600; font-size: 14px; margin-bottom: 4px; }
    .sp2-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .sp2-help-card { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 10px 12px; font-size: 12px; color: #1e3a8a; line-height: 1.5; display: flex; gap: 8px; align-items: flex-start; }
    .sp2-help-card-ico { font-size: 14px; flex-shrink: 0; }
    .sp2-plot-legend { display: flex; flex-wrap: wrap; gap: 10px 14px; font-size: 12px; color: #475569; margin-bottom: 10px; align-items: center; }
    .sp2-plot-legend-dot { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 5px; vertical-align: middle; }
    .sp2-kbd-hint { font-size: 11px; color: #94a3b8; margin-top: 6px; }
    @media (max-width: 600px) {
      .sp2-field-row { grid-template-columns: 1fr; }
      .sp2-live-summary { font-size: 11px; }
      .sp2-section-title { font-size: 16px; }
    }
    .sell-wizard__input, .sell-wizard__select, .sell-wizard__textarea { min-height: 40px; }
    .sell-wizard__btn { min-height: 44px; }
    .sell-wizard__btn--primary, .sell-wizard__btn--cta { font-weight: 600; letter-spacing: 0.01em; }
  `

  // Build a one-line running summary shown at the top of the wizard so the
  // user always sees what they've chosen so far.
  const wizardLiveSummary = (() => {
    const parts = []
    if (selectedProject) parts.push(`Projet : ${selectedProject.title}`)
    if (selectedPlots.length) parts.push(`${selectedPlots.length} parcelle${selectedPlots.length > 1 ? 's' : ''}`)
    if (wizardSelectedClient) parts.push(`Client : ${wizardSelectedClient.name}`)
    else if (pendingPhoneReservation) parts.push('Client : rattachement en attente')
    if (form.paymentType) parts.push(form.paymentType === 'full' ? 'Comptant' : 'Échelonné')
    return parts
  })()

  return (
    <div className="sell-field" dir="ltr">
      <style>{localStyles}</style>
      <button type="button" className="ds-back-btn" onClick={goBack}>
        <span className="ds-back-btn__icon" aria-hidden>←</span>
        <span className="ds-back-btn__label">Retour</span>
      </button>
      {sellTab === 'field' && (
        <>
          <header className="sell-field__hero">
            <div className="sell-field__hero-top">
              <div className="sell-field__hero-user">
                <div className="sell-field__hero-avatar">
                  <img src={`https://api.dicebear.com/9.x/initials/svg?seed=${avatarSeed}&backgroundColor=eff6ff&textColor=2563eb&fontSize=42`} alt="" width={44} height={44} />
                </div>
                <div>
                  <h1 className="sell-field__hero-name">{displayAgentName}</h1>
                  <p className="sell-field__hero-role">{commercialRoleLabel}{agentCity ? ` · ${agentCity}` : ''}</p>
                </div>
              </div>
            </div>
            <div className="sell-field__hero-kpi">
              <div className="sell-field__kpi-block">
                <span className="sell-field__kpi-num">{todayDepositTotal.toLocaleString('fr-FR')}</span>
                <span className="sell-field__kpi-unit">TND</span>
              </div>
              <span className="sell-field__kpi-label">{todaySaleCount} vente{todaySaleCount !== 1 ? 's' : ''} aujourd’hui</span>
            </div>
          </header>

          <button
            type="button"
            className="sell-field__cta-btn"
            onClick={openNew}
            title="Démarrer le formulaire de vente en 6 étapes"
          >
            <span className="sell-field__cta-plus">+</span>
            <span className="sell-field__cta-text">Enregistrer une nouvelle vente</span>
            <span className="sell-field__cta-arrow">→</span>
          </button>

          <div className="sell-field__section-head">
            <h2 className="sell-field__section-title" style={{ fontSize: 18 }}>Ventes du jour</h2>
          </div>

          {salesToday.length === 0 ? (
            <div className="sp2-empty" role="status">
              <span className="sp2-empty-emoji" aria-hidden>📭</span>
              <div className="sp2-empty-title">Aucune vente aujourd’hui</div>
              <div>Appuyez sur « Enregistrer une nouvelle vente » pour commencer.</div>
            </div>
          ) : (
            <div className="sell-cat__list">
              {salesToday.map(s => {
                const flow = STATUS_FLOW[s.status]
                const pt = PAYMENT_TYPE[s.paymentType] || PAYMENT_TYPE.full
                const pIds = normalizePlotIds(s)
                const plotLabel = pIds.length <= 3 ? pIds.map(id => `#${id}`).join(', ') : `${pIds.length} parcelles`
                const deposit = Number(s.deposit) || 0
                const ttl = reservationTtlText(s)
                return (
                  <div key={s.id} className="sell-cat__card" onClick={() => setDetailSale(s)} role="presentation">
                    <div className="sell-cat__card-head">
                      <div className="sell-cat__card-user">
                        <span className="sell-cat__card-initials">{initialsFromName(s.clientName)}</span>
                        <div>
                          <p className="sell-cat__card-name">{s.clientName || '—'}</p>
                          <p className="sell-cat__card-sub">{s.projectTitle} · {plotLabel}</p>
                        </div>
                      </div>
                      <div className="sell-cat__card-status">
                        <span className={`sell-cat__badge sell-cat__badge--${flow?.badge || 'gray'}`}>{flow?.label || s.status}</span>
                        {ttl && <span className={`sell-cat__ttl${ttl.urgent ? ' sell-cat__ttl--urgent' : ''}`}>⏱ {ttl.text}</span>}
                      </div>
                    </div>
                    <div className="sell-cat__card-body">
                      <div className="sell-cat__card-price">
                        <span className="sell-cat__card-amount">{(s.agreedPrice || 0).toLocaleString('fr-FR')}</span>
                        <span className="sell-cat__card-currency">TND</span>
                      </div>
                      <div className="sell-cat__card-info">
                        <span>{pt.icon} {pt.label}</span>
                        {deposit > 0 && <span className="sell-cat__card-prepaid">↓ {deposit.toLocaleString('fr-FR')}</span>}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {sellTab === 'catalog' && renderSaleList()}

      <nav className="sell-field__bottom" aria-label="Navigation ventes">
        <div className="sell-field__bottom-inner">
          <button type="button" className={`sell-field__tab${sellTab === 'field' ? ' sell-field__tab--active' : ''}`} onClick={() => setSellTab('field')}>
            <span className="sell-field__tab-icon" aria-hidden>📍</span>
            Terrain
          </button>
          <button type="button" className={`sell-field__tab${sellTab === 'catalog' ? ' sell-field__tab--active' : ''}`} onClick={() => setSellTab('catalog')}>
            <span className="sell-field__tab-icon" aria-hidden>📋</span>
            Toutes les ventes
          </button>
        </div>
      </nav>

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
            <div className="sell-detail">
              <div className="sell-detail__banner">
                <div className="sell-detail__banner-top">
                  <span className={`sell-cat__badge sell-cat__badge--${flow?.badge || 'gray'}`}>{flow?.label || ds.status}</span>
                  {detailTtl && <span className={`sell-detail__ttl${detailTtl.urgent ? ' sell-detail__ttl--urgent' : ''}`}>⏱ {detailTtl.text}</span>}
                  <span className="sell-detail__date">{fmtFrDateTime(ds.createdAt)}</span>
                </div>
                <div className="sell-detail__banner-price">
                  <span className="sell-detail__price-num">{agreed.toLocaleString('fr-FR')}</span>
                  <span className="sell-detail__price-cur">TND</span>
                </div>
                <p className="sell-detail__banner-sub">{ds.projectTitle} · {plotLabel}</p>
              </div>

              <div className="sell-detail__section">
                <div className="sell-detail__section-title">Vendeur</div>
                <div className="sell-detail__row">
                  <span>Nom</span><strong>{resolveAgentForSale(ds)?.name || displayAgentName}</strong>
                </div>
                <div className="sell-detail__row">
                  <span>Contact</span><strong>{resolveAgentForSale(ds)?.email || adminUser?.email || user?.email || '—'}</strong>
                </div>
              </div>

              <div className="sell-detail__section">
                <div className="sell-detail__section-title">Client (acheteur)</div>
                <div className="sell-detail__row">
                  <span>Nom</span><strong>{ds.clientName || '—'}</strong>
                </div>
                {ds.clientPhone && (
                  <div className="sell-detail__row">
                    <span>Téléphone</span><strong style={{ direction: 'ltr' }}>{ds.clientPhone}</strong>
                  </div>
                )}
                {ds.clientEmail && (
                  <div className="sell-detail__row">
                    <span>Email</span><strong style={{ direction: 'ltr', wordBreak: 'break-all' }}>{ds.clientEmail}</strong>
                  </div>
                )}
                {ds.clientCin && (
                  <div className="sell-detail__row">
                    <span>CIN</span><strong style={{ direction: 'ltr' }}>{ds.clientCin}</strong>
                  </div>
                )}
              </div>

              <div className="sell-detail__section">
                <div className="sell-detail__section-title">Offre & paiement</div>
                <div className="sell-detail__row">
                  <span>Mode</span><strong>{pt.icon} {pt.label}</strong>
                </div>
                {isInst && ds.offerName && (
                  <div className="sell-detail__row">
                    <span>Offre</span><strong>{ds.offerName}</strong>
                  </div>
                )}
                <div className="sell-detail__row">
                  <span>Prix convenu</span><strong>{agreed.toLocaleString('fr-FR')} TND</strong>
                </div>
                {isInst && downPct > 0 && (
                  <>
                    <div className="sell-detail__row">
                      <span>1er versement ({downPct}%)</span><strong>{downAmt.toLocaleString('fr-FR')} TND</strong>
                    </div>
                    <div className="sell-detail__row">
                      <span>Capital restant</span><strong>{remaining.toLocaleString('fr-FR')} TND</strong>
                    </div>
                    {duration > 0 && (
                      <div className="sell-detail__row">
                        <span>Mensualité</span><strong>{monthly.toLocaleString('fr-FR')} TND x {duration} mois</strong>
                      </div>
                    )}
                  </>
                )}
                {deposit > 0 && (
                  <div className="sell-detail__row">
                    <span>Acompte</span><strong>{deposit.toLocaleString('fr-FR')} TND</strong>
                  </div>
                )}
                <div className="sell-detail__row sell-detail__row--highlight">
                  <span>Solde finance</span><strong>{balanceDue.toLocaleString('fr-FR')} TND</strong>
                </div>
              </div>

              <SaleLedgerPanel sale={ds} variant="detail" />

              {ds.notes && (
                <div className="sell-detail__section">
                  <div className="sell-detail__section-title">Notes</div>
                  <p className="sell-detail__notes">{ds.notes}</p>
                </div>
              )}

              <div className="sell-detail__actions">
                <button type="button" className="sell-detail__btn sell-detail__btn--edit" onClick={() => { setDetailSale(null); openEdit(ds) }}>Modifier</button>
              </div>
            </div>
          </AdminModal>
        )
      })()}

      {/* ── Edit Sale Modal (flat form) ── */}
      {drawer === 'edit' && editId && (() => {
        const prevSale = sales.find(s => s.id === editId)
        const canEditStructure = prevSale && ['draft', 'pending_finance'].includes(prevSale.status)
        const editProject = scopedProjects.find(p => p.id === form.projectId)
        const editPlotLabel = form.plotIds.length <= 3 ? form.plotIds.map(id => `#${id}`).join(', ') : `${form.plotIds.length} parcelles`
        return (
          <AdminModal open onClose={closeSaleDrawer} title="">
            <div className="sell-edit">
              <div className="sell-edit__banner">
                <p className="sell-edit__banner-title">Modifier la vente</p>
                <p className="sell-edit__banner-sub">{prevSale?.clientName || '—'} · {editProject?.title || prevSale?.projectTitle || '—'} · {editPlotLabel}</p>
              </div>

              <div className="sell-edit__body">
                <div className="sell-edit__field">
                  <label className="sell-edit__label">Acompte (TND)</label>
                  <div className="sell-edit__input" style={{ opacity: 0.8, cursor: 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>
                      {Number(arabonForProject(form.projectId) || 0).toLocaleString('fr-FR')}
                    </strong>
                    <span style={{ fontSize: 12, opacity: 0.8 }}>TND</span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                    Modifiable uniquement depuis les paramètres du projet.
                  </div>
                </div>
                <div className="sell-edit__field">
                  <label className="sell-edit__label">Mode de paiement</label>
                  <div className="sell-edit__toggle">
                    <button type="button" className={`sell-edit__toggle-btn${form.paymentType === 'full' ? ' sell-edit__toggle-btn--on' : ''}`}
                      onClick={() => setForm(f => ({ ...f, paymentType: 'full', offerId: '' }))}>Comptant</button>
                    <button type="button" className={`sell-edit__toggle-btn${form.paymentType === 'installments' ? ' sell-edit__toggle-btn--on' : ''}`}
                      onClick={() => setForm(f => ({ ...f, paymentType: 'installments' }))}>Echelonne</button>
                  </div>
                </div>
                {form.paymentType === 'installments' && projectOffers.length > 0 && (
                  <div className="sell-edit__field sell-edit__field--full">
                    <label className="sell-edit__label">Offre</label>
                    <div className="sell-edit__offer-list">
                      {projectOffers.map((o, i) => {
                        const sel = String(form.offerId) === String(i)
                        const mo = o.duration > 0 ? Math.round((o.price * (1 - o.downPayment / 100)) / o.duration) : 0
                        return (
                          <button key={i} type="button" className={`sell-edit__offer-opt${sel ? ' sell-edit__offer-opt--on' : ''}`}
                            onClick={() => setForm(f => ({ ...f, offerId: String(i) }))}>
                            <span className="sell-edit__offer-opt-radio" />
                            <span className="sell-edit__offer-opt-info">
                              <span className="sell-edit__offer-opt-name">{o.name}{o.price > 0 ? ` — ${o.price.toLocaleString('fr-FR')} TND` : ''}</span>
                              <span className="sell-edit__offer-opt-meta">{o.downPayment}% acompte · {o.duration} mois{mo > 0 ? ` · ~${mo.toLocaleString('fr-FR')}/mois` : ''}</span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div className="sell-edit__field sell-edit__field--full">
                  <label className="sell-edit__label">Notes</label>
                  <textarea className="sell-edit__input sell-edit__textarea" rows={2}
                    placeholder="Ajouter une note…"
                    value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                </div>
              </div>

              <div className="sell-edit__footer">
                <button type="button" className="sell-edit__btn sell-edit__btn--cancel" onClick={closeSaleDrawer}>Annuler</button>
                <button type="button" className="sell-edit__btn sell-edit__btn--save" onClick={handleSave}>Enregistrer</button>
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
            'sell-wizard sell-wizard--stacked' +
            (saleWizardStep === 2 && form.projectId ? ' sell-wizard--plots-grid-only' : '')
          }
          dir="ltr"
        >
          {!(saleWizardStep === 2 && form.projectId) && (
          <div className="sell-wizard__top">
            <div
              className="sp2-progress"
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
                    'sp2-progress-pill' +
                    (i + 1 < saleWizardStep ? ' sp2-progress-pill--done' : '') +
                    (i + 1 === saleWizardStep ? ' sp2-progress-pill--active' : '')
                  }
                />
              ))}
            </div>
            <div className="sell-wizard__steps" aria-hidden>
              {Array.from({ length: SALE_WIZARD_STEP_COUNT }, (_, i) => (
                <div
                  key={i}
                  className={
                    'sell-wizard__step-box' +
                    (i + 1 < saleWizardStep ? ' sell-wizard__step-box--done' : '') +
                    (i + 1 === saleWizardStep ? ' sell-wizard__step-box--active' : '')
                  }
                >
                  {i + 1 < saleWizardStep ? '✓' : i + 1}
                </div>
              ))}
            </div>
            <h2 className="sell-wizard__title" style={{ fontSize: 20 }}>
              {SALE_WIZARD_LABELS[saleWizardStep - 1]}
            </h2>
            <p className="sell-wizard__hint" style={{ fontSize: 13, lineHeight: 1.5 }}>
              {SALE_WIZARD_HELPERS[saleWizardStep - 1]}
            </p>
            {wizardLiveSummary.length > 0 && saleWizardStep > 1 && (
              <div className="sp2-live-summary" aria-label="Résumé de la saisie en cours">
                <span aria-hidden>📝</span>
                {wizardLiveSummary.map((p, i) => (
                  <span key={i}><strong>{p}</strong></span>
                ))}
              </div>
            )}
          </div>
          )}

          <div className="sell-wizard__scroll">
          {saleWizardStep === 1 && (
        <div className="sell-wizard__panel">
          <label className="sell-wizard__label" htmlFor="sp2-project-select">
            Projet concerné<span className="sp2-required" aria-hidden>*</span>
          </label>
          <select
            id="sp2-project-select"
            className={'sell-wizard__select' + (!form.projectId ? '' : '')}
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
          <p className="sp2-help">Le projet détermine les parcelles, offres et paramètres d’acompte disponibles.</p>
          {scopedProjects.length === 0 && (
            <div className="sp2-empty" style={{ marginTop: 12 }}>
              <span className="sp2-empty-emoji" aria-hidden>🏗️</span>
              <div className="sp2-empty-title">Aucun projet accessible</div>
              <div>Contactez un administrateur pour qu’un projet vous soit attribué.</div>
            </div>
          )}
        </div>
          )}

          {saleWizardStep === 2 && form.projectId && (
        <div className="sell-wizard__panel sell-wizard__panel--plots sell-wizard__panel--plots-minimal">
            <div style={{ padding: '0 4px 10px', borderBottom: '1px solid #e2e8f0', marginBottom: 10 }}>
              <h2 className="sp2-section-title">Choisissez les parcelles</h2>
              <p className="sp2-section-sub">
                {selectedPlots.length === 0
                  ? 'Appuyez sur un numéro pour le sélectionner.'
                  : `${selectedPlots.length} parcelle${selectedPlots.length > 1 ? 's' : ''} sélectionnée${selectedPlots.length > 1 ? 's' : ''}${totalArea > 0 ? ` · ${totalArea.toLocaleString('fr-FR')} m²` : ''}`}
              </p>
              <div className="sp2-plot-legend" aria-label="Légende des parcelles">
                <span><span className="sp2-plot-legend-dot" style={{ background: '#2563eb' }} />Sélectionnée</span>
                <span><span className="sp2-plot-legend-dot" style={{ background: '#f1f5f9', border: '1px solid #cbd5e1' }} />Disponible</span>
                <span><span className="sp2-plot-legend-dot" style={{ background: '#e5e7eb' }} />Indisponible</span>
              </div>
            </div>
            {allProjectPlots.length === 0 ? (
              <div className="sp2-empty">
                <span className="sp2-empty-emoji" aria-hidden>🗺️</span>
                <div className="sp2-empty-title">Aucune parcelle dans ce projet</div>
                <div>Revenez à l’étape précédente pour choisir un autre projet.</div>
              </div>
            ) : (
              <div className="sell-wizard__plots-grid-shell sell-wizard__plots-grid-shell--solo">
                <div
                  className="sell-wizard__plot-micro-grid"
                  role="group"
                  aria-label={
                    `Parcelles. ${selectedPlots.length} sélectionnée${selectedPlots.length !== 1 ? 's' : ''}. ` +
                    'Touchez un numéro pour l’ajouter ou le retirer. Indisponible si grisé et barré.'
                  }
                >
                    {sortedProjectPlots.map(pl => {
                      const numId = Number(pl.id)
                      const selected = form.plotIds.some(pid => Number(pid) === numId || String(pid) === String(pl.id))
                      const available = isPlotAvailable(pl)
                      return (
                        <button
                          key={pl.id}
                          type="button"
                          className={
                            'sell-wizard__plot-micro' +
                            (selected ? ' sell-wizard__plot-micro--selected' : '') +
                            (!available ? ' sell-wizard__plot-micro--taken' : '')
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
                          title={available ? `${selected ? 'Retirer' : 'Ajouter'} la parcelle ${pl.id}` : `Parcelle ${pl.id} indisponible`}
                        >
                          <span className="sell-wizard__plot-micro-num">{pl.id}</span>
                        </button>
                      )
                    })}
                </div>
              </div>
            )}
            {allProjectPlots.length > 0 && availablePlots.length === 0 && selectedPlots.length === 0 ? (
              <p className="sell-sr-only" role="status">
                Toutes les parcelles sont indisponibles (réservées, vendues ou liées à une vente).
              </p>
            ) : null}
        </div>
          )}

          {saleWizardStep === 3 && (
        <div className="sell-wizard__panel">
          <label className="sell-wizard__label">Client — recherche par téléphone</label>
          <div className="sell-wizard__row">
            <input
              className="sell-wizard__input"
              value={cinLookup}
              onChange={e => {
                const val = normalizePhoneLookup(e.target.value)
                setCinLookup(val)
                if (val.length >= 4) {
                  // Phone is the only linking key. CIN is optional metadata.
                  // 1) Instant match against the local list (cached view).
                  const found = clients.find(c => normalizePhoneLookup(c.phone) === val)
                  setCinLookupResult(found || null)
                  if (found) setForm(f => ({ ...f, clientId: found.id }))
                  else setForm(f => ({ ...f, clientId: '' }))
                  // 2) When the phone is fully entered and the local list said
                  //    "not found", double-check the database so we don't
                  //    invite the user to create a duplicate stub.
                  if (!found && val.length >= 8) {
                    const guard = val
                    db.fetchClientByPhone(val)
                      .then(dbClient => {
                        if (!dbClient) return
                        // Discard stale responses if the user kept typing.
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
              className="sell-wizard__btn sell-wizard__btn--ghost"
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={() => { setClientForm({ name: '', email: '', phone: cinLookup || '', cin: '', city: '' }); setClientModal(true) }}
            >
              + Nouveau
            </button>
          </div>
          {cinLookupResult && cinLookup.length >= 4 && (
            <div className="sell-wizard__mini sell-wizard__mini--ok">
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
            <div className="sell-wizard__mini sell-wizard__mini--warn">
              <span>⚠</span>
              <div>
                <div style={{ fontWeight: 700 }}>Aucun client avec ce téléphone</div>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  Créez une fiche avec « Nouveau », ou poursuivez : la vente enregistre une réclamation téléphone et se rattache à l’inscription.
                </div>
              </div>
            </div>
          )}
        </div>
          )}

          {saleWizardStep === 4 && (
        <div className="sell-wizard__panel">
          <label className="sell-wizard__label">Acompte (TND)</label>
          <div className="sell-wizard__arabon-display">
            <span className="sell-wizard__arabon-value" style={{ textAlign: 'center' }}>
              {Number(arabonForProject(form.projectId) || 0).toLocaleString('fr-FR')}
            </span>
            <span className="sell-wizard__arabon-unit">TND</span>
          </div>
          <p className="sell-wizard__arabon-note">
            Modifiable uniquement depuis les paramètres du projet.
          </p>
        </div>
          )}

          {saleWizardStep === 5 && (
        <>
        <div className="sell-wizard__panel">
          <label className="sell-wizard__label">Mode de paiement</label>
          <div className="sell-wizard__pay-grid">
            <button
              type="button"
              className={`sell-wizard__pay-card${form.paymentType === 'full' ? ' sell-wizard__pay-card--on' : ''}`}
              onClick={() => setForm(f => ({ ...f, paymentType: 'full', offerId: '' }))}
            >
              <div className="sell-wizard__pay-ico">💵</div>
              <div className="sell-wizard__pay-name">Comptant</div>
              <div className="sell-wizard__pay-hint">Montant total en espèces</div>
            </button>
            <button
              type="button"
              className={`sell-wizard__pay-card${form.paymentType === 'installments' ? ' sell-wizard__pay-card--on' : ''}`}
              onClick={() => setForm(f => ({ ...f, paymentType: 'installments' }))}
            >
              <div className="sell-wizard__pay-ico">📅</div>
              <div className="sell-wizard__pay-name">Echelonne</div>
              <div className="sell-wizard__pay-hint">Acompte + mensualités</div>
            </button>
          </div>
        </div>

        {form.paymentType === 'installments' && form.projectId && projectOffers.length > 0 && (
          <div className="sell-wizard__panel">
            <label className="sell-wizard__label">Offre de paiement</label>
            <div className="sell-wizard__offer-list">
              {projectOffers.map((o, i) => {
                const sel = String(form.offerId) === String(i)
                const mo = o.duration > 0 ? Math.round((o.price * (1 - o.downPayment / 100)) / o.duration) : 0
                return (
                  <button key={i} type="button" className={`sell-wizard__offer${sel ? ' sell-wizard__offer--on' : ''}`}
                    onClick={() => setForm(f => ({ ...f, offerId: String(i) }))}>
                    <div className="sell-wizard__offer-top">
                      <span className="sell-wizard__offer-name">{o.name}</span>
                      {o.price > 0 && <span className="sell-wizard__offer-price">{o.price.toLocaleString('fr-FR')} TND</span>}
                    </div>
                    <div className="sell-wizard__offer-chips">
                      <span className="sell-wizard__offer-chip">{o.downPayment}%</span>
                      <span className="sell-wizard__offer-chip">{o.duration} mois</span>
                      {mo > 0 && <span className="sell-wizard__offer-chip">~{mo.toLocaleString('fr-FR')}/mois</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {form.paymentType === 'installments' && form.projectId && projectOffers.length === 0 && (
          <div className="sell-wizard__fin-warn">⚠️ Aucune offre pour ce projet — passez en comptant ou configurez les offres.</div>
        )}

        {form.paymentType === 'installments' && form.offerId !== '' && projectOffers[Number(form.offerId)] && selectedPlots.length > 0 && (() => {
          const o = projectOffers[Number(form.offerId)]
          const price = o.price ? (o.price * selectedPlots.length) : totalPlotPrice
          const down = Math.round(price * o.downPayment / 100)
          const remaining = price - down
          const monthly = Math.round(remaining / o.duration)
          const arabonVal = Number(form.deposit) || 0
          const toPay = Math.max(0, down - arabonVal)
          return (
            <div className="sell-wizard__panel">
              <div className="sell-wizard__fin-header">Détail des échéances — {selectedPlots.length} parcelle(s)</div>
              {o.price && o.price * selectedPlots.length !== totalPlotPrice && (
                <div className="sell-wizard__fin-catalog-note">
                  Prix catalogue : <s>{totalPlotPrice.toLocaleString('fr-FR')} TND</s> → offre : <strong>{price.toLocaleString('fr-FR')} TND</strong>
                </div>
              )}
              <div className="sell-wizard__fin-grid">
                <span>Prix convenu :</span> <strong>{price.toLocaleString('fr-FR')} TND</strong>
                <span>1er versement ({o.downPayment} %) :</span> <strong>{down.toLocaleString('fr-FR')} TND</strong>
                <span>Reste :</span> <strong>{remaining.toLocaleString('fr-FR')} TND</strong>
                <span>Mensualité :</span> <strong>{monthly.toLocaleString('fr-FR')} TND × {o.duration}</strong>
              </div>
              {arabonVal > 0 && (
                <div className="sell-wizard__fin-deductions">
                  <div className="sell-wizard__fin-deduct-row">
                    <span>Acompte terrain :</span>
                    <strong>- {arabonVal.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sell-wizard__fin-total-row">
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
            <div className="sell-wizard__panel">
              <div className="sell-wizard__fin-header">Résumé comptant — {selectedPlots.length} parcelle(s)</div>
              <div className="sell-wizard__fin-grid">
                <span>Montant total :</span>
                <strong>{totalPlotPrice.toLocaleString('fr-FR')} TND</strong>
              </div>
              {arabonVal > 0 && (
                <div className="sell-wizard__fin-deductions">
                  <div className="sell-wizard__fin-deduct-row">
                    <span>Acompte terrain :</span>
                    <strong>- {arabonVal.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sell-wizard__fin-total-row">
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
          <div className="sell-wizard__recap sell-wizard__recap--stack">
            <div className="sell-wizard__recap-section">
              <div className="sell-wizard__recap-section-title">Suivi &amp; horodatage</div>
              <div className="sell-wizard__recap-row">
                <span>Récapitulatif établi le</span>
                <strong>{fmtFrDateTime(recapCapturedAt)}</strong>
              </div>
              {editId && (
                <>
                  <div className="sell-wizard__recap-row">
                    <span>Réf. vente</span>
                    <strong style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.72rem', wordBreak: 'break-all' }}>{editId}</strong>
                  </div>
                  {saleBeingEdited?.createdAt && (
                    <div className="sell-wizard__recap-row">
                      <span>Vente créée le</span>
                      <strong>{fmtFrDateTime(saleBeingEdited.createdAt)}</strong>
                    </div>
                  )}
                  {saleBeingEdited?.updatedAt &&
                    saleBeingEdited?.createdAt &&
                    String(saleBeingEdited.updatedAt) !== String(saleBeingEdited.createdAt) && (
                      <div className="sell-wizard__recap-row">
                        <span>Dernière mise à jour</span>
                        <strong>{fmtFrDateTime(saleBeingEdited.updatedAt)}</strong>
                      </div>
                    )}
                </>
              )}
            </div>

            <div className="sell-wizard__recap-section">
              <div className="sell-wizard__recap-section-title">Commercial (vendeur)</div>
              <div className="sell-wizard__recap-row">
                <span>Nom</span>
                <strong>{displayAgentName}</strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>Rôle</span>
                <strong>{commercialRoleLabel}</strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>Contact</span>
                <strong>{adminUser?.email || user?.email || '—'}</strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>Téléphone</span>
                <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>
                  {normalizePhoneLookup(adminUser?.phone || user?.phone || '') || '—'}
                </strong>
              </div>
            </div>

            <div className="sell-wizard__recap-section">
              <div className="sell-wizard__recap-section-title">Client</div>
              <div className="sell-wizard__recap-row">
                <span>Nom</span>
                <strong>
                  {wizardSelectedClient?.name || (pendingPhoneReservation ? 'Rattachement en attente (téléphone)' : '—')}
                </strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>CIN</span>
                <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>
                  {wizardSelectedClient?.cin || cinLookupResult?.cin || '—'}
                </strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>Téléphone</span>
                <strong style={{ direction: 'ltr' }}>
                  {wizardSelectedClient?.phone || (pendingPhoneReservation ? normalizePhone(cinLookup) : '—')}
                </strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>Email</span>
                <strong style={{ direction: 'ltr', wordBreak: 'break-all' }}>{wizardSelectedClient?.email || '—'}</strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>Ville</span>
                <strong>{wizardSelectedClient?.city || '—'}</strong>
              </div>
            </div>

            <div className="sell-wizard__recap-section">
              <div className="sell-wizard__recap-section-title">Commission (attribuee au vendeur)</div>
              <p className="sell-wizard__hint">
                Le rattachement se fait par numero de telephone. Le CIN reste une information complementaire.
              </p>
              {willBeCreditedAsSellerL1 ? (
                <p className="sell-wizard__hint" style={{ color: '#0a7a3a', fontWeight: 600 }}>
                  Vous serez crédité comme vendeur (L1) sur cette vente.
                </p>
              ) : sellerL1BlockedByBuyerEq ? (
                <p className="sell-wizard__hint" style={{ color: '#b94a00', fontWeight: 600 }}>
                  Vous êtes l’acheteur sur cette vente : aucune commission L1 ne vous sera attribuée.
                </p>
              ) : (
                <p className="sell-wizard__hint" style={{ color: '#b94a00', fontWeight: 600 }}>
                  Aucun compte client n’est rattaché à votre session : aucune commission L1 ne sera attribuée. Contactez un Super Admin pour rattacher votre CIN/téléphone à un profil client afin d’être crédité.
                </p>
              )}
              <div className="sell-wizard__recap-row">
                <span>Vendeur</span>
                <strong>{sellerClientRecord?.name || displayAgentName}</strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>Telephone</span>
                <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>
                  {normalizePhoneLookup(sellerClientRecord?.phone || adminUser?.phone || user?.phone || '') || '—'}
                </strong>
              </div>
              {sellerClientRecord?.cin ? (
                <div className="sell-wizard__recap-row">
                  <span>CIN</span>
                  <strong style={{ direction: 'ltr', fontFamily: 'ui-monospace, monospace' }}>{sellerClientRecord.cin}</strong>
                </div>
              ) : null}
              {!sellerClientRecord && !myClientId ? (
                <div className="sell-wizard__recap-row">
                  <span>Compte vendeur (client)</span>
                  <strong>—</strong>
                </div>
              ) : null}
            </div>

            <div className="sell-wizard__recap-section">
              <div className="sell-wizard__recap-section-title">Projet &amp; parcelles</div>
              <div className="sell-wizard__recap-row">
                <span>Projet</span>
                <strong>{selectedProject ? `${selectedProject.title} — ${selectedProject.city || ''}` : '—'}</strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>Parcelles ({selectedPlots.length})</span>
                <strong>
                  {selectedPlots.length
                    ? selectedPlots
                        .map((p) => `#${p.id}${p.area != null ? ` · ${p.area} m²` : ''}${p.trees != null ? ` · ${p.trees} arbres` : ''}`)
                        .join(' · ')
                    : '—'}
                </strong>
              </div>
              <div className="sell-wizard__recap-row">
                <span>Surface totale</span>
                <strong>{totalArea > 0 ? `${totalArea.toLocaleString('fr-FR')} m²` : '—'}</strong>
              </div>
            </div>

            <div className="sell-wizard__recap-section">
              <div className="sell-wizard__recap-section-title">Offre &amp; encaissements</div>
              <div className="sell-wizard__recap-row">
                <span>Mode de paiement</span>
                <strong>{form.paymentType === 'full' ? 'Comptant' : 'Echelonne'}</strong>
              </div>
              {wizardFinancialRecap.kind === 'installments' && wizardFinancialRecap.offer && (
                <>
                  <div className="sell-wizard__recap-row">
                    <span>Offre commerciale</span>
                    <strong>{wizardFinancialRecap.offer.name}</strong>
                  </div>
                  <div className="sell-wizard__recap-row">
                    <span>Prix convenu ({wizardFinancialRecap.plotCount} parcelle(s))</span>
                    <strong>{wizardFinancialRecap.price.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sell-wizard__recap-row">
                    <span>1er versement ({wizardFinancialRecap.downPct} %)</span>
                    <strong>{wizardFinancialRecap.down.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sell-wizard__recap-row">
                    <span>Capital restant</span>
                    <strong>{wizardFinancialRecap.remaining.toLocaleString('fr-FR')} TND</strong>
                  </div>
                  <div className="sell-wizard__recap-row">
                    <span>Mensualité × durée</span>
                    <strong>
                      {wizardFinancialRecap.monthly.toLocaleString('fr-FR')} TND × {wizardFinancialRecap.duration} mois
                    </strong>
                  </div>
                </>
              )}
              {wizardFinancialRecap.kind === 'full' && (
                <div className="sell-wizard__recap-row">
                  <span>Montant total (parcelles)</span>
                  <strong>{wizardFinancialRecap.totalPlotPrice.toLocaleString('fr-FR')} TND</strong>
                </div>
              )}
              <div className="sell-wizard__recap-row">
                <span>Acompte (terrain)</span>
                <strong>{wizardFinancialRecap.kind !== 'incomplete' ? wizardFinancialRecap.arabon.toLocaleString('fr-FR') : (Number(form.deposit) || 0).toLocaleString('fr-FR')} TND</strong>
              </div>
              {wizardFinancialRecap.kind !== 'incomplete' && (
                <div className="sell-wizard__recap-row sell-wizard__recap-row--emph">
                  <span>Solde à encaisser (finance)</span>
                  <strong>{wizardFinancialRecap.toPay.toLocaleString('fr-FR')} TND</strong>
                </div>
              )}
              {wizardFinancialRecap.kind === 'incomplete' && form.paymentType === 'installments' && (
                <div className="sell-wizard__recap-note">
                  Complétez le mode et l’offre à l’étape précédente pour le détail des montants.
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
          <div className="sell-wizard__panel">
            <label className="sell-wizard__label">Notes internes</label>
            <textarea className="sell-wizard__textarea" value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes internes…" />
          </div>
        </>
          )}

          </div>

          <div className="sell-wizard__footer">
            {saleWizardStep > 1 && (
              <button type="button" className="sell-wizard__btn sell-wizard__btn--ghost" onClick={() => setSaleWizardStep(s => Math.max(1, s - 1))}>
                ‹ Retour
              </button>
            )}
            <span className="sell-wizard__footer-spacer" />
            {saleWizardStep < SALE_WIZARD_STEP_COUNT ? (
              <button type="button" className="sell-wizard__btn sell-wizard__btn--primary" onClick={tryWizardNext}>
                Continuer ›
              </button>
            ) : (
              <>
                <button type="button" className="sell-wizard__btn sell-wizard__btn--ghost" onClick={closeSaleDrawer}>
                  Annuler
                </button>
                <button
                  type="button"
                  className="sell-wizard__btn sell-wizard__btn--cta"
                  onClick={handleSave}
                  disabled={saleFormSubmitBlocked}
                >
                  {editId ? 'Enregistrer' : `Créer la vente (${form.plotIds.length} parcelle(s))`}
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
        <div className="adm-form-row">
          <div className="adm-field"><label className="adm-label">Téléphone *</label><input className="adm-input" value={clientForm.phone} onChange={e => setClientForm(f => ({ ...f, phone: e.target.value }))} placeholder="+216 XX XXX XXX" /></div>
          <div className="adm-field"><label className="adm-label">E-mail</label><input className="adm-input" type="email" value={clientForm.email} onChange={e => setClientForm(f => ({ ...f, email: e.target.value }))} placeholder="email@example.com" /></div>
        </div>
        <div className="adm-field"><label className="adm-label">Ville</label><input className="adm-input" value={clientForm.city} onChange={e => setClientForm(f => ({ ...f, city: e.target.value }))} placeholder="Tunis, Sousse…" /></div>
        <div className="adm-form-actions">
          <button className="adm-btn adm-btn--secondary" onClick={() => setClientModal(false)}>Annuler</button>
          <button className="adm-btn adm-btn--primary" onClick={handleCreateClient} disabled={!clientForm.name.trim() || !normalizePhoneLookup(clientForm.phone) || clientSaving}>{clientSaving ? 'Création…' : 'Créer le client'}</button>
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
                    <li>Création du plan d’échéances : <strong>{actionModal.offerDuration} mois</strong></li>
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
