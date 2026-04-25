import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext.jsx'
import {
  useAmbassadorReferralSummary,
  useProjectsScoped,
  useSalesScoped,
} from '../lib/useSupabase.js'
import { buildMyPurchases } from '../lib/buildMyPurchases.js'
import NotificationsMenu from '../components/NotificationsMenu.jsx'
import headerLogo from '../../logo-header2.png'
import './hub-page.css'

/*
 * HubPage — experimental simplified hub (test route: /hub).
 *
 * Single-page experience:
 *  · see all your pieces (parcelles)
 *  · click one → inline detail panel opens over the grid
 *  · "Présenter" switch masks financials so you can show the card to a friend
 *  · one-tap Partager / J'aime / Vendre / Commissions, all from the same page
 *
 * Intentionally isolated from DashboardShell so iterating on the workflow
 * can't affect the production dashboard routes. Reads the same data hooks
 * (no writes, no schema changes) so this is safe to iterate on.
 */

function fmtDT(n) {
  return Math.round(Number(n) || 0).toLocaleString('fr-FR')
}

function isCompletedNotarized(s) {
  return (
    String(s?.status || '').toLowerCase() === 'completed' &&
    Boolean(s?.notaryCompletedAt)
  )
}

function pieceKey(piece) {
  return `${piece.saleId}-${piece.plotId}`
}

// Deterministic gradient per-piece so the card visuals are stable across
// renders even without a server-side image. Much nicer than a flat fallback.
function piecePalette(seed) {
  const palettes = [
    ['#1E5CFF', '#7AB8FF'], // blue
    ['#0FA968', '#6ED29E'], // emerald
    ['#B7791F', '#F0C34A'], // amber
    ['#7C3AED', '#C4B5FD'], // violet
    ['#DC2626', '#FCA5A5'], // red
    ['#0891B2', '#67E8F9'], // cyan
  ]
  const key = String(seed || '')
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0
  const idx = Math.abs(hash) % palettes.length
  return palettes[idx]
}

function PieceThumb({ piece, masked }) {
  const [a, b] = piecePalette(pieceKey(piece))
  return (
    <div
      className="hub-thumb"
      style={{ background: `linear-gradient(135deg, ${a} 0%, ${b} 100%)` }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 120 80" preserveAspectRatio="xMidYMid slice">
        <path d="M0 60 L30 42 L55 55 L85 30 L120 48 L120 80 L0 80 Z" fill="rgba(255,255,255,0.18)" />
        <path d="M0 70 L25 58 L50 65 L80 48 L120 62 L120 80 L0 80 Z" fill="rgba(255,255,255,0.28)" />
        <circle cx="95" cy="22" r="8" fill="rgba(255,255,255,0.35)" />
      </svg>
      <div className="hub-thumb-tag">
        {masked ? '••••' : `#${piece.plotId}`}
      </div>
    </div>
  )
}

function HeartIcon({ filled }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.7 1.1-1a5.5 5.5 0 0 0 0-7.7z" />
    </svg>
  )
}

function useLocalLikes() {
  const storageKey = 'hub:likes:v1'
  const [likes, setLikes] = useState(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      return raw ? new Set(JSON.parse(raw)) : new Set()
    } catch {
      return new Set()
    }
  })
  const toggle = useCallback((key) => {
    setLikes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]))
      } catch { /* ignore */ }
      return next
    })
  }, [])
  return [likes, toggle]
}

