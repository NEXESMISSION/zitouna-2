import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useCountUp } from '../hooks/useCountUp.js'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import { useTheme } from '../lib/ThemeContext.jsx'
import NotificationsMenu from '../components/NotificationsMenu.jsx'
import headerLogo from '../../logo-header2.png'


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
  fetchMyHarvestDistributions,
  fetchUpcomingHarvestsForClient,
  requestAmbassadorPayout,
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
import { buildMyPurchases } from '../lib/buildMyPurchases.js'
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
  const auth = useAuth()
  const {
    user,
    ready,
    adminUser,
    clientProfile,
    profileStatus,
    logout,
  } = auth

  // Admin/sell portal shortcuts — mirrors TopBar so the dashboard header
  // can surface the key + notifications + home buttons without the legacy
  // top bar above it.
  const hasAdminAccess = auth?.hasAdminAccess
  const canAccessSellPortal = auth?.canAccessSellPortal
  const adminTarget = auth?.adminTarget || '/admin'
  const showAdminEntry = Boolean(hasAdminAccess || canAccessSellPortal)
  const adminEntryTarget = hasAdminAccess ? adminTarget : '/admin/sell'

  const { theme } = useTheme()
  const isLightTheme = theme === 'light'

  const displayName = adminUser?.name || user?.firstname || user?.name || 'Investisseur'
  // Revolut-vibe: single electric-blue accent across both themes.
  const forecastAccentCurrent   = '#0a84ff'
  const forecastAccentPotential = isLightTheme ? '#0062cc' : '#409cff'
  const payoutIconBg            = 'rgba(10, 132, 255, 0.14)'

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

  // Harvest income — separate stream from commissions. Pulled independently
  // so a slow query on one doesn't block the other. `distributions` lists
  // the client's past credited harvests; `upcomingHarvests` is the next
  // planned/in_progress row across all their projects for the "Prochaine
  // récolte" card.
  const [harvestDistributions, setHarvestDistributions] = useState(null)
  const [upcomingHarvests, setUpcomingHarvests] = useState(null)
  useEffect(() => {
    if (!clientId) {
      setHarvestDistributions([])
      setUpcomingHarvests([])
      return undefined
    }
    let cancelled = false
    ;(async () => {
      try {
        const [dists, upcoming] = await Promise.all([
          fetchMyHarvestDistributions({ clientId }),
          fetchUpcomingHarvestsForClient(clientId),
        ])
        if (cancelled) return
        setHarvestDistributions(dists)
        setUpcomingHarvests(upcoming)
      } catch (err) {
        if (cancelled) return
        console.warn('[dashboard] harvest fetch failed', err?.message || err)
        setHarvestDistributions([])
        setUpcomingHarvests([])
      }
    })()
    return () => { cancelled = true }
  }, [clientId])

  const currentYear = new Date().getFullYear()
  const harvestThisYearTnd = (harvestDistributions || [])
    .filter((d) => d.harvestYear === currentYear)
    .reduce((s, d) => s + d.amountTnd, 0)
  const nextHarvest = (upcomingHarvests || []).find(
    (h) => h.status === 'planned' || h.status === 'in_progress',
  ) || null
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

  const myPurchases = useMemo(
    () => buildMyPurchases(mySales, allProjects),
    [mySales, allProjects],
  )

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
  /* Profile editing moved to /my/profile (standalone page). */

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
  const commissionBalance = Number(referralSummary?.walletBalance) || 0
  const animCommission = useCountUp(commissionBalance, { duration: KPI_COUNT_MS, delay: 340 })

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  // Avatar dropdown (Profil / Déconnexion). Closes on click outside + ESC.
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
  const avatarMenuRef = useRef(null)
  useEffect(() => {
    if (!avatarMenuOpen) return undefined
    const onDoc = (e) => {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target)) {
        setAvatarMenuOpen(false)
      }
    }
    const onKey = (e) => { if (e.key === 'Escape') setAvatarMenuOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [avatarMenuOpen])

  return (
    <main className="screen screen--app">
      <section className="zb-dash">
        <div className="zb-page">
        {/* ── Sidebar: brand · nav · referral CTA ── */}
        <aside className="zb-side">
          <div className="zb-brand">
            <div className="zb-brand-mark" aria-hidden>
              <img src={headerLogo} alt="" />
            </div>
            <div>
              <div className="zb-brand-name">Zitouna Bladi</div>
              <div className="zb-brand-sub">Smart Agriculture</div>
            </div>
          </div>

          <nav className="zb-nav">
            <button type="button" className="zb-nav-active">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
              Tableau de bord
            </button>
            <button type="button" onClick={() => navigate('/browse')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20l8-16 8 16H4z"/><path d="M8 16l4-8 4 8"/></svg>
              Portefeuille
            </button>
            <button type="button" onClick={() => navigate('/installments')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7h18M3 12h18M3 17h12"/></svg>
              Échéances
            </button>
            <button type="button" onClick={() => navigate('/my/commissions')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/></svg>
              Commissions
            </button>
            <button type="button" onClick={() => navigate('/my/tree')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.8 7.8l3.4 8.4M16.2 7.8l-3.4 8.4"/></svg>
              Arbre
            </button>
            <button type="button" onClick={() => navigate('/my/payout')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12h12M12 5l7 7-7 7"/></svg>
              Retirer
            </button>

            <div className="zb-nav-group-title">Compte</div>
            <button type="button" onClick={() => navigate('/my/profile')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>
              Profil
            </button>
            {showAdminEntry && (
              <button type="button" onClick={() => navigate(adminEntryTarget)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
                {hasAdminAccess ? 'Admin' : 'Ventes'}
              </button>
            )}
            <button type="button" onClick={handleLogout}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              Déconnexion
            </button>
          </nav>

        </aside>

        <main className="zb-main">
          {/* Topbar: search · notifications · avatar */}
          <div className="zb-topbar">
            <div className="zb-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
              <input type="text" placeholder="Rechercher une parcelle, un projet…" readOnly />
            </div>
            <div className="zb-topbar-actions">
              <NotificationsMenu />
              <div className="zb-avatar-wrap" ref={avatarMenuRef}>
                <button
                  type="button"
                  className="zb-avatar"
                  onClick={() => setAvatarMenuOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={avatarMenuOpen}
                  aria-label="Menu du compte"
                  title={displayName}
                >
                  {(displayName || 'ZB').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'ZB'}
                </button>
                {avatarMenuOpen && (
                  <div className="zb-avatar-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setAvatarMenuOpen(false); navigate('/my/profile') }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>
                      Mon profil
                    </button>
                    {showAdminEntry && (
                      <button type="button" role="menuitem" onClick={() => { setAvatarMenuOpen(false); navigate(adminEntryTarget) }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>
                        {hasAdminAccess ? 'Admin' : 'Ventes'}
                      </button>
                    )}
                    <hr />
                    <button type="button" role="menuitem" className="zb-danger" onClick={() => { setAvatarMenuOpen(false); handleLogout() }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                      Déconnexion
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Greeting */}
          <div className="zb-greeting">
            <div className="zb-greeting-sub">Bonjour {displayName} 👋</div>
            <h1 className="zb-greeting-title">Voici votre portefeuille.</h1>
          </div>


        {/* ══════════════════════════════════════════════════════════
           Unified dashboard — hero · parcelles · grid-2 (échéances + activity).
           Commissions and Retirer moved to /my/commissions and /my/payout.
           Échéances detail moved to /installments.
           ══════════════════════════════════════════════════════════ */}
        {(() => {
          // Upcoming payments — pick the next unresolved payment from each
          // plan, sort chronologically, cap at 4 for the preview.
          const upcomingPayments = []
          for (const plan of myPlans || []) {
            const next = (plan.payments || []).find(
              (p) => p.status === 'pending' || p.status === 'rejected' || p.status === 'submitted',
            )
            if (next) upcomingPayments.push({ ...next, plan })
          }
          upcomingPayments.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
          const upcomingPreview = upcomingPayments.slice(0, 4)

          const monthAbbr = (iso) => {
            const m = ['JAN', 'FÉV', 'MAR', 'AVR', 'MAI', 'JUI', 'JUL', 'AOÛ', 'SEP', 'OCT', 'NOV', 'DÉC']
            try { return m[new Date(iso).getMonth()] } catch { return '' }
          }
          const dayNum = (iso) => {
            try { return String(new Date(iso).getDate()).padStart(2, '0') } catch { return '' }
          }

          // Recent activity — mix last commission events for a feed.
          const recentActivity = (myCommissionEvents || []).slice(0, 5)

          return (
            <>
              {/* ── Hero: two earnings cards — Commissions + Récoltes ── */}
              <section className="zb-hero zb-hero--earn">
                {/* Commissions card */}
                <article
                  className="zb-earn zb-earn--commission"
                  onClick={() => navigate('/my/commissions')}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate('/my/commissions') }}
                >
                  <div className="zb-earn-head">
                    <div className="zb-earn-ic zb-earn-ic--commission">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v10M9 9.5c0-1 1-2 3-2s3 1 3 2-1 1.5-3 2-3 1-3 2 1 2 3 2 3-1 3-2" />
                      </svg>
                    </div>
                    <div className="zb-earn-head-tx">
                      <div className="zb-earn-t">Commissions</div>
                      <div className="zb-earn-s">{showAmbassadorCard ? 'Solde disponible · prêt à retirer' : 'Activez votre compte ambassadeur'}</div>
                    </div>
                  </div>
                  <div className="zb-earn-v">
                    {referralLoading ? '—' : Math.round(animCommission).toLocaleString('fr-FR')}
                    <span className="zb-earn-u">TND</span>
                  </div>
                  <div className="zb-earn-meta">
                    {showAmbassadorCard && Number(referralSummary?.commissionsReleased) > 0 ? (
                      <>
                        <span className="zb-earn-pill zb-earn-pill--green">
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 14l6-6 6 6" /></svg>
                          {Math.max(1, Math.round((commissionBalance / Number(referralSummary.commissionsReleased)) * 100))}%
                        </span>
                        <span className="zb-earn-sub">
                          {Math.round(Number(referralSummary.commissionsReleased)).toLocaleString('fr-FR')} TND libérés · lifetime
                        </span>
                      </>
                    ) : showAmbassadorCard ? (
                      <span className="zb-earn-sub">Aucune commission encore libérée</span>
                    ) : (
                      <span className="zb-earn-sub">Parrainez pour toucher des commissions L1 + L2</span>
                    )}
                  </div>
                  <div className="zb-earn-cta">
                    {showAmbassadorCard
                      ? (commissionBalance > 0 ? 'Retirer maintenant →' : 'Voir mes commissions →')
                      : 'Découvrir le parrainage →'}
                  </div>
                </article>

                {/* Récoltes card */}
                <article
                  className="zb-earn zb-earn--harvest"
                  onClick={() => navigate('/my/harvests')}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate('/my/harvests') }}
                >
                  <div className="zb-earn-head">
                    <div className="zb-earn-ic zb-earn-ic--harvest">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3c4 3 6 7 6 11a6 6 0 0 1-12 0c0-4 2-8 6-11z" />
                        <path d="M12 14v6" />
                      </svg>
                    </div>
                    <div className="zb-earn-head-tx">
                      <div className="zb-earn-t">Récoltes {currentYear}</div>
                      <div className="zb-earn-s">Revenu des oliviers distribué cette année</div>
                    </div>
                  </div>
                  <div className="zb-earn-v">
                    {salesLoading ? '—' : Math.round(harvestThisYearTnd).toLocaleString('fr-FR')}
                    <span className="zb-earn-u">TND</span>
                  </div>
                  <div className="zb-earn-meta">
                    {totalRevenue > 0 ? (
                      <>
                        <span className="zb-earn-pill zb-earn-pill--blue">
                          {Math.min(100, Math.max(0, Math.round((harvestThisYearTnd / totalRevenue) * 100)))}%
                        </span>
                        <span className="zb-earn-sub">
                          du revenu annuel projeté ({Math.round(totalRevenue).toLocaleString('fr-FR')} TND)
                        </span>
                      </>
                    ) : nextHarvest ? (
                      <span className="zb-earn-sub">
                        Prochaine récolte · {nextHarvest.date
                          ? new Date(nextHarvest.date).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
                          : nextHarvest.year}
                      </span>
                    ) : (
                      <span className="zb-earn-sub">Premiers revenus à partir de la 3ᵉ année</span>
                    )}
                  </div>
                  <div className="zb-earn-cta">
                    {nextHarvest ? `Prochaine : ${nextHarvest.date ? new Date(nextHarvest.date).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }) : nextHarvest.year} →` : 'Voir mes récoltes →'}
                  </div>
                </article>
              </section>

              {/* Quick actions + portfolio rail */}
              <section className="zb-card zb-hero-actions">
                <div className="zb-actions">
                  {showAdminEntry && (
                    <button className="zb-btn zb-btn-primary" type="button" onClick={() => navigate(adminEntryTarget)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
                      {hasAdminAccess ? 'Admin' : 'Espace ventes'}
                    </button>
                  )}
                  <button className="zb-btn zb-btn-ghost" type="button" onClick={() => navigate('/my/payout')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12h12M12 5l7 7-7 7" /></svg>
                    Retirer
                  </button>
                  <button className="zb-btn zb-btn-ghost" type="button" onClick={() => navigate('/my/commissions')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /></svg>
                    Commissions
                  </button>
                  <button className="zb-btn zb-btn-ghost" type="button" onClick={() => navigate('/my/tree')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.8 7.8l3.4 8.4M16.2 7.8l-3.4 8.4"/></svg>
                    Arbre
                  </button>
                  <button className="zb-btn zb-btn-ghost" type="button" onClick={() => navigate('/installments')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7h18M3 12h18M3 17h12" /></svg>
                    Échéances
                  </button>
                  <button className="zb-btn zb-btn-ghost" type="button" onClick={() => navigate('/browse')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/><path d="M8 11h6M11 8v6"/></svg>
                    Explorer
                  </button>
                  <button className="zb-btn zb-btn-ghost" type="button" onClick={() => navigate('/my/activity')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                    Activité
                  </button>
                </div>

                <div className="zb-rail zb-rail--3">
                  <div>
                    <div className="zb-k">Oliviers</div>
                    <div className="zb-v">{salesLoading ? '—' : Math.round(animTrees).toLocaleString('fr-FR')}</div>
                  </div>
                  <div>
                    <div className="zb-k">Revenu annuel projeté</div>
                    <div className="zb-v zb-blue">
                      {salesLoading ? '—' : Math.round(animRevenue).toLocaleString('fr-FR')}
                      <span className="zb-s">TND</span>
                    </div>
                  </div>
                  <div>
                    <div className="zb-k">Capital placé</div>
                    <div className="zb-v">
                      {salesLoading ? '—' : Math.round(animInvested).toLocaleString('fr-FR')}
                      <span className="zb-s">TND · ROI {animRoi.toFixed(1)}%</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* ── Prochaine récolte — featured card when one exists ── */}
              {nextHarvest && (
                <section
                  className="zb-next-harvest"
                  onClick={() => navigate(`/project/${nextHarvest.projectId}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/project/${nextHarvest.projectId}`) }}
                >
                  <div className="zb-next-harvest-bubble">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
                    </svg>
                  </div>
                  <div className="zb-next-harvest-body">
                    <div className="zb-k">Prochaine récolte</div>
                    <div className="zb-next-harvest-v">
                      {nextHarvest.date
                        ? new Date(nextHarvest.date).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
                        : nextHarvest.year}
                    </div>
                    <div className="zb-next-harvest-s">
                      Projet {nextHarvest.projectId}
                      {nextHarvest.status === 'in_progress' ? ' · récolte en cours' : ''}
                      {nextHarvest.projectedGrossTnd > 0
                        ? ` · ≈ ${Math.round(nextHarvest.projectedGrossTnd).toLocaleString('fr-FR')} TND prévus`
                        : ''}
                    </div>
                  </div>
                  <svg className="zb-next-harvest-arrow" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </section>
              )}

              {/* ── Mes parcelles ── */}
              <section>
                <div className="zb-section-head">
                  <h2>Mes parcelles</h2>
                  {myPurchases.length > 0 && (
                    <button type="button" onClick={() => navigate('/my/parcelles')}>Voir toutes →</button>
                  )}
                </div>

                <RenderDataGate
                  loading={portfolioLoading}
                  error={null}
                  data={myPurchases}
                  watchdogMs={4000}
                  skeleton={() => (
                    <div className="zb-parcelles zb-parcelles--slim" aria-busy="true">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="zb-card zb-parcelle zb-parcelle--slim">
                          <div className="zb-parcelle-body">
                            <div className="zb-parcelle-head">
                              <div className="sk sk-line sk-line--title" style={{ width: '55%' }} />
                              <div className="sk sk-line sk-line--sub" style={{ width: '30%' }} />
                            </div>
                            <div className="sk sk-line sk-line--sub" style={{ width: '70%' }} />
                            <div className="sk sk-line sk-line--sub" style={{ width: '50%' }} />
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
                    <div className="zb-card" style={{ padding: 22, color: 'var(--zb-muted)', fontSize: 13 }}>
                      Vous avez {mySalesInProgress.length} achat{mySalesInProgress.length !== 1 ? 's' : ''} en cours de finalisation.
                      Les parcelles s&apos;affichent ici après la <strong style={{ color: 'var(--zb-ink)' }}>finalisation notaire</strong>.
                    </div>
                  ) : (
                    <EmptyState
                      title="Aucune parcelle"
                      description="Vous ne possédez pas encore de parcelles."
                      action={{ label: 'Explorer les projets', onClick: () => navigate('/browse') }}
                    />
                  )}
                >
                  {(purchases) => (
                    <div className="zb-parcelles zb-parcelles--slim">
                      {purchases.slice(0, 3).map((parcel) => {
                        const progress = Math.min(100, Math.max(8, (parcel.annualRevenue / (parcel.invested || 1)) * 100))
                        return (
                          <div
                            key={`${parcel.saleId}-${parcel.plotId}`}
                            className="zb-card zb-parcelle zb-parcelle--slim"
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
                            <div className="zb-parcelle-body">
                              <div className="zb-parcelle-head">
                                <div className="zb-parcelle-title">Parcelle #{parcel.plotId}</div>
                                {parcel.city && (
                                  <span className="zb-parcelle-city">
                                    <span className="zb-d" />{parcel.city}
                                  </span>
                                )}
                              </div>
                              <div className="zb-parcelle-subtitle">{parcel.projectTitle}</div>
                              <div className="zb-parcelle-stats">
                                <div className="zb-kv">
                                  <span className="zb-k">Investi</span>
                                  <span className="zb-v">{Math.round(parcel.invested).toLocaleString('fr-FR')}<span className="zb-v-unit">DT</span></span>
                                </div>
                                <div className="zb-kv">
                                  <span className="zb-k">Revenu / an</span>
                                  <span className="zb-v zb-blue">{Math.round(parcel.annualRevenue).toLocaleString('fr-FR')}<span className="zb-v-unit">DT</span></span>
                                </div>
                              </div>
                              <div className="zb-parcelle-foot">
                                <div className="zb-progress"><span style={{ width: `${progress}%` }} /></div>
                                <button
                                  type="button"
                                  className="zb-parcelle-detail"
                                  onClick={(e) => { e.stopPropagation(); navigate(`/project/${parcel.projectId}/plot/${parcel.plotId}`) }}
                                >
                                  Détail
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </RenderDataGate>
              </section>

              {/* ── Grid-2: Échéances preview · Activité récente ── */}
              <section className="zb-grid-2">
                <div className="zb-card zb-ech">
                  <div className="zb-ech-head">
                    <div>
                      <h2>Prochaines échéances</h2>
                      <div className="zb-ech-sub">
                        {ipStats.total} plan{ipStats.total !== 1 ? 's' : ''} actif{ipStats.total !== 1 ? 's' : ''}
                        {ipStats.rejected > 0 && ` · ${ipStats.rejected} à corriger`}
                      </div>
                    </div>
                    <button type="button" className="zb-ech-link" onClick={() => navigate('/installments')}>Tout voir →</button>
                  </div>

                  {upcomingPreview.length === 0 ? (
                    plansLoadingRaw ? (
                      <div className="zb-ech-list" aria-busy="true" aria-live="polite">
                        {[0, 1, 2].map((i) => (
                          <div key={i} className="zb-ech-row zb-ech-row--sk">
                            <div className="zb-date-chip zb-date-chip--sk" aria-hidden="true">
                              <span className="sk sk-line zb-sk-date-d" />
                              <span className="sk sk-line zb-sk-date-m" />
                            </div>
                            <div className="zb-ech-txt">
                              <div className="sk sk-line" style={{ width: '70%', height: 12 }} />
                              <div className="sk sk-line" style={{ width: '45%', height: 10, marginTop: 6 }} />
                            </div>
                            <div className="zb-ech-side">
                              <div className="sk sk-line" style={{ width: 72, height: 14, marginLeft: 'auto' }} />
                              <div className="sk sk-line sk-line--badge" style={{ marginTop: 6, marginLeft: 'auto' }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="zb-ech-empty">Aucune échéance en attente.</div>
                    )
                  ) : (
                    <div className="zb-ech-list">
                      {upcomingPreview.map((p) => {
                        const meta = ipStatusMeta(p.status)
                        const statusClass =
                          meta.tone === 'approved' ? 'zb-status-paid'
                            : meta.tone === 'submitted' ? 'zb-status-up'
                              : meta.tone === 'rejected' ? 'zb-status-bad'
                                : 'zb-status-due'
                        return (
                          <div
                            key={`${p.plan.id}:${p.month}`}
                            className="zb-ech-row"
                            role="button"
                            tabIndex={0}
                            onClick={() => navigate('/installments')}
                            onKeyDown={(e) => { if (e.key === 'Enter') navigate('/installments') }}
                            style={{ cursor: 'pointer' }}
                          >
                            <div className="zb-date-chip">
                              <div className="zb-d">{dayNum(p.dueDate)}</div>
                              <div className="zb-m">{monthAbbr(p.dueDate)}</div>
                            </div>
                            <div className="zb-ech-txt">
                              <div className="zb-ech-txt-t">Facilité {p.month} · {p.plan.projectTitle}</div>
                              <div className="zb-ech-txt-s">{p.plan.projectCity || 'Plan d\'échéances'}</div>
                            </div>
                            <div className="zb-ech-side">
                              <div className="zb-ech-amt">{p.amount.toLocaleString('fr-FR')}<span className="zb-u">DT</span></div>
                              <span className={`zb-status ${statusClass}`}>{meta.label}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                <div className="zb-card zb-act">
                  <div className="zb-act-head">
                    <h2>Activité récente</h2>
                    <button type="button" className="zb-ech-link" onClick={() => navigate('/my/activity')}>Historique →</button>
                  </div>

                  {recentActivity.length === 0 ? (
                    ledgerLoading ? (
                      <div aria-busy="true" aria-live="polite">
                        {[0, 1, 2].map((i) => (
                          <div key={i} className="zb-act-row zb-act-row--sk">
                            <div className="sk sk-box zb-sk-act-ic" aria-hidden="true" />
                            <div className="zb-info">
                              <div className="sk sk-line" style={{ width: '65%', height: 12 }} />
                              <div className="sk sk-line" style={{ width: '40%', height: 10, marginTop: 6 }} />
                            </div>
                            <div className="sk sk-line zb-sk-act-amt" aria-hidden="true" />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="zb-ech-empty">Aucune activité récente.</div>
                    )
                  ) : (
                    recentActivity.map((ev) => {
                      const isPayout = ev.kind === 'payout'
                      const amount = Number(ev.amount || 0)
                      const dateIso = ev.createdAt || ev.sale?.notaryCompletedAt || ev.paidAt || ev.reviewedAt
                      const sub = dateIso ? fmtDate(dateIso) : ''
                      const title = isPayout
                        ? 'Demande de retrait'
                        : `Commission L${ev.level || '?'} · ${ev.project?.title || 'Vente'}`
                      return (
                        <div key={ev.id} className="zb-act-row">
                          <div className={`zb-act-ic ${isPayout ? 'zb-act-ic-out' : 'zb-act-ic-in'}`}>
                            {isPayout ? (
                              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12h12M12 5l7 7-7 7" /></svg>
                            ) : (
                              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7 7 7-7" /></svg>
                            )}
                          </div>
                          <div className="zb-info">
                            <div className="zb-info-t">{title}</div>
                            <div className="zb-info-s">{sub}</div>
                          </div>
                          <div className={`zb-a ${isPayout ? 'zb-out' : 'zb-in'}`}>
                            {isPayout ? '−' : '+'}{Math.abs(amount).toLocaleString('fr-FR')}
                            <span className="zb-u">DT</span>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </section>
            </>
          )
        })()}

        {/* Legacy tab blocks removed: échéances → /installments, commissions → /my/commissions, retirer → /my/payout. */}
        {false && activeTab === 'portfolio' && (
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

            {/* "Mes revenus" — rich revenue breakdown surfaced directly on
                the dashboard (used to live inside the Mon profil modal).
                Shares its data source (myPurchases) with the portfolio so
                all numbers stay in sync with the KPI strip above. */}
            {!salesLoading && (
              <ProfileRevenuePanel
                purchases={myPurchases}
                totalInvested={totalInvested}
                totalRevenue={totalRevenue}
              />
            )}

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
                <span className="ip__hero-icon" aria-hidden>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                </span>
                <div>
                  <h1 className="ip__hero-title">Mes échéances</h1>
                  <p className="ip__hero-sub">Suivez vos paiements en temps réel</p>
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
                    <button type="button" className="ip__modal-close" onClick={() => setFocusedPlanId(null)} aria-label="Fermer le détail du plan">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
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
                                  {p.status === 'rejected' && p.rejectedNote && (
                                    <div className="ip__pay-reject">
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                                        </svg>
                                        {p.rejectedNote}
                                      </span>
                                    </div>
                                  )}
                                  {receipt && (
                                    <div className="ip__receipt">
                                      {receiptIsImage
                                        ? <img src={receipt.url} alt="Reçu" className="ip__receipt-thumb" />
                                        : (
                                          <div className="ip__receipt-file-icon" aria-hidden>
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                                            </svg>
                                          </div>
                                        )}
                                      <div className="ip__receipt-info">
                                        <div className="ip__receipt-name">{receipt.name}</div>
                                        {receipt.date && <div className="ip__receipt-date">{fmtDate(receipt.date)}</div>}
                                      </div>
                                      <a href={receipt.url} target="_blank" rel="noreferrer" className="ip__receipt-link">Voir</a>
                                    </div>
                                  )}
                                  {isPayable(p.status) && (
                                    <button type="button" className={`ip__pay-btn${p.status === 'submitted' ? ' ip__pay-btn--correct' : ''}`} onClick={() => ipOpenPay(focusedPlan, p)}>
                                      {p.status === 'submitted' ? (
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                                          </svg>
                                          Corriger le reçu
                                        </span>
                                      ) : (
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                                          </svg>
                                          Envoyer un reçu
                                        </span>
                                      )}
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
                <button type="button" className="ip__modal-close" onClick={ipClosePay} aria-label="Fermer">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
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
                          Retrait min. {showAmbassadorCard ? (referralSummary?.minPayoutAmount ?? 0) : 0} DT
                        </span>
                        <div className="inv-wallet__hero-breakdown">
                          <span className="inv-wallet__chip">
                            <span className="inv-wallet__chip-lbl">En cours de retrait</span>
                            <span className="inv-wallet__chip-val">
                              {(showAmbassadorCard ? (referralSummary?.inPayoutAmount ?? 0) : 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} DT
                            </span>
                          </span>
                          <span className="inv-wallet__chip">
                            <span className="inv-wallet__chip-lbl">Crédit légal</span>
                            <span className="inv-wallet__chip-val">
                              {(showAmbassadorCard ? (referralSummary?.commissionsReleased ?? 0) : 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} DT
                            </span>
                          </span>
                          <span className="inv-wallet__chip">
                            <span className="inv-wallet__chip-lbl">Avant notaire</span>
                            <span className="inv-wallet__chip-val">
                              {(showAmbassadorCard ? (referralSummary?.gainsAccrued ?? 0) : 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} DT
                            </span>
                          </span>
                        </div>
                      </div>
                      <div className="inv-wallet__stats">
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
                                <rect x="5" y="8" width={currentW} height="16" rx="4" fill={forecastAccentCurrent} opacity="0.85" />
                                <rect x="5" y="36" width={potentialW} height="16" rx="4" fill={forecastAccentPotential} />
                              </>
                            )
                          })()}
                        </svg>
                        <div className="inv-forecast__legend">
                          <span><span className="inv-forecast__dot" style={{ background: forecastAccentCurrent }} /> Actuel</span>
                          <span><span className="inv-forecast__dot" style={{ background: forecastAccentPotential }} /> Potentiel</span>
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
                                <div className="inv-ledger__lvl" style={{ background: payoutIconBg, color: '#fff' }} aria-hidden>
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>
                                  </svg>
                                </div>
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
                            const snap = ev.rule_snapshot || ev.ruleSnapshot || null
                            const isGrantBased = snap && snap.source === 'reverse_sale_grant'
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
                                    {isGrantBased ? (
                                      <span
                                        className="inv-ledger__vi-pill"
                                        title="Vente inversée : commission versée grâce à un droit acquis — un filleul de la source a vendu, ce qui déclenche votre commission L1."
                                      >
                                        V.I.
                                      </span>
                                    ) : null}
                                    <span className={`inv-ledger__status inv-ledger__status--${st.tone}`}>{st.label}</span>
                                  </div>
                                  <div className="inv-ledger__summary">
                                    <span className="inv-ledger__summary-project">{project}</span>
                                    {ev.sale?.notaryCompletedAt && (
                                      <span className="inv-ledger__summary-date">{fmtDate(ev.sale.notaryCompletedAt)}</span>
                                    )}
                                  </div>
                                  {(sellerName !== '—' || buyerName !== '—' || ev.sale?.code) && (
                                    <details className="inv-ledger__details">
                                      <summary className="inv-ledger__details-summary">Détails</summary>
                                      <div className="inv-ledger__grid">
                                        <span className="inv-ledger__lbl">Vendeur</span>
                                        <span className="inv-ledger__val">{sellerName}</span>
                                        <span className="inv-ledger__lbl">Acheteur</span>
                                        <span className="inv-ledger__val">{buyerName}</span>
                                        {ev.sale?.code && (<>
                                          <span className="inv-ledger__lbl">Code</span>
                                          <span className="inv-ledger__val"><code style={{ fontSize: 11 }}>{ev.sale.code}</code></span>
                                        </>)}
                                      </div>
                                    </details>
                                  )}
                                </div>
                              </li>
                            )
                          }
                          return (
                            <>
                              {directEvents.length > 0 && (
                                <div className="inv-ledger__section">
                                  <div className="inv-ledger__section-title">Ventes directes (L1)</div>
                                  <ul className="inv-ledger__list">{directEvents.map(renderCard)}</ul>
                                </div>
                              )}
                              {indirectEvents.length > 0 && (
                                <div className="inv-ledger__section">
                                  <div className="inv-ledger__section-title">Votre ligne (L2+)</div>
                                  <ul className="inv-ledger__list">{indirectEvents.map(renderCard)}</ul>
                                </div>
                              )}
                              {payoutsOnly.length > 0 && (
                                <div className="inv-ledger__section">
                                  <div className="inv-ledger__section-title">Retraits</div>
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
                            <div aria-hidden>
                              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>
                              </svg>
                            </div>
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

          <div className="zb-footer-note">Données indicatives · Portfolio Zitouna Bladi</div>
        </main>
        </div>
      </section>
    </main>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   RevenueSparkCard — cumulative revenue curve over 10 years.
   The curve shows REAL cumulative revenue = annual × t (TND on Y, years
   on X). A dashed horizontal line marks the investment (break-even);
   a diamond marker highlights the year the portfolio breaks even.
   When the user has no revenue yet, we still show a light illustrative
   curve and invite them to buy their first plot.
   ══════════════════════════════════════════════════════════════════════ */
function RevenueSparkCard({ totalRevenue, totalInvested, onExplore }) {
  const HORIZON = 10
  const W = 520
  const H = 120
  const PAD_T = 10
  const PAD_B = 18
  const PLOT_H = H - PAD_T - PAD_B

  const annual = Math.max(0, Number(totalRevenue) || 0)
  const invested = Math.max(0, Number(totalInvested) || 0)
  const hasData = annual > 0 && invested > 0

  // Cumulative revenue at horizon + break-even year (may fall past horizon).
  const cumulAtHorizon = annual * HORIZON
  const paybackYears = annual > 0 ? invested / annual : 0
  // Y-axis max: whichever is bigger so the break-even line is visible.
  const yMax = Math.max(cumulAtHorizon, invested) * 1.08 || 1

  // 24 sample points along the straight cumul line (kept as a polyline so
  // the gradient fill under it looks smooth).
  const points = useMemo(() => {
    const pts = []
    const steps = 24
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * HORIZON
      const cumul = annual * t
      const x = (i / steps) * W
      const y = PAD_T + (1 - cumul / yMax) * PLOT_H
      pts.push([x, y])
    }
    return pts
  }, [annual, yMax, PLOT_H])

  const pathD = useMemo(() => {
    if (!points.length) return ''
    return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  }, [points])
  const areaD = `${pathD} L${W},${H - PAD_B} L0,${H - PAD_B} Z`

  // Where the dashed break-even line sits on the Y axis.
  const breakEvenY = PAD_T + (1 - invested / yMax) * PLOT_H
  // Where the break-even diamond sits on the curve (if reached in horizon).
  const breakEvenReached = paybackYears > 0 && paybackYears <= HORIZON
  const breakEvenX = breakEvenReached ? (paybackYears / HORIZON) * W : null

  const endPt = points[points.length - 1]

  // Endpoint label formatting.
  const fmtTND = (n) => Math.round(n).toLocaleString('fr-FR')
  const pwYears = Math.floor(paybackYears)
  const pwMonths = Math.round((paybackYears - pwYears) * 12)
  const paybackLabel = !hasData
    ? null
    : pwYears > 0
      ? (pwMonths > 0 ? `${pwYears} an${pwYears > 1 ? 's' : ''} ${pwMonths} mois` : `${pwYears} an${pwYears > 1 ? 's' : ''}`)
      : `${pwMonths} mois`

  return (
    <div className="zb-card zb-spark">
      <div className="zb-spark-head">
        <div>
          <h3>Mes revenus</h3>
          <div className="zb-sub">
            {hasData
              ? <>Cumul projeté sur {HORIZON} ans · <strong>{fmtTND(cumulAtHorizon)} TND</strong></>
              : <>Projection sur {HORIZON} ans — ajoutez une parcelle pour démarrer</>}
          </div>
        </div>
        {hasData && breakEvenReached && (
          <span className="zb-spark-chip" title="Année où vos revenus cumulés égalent votre investissement">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            Remboursé en {paybackLabel}
          </span>
        )}
      </div>

      <svg className="zb-spark-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Courbe de revenu cumulé">
        <defs>
          <linearGradient id="zb-spark-g1" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#1E5CFF" stopOpacity={hasData ? 0.22 : 0.08} />
            <stop offset="100%" stopColor="#1E5CFF" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Baseline */}
        <line x1="0" y1={H - PAD_B} x2={W} y2={H - PAD_B} stroke="#ECECEC" strokeWidth="1" />

        {/* Break-even dashed line (investment level) */}
        {hasData && invested > 0 && breakEvenY > PAD_T && breakEvenY < H - PAD_B && (
          <>
            <line
              x1="0" y1={breakEvenY} x2={W} y2={breakEvenY}
              stroke="#B9A769" strokeWidth="1" strokeDasharray="4 4" opacity="0.8"
            />
            <text x={W - 6} y={breakEvenY - 4} textAnchor="end" fontSize="10" fill="#9A864F" fontWeight="600">
              Investi · {fmtTND(invested)} TND
            </text>
          </>
        )}

        {/* Filled area + curve */}
        <path d={areaD} fill="url(#zb-spark-g1)" />
        <path
          d={pathD}
          fill="none"
          stroke={hasData ? '#1E5CFF' : '#C8C8C0'}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={hasData ? undefined : '5 5'}
        />

        {/* Break-even diamond on the curve */}
        {hasData && breakEvenReached && breakEvenX != null && (
          <g transform={`translate(${breakEvenX},${breakEvenY})`}>
            <rect x="-6" y="-6" width="12" height="12" transform="rotate(45)" fill="#FFFFFF" stroke="#B9A769" strokeWidth="2" />
            <rect x="-2.5" y="-2.5" width="5" height="5" transform="rotate(45)" fill="#B9A769" />
          </g>
        )}

        {/* Endpoint marker */}
        {hasData && endPt && (
          <>
            <circle cx={endPt[0]} cy={endPt[1]} r="8" fill="#1E5CFF" opacity="0.15" />
            <circle cx={endPt[0]} cy={endPt[1]} r="4" fill="#1E5CFF" />
          </>
        )}
      </svg>

      <div className="zb-spark-footer">
        {[0, 2, 4, 6, 8, 10].map((y) => (
          <span key={y}>{y === 0 ? 'Aujourd’hui' : `${y} ans`}</span>
        ))}
      </div>

      {!hasData && onExplore && (
        <button className="zb-btn zb-btn-primary zb-spark-empty-cta" type="button" onClick={onExplore}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          Explorer les projets
        </button>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   ProfileRevenuePanel — rich "Mes revenus" section surfaced at the top
   of Mon profil. Aggregates per-plot annual revenue from `myPurchases`
   (which flows through computePlotAnnualRevenue → project.annualRevenueTotal
   × surface share) and derives:
     · mensuel / journalier projections
     · ROI ring + payback horizon
     · cumul 1 / 3 / 5 / 10 ans (switchable)
     · répartition stackée par projet
     · top 3 parcelles (médailles)
   Empty state shown when user has no purchases yet.
   ══════════════════════════════════════════════════════════════════════ */
function ProfileRevenuePanel({ purchases, totalInvested, totalRevenue }) {
  const hasData = (purchases?.length ?? 0) > 0 && totalRevenue > 0
  const monthly = totalRevenue / 12
  const daily = totalRevenue / 365
  const roiPct = totalInvested > 0 ? (totalRevenue / totalInvested) * 100 : 0
  const paybackYears = totalRevenue > 0 ? (totalInvested / totalRevenue) : 0

  const byProject = useMemo(() => {
    const map = new Map()
    for (const p of purchases || []) {
      const key = p.projectId
      const row = map.get(key) || { projectId: key, title: p.projectTitle || key, city: p.city, revenue: 0, plots: 0, area: 0 }
      row.revenue += Number(p.annualRevenue) || 0
      row.plots += 1
      row.area += Number(p.area) || 0
      map.set(key, row)
    }
    const list = Array.from(map.values()).sort((a, b) => b.revenue - a.revenue)
    const tot = list.reduce((s, x) => s + x.revenue, 0) || 1
    return list.map((x, i) => ({ ...x, pct: (x.revenue / tot) * 100, colorIdx: i }))
  }, [purchases])

  const topPlots = useMemo(() => (
    [...(purchases || [])]
      .sort((a, b) => (Number(b.annualRevenue) || 0) - (Number(a.annualRevenue) || 0))
      .slice(0, 3)
  ), [purchases])

  const animRevenue = useCountUp(totalRevenue, { duration: 1100, delay: 40 })
  const animMonthly = useCountUp(Math.round(monthly), { duration: 1100, delay: 120 })
  const animDaily = useCountUp(Math.round(daily), { duration: 1100, delay: 200 })

  const RING_SIZE = 104
  const RING_STROKE = 10
  const r = (RING_SIZE - RING_STROKE) / 2
  const circ = 2 * Math.PI * r
  // Ring fills proportionally to ROI%. Anything past 100% still shows a
  // full ring — the badge number keeps the precise figure.
  const ringPct = Math.max(0, Math.min(100, roiPct))
  const offset = circ - (ringPct / 100) * circ

  // Project palette — six distinct hues that work on the dashboard's
  // dark-green background. Cycled when a user owns >6 projects.
  const PROJECT_COLORS = ['#0a84ff', '#30d158', '#bf5af2', '#64d2ff', '#ff9f0a', '#ff453a']

  if (!hasData) {
    return (
      <section className="inv-rev-panel inv-rev-panel--empty" aria-label="Mes revenus">
        <div className="inv-rev-panel__empty-icon" aria-hidden>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22V12m0 0C12 7 7 4 3 6m9 6c0-5 5-8 9-6"/></svg>
        </div>
        <div className="inv-rev-panel__empty-title">Aucun revenu projeté</div>
        <div className="inv-rev-panel__empty-sub">
          Achetez votre première parcelle pour voir ici votre rendement détaillé.
        </div>
      </section>
    )
  }

  // Condensed "Mes revenus" panel. The top KPI strip already shows the big
  // numbers (oliviers / TND investis / TND an / ROI), so this block only
  // carries the unique value-adds: the /mois & /jour breakdown, payback,
  // per-project split (when >1 project) and the top-3 parcelles.
  const showProjectBreakdown = byProject.length > 1
  const mostProductivePlot = topPlots[0] || null
  void roiPct; void animRevenue; void RING_SIZE; void RING_STROKE; void r; void circ; void offset; void PROJECT_COLORS

  return (
    <section className="inv-rev-panel inv-rev-panel--slim" aria-labelledby="inv-rev-panel-title">
      <header className="inv-rev-panel__slim-head">
        <h4 className="inv-rev-panel__slim-title" id="inv-rev-panel-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
          </svg>
          Mes revenus
        </h4>
        <span
          className="inv-rev-panel__slim-help"
          title="Projection basée sur les arbres de chaque parcelle (cohortes × rendement par âge)."
          aria-label="Aide sur le calcul"
        >
          ⓘ
        </span>
      </header>

      {/* Chips row: monthly / daily / payback — the unique insights */}
      <div className="inv-rev-panel__chips">
        <div className="inv-rev-panel__chip">
          <span className="inv-rev-panel__chip-num">{Math.round(animMonthly).toLocaleString('fr-FR')}</span>
          <span className="inv-rev-panel__chip-lbl">DT / mois</span>
        </div>
        <div className="inv-rev-panel__chip">
          <span className="inv-rev-panel__chip-num">{Math.round(animDaily).toLocaleString('fr-FR')}</span>
          <span className="inv-rev-panel__chip-lbl">DT / jour</span>
        </div>
        {paybackYears > 0 && (
          <div className="inv-rev-panel__chip inv-rev-panel__chip--accent">
            <span className="inv-rev-panel__chip-num">
              {paybackYears >= 10 ? Math.round(paybackYears) : paybackYears.toFixed(1)}
              <small>&nbsp;an{paybackYears >= 2 ? 's' : ''}</small>
            </span>
            <span className="inv-rev-panel__chip-lbl">Recouvrement</span>
          </div>
        )}
      </div>

      {/* Project breakdown — only when the user owns ≥2 projects */}
      {showProjectBreakdown && (
        <div className="inv-rev-panel__slim-proj">
          <div className="inv-rev-panel__slim-proj-head">
            <span className="inv-rev-panel__slim-label">Par projet</span>
          </div>
          <div className="inv-rev-panel__stack" role="img" aria-label="Répartition par projet">
            {byProject.map((row) => (
              <span
                key={row.projectId}
                className="inv-rev-panel__stack-seg"
                style={{ width: `${row.pct}%`, background: PROJECT_COLORS[row.colorIdx % PROJECT_COLORS.length] }}
                title={`${row.title} · ${Math.round(row.pct)}%`}
              />
            ))}
          </div>
          <ul className="inv-rev-panel__bd-list">
            {byProject.map((row) => (
              <li key={row.projectId} className="inv-rev-panel__bd-row">
                <span
                  className="inv-rev-panel__bd-dot"
                  style={{ background: PROJECT_COLORS[row.colorIdx % PROJECT_COLORS.length] }}
                  aria-hidden
                />
                <span className="inv-rev-panel__bd-title" title={row.title}>{row.title}</span>
                <span className="inv-rev-panel__bd-pct">{Math.round(row.pct)}%</span>
                <span className="inv-rev-panel__bd-amount">{Math.round(row.revenue).toLocaleString('fr-FR')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Meilleure parcelle (single, when mono-project) or top 3 (when multi) */}
      {topPlots.length > 0 && (
        showProjectBreakdown ? (
          <div className="inv-rev-panel__slim-plots">
            <span className="inv-rev-panel__slim-label">Meilleures parcelles</span>
            <ol className="inv-rev-panel__slim-plots-list">
              {topPlots.map((p, i) => (
                <li key={`${p.saleId}-${p.plotId}`} className="inv-rev-panel__slim-plot">
                  <span className="inv-rev-panel__slim-plot-rank">{i + 1}</span>
                  <div className="inv-rev-panel__slim-plot-body">
                    <div className="inv-rev-panel__slim-plot-title">
                      #{p.plotId} · {p.trees} arbres
                      {p.area ? <small> · {Number(p.area).toLocaleString('fr-FR')} m²</small> : null}
                    </div>
                    <div className="inv-rev-panel__slim-plot-sub" title={p.projectTitle}>
                      {p.projectTitle}
                    </div>
                  </div>
                  <div className="inv-rev-panel__slim-plot-amt">
                    <strong>{Math.round(Number(p.annualRevenue) || 0).toLocaleString('fr-FR')}</strong>
                    <span>DT/an</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : mostProductivePlot ? (
          <div className="inv-rev-panel__slim-single">
            <div className="inv-rev-panel__slim-single-head">
              <span className="inv-rev-panel__slim-label">Votre parcelle</span>
              <span className="inv-rev-panel__slim-single-amt">
                <strong>{Math.round(Number(mostProductivePlot.annualRevenue) || 0).toLocaleString('fr-FR')}</strong> DT/an
              </span>
            </div>
            <div className="inv-rev-panel__slim-single-body">
              <span className="inv-rev-panel__slim-single-badge">#{mostProductivePlot.plotId}</span>
              <span>
                <strong>{mostProductivePlot.trees}</strong> arbres
                {mostProductivePlot.area ? ` · ${Number(mostProductivePlot.area).toLocaleString('fr-FR')} m²` : ''}
              </span>
              <span className="inv-rev-panel__slim-single-proj" title={mostProductivePlot.projectTitle}>
                {mostProductivePlot.projectTitle}
              </span>
            </div>
          </div>
        ) : null
      )}
    </section>
  )
}
