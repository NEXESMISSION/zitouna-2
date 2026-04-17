import { useEffect, useState } from 'react'
import { useProjectWorkflow } from '../../lib/useSupabase.js'

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
 * Used standalone on /admin/referral-settings (with its own project picker)
 * and embedded in ProjectDetailPage so admins can configure L1/L2/… in the
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
  title = 'Règles de commission par niveau',
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
      <div style={{ fontSize: 12, color: '#94a3b8', padding: 8 }}>
        Sélectionnez un projet pour configurer ses règles de commission.
      </div>
    )
  }

  return (
    <div className="zitu-page__section" style={{ marginTop: 8 }}>
      <div className="zitu-page__section-title">{title}</div>
      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 10px' }}>
        Niveau 1 = vendeur direct, puis chaîne parrain. Plafond optionnel par ligne (TND ou borne % selon le type).
      </p>
      {showSnapshotReminder && (
        <div
          style={{
            fontSize: 11,
            color: '#92400e',
            background: '#fef3c7',
            border: '1px solid #fde68a',
            borderRadius: 8,
            padding: '6px 10px',
            marginBottom: 10,
          }}
        >
          ⓘ S&apos;applique aux <strong>nouvelles ventes</strong>. Les ventes déjà enregistrées conservent leur
          snapshot commission à la création (pas de recalcul rétroactif).
        </div>
      )}
      <div
        style={{
          fontSize: 11,
          color: '#075985',
          background: '#e0f2fe',
          border: '1px solid #bae6fd',
          borderRadius: 8,
          padding: '6px 10px',
          marginBottom: 10,
        }}
      >
        ⓘ <strong>À ne pas confondre</strong> avec le « Seuil payout min. » plus haut dans le workflow :
        ce seuil est le plancher de retrait du portefeuille parrainage ; les règles ci-dessous définissent les
        montants L1 / L2… créés par vente.
      </div>
      {rules.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Aucune règle — ajoutez une ligne.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.map((r, idx) => (
            <div
              key={`${idx}-${r.level}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '72px 1fr 1fr 1fr auto',
                gap: 8,
                alignItems: 'end',
                padding: 10,
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                background: '#fafafa',
              }}
            >
              <div className="zitu-page__field" style={{ margin: 0 }}>
                <label className="zitu-page__field-label">Niveau</label>
                <input
                  className="zitu-page__input"
                  type="number"
                  min={1}
                  value={r.level}
                  onChange={(e) => patchRowAt(idx, { level: Math.max(1, Number(e.target.value) || 1) })}
                />
              </div>
              <div className="zitu-page__field" style={{ margin: 0 }}>
                <label className="zitu-page__field-label">Type</label>
                <select
                  className="zitu-page__select"
                  value={r.ruleType}
                  onChange={(e) => patchRowAt(idx, { ruleType: e.target.value })}
                >
                  <option value="fixed">Fixe (TND)</option>
                  <option value="percent">Pourcentage (%)</option>
                </select>
              </div>
              <div className="zitu-page__field" style={{ margin: 0 }}>
                <label className="zitu-page__field-label">{r.ruleType === 'percent' ? 'Valeur %' : 'Montant TND'}</label>
                <input
                  className="zitu-page__input"
                  type="number"
                  step="0.01"
                  value={r.value}
                  onChange={(e) => patchRowAt(idx, { value: e.target.value })}
                />
              </div>
              <div className="zitu-page__field" style={{ margin: 0 }}>
                <label className="zitu-page__field-label">Plafond (opt.)</label>
                <input
                  className="zitu-page__input"
                  type="number"
                  step="0.01"
                  placeholder="—"
                  value={r.maxCapAmount ?? ''}
                  onChange={(e) =>
                    patchRowAt(idx, {
                      maxCapAmount: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
              <button type="button" className="zitu-page__btn" style={{ padding: '8px 10px' }} onClick={() => removeRowAt(idx)}>
                Retirer
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <button type="button" className="zitu-page__btn" onClick={addRow}>
          + Niveau
        </button>
        <button
          type="button"
          className="zitu-page__btn zitu-page__btn--primary"
          disabled={workflowLoading || saving}
          onClick={() => void save()}
        >
          {saving ? 'Enregistrement…' : 'Enregistrer les règles'}
        </button>
        {savedAt && !error && (
          <span style={{ fontSize: 12, color: '#059669' }}>
            ✓ Enregistré {savedAt.toLocaleTimeString('fr-FR')}
          </span>
        )}
        {error && <span style={{ fontSize: 12, color: '#dc2626' }}>{error}</span>}
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="zitu-page__section-title" style={{ fontSize: 13 }}>Aperçu de la commission</div>
        <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 10px' }}>
          Simulation pour un prix de vente donné.
        </p>
        <div className="zitu-page__field" style={{ margin: 0, marginBottom: 10, maxWidth: 260 }}>
          <label className="zitu-page__field-label">Prix convenu simulé (TND)</label>
          <input
            className="zitu-page__input"
            type="number"
            min={0}
            step="1000"
            value={previewPrice}
            onChange={(e) => setPreviewPrice(Number(e.target.value) || 0)}
          />
        </div>
        {rules.length === 0 ? (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>Ajoutez des niveaux pour voir l&apos;aperçu.</div>
        ) : (
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr 1fr 120px', background: '#f8fafc', padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '.03em' }}>
              <span>Niveau</span>
              <span>Règle</span>
              <span>Plafond</span>
              <span style={{ textAlign: 'right' }}>Commission</span>
            </div>
            {rules.slice().sort((a, b) => a.level - b.level).map((r) => {
              const amt = computePreviewRow(r, previewPrice)
              const ruleDesc = r.ruleType === 'percent'
                ? `${Number(r.value || 0).toLocaleString('fr-FR')} %`
                : `${Number(r.value || 0).toLocaleString('fr-FR')} TND fixe`
              const capDesc = r.maxCapAmount != null && r.maxCapAmount !== ''
                ? `${Number(r.maxCapAmount).toLocaleString('fr-FR')} TND`
                : '—'
              return (
                <div
                  key={`preview-${r.level}`}
                  style={{ display: 'grid', gridTemplateColumns: '72px 1fr 1fr 120px', padding: '8px 10px', fontSize: 12, borderTop: '1px solid #e2e8f0', alignItems: 'center' }}
                >
                  <span style={{ fontWeight: 700, color: '#0f172a' }}>L{r.level}</span>
                  <span style={{ color: '#334155' }}>{ruleDesc}</span>
                  <span style={{ color: '#64748b' }}>{capDesc}</span>
                  <span style={{ textAlign: 'right', fontWeight: 800, color: '#059669' }}>
                    {amt.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} TND
                  </span>
                </div>
              )
            })}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', padding: '8px 10px', background: '#f1f5f9', borderTop: '1px solid #e2e8f0' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: '#475569' }}>Total cumulé (si chaîne complète)</span>
              <span style={{ textAlign: 'right', fontSize: 12, fontWeight: 800, color: '#1e40af' }}>
                {rules.reduce((acc, r) => acc + computePreviewRow(r, previewPrice), 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} TND
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
