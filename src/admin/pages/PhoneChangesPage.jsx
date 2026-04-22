import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToast } from '../components/AdminToast.jsx'
import {
  adminApplyPhoneChange,
  adminSearchPhoneChangeRequests,
} from '../../lib/db.js'
import './zitouna-admin-page.css'
import './admin-patterns.css'

function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function statusPill(status) {
  if (status === 'pending') return { label: 'En attente', color: '#f5c842', bg: 'rgba(245,200,66,0.12)' }
  if (status === 'approved') return { label: 'Approuvée', color: '#16a34a', bg: 'rgba(22,163,74,0.12)' }
  if (status === 'rejected') return { label: 'Refusée', color: '#dc2626', bg: 'rgba(220,38,38,0.1)' }
  return { label: status, color: '#64748b', bg: 'rgba(100,116,139,0.1)' }
}

export default function PhoneChangesPage() {
  const { addToast } = useToast()

  const [emailQuery, setEmailQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('pending')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  // Per-row review state (note + approve/reject busy flag + confirm toggle).
  const [rowState, setRowState] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const data = await adminSearchPhoneChangeRequests({
        emailQuery,
        status: statusFilter || '',
        limit: 100,
      })
      setRows(data)
    } catch (e) {
      setErr(e?.message || String(e))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [emailQuery, statusFilter])

  useEffect(() => {
    load()
  }, [load])

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 }
    for (const r of rows) {
      if (r.status === 'pending') c.pending += 1
      else if (r.status === 'approved') c.approved += 1
      else if (r.status === 'rejected') c.rejected += 1
    }
    return c
  }, [rows])

  const setRow = (id, patch) => setRowState((s) => ({ ...s, [id]: { ...(s[id] || {}), ...patch } }))

  const handleApply = useCallback(
    async (row, approve) => {
      const note = rowState[row.id]?.note || ''
      if (!approve && !note.trim()) {
        addToast('Ajoutez un motif de refus.', 'error')
        setRow(row.id, { showNoteErr: true })
        return
      }
      setRow(row.id, { busy: true })
      try {
        await adminApplyPhoneChange({ requestId: row.id, approve, note })
        addToast(approve ? 'Demande approuvée et numéro mis à jour.' : 'Demande refusée.')
        await load()
      } catch (e) {
        const raw = String(e?.message || e || '')
        let msg = raw
        if (/NOT_SUPER_ADMIN/i.test(raw)) msg = 'Accès refusé : réservé aux super administrateurs.'
        else if (/ALREADY_REVIEWED/i.test(raw)) msg = 'Cette demande a déjà été traitée.'
        else if (/REQUEST_NOT_FOUND/i.test(raw)) msg = 'Demande introuvable.'
        addToast(`Erreur : ${msg}`, 'error')
      } finally {
        setRow(row.id, { busy: false })
      }
    },
    [rowState, addToast, load],
  )

  return (
    <section className="zitu-page">
      <div className="zitu-page__column">
        <div className="zitu-page__header">
          <div className="zitu-page__header-icon">📞</div>
          <div className="zitu-page__header-text">
            <h1>Changements de numéro de téléphone</h1>
            <p>Super admin uniquement · examiner et approuver</p>
          </div>
          <div className="zitu-page__header-actions">
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--sm"
              onClick={load}
              disabled={loading}
            >
              {loading ? 'Chargement…' : 'Actualiser'}
            </button>
          </div>
        </div>

        <div className="zitu-page__field" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 2, minWidth: 220 }}>
            <label className="zitu-page__field-label" htmlFor="pc-search">
              Rechercher par email
            </label>
            <input
              id="pc-search"
              className="zitu-page__input"
              type="search"
              placeholder="exemple@domaine.com"
              value={emailQuery}
              onChange={(e) => setEmailQuery(e.target.value)}
            />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label className="zitu-page__field-label" htmlFor="pc-status">
              Statut
            </label>
            <select
              id="pc-status"
              className="zitu-page__select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">Tous</option>
              <option value="pending">En attente</option>
              <option value="approved">Approuvées</option>
              <option value="rejected">Refusées</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#64748b', margin: '4px 0 12px' }}>
          <span><strong>{counts.pending}</strong> en attente</span>
          <span><strong>{counts.approved}</strong> approuvées</span>
          <span><strong>{counts.rejected}</strong> refusées</span>
        </div>

        {err && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid rgba(220,38,38,0.3)',
              background: 'rgba(220,38,38,0.06)',
              color: '#dc2626',
              fontSize: 12,
              marginBottom: 12,
            }}
          >
            Erreur : {err}
          </div>
        )}

        {!loading && rows.length === 0 && !err && (
          <div
            style={{
              padding: '40px 12px',
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: 12,
              border: '1px dashed #e2e8f0',
              borderRadius: 10,
            }}
          >
            Aucune demande pour ces filtres.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((r) => {
            const pill = statusPill(r.status)
            const rs = rowState[r.id] || {}
            return (
              <div
                key={r.id}
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  background: '#fff',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <strong style={{ fontSize: 13 }}>
                      {r.client_name || '(sans nom)'} <span style={{ color: '#64748b', fontWeight: 400 }}>·</span>{' '}
                      <span dir="ltr">{r.client_email || r.user_email || '—'}</span>
                    </strong>
                    <span style={{ fontSize: 10, color: '#64748b' }}>
                      Soumise le {fmtDate(r.created_at)}
                    </span>
                  </div>
                  <span
                    style={{
                      alignSelf: 'flex-start',
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: pill.bg,
                      color: pill.color,
                      fontSize: 10,
                      fontWeight: 700,
                    }}
                  >
                    {pill.label}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}>
                  <div>
                    <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase' }}>
                      Numéro actuel
                    </div>
                    <div dir="ltr" style={{ fontFamily: 'ui-monospace, monospace' }}>
                      {r.current_phone || r.client_current_phone || '—'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase' }}>
                      Nouveau numéro
                    </div>
                    <div
                      dir="ltr"
                      style={{ fontFamily: 'ui-monospace, monospace', color: '#16a34a', fontWeight: 700 }}
                    >
                      {r.requested_phone}
                    </div>
                  </div>
                </div>

                {r.reason && (
                  <div style={{ fontSize: 11, color: '#475569' }}>
                    <span style={{ color: '#64748b' }}>Motif client :</span> {r.reason}
                  </div>
                )}

                {r.reviewer_note && r.status !== 'pending' && (
                  <div style={{ fontSize: 11, color: '#475569' }}>
                    <span style={{ color: '#64748b' }}>Note admin :</span> {r.reviewer_note}
                  </div>
                )}

                {r.status === 'pending' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                    <input
                      className="zitu-page__input"
                      placeholder="Note (obligatoire si refus)"
                      value={rs.note || ''}
                      onChange={(e) =>
                        setRow(r.id, { note: e.target.value, showNoteErr: false })
                      }
                    />
                    {rs.showNoteErr && (
                      <span style={{ color: '#dc2626', fontSize: 10 }}>
                        Ajoutez un motif pour refuser.
                      </span>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="zitu-page__btn zitu-page__btn--primary zitu-page__btn--sm"
                        disabled={rs.busy}
                        onClick={() => handleApply(r, true)}
                      >
                        {rs.busy ? '…' : 'Approuver et appliquer'}
                      </button>
                      <button
                        type="button"
                        className="zitu-page__btn zitu-page__btn--danger zitu-page__btn--sm"
                        disabled={rs.busy}
                        onClick={() => handleApply(r, false)}
                      >
                        Refuser
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
