import { useEffect, useMemo, useState } from 'react'
import AdminModal from './AdminModal.jsx'
import { supabase } from '../../lib/supabase.js'

function fmtTnd(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TND`
}

function statusFrench(s) {
  const map = {
    pending: 'En attente',
    pending_review: 'En revue',
    payable: 'À payer',
    paid: 'Payé',
    approved: 'Approuvé',
    rejected: 'Rejeté',
    cancelled: 'Annulée',
  }
  return map[s] || s || '—'
}

function Row({ label, value, mono }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, fontSize: 13 }}>
      <div style={{ color: 'var(--adm-text-dim, #64748b)' }}>{label}</div>
      <div
        style={{
          fontWeight: 600,
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
    </div>
  )
}

function ActionPill({ active, disabled, label, tone, onClick }) {
  const palette = {
    blue: { bg: '#2563eb', bgDim: '#eff6ff', fg: '#fff', fgDim: '#1d4ed8', border: '#bfdbfe' },
    red: { bg: '#dc2626', bgDim: '#fef2f2', fg: '#fff', fgDim: '#991b1b', border: '#fecaca' },
    green: { bg: '#16a34a', bgDim: '#f0fdf4', fg: '#fff', fgDim: '#166534', border: '#bbf7d0' },
  }[tone || 'blue']
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 14px',
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${active ? palette.bg : palette.border}`,
        background: active ? palette.bg : palette.bgDim,
        color: active ? palette.fg : palette.fgDim,
        opacity: disabled ? 0.5 : 1,
        transition: 'all .15s ease',
      }}
    >
      {label}
    </button>
  )
}

