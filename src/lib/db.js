import { supabase } from './supabase.js'
import { normalizeAdminPagePath } from '../admin/adminNavConfig.js'
import { dedupeVerificationRequestsByUserAndCin } from './verificationResolution.js'
import { normalizePhone as normalizePhoneE164 } from './phone.js'

let PREVIEW_RPC_DISABLED_UNTIL = 0
const USE_PREVIEW_RPC = Boolean(
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_USE_PREVIEW_RPC === '1')
  || (typeof window !== 'undefined' && window.__USE_PREVIEW_RPC__ === true)
)

/** Dev-only: allow client-side fallback when RPC `approve_data_access_and_link_client` is missing. */
const ALLOW_APPROVE_LINK_FALLBACK =
  typeof import.meta !== 'undefined' &&
  import.meta.env?.DEV === true &&
  import.meta.env?.VITE_ALLOW_APPROVE_LINK_FALLBACK === '1'

export function randomEntityCode(prefix) {
  const p = String(prefix || 'ID').replace(/[^A-Za-z0-9_-]/g, '') || 'ID'
  try {
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
      return `${p}-${globalThis.crypto.randomUUID()}`
    }
  } catch {
    /* ignore */
  }
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function db() {
  return supabase
}

export function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits.length > 8 ? digits.slice(-8) : digits
}

export function normalizeCountryCode(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return ''
  return `+${digits}`
}

export function normalizePhoneLocal(raw) {
  return String(raw || '').replace(/\D/g, '')
}

export function normalizePhoneCanonical(rawPhone, { countryCode = '', phoneLocal = '' } = {}) {
  const cc = normalizeCountryCode(countryCode)
  const local = normalizePhoneLocal(phoneLocal)
  if (cc && local) return `${cc}${local}`
  const digits = String(rawPhone || '').replace(/\D/g, '')
  if (!digits) return ''
  if (String(rawPhone || '').trim().startsWith('+')) return `+${digits}`
  if (cc) return `${cc}${digits}`
  return `+${digits}`
}

function throwIfError(res, label) {
  if (res.error) {
    const err = new Error(`${label}: ${res.error.message}`)
    if (res.error.code) err.code = res.error.code
    if (res.error.details) err.details = res.error.details
    throw err
  }
  return res.data
}

async function currentUserId() {
  const { data, error } = await db().auth.getUser()
  if (error) throw new Error(`authUser: ${error.message}`)
  return data?.user?.id || null
}

/** Maps JWT user to admin_users.id for audit_logs.actor_user_id FK (not auth.uid()). */
async function resolveCurrentAdminActor() {
  const { data: authData, error } = await db().auth.getUser()
  if (error || !authData?.user?.email) return { adminId: null, email: '' }
  const email = String(authData.user.email).toLowerCase()
  const res = await db().from('admin_users').select('id, email').ilike('email', email).maybeSingle()
  if (res.error || !res.data) return { adminId: null, email }
  return { adminId: res.data.id, email: res.data.email || email }
}

async function signReceiptUrls(paths = []) {
  const unique = [...new Set((paths || []).filter((p) => p && !String(p).startsWith('http')))]
  if (!unique.length) return new Map()
  const rs = await db().storage.from('installment-receipts').createSignedUrls(unique, 3600)
  if (rs.error || !Array.isArray(rs.data)) return new Map()
  const map = new Map()
  for (const item of rs.data) {
    if (item?.path && item?.signedUrl) map.set(item.path, item.signedUrl)
  }
  return map
}

/**
 * Generate a short-lived signed URL for a receipt stored in `installment-receipts`.
 * If the input is already an absolute URL, returns it unchanged.
 */
export async function getInstallmentReceiptSignedUrl(path, expiresInSec = 3600) {
  if (!path) return ''
  if (String(path).startsWith('http')) return path
  const res = await db().storage.from('installment-receipts').createSignedUrl(path, expiresInSec)
  if (res.error) throw new Error(res.error.message || 'signed url error')
  return res.data?.signedUrl || ''
}

const DB_ROLE_MAP = { SUPER_ADMIN: 'Super Admin', STAFF: 'Staff' }
const APP_ROLE_MAP = { 'Super Admin': 'SUPER_ADMIN', 'Staff': 'STAFF' }

/* ═══════════════════════════════════════════════════════════
   PROJECTS  (read-only + parcel status updates)
   ═══════════════════════════════════════════════════════════ */

export async function fetchProjects() {
  const [projRes, parcelRes] = await Promise.all([
    db().from('projects').select('*'),
    db().from('parcels').select('*'),
  ])
  const projects = throwIfError(projRes, 'projects')
  const parcels = throwIfError(parcelRes, 'parcels')
  const parcelIds = (parcels || []).map((p) => p.id).filter(Boolean)
  const batchRes =
    parcelIds.length > 0
      ? await db().from('parcel_tree_batches').select('*').in('parcel_id', parcelIds)
      : { data: [], error: null }
  const batches = throwIfError(batchRes, 'batches')

  return projects.map(p => ({
    id: p.id,
    title: p.title,
    city: p.city,
    region: p.region || '',
    area: p.area || '',
    year: p.year_started || '',
    description: p.description || '',
    mapUrl: p.map_url || '',
    arabonDefault: Number(p.arabon_default) || 50,
    plots: parcels
      .filter(x => x.project_id === p.id)
      .map(pl => ({
        id: pl.parcel_number,
        dbId: pl.id,
        area: Number(pl.area_m2 || 0),
        trees: Number(pl.tree_count || 0),
        totalPrice: Number(pl.total_price || 0),
        pricePerTree: Number(pl.price_per_tree || 0),
        status: pl.status || 'available',
        mapUrl: pl.map_url || '',
        treeBatches: batches
          .filter(b => b.parcel_id === pl.id)
          .map(b => ({ year: b.batch_year, count: b.tree_count })),
      })),
  }))
}

/** Explorer / browse: all projects and parcels (public, no status filter). */
export async function fetchPublicCatalogProjects() {
  const [projRes, parcelRes] = await Promise.all([
    db().from('projects').select('*'),
    db().from('parcels').select('*'),
  ])
  const projects = throwIfError(projRes, 'projects')
  const parcels = throwIfError(parcelRes, 'parcels')
  const parcelIds = (parcels || []).map((p) => p.id).filter(Boolean)
  const batchRes =
    parcelIds.length > 0
      ? await db().from('parcel_tree_batches').select('*').in('parcel_id', parcelIds)
      : { data: [], error: null }
  const batches = throwIfError(batchRes, 'batches')

  return projects
    .map((p) => ({
      id: p.id,
      title: p.title,
      city: p.city,
      region: p.region || '',
      area: p.area || '',
      year: p.year_started || '',
      description: p.description || '',
      mapUrl: p.map_url || '',
      arabonDefault: Number(p.arabon_default) || 50,
      plots: parcels
        .filter((x) => x.project_id === p.id)
        .map((pl) => ({
          id: pl.parcel_number,
          dbId: pl.id,
          area: Number(pl.area_m2 || 0),
          trees: Number(pl.tree_count || 0),
          totalPrice: Number(pl.total_price || 0),
          pricePerTree: Number(pl.price_per_tree || 0),
          status: pl.status || 'available',
          mapUrl: pl.map_url || '',
          treeBatches: batches
            .filter((b) => b.parcel_id === pl.id)
            .map((b) => ({ year: b.batch_year, count: b.tree_count })),
        })),
    }))
}

/** Public visitor visit slot options (template list). */
export async function fetchPublicVisitSlotOptions() {
  const res = await db()
    .from('visit_slot_options')
    .select('id, label, hint, sort_order')
    .order('sort_order', { ascending: true })
  const rows = throwIfError(res, 'visitSlotOptions')
  return (rows || []).map((r) => ({
    id: r.id,
    label: r.label,
    hint: r.hint || '',
    sortOrder: Number(r.sort_order || 0),
  }))
}

/** Single project for public detail / plot / visite flows — all parcels visible. */
export async function fetchPublicProjectById(projectId) {
  const id = String(projectId || '').trim()
  if (!id) return null

  const [projRes, parcelRes] = await Promise.all([
    db().from('projects').select('*').eq('id', id).maybeSingle(),
    db().from('parcels').select('*').eq('project_id', id),
  ])
  if (projRes.error) throw new Error(`project: ${projRes.error.message}`)
  const p = projRes.data
  if (!p) return null

  const parcels = throwIfError(parcelRes, 'parcels')
  const parcelIds = (parcels || []).map((p) => p.id).filter(Boolean)
  const batchRes =
    parcelIds.length > 0
      ? await db().from('parcel_tree_batches').select('*').in('parcel_id', parcelIds)
      : { data: [], error: null }
  const batches = throwIfError(batchRes, 'batches')

  const plots = parcels
    .filter((x) => x.project_id === p.id)
    .map((pl) => ({
      id: pl.parcel_number,
      dbId: pl.id,
      area: Number(pl.area_m2 || 0),
      trees: Number(pl.tree_count || 0),
      totalPrice: Number(pl.total_price || 0),
      pricePerTree: Number(pl.price_per_tree || 0),
      status: pl.status || 'available',
      mapUrl: pl.map_url || '',
      treeBatches: batches
        .filter((b) => b.parcel_id === pl.id)
        .map((b) => ({ year: b.batch_year, count: b.tree_count })),
    }))

  return {
    id: p.id,
    title: p.title,
    city: p.city,
    region: p.region || '',
    area: p.area || '',
    year: p.year_started || '',
    description: p.description || '',
    mapUrl: p.map_url || '',
    arabonDefault: Number(p.arabon_default) || 50,
    plots,
  }
}

const DEFAULT_SIGNATURE_CHECKLIST = [
  { key: 'contract', label: 'Contrat de vente principal', required: true, grantAllowedPages: null },
  { key: 'cahier', label: 'كراس الشروط', required: true, grantAllowedPages: null },
  {
    key: 'seller_contract',
    label: 'Contrat du vendeur / mandat (optionnel)',
    required: false,
    grantAllowedPages: ['/admin/sell'],
  },
]

const DEFAULT_COMMISSION_RULES = [
  { level: 1, ruleType: 'fixed', value: 60, maxCapAmount: null },
  { level: 2, ruleType: 'fixed', value: 20, maxCapAmount: null },
]

function parseGrantAllowedPages(raw) {
  if (raw == null) return null
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw)
      return Array.isArray(p) ? p : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Workflow config for a project (fees, reservation, checklist, commissions).
 * Used for live Supabase: project settings + sale snapshots at creation.
 */
export async function fetchProjectWorkflowConfig(projectId) {
  const id = String(projectId || '').trim()
  if (!id) {
    return {
      projectId: '',
      arabonDefault: 50,
      reservationHours: 48,
      arabonPolicy: { on_cancel: 'configurable' },
      companyFeePct: 5,
      notaryFeePct: 2,
      minimumPayoutThreshold: 100,
      signatureChecklist: DEFAULT_SIGNATURE_CHECKLIST.map((x) => ({ ...x })),
      commissionRules: DEFAULT_COMMISSION_RULES.map((x) => ({ ...x })),
    }
  }

  const [projRes, settingsRes, checklistRes, rulesRes] = await Promise.all([
    db().from('projects').select('arabon_default').eq('id', id).maybeSingle(),
    db().from('project_workflow_settings').select('*').eq('project_id', id).maybeSingle(),
    db().from('project_signature_checklist_items').select('*').eq('project_id', id).order('sort_order', { ascending: true }),
    db().from('project_commission_rules').select('*').eq('project_id', id).order('level', { ascending: true }),
  ])

  if (projRes.error) throw new Error(`projectWorkflowProject: ${projRes.error.message}`)
  if (settingsRes.error) throw new Error(`projectWorkflowSettings: ${settingsRes.error.message}`)
  const checklistRows = throwIfError(checklistRes, 'projectWorkflowChecklist')
  const rulesRows = throwIfError(rulesRes, 'projectWorkflowCommissionRules')

  const arabonDefault = Number(projRes.data?.arabon_default) || 50
  const s = settingsRes.data || {}
  const signatureChecklist =
    checklistRows.length > 0
      ? checklistRows.map((row) => ({
          key: row.item_key,
          label: row.label,
          required: Boolean(row.required),
          grantAllowedPages: parseGrantAllowedPages(row.grant_allowed_pages),
        }))
      : DEFAULT_SIGNATURE_CHECKLIST.map((x) => ({ ...x }))

  const commissionRules =
    rulesRows.length > 0
      ? rulesRows.map((r) => ({
          level: r.level,
          ruleType: r.rule_type === 'percent' ? 'percent' : 'fixed',
          value: Number(r.value),
          maxCapAmount: r.max_cap_amount != null ? Number(r.max_cap_amount) : null,
        }))
      : DEFAULT_COMMISSION_RULES.map((x) => ({ ...x }))

  return {
    projectId: id,
    arabonDefault,
    reservationHours: Number(s.reservation_duration_hours) || 48,
    arabonPolicy:
      s.arabon_policy && typeof s.arabon_policy === 'object' && !Array.isArray(s.arabon_policy)
        ? s.arabon_policy
        : { on_cancel: 'configurable' },
    companyFeePct: Number(s.company_fee_pct ?? 5),
    notaryFeePct: Number(s.notary_fee_pct ?? 2),
    minimumPayoutThreshold: Number(s.minimum_payout_threshold ?? 100),
    signatureChecklist,
    commissionRules,
  }
}

/** Persist fee / reservation / payout rows in `project_workflow_settings` from a merged workflow shape. */
export async function upsertProjectWorkflowSettingsFromShape(projectId, wf) {
  const id = String(projectId || '').trim()
  if (!id) throw new Error('upsertProjectWorkflowSettingsFromShape: missing projectId')
  const row = {
    project_id: id,
    reservation_duration_hours: Number(wf.reservationHours) || 48,
    arabon_policy:
      wf.arabonPolicy && typeof wf.arabonPolicy === 'object' && !Array.isArray(wf.arabonPolicy)
        ? wf.arabonPolicy
        : {},
    company_fee_pct: Number(wf.companyFeePct ?? 5),
    notary_fee_pct: Number(wf.notaryFeePct ?? 2),
    minimum_payout_threshold: Number(wf.minimumPayoutThreshold ?? 0),
  }
  const res = await db().from('project_workflow_settings').upsert(row, { onConflict: 'project_id' })
  throwIfError(res, 'upsertProjectWorkflowSettingsFromShape')
}

export async function updateProjectArabonDefault(projectId, arabonDefault) {
  const id = String(projectId || '').trim()
  if (!id) return
  const res = await db().from('projects').update({ arabon_default: Number(arabonDefault) || 50 }).eq('id', id)
  throwIfError(res, 'updateProjectArabonDefault')
}

export async function replaceProjectSignatureChecklist(projectId, items = []) {
  const id = String(projectId || '').trim()
  if (!id) throw new Error('replaceProjectSignatureChecklist: missing projectId')
  const del = await db().from('project_signature_checklist_items').delete().eq('project_id', id)
  throwIfError(del, 'deleteProjectSignatureChecklist')
  if (!Array.isArray(items) || !items.length) return
  const rows = items.map((it, i) => ({
    project_id: id,
    item_key: String(it.key || it.item_key || '').trim() || `item_${i + 1}`,
    label: String(it.label || '').trim() || String(it.key || 'Item'),
    required: Boolean(it.required),
    sort_order: Number(it.sortOrder) >= 0 ? Number(it.sortOrder) : i + 1,
    grant_allowed_pages:
      it.grantAllowedPages == null
        ? null
        : Array.isArray(it.grantAllowedPages)
          ? it.grantAllowedPages
          : null,
  }))
  const ins = await db().from('project_signature_checklist_items').insert(rows)
  throwIfError(ins, 'insertProjectSignatureChecklist')
}

export async function replaceProjectCommissionRules(projectId, rules = []) {
  const id = String(projectId || '').trim()
  if (!id) throw new Error('replaceProjectCommissionRules: missing projectId')
  const del = await db().from('project_commission_rules').delete().eq('project_id', id)
  throwIfError(del, 'deleteProjectCommissionRules')
  if (!Array.isArray(rules) || !rules.length) return
  const rows = rules.map((r) => ({
    project_id: id,
    level: Number(r.level) || 1,
    rule_type: r.ruleType === 'percent' || r.rule_type === 'percent' ? 'percent' : 'fixed',
    value: Number(r.value) || 0,
    max_cap_amount:
      r.maxCapAmount != null && r.maxCapAmount !== '' && Number.isFinite(Number(r.maxCapAmount))
        ? Number(r.maxCapAmount)
        : null,
  }))
  const ins = await db().from('project_commission_rules').insert(rows)
  throwIfError(ins, 'insertProjectCommissionRules')
}

export async function fetchProjectsScopedByIds(projectIds = []) {
  const ids = Array.isArray(projectIds) ? [...new Set(projectIds.filter(Boolean))] : []
  if (!ids.length) return []

  const [projRes, parcelRes] = await Promise.all([
    db().from('projects').select('*').in('id', ids),
    db().from('parcels').select('*').in('project_id', ids),
  ])
  const projects = throwIfError(projRes, 'scopedProjects')
  const parcels = throwIfError(parcelRes, 'scopedParcels')

  const parcelIds = parcels.map((p) => p.id).filter(Boolean)
  const batchRes = parcelIds.length
    ? await db().from('parcel_tree_batches').select('*').in('parcel_id', parcelIds)
    : { data: [], error: null }
  const batches = throwIfError(batchRes, 'scopedBatches')

  return projects.map(p => ({
    id: p.id,
    title: p.title,
    city: p.city,
    region: p.region || '',
    area: p.area || '',
    year: p.year_started || '',
    description: p.description || '',
    mapUrl: p.map_url || '',
    arabonDefault: Number(p.arabon_default) || 50,
    plots: parcels
      .filter(x => x.project_id === p.id)
      .map(pl => ({
        id: pl.parcel_number,
        dbId: pl.id,
        area: Number(pl.area_m2 || 0),
        trees: Number(pl.tree_count || 0),
        totalPrice: Number(pl.total_price || 0),
        pricePerTree: Number(pl.price_per_tree || 0),
        status: pl.status || 'available',
        mapUrl: pl.map_url || '',
        treeBatches: batches
          .filter(b => b.parcel_id === pl.id)
          .map(b => ({ year: b.batch_year, count: b.tree_count })),
      })),
  }))
}

export async function updateParcelStatus(parcelDbId, status) {
  const res = await db().from('parcels').update({ status }).eq('id', parcelDbId)
  throwIfError(res, 'updateParcelStatus')
}

async function replaceParcelTreeBatches(parcelDbId, batches) {
  const delRes = await db().from('parcel_tree_batches').delete().eq('parcel_id', parcelDbId)
  throwIfError(delRes, 'deleteParcelTreeBatches')
  const list = (batches || []).filter(b => b && (Number(b.count) > 0 || Number(b.year)))
  if (!list.length) return
  const rows = list.map(b => ({
    parcel_id: parcelDbId,
    batch_year: Number(b.year) || new Date().getFullYear(),
    tree_count: Number(b.count) || 0,
  }))
  const insRes = await db().from('parcel_tree_batches').insert(rows)
  throwIfError(insRes, 'insertParcelTreeBatches')
}

/**
 * Crée ou met à jour une parcelle (plot côté UI : id = parcel_number, dbId = id SQL).
 */
export async function upsertParcelForProject(projectId, plot) {
  const trees = Number(plot.trees) || 0
  const totalPrice = Number(plot.totalPrice) || 0
  const pricePerTree = trees > 0
    ? Math.round(totalPrice / trees)
    : (Number(plot.pricePerTree) || 0)
  // Accept both `id` (legacy) and `plotNumber` (current UI) — the UI evolved
  // but the schema column is still `parcel_number`. Either key works.
  const parcelNumber = Number(plot.plotNumber ?? plot.id)
  if (!Number.isFinite(parcelNumber) || parcelNumber <= 0) {
    throw new Error('Numéro de parcelle invalide')
  }
  const row = {
    project_id: projectId,
    parcel_number: parcelNumber,
    area_m2: Number(plot.area) || 0,
    tree_count: trees,
    total_price: totalPrice,
    price_per_tree: pricePerTree,
    status: plot.status || 'available',
    map_url: (plot.mapUrl || '').trim() || null,
  }
  if (plot.dbId) {
    const res = await db().from('parcels').update(row).eq('id', plot.dbId).select().single()
    const data = throwIfError(res, 'updateParcel')
    await replaceParcelTreeBatches(plot.dbId, plot.treeBatches)
    return data
  }
  const res = await db().from('parcels').insert(row).select().single()
  const data = throwIfError(res, 'insertParcel')
  await replaceParcelTreeBatches(data.id, plot.treeBatches)
  return data
}

export async function deleteParcelById(parcelDbId) {
  const res = await db().from('parcels').delete().eq('id', parcelDbId)
  throwIfError(res, 'deleteParcel')
}

