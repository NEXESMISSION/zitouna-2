import { useState, useMemo } from 'react'
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
    installment: ['badge--amber', 'Facilité'],
    active:      ['badge--green', 'Actif'],
    available:   ['badge--green', 'Disponible'],
    sold:        ['badge--amber', 'Vendue'],
  }
  const [cls, label] = map[type] || ['badge--gray', type]
  return <span className={`ap-badge ${cls}`}>{label}</span>
}

const TABS = [
  { id: 'overview',  label: 'Aperçu',    icon: '▦' },
  { id: 'projects',  label: 'Projets',   icon: '🌿' },
  { id: 'clients',   label: 'Clients',   icon: '👤' },
  { id: 'sales',     label: 'Ventes',    icon: '💰' },
  { id: 'receipts',  label: 'Reçus',     icon: '📄' },
]

const EMPTY_PROJECT = { id: '', title: '', city: '', region: '', area: '', year: String(new Date().getFullYear()), lat: '', lng: '' }
const EMPTY_PARCEL  = { trees: '', area: '', pricePerTree: '' }

function makeMapUrl(lat, lng) {
  const pad = 0.05
  return `https://www.openstreetmap.org/export/embed.html?bbox=${(lng - pad).toFixed(3)},${(lat - pad).toFixed(3)},${(lng + pad).toFixed(3)},${(lat + pad).toFixed(3)}&layer=mapnik&marker=${lat},${lng}`
}

