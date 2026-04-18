import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useSales } from '../../lib/useSupabase.js'
import AdminModal from '../components/AdminModal.jsx'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import './zitouna-admin-page.css'
import './service-juridique.css'
import './sell-field.css'

const PER_PAGE = 10

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtMoney(v) { return `${(Number(v) || 0).toLocaleString('fr-FR')} TND` }
function fmtMoneyShort(v) {
  const n = Number(v) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 0 })
}
function fmtDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return String(iso) }
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}
function normalizePlotIds(sale) {
  const ids = Array.isArray(sale?.plotIds) ? sale.plotIds : sale?.plotId != null ? [sale.plotId] : []
  return ids.map((x) => Number(x)).filter((n) => Number.isFinite(n))
}
function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function juridiqueScheduleFromSale(iso) {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  return {
    date: toIsoDate(d),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  }
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1) }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1) }
function monthGrid(anchor) {
  const first = startOfMonth(anchor)
  const startWeekday = (first.getDay() + 6) % 7
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = []
  let day = 1 - startWeekday
  for (let i = 0; i < 42; i += 1) {
    cells.push({ date: new Date(first.getFullYear(), first.getMonth(), day), inMonth: day >= 1 && day <= daysInMonth })
    day += 1
  }
  return cells
}
function getPagerPages(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out = [1]
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)
  if (left > 2) out.push('…')
  for (let i = left; i <= right; i++) out.push(i)
  if (right < total - 1) out.push('…')
  out.push(total)
  return out
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ServiceJuridiquePage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { sales, update: salesUpdate } = useSales()

  const [view, setView] = useState('list')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState(null)
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()))
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    window.setTimeout(() => setToast(null), 2800)
  }

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // ── Filter: sales awaiting Juridique validation ───────────────────────────
  const legalEntries = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (sales || [])
      .filter((s) => {
        const st = String(s.status || '')
        if (st !== 'pending_finance' && st !== 'pending_legal') return false
        if (!s.coordinationJuridiqueAt) return false
        if (s.juridiqueValidatedAt) return false
        return true
      })
      .map((sale) => {
        const plotIds = normalizePlotIds(sale)
        const { date, time } = juridiqueScheduleFromSale(sale.coordinationJuridiqueAt)
        if (!date || !time) return null
        const total = Number(sale.agreedPrice) || 0
        const unit = plotIds.length > 0 ? Math.round(total / plotIds.length) : total
        return {
          id: sale.id,
          sale,
          saleCode: sale.code || sale.id,
          clientName: sale.clientName || 'Client',
          projectTitle: sale.projectTitle || 'Projet',
          plotIds,
          plotLabel: plotIds.map((id) => `#${id}`).join(', ') || '—',
          priceTotal: total,
          pricePerPiece: unit,
          offerName: sale.offerName || (sale.paymentType === 'installments' ? 'Échelonné' : 'Comptant'),
          paymentType: sale.paymentType === 'installments' ? 'Échelonné' : 'Comptant',
          date,
          time,
          notes: sale.notes || '',
          coordinationNotes: sale.coordinationNotes || '',
        }
      })
      .filter(Boolean)
      .filter((e) => {
        if (!q) return true
        const hay = `${e.clientName} ${e.projectTitle} ${e.saleCode} ${e.plotIds.join(',')}`.toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => {
        const c = `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
        if (c !== 0) return c
        return String(a.clientName).localeCompare(String(b.clientName))
      })
  }, [sales, query])

  const todayCount = useMemo(
    () => legalEntries.filter((e) => e.date === todayIso).length,
    [legalEntries, todayIso],
  )

  const totalVolume = useMemo(
    () => legalEntries.reduce((sum, e) => sum + e.priceTotal, 0),
    [legalEntries],
  )

  // ── Paging ───────────────────────────────────────────────────────────────
  const pageCount = Math.max(1, Math.ceil(legalEntries.length / PER_PAGE))
  const paged = useMemo(
    () => legalEntries.slice((page - 1) * PER_PAGE, page * PER_PAGE),
    [legalEntries, page],
  )

  // ── Calendar ──────────────────────────────────────────────────────────────
  const appointmentsByDate = useMemo(() => {
    const m = new Map()
    for (const e of legalEntries) {
      if (!m.has(e.date)) m.set(e.date, [])
      m.get(e.date).push(e)
    }
    for (const [, list] of m) list.sort((a, b) => String(a.time).localeCompare(String(b.time)))
    return m
  }, [legalEntries])
  const monthCells = useMemo(() => monthGrid(monthAnchor), [monthAnchor])
  const dayAgenda = useMemo(() => appointmentsByDate.get(selectedDate) || [], [appointmentsByDate, selectedDate])
  const monthLabel = monthAnchor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  const selected = useMemo(
    () => (selectedId ? legalEntries.find((e) => String(e.id) === String(selectedId)) : null),
    [selectedId, legalEntries],
  )

  // ── Actions ───────────────────────────────────────────────────────────────
  async function stampReadyForNotary() {
    if (!selected?.id) return
    setSaving(true)
    try {
      await salesUpdate(selected.id, {
        juridiqueValidatedAt: new Date().toISOString(),
        juridiqueValidatedBy: adminUser?.id || null,
      })
      showToast('Dossier validé — transféré au notaire.')
      setSelectedId(null)
    } catch (e) {
      console.error('stampReadyForNotary', e)
      showToast('Erreur lors de la validation', false)
    } finally {
      setSaving(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="sell-field jur-v3" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      {/* ── Topbar ───────────────────────────────────────────── */}
      <header className="jv-topbar">
        <div className="jv-topbar__title">
          <h1 className="jv-topbar__h1">Service juridique</h1>
          <p className="jv-topbar__sub">Traiter les rendez-vous planifiés et valider avant le notaire.</p>
        </div>
        <div className="jv-topbar__kpis">
          <span className="jv-kpi-pill" title="Dossiers à traiter">
            <strong>{legalEntries.length}</strong><span>dossier{legalEntries.length > 1 ? 's' : ''}</span>
          </span>
          {todayCount > 0 ? (
            <span className="jv-kpi-pill jv-kpi-pill--today" title="Prévus aujourd'hui">
              <strong>{todayCount}</strong><span>aujourd’hui</span>
            </span>
          ) : null}
          <span className="jv-kpi-pill jv-kpi-pill--info" title="Volume total">
            <strong>{fmtMoneyShort(totalVolume)}</strong><span>TND volume</span>
          </span>
        </div>
      </header>

      {/* ── Tabs ────────────────────────────────────────────── */}
      <div className="jv-tabs" role="tablist">
        <button
          type="button" role="tab" aria-selected={view === 'list'}
          className={`jv-tab${view === 'list' ? ' jv-tab--on' : ''}`}
          onClick={() => setView('list')}
        >
          Liste
          <span className="jv-tab__count">{legalEntries.length}</span>
        </button>
        <button
          type="button" role="tab" aria-selected={view === 'calendar'}
          className={`jv-tab${view === 'calendar' ? ' jv-tab--on' : ''}`}
          onClick={() => setView('calendar')}
        >
          Calendrier
        </button>
      </div>

      {view === 'list' && (
        <>
          <div className="jv-search">
            <input
              type="search" value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1) }}
              placeholder="Rechercher un client, projet, code ou parcelle…"
              aria-label="Rechercher un dossier"
            />
          </div>

          <section className="sp-cards jv-queue">
            {legalEntries.length === 0 ? (
              <div className="sp-empty">
                <span className="sp-empty__emoji" aria-hidden>📭</span>
                <div className="sp-empty__title">
                  {query ? 'Aucun résultat' : 'Aucun dossier en attente'}
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }}>
                  {query
                    ? 'Essayez un autre mot-clé.'
                    : 'La coordination n’a planifié aucun rendez-vous juridique.'}
                </p>
              </div>
            ) : (
              paged.map((entry) => {
                const isToday = entry.date === todayIso
                return (
                  <article
                    key={entry.id}
                    className="sp-card jv-card"
                    role="button" tabIndex={0}
                    onClick={() => setSelectedId(entry.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedId(entry.id)
                      }
                    }}
                  >
                    <div className="sp-card__head">
                      <div className="sp-card__user">
                        <span className="sp-card__initials" aria-hidden>{initials(entry.clientName)}</span>
                        <div>
                          <p className="sp-card__name">{entry.clientName}</p>
                          <p className="sp-card__sub">{entry.projectTitle} · Parcelle {entry.plotLabel}</p>
                        </div>
                      </div>
                      {isToday
                        ? <span className="sp-badge sp-badge--orange">Aujourd’hui</span>
                        : <span className="sp-badge sp-badge--gray">{fmtDate(entry.date)}</span>
                      }
                    </div>

                    <div className="jv-card__meta">
                      <div className="jv-card__time">
                        <span className="jv-card__time-ico" aria-hidden>🕐</span>
                        <strong>{entry.time}</strong>
                        <span className="jv-card__time-sep">·</span>
                        <span>{fmtDate(entry.date)}</span>
                      </div>
                      <div className="jv-card__price">
                        <span className="jv-card__price-num">{fmtMoney(entry.priceTotal)}</span>
                        <span className="jv-card__price-type">{entry.paymentType}</span>
                      </div>
                    </div>
                  </article>
                )
              })
            )}
          </section>

          {legalEntries.length > PER_PAGE && (
            <div className="sp-pager" role="navigation" aria-label="Pagination">
              <button
                type="button" className="sp-pager__btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Page précédente"
              >‹</button>
              {getPagerPages(page, pageCount).map((p, i) =>
                p === '…' ? (
                  <span key={`d-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
                ) : (
                  <button
                    key={p} type="button"
                    className={`sp-pager__btn${p === page ? ' sp-pager__btn--active' : ''}`}
                    onClick={() => setPage(p)}
                    aria-current={p === page ? 'page' : undefined}
                  >{p}</button>
                ),
              )}
              <button
                type="button" className="sp-pager__btn"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                aria-label="Page suivante"
              >›</button>
              <span className="sp-pager__info">
                {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, legalEntries.length)} / {legalEntries.length}
              </span>
            </div>
          )}
        </>
      )}

      {view === 'calendar' && (
        <section className="jv-cal">
          <div className="jv-cal__nav">
            <button type="button" className="jv-cal__nav-btn" onClick={() => setMonthAnchor((d) => addMonths(d, -1))}>‹</button>
            <span className="jv-cal__month">{monthLabel}</span>
            <button type="button" className="jv-cal__nav-btn" onClick={() => setMonthAnchor((d) => addMonths(d, 1))}>›</button>
          </div>
          <div className="jv-cal__week">
            {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
              <span key={d} className="jv-cal__weekday">{d}</span>
            ))}
          </div>
          <div className="jv-cal__grid">
            {monthCells.map((cell) => {
              const iso = toIsoDate(cell.date)
              const count = (appointmentsByDate.get(iso) || []).length
              const isSel = iso === selectedDate
              const isToday = iso === todayIso
              return (
                <button
                  key={`${iso}-${cell.inMonth ? 'in' : 'out'}`}
                  type="button"
                  className={`jv-cal__day${cell.inMonth ? '' : ' jv-cal__day--muted'}${isSel ? ' jv-cal__day--sel' : ''}${isToday ? ' jv-cal__day--today' : ''}`}
                  onClick={() => setSelectedDate(iso)}
                >
                  <span className="jv-cal__day-num">{cell.date.getDate()}</span>
                  {count > 0 ? <span className="jv-cal__day-dot">{count}</span> : null}
                </button>
              )
            })}
          </div>
          <div className="jv-cal__agenda">
            <div className="jv-cal__agenda-head">
              {fmtDate(selectedDate)}
              {selectedDate === todayIso
                ? <span className="jv-today-chip">Aujourd’hui</span>
                : null
              }
            </div>
            {dayAgenda.length === 0 ? (
              <div className="jv-cal__agenda-empty">Aucun rendez-vous ce jour.</div>
            ) : (
              dayAgenda.map((entry) => (
                <button
                  key={`${entry.id}-${entry.time}`} type="button"
                  className="jv-cal__item"
                  onClick={() => setSelectedId(entry.id)}
                >
                  <span className="jv-cal__item-time">{entry.time}</span>
                  <span className="jv-cal__item-body">
                    <span className="jv-cal__item-kind">Juridique</span>
                    <span className="jv-cal__item-name">{entry.clientName}</span>
                    <span className="jv-cal__item-sub">{entry.projectTitle} · {entry.plotLabel}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
      )}

      {/* ── Detail + validation modal ───────────────────────── */}
      <AdminModal
        open={Boolean(selected)}
        onClose={() => setSelectedId(null)}
        title={selected ? `Dossier ${selected.saleCode}` : 'Dossier'}
        width={560}
      >
        {selected && (
          <div className="jv-detail">
            <div className="jv-detail__head">
              <div>
                <div className="jv-detail__name">{selected.clientName}</div>
                <div className="jv-detail__code">Réf : <code>{selected.saleCode}</code></div>
              </div>
              {selected.date === todayIso
                ? <span className="sp-badge sp-badge--orange">Aujourd’hui</span>
                : <span className="sp-badge sp-badge--gray">{fmtDate(selected.date)}</span>
              }
            </div>

            {/* Schedule hero */}
            <div className="jv-detail__sched">
              <div className="jv-detail__sched-lbl">Rendez-vous planifié</div>
              <div className="jv-detail__sched-val">
                <strong>{fmtDate(selected.date)}</strong>
                <span className="jv-detail__sched-time">{selected.time}</span>
              </div>
            </div>

            {selected.sale ? (
              <div style={{ margin: '6px 0' }}>
                <SaleSnapshotTracePanel sale={selected.sale} />
              </div>
            ) : null}

            <DetailBlock title="Client & projet">
              <Row k="Client" v={selected.clientName} />
              <Row k="Projet" v={selected.projectTitle} />
              <Row k="Parcelle(s)" v={selected.plotLabel} />
            </DetailBlock>

            <DetailBlock title="Montants">
              <Row k="Prix total" v={fmtMoney(selected.priceTotal)} strong />
              <Row k="Prix / parcelle" v={fmtMoney(selected.pricePerPiece)} />
              <Row k="Offre" v={selected.offerName} />
              <Row k="Mode paiement" v={selected.paymentType} />
            </DetailBlock>

            {selected.coordinationNotes ? (
              <div className="jv-notes jv-notes--coord">
                <div className="jv-notes__label">Notes coordination</div>
                <div className="jv-notes__body">{selected.coordinationNotes}</div>
              </div>
            ) : null}
            {selected.notes ? (
              <div className="jv-notes">
                <div className="jv-notes__label">Notes du dossier</div>
                <div className="jv-notes__body">{selected.notes}</div>
              </div>
            ) : null}

            <div className="jv-detail__footer">
              <button
                type="button" className="jv-btn jv-btn--ghost"
                onClick={() => setSelectedId(null)}
              >Fermer</button>
              <button
                type="button" className="jv-btn jv-btn--primary"
                disabled={saving}
                onClick={stampReadyForNotary}
                title="Marque ce dossier comme conforme et le transfère au notaire"
              >
                {saving ? 'Enregistrement…' : '✓ Valider — Prêt pour le notaire'}
              </button>
            </div>
          </div>
        )}
      </AdminModal>

      {toast ? (
        <div
          className={`jv-toast${toast.ok ? ' jv-toast--ok' : ' jv-toast--err'}`}
          role="status"
          onClick={() => setToast(null)}
        >
          <span className="jv-toast__icon" aria-hidden>{toast.ok ? '✓' : '✕'}</span>
          <span className="jv-toast__msg">{toast.msg}</span>
        </div>
      ) : null}
    </div>
  )
}

function DetailBlock({ title, children }) {
  return (
    <section className="jv-detail__block">
      <div className="jv-detail__block-title">{title}</div>
      <div className="jv-detail__block-body">{children}</div>
    </section>
  )
}

function Row({ k, v, strong }) {
  return (
    <div className="jv-detail__row">
      <span className="jv-detail__row-k">{k}</span>
      <span className={`jv-detail__row-v${strong ? ' jv-detail__row-v--strong' : ''}`}>{v}</span>
    </div>
  )
}
