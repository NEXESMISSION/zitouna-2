import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../components/AdminToast.jsx'
import { useClients, useSales } from '../../lib/useSupabase.js'
import { relinkAuthToClientWithTicket, reassignSaleClientWithTicket } from '../../lib/db.js'
import './zitouna-admin-page.css'

function parsePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return { countryCode: '+216', phoneLocal: '' }
  if (String(raw || '').trim().startsWith('+') && digits.length > 8) {
    return { countryCode: `+${digits.slice(0, digits.length - 8)}`, phoneLocal: digits.slice(-8) }
  }
  if (digits.length > 8) return { countryCode: `+${digits.slice(0, digits.length - 8)}`, phoneLocal: digits.slice(-8) }
  return { countryCode: '+216', phoneLocal: digits }
}

export default function ClientLinkRepairPage() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const { clients } = useClients()
  const { sales } = useSales()

  const [clientId, setClientId] = useState('')
  const [authUserId, setAuthUserId] = useState('')
  const [ticket, setTicket] = useState('')
  const [reason, setReason] = useState('')

  const [saleId, setSaleId] = useState('')
  const [targetClientId, setTargetClientId] = useState('')
  const [saleTicket, setSaleTicket] = useState('')
  const [saleReason, setSaleReason] = useState('')

  const [busy, setBusy] = useState(false)

  const clientOptions = useMemo(
    () => (clients || []).map((c) => ({ id: String(c.id), label: `${c.name || 'Client'} • ${c.phone || '—'}` })),
    [clients],
  )
  const saleOptions = useMemo(
    () =>
      (sales || []).slice(0, 500).map((s) => ({
        id: String(s.id),
        label: `${s.code || s.id} • ${s.clientName || 'Client'} • ${s.projectTitle || 'Projet'}`,
      })),
    [sales],
  )

  const selectedClient = useMemo(
    () => (clients || []).find((c) => String(c.id) === String(clientId)) || null,
    [clients, clientId],
  )

  const relinkHelp = useMemo(() => {
    if (!selectedClient) return 'Choisissez un client, puis collez le UUID auth.'
    return `Client sélectionné: ${selectedClient.name || 'Client'}`
  }, [selectedClient])

  async function handleQuickRelink() {
    if (!clientId || !authUserId.trim()) {
      addToast('Client et Auth User ID sont requis.', 'error')
      return
    }
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
      addToast('Compte relie au client avec succès.')
      setTicket('')
      setReason('')
    } catch (e) {
      addToast(`Erreur: ${e.message || e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function handleSaleReassign() {
    if (!saleId || !targetClientId) {
      addToast('Vente et client cible sont requis.', 'error')
      return
    }
    setBusy(true)
    try {
      const res = await reassignSaleClientWithTicket({
        saleId,
        targetClientId,
        ticket: saleTicket.trim(),
        reason: saleReason.trim(),
      })
      if (!res?.ok) throw new Error(res?.reason || 'sale_reassign_failed')
      addToast('Vente reaffectee au bon client.')
      setSaleTicket('')
      setSaleReason('')
    } catch (e) {
      addToast(`Erreur: ${e.message || e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Back</span>
        </button>

        <header className="zitu-page__header">
          <div className="zitu-page__header-icon">🔗</div>
          <div className="zitu-page__header-text">
            <h1>Correction des liens client</h1>
            <p>Version simplifiée: 2 actions rapides, journalisation automatique.</p>
          </div>
        </header>

        <section className="zitu-page__section" style={{ marginBottom: 12 }}>
          <div className="zitu-page__section-title">1) Relier compte utilisateur au client</div>
          <p className="zitu-page__section-desc">{relinkHelp}</p>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Client</label>
            <select className="zitu-page__select" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Sélectionner un client</option>
              {clientOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Auth User ID (UUID)</label>
            <input
              className="zitu-page__input"
              value={authUserId}
              onChange={(e) => setAuthUserId(e.target.value)}
              placeholder="Collez le UUID de auth.users"
            />
          </div>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Ticket (optionnel)</label>
            <input className="zitu-page__input" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="INC-1234" />
          </div>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Raison (optionnel)</label>
            <textarea className="zitu-page__textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>

          <button type="button" className="zitu-page__btn zitu-page__btn--primary" onClick={handleQuickRelink} disabled={busy}>
            Relier le compte
          </button>
        </section>

        <section className="zitu-page__section">
          <div className="zitu-page__section-title">2) Réaffecter une vente au bon client</div>
          <p className="zitu-page__section-desc">Utilisez cette action si une vente pointe vers le mauvais client.</p>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Vente</label>
            <select className="zitu-page__select" value={saleId} onChange={(e) => setSaleId(e.target.value)}>
              <option value="">Sélectionner une vente</option>
              {saleOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Client cible</label>
            <select className="zitu-page__select" value={targetClientId} onChange={(e) => setTargetClientId(e.target.value)}>
              <option value="">Sélectionner un client</option>
              {clientOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Ticket (optionnel)</label>
            <input className="zitu-page__input" value={saleTicket} onChange={(e) => setSaleTicket(e.target.value)} placeholder="INC-1234" />
          </div>

          <div className="zitu-page__field">
            <label className="zitu-page__field-label">Raison (optionnel)</label>
            <textarea className="zitu-page__textarea" value={saleReason} onChange={(e) => setSaleReason(e.target.value)} />
          </div>

          <button type="button" className="zitu-page__btn zitu-page__btn--primary" onClick={handleSaleReassign} disabled={busy}>
            Réaffecter la vente
          </button>
        </section>
      </div>
    </div>
  )
}