export default function OwnerDashboard() {
  const navigate = useNavigate()
  const [tab, setTab]               = useState('overview')
  const [receipts, setReceipts]     = useState(mockReceipts)
  const [users, setUsers]           = useState(mockUsers)
  const [projects, setProjects]     = useState(allProjects)
  const [search, setSearch]         = useState('')
  const [rejectNote, setRejectNote] = useState('')
  const [rejectTarget, setRejectTarget] = useState(null)
  const [delConfirm, setDelConfirm] = useState(null)
  const [toast, setToast]           = useState(null)

  /* ── New state for forms ── */
  const [projectModal, setProjectModal] = useState(null)   // null | { mode:'new'|'edit', ...fields }
  const [parcelPanel, setParcelPanel]   = useState(null)   // projectId | null
  const [parcelModal, setParcelModal]   = useState(null)   // null | { projectId, ...fields }
  const [delPlotConfirm, setDelPlotConfirm] = useState(null) // { projectId, plotId, label }

  /* ── Helpers ── */
  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3200)
  }

  const totalParcels = projects.reduce((s, p) => s + p.plots.length, 0)
  const totalRevenue = mockSales.reduce((s, v) => s + v.amount, 0)
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

  /* ── Project CRUD ── */
  const openNewProject  = () => setProjectModal({ mode: 'new', ...EMPTY_PROJECT })
  const openEditProject = (p) => setProjectModal({ mode: 'edit', id: p.id, title: p.title, city: p.city, region: p.region, area: p.area, year: String(p.year), lat: '', lng: '' })

  const saveProject = (e) => {
    e.preventDefault()
    const m = projectModal
    if (!m.title || !m.city) return showToast('Titre et ville sont requis.', false)
    const lat  = parseFloat(m.lat)  || 36.8
    const lng  = parseFloat(m.lng)  || 10.2
    const slug = m.mode === 'new'
      ? (m.id.trim() || m.city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-'))
      : m.id
    const mapUrl = makeMapUrl(lat, lng)

    if (m.mode === 'new') {
      if (projects.find(p => p.id === slug)) return showToast('Un projet avec cet identifiant existe déjà.', false)
      setProjects(prev => [...prev, {
        id: slug, title: m.title, city: m.city, region: m.region,
        area: m.area || '—', year: parseInt(m.year) || new Date().getFullYear(),
        mapUrl, plots: [],
      }])
      showToast('Projet créé avec succès.')
    } else {
      setProjects(prev => prev.map(p => p.id === m.id ? {
        ...p, title: m.title, city: m.city, region: m.region,
        area: m.area || p.area, year: parseInt(m.year) || p.year,
        mapUrl: (m.lat && m.lng) ? mapUrl : p.mapUrl,
      } : p))
      showToast('Projet mis à jour.')
    }
    setProjectModal(null)
  }

  const deleteProject = (id) => {
    setProjects(prev => prev.filter(p => p.id !== id))
    if (parcelPanel === id) setParcelPanel(null)
    setDelConfirm(null); showToast('Projet supprimé.')
  }

  /* ── Parcel CRUD ── */
  const openNewParcel = (projectId) => setParcelModal({ projectId, ...EMPTY_PARCEL })

  const savePlot = (e) => {
    e.preventDefault()
    const { projectId, trees, area, pricePerTree } = parcelModal
    if (!trees || !area || !pricePerTree) return showToast('Tous les champs sont requis.', false)
    const proj  = projects.find(p => p.id === projectId)
    const maxId = proj.plots.reduce((m, pl) => Math.max(m, pl.id), 0)
    setProjects(prev => prev.map(p => p.id === projectId ? {
      ...p, plots: [...p.plots, {
        id: maxId + 1,
        area: parseInt(area),
        trees: parseInt(trees),
        pricePerTree: parseInt(pricePerTree),
        totalPrice: parseInt(trees) * parseInt(pricePerTree),
        mapUrl: proj.mapUrl,
      }],
    } : p))
    setParcelModal(null); showToast('Parcelle ajoutée.')
  }

  const deletePlot = ({ projectId, plotId }) => {
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, plots: p.plots.filter(pl => pl.id !== plotId) } : p))
    setDelPlotConfirm(null); showToast('Parcelle supprimée.')
  }

  /* ── Client delete ── */
  const deleteUser = (id) => {
    setUsers(prev => prev.filter(u => u.id !== id))
    setDelConfirm(null); showToast('Client supprimé.')
  }

  const filteredUsers = useMemo(() =>
    users.filter(u =>
      !search ||
      `${u.firstName} ${u.lastName}`.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.cin.includes(search)
    ), [users, search])

  /* ── Field helper for project modal ── */
  const pf = (key) => ({
    value: projectModal?.[key] ?? '',
    onChange: e => setProjectModal(prev => ({ ...prev, [key]: e.target.value })),
  })
  const pfc = (key) => ({
    value: parcelModal?.[key] ?? '',
    onChange: e => setParcelModal(prev => ({ ...prev, [key]: e.target.value })),
  })

  return (
    <div className="ap-shell">

      {/* ── Sidebar ── */}
      <aside className="ap-sidebar ap-sidebar--owner">
        <div className="ap-sidebar-logo">
          <img src={appLogo} alt="logo" width="36" />
          <div>
            <span className="ap-brand">ZITOUNA BLADI</span>
            <span className="ap-role ap-role--owner">👑 Propriétaire</span>
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
        <button type="button" className="ap-back-btn" onClick={() => navigate('/')}>
          ← Quitter le panel
        </button>
      </aside>

      {/* ── Main ── */}
      <main className="ap-main">

        {/* ── APERÇU ── */}
        {tab === 'overview' && (
          <>
            <div className="ap-page-header">
              <div>
                <h1 className="ap-page-title">Vue d&apos;ensemble</h1>
                <p className="ap-page-sub">Tableau de bord global de la plateforme</p>
              </div>
            </div>
            <div className="ap-kpi-grid">
              <div className="ap-kpi ap-kpi--green">
                <span className="ap-kpi-label">Projets actifs</span>
                <p className="ap-kpi-value">{projects.length}</p>
              </div>
              <div className="ap-kpi">
                <span className="ap-kpi-label">Total parcelles</span>
                <p className="ap-kpi-value">{totalParcels}</p>
              </div>
              <div className="ap-kpi">
                <span className="ap-kpi-label">Clients inscrits</span>
                <p className="ap-kpi-value">{users.length}</p>
              </div>
              <div className="ap-kpi ap-kpi--amber">
                <span className="ap-kpi-label">Chiffre d&apos;affaires</span>
                <p className="ap-kpi-value">{totalRevenue.toLocaleString()}</p>
                <span className="ap-kpi-sub">DT total</span>
              </div>
              <div className="ap-kpi ap-kpi--blue">
                <span className="ap-kpi-label">Reçus en attente</span>
                <p className="ap-kpi-value">{pendingCount}</p>
              </div>
              <div className="ap-kpi">
                <span className="ap-kpi-label">Ventes totales</span>
                <p className="ap-kpi-value">{mockSales.length}</p>
              </div>
            </div>

            <h3 className="ap-section-title">Dernières ventes</h3>
            <div className="ap-table-wrap">
              <table className="ap-table">
                <thead><tr><th>Réf.</th><th>Client</th><th>Projet</th><th>Parcelle</th><th>Montant</th><th>Type</th><th>Date</th></tr></thead>
                <tbody>
                  {mockSales.slice(0, 5).map(s => (
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
            </div>
          </>
        )}

        {/* ── PROJETS ── */}
        {tab === 'projects' && (
          <>
            <div className="ap-page-header">
              <div>
                <h1 className="ap-page-title">Gestion des projets</h1>
                <p className="ap-page-sub">{projects.length} projet{projects.length !== 1 ? 's' : ''} · {totalParcels} parcelles</p>
              </div>
              <button type="button" className="ap-btn-primary" onClick={openNewProject}>
                + Nouveau projet
              </button>
            </div>

            <div className="ap-table-wrap">
              <table className="ap-table">
                <thead>
                  <tr>
                    <th>Projet</th><th>Ville</th><th>Superficie</th><th>Plantation</th>
                    <th>Parcelles</th><th>Disponibles</th><th>Vendues</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map(p => {
                    const sold = mockSales.filter(s => s.projectId === p.id).length
                    const isOpen = parcelPanel === p.id
                    return (
                      <>
                        <tr key={p.id}>
                          <td className="ap-bold">{p.title}</td>
                          <td>{p.city}{p.region ? `, ${p.region}` : ''}</td>
                          <td>{p.area}</td>
                          <td>{p.year}</td>
                          <td>{p.plots.length}</td>
                          <td className="ap-green">{p.plots.length - sold}</td>
                          <td>{sold}</td>
                          <td>
                            <div className="ap-row-actions">
                              <button type="button" className="ap-btn-row ap-btn-row--edit"
                                onClick={() => openEditProject(p)}>Éditer</button>
                              <button type="button" className="ap-btn-row ap-btn-row--parcels"
                                onClick={() => setParcelPanel(isOpen ? null : p.id)}>
                                {isOpen ? '▲ Parcelles' : `▼ Parcelles (${p.plots.length})`}
                              </button>
                              <button type="button" className="ap-btn-row ap-btn-row--del"
                                onClick={() => setDelConfirm({ type: 'project', id: p.id, label: p.title })}>Suppr.</button>
                            </div>
                          </td>
                        </tr>

                        {/* ── Inline parcel panel ── */}
                        {isOpen && (
                          <tr key={`${p.id}-parcels`} className="ap-parcel-row">
                            <td colSpan={8}>
                              <div className="ap-parcel-panel">
                                <div className="ap-parcel-panel-header">
                                  <span className="ap-parcel-panel-title">
                                    Parcelles de «{p.title}»
                                  </span>
                                  <button type="button" className="ap-btn-primary"
                                    style={{ padding: '0.35rem 0.9rem', fontSize: '12px' }}
                                    onClick={() => openNewParcel(p.id)}>
                                    + Ajouter une parcelle
                                  </button>
                                </div>

                                {p.plots.length === 0 ? (
                                  <p className="ap-empty" style={{ margin: '1rem 0 0.5rem' }}>Aucune parcelle pour ce projet.</p>
                                ) : (
                                  <table className="ap-table ap-table--nested">
                                    <thead>
                                      <tr>
                                        <th>N°</th><th>Arbres</th><th>Surface (m²)</th>
                                        <th>Prix/arbre</th><th>Prix total</th><th>Statut</th><th></th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {p.plots.map(pl => {
                                        const isSold = mockSales.some(s => s.projectId === p.id && s.plotId === pl.id)
                                        return (
                                          <tr key={pl.id}>
                                            <td className="ap-mono">#{pl.id}</td>
                                            <td>{pl.trees}</td>
                                            <td>{pl.area} m²</td>
                                            <td>{pl.pricePerTree?.toLocaleString()} DT</td>
                                            <td className="ap-bold">{pl.totalPrice?.toLocaleString()} DT</td>
                                            <td><Badge type={isSold ? 'sold' : 'available'} /></td>
                                            <td>
                                              <button type="button" className="ap-btn-row ap-btn-row--del"
                                                onClick={() => setDelPlotConfirm({ projectId: p.id, plotId: pl.id, label: `Parcelle #${pl.id}` })}>
                                                Suppr.
                                              </button>
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
              {projects.length === 0 && <p className="ap-empty">Aucun projet. Créez-en un avec le bouton ci-dessus.</p>}
            </div>
          </>
        )}

        {/* ── CLIENTS ── */}
        {tab === 'clients' && (
          <>
            <div className="ap-page-header">
              <div>
                <h1 className="ap-page-title">Gestion des clients</h1>
                <p className="ap-page-sub">{users.length} clients inscrits</p>
              </div>
              <div className="ap-search-wrap">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input className="ap-search" placeholder="Rechercher par nom, email, CIN…" value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            </div>
            <div className="ap-table-wrap">
              <table className="ap-table">
                <thead><tr><th>Nom</th><th>E-mail</th><th>Téléphone</th><th>CIN</th><th>Parcelles</th><th>Solde</th><th>Inscrit le</th><th>Actions</th></tr></thead>
                <tbody>
                  {filteredUsers.map(u => (
                    <tr key={u.id}>
                      <td className="ap-bold">{u.firstName} {u.lastName}</td>
                      <td className="ap-muted">{u.email}</td>
                      <td className="ap-muted">{u.phone}</td>
                      <td className="ap-mono">{u.cin}</td>
                      <td>{u.plots.length}</td>
                      <td className={u.balance > 0 ? 'ap-green' : 'ap-muted'}>{u.balance.toLocaleString()} DT</td>
                      <td className="ap-muted">{fmtDate(u.joined)}</td>
                      <td>
                        <div className="ap-row-actions">
                          <button type="button" className="ap-btn-row ap-btn-row--del"
                            onClick={() => setDelConfirm({ type: 'user', id: u.id, label: `${u.firstName} ${u.lastName}` })}>
                            Suppr.
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredUsers.length === 0 && <p className="ap-empty">Aucun client trouvé.</p>}
            </div>
          </>
        )}

        {/* ── VENTES ── */}
        {tab === 'sales' && (
          <>
            <div className="ap-page-header">
              <div>
                <h1 className="ap-page-title">Historique des ventes</h1>
                <p className="ap-page-sub">{mockSales.length} ventes · {totalRevenue.toLocaleString()} DT total</p>
              </div>
            </div>
            <div className="ap-table-wrap">
              <table className="ap-table">
                <thead><tr><th>Réf.</th><th>Client</th><th>Projet</th><th>Parcelle</th><th>Montant</th><th>Type</th><th>Date</th></tr></thead>
                <tbody>
                  {mockSales.map(s => (
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
            </div>
          </>
        )}

        {/* ── REÇUS ── */}
        {tab === 'receipts' && (
          <>
            <div className="ap-page-header">
              <div>
                <h1 className="ap-page-title">Gestion des reçus</h1>
                <p className="ap-page-sub">{pendingCount} reçu{pendingCount !== 1 ? 's' : ''} en attente</p>
              </div>
            </div>
            <div className="ap-receipt-list">
              {receipts.map(r => (
                <div key={r.id} className={`ap-receipt-card ap-receipt-card--${r.status}`}>
                  <div className="ap-receipt-top">
                    <div>
                      <p className="ap-receipt-ref">{r.id} · {r.projectTitle}</p>
                      <p className="ap-receipt-client">{r.userName} — Facilité {r.month} · {r.amount.toLocaleString()} DT</p>
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
                        <button type="button" className="ap-btn-approve" onClick={() => rejectReceipt(r.id, rejectNote)}>Confirmer le rejet</button>
                        <button type="button" className="ap-btn-ghost"   onClick={() => setRejectTarget(null)}>Annuler</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {receipts.length === 0 && <p className="ap-empty">Aucun reçu pour le moment.</p>}
            </div>
          </>
        )}
      </main>

      {/* ══════════════════════════════════════════════
          PROJECT FORM MODAL (create / edit)
      ══════════════════════════════════════════════ */}
      {projectModal && (
        <div className="ap-modal-overlay" onClick={() => setProjectModal(null)}>
          <div className="ap-form-modal" onClick={e => e.stopPropagation()}>
            <div className="ap-form-modal-header">
              <h3 className="ap-modal-title">
                {projectModal.mode === 'new' ? '+ Nouveau projet' : `Éditer — ${projectModal.title || '…'}`}
              </h3>
              <button type="button" className="ap-modal-close" onClick={() => setProjectModal(null)}>✕</button>
            </div>

            <form className="ap-form-modal-body" onSubmit={saveProject}>
              <div className="ap-form-grid-2">
                <div className="ap-form-group">
                  <label className="ap-form-label">Titre du projet *</label>
                  <input className="ap-form-input" placeholder="Projet Olivier — La Marsa" {...pf('title')} required />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Identifiant URL {projectModal.mode === 'new' && '(optionnel)'}</label>
                  <input className="ap-form-input" placeholder="ex: la-marsa (auto-généré si vide)" {...pf('id')} disabled={projectModal.mode === 'edit'} />
                  <span className="ap-form-hint">Lettres minuscules, tirets uniquement</span>
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Ville *</label>
                  <input className="ap-form-input" placeholder="Tunis" {...pf('city')} required />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Région / Délégation</label>
                  <input className="ap-form-input" placeholder="La Marsa" {...pf('region')} />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Superficie</label>
                  <input className="ap-form-input" placeholder="15 Ha" {...pf('area')} />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Année de plantation</label>
                  <input className="ap-form-input" type="number" placeholder="2023" {...pf('year')} min="1990" max="2099" />
                </div>
              </div>

              <div className="ap-form-divider">
                <span>Coordonnées GPS (pour la carte)</span>
              </div>
              <div className="ap-form-grid-2">
                <div className="ap-form-group">
                  <label className="ap-form-label">Latitude</label>
                  <input className="ap-form-input" type="number" step="0.0001" placeholder="36.8892" {...pf('lat')} />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Longitude</label>
                  <input className="ap-form-input" type="number" step="0.0001" placeholder="10.3241" {...pf('lng')} />
                </div>
              </div>
              {projectModal.mode === 'edit' && (
                <p className="ap-form-hint" style={{ marginTop: '-0.5rem' }}>
                  Laissez les coordonnées vides pour conserver la carte actuelle.
                </p>
              )}

              <div className="ap-form-modal-actions">
                <button type="submit" className="ap-btn-primary ap-btn-primary--full">
                  {projectModal.mode === 'new' ? 'Créer le projet' : 'Enregistrer les modifications'}
                </button>
                <button type="button" className="ap-btn-ghost" onClick={() => setProjectModal(null)}>Annuler</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          PARCEL FORM MODAL (add parcel to project)
      ══════════════════════════════════════════════ */}
      {parcelModal && (
        <div className="ap-modal-overlay" onClick={() => setParcelModal(null)}>
          <div className="ap-form-modal ap-form-modal--sm" onClick={e => e.stopPropagation()}>
            <div className="ap-form-modal-header">
              <h3 className="ap-modal-title">+ Nouvelle parcelle</h3>
              <button type="button" className="ap-modal-close" onClick={() => setParcelModal(null)}>✕</button>
            </div>
            <p className="ap-form-project-name">
              Projet : {projects.find(p => p.id === parcelModal.projectId)?.title}
            </p>

            <form className="ap-form-modal-body" onSubmit={savePlot}>
              <div className="ap-form-grid-2">
                <div className="ap-form-group">
                  <label className="ap-form-label">Nombre d&apos;arbres *</label>
                  <input className="ap-form-input" type="number" placeholder="48" {...pfc('trees')} required min="1" />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Surface (m²) *</label>
                  <input className="ap-form-input" type="number" placeholder="320" {...pfc('area')} required min="1" />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Prix par arbre (DT) *</label>
                  <input className="ap-form-input" type="number" placeholder="1500" {...pfc('pricePerTree')} required min="1" />
                </div>
                <div className="ap-form-group">
                  <label className="ap-form-label">Prix total estimé</label>
                  <div className="ap-form-input ap-form-input--readonly">
                    {(parseInt(parcelModal.trees || 0) * parseInt(parcelModal.pricePerTree || 0)).toLocaleString()} DT
                  </div>
                </div>
              </div>

              <div className="ap-form-modal-actions">
                <button type="submit" className="ap-btn-primary ap-btn-primary--full">Ajouter la parcelle</button>
                <button type="button" className="ap-btn-ghost" onClick={() => setParcelModal(null)}>Annuler</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete project / client confirmation ── */}
      {delConfirm && (
        <div className="ap-modal-overlay" onClick={() => setDelConfirm(null)}>
          <div className="ap-modal" onClick={e => e.stopPropagation()}>
            <h3 className="ap-modal-title">Confirmer la suppression</h3>
            <p className="ap-modal-body">
              Voulez-vous vraiment supprimer <strong>{delConfirm.label}</strong> ? Cette action est irréversible.
            </p>
            <div className="ap-modal-actions">
              <button type="button" className="ap-btn-reject"
                onClick={() => delConfirm.type === 'project' ? deleteProject(delConfirm.id) : deleteUser(delConfirm.id)}>
                Supprimer
              </button>
              <button type="button" className="ap-btn-ghost" onClick={() => setDelConfirm(null)}>Annuler</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete parcel confirmation ── */}
      {delPlotConfirm && (
        <div className="ap-modal-overlay" onClick={() => setDelPlotConfirm(null)}>
          <div className="ap-modal" onClick={e => e.stopPropagation()}>
            <h3 className="ap-modal-title">Supprimer la parcelle</h3>
            <p className="ap-modal-body">
              Voulez-vous vraiment supprimer <strong>{delPlotConfirm.label}</strong> ? Cette action est irréversible.
            </p>
            <div className="ap-modal-actions">
              <button type="button" className="ap-btn-reject" onClick={() => deletePlot(delPlotConfirm)}>Supprimer</button>
              <button type="button" className="ap-btn-ghost" onClick={() => setDelPlotConfirm(null)}>Annuler</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && <div className={`ap-toast${toast.ok ? '' : ' ap-toast--err'}`}>{toast.msg}</div>}
    </div>
  )
}