export async function upsertProject(project) {
  const row = {
    id: project.id,
    title: project.title || '',
    city: project.city || '',
    region: project.region || '',
    area: project.area || '',
    year_started: Number(project.year || new Date().getFullYear()),
    description: project.description || '',
    map_url: project.mapUrl || '',
    arabon_default: Number(project.arabonDefault) || 50,
  }
  if (project.id) {
    const res = await db().from('projects').upsert(row).select().single()
    return throwIfError(res, 'upsertProject')
  }
  const res = await db().from('projects').insert({ ...row, id: `proj-${Date.now()}` }).select().single()
  return throwIfError(res, 'insertProject')
}

export async function deleteProject(projectId) {
  const res = await db().from('projects').delete().eq('id', projectId)
  throwIfError(res, 'deleteProject')
}

/* ═══════════════════════════════════════════════════════════
   OFFERS
   ═══════════════════════════════════════════════════════════ */

export async function fetchOffers() {
  const res = await db().from('project_offers').select('*')
  const rows = throwIfError(res, 'offers')
  const byProject = {}
  rows.forEach(o => {
    if (!byProject[o.project_id]) byProject[o.project_id] = []
    byProject[o.project_id].push({
      dbId: o.id,
      name: o.name,
      price: Number(o.price || 0),
      downPayment: Number(o.down_payment_pct || 0),
      duration: Number(o.duration_months || 0),
    })
  })
  return byProject
}

export async function upsertOffer(projectId, offer) {
  const row = {
    project_id: projectId,
    name: offer.name,
    price: offer.price || 0,
    down_payment_pct: offer.downPayment || 0,
    duration_months: offer.duration || 0,
  }
  if (offer.dbId) {
    const res = await db().from('project_offers').update(row).eq('id', offer.dbId).select().single()
    return throwIfError(res, 'updateOffer')
  }
  const res = await db().from('project_offers').insert(row).select().single()
  return throwIfError(res, 'insertOffer')
}

export async function deleteOffer(offerDbId) {
  const res = await db().from('project_offers').delete().eq('id', offerDbId)
  throwIfError(res, 'deleteOffer')
}

/* ═══════════════════════════════════════════════════════════
   CLIENTS
   ═══════════════════════════════════════════════════════════ */

function mapClientFromDb(c) {
  return {
    id: c.id,
    code: c.code,
    name: c.full_name,
    email: c.email || '',
    phone: c.phone || '',
    phoneNormalized: c.phone_normalized || '',
    city: c.city || '',
    cin: c.cin || '',
    referralCode: c.referral_code || '',
    ownerAgentId: c.owner_agent_id || '',
    referredByClientId: c.referred_by_client_id || '',
    authUserId: c.auth_user_id || '',
    sellerEnabled: Boolean(c.seller_enabled),
    sellerParcelQuota: Number(c.seller_parcel_quota || 0),
    sellerParcelsSoldCount: Number(c.seller_parcels_sold_count || 0),
    sellerEnabledAt: c.seller_enabled_at || '',
    sellerEnabledBy: c.seller_enabled_by || '',
    accountType: 'client',
    status: c.status || 'active',
    allowedPages: Array.isArray(c.allowed_pages) ? c.allowed_pages : null,
    allowedProjectIds: Array.isArray(c.allowed_project_ids) ? c.allowed_project_ids : null,
    parentSellerClientId: null,
    ownedParcelKeys: [],
    suspendedAt: c.suspended_at || null,
    suspendedBy: c.suspended_by || null,
    suspendedReason: c.suspension_reason || null,
    createdAt: c.created_at,
  }
}

export async function fetchClients() {
  const res = await db().from('clients').select('*').order('created_at', { ascending: false })
  return throwIfError(res, 'clients').map(mapClientFromDb)
}

/**
 * Direct DB lookup of a client by phone number. Used by SellPage so the
 * "Aucun client avec ce téléphone" message is NEVER based on a partial local
 * array — we always consult the database (phone_normalized then, as fallback,
 * client_phone_identities.phone_canonical → clients.id).
 *
 * Returns a mapped client object, or null when no match is found.
 */
export async function fetchClientByPhone(rawPhone) {
  const input = String(rawPhone || '').trim()
  if (!input) return null
  const e164 = normalizePhoneE164(input)
  const legacy = normalizePhone(input)
  const canonical = normalizePhoneCanonical(input)
  const candidates = [...new Set([e164, legacy, canonical, input.replace(/\D/g, '')].filter(Boolean))]
  if (!candidates.length) return null

  const byNorm = await db()
    .from('clients')
    .select('*')
    .in('phone_normalized', candidates)
    .limit(1)
    .maybeSingle()
  if (byNorm.error && byNorm.error.code !== 'PGRST116') {
    console.warn('[fetchClientByPhone] phone_normalized:', byNorm.error.message)
  }
  if (byNorm.data) return mapClientFromDb(byNorm.data)

  if (canonical) {
    const identRes = await db()
      .from('client_phone_identities')
      .select('client_id')
      .eq('phone_canonical', canonical)
      .not('client_id', 'is', null)
      .limit(1)
      .maybeSingle()
    if (identRes.data?.client_id) {
      const res = await db().from('clients').select('*').eq('id', identRes.data.client_id).maybeSingle()
      if (res.data) return mapClientFromDb(res.data)
    }
  }
  return null
}

export async function upsertClient(client) {
  const phoneCanonical = normalizePhoneCanonical(client.phone, {
    countryCode: client.phoneCountryCode,
    phoneLocal: client.phoneLocal,
  })
  const legacyPhoneNorm = normalizePhone(client.phone || client.phoneLocal || '')
  const phoneNorm =
    client.phoneNormalized != null && String(client.phoneNormalized).trim() !== ''
      ? String(client.phoneNormalized).trim()
      : phoneCanonical || legacyPhoneNorm || null
  const row = {
    code: client.code || `CLI-${Date.now()}`,
    full_name: client.name || '',
    email: client.email || null,
    phone: client.phone || '',
    phone_normalized: phoneNorm,
    city: client.city || '',
    cin: client.cin || '',
    referral_code: client.referralCode || null,
    owner_agent_id: client.ownerAgentId || null,
    referred_by_client_id: client.referredByClientId || null,
    auth_user_id: client.authUserId || null,
    seller_enabled: Boolean(client.sellerEnabled),
    seller_parcel_quota: Number(client.sellerParcelQuota || 0),
    seller_parcels_sold_count: Number(client.sellerParcelsSoldCount || 0),
    seller_enabled_at: client.sellerEnabledAt || null,
    seller_enabled_by: client.sellerEnabledBy || null,
    status: client.status || 'active',
    suspended_at: client.suspendedAt != null ? client.suspendedAt : null,
    suspended_by: client.suspendedBy != null ? client.suspendedBy : null,
    suspension_reason: client.suspensionReason != null ? client.suspensionReason : null,
    allowed_pages: client.allowedPages != null ? client.allowedPages : null,
    allowed_project_ids: client.allowedProjectIds != null ? client.allowedProjectIds : null,
  }
  if (!client.id) {
    // Prefer updating an existing row (auth/email/phone) to avoid unique-key crashes
    // during registration retries and partial profile creation.
    if (row.auth_user_id) {
      const byAuth = await db().from('clients').select('id, code').eq('auth_user_id', row.auth_user_id).limit(1).maybeSingle()
      if (byAuth.data?.id) {
        const res = await db().from('clients').update({ ...row, code: byAuth.data.code || row.code }).eq('id', byAuth.data.id).select().single()
        return mapClientFromDb(throwIfError(res, 'updateClientByAuthUser'))
      }
    }
    if (row.email) {
      const byEmail = await db().from('clients').select('id, code, auth_user_id').ilike('email', row.email).limit(1).maybeSingle()
      if (byEmail.data?.id) {
        if (byEmail.data.auth_user_id && row.auth_user_id && String(byEmail.data.auth_user_id) !== String(row.auth_user_id)) {
          const err = new Error('phone_or_email_already_linked_to_another_user')
          err.code = 'PHONE_LINK_CONFLICT'
          throw err
        }
        const res = await db().from('clients').update({ ...row, code: byEmail.data.code || row.code }).eq('id', byEmail.data.id).select().single()
        return mapClientFromDb(throwIfError(res, 'updateClientByEmail'))
      }
    }
    if (row.phone_normalized) {
      const phoneCandidates = [...new Set([row.phone_normalized, legacyPhoneNorm, normalizePhone(client.phone || '')].filter(Boolean))]
      const byPhone = await db()
        .from('clients')
        .select('id, code, auth_user_id')
        .in('phone_normalized', phoneCandidates)
        .limit(1)
        .maybeSingle()
      if (byPhone.data?.id) {
        if (byPhone.data.auth_user_id && row.auth_user_id && String(byPhone.data.auth_user_id) !== String(row.auth_user_id)) {
          const err = new Error('phone_already_linked_to_another_user')
          err.code = 'PHONE_LINK_CONFLICT'
          throw err
        }
        const res = await db().from('clients').update({ ...row, code: byPhone.data.code || row.code }).eq('id', byPhone.data.id).select().single()
        return mapClientFromDb(throwIfError(res, 'updateClientByPhone'))
      }
    }
  }
  if (client.id) {
    const res = await db().from('clients').update(row).eq('id', client.id).select().single()
    return mapClientFromDb(throwIfError(res, 'updateClient'))
  }
  const res = await db().from('clients').insert(row).select().single()
  if (res.error && String(res.error.code) === '23505') {
    // Race: another session inserted the row between our SELECT and INSERT.
    // Re-lookup by the same identity keys and UPDATE instead of crashing the
    // registration flow with "duplicate key ... clients_phone_normalized_key".
    const constraint = String(res.error.details || res.error.message || '')
    const existing = await lookupExistingClientRow({
      authUserId: row.auth_user_id,
      email: row.email,
      phoneNormalized: row.phone_normalized,
    })
    if (existing?.id) {
      if (
        existing.auth_user_id
        && row.auth_user_id
        && String(existing.auth_user_id) !== String(row.auth_user_id)
      ) {
        const err = new Error('phone_or_email_already_linked_to_another_user')
        err.code = 'PHONE_LINK_CONFLICT'
        err.details = constraint
        throw err
      }
      const upd = await db()
        .from('clients')
        .update({ ...row, code: existing.code || row.code })
        .eq('id', existing.id)
        .select()
        .single()
      return mapClientFromDb(throwIfError(upd, 'insertClientRetryUpdate'))
    }
    // Nothing found on retry — re-throw with the original error so it surfaces.
  }
  return mapClientFromDb(throwIfError(res, 'insertClient'))
}

/**
 * Delegated-seller path for the Sell wizard. Calls the security-definer RPC
 * public.create_buyer_stub_for_sale, which lets a client with /admin/sell in
 * clients.allowed_pages OR page_access_grants create a buyer stub without
 * holding the staff_clients_crud policy. Idempotent on phone_normalized /
 * email. Active staff can use it too; they simply skip the grant check.
 */
export async function createBuyerStubForSale({ code, name, email, phone, cin, city }) {
  const res = await db().rpc('create_buyer_stub_for_sale', {
    p_code: code || '',
    p_name: name || '',
    p_email: email || '',
    p_phone: phone || '',
    p_cin: cin || '',
    p_city: city || '',
  })
  if (res.error) {
    const msg = String(res.error.message || '')
    if (/no_sell_grant/i.test(msg)) {
      const e = new Error('no_sell_grant'); e.code = '42501'; throw e
    }
    if (/caller_not_linked_to_client/i.test(msg)) {
      const e = new Error('caller_not_linked_to_client'); e.code = '42501'; throw e
    }
    if (/phone_required/i.test(msg)) {
      const e = new Error('phone_required'); e.code = '22023'; throw e
    }
    throw new Error(`createBuyerStubForSale: ${msg}`)
  }
  if (!res.data) return null
  return mapClientFromDb(res.data)
}

async function invalidateOtherPhoneCanonicalsForIdentity({
  clientId = null,
  authUserId = null,
  canonical = '',
  adminUserId = null,
} = {}) {
  if (!canonical) return
  try {
    const clauses = []
    if (clientId) clauses.push(`client_id.eq.${clientId}`)
    if (authUserId) clauses.push(`auth_user_id.eq.${authUserId}`)
    if (!clauses.length) return
    await db()
      .from('client_phone_identities')
      .update({
        verification_status: 'pending_verification',
        verification_reason: 'phone_changed',
        updated_by: adminUserId || null,
      })
      .or(clauses.join(','))
      .neq('phone_canonical', canonical)
      .neq('verification_status', 'pending_verification')
  } catch (e) {
    console.warn('[upsertClientPhoneIdentity] stale invalidation failed:', e?.message || e)
  }
}

async function lookupExistingClientRow({ authUserId, email, phoneNormalized }) {
  if (authUserId) {
    const r = await db().from('clients').select('id, code, auth_user_id').eq('auth_user_id', authUserId).limit(1).maybeSingle()
    if (r.data?.id) return r.data
  }
  if (email) {
    const r = await db().from('clients').select('id, code, auth_user_id').ilike('email', email).limit(1).maybeSingle()
    if (r.data?.id) return r.data
  }
  if (phoneNormalized) {
    const r = await db().from('clients').select('id, code, auth_user_id').eq('phone_normalized', phoneNormalized).limit(1).maybeSingle()
    if (r.data?.id) return r.data
  }
  return null
}

export async function upsertClientPhoneIdentity({
  countryCode = '',
  phoneLocal = '',
  clientId = null,
  authUserId = null,
  adminUserId = null,
  verificationStatus = 'verified',
  verificationReason = null,
  verificationTicket = null,
} = {}) {
  const cc = normalizeCountryCode(countryCode)
  const local = normalizePhoneLocal(phoneLocal)
  const canonical = normalizePhoneCanonical('', { countryCode: cc, phoneLocal: local })
  if (!cc || !local || !canonical) return { ok: false, reason: 'invalid_phone' }

  const existing = await db()
    .from('client_phone_identities')
    .select('*')
    .eq('phone_canonical', canonical)
    .limit(1)
    .maybeSingle()
  if (existing.error) throw new Error(`phoneIdentityLookup: ${existing.error.message}`)

  if (existing.data) {
    if (existing.data.auth_user_id && authUserId && String(existing.data.auth_user_id) !== String(authUserId)) {
      const res = await db()
        .from('client_phone_identities')
        .update({
          verification_status: 'pending_verification',
          verification_reason: verificationReason || 'phone_conflict_auth_user',
          verification_ticket: verificationTicket || existing.data.verification_ticket,
          updated_by: adminUserId || existing.data.updated_by || null,
        })
        .eq('id', existing.data.id)
        .select('*')
        .single()
      return { ok: false, reason: 'pending_verification', row: throwIfError(res, 'phoneIdentityPendingConflict') }
    }

    const res = await db()
      .from('client_phone_identities')
      .update({
        country_code: cc,
        phone_local: local,
        client_id: clientId || existing.data.client_id || null,
        auth_user_id: authUserId || existing.data.auth_user_id || null,
        admin_user_id: adminUserId || existing.data.admin_user_id || null,
        verification_status: verificationStatus || existing.data.verification_status || 'verified',
        verification_reason: verificationReason != null ? verificationReason : existing.data.verification_reason,
        verification_ticket: verificationTicket != null ? verificationTicket : existing.data.verification_ticket,
        updated_by: adminUserId || existing.data.updated_by || null,
      })
      .eq('id', existing.data.id)
      .select('*')
      .single()
    const updatedRow = throwIfError(res, 'phoneIdentityUpdate')
    await invalidateOtherPhoneCanonicalsForIdentity({
      clientId: updatedRow.client_id,
      authUserId: updatedRow.auth_user_id,
      canonical,
      adminUserId,
    })
    return { ok: true, row: updatedRow }
  }

  const inserted = await db()
    .from('client_phone_identities')
    .insert({
      country_code: cc,
      phone_local: local,
      phone_canonical: canonical,
      client_id: clientId || null,
      auth_user_id: authUserId || null,
      admin_user_id: adminUserId || null,
      verification_status: verificationStatus || 'verified',
      verification_reason: verificationReason || null,
      verification_ticket: verificationTicket || null,
      created_by: adminUserId || null,
      updated_by: adminUserId || null,
    })
    .select('*')
    .single()
  const newRow = throwIfError(inserted, 'phoneIdentityInsert')

  await invalidateOtherPhoneCanonicalsForIdentity({
    clientId,
    authUserId,
    canonical,
    adminUserId,
  })

  return { ok: true, row: newRow }
}

export async function fetchClientPhoneIdentities(limit = 500) {
  const res = await db()
    .from('client_phone_identities')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(limit)
  return throwIfError(res, 'fetchClientPhoneIdentities')
}

export async function reassignSaleClientWithTicket({
  saleId,
  targetClientId,
  ticket,
  reason = '',
} = {}) {
  if (!saleId || !targetClientId) {
    return { ok: false, reason: 'missing_required_fields' }
  }
  const ticketValue = String(ticket || '').trim() || `AUTO-${Date.now()}`
  const beforeRes = await db().from('sales').select('id, client_id').eq('id', saleId).maybeSingle()
  const before = throwIfError(beforeRes, 'saleBeforeReassign')
  if (!before) return { ok: false, reason: 'sale_not_found' }
  const updateRes = await db()
    .from('sales')
    .update({ client_id: targetClientId })
    .eq('id', saleId)
    .select('id, client_id')
    .single()
  const after = throwIfError(updateRes, 'saleClientReassign')
  await appendAuditEntry({
    action: 'sale_client_reassigned',
    entity: 'sale',
    entityId: String(saleId),
    details: `Manual repair ticket ${ticketValue}${reason ? ` | ${reason}` : ''}`,
    metadata: { ticket: ticketValue, reason, beforeClientId: before.client_id || null, afterClientId: after.client_id || null },
  })
  return { ok: true, saleId: String(saleId), fromClientId: before.client_id || null, toClientId: after.client_id || null }
}

export async function relinkAuthToClientWithTicket({
  clientId,
  authUserId,
  countryCode,
  phoneLocal,
  ticket,
  reason = '',
} = {}) {
  if (!clientId || !authUserId) {
    return { ok: false, reason: 'missing_required_fields' }
  }
  const ticketValue = String(ticket || '').trim() || `AUTO-${Date.now()}`
  const clientBeforeRes = await db().from('clients').select('id, auth_user_id, phone').eq('id', clientId).maybeSingle()
  const clientBefore = throwIfError(clientBeforeRes, 'clientBeforeRelink')
  if (!clientBefore) return { ok: false, reason: 'client_not_found' }
  const clientUpdateRes = await db()
    .from('clients')
    .update({ auth_user_id: authUserId })
    .eq('id', clientId)
    .select('id, auth_user_id')
    .single()
  const clientAfter = throwIfError(clientUpdateRes, 'clientRelinkAuth')

  if (countryCode && phoneLocal) {
    await upsertClientPhoneIdentity({
      countryCode,
      phoneLocal,
      clientId,
      authUserId,
      verificationStatus: 'verified',
      verificationReason: null,
      verificationTicket: ticketValue,
    })
  }

  await appendAuditEntry({
    action: 'client_auth_relinked',
    entity: 'client',
    entityId: String(clientId),
    details: `Manual repair ticket ${ticketValue}${reason ? ` | ${reason}` : ''}`,
    metadata: {
      ticket: ticketValue,
      reason,
      beforeAuthUserId: clientBefore.auth_user_id || null,
      afterAuthUserId: clientAfter.auth_user_id || null,
    },
  })
  return {
    ok: true,
    clientId: String(clientId),
    beforeAuthUserId: clientBefore.auth_user_id || null,
    afterAuthUserId: clientAfter.auth_user_id || null,
  }
}

export async function deleteClient(clientId) {
  const res = await db().from('clients').delete().eq('id', clientId)
  throwIfError(res, 'deleteClient')
}

export async function findClientByCin(cin) {
  if (!cin) return null
  const res = await db().from('clients').select('*').eq('cin', cin).limit(1).maybeSingle()
  if (res.error || !res.data) return null
  return mapClientFromDb(res.data)
}

export async function findClientByEmail(email) {
  if (!email) return null
  const res = await db().from('clients').select('*').ilike('email', email).limit(1).maybeSingle()
  if (res.error || !res.data) return null
  return mapClientFromDb(res.data)
}

export async function findClientByPhone(phone) {
  const normalized = normalizePhone(phone)
  if (!normalized) return null
  const res = await db().from('clients').select('*').ilike('phone', `%${normalized}`).limit(1).maybeSingle()
  if (res.error || !res.data) return null
  return mapClientFromDb(res.data)
}

/* ═══════════════════════════════════════════════════════════
   ADMIN USERS
   ═══════════════════════════════════════════════════════════ */

