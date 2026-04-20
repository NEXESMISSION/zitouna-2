import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAdminUsers, useProjects, useClients, useWorkspaceAudit } from '../../lib/useSupabase.js'
import { useToast } from '../components/AdminToast.jsx'
import AdminModal from '../components/AdminModal.jsx'
import { supabase } from '../../lib/supabase.js'
import {
  assignSellerParcel,
  fetchSellerParcelAssignments,
  insertAdminUserRow,
  randomEntityCode,
  revokeSellerParcel,
} from '../../lib/db.js'
import { NAV_ITEMS } from '../adminNavConfig.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import { isClientSuspended } from '../../lib/adminAccess.js'
import { runSafeAction } from '../../lib/runSafeAction.js'
import { getPagerPages } from './pager-util.js'
import './sell-field.css'
import './user-management.css'

const PAGE_OPTIONS = NAV_ITEMS
  .filter((n) => n.to !== '/admin/profile')
  .map((n) => ({ key: n.to, label: n.label }))

const USERS_PER_PAGE = 15

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'U'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso)
  }
}

export default function UserManagementPage() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const { adminUser, setStaffSession } = useAuth()
  const { adminUsers: users, loading, upsert, remove, refresh } = useAdminUsers()
  const { clients, upsert: upsertClient } = useClients()
  const { audit, append: appendAudit } = useWorkspaceAudit()
  const { projects } = useProjects()

  const [mainTab, setMainTab] = useState('staff')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const [drawer, setDrawer] = useState(null) // null | 'create' | 'edit'
  const [confirmModal, setConfirmModal] = useState(null)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [formStep, setFormStep] = useState('identity')

  const [clientModal, setClientModal] = useState(null)
  const [clientPagesForm, setClientPagesForm] = useState([])
  const [clientProjectsForm, setClientProjectsForm] = useState([])
  const [clientIdentityForm, setClientIdentityForm] = useState({ name: '', phone: '', cin: '', email: '' })
  const [clientAssignments, setClientAssignments] = useState([])
  const [clientAssignmentsLoading, setClientAssignmentsLoading] = useState(false)
  const [clientSaving, setClientSaving] = useState(false)

  const allPageKeys = useMemo(() => PAGE_OPTIONS.map((p) => p.key), [])
  const allProjectIds = useMemo(() => (projects || []).map((p) => p.id), [projects])
  const allParcelKeys = useMemo(
    () =>
      (projects || []).flatMap((p) =>
        (p.plots || []).map((plot) => ({
          key: `${p.id}:${plot.id}`,
          projectId: p.id,
          projectTitle: p.title,
          label: `#${plot.id}`,
        })),
      ),
    [projects],
  )
  const allParcelKeyValues = useMemo(() => allParcelKeys.map((it) => it.key), [allParcelKeys])

  const filteredStaff = useMemo(() => {
    const q = search.toLowerCase()
    return users.filter((u) => !q || u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q))
  }, [users, search])

  const filteredClients = useMemo(() => {
    const q = search.toLowerCase()
    return (clients || []).filter(
      (c) =>
        !q ||
        c.name?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        (c.phone && c.phone.toLowerCase().includes(q)),
    )
  }, [clients, search])

  const activeList = mainTab === 'staff' ? filteredStaff : filteredClients

  const stats = useMemo(() => {
    if (mainTab === 'staff') {
      const suspendedN = users.filter((u) => u.status === 'suspended' || u.suspendedAt).length
      const limitedPages = users.filter((u) => Array.isArray(u.allowedPages)).length
      return { total: users.length, suspended: suspendedN, scoped: limitedPages }
    }
    const list = clients || []
    const suspendedN = list.filter((c) => isClientSuspended(c)).length
    const limitedPages = list.filter((c) => Array.isArray(c.allowedPages) && c.allowedPages.length > 0).length
    return { total: list.length, suspended: suspendedN, scoped: limitedPages }
  }, [users, clients, mainTab])

  const pageCount = Math.max(1, Math.ceil(activeList.length / USERS_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pagedList = useMemo(
    () => activeList.slice((safePage - 1) * USERS_PER_PAGE, safePage * USERS_PER_PAGE),
    [activeList, safePage],
  )

  const onSearchChange = (e) => { setSearch(e.target.value); setPage(1) }
  const onTabChange = (tab) => { setMainTab(tab); setPage(1); setSearch('') }

  const clientAudit = useMemo(() => {
    if (!clientModal) return []
    const id = String(clientModal.id)
    return (audit || [])
      .filter(
        (a) =>
          String(a.subjectUserId || '') === id ||
          (a.entity === 'client' && String(a.entityId) === id),
      )
      .slice(0, 40)
  }, [audit, clientModal])

  const staffAudit = useMemo(() => {
    if (drawer !== 'edit' || !form?.id) return []
    const id = String(form.dbId || form.id)
    return (audit || [])
      .filter(
        (a) =>
          String(a.subjectUserId || '') === id ||
          (a.entity === 'admin_user' && String(a.entityId) === id),
      )
      .slice(0, 40)
  }, [audit, drawer, form?.id, form?.dbId])

  const openCreate = () => {
    setForm({
      name: '',
      email: '',
      phone: '',
      cin: '',
      password: '',
      allowedPages: [],
      allowedProjectIds: null,
      allowedParcelKeys: null,
    })
    setFormStep('identity')
    setDrawer('create')
  }

  const openEdit = (user) => {
    setForm({
      ...user,
      password: '',
      allowedPages: user.allowedPages || null,
      allowedProjectIds: user.allowedProjectIds || null,
      allowedParcelKeys: user.allowedParcelKeys || null,
    })
    setFormStep('identity')
    setDrawer('edit')
  }

  const openClientManage = (c) => {
    setClientModal(c)
    setClientPagesForm(Array.isArray(c.allowedPages) ? [...c.allowedPages] : allPageKeys)
    setClientProjectsForm(Array.isArray(c.allowedProjectIds) ? [...c.allowedProjectIds] : allProjectIds)
    setClientIdentityForm({
      name: c.name || '',
      phone: c.phone || '',
      cin: c.cin || '',
      email: c.email || '',
    })
    ;(async () => {
      setClientAssignmentsLoading(true)
      try {
        const rows = await fetchSellerParcelAssignments(c.id)
        setClientAssignments(Array.isArray(rows) ? rows : [])
      } catch (e) {
        console.error('fetchSellerParcelAssignments failed:', e)
        setClientAssignments([])
      } finally {
        setClientAssignmentsLoading(false)
      }
    })()
  }

  const toggleClientPageKey = useCallback((pageKey) => {
    setClientPagesForm((prev) => {
      const next = new Set(prev)
      if (next.has(pageKey)) next.delete(pageKey)
      else next.add(pageKey)
      return [...next]
    })
  }, [])

  const toggleClientProject = useCallback((projectId) => {
    setClientProjectsForm((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return [...next]
    })
  }, [])

  const handleSaveClientAccess = useCallback(async () => {
    if (!clientModal) return
    await runSafeAction(
      { setBusy: setClientSaving, onError: (m) => addToast(m, 'error'), label: 'Mise à jour accès client' },
      async () => {
        const prev = new Set(clientModal.allowedPages || [])
        const nextArr = [...new Set(clientPagesForm)]
        const nextPages = new Set(nextArr)
        for (const p of nextPages) {
          if (!prev.has(p)) {
            await appendAudit({
              action: 'page_access_granted',
              entity: 'client',
              entityId: String(clientModal.id),
              subjectUserId: String(clientModal.id),
              actorUserId: adminUser?.id || null,
              actorEmail: adminUser?.email || '',
              details: `Grant ${p} (manual)`,
              metadata: { pageKey: p, source: 'manual_promotion' },
            })
          }
        }

        const prevProjects = new Set(clientModal.allowedProjectIds || [])
        const nextProjectArr = [...new Set(clientProjectsForm)]
        const nextProjects = new Set(nextProjectArr)
        for (const prId of nextProjects) {
          if (!prevProjects.has(prId)) {
            await appendAudit({
              action: 'project_access_granted',
              entity: 'client',
              entityId: String(clientModal.id),
              subjectUserId: String(clientModal.id),
              actorUserId: adminUser?.id || null,
              actorEmail: adminUser?.email || '',
              details: `Grant project ${prId} (manual)`,
              metadata: { projectId: prId, source: 'manual_promotion' },
            })
          }
        }

        await upsertClient({
          ...clientModal,
          name: clientIdentityForm.name,
          phone: clientIdentityForm.phone || '',
          cin: clientIdentityForm.cin || '',
          allowedPages: nextArr.length ? nextArr : null,
          allowedProjectIds: nextProjectArr.length ? nextProjectArr : null,
        })

        const nextProjectSet = new Set(nextProjectArr.map((x) => String(x)))
        const toRevoke = (clientAssignments || []).filter(
          (a) => a?.projectId && !nextProjectSet.has(String(a.projectId)),
        )
        for (const a of toRevoke) {
          await revokeSellerParcel({
            clientId: clientModal.id,
            parcelId: a.parcelId,
            reason: 'Project access removed',
          })
        }

        addToast('Accès client mis à jour')
        setClientModal(null)
      },
    )
  }, [
    clientModal,
    clientPagesForm,
    clientProjectsForm,
    clientAssignments,
    clientIdentityForm.name,
    clientIdentityForm.phone,
    clientIdentityForm.cin,
    upsertClient,
    addToast,
    adminUser?.id,
    adminUser?.email,
    appendAudit,
  ])

  const handleClientSuspend = useCallback(async () => {
    if (!clientModal) return
    if (!window.confirm(`Suspendre ${clientModal.name || 'ce client'} ? Il ne pourra plus se connecter.`)) return
    await runSafeAction(
      { setBusy: setClientSaving, onError: (m) => addToast(m, 'error'), label: 'Suspension client' },
      async () => {
        await upsertClient({
          ...clientModal,
          status: 'suspended',
          suspendedAt: new Date().toISOString(),
          suspendedBy: adminUser?.id || null,
          suspendedReason: 'Suspended from User management',
        })
        await appendAudit({
          action: 'client_suspended',
          entity: 'client',
          entityId: String(clientModal.id),
          subjectUserId: String(clientModal.id),
          actorUserId: adminUser?.id || null,
          actorEmail: adminUser?.email || '',
          details: 'Suspended',
        })
        addToast('Client suspendu')
        setClientModal(null)
      },
    )
  }, [clientModal, upsertClient, addToast, adminUser?.id, adminUser?.email, appendAudit])

  const handleClientReactivate = useCallback(async () => {
    if (!clientModal) return
    await runSafeAction(
      { setBusy: setClientSaving, onError: (m) => addToast(m, 'error'), label: 'Réactivation client' },
      async () => {
        await upsertClient({
          ...clientModal,
          status: 'active',
          suspendedAt: null,
          suspendedBy: null,
          suspendedReason: null,
        })
        await appendAudit({
          action: 'client_reactivated',
          entity: 'client',
          entityId: String(clientModal.id),
          subjectUserId: String(clientModal.id),
          actorUserId: adminUser?.id || null,
          actorEmail: adminUser?.email || '',
          details: 'Reactivated',
        })
        addToast('Client réactivé')
        setClientModal(null)
      },
    )
  }, [clientModal, upsertClient, addToast, adminUser?.id, adminUser?.email, appendAudit])

  const handleStaffSuspendToggle = useCallback(async () => {
    if (drawer !== 'edit' || !form.id) return
    const rowId = form.dbId || form.id
    const susp = form.status === 'suspended' || form.suspendedAt
    if (!susp && !window.confirm(`Suspendre ${form.name || 'ce staff'} ? Il ne pourra plus se connecter.`)) return
    const patch = susp
      ? { status: 'active', suspendedAt: null, suspendedBy: null, suspensionReason: null }
      : { status: 'suspended', suspendedAt: new Date().toISOString(), suspendedBy: adminUser?.id || null, suspensionReason: 'Suspended from User management' }
    await runSafeAction(
      { setBusy: setSaving, onError: (m) => addToast(m, 'error'), label: susp ? 'Réactivation staff' : 'Suspension staff' },
      async () => {
        await upsert({ ...form, id: rowId, dbId: rowId, ...patch })
        await appendAudit({
          action: susp ? 'staff_reactivated' : 'staff_suspended',
          entity: 'admin_user',
          entityId: String(rowId),
          subjectUserId: String(rowId),
          actorUserId: adminUser?.id || null,
          actorEmail: adminUser?.email || '',
          details: susp ? 'Reactivated' : 'Suspended',
        })
        setForm((f) => ({ ...f, ...patch }))
        addToast(susp ? 'Staff réactivé' : 'Staff suspendu')
        if (String(rowId) === String(adminUser?.dbId || adminUser?.id)) {
          setStaffSession(patch)
        }
      },
    )
  }, [drawer, form, upsert, addToast, adminUser, setStaffSession, appendAudit])

  const togglePage = useCallback((pageKey) => {
    setForm((f) => {
      const current = Array.isArray(f.allowedPages) ? f.allowedPages : [...allPageKeys]
      const next = current.includes(pageKey)
        ? current.filter((k) => k !== pageKey)
        : [...current, pageKey]
      return { ...f, allowedPages: next }
    })
  }, [allPageKeys])

  const toggleProject = useCallback((projectId) => {
    setForm((f) => {
      const current = Array.isArray(f.allowedProjectIds) ? f.allowedProjectIds : [...allProjectIds]
      const next = current.includes(projectId)
        ? current.filter((k) => k !== projectId)
        : [...current, projectId]
      const allowedProjectSet = new Set(next)
      const currentPieces = Array.isArray(f.allowedParcelKeys) ? f.allowedParcelKeys : [...allParcelKeyValues]
      const cleanedPieces = currentPieces.filter((k) => allowedProjectSet.has(String(k).split(':')[0]))
      return {
        ...f,
        allowedProjectIds: next,
        allowedParcelKeys: cleanedPieces,
      }
    })
  }, [allProjectIds, allParcelKeyValues])

  const togglePiece = useCallback((pieceKey) => {
    setForm((f) => {
      const current = Array.isArray(f.allowedParcelKeys) ? f.allowedParcelKeys : [...allParcelKeyValues]
      const next = current.includes(pieceKey)
        ? current.filter((k) => k !== pieceKey)
        : [...current, pieceKey]
      return { ...f, allowedParcelKeys: next }
    })
  }, [allParcelKeyValues])

  const handleSave = useCallback(async () => {
    if (!form.name?.trim() || !form.email?.trim()) {
      addToast('Nom et e-mail obligatoires', 'error')
      return
    }

    if (drawer === 'create') {
      if (!form.password || form.password.length < 6) {
        addToast('Mot de passe requis (min. 6 caractères)', 'error')
        return
      }
      await runSafeAction(
        { setBusy: setSaving, onError: (m) => addToast(m, 'error'), label: 'Création utilisateur' },
        async () => {
          const email = form.email.trim().toLowerCase()
          const nameParts = form.name.trim().split(/\s+/)
          const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password: form.password,
            options: {
              data: {
                firstname: nameParts[0] || '',
                lastname: nameParts.slice(1).join(' ') || '',
                name: form.name.trim(),
                phone: form.phone || '',
                cin: form.cin || '',
              },
            },
          })
          if (authError) {
            throw new Error(authError.message)
          }
          if (authData.user?.identities?.length === 0) {
            throw new Error('E-mail déjà utilisé')
          }

          await insertAdminUserRow({
            code: randomEntityCode('USR'),
            full_name: form.name.trim(),
            email,
            phone: form.phone || null,
            role: 'STAFF',
            status: 'active',
            allowed_pages: form.allowedPages,
            allowed_project_ids: form.allowedProjectIds,
          })

          await upsert({
            id: authData.user?.id || `u-${Date.now()}`,
            dbId: authData.user?.id || `u-${Date.now()}`,
            name: form.name.trim(),
            email,
            phone: form.phone || '',
            role: 'Staff',
            status: 'active',
            accountType: 'staff',
            allowedPages: form.allowedPages,
            allowedProjectIds: form.allowedProjectIds,
            allowedParcelKeys: form.allowedParcelKeys,
          })
          await refresh({ force: true })
          addToast('Utilisateur créé')
          setDrawer(null)
        },
      )
      return
    }

    await runSafeAction(
      { setBusy: setSaving, onError: (m) => addToast(m, 'error'), label: 'Enregistrement utilisateur' },
      async () => {
        const email = form.email.trim().toLowerCase()
        const rowId = form.dbId || form.id
        const saved = {
          ...form,
          id: rowId,
          dbId: rowId,
          name: form.name.trim(),
          email,
          phone: form.phone || '',
          allowedPages: form.allowedPages,
          allowedProjectIds: form.allowedProjectIds,
          allowedParcelKeys: form.allowedParcelKeys,
        }
        await upsert(saved)
        const prev = users.find((u) => String(u.dbId || u.id) === String(rowId))
        if (prev) {
          const changed =
            JSON.stringify(prev.allowedPages ?? null) !== JSON.stringify(saved.allowedPages ?? null) ||
            JSON.stringify(prev.allowedProjectIds ?? null) !== JSON.stringify(saved.allowedProjectIds ?? null) ||
            JSON.stringify(prev.allowedParcelKeys ?? null) !== JSON.stringify(saved.allowedParcelKeys ?? null)
          if (changed) {
            await appendAudit({
              action: 'staff_access_updated',
              entity: 'admin_user',
              entityId: String(rowId),
              subjectUserId: String(rowId),
              actorUserId: adminUser?.id || null,
              actorEmail: adminUser?.email || '',
              details: 'Scopes pages / projets / parcelles mis à jour',
              metadata: {
                before: {
                  allowedPages: prev.allowedPages,
                  allowedProjectIds: prev.allowedProjectIds,
                  allowedParcelKeys: prev.allowedParcelKeys,
                },
                after: {
                  allowedPages: saved.allowedPages,
                  allowedProjectIds: saved.allowedProjectIds,
                  allowedParcelKeys: saved.allowedParcelKeys,
                },
              },
            })
          }
        }
        if (String(rowId) === String(adminUser?.dbId || adminUser?.id)) {
          setStaffSession({
            name: saved.name,
            email: saved.email,
            phone: saved.phone,
            allowedPages: saved.allowedPages,
            allowedProjectIds: saved.allowedProjectIds,
            allowedParcelKeys: saved.allowedParcelKeys,
          })
        }
        addToast('Utilisateur mis à jour')
        setDrawer(null)
      },
    )
  }, [drawer, form, upsert, addToast, refresh, adminUser, setStaffSession, users, appendAudit])

  const handleDelete = useCallback(async () => {
    await runSafeAction(
      { setBusy: setSaving, onError: (m) => addToast(m, 'error'), label: 'Suppression utilisateur' },
      async () => {
        const rowId = confirmModal.dbId || confirmModal.id
        if (rowId) await remove(rowId)
        addToast(`${confirmModal.name || 'Utilisateur'} supprimé`)
        setConfirmModal(null)
        setDrawer(null)
      },
    )
  }, [confirmModal, remove, addToast])

  const pageMode = form.allowedPages === null ? 'all' : 'custom'
  const projectMode = form.allowedProjectIds === null ? 'all' : 'custom'
  const pieceMode = form.allowedParcelKeys === null ? 'all' : 'custom'

  const formPages = Array.isArray(form.allowedPages) ? form.allowedPages : allPageKeys
  const formProjects = Array.isArray(form.allowedProjectIds) ? form.allowedProjectIds : allProjectIds
  const scopedProjectSet = useMemo(() => new Set(formProjects), [formProjects])
  const pieceOptions = useMemo(
    () => allParcelKeys.filter((it) => scopedProjectSet.has(it.projectId)),
    [allParcelKeys, scopedProjectSet],
  )
  const allVisiblePieceKeys = pieceOptions.map((it) => it.key)
  const formPieces = Array.isArray(form.allowedParcelKeys) ? form.allowedParcelKeys : allVisiblePieceKeys
  const groupedPieceOptions = useMemo(
    () =>
      (projects || [])
        .filter((p) => scopedProjectSet.has(p.id))
        .map((p) => ({
          projectId: p.id,
          projectTitle: p.title,
          items: pieceOptions.filter((it) => it.projectId === p.id),
        }))
        .filter((g) => g.items.length > 0),
    [projects, scopedProjectSet, pieceOptions],
  )

  // Client access controls: projects + parcel assignments (pieces access).
  const clientProjectsSet = useMemo(() => new Set(clientProjectsForm), [clientProjectsForm])

  const clientAssignedPieceKeySet = useMemo(() => {
    const set = new Set()
    for (const a of clientAssignments || []) {
      if (!a) continue
      if (a.projectId == null || a.parcelId == null) continue
      set.add(`${a.projectId}:${a.parcelId}`)
    }
    return set
  }, [clientAssignments])

  const clientScopedPieceOptions = useMemo(
    () => allParcelKeys.filter((it) => clientProjectsSet.has(it.projectId)),
    [allParcelKeys, clientProjectsSet],
  )

  const groupedClientPieceOptions = useMemo(
    () =>
      (projects || [])
        .filter((p) => clientProjectsSet.has(p.id))
        .map((p) => ({
          projectId: p.id,
          projectTitle: p.title,
          items: clientScopedPieceOptions.filter((it) => it.projectId === p.id),
        }))
        .filter((g) => g.items.length > 0),
    [projects, clientProjectsSet, clientScopedPieceOptions],
  )

  const toggleClientPiece = useCallback(
    async (pieceKey) => {
      if (!clientModal) return
      const [projectId, parcelIdStr] = String(pieceKey).split(':')
      const parcelId = Number(parcelIdStr)
      if (!projectId || !Number.isFinite(parcelId)) return

      const assigned = clientAssignedPieceKeySet.has(String(pieceKey))

      await runSafeAction(
        { setBusy: setClientAssignmentsLoading, onError: (m) => addToast(m, 'error'), label: 'Mise à jour parcelles' },
        async () => {
          if (assigned) {
            await revokeSellerParcel({ clientId: clientModal.id, parcelId, reason: 'Pieces access removed' })
          } else {
            await assignSellerParcel({ clientId: clientModal.id, projectId, parcelId, note: '' })
          }

          const rows = await fetchSellerParcelAssignments(clientModal.id)
          setClientAssignments(Array.isArray(rows) ? rows : [])
          addToast(assigned ? 'Accès parcelle révoqué' : 'Accès parcelle accordé')
        },
      )
    },
    [clientModal, clientAssignedPieceKeySet, addToast],
  )

  const steps = ['identity', 'pages', 'projects', 'pieces']
  const stepLabels = {
    identity: 'Identité',
    pages: 'Pages',
    projects: 'Projets',
    pieces: 'Parcelles',
  }
  const stepIndex = steps.indexOf(formStep)
  const canGoNext = formStep !== 'identity' || (form.name?.trim() && form.email?.trim())

  const showSkeletons = loading && activeList.length === 0

  // ───────────────────────── render ─────────────────────────
  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero">
        <div className="sp-hero__avatar" aria-hidden>
          <span>👥</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Utilisateurs et permissions</h1>
          <p className="sp-hero__role">Staff, clients, pages, projets et parcelles</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : stats.total}
          </span>
          <span className="sp-hero__kpi-label">{mainTab === 'staff' ? 'staff' : 'client(s)'}</span>
        </div>
      </header>

      <div className="um-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mainTab === 'staff'}
          className={`um-tab ${mainTab === 'staff' ? 'um-tab--on' : ''}`}
          onClick={() => onTabChange('staff')}
        >
          Staff · {users.length}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mainTab === 'clients'}
          className={`um-tab ${mainTab === 'clients' ? 'um-tab--on' : ''}`}
          onClick={() => onTabChange('clients')}
        >
          Clients · {(clients || []).length}
        </button>
      </div>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{showSkeletons ? <span className="sk-num" /> : stats.total}</strong> total
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : stats.scoped}</strong> avec accès limité
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : stats.suspended}</strong> suspendu{stats.suspended > 1 ? 's' : ''}
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder={mainTab === 'staff'
              ? 'Rechercher un staff par nom ou e-mail…'
              : 'Rechercher un client par nom, e-mail, téléphone…'}
            value={search}
            onChange={onSearchChange}
            aria-label="Rechercher un utilisateur"
          />
          {mainTab === 'staff' ? (
            <button type="button" className="um-hero-cta" onClick={openCreate}>
              + Nouvel utilisateur
            </button>
          ) : null}
        </div>
      </div>

      <div className="sp-cards">
        {showSkeletons ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={`sk-${i}`} className="sp-card sp-card--skeleton" aria-hidden>
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials sk-box" />
                  <div style={{ flex: 1 }}>
                    <p className="sk-line sk-line--title" />
                    <p className="sk-line sk-line--sub" />
                  </div>
                </div>
                <span className="sk-line sk-line--badge" />
              </div>
              <div className="sp-card__body">
                <span className="sk-line sk-line--info" />
                <span className="sk-line sk-line--info" />
              </div>
            </div>
          ))
        ) : activeList.length === 0 ? (
          <div className="sp-empty">
            <span className="sp-empty__emoji" aria-hidden>👤</span>
            <div className="sp-empty__title">
              {search
                ? 'Aucun résultat.'
                : mainTab === 'staff'
                  ? 'Aucun membre staff.'
                  : 'Aucun client.'}
            </div>
          </div>
        ) : mainTab === 'staff' ? (
          pagedList.map((u) => {
            const suspended = u.status === 'suspended' || Boolean(u.suspendedAt)
            const isSuper = u.role === 'Super Admin' || u.role === 'SUPER_ADMIN'
            const tone = suspended ? 'gray' : isSuper ? 'orange' : 'blue'
            const badgeTone = suspended ? 'red' : isSuper ? 'orange' : 'blue'
            const badgeLabel = suspended ? 'Suspendu' : isSuper ? 'Super Admin' : 'Staff'
            const pagesLabel = Array.isArray(u.allowedPages) ? `${u.allowedPages.length} pages` : 'Toutes pages'
            const projLabel = Array.isArray(u.allowedProjectIds) ? `${u.allowedProjectIds.length} projets` : 'Tous projets'
            return (
              <button
                key={u.id}
                type="button"
                className={`sp-card sp-card--${tone}`}
                onClick={() => openEdit(u)}
                aria-label={`Modifier ${u.name || 'utilisateur'}`}
              >
                <div className="sp-card__head">
                  <div className="sp-card__user">
                    <span className="sp-card__initials">{initials(u.name)}</span>
                    <div style={{ minWidth: 0 }}>
                      <p className="sp-card__name">{u.name || 'Sans nom'}</p>
                      <p className="sp-card__sub">{u.email || '—'}</p>
                    </div>
                  </div>
                  <span className={`sp-badge sp-badge--${badgeTone}`}>{badgeLabel}</span>
                </div>
                <div className="sp-card__body">
                  <div className="sp-card__info">
                    <span>{pagesLabel}</span>
                    <span>·</span>
                    <span>{projLabel}</span>
                  </div>
                </div>
              </button>
            )
          })
        ) : (
          pagedList.map((c) => {
            const suspended = isClientSuspended(c)
            const pagesN = Array.isArray(c.allowedPages) ? c.allowedPages.length : 0
            const selfReg = String(c.id).startsWith('c-reg-')
            const tone = suspended ? 'gray' : 'green'
            const badgeTone = suspended ? 'red' : 'green'
            const badgeLabel = suspended ? 'Suspendu' : 'Client'
            return (
              <div
                key={c.id}
                className={`sp-card sp-card--${tone}`}
                role="group"
                aria-label={`Client ${c.name || ''}`}
              >
                <div className="sp-card__head">
                  <div className="sp-card__user">
                    <span className="sp-card__initials">{initials(c.name)}</span>
                    <div style={{ minWidth: 0 }}>
                      <p className="sp-card__name">{c.name || 'Sans nom'}</p>
                      <p className="sp-card__sub">
                        {c.email || '—'}{c.phone ? ` · ${c.phone}` : ''}
                      </p>
                    </div>
                  </div>
                  <span className={`sp-badge sp-badge--${badgeTone}`}>{badgeLabel}</span>
                </div>
                <div className="sp-card__body">
                  <div className="sp-card__info">
                    <span>{pagesN ? `${pagesN} page(s) admin` : 'Aucune page admin'}</span>
                    {selfReg ? <span className="sp-badge sp-badge--blue" style={{ fontSize: 9 }}>Auto-inscrit</span> : null}
                  </div>
                  <div className="um-card__side-actions">
                    <button
                      type="button"
                      className="um-mini-btn"
                      onClick={() => navigate(`/admin/clients/${c.id}`)}
                    >
                      Profil
                    </button>
                    <button
                      type="button"
                      className="um-mini-btn um-mini-btn--primary"
                      onClick={() => openClientManage(c)}
                    >
                      Accès
                    </button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {!showSkeletons && activeList.length > USERS_PER_PAGE && (
        <div className="sp-pager" role="navigation" aria-label="Pagination">
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage <= 1}
            onClick={() => setPage(Math.max(1, safePage - 1))}
            aria-label="Page précédente"
          >
            ‹
          </button>
          {getPagerPages(safePage, pageCount).map((p, i) =>
            p === '…' ? (
              <span key={`dots-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
            ) : (
              <button
                key={p}
                type="button"
                className={`sp-pager__btn${p === safePage ? ' sp-pager__btn--active' : ''}`}
                onClick={() => setPage(p)}
                aria-current={p === safePage ? 'page' : undefined}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage >= pageCount}
            onClick={() => setPage(Math.min(pageCount, safePage + 1))}
            aria-label="Page suivante"
          >
            ›
          </button>
          <span className="sp-pager__info">
            {(safePage - 1) * USERS_PER_PAGE + 1}–{Math.min(safePage * USERS_PER_PAGE, activeList.length)} / {activeList.length}
          </span>
        </div>
      )}

      {/* ─────── STAFF CREATE / EDIT MODAL ─────── */}
      {drawer && (
        <AdminModal open onClose={() => setDrawer(null)} title="" width={760}>
          <div className="sp-detail">
            <div className="sp-detail__banner">
              <div className="sp-detail__banner-top">
                <span className="sp-badge sp-badge--blue">
                  {drawer === 'create' ? 'Nouveau staff' : 'Modification staff'}
                </span>
                {drawer === 'edit' && (form.status === 'suspended' || form.suspendedAt) ? (
                  <span className="sp-badge sp-badge--red">Suspendu</span>
                ) : null}
              </div>
              <div className="sp-detail__price">
                <span className="sp-detail__price-num">{form.name || 'Sans nom'}</span>
              </div>
              <p className="sp-detail__banner-sub">
                {form.email || 'Aucun e-mail'}
              </p>
            </div>

            <div className="um-steps" role="tablist" aria-label="Étapes">
              {steps.map((s, idx) => {
                const isOn = formStep === s
                const isDone = stepIndex > idx
                return (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-selected={isOn}
                    className={`um-step ${isOn ? 'um-step--on' : ''} ${isDone ? 'um-step--done' : ''}`}
                    onClick={() => setFormStep(s)}
                  >
                    <span className="um-step__num">{isDone ? '✓' : idx + 1}</span>
                    <span>{stepLabels[s]}</span>
                  </button>
                )
              })}
            </div>

            {formStep === 'identity' && (
              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Identité</div>
                <div className="um-form">
                  <div className="um-field">
                    <label className="um-label">Nom complet *</label>
                    <input
                      className="um-input"
                      value={form.name || ''}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="Ex : Sami Bouaziz"
                    />
                  </div>
                  <div className="um-field">
                    <label className="um-label">E-mail *</label>
                    <input
                      className="um-input"
                      type="email"
                      value={form.email || ''}
                      onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                      placeholder="sami@zitouna.tn"
                      disabled={drawer === 'edit'}
                    />
                    {drawer === 'edit' ? (
                      <div className="um-field__hint">L’e-mail ne peut pas être modifié.</div>
                    ) : null}
                  </div>
                  <div className="um-field">
                    <label className="um-label">Téléphone</label>
                    <input
                      className="um-input"
                      value={form.phone || ''}
                      onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                      placeholder="+216 71 000 000"
                    />
                  </div>
                  <div className="um-field">
                    <label className="um-label">CIN</label>
                    <input
                      className="um-input"
                      value={form.cin || ''}
                      onChange={(e) => setForm((f) => ({ ...f, cin: e.target.value }))}
                      placeholder="8 chiffres"
                      maxLength={8}
                    />
                  </div>
                  {drawer === 'create' && (
                    <div className="um-field um-form--full">
                      <label className="um-label">Mot de passe *</label>
                      <input
                        className="um-input"
                        type="password"
                        value={form.password || ''}
                        onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                        placeholder="Minimum 6 caractères"
                        autoComplete="new-password"
                      />
                      <div className="um-field__hint">L’utilisateur pourra le changer après sa première connexion.</div>
                    </div>
                  )}
                </div>
                {drawer === 'edit' && (
                  <div className="um-danger-zone">
                    <div className="um-danger-zone__text">
                      <b>Suspension :</b> bloque temporairement la connexion sans supprimer le compte.
                    </div>
                    <button
                      type="button"
                      className="um-btn um-btn--danger"
                      disabled={saving || form.status === 'suspended' || Boolean(form.suspendedAt)}
                      onClick={handleStaffSuspendToggle}
                    >
                      Suspendre
                    </button>
                    <button
                      type="button"
                      className="um-btn um-btn--primary"
                      disabled={saving || (form.status !== 'suspended' && !form.suspendedAt)}
                      onClick={handleStaffSuspendToggle}
                    >
                      Réactiver
                    </button>
                  </div>
                )}
              </div>
            )}

            {formStep === 'pages' && (
              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Pages accessibles</div>
                <div className="um-mode" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={pageMode === 'all'}
                    className={`um-mode__btn ${pageMode === 'all' ? 'um-mode__btn--on' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, allowedPages: null }))}
                  >
                    Toutes
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={pageMode === 'custom'}
                    className={`um-mode__btn ${pageMode === 'custom' ? 'um-mode__btn--on' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, allowedPages: Array.isArray(f.allowedPages) ? f.allowedPages : [] }))}
                  >
                    Personnalisé
                  </button>
                </div>
                {pageMode === 'custom' ? (
                  <>
                    <div className="um-hint">
                      {formPages.length} page(s) sélectionnée(s) sur {allPageKeys.length}.
                    </div>
                    <div className="um-chips">
                      {PAGE_OPTIONS.map((p) => {
                        const on = formPages.includes(p.key)
                        return (
                          <button
                            key={p.key}
                            type="button"
                            className={`um-chip ${on ? 'um-chip--on' : ''}`}
                            onClick={() => togglePage(p.key)}
                          >
                            {on ? '✓ ' : ''}{p.label}
                          </button>
                        )
                      })}
                    </div>
                  </>
                ) : (
                  <div className="um-note">
                    ✓ Accès complet : les {allPageKeys.length} pages sont autorisées.
                  </div>
                )}
              </div>
            )}

            {formStep === 'projects' && (
              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Projets visibles</div>
                <div className="um-mode" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={projectMode === 'all'}
                    className={`um-mode__btn ${projectMode === 'all' ? 'um-mode__btn--on' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, allowedProjectIds: null, allowedParcelKeys: null }))}
                  >
                    Tous
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={projectMode === 'custom'}
                    className={`um-mode__btn ${projectMode === 'custom' ? 'um-mode__btn--on' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, allowedProjectIds: Array.isArray(f.allowedProjectIds) ? f.allowedProjectIds : [], allowedParcelKeys: [] }))}
                  >
                    Personnalisé
                  </button>
                </div>
                {projects.length === 0 ? (
                  <div className="um-note um-note--muted">Aucun projet. Créez-en depuis la page Projets.</div>
                ) : projectMode !== 'custom' ? (
                  <div className="um-note">
                    ✓ Accès complet : les {allProjectIds.length} projets sont autorisés.
                  </div>
                ) : (
                  <>
                    <div className="um-hint">
                      {formProjects.length} projet(s) sur {allProjectIds.length}.
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {projects.map((p) => {
                        const on = formProjects.includes(p.id)
                        return (
                          <button
                            key={p.id}
                            type="button"
                            className={`um-row-item ${on ? 'um-row-item--on' : ''}`}
                            onClick={() => toggleProject(p.id)}
                          >
                            <span>{p.title}</span>
                            <span className="um-row-item__status">
                              {on ? '✓ Autorisé' : 'Cliquer pour ajouter'}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {formStep === 'pieces' && (
              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Parcelles autorisées</div>
                <div className="um-mode" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={pieceMode === 'all'}
                    className={`um-mode__btn ${pieceMode === 'all' ? 'um-mode__btn--on' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, allowedParcelKeys: null }))}
                  >
                    Toutes
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={pieceMode === 'custom'}
                    className={`um-mode__btn ${pieceMode === 'custom' ? 'um-mode__btn--on' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, allowedParcelKeys: Array.isArray(f.allowedParcelKeys) ? f.allowedParcelKeys : [] }))}
                    disabled={pieceOptions.length === 0}
                  >
                    Personnalisé
                  </button>
                </div>
                {pieceOptions.length === 0 ? (
                  <div className="um-note um-note--muted">Sélectionnez au moins un projet à l’étape précédente.</div>
                ) : pieceMode !== 'custom' ? (
                  <div className="um-note">
                    ✓ Accès complet : les {allVisiblePieceKeys.length} parcelles sont autorisées.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 10 }}>
                    <div className="um-hint" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span>{formPieces.length} / {allVisiblePieceKeys.length} parcelles sélectionnées</span>
                      <div style={{ flex: 1 }} />
                      <button
                        type="button"
                        className="um-btn"
                        style={{ padding: '6px 10px', fontSize: 11 }}
                        onClick={() => setForm((f) => ({ ...f, allowedParcelKeys: [...allVisiblePieceKeys] }))}
                      >
                        Tout sélectionner
                      </button>
                      <button
                        type="button"
                        className="um-btn"
                        style={{ padding: '6px 10px', fontSize: 11 }}
                        onClick={() => setForm((f) => ({ ...f, allowedParcelKeys: [] }))}
                      >
                        Tout vider
                      </button>
                    </div>

                    <div className="um-scroll">
                      {groupedPieceOptions.map((group) => {
                        const projectKeys = group.items.map((it) => it.key)
                        const selectedCount = projectKeys.filter((k) => formPieces.includes(k)).length
                        return (
                          <div key={group.projectId} className="um-piece-group">
                            <div className="um-piece-group__head">
                              <div>
                                <div className="um-piece-group__title">{group.projectTitle}</div>
                                <div className="um-piece-group__meta">{selectedCount}/{projectKeys.length} sélectionnées</div>
                              </div>
                              <div className="um-piece-group__actions">
                                <button
                                  type="button"
                                  className="um-btn"
                                  style={{ padding: '4px 8px', fontSize: 10 }}
                                  onClick={() =>
                                    setForm((f) => {
                                      const current = Array.isArray(f.allowedParcelKeys) ? f.allowedParcelKeys : []
                                      const next = [...new Set([...current, ...projectKeys])]
                                      return { ...f, allowedParcelKeys: next }
                                    })
                                  }
                                >
                                  Tous
                                </button>
                                <button
                                  type="button"
                                  className="um-btn"
                                  style={{ padding: '4px 8px', fontSize: 10 }}
                                  onClick={() =>
                                    setForm((f) => {
                                      const current = Array.isArray(f.allowedParcelKeys) ? f.allowedParcelKeys : []
                                      return { ...f, allowedParcelKeys: current.filter((k) => !projectKeys.includes(k)) }
                                    })
                                  }
                                >
                                  Aucun
                                </button>
                              </div>
                            </div>

                            <div className="um-chips">
                              {group.items.map((item) => {
                                const on = formPieces.includes(item.key)
                                return (
                                  <button
                                    key={item.key}
                                    type="button"
                                    onClick={() => togglePiece(item.key)}
                                    className={`um-chip um-chip--small ${on ? 'um-chip--on' : ''}`}
                                  >
                                    {item.label}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {drawer === 'edit' && (
              <div className="sp-detail__section">
                <div className="sp-detail__section-title">Activité récente</div>
                <button
                  type="button"
                  className="um-btn"
                  style={{ marginBottom: 8, padding: '6px 10px', fontSize: 11 }}
                  onClick={() =>
                    navigate(`/admin/audit-log?subject=${encodeURIComponent(String(form.dbId || form.id || ''))}`)
                  }
                >
                  Ouvrir le journal filtré
                </button>
                {staffAudit.length === 0 ? (
                  <div className="um-note um-note--muted">Aucun événement pour ce compte.</div>
                ) : (
                  <ul className="um-audit">
                    {staffAudit.map((a) => (
                      <li key={a.id} className="um-audit__row">
                        <span className="um-audit__action">{a.action}</span>
                        <span className="um-audit__details">{a.details || a.entityId}</span>
                        <span className="um-audit__time">{fmtDate(a.createdAt) || a.createdAt}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="um-actions">
              {drawer === 'edit' && (
                <button
                  type="button"
                  className="um-btn um-btn--danger"
                  onClick={() => setConfirmModal({ ...form, action: 'delete' })}
                  disabled={saving}
                >
                  Supprimer
                </button>
              )}
              <div className="um-actions__spacer" />
              <button
                type="button"
                className="um-btn"
                onClick={() => setDrawer(null)}
                disabled={saving}
              >
                Annuler
              </button>
              <button
                type="button"
                className="um-btn"
                onClick={() => setFormStep(steps[Math.max(0, stepIndex - 1)])}
                disabled={stepIndex <= 0 || saving}
              >
                Précédent
              </button>
              {stepIndex < steps.length - 1 ? (
                <button
                  type="button"
                  className="um-btn um-btn--primary"
                  onClick={() => setFormStep(steps[Math.min(steps.length - 1, stepIndex + 1)])}
                  disabled={!canGoNext}
                >
                  Suivant
                </button>
              ) : (
                <button
                  type="button"
                  className="um-btn um-btn--primary"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Enregistrement…' : drawer === 'create' ? 'Créer' : 'Enregistrer'}
                </button>
              )}
            </div>
          </div>
        </AdminModal>
      )}

      {/* ─────── CLIENT ACCESS MODAL ─────── */}
      {clientModal && (
        <AdminModal open onClose={() => setClientModal(null)} title="" width={640}>
          <div className="sp-detail">
            <div className="sp-detail__banner">
              <div className="sp-detail__banner-top">
                <span className="sp-badge sp-badge--green">Accès client</span>
                {isClientSuspended(clientModal) ? (
                  <span className="sp-badge sp-badge--red">Suspendu</span>
                ) : null}
              </div>
              <div className="sp-detail__price">
                <span className="sp-detail__price-num">{clientModal.name || 'Sans nom'}</span>
              </div>
              <p className="sp-detail__banner-sub">
                {clientModal.email || '—'}{clientModal.phone ? ` · ${clientModal.phone}` : ''}
              </p>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Identité</div>
              <div className="um-form">
                <div className="um-field">
                  <label className="um-label">Nom complet</label>
                  <input
                    className="um-input"
                    value={clientIdentityForm.name}
                    onChange={(e) => setClientIdentityForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Med Saief Allah"
                  />
                </div>
                <div className="um-field">
                  <label className="um-label">E-mail</label>
                  <input className="um-input" value={clientIdentityForm.email} disabled />
                </div>
                <div className="um-field">
                  <label className="um-label">Téléphone</label>
                  <input
                    className="um-input"
                    value={clientIdentityForm.phone}
                    onChange={(e) => setClientIdentityForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="+216 71 000 000"
                  />
                </div>
                <div className="um-field">
                  <label className="um-label">CIN</label>
                  <input
                    className="um-input"
                    value={clientIdentityForm.cin}
                    onChange={(e) => setClientIdentityForm((f) => ({ ...f, cin: e.target.value }))}
                    placeholder="XXXXXXXX"
                    maxLength={8}
                  />
                </div>
              </div>

              <div className="um-danger-zone">
                <div className="um-danger-zone__text">
                  <b>Suspension :</b> bloque temporairement la connexion sans supprimer le compte.
                </div>
                <button
                  type="button"
                  className="um-btn"
                  onClick={() => navigate(`/admin/clients/${clientModal.id}`)}
                >
                  Ouvrir le profil
                </button>
                <button
                  type="button"
                  className="um-btn um-btn--danger"
                  disabled={clientSaving || isClientSuspended(clientModal)}
                  onClick={handleClientSuspend}
                >
                  Suspendre
                </button>
                <button
                  type="button"
                  className="um-btn um-btn--primary"
                  disabled={clientSaving || !isClientSuspended(clientModal)}
                  onClick={handleClientReactivate}
                >
                  Réactiver
                </button>
              </div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Pages admin accessibles</div>
              <div className="um-hint">Droits pour la navigation admin / garde d’accès.</div>
              <div className="um-chips">
                {PAGE_OPTIONS.map((p) => {
                  const on = clientPagesForm.includes(p.key)
                  return (
                    <button
                      key={p.key}
                      type="button"
                      className={`um-chip um-chip--small ${on ? 'um-chip--on' : ''}`}
                      onClick={() => toggleClientPageKey(p.key)}
                    >
                      {on ? '✓ ' : ''}{p.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Projets accessibles</div>
              <div className="um-hint">Sélectionnez les projets qui déverrouillent les parcelles du client.</div>
              {projects.length === 0 ? (
                <div className="um-note um-note--muted">Aucun projet disponible.</div>
              ) : (
                <div className="um-chips">
                  {projects.map((p) => {
                    const on = clientProjectsForm.includes(p.id)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`um-chip ${on ? 'um-chip--on' : ''}`}
                        onClick={() => toggleClientProject(p.id)}
                      >
                        {p.title}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Parcelles</div>
              {clientAssignmentsLoading ? (
                <div className="um-hint">Chargement des parcelles…</div>
              ) : null}
              {clientProjectsForm.length === 0 ? (
                <div className="um-note um-note--muted">Choisissez au moins un projet.</div>
              ) : groupedClientPieceOptions.length === 0 ? (
                <div className="um-note um-note--muted">Aucune parcelle dans les projets sélectionnés.</div>
              ) : (
                <div className="um-scroll um-scroll--sm">
                  {groupedClientPieceOptions.map((group) => (
                    <div key={group.projectId} className="um-piece-group">
                      <div className="um-piece-group__head">
                        <div className="um-piece-group__title">{group.projectTitle}</div>
                        <div className="um-piece-group__meta">{group.items.length} pièce(s)</div>
                      </div>
                      <div className="um-chips">
                        {group.items.map((item) => {
                          const on = clientAssignedPieceKeySet.has(item.key)
                          return (
                            <button
                              key={item.key}
                              type="button"
                              disabled={clientSaving || clientAssignmentsLoading}
                              onClick={() => toggleClientPiece(item.key)}
                              className={`um-chip um-chip--small ${on ? 'um-chip--on' : ''}`}
                            >
                              {on ? '✓ ' : ''}{item.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Activité récente</div>
              <button
                type="button"
                className="um-btn"
                style={{ marginBottom: 8, padding: '6px 10px', fontSize: 11 }}
                onClick={() =>
                  navigate(`/admin/audit-log?subject=${encodeURIComponent(String(clientModal.id || ''))}`)
                }
              >
                Ouvrir le journal filtré
              </button>
              {clientAudit.length === 0 ? (
                <div className="um-note um-note--muted">Aucun événement pour ce client.</div>
              ) : (
                <ul className="um-audit">
                  {clientAudit.map((a) => (
                    <li key={a.id} className="um-audit__row">
                      <span className="um-audit__action">{a.action}</span>
                      <span className="um-audit__details">{a.details || a.entityId}</span>
                      <span className="um-audit__time">{fmtDate(a.createdAt) || a.createdAt}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="um-actions">
              <button
                type="button"
                className="um-btn"
                onClick={() => setClientModal(null)}
                disabled={clientSaving}
              >
                Fermer
              </button>
              <div className="um-actions__spacer" />
              <button
                type="button"
                className="um-btn um-btn--primary"
                disabled={clientSaving}
                onClick={handleSaveClientAccess}
              >
                {clientSaving ? 'Enregistrement…' : 'Enregistrer l’accès'}
              </button>
            </div>
          </div>
        </AdminModal>
      )}

      {/* ─────── CONFIRM DELETE ─────── */}
      {confirmModal && (
        <AdminModal open onClose={() => setConfirmModal(null)} title="">
          {confirmModal.action === 'delete' && (
            <div className="um-confirm">
              <div className="um-confirm__icon">🗑️</div>
              <h3 className="um-confirm__title">Supprimer {confirmModal.name || 'cet utilisateur'} ?</h3>
              <p className="um-confirm__text">Cette action est irréversible.</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button type="button" className="um-btn" onClick={() => setConfirmModal(null)} disabled={saving}>
                  Annuler
                </button>
                <button type="button" className="um-btn um-btn--danger" onClick={handleDelete} disabled={saving}>
                  {saving ? 'Suppression…' : 'Supprimer'}
                </button>
              </div>
            </div>
          )}
        </AdminModal>
      )}
    </div>
  )
}
