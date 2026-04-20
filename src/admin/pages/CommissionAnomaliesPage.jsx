import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase.js'
import AdminModal from '../components/AdminModal.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { SkeletonCard } from '../../components/skeletons/index.js'
import './zitouna-admin-page.css'
import './commission-anomalies.css'

// Read-only admin page that surfaces referral-tree anomalies returned by the
// SQL RPC `public.detect_parrainage_anomalies()`.  The RPC is produced by a
// sibling migration and returns jsonb of shape:
//   { cycles, self_referrals, orphan_commissions, mismatched_l1, duplicate_upline }
// Each key maps to an array of row objects; shapes are tolerant (see renderers).

// Keep AdminModal importable per admin conventions; not rendered today but we
// reference the symbol so future drill-downs don't require re-adding the import.
void AdminModal

const CATEGORIES = [
  { key: 'cycles', label: 'Cycles de parrainage' },
  { key: 'self_referrals', label: 'Auto-parrainages' },
  { key: 'orphan_commissions', label: 'Commissions orphelines' },
  { key: 'mismatched_l1', label: 'L1 incohérents' },
  { key: 'duplicate_upline', label: 'Upline en doublon' },
]

// Extract an array no matter whether Postgres returns null, an object-keyed
// jsonb, or an already parsed array.  Defensive so the UI never crashes.
function asList(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return Object.values(raw)
  return []
}

function shortId(id) {
  const s = String(id || '')
  if (!s) return '—'
  if (s.length <= 10) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

function renderCycle(row, i) {
  const chain = Array.isArray(row?.chain) ? row.chain : Array.isArray(row?.ids) ? row.ids : []
  const size = Number(row?.size || chain.length || 0)
  const rendered = chain.length ? chain.map(shortId).join(' → ') : '—'
  return (
    <li key={`cycle-${i}`} className="can-item">
      <span className="can-item__title">Cycle de {size} clients</span>
      <span className="can-item__detail">{rendered}</span>
    </li>
  )
}

function renderSelfReferral(row, i) {
  const id = shortId(row?.client_id || row?.id)
  const reason = row?.reason || row?.cause || 'auto-parrainage détecté'
  return (
    <li key={`self-${i}`} className="can-item">
      <span className="can-item__title">Client {id} se parraine lui-même</span>
      <span className="can-item__detail">({reason})</span>
    </li>
  )
}

function renderOrphan(row, i) {
  const eventId = shortId(row?.event_id || row?.id)
  return (
    <li key={`orphan-${i}`} className="can-item">
      <span className="can-item__title">Événement {eventId}</span>
      <span className="can-item__detail">référence un bénéficiaire supprimé</span>
    </li>
  )
}

function renderMismatched(row, i) {
  const beneficiary = shortId(row?.beneficiary_client_id || row?.beneficiary_id)
  const seller = shortId(row?.seller_client_id || row?.seller_id)
  const sale = shortId(row?.sale_id)
  return (
    <li key={`mml1-${i}`} className="can-item">
      <span className="can-item__title">Événement L1</span>
      <span className="can-item__detail">
        bénéficiaire {beneficiary} ≠ vendeur {seller} (vente {sale})
      </span>
    </li>
  )
}

function renderDuplicate(row, i) {
  const authId = shortId(row?.auth_user_id || row?.user_id)
  const count = Number(row?.client_count || row?.count || 0)
  return (
    <li key={`dup-${i}`} className="can-item">
      <span className="can-item__title">auth_user_id {authId}</span>
      <span className="can-item__detail">est lié à {count} fiches clients</span>
    </li>
  )
}

const RENDERERS = {
  cycles: renderCycle,
  self_referrals: renderSelfReferral,
  orphan_commissions: renderOrphan,
  mismatched_l1: renderMismatched,
  duplicate_upline: renderDuplicate,
}

function Section({ category, rows, open, onToggle }) {
  const count = rows.length
  const tone = count === 0 ? 'ok' : 'warn'
  const renderer = RENDERERS[category.key]
  return (
    <section className={`can-section can-section--${tone}`} aria-label={category.label}>
      <button
        type="button"
        className="can-section__header"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="can-section__title">{category.label}</span>
        <span className={`can-section__badge can-section__badge--${tone}`}>{count}</span>
        <span className="can-section__chev" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="can-section__body">
          {count === 0 ? (
            <p className="can-empty">✓ Aucune anomalie</p>
          ) : (
            <ul className="can-list">{rows.map((row, i) => renderer(row, i))}</ul>
          )}
        </div>
      ) : null}
    </section>
  )
}

