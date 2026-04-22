import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useCountUp } from '../hooks/useCountUp.js'
import { useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { useAuth } from '../lib/AuthContext.jsx'


import { supabase } from '../lib/supabase.js'
import {
  useAmbassadorReferralSummary,
  useInstallmentsScoped,
  useMyCommissionLedger,
  useProjectsScoped,
  useSalesBySellerClientId,
  useSalesScoped,
} from '../lib/useSupabase.js'
import {
  addInstallmentReceiptRecord,
  fetchMyPhoneChangeRequest,
  requestAmbassadorPayout,
  submitPhoneChangeRequest,
  updatePaymentStatus,
  uploadInstallmentReceipt,
} from '../lib/db.js'
import * as instMetrics from '../domain/installmentMetrics.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import ErrorPanel from '../components/ErrorPanel.jsx'
import MyReferralTree from '../components/MyReferralTree.jsx'
import './dashboard-page.css'
import './installments-page.css'

const REVENUE_PER_TREE = 90
const MAX_IMAGE_DIMENSION = 1600
const IMAGE_QUALITY = 0.76
// Receipts are phone camera shots of bank slips — after webp compression at
// 1600px/0.76 quality a typical receipt lands around 200–900 KB. The old
// 450 KB cap rejected a lot of legitimate photos silently from the dashboard
// submit flow, leaving users unable to send their receipts. 2 MB is a safe
// ceiling that still protects storage while accepting real-world images.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_NON_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}
function ipStatusMeta(status) {
  if (status === 'approved') return { label: 'Confirmé', hint: 'Paiement validé par l\'administration.', tone: 'approved' }
  if (status === 'submitted') return { label: 'En révision', hint: 'Reçu envoyé, en attente de validation.', tone: 'submitted' }
  if (status === 'rejected') return { label: 'Rejeté', hint: 'Action requise : corriger et renvoyer.', tone: 'rejected' }
  return { label: 'En attente', hint: 'Vous pouvez envoyer le reçu.', tone: 'pending' }
}
function isPayable(status) { return status === 'pending' || status === 'rejected' || status === 'submitted' }

function isImageUrl(url) { if (!url) return false; try { return IMAGE_EXT_RE.test(new URL(url).pathname) } catch { return IMAGE_EXT_RE.test(url) } }
function lastReceipt(payment) {
  if (Array.isArray(payment.receipts) && payment.receipts.length > 0) { const r = payment.receipts[0]; return { url: r.url, name: r.fileName || 'reçu', date: r.createdAt } }
  if (payment.receiptUrl && String(payment.receiptUrl).startsWith('http')) return { url: payment.receiptUrl, name: payment.fileName || 'reçu', date: null }
  return null
}
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => { const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => { URL.revokeObjectURL(url); resolve(img) }; img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Impossible de lire l\'image')) }; img.src = url })
}
async function optimizeImageFile(file) {
  const img = await loadImageFromFile(file)
  const maxSide = Math.max(img.width, img.height)
  const ratio = maxSide > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / maxSide : 1
  const w = Math.max(1, Math.round(img.width * ratio)), h = Math.max(1, Math.round(img.height * ratio))
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: true }); if (!ctx) throw new Error('Canvas non disponible')
  ctx.drawImage(img, 0, 0, w, h)
  const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', IMAGE_QUALITY))
  if (!blob) throw new Error('Échec compression image')
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'receipt'}.webp`, { type: 'image/webp' })
}

function saleInInvestorPortfolio(s) {
  // Business rule: client portfolio exposes only finalized ownership.
  // A sale is visible only when BOTH status and notary completion are set.
  const statusOk = String(s?.status || '').toLowerCase() === 'completed'
  const notaryOk = Boolean(s?.notaryCompletedAt)
  return statusOk && notaryOk
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const {
    user,
    ready,
    adminUser,
    clientProfile,
    profileStatus,
    logout,
    refreshAuth,
  } = useAuth()

  const displayName = adminUser?.name || user?.firstname || user?.name || 'Investisseur'

  // Plan 04 §3.1 — pass the resolved clientId into every scoped hook.
  // `ready && clientProfile?.id` ensures we never fire fetches while
  // AuthContext is still resolving, and the hooks' null-guards short
  // circuit (loading=false + empty) when `clientId` is null so no
  // section is ever pinned on an initial-mount spinner. The in-component
  // `heal_my_client_profile_now` effect has been removed — heal is now
  // owned by RequireCustomerAuth + AuthContext (plan 04 §3.3 / §5).
  //
  // 2026-04 fix — useSalesScoped / useInstallmentsScoped distinguish:
  //     clientId === null → "still resolving, keep skeleton"
  //     clientId === ''   → "explicit empty, show empty state"
  // When the server-side heal RPC fails (e.g. the clients_code_key
  // collision we just patched in 03_functions.sql) or the admin has no
  // buyer profile, `ready` flips to true but `clientProfile` stays null.
  // The old code left `clientId = null`, which pinned every scoped hook
  // on a permanent skeleton. Map those terminal states to `''` so the
  // dashboard renders the empty state immediately instead of loading forever.
  const terminalProfileReason = profileStatus?.reason
  const profileResolutionFinalized =
    Boolean(terminalProfileReason) &&
    ['rpc_error', 'ambiguous_client_profile', 'phone_conflict', 'admin_no_buyer_profile', 'not_authenticated'].includes(
      terminalProfileReason,
    )
  const clientId =
    ready
      ? (clientProfile?.id || (profileResolutionFinalized ? '' : null))
      : null

  const { sales: mySalesRaw, loading: salesLoading } = useSalesScoped({ clientId })
  const { plans: myPlans, loading: plansLoadingRaw, refresh: refreshPlans } = useInstallmentsScoped({ clientId })
  const { sales: ambassadorSales } = useSalesBySellerClientId(clientId || '')
  const showAmbassadorCard = Boolean(clientId)
  const { summary: referralSummary, loading: referralLoading, refresh: refreshReferralSummary } =
    useAmbassadorReferralSummary(showAmbassadorCard)
  // PLAN 02 §14 — migrated from boolean form to canonical {clientId, enabled}.
  const { events: myCommissionEvents, loading: ledgerLoading, refresh: refreshCommissionLedger } = useMyCommissionLedger({ clientId: clientId || null, enabled: Boolean(clientId) })
  // The hook's own withTimeout (8s) already resolves loading=false on failure,
  // so no external watchdog is needed. Older 30s timer caused extra renders.
  const referralHasError = referralSummary?.reason === 'rpc_error'
  const [payoutBusy, setPayoutBusy] = useState(false)
  const [payoutError, setPayoutError] = useState('')
  const payoutIdempotencyRef = useRef(null)
  const [payoutConfirmOpen, setPayoutConfirmOpen] = useState(false)
  // Hybrid rule: staff / Super Admin can ALSO buy. The buyer portfolio is
  // visible whenever a clientProfile has resolved (clientId present); the
  // per-sale filter below excludes sales where the current user is the seller
  // or ambassador, so hybrid accounts never see their own sell-side work here.
  const portfolioAllowed = Boolean(clientId)
  // Single-pass filter: combine the cancelled/rejected + seller-bound guards
  // and split into investor vs in-progress buckets in one walk. Prior code
  // made three separate passes + two dependent memos.
  const { mySalesAll, mySales, mySalesInProgress } = useMemo(() => {
    if (!portfolioAllowed) {
      return { mySalesAll: [], mySales: [], mySalesInProgress: [] }
    }
    const clientIdStr = clientId ? String(clientId) : ''
    const all = []
    const investor = []
    const inProgress = []
    for (const s of mySalesRaw || []) {
      if (s.status === 'cancelled' || s.status === 'rejected') continue
      if (clientIdStr) {
        const sellerBound =
          String(s.ambassadorClientId || '') === clientIdStr ||
          String(s.sellerClientId || '') === clientIdStr
        if (sellerBound) continue
      }
      all.push(s)
      if (saleInInvestorPortfolio(s)) investor.push(s)
      else inProgress.push(s)
    }
    return { mySalesAll: all, mySales: investor, mySalesInProgress: inProgress }
  }, [mySalesRaw, portfolioAllowed, clientId])

  // Indexed lookup so per-plan .find() over mySalesRaw becomes O(1) inside
  // the renderer below (the plan list re-runs this on every render).
  const saleByIdMap = useMemo(() => {
    const m = new Map()
    for (const s of mySalesRaw || []) m.set(String(s.id), s)
    return m
  }, [mySalesRaw])
  const scopedProjectIds = useMemo(
    () => [...new Set((mySalesAll || []).map((s) => s.projectId).filter(Boolean))],
    [mySalesAll]
  )
  const { projects: allProjects, loading: projectsLoading, refresh: refreshProjects } = useProjectsScoped(scopedProjectIds)
  // Plan 04 §3.1 — the old `portfolioLoading` aggregate boolean has been
  // dropped: a single stalled sub-hook no longer pins the whole page.
  // Each section below owns its own RenderDataGate + watchdog so
  // independent stores recover independently.
  //
  // 2026-04 fix — previously gated on `(salesLoading || projectsLoading) && mySalesAll.length === 0`.
  // That pinned the skeleton whenever the GLOBAL projects cache (populated
  // by useProjects()) was still warming up on first mount, even though the
  // sales fetch had already returned. Users with no sales stared at a
  // shimmer for up to 8–16s (fetch timeout + one retry) before the empty
  // state appeared. We now clear the gate as soon as sales resolves — if
  // `myPurchases` ends up empty, RenderDataGate renders the empty state;
  // if projects data lands later, React re-renders the list in place.
  const portfolioLoading = Boolean(clientId) && salesLoading && mySalesAll.length === 0
  // Kept for downstream consumers that still want to show a subtle "syncing…"
  // hint while projects catch up — does NOT block the portfolio render.
  void projectsLoading

  const { myPurchases } = useMemo(() => {
    // Pre-index projects and plots once to avoid O(n·m·k) nested .find()
    // inside the per-sale loop (was up to ~20k lookups on larger accounts).
    const projectsById = new Map()
    const plotsByKey = new Map()
    for (const p of allProjects || []) {
      projectsById.set(p.id, p)
      for (const pl of p.plots || []) {
        plotsByKey.set(`${p.id}:${pl.id}`, pl)
      }
    }
    const flat = []
    for (const sale of mySales) {
      const proj = projectsById.get(sale.projectId)
      const plotIds = Array.isArray(sale.plotIds) ? sale.plotIds : (sale.plotId ? [sale.plotId] : [])
      for (const pid of plotIds) {
        const plot =
          plotsByKey.get(`${sale.projectId}:${pid}`) ||
          plotsByKey.get(`${sale.projectId}:${Number(pid)}`)
        const trees = plot?.trees || 0
        const invested = plot?.totalPrice || 0
        const annualRevenue = trees * REVENUE_PER_TREE
        flat.push({
          saleId: sale.id,
          projectId: sale.projectId,
          plotId: pid,
          city: proj?.city || '',
          region: proj?.region || '',
          projectTitle: proj?.title || sale.projectId,
          trees,
          invested,
          annualRevenue,
          mapUrl: plot?.mapUrl || '',
          status: sale.status,
          createdAt: sale.createdAt,
        })
      }
    }
    return { myPurchases: flat }
  }, [mySales, allProjects])

  const ambassadorReferralRows = useMemo(() => {
    if (!clientId) return []
    return (ambassadorSales || []).filter(
      (s) => s.status !== 'cancelled' && s.status !== 'rejected' && saleInInvestorPortfolio(s),
    )
  }, [clientId, ambassadorSales])

  const referralLevelsExposed = useMemo(
    () => (ambassadorReferralRows || []).some((r) => r && r.level != null),
    [ambassadorReferralRows],
  )
  const referralDirectCount = useMemo(
    () => (ambassadorReferralRows || []).filter((r) => r && (r.level === 1 || !r.level)).length,
    [ambassadorReferralRows],
  )
  const referralIndirectCount = useMemo(
    () => (ambassadorReferralRows || []).filter((r) => r && r.level && r.level !== 1).length,
    [ambassadorReferralRows],
  )

  /*
   * Parrainage forecast:
   *
   *   Count distinct filleuls from ambassadorReferralRows and estimate what
   *   the user would earn if each filleul closed one more parcel at 85 000 DT.
   *   Per-level "rule amount" is inferred from the first existing commission
   *   event at each level (they all share the same rule on the backend today).
   *   If no events exist yet, we can't reliably estimate → hide the widget.
   */
  const PARRAINAGE_SAMPLE_PARCEL_PRICE = 85000
  const parrainageFilleulCount = useMemo(() => {
    const set = new Set()
    for (const row of ambassadorReferralRows || []) {
      const bid = row?.clientId || row?.buyerClientId || row?.buyerId
      if (bid != null) set.add(String(bid))
    }
    return set.size
  }, [ambassadorReferralRows])
  const parrainageLevelRules = useMemo(() => {
    const byLevel = new Map()
    for (const ev of myCommissionEvents || []) {
      if (ev?.kind === 'payout') continue
      const lvl = Number(ev?.level || 0)
      if (!lvl) continue
      const amt = Number(ev?.amount || 0)
      if (!amt) continue
      if (!byLevel.has(lvl)) byLevel.set(lvl, amt)
    }
    return byLevel
  }, [myCommissionEvents])
  const parrainageForecast = useMemo(() => {
    if (!showAmbassadorCard) return null
    if (!parrainageFilleulCount) return null
    if (parrainageLevelRules.size === 0) return null
    const l1PerSale = parrainageLevelRules.get(1) || 0
    const l2PerSale = parrainageLevelRules.get(2) || 0
    const currentLifetime = Number(referralSummary?.l1Total ?? 0) + Number(referralSummary?.l2Total ?? 0)
    const potentialPerFilleul = l1PerSale + l2PerSale
    const potentialTotal = parrainageFilleulCount * potentialPerFilleul
    if (potentialTotal <= 0) return null
    return {
      filleulCount: parrainageFilleulCount,
      parcelPrice: PARRAINAGE_SAMPLE_PARCEL_PRICE,
      l1PerSale,
      l2PerSale,
      potentialPerFilleul,
      potentialTotal,
      currentLifetime,
    }
  }, [showAmbassadorCard, parrainageFilleulCount, parrainageLevelRules, referralSummary])

  const referralVerificationBlocked =
    referralSummary?.identityVerificationBlocked === true

  const referralSummaryIssueMessage = useMemo(() => {
    if (!referralSummary) return ''
    if (referralSummary.ambiguous) {
      return 'Profil client ambigu détecté — le portefeuille affiché peut ne pas refléter l\'intégralité de vos commissions. Contactez le support.'
    }
    if (referralSummary.ok) return ''
    const r = referralSummary.reason
    // Transient / expected states — no banner.
    if (r === 'pending' || r === 'not_enabled') return ''
    if (referralSummary.errorMessage && r !== 'rpc_error') return referralSummary.errorMessage
    if (r === 'ambiguous_client_profile') return 'Profil client ambigu — contactez le support.'
    if (r === 'no_client_profile') return 'Profil client introuvable pour ce compte.'
    if (r === 'not_authenticated') return 'Connexion requise pour afficher le portefeuille.'
    if (r === 'supabase_not_configured') return 'Connexion base de données indisponible.'
    if (r === 'rpc_error') return 'Impossible de charger le portefeuille pour le moment — réessayez dans un instant.'
    return r ? `État portefeuille: ${r}` : ''
  }, [referralSummary])

  const handleAmbassadorPayout = useCallback(async () => {
    const bal = referralSummary?.walletBalance ?? 0
    const min = referralSummary?.minPayoutAmount ?? 0
    if (referralVerificationBlocked) {
      setPayoutError("Vérification d'identité requise avant tout retrait bancaire.")
      return
    }
    if (bal <= 0) {
      setPayoutError('Aucun gain disponible à retirer pour le moment.')
      return
    }
    if (bal < min) {
      setPayoutError(`Seuil minimum non atteint (${min.toLocaleString('fr-FR')} DT).`)
      return
    }
    if (!payoutIdempotencyRef.current) payoutIdempotencyRef.current = crypto.randomUUID()
    const idem = payoutIdempotencyRef.current
    setPayoutBusy(true)
    setPayoutError('')
    try {
      await requestAmbassadorPayout(bal, idem)
      payoutIdempotencyRef.current = null
      await refreshReferralSummary({ force: true })
      setPayoutConfirmOpen(false)
    } catch (e) {
      setPayoutError(e?.message || 'Erreur')
    } finally {
      setPayoutBusy(false)
    }
  }, [referralSummary, refreshReferralSummary, referralVerificationBlocked])

  const [activeTab, setActiveTab] = useState('portfolio')

  /*
   * Real-time parrainage subscriptions.
   *
   *   While the Parrainage tab is mounted AND the buyer has a clientProfile,
   *   subscribe to commission_events and commission_payout_requests filtered
   *   to this beneficiary. Any server-side event (new commission credited,
   *   payout status flip) triggers a refresh of both the referral summary
   *   (wallet totals) and the commission ledger (per-event cards). The hooks
   *   themselves keep their own global subscriptions; these scoped filters
   *   catch mutations faster for the currently viewed client.
   */
  // Stable refs for the refresh callbacks so the realtime channel is not
  // torn down + resubscribed every time the useCallback identities change
  // (they change on any parent re-render — previously caused a resubscribe
  // storm and missed events during each ~300ms reconnect window).
  const refreshReferralSummaryRef = useRef(refreshReferralSummary)
  const refreshCommissionLedgerRef = useRef(refreshCommissionLedger)
  useEffect(() => { refreshReferralSummaryRef.current = refreshReferralSummary }, [refreshReferralSummary])
  useEffect(() => { refreshCommissionLedgerRef.current = refreshCommissionLedger }, [refreshCommissionLedger])

  useEffect(() => {
    if (activeTab !== 'parrainage') return undefined
    const beneficiaryId = clientProfile?.id
    if (!beneficiaryId) return undefined
    const filter = `beneficiary_client_id=eq.${beneficiaryId}`
    const reactEvent = () => {
      try { refreshReferralSummaryRef.current?.() } catch { /* noop */ }
      try { refreshCommissionLedgerRef.current?.() } catch { /* noop */ }
    }
    const channel = supabase
      .channel(`parrainage-live-${beneficiaryId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_events', filter }, reactEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_payout_requests', filter }, reactEvent)
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [activeTab, clientProfile?.id])

  /*
   * CSV export: flatten myCommissionEvents into a spreadsheet-friendly CSV
   * with a stable column order. Uses only Blob + createObjectURL so no
   * library is needed. Values that may contain separators are quoted with
   * RFC 4180 escaping.
   */
  const handleExportCommissionsCsv = useCallback(() => {
    const rows = Array.isArray(myCommissionEvents) ? myCommissionEvents : []
    if (rows.length === 0) return
    const escape = (value) => {
      if (value == null) return ''
      const str = String(value)
      if (/[",;\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
      return str
    }
    const statusLabels = {
      paid: 'Payé',
      payable: 'À virer',
      pending: 'En attente',
      cancelled: 'Annulé',
      pending_review: 'En revue',
      approved: 'Approuvé',
      rejected: 'Refusé',
    }
    const header = ['Date', 'Niveau', 'Montant DT', 'Statut', 'Type', 'Vendeur', 'Acheteur', 'Projet', 'Code vente']
    const lines = [header.join(';')]
    for (const ev of rows) {
      const isPayout = ev?.kind === 'payout'
      const dateRaw = ev?.createdAt || ev?.sale?.notaryCompletedAt || ev?.paidAt || ev?.reviewedAt || ''
      const dateFr = dateRaw
        ? (() => { try { return new Date(dateRaw).toLocaleDateString('fr-FR') } catch { return String(dateRaw) } })()
        : ''
      const level = isPayout ? '' : (ev?.level ?? '')
      const amountRaw = Number(ev?.amount || 0)
      const amount = (isPayout ? -Math.abs(amountRaw) : amountRaw)
        .toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
      const statusKey = ev?.status || ''
      const status = statusLabels[statusKey] || statusKey
      const type = isPayout ? 'payout' : 'commission'
      const seller = isPayout ? '' : (ev?.seller?.name || '')
      const buyer = isPayout ? '' : (ev?.buyer?.name || '')
      const project = isPayout ? '' : (ev?.project?.title || '')
      const saleCode = isPayout ? (ev?.code || '') : (ev?.sale?.code || '')
      lines.push([dateFr, level, amount, status, type, seller, buyer, project, saleCode].map(escape).join(';'))
    }
    // Prepend UTF-8 BOM so Excel opens the file with accents preserved.
    const csv = '\uFEFF' + lines.join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    const link = document.createElement('a')
    link.href = url
    link.download = `commissions-${stamp}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    // Release the object URL after the download tick completes.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [myCommissionEvents])

  const [focusedPlanId, setFocusedPlanId] = useState(null)
  // Pagination for the focused plan's payments list. Reset to page 1 when
  // switching plans so the user isn't stranded on page 3 of a short plan.
  const IP_PAYMENTS_PER_PAGE = 5
  const [ipPaymentPage, setIpPaymentPage] = useState(1)
  const ipNextDueCardRef = useRef(null)
  const ipScrollPendingRef = useRef(false)
  useLayoutEffect(() => {
    if (!focusedPlanId) {
      ipScrollPendingRef.current = false
      return
    }
    const plan = myPlans.find((p) => p.id === focusedPlanId)
    if (!plan?.payments?.length) return
    setIpPaymentPage(instMetrics.getPaymentPageForNextDue(plan.payments, IP_PAYMENTS_PER_PAGE))
    ipScrollPendingRef.current = true
  }, [focusedPlanId, myPlans])
  useLayoutEffect(() => {
    if (!focusedPlanId || !ipScrollPendingRef.current) return
    ipScrollPendingRef.current = false
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ipNextDueCardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    })
    return () => cancelAnimationFrame(id)
  }, [focusedPlanId, ipPaymentPage])
  const [ipPayTarget, setIpPayTarget] = useState(null)
  const [ipReceiptName, setIpReceiptName] = useState('')
  const [ipReceiptFile, setIpReceiptFile] = useState(null)
  const [ipReceiptPreview, setIpReceiptPreview] = useState('')
  const [ipNote, setIpNote] = useState('')
  const [ipSubmitting, setIpSubmitting] = useState(false)
  const [ipError, setIpError] = useState('')
  useEffect(() => {
    if (!focusedPlanId || ipPayTarget) return
    const onKey = (e) => {
      if (e.key === 'Escape') setFocusedPlanId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedPlanId, ipPayTarget])
  const [showProfile, setShowProfile] = useState(false)
  const [profileForm, setProfileForm] = useState({})
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')

  // Phone-change demande (dashboard-side half of the super-admin flow).
  const [phoneChange, setPhoneChange] = useState({
    open: false,
    newPhone: '',
    reason: '',
    saving: false,
    msg: '',
    request: null, // { id, status, requested_phone, created_at, reviewer_note, ... }
    loading: false,
  })

  const loadMyPhoneChangeRequest = useCallback(async () => {
    try {
      setPhoneChange((p) => ({ ...p, loading: true }))
      const req = await fetchMyPhoneChangeRequest()
      setPhoneChange((p) => ({ ...p, request: req || null, loading: false }))
    } catch (err) {
      console.warn('[dashboard] fetchMyPhoneChangeRequest:', err?.message || err)
      setPhoneChange((p) => ({ ...p, loading: false }))
    }
  }, [])

  useEffect(() => {
    if (showProfile) loadMyPhoneChangeRequest()
  }, [showProfile, loadMyPhoneChangeRequest])

  const handleSubmitPhoneChange = useCallback(async () => {
    const trimmed = String(phoneChange.newPhone || '').trim()
    if (trimmed.length < 6) {
      setPhoneChange((p) => ({ ...p, msg: 'Numéro invalide (6 caractères minimum).' }))
      return
    }
    setPhoneChange((p) => ({ ...p, saving: true, msg: '' }))
    try {
      await submitPhoneChangeRequest({ newPhone: trimmed, reason: phoneChange.reason || '' })
      setPhoneChange((p) => ({ ...p, saving: false, msg: 'Demande envoyée.', newPhone: '', reason: '', open: false }))
      await loadMyPhoneChangeRequest()
    } catch (err) {
      const raw = String(err?.message || err || '')
      let msg = raw
      if (/PHONE_UNCHANGED/i.test(raw)) msg = 'Le nouveau numéro est identique à l\'actuel.'
      else if (/INVALID_PHONE/i.test(raw)) msg = 'Numéro invalide.'
      else if (/NOT_AUTHENTICATED/i.test(raw)) msg = 'Session expirée : reconnectez-vous.'
      setPhoneChange((p) => ({ ...p, saving: false, msg }))
    }
  }, [phoneChange.newPhone, phoneChange.reason, loadMyPhoneChangeRequest])

  const profileFields = useMemo(() => {
    const u = user || {}
    const adm = adminUser || {}
    const nameParts = (adm.name || '').split(/\s+/)
    const admFirst = nameParts.length >= 2 ? nameParts.slice(0, -1).join(' ') : (adm.name || '')
    const admLast = nameParts.length >= 2 ? nameParts[nameParts.length - 1] : ''
    return [
      { key: 'firstname', label: 'Prénom', value: admFirst || u.firstname || '' },
      { key: 'lastname', label: 'Nom', value: admLast || u.lastname || '' },
      { key: 'email', label: 'Email', value: adm.email || u.email || '', locked: true },
      { key: 'phone', label: 'Téléphone', value: adm.phone || u.phone || '' },
    ]
  }, [user, adminUser])

  const openProfile = useCallback(() => {
    const init = {}
    for (const f of profileFields) init[f.key] = f.value
    setProfileForm(init)
    setProfileMsg('')
    setShowProfile(true)
  }, [profileFields])

  const handleProfileSave = useCallback(async () => {
    setProfileSaving(true)
    setProfileMsg('')
    try {
      const meta = {}
      let changed = false
      for (const f of profileFields) {
        if (f.locked) continue
        const original = f.value || ''
        const current = (profileForm[f.key] || '').trim()
        if (!original && current) {
          meta[f.key] = current
          changed = true
        }
      }
      if (!changed) { setProfileMsg('Aucune modification.'); setProfileSaving(false); return }
      if (meta.firstname || meta.lastname) {
        const fn = meta.firstname || profileForm.firstname || ''
        const ln = meta.lastname || profileForm.lastname || ''
        meta.name = `${fn} ${ln}`.trim()
      }
      const { error } = await supabase.auth.updateUser({ data: meta })
      if (error) throw error
      refreshAuth()
      setProfileMsg('Profil mis à jour.')
      setShowProfile(false)
    } catch (e) {
      setProfileMsg(e?.message || 'Erreur.')
    } finally {
      setProfileSaving(false)
    }
  }, [profileFields, profileForm, refreshAuth])

  /* ── Installment handlers (inline) ── */
  const ipHandleReceiptChange = useCallback(async (file) => {
    if (!file) return
    setIpError('')
    let finalFile = file
    if (file.type?.startsWith('image/')) {
      try {
        finalFile = await optimizeImageFile(file)
      } catch {
        // Compression failed (e.g. HEIC on an older browser). Fall back to
        // the raw file so the user can still upload — the storage layer
        // accepts any image/* and the 5 MB non-image ceiling is our net.
        finalFile = file
      }
      if (finalFile.size > MAX_IMAGE_BYTES) throw new Error('Image trop lourde (max 2 Mo après compression). Essayez une photo plus nette ou un PDF.')
    } else if (file.size > MAX_NON_IMAGE_BYTES) throw new Error('Fichier trop volumineux (max 5 Mo)')
    setIpReceiptFile(finalFile)
    if (ipReceiptPreview?.startsWith('blob:')) URL.revokeObjectURL(ipReceiptPreview)
    setIpReceiptName(finalFile.name)
    setIpReceiptPreview(finalFile.type?.startsWith('image/') ? URL.createObjectURL(finalFile) : '')
  }, [ipReceiptPreview])

  const ipOpenPay = useCallback((plan, payment) => {
    setIpPayTarget({ planId: plan.id, month: payment.month, amount: payment.amount, dueDate: payment.dueDate })
    setIpReceiptName(''); setIpReceiptFile(null)
    if (ipReceiptPreview?.startsWith('blob:')) URL.revokeObjectURL(ipReceiptPreview)
    setIpReceiptPreview(''); setIpNote(''); setIpError('')
  }, [ipReceiptPreview])

  const ipClosePay = useCallback(() => {
    setIpPayTarget(null); setIpReceiptName(''); setIpReceiptFile(null)
    if (ipReceiptPreview?.startsWith('blob:')) URL.revokeObjectURL(ipReceiptPreview)
    setIpReceiptPreview(''); setIpNote(''); setIpError('')
  }, [ipReceiptPreview])

  const ipSubmit = useCallback(async () => {
    if (ipSubmitting) return
    if (!ipPayTarget) { setIpError('Aucune mensualité sélectionnée.'); return }
    if (!ipReceiptFile) { setIpError('Veuillez choisir un fichier reçu.'); return }
    setIpSubmitting(true); setIpError('')
    try {
      const plan = myPlans.find(p => p.id === ipPayTarget.planId)
      const payment = plan?.payments?.find(p => p.month === ipPayTarget.month)
      if (!payment?.id) throw new Error('Paiement introuvable')
      const url = await uploadInstallmentReceipt({ paymentId: payment.id, file: ipReceiptFile })
      await addInstallmentReceiptRecord({ paymentId: payment.id, receiptUrl: url || '', fileName: ipReceiptName || ipReceiptFile.name, note: ipNote || '' })
      await updatePaymentStatus(payment.id, 'submitted', { receiptUrl: url || ipReceiptName || ipReceiptFile.name })
      await refreshPlans({ force: true })
      ipClosePay()
    } catch (err) {
      // Surface the underlying Supabase message so the user (and support)
      // can distinguish RLS / storage / network failures instead of the
      // generic "Échec envoi" that was masking real issues from the dashboard.
      const msg = err?.message || 'Échec envoi'
      console.error('[receipt-upload]', err)
      setIpError(msg)
    }
    finally { setIpSubmitting(false) }
  }, [ipPayTarget, ipReceiptName, ipReceiptFile, ipSubmitting, myPlans, ipNote, ipClosePay, refreshPlans])

  const focusedPlan = focusedPlanId ? myPlans.find(p => p.id === focusedPlanId) : null
  const ipStats = useMemo(() => {
    const all = myPlans.flatMap(p => p.payments || [])
    return { total: myPlans.length, submitted: all.filter(p => p.status === 'submitted').length, rejected: all.filter(p => p.status === 'rejected').length, approved: all.filter(p => p.status === 'approved').length }
  }, [myPlans])

  const totalTrees    = myPurchases.reduce((s, p) => s + p.trees, 0)
  const totalInvested = myPurchases.reduce((s, p) => s + p.invested, 0)
  const totalRevenue  = myPurchases.reduce((s, p) => s + p.annualRevenue, 0)
  const roiTarget = useMemo(
    () => (totalInvested > 0 ? (totalRevenue / totalInvested) * 100 : 0),
    [totalInvested, totalRevenue]
  )

  const KPI_COUNT_MS = 1300
  const animTrees = useCountUp(totalTrees, { duration: KPI_COUNT_MS, delay: 0 })
  const animInvested = useCountUp(totalInvested, { duration: KPI_COUNT_MS, delay: 85 })
  const animRevenue = useCountUp(totalRevenue, { duration: KPI_COUNT_MS, delay: 170 })
  const animRoi = useCountUp(roiTarget, { duration: KPI_COUNT_MS, delay: 255 })

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <main className="screen screen--app">
      <section className="inv-dash">
        <TopBar />
        {/* ── Header Card ── */}
        <div className="inv-header">
          <div className="inv-header__top">
            <div className="inv-header__avatar">
              <img
                src={`https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(displayName)}&backgroundColor=7ab020&textColor=0b150c&fontSize=40`}
                alt={displayName}
              />
            </div>
            <div className="inv-header__meta">
              <h2 className="inv-header__name">Bonjour, {displayName}</h2>
              <p className="inv-header__subtitle">Votre portefeuille d&apos;oliviers</p>
            </div>
            <button type="button" className="inv-header__profile-btn" onClick={openProfile} aria-label="Mon profil">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </button>
          </div>
        </div>

        {/* ── Profile Edit Panel ── */}
        {showProfile && (
          <div className="inv-profile">
            <div className="inv-profile__head">
              <h3 className="inv-profile__title">Mon profil</h3>
              <button type="button" className="inv-profile__close" onClick={() => setShowProfile(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="inv-profile__fields">
              {profileFields.map(f => {
                const original = f.value || ''
                const isLocked = f.locked || Boolean(original)
                return (
                  <div key={f.key} className="inv-profile__field">
                    <label className="inv-profile__label">{f.label}</label>
                    <div className="inv-profile__input-wrap">
                      <input
                        type={f.key === 'email' ? 'email' : 'text'}
                        className={`inv-profile__input${isLocked ? ' inv-profile__input--locked' : ''}`}
                        value={profileForm[f.key] ?? f.value}
                        readOnly={isLocked}
                        dir={f.key === 'phone' || f.key === 'email' ? 'ltr' : undefined}
                        placeholder={isLocked ? '' : `Saisir ${f.label.toLowerCase()}…`}
                        onChange={e => !isLocked && setProfileForm(p => ({ ...p, [f.key]: e.target.value }))}
                      />
                      {isLocked && <span className="inv-profile__lock">🔒</span>}
                    </div>
                  </div>
                )
              })}
            </div>
            {profileMsg && <p className="inv-profile__msg">{profileMsg}</p>}
            <button
              type="button"
              className="inv-profile__save"
              onClick={handleProfileSave}
              disabled={profileSaving}
            >
              {profileSaving ? 'Enregistrement…' : 'Enregistrer'}
            </button>

            {/* Phone-change demande. A client cannot edit phone directly —
                they submit a request reviewed by a super admin. */}
            <div className="inv-profile__phone-change">
              <div className="inv-profile__phone-change-header">
                <span className="inv-profile__phone-change-title">
                  Changer le numéro de téléphone
                </span>
                {!phoneChange.open && !phoneChange.request && (
                  <button
                    type="button"
                    className="inv-profile__phone-change-toggle"
                    onClick={() => setPhoneChange((p) => ({ ...p, open: true, msg: '' }))}
                  >
                    Demander un changement
                  </button>
                )}
              </div>

              {phoneChange.request && phoneChange.request.status === 'pending' && (
                <div className="inv-profile__phone-change-status inv-profile__phone-change-status--pending">
                  <strong>Demande en cours</strong>
                  <span>Nouveau numéro : <span dir="ltr">{phoneChange.request.requested_phone}</span></span>
                  <span className="inv-profile__phone-change-note">
                    Un super administrateur examinera votre demande.
                  </span>
                </div>
              )}

              {phoneChange.request && phoneChange.request.status === 'approved' && !phoneChange.open && (
                <div className="inv-profile__phone-change-status inv-profile__phone-change-status--approved">
                  <strong>Dernière demande approuvée</strong>
                  <span>Numéro actuel : <span dir="ltr">{phoneChange.request.requested_phone}</span></span>
                  <button
                    type="button"
                    className="inv-profile__phone-change-toggle"
                    onClick={() => setPhoneChange((p) => ({ ...p, open: true, msg: '' }))}
                  >
                    Nouvelle demande
                  </button>
                </div>
              )}

              {phoneChange.request && phoneChange.request.status === 'rejected' && !phoneChange.open && (
                <div className="inv-profile__phone-change-status inv-profile__phone-change-status--rejected">
                  <strong>Dernière demande refusée</strong>
                  {phoneChange.request.reviewer_note && (
                    <span className="inv-profile__phone-change-note">
                      Motif : {phoneChange.request.reviewer_note}
                    </span>
                  )}
                  <button
                    type="button"
                    className="inv-profile__phone-change-toggle"
                    onClick={() => setPhoneChange((p) => ({ ...p, open: true, msg: '' }))}
                  >
                    Soumettre une nouvelle demande
                  </button>
                </div>
              )}

              {phoneChange.open && (
                <div className="inv-profile__phone-change-form">
                  <label className="inv-profile__label" htmlFor="pc-new-phone">
                    Nouveau numéro
                  </label>
                  <input
                    id="pc-new-phone"
                    type="tel"
                    dir="ltr"
                    className="inv-profile__input"
                    placeholder="+216 XX XXX XXX"
                    value={phoneChange.newPhone}
                    onChange={(e) => setPhoneChange((p) => ({ ...p, newPhone: e.target.value }))}
                  />
                  <label className="inv-profile__label" htmlFor="pc-reason" style={{ marginTop: 8 }}>
                    Motif (optionnel)
                  </label>
                  <textarea
                    id="pc-reason"
                    className="inv-profile__input"
                    rows={2}
                    placeholder="Pourquoi voulez-vous changer de numéro ?"
                    value={phoneChange.reason}
                    onChange={(e) => setPhoneChange((p) => ({ ...p, reason: e.target.value }))}
                  />
                  {phoneChange.msg && (
                    <p className="inv-profile__msg">{phoneChange.msg}</p>
                  )}
                  <div className="inv-profile__phone-change-actions">
                    <button
                      type="button"
                      className="inv-profile__phone-change-cancel"
                      onClick={() => setPhoneChange((p) => ({ ...p, open: false, msg: '' }))}
                      disabled={phoneChange.saving}
                    >
                      Annuler
                    </button>
                    <button
                      type="button"
                      className="inv-profile__phone-change-submit"
                      onClick={handleSubmitPhoneChange}
                      disabled={phoneChange.saving || !phoneChange.newPhone.trim()}
                    >
                      {phoneChange.saving ? 'Envoi…' : 'Envoyer la demande'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Tabs ── */}
        <div className="inv-tabs">
          <button
            type="button"
            className={`inv-tab${activeTab === 'portfolio' ? ' inv-tab--active' : ''}`}
            onClick={() => setActiveTab('portfolio')}
          >
            Mon Portefeuille
          </button>
          <button
            type="button"
            className={`inv-tab${activeTab === 'echeances' ? ' inv-tab--active' : ''}`}
            onClick={() => setActiveTab('echeances')}
          >
            Mes Échéances
          </button>
          <button
            type="button"
            className={`inv-tab${activeTab === 'parrainage' ? ' inv-tab--active' : ''}`}
            onClick={() => setActiveTab('parrainage')}
          >
            Commissions
          </button>
        </div>

        {/* ══════════════════════════════════════
           TAB: Mon Portefeuille
           ══════════════════════════════════════ */}
        {activeTab === 'portfolio' && (
          <>
            <div className="inv-kpi-strip" aria-live="polite">
              <div className="inv-kpi">
                <span className="inv-kpi__value inv-kpi__value--green">
                  {salesLoading ? <span className="sk sk-num" /> : Math.round(animTrees).toLocaleString('fr-FR')}
                </span>
                <span className="inv-kpi__label">Oliviers</span>
              </div>
              <div className="inv-kpi-sep" />
              <div className="inv-kpi">
                <span className="inv-kpi__value">
                  {salesLoading ? <span className="sk sk-num" /> : Math.round(animInvested).toLocaleString('fr-FR')}
                </span>
                <span className="inv-kpi__label">TND investis</span>
              </div>
              <div className="inv-kpi-sep" />
              <div className="inv-kpi">
                <span className="inv-kpi__value inv-kpi__value--green">
                  {salesLoading ? <span className="sk sk-num" /> : Math.round(animRevenue).toLocaleString('fr-FR')}
                </span>
                <span className="inv-kpi__label">TND / an</span>
              </div>
              <div className="inv-kpi-sep" />
              <div className="inv-kpi">
                <span className="inv-kpi__value inv-kpi__value--blue">
                  {salesLoading ? <span className="sk sk-num" /> : `${animRoi.toFixed(1)}%`}
                </span>
                <span className="inv-kpi__label">ROI</span>
              </div>
            </div>

            <h3 className="inv-section-title">Mes parcelles</h3>

            {/* Plan 04 §3.1 — portfolio section gated by RenderDataGate.
                A stalled sales/projects fetch no longer pins the whole
                Dashboard; the skeleton shimmer upgrades to the stuck
                banner after the watchdog and the rest of the page stays
                interactive. */}
            <RenderDataGate
              loading={portfolioLoading}
              error={null}
              data={myPurchases}
              // Show the "Chargement plus long…" retry banner after 4s
              // instead of the 8s default. On real networks the sales
              // fetch resolves in <1s; if we're not back by 4s something
              // is off and the user should get a visible recovery path
              // rather than staring at a shimmer.
              watchdogMs={4000}
              skeleton={() => (
                <div className="inv-parcels" aria-busy="true" aria-live="polite">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="inv-parcel-card">
                      <div className="sk sk-map" />
                      <div className="inv-parcel-card__body">
                        <div className="sk sk-line sk-line--title" />
                        <div className="sk sk-line" />
                        <div className="sk sk-line" style={{ width: '60%' }} />
                        <div className="sk sk-line" style={{ width: '45%' }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              onRetry={() => {
                try { refreshPlans?.() } catch { /* ignore */ }
                try { refreshProjects?.() } catch { /* ignore */ }
              }}
              empty={mySalesInProgress.length > 0 ? (
                <div className="inv-progress-notice">
                  Vous avez {mySalesInProgress.length} achat{mySalesInProgress.length !== 1 ? 's' : ''} en cours de finalisation.
                  Les parcelles s&apos;affichent ici uniquement après <strong>finalisation notaire</strong>.
                </div>
              ) : (
                <EmptyState
                  className="inv-empty-portfolio"
                  icon="🌿"
                  title="Aucune parcelle"
                  description="Vous ne possédez pas encore de parcelles."
                  action={{ label: 'Explorer les projets', onClick: () => navigate('/browse') }}
                  secondary={{ label: 'Se déconnecter', onClick: handleLogout }}
                />
              )}
            >
              {(purchases) => (
                <div className="inv-parcels">
                  {purchases.map((parcel) => {
                  const proj = allProjects.find((p) => p.id === parcel.projectId)
                  const plotForMap = proj?.plots?.find(
                    (pl) => pl.id === parcel.plotId || pl.id === Number(parcel.plotId),
                  )
                  const mapSrc = plotForMap?.mapUrl || parcel.mapUrl
                  const parcelTitle = `Parcelle #${parcel.plotId}`
                  return (
                    <div
                      key={`${parcel.saleId}-${parcel.plotId}`}
                      className="inv-parcel-card"
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/project/${parcel.projectId}/plot/${parcel.plotId}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          navigate(`/project/${parcel.projectId}/plot/${parcel.plotId}`)
                        }
                      }}
                    >
                      {mapSrc && (
                        <div className="inv-parcel-card__map">
                          <iframe title={parcelTitle} src={mapSrc} loading="lazy" tabIndex={-1} />
                        </div>
                      )}
                      <div className="inv-parcel-card__body">
                        <div className="inv-parcel-card__top">
                          <div>
                            <div className="inv-parcel-card__id">{parcelTitle}</div>
                            <div className="inv-parcel-card__project">{parcel.projectTitle}</div>
                          </div>
                          <span className="inv-parcel-card__loc">{parcel.city}</span>
                        </div>
                        <div className="inv-parcel-card__stats">
                          <div className="inv-parcel-card__stat-row">
                            <span className="inv-parcel-card__stat-label">Arbres</span>
                            <strong className="inv-parcel-card__stat-value">{parcel.trees}</strong>
                          </div>
                          <div className="inv-parcel-card__stat-row">
                            <span className="inv-parcel-card__stat-label">Investi</span>
                            <strong className="inv-parcel-card__stat-value">{parcel.invested.toLocaleString()} DT</strong>
                          </div>
                          <div className="inv-parcel-card__stat-row">
                            <span className="inv-parcel-card__stat-label">Revenu/an</span>
                            <strong className="inv-parcel-card__stat-value inv-green">{parcel.annualRevenue.toLocaleString()} DT</strong>
                          </div>
                        </div>
                        <div className="inv-parcel-card__links" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="inv-link-btn"
                            onClick={() => navigate(`/project/${parcel.projectId}/plot/${parcel.plotId}`)}
                          >
                            Détail #{parcel.plotId} →
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
                </div>
              )}
            </RenderDataGate>
          </>
        )}

        {/* ══════════════════════════════════════
           TAB: Mes Échéances (integrated)
           ══════════════════════════════════════ */}
        {activeTab === 'echeances' && (
          <div className="ip ip--embedded">
            <div className="ip__hero ip__hero--embedded">
              <div className="ip__hero-intro">
                <span className="ip__hero-icon" aria-hidden>📅</span>
                <div>
                  <h1 className="ip__hero-title">Mes échéances</h1>
                  <p className="ip__hero-sub">Suivez vos facilités en temps réel</p>
                </div>
              </div>
              <div className="ip__hero-kpi ip__hero-kpi--strip" role="list">
                <div className="ip__kpi" role="listitem"><span className="ip__kpi-value">{ipStats.total}</span><span className="ip__kpi-label">Plans</span></div>
                <div className="ip__kpi" role="listitem"><span className="ip__kpi-value">{ipStats.submitted}</span><span className="ip__kpi-label">En révision</span></div>
                <div className="ip__kpi" role="listitem"><span className="ip__kpi-value">{ipStats.rejected}</span><span className="ip__kpi-label">À corriger</span></div>
                <div className="ip__kpi" role="listitem"><span className="ip__kpi-value">{ipStats.approved}</span><span className="ip__kpi-label">Confirmés</span></div>
              </div>
            </div>

            {/* ── List: all plans (détail = popup) ── */}
            <RenderDataGate
                loading={plansLoadingRaw}
                data={myPlans}
                skeleton="table"
                watchdogMs={4000}
                onRetry={refreshPlans}
                empty={
                  <EmptyState
                    title="Aucun plan d'échéances"
                    description="Vos plans apparaîtront ici après finalisation de votre achat."
                  />
                }
              >
                {(list) => (
                  <div className="ip__plan-list">
                    {list.map(plan => {
                      const sale = saleByIdMap.get(String(plan.saleId)) || {}
                      const metrics = instMetrics.computeInstallmentSaleMetrics(sale, plan)
                      const progress = metrics.approvedPct
                      const nextAction = plan.payments.find(p => p.status === 'rejected' || p.status === 'pending' || p.status === 'submitted')
                      return (
                        <button key={plan.id} type="button" className="ip__plan-card" onClick={() => setFocusedPlanId(plan.id)}>
                          <div className="ip__plan-card__header">
                            <div className="ip__plan-card__titles">
                              <span className="ip__plan-title">{plan.projectTitle}</span>
                              <span className="ip__plan-ref">{plan.projectCity}</span>
                            </div>
                            <div className="ip__plan-pills">
                              {metrics.submittedCount > 0 && <span className="ip__pill ip__pill--submitted">{metrics.submittedCount} en révision</span>}
                              {metrics.rejectedCount > 0 && <span className="ip__pill ip__pill--rejected">{metrics.rejectedCount} à corriger</span>}
                              {metrics.submittedCount === 0 && metrics.rejectedCount === 0 && <span className="ip__pill ip__pill--ok">Rythme normal</span>}
                            </div>
                          </div>
                          <div className="ip__plan-money" aria-label="Montants validés et restants">
                            <div className="ip__plan-money__item ip__plan-money__item--ok">
                              <span className="ip__plan-money__label">Validé</span>
                              <span className="ip__plan-money__value">{instMetrics.formatMoneyTnd(metrics.cashValidatedStrict)}</span>
                            </div>
                            <div className="ip__plan-money__item">
                              <span className="ip__plan-money__label">Reste</span>
                              <span className="ip__plan-money__value">{instMetrics.formatMoneyTnd(metrics.remainingStrict)}</span>
                            </div>
                          </div>
                          <div className="ip__plan-progress-block">
                            <div className="ip__plan-progress-head">
                              <span className="ip__plan-progress-title">Facilités confirmées</span>
                              <span className="ip__progress-label">{metrics.approvedCount}/{metrics.totalMonths}</span>
                            </div>
                            <div className="ip__progress">
                              <div className="ip__progress-track">
                                <div className="ip__progress-fill" style={{ width: `${Math.max(progress, 2)}%` }} />
                              </div>
                            </div>
                          </div>
                          <div className="ip__plan-next">
                            {nextAction ? (
                              <>
                                <span className="ip__plan-next__kicker">Prochaine action</span>
                                <span className="ip__plan-next__text">F.{nextAction.month} — {ipStatusMeta(nextAction.status).label}</span>
                              </>
                            ) : (
                              <span className="ip__plan-next__text ip__plan-next__text--done">Toutes les facilités sont confirmées.</span>
                            )}
                          </div>
                          <div className="ip__plan-cta">
                            <span>Ouvrir le détail</span>
                            <span className="ip__plan-cta__arrow" aria-hidden>→</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </RenderDataGate>

            {focusedPlan && (
              <div
                className="ip__overlay ip__overlay--plan-detail"
                role="presentation"
                onClick={() => setFocusedPlanId(null)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="ip-plan-detail-title"
                  className="ip__modal ip__modal--plan-detail"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="ip__modal-header ip__modal-header--plan-detail">
                    <div>
                      <h2 id="ip-plan-detail-title" className="ip__modal-title">{focusedPlan.projectTitle}</h2>
                      <p className="ip__modal-sub">{focusedPlan.projectCity} · #{focusedPlan.id}</p>
                    </div>
                    <button type="button" className="ip__modal-close" onClick={() => setFocusedPlanId(null)} aria-label="Fermer le détail du plan">✕</button>
                  </div>
                  <div className="ip__modal-body ip__modal-body--plan-detail">
                    {(() => {
                      const sale = saleByIdMap.get(String(focusedPlan.saleId)) || {}
                      const m = instMetrics.computeInstallmentSaleMetrics(sale, focusedPlan)
                      return (
                        <div className="ip-metrics ip-metrics--embedded ip-metrics--in-modal">
                          <div className="ip-metric ip-metric--ok">
                            <div className="ip-metric__label">Validé</div>
                            <div className="ip-metric__value">{instMetrics.formatMoneyTnd(m.cashValidatedStrict)}</div>
                            <div className="ip-metric__hint">1er versement + mensualités confirmées</div>
                          </div>
                          <div className="ip-metric ip-metric--review">
                            <div className="ip-metric__label">En révision</div>
                            <div className="ip-metric__value">{instMetrics.formatMoneyTnd(m.submittedAmount)}</div>
                            <div className="ip-metric__hint">Reçus envoyés, en attente</div>
                          </div>
                          <div className="ip-metric ip-metric--bad">
                            <div className="ip-metric__label">À corriger</div>
                            <div className="ip-metric__value">{instMetrics.formatMoneyTnd(m.rejectedAmount)}</div>
                            <div className="ip-metric__hint">Reçus refusés à renvoyer</div>
                          </div>
                          <div className="ip-metric ip-metric--neutral">
                            <div className="ip-metric__label">Reste à valider</div>
                            <div className="ip-metric__value">{instMetrics.formatMoneyTnd(m.remainingStrict)}</div>
                            <div className="ip-metric__hint">Sur un total de {instMetrics.formatMoneyTnd(m.saleAgreed)}</div>
                          </div>
                        </div>
                      )
                    })()}
                    <div className="ip__detail-hint ip__detail-hint--modal">
                      <strong>Mode d&apos;emploi :</strong> En attente / Rejeté = envoyez ou corrigez un reçu. En révision = attente validation. Confirmé = rien à faire.
                    </div>
                    {(() => {
                      const all = focusedPlan.payments || []
                      const nextDueIdx = instMetrics.getNextDuePaymentIndex(all)
                      const totalPages = Math.max(1, Math.ceil(all.length / IP_PAYMENTS_PER_PAGE))
                      const page = Math.min(Math.max(1, ipPaymentPage), totalPages)
                      const start = (page - 1) * IP_PAYMENTS_PER_PAGE
                      const slice = all.slice(start, start + IP_PAYMENTS_PER_PAGE)
                      return (
                        <>
                          <div className="ip__payments">
                            {slice.map((p, i) => {
                              const meta = ipStatusMeta(p.status)
                              const receipt = lastReceipt(p)
                              const receiptIsImage = receipt && isImageUrl(receipt.url)
                              const globalIdx = start + i
                              const isNextDue = nextDueIdx >= 0 && globalIdx === nextDueIdx
                              return (
                                <div
                                  key={`${focusedPlan.id}:${p.month}`}
                                  ref={isNextDue ? ipNextDueCardRef : undefined}
                                  className={`ip__pay-card${isNextDue ? ' ip__pay-card--next' : ''}`}
                                >
                                  <div className="ip__pay-top">
                                    <span className="ip__pay-month">Facilité {p.month}</span>
                                    <span className="ip__pay-due">{fmtDate(p.dueDate)}</span>
                                  </div>
                                  <div className="ip__pay-mid">
                                    <span className="ip__pay-amount">{p.amount.toLocaleString()} <small>DT</small></span>
                                    <span className={`ip__status ip__status--${meta.tone}`}>{meta.label}</span>
                                  </div>
                                  <div className="ip__pay-hint">{meta.hint}</div>
                                  {p.status === 'rejected' && p.rejectedNote && <div className="ip__pay-reject">⚠ {p.rejectedNote}</div>}
                                  {receipt && (
                                    <div className="ip__receipt">
                                      {receiptIsImage
                                        ? <img src={receipt.url} alt="Reçu" className="ip__receipt-thumb" />
                                        : <div className="ip__receipt-file-icon">📄</div>}
                                      <div className="ip__receipt-info">
                                        <div className="ip__receipt-name">{receipt.name}</div>
                                        {receipt.date && <div className="ip__receipt-date">{fmtDate(receipt.date)}</div>}
                                      </div>
                                      <a href={receipt.url} target="_blank" rel="noreferrer" className="ip__receipt-link">Voir</a>
                                    </div>
                                  )}
                                  {isPayable(p.status) && (
                                    <button type="button" className={`ip__pay-btn${p.status === 'submitted' ? ' ip__pay-btn--correct' : ''}`} onClick={() => ipOpenPay(focusedPlan, p)}>
                                      {p.status === 'submitted' ? '📝 Corriger le reçu' : '📤 Envoyer un reçu'}
                                    </button>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                          {totalPages > 1 && (
                            <nav className="ip__pager" aria-label="Pagination des facilités">
                              <button type="button" className="ip__pager-btn ip__pager-btn--nav" onClick={() => setIpPaymentPage((v) => Math.max(1, v - 1))} disabled={page <= 1} aria-label="Page précédente">‹</button>
                              {Array.from({ length: totalPages }, (_, idx) => idx + 1).map((n) => (
                                <button key={n} type="button" className={`ip__pager-btn${n === page ? ' ip__pager-btn--active' : ''}`} onClick={() => setIpPaymentPage(n)} aria-current={n === page ? 'page' : undefined}>{n}</button>
                              ))}
                              <button type="button" className="ip__pager-btn ip__pager-btn--nav" onClick={() => setIpPaymentPage((v) => Math.min(totalPages, v + 1))} disabled={page >= totalPages} aria-label="Page suivante">›</button>
                              <span className="ip__pager-hint">Facilités {start + 1}–{Math.min(start + IP_PAYMENTS_PER_PAGE, all.length)} / {all.length}</span>
                            </nav>
                          )}
                        </>
                      )
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Receipt Upload Modal ── */}
        {ipPayTarget && (
          <div className="ip__overlay ip__overlay--receipt" onClick={ipClosePay}>
            <div className="ip__modal" onClick={e => e.stopPropagation()}>
              <div className="ip__modal-header">
                <div>
                  <h3 className="ip__modal-title">Soumettre votre reçu</h3>
                  <p className="ip__modal-sub">Validation rapide de votre mensualité</p>
                </div>
                <button type="button" className="ip__modal-close" onClick={ipClosePay}>✕</button>
              </div>
              <div className="ip__modal-body">
                <div className="ip__modal-info ip__modal-info--receipt">
                  <span className="ip__modal-info-kicker">Mensualité sélectionnée</span>
                  <strong className="ip__modal-info-main">
                    Facilité {ipPayTarget.month} · {ipPayTarget.amount.toLocaleString()} DT
                  </strong>
                  <span className="ip__modal-info-meta">Échéance : {fmtDate(ipPayTarget.dueDate)}</span>
                </div>
                <div className="ip__upload-label">Choisir le justificatif</div>
                <div className="ip__upload-btns">
                  <label className="ip__upload-btn">
                    <input type="file" accept="image/*,.pdf" onChange={async e => { try { if (e.target.files?.[0]) await ipHandleReceiptChange(e.target.files[0]) } catch (err) { setIpError(err.message || 'Erreur') } }} />
                    Fichier (image/PDF)
                  </label>
                  <label className="ip__upload-btn">
                    <input type="file" accept="image/*" capture="environment" onChange={async e => { try { if (e.target.files?.[0]) await ipHandleReceiptChange(e.target.files[0]) } catch (err) { setIpError(err.message || 'Erreur') } }} />
                    Prendre une photo
                  </label>
                </div>
                {ipReceiptName ? (
                  <div className="ip__upload-status ip__upload-status--ok">
                    <span className="ip__upload-status-title">Fichier prêt</span>
                    <span className="ip__upload-status-name">{ipReceiptName}</span>
                  </div>
                ) : (
                  <div className="ip__upload-status ip__upload-status--empty">Aucun fichier sélectionné</div>
                )}
                {ipReceiptPreview && <div className="ip__upload-preview"><img src={ipReceiptPreview} alt="Aperçu" /></div>}
                {ipReceiptFile && <div className="ip__upload-size">Taille optimisée : {(ipReceiptFile.size / 1024).toFixed(0)} Ko</div>}
                {ipError && <div className="ip__upload-error">⚠ {ipError}</div>}
                <div className="ip__upload-label">Note (optionnelle)</div>
                <textarea className="ip__upload-note" placeholder="Ajouter un commentaire pour l'équipe finance…" value={ipNote} onChange={e => setIpNote(e.target.value)} />
              </div>
              <div className="ip__modal-footer">
                <button type="button" className="ip__modal-cancel" onClick={ipClosePay}>Annuler</button>
                <button type="button" className="ip__modal-submit" disabled={!ipReceiptFile || ipSubmitting} onClick={ipSubmit}>
                  {ipSubmitting ? 'Envoi…' : 'Envoyer le reçu'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════
           TAB: Parrainage
           ══════════════════════════════════════ */}
        {activeTab === 'parrainage' && (
          <>
            <div className="inv-wallet">
              <header className="inv-wallet__header">
                <div>
                  <h3 className="inv-wallet__title">Commissions</h3>
                  <p className="inv-wallet__lead">
                    Retraits soumis aux règles finance (après tampon légal).
                  </p>
                  {!showAmbassadorCard && (
                    <p className="inv-wallet__lead inv-wallet__lead--muted">
                      Reliez votre profil client pour activer l’accès.
                    </p>
                  )}
                </div>
                {referralLevelsExposed ? (
                  <span className="inv-wallet__pill">
                    {referralDirectCount} direct{referralDirectCount !== 1 ? 's' : ''} ·{' '}
                    {referralIndirectCount} indirect{referralIndirectCount !== 1 ? 's' : ''}
                  </span>
                ) : (
                  <span className="inv-wallet__pill">
                    {ambassadorReferralRows.length} filleul{ambassadorReferralRows.length !== 1 ? 's' : ''}
                  </span>
                )}
              </header>

              {showAmbassadorCard && referralLoading && !referralHasError ? (
                <div className="inv-wallet__loading-wrap" role="status" aria-live="polite" aria-busy="true">
                  <span className="inv-wallet__spinner" aria-hidden="true" />
                  <div className="inv-wallet__loading-copy">
                    <span className="inv-wallet__loading-title">Chargement du portefeuille</span>
                    <span className="inv-wallet__loading-dots" aria-hidden>
                      <span className="inv-wallet__dot" />
                      <span className="inv-wallet__dot" />
                      <span className="inv-wallet__dot" />
                    </span>
                    <span className="inv-wallet__loading-shimmer" aria-hidden />
                  </div>
                </div>
              ) : showAmbassadorCard && referralHasError ? (
                /* Plan 04 §3.1 step 5 — uniform ErrorPanel replaces the
                   bespoke alert+button block. Retry re-fires the RPC. */
                <ErrorPanel
                  title="Impossible de charger le portefeuille"
                  hint="Vérifiez votre connexion puis réessayez."
                  onRetry={() => refreshReferralSummary()}
                />
              ) : (
                  <>
                    <div className="inv-wallet__panel">
                      <div className="inv-wallet__hero">
                        <span className="inv-wallet__hero-label">Disponible au retrait</span>
                        <strong className="inv-wallet__hero-amount">
                          {(showAmbassadorCard ? (referralSummary?.walletBalance ?? 0) : 0).toLocaleString('fr-FR', {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}{' '}
                          <span className="inv-wallet__hero-currency">DT</span>
                        </strong>
                        <span className="inv-wallet__hero-meta">
                          Retrait min. {showAmbassadorCard ? (referralSummary?.minPayoutAmount ?? 0) : 0} DT · virement validé par la finance
                        </span>
                      </div>
                      <div className="inv-wallet__stats">
                        <div className="inv-wallet__stat">
                          <span className="inv-wallet__stat-lbl">En attente</span>
                          <span className="inv-wallet__stat-val">
                            {(showAmbassadorCard ? (referralSummary?.gainsAccrued ?? 0) : 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} DT
                          </span>
                          <span className="inv-wallet__stat-sub">Avant tampon</span>
                        </div>
                        <div className="inv-wallet__stat">
                          <span className="inv-wallet__stat-lbl">Crédit légal</span>
                          <span className="inv-wallet__stat-val">
                            {(showAmbassadorCard ? (referralSummary?.commissionsReleased ?? 0) : 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} DT
                          </span>
                          <span className="inv-wallet__stat-sub">Non versé</span>
                        </div>
                        <div className="inv-wallet__stat">
                          <span className="inv-wallet__stat-lbl">Direct (L1)</span>
                          <span className="inv-wallet__stat-val">
                            {(Number(showAmbassadorCard ? referralSummary?.l1Total : 0) || 0).toLocaleString('fr-FR')} DT
                          </span>
                        </div>
                        <div className="inv-wallet__stat">
                          <span className="inv-wallet__stat-lbl">Indirect (L2+)</span>
                          <span className="inv-wallet__stat-val">
                            {(Number(showAmbassadorCard ? referralSummary?.l2Total : 0) || 0).toLocaleString('fr-FR')} DT
                          </span>
                        </div>
                      </div>
                    </div>

                    {parrainageForecast && (
                      <details className="inv-wallet__fold">
                        <summary className="inv-wallet__fold-summary">Projection avec vos filleuls (optionnel)</summary>
                        <section className="inv-forecast inv-forecast--in-fold" aria-label="Potentiel de commissions">
                        <div className="inv-forecast__head">
                          <span className="inv-forecast__kicker">Projection</span>
                          <strong className="inv-forecast__title">Votre potentiel avec vos filleuls actuels</strong>
                        </div>
                        <p className="inv-forecast__lead">
                          Si chacun de vos <strong>{parrainageForecast.filleulCount}</strong>{' '}
                          filleul{parrainageForecast.filleulCount !== 1 ? 's' : ''} vend une parcelle à{' '}
                          <strong>{parrainageForecast.parcelPrice.toLocaleString('fr-FR')} DT</strong>,
                          vous pourriez percevoir{' '}
                          <strong className="inv-forecast__total">
                            {parrainageForecast.potentialTotal.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} DT
                          </strong>{' '}
                          en commissions (directes + indirectes).
                        </p>
                        <div className="inv-forecast__grid">
                          <div className="inv-forecast__cell">
                            <span className="inv-forecast__lbl">Direct (L1) / vente</span>
                            <span className="inv-forecast__val">{parrainageForecast.l1PerSale.toLocaleString('fr-FR')} DT</span>
                          </div>
                          <div className="inv-forecast__cell">
                            <span className="inv-forecast__lbl">Indirect (L2+) / vente</span>
                            <span className="inv-forecast__val">{parrainageForecast.l2PerSale.toLocaleString('fr-FR')} DT</span>
                          </div>
                          <div className="inv-forecast__cell">
                            <span className="inv-forecast__lbl">Par filleul</span>
                            <span className="inv-forecast__val">{parrainageForecast.potentialPerFilleul.toLocaleString('fr-FR')} DT</span>
                          </div>
                          <div className="inv-forecast__cell">
                            <span className="inv-forecast__lbl">Gagné à ce jour</span>
                            <span className="inv-forecast__val">{parrainageForecast.currentLifetime.toLocaleString('fr-FR')} DT</span>
                          </div>
                        </div>
                        <svg
                          className="inv-forecast__bars"
                          viewBox="0 0 220 60"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                        >
                          {(() => {
                            const max = Math.max(
                              parrainageForecast.currentLifetime,
                              parrainageForecast.potentialTotal,
                              1,
                            )
                            const currentW = Math.max(2, (parrainageForecast.currentLifetime / max) * 210)
                            const potentialW = Math.max(2, (parrainageForecast.potentialTotal / max) * 210)
                            return (
                              <>
                                <rect x="5" y="8" width={currentW} height="16" rx="4" fill="#a8cc50" opacity="0.85" />
                                <rect x="5" y="36" width={potentialW} height="16" rx="4" fill="#7ab020" />
                              </>
                            )
                          })()}
                        </svg>
                        <div className="inv-forecast__legend">
                          <span><span className="inv-forecast__dot" style={{ background: '#a8cc50' }} /> Actuel</span>
                          <span><span className="inv-forecast__dot" style={{ background: '#7ab020' }} /> Potentiel</span>
                        </div>
                        </section>
                      </details>
                    )}

                    {showAmbassadorCard && (
                      <div style={{ marginBottom: 14 }}>
                        <MyReferralTree
                          myClientId={clientId}
                          myName={clientProfile?.full_name || clientProfile?.name || displayName}
                          ledger={myCommissionEvents}
                          loading={ledgerLoading && myCommissionEvents.length === 0}
                        />
                      </div>
                    )}

                    {showAmbassadorCard && (
                      <div className="inv-ledger">
                        <div className="inv-ledger__head">
                          <h4 className="inv-ledger__title">Historique</h4>
                          <div className="inv-ledger__head-right">
                            <span className="inv-ledger__count">{myCommissionEvents.length} ligne{myCommissionEvents.length !== 1 ? 's' : ''}</span>
                            {myCommissionEvents.length > 0 && (
                              <button
                                type="button"
                                className="inv-wallet__export"
                                onClick={handleExportCommissionsCsv}
                                aria-label="Exporter les commissions au format CSV"
                              >
                                CSV
                              </button>
                            )}
                          </div>
                        </div>
                        <p className="inv-ledger__hint">
                          L1 = votre vente · L2+ = vente dans votre ligne de commissions.
                        </p>
                        <RenderDataGate
                          loading={ledgerLoading && myCommissionEvents.length === 0}
                          data={myCommissionEvents}
                          skeleton="table"
                          watchdogMs={4000}
                          onRetry={refreshCommissionLedger}
                          empty={
                            <EmptyState
                              title="Aucune commission"
                              description="Les montants s’affichent après clôture notaire des ventes concernées."
                            />
                          }
                        >
                          {(events) => (() => {
                          const commissionOnly = events.filter((e) => e.kind !== 'payout')
                          const payoutsOnly = events.filter((e) => e.kind === 'payout')
                          const directEvents = commissionOnly.filter((e) => (e.level || 0) === 1)
                          const indirectEvents = commissionOnly.filter((e) => (e.level || 0) >= 2)
                          const statusMap = {
                            paid: { label: 'Payé', tone: 'good' },
                            payable: { label: 'À virer', tone: 'info' },
                            pending: { label: 'En attente', tone: 'warn' },
                            cancelled: { label: 'Annulé', tone: 'bad' },
                            pending_review: { label: 'En revue', tone: 'warn' },
                            approved: { label: 'Approuvé', tone: 'info' },
                            rejected: { label: 'Refusé', tone: 'bad' },
                          }
                          const renderPayoutCard = (pr) => {
                            const st = statusMap[pr.status] || { label: pr.status || '—', tone: 'warn' }
                            return (
                              <li key={pr.id} className="inv-ledger__row">
                                <div className="inv-ledger__lvl" style={{ background: '#0f766e' }}>💸</div>
                                <div className="inv-ledger__body">
                                  <div className="inv-ledger__top">
                                    <span className="inv-ledger__amount inv-ledger__amount--neg">−{(Number(pr.amount) || 0).toLocaleString('fr-FR')} <small>DT</small></span>
                                    <span className={`inv-ledger__status inv-ledger__status--${st.tone}`}>{st.label}</span>
                                  </div>
                                  <div className="inv-ledger__grid">
                                    <span className="inv-ledger__lbl">Type</span>
                                    <span className="inv-ledger__val">Demande de retrait</span>
                                    {pr.code && (<>
                                      <span className="inv-ledger__lbl">Code</span>
                                      <span className="inv-ledger__val"><code style={{ fontSize: 11 }}>{pr.code}</code></span>
                                    </>)}
                                    {pr.createdAt && (<>
                                      <span className="inv-ledger__lbl">Demandé</span>
                                      <span className="inv-ledger__val">{fmtDate(pr.createdAt)}</span>
                                    </>)}
                                    {pr.reviewedAt && (<>
                                      <span className="inv-ledger__lbl">Revue</span>
                                      <span className="inv-ledger__val">{fmtDate(pr.reviewedAt)}</span>
                                    </>)}
                                    {pr.paidAt && (<>
                                      <span className="inv-ledger__lbl">Versé</span>
                                      <span className="inv-ledger__val">{fmtDate(pr.paidAt)}</span>
                                    </>)}
                                  </div>
                                </div>
                              </li>
                            )
                          }
                          const renderCard = (ev) => {
                            const lvl = ev.level || 0
                            const lvlMod = lvl === 1 ? 'l1' : lvl === 2 ? 'l2' : lvl === 3 ? 'l3' : lvl >= 4 ? 'l4' : null
                            const st = statusMap[ev.status] || { label: ev.status || '—', tone: 'warn' }
                            const sellerName = ev.seller?.name || '—'
                            const buyerName = ev.buyer?.name || '—'
                            const project = ev.project?.title || '—'
                            // Honest display: show the raw facts (actual seller, actual
                            // buyer, level) without inferring a story. User can spot
                            // anomalies themselves (e.g. L1 credited but they weren't
                            // the seller → data bug).
                            return (
                              <li key={ev.id} className="inv-ledger__row">
                                <div className={`inv-ledger__lvl${lvlMod ? ` inv-ledger__lvl--${lvlMod}` : ''}`}>L{lvl}</div>
                                <div className="inv-ledger__body">
                                  <div className="inv-ledger__top">
                                    <span className="inv-ledger__amount">+{(Number(ev.amount) || 0).toLocaleString('fr-FR')} <small>DT</small></span>
                                    <span className={`inv-ledger__status inv-ledger__status--${st.tone}`}>{st.label}</span>
                                  </div>
                                  <div className="inv-ledger__grid">
                                    <span className="inv-ledger__lbl">Vendeur</span>
                                    <span className="inv-ledger__val">{sellerName}</span>
                                    <span className="inv-ledger__lbl">Acheteur</span>
                                    <span className="inv-ledger__val">{buyerName}</span>
                                    <span className="inv-ledger__lbl">Projet</span>
                                    <span className="inv-ledger__val">{project}</span>
                                    {ev.sale?.code && (<>
                                      <span className="inv-ledger__lbl">Code vente</span>
                                      <span className="inv-ledger__val"><code style={{ fontSize: 11 }}>{ev.sale.code}</code></span>
                                    </>)}
                                    {ev.sale?.notaryCompletedAt && (<>
                                      <span className="inv-ledger__lbl">Finalisé</span>
                                      <span className="inv-ledger__val">{fmtDate(ev.sale.notaryCompletedAt)}</span>
                                    </>)}
                                  </div>
                                </div>
                              </li>
                            )
                          }
                          return (
                            <>
                              {directEvents.length > 0 && (
                                <div className="inv-ledger__section">
                                  <div className="inv-ledger__section-title">Vos ventes directes</div>
                                  <ul className="inv-ledger__list">{directEvents.map(renderCard)}</ul>
                                </div>
                              )}
                              {indirectEvents.length > 0 && (
                                <div className="inv-ledger__section">
                                  <div className="inv-ledger__section-title">Ventes de votre ligne (commissions)</div>
                                  <ul className="inv-ledger__list">{indirectEvents.map(renderCard)}</ul>
                                </div>
                              )}
                              {payoutsOnly.length > 0 && (
                                <div className="inv-ledger__section">
                                  <div className="inv-ledger__section-title">Demandes de retrait</div>
                                  <ul className="inv-ledger__list">{payoutsOnly.map(renderPayoutCard)}</ul>
                                </div>
                              )}
                            </>
                          )
                        })()}
                        </RenderDataGate>
                      </div>
                    )}
                  </>
                )}

              {showAmbassadorCard && (
                <>
                  {payoutError && (
                    <p className="inv-wallet__alert inv-wallet__alert--error">{payoutError}</p>
                  )}
                  {!referralLoading && referralSummaryIssueMessage && (
                    <p className="inv-wallet__alert inv-wallet__alert--warn">{referralSummaryIssueMessage}</p>
                  )}
                  {!referralLoading
                    && referralSummary?.ok
                    && !referralVerificationBlocked
                    && (referralSummary?.walletBalance ?? 0) === 0
                    && (referralSummary?.gainsAccrued ?? 0) === 0
                    && (referralSummary?.commissionsReleased ?? 0) === 0 && (
                    <>
                      {referralSummary?.diagnostics && (() => {
                        const d = referralSummary.diagnostics
                        const notEligible =
                          (d.linkedAsSeller || 0) === 0
                          && (d.linkedAsAmbassador || 0) === 0
                        const hasAgentSales = (d.linkedAsAgent || 0) > 0
                        const hint = notEligible && hasAgentSales
                          ? "Les ventes que vous avez enregistrées n'ont pas de bénéficiaire commission désigné (seller_client_id / ambassador_client_id). Un administrateur doit configurer votre rôle commercial pour que vous receviez des commissions."
                          : notEligible
                            ? "Aucune vente avec vous comme vendeur ou parrain. Les commissions exigent un seller_client_id ou ambassador_client_id."
                            : (d.notaryCompleteTotal || 0) === 0
                              ? "Vos ventes ne sont pas encore notariées. Les commissions apparaîtront après validation notaire."
                              : "Un rattachement existe mais aucune ligne commission n'a été créée — contactez le support."
                        return (
                          <details className="inv-diagnostic">
                            <summary className="inv-diagnostic__summary">Pourquoi tout est à 0 ?</summary>
                            <div className="inv-diagnostic__body">
                              <div className="inv-diagnostic__hint">{hint}</div>
                              <div className="inv-diagnostic__mono">
                                {`acheteur=${d.linkedAsBuyer ?? 0}  vendeur=${d.linkedAsSeller ?? 0}  parrain=${d.linkedAsAmbassador ?? 0}  agent=${d.linkedAsAgent ?? 0}`}
                                <br />
                                {`notariées=${d.notaryCompleteTotal ?? 0}  commission_events=${d.commissionEventCount ?? 0}`}
                              </div>
                              {Array.isArray(d.latestSales) && d.latestSales.length > 0 && (
                                <table className="inv-diagnostic__table">
                                  <thead>
                                    <tr className="inv-diagnostic__head-row">
                                      <th className="inv-diagnostic__th">Code</th>
                                      <th className="inv-diagnostic__th">Rôle</th>
                                      <th className="inv-diagnostic__th">Notaire</th>
                                      <th className="inv-diagnostic__th inv-diagnostic__th--right">Prix</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {d.latestSales.map((s) => (
                                      <tr key={s.id}>
                                        <td className="inv-diagnostic__td inv-diagnostic__td--mono">{s.code || s.id.slice(0, 8)}</td>
                                        <td className="inv-diagnostic__td">
                                          {[s.as_buyer && 'acheteur', s.as_seller && 'vendeur', s.as_ambassador && 'parrain'].filter(Boolean).join(', ') || '—'}
                                        </td>
                                        <td className="inv-diagnostic__td">{s.notary_done ? '✓' : '—'}</td>
                                        <td className="inv-diagnostic__td inv-diagnostic__td--right">{Number(s.agreed_price || 0).toLocaleString('fr-FR')}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </details>
                        )
                      })()}
                    </>
                  )}
                  {referralVerificationBlocked && (
                    <p className="inv-wallet__alert inv-wallet__alert--verify">
                      Vérification d&apos;identité requise avant tout retrait bancaire. Le portefeuille reste visible.
                    </p>
                  )}

                  <div className="inv-wallet__actions">
                    {(() => {
                      const bal = Number(referralSummary?.walletBalance ?? 0)
                      const min = Number(referralSummary?.minPayoutAmount ?? 0)
                      const disabled =
                        payoutBusy
                        || referralLoading
                        || referralVerificationBlocked
                        || bal < min
                        || bal <= 0
                      let reason = ''
                      if (referralLoading) reason = 'Chargement du portefeuille…'
                      else if (referralVerificationBlocked) reason = "Vérification d'identité requise."
                      else if (bal <= 0) reason = 'Aucun gain disponible à retirer pour le moment.'
                      else if (bal < min) reason = `Seuil minimum non atteint (${min.toLocaleString('fr-FR')} DT).`
                      return (
                        <>
                          <button
                            type="button"
                            className="inv-wallet__btn"
                            disabled={disabled}
                            onClick={() => { setPayoutError(''); setPayoutConfirmOpen(true) }}
                            title={reason || undefined}
                          >
                            {payoutBusy ? 'Traitement…' : 'Retirer les gains'}
                          </button>
                          <p className="inv-wallet__actions-note">
                            {reason || 'Validation interne avant virement.'}
                          </p>
                        </>
                      )
                    })()}
                  </div>

                  {payoutConfirmOpen && (() => {
                    const bal = Number(referralSummary?.walletBalance ?? 0)
                    const min = Number(referralSummary?.minPayoutAmount ?? 0)
                    return (
                      <div className="inv-payout__overlay" role="dialog" aria-modal="true" onClick={() => !payoutBusy && setPayoutConfirmOpen(false)}>
                        <div className="inv-payout__modal" onClick={(e) => e.stopPropagation()}>
                          <header className="inv-payout__head">
                            <div style={{ fontSize: 28 }}>💸</div>
                            <div>
                              <h3 className="inv-payout__title">Confirmer le retrait</h3>
                              <p className="inv-payout__sub">Votre demande sera transmise à la finance.</p>
                            </div>
                          </header>

                          <div className="inv-payout__amount">
                            <span className="inv-payout__amount-lbl">Montant demandé</span>
                            <span className="inv-payout__amount-val">{bal.toLocaleString('fr-FR')} <small>DT</small></span>
                          </div>

                          <ul className="inv-payout__notes">
                            <li>
                              <strong>Seuil minimum&nbsp;:</strong> {min.toLocaleString('fr-FR')} DT. Vous êtes au-dessus, la demande peut partir.
                            </li>
                            <li>
                              <strong>Validation interne&nbsp;:</strong> l'équipe finance vérifie puis déclenche le virement bancaire. Délai habituel&nbsp;: 3 à 7 jours ouvrés.
                            </li>
                            <li>
                              <strong>Commissions bloquées&nbsp;:</strong> pendant le traitement, les gains inclus dans la demande sont verrouillés et n'apparaissent plus comme "disponibles".
                            </li>
                            <li>
                              <strong>Traçabilité&nbsp;:</strong> une ligne "Demande de retrait" apparaît dans votre historique ci-dessous, avec le statut mis à jour à chaque étape (En revue → Approuvé → Payé).
                            </li>
                            <li>
                              <strong>En cas de refus&nbsp;:</strong> les gains retournent automatiquement dans votre portefeuille, vous pouvez redemander plus tard.
                            </li>
                          </ul>

                          {payoutError && <div className="inv-payout__err">Erreur&nbsp;: {payoutError}</div>}

                          <div className="inv-payout__actions">
                            <button type="button" className="inv-payout__btn inv-payout__btn--secondary" onClick={() => setPayoutConfirmOpen(false)} disabled={payoutBusy}>
                              Annuler
                            </button>
                            <button type="button" className="inv-payout__btn inv-payout__btn--primary" onClick={handleAmbassadorPayout} disabled={payoutBusy}>
                              {payoutBusy ? 'Envoi…' : `Confirmer le retrait de ${bal.toLocaleString('fr-FR')} DT`}
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                </>
              )}

            </div>
          </>
        )}

        {/* ── Footer ── */}
        <footer className="inv-footer">
          <button type="button" className="inv-footer__btn" onClick={handleLogout}>
            Se déconnecter
          </button>
        </footer>
      </section>
    </main>
  )
}