const ADMIN_ROW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function mapAdminFromDb(u) {
  return {
    id: u.id,
    dbId: u.id,
    code: u.code,
    name: u.full_name,
    email: u.email || '',
    phone: u.phone || '',
    role: DB_ROLE_MAP[u.role] || u.role,
    status: u.status || 'active',
    accountType: 'staff',
    managerId: u.manager_id || '',
    avatar: u.avatar_url || null,
    allowedPages: Array.isArray(u.allowed_pages) ? u.allowed_pages : null,
    allowedProjectIds: Array.isArray(u.allowed_project_ids) ? u.allowed_project_ids : null,
    allowedParcelKeys: Array.isArray(u.allowed_parcel_keys) ? u.allowed_parcel_keys : null,
    suspendedAt: u.suspended_at || null,
    suspendedBy: u.suspended_by || null,
    suspensionReason: u.suspension_reason || null,
    createdAt: u.created_at,
  }
}

export async function fetchAdminUsers() {
  const res = await db().from('admin_users').select('*').order('created_at', { ascending: false })
  return throwIfError(res, 'adminUsers').map(mapAdminFromDb)
}

export async function insertAdminUserRow(fields) {
  const res = await db().from('admin_users').insert(fields).select().single()
  return mapAdminFromDb(throwIfError(res, 'insertAdminUserRow'))
}

export async function upsertAdminUser(user) {
  const row = {
    code: user.code || randomEntityCode('ADM'),
    full_name: user.name || '',
    email: user.email || '',
    phone: user.phone || '',
    role: APP_ROLE_MAP[user.role] || user.role || 'VIEWER',
    status: user.status || 'active',
    manager_id: user.managerId || null,
    avatar_url: user.avatar || null,
    allowed_pages: user.allowedPages != null ? user.allowedPages : null,
    allowed_project_ids: user.allowedProjectIds != null ? user.allowedProjectIds : null,
    allowed_parcel_keys: user.allowedParcelKeys != null ? user.allowedParcelKeys : null,
  }
  if (Object.prototype.hasOwnProperty.call(user, 'suspendedAt')) row.suspended_at = user.suspendedAt
  if (Object.prototype.hasOwnProperty.call(user, 'suspendedBy')) row.suspended_by = user.suspendedBy
  if (Object.prototype.hasOwnProperty.call(user, 'suspensionReason')) row.suspension_reason = user.suspensionReason
  const rowId = user.dbId || user.id
  if (rowId && ADMIN_ROW_UUID_RE.test(String(rowId))) {
    const res = await db().from('admin_users').update(row).eq('id', rowId).select().single()
    return mapAdminFromDb(throwIfError(res, 'updateAdmin'))
  }
  const res = await db().from('admin_users').insert(row).select().single()
  return mapAdminFromDb(throwIfError(res, 'insertAdmin'))
}

export async function deleteAdminUser(userId) {
  const res = await db().from('admin_users').delete().eq('id', userId)
  throwIfError(res, 'deleteAdmin')
}

export async function fetchAuthAdminProfile(authEmail) {
  const email = String(authEmail || '').trim().toLowerCase()
  if (!email) return null
  const res = await db().from('admin_users').select('*').ilike('email', email).maybeSingle()
  if (res.error) {
    if (res.error.code !== 'PGRST301' && res.error.code !== '42501') {
      console.error('fetchAuthAdminProfile query error:', res.error.message, '| code:', res.error.code)
    }
    return null
  }
  if (!res.data) return null
  return mapAdminFromDb(res.data)
}

/**
 * Client-side diagnostic for the "Création client refusée / pas staff actif"
 * RLS toast. Returns a structured snapshot of what the current session looks
 * like from the app's point of view so the user (and support) can pinpoint
 * the exact mismatch without opening the Supabase dashboard.
 *
 * The shape is UI-friendly and intentionally non-sensitive (no tokens, no
 * session id) so we can surface it in a toast / inline panel.
 */
export async function diagnoseStaffAccess() {
  const out = {
    authEmail: '',
    authUserId: '',
    adminRow: null,
    adminActive: false,
    adminEmailMatches: false,
    clientRowId: '',
    clientAllowedPages: [],
    clientGrantKeys: [],
    effectiveAllowedPages: [],
    verdict: 'unknown',
  }
  try {
    const { data: authData } = await db().auth.getUser()
    out.authEmail = String(authData?.user?.email || '').trim().toLowerCase()
    out.authUserId = String(authData?.user?.id || '')
  } catch { /* ignore */ }

  if (out.authEmail) {
    try {
      const res = await db().from('admin_users').select('id, email, status, role').ilike('email', out.authEmail).maybeSingle()
      if (!res.error && res.data) {
        out.adminRow = { id: res.data.id, email: res.data.email, status: res.data.status, role: res.data.role }
        out.adminActive = res.data.status === 'active'
        out.adminEmailMatches = String(res.data.email || '').trim().toLowerCase() === out.authEmail
      }
    } catch { /* ignore */ }
  }

  if (out.authUserId) {
    try {
      const res = await db().from('clients').select('id, allowed_pages').eq('auth_user_id', out.authUserId).order('created_at', { ascending: true }).limit(1).maybeSingle()
      if (!res.error && res.data) {
        out.clientRowId = res.data.id
        out.clientAllowedPages = Array.isArray(res.data.allowed_pages)
          ? res.data.allowed_pages.map((p) => normalizeAdminPagePath(p)).filter(Boolean)
          : []
      }
    } catch { /* ignore */ }
  }

  // Mirror fetchAuthClientProfile: the effective allowedPages is the union of
  // the clients.allowed_pages column AND active page_access_grants for the
  // same clients row. Without this, a delegated seller whose Sell access lives
  // purely in page_access_grants is mis-classified as client_no_grants and the
  // toast tells them to ask for an admin_users email — wrong action.
  if (out.clientRowId) {
    try {
      const keys = await fetchActivePageGrantKeysForClient(out.clientRowId)
      out.clientGrantKeys = Array.isArray(keys) ? keys : []
    } catch { /* ignore */ }
  }
  out.effectiveAllowedPages = [...new Set([...(out.clientAllowedPages || []), ...(out.clientGrantKeys || [])])]

  if (!out.authEmail) out.verdict = 'no_auth_email'
  else if (out.adminRow && out.adminActive) out.verdict = 'staff_ok'
  else if (out.adminRow && !out.adminActive) out.verdict = 'staff_inactive'
  else if (!out.adminRow && out.clientRowId && out.effectiveAllowedPages.length) out.verdict = 'delegated_client'
  else if (!out.adminRow && out.clientRowId) out.verdict = 'client_no_grants'
  else out.verdict = 'unknown_session'
  return out
}

function mapPageAccessGrantFromDb(r) {
  return {
    id: r.id,
    clientId: r.client_id,
    pageKey: r.page_key,
    sourceSaleId: r.source_sale_id,
    sourceChecklistKey: r.source_checklist_key,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
  }
}

/** Active `page_key` values from signature (or other) grants — merged into client session `allowedPages`. */
export async function fetchActivePageGrantKeysForClient(clientId) {
  const id = String(clientId || '').trim()
  if (!id) return []
  const res = await db().from('page_access_grants').select('page_key').eq('client_id', id).is('revoked_at', null)
  const rows = throwIfError(res, 'activePageGrantsForClient')
  return [...new Set((rows || []).map((r) => normalizeAdminPagePath(r.page_key)).filter(Boolean))]
}

const CHECKLIST_WF_TO_DOCKEY = {
  contract: 'contract',
  cahier: 'cahier',
  seller_contract: 'sellerContract',
}

/**
 * Ensures page_access_grants exist for completed notary sales on this client (checklist snapshot).
 * Idempotent: skips when an active grant for the same page already exists.
 * Fixes cases where grants were written on a stub client before the buyer account was linked.
 */
export async function replayPageGrantsFromCompletedSales(clientId) {
  const id = String(clientId || '').trim()
  if (!id) return

  const salesRes = await db()
    .from('sales')
    .select('id, checklist_snapshot, notary_checklist_signed, status, notary_completed_at')
    .eq('client_id', id)
    .eq('status', 'completed')
    .not('notary_completed_at', 'is', null)

  const sales = throwIfError(salesRes, 'replayGrantsSales')
  for (const row of sales || []) {
    const snap = row.checklist_snapshot || {}
    const items = Array.isArray(snap.items) ? snap.items : []
    const signedPayload =
      row.notary_checklist_signed && typeof row.notary_checklist_signed === 'object' ? row.notary_checklist_signed : {}
    const wfKeys = signedPayload.wfKeys && typeof signedPayload.wfKeys === 'object' ? signedPayload.wfKeys : {}
    const docKeys = signedPayload.docKeys && typeof signedPayload.docKeys === 'object' ? signedPayload.docKeys : {}
    const hasSignedTrace = Object.keys(wfKeys).length > 0 || Object.keys(docKeys).length > 0

    for (const item of items) {
      const wfKey = item.key || item.item_key
      const dk = CHECKLIST_WF_TO_DOCKEY[wfKey] || wfKey
      const signed =
        wfKeys[wfKey] === true || docKeys[dk] === true || docKeys[wfKey] === true
      const legacyCompleted = !hasSignedTrace

      if (!signed && !legacyCompleted) continue

      const pagesRaw = item.grant_allowed_pages ?? item.grantAllowedPages
      if (!Array.isArray(pagesRaw) || !pagesRaw.length) continue

      for (const pk of pagesRaw) {
        const pageKey = normalizeAdminPagePath(pk)
        if (!pageKey) continue
        const existing = await db()
          .from('page_access_grants')
          .select('id')
          .eq('client_id', id)
          .eq('page_key', pageKey)
          .is('revoked_at', null)
          .maybeSingle()
        if (existing.error) continue
        if (existing.data?.id) continue

        await grantPageAccessLive({
          clientId: id,
          pageKey,
          sourceSaleId: row.id,
          sourceChecklistKey: wfKey || null,
          actorUserId: null,
          actorEmail: 'replay_completed_sale',
        })
      }
    }
  }
}

export async function fetchClientIdByAuthUserId(authUserId) {
  const uid = String(authUserId || '').trim()
  if (!uid) return null
  const res = await db().from('clients').select('id').eq('auth_user_id', uid).maybeSingle()
  if (res.error) return null
  return res.data?.id || null
}

export async function fetchActivePageAccessGrants() {
  const res = await db()
    .from('page_access_grants')
    .select('*')
    .is('revoked_at', null)
    .order('granted_at', { ascending: false })
  return throwIfError(res, 'pageAccessGrantsActive').map(mapPageAccessGrantFromDb)
}

/** Active + revoked rows for admin audit (signature grants, revocations). */
export async function fetchPageAccessGrantsAudit(limit = 500) {
  const n = Math.min(Math.max(Number(limit) || 500, 1), 5000)
  const res = await db()
    .from('page_access_grants')
    .select('*')
    .order('granted_at', { ascending: false })
    .limit(n)
  return throwIfError(res, 'pageAccessGrantsAudit').map(mapPageAccessGrantFromDb)
}

/**
 * Insert an active page grant (revokes any previous active row for same client + page first).
 * Checklist / notaire flow and optional manual tooling.
 */
export async function grantPageAccessLive({
  clientId,
  pageKey,
  sourceSaleId = null,
  sourceChecklistKey = null,
  actorUserId = null,
  actorEmail = '',
}) {
  const cid = String(clientId || '').trim()
  const pk = normalizeAdminPagePath(pageKey)
  if (!cid || !pk) return null

  const now = new Date().toISOString()
  const revokeRes = await db()
    .from('page_access_grants')
    .update({ revoked_at: now, revoked_by: actorUserId || null })
    .eq('client_id', cid)
    .eq('page_key', pk)
    .is('revoked_at', null)
  throwIfError(revokeRes, 'revokePreviousPageGrant')

  const ins = await db()
    .from('page_access_grants')
    .insert({
      client_id: cid,
      page_key: pk,
      source_sale_id: sourceSaleId || null,
      source_checklist_key: sourceChecklistKey || null,
    })
    .select()
    .single()
  const row = mapPageAccessGrantFromDb(throwIfError(ins, 'insertPageAccessGrant'))

  await appendAuditEntry({
    action: 'page_access_granted',
    entity: 'client',
    entityId: cid,
    subjectUserId: cid,
    actorUserId: actorUserId || null,
    actorEmail: actorEmail || '',
    details: `Grant ${pk}`,
    metadata: { pageKey: pk, sourceSaleId, sourceChecklistKey },
  })

  return row
}

export async function revokePageAccessGrant(grantId, revokedByUserId = null) {
  const id = String(grantId || '').trim()
  if (!id) return { ok: false, reason: 'missing_id' }
  const grantRes = await db().from('page_access_grants').select('client_id, page_key, revoked_at').eq('id', id).maybeSingle()
  if (grantRes.error || !grantRes.data || grantRes.data.revoked_at) return { ok: false, reason: 'not_found' }
  const now = new Date().toISOString()
  const upd = await db()
    .from('page_access_grants')
    .update({ revoked_at: now, revoked_by: revokedByUserId || null })
    .eq('id', id)
    .is('revoked_at', null)
  throwIfError(upd, 'revokePageAccessGrant')
  await appendAuditEntry({
    action: 'page_access_revoked',
    entity: 'access_grant',
    entityId: id,
    subjectUserId: grantRes.data.client_id || null,
    actorUserId: revokedByUserId || null,
    details: grantRes.data.page_key || '',
    metadata: { pageKey: grantRes.data.page_key },
  })
  return { ok: true }
}

export async function fetchAuthClientProfile(authUserId) {
  if (!authUserId) return null
  const res = await db().from('clients').select('*').eq('auth_user_id', authUserId).maybeSingle()
  if (res.error) {
    console.error('fetchAuthClientProfile query error:', res.error.message, '| code:', res.error.code, '| authUserId:', authUserId)
    return { __profileError: true, message: res.error.message, code: res.error.code }
  }
  if (!res.data) return null
  try {
    await replayPageGrantsFromCompletedSales(res.data.id)
  } catch (e) {
    console.warn('replayPageGrantsFromCompletedSales:', e?.message || e)
  }
  try {
    // Best-effort self-heal so buyers never land on “Plan en cours…” when the
    // notary branch silently dropped plan creation. RLS will block the INSERT
    // for buyer sessions; the helper tags those as `permission_denied` and
    // returns cleanly. Effective for staff sessions (admin login).
    await replayInstallmentPlansFromCompletedSales(res.data.id)
  } catch (e) {
    console.warn('replayInstallmentPlansFromCompletedSales:', e?.message || e)
  }
  const c = mapClientFromDb(res.data)
  const grantKeys = await fetchActivePageGrantKeysForClient(c.id)
  const base = Array.isArray(c.allowedPages)
    ? c.allowedPages.map((p) => normalizeAdminPagePath(p)).filter(Boolean)
    : []
  c.allowedPages = [...new Set([...base, ...grantKeys])]
  return c
}

/**
 * Calls the `ensure_current_client_profile` RPC (returns jsonb).
 *
 * Result shape: `{ ok, reason, clientId, ambiguous, phoneConflict, migrated }`.
 * `reason` is null on success; otherwise one of:
 *   - `not_authenticated`  — no JWT / no auth.uid()
 *   - `ambiguous_client_profile` — multiple clients rows for this auth user
 *   - `phone_conflict`     — canonical phone points at another auth user
 *
 * Legacy callers expecting a raw uuid can still read `.clientId`.
 */
export async function ensureCurrentClientProfile() {
  const { data, error } = await db().rpc('ensure_current_client_profile')
  if (error) {
    const err = new Error(`ensureCurrentClientProfile: ${error.message}`)
    if (error.code) err.code = error.code
    throw err
  }
  if (data && typeof data === 'object') {
    return {
      ok: data.ok !== false,
      reason: data.reason || null,
      clientId: data.clientId || null,
      ambiguous: Boolean(data.ambiguous),
      phoneConflict: Boolean(data.phoneConflict),
      migrated: data.migrated || { sales: 0, plans: 0, grants: 0, commissions: 0, wallets: 0 },
    }
  }
  // Back-compat: older DB still returning a uuid scalar.
  return { ok: Boolean(data), reason: null, clientId: data || null, ambiguous: false, phoneConflict: false, migrated: {} }
}

/* ═══════════════════════════════════════════════════════════
   SELLER RELATIONS + COMMISSIONS
   ═══════════════════════════════════════════════════════════ */

function mapSellerRelationFromDb(r) {
  return {
    id: r.id,
    childClientId: r.child_client_id,
    parentClientId: r.parent_client_id,
    sourceSaleId: r.source_sale_id,
    linkedAt: r.linked_at,
  }
}

export async function fetchSellerRelations() {
  const res = await db().from('seller_relations').select('*')
  return throwIfError(res, 'sellerRelations').map(mapSellerRelationFromDb)
}

/** One parent per child (unique child_client_id). Cycle-safe link for commission uplines. */
export async function upsertSellerRelation({ childClientId, parentClientId, sourceSaleId = null }) {
  const child = String(childClientId || '').trim()
  const parent = String(parentClientId || '').trim()
  if (!child || !parent || child === parent) return { ok: false, reason: 'invalid' }

  const allRes = await db().from('seller_relations').select('child_client_id, parent_client_id')
  const all = throwIfError(allRes, 'sellerRelationsGraph')
  const relByChild = new Map(all.map((row) => [String(row.child_client_id), String(row.parent_client_id)]))

  if (all.some((row) => String(row.child_client_id) === child)) {
    return { ok: false, reason: 'already_linked' }
  }

  let cur = parent
  const seen = new Set([child])
  for (let i = 0; i < 60; i += 1) {
    if (seen.has(cur)) return { ok: false, reason: 'cycle' }
    seen.add(cur)
    const next = relByChild.get(cur)
    if (!next) break
    cur = next
  }

  const ins = await db().from('seller_relations').insert({
    child_client_id: child,
    parent_client_id: parent,
    source_sale_id: sourceSaleId || null,
  })
  throwIfError(ins, 'insertSellerRelation')
  return { ok: true }
}

function roundCommission2(n) {
  return Math.round(Number(n) * 100) / 100
}

/**
 * @param {object} sale App-shaped sale (mapSaleFromDb)
 * @param {object[]} relations DB rows: { child_client_id, parent_client_id }
 * @param {object[]} rules Project / snapshot rules (level, ruleType, value, maxCapAmount)
 */
export function computeCommissionEventPayloads(sale, relations, rules) {
  if (!sale || !Array.isArray(rules) || !rules.length) return []
  const amountBase = Number(sale.agreedPrice || 0)
  const relByChild = new Map()
  for (const r of relations || []) {
    relByChild.set(String(r.child_client_id), String(r.parent_client_id))
  }

  // A real seller is required to credit L1. If the seller is missing or is the
  // buyer themselves, skip L1 entirely — never credit the buyer for their own
  // sale. The upline walk then starts at the buyer's parent (if any), so only
  // legitimate parrainage earns commissions.
  const buyerId = String(sale.clientId || '')
  const sellerId = String(sale.sellerClientId || '')
  const hasRealSeller = Boolean(sellerId) && sellerId !== buyerId

  const walkStart = hasRealSeller ? sellerId : buyerId
  const chain = []
  const seen = new Set()
  let steps = 0
  let walkId = walkStart
  while (walkId && steps < 40) {
    const key = String(walkId)
    if (seen.has(key)) break // cycle-safe
    seen.add(key)
    chain.push(key)
    const parentId = relByChild.get(key)
    if (!parentId) break
    walkId = parentId
    steps += 1
  }

  // When no real seller exists we drop the first link of the chain (the buyer)
  // so upline parrainage kicks in at L1 instead of paying the buyer.
  const directSeller = hasRealSeller ? sellerId : ''
  const upline = hasRealSeller
    ? chain.filter((cid) => cid !== directSeller)
    : chain.filter((cid) => cid !== buyerId)
  const ordered = directSeller ? [directSeller, ...upline] : [...upline]
  const maxLevel = rules.reduce((m, r) => Math.max(m, Number(r.level) || 0), 0)

  const events = []
  ordered.forEach((beneficiaryId, idx) => {
    const level = idx + 1
    if (maxLevel > 0 && level > maxLevel) return // cap chain depth to configured rule count
    const rule = rules.find((rr) => Number(rr.level) === level) || rules[idx]
    if (!rule || !beneficiaryId) return
    let amt = 0
    const rt = rule.ruleType || rule.rule_type
    if (rt === 'percent') amt = roundCommission2((amountBase * Number(rule.value || 0)) / 100)
    else amt = roundCommission2(Number(rule.value || 0))
    const cap = rule.maxCapAmount != null ? Number(rule.maxCapAmount) : null
    if (cap != null && Number.isFinite(cap)) amt = Math.min(amt, cap)
    if (amt > 0) {
      // Diagnostic metadata merged into rule_snapshot so the existing
      // commission_events column can carry it without a schema change.
      const ruleSnapshot = {
        ...rule,
        meta: {
          saleId: sale.id || null,
          saleProjectId: sale.projectId || null,
          buyerClientId: buyerId || null,
          level,
          beneficiaryClientId: beneficiaryId,
          directSeller: directSeller || null,
          // fallbackFromBuyerUpline is true when no real seller was present and
          // we walked the buyer's parrainage chain starting at the buyer's
          // parent. Useful for support when the L1 line is missing but L2+ are
          // present.
          fallbackFromBuyerUpline: !hasRealSeller,
          chainPath: ordered.slice(0, idx + 1),
          computedAmount: amt,
          amountBase,
          computedAt: new Date().toISOString(),
        },
      }
      events.push({
        beneficiaryClientId: beneficiaryId,
        level,
        ruleSnapshot,
        amount: amt,
      })
    }
  })
  return events
}

