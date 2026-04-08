import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { projects as allProjects } from '../projects.js'
import { mockUsers, mockReceipts, mockSales, mockOffersByProject } from '../adminData.js'
import { loadHealthReports, upsertPlotHealthReport } from '../healthReportsStore.js'
import { loadVisitRequests, saveVisitRequests } from '../visitRequestsStore.js'
import { loadOffersByProject } from '../offersStore.js'

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
    visit_new:   ['badge--blue', 'Nouveau'],
    visit_called:['badge--amber', 'Client contacté'],
    visit_done:  ['badge--green', 'Planifié'],
  }
  const [cls, label] = map[type] || ['badge--gray', type]
  return <span className={`ap-badge ${cls}`}>{label}</span>
}

const TABS = [
  { id: 'receipts', label: 'Reçus',            icon: '📄' },
  { id: 'assign',   label: 'Vendre parcelle',   icon: '🤝' },
  { id: 'visits',   label: 'Rendez-vous',       icon: '📅' },
  { id: 'health',   label: 'Rapports santé',    icon: '🩺' },
  { id: 'history',  label: 'Mes ventes',        icon: '📊' },
]

const EMPTY_NEW_CLIENT = { firstName: '', lastName: '', email: '', phone: '', cin: '' }

export default function AdminDashboard() {
  const navigate = useNavigate()

  const [tab, setTab]           = useState('receipts')
  const [receipts, setReceipts] = useState(mockReceipts)
  const [sales, setSales]       = useState(mockSales.filter(s => s.adminId === 'admin1'))
  const [localUsers, setLocalUsers] = useState(mockUsers)
  const [offersByProject]       = useState(() => {
    const fromStore = loadOffersByProject()
    return Object.keys(fromStore).length > 0 ? fromStore : mockOffersByProject
  })
  const [healthReports, setHealthReports] = useState(loadHealthReports())
  const [visitRequests, setVisitRequests] = useState(loadVisitRequests())

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
  const [healthForm, setHealthForm] = useState({
    projectId: '',
    plotId: '',
    treeSante: '95',
    humidity: '65',
    nutrients: '80',
    co2: '4.2',
    lastWateringPct: '70',
    lastWateringInfo: '2 heures',
    lastDronePct: '15',
    lastDroneInfo: '10 jours',
    nextAction: '"Arrosage automatise (0.5 L)" dans 4 heures',
  })

  const sf = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))
  const nc = (key) => (e) => setNewClientForm(f => ({ ...f, [key]: e.target.value }))

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3200)
  }

  const pendingCount = receipts.filter(r => r.status === 'submitted').length
  const pendingVisits = visitRequests.filter((v) => v.status === 'new').length

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

  const projectOffers  = offersByProject[form.projectId] || []
  const selectedOffer  = projectOffers.find(o => o.id === form.offerId)
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

  const selectedHealthProject = allProjects.find((p) => p.id === healthForm.projectId)
  const healthPlots = selectedHealthProject?.plots || []
  const projectHealthCount = useMemo(() => {
    if (!healthForm.projectId) return 0
    return Object.keys(healthReports).filter((k) => k.startsWith(`${healthForm.projectId}:`)).length
  }, [healthForm.projectId, healthReports])

  useEffect(() => {
    if (!healthForm.projectId || !healthForm.plotId) return
    const key = `${healthForm.projectId}:${healthForm.plotId}`
    const existing = healthReports[key]
    if (!existing) return
    setHealthForm((f) => ({
      ...f,
      treeSante: String(existing.treeSante ?? 0),
      humidity: String(existing.humidity ?? 0),
      nutrients: String(existing.nutrients ?? 0),
      co2: String(existing.co2 ?? 0),
      lastWateringPct: String(existing.lastWatering?.pct ?? 0),
      lastWateringInfo: existing.lastWatering?.info ?? '—',
      lastDronePct: String(existing.lastDrone?.pct ?? 0),
      lastDroneInfo: existing.lastDrone?.info ?? '—',
      nextAction: existing.nextAction ?? '—',
    }))
  }, [healthForm.projectId, healthForm.plotId, healthReports])

  const saveHealthReport = () => {
    if (!healthForm.projectId || !healthForm.plotId) {
      return showToast('Choisissez un projet et une parcelle.', false)
    }
    const report = {
      treeSante: Number(healthForm.treeSante) || 0,
      santeLabel: 'Manuel',
      humidity: Number(healthForm.humidity) || 0,
      humidityLabel: 'Manuel',
      nutrients: Number(healthForm.nutrients) || 0,
      nutrientsLabel: 'Manuel',
      co2: Number(healthForm.co2) || 0,
      co2Trend: [1, 1.5, 2.2, 2.8, 3.6, Number(healthForm.co2) || 0],
      lastWatering: {
        pct: Number(healthForm.lastWateringPct) || 0,
        info: healthForm.lastWateringInfo || '—',
      },
      lastDrone: {
        pct: Number(healthForm.lastDronePct) || 0,
        info: healthForm.lastDroneInfo || '—',
      },
      nextAction: healthForm.nextAction || '—',
    }

    const next = upsertPlotHealthReport(healthForm.projectId, healthForm.plotId, report)
    setHealthReports(next)
    showToast('Rapport santé manuel enregistré.')
  }

  const updateVisitStatus = (visitId, status) => {
    const next = visitRequests.map((v) => (v.id === visitId ? { ...v, status } : v))
    setVisitRequests(next)
    saveVisitRequests(next)
    showToast('Rendez-vous mis à jour.')
  }

  return (
    <main className="screen screen--app">
      <section className="dashboard-page">
      <TopBar />

      {/* role badge */}
      <p className="ap-role-badge ap-role-badge--admin">🛡 Administrateur — Accès limité</p>

      {/* horizontal tab bar */}
      <div className="ap-tabbar">
        {TABS.map(t => (
          <button key={t.id} type="button"
            className={`ap-tab-btn${tab === t.id ? ' ap-tab-btn--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span>{t.icon}</span> {t.label}
            {t.id === 'receipts' && pendingCount > 0 && (
              <span className="ap-nav-badge">{pendingCount}</span>
            )}
            {t.id === 'visits' && pendingVisits > 0 && (
              <span className="ap-nav-badge">{pendingVisits}</span>
            )}
          </button>
        ))}
      </div>

      {/* content */}
      <div className="ap-content">

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

        {/* ── RENDEZ-VOUS RECUS ── */}
        {tab === 'visits' && (
          <>
            <div className="ap-page-header">
              <div>
                <h1 className="ap-page-title">Rendez-vous reçus</h1>
                <p className="ap-page-sub">{visitRequests.length} demande{visitRequests.length !== 1 ? 's' : ''} · {pendingVisits} nouvelle{pendingVisits !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="ap-receipt-list">
              {visitRequests.map((v) => (
                <div key={v.id} className="ap-receipt-card">
                  <div className="ap-receipt-top">
                    <div>
                      <p className="ap-receipt-ref">{v.id} · {v.projectTitle}</p>
                      <p className="ap-receipt-client">{v.userName} — Parcelles: {v.plotIds?.join(', ') || '—'}</p>
                      <p className="ap-receipt-meta">
                        {v.date} · {v.slotLabel}
                      </p>
                    </div>
                    <div className="ap-receipt-right">
                      <Badge type={`visit_${v.status}`} />
                    </div>
                  </div>
                  {v.slotHint && <p className="ap-receipt-note">💬 {v.slotHint}</p>}
                  <div className="ap-receipt-actions">
                    <button type="button" className="ap-btn-approve" onClick={() => updateVisitStatus(v.id, 'called')}>Contacter client</button>
                    <button type="button" className="ap-btn-ghost" onClick={() => updateVisitStatus(v.id, 'done')}>Marquer planifié</button>
                  </div>
                </div>
              ))}
              {visitRequests.length === 0 && <p className="ap-empty">Aucune demande de rendez-vous pour le moment.</p>}
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
                  {projectOffers.length === 0 ? (
                    <p className="ap-form-hint ap-form-hint--warn">Aucune offre disponible. L&apos;administrateur propriétaire doit en créer.</p>
                  ) : (
                    <div className="ap-offer-grid">
                      {projectOffers.map(o => (
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

        {/* ── RAPPORTS SANTE (manuel) ── */}
        {tab === 'health' && (
          <>
            <div className="ap-page-header">
              <div>
                <h1 className="ap-page-title">Rapports santé (manuel)</h1>
                <p className="ap-page-sub">Chaque projet a ses propres rapports. Saisissez l&apos;état santé par projet et parcelle.</p>
              </div>
            </div>

            <div className="ap-assign-form">
              <div className="ap-form-grid-2">
                <div className="ap-form-group">
                  <label className="ap-form-label">Projet</label>
                  <select
                    className="ap-select"
                    value={healthForm.projectId}
                    onChange={(e) => setHealthForm((f) => ({ ...f, projectId: e.target.value, plotId: '' }))}
                  >
                    <option value="">— Sélectionner un projet —</option>
                    {allProjects.map((p) => (
                      <option key={p.id} value={p.id}>{p.title} · {p.city}</option>
                    ))}
                  </select>
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Parcelle</label>
                  <select
                    className="ap-select"
                    value={healthForm.plotId}
                    onChange={(e) => setHealthForm((f) => ({ ...f, plotId: e.target.value }))}
                    disabled={!healthForm.projectId}
                  >
                    <option value="">— Sélectionner une parcelle —</option>
                    {healthPlots.map((pl) => (
                      <option key={pl.id} value={String(pl.id)}>#{pl.id} · {pl.trees} arbres</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="ap-form-grid-2">
                <div className="ap-form-group">
                  <label className="ap-form-label">Santé arbre (%)</label>
                  <input className="ap-form-input" type="number" min="0" max="100" value={healthForm.treeSante} onChange={(e) => setHealthForm((f) => ({ ...f, treeSante: e.target.value }))} />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Humidité (%)</label>
                  <input className="ap-form-input" type="number" min="0" max="100" value={healthForm.humidity} onChange={(e) => setHealthForm((f) => ({ ...f, humidity: e.target.value }))} />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Nutriments (%)</label>
                  <input className="ap-form-input" type="number" min="0" max="100" value={healthForm.nutrients} onChange={(e) => setHealthForm((f) => ({ ...f, nutrients: e.target.value }))} />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">CO2 capturé (kg)</label>
                  <input className="ap-form-input" type="number" step="0.1" min="0" value={healthForm.co2} onChange={(e) => setHealthForm((f) => ({ ...f, co2: e.target.value }))} />
                </div>
              </div>

              <div className="ap-form-grid-2">
                <div className="ap-form-group">
                  <label className="ap-form-label">Dernier arrosage (%)</label>
                  <input className="ap-form-input" type="number" min="0" max="100" value={healthForm.lastWateringPct} onChange={(e) => setHealthForm((f) => ({ ...f, lastWateringPct: e.target.value }))} />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Info arrosage</label>
                  <input className="ap-form-input" value={healthForm.lastWateringInfo} onChange={(e) => setHealthForm((f) => ({ ...f, lastWateringInfo: e.target.value }))} />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Dernier drone (%)</label>
                  <input className="ap-form-input" type="number" min="0" max="100" value={healthForm.lastDronePct} onChange={(e) => setHealthForm((f) => ({ ...f, lastDronePct: e.target.value }))} />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Info drone</label>
                  <input className="ap-form-input" value={healthForm.lastDroneInfo} onChange={(e) => setHealthForm((f) => ({ ...f, lastDroneInfo: e.target.value }))} />
                </div>
              </div>

              <div className="ap-form-group">
                <label className="ap-form-label">Prochaine action</label>
                <input className="ap-form-input" value={healthForm.nextAction} onChange={(e) => setHealthForm((f) => ({ ...f, nextAction: e.target.value }))} />
              </div>

              <button type="button" className="ap-btn-primary ap-btn-primary--full" onClick={saveHealthReport}>
                Enregistrer le rapport manuel
              </button>

              <p className="ap-form-hint" style={{ marginTop: '0.5rem' }}>
                Rapports enregistrés pour ce projet: {projectHealthCount}
              </p>
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

      {/* ── Toast ── */}
      {toast && <div className={`ap-toast${toast.ok ? '' : ' ap-toast--err'}`}>{toast.msg}</div>}
      </div>{/* ap-content */}
      </section>
    </main>
  )
}
