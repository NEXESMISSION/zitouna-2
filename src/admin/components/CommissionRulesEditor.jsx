import { useEffect, useState } from 'react'
import { useProjectWorkflow } from '../../lib/useSupabase.js'
import './commission-rules-editor.css'

function normalizeRules(arr) {
  if (!Array.isArray(arr)) return []
  return arr
    .map((r, i) => ({
      level: Number(r.level) > 0 ? Number(r.level) : i + 1,
      ruleType: r.ruleType === 'percent' || r.rule_type === 'percent' ? 'percent' : 'fixed',
      value: Number(r.value ?? r.amount ?? 0),
      maxCapAmount:
        r.maxCapAmount != null && r.maxCapAmount !== ''
          ? Number(r.maxCapAmount)
          : r.max_cap != null
            ? Number(r.max_cap)
            : null,
    }))
    .sort((a, b) => a.level - b.level)
}

function computePreviewRow(rule, salePrice) {
  const rt = rule.ruleType === 'percent' ? 'percent' : 'fixed'
  let amt = rt === 'percent'
    ? Math.round((Number(salePrice) || 0) * (Number(rule.value) || 0) / 100 * 100) / 100
    : Math.round((Number(rule.value) || 0) * 100) / 100
  const cap = rule.maxCapAmount != null && rule.maxCapAmount !== '' ? Number(rule.maxCapAmount) : null
  if (cap != null && Number.isFinite(cap)) amt = Math.min(amt, cap)
  return amt
}

/**
 * Commission rules editor + live preview for a single project.
 *
 * Embedded in ProjectDetailPage so admins can configure L1/L2/… in the
 * same screen where they set fees and payout threshold.
 *
 * Props:
 *   - projectId    (required) project to edit
 *   - title        optional section title
 *   - defaultPreviewPrice  initial sale price for the preview simulator
 *   - showSnapshotReminder renders the "applies to new sales only" hint
 */