export default function CommissionAnomaliesPage() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [openSections, setOpenSections] = useState(() => ({
    cycles: true,
    self_referrals: true,
    orphan_commissions: true,
    mismatched_l1: true,
    duplicate_upline: true,
  }))

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      // RESEARCH 03: the RPC previously ran without a timeout — if Supabase
      // was down, the promise hung indefinitely and the page skeleton never
      // resolved. 20s budget accommodates the full-tree scan on a cold
      // replica while still surfacing a visible error to the admin.
      const { data: rpcData, error } = await Promise.race([
        supabase.rpc('detect_parrainage_anomalies'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('RPC timeout (20s)')), 20_000)),
      ])
      if (error) throw new Error(error.message)
      setData(rpcData || {})
    } catch (e) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const counts = useMemo(() => {
    const out = {}
    for (const cat of CATEGORIES) out[cat.key] = asList(data?.[cat.key]).length
    return out
  }, [data])

  const totalAnomalies = useMemo(
    () => Object.values(counts).reduce((s, n) => s + n, 0),
    [counts],
  )

  function toggleSection(key) {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">
        <button
          type="button"
          className="ds-back-btn"
          onClick={() => navigate(-1)}
          title="Revenir à la page précédente"
        >
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Retour</span>
        </button>

        <section className="cli-hero" aria-label="En-tête des anomalies de parrainage">
          <span className="cli-hero__badge" aria-hidden>🛡️</span>
          <div>
            <h1 className="cli-hero__title">Anomalies de parrainage</h1>
            <p className="cli-hero__subtitle">
              Contrôle lecture-seule : cycles, auto-parrainages, commissions orphelines et incohérences de l'arbre.
            </p>
          </div>
        </section>

        <div className="can-toolbar">
          <button
            type="button"
            className="adm-btn adm-btn--secondary"
            onClick={refresh}
            disabled={loading}
            title="Relancer la détection"
          >
            {loading ? 'Actualisation…' : 'Actualiser'}
          </button>
        </div>

        <div className="can-stats" role="group" aria-label="Synthèse des anomalies">
          {CATEGORIES.map((cat) => {
            const n = counts[cat.key]
            const tone = n === 0 ? 'ok' : 'warn'
            return (
              <div key={cat.key} className={`can-stat can-stat--${tone}`} title={cat.label}>
                <div className="can-stat__label">{cat.label}</div>
                <div className="can-stat__value">{n}</div>
              </div>
            )
          })}
        </div>

        {/* Plan 03 §4.4: replace the loading/error/empty/data ladder with a
            four-state <RenderDataGate>. The RPC is timeout-wrapped upstream;
            the gate's watchdog is the component-level safety net. */}
        <RenderDataGate
          loading={loading && !data}
          error={err ? new Error(err) : null}
          data={data}
          onRetry={refresh}
          skeleton={<SkeletonCard cards={5} />}
          isEmpty={() => totalAnomalies === 0}
          empty={
            <EmptyState
              icon="✅"
              title="Aucune anomalie détectée"
              description="L'arbre de parrainage est cohérent."
            />
          }
        >
          {(payload) => (
            <div>
              {CATEGORIES.map((cat) => (
                <Section
                  key={cat.key}
                  category={cat}
                  rows={asList(payload?.[cat.key])}
                  open={Boolean(openSections[cat.key])}
                  onToggle={() => toggleSection(cat.key)}
                />
              ))}
            </div>
          )}
        </RenderDataGate>
      </div>
    </div>
  )
}
