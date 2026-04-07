import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import appLogo from '../../logo.png'
import { projects as allProjects } from '../projects.js'
import { mockUsers, mockReceipts, mockSales } from '../adminData.js'

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

function Badge({ type }) {
  const map = {
    submitted:   ['badge--blue',  '⏳ En révision'],
    approved:    ['badge--green', '✓ Approuvé'],
    rejected:    ['badge--red',   '✗ Rejeté'],
    cash:        ['badge--green', 'Comptant'],
    installment: ['badge--amber', 'Versements'],
  }
  const [cls, label] = map[type] || ['badge--gray', type]
  return <span className={`ap-badge ${cls}`}>{label}</span>
}

const TABS = [
  { id: 'receipts', label: 'Reçus',           icon: '📄' },
  { id: 'assign',   label: 'Assigner parcelle',icon: '🤝' },
  { id: 'history',  label: 'Mes ventes',       icon: '📊' },
]

export default function AdminDashboard() {
  const navigate = useNavigate()

  const [tab, setTab]             = useState('receipts')
  const [receipts, setReceipts]   = useState(mockReceipts)
  const [sales,    setSales]      = useState(mockSales.filter(s => s.adminId === 'admin1'))
  const [rejectNote, setRejectNote]     = useState('')
  const [rejectTarget, setRejectTarget] = useState(null)
  const [toast, setToast] = useState(null)

  // Assign form state
  const [form, setForm] = useState({
    userId: '', projectId: '', plotId: '', type: 'installment',
    downPct: 20, duration: 24,
  })

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  const pendingCount = receipts.filter(r => r.status === 'submitted').length

  /* ── Receipt actions ── */
  const approveReceipt = (id) => {
    setReceipts(prev => prev.map(r => r.id === id ? { ...r, status: 'approved' } : r))
    showToast('Reçu approuvé.')
  }
  const rejectReceipt = (id, note) => {
    setReceipts(prev => prev.map(r => r.id === id ? { ...r, status: 'rejected', rejectedNote: note } : r))
    setRejectTarget(null)
    setRejectNote('')
    showToast('Reçu rejeté.', false)
  }

  /* ── Assign parcel ── */
  const selectedProj  = allProjects.find(p => p.id === form.projectId)
  const availablePlots = selectedProj?.plots.filter(pl =>
    !sales.find(s => s.projectId === form.projectId && s.plotId === pl.id)
  ) || []

  const downAmount = selectedProj?.plots.find(pl => pl.id === Number(form.plotId))
    ? Math.round(selectedProj.plots.find(pl => pl.id === Number(form.plotId)).totalPrice * form.downPct / 100)
    : 0
  const plotPrice = selectedProj?.plots.find(pl => pl.id === Number(form.plotId))?.totalPrice || 0
  const monthly   = form.type === 'installment' && form.duration > 0
    ? Math.round((plotPrice - downAmount) / form.duration)
    : 0

  const submitAssign = () => {
    if (!form.userId || !form.projectId || !form.plotId) { showToast('Veuillez remplir tous les champs.', false); return }
    const user = mockUsers.find(u => u.id === Number(form.userId))
    const newSale = {
      id:           `SALE-${Date.now()}`,
      userId:       Number(form.userId),
      userName:     `${user?.firstName} ${user?.lastName}`,
      projectId:    form.projectId,
      plotId:       Number(form.plotId),
      projectTitle: selectedProj?.region || '',
      date:         new Date().toISOString().split('T')[0],
      amount:       plotPrice,
      type:         form.type,
      adminId:      'admin1',
    }
    setSales(prev => [newSale, ...prev])
    setForm({ userId: '', projectId: '', plotId: '', type: 'installment', downPct: 20, duration: 24 })
    showToast('Parcelle assignée avec succès !')
    setTab('history')
  }

  return (
    <div className="ap-shell">
      {/* ── Sidebar ── */}
      <aside className="ap-sidebar ap-sidebar--admin">
        <div className="ap-sidebar-logo">
          <img src={appLogo} alt="logo" width="36" />
          <div>
            <span className="ap-brand">ZITOUNA BLADI</span>
            <span className="ap-role ap-role--admin">🛡 Administrateur</span>
          </div>
        </div>

        <nav className="ap-nav">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              className={`ap-nav-btn${tab === t.id ? ' ap-nav-btn--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span className="ap-nav-icon">{t.icon}</span>
              {t.label}
              {t.id === 'receipts' && pendingCount > 0 && (
                <span className="ap-nav-badge">{pendingCount}</span>
              )}
            </button>
          ))}
        </nav>

        {/* Read-only notice */}
        <div className="ap-restriction-note">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          Accès limité — les projets et parcelles sont en lecture seule
        </div>

        <button type="button" className="ap-back-btn" onClick={() => navigate('/')}>
          ← Quitter
        </button>
      </aside>

      {/* ── Main ── */}
      <main className="ap-main">

        {/* ── REÇUS ── */}
        {tab === 'receipts' && (
          <>
            <div className="ap-page-header">
              <div><h1 className="ap-page-title">Gestion des reçus</h1><p className="ap-page-sub">{pendingCount} reçu{pendingCount !== 1 ? 's' : ''} en attente</p></div>
            </div>

            {/* Quick stats */}
            <div className="ap-kpi-grid ap-kpi-grid--3">
              <div className="ap-kpi ap-kpi--blue">
                <span className="ap-kpi-label">En attente</span>
                <p className="ap-kpi-value">{pendingCount}</p>
              </div>
              <div className="ap-kpi ap-kpi--green">
                <span className="ap-kpi-label">Approuvés</span>
                <p className="ap-kpi-value">{receipts.filter(r => r.status === 'approved').length}</p>
              </div>
              <div className="ap-kpi ap-kpi--red">
                <span className="ap-kpi-label">Rejetés</span>
                <p className="ap-kpi-value">{receipts.filter(r => r.status === 'rejected').length}</p>
              </div>
            </div>

            <div className="ap-receipt-list">
              {receipts.map(r => (
                <div key={r.id} className={`ap-receipt-card ap-receipt-card--${r.status}`}>
                  <div className="ap-receipt-top">
                    <div>
                      <p className="ap-receipt-ref">{r.id} · {r.projectTitle}</p>
                      <p className="ap-receipt-client">{r.userName} — Versement {r.month} · <strong>{r.amount.toLocaleString()} DT</strong></p>
                      <p className="ap-receipt-meta">Dû le {fmtDate(r.dueDate)} · Soumis le {fmtDate(r.submittedDate)}</p>
                    </div>
                    <div className="ap-receipt-right">
                      <Badge type={r.status} />
                      <a href="#" className="ap-receipt-file">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        {r.fileName}
                      </a>
                    </div>
                  </div>
                  {r.note && <p className="ap-receipt-note">💬 {r.note}</p>}
                  {r.rejectedNote && <p className="ap-receipt-reject-note">⚠ {r.rejectedNote}</p>}
                  {r.status === 'submitted' && (
                    <div className="ap-receipt-actions">
                      <button type="button" className="ap-btn-approve" onClick={() => approveReceipt(r.id)}>✓ Approuver</button>
                      <button type="button" className="ap-btn-reject"  onClick={() => setRejectTarget(r.id)}>✗ Rejeter</button>
                    </div>
                  )}
                  {rejectTarget === r.id && (
                    <div className="ap-reject-form">
                      <textarea className="ap-reject-note-input" placeholder="Motif du rejet…" value={rejectNote} onChange={e => setRejectNote(e.target.value)} rows={2} />
                      <div className="ap-receipt-actions">
                        <button type="button" className="ap-btn-approve" onClick={() => rejectReceipt(r.id, rejectNote)}>Confirmer</button>
                        <button type="button" className="ap-btn-ghost" onClick={() => setRejectTarget(null)}>Annuler</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── ASSIGNER ── */}
        {tab === 'assign' && (
          <>
            <div className="ap-page-header">
              <div><h1 className="ap-page-title">Assigner une parcelle</h1><p className="ap-page-sub">Vendre une parcelle disponible à un client</p></div>
            </div>

            <div className="ap-assign-form">

              {/* Client */}
              <div className="ap-form-group">
                <label className="ap-form-label">Client</label>
                <select className="ap-select" value={form.userId} onChange={e => setForm(f => ({ ...f, userId: e.target.value }))}>
                  <option value="">— Sélectionner un client —</option>
                  {mockUsers.map(u => (
                    <option key={u.id} value={u.id}>{u.firstName} {u.lastName} · {u.email}</option>
                  ))}
                </select>
              </div>

              {/* Project */}
              <div className="ap-form-group">
                <label className="ap-form-label">Projet</label>
                <select className="ap-select" value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value, plotId: '' }))}>
                  <option value="">— Sélectionner un projet —</option>
                  {allProjects.map(p => (
                    <option key={p.id} value={p.id}>{p.title} · {p.city}</option>
                  ))}
                </select>
              </div>

              {/* Plot */}
              <div className="ap-form-group">
                <label className="ap-form-label">Parcelle disponible</label>
                <select className="ap-select" value={form.plotId} onChange={e => setForm(f => ({ ...f, plotId: e.target.value }))} disabled={!form.projectId}>
                  <option value="">— Sélectionner une parcelle —</option>
                  {availablePlots.map(pl => (
                    <option key={pl.id} value={pl.id}>#{pl.id} · {pl.trees} arbres · {pl.totalPrice.toLocaleString()} DT</option>
                  ))}
                </select>
                {form.projectId && availablePlots.length === 0 && (
                  <p className="ap-form-hint ap-form-hint--warn">Toutes les parcelles de ce projet sont vendues.</p>
                )}
              </div>

              {/* Payment type */}
              <div className="ap-form-group">
                <label className="ap-form-label">Mode de paiement</label>
                <div className="ap-type-btns">
                  <button type="button" className={`ap-type-btn${form.type === 'cash' ? ' active' : ''}`} onClick={() => setForm(f => ({ ...f, type: 'cash' }))}>
                    💵 Comptant
                  </button>
                  <button type="button" className={`ap-type-btn${form.type === 'installment' ? ' active' : ''}`} onClick={() => setForm(f => ({ ...f, type: 'installment' }))}>
                    📅 Versements
                  </button>
                </div>
              </div>

              {/* Installment config */}
              {form.type === 'installment' && form.plotId && (
                <div className="ap-installment-config">
                  <div className="ap-form-group">
                    <div className="ap-form-row-label">
                      <label className="ap-form-label">Avance initiale</label>
                      <strong className="ap-form-value">{form.downPct}% — {downAmount.toLocaleString()} DT</strong>
                    </div>
                    <input type="range" min="10" max="50" step="5" value={form.downPct} onChange={e => setForm(f => ({ ...f, downPct: Number(e.target.value) }))} className="plan-slider" />
                    <div className="plan-slider-marks"><span>10%</span><span>30%</span><span>50%</span></div>
                  </div>
                  <div className="ap-form-group">
                    <label className="ap-form-label">Durée du plan</label>
                    <div className="plan-duration-btns">
                      {[12, 24, 36, 48, 60].map(m => (
                        <button key={m} type="button" className={`plan-duration-btn${form.duration === m ? ' active' : ''}`} onClick={() => setForm(f => ({ ...f, duration: m }))}>{m} mois</button>
                      ))}
                    </div>
                  </div>
                  <div className="ap-summary-box">
                    <div className="ap-summary-row"><span>Prix total</span><strong>{plotPrice.toLocaleString()} DT</strong></div>
                    <div className="ap-summary-row"><span>Avance</span><strong>{downAmount.toLocaleString()} DT</strong></div>
                    <div className="ap-summary-row"><span>Restant</span><strong>{(plotPrice - downAmount).toLocaleString()} DT</strong></div>
                    <div className="ap-summary-row ap-summary-row--total"><span>Mensualité</span><strong className="ap-green">{monthly.toLocaleString()} DT / mois</strong></div>
                  </div>
                </div>
              )}

              <button type="button" className="ap-btn-primary ap-btn-primary--full" onClick={submitAssign}>
                Confirmer la vente →
              </button>
            </div>
          </>
        )}

        {/* ── MES VENTES ── */}
        {tab === 'history' && (
          <>
            <div className="ap-page-header">
              <div><h1 className="ap-page-title">Mes ventes</h1><p className="ap-page-sub">{sales.length} vente{sales.length !== 1 ? 's' : ''} enregistrée{sales.length !== 1 ? 's' : ''}</p></div>
            </div>
            <div className="ap-table-wrap">
              <table className="ap-table">
                <thead><tr><th>Réf.</th><th>Client</th><th>Projet</th><th>Parcelle</th><th>Montant</th><th>Type</th><th>Date</th></tr></thead>
                <tbody>
                  {sales.map(s => (
                    <tr key={s.id}>
                      <td className="ap-mono">{s.id}</td>
                      <td>{s.userName}</td>
                      <td>{s.projectTitle}</td>
                      <td className="ap-mono">#{s.plotId}</td>
                      <td className="ap-bold">{s.amount.toLocaleString()} DT</td>
                      <td><Badge type={s.type} /></td>
                      <td className="ap-muted">{fmtDate(s.date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sales.length === 0 && <p className="ap-empty">Aucune vente enregistrée.</p>}
            </div>
          </>
        )}
      </main>

      {/* ── Toast ── */}
      {toast && (
        <div className={`ap-toast${toast.ok ? '' : ' ap-toast--err'}`}>{toast.msg}</div>
      )}
    </div>
  )
}