function mapCommissionEventFromDb(r) {
  return {
    id: r.id,
    saleId: r.sale_id,
    beneficiaryClientId: r.beneficiary_client_id,
    level: r.level,
    ruleSnapshot: r.rule_snapshot,
    amount: Number(r.amount || 0),
    status: r.status,
    payableAt: r.payable_at,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  }
}

function mapPayoutRequestFromDb(row, eventIds = []) {
  return {
    id: row.id,
    code: row.code,
    beneficiaryClientId: row.beneficiary_client_id,
    grossAmount: Number(row.gross_amount || 0),
    status: row.status,
    eventIds: [...eventIds],
    createdAt: row.created_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewReason: row.review_reason,
    paidAt: row.paid_at,
    paidBy: row.paid_by,
    paymentRef: row.payment_ref,
  }
}

export async function fetchCommissionEvents(limit = 8000) {
  const n = Math.min(Math.max(Number(limit) || 8000, 1), 20000)
  const res = await db().from('commission_events').select('*').order('created_at', { ascending: false }).limit(n)
  return throwIfError(res, 'commissionEvents').map(mapCommissionEventFromDb)
}

export async function fetchCommissionPayoutRequestsWithItems() {
  const res = await db().from('commission_payout_requests').select('*').order('created_at', { ascending: false })
  const requests = throwIfError(res, 'commissionPayoutRequests')
  if (!requests.length) return []
  const ids = requests.map((r) => r.id)
  const itemsRes = await db().from('commission_payout_request_items').select('*').in('request_id', ids)
  const items = throwIfError(itemsRes, 'commissionPayoutItems')
  const byReq = new Map()
  for (const it of items) {
    if (!byReq.has(it.request_id)) byReq.set(it.request_id, [])
    byReq.get(it.request_id).push(it.commission_event_id)
  }
  return requests.map((r) => mapPayoutRequestFromDb(r, byReq.get(r.id) || []))
}

// Payout threshold for a multi-project wallet: use the LOWEST project threshold
// among the projects the beneficiary has events in. The previous MAX policy
// silently stalled cross-project wallets when one project had a higher floor,
// without telling the user why. MIN matches the user mental model ("I have
// enough to withdraw in at least one project") and makes the number that
// appears in the UI actionable.
async function maxMinPayoutThresholdForSaleIds(saleIds = []) {
  const unique = [...new Set(saleIds.filter(Boolean).map(String))]
  if (!unique.length) return 0
  const salesRes = await db().from('sales').select('id, project_id').in('id', unique)
  const sales = throwIfError(salesRes, 'salesForPayoutThresh')
  const pids = [...new Set(sales.map((x) => x.project_id).filter(Boolean))]
  if (!pids.length) return 0
  const setRes = await db()
    .from('project_workflow_settings')
    .select('project_id, minimum_payout_threshold')
    .in('project_id', pids)
  const rows = throwIfError(setRes, 'workflowMinPayout')
  const positive = rows
    .map((r) => Number(r.minimum_payout_threshold || 0))
    .filter((v) => Number.isFinite(v) && v > 0)
  if (!positive.length) return 0
  return Math.min(...positive)
}

/**
 * Create commission events for a completed sale.
 *
 * Default behaviour is idempotent: if any event already exists for the sale we
 * return the existing rows untouched. Pass `{ force: true }` to regenerate
 * after a bad initial attribution — this is only allowed when no event has
 * been paid yet (status <> 'paid' and not locked in an approved payout
 * request). All deletions and re-insertions are audited.
 */
export async function insertCommissionEventsForCompletedSale(
  sale,
  actorUserId = null,
  actorEmail = '',
  { force = false, reason = '' } = {},
) {
  if (!sale?.id) return []
  const existingRes = await db()
    .from('commission_events')
    .select('id, status')
    .eq('sale_id', sale.id)
  if (existingRes.error) throw new Error('commissionDupCheck: ' + existingRes.error.message)
  const existing = existingRes.data || []
  if (existing.length) {
    if (!force) return []
    const hasPaid = existing.some((e) => String(e.status) === 'paid')
    if (hasPaid) {
      const err = new Error('Commissions already paid — regeneration refused.')
      err.code = 'COMMISSION_REGEN_LOCKED'
      throw err
    }
    const existingIds = existing.map((e) => e.id)
    const lockedRes = await db()
      .from('commission_payout_request_items')
      .select('commission_event_id, request_id, commission_payout_requests!inner(status)')
      .in('commission_event_id', existingIds)
    if (lockedRes.error) throw new Error('commissionLockCheck: ' + lockedRes.error.message)
    const locked = (lockedRes.data || []).some((row) => {
      const st = row.commission_payout_requests?.status
      return st === 'approved' || st === 'paid'
    })
    if (locked) {
      const err = new Error('Commissions attached to an approved payout request — regeneration refused.')
      err.code = 'COMMISSION_REGEN_LOCKED'
      throw err
    }
    const del = await db().from('commission_events').delete().in('id', existingIds)
    if (del.error) throw new Error('commissionRegenDelete: ' + del.error.message)
    await appendAuditEntry({
      action: 'commission_events_regenerated',
      entity: 'sale',
      entityId: String(sale.id),
      actorUserId: actorUserId || null,
      actorEmail: actorEmail || '',
      details: `Regenerated ${existingIds.length} commission line(s). Reason: ${String(reason || '(none)')}`,
      metadata: { removedIds: existingIds, reason: String(reason || '') },
    })
  }

  const relRes = await db().from('seller_relations').select('child_client_id, parent_client_id')
  const relations = throwIfError(relRes, 'sellerRelationsCommission')

  let rules = sale.commissionRuleSnapshot?.levels
  if (!Array.isArray(rules) || !rules.length) {
    const wf = await fetchProjectWorkflowConfig(String(sale.projectId || ''))
    rules = wf.commissionRules || []
  }

  const payloads = computeCommissionEventPayloads(sale, relations, rules)
  if (!payloads.length) return []

  const payableAt = sale.notaryCompletedAt || new Date().toISOString()
  const rows = payloads.map((row) => ({
    sale_id: sale.id,
    beneficiary_client_id: row.beneficiaryClientId,
    level: row.level,
    rule_snapshot: row.ruleSnapshot,
    amount: row.amount,
    status: 'payable',
    payable_at: payableAt,
  }))
  const ins = await db().from('commission_events').insert(rows).select()
  const data = throwIfError(ins, 'insertCommissionEvents')

  await appendAuditEntry({
    action: 'commission_events_created',
    entity: 'sale',
    entityId: String(sale.id),
    actorUserId: actorUserId || null,
    actorEmail: actorEmail || '',
    details: data.length + ' commission line(s)',
    metadata: { amounts: data.map((r) => r.amount) },
  })

  return data.map(mapCommissionEventFromDb)
}

/**
 * Returns true when the sale's commission snapshot is locked because notary
 * has completed. Admin-side override UI should use this to hide/disable the
 * override action once the dossier is stamped.
 */
export function isSaleCommissionSnapshotLocked(sale) {
  if (!sale) return true
  const st = String(sale.status || '').toLowerCase()
  const pipe = String(sale.pipelineStatus || sale.pipeline_status || '').toLowerCase()
  const stampedAt = sale.notaryCompletedAt || sale.notary_completed_at || null
  return Boolean(stampedAt) || st === 'completed' || pipe === 'completed'
}

/**
 * Persist an admin override of a sale's commission_rule_snapshot BEFORE notary
 * completion. Enforces:
 *   - the sale is not already notary-stamped (throws OVERRIDE_LOCKED otherwise)
 *   - a non-empty human-readable reason is provided
 * Stores before/after in the snapshot and appends an immutable audit entry.
 *
 * Returns the new snapshot object.
 */
export async function overrideSaleCommissionSnapshot(
  saleId,
  newLevels,
  { reason, actorUserId = null, actorEmail = '' } = {},
) {
  if (!saleId) throw new Error('overrideSaleCommissionSnapshot: missing sale id')
  if (!Array.isArray(newLevels) || !newLevels.length) {
    throw new Error('overrideSaleCommissionSnapshot: newLevels must be a non-empty array')
  }
  const reasonTrim = String(reason || '').trim()
  if (!reasonTrim) {
    const err = new Error('Motif obligatoire pour un override de commission.')
    err.code = 'OVERRIDE_REASON_REQUIRED'
    throw err
  }

  const saleRes = await db().from('sales').select('*').eq('id', saleId).maybeSingle()
  if (saleRes.error) throw new Error(`overrideSaleCommissionSnapshot fetch: ${saleRes.error.message}`)
  if (!saleRes.data) throw new Error('overrideSaleCommissionSnapshot: sale not found')
  const sale = saleRes.data
  const stampedAt = sale.notary_completed_at
  const st = String(sale.status || '').toLowerCase()
  const pipe = String(sale.pipeline_status || '').toLowerCase()
  if (stampedAt || st === 'completed' || pipe === 'completed') {
    const err = new Error('Override refusé : la vente est clôturée chez le notaire. Le snapshot est figé.')
    err.code = 'OVERRIDE_LOCKED'
    throw err
  }

  const before = sale.commission_rule_snapshot && typeof sale.commission_rule_snapshot === 'object'
    ? sale.commission_rule_snapshot
    : {}
  const beforeLevels = Array.isArray(before.levels) ? before.levels : []
  const cleanLevels = newLevels.map((r, i) => ({
    level: Number(r.level) || (i + 1),
    ruleType: r.ruleType === 'percent' || r.rule_type === 'percent' ? 'percent' : 'fixed',
    value: Number(r.value) || 0,
    maxCapAmount:
      r.maxCapAmount != null && r.maxCapAmount !== '' && Number.isFinite(Number(r.maxCapAmount))
        ? Number(r.maxCapAmount)
        : null,
  }))
  const now = new Date().toISOString()
  const prevOverrides = Array.isArray(before.overrideHistory) ? before.overrideHistory : []
  const nextSnapshot = {
    ...before,
    levels: cleanLevels,
    override: {
      reason: reasonTrim,
      actorUserId: actorUserId || null,
      actorEmail: actorEmail || '',
      appliedAt: now,
      beforeLevels,
    },
    overrideHistory: [
      ...prevOverrides,
      { reason: reasonTrim, actorUserId: actorUserId || null, actorEmail: actorEmail || '', appliedAt: now, beforeLevels, afterLevels: cleanLevels },
    ],
  }

  const upd = await db().from('sales').update({ commission_rule_snapshot: nextSnapshot }).eq('id', saleId)
  if (upd.error) throw new Error(`overrideSaleCommissionSnapshot update: ${upd.error.message}`)

  await appendAuditEntry({
    action: 'commission_override_applied',
    entity: 'sale',
    entityId: String(saleId),
    actorUserId: actorUserId || null,
    actorEmail: actorEmail || '',
    details: reasonTrim,
    metadata: {
      before: beforeLevels,
      after: cleanLevels,
      overrideAt: now,
    },
    severity: 'warn',
    category: 'governance',
  })

  return nextSnapshot
}

export async function submitCommissionPayoutRequest(beneficiaryClientId, actorUserId = null) {
  const bid = String(beneficiaryClientId || '').trim()
  if (!bid) return { ok: false, reason: 'invalid' }

  const openRes = await db().from('commission_payout_requests').select('id').in('status', ['pending_review', 'approved'])
  const openRows = throwIfError(openRes, 'openPayoutRequests')
  const openIds = openRows.map((r) => r.id)
  const claimed = new Set()
  if (openIds.length) {
    const itemsRes = await db()
      .from('commission_payout_request_items')
      .select('commission_event_id')
      .in('request_id', openIds)
    const itemRows = throwIfError(itemsRes, 'openPayoutItems')
    for (const it of itemRows) claimed.add(it.commission_event_id)
  }

  const evRes = await db()
    .from('commission_events')
    .select('*')
    .eq('beneficiary_client_id', bid)
    .eq('status', 'payable')
    .is('paid_at', null)
  const allPayable = throwIfError(evRes, 'payableCommissionEvents')
  const payable = allPayable.filter((e) => !claimed.has(e.id))
  if (!payable.length) return { ok: false, reason: 'no_payable' }

  const gross = roundCommission2(payable.reduce((sum, e) => sum + Number(e.amount || 0), 0))
  const minThresh = await maxMinPayoutThresholdForSaleIds(payable.map((e) => e.sale_id))
  if (gross < minThresh) return { ok: false, reason: 'below_threshold', minThresh, gross }

  const code = randomEntityCode('PAYOUT')
  const insReq = await db()
    .from('commission_payout_requests')
    .insert({
      code,
      beneficiary_client_id: bid,
      gross_amount: gross,
      status: 'pending_review',
    })
    .select()
    .single()
  const reqRow = throwIfError(insReq, 'insertPayoutRequest')

  const itemRows = payable.map((e) => ({
    request_id: reqRow.id,
    commission_event_id: e.id,
  }))
  const insItems = await db().from('commission_payout_request_items').insert(itemRows)
  throwIfError(insItems, 'insertPayoutRequestItems')

  await appendAuditEntry({
    action: 'payout_request_created',
    entity: 'payout_request',
    entityId: String(reqRow.id),
    actorUserId: actorUserId || null,
    details: gross + ' TND · ' + payable.length + ' ligne(s)',
    metadata: { beneficiaryClientId: bid, gross },
  })

  return { ok: true, id: reqRow.id }
}

export async function reviewCommissionPayoutRequest(requestId, decision, opts = {}) {
  const id = String(requestId || '').trim()
  const reason = opts.reason || ''
  const reviewerId = opts.reviewerId || null
  const paymentRef = opts.paymentRef || ''
  if (!id) return { ok: false, reason: 'missing_id' }

  const reqRes = await db().from('commission_payout_requests').select('*').eq('id', id).maybeSingle()
  if (reqRes.error || !reqRes.data) return { ok: false, reason: 'not_found' }
  const req = reqRes.data
  const now = new Date().toISOString()

  if (decision === 'rejected') {
    if (req.status !== 'pending_review') return { ok: false, reason: 'bad_status' }
    const upd = await db()
      .from('commission_payout_requests')
      .update({
        status: 'rejected',
        reviewed_at: now,
        reviewed_by: reviewerId,
        review_reason: reason,
      })
      .eq('id', id)
    throwIfError(upd, 'rejectPayoutRequest')
    await appendAuditEntry({
      action: 'payout_request_rejected',
      entity: 'payout_request',
      entityId: id,
      actorUserId: reviewerId,
      details: reason || 'rejected',
    })
    return { ok: true }
  }

  if (decision === 'approved') {
    if (req.status !== 'pending_review') return { ok: false, reason: 'bad_status' }
    const upd = await db()
      .from('commission_payout_requests')
      .update({
        status: 'approved',
        reviewed_at: now,
        reviewed_by: reviewerId,
        review_reason: reason || null,
      })
      .eq('id', id)
    throwIfError(upd, 'approvePayoutRequest')
    await appendAuditEntry({
      action: 'payout_request_approved',
      entity: 'payout_request',
      entityId: id,
      actorUserId: reviewerId,
      details: reason || 'approved',
    })
    return { ok: true }
  }

  if (decision === 'paid') {
    if (req.status !== 'approved') return { ok: false, reason: 'not_approved' }
    const itemsRes = await db().from('commission_payout_request_items').select('commission_event_id').eq('request_id', id)
    const itemRows = throwIfError(itemsRes, 'payoutItemsForPaid')
    const evIds = itemRows.map((x) => x.commission_event_id).filter(Boolean)
    if (evIds.length) {
      const evUpd = await db().from('commission_events').update({ status: 'paid', paid_at: now }).in('id', evIds)
      throwIfError(evUpd, 'markCommissionEventsPaid')
    }
    const reqUpd = await db()
      .from('commission_payout_requests')
      .update({
        status: 'paid',
        paid_at: now,
        paid_by: reviewerId,
        payment_ref: paymentRef || null,
      })
      .eq('id', id)
    throwIfError(reqUpd, 'markPayoutRequestPaid')
    await appendAuditEntry({
      action: 'payout_request_paid',
      entity: 'payout_request',
      entityId: id,
      actorUserId: reviewerId,
      details: paymentRef || 'paid',
    })
    return { ok: true }
  }

  return { ok: false, reason: 'bad_decision' }
}


/* ═══════════════════════════════════════════════════════════
   SALES
   ═══════════════════════════════════════════════════════════ */

/** Supabase may return parcel PK as number or string; parcel_ids in sales can mismatch Map keys. */
function fillParcelNumberMap(parcels = []) {
  const m = new Map()
  for (const p of parcels) {
    const num = p.parcel_number
    m.set(p.id, num)
    const nid = Number(p.id)
    if (Number.isFinite(nid)) m.set(nid, num)
    m.set(String(p.id), num)
  }
  return m
}

function resolveParcelNumber(parcelMap, dbId) {
  if (!parcelMap) return dbId
  if (dbId == null || dbId === '') return dbId
  if (parcelMap.has(dbId)) return parcelMap.get(dbId)
  const n = Number(dbId)
  if (Number.isFinite(n) && parcelMap.has(n)) return parcelMap.get(n)
  const s = String(dbId)
  if (parcelMap.has(s)) return parcelMap.get(s)
  return dbId
}

function mapSaleFromDb(s, parcelMap) {
  const dbIds = Array.isArray(s.parcel_ids) && s.parcel_ids.length > 0
    ? s.parcel_ids
    : (s.parcel_id ? [s.parcel_id] : [])
  const plotIds = parcelMap ? dbIds.map(id => resolveParcelNumber(parcelMap, id)) : dbIds

  return {
    id: s.id,
    code: s.code,
    projectId: s.project_id,
    projectTitle: s.project?.title || '',
    projectCity: s.project?.city || '',
    parcelId: s.parcel_id,
    parcelIds: dbIds,
    plotIds,
    plotId: plotIds[0],
    plotCount: plotIds.length,
    clientId: s.client_id,
    clientName: s.client?.full_name || '',
    clientCin: s.client?.cin || '',
    clientEmail: s.client?.email || '',
    clientPhone: s.client?.phone || '',
    paymentType: s.payment_type,
    offerId: s.offer_id || '',
    agreedPrice: Number(s.agreed_price || 0),
    deposit: Number(s.deposit || 0),
    advancePaid: Number(s.advance_paid ?? 0),
    plotsTotalPrice: Number(s.plots_total_price || 0),
    offerDownPayment: Number(s.offer_down_payment_pct || 0),
    offerDuration: Number(s.offer_duration_months || 0),
    offerName: s.offer_name || '',
    paymentMethod: s.payment_method || '',
    financeConfirmedAt: s.finance_confirmed_at || '',
    ambassadorCin: s.ambassador_cin || '',
    ambassadorClientId: s.ambassador_client_id || '',
    sellerClientId: s.seller_client_id || '',
    legalTermsSignedAt: s.legal_terms_signed_at || '',
    legalSaleContractSignedAt: s.legal_sale_contract_signed_at || '',
    legalSellerChoice: s.legal_seller_choice || 'pending',
    legalSellerSignedAt: s.legal_seller_signed_at || '',
    legalSellerNotes: s.legal_seller_notes || '',
    legalOfferAdvance: Number(s.legal_offer_advance || 0),
    reservationExpiresAt: s.reservation_expires_at || '',
    reservationReleasedAt: s.reservation_released_at || '',
    reservationReleaseReason: s.reservation_release_reason || '',
    notes: s.notes || '',
    status: s.status,
    agentId: s.agent_id || '',
    managerId: s.manager_id || '',
    stampedAt: s.stamped_at || '',
    paidAt: s.paid_at || '',
    pipelineStatus: s.pipeline_status || '',
    postNotaryDestination: s.post_notary_destination || '',
    configSnapshotVersion: s.config_snapshot_version ?? 1,
    pricingSnapshot: s.pricing_snapshot || {},
    feeSnapshot: s.fee_snapshot || {},
    checklistSnapshot: s.checklist_snapshot || {},
    notaryChecklistSigned: s.notary_checklist_signed && typeof s.notary_checklist_signed === 'object' ? s.notary_checklist_signed : {},
    commissionRuleSnapshot: s.commission_rule_snapshot || {},
    offerSnapshot: s.offer_snapshot || {},
    financeValidatedAt: s.finance_validated_at || '',
    financeValidatedBy: s.finance_validated_by || '',
    juridiqueValidatedAt: s.juridique_validated_at || '',
    juridiqueValidatedBy: s.juridique_validated_by || '',
    notaryCompletedAt: s.notary_completed_at || '',
    notaryCompletedBy: s.notary_completed_by || '',
    buyerPhoneNormalized: s.buyer_phone_normalized || '',
    buyerPhoneClaim: s.buyer_phone_normalized || '',
    buyerAuthUserId: s.buyer_auth_user_id || '',
    buyerUserId: s.buyer_auth_user_id || s.client_id,
    sellerContractSigned: Boolean(s.seller_contract_signed),
    reservationStartedAt: s.reservation_started_at || '',
    reservationStatus: s.reservation_status || '',
    coordinationFinanceAt: s.coordination_finance_at || '',
    coordinationJuridiqueAt: s.coordination_juridique_at || '',
    coordinationNotes: s.coordination_notes || '',
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }
}

