import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import appLogo from '../../logo.png'
import { projects as allProjects } from '../projects.js'
import { mockUsers, mockReceipts, mockSales, mockOffers } from '../adminData.js'

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

function Badge({ type }) {
  const map = {
    submitted:   ['badge--blue',  '⏳ En révision'],
    approved:    ['badge--green', '✓ Approuvé'],
    rejected:    ['badge--red',   '✗ Rejeté'],
    cash:        ['badge--green', 'Comptant'],
    installment: ['badge--amber', 'Facilité'],
    available:   ['badge--green', 'Disponible'],
    sold:        ['badge--amber', 'Vendue'],
  }
  const [cls, label] = map[type] || ['badge--gray', type]
  return <span className={`ap-badge ${cls}`}>{label}</span>
}

const TABS = [
  { id: 'receipts', label: 'Reçus',            icon: '📄' },
  { id: 'assign',   label: 'Vendre parcelle',   icon: '🤝' },
  { id: 'history',  label: 'Mes ventes',        icon: '📊' },
]

const EMPTY_NEW_CLIENT = { firstName: '', lastName: '', email: '', phone: '', cin: '' }

export default function AdminDashboard() {
  const navigate = useNavigate()

  const [tab, setTab]           = useState('receipts')
  const [receipts, setReceipts] = useState(mockReceipts)
  const [sales, setSales]       = useState(mockSales.filter(s => s.adminId === 'admin1'))
  const [localUsers, setLocalUsers] = useState(mockUsers)
  const [offers]                = useState(mockOffers)

  const [rejectNote, setRejectNote]     = useState('')
  const [rejectTarget, setRejectTarget] = useState(null)
  const [toast, setToast]               = useState(null)

  /* ── Assign form ── */
  const [form, setForm] = useState({
    userId: '', projectId: '', plotId: '',
    type: 'installment',
    offerId: '',
    araboun: '',
  })
  const [newClientForm, setNewClientForm] = useState(EMPTY_NEW_CLIENT)

  const sf = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))
  const nc = (key) => (e) => setNewClientForm(f => ({ ...f, [key]: e.target.value }))

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3200)
  }

  const pendingCount = receipts.filter(r => r.status === 'submitted').length

  /* ── Receipt actions ── */
  const approveReceipt = (id) => {
    setReceipts(prev => prev.map(r => r.id === id ? { ...r, status: 'approved' } : r))
    showToast('Reçu approuvé.')
  }
  const rejectReceipt = (id, note) => {
    setReceipts(prev => prev.map(r => r.id === id ? { ...r, status: 'rejected', rejectedNote: note } : r))
    setRejectTarget(null); setRejectNote('')
    showToast('Reçu rejeté.', false)
  }

  /* ── Create client on the spot ── */
  const addNewClient = () => {
    const { firstName, lastName, email } = newClientForm
    if (!firstName || !lastName || !email) return showToast('Prénom, nom et email sont requis.', false)
    const newUser = {
      id: Date.now(),
      firstName, lastName, email,
      phone:  newClientForm.phone || '—',
      cin:    newClientForm.cin   || '—',
      balance: 0,
      joined: new Date().toISOString().split('T')[0],
      plots: [],
    }
    setLocalUsers(prev => [...prev, newUser])
    setForm(f => ({ ...f, userId: String(newUser.id) }))
    setNewClientForm(EMPTY_NEW_CLIENT)
    showToast(`Client ${firstName} ${lastName} créé et sélectionné.`)
  }

  /* ── Derived values ── */
  const selectedProj   = allProjects.find(p => p.id === form.projectId)
  const availablePlots = selectedProj?.plots.filter(pl =>
    !sales.find(s => s.projectId === form.projectId && s.plotId === pl.id)
  ) || []
  const selectedPlot   = selectedProj?.plots.find(pl => pl.id === Number(form.plotId))
  const plotPrice      = selectedPlot?.totalPrice || 0

  const selectedOffer  = offers.find(o => o.id === form.offerId)
  const avanceAmt      = selectedOffer ? Math.round(plotPrice * selectedOffer.avancePct / 100) : 0
  const remaining      = plotPrice - avanceAmt
  const monthly        = selectedOffer?.duration > 0 ? Math.round(remaining / selectedOffer.duration) : 0
  const arabounAmt     = parseInt(form.araboun) || 0

  /* ── Submit sale ── */
  const submitAssign = () => {
    if (!form.userId || form.userId === '__new__') return showToast('Veuillez sélectionner ou créer un client.', false)
    if (!form.projectId || !form.plotId)           return showToast('Veuillez sélectionner un projet et une parcelle.', false)
    if (form.type === 'installment' && !form.offerId) return showToast('Veuillez choisir une offre de facilité.', false)

    const user = localUsers.find(u => u.id === Number(form.userId))
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
      offerId:      form.offerId || null,
      araboun:      arabounAmt,
      adminId:      'admin1',
    }
    setSales(prev => [newSale, ...prev])
    setForm({ userId: '', projectId: '', plotId: '', type: 'installment', offerId: '', araboun: '' })
    showToast('Vente enregistrée avec succès !')
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
            <button key={t.id} type="button"
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
            <div className="ap-kpi-grid ap-kpi-grid--3">
              <div className="ap-kpi ap-kpi--blue"><span className="ap-kpi-label">En attente</span><p className="ap-kpi-value">{pendingCount}</p></div>
              <div className="ap-kpi ap-kpi--green"><span className="ap-kpi-label">Approuvés</span><p className="ap-kpi-value">{receipts.filter(r => r.status === 'approved').length}</p></div>
              <div className="ap-kpi ap-kpi--red"><span className="ap-kpi-label">Rejetés</span><p className="ap-kpi-value">{receipts.filter(r => r.status === 'rejected').length}</p></div>
            </div>
            <div className="ap-receipt-list">
              {receipts.map(r => (
                <div key={r.id} className={`ap-receipt-card ap-receipt-card--${r.status}`}>
                  <div className="ap-receipt-top">
                    <div>
                      <p className="ap-receipt-ref">{r.id} · {r.projectTitle}</p>
                      <p className="ap-receipt-client">{r.userName} — Facilité {r.month} · <strong>{r.amount.toLocaleString()} DT</strong></p>
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

        {/* ── VENDRE PARCELLE ── */}
        {tab === 'assign' && (
          <>
            <div className="ap-page-header">
              <div><h1 className="ap-page-title">Vendre une parcelle</h1><p className="ap-page-sub">Assigner une parcelle disponible à un client</p></div>
            </div>

            <div className="ap-assign-form">

              {/* ── 1. Client ── */}
              <div className="ap-form-section-label">① Client</div>
              <div className="ap-form-group">
                <label className="ap-form-label">Sélectionner un client</label>
                <select className="ap-select" value={form.userId} onChange={sf('userId')}>
                  <option value="">— Choisir un client existant —</option>
                  {localUsers.map(u => (
                    <option key={u.id} value={u.id}>{u.firstName} {u.lastName} · {u.email}</option>
                  ))}
                  <option value="__new__">➕ Créer un nouveau client</option>
                </select>
              </div>

              {/* ── Inline new client form ── */}
              {form.userId === '__new__' && (
                <div className="ap-new-client-box">
                  <p className="ap-new-client-title">Nouveau client</p>
                  <div className="ap-form-grid-2">
                    <div className="ap-form-group">
                      <label className="ap-form-label">Prénom *</label>
                      <input className="ap-form-input" placeholder="Lassaad" value={newClientForm.firstName} onChange={nc('firstName')} />
                    </div>
                    <div className="ap-form-group">
                      <label className="ap-form-label">Nom *</label>
                      <input className="ap-form-input" placeholder="Ben Salah" value={newClientForm.lastName} onChange={nc('lastName')} />
                    </div>
                    <div className="ap-form-group">
                      <label className="ap-form-label">Email *</label>
                      <input className="ap-form-input" type="email" placeholder="client@email.com" value={newClientForm.email} onChange={nc('email')} />
                    </div>
                    <div className="ap-form-group">
                      <label className="ap-form-label">Téléphone</label>
                      <input className="ap-form-input" placeholder="+216 55 000 000" value={newClientForm.phone} onChange={nc('phone')} />
                    </div>
                    <div className="ap-form-group">
                      <label className="ap-form-label">CIN</label>
                      <input className="ap-form-input" placeholder="12345678" value={newClientForm.cin} onChange={nc('cin')} />
                    </div>
                  </div>
                  <button type="button" className="ap-btn-primary" style={{ marginTop: '0.5rem' }} onClick={addNewClient}>
                    ✓ Ajouter ce client
                  </button>
                </div>
              )}

              {/* ── 2. Parcelle ── */}
              <div className="ap-form-section-label" style={{ marginTop: '1.25rem' }}>② Parcelle</div>
              <div className="ap-form-group">
                <label className="ap-form-label">Projet</label>
                <select className="ap-select" value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value, plotId: '', offerId: '' }))}>
                  <option value="">— Sélectionner un projet —</option>
                  {allProjects.map(p => (
                    <option key={p.id} value={p.id}>{p.title} · {p.city}</option>
                  ))}
                </select>
              </div>
              <div className="ap-form-group">
                <label className="ap-form-label">Parcelle disponible</label>
                <select className="ap-select" value={form.plotId} onChange={e => setForm(f => ({ ...f, plotId: e.target.value }))} disabled={!form.projectId}>
                  <option value="">— Sélectionner une parcelle —</option>
                  {availablePlots.map(pl => (
                    <option key={pl.id} value={pl.id}>
                      #{pl.id} · {pl.trees} arbres · {pl.totalPrice.toLocaleString()} DT
                    </option>
                  ))}
                </select>
                {form.projectId && availablePlots.length === 0 && (
                  <p className="ap-form-hint ap-form-hint--warn">Toutes les parcelles de ce projet sont vendues.</p>
                )}
              </div>

              {/* ── 3. Paiement ── */}
              <div className="ap-form-section-label" style={{ marginTop: '1.25rem' }}>③ Mode de paiement</div>
              <div className="ap-form-group">
                <div className="ap-type-btns">
                  <button type="button" className={`ap-type-btn${form.type === 'cash' ? ' active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, type: 'cash', offerId: '' }))}>
                    💵 Comptant
                  </button>
                  <button type="button" className={`ap-type-btn${form.type === 'installment' ? ' active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, type: 'installment' }))}>
                    📅 Facilités
                  </button>
                </div>
              </div>

              {/* ── Offer picker (only for facilité) ── */}
              {form.type === 'installment' && (
                <div className="ap-form-group">
                  <label className="ap-form-label">Offre de facilité</label>
                  {offers.length === 0 ? (
                    <p className="ap-form-hint ap-form-hint--warn">Aucune offre disponible. L&apos;administrateur propriétaire doit en créer.</p>
                  ) : (
                    <div className="ap-offer-grid">
                      {offers.map(o => (
                        <button key={o.id} type="button"
                          className={`ap-offer-card${form.offerId === o.id ? ' ap-offer-card--active' : ''}`}
                          onClick={() => setForm(f => ({ ...f, offerId: o.id }))}>
                          <span className="ap-offer-name">{o.label}</span>
                          <span className="ap-offer-detail">Avance {o.avancePct}%</span>
                          <span className="ap-offer-detail">{o.duration} mois</span>
                          {o.note && <span className="ap-offer-note">{o.note}</span>}
                          {plotPrice > 0 && form.offerId === o.id && (
                            <span className="ap-offer-monthly">
                              ≈ {Math.round((plotPrice - Math.round(plotPrice * o.avancePct / 100)) / o.duration).toLocaleString()} DT/mois
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── العربون (Arrhes) — always visible ── */}
              <div className="ap-araboun-wrap">
                <div className="ap-araboun-header">
                  <span className="ap-araboun-title">العربون <span className="ap-araboun-fr">(Arrhes)</span></span>
                  <span className="ap-araboun-hint">Montant personnalisé selon le cas — optionnel</span>
                </div>
                <div className="ap-araboun-input-row">
                  <input
                    className="ap-form-input"
                    type="number"
                    min="0"
                    placeholder="0"
                    value={form.araboun}
                    onChange={sf('araboun')}
                  />
                  <span className="ap-araboun-unit">DT</span>
                </div>
              </div>

              {/* ── Summary ── */}
              {plotPrice > 0 && (
                <div className="ap-summary-box">
                  <div className="ap-summary-row"><span>Prix parcelle</span><strong>{plotPrice.toLocaleString()} DT</strong></div>
                  {arabounAmt > 0 && (
                    <div className="ap-summary-row"><span>العربون</span><strong className="ap-green">{arabounAmt.toLocaleString()} DT</strong></div>
                  )}
                  {form.type === 'installment' && selectedOffer && (
                    <>
                      <div className="ap-summary-row"><span>Avance ({selectedOffer.avancePct}%)</span><strong>{avanceAmt.toLocaleString()} DT</strong></div>
                      <div className="ap-summary-row"><span>Restant</span><strong>{remaining.toLocaleString()} DT</strong></div>
                      <div className="ap-summary-row ap-summary-row--total">
                        <span>Mensualité · {selectedOffer.duration} mois</span>
                        <strong className="ap-green">{monthly.toLocaleString()} DT / mois</strong>
                      </div>
                    </>
                  )}
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
              <div>
                <h1 className="ap-page-title">Mes ventes</h1>
                <p className="ap-page-sub">{sales.length} vente{sales.length !== 1 ? 's' : ''} enregistrée{sales.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="ap-table-wrap">
              <table className="ap-table">
                <thead><tr><th>Réf.</th><th>Client</th><th>Projet</th><th>Parcelle</th><th>Montant</th><th>Arrhes</th><th>Type</th><th>Date</th></tr></thead>
                <tbody>
                  {sales.map(s => (
                    <tr key={s.id}>
                      <td className="ap-mono">{s.id}</td>
                      <td>{s.userName}</td>
                      <td>{s.projectTitle}</td>
                      <td className="ap-mono">#{s.plotId}</td>
                      <td className="ap-bold">{s.amount.toLocaleString()} DT</td>
                      <td className={s.araboun > 0 ? 'ap-green' : 'ap-muted'}>{s.araboun > 0 ? `${s.araboun.toLocaleString()} DT` : '—'}</td>
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
      {toast && <div className={`ap-toast${toast.ok ? '' : ' ap-toast--err'}`}>{toast.msg}</div>}
    </div>
  )
}
