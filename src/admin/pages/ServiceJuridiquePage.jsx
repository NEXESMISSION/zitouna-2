import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useSales } from '../../lib/useSupabase.js'
import AdminModal from '../components/AdminModal.jsx'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import './zitouna-admin-page.css'
import './service-juridique.css'

function fmtMoney(v) {
  return `${(Number(v) || 0).toLocaleString('fr-FR')} TND`
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso)
  }
}

function normalizePlotIds(sale) {
  const ids = Array.isArray(sale?.plotIds)
    ? sale.plotIds
    : sale?.plotId != null
      ? [sale.plotId]
      : []
  return ids.map((x) => Number(x)).filter((n) => Number.isFinite(n))
}

function toIsoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** @param {string} [iso] timestamptz */
function juridiqueScheduleFromSale(iso) {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const date = `${y}-${m}-${day}`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return { date, time }
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function monthGrid(anchorDate) {
  const first = startOfMonth(anchorDate)
  const startWeekday = (first.getDay() + 6) % 7
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = []
  let day = 1 - startWeekday
  for (let i = 0; i < 42; i += 1) {
    const cur = new Date(first.getFullYear(), first.getMonth(), day)
    cells.push({ date: cur, inMonth: day >= 1 && day <= daysInMonth })
    day += 1
  }
  return cells
}

// Local styles scoped to this page. We deliberately avoid touching the shared
// admin stylesheets; these tokens only enhance hierarchy and mobile layout.
const SJ_LOCAL_CSS = `
.sj-local-wrap { --sj-fg:#0f172a; --sj-muted:#64748b; --sj-border:#e2e8f0; --sj-soft:#f8fafc; --sj-primary:#0f766e; --sj-primary-soft:#ecfdf5; --sj-warn:#b45309; --sj-warn-soft:#fffbeb; }
.sj-local-wrap * { box-sizing: border-box; }
.sj-guide { font-size: 13px; color: var(--sj-muted); margin: 4px 0 12px; line-height: 1.5; }
.sj-guide strong { color: var(--sj-fg); }
.sj-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin: 18px 0 6px; flex-wrap: wrap; }
.sj-section-head h2 { font-size: 18px; font-weight: 700; color: var(--sj-fg); margin:0; }
.sj-section-head .sj-section-help { font-size: 13px; color: var(--sj-muted); }
.sj-badge-count { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; padding:4px 10px; border-radius:999px; background: var(--sj-primary-soft); color: var(--sj-primary); }
.sj-tabs-wrap { display:flex; align-items:center; gap:10px; flex-wrap: wrap; margin-bottom: 8px; }
.sj-hint { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--sj-muted); }
.sj-hint__icon { width:16px; height:16px; border-radius:50%; background:#e2e8f0; color:#334155; font-size:11px; font-weight:700; display:inline-flex; align-items:center; justify-content:center; cursor: help; }
.sj-empty-rich { border: 1px dashed var(--sj-border); background: var(--sj-soft); border-radius: 12px; padding: 22px 18px; text-align:center; }
.sj-empty-rich__title { font-size: 15px; font-weight: 600; color: var(--sj-fg); margin:0 0 4px; }
.sj-empty-rich__sub { font-size: 13px; color: var(--sj-muted); margin:0; line-height: 1.5; }
.sj-empty-rich__icon { font-size: 28px; margin-bottom: 6px; }
.sj-detail__block { background: var(--sj-soft); border:1px solid var(--sj-border); border-radius: 10px; padding: 12px; margin-bottom: 12px; }
.sj-detail__block-title { font-size: 12px; font-weight:700; text-transform: uppercase; letter-spacing: .04em; color: var(--sj-muted); margin: 0 0 8px; }
.sj-detail__grid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px 16px; }
.sj-detail__grid > div { display:flex; flex-direction: column; gap: 2px; min-width: 0; }
.sj-detail__label { font-size: 12px; color: var(--sj-muted); }
.sj-detail__value { font-size: 14px; color: var(--sj-fg); font-weight: 600; word-break: break-word; }
.sj-detail__value--strong { color: var(--sj-primary); }
.sj-notes-card { background: var(--sj-warn-soft); border: 1px solid #fde68a; border-radius: 10px; padding: 10px 12px; font-size: 13px; color: #78350f; line-height: 1.5; margin-bottom: 10px; }
.sj-notes-card b { display:block; font-size: 11px; text-transform: uppercase; letter-spacing:.04em; color:#92400e; margin-bottom: 4px; font-weight: 700; }
.sj-primary-cta { width: 100%; min-height: 48px; font-size: 15px; font-weight: 700; }
.sj-cta-help { font-size: 12px; color: var(--sj-muted); text-align:center; margin: 8px 0 0; }
.sj-legend { display:flex; align-items:center; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--sj-muted); margin: 6px 0 10px; }
.sj-legend__item { display:inline-flex; align-items:center; gap:6px; }
.sj-legend__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sj-primary); }
.sj-today-chip { display:inline-flex; align-items:center; gap:6px; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; background: #fef3c7; color: #92400e; }
.sj-input-like { min-height: 40px; }
@media (max-width: 600px) {
  .sj-detail__grid { grid-template-columns: 1fr; }
  .sj-section-head { flex-direction: column; align-items: flex-start; gap: 4px; }
  .sj-primary-cta { font-size: 14px; }
}
`

export default function ServiceJuridiquePage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { sales, update: salesUpdate } = useSales()
  const [view, setView] = useState('list')
  const [selected, setSelected] = useState(null)
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()))
  const [jurSaving, setJurSaving] = useState(false)

  const legalEntries = useMemo(() => {
    const candidates = (sales || []).filter((s) => {
      const st = String(s.status || '')
      // Juridique can work on dossiers planned by Coordination, even before notary step.
      if (st !== 'pending_finance' && st !== 'pending_legal') return false
      // Juridique is only accessible when coordination actually scheduled it.
      // If no coordination time was set, keep the dossier out of this page.
      if (!s.coordinationJuridiqueAt) return false
      if (s.juridiqueValidatedAt) return false
      return true
    })
    return candidates
      .map((sale) => {
        const plotIds = normalizePlotIds(sale)
        const { date, time } = juridiqueScheduleFromSale(sale.coordinationJuridiqueAt)
        if (!date || !time) return null
        const total = Number(sale.agreedPrice) || 0
        const unit = plotIds.length > 0 ? Math.round(total / plotIds.length) : total
        return {
          id: sale.id,
          saleCode: sale.code || sale.id,
          clientName: sale.clientName || 'Client',
          projectTitle: sale.projectTitle || 'Projet',
          plotIds,
          priceTotal: total,
          pricePerPiece: unit,
          offerName: sale.offerName || (sale.paymentType === 'installments' ? 'Echelonne' : 'Comptant'),
          paymentType: sale.paymentType === 'installments' ? 'Echelonne' : 'Comptant',
          date,
          time,
          notes: sale.notes || '',
          coordinationNotes: sale.coordinationNotes || '',
        }
      })
      .filter(Boolean)
      .sort((a, b) => {
        const da = a.date || '9999-99-99'
        const db = b.date || '9999-99-99'
        const c = `${da} ${a.time || '99:99'}`.localeCompare(`${db} ${b.time || '99:99'}`)
        if (c !== 0) return c
        return String(a.clientName || '').localeCompare(String(b.clientName || ''))
      })
  }, [sales])

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const todayCount = useMemo(() => {
    return legalEntries.filter((e) => e.date && e.date === todayIso).length
  }, [legalEntries, todayIso])

  const appointmentsByDate = useMemo(() => {
    const map = new Map()
    for (const e of legalEntries) {
      const key = e.date || ''
      if (!key) continue
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(e)
    }
    for (const [, list] of map) {
      list.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
    }
    return map
  }, [legalEntries])

  const monthCells = useMemo(() => monthGrid(monthAnchor), [monthAnchor])
  const dayAgenda = useMemo(() => appointmentsByDate.get(selectedDate) || [], [appointmentsByDate, selectedDate])
  const monthLabel = monthAnchor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  const selectedFullSale = useMemo(
    () => (selected ? (sales || []).find((s) => String(s.id) === String(selected.id)) : null),
    [sales, selected],
  )

  async function stampReadyForNotary() {
    if (!selected?.id) return
    setJurSaving(true)
    try {
      const now = new Date().toISOString()
      await salesUpdate(selected.id, {
        juridiqueValidatedAt: now,
        juridiqueValidatedBy: adminUser?.id || null,
      })
      setSelected(null)
    } finally {
      setJurSaving(false)
    }
  }

  return (
    <div className="sj-page sj-local-wrap" dir="ltr">
      <style>{SJ_LOCAL_CSS}</style>
      <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
        <span className="ds-back-btn__icon" aria-hidden>←</span>
        <span className="ds-back-btn__label">Retour</span>
      </button>

      <section className="sj-hero">
        <div className="sj-hero__top">
          <div className="sj-hero__icon" aria-hidden>⚖️</div>
          <div className="sj-hero__text">
            <h1 className="sj-hero__title" style={{ fontSize: 22 }}>Service juridique</h1>
            <p className="sj-hero__sub" style={{ fontSize: 14, lineHeight: 1.5 }}>
              Traitez les rendez-vous planifies par la coordination et validez les dossiers avant le passage chez le notaire.
            </p>
          </div>
        </div>
        <div className="sj-hero__kpi" role="group" aria-label="Indicateurs juridiques">
          <div className="sj-hero__kpi-block">
            <span className="sj-hero__kpi-num">{legalEntries.length}</span>
            <span className="sj-hero__kpi-unit">Dossiers a traiter</span>
          </div>
          <span className="sj-hero__kpi-sep" />
          <div className="sj-hero__kpi-block">
            <span className="sj-hero__kpi-num">{todayCount}</span>
            <span className="sj-hero__kpi-unit">Prevu aujourd'hui</span>
          </div>
        </div>
      </section>

      <div className="sj-tabs-wrap">
        <div className="sj-tabs sj-tabs--2col" role="tablist" aria-label="Mode d'affichage">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'list'}
            className={`sj-tab${view === 'list' ? ' sj-tab--on' : ''}`}
            onClick={() => setView('list')}
            title="Vue rapide pour traiter les dossiers un par un"
          >
            <span className="sj-tab__main">📋 Liste</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'calendar'}
            className={`sj-tab${view === 'calendar' ? ' sj-tab--on' : ''}`}
            onClick={() => setView('calendar')}
            title="Vue mensuelle pour visualiser la charge de travail"
          >
            <span className="sj-tab__main">🗓️ Calendrier</span>
          </button>
        </div>
      </div>

      {view === 'list' && (
        <>
          <div className="sj-section-head">
            <h2>Rendez-vous juridiques</h2>
            <span className="sj-badge-count">
              {legalEntries.length} {legalEntries.length > 1 ? 'dossiers' : 'dossier'}
            </span>
          </div>
          <p className="sj-guide">
            Cliquez sur un dossier pour ouvrir sa fiche et le <strong>valider</strong> avant le notaire.
            Les dossiers deja valides disparaissent automatiquement de cette liste.
          </p>
          {legalEntries.length === 0 ? (
            <div className="sj-empty-rich">
              <div className="sj-empty-rich__icon" aria-hidden>📭</div>
              <p className="sj-empty-rich__title">Aucun dossier en attente</p>
              <p className="sj-empty-rich__sub">
                La coordination n'a planifie aucun rendez-vous juridique pour le moment.
                Les nouveaux dossiers apparaitront automatiquement ici.
              </p>
            </div>
          ) : (
            <div className="sj-cal-grid">
              {legalEntries.map((entry) => {
                const isToday = entry.date === todayIso
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className="sj-agenda__row"
                    onClick={() => setSelected(entry)}
                    title={`Ouvrir le dossier de ${entry.clientName}`}
                  >
                    <span className="sj-agenda__time">{entry.time || '—'}</span>
                    <span className="sj-agenda__body">
                      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="sj-pill sj-pill--juridique">Service juridique</span>
                        {isToday && <span className="sj-today-chip">● Aujourd'hui</span>}
                      </span>
                      <div className="sj-agenda__title" style={{ fontSize: 15 }}>{entry.clientName}</div>
                      <div className="sj-agenda__sub" style={{ fontSize: 13 }}>
                        {entry.projectTitle} • {entry.plotIds.map((id) => `#${id}`).join(', ') || '—'} • {entry.date ? fmtDate(entry.date) : 'Non planifie'}
                      </div>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      {view === 'calendar' && (
        <>
          <div className="sj-section-head">
            <h2>Calendrier juridique</h2>
            <span className="sj-section-help">Cliquez sur un jour pour voir ses rendez-vous.</span>
          </div>
          <p className="sj-guide">
            Le nombre affiche sur chaque jour correspond au nombre de rendez-vous. Utilisez les fleches pour changer de mois.
          </p>
          <div className="sj-legend" aria-hidden>
            <span className="sj-legend__item"><span className="sj-legend__dot" /> Jour avec rendez-vous</span>
            <span className="sj-legend__item">Jour selectionne en surbrillance</span>
          </div>
          <div className="sj-cal-wrap">
            <div className="sj-cal-toolbar">
              <button
                type="button"
                className="sj-cal-nav"
                onClick={() => setMonthAnchor((d) => addMonths(d, -1))}
                aria-label="Mois precedent"
                title="Mois precedent"
              >‹</button>
              <span className="sj-cal-month" style={{ textTransform: 'capitalize' }}>{monthLabel}</span>
              <button
                type="button"
                className="sj-cal-nav"
                onClick={() => setMonthAnchor((d) => addMonths(d, 1))}
                aria-label="Mois suivant"
                title="Mois suivant"
              >›</button>
            </div>

            <div className="sj-cal-weekhead">
              {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
                <span key={d} className="sj-cal-weekday">{d}</span>
              ))}
            </div>
            <div className="sj-cal-grid-month">
              {monthCells.map((cell) => {
                const iso = toIsoDate(cell.date)
                const count = (appointmentsByDate.get(iso) || []).length
                const isSel = iso === selectedDate
                const isToday = iso === todayIso
                return (
                  <button
                    key={`${iso}-${cell.inMonth ? 'in' : 'out'}`}
                    type="button"
                    className={`sj-cal-day${cell.inMonth ? '' : ' sj-cal-day--muted'}${isSel ? ' sj-cal-day--selected' : ''}`}
                    onClick={() => setSelectedDate(iso)}
                    title={count > 0 ? `${count} rendez-vous le ${fmtDate(iso)}` : fmtDate(iso)}
                    aria-label={`${fmtDate(iso)}${count > 0 ? `, ${count} rendez-vous` : ''}`}
                    style={isToday && !isSel ? { outline: '2px solid #fbbf24', outlineOffset: '-2px' } : undefined}
                  >
                    <span className="sj-cal-day__num">{cell.date.getDate()}</span>
                    {count > 0 ? <span className="sj-cal-day__dot">{count}</span> : null}
                  </button>
                )
              })}
            </div>

            <div className="sj-cal-agenda">
              <div className="sj-cal-agenda__head" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ textTransform: 'capitalize' }}>{fmtDate(selectedDate)}</span>
                {selectedDate === todayIso && <span className="sj-today-chip">Aujourd'hui</span>}
                <span style={{ marginLeft: 'auto', fontSize: 13, color: '#64748b', fontWeight: 500 }}>
                  {dayAgenda.length} {dayAgenda.length > 1 ? 'rendez-vous' : 'rendez-vous'}
                </span>
              </div>
              {dayAgenda.length === 0 ? (
                <div className="sj-empty-rich" style={{ margin: 12 }}>
                  <div className="sj-empty-rich__icon" aria-hidden>🗓️</div>
                  <p className="sj-empty-rich__title">Aucun rendez-vous ce jour</p>
                  <p className="sj-empty-rich__sub">Selectionnez une autre date ou changez de mois.</p>
                </div>
              ) : (
                dayAgenda.map((entry) => (
                  <button
                    key={`${entry.id}-${entry.time}`}
                    type="button"
                    className="sj-agenda__row"
                    onClick={() => setSelected(entry)}
                    title={`Ouvrir le dossier de ${entry.clientName}`}
                  >
                    <span className="sj-agenda__time">{entry.time || '—'}</span>
                    <span className="sj-agenda__body">
                      <span className="sj-pill sj-pill--juridique">Service juridique</span>
                      <div className="sj-agenda__title" style={{ fontSize: 15 }}>{entry.clientName}</div>
                      <div className="sj-agenda__sub" style={{ fontSize: 13 }}>
                        {entry.projectTitle} • {entry.plotIds.map((id) => `#${id}`).join(', ') || '—'}
                      </div>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}

      <p className="sj-footnote" style={{ fontSize: 13 }}>
        <strong>Astuce :</strong> utilisez <strong>Liste</strong> pour traiter les dossiers rapidement et
        <strong> Calendrier</strong> pour voir la charge de travail du mois.
      </p>

      {selected && (
        <AdminModal
          open
          onClose={() => setSelected(null)}
          title={`Dossier ${selected.saleCode}`}
        >
          <div className="sj-detail">
            {selectedFullSale ? (
              <div style={{ marginBottom: 14 }}>
                <SaleSnapshotTracePanel sale={selectedFullSale} />
              </div>
            ) : null}

            {/* Client + project summary */}
            <div className="sj-detail__block">
              <p className="sj-detail__block-title">Client & projet</p>
              <div className="sj-detail__grid">
                <div>
                  <span className="sj-detail__label">Client</span>
                  <span className="sj-detail__value">{selected.clientName}</span>
                </div>
                <div>
                  <span className="sj-detail__label">Projet</span>
                  <span className="sj-detail__value">{selected.projectTitle}</span>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <span className="sj-detail__label">Pieces concernees</span>
                  <span className="sj-detail__value">{selected.plotIds.map((id) => `#${id}`).join(', ') || '—'}</span>
                </div>
              </div>
            </div>

            {/* Financial summary */}
            <div className="sj-detail__block">
              <p className="sj-detail__block-title">Montants</p>
              <div className="sj-detail__grid">
                <div>
                  <span className="sj-detail__label">Prix par piece</span>
                  <span className="sj-detail__value">{fmtMoney(selected.pricePerPiece)}</span>
                </div>
                <div>
                  <span className="sj-detail__label">Prix total</span>
                  <span className="sj-detail__value sj-detail__value--strong">{fmtMoney(selected.priceTotal)}</span>
                </div>
                <div>
                  <span className="sj-detail__label">Offre</span>
                  <span className="sj-detail__value">{selected.offerName}</span>
                </div>
                <div>
                  <span className="sj-detail__label">Mode de paiement</span>
                  <span className="sj-detail__value">{selected.paymentType}</span>
                </div>
              </div>
            </div>

            {/* Scheduling */}
            <div className="sj-detail__block">
              <p className="sj-detail__block-title">Rendez-vous planifie</p>
              <div className="sj-detail__grid">
                <div style={{ gridColumn: '1 / -1' }}>
                  <span className="sj-detail__label">Date et heure (coordination)</span>
                  <span className="sj-detail__value">
                    {selected.date
                      ? `${fmtDate(selected.date)} • ${selected.time || '—'}`
                      : 'Non planifie — a verifier avec Coordination'}
                  </span>
                </div>
              </div>
            </div>

            {selected.coordinationNotes ? (
              <div className="sj-notes-card">
                <b>Notes coordination</b>
                {selected.coordinationNotes}
              </div>
            ) : null}
            {selected.notes ? (
              <div className="sj-notes-card">
                <b>Notes du dossier</b>
                {selected.notes}
              </div>
            ) : null}

            <div className="zitu-page__form-actions" style={{ marginTop: 14, flexDirection: 'column', gap: 6 }}>
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--primary sj-primary-cta"
                disabled={jurSaving}
                onClick={stampReadyForNotary}
                title="Marque ce dossier comme conforme et pret pour la suite"
              >
                {jurSaving ? 'Enregistrement…' : '✓ Valider — Pret pour le notaire'}
              </button>
              <p className="sj-cta-help">
                Cette action confirme que le dossier est conforme. Il sera retire de la liste et transmis au notaire.
              </p>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