export async function fetchSales() {
  const salesRes = await db().from('sales').select('*').order('created_at', { ascending: false })
  const sales = throwIfError(salesRes, 'sales')
  if (!sales.length) return []

  const parcelIds = [
    ...new Set(
      sales
        .flatMap((s) =>
          Array.isArray(s.parcel_ids) ? s.parcel_ids : (s.parcel_id ? [s.parcel_id] : []),
        )
        .filter(Boolean),
    ),
  ]
  const projectIds = [...new Set(sales.map((s) => s.project_id).filter(Boolean))]
  const clientIds = [...new Set(sales.map((s) => s.client_id).filter(Boolean))]

  const [parcelsRes, clientsRes, projectsRes] = await Promise.all([
    parcelIds.length ? db().from('parcels').select('id, parcel_number').in('id', parcelIds) : Promise.resolve({ data: [], error: null }),
    clientIds.length ? db().from('clients').select('id, full_name, cin, email, phone').in('id', clientIds) : Promise.resolve({ data: [], error: null }),
    projectIds.length ? db().from('projects').select('id, title, city, region').in('id', projectIds) : Promise.resolve({ data: [], error: null }),
  ])

  const parcels = throwIfError(parcelsRes, 'salesParcels')
  const clients = throwIfError(clientsRes, 'salesClients')
  const projects = throwIfError(projectsRes, 'salesProjects')

  const parcelMap = fillParcelNumberMap(parcels)
  const clientMap = new Map()
  clients.forEach((c) => clientMap.set(c.id, c))
  const projectMap = new Map()
  projects.forEach((p) => projectMap.set(p.id, p))

  return sales.map((s) =>
    mapSaleFromDb(
      {
        ...s,
        client: clientMap.get(s.client_id) || null,
        project: projectMap.get(s.project_id) || null,
      },
      parcelMap,
    ),
  )
}

export async function fetchSalesScoped({ clientId = null } = {}) {
  const clientIds = clientId ? [clientId] : []
  if (!clientIds.length) return []

  const salesRes = await db()
    .from('sales')
    .select('*')
    .in('client_id', clientIds)
    .order('created_at', { ascending: false })
  const sales = throwIfError(salesRes, 'scopedSales')
  if (!sales.length) return []

  const parcelIds = [...new Set(sales.flatMap((s) => (Array.isArray(s.parcel_ids) ? s.parcel_ids : (s.parcel_id ? [s.parcel_id] : []))).filter(Boolean))]
  const projectIds = [...new Set(sales.map((s) => s.project_id).filter(Boolean))]
  const scopedClientIds = [...new Set(sales.map((s) => s.client_id).filter(Boolean))]

  const [parcelsRes, clientsRes, projectsRes] = await Promise.all([
    parcelIds.length ? db().from('parcels').select('id, parcel_number').in('id', parcelIds) : Promise.resolve({ data: [], error: null }),
    scopedClientIds.length ? db().from('clients').select('id, full_name, cin, email, phone').in('id', scopedClientIds) : Promise.resolve({ data: [], error: null }),
    projectIds.length ? db().from('projects').select('id, title, city, region').in('id', projectIds) : Promise.resolve({ data: [], error: null }),
  ])
  const parcels = throwIfError(parcelsRes, 'scopedSalesParcels')
  const clients = throwIfError(clientsRes, 'scopedSalesClientsData')
  const projects = throwIfError(projectsRes, 'scopedSalesProjects')

  const parcelMap = fillParcelNumberMap(parcels)
  const clientMap = new Map()
  clients.forEach(c => clientMap.set(c.id, c))
  const projectMap = new Map()
  projects.forEach(p => projectMap.set(p.id, p))

  return sales.map(s => mapSaleFromDb({
    ...s,
    client: clientMap.get(s.client_id) || null,
    project: projectMap.get(s.project_id) || null,
  }, parcelMap))
}

/** Ventes où ce client est le « compte vendeur » (ambassador_client_id). */
export async function fetchSalesBySellerClientId(clientId = '') {
  const id = String(clientId || '').trim()
  if (!id) return []

  const salesRes = await db()
    .from('sales')
    .select('*')
    .eq('ambassador_client_id', id)
    .order('created_at', { ascending: false })
  const sales = throwIfError(salesRes, 'sellerClientSales')
  if (!sales.length) return []

  const parcelIds = [...new Set(sales.flatMap((s) => (Array.isArray(s.parcel_ids) ? s.parcel_ids : (s.parcel_id ? [s.parcel_id] : []))).filter(Boolean))]
  const projectIds = [...new Set(sales.map((s) => s.project_id).filter(Boolean))]
  const clientIds = [...new Set(sales.map((s) => s.client_id).filter(Boolean))]

  const [parcelsRes, clientsRes, projectsRes] = await Promise.all([
    parcelIds.length ? db().from('parcels').select('id, parcel_number').in('id', parcelIds) : Promise.resolve({ data: [], error: null }),
    clientIds.length ? db().from('clients').select('id, full_name, cin, email, phone').in('id', clientIds) : Promise.resolve({ data: [], error: null }),
    projectIds.length ? db().from('projects').select('id, title, city, region').in('id', projectIds) : Promise.resolve({ data: [], error: null }),
  ])
  const parcels = throwIfError(parcelsRes, 'sellerClientParcels')
  const clients = throwIfError(clientsRes, 'sellerClientClients')
  const projects = throwIfError(projectsRes, 'sellerClientProjects')

  const parcelMap = fillParcelNumberMap(parcels)
  const clientMap = new Map()
  clients.forEach(c => clientMap.set(c.id, c))
  const projectMap = new Map()
  projects.forEach(p => projectMap.set(p.id, p))

  return sales.map(s => mapSaleFromDb({
    ...s,
    client: clientMap.get(s.client_id) || null,
    project: projectMap.get(s.project_id) || null,
  }, parcelMap))
}

function mapSellerAssignmentFromDb(a) {
  return {
    id: a.assignment_id || a.id,
    clientId: a.client_id || '',
    clientName: a.client_name || '',
    projectId: a.project_id || '',
    projectTitle: a.project_title || '',
    parcelId: a.parcel_id,
    parcelNumber: a.parcel_number,
    active: a.active !== false,
    note: a.note || '',
    assignedBy: a.assigned_by || '',
    assignedByName: a.assigned_by_name || '',
    assignedAt: a.assigned_at || '',
    revokedBy: a.revoked_by || '',
    revokedByName: a.revoked_by_name || '',
    revokedAt: a.revoked_at || '',
    revokedReason: a.revoked_reason || '',
  }
}

export async function fetchSellerParcelAssignments(clientId = '') {
  const id = String(clientId || '').trim()
  const { data, error } = await db().rpc('list_seller_assignments', {
    p_client_id: id || null,
  })
  if (error) {
    const msg = String(error.message || '').toLowerCase()
    if (msg.includes('column au1.name does not exist') || msg.includes('column au2.name does not exist')) {
      // Compatibility fallback while SQL function on remote is not yet updated.
      return []
    }
    if (error.code === '42501') return []
    throw new Error(`sellerAssignments: ${error.message}`)
  }
  return Array.isArray(data) ? data.map(mapSellerAssignmentFromDb) : []
}

export async function fetchMySellerParcelAssignments() {
  const { data, error } = await db().rpc('list_my_seller_assignments')
  if (error) throw new Error(`mySellerAssignments: ${error.message}`)
  return Array.isArray(data) ? data.map(mapSellerAssignmentFromDb) : []
}

export async function assignSellerParcel({ clientId, projectId, parcelId, note = '' }) {
  const { data, error } = await db().rpc('assign_seller_parcel', {
    p_client_id: clientId,
    p_project_id: projectId,
    p_parcel_id: parcelId,
    p_note: note || '',
  })
  if (error) throw new Error(`assignSellerParcel: ${error.message}`)
  return data || {}
}

export async function revokeSellerParcel({ assignmentId = null, clientId = null, parcelId = null, reason = '' }) {
  const { data, error } = await db().rpc('revoke_seller_parcel', {
    p_assignment_id: assignmentId || null,
    p_client_id: clientId || null,
    p_parcel_id: parcelId || null,
    p_reason: reason || '',
  })
  if (error) throw new Error(`revokeSellerParcel: ${error.message}`)
  return data || {}
}

export async function createSale(sale) {
  const row = {
    code: sale.code || randomEntityCode('SALE'),
    project_id: sale.projectId,
    parcel_id: sale.parcelId,
    parcel_ids: sale.parcelIds || [],
    client_id: sale.clientId,
    payment_type: sale.paymentType || 'full',
    offer_id: sale.offerId || null,
    agreed_price: sale.agreedPrice || 0,
    deposit: sale.deposit || 0,
    advance_paid: sale.advancePaid ?? 0,
    plots_total_price: sale.plotsTotalPrice || 0,
    offer_down_payment_pct: sale.offerDownPayment || 0,
    offer_duration_months: sale.offerDuration || 0,
    offer_name: sale.offerName || '',
    payment_method: sale.paymentMethod || '',
    buyer_phone_normalized: sale.buyerPhoneNormalized || sale.buyerPhoneClaim || null,
    buyer_auth_user_id: sale.buyerAuthUserId || null,
    seller_contract_signed: Boolean(sale.sellerContractSigned),
    ambassador_cin: sale.ambassadorCin || '',
    ambassador_client_id: sale.ambassadorClientId || null,
    seller_client_id: sale.sellerClientId || null,
    notes: sale.notes || '',
    status: sale.status || 'pending_finance',
    pipeline_status: sale.pipelineStatus || sale.status || 'pending_finance',
    agent_id: sale.agentId || null,
    manager_id: sale.managerId || null,
    legal_offer_advance: sale.legalOfferAdvance ?? sale.advancePaid ?? 0,
    legal_terms_signed_at: sale.legalTermsSignedAt || null,
    legal_sale_contract_signed_at: sale.legalSaleContractSignedAt || null,
    legal_seller_choice: sale.legalSellerChoice || 'pending',
    legal_seller_signed_at: sale.legalSellerSignedAt || null,
    legal_seller_notes: sale.legalSellerNotes || '',
    finance_confirmed_at: sale.financeConfirmedAt || null,
    finance_validated_at: sale.financeValidatedAt || null,
    finance_validated_by: sale.financeValidatedBy || null,
    juridique_validated_at: sale.juridiqueValidatedAt || null,
    juridique_validated_by: sale.juridiqueValidatedBy || null,
    coordination_finance_at: sale.coordinationFinanceAt || null,
    coordination_juridique_at: sale.coordinationJuridiqueAt || null,
    coordination_notes: sale.coordinationNotes || '',
    notary_completed_at: sale.notaryCompletedAt || null,
    notary_completed_by: sale.notaryCompletedBy || null,
    post_notary_destination: sale.postNotaryDestination || null,
    config_snapshot_version: sale.configSnapshotVersion ?? 1,
    pricing_snapshot: sale.pricingSnapshot && typeof sale.pricingSnapshot === 'object' ? sale.pricingSnapshot : {},
    fee_snapshot: sale.feeSnapshot && typeof sale.feeSnapshot === 'object' ? sale.feeSnapshot : {},
    checklist_snapshot: sale.checklistSnapshot && typeof sale.checklistSnapshot === 'object' ? sale.checklistSnapshot : {},
    notary_checklist_signed:
      sale.notaryChecklistSigned && typeof sale.notaryChecklistSigned === 'object' ? sale.notaryChecklistSigned : {},
    commission_rule_snapshot:
      sale.commissionRuleSnapshot && typeof sale.commissionRuleSnapshot === 'object'
        ? sale.commissionRuleSnapshot
        : {},
    offer_snapshot: sale.offerSnapshot && typeof sale.offerSnapshot === 'object' ? sale.offerSnapshot : {},
    reservation_started_at: sale.reservationStartedAt || null,
    reservation_expires_at: sale.reservationExpiresAt || null,
    reservation_status: sale.reservationStatus || 'none',
    reservation_released_at: sale.reservationReleasedAt || null,
    reservation_release_reason: sale.reservationReleaseReason || '',
    stamped_at: sale.stampedAt || null,
    paid_at: sale.paidAt || null,
  }
  const res = await db().from('sales').insert(row).select().single()
  return mapSaleFromDb(throwIfError(res, 'createSale'), null)
}

export async function updateSale(saleId, updates) {
  const FM = {
    status: 'status',
    pipelineStatus: 'pipeline_status',
    paymentMethod: 'payment_method',
    financeConfirmedAt: 'finance_confirmed_at',
    financeValidatedAt: 'finance_validated_at',
    financeValidatedBy: 'finance_validated_by',
    juridiqueValidatedAt: 'juridique_validated_at',
    juridiqueValidatedBy: 'juridique_validated_by',
    notaryCompletedAt: 'notary_completed_at',
    notaryCompletedBy: 'notary_completed_by',
    postNotaryDestination: 'post_notary_destination',
    stampedAt: 'stamped_at',
    paidAt: 'paid_at',
    notes: 'notes',
    deposit: 'deposit',
    advancePaid: 'advance_paid',
    agreedPrice: 'agreed_price',
    paymentType: 'payment_type',
    offerName: 'offer_name',
    offerDownPayment: 'offer_down_payment_pct',
    offerDuration: 'offer_duration_months',
    plotsTotalPrice: 'plots_total_price',
    ambassadorCin: 'ambassador_cin',
    ambassadorClientId: 'ambassador_client_id',
    sellerClientId: 'seller_client_id',
    legalTermsSignedAt: 'legal_terms_signed_at',
    legalSaleContractSignedAt: 'legal_sale_contract_signed_at',
    legalSellerChoice: 'legal_seller_choice',
    legalSellerSignedAt: 'legal_seller_signed_at',
    legalSellerNotes: 'legal_seller_notes',
    legalOfferAdvance: 'legal_offer_advance',
    reservationExpiresAt: 'reservation_expires_at',
    reservationReleasedAt: 'reservation_released_at',
    reservationReleaseReason: 'reservation_release_reason',
    reservationStartedAt: 'reservation_started_at',
    reservationStatus: 'reservation_status',
    sellerContractSigned: 'seller_contract_signed',
    notaryChecklistSigned: 'notary_checklist_signed',
    buyerPhoneNormalized: 'buyer_phone_normalized',
    buyerAuthUserId: 'buyer_auth_user_id',
    coordinationFinanceAt: 'coordination_finance_at',
    coordinationJuridiqueAt: 'coordination_juridique_at',
    coordinationNotes: 'coordination_notes',
    parcelId: 'parcel_id',
    parcelIds: 'parcel_ids',
    offerId: 'offer_id',
    projectId: 'project_id',
    clientId: 'client_id',
  }
  const row = {}
  for (const [k, v] of Object.entries(FM)) {
    if (updates[k] !== undefined) row[v] = updates[k]
  }
  if (Object.keys(row).length === 0) return
  const res = await db().from('sales').update(row).eq('id', saleId)
  throwIfError(res, 'updateSale')
}

/** Append-only reservation lifecycle rows for sale ledger / audits. */
export async function insertSaleReservationEvent({
  saleId,
  eventType,
  fromStatus = null,
  toStatus = null,
  actorUserId = null,
  details = '',
  metadata = {},
}) {
  if (!saleId || !eventType) return
  const res = await db().from('sale_reservation_events').insert({
    sale_id: saleId,
    event_type: String(eventType),
    from_status: fromStatus,
    to_status: toStatus,
    actor_user_id: actorUserId || null,
    details: details || '',
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  })
  throwIfError(res, 'insertSaleReservationEvent')
}

export async function deleteSale(saleId) {
  const res = await db().from('sales').delete().eq('id', saleId)
  throwIfError(res, 'deleteSale')
}

/* ═══════════════════════════════════════════════════════════
   INSTALLMENT PLANS & PAYMENTS
   ═══════════════════════════════════════════════════════════ */

function mapPlanFromDb(p, payments, parcelMap, receiptsByPayment = new Map()) {
  const parcelNumber = parcelMap ? resolveParcelNumber(parcelMap, p.parcel_id) : p.parcel_id
  return {
    id: p.id,
    code: p.code,
    saleId: p.sale_id,
    clientId: p.client_id,
    clientName: p.client?.full_name || '',
    clientCin: p.client?.cin || '',
    clientEmail: p.client?.email || '',
    projectId: p.project_id,
    projectTitle: p.project?.title || '',
    projectCity: p.project?.city || '',
    projectRegion: p.project?.region || '',
    projectArabonDefault: p.project?.arabon_default != null ? Number(p.project.arabon_default) : null,
    parcelId: p.parcel_id,
    plotId: parcelNumber,
    plotIds: parcelNumber ? [parcelNumber] : [],
    totalPrice: Number(p.total_price || 0),
    downPayment: Number(p.down_payment || 0),
    monthlyAmount: Number(p.monthly_amount || 0),
    totalMonths: Number(p.total_months || 0),
    startDate: p.start_date,
    status: p.status,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    payments: (payments || [])
      .filter(pm => pm.plan_id === p.id)
      .sort((a, b) => a.month_no - b.month_no)
      .map(pm => {
        const latestReceiptUrl = ((receiptsByPayment.get(pm.id) || [])[0]?.url || '')
        return {
        id: pm.id,
        month: pm.month_no,
        dueDate: pm.due_date,
        amount: Number(pm.amount || 0),
        status: pm.status,
        receiptUrl: String(pm.receipt_url || '').startsWith('http') ? pm.receipt_url : (latestReceiptUrl || pm.receipt_url || ''),
        rejectedNote: pm.rejected_note || '',
        receipts: receiptsByPayment.get(pm.id) || [],
        }
      }),
  }
}

export async function fetchInstallments() {
  const [plansRes, paymentsRes, parcelsRes, clientsRes, projectsRes] = await Promise.all([
    db().from('installment_plans').select('*').order('created_at', { ascending: false }),
    db().from('installment_payments').select('*'),
    db().from('parcels').select('id, parcel_number'),
    db().from('clients').select('id, full_name, cin, email'),
    db().from('projects').select('id, title, city, region, arabon_default'),
  ])
  const plans = throwIfError(plansRes, 'plans')
  const payments = throwIfError(paymentsRes, 'payments')
  const parcels = throwIfError(parcelsRes, 'parcels')
  const clients = throwIfError(clientsRes, 'clients')
  const projects = throwIfError(projectsRes, 'projects')
  const parcelMap = fillParcelNumberMap(parcels)
  const clientMap = new Map()
  clients.forEach(c => clientMap.set(c.id, c))
  const projectMap = new Map()
  projects.forEach(p => projectMap.set(p.id, p))

  let receiptsByPayment = new Map()
  try {
    const rr = await db()
      .from('installment_payment_receipts')
      .select('*')
      .order('created_at', { ascending: false })
    if (!rr.error) {
      receiptsByPayment = new Map()
      for (const r of rr.data || []) {
        const key = r.payment_id
        const list = receiptsByPayment.get(key) || []
        list.push({
          id: r.id,
          url: r.receipt_url || '',
          fileName: r.file_name || '',
          note: r.note || '',
          createdAt: r.created_at,
        })
        receiptsByPayment.set(key, list)
      }
    }
  } catch {
    // Ignore: receipt history table is optional until migration is applied.
  }

  const allReceiptPaths = [
    ...payments.map((pm) => pm.receipt_url).filter((p) => p && !String(p).startsWith('http')),
    ...[].concat(...Array.from(receiptsByPayment.values()).map((arr) => arr.map((r) => r.url))),
  ]
  const signedMap = await signReceiptUrls(allReceiptPaths)
  if (signedMap.size) {
    for (const pm of payments) {
      if (pm.receipt_url && !String(pm.receipt_url).startsWith('http')) {
        pm.receipt_url = signedMap.get(pm.receipt_url) || pm.receipt_url
      }
    }
    for (const [paymentId, list] of receiptsByPayment.entries()) {
      receiptsByPayment.set(paymentId, list.map((r) => ({
        ...r,
        url: signedMap.get(r.url) || r.url,
      })))
    }
  }

  return plans.map(p => mapPlanFromDb({
    ...p,
    client: clientMap.get(p.client_id) || null,
    project: projectMap.get(p.project_id) || null,
  }, payments, parcelMap, receiptsByPayment))
}

