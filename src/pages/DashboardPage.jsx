import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { addInstallmentReceiptRecord, requestAmbassadorPayout, updatePaymentStatus, uploadInstallmentReceipt } from '../lib/db.js'
import { computeInstallmentSaleMetrics, formatMoneyTnd } from '../domain/installmentMetrics.js'
import './dashboard-page.css'
import './installments-page.css'

const REVENUE_PER_TREE = 90
const MAX_IMAGE_DIMENSION = 1600
const IMAGE_QUALITY = 0.76
const MAX_IMAGE_BYTES = 450 * 1024
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
    adminUser,
    clientProfile,
    logout,
    refreshAuth,
  } = useAuth()

  const displayName = adminUser?.name || user?.firstname || user?.name || 'Investisseur'

  const clientId = clientProfile?.id || null

  // Self-heal on mount: if the logged-in user has no clientProfile yet but
  // DOES have an auth.uid, call heal_my_client_profile_now() which links any
  // orphan clients row (stub created by a delegated seller + buyer email
  // matches the auth user). Silent if already linked. This replaces the
  // "you must log out and log back in for the link to take effect" behavior.
  const healedRef = useRef(false)
  useEffect(() => {
    if (healedRef.current) return
    if (!user?.id) return
    if (clientProfile?.id) return
    healedRef.current = true
    ;(async () => {
      try {
        const { data, error } = await supabase.rpc('heal_my_client_profile_now')
        if (error) {
          console.warn('[Dashboard] heal_my_client_profile_now error:', error.message)
          return
        }
        if (data?.linked > 0 || (data?.ok && data?.clientId)) {
          console.info('[Dashboard] profile healed:', data)
          refreshAuth?.()
        }
      } catch (e) {
        console.warn('[Dashboard] heal failed:', e?.message || e)
      }
    })()
  }, [user?.id, clientProfile?.id, refreshAuth])

  const { sales: mySalesRaw } = useSalesScoped({ clientId })
  const { plans: myPlans, refresh: refreshPlans } = useInstallmentsScoped({ clientId })
  const { sales: ambassadorSales } = useSalesBySellerClientId(clientId || '')
  const showAmbassadorCard = Boolean(clientId)
  const { summary: referralSummary, loading: referralLoading, refresh: refreshReferralSummary } =
    useAmbassadorReferralSummary(showAmbassadorCard)
  const { events: myCommissionEvents, loading: ledgerLoading, refresh: refreshCommissionLedger } = useMyCommissionLedger(clientId || false)
  const [referralLoadStale, setReferralLoadStale] = useState(false)
  useEffect(() => {
    if (!referralLoading) {
      setReferralLoadStale(false)
      return undefined
    }
    setReferralLoadStale(false)
    const t = window.setTimeout(() => setReferralLoadStale(true), 30000)
    return () => window.clearTimeout(t)
  }, [referralLoading])
  const referralHasError = referralSummary?.reason === 'rpc_error' || referralLoadStale
  const [payoutBusy, setPayoutBusy] = useState(false)
  const [payoutError, setPayoutError] = useState('')
  const payoutIdempotencyRef = useRef(null)
  const [payoutConfirmOpen, setPayoutConfirmOpen] = useState(false)
  // Hybrid rule: staff / Super Admin can ALSO buy. The buyer portfolio is
  // visible whenever a clientProfile has resolved (clientId present); the
  // per-sale filter below excludes sales where the current user is the seller
  // or ambassador, so hybrid accounts never see their own sell-side work here.
  const portfolioAllowed = Boolean(clientId)
  const mySalesAll = useMemo(
    () =>
      // Dashboard portfolio is buyer-facing only.
      // Admin/seller-style accounts should not expose owned parcel portfolio here.
      (!portfolioAllowed ? [] : (mySalesRaw || []))
        .filter((s) => s.status !== 'cancelled' && s.status !== 'rejected')
        .filter((s) => {
          if (!portfolioAllowed) return false
          if (!clientId) return true
          const isSellerBound =
            String(s.ambassadorClientId || '') === String(clientId) ||
            String(s.sellerClientId || '') === String(clientId)
          return !isSellerBound
        }),
    [mySalesRaw, portfolioAllowed, clientId]
  )
  const mySales = useMemo(
    () => mySalesAll.filter((s) => saleInInvestorPortfolio(s)),
    [mySalesAll],
  )
  const mySalesInProgress = useMemo(
    () => mySalesAll.filter((s) => !saleInInvestorPortfolio(s)),
    [mySalesAll]
  )
  const scopedProjectIds = useMemo(
    () => [...new Set((mySalesAll || []).map((s) => s.projectId).filter(Boolean))],
    [mySalesAll]
  )
  const { projects: allProjects } = useProjectsScoped(scopedProjectIds)

  const { myPurchases } = useMemo(() => {
    const flat = []
    for (const sale of mySales) {
      const proj = allProjects.find((p) => p.id === sale.projectId)
      const plotIds = Array.isArray(sale.plotIds) ? sale.plotIds : (sale.plotId ? [sale.plotId] : [])
      for (const pid of plotIds) {
        const plot = proj?.plots?.find((pl) => pl.id === Number(pid) || pl.id === pid)
        const trees = plot?.trees || 0
        const invested = plot?.totalPrice || 0
        const annualRevenue = trees * REVENUE_PER_TREE
        const row = {
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
        }
        flat.push(row)
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
    if (referralVerificationBlocked || bal < min || bal <= 0) return
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
  useEffect(() => {
    if (activeTab !== 'parrainage') return undefined
    const beneficiaryId = clientProfile?.id
    if (!beneficiaryId) return undefined
    const filter = `beneficiary_client_id=eq.${beneficiaryId}`
    const reactEvent = () => {
      try { refreshReferralSummary?.() } catch { /* noop */ }
      try { refreshCommissionLedger?.() } catch { /* noop */ }
    }
    const channel = supabase
      .channel(`parrainage-live-${beneficiaryId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_events', filter }, reactEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_payout_requests', filter }, reactEvent)
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [activeTab, clientProfile?.id, refreshReferralSummary, refreshCommissionLedger])

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
  const [ipPayTarget, setIpPayTarget] = useState(null)
  const [ipReceiptName, setIpReceiptName] = useState('')
  const [ipReceiptFile, setIpReceiptFile] = useState(null)
  const [ipReceiptPreview, setIpReceiptPreview] = useState('')
  const [ipNote, setIpNote] = useState('')
  const [ipSubmitting, setIpSubmitting] = useState(false)
  const [ipError, setIpError] = useState('')
  const [showProfile, setShowProfile] = useState(false)
  const [profileForm, setProfileForm] = useState({})
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')

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
      finalFile = await optimizeImageFile(file)
      if (finalFile.size > MAX_IMAGE_BYTES) throw new Error('Image trop lourde')
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
    if (!ipPayTarget || !ipReceiptName || !ipReceiptFile || ipSubmitting) return
    setIpSubmitting(true); setIpError('')
    try {
      const plan = myPlans.find(p => p.id === ipPayTarget.planId)
      const payment = plan?.payments?.find(p => p.month === ipPayTarget.month)
      if (!payment?.id) throw new Error('Paiement introuvable')
      const url = await uploadInstallmentReceipt({ paymentId: payment.id, file: ipReceiptFile })
      await addInstallmentReceiptRecord({ paymentId: payment.id, receiptUrl: url || '', fileName: ipReceiptName, note: ipNote || '' })
      await updatePaymentStatus(payment.id, 'submitted', { receiptUrl: url || ipReceiptName })
      await refreshPlans({ force: true })
      ipClosePay()
    } catch (err) { setIpError(err.message || 'Échec envoi') }
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
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="inv-header__name">Bonjour, {displayName}</h2>
              <p className="inv-header__subtitle">Votre portefeuille d&apos;oliviers</p>
            </div>
            <button type="button" className="inv-header__profile-btn" onClick={openProfile} aria-label="Mon profil">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </button>
          </div>
          <div className="inv-header__actions">
            <button type="button" className="inv-header__cta" onClick={() => navigate('/browse')}>
              Prendre un rendez-vous
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
            Parrainage
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
                  {Math.round(animTrees).toLocaleString('fr-FR')}
                </span>
                <span className="inv-kpi__label">Oliviers</span>
              </div>
              <div className="inv-kpi-sep" />
              <div className="inv-kpi">
                <span className="inv-kpi__value">
                  {Math.round(animInvested).toLocaleString('fr-FR')}
                </span>
                <span className="inv-kpi__label">TND investis</span>
              </div>
              <div className="inv-kpi-sep" />
              <div className="inv-kpi">
                <span className="inv-kpi__value inv-kpi__value--green">
                  {Math.round(animRevenue).toLocaleString('fr-FR')}
                </span>
                <span className="inv-kpi__label">TND / an</span>
              </div>
              <div className="inv-kpi-sep" />
              <div className="inv-kpi">
                <span className="inv-kpi__value inv-kpi__value--blue">{animRoi.toFixed(1)}%</span>
                <span className="inv-kpi__label">ROI</span>
              </div>
            </div>

            <h3 className="inv-section-title">Mes parcelles</h3>

            {myPurchases.length === 0 && mySalesInProgress.length > 0 && (
              <div className="inv-progress-notice">
                Vous avez {mySalesInProgress.length} achat{mySalesInProgress.length !== 1 ? 's' : ''} en cours de finalisation.
                Les parcelles s&apos;affichent ici uniquement après <strong>finalisation notaire</strong>.
              </div>
            )}

            {myPurchases.length === 0 && mySalesInProgress.length === 0 && (
              <div className="inv-empty">
                <strong>Aucune parcelle</strong>
                <p>Vous ne possédez pas encore de parcelles.</p>
                <button type="button" className="inv-empty__btn" onClick={() => navigate('/browse')}>
                  Explorer les projets
                </button>
              </div>
            )}

            {myPurchases.length > 0 && (
              <div className="inv-parcels">
                {myPurchases.map((parcel) => {
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
          </>
        )}

        {/* ══════════════════════════════════════
           TAB: Mes Échéances (integrated)
           ══════════════════════════════════════ */}
        {activeTab === 'echeances' && (
          <div className="ip ip--embedded">
            {/* KPI strip */}
            <div className="ip__hero">
              <h1 className="ip__hero-title">Mes échéances</h1>
              <p className="ip__hero-sub">Suivez vos facilités en temps réel</p>
              <div className="ip__hero-kpi">
                <div className="ip__kpi"><span className="ip__kpi-value">{ipStats.total}</span><span className="ip__kpi-label">Plans</span></div>
                <div className="ip__kpi"><span className="ip__kpi-value">{ipStats.submitted}</span><span className="ip__kpi-label">En révision</span></div>
                <div className="ip__kpi"><span className="ip__kpi-value">{ipStats.rejected}</span><span className="ip__kpi-label">À corriger</span></div>
                <div className="ip__kpi"><span className="ip__kpi-value">{ipStats.approved}</span><span className="ip__kpi-label">Confirmés</span></div>
              </div>
            </div>

            {/* ── Detail view: single plan ── */}
            {focusedPlan ? (
              <>
                <button type="button" className="ip__back" onClick={() => setFocusedPlanId(null)}>← Tous les plans</button>
                <div className="ip__detail-head">
                  <div className="ip__detail-title">{focusedPlan.projectTitle}</div>
                  <div className="ip__detail-ref">{focusedPlan.projectCity} · #{focusedPlan.id}</div>
                  {(() => {
                    const sale = (mySalesRaw || []).find((s) => String(s.id) === String(focusedPlan.saleId)) || {}
                    const m = computeInstallmentSaleMetrics(sale, focusedPlan)
                    return (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 12 }}>
                        <div style={{ padding: '10px 12px', borderRadius: 12, background: '#ecfdf5', border: '1px solid #a7f3d0' }}>
                          <div style={{ fontSize: 9, fontWeight: 800, color: '#065f46', textTransform: 'uppercase', letterSpacing: '.03em' }}>Validé</div>
                          <div style={{ fontSize: 15, fontWeight: 800, color: '#065f46' }}>{formatMoneyTnd(m.cashValidatedStrict)}</div>
                          <div style={{ fontSize: 10, color: '#047857' }}>Araboun + mensualités confirmées</div>
                        </div>
                        <div style={{ padding: '10px 12px', borderRadius: 12, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                          <div style={{ fontSize: 9, fontWeight: 800, color: '#1e40af', textTransform: 'uppercase', letterSpacing: '.03em' }}>En révision</div>
                          <div style={{ fontSize: 15, fontWeight: 800, color: '#1e40af' }}>{formatMoneyTnd(m.submittedAmount)}</div>
                          <div style={{ fontSize: 10, color: '#1d4ed8' }}>Reçus envoyés, en attente</div>
                        </div>
                        <div style={{ padding: '10px 12px', borderRadius: 12, background: '#fef2f2', border: '1px solid #fecaca' }}>
                          <div style={{ fontSize: 9, fontWeight: 800, color: '#991b1b', textTransform: 'uppercase', letterSpacing: '.03em' }}>À corriger</div>
                          <div style={{ fontSize: 15, fontWeight: 800, color: '#991b1b' }}>{formatMoneyTnd(m.rejectedAmount)}</div>
                          <div style={{ fontSize: 10, color: '#b91c1c' }}>Reçus refusés à renvoyer</div>
                        </div>
                        <div style={{ padding: '10px 12px', borderRadius: 12, background: '#fff', border: '1px solid #e2e8f0' }}>
                          <div style={{ fontSize: 9, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '.03em' }}>Reste à valider</div>
                          <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>{formatMoneyTnd(m.remainingStrict)}</div>
                          <div style={{ fontSize: 10, color: '#64748b' }}>Sur un total de {formatMoneyTnd(m.saleAgreed)}</div>
                        </div>
                      </div>
                    )
                  })()}
                </div>
                <div className="ip__detail-hint">
                  <strong>Mode d&apos;emploi :</strong> En attente / Rejeté = envoyez ou corrigez un reçu. En révision = attente validation. Confirmé = rien à faire.
                </div>
                <div className="ip__payments">
                  {focusedPlan.payments.map(p => {
                    const meta = ipStatusMeta(p.status)
                    const receipt = lastReceipt(p)
                    const receiptIsImage = receipt && isImageUrl(receipt.url)
                    return (
                      <div key={`${focusedPlan.id}:${p.month}`} className="ip__pay-card">
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
              </>
            ) : (
              /* ── List view: all plans ── */
              <>
                {myPlans.length === 0 ? (
                  <div className="ip__empty">
                    <strong>Aucun plan d&apos;échéances</strong>
                    Vos plans apparaîtront ici après finalisation de votre achat.
                  </div>
                ) : (
                  <div className="ip__plan-list">
                    {myPlans.map(plan => {
                      const sale = (mySalesRaw || []).find((s) => String(s.id) === String(plan.saleId)) || {}
                      const metrics = computeInstallmentSaleMetrics(sale, plan)
                      const progress = metrics.approvedPct
                      const nextAction = plan.payments.find(p => p.status === 'rejected' || p.status === 'pending' || p.status === 'submitted')
                      return (
                        <button key={plan.id} type="button" className="ip__plan-card" onClick={() => setFocusedPlanId(plan.id)}>
                          <div className="ip__plan-head">
                            <span className="ip__plan-title">{plan.projectTitle}</span>
                            <span className="ip__plan-ref">{plan.projectCity}</span>
                          </div>
                          <div className="ip__plan-pills">
                            {metrics.submittedCount > 0 && <span className="ip__pill ip__pill--submitted">{metrics.submittedCount} en révision</span>}
                            {metrics.rejectedCount > 0 && <span className="ip__pill ip__pill--rejected">{metrics.rejectedCount} à corriger</span>}
                            {metrics.submittedCount === 0 && metrics.rejectedCount === 0 && <span className="ip__pill ip__pill--ok">Rythme normal</span>}
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 10, color: '#475569', marginTop: 4 }}>
                            <span>Validé : <strong style={{ color: '#065f46' }}>{formatMoneyTnd(metrics.cashValidatedStrict)}</strong></span>
                            <span>·</span>
                            <span>Reste : <strong style={{ color: '#0f172a' }}>{formatMoneyTnd(metrics.remainingStrict)}</strong></span>
                          </div>
                          <div className="ip__progress">
                            <div className="ip__progress-track">
                              <div className="ip__progress-fill" style={{ width: `${Math.max(progress, 2)}%` }} />
                            </div>
                            <span className="ip__progress-label">{metrics.approvedCount}/{metrics.totalMonths}</span>
                          </div>
                          <div className="ip__plan-next">
                            {nextAction ? `Prochaine action : F.${nextAction.month} — ${ipStatusMeta(nextAction.status).label}` : 'Toutes les facilités sont confirmées.'}
                          </div>
                          <div className="ip__plan-cta"><span>Ouvrir le détail</span><span aria-hidden>→</span></div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Receipt Upload Modal ── */}
        {ipPayTarget && (
          <div className="ip__overlay" onClick={ipClosePay}>
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
                <button type="button" className="ip__modal-submit" disabled={!ipReceiptName || ipSubmitting} onClick={ipSubmit}>
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
                  <h3 className="inv-wallet__title">Portefeuille Parrainage</h3>
                  <p className="inv-wallet__lead">
                    Commissions créditées au tampon légal, retirables selon les règles finance.
                  </p>
                  {!showAmbassadorCard && (
                    <p
                      className="inv-wallet__lead"
                      style={{ marginTop: 4, opacity: 0.7, fontStyle: 'italic' }}
                    >
                      Reliez votre profil client pour activer le parrainage
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
                <p className="inv-wallet__loading">Chargement du portefeuille…</p>
              ) : showAmbassadorCard && referralHasError ? (
                <div className="inv-wallet__alert inv-wallet__alert--error">
                  <p style={{ margin: 0, marginBottom: 6 }}>
                    Impossible de charger le portefeuille. Vérifiez votre connexion puis réessayez.
                  </p>
                  <button
                    type="button"
                    className="inv-wallet__btn"
                    onClick={() => refreshReferralSummary()}
                  >
                    Réessayer
                  </button>
                </div>
              ) : (
                  <>
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
                        Retrait min. {showAmbassadorCard ? (referralSummary?.minPayoutAmount ?? 0) : 0} DT · virement traité par la finance
                      </span>
                    </div>

                    <div className="inv-wallet__phases">
                      <div className="inv-wallet__phase">
                        <span className="inv-wallet__phase-label">Gains en attente</span>
                        <span className="inv-wallet__phase-value">
                          {(showAmbassadorCard ? (referralSummary?.gainsAccrued ?? 0) : 0).toLocaleString('fr-FR', {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}{' '}
                          DT
                        </span>
                        <span className="inv-wallet__phase-hint">Avant tampon (vente non terminée)</span>
                      </div>
                      <div className="inv-wallet__phase">
                        <span className="inv-wallet__phase-label">Crédit légal</span>
                        <span className="inv-wallet__phase-value">
                          {(showAmbassadorCard ? (referralSummary?.commissionsReleased ?? 0) : 0).toLocaleString('fr-FR', {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}{' '}
                          DT
                        </span>
                        <span className="inv-wallet__phase-hint">Tampon légal · pas encore payé</span>
                      </div>
                    </div>

                    <div className="inv-wallet__breakdown">
                      <div className="inv-wallet__bd-row">
                        <span className="inv-wallet__bd-label">Commission directe (L1)</span>
                        <span className="inv-wallet__bd-amount">{(Number(showAmbassadorCard ? referralSummary?.l1Total : 0) || 0).toLocaleString('fr-FR')} <small>DT</small></span>
                      </div>
                      <div className="inv-wallet__bd-row">
                        <span className="inv-wallet__bd-label">Commission indirecte (L2+)</span>
                        <span className="inv-wallet__bd-amount">{(Number(showAmbassadorCard ? referralSummary?.l2Total : 0) || 0).toLocaleString('fr-FR')} <small>DT</small></span>
                      </div>
                    </div>

                    {parrainageForecast && (
                      <section className="inv-forecast" aria-label="Potentiel de parrainage">
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
                    )}

                    {showAmbassadorCard && (
                      <div className="inv-ledger">
                        <div className="inv-ledger__head">
                          <h4 className="inv-ledger__title">D'où viennent vos commissions</h4>
                          <div className="inv-ledger__head-right">
                            <span className="inv-ledger__count">{myCommissionEvents.length} commission{myCommissionEvents.length !== 1 ? 's' : ''}</span>
                            {myCommissionEvents.length > 0 && (
                              <button
                                type="button"
                                className="inv-wallet__export"
                                onClick={handleExportCommissionsCsv}
                                aria-label="Exporter les commissions au format CSV"
                              >
                                Exporter (CSV)
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="inv-ledger__explainer">
                          <div className="inv-ledger__explainer-row"><span className="inv-ledger__explainer-dot" style={{ background: '#2563eb' }} />
                            <strong>Commission directe</strong> — vous avez vendu vous-même.
                          </div>
                          <div className="inv-ledger__explainer-row"><span className="inv-ledger__explainer-dot" style={{ background: '#f59e0b' }} />
                            <strong>Commission indirecte</strong> — quelqu'un que vous avez parrainé (ou dans votre ligne) a vendu.
                          </div>
                        </div>
                        {ledgerLoading && myCommissionEvents.length === 0 ? (
                          <div className="inv-ledger__empty">Chargement…</div>
                        ) : myCommissionEvents.length === 0 ? (
                          <div className="inv-ledger__empty">
                            Aucune commission pour l'instant. Vos gains apparaîtront ici dès qu'une de vos ventes (ou une vente de votre ligne) passe chez le notaire.
                          </div>
                        ) : (() => {
                          const commissionOnly = myCommissionEvents.filter((e) => e.kind !== 'payout')
                          const payoutsOnly = myCommissionEvents.filter((e) => e.kind === 'payout')
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
                            const levelBg = lvl === 1 ? '#2563eb' : lvl === 2 ? '#f59e0b' : lvl === 3 ? '#10b981' : lvl >= 4 ? '#8b5cf6' : '#64748b'
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
                                <div className="inv-ledger__lvl" style={{ background: levelBg }}>L{lvl}</div>
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
                                  <div className="inv-ledger__section-title">Ventes de votre ligne (parrainage)</div>
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
                      <p className="inv-wallet__alert inv-wallet__alert--warn">
                        Aucune commission pour le moment — elles apparaîtront dès la clôture notaire des ventes liées à votre code parrain.
                      </p>
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
                          <details style={{ fontSize: 11, marginTop: 8, opacity: 0.85 }}>
                            <summary style={{ cursor: 'pointer' }}>Pourquoi 0 DT ? (diagnostic)</summary>
                            <div style={{ marginTop: 6, padding: '8px 10px', background: 'rgba(255,255,255,0.04)', borderRadius: 6 }}>
                              <div style={{ marginBottom: 6 }}>{hint}</div>
                              <div style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.5 }}>
                                {`acheteur=${d.linkedAsBuyer ?? 0}  vendeur=${d.linkedAsSeller ?? 0}  parrain=${d.linkedAsAmbassador ?? 0}  agent=${d.linkedAsAgent ?? 0}`}
                                <br />
                                {`notariées=${d.notaryCompleteTotal ?? 0}  commission_events=${d.commissionEventCount ?? 0}`}
                              </div>
                              {Array.isArray(d.latestSales) && d.latestSales.length > 0 && (
                                <table style={{ marginTop: 8, fontSize: 10, borderCollapse: 'collapse', width: '100%' }}>
                                  <thead>
                                    <tr style={{ opacity: 0.6 }}>
                                      <th style={{ textAlign: 'left', padding: '2px 6px' }}>Code</th>
                                      <th style={{ textAlign: 'left', padding: '2px 6px' }}>Rôle</th>
                                      <th style={{ textAlign: 'left', padding: '2px 6px' }}>Notaire</th>
                                      <th style={{ textAlign: 'right', padding: '2px 6px' }}>Prix</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {d.latestSales.map((s) => (
                                      <tr key={s.id}>
                                        <td style={{ padding: '2px 6px', fontFamily: 'monospace' }}>{s.code || s.id.slice(0, 8)}</td>
                                        <td style={{ padding: '2px 6px' }}>
                                          {[s.as_buyer && 'acheteur', s.as_seller && 'vendeur', s.as_ambassador && 'parrain'].filter(Boolean).join(', ') || '—'}
                                        </td>
                                        <td style={{ padding: '2px 6px' }}>{s.notary_done ? '✓' : '—'}</td>
                                        <td style={{ padding: '2px 6px', textAlign: 'right' }}>{Number(s.agreed_price || 0).toLocaleString('fr-FR')}</td>
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
                    <button
                      type="button"
                      className="inv-wallet__btn"
                      disabled={
                        payoutBusy
                        || referralLoading
                        || referralVerificationBlocked
                        || (referralSummary?.walletBalance ?? 0) < (referralSummary?.minPayoutAmount ?? 0)
                        || (referralSummary?.walletBalance ?? 0) <= 0
                      }
                      onClick={() => { setPayoutError(''); setPayoutConfirmOpen(true) }}
                    >
                      {payoutBusy ? 'Traitement…' : 'Retirer les gains'}
                    </button>
                    <p className="inv-wallet__actions-note">
                      Le virement bancaire reste soumis à validation interne.
                    </p>
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

              {showAmbassadorCard && clientProfile?.referralCode && (
                <footer className="inv-wallet__code">
                  <span className="inv-wallet__code-label">Votre code parrain</span>
                  <code className="inv-wallet__code-value" dir="ltr">
                    {clientProfile.referralCode}
                  </code>
                  <span className="inv-wallet__code-hint">
                    Partagez ce code pour lier un nouveau dossier client.
                  </span>
                </footer>
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
