import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../components/AdminToast.jsx'
import { useClients, useSales } from '../../lib/useSupabase.js'
import { relinkAuthToClientWithTicket, reassignSaleClientWithTicket } from '../../lib/db.js'
import './zitouna-admin-page.css'
import './admin-patterns.css'
import './client-link-repair.css'

function parsePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return { countryCode: '+216', phoneLocal: '' }
  if (String(raw || '').trim().startsWith('+') && digits.length > 8) {
    return { countryCode: `+${digits.slice(0, digits.length - 8)}`, phoneLocal: digits.slice(-8) }
  }
  if (digits.length > 8) return { countryCode: `+${digits.slice(0, digits.length - 8)}`, phoneLocal: digits.slice(-8) }
  return { countryCode: '+216', phoneLocal: digits }
}

const isLikelyUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '').trim())

export default function ClientLinkRepairPage() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const { clients } = useClients()
  const { sales } = useSales()

  const [tab, setTab] = useState('relink')
  const [busy, setBusy] = useState(false)

  const [clientSearch, setClientSearch] = useState('')
  const [clientId, setClientId] = useState('')
  const [authUserId, setAuthUserId] = useState('')
  const [ticket, setTicket] = useState('')
  const [reason, setReason] = useState('')

  const [saleSearch, setSaleSearch] = useState('')
  const [saleId, setSaleId] = useState('')
  const [targetSearch, setTargetSearch] = useState('')
  const [targetClientId, setTargetClientId] = useState('')
  const [saleTicket, setSaleTicket] = useState('')
  const [saleReason, setSaleReason] = useState('')

  const filterClients = (list, q) => {
    const needle = String(q || '').trim().toLowerCase()
    if (!needle) return list
    return list.filter((c) => {
      const name = String(c.name || '').toLowerCase()
      const phone = String(c.phone || '').toLowerCase()
      return name.includes(needle) || phone.includes(needle)
    })
  }

  const clientOptions = useMemo(() => {
    const list = filterClients(clients || [], clientSearch)
    return list.slice(0, 200)
  }, [clients, clientSearch])

  const targetClientOptions = useMemo(() => {
    const list = filterClients(clients || [], targetSearch)
    return list.slice(0, 200)
  }, [clients, targetSearch])

  const saleOptions = useMemo(() => {
    const needle = String(saleSearch || '').trim().toLowerCase()
    const list = (sales || []).filter((s) => {
      if (!needle) return true
      const code = String(s.code || s.id || '').toLowerCase()
      const cname = String(s.clientName || '').toLowerCase()
      const proj = String(s.projectTitle || '').toLowerCase()
      return code.includes(needle) || cname.includes(needle) || proj.includes(needle)
    })
    return list.slice(0, 300)
  }, [sales, saleSearch])

  const selectedClient = useMemo(
    () => (clients || []).find((c) => String(c.id) === String(clientId)) || null,
    [clients, clientId],
  )
  const selectedSale = useMemo(
    () => (sales || []).find((s) => String(s.id) === String(saleId)) || null,
    [sales, saleId],
  )
  const selectedTargetClient = useMemo(
    () => (clients || []).find((c) => String(c.id) === String(targetClientId)) || null,
    [clients, targetClientId],
  )

  const relinkReady = Boolean(clientId && authUserId.trim() && isLikelyUuid(authUserId))
  const saleReady = Boolean(saleId && targetClientId)
  const saleSameClientWarning = selectedSale && selectedTargetClient && String(selectedSale.clientId || '') === String(selectedTargetClient.id || '')

  async function handleQuickRelink() {
    if (!clientId || !authUserId.trim()) {
      addToast('Client et Auth User ID requis.', 'error')
      return
    }
    const confirmMsg = `Relier le compte\n${authUserId.trim()}\nau client « ${selectedClient?.name || ''} » (${selectedClient?.phone || '—'}) ?\n\nAction tracée dans l'audit.`
    if (!window.confirm(confirmMsg)) return
    const p = parsePhone(selectedClient?.phone || '')
    setBusy(true)
    try {
      const res = await relinkAuthToClientWithTicket({
        clientId,
        authUserId: authUserId.trim(),
        countryCode: p.countryCode,
        phoneLocal: p.phoneLocal,
        ticket: ticket.trim(),
        reason: reason.trim(),
      })
      if (!res?.ok) throw new Error(res?.reason || 'relink_failed')
      addToast('Compte relié avec succès.')
      setAuthUserId(''); setTicket(''); setReason(''); setClientId(''); setClientSearch('')
    } catch (e) {
      addToast(`Erreur: ${e.message || e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function handleSaleReassign() {
    if (!saleId || !targetClientId) {
      addToast('Vente et client cible requis.', 'error')
      return
    }
    const confirmMsg = `Réaffecter la vente « ${selectedSale?.code || selectedSale?.id || ''} » à « ${selectedTargetClient?.name || ''} » ?\n\nAction tracée dans l'audit.`
    if (!window.confirm(confirmMsg)) return
    setBusy(true)
    try {
      const res = await reassignSaleClientWithTicket({
        saleId,
        targetClientId,
        ticket: saleTicket.trim(),
        reason: saleReason.trim(),
      })
      if (!res?.ok) throw new Error(res?.reason || 'sale_reassign_failed')
      addToast('Vente réaffectée.')
      setSaleId(''); setTargetClientId(''); setSaleTicket(''); setSaleReason(''); setSaleSearch(''); setTargetSearch('')
    } catch (e) {
      addToast(`Erreur: ${e.message || e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const noClients = !clients || clients.length === 0
  const noSales = !sales || sales.length === 0
  const uuidInvalid = authUserId && !isLikelyUuid(authUserId)

  return (
    <div className="zitu-page lr" dir="ltr">
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        <header className="lr-head">
          <div className="lr-head__icon" aria-hidden>🔗</div>
          <div className="lr-head__body">
            <h1 className="lr-head__title">Correction de liens client</h1>
            <div className="lr-head__sub">
              Outil de support. Toute action est tracée dans l'audit.{' '}
              <a href="#/admin/audit-log" className="lr-audit-link" onClick={(e) => { e.preventDefault(); navigate('/admin/audit-log') }}>Voir l'audit →</a>
            </div>
          </div>
        </header>

        {/* Tabs */}
        <div className="lr-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'relink'}
            className={`lr-tab ${tab === 'relink' ? 'lr-tab--active' : ''}`}
            onClick={() => setTab('relink')}
          >
            <span className="lr-tab__lead">🔐 Compte → client</span>
            <span className="lr-tab__sub">Relier un login auth</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'reassign'}
            className={`lr-tab ${tab === 'reassign' ? 'lr-tab--active' : ''}`}
            onClick={() => setTab('reassign')}
          >
            <span className="lr-tab__lead">🔄 Vente → client</span>
            <span className="lr-tab__sub">Réaffecter une vente</span>
          </button>
        </div>

        {/* TAB 1: Relink auth → client */}
        {tab === 'relink' ? (
          <div className="lr-panel" role="tabpanel">
            {noClients ? (
              <div className="adm-empty">Aucun client disponible. Rechargez la page.</div>
            ) : (
              <>
                <div className="lr-field">
                  <div className="lr-label">Fiche client cible</div>
                  <div className="lr-search lr-search--mb">
                    <span className="lr-search__icon" aria-hidden>🔍</span>
                    <input
                      type="text"
                      className="lr-input lr-search__input"
                      placeholder="Chercher par nom ou téléphone…"
                      value={clientSearch}
                      onChange={(e) => setClientSearch(e.target.value)}
                    />
                  </div>
                  <select className="lr-select" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                    <option value="">— Sélectionner un client ({clientOptions.length}) —</option>
                    {clientOptions.map((c) => (
                      <option key={c.id} value={c.id}>{c.name || 'Client'} · {c.phone || '—'}</option>
                    ))}
                  </select>
                </div>

                <div className="lr-field">
                  <div className="lr-label">
                    Auth User ID (UUID)
                  </div>
                  <input
                    className={`lr-input${uuidInvalid ? ' lr-input--bad' : ''}`}
                    value={authUserId}
                    onChange={(e) => setAuthUserId(e.target.value)}
                    placeholder="3f2a9b4e-1234-4abc-9def-0123456789ab"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {uuidInvalid ? (
                    <div className="lr-hint lr-hint--err">Format UUID invalide (attendu : 8-4-4-4-12 hexa).</div>
                  ) : !authUserId ? (
                    <div className="lr-uuid-help">
                      Copiez l'UUID depuis Supabase → Auth → Users. Exemple : <code>3f2a9b4e-1234-4abc-9def-0123456789ab</code>
                    </div>
                  ) : null}
                </div>

                <div className="lr-row">
                  <div className="lr-field">
                    <div className="lr-label">
                      Ticket <span className="lr-label__opt">optionnel</span>
                    </div>
                    <input className="lr-input" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="INC-1234" />
                  </div>
                  <div className="lr-field">
                    <div className="lr-label">
                      Raison <span className="lr-label__opt">optionnel</span>
                    </div>
                    <input className="lr-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Mauvais numéro saisi" />
                  </div>
                </div>

                {relinkReady ? (
                  <div className="lr-preview">
                    <div className="lr-preview__title">À valider</div>
                    <div className="lr-preview__row">
                      <span className="lr-preview__val-sub">Compte</span>
                      <span className="lr-preview__val lr-preview__val--mono">{authUserId.trim().slice(0, 13)}…</span>
                    </div>
                    <div className="lr-preview__row">
                      <span className="lr-preview__arrow">→</span>
                      <span className="lr-preview__val">{selectedClient?.name || '—'} <span className="lr-preview__val-sub">({selectedClient?.phone || '—'})</span></span>
                    </div>
                  </div>
                ) : null}

                <button
                  type="button"
                  className="lr-submit"
                  onClick={handleQuickRelink}
                  disabled={busy || !relinkReady}
                >
                  {busy ? 'Traitement…' : relinkReady ? 'Relier le compte' : 'Choisissez un client et un UUID valide'}
                </button>
              </>
            )}
          </div>
        ) : null}

        {/* TAB 2: Reassign sale */}
        {tab === 'reassign' ? (
          <div className="lr-panel" role="tabpanel">
            {noSales ? (
              <div className="adm-empty">Aucune vente disponible. Rechargez la page.</div>
            ) : (
              <>
                <div className="lr-field">
                  <div className="lr-label">Vente à réaffecter</div>
                  <div className="lr-search lr-search--mb">
                    <span className="lr-search__icon" aria-hidden>🔍</span>
                    <input
                      type="text"
                      className="lr-input lr-search__input"
                      placeholder="Code, client actuel ou projet…"
                      value={saleSearch}
                      onChange={(e) => setSaleSearch(e.target.value)}
                    />
                  </div>
                  <select className="lr-select" value={saleId} onChange={(e) => setSaleId(e.target.value)}>
                    <option value="">— Sélectionner une vente ({saleOptions.length}) —</option>
                    {saleOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code || String(s.id).slice(0, 8)} · {s.clientName || '—'} · {s.projectTitle || 'Projet'}
                      </option>
                    ))}
                  </select>
                  {selectedSale ? (
                    <div className="lr-hint">Client actuel : <strong className="lr-hint__strong">{selectedSale.clientName || '—'}</strong></div>
                  ) : null}
                </div>

                <div className="lr-field">
                  <div className="lr-label">Nouveau client</div>
                  <div className="lr-search lr-search--mb">
                    <span className="lr-search__icon" aria-hidden>🔍</span>
                    <input
                      type="text"
                      className="lr-input lr-search__input"
                      placeholder="Chercher par nom ou téléphone…"
                      value={targetSearch}
                      onChange={(e) => setTargetSearch(e.target.value)}
                    />
                  </div>
                  <select className="lr-select" value={targetClientId} onChange={(e) => setTargetClientId(e.target.value)}>
                    <option value="">— Sélectionner un client ({targetClientOptions.length}) —</option>
                    {targetClientOptions.map((c) => (
                      <option key={c.id} value={c.id}>{c.name || 'Client'} · {c.phone || '—'}</option>
                    ))}
                  </select>
                </div>

                {saleSameClientWarning ? (
                  <div className="adm-callout adm-callout--warn">
                    <span className="adm-callout__icon" aria-hidden>⚠️</span>
                    <span className="adm-callout__main">La vente est déjà attribuée à ce client — aucun changement ne sera effectué.</span>
                  </div>
                ) : null}

                <div className="lr-row">
                  <div className="lr-field">
                    <div className="lr-label">
                      Ticket <span className="lr-label__opt">optionnel</span>
                    </div>
                    <input className="lr-input" value={saleTicket} onChange={(e) => setSaleTicket(e.target.value)} placeholder="INC-1234" />
                  </div>
                  <div className="lr-field">
                    <div className="lr-label">
                      Raison <span className="lr-label__opt">optionnel</span>
                    </div>
                    <input className="lr-input" value={saleReason} onChange={(e) => setSaleReason(e.target.value)} placeholder="Vente sur mauvais dossier" />
                  </div>
                </div>

                {saleReady && selectedSale && selectedTargetClient && !saleSameClientWarning ? (
                  <div className="lr-preview">
                    <div className="lr-preview__title">À valider</div>
                    <div className="lr-preview__row">
                      <span className="lr-preview__val-sub">Vente</span>
                      <span className="lr-preview__val">{selectedSale.code || String(selectedSale.id).slice(0, 8)} <span className="lr-preview__val-sub">({selectedSale.projectTitle || '—'})</span></span>
                    </div>
                    <div className="lr-preview__row">
                      <span className="lr-preview__val-sub">De</span>
                      <span className="lr-preview__val">{selectedSale.clientName || '—'}</span>
                    </div>
                    <div className="lr-preview__row">
                      <span className="lr-preview__arrow">→</span>
                      <span className="lr-preview__val">{selectedTargetClient.name || '—'} <span className="lr-preview__val-sub">({selectedTargetClient.phone || '—'})</span></span>
                    </div>
                  </div>
                ) : null}

                <button
                  type="button"
                  className="lr-submit"
                  onClick={handleSaleReassign}
                  disabled={busy || !saleReady || saleSameClientWarning}
                >
                  {busy ? 'Traitement…' : saleReady ? 'Réaffecter la vente' : 'Choisissez la vente et le nouveau client'}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