export default function CommissionRulesEditor({
  projectId,
  defaultPreviewPrice = 100000,
  showSnapshotReminder = true,
}) {
  const { workflow, updateWorkflow, loading: workflowLoading } = useProjectWorkflow(projectId || '')
  const [rules, setRules] = useState([])
  const [previewPrice, setPreviewPrice] = useState(defaultPreviewPrice)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!projectId) { setRules([]); return }
    if (!workflow) return
    setRules(normalizeRules(workflow.commissionRules || []))
  }, [projectId, workflow])

  const addRow = () => {
    const nextLevel = rules.length ? Math.max(...rules.map((r) => r.level), 0) + 1 : 1
    setRules((prev) => [...prev, { level: nextLevel, ruleType: 'fixed', value: 0, maxCapAmount: null }])
  }

  const removeRowAt = (idx) => {
    setRules((prev) => prev.filter((_, i) => i !== idx).map((r, i) => ({ ...r, level: i + 1 })))
  }

  const patchRowAt = (idx, patch) => {
    setRules((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], ...patch }
      return next
    })
  }

  const save = async () => {
    setError('')
    const levels = new Set()
    for (const r of rules) {
      if (levels.has(r.level)) {
        setError('Chaque niveau doit être unique.')
        return
      }
      levels.add(r.level)
    }
    const payload = rules
      .sort((a, b) => a.level - b.level)
      .map((r) => {
        const row = {
          level: r.level,
          ruleType: r.ruleType,
          value: Number(r.value) || 0,
        }
        if (r.maxCapAmount != null && r.maxCapAmount !== '' && Number.isFinite(Number(r.maxCapAmount))) {
          row.maxCapAmount = Number(r.maxCapAmount)
        }
        return row
      })
    setSaving(true)
    try {
      await updateWorkflow({ commissionRules: payload })
      setSavedAt(new Date())
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  if (!projectId) {
    return (
      <div className="cre__empty-state">
        Sélectionnez un projet pour configurer ses règles de commission.
      </div>
    )
  }

  const totalPreview = rules.reduce((acc, r) => acc + computePreviewRow(r, previewPrice), 0)

  return (
    <div className="cre">
      {showSnapshotReminder && (
        <div className="cre__intro" role="note">
          <span className="cre__intro-icon" aria-hidden>ⓘ</span>
          <span>
            S'applique aux <strong>nouvelles ventes</strong>. Niveau 1 = vendeur direct, puis chaîne parrain.
            À ne pas confondre avec le <strong>seuil payout</strong> (onglet Workflow) qui contrôle les retraits.
          </span>
        </div>
      )}

      {/* Rule rows */}
      <div className="cre__rules">
        {rules.length === 0 ? (
          <div className="cre__empty">Aucune règle — cliquez « + Niveau » pour en ajouter.</div>
        ) : rules.map((r, idx) => (
          <div key={`${idx}-${r.level}`} className="cre__row">
            <div className="cre__field">
              <label className="cre__field-label">Niveau</label>
              <input
                className="cre__input"
                type="number"
                min={1}
                value={r.level}
                onChange={(e) => patchRowAt(idx, { level: Math.max(1, Number(e.target.value) || 1) })}
              />
            </div>
            <div className="cre__field">
              <label className="cre__field-label">Type</label>
              <select
                className="cre__select"
                value={r.ruleType}
                onChange={(e) => patchRowAt(idx, { ruleType: e.target.value })}
              >
                <option value="fixed">Fixe (TND)</option>
                <option value="percent">Pourcentage (%)</option>
              </select>
            </div>
            <div className="cre__field">
              <label className="cre__field-label">{r.ruleType === 'percent' ? 'Valeur %' : 'Montant TND'}</label>
              <input
                className="cre__input"
                type="number"
                step="0.01"
                value={r.value}
                onChange={(e) => patchRowAt(idx, { value: e.target.value })}
              />
            </div>
            <button
              type="button"
              className="cre__remove"
              onClick={() => removeRowAt(idx)}
              aria-label={`Retirer le niveau ${r.level}`}
              title="Retirer"
            >
              <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="cre__actions">
        <button type="button" className="cre__btn" onClick={addRow}>+ Niveau</button>
        <button
          type="button"
          className="cre__btn cre__btn--primary"
          disabled={workflowLoading || saving}
          onClick={() => void save()}
        >
          {saving ? 'Enregistrement…' : 'Enregistrer les règles'}
        </button>
        {savedAt && !error && (
          <span className="cre__status cre__status--ok">✓ Enregistré {savedAt.toLocaleTimeString('fr-FR')}</span>
        )}
        {error && <span className="cre__status cre__status--err">⚠ {error}</span>}
      </div>

      {/* Preview */}
      <div className="cre__preview">
        <div className="cre__preview-head">
          <h4 className="cre__preview-title">Aperçu de la commission</h4>
          <div className="cre__preview-input-wrap">
            <label className="cre__preview-input-lbl" htmlFor="cre-preview-price">Prix simulé (TND)</label>
            <input
              id="cre-preview-price"
              className="cre__preview-input"
              type="number"
              min={0}
              step="1000"
              value={previewPrice}
              onChange={(e) => setPreviewPrice(Number(e.target.value) || 0)}
            />
          </div>
        </div>
        {rules.length === 0 ? (
          <div className="cre__preview-empty">Ajoutez des niveaux pour voir l'aperçu.</div>
        ) : (
          <div className="cre__preview-table">
            <div className="cre__preview-thead">
              <span>Niveau</span>
              <span>Règle</span>
              <span>Commission</span>
            </div>
            {rules.slice().sort((a, b) => a.level - b.level).map((r) => {
              const amt = computePreviewRow(r, previewPrice)
              const ruleDesc = r.ruleType === 'percent'
                ? `${Number(r.value || 0).toLocaleString('fr-FR')} %`
                : `${Number(r.value || 0).toLocaleString('fr-FR')} TND fixe`
              return (
                <div key={`preview-${r.level}`} className="cre__preview-trow">
                  <span className="cre__preview-level">L{r.level}</span>
                  <span className="cre__preview-rule">{ruleDesc}</span>
                  <span className="cre__preview-amount">
                    {amt.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} TND
                  </span>
                </div>
              )
            })}
            <div className="cre__preview-total">
              <span className="cre__preview-total-lbl">Total cumulé (chaîne complète)</span>
              <span className="cre__preview-total-val">
                {totalPreview.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} TND
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