export async function fetchInstallmentsScoped({ clientId = null } = {}) {
  const clientIds = clientId ? [clientId] : []
  if (!clientIds.length) return []

  const plansRes = await db()
    .from('installment_plans')
    .select('*')
    .in('client_id', clientIds)
    .order('created_at', { ascending: false })
  const plans = throwIfError(plansRes, 'scopedPlans')
  if (!plans.length) return []

  const planIds = plans.map((p) => p.id).filter(Boolean)
  const parcelIds = [...new Set(plans.map((p) => p.parcel_id).filter(Boolean))]
  const projectIds = [...new Set(plans.map((p) => p.project_id).filter(Boolean))]
  const scopedClientIds = [...new Set(plans.map((p) => p.client_id).filter(Boolean))]

  const [paymentsRes, parcelsRes, clientsRes, projectsRes] = await Promise.all([
    db().from('installment_payments').select('*').in('plan_id', planIds),
    parcelIds.length ? db().from('parcels').select('id, parcel_number').in('id', parcelIds) : Promise.resolve({ data: [], error: null }),
    scopedClientIds.length ? db().from('clients').select('id, full_name, cin, email').in('id', scopedClientIds) : Promise.resolve({ data: [], error: null }),
    projectIds.length ? db().from('projects').select('id, title, city, region').in('id', projectIds) : Promise.resolve({ data: [], error: null }),
  ])

  const payments = throwIfError(paymentsRes, 'scopedPayments')
  const parcels = throwIfError(parcelsRes, 'scopedParcels')
  const clients = throwIfError(clientsRes, 'scopedClientsData')
  const projects = throwIfError(projectsRes, 'scopedProjects')

  const parcelMap = fillParcelNumberMap(parcels)
  const clientMap = new Map()
  clients.forEach((c) => clientMap.set(c.id, c))
  const projectMap = new Map()
  projects.forEach((p) => projectMap.set(p.id, p))

  let receiptsByPayment = new Map()
  try {
    const rr = await db()
      .from('installment_payment_receipts')
      .select('*')
      .in('payment_id', payments.map((p) => p.id))
      .order('created_at', { ascending: false })
    if (!rr.error) {
      for (const r of rr.data || []) {
        const key = r.payment_id
        const list = receiptsByPayment.get(key) || []
        list.push({
          id: r.id,
          url: r.receipt_url || '',
          fileName: r.file_name || '',
          note: r.note || '',
          createdAt: r.created_at,
        })
        receiptsByPayment.set(key, list)
      }
    }
  } catch {
    // optional table until migration applied
  }

  const allReceiptPaths = [
    ...payments.map((pm) => pm.receipt_url).filter((p) => p && !String(p).startsWith('http')),
    ...[].concat(...Array.from(receiptsByPayment.values()).map((arr) => arr.map((r) => r.url))),
  ]
  const signedMap = await signReceiptUrls(allReceiptPaths)
  if (signedMap.size) {
    for (const pm of payments) {
      if (pm.receipt_url && !String(pm.receipt_url).startsWith('http')) {
        pm.receipt_url = signedMap.get(pm.receipt_url) || pm.receipt_url
      }
    }
    for (const [paymentId, list] of receiptsByPayment.entries()) {
      receiptsByPayment.set(paymentId, list.map((r) => ({
        ...r,
        url: signedMap.get(r.url) || r.url,
      })))
    }
  }

  return plans.map((p) => mapPlanFromDb({
    ...p,
    client: clientMap.get(p.client_id) || null,
    project: projectMap.get(p.project_id) || null,
  }, payments, parcelMap, receiptsByPayment))
}

