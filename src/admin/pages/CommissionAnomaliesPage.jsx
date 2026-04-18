import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase.js'
import AdminModal from '../components/AdminModal.jsx'
import './zitouna-admin-page.css'

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
      const { data: rpcData, error } = await supabase.rpc('detect_parrainage_anomalies')
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
      <style>{`
        .cli-hero {
          background: linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%);
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          padding: 18px 20px;
          margin-top: 8px;
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .cli-hero__badge {
          width: 44px; height: 44px;
          border-radius: 12px;
          background: #1d4ed8;
          color: #fff;
          font-size: 22px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .cli-hero__title { font-size: 20px; font-weight: 700; color: #0f172a; margin: 0; line-height: 1.2; }
        .cli-hero__subtitle { font-size: 13px; color: #475569; margin: 4px 0 0; }

        .can-toolbar { display: flex; justify-content: flex-end; gap: 8px; margin: 12px 0 6px; }
        .can-stats {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 10px;
          margin: 12px 0 6px;
        }
        .can-stat {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 12px 14px;
        }
        .can-stat__label { font-size: 12px; color: #64748b; font-weight: 500; }
        .can-stat__value { font-size: 22px; font-weight: 700; margin-top: 4px; line-height: 1; }
        .can-stat--ok { background: #f0fdf4; border-color: #bbf7d0; }
        .can-stat--ok .can-stat__value { color: #166534; }
        .can-stat--warn { background: #fef2f2; border-color: #fecaca; }
        .can-stat--warn .can-stat__value { color: #991b1b; }

        .can-section { border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; margin-top: 10px; overflow: hidden; }
        .can-section--warn { border-color: #fecaca; }
        .can-section__header {
          display: flex; align-items: center; gap: 10px;
          width: 100%; text-align: left; cursor: pointer;
          background: transparent; border: 0; padding: 12px 14px;
          font: inherit; color: inherit;
        }
        .can-section__header:hover { background: #f8fafc; }
        .can-section__title { flex: 1; font-weight: 600; color: #0f172a; }
        .can-section__badge {
          display: inline-block; min-width: 28px; padding: 2px 10px;
          border-radius: 999px; font-size: 12px; font-weight: 700;
          text-align: center;
        }
        .can-section__badge--ok { background: #dcfce7; color: #166534; }
        .can-section__badge--warn { background: #fee2e2; color: #991b1b; }
        .can-section__chev { font-size: 12px; color: #64748b; }
        .can-section__body { padding: 0 14px 14px; border-top: 1px solid #f1f5f9; }
        .can-list { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-direction: column; gap: 6px; }
        .can-item { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; background: #fafafa; border: 1px solid #f1f5f9; border-radius: 8px; font-size: 13px; }
        .can-item__title { font-weight: 600; color: #0f172a; }
        .can-item__detail { color: #475569; }
        .can-empty { margin: 10px 0 0; color: #166534; font-size: 13px; }
        .can-error {
          border: 1px solid #fecaca; background: #fef2f2; color: #991b1b;
          padding: 10px 12px; border-radius: 10px; margin: 8px 0;
          display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;
        }
        .can-loading { color: #64748b; font-size: 14px; padding: 20px; text-align: center; }

        @media (max-width: 900px) { .can-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 600px) { .can-stats { grid-template-columns: 1fr; } }
      `}</style>

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

        {err ? (
          <div className="can-error" role="alert">
            <span>Erreur lors du chargement : {err}</span>
            <button type="button" className="adm-btn adm-btn--secondary" onClick={refresh}>
              Réessayer
            </button>
          </div>
        ) : null}

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

        {loading && !data ? (
          <div className="can-loading">Chargement des anomalies…</div>
        ) : (
          <div>
            {totalAnomalies === 0 && !err ? (
              <p className="can-empty" style={{ padding: '10px 0' }}>
                ✓ Aucune anomalie détectée sur l'arbre de parrainage.
              </p>
            ) : null}
            {CATEGORIES.map((cat) => (
              <Section
                key={cat.key}
                category={cat}
                rows={asList(data?.[cat.key])}
                open={Boolean(openSections[cat.key])}
                onToggle={() => toggleSection(cat.key)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
