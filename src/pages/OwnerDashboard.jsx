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
    submitted: ['badge--blue',   '⏳ En révision'],
    approved:  ['badge--green',  '✓ Approuvé'],
    rejected:  ['badge--red',    '✗ Rejeté'],
    cash:        ['badge--green',  'Comptant'],
    installment: ['badge--amber',  'Versements'],
    active:    ['badge--green',  'Actif'],
    late:      ['badge--red',    'En retard'],
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

export default function OwnerDashboard() {
  const navigate  = useNavigate()
  const [tab, setTab]         = useState('overview')
  const [receipts, setReceipts] = useState(mockReceipts)
  const [users,    setUsers]    = useState(mockUsers)
  const [search,   setSearch]   = useState('')
  const [rejectNote, setRejectNote]   = useState('')
  const [rejectTarget, setRejectTarget] = useState(null)
  const [projects, setProjects] = useState(allProjects)
  const [delConfirm, setDelConfirm] = useState(null) // { type, id }
  const [toast, setToast] = useState(null)

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  const totalParcels   = projects.reduce((s, p) => s + p.plots.length, 0)
  const totalRevenue   = mockSales.reduce((s, v) => s + v.amount, 0)
  const pendingCount   = receipts.filter(r => r.status === 'submitted').length

  /* ── Receipt actions ── */
  const approveReceipt = (id) => {
    setReceipts(prev => prev.map(r => r.id === id ? { ...r, status: 'approved' } : r))
    showToast('Reçu approuvé avec succès.')
  }
  const rejectReceipt = (id, note) => {
    setReceipts(prev => prev.map(r => r.id === id ? { ...r, status: 'rejected', rejectedNote: note } : r))
    setRejectTarget(null)
    setRejectNote('')
    showToast('Reçu rejeté.', false)
  }

  /* ── Delete project ── */
  const deleteProject = (id) => {
    setProjects(prev => prev.filter(p => p.id !== id))
    setDelConfirm(null)
    showToast('Projet supprimé.')
  }

  /* ── Delete client ── */
  const deleteUser = (id) => {
    setUsers(prev => prev.filter(u => u.id !== id))
    setDelConfirm(null)
    showToast('Client supprimé.')
  }

  const filteredUsers = useMemo(() =>
    users.filter(u =>
      !search ||
      `${u.firstName} ${u.lastName}`.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.cin.includes(search)
    ), [users, search])

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

        <button type="button" className="ap-back-btn" onClick={() => navigate('/')}>
          ← Quitter le panel
        </button>
      </aside>

      {/* ── Main content ── */}
      <main className="ap-main">

        {/* ── APERÇU ── */}
        {tab === 'overview' && (
          <>
            <div className="ap-page-header">
              <div><h1 className="ap-page-title">Vue d&apos;ensemble</h1><p className="ap-page-sub">Tableau de bord global de la plateforme</p></div>
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
              <div><h1 className="ap-page-title">Gestion des projets</h1><p className="ap-page-sub">{projects.length} projets · {totalParcels} parcelles au total</p></div>
              <button type="button" className="ap-btn-primary">+ Nouveau projet</button>
            </div>
            <div className="ap-table-wrap">
              <table className="ap-table">
                <thead><tr><th>Projet</th><th>Ville</th><th>Superficie</th><th>Parcelles</th><th>Disponibles</th><th>Vendues</th><th>Actions</th></tr></thead>
                <tbody>
                  {projects.map(p => {
                    const sold = mockSales.filter(s => s.projectId === p.id).length
                    return (
                      <tr key={p.id}>
                        <td className="ap-bold">{p.title}</td>
                        <td>{p.city}, {p.region}</td>
                        <td>{p.area}</td>
                        <td>{p.plots.length}</td>
                        <td className="ap-green">{p.plots.length - sold}</td>
                        <td>{sold}</td>
                        <td>
                          <div className="ap-row-actions">
                            <button type="button" className="ap-btn-row ap-btn-row--edit" onClick={() => navigate(`/project/${p.id}`)}>Voir</button>
                            <button type="button" className="ap-btn-row ap-btn-row--del"  onClick={() => setDelConfirm({ type: 'project', id: p.id, label: p.title })}>Suppr.</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── CLIENTS ── */}
        {tab === 'clients' && (
          <>
            <div className="ap-page-header">
              <div><h1 className="ap-page-title">Gestion des clients</h1><p className="ap-page-sub">{users.length} clients inscrits</p></div>
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
                          <button type="button" className="ap-btn-row ap-btn-row--del" onClick={() => setDelConfirm({ type: 'user', id: u.id, label: `${u.firstName} ${u.lastName}` })}>Suppr.</button>
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
              <div><h1 className="ap-page-title">Historique des ventes</h1><p className="ap-page-sub">{mockSales.length} ventes · {totalRevenue.toLocaleString()} DT total</p></div>
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
              <div><h1 className="ap-page-title">Gestion des reçus</h1><p className="ap-page-sub">{pendingCount} reçu{pendingCount !== 1 ? 's' : ''} en attente de révision</p></div>
            </div>
            <div className="ap-receipt-list">
              {receipts.map(r => (
                <div key={r.id} className={`ap-receipt-card ap-receipt-card--${r.status}`}>
                  <div className="ap-receipt-top">
                    <div>
                      <p className="ap-receipt-ref">{r.id} · {r.projectTitle}</p>
                      <p className="ap-receipt-client">{r.userName} — Versement {r.month} · {r.amount.toLocaleString()} DT</p>
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
                      <textarea className="ap-reject-note-input" placeholder="Motif du rejet (ex: reçu illisible)…" value={rejectNote} onChange={e => setRejectNote(e.target.value)} rows={2} />
                      <div className="ap-receipt-actions">
                        <button type="button" className="ap-btn-approve" onClick={() => rejectReceipt(r.id, rejectNote)}>Confirmer le rejet</button>
                        <button type="button" className="ap-btn-ghost" onClick={() => setRejectTarget(null)}>Annuler</button>
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

      {/* ── Delete confirmation modal ── */}
      {delConfirm && (
        <div className="ap-modal-overlay" onClick={() => setDelConfirm(null)}>
          <div className="ap-modal" onClick={e => e.stopPropagation()}>
            <h3 className="ap-modal-title">Confirmer la suppression</h3>
            <p className="ap-modal-body">Voulez-vous vraiment supprimer <strong>{delConfirm.label}</strong> ? Cette action est irréversible.</p>
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

      {/* ── Toast ── */}
      {toast && (
        <div className={`ap-toast${toast.ok ? '' : ' ap-toast--err'}`}>{toast.msg}</div>
      )}
    </div>
  )
}