export async function fetchInstallmentsSummaryScoped({ clientId = null } = {}) {
  const clientIds = clientId ? [clientId] : []
  if (!clientIds.length) return []

  const plansRes = await db()
    .from('installment_plans')
    .select('id, project_id')
    .in('client_id', clientIds)
  const plans = throwIfError(plansRes, 'summaryScopedPlans')
  if (!plans.length) return []

  const planIds = plans.map((p) => p.id).filter(Boolean)
  const projectIds = [...new Set(plans.map((p) => p.project_id).filter(Boolean))]

  const [paymentsRes, projectsRes] = await Promise.all([
    db().from('installment_payments').select('id, plan_id, month_no, due_date, amount, status').in('plan_id', planIds),
    projectIds.length
      ? db().from('projects').select('id, title').in('id', projectIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  const payments = throwIfError(paymentsRes, 'summaryScopedPayments')
  const projects = throwIfError(projectsRes, 'summaryScopedProjects')

  const planProject = new Map()
  plans.forEach((p) => planProject.set(p.id, p.project_id))
  const projectTitle = new Map()
  projects.forEach((p) => projectTitle.set(p.id, p.title || ''))

  return payments.map((pm) => ({
    id: pm.id,
    planId: pm.plan_id,
    month: pm.month_no,
    dueDate: pm.due_date,
    amount: Number(pm.amount || 0),
    status: pm.status,
    projectTitle: projectTitle.get(planProject.get(pm.plan_id)) || '',
  }))
}

export async function createInstallmentPlan(plan) {
  const basePlanRow = {
    code: plan.code || `INS-${Date.now()}`,
    sale_id: plan.saleId,
    client_id: plan.clientId,
    project_id: plan.projectId,
    parcel_id: plan.parcelId,
    total_price: plan.totalPrice || 0,
    down_payment: plan.downPayment || 0,
    monthly_amount: plan.monthlyAmount || 0,
    total_months: plan.totalMonths || 0,
    start_date: plan.startDate,
    status: plan.status || 'active',
  }
  const insertWithCode = async (code) => {
    const row = { ...basePlanRow, code }
    return db().from('installment_plans').insert(row).select().single()
  }

  let planRes = await insertWithCode(basePlanRow.code)
  if (planRes.error && String(planRes.error.code || '') === '23505') {
    // Idempotency on retry: if sale already has a plan, return it.
    const existingBySaleRes = await db()
      .from('installment_plans')
      .select('id, code')
      .eq('sale_id', basePlanRow.sale_id)
      .limit(1)
      .maybeSingle()
    if (existingBySaleRes.data?.id) return existingBySaleRes.data.id

    // Code collision with another plan: retry once with a unique suffix.
    planRes = await insertWithCode(`INS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  }
  const inserted = throwIfError(planRes, 'createPlan')

  if (Array.isArray(plan.payments) && plan.payments.length > 0) {
    const paymentRows = plan.payments.map(pm => ({
      plan_id: inserted.id,
      month_no: pm.month,
      due_date: pm.dueDate,
      amount: pm.amount || 0,
      status: pm.status || 'pending',
    }))
    const pmRes = await db().from('installment_payments').insert(paymentRows)
    throwIfError(pmRes, 'createPayments')
  }

  return inserted.id
}

/**
 * Idempotent plan+payments creation from a completed sale.
 * - If a plan already exists for sale_id, returns its id without mutation.
 * - Computes down payment + monthly from the sale snapshot (offer % / duration).
 * - Generates the monthly schedule from startDate (defaults to today).
 */
export async function ensureInstallmentPlanFromSale(sale, { startDate } = {}) {
  if (!sale?.id) throw new Error('ensureInstallmentPlanFromSale: missing sale')
  const existing = await db()
    .from('installment_plans')
    .select('id')
    .eq('sale_id', sale.id)
    .limit(1)
    .maybeSingle()
  if (existing?.data?.id) return existing.data.id

  // Snapshot-first: the sale freezes offer terms at creation so post-notary plans
  // stay true even if the source offer changes later. Fall back to live fields.
  const snap = (sale.offerSnapshot && typeof sale.offerSnapshot === 'object') ? sale.offerSnapshot : {}
  const pricing = (sale.pricingSnapshot && typeof sale.pricingSnapshot === 'object') ? sale.pricingSnapshot : {}
  const duration = Math.max(1, Number(snap.duration || sale.offerDuration) || 0)
  const downPct = Number(snap.downPayment ?? sale.offerDownPayment) || 0
  const agreedPrice = Number(pricing.agreedPrice ?? sale.agreedPrice) || 0

  if (!duration || !agreedPrice) {
    console.warn('ensureInstallmentPlanFromSale: missing duration/agreedPrice — skipping', {
      saleId: sale.id, duration, agreedPrice,
    })
    return null
  }

  const downAmount = Math.round(agreedPrice * (downPct / 100) * 100) / 100
  const remaining = Math.max(0, Math.round((agreedPrice - downAmount) * 100) / 100)
  const baseMonthly = Math.round((remaining / duration) * 100) / 100
  const iso = startDate || new Date().toISOString().slice(0, 10)

  // Absorb rounding drift into the final installment so the schedule total equals
  // the remaining balance to the cent.
  const priorSum = Math.round(baseMonthly * (duration - 1) * 100) / 100
  const lastMonthly = Math.round((remaining - priorSum) * 100) / 100

  const payments = []
  const start = new Date(iso)
  for (let i = 0; i < duration; i += 1) {
    const due = new Date(start)
    due.setMonth(due.getMonth() + i)
    const dueIso = new Date(due.getTime() - due.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10)
    const amount = i === duration - 1 ? lastMonthly : baseMonthly
    payments.push({ month: i + 1, dueDate: dueIso, amount, status: 'pending' })
  }

  return createInstallmentPlan({
    code: `INS-${sale.code || sale.id}`,
    saleId: sale.id,
    clientId: sale.clientId,
    projectId: sale.projectId,
    parcelId: sale.parcelId || (Array.isArray(sale.parcelIds) ? sale.parcelIds[0] : null),
    totalPrice: agreedPrice,
    downPayment: downAmount,
    monthlyAmount: baseMonthly,
    totalMonths: duration,
    startDate: iso,
    status: 'active',
    payments,
  })
}

/**
 * Self-heal: scan completed installment sales destined for plans that lack an
 * `installment_plans` row, and call `ensureInstallmentPlanFromSale` for each.
 *
 * Idempotent (plan check happens inside ensure). Best-effort: RLS blocks on
 * INSERT for non-staff buyers just bubble up as `skipped: permission_denied`.
 *
 * Scope:
 *   - `clientId` provided → only that client's sales (used by auth sync / buyer path)
 *   - `clientId` null      → all visible sales (admin/staff bulk repair path)
 */
export async function replayInstallmentPlansFromCompletedSales(clientId = null) {
  const result = { scanned: 0, created: [], skipped: [], errors: [] }

  const base = db()
    .from('sales')
    .select('*')
    .eq('status', 'completed')
    .eq('payment_type', 'installments')
  const salesRes = clientId
    ? await base.eq('client_id', clientId)
    : await base
  if (salesRes.error) {
    console.warn('[replay] sales query failed:', salesRes.error.message)
    return result
  }
  const rows = (salesRes.data || []).filter((s) => {
    const d = String(s.post_notary_destination || '').toLowerCase()
    return d === 'plans' || d === ''
  })
  if (!rows.length) return result

  const saleIds = rows.map((s) => s.id)
  const plansRes = await db()
    .from('installment_plans')
    .select('sale_id')
    .in('sale_id', saleIds)
  if (plansRes.error) {
    console.warn('[replay] plans query failed:', plansRes.error.message)
    return result
  }
  const withPlan = new Set((plansRes.data || []).map((p) => String(p.sale_id)))
  const missing = rows.filter((s) => !withPlan.has(String(s.id)))
  result.scanned = rows.length
  if (!missing.length) return result

  for (const row of missing) {
    const sale = mapSaleFromDb(row, null)
    try {
      const planId = await ensureInstallmentPlanFromSale(sale)
      if (planId) {
        result.created.push({ saleId: sale.id, planId })
        console.info('[replay] plan created', { saleId: sale.id, planId })
      } else {
        result.skipped.push({ saleId: sale.id, reason: 'missing_snapshot' })
      }
    } catch (e) {
      const msg = String(e?.message || e)
      const denied = /42501|permission|row-level|rls|forbidden/i.test(msg)
      if (denied) {
        result.skipped.push({ saleId: sale.id, reason: 'permission_denied' })
      } else {
        result.errors.push({ saleId: sale.id, message: msg })
        console.warn('[replay] plan creation failed', { saleId: sale.id, message: msg })
      }
    }
  }
  return result
}

export async function updatePaymentStatus(paymentId, status, extra = {}) {
  const row = { status }
  if (extra.receiptUrl) row.receipt_url = extra.receiptUrl
  if (status === 'rejected' && Object.prototype.hasOwnProperty.call(extra, 'rejectedNote')) {
    row.rejected_note = extra.rejectedNote || ''
  }
  if (status === 'approved') row.approved_at = new Date().toISOString()

  const res = await db().from('installment_payments').update(row).eq('id', paymentId).select().single()
  try {
    return throwIfError(res, 'updatePayment')
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase()
    const permissionDenied =
      msg.includes('42501')
      || msg.includes('forbidden')
      || msg.includes('permission')
      || msg.includes('row-level security')
      || msg.includes('rls')
    if (permissionDenied) {
      const e = new Error('Impossible d\'envoyer le reçu: ce paiement n\'est pas autorisé pour votre compte. Vérifiez votre accès puis reconnectez-vous.')
      e.code = 'PAYMENT_FORBIDDEN'
      throw e
    }
    throw err
  }
}

export async function updatePlanStatus(planId, status) {
  const res = await db().from('installment_plans').update({ status }).eq('id', planId)
  throwIfError(res, 'updatePlanStatus')
}

export async function uploadInstallmentReceipt({ paymentId, file }) {
  if (!paymentId || !file) throw new Error('uploadInstallmentReceipt: missing paymentId or file')
  const ext = String(file.name || '').includes('.') ? file.name.split('.').pop() : 'bin'
  const safeExt = String(ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
  const path = `payments/${paymentId}/${Date.now()}.${safeExt || 'bin'}`
  const up = await db()
    .storage
    .from('installment-receipts')
    .upload(path, file, { upsert: true, cacheControl: '3600' })
  throwIfError(up, 'uploadInstallmentReceipt')
  return path
}

export async function addInstallmentReceiptRecord({ paymentId, receiptUrl, fileName, note = '' }) {
  const row = {
    payment_id: paymentId,
    receipt_url: receiptUrl || '',
    file_name: fileName || '',
    note: note || '',
  }
  const res = await db().from('installment_payment_receipts').insert(row).select().single()
  return throwIfError(res, 'addInstallmentReceiptRecord')
}

/* ═══════════════════════════════════════════════════════════
   VISIT REQUESTS
   ═══════════════════════════════════════════════════════════ */

function mapVisitFromDb(v) {
  return {
    id: v.id,
    userId: v.user_id || '',
    userName: v.user_name || '',
    userEmail: v.user_email || '',
    userPhone: v.user_phone || '',
    userCin: v.user_cin || '',
    projectId: v.project_id || '',
    projectTitle: v.project_title || '',
    preferredDate: v.preferred_date || '',
    preferredTime: v.preferred_time || '',
    message: v.message || '',
    status: v.status || 'new',
    adminNotes: v.admin_notes || '',
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  }
}

export async function fetchVisitRequests() {
  const res = await db().from('visit_requests').select('*').order('created_at', { ascending: false })
  return throwIfError(res, 'visitRequests').map(mapVisitFromDb)
}

export async function addVisitRequest(req) {
  const row = {
    user_id: req.userId || '',
    user_name: req.userName || '',
    user_email: req.userEmail || '',
    user_phone: req.userPhone || '',
    user_cin: req.userCin || '',
    project_id: req.projectId || null,
    project_title: req.projectTitle || '',
    preferred_date: req.preferredDate || '',
    preferred_time: req.preferredTime || '',
    message: req.message || '',
    status: 'new',
  }
  const res = await db().from('visit_requests').insert(row).select().single()
  return mapVisitFromDb(throwIfError(res, 'addVisitRequest'))
}

export async function updateVisitRequest(id, updates) {
  const row = {}
  if (updates.status !== undefined) row.status = updates.status
  if (updates.adminNotes !== undefined) row.admin_notes = updates.adminNotes
  const res = await db().from('visit_requests').update(row).eq('id', id).select().single()
  return mapVisitFromDb(throwIfError(res, 'updateVisitRequest'))
}

export async function deleteVisitRequest(id) {
  const res = await db().from('visit_requests').delete().eq('id', id)
  throwIfError(res, 'deleteVisitRequest')
}

/* ═══════════════════════════════════════════════════════════
   APPOINTMENTS
   ═══════════════════════════════════════════════════════════ */

function mapAppointmentFromDb(a) {
  return {
    id: a.id,
    code: a.code,
    saleId: a.sale_id || '',
    clientId: a.client_id || '',
    projectId: a.project_id || '',
    type: a.type,
    status: a.status,
    date: a.date,
    time: String(a.time || '').slice(0, 5),
    notes: a.notes || '',
    createdBy: a.created_by || '',
    createdAt: a.created_at,
  }
}

export async function fetchAppointments() {
  const res = await db().from('appointments').select('*').order('created_at', { ascending: false })
  return throwIfError(res, 'appointments').map(mapAppointmentFromDb)
}

export async function upsertAppointment(apt) {
  const saleIdFromNotes = (() => {
    const m = String(apt.notes || '').match(/\[sale:([^[\]]+)\]/)
    return m ? m[1] : null
  })()
  const row = {
    code: apt.code || `APT-${Date.now()}`,
    sale_id: apt.saleId || saleIdFromNotes || null,
    client_id: apt.clientId || null,
    project_id: apt.projectId || null,
    type: apt.type || 'visit',
    status: apt.status || 'new',
    date: apt.date,
    time: apt.time,
    notes: apt.notes || '',
    created_by: apt.createdBy || null,
  }
  if (apt.id) {
    const res = await db().from('appointments').update(row).eq('id', apt.id).select().single()
    return mapAppointmentFromDb(throwIfError(res, 'updateAppointment'))
  }
  const res = await db().from('appointments').insert(row).select().single()
  return mapAppointmentFromDb(throwIfError(res, 'insertAppointment'))
}

export async function deleteAppointment(id) {
  const res = await db().from('appointments').delete().eq('id', id)
  throwIfError(res, 'deleteAppointment')
}

/* ═══════════════════════════════════════════════════════════
   LEGAL STAMPS
   ═══════════════════════════════════════════════════════════ */

function mapStampFromDb(s) {
  return {
    id: s.id,
    saleId: s.sale_id || '',
    clientName: s.client_name || '',
    projectTitle: s.project_title || '',
    parcelId: s.parcel_id,
    stampedBy: s.stamped_by || '',
    stampDate: s.stamp_date,
    contractRef: s.contract_ref || '',
    notes: s.notes || '',
    createdAt: s.created_at,
  }
}

export async function fetchStamps() {
  const res = await db().from('legal_stamps').select('*').order('created_at', { ascending: false })
  return throwIfError(res, 'stamps').map(mapStampFromDb)
}

export async function addStamp(stamp) {
  const row = {
    sale_id: stamp.saleId || null,
    client_name: stamp.clientName || '',
    project_title: stamp.projectTitle || '',
    parcel_id: stamp.parcelId || null,
    stamped_by: stamp.stampedBy || '',
    contract_ref: stamp.contractRef || '',
    notes: stamp.notes || '',
  }
  const res = await db().from('legal_stamps').insert(row).select().single()
  return mapStampFromDb(throwIfError(res, 'addStamp'))
}

/* ═══════════════════════════════════════════════════════════
   LEGAL NOTICES
   ═══════════════════════════════════════════════════════════ */

function mapNoticeFromDb(n) {
  return {
    id: n.id,
    saleId: n.sale_id || '',
    clientName: n.client_name || '',
    clientEmail: n.client_email || '',
    projectTitle: n.project_title || '',
    parcelId: n.parcel_id,
    type: n.notice_type || 'Relance amiable',
    reason: n.reason || '',
    missedMonths: n.missed_months || 0,
    missedAmount: Number(n.missed_amount || 0),
    status: n.status || 'draft',
    sentAt: n.sent_at || '',
    resolvedAt: n.resolved_at || '',
    notes: n.notes || '',
    createdAt: n.created_at,
  }
}

export async function fetchNotices() {
  const res = await db().from('legal_notices').select('*').order('created_at', { ascending: false })
  return throwIfError(res, 'notices').map(mapNoticeFromDb)
}

export async function upsertNotice(notice) {
  const row = {
    sale_id: notice.saleId || null,
    client_name: notice.clientName || '',
    client_email: notice.clientEmail || '',
    project_title: notice.projectTitle || '',
    parcel_id: notice.parcelId || null,
    notice_type: notice.type || 'Relance amiable',
    reason: notice.reason || '',
    missed_months: notice.missedMonths || 0,
    missed_amount: notice.missedAmount || 0,
    status: notice.status || 'draft',
    sent_at: notice.sentAt || null,
    resolved_at: notice.resolvedAt || null,
    notes: notice.notes || '',
  }
  if (notice.id) {
    const res = await db().from('legal_notices').update(row).eq('id', notice.id).select().single()
    return mapNoticeFromDb(throwIfError(res, 'updateNotice'))
  }
  const res = await db().from('legal_notices').insert(row).select().single()
  return mapNoticeFromDb(throwIfError(res, 'insertNotice'))
}

export async function deleteNotice(id) {
  const res = await db().from('legal_notices').delete().eq('id', id)
  throwIfError(res, 'deleteNotice')
}

/* ═══════════════════════════════════════════════════════════
   COMMISSIONS & WALLETS
   ═══════════════════════════════════════════════════════════ */

function mapCommissionFromDb(c) {
  return {
    id: c.id,
    saleId: c.sale_id || '',
    ownerUserId: c.owner_user_id || '',
    ownerClientId: c.owner_client_id || '',
    role: c.role ? (DB_ROLE_MAP[c.role] || c.role) : '',
    type: c.type,
    amount: Number(c.amount || 0),
    grossAmount: c.gross_amount != null ? Number(c.gross_amount) : null,
    withholdingAmount: c.withholding_amount != null ? Number(c.withholding_amount) : null,
    netAmount: c.net_amount != null ? Number(c.net_amount) : null,
    status: c.status,
    monthKey: c.month_key || '',
    description: c.description || '',
    clearedAt: c.cleared_at || '',
    paidAt: c.paid_at || '',
    createdAt: c.created_at,
  }
}

export async function fetchCommissions() {
  const res = await db().from('commissions').select('*').order('created_at', { ascending: false })
  return throwIfError(res, 'commissions').map(mapCommissionFromDb)
}

export async function upsertCommission(commission) {
  const row = {
    sale_id: commission.saleId || null,
    owner_user_id: commission.ownerUserId || null,
    owner_client_id: commission.ownerClientId || null,
    role: commission.role ? (APP_ROLE_MAP[commission.role] || commission.role) : null,
    type: commission.type,
    amount: commission.amount || 0,
    gross_amount: commission.grossAmount != null ? commission.grossAmount : null,
    withholding_amount: commission.withholdingAmount != null ? commission.withholdingAmount : null,
    net_amount: commission.netAmount != null ? commission.netAmount : null,
    status: commission.status || 'pending',
    month_key: commission.monthKey || '',
    description: commission.description || '',
    cleared_at: commission.clearedAt || null,
    paid_at: commission.paidAt || null,
  }
  if (commission.id) {
    const res = await db().from('commissions').update(row).eq('id', commission.id).select().single()
    return mapCommissionFromDb(throwIfError(res, 'updateCommission'))
  }
  const res = await db().from('commissions').insert(row).select().single()
  return mapCommissionFromDb(throwIfError(res, 'insertCommission'))
}

export async function fetchWallets() {
  const res = await db().from('ambassador_wallets').select('*')
  const rows = throwIfError(res, 'wallets')
  const map = {}
  rows.forEach(w => { map[w.client_id] = Number(w.balance || 0) })
  return map
}

export async function creditWallet(clientId, amount) {
  const delta = Number(amount)
  if (Number.isNaN(delta)) throw new Error('Montant invalide')
  const { error } = await supabase.rpc('increment_ambassador_wallet_balance', {
    p_client_id: clientId,
    p_delta: delta,
  })
  if (error) throw new Error(error.message || 'creditWallet')
}

/** Keys used by chef d’équipe dashboard (override estimate + team bonus target). */
export const TEAM_COMMISSION_RULE_KEYS = [
  'MANAGER_OVERRIDE_PER_SALE',
  'MANAGER_TEAM_TARGET',
  'MANAGER_TEAM_BONUS',
]

export async function fetchCommissionRulesByKeys(keys) {
  if (!keys?.length) return {}
  const res = await db()
    .from('commission_rules')
    .select('key, amount')
    .in('key', keys)
  const rows = throwIfError(res, 'commissionRulesByKeys')
  const map = {}
  for (const r of rows || []) {
    map[r.key] = Number(r.amount ?? 0)
  }
  return map
}

/** Brut TND par rang dans la chaîne (niveau 1 = plus proche du compte vendeur saisi sur la vente). 0 = repli sur AMBASSADOR_REFERRAL_GROSS. */
export const AMBASSADOR_LEVEL_GROSS_KEYS = Array.from({ length: 20 }, (_, i) => `AMBASSADOR_LEVEL_${i + 1}_GROSS`)

export const REFERRAL_COMMISSION_RULE_KEYS = [
  'AGENT_INSTANT',
  'MANAGER_OVERRIDE_PER_SALE',
  'AMBASSADOR_REFERRAL_GROSS',
  'AMBASSADOR_REFERRAL',
  'AMBASSADOR_RS_RATE_PCT',
  'PARRAINAGE_MAX_DEPTH',
  'FIELD_DEPOSIT_MIN',
  'FULL_DEPOSIT_TARGET',
  'MIN_PAYOUT_AMOUNT',
  'ARABON_DEFAULT',
  'NOTARY_CONTRACT_FEE',
  'BROKERAGE_COMMISSION_FEE',
  'FISCAL_STAMP_FEE',
  'REGISTRATION_FEE',
  ...AMBASSADOR_LEVEL_GROSS_KEYS,
]

export async function fetchReferralCommissionRules() {
  const res = await db()
    .from('commission_rules')
    .select('key, amount')
    .in('key', REFERRAL_COMMISSION_RULE_KEYS)
  const rows = throwIfError(res, 'referralCommissionRules')
  const map = {}
  for (const r of rows) {
    map[r.key] = Number(r.amount || 0)
  }
  return map
}

export async function upsertCommissionRule(key, amount) {
  let n = Number(amount)
  if (Number.isNaN(n) || n < 0) {
    throw new Error('Montant invalide (≥ 0 requis)')
  }
  if (key === 'PARRAINAGE_MAX_DEPTH') {
    n = Math.trunc(n)
    if (n < 0) {
      throw new Error('Profondeur parrainage invalide')
    }
  }
  const res = await db()
    .from('commission_rules')
    .upsert({ key, amount: n }, { onConflict: 'key' })
  throwIfError(res, 'upsertCommissionRule')
}

function defaultReferralSummary() {
  return {
    ok: false,
    gainsAccrued: 0,
    commissionsReleased: 0,
    walletBalance: 0,
    minPayoutAmount: 0,
    fieldDepositMin: 0,
    fullDepositTarget: 0,
    referralGross: 0,
    referralGrossPerLevel: 0,
    parrainageMaxDepth: 0,
    rsRatePct: 0,
    reason: null,
    errorMessage: null,
    identityVerificationBlocked: false,
    levelGrossRules: [],
  }
}

/** Aggregated ambassador KPIs + rules (RPC get_my_referral_summary). */
export async function fetchAmbassadorReferralSummary() {
  const { data, error } = await supabase.rpc('get_my_referral_summary')
  if (error) {
    console.warn('[fetchAmbassadorReferralSummary]', error.message)
    return {
      ...defaultReferralSummary(),
      ok: false,
      reason: 'rpc_error',
      errorMessage: error.message,
    }
  }
  const d = data || {}
  return {
    ok: d.ok !== false,
    clientId: d.clientId || null,
    ambiguous: Boolean(d.ambiguous),
    gainsAccrued: Number(d.gainsAccrued ?? 0),
    commissionsReleased: Number(d.commissionsReleased ?? 0),
    walletBalance: Number(d.walletBalance ?? 0),
    minPayoutAmount: Number(d.minPayoutAmount ?? 0),
    fieldDepositMin: Number(d.fieldDepositMin ?? 0),
    fullDepositTarget: Number(d.fullDepositTarget ?? 0),
    referralGross: Number(d.referralGross ?? 0),
    // Array of { level, amount } — the RPC returns this for per-level display.
    referralGrossPerLevel: Array.isArray(d.referralGrossPerLevel) ? d.referralGrossPerLevel : [],
    // L1 / L2 aggregates for the Parrainage card breakdown.
    l1Total: Number(d.l1Total ?? 0),
    l2Total: Number(d.l2Total ?? 0),
    parrainageMaxDepth: Number(d.parrainageMaxDepth ?? 0),
    rsRatePct: Number(d.rsRatePct ?? 0),
    levelGrossRules: Array.isArray(d.levelGrossRules) ? d.levelGrossRules : [],
    reason: d.reason || null,
    errorMessage: null,
    identityVerificationBlocked: Boolean(d.identityVerificationBlocked),
    diagnostics: d.diagnostics || null,
  }
}

/**
 * Detailed commission ledger for the signed-in client: every commission_events
 * row where they are the beneficiary, enriched with sale + project + seller +
 * buyer info so the dashboard can show WHY each payment exists (which filleul
 * made which sale). Uses current_client_id() via the heal_my_client_profile_now
 * path — read-only, staff RLS not required because client_select_own_commission_events
 * already allows the beneficiary to SELECT their own rows.
 */
export async function fetchMyCommissionLedger(clientId = null) {
  // Resolve the caller's clients.id explicitly. For regular buyers RLS on
  // commission_events already filters to current_client_id(), but STAFF (incl.
  // Super Admin) bypass that policy and would see every event in the DB —
  // including DEMO data and other users' commissions. Always filter by the
  // passed-in clientId to guarantee the dashboard only shows the signed-in
  // user's own commissions, regardless of their role.
  let beneficiaryId = clientId
  if (!beneficiaryId) {
    try {
      const { data: heal } = await db().rpc('heal_my_client_profile_now')
      beneficiaryId = heal?.clientId || null
    } catch { /* ignore */ }
  }
  if (!beneficiaryId) return []

  const evRes = await db()
    .from('commission_events')
    .select('id, sale_id, level, amount, status, rule_snapshot, created_at')
    .eq('beneficiary_client_id', beneficiaryId)
    .order('created_at', { ascending: false })
  if (evRes.error) throw new Error(`fetchMyCommissionLedger events: ${evRes.error.message}`)
  const events = evRes.data || []
  // Also fetch payout requests for this beneficiary only.
  const prRes = await db()
    .from('commission_payout_requests')
    .select('id, code, gross_amount, status, reviewed_at, reviewed_by, paid_at, created_at')
    .eq('beneficiary_client_id', beneficiaryId)
    .order('created_at', { ascending: false })
  const payoutRequests = (prRes.error ? [] : (prRes.data || [])).map((r) => ({
    kind: 'payout',
    id: r.id,
    code: r.code || '',
    amount: Number(r.gross_amount) || 0,
    status: r.status || 'pending_review',
    createdAt: r.created_at || null,
    reviewedAt: r.reviewed_at || null,
    paidAt: r.paid_at || null,
  }))
  if (!events.length && !payoutRequests.length) return []

  const saleIds = [...new Set(events.map((e) => e.sale_id).filter(Boolean))]
  const salesRes = saleIds.length
    ? await db().from('sales')
        .select('id, code, project_id, client_id, seller_client_id, agreed_price, notary_completed_at')
        .in('id', saleIds)
    : { data: [], error: null }
  if (salesRes.error) throw new Error(`fetchMyCommissionLedger sales: ${salesRes.error.message}`)
  const sales = salesRes.data || []
  const clientIds = [...new Set(sales.flatMap((s) => [s.client_id, s.seller_client_id]).filter(Boolean))]
  const projectIds = [...new Set(sales.map((s) => s.project_id).filter(Boolean))]
  const [clientsRes, projectsDetailRes] = await Promise.all([
    clientIds.length
      ? db().from('clients').select('id, full_name, code, phone').in('id', clientIds)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length
      ? db().from('projects').select('id, title, city').in('id', projectIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (clientsRes.error) throw new Error(`fetchMyCommissionLedger clients: ${clientsRes.error.message}`)
  if (projectsDetailRes.error) throw new Error(`fetchMyCommissionLedger projects: ${projectsDetailRes.error.message}`)

  const saleById = new Map(sales.map((s) => [s.id, s]))
  const clientById = new Map((clientsRes.data || []).map((c) => [c.id, c]))
  const projectById = new Map((projectsDetailRes.data || []).map((p) => [p.id, p]))

  const mappedEvents = events.map((ev) => {
    const sale = saleById.get(ev.sale_id) || null
    const project = sale ? projectById.get(sale.project_id) : null
    const seller = sale ? clientById.get(sale.seller_client_id) : null
    const buyer = sale ? clientById.get(sale.client_id) : null
    return {
      kind: 'commission',
      id: ev.id,
      level: Number(ev.level) || 0,
      amount: Number(ev.amount) || 0,
      status: ev.status || 'pending',
      createdAt: ev.created_at || null,
      sale: sale ? {
        id: sale.id,
        code: sale.code,
        agreedPrice: Number(sale.agreed_price) || 0,
        notaryCompletedAt: sale.notary_completed_at || null,
      } : null,
      project: project ? { id: project.id, title: project.title, city: project.city } : null,
      seller: seller ? { id: seller.id, name: seller.full_name || seller.code, phone: seller.phone || '' } : null,
      buyer: buyer ? { id: buyer.id, name: buyer.full_name || buyer.code, phone: buyer.phone || '' } : null,
    }
  })
  // Merge commission events + payout requests and sort by date (newest first).
  const merged = [...mappedEvents, ...payoutRequests]
  merged.sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime()
    const tb = new Date(b.createdAt || 0).getTime()
    return tb - ta
  })
  return merged
}

export async function requestAmbassadorPayout(amount, idempotencyKey = null) {
  const payload = { p_amount: amount }
  if (idempotencyKey != null) payload.p_idempotency_key = idempotencyKey
  const { data, error } = await supabase.rpc('request_ambassador_payout', payload)
  if (error) throw error
  return data
}

/* ═══════════════════════════════════════════════════════════
   AUDIT LOG
   ═══════════════════════════════════════════════════════════ */

function mapAuditFromDb(a) {
  const createdAt = a.created_at || ''
  return {
    id: a.id,
    date: a.created_at,
    createdAt,
    user: a.actor_email || '',
    actorUserId: a.actor_user_id || '',
    subjectUserId: a.subject_user_id || '',
    action: a.action,
    entity: a.entity,
    entityId: a.entity_id || '',
    details: a.details || '',
    metadata: a.metadata || {},
    severity: a.severity || 'info',
    category: a.category || 'business',
    source: a.source || 'database',
  }
}

export async function fetchAuditLog(limit = 5000) {
  const n = Math.min(Math.max(Number(limit) || 5000, 1), 20000)
  const res = await db().from('audit_logs').select('*').order('created_at', { ascending: false }).limit(n)
  return throwIfError(res, 'auditLog').map(mapAuditFromDb)
}

export async function appendAuditEntry(entry) {
  const row = {
    actor_user_id: entry.actorUserId || null,
    actor_email: entry.actorEmail || entry.user || '',
    action: entry.action || '',
    entity: entry.entity || '',
    entity_id: entry.entityId || '',
    details: entry.details || '',
    metadata: entry.metadata || {},
    severity: entry.severity || 'info',
    category: entry.category || 'business',
    source: entry.source || 'admin_ui',
    subject_user_id: entry.subjectUserId || null,
  }
  const res = await db().from('audit_logs').insert(row)
  throwIfError(res, 'appendAudit')
}

let appendClientAuditRpcMissingNotified = false

/** Best-effort session/auth rows for authenticated users (RPC bypasses admin-only RLS). */
export async function appendClientAuditEvent(opts = {}) {
  try {
    const { error } = await supabase.rpc('append_client_audit', {
      p_action: opts.action || 'client_event',
      p_entity: opts.entity || 'session',
      p_entity_id: opts.entityId != null ? String(opts.entityId) : '',
      p_details: opts.details || '',
      p_metadata: opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : {},
      p_severity: opts.severity || 'info',
      p_category: opts.category || 'auth',
    })
    if (!error) return
    const msg = String(error.message || '')
    const missingFn = /could not find the function|schema cache|404/i.test(msg)
    if (missingFn) {
      if (!appendClientAuditRpcMissingNotified && typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
        appendClientAuditRpcMissingNotified = true
        console.info(
          '[appendClientAuditEvent] RPC append_client_audit absent — appliquer les fonctions RPC côté Supabase ou utiliser database/schema.sql comme référence (messages suivants masqués).'
        )
      }
      return
    }
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      console.warn('[appendClientAuditEvent]', msg)
    }
  } catch {
    /* ignore */
  }
}

/* ═══════════════════════════════════════════════════════════
   VERIFICATION / DATA ACCESS REQUESTS
   ═══════════════════════════════════════════════════════════ */

function mapVerificationFromDb(v) {
  return {
    id: v.id,
    userId: v.user_id || '',
    userEmail: v.user_email || '',
    userName: v.user_name || '',
    requestedCin: v.requested_cin || '',
    idDocumentUrl: v.id_document_url || '',
    status: v.status || 'pending',
    reviewerId: v.reviewer_id || '',
    reviewerNote: v.reviewer_note || '',
    createdAt: v.created_at,
    reviewedAt: v.reviewed_at || '',
  }
}

function mapPhoneVerificationFromDb(v) {
  return {
    id: v.id,
    userId: v.user_id || '',
    userEmail: v.user_email || '',
    userName: v.user_name || '',
    requestedPhone: v.requested_phone || '',
    status: v.status || 'pending',
    reviewerId: v.reviewer_id || '',
    reviewerNote: v.reviewer_note || '',
    createdAt: v.created_at,
    reviewedAt: v.reviewed_at || '',
    verifiedAt: v.verified_at || '',
  }
}

export async function fetchVerificationRequests() {
  const res = await db().from('data_access_requests').select('*').order('created_at', { ascending: false })
  const rows = throwIfError(res, 'verification').map(mapVerificationFromDb)
  return dedupeVerificationRequestsByUserAndCin(rows)
}

export async function fetchPhoneVerificationRequests() {
  const res = await db().from('phone_access_requests').select('*').order('created_at', { ascending: false })
  return throwIfError(res, 'phoneVerification').map(mapPhoneVerificationFromDb)
}

export async function adminApprovePhoneRequestAndLink(requestId, reviewerNote = '') {
  const rpcRes = await db().rpc('admin_approve_phone_request_and_link', {
    p_request_id: requestId,
    p_reviewer_note: reviewerNote || '',
  })
  if (rpcRes.error) throw new Error(rpcRes.error.message || 'admin_approve_phone_request_and_link failed')
  return rpcRes.data || null
}

export async function addVerificationRequest(req) {
  const uid = req.userId
  const cin = String(req.requestedCin || '').trim()
  if (!uid || !cin) return null

  const rpcRes = await db().rpc('upsert_data_access_request', {
    p_cin: cin,
    p_email: req.userEmail || '',
    p_name: req.userName || '',
  })

  if (!rpcRes.error && rpcRes.data) {
    const d = typeof rpcRes.data === 'object' && rpcRes.data !== null ? rpcRes.data : {}
    const action = d.action
    if (action === 'noop_pending' || action === 'noop_approved') return null
    const rowId = d.id
    if (rowId) {
      const res = await db().from('data_access_requests').select('*').eq('id', rowId).maybeSingle()
      if (res.data) return mapVerificationFromDb(throwIfError(res, 'addVerification'))
    }
  }

  const msg = String(rpcRes.error?.message || '')
  const rpcMissing =
    msg.includes('Could not find')
    || msg.includes('function public.upsert_data_access_request')
    || msg.includes('schema cache')
    || msg.includes('PGRST')
  if (!rpcMissing && rpcRes.error) {
    throw new Error(`upsert_data_access_request: ${msg}`)
  }

  // Fallback when RPC is not deployed: insert only if no row exists for this user+CIN (any status).
  const anyRes = await db()
    .from('data_access_requests')
    .select('id')
    .eq('user_id', uid)
    .eq('requested_cin', cin)
    .limit(5)
  const anyRows = throwIfError(anyRes, 'addVerificationAny') || []
  if (anyRows.length > 0) {
    console.warn('[addVerificationRequest] RPC upsert_data_access_request absent — voir database/schema.sql et database/README.txt pour le schéma de base.')
    return null
  }

  const row = {
    user_id: uid,
    user_email: req.userEmail || '',
    user_name: req.userName || '',
    requested_cin: cin,
    id_document_url: req.idDocumentUrl || '',
    status: 'pending',
  }
  const res = await db().from('data_access_requests').insert(row).select().single()
  return mapVerificationFromDb(throwIfError(res, 'addVerification'))
}

export async function fetchCinOwnershipInfo(cin) {
  const normalizedCin = String(cin || '')
  if (!normalizedCin) return null
  const res = await db()
    .from('clients')
    .select('id, full_name, cin, auth_user_id')
    .eq('cin', normalizedCin)
    .limit(1)
    .maybeSingle()
  if (res.error || !res.data) return null
  return {
    clientId: res.data.id,
    clientName: res.data.full_name || '',
    cin: res.data.cin || '',
    authUserId: res.data.auth_user_id || '',
  }
}

export async function fetchPortfolioPreviewByCin(cin) {
  const normalizedCin = String(cin || '')
  if (!normalizedCin) return null

  if (USE_PREVIEW_RPC && Date.now() > PREVIEW_RPC_DISABLED_UNTIL) {
    try {
      const res = await db().rpc('get_portfolio_preview_for_cin', { p_cin: normalizedCin })
      if (!res.error) {
        const row = Array.isArray(res.data) ? res.data[0] : null
        if (!row) return null
        return {
          matched: true,
          requestedCin: row.requested_cin || normalizedCin,
          requestStatus: row.request_status || 'pending',
          parcelsCount: Number(row.parcels_count || 0),
          projectsCount: Number(row.projects_count || 0),
          totalTrees: Number(row.total_trees || 0),
          totalInvested: Number(row.total_invested || 0),
          activePlans: Number(row.active_plans || 0),
        }
      }
      // Prevent noisy repeated POST /rpc errors when SQL function is not deployed yet
      // (PostgREST typically returns 400/404 in this case).
      PREVIEW_RPC_DISABLED_UNTIL = Date.now() + 5 * 60_000
    } catch {
      PREVIEW_RPC_DISABLED_UNTIL = Date.now() + 5 * 60_000
    }
  }

  // Safe fallback when RPC is not yet deployed or temporarily unavailable.
  // Uses current user’s own request row + CIN scoped aggregates.
  const userId = await currentUserId()
  if (!userId) return null

  const reqRes = await db()
    .from('data_access_requests')
    .select('status, requested_cin, created_at')
    .eq('user_id', userId)
    .eq('requested_cin', normalizedCin)
    .order('created_at', { ascending: false })
  const reqRows = throwIfError(reqRes, 'portfolioPreviewFallbackRequest') || []
  const STATUS_PRIORITY = { approved: 0, pending: 1, rejected: 2 }
  const req = reqRows.length
    ? [...reqRows].sort((a, b) => {
        const pa = STATUS_PRIORITY[a.status] ?? 3
        const pb = STATUS_PRIORITY[b.status] ?? 3
        if (pa !== pb) return pa - pb
        return new Date(b.created_at) - new Date(a.created_at)
      })[0]
    : null
  if (!req) return null

  const clientRes = await db()
    .from('clients')
    .select('id')
    .eq('cin', normalizedCin)
    .limit(1)
    .maybeSingle()
  const client = throwIfError(clientRes, 'portfolioPreviewFallbackClient')
  if (!client?.id) return null

  const [salesRes, plansRes] = await Promise.all([
    db().from('sales').select('project_id, parcel_ids, parcel_id, agreed_price').eq('client_id', client.id),
    db().from('installment_plans').select('id, status').eq('client_id', client.id),
  ])
  const sales = throwIfError(salesRes, 'portfolioPreviewFallbackSales') || []
  const plans = throwIfError(plansRes, 'portfolioPreviewFallbackPlans') || []

  const projectIds = [...new Set(sales.map((s) => s.project_id).filter(Boolean))]
  const parcelIds = [...new Set(sales.flatMap((s) => (
    Array.isArray(s.parcel_ids) && s.parcel_ids.length ? s.parcel_ids : (s.parcel_id ? [s.parcel_id] : [])
  )).filter(Boolean))]
  const parcelsRes = parcelIds.length
    ? await db().from('parcels').select('id, tree_count').in('id', parcelIds)
    : { data: [], error: null }
  const parcels = throwIfError(parcelsRes, 'portfolioPreviewFallbackParcels') || []

  return {
    matched: true,
    requestedCin: normalizedCin,
    requestStatus: req.status || 'pending',
    parcelsCount: parcelIds.length,
    projectsCount: projectIds.length,
    totalTrees: parcels.reduce((sum, p) => sum + Number(p.tree_count || 0), 0),
    totalInvested: sales.reduce((sum, s) => sum + Number(s.agreed_price || 0), 0),
    activePlans: plans.filter((p) => p.status === 'active').length,
  }
}

export async function fetchPortfolioPreviewByPhone(phone) {
  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone) return null

  if (USE_PREVIEW_RPC && Date.now() > PREVIEW_RPC_DISABLED_UNTIL) {
    try {
      const res = await db().rpc('get_portfolio_preview_for_phone', { p_phone: normalizedPhone })
      if (!res.error) {
        const row = Array.isArray(res.data) ? res.data[0] : null
        if (!row) return null
        return {
          matched: true,
          requestedPhone: row.requested_phone || normalizedPhone,
          requestStatus: row.request_status || 'pending',
          parcelsCount: Number(row.parcels_count || 0),
          projectsCount: Number(row.projects_count || 0),
          totalTrees: Number(row.total_trees || 0),
          totalInvested: Number(row.total_invested || 0),
          activePlans: Number(row.active_plans || 0),
        }
      }
      // Prevent noisy repeated POST /rpc errors when SQL function is not deployed yet
      // (PostgREST typically returns 400/404 in this case).
      PREVIEW_RPC_DISABLED_UNTIL = Date.now() + 5 * 60_000
    } catch {
      PREVIEW_RPC_DISABLED_UNTIL = Date.now() + 5 * 60_000
    }
  }

  const userId = await currentUserId()
  if (!userId) return null
  const reqRes = await db()
    .from('phone_access_requests')
    .select('status, requested_phone, created_at')
    .eq('user_id', userId)
    .eq('requested_phone', normalizedPhone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const req = throwIfError(reqRes, 'portfolioPreviewPhoneFallbackRequest')
  if (!req) return null

  const clientRes = await db()
    .from('clients')
    .select('id')
    .ilike('phone', `%${normalizedPhone}`)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  let client = null
  try {
    client = throwIfError(clientRes, 'portfolioPreviewPhoneFallbackClient')
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase()
    if (msg.includes('infinite recursion detected in policy for relation "clients"')) {
      // Temporary safeguard when RLS policies are inconsistent in a live environment.
      return null
    }
    throw err
  }
  if (!client?.id) return null

  const [salesRes, plansRes] = await Promise.all([
    db().from('sales').select('project_id, parcel_ids, parcel_id, agreed_price').eq('client_id', client.id),
    db().from('installment_plans').select('id, status').eq('client_id', client.id),
  ])
  const sales = throwIfError(salesRes, 'portfolioPreviewPhoneFallbackSales') || []
  const plans = throwIfError(plansRes, 'portfolioPreviewPhoneFallbackPlans') || []
  const projectIds = [...new Set(sales.map((s) => s.project_id).filter(Boolean))]
  const parcelIds = [...new Set(sales.flatMap((s) => (
    Array.isArray(s.parcel_ids) && s.parcel_ids.length ? s.parcel_ids : (s.parcel_id ? [s.parcel_id] : [])
  )).filter(Boolean))]
  const parcelsRes = parcelIds.length
    ? await db().from('parcels').select('id, tree_count').in('id', parcelIds)
    : { data: [], error: null }
  const parcels = throwIfError(parcelsRes, 'portfolioPreviewPhoneFallbackParcels') || []
  return {
    matched: true,
    requestedPhone: normalizedPhone,
    requestStatus: req.status || 'pending',
    parcelsCount: parcelIds.length,
    projectsCount: projectIds.length,
    totalTrees: parcels.reduce((sum, p) => sum + Number(p.tree_count || 0), 0),
    totalInvested: sales.reduce((sum, s) => sum + Number(s.agreed_price || 0), 0),
    activePlans: plans.filter((p) => p.status === 'active').length,
  }
}

export async function requestPhoneAccessOtp({ phone, userEmail = '', userName = '' }) {
  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone || normalizedPhone.length !== 8) {
    throw new Error('Numéro de téléphone invalide')
  }
  const { data, error } = await db().rpc('request_phone_access_otp', {
    p_phone: normalizedPhone,
    p_email: userEmail,
    p_name: userName,
  })
  if (error) throw new Error(error.message || 'request_phone_access_otp failed')
  return data || null
}

export async function verifyPhoneAccessOtp({ requestId, code }) {
  const cleanCode = String(code || '').trim()
  if (!requestId || cleanCode.length < 4) {
    throw new Error('Code invalide')
  }
  const { data, error } = await db().rpc('verify_phone_access_otp', {
    p_request_id: requestId,
    p_code: cleanCode,
  })
  if (error) throw new Error(error.message || 'verify_phone_access_otp failed')
  return data || null
}

export async function approveDataAccessAndLinkClient(requestId) {
  const rpcRes = await db().rpc('approve_data_access_and_link_client', { p_request_id: requestId })
  if (!rpcRes.error) return rpcRes.data

  const msg = String(rpcRes.error.message || '')
  const missingRpc = /approve_data_access_and_link_client|Could not find the function|404|schema cache|PGRST/i.test(msg)

  if (!ALLOW_APPROVE_LINK_FALLBACK || !missingRpc) {
    throw new Error(`approveDataAccessAndLinkClient: ${msg}`)
  }

  // Compatibility fallback (local dev only): migrations 011/012 not applied.
  const reqRes = await db()
    .from('data_access_requests')
    .select('*')
    .eq('id', requestId)
    .limit(1)
    .maybeSingle()
  const req = throwIfError(reqRes, 'approveDataAccessFallbackRequest')
  if (!req) throw new Error('approveDataAccessAndLinkClient: request_not_found')

  const clientRes = await db()
    .from('clients')
    .select('id, auth_user_id')
    .eq('cin', req.requested_cin)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  const client = throwIfError(clientRes, 'approveDataAccessFallbackClient')

  if (client?.id) {
    const upClient = await db()
      .from('clients')
      .update({ auth_user_id: req.user_id })
      .eq('id', client.id)
    throwIfError(upClient, 'approveDataAccessFallbackLinkClient')
  }

  const reviewerId = await currentUserId()
  const nowIso = new Date().toISOString()
  const approveRes = await db()
    .from('data_access_requests')
    .update({
      status: 'approved',
      reviewer_id: reviewerId,
      reviewed_at: nowIso,
    })
    .eq('id', requestId)
    .select()
    .single()
  const approved = throwIfError(approveRes, 'approveDataAccessFallbackApprove')

  // Mimic RPC behavior: close competing pending requests for same CIN.
  if (req.requested_cin) {
    const closeRes = await db()
      .from('data_access_requests')
      .update({
        status: 'rejected',
        reviewer_id: reviewerId,
        reviewed_at: nowIso,
        reviewer_note: 'Closed automatically: CIN linked to another approved account',
      })
      .eq('requested_cin', req.requested_cin)
      .eq('status', 'pending')
      .neq('id', requestId)
    throwIfError(closeRes, 'approveDataAccessFallbackClosePending')
  }

  // Best-effort audit entry for compatibility path.
  try {
    const actor = await resolveCurrentAdminActor()
    await appendAuditEntry({
      actorUserId: actor.adminId,
      user: actor.email,
      action: 'approve_and_link_cin_access_fallback',
      entity: 'data_access_requests',
      entityId: String(requestId),
      details: 'Approved CIN access and linked client ownership (fallback path)',
      metadata: {
        request_id: requestId,
        requested_cin: req.requested_cin || '',
        client_id: client?.id || null,
      },
      category: 'data_access',
      source: 'admin_ui',
    })
  } catch {
    // ignore audit failures in compatibility path
  }
  return approved
}

export async function approveVerificationRequest(requestId) {
  const reviewerId = await currentUserId()
  const res = await db().from('data_access_requests').update({
    status: 'approved',
    reviewer_id: reviewerId,
    reviewed_at: new Date().toISOString(),
  }).eq('id', requestId).select().single()
  const row = mapVerificationFromDb(throwIfError(res, 'approveVerification'))
  try {
    const actor = await resolveCurrentAdminActor()
    await appendAuditEntry({
      actorUserId: actor.adminId,
      user: actor.email,
      action: 'approve_verification_request',
      entity: 'data_access_requests',
      entityId: String(requestId),
      details: 'Approved identity / data access request',
      metadata: { request_id: requestId, requested_cin: row.requestedCin || '' },
      category: 'data_access',
      source: 'admin_ui',
    })
  } catch {
    /* best-effort */
  }
  return row
}

export async function rejectVerificationRequest(requestId, reason) {
  const reviewerId = await currentUserId()
  const res = await db().from('data_access_requests').update({
    status: 'rejected',
    reviewer_id: reviewerId,
    reviewer_note: reason || '',
    reviewed_at: new Date().toISOString(),
  }).eq('id', requestId).select().single()
  const row = mapVerificationFromDb(throwIfError(res, 'rejectVerification'))
  try {
    const actor = await resolveCurrentAdminActor()
    await appendAuditEntry({
      actorUserId: actor.adminId,
      user: actor.email,
      action: 'reject_verification_request',
      entity: 'data_access_requests',
      entityId: String(requestId),
      details: String(reason || '').slice(0, 500) || 'Rejected data access request',
      metadata: { request_id: requestId, requested_cin: row.requestedCin || '' },
      category: 'data_access',
      source: 'admin_ui',
      severity: 'warning',
    })
  } catch {
    /* best-effort */
  }
  return row
}

function mapUserNotificationFromDb(r) {
  return {
    id: r.id,
    type: r.type,
    payload: r.payload || {},
    readAt: r.read_at,
    createdAt: r.created_at,
    roleScope: r.role_scope,
  }
}

export async function fetchUserNotifications({ roleScope = 'investor', limit = 50 } = {}) {
  const uid = await currentUserId()
  if (!uid) return []
  const res = await db()
    .from('user_notifications')
    .select('id, type, payload, read_at, created_at, role_scope')
    .eq('user_id', uid)
    .eq('role_scope', roleScope)
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (res.error) {
    const m = String(res.error.message || '')
    if (m.includes('does not exist') || res.error.code === '42P01' || m.includes('schema cache')) {
      return []
    }
    throw new Error(`fetchUserNotifications: ${m}`)
  }
  return (res.data || []).map(mapUserNotificationFromDb)
}

export async function markUserNotificationRead(id) {
  const uid = await currentUserId()
  if (!uid) return null
  const res = await db()
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', uid)
    .select()
    .maybeSingle()
  if (res.error) {
    const m = String(res.error.message || '')
    if (m.includes('does not exist') || res.error.code === '42P01') return null
    throw new Error(`markUserNotificationRead: ${m}`)
  }
  return res.data
}

/* ═══════════════════════════════════════════════════════════
   HEALTH REPORTS
   ═══════════════════════════════════════════════════════════ */

const DEFAULT_HEALTH = {
  treeSante: 95, santeLabel: 'Excellent',
  humidity: 65, humidityLabel: 'Optimale',
  nutrients: 80, nutrientsLabel: 'Equilibres',
  co2: 4.2, co2Trend: [1.8, 2.4, 2.9, 3.4, 3.8, 4.2],
  lastWatering: { pct: 70, info: '2 heures' },
  lastDrone: { pct: 15, info: '10 jours' },
  nextAction: '"Arrosage automatise (0.5 L)" dans 4 heures',
}

function mapHealthFromDb(h) {
  return {
    id: h.id,
    projectId: h.project_id,
    parcelId: h.parcel_id,
    treeSante: Number(h.tree_health_pct || 95),
    humidity: Number(h.humidity_pct || 65),
    nutrients: Number(h.nutrients_pct || 80),
    co2: Number(h.co2_tons || 0),
    statusLabel: h.status_label || '',
    nextAction: h.next_action || '',
  }
}

export async function fetchHealthReports() {
  const res = await db().from('project_health_reports').select('*')
  return throwIfError(res, 'health').map(mapHealthFromDb)
}

export async function getPlotHealthReport(projectId, parcelId) {
  if (parcelId) {
    const res = await db().from('project_health_reports')
      .select('*').eq('project_id', projectId).eq('parcel_id', parcelId).maybeSingle()
    if (res.data) return mapHealthFromDb(res.data)
  }
  const res = await db().from('project_health_reports')
    .select('*').eq('project_id', projectId).is('parcel_id', null).maybeSingle()
  if (res.data) return mapHealthFromDb(res.data)
  return DEFAULT_HEALTH
}

export async function upsertHealthReport(report) {
  const row = {
    project_id: report.projectId,
    parcel_id: report.parcelId || null,
    tree_health_pct: report.treeSante || 95,
    humidity_pct: report.humidity || 65,
    nutrients_pct: report.nutrients || 80,
    co2_tons: report.co2 || 0,
    status_label: report.statusLabel || '',
    next_action: report.nextAction || '',
  }
  if (report.id) {
    const res = await db().from('project_health_reports').update(row).eq('id', report.id).select().single()
    return mapHealthFromDb(throwIfError(res, 'updateHealth'))
  }
  const res = await db().from('project_health_reports').insert(row).select().single()
  return mapHealthFromDb(throwIfError(res, 'insertHealth'))
}

/* ───── 48-hour reservation expiry ───── */

export async function expirePendingSalesReservations(limit = 500) {
  const { data, error } = await supabase.rpc('expire_pending_sales_reservations', { p_limit: limit })
  if (error) throw new Error(`expire_pending_sales_reservations: ${error.message}`)
  return data
}

export async function fetchWorkflowIntegritySummary() {
  const [salesRes, aptRes, eventRes] = await Promise.all([
    db().from('sales').select('id, status, finance_confirmed_at, stamped_at'),
    db().from('appointments').select('id, sale_id, notes, type, status'),
    db().from('sale_reservation_events').select('sale_id, from_status, to_status, event_type, created_at').eq('event_type', 'status_change'),
  ])
  const sales = throwIfError(salesRes, 'workflowIntegritySales') || []
  const appointments = throwIfError(aptRes, 'workflowIntegrityAppointments') || []
  const events = throwIfError(eventRes, 'workflowIntegrityEvents') || []

  const saleIds = new Set(sales.map((s) => String(s.id)))
  const opsTypes = new Set(['finance', 'legal_signature', 'juridique'])
  const opsAppointments = appointments.filter((a) => opsTypes.has(String(a.type || '')))
  const orphanAppointments = opsAppointments.filter((a) => !a.sale_id || !saleIds.has(String(a.sale_id)))

  const allowedTransitions = new Set([
    'draft->pending_finance',
    'pending->pending_finance',
    'pending_finance->pending_legal',
    'pending_legal->active',
    'pending_legal->completed',
    'active->completed',
  ])
  const invalidStatusJumps = events.filter((e) => {
    const from = String(e.from_status || '')
    const to = String(e.to_status || '')
    if (!from || !to || from === to) return false
    return !allowedTransitions.has(`${from}->${to}`)
  })

  const appointmentsBySale = new Map()
  for (const apt of opsAppointments) {
    const sid = String(apt.sale_id || '')
    if (!sid) continue
    if (!appointmentsBySale.has(sid)) appointmentsBySale.set(sid, [])
    appointmentsBySale.get(sid).push(apt)
  }
  const financeConfirmedWithoutLegalMilestone = sales.filter((s) => {
    if (!s.finance_confirmed_at) return false
    if (s.stamped_at) return false
    const list = appointmentsBySale.get(String(s.id)) || []
    return !list.some((a) => a.type === 'legal_signature' || a.type === 'juridique')
  })

  return {
    orphanAppointments: orphanAppointments.length,
    invalidStatusJumps: invalidStatusJumps.length,
    financeConfirmedWithoutLegalMilestone: financeConfirmedWithoutLegalMilestone.length,
  }
}

export { DEFAULT_HEALTH }

/**
 * Fetches everything the admin commission tracker needs in one trip.
 * Staff-only (RLS). Returns { commissionEvents, clients, sellerRelations, sales }.
 */
export async function fetchCommissionTrackerData() {
  const [ceRes, clRes, srRes, saRes, prRes] = await Promise.all([
    db().from('commission_events').select('id, beneficiary_client_id, sale_id, level, amount, status, rule_snapshot, created_at').order('created_at', { ascending: false }),
    db().from('clients').select('id, code, full_name, email, phone, phone_normalized, referred_by_client_id, status'),
    db().from('seller_relations').select('id, child_client_id, parent_client_id, source_sale_id, linked_at'),
    db().from('sales').select('id, code, client_id, seller_client_id, project_id, agreed_price, notary_completed_at, status').not('notary_completed_at','is', null).order('notary_completed_at', { ascending: false }),
    db().from('projects').select('id, title, city'),
  ])
  if (ceRes.error) throw new Error(`commission_events: ${ceRes.error.message}`)
  if (clRes.error) throw new Error(`clients: ${clRes.error.message}`)
  if (srRes.error) throw new Error(`seller_relations: ${srRes.error.message}`)
  if (saRes.error) throw new Error(`sales: ${saRes.error.message}`)
  if (prRes.error) throw new Error(`projects: ${prRes.error.message}`)
  return {
    commissionEvents: ceRes.data || [],
    clients: clRes.data || [],
    sellerRelations: srRes.data || [],
    sales: saRes.data || [],
    projects: prRes.data || [],
  }
}