export default function CommissionOverrideModal({ event, open, onClose, onSaved }) {
  const canReactivate = String(event?.status || '') === 'cancelled'
  const defaultAction = canReactivate ? 'reactivate' : 'adjust'

  const [action, setAction] = useState(defaultAction)
  const [newAmount, setNewAmount] = useState('')
  const [reason, setReason] = useState('')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Reset local state whenever the modal opens on a different event.
  useEffect(() => {
    if (!open) return
    const nextAction = String(event?.status || '') === 'cancelled' ? 'reactivate' : 'adjust'
    setAction(nextAction)
    setNewAmount(event?.amount != null ? String(event.amount) : '')
    setReason('')
    setConfirmCancel(false)
    setError('')
    setSaving(false)
  }, [open, event?.id, event?.amount, event?.status])

  const isCancelDisabled = String(event?.status || '') === 'cancelled'

  const canSave = useMemo(() => {
    if (!event?.id) return false
    if (action === 'adjust') {
      const n = Number(newAmount)
      if (!Number.isFinite(n) || n < 0) return false
      if (Number(event.amount) === n) return false
      return true
    }
    if (action === 'cancel') {
      if (isCancelDisabled) return false
      return confirmCancel && reason.trim().length > 0
    }
    if (action === 'reactivate') {
      return canReactivate
    }
    return false
  }, [action, newAmount, confirmCancel, reason, event, canReactivate, isCancelDisabled])

  async function handleSave() {
    if (!canSave || saving) return
    setSaving(true)
    setError('')
    try {
      const patch = {}
      if (action === 'adjust') patch.amount = Number(newAmount)
      else if (action === 'cancel') patch.status = 'cancelled'
      else if (action === 'reactivate') patch.status = 'payable'
      if (!Object.keys(patch).length) {
        setSaving(false)
        return
      }

      const { data, error: updErr } = await supabase
        .from('commission_events')
        .update(patch)
        .eq('id', event.id)
        .select()
        .single()
      if (updErr) throw new Error(updErr.message)

      // Audit trail — never block the UI if the insert fails (non-critical
      // for user flow, but we surface a console warning for diagnostics).
      const auditRow = {
        action: `commission_${action}`,
        entity: 'commission_event',
        entity_id: String(event.id),
        details: `Commission ${action}: amount ${event.amount} → ${data.amount}, status ${event.status} → ${data.status}.${
          reason ? ' Raison: ' + reason : ''
        }`,
        metadata: { previous: event, next: data, reason: reason || null },
        category: 'business',
        source: 'admin_ui',
      }
      const auditRes = await supabase.from('audit_logs').insert(auditRow)
      if (auditRes.error) {
        console.warn('commission override audit failed', auditRes.error)
      }

      onSaved?.(data)
      onClose?.()
    } catch (e) {
      setError(e?.message || 'Impossible d’enregistrer la modification')
    } finally {
      setSaving(false)
    }
  }

  if (!open || !event) return null

  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button className="adm-btn adm-btn--secondary" onClick={onClose} disabled={saving}>
        Annuler
      </button>
      <button
        className="adm-btn adm-btn--primary"
        onClick={handleSave}
        disabled={!canSave || saving}
      >
        {saving ? 'Enregistrement…' : 'Enregistrer'}
      </button>
    </div>
  )

  return (
    <AdminModal open={open} onClose={onClose} title="Ajuster la commission" width={560} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Read-only summary */}
        <section
          style={{
            border: '1px solid var(--adm-border, #e2e8f0)',
            borderRadius: 8,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            background: '#f8fafc',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: 0.3, color: '#475569', marginBottom: 4 }}>
            ÉVÉNEMENT ACTUEL
          </div>
          <Row label="ID événement" value={String(event.id || '—')} mono />
          <Row label="Niveau" value={event.level != null ? `N${event.level}` : '—'} />
          <Row label="Montant actuel" value={fmtTnd(event.amount)} />
          <Row label="Statut actuel" value={statusFrench(event.status)} />
          <Row label="Bénéficiaire" value={String(event.beneficiary_client_id || '—')} mono />
          <Row label="Vente" value={String(event.sale_id || '—')} mono />
        </section>

        {/* Action selector */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8, letterSpacing: 0.3 }}>
            ACTION
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <ActionPill
              label="Modifier montant"
              tone="blue"
              active={action === 'adjust'}
              onClick={() => setAction('adjust')}
            />
            <ActionPill
              label="Annuler"
              tone="red"
              active={action === 'cancel'}
              disabled={isCancelDisabled}
              onClick={() => setAction('cancel')}
            />
            <ActionPill
              label="Réactiver"
              tone="green"
              active={action === 'reactivate'}
              disabled={!canReactivate}
              onClick={() => setAction('reactivate')}
            />
          </div>
          {isCancelDisabled ? (
            <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
              Cet événement est déjà annulé.
            </div>
          ) : null}
          {!canReactivate && action !== 'reactivate' ? (
            <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
              « Réactiver » est disponible uniquement pour un événement annulé.
            </div>
          ) : null}
        </div>

        {/* Action-specific body */}
        {action === 'adjust' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="cmo-amount" style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>
              Nouveau montant (TND)
            </label>
            <input
              id="cmo-amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={newAmount}
              onChange={(e) => setNewAmount(e.target.value)}
              style={{
                padding: '10px 12px',
                fontSize: 14,
                border: '1px solid #cbd5e1',
                borderRadius: 8,
                background: '#fff',
              }}
            />
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Valeur actuelle : {fmtTnd(event.amount)}
            </div>
          </div>
        ) : null}

        {action === 'cancel' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: '#334155' }}>
              <input
                type="checkbox"
                checked={confirmCancel}
                onChange={(e) => setConfirmCancel(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                Je confirme l’annulation de cette commission. Le bénéficiaire ne pourra plus la réclamer.
              </span>
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="cmo-reason" style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>
                Raison (obligatoire)
              </label>
              <textarea
                id="cmo-reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ex. doublon, erreur de saisie, vente annulée…"
                style={{
                  padding: '10px 12px',
                  fontSize: 14,
                  border: '1px solid #cbd5e1',
                  borderRadius: 8,
                  background: '#fff',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
            </div>
          </div>
        ) : null}

        {action === 'reactivate' ? (
          <div
            style={{
              padding: 12,
              border: '1px solid #bbf7d0',
              background: '#f0fdf4',
              borderRadius: 8,
              color: '#166534',
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            Le statut sera remis à « À payer » ({fmtTnd(event.amount)}). L’événement redeviendra éligible
            au prochain regroupement de paiement.
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            style={{
              padding: '8px 10px',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 8,
              color: '#991b1b',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        ) : null}
      </div>
    </AdminModal>
  )
}