export default function HubPage() {
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

  const hasAdminAccess = auth?.hasAdminAccess
  const canAccessSellPortal = auth?.canAccessSellPortal

  const displayName = adminUser?.name || user?.firstname || user?.name || 'Investisseur'
  const firstName = String(displayName).split(/\s+/)[0] || 'Investisseur'

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

  const mySales = useMemo(() => {
    if (!clientId) return []
    const cidStr = String(clientId)
    const out = []
    for (const s of mySalesRaw || []) {
      if (s.status === 'cancelled' || s.status === 'rejected') continue
      const sellerBound =
        String(s.ambassadorClientId || '') === cidStr ||
        String(s.sellerClientId || '') === cidStr
      if (sellerBound) continue
      if (isCompletedNotarized(s)) out.push(s)
    }
    return out
  }, [mySalesRaw, clientId])

  const scopedProjectIds = useMemo(
    () => [...new Set((mySales || []).map((s) => s.projectId).filter(Boolean))],
    [mySales],
  )
  const { projects } = useProjectsScoped(scopedProjectIds)

  const pieces = useMemo(() => buildMyPurchases(mySales, projects), [mySales, projects])

  const { summary: referralSummary } = useAmbassadorReferralSummary(Boolean(clientId))
  const walletBalance = Number(referralSummary?.walletBalance ?? 0)
  const pendingCommission = Number(referralSummary?.gainsAccrued ?? 0)

  const [presentMode, setPresentMode] = useState(false)
  const [selectedKey, setSelectedKey] = useState(null)
  const [shareFeedback, setShareFeedback] = useState('')
  const [likes, toggleLike] = useLocalLikes()

  // Inline "Vendre à un ami" form — lives inside the detail panel so the
  // full sell flow never leaves this page. Submit creates a sell intent
  // (no backend write yet) that an agent follows up on.
  const [sellOpen, setSellOpen] = useState(false)
  const [sellForm, setSellForm] = useState({ firstName: '', lastName: '', countryCode: '+216', phone: '' })
  const [sellStatus, setSellStatus] = useState(null) // 'sent' | 'error' | null
  const [sellSubmitting, setSellSubmitting] = useState(false)

  const selectedPiece = useMemo(
    () => pieces.find((p) => pieceKey(p) === selectedKey) || null,
    [pieces, selectedKey],
  )

  useEffect(() => {
    if (!selectedPiece) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setSelectedKey(null) }
    document.addEventListener('keydown', onKey)
    // Prevent background scroll while the inline panel is open on mobile.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [selectedPiece])

  useEffect(() => {
    if (!shareFeedback) return undefined
    const t = window.setTimeout(() => setShareFeedback(''), 2500)
    return () => window.clearTimeout(t)
  }, [shareFeedback])

  // Reset the sell form whenever the detail panel closes or switches parcel
  // so the user doesn't see stale data if they re-open another piece.
  useEffect(() => {
    setSellOpen(false)
    setSellStatus(null)
    setSellSubmitting(false)
    setSellForm({ firstName: '', lastName: '', countryCode: '+216', phone: '' })
  }, [selectedKey])

  const handleShare = useCallback(async (piece) => {
    const url = `${window.location.origin}/project/${piece.projectId}/plot/${piece.plotId}`
    const text = `Regardez cette parcelle #${piece.plotId} — ${piece.projectTitle}${piece.city ? ` · ${piece.city}` : ''}`
    try {
      if (navigator.share) {
        await navigator.share({ title: piece.projectTitle, text, url })
        setShareFeedback('Partagé')
        return
      }
    } catch { /* cancelled or unsupported — fall through to copy */ }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`)
      setShareFeedback('Lien copié')
    } catch {
      setShareFeedback('Impossible de copier — copiez manuellement.')
    }
  }, [])

  const handleShareWhatsapp = useCallback((piece) => {
    const url = `${window.location.origin}/project/${piece.projectId}/plot/${piece.plotId}`
    const text = `Regardez cette parcelle #${piece.plotId} — ${piece.projectTitle}${piece.city ? ` · ${piece.city}` : ''}\n${url}`
    const wa = `https://wa.me/?text=${encodeURIComponent(text)}`
    window.open(wa, '_blank', 'noopener,noreferrer')
  }, [])

  const openFullSellFunnel = useCallback((piece) => {
    navigate(`/admin/sell?projectId=${encodeURIComponent(piece.projectId)}&plot=${encodeURIComponent(piece.plotId)}`)
  }, [navigate])

  const submitSellIntent = useCallback(async (piece) => {
    if (sellSubmitting) return
    const phoneDigits = String(sellForm.phone || '').replace(/\D/g, '')
    if (!sellForm.firstName.trim() || phoneDigits.length < 6) {
      setSellStatus('error')
      return
    }
    setSellSubmitting(true)
    setSellStatus(null)
    try {
      // Persist the intent locally so a refresh doesn't lose it. A real
      // backend hook can be wired in later — the UI contract stays the
      // same ("request sent → agent follows up").
      const intent = {
        id: `hub-sell-${Date.now()}`,
        createdAt: new Date().toISOString(),
        piece: { projectId: piece.projectId, projectTitle: piece.projectTitle, plotId: piece.plotId },
        friend: {
          firstName: sellForm.firstName.trim(),
          lastName: sellForm.lastName.trim(),
          phone: `${sellForm.countryCode}${phoneDigits}`,
        },
      }
      const raw = window.localStorage.getItem('hub:sell-intents:v1')
      const arr = raw ? JSON.parse(raw) : []
      arr.unshift(intent)
      window.localStorage.setItem('hub:sell-intents:v1', JSON.stringify(arr.slice(0, 50)))
      // Fake latency so the button state is visible, not a flash.
      await new Promise((r) => setTimeout(r, 400))
      setSellStatus('sent')
    } catch {
      setSellStatus('error')
    } finally {
      setSellSubmitting(false)
    }
  }, [sellForm, sellSubmitting])

  const handleLogout = useCallback(async () => {
    await logout()
    navigate('/login', { replace: true })
  }, [logout, navigate])

  const totalInvested = pieces.reduce((s, p) => s + (Number(p.invested) || 0), 0)
  const totalAnnual = pieces.reduce((s, p) => s + (Number(p.annualRevenue) || 0), 0)

  const portfolioLoading = Boolean(clientId) && salesLoading && (mySalesRaw?.length || 0) === 0

  return (
    <main className="hub">
      <header className="hub-top">
        <div className="hub-top-brand">
          <img src={headerLogo} alt="Zitouna Bladi" />
          <div>
            <div className="hub-top-name">Mon espace</div>
            <div className="hub-top-sub">Version expérimentale</div>
          </div>
        </div>
        <div className="hub-top-actions">
          <label className="hub-switch" title="Masquer les montants — mode présentation">
            <input
              type="checkbox"
              checked={presentMode}
              onChange={(e) => setPresentMode(e.target.checked)}
            />
            <span className="hub-switch-track"><span className="hub-switch-thumb" /></span>
            <span className="hub-switch-label">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              {presentMode ? 'Présentation' : 'Privé'}
            </span>
          </label>
          <NotificationsMenu />
          <button type="button" className="hub-back" onClick={() => navigate('/dashboard')} title="Revenir au tableau de bord classique">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18M13 5l7 7-7 7"/></svg>
            Ancien tableau
          </button>
          <button type="button" className="hub-logout" onClick={handleLogout} title="Déconnexion">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </header>

      <section className="hub-hero">
        <div className="hub-hero-text">
          <h1>Bonjour {firstName}</h1>
          <p>
            Tout votre patrimoine dans un seul endroit. Partagez une parcelle, vendez-la à un ami,
            ou suivez vos commissions — sans changer de page.
          </p>
        </div>
        <div className="hub-hero-stats">
          <div className="hub-stat">
            <div className="hub-stat-k">Parcelles</div>
            <div className="hub-stat-v">{pieces.length}</div>
          </div>
          <div className="hub-stat">
            <div className="hub-stat-k">Investi</div>
            <div className="hub-stat-v">
              {presentMode ? '•••' : fmtDT(totalInvested)}
              <span className="hub-stat-u">DT</span>
            </div>
          </div>
          <div className="hub-stat">
            <div className="hub-stat-k">Revenu / an</div>
            <div className="hub-stat-v hub-stat-v--accent">
              {presentMode ? '•••' : fmtDT(totalAnnual)}
              <span className="hub-stat-u">DT</span>
            </div>
          </div>
          <div className="hub-stat">
            <div className="hub-stat-k">Commissions dispo.</div>
            <div className="hub-stat-v">
              {presentMode ? '•••' : fmtDT(walletBalance)}
              <span className="hub-stat-u">DT</span>
            </div>
          </div>
        </div>
      </section>

      <section className="hub-pieces">
        <div className="hub-pieces-head">
          <h2>Mes parcelles</h2>
          <div className="hub-pieces-sub">
            {portfolioLoading ? 'Chargement…' : `${pieces.length} parcelle${pieces.length !== 1 ? 's' : ''}`}
            {presentMode && <span className="hub-pill-ghost">Mode présentation actif</span>}
          </div>
        </div>

        {portfolioLoading ? (
          <div className="hub-grid" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="hub-card hub-card--skeleton">
                <div className="hub-thumb hub-thumb--sk" />
                <div className="hub-card-body">
                  <span className="sk sk-line sk-line--title" style={{ width: '65%' }} />
                  <span className="sk sk-line sk-line--sub" style={{ width: '40%' }} />
                  <span className="sk sk-line sk-line--sub" style={{ width: '80%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : pieces.length === 0 ? (
          <div className="hub-empty">
            <div className="hub-empty-art">🌿</div>
            <h3>Aucune parcelle pour l'instant</h3>
            <p>Vos parcelles s'afficheront ici dès qu'une vente sera finalisée chez le notaire.</p>
            <button type="button" className="hub-btn hub-btn--primary" onClick={() => navigate('/browse')}>
              Explorer les projets
            </button>
          </div>
        ) : (
          <div className="hub-grid">
            {pieces.map((piece) => {
              const key = pieceKey(piece)
              const liked = likes.has(key)
              return (
                <article
                  key={key}
                  className={`hub-card${selectedKey === key ? ' hub-card--active' : ''}`}
                  onClick={() => setSelectedKey(key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedKey(key)
                    }
                  }}
                >
                  <PieceThumb piece={piece} masked={presentMode} />
                  <div className="hub-card-body">
                    <div className="hub-card-head">
                      <h3>Parcelle #{piece.plotId}</h3>
                      <button
                        type="button"
                        className={`hub-heart${liked ? ' hub-heart--on' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleLike(key) }}
                        aria-label={liked ? 'Retirer J\'aime' : 'J\'aime'}
                        title={liked ? 'Aimée' : 'J\'aime'}
                      >
                        <HeartIcon filled={liked} />
                      </button>
                    </div>
                    <div className="hub-card-project">{piece.projectTitle}</div>
                    {piece.city && <div className="hub-card-city"><span className="hub-dot" />{piece.city}</div>}
                    <div className="hub-card-stats">
                      <div>
                        <span className="hub-k">Investi</span>
                        <span className="hub-v">{presentMode ? '•••' : `${fmtDT(piece.invested)} DT`}</span>
                      </div>
                      <div>
                        <span className="hub-k">Revenu/an</span>
                        <span className="hub-v hub-v--accent">{presentMode ? '•••' : `${fmtDT(piece.annualRevenue)} DT`}</span>
                      </div>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {selectedPiece && (
        <div className="hub-detail-backdrop" onClick={() => setSelectedKey(null)} role="presentation">
          <aside
            className="hub-detail"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hub-detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="hub-detail-head">
              <div>
                <div className="hub-detail-eyebrow">Parcelle sélectionnée</div>
                <h2 id="hub-detail-title">Parcelle #{selectedPiece.plotId}</h2>
                <div className="hub-detail-project">
                  {selectedPiece.projectTitle}
                  {selectedPiece.city && <> · <span className="hub-detail-city">{selectedPiece.city}</span></>}
                </div>
              </div>
              <button
                type="button"
                className="hub-detail-close"
                onClick={() => setSelectedKey(null)}
                aria-label="Fermer"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>

            <PieceThumb piece={selectedPiece} masked={presentMode} />

            <div className="hub-detail-body">
              <div className="hub-detail-stats">
                <div>
                  <div className="hub-k">Investi</div>
                  <div className="hub-v hub-v--big">
                    {presentMode ? '•••' : `${fmtDT(selectedPiece.invested)} DT`}
                  </div>
                </div>
                <div>
                  <div className="hub-k">Revenu estimé / an</div>
                  <div className="hub-v hub-v--big hub-v--accent">
                    {presentMode ? '•••' : `${fmtDT(selectedPiece.annualRevenue)} DT`}
                  </div>
                </div>
              </div>

              <div className="hub-detail-section">
                <h4>Partager avec un ami</h4>
                <p className="hub-detail-hint">
                  Envoyez le lien de cette parcelle. L'ami peut l'ouvrir sans compte et vous pouvez lui vendre via le tunnel de vente.
                </p>
                <div className="hub-detail-actions">
                  <button type="button" className="hub-btn hub-btn--ghost" onClick={() => handleShare(selectedPiece)}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>
                    Partager
                  </button>
                  <button type="button" className="hub-btn hub-btn--ghost" onClick={() => handleShareWhatsapp(selectedPiece)}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z"/></svg>
                    WhatsApp
                  </button>
                  {shareFeedback && <span className="hub-detail-toast">{shareFeedback}</span>}
                </div>
              </div>

              <div className="hub-detail-section">
                <h4>Vendre à un ami</h4>
                <p className="hub-detail-hint">
                  Entrez le contact de votre ami. Un conseiller le rappellera pour finaliser la vente — votre commission sera liée à cette parcelle.
                </p>

                {!sellOpen && sellStatus !== 'sent' && (
                  <button
                    type="button"
                    className="hub-btn hub-btn--primary"
                    onClick={() => setSellOpen(true)}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
                    Proposer à un ami
                  </button>
                )}

                {sellOpen && sellStatus !== 'sent' && (
                  <form
                    className="hub-sell-form"
                    onSubmit={(e) => { e.preventDefault(); submitSellIntent(selectedPiece) }}
                  >
                    <div className="hub-sell-row">
                      <label className="hub-field">
                        <span>Prénom</span>
                        <input
                          type="text"
                          value={sellForm.firstName}
                          onChange={(e) => setSellForm((f) => ({ ...f, firstName: e.target.value }))}
                          placeholder="Ahmed"
                          autoComplete="given-name"
                          required
                        />
                      </label>
                      <label className="hub-field">
                        <span>Nom</span>
                        <input
                          type="text"
                          value={sellForm.lastName}
                          onChange={(e) => setSellForm((f) => ({ ...f, lastName: e.target.value }))}
                          placeholder="Ben Salah"
                          autoComplete="family-name"
                        />
                      </label>
                    </div>
                    <label className="hub-field">
                      <span>Téléphone</span>
                      <div className="hub-phone">
                        <select
                          value={sellForm.countryCode}
                          onChange={(e) => setSellForm((f) => ({ ...f, countryCode: e.target.value }))}
                          aria-label="Indicatif pays"
                        >
                          <option value="+216">🇹🇳 +216</option>
                          <option value="+33">🇫🇷 +33</option>
                          <option value="+213">🇩🇿 +213</option>
                          <option value="+212">🇲🇦 +212</option>
                          <option value="+218">🇱🇾 +218</option>
                          <option value="+971">🇦🇪 +971</option>
                          <option value="+966">🇸🇦 +966</option>
                          <option value="+1">🇨🇦 +1</option>
                          <option value="+44">🇬🇧 +44</option>
                        </select>
                        <input
                          type="tel"
                          inputMode="numeric"
                          value={sellForm.phone}
                          onChange={(e) => setSellForm((f) => ({ ...f, phone: e.target.value }))}
                          placeholder="20 123 456"
                          autoComplete="tel-national"
                          required
                        />
                      </div>
                    </label>
                    {sellStatus === 'error' && (
                      <div className="hub-sell-error">Merci de renseigner un prénom et un téléphone valide.</div>
                    )}
                    <div className="hub-detail-actions">
                      <button
                        type="submit"
                        className="hub-btn hub-btn--primary"
                        disabled={sellSubmitting}
                      >
                        {sellSubmitting ? 'Envoi…' : 'Envoyer la demande'}
                      </button>
                      <button
                        type="button"
                        className="hub-btn hub-btn--ghost"
                        onClick={() => { setSellOpen(false); setSellStatus(null) }}
                        disabled={sellSubmitting}
                      >
                        Annuler
                      </button>
                    </div>
                  </form>
                )}

                {sellStatus === 'sent' && (
                  <div className="hub-sell-success">
                    <div className="hub-sell-success-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>
                    <div>
                      <strong>Demande envoyée</strong>
                      <p>Un conseiller contactera {sellForm.firstName || 'votre ami'} dans les 24h pour finaliser la vente de la parcelle #{selectedPiece.plotId}.</p>
                    </div>
                    <button
                      type="button"
                      className="hub-btn hub-btn--ghost"
                      onClick={() => { setSellStatus(null); setSellOpen(false); setSellForm({ firstName: '', lastName: '', countryCode: '+216', phone: '' }) }}
                    >
                      Nouvelle demande
                    </button>
                  </div>
                )}

                {(canAccessSellPortal || hasAdminAccess) && (
                  <button
                    type="button"
                    className="hub-btn hub-btn--link"
                    onClick={() => openFullSellFunnel(selectedPiece)}
                  >
                    Ou ouvrir le tunnel de vente complet
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
                  </button>
                )}
              </div>

              <div className="hub-detail-section">
                <h4>Commissions liées</h4>
                <div className="hub-detail-kpis">
                  <div>
                    <div className="hub-k">Disponible</div>
                    <div className="hub-v">{presentMode ? '•••' : `${fmtDT(walletBalance)} DT`}</div>
                  </div>
                  <div>
                    <div className="hub-k">En attente</div>
                    <div className="hub-v">{presentMode ? '•••' : `${fmtDT(pendingCommission)} DT`}</div>
                  </div>
                </div>
                <button
                  type="button"
                  className="hub-btn hub-btn--ghost"
                  onClick={() => navigate('/my/commissions')}
                >
                  Voir le détail des commissions
                </button>
              </div>

              <div className="hub-detail-section">
                <button
                  type="button"
                  className="hub-btn hub-btn--link"
                  onClick={() => navigate(`/project/${selectedPiece.projectId}/plot/${selectedPiece.plotId}`)}
                >
                  Voir la fiche complète de la parcelle
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  )
}
