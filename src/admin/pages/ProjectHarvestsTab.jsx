import { useCallback, useEffect, useState } from 'react'
import {
  adminDeleteProjectHarvest,
  adminDistributeHarvest,
  adminFetchProjectHarvests,
  adminPreviewHarvestDistribution,
  adminUpsertProjectHarvest,
} from '../../lib/db.js'

/*
 * ProjectHarvestsTab — admin workflow for one project's yearly harvests.
 *
 *   Plan → In progress → Harvested → (Distribute) → Distributed.
 *
 *   Each row is inline-editable. The "Distribuer" button opens a preview
 *   modal that lists every client + share + amount BEFORE the DB write, so
 *   the admin can double-check then commit. Commit is idempotent on the
 *   backend (distribute_harvest RPC).
 */

const STATUS_OPTIONS = [
  { value: 'planned', label: 'Prévue' },
  { value: 'in_progress', label: 'En cours' },
  { value: 'harvested', label: 'Récoltée' },
  { value: 'cancelled', label: 'Annulée' },
]

const STATUS_LABELS = {
  planned: 'Prévue',
  in_progress: 'En cours',
  harvested: 'Récoltée',
  distributed: 'Distribuée',
  cancelled: 'Annulée',
}

function fmtMoney(n) { return `${Math.round(Number(n) || 0).toLocaleString('fr-FR')} DT` }
function fmtKg(n) { return `${Math.round(Number(n) || 0).toLocaleString('fr-FR')} kg` }

function HarvestRow({ harvest, onSave, onDelete, onDistribute, busy }) {
  const [editing, setEditing] = useState(!harvest.id)
  const [form, setForm] = useState({
    year: harvest.year || new Date().getFullYear(),
    date: harvest.date || '',
    status: harvest.status || 'planned',
    projectedGrossTnd: harvest.projectedGrossTnd || 0,
    actualKg: harvest.actualKg || 0,
    pricePerKgTnd: harvest.pricePerKgTnd || 0,
    actualGrossTnd: harvest.actualGrossTnd || 0,
    costsTnd: harvest.costsTnd || 0,
    notes: harvest.notes || '',
  })

  // Auto-compute gross from kg × price when editing.
  const setField = (name, value) => {
    setForm((prev) => {
      const next = { ...prev, [name]: value }
      if (name === 'actualKg' || name === 'pricePerKgTnd') {
        const kg = Number(next.actualKg) || 0
        const ppk = Number(next.pricePerKgTnd) || 0
        if (kg > 0 && ppk > 0) next.actualGrossTnd = +(kg * ppk).toFixed(2)
      }
      return next
    })
  }

  const netTnd = Math.max(
    (Number(form.actualGrossTnd) || 0) - (Number(form.costsTnd) || 0),
    0,
  )

  if (!editing) {
    return (
      <div className={`pdp-harvest-row pdp-harvest-row--${harvest.status}`}>
        <div className="pdp-harvest-yearblock">
          <div className="pdp-harvest-year">{harvest.year}</div>
          {harvest.date ? (
            <div className="pdp-harvest-date">
              {new Date(harvest.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
            </div>
          ) : null}
        </div>
        <div className="pdp-harvest-main">
          <div className="pdp-harvest-status-line">
            <span className={`pdp-harvest-pill pdp-harvest-pill--${harvest.status}`}>
              {STATUS_LABELS[harvest.status] || harvest.status}
            </span>
            {harvest.actualKg > 0 ? <span className="pdp-harvest-meta">{fmtKg(harvest.actualKg)}</span> : null}
            {harvest.pricePerKgTnd > 0 ? <span className="pdp-harvest-meta">× {harvest.pricePerKgTnd} DT/kg</span> : null}
          </div>
          <div className="pdp-harvest-nums">
            <div><span className="pdp-k">Brut projeté</span><strong>{fmtMoney(harvest.projectedGrossTnd)}</strong></div>
            <div><span className="pdp-k">Brut réel</span><strong>{fmtMoney(harvest.actualGrossTnd)}</strong></div>
            <div><span className="pdp-k">Coûts</span><strong>{fmtMoney(harvest.costsTnd)}</strong></div>
            <div className="pdp-harvest-net"><span className="pdp-k">Net à distribuer</span><strong>{fmtMoney(harvest.netTnd)}</strong></div>
          </div>
          {harvest.notes ? <div className="pdp-harvest-notes">{harvest.notes}</div> : null}
        </div>
        <div className="pdp-harvest-actions">
          {harvest.status !== 'distributed' && harvest.status !== 'cancelled' ? (
            <button type="button" className="zitu-page__btn" onClick={() => setEditing(true)}>
              Modifier
            </button>
          ) : null}
          {harvest.status === 'harvested' && harvest.netTnd > 0 ? (
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--primary"
              disabled={busy}
              onClick={() => onDistribute(harvest)}
            >
              Distribuer
            </button>
          ) : null}
          {harvest.status !== 'distributed' ? (
            <button
              type="button"
              className="zitu-page__btn zitu-page__btn--danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Supprimer la récolte ${harvest.year} ?`)) onDelete(harvest)
              }}
            >
              Supprimer
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="pdp-harvest-row pdp-harvest-row--editing">
      <div className="pdp-harvest-grid">
        <label className="pdp-field">
          <span>Année</span>
          <input
            type="number"
            value={form.year}
            onChange={(e) => setField('year', Number(e.target.value) || new Date().getFullYear())}
          />
        </label>
        <label className="pdp-field">
          <span>Date prévue</span>
          <input type="date" value={form.date || ''} onChange={(e) => setField('date', e.target.value)} />
        </label>
        <label className="pdp-field">
          <span>Statut</span>
          <select value={form.status} onChange={(e) => setField('status', e.target.value)}>
            {STATUS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
          </select>
        </label>
        <label className="pdp-field">
          <span>Brut projeté (DT)</span>
          <input
            type="number" min="0" step="0.01"
            value={form.projectedGrossTnd}
            onChange={(e) => setField('projectedGrossTnd', Number(e.target.value) || 0)}
          />
        </label>
        <label className="pdp-field">
          <span>Kg récoltés</span>
          <input
            type="number" min="0" step="0.01"
            value={form.actualKg}
            onChange={(e) => setField('actualKg', Number(e.target.value) || 0)}
          />
        </label>
        <label className="pdp-field">
          <span>Prix / kg (DT)</span>
          <input
            type="number" min="0" step="0.001"
            value={form.pricePerKgTnd}
            onChange={(e) => setField('pricePerKgTnd', Number(e.target.value) || 0)}
          />
        </label>
        <label className="pdp-field">
          <span>Brut réel (DT)</span>
          <input
            type="number" min="0" step="0.01"
            value={form.actualGrossTnd}
            onChange={(e) => setField('actualGrossTnd', Number(e.target.value) || 0)}
          />
        </label>
        <label className="pdp-field">
          <span>Coûts (DT)</span>
          <input
            type="number" min="0" step="0.01"
            value={form.costsTnd}
            onChange={(e) => setField('costsTnd', Number(e.target.value) || 0)}
          />
        </label>
        <label className="pdp-field pdp-field--wide">
          <span>Notes</span>
          <textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setField('notes', e.target.value)}
          />
        </label>
        <div className="pdp-harvest-netline">
          Net à distribuer : <strong>{fmtMoney(netTnd)}</strong>
        </div>
      </div>
      <div className="pdp-harvest-actions">
        {harvest.id ? (
          <button type="button" className="zitu-page__btn" onClick={() => setEditing(false)} disabled={busy}>
            Annuler
          </button>
        ) : null}
        <button
          type="button"
          className="zitu-page__btn zitu-page__btn--primary"
          disabled={busy}
          onClick={() => {
            onSave({ ...harvest, ...form })
            if (harvest.id) setEditing(false)
          }}
        >
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  )
}

function DistributePreviewModal({ harvest, onClose, onCommit }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!harvest?.id) return
    let cancelled = false
    setError('')
    setRows(null)
    ;(async () => {
      try {
        const r = await adminPreviewHarvestDistribution(harvest.id)
        if (!cancelled) setRows(r)
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Preview failed')
      }
    })()
    return () => { cancelled = true }
  }, [harvest?.id])

  const total = (rows || []).reduce((s, r) => s + r.amountTnd, 0)

  return (
    <div className="pdp-modal-bg">
      <div className="pdp-modal pdp-modal--wide">
        <div className="pdp-modal__head">
          <h3>Distribuer la récolte {harvest.year}</h3>
          <button type="button" onClick={onClose} aria-label="Fermer">×</button>
        </div>
        <div className="pdp-modal__body">
          <div className="pdp-harvest-summary">
            <div><span className="pdp-k">Net à distribuer</span><strong>{fmtMoney(harvest.netTnd)}</strong></div>
            <div><span className="pdp-k">Bénéficiaires</span><strong>{rows ? rows.length : '—'}</strong></div>
            <div><span className="pdp-k">Total calculé</span><strong>{fmtMoney(total)}</strong></div>
          </div>

          {error ? <div className="pdp-alert pdp-alert--error">{error}</div> : null}

          {rows === null ? (
            <div className="pdp-harvest-loading">Calcul des parts…</div>
          ) : rows.length === 0 ? (
            <div className="pdp-harvest-empty">
              Aucun client éligible (aucune vente complétée pour ce projet avant la date de récolte).
            </div>
          ) : (
            <div className="pdp-harvest-preview">
              <div className="pdp-harvest-preview__head">
                <span>Client</span>
                <span>Surface</span>
                <span>Part</span>
                <span>Montant</span>
              </div>
              {rows.map((r) => (
                <div key={r.clientId} className="pdp-harvest-preview__row">
                  <span>{r.clientName || r.clientId.slice(0, 8)}</span>
                  <span>{r.ownedAreaM2.toLocaleString('fr-FR')} m²</span>
                  <span>{r.sharePct.toFixed(2)}%</span>
                  <span><strong>{fmtMoney(r.amountTnd)}</strong></span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="pdp-modal__foot">
          <button type="button" className="zitu-page__btn" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button
            type="button"
            className="zitu-page__btn zitu-page__btn--primary"
            disabled={busy || !rows || rows.length === 0}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                await onCommit()
                onClose()
              } catch (e) {
                setError(e?.message || 'Distribution failed')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Distribution…' : `Confirmer · créditer ${fmtMoney(total)}`}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ProjectHarvestsTab({ projectId }) {
  const [harvests, setHarvests] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(null)
  const [distributeTarget, setDistributeTarget] = useState(null)

  const refresh = useCallback(async () => {
    if (!projectId) return
    try {
      const rows = await adminFetchProjectHarvests(projectId)
      setHarvests(rows)
    } catch (e) {
      setError(e?.message || 'Fetch failed')
      setHarvests([])
    }
  }, [projectId])

  useEffect(() => { refresh() }, [refresh])

  const handleSave = useCallback(async (row) => {
    setBusy(true)
    setError('')
    try {
      await adminUpsertProjectHarvest(projectId, row)
      setDraft(null)
      await refresh()
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }, [projectId, refresh])

  const handleDelete = useCallback(async (row) => {
    if (!row.id) { setDraft(null); return }
    setBusy(true)
    setError('')
    try {
      await adminDeleteProjectHarvest(row.id)
      await refresh()
    } catch (e) {
      setError(e?.message || 'Delete failed')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const handleCommitDistribute = useCallback(async () => {
    if (!distributeTarget?.id) return
    await adminDistributeHarvest(distributeTarget.id)
    await refresh()
  }, [distributeTarget?.id, refresh])

  const nextYear = (harvests || []).length === 0
    ? new Date().getFullYear()
    : Math.max(...harvests.map((h) => h.year || 0)) + 1

  return (
    <div className="pdp-harvests">
      <div className="pdp-harvests__head">
        <div>
          <h3>Récoltes</h3>
          <p>Planifiez, suivez et distribuez les récoltes annuelles. La distribution crée une ligne créditée dans le portefeuille de chaque client propriétaire.</p>
        </div>
        {!draft ? (
          <button
            type="button"
            className="zitu-page__btn zitu-page__btn--primary"
            onClick={() => setDraft({ year: nextYear, status: 'planned' })}
            disabled={busy}
          >
            + Ajouter une récolte
          </button>
        ) : null}
      </div>

      {error ? <div className="pdp-alert pdp-alert--error">{error}</div> : null}

      {draft ? (
        <HarvestRow
          key="draft"
          harvest={draft}
          busy={busy}
          onSave={(row) => handleSave(row).then(() => setDraft(null))}
          onDelete={() => setDraft(null)}
          onDistribute={() => {}}
        />
      ) : null}

      {harvests === null ? (
        <div className="pdp-harvest-loading">Chargement…</div>
      ) : harvests.length === 0 && !draft ? (
        <div className="pdp-harvest-empty">
          Aucune récolte enregistrée. Ajoutez la première campagne pour commencer le suivi.
        </div>
      ) : (
        <div className="pdp-harvest-list">
          {harvests.map((h) => (
            <HarvestRow
              key={h.id}
              harvest={h}
              busy={busy}
              onSave={handleSave}
              onDelete={handleDelete}
              onDistribute={(row) => setDistributeTarget(row)}
            />
          ))}
        </div>
      )}

      {distributeTarget ? (
        <DistributePreviewModal
          harvest={distributeTarget}
          onClose={() => setDistributeTarget(null)}
          onCommit={handleCommitDistribute}
        />
      ) : null}
    </div>
  )
}
