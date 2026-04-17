import { useState, useCallback, useMemo } from 'react'
import { useAdminUsers, useProjects, useClients, useWorkspaceAudit } from '../../lib/useSupabase.js'
import { useToast } from '../components/AdminToast.jsx'
import AdminModal from '../components/AdminModal.jsx'
import { useNavigate as useNav } from 'react-router-dom'
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
import './zitouna-admin-page.css'

const PAGE_OPTIONS = NAV_ITEMS
  .filter((n) => n.to !== '/admin/profile')
  .map((n) => ({ key: n.to, label: n.label }))

export default function UserManagementPage() {
  const navBack = useNav()
  const { addToast } = useToast()
  const { adminUser, setStaffSession } = useAuth()
  const { adminUsers: users, loading, upsert, remove, refresh } = useAdminUsers()
  const { clients, upsert: upsertClient } = useClients()
  const { audit, append: appendAudit } = useWorkspaceAudit()
  const { projects } = useProjects()
  const [mainTab, setMainTab] = useState('staff')
  const [search, setSearch] = useState('')
  const [drawer, setDrawer] = useState(null)
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

  const filtered = useMemo(() => {
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

  const stats = useMemo(
    () => ({
      total: mainTab === 'staff' ? users.length : (clients || []).length,
      withPageScope:
        mainTab === 'staff'
          ? users.filter((u) => Array.isArray(u.allowedPages)).length
          : (clients || []).filter((c) => Array.isArray(c.allowedPages) && c.allowedPages.length > 0).length,
      withProjectScope:
        mainTab === 'staff'
          ? users.filter((u) => Array.isArray(u.allowedProjectIds)).length
          : (clients || []).filter((c) => Array.isArray(c.allowedProjectIds) && c.allowedProjectIds.length > 0).length,
    }),
    [users, clients, mainTab],
  )

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
    setClientSaving(true)
    try {
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

      // If projects were removed, revoke any piece assignments from those projects
      // so that "pieces access" matches exactly what the client is allowed to see.
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

      addToast('Client access updated')
      setClientModal(null)
    } catch (err) {
      addToast(`Error: ${err.message}`, 'error')
    } finally {
      setClientSaving(false)
    }
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
    setClientSaving(true)
    try {
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
      addToast('Client suspended')
      setClientModal(null)
    } catch (err) {
      addToast(`Error: ${err.message}`, 'error')
    } finally {
      setClientSaving(false)
    }
  }, [clientModal, upsertClient, addToast, adminUser?.id, adminUser?.email, appendAudit])

  const handleClientReactivate = useCallback(async () => {
    if (!clientModal) return
    setClientSaving(true)
    try {
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
      addToast('Client reactivated')
      setClientModal(null)
    } catch (err) {
      addToast(`Error: ${err.message}`, 'error')
    } finally {
      setClientSaving(false)
    }
  }, [clientModal, upsertClient, addToast, adminUser?.id, adminUser?.email, appendAudit])

  const handleStaffSuspendToggle = useCallback(async () => {
    if (drawer !== 'edit' || !form.id) return
    const rowId = form.dbId || form.id
    const susp = form.status === 'suspended' || form.suspendedAt
    const patch = susp
      ? { status: 'active', suspendedAt: null, suspendedBy: null, suspensionReason: null }
      : { status: 'suspended', suspendedAt: new Date().toISOString(), suspendedBy: adminUser?.id || null, suspensionReason: 'Suspended from User management' }
    setSaving(true)
    try {
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
      addToast(susp ? 'Staff reactivated' : 'Staff suspended')
      if (String(rowId) === String(adminUser?.dbId || adminUser?.id)) {
        setStaffSession(patch)
      }
    } catch (err) {
      addToast(`Error: ${err.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [drawer, form, upsert, addToast, adminUser, setStaffSession, appendAudit])

  const allPageKeys = useMemo(() => PAGE_OPTIONS.map((p) => p.key), [])

  const togglePage = useCallback((pageKey) => {
    setForm((f) => {
      const current = Array.isArray(f.allowedPages) ? f.allowedPages : [...allPageKeys]
      const next = current.includes(pageKey)
        ? current.filter((k) => k !== pageKey)
        : [...current, pageKey]
      return { ...f, allowedPages: next }
    })
  }, [allPageKeys])

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

  const allProjectIds = useMemo(() => (projects || []).map((p) => p.id), [projects])
  const allParcelKeyValues = useMemo(() => allParcelKeys.map((it) => it.key), [allParcelKeys])

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
      addToast('Name and email are required', 'error')
      return
    }

    if (drawer === 'create') {
      if (!form.password || form.password.length < 6) {
        addToast('Password required (min 6 chars)', 'error')
        return
      }
      setSaving(true)
      try {
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
          addToast(`Error: ${authError.message}`, 'error')
          return
        }
        if (authData.user?.identities?.length === 0) {
          addToast('Email already used', 'error')
          return
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
        addToast('User created')
        setDrawer(null)
      } catch (err) {
        addToast(`Error: ${err.message}`, 'error')
      } finally {
        setSaving(false)
      }
      return
    }

    setSaving(true)
    try {
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
      addToast('User updated')
      setDrawer(null)
    } catch (err) {
      addToast(`Error: ${err.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [drawer, form, upsert, addToast, refresh, adminUser, setStaffSession, users, appendAudit])

  const handleDelete = useCallback(async () => {
    try {
      const rowId = confirmModal.dbId || confirmModal.id
      if (rowId) await remove(rowId)
      addToast(`${confirmModal.name} removed`)
    } catch (err) {
      addToast(`Error: ${err.message}`, 'error')
    }
    setConfirmModal(null)
    setDrawer(null)
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

      setClientAssignmentsLoading(true)
      try {
        if (assigned) {
          await revokeSellerParcel({ clientId: clientModal.id, parcelId, reason: 'Pieces access removed' })
        } else {
          await assignSellerParcel({ clientId: clientModal.id, projectId, parcelId, note: '' })
        }

        const rows = await fetchSellerParcelAssignments(clientModal.id)
        setClientAssignments(Array.isArray(rows) ? rows : [])
        addToast(assigned ? 'Piece access revoked' : 'Piece access granted')
      } catch (err) {
        addToast(`Error: ${err.message}`, 'error')
      } finally {
        setClientAssignmentsLoading(false)
      }
    },
    [clientModal, clientAssignedPieceKeySet, addToast],
  )

  const steps = ['identity', 'pages', 'projects', 'pieces']
  const stepLabels = {
    identity: 'User info',
    pages: 'Page access',
    projects: 'Project access',
    pieces: 'Pieces access',
  }
  const stepIndex = steps.indexOf(formStep)
  const canGoNext = formStep !== 'identity' || (form.name?.trim() && form.email?.trim())

  if (loading) {
    return (
      <div className="zitu-page" dir="ltr">
        <div className="zitu-page__column">
          <div className="zitu-page__loading">Loading...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navBack(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Back</span>
        </button>
        <header className="zitu-page__header">
          <div className="zitu-page__header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="zitu-page__header-text">
            <h1>Gestion IAM: utilisateurs & permissions</h1>
            <p>Comptes staff, comptes clients, droits d acces et suspension.</p>
          </div>
          <div className="zitu-page__header-actions">
            {mainTab === 'staff' ? (
              <button type="button" className="zitu-page__btn zitu-page__btn--primary" onClick={openCreate}>
                + New user
              </button>
            ) : null}
          </div>
        </header>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`zitu-page__btn ${mainTab === 'staff' ? 'zitu-page__btn--primary' : ''}`}
            style={{ padding: '6px 12px', fontSize: 12 }}
            onClick={() => setMainTab('staff')}
          >
            Staff ({users.length})
          </button>
          <button
            type="button"
            className={`zitu-page__btn ${mainTab === 'clients' ? 'zitu-page__btn--primary' : ''}`}
            style={{ padding: '6px 12px', fontSize: 12 }}
            onClick={() => setMainTab('clients')}
          >
            Clients ({(clients || []).length})
          </button>
        </div>

        <div className="zitu-page__stats zitu-page__stats--3" style={{ marginBottom: 12 }}>
          <div className="zitu-page__stat">
            <div className="zitu-page__stat-label">{mainTab === 'staff' ? 'Staff' : 'Clients'}</div>
            <div className="zitu-page__stat-value">{stats.total}</div>
          </div>
          <div className="zitu-page__stat">
            <div className="zitu-page__stat-label">{mainTab === 'staff' ? 'Page scoped' : 'With admin pages'}</div>
            <div className="zitu-page__stat-value zitu-page__stat-value--mint">{stats.withPageScope}</div>
          </div>
          <div className="zitu-page__stat">
            <div className="zitu-page__stat-label">{mainTab === 'staff' ? 'Project scoped' : 'Project scoped'}</div>
            <div className="zitu-page__stat-value">{stats.withProjectScope}</div>
          </div>
        </div>

        <div className="zitu-page__filters">
          <div className="zitu-page__search-wrap zitu-page__filters-grow">
            <input
              className="zitu-page__search"
              placeholder={mainTab === 'staff' ? 'Search staff by name or email…' : 'Search clients by name, email, phone…'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="zitu-page__search-icon" aria-hidden>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </span>
          </div>
        </div>

        {mainTab === 'staff' && filtered.length === 0 ? (
          <div className="zitu-page__empty">
            <strong>No staff found</strong>
            Adjust search or create a new user.
          </div>
        ) : null}
        {mainTab === 'clients' && filteredClients.length === 0 ? (
          <div className="zitu-page__empty">
            <strong>No clients found</strong>
            Self-registered clients appear here after signup.
          </div>
        ) : null}

        {mainTab === 'staff' && filtered.length > 0 ? (
          <div className="zitu-page__card-list">
            {filtered.map((u) => {
              const pagesLabel = u.allowedPages ? `${u.allowedPages.length} pages` : 'All pages'
              const projLabel = u.allowedProjectIds ? `${u.allowedProjectIds.length} projects` : 'All projects'
              const pieceLabel = u.allowedParcelKeys ? `${u.allowedParcelKeys.length} pieces` : 'All pieces'
              const suspended = u.status === 'suspended' || Boolean(u.suspendedAt)
              return (
                <div
                  key={u.id}
                  className="zitu-page__card"
                  onClick={() => openEdit(u)}
                  role="presentation"
                  style={{
                    borderRadius: 14,
                    border: '1px solid #dbeafe',
                    background: 'linear-gradient(135deg, #ffffff 0%, #f8fbff 100%)',
                    boxShadow: '0 6px 18px rgba(30, 64, 175, 0.06)',
                    opacity: suspended ? 0.72 : 1,
                  }}
                >
                  <div className="zitu-page__card-accent" style={{ background: suspended ? '#94a3b8' : '#2563eb' }} />
                  <div className="zitu-page__card-top">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          background: '#dbeafe',
                          border: '1px solid #bfdbfe',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 12,
                          fontWeight: 700,
                          color: '#1d4ed8',
                          flexShrink: 0,
                        }}
                      >
                        {(u.name || 'U')[0].toUpperCase()}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div className="zitu-page__card-name">{u.name}</div>
                        <div className="zitu-page__card-meta">{u.email}</div>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span className="zitu-page__badge" style={{
                        background: u.role === 'Super Admin' || u.role === 'SUPER_ADMIN' ? '#fef3c7' : '#dbeafe',
                        color: u.role === 'Super Admin' || u.role === 'SUPER_ADMIN' ? '#92400e' : '#1e40af',
                        border: `1px solid ${u.role === 'Super Admin' || u.role === 'SUPER_ADMIN' ? '#fde68a' : '#bfdbfe'}`,
                        fontWeight: 700,
                      }}>
                        {u.role === 'Super Admin' || u.role === 'SUPER_ADMIN' ? 'Super Admin' : 'Staff'}
                      </span>
                      {suspended ? (
                        <span className="zitu-page__badge" style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}>Suspended</span>
                      ) : null}
                      <span className="zitu-page__badge" style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0' }}>{pagesLabel}</span>
                      <span className="zitu-page__badge" style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0' }}>{projLabel}</span>
                      <span className="zitu-page__badge" style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0' }}>{pieceLabel}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}

        {mainTab === 'clients' && filteredClients.length > 0 ? (
          <div className="zitu-page__card-list">
            {filteredClients.map((c) => {
              const suspended = isClientSuspended(c)
              const pagesN = Array.isArray(c.allowedPages) ? c.allowedPages.length : 0
              return (
                <div
                  key={c.id}
                  className="zitu-page__card"
                  role="presentation"
                  style={{
                    borderRadius: 14,
                    border: '1px solid #dbeafe',
                    background: 'linear-gradient(135deg, #ffffff 0%, #f8fbff 100%)',
                    boxShadow: '0 6px 18px rgba(30, 64, 175, 0.06)',
                    opacity: suspended ? 0.72 : 1,
                  }}
                >
                  <div className="zitu-page__card-accent" style={{ background: suspended ? '#94a3b8' : '#059669' }} />
                  <div className="zitu-page__card-top">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 8,
                            background: '#d1fae5',
                            border: '1px solid #a7f3d0',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 12,
                            fontWeight: 700,
                            color: '#047857',
                            flexShrink: 0,
                          }}
                        >
                          {(c.name || 'C')[0].toUpperCase()}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div className="zitu-page__card-name">{c.name}</div>
                          <div className="zitu-page__card-meta">{c.email || '—'}{c.phone ? ` · ${c.phone}` : ''}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          type="button"
                          className="zitu-page__btn zitu-page__btn--sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            navBack(`/admin/clients/${c.id}`)
                          }}
                        >
                          Profile
                        </button>
                        <button
                          type="button"
                          className="zitu-page__btn zitu-page__btn--sm zitu-page__btn--primary"
                          onClick={(e) => {
                            e.stopPropagation()
                            openClientManage(c)
                          }}
                        >
                          Access
                        </button>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    {suspended ? (
                      <span className="zitu-page__badge" style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}>Suspended</span>
                    ) : null}
                    {String(c.id).startsWith('c-reg-') ? (
                      <span className="zitu-page__badge" style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>Self-registered</span>
                    ) : null}
                    <span className="zitu-page__badge" style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0' }}>
                      {pagesN ? `${pagesN} admin page(s)` : 'No admin pages'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}

        <AdminModal
          open={!!drawer}
          onClose={() => setDrawer(null)}
          title={drawer === 'create' ? 'Create User' : `Edit User — ${form.name || ''}`}
          width={760}
        >
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            {steps.map((s, idx) => (
              <button
                key={s}
                type="button"
                className={`zitu-page__btn ${formStep === s ? 'zitu-page__btn--primary' : ''}`}
                style={{ padding: '4px 8px', fontSize: 10 }}
                onClick={() => setFormStep(s)}
              >
                {idx + 1}. {stepLabels[s]}
              </button>
            ))}
          </div>

          {formStep === 'identity' && (
            <div className="zitu-page__section" style={{ margin: 0 }}>
              <div className="zitu-page__section-title">User info</div>
              <div className="zitu-page__form-grid">
                <div className="zitu-page__field">
                  <label className="zitu-page__field-label">Full name</label>
                  <input className="zitu-page__input" value={form.name || ''} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Sami Bouaziz" />
                </div>
                <div className="zitu-page__field">
                  <label className="zitu-page__field-label">Email</label>
                  <input className="zitu-page__input" type="email" value={form.email || ''} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="sami@zitouna.tn" disabled={drawer === 'edit'} />
                </div>
              </div>
              <div className="zitu-page__form-grid">
                <div className="zitu-page__field">
                  <label className="zitu-page__field-label">Phone</label>
                  <input className="zitu-page__input" value={form.phone || ''} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+216 71 000 000" />
                </div>
                <div className="zitu-page__field">
                  <label className="zitu-page__field-label">CIN</label>
                  <input className="zitu-page__input" value={form.cin || ''} onChange={(e) => setForm((f) => ({ ...f, cin: e.target.value }))} placeholder="XXXXXXXX" maxLength={8} />
                </div>
              </div>
              {drawer === 'create' && (
                <div className="zitu-page__field">
                  <label className="zitu-page__field-label">Password</label>
                  <input className="zitu-page__input" type="password" value={form.password || ''} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="Min 6 characters" autoComplete="new-password" />
                </div>
              )}
              {drawer === 'edit' && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <button
                    type="button"
                    className="zitu-page__btn"
                    style={{ borderColor: '#fca5a5', color: '#b91c1c' }}
                    disabled={saving || form.status === 'suspended' || Boolean(form.suspendedAt)}
                    onClick={handleStaffSuspendToggle}
                  >
                    Suspend staff
                  </button>
                  <button
                    type="button"
                    className="zitu-page__btn zitu-page__btn--primary"
                    disabled={saving || (form.status !== 'suspended' && !form.suspendedAt)}
                    onClick={handleStaffSuspendToggle}
                  >
                    Reactivate staff
                  </button>
                </div>
              )}
            </div>
          )}

          {formStep === 'pages' && (
            <div className="zitu-page__section" style={{ margin: 0 }}>
              <div className="zitu-page__section-title">Page Access</div>
              <div style={{ display: 'flex', gap: 8, margin: '4px 0 8px' }}>
                <button type="button" className={`zitu-page__btn ${pageMode === 'all' ? 'zitu-page__btn--primary' : ''}`} style={{ padding: '4px 8px', fontSize: 10 }} onClick={() => setForm((f) => ({ ...f, allowedPages: null }))}>All</button>
                <button type="button" className={`zitu-page__btn ${pageMode === 'custom' ? 'zitu-page__btn--primary' : ''}`} style={{ padding: '4px 8px', fontSize: 10 }} onClick={() => setForm((f) => ({ ...f, allowedPages: Array.isArray(f.allowedPages) ? f.allowedPages : [] }))}>Custom</button>
              </div>
              {pageMode === 'custom' ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {PAGE_OPTIONS.map((p) => {
                    const on = formPages.includes(p.key)
                    return (
                      <button key={p.key} type="button" onClick={() => togglePage(p.key)} style={{ padding: '5px 10px', fontSize: 10, fontWeight: 600, borderRadius: 6, cursor: 'pointer', border: on ? '1px solid #93c5fd' : '1px solid #e2e8f0', background: on ? '#eff6ff' : '#fff', color: on ? '#1d4ed8' : '#94a3b8' }}>
                        {p.label}
                      </button>
                    )
                  })}
                </div>
              ) : <div style={{ fontSize: 10, color: '#64748b' }}>{`All ${allPageKeys.length} pages allowed.`}</div>}
            </div>
          )}

          {formStep === 'projects' && (
            <div className="zitu-page__section" style={{ margin: 0 }}>
              <div className="zitu-page__section-title">Project Access</div>
              <div style={{ display: 'flex', gap: 8, margin: '4px 0 8px' }}>
                <button type="button" className={`zitu-page__btn ${projectMode === 'all' ? 'zitu-page__btn--primary' : ''}`} style={{ padding: '4px 8px', fontSize: 10 }} onClick={() => setForm((f) => ({ ...f, allowedProjectIds: null, allowedParcelKeys: null }))}>All</button>
                <button type="button" className={`zitu-page__btn ${projectMode === 'custom' ? 'zitu-page__btn--primary' : ''}`} style={{ padding: '4px 8px', fontSize: 10 }} onClick={() => setForm((f) => ({ ...f, allowedProjectIds: Array.isArray(f.allowedProjectIds) ? f.allowedProjectIds : [], allowedParcelKeys: [] }))}>Custom</button>
              </div>
              {projects.length === 0 ? (
                <div style={{ fontSize: 10, color: '#94a3b8' }}>No projects yet.</div>
              ) : projectMode !== 'custom' ? (
                <div style={{ fontSize: 10, color: '#64748b' }}>{`All ${allProjectIds.length} projects allowed.`}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {projects.map((p) => {
                    const on = formProjects.includes(p.id)
                    return (
                      <button key={p.id} type="button" onClick={() => toggleProject(p.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 10px', fontSize: 11, fontWeight: 600, borderRadius: 8, cursor: 'pointer', border: on ? '1px solid #93c5fd' : '1px solid #e2e8f0', background: on ? '#eff6ff' : '#fff' }}>
                        <span>{p.title}</span><span style={{ color: on ? '#1d4ed8' : '#94a3b8' }}>{on ? 'Selected' : 'Select'}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {formStep === 'pieces' && (
            <div className="zitu-page__section" style={{ margin: 0 }}>
              <div className="zitu-page__section-title">Pieces Access (Parcelles)</div>
              <div style={{ display: 'flex', gap: 8, margin: '4px 0 8px' }}>
                <button type="button" className={`zitu-page__btn ${pieceMode === 'all' ? 'zitu-page__btn--primary' : ''}`} style={{ padding: '4px 8px', fontSize: 10 }} onClick={() => setForm((f) => ({ ...f, allowedParcelKeys: null }))}>All</button>
                <button type="button" className={`zitu-page__btn ${pieceMode === 'custom' ? 'zitu-page__btn--primary' : ''}`} style={{ padding: '4px 8px', fontSize: 10 }} onClick={() => setForm((f) => ({ ...f, allowedParcelKeys: Array.isArray(f.allowedParcelKeys) ? f.allowedParcelKeys : [] }))} disabled={pieceOptions.length === 0}>Custom</button>
              </div>
              {pieceOptions.length === 0 ? (
                <div style={{ fontSize: 10, color: '#94a3b8' }}>No pieces available in selected projects.</div>
              ) : pieceMode !== 'custom' ? (
                <div style={{ fontSize: 10, color: '#64748b' }}>{`All ${allVisiblePieceKeys.length} pieces allowed.`}</div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="zitu-page__btn zitu-page__btn--sm"
                      onClick={() => setForm((f) => ({ ...f, allowedParcelKeys: [...allVisiblePieceKeys] }))}
                    >
                      Select all visible pieces
                    </button>
                    <button
                      type="button"
                      className="zitu-page__btn zitu-page__btn--sm"
                      onClick={() => setForm((f) => ({ ...f, allowedParcelKeys: [] }))}
                    >
                      Clear all
                    </button>
                  </div>

                  <div style={{ display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto', paddingRight: 2 }}>
                    {groupedPieceOptions.map((group) => {
                      const projectKeys = group.items.map((it) => it.key)
                      const selectedCount = projectKeys.filter((k) => formPieces.includes(k)).length
                      return (
                        <div key={group.projectId} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 8, background: '#fff' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <div>
                              <div style={{ fontSize: 11, fontWeight: 800, color: '#0f172a' }}>{group.projectTitle}</div>
                              <div style={{ fontSize: 9, color: '#64748b' }}>{selectedCount}/{projectKeys.length} selected</div>
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                type="button"
                                className="zitu-page__btn zitu-page__btn--sm"
                                onClick={() =>
                                  setForm((f) => {
                                    const current = Array.isArray(f.allowedParcelKeys) ? f.allowedParcelKeys : []
                                    const next = [...new Set([...current, ...projectKeys])]
                                    return { ...f, allowedParcelKeys: next }
                                  })
                                }
                              >
                                All
                              </button>
                              <button
                                type="button"
                                className="zitu-page__btn zitu-page__btn--sm"
                                onClick={() =>
                                  setForm((f) => {
                                    const current = Array.isArray(f.allowedParcelKeys) ? f.allowedParcelKeys : []
                                    return { ...f, allowedParcelKeys: current.filter((k) => !projectKeys.includes(k)) }
                                  })
                                }
                              >
                                Clear
                              </button>
                            </div>
                          </div>

                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {group.items.map((item) => {
                              const on = formPieces.includes(item.key)
                              return (
                                <button
                                  key={item.key}
                                  type="button"
                                  onClick={() => togglePiece(item.key)}
                                  style={{
                                    padding: '5px 9px',
                                    borderRadius: 999,
                                    border: on ? '1px solid #93c5fd' : '1px solid #e2e8f0',
                                    background: on ? '#eff6ff' : '#fff',
                                    color: on ? '#1d4ed8' : '#64748b',
                                    fontSize: 10,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                  }}
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
            <div className="zitu-page__section" style={{ margin: '12px 0 0' }}>
              <div className="zitu-page__section-title">Activité récente (audit)</div>
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--sm"
                style={{ marginBottom: 8 }}
                onClick={() =>
                  navBack(`/admin/audit-log?subject=${encodeURIComponent(String(form.dbId || form.id || ''))}`)
                }
              >
                Ouvrir le journal filtré
              </button>
              {staffAudit.length === 0 ? (
                <div style={{ fontSize: 11, color: '#94a3b8' }}>Aucun événement pour ce compte staff.</div>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', maxHeight: 220, overflowY: 'auto', fontSize: 11 }}>
                  {staffAudit.map((a) => (
                    <li
                      key={a.id}
                      style={{
                        padding: '6px 8px',
                        borderBottom: '1px solid #f1f5f9',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      <span style={{ fontWeight: 700, color: '#0f172a' }}>{a.action}</span>
                      <span style={{ color: '#64748b' }}>{a.details || a.entityId}</span>
                      <span style={{ color: '#94a3b8', fontSize: 10 }}>{a.createdAt}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="zitu-page__form-actions" style={{ marginTop: 10 }}>
            {drawer === 'edit' && (
              <button className="zitu-page__btn zitu-page__btn--danger" onClick={() => setConfirmModal({ ...form, action: 'delete' })}>
                Delete
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button className="zitu-page__btn" onClick={() => setDrawer(null)}>Cancel</button>
            <button
              className="zitu-page__btn"
              onClick={() => setFormStep(steps[Math.max(0, stepIndex - 1)])}
              disabled={stepIndex <= 0}
            >
              Back
            </button>
            {stepIndex < steps.length - 1 ? (
              <button
                className="zitu-page__btn zitu-page__btn--primary"
                onClick={() => setFormStep(steps[Math.min(steps.length - 1, stepIndex + 1)])}
                disabled={!canGoNext}
              >
                Next
              </button>
            ) : (
              <button className="zitu-page__btn zitu-page__btn--primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : drawer === 'create' ? 'Create User' : 'Save'}
              </button>
            )}
          </div>
        </AdminModal>

        <AdminModal
          open={!!clientModal}
          onClose={() => setClientModal(null)}
          title={clientModal ? `Client access — ${clientModal.name || ''}` : ''}
          width={640}
        >
          {clientModal ? (
            <div>
              <div className="zitu-page__section-title" style={{ marginBottom: 6 }}>User info</div>
              <div className="zitu-page__form-grid">
                <div className="zitu-page__field">
                  <label className="zitu-page__field-label">Full name</label>
                  <input
                    className="zitu-page__input"
                    value={clientIdentityForm.name}
                    onChange={(e) => setClientIdentityForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Med Saief Allah"
                  />
                </div>
                <div className="zitu-page__field">
                  <label className="zitu-page__field-label">Email</label>
                  <input className="zitu-page__input" value={clientIdentityForm.email} disabled />
                </div>
              </div>
              <div className="zitu-page__form-grid">
                <div className="zitu-page__field">
                  <label className="zitu-page__field-label">Phone</label>
                  <input
                    className="zitu-page__input"
                    value={clientIdentityForm.phone}
                    onChange={(e) => setClientIdentityForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="+216 71 000 000"
                  />
                </div>
                <div className="zitu-page__field">
                  <label className="zitu-page__field-label">CIN</label>
                  <input
                    className="zitu-page__input"
                    value={clientIdentityForm.cin}
                    onChange={(e) => setClientIdentityForm((f) => ({ ...f, cin: e.target.value }))}
                    placeholder="XXXXXXXX"
                    maxLength={8}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', marginTop: 10 }}>
                <button
                  type="button"
                  className="zitu-page__btn zitu-page__btn--sm"
                  onClick={() => navBack(`/admin/clients/${clientModal.id}`)}
                >
                  Open profile
                </button>
                <button
                  type="button"
                  className="zitu-page__btn zitu-page__btn--sm"
                  style={{ borderColor: '#fca5a5', color: '#b91c1c' }}
                  disabled={clientSaving || isClientSuspended(clientModal)}
                  onClick={handleClientSuspend}
                >
                  Suspend staff
                </button>
                <button
                  type="button"
                  className="zitu-page__btn zitu-page__btn--sm zitu-page__btn--primary"
                  disabled={clientSaving || !isClientSuspended(clientModal)}
                  onClick={handleClientReactivate}
                >
                  Reactivate staff
                </button>
              </div>

              <div className="zitu-page__section-title" style={{ marginBottom: 6 }}>2. Page access</div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>Grants for admin navigation / access guards.</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {PAGE_OPTIONS.map((p) => {
                  const on = clientPagesForm.includes(p.key)
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => toggleClientPageKey(p.key)}
                      style={{
                        padding: '5px 10px',
                        fontSize: 10,
                        fontWeight: 600,
                        borderRadius: 6,
                        cursor: 'pointer',
                        border: on ? '1px solid #93c5fd' : '1px solid #e2e8f0',
                        background: on ? '#eff6ff' : '#fff',
                        color: on ? '#1d4ed8' : '#94a3b8',
                      }}
                    >
                      {p.label}
                    </button>
                  )
                })}
              </div>

              <div className="zitu-page__section-title" style={{ margin: '14px 0 6px' }}>3. Project access</div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>Select projects that unlock the client parcels.</div>
              {projects.length === 0 ? (
                <div style={{ fontSize: 11, color: '#94a3b8' }}>No projects available.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {projects.map((p) => {
                    const on = clientProjectsForm.includes(p.id)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="zitu-page__btn zitu-page__btn--sm"
                        onClick={() => toggleClientProject(p.id)}
                        style={{
                          borderColor: on ? '#93c5fd' : '#e2e8f0',
                          background: on ? '#eff6ff' : '#fff',
                          color: on ? '#1d4ed8' : '#94a3b8',
                        }}
                      >
                        {p.title}
                      </button>
                    )
                  })}
                </div>
              )}

              <div className="zitu-page__section-title" style={{ margin: '14px 0 6px' }}>4. Pieces access</div>
              {clientAssignmentsLoading ? (
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>Loading pieces…</div>
              ) : null}

              {clientProjectsForm.length === 0 ? (
                <div style={{ fontSize: 11, color: '#94a3b8' }}>Choisissez au moins un projet.</div>
              ) : groupedClientPieceOptions.length === 0 ? (
                <div style={{ fontSize: 11, color: '#94a3b8' }}>Aucune parcelle dans les projets sélectionnés.</div>
              ) : (
                <div style={{ display: 'grid', gap: 8, maxHeight: 220, overflowY: 'auto', paddingRight: 2 }}>
                  {groupedClientPieceOptions.map((group) => (
                    <div key={group.projectId} style={{ border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', padding: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <div style={{ fontSize: 11, fontWeight: 900, color: '#0f172a' }}>{group.projectTitle}</div>
                        <div style={{ fontSize: 9, color: '#64748b' }}>{group.items.length} pièces</div>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {group.items.map((item) => {
                          const on = clientAssignedPieceKeySet.has(item.key)
                          return (
                            <button
                              key={item.key}
                              type="button"
                              disabled={clientSaving || clientAssignmentsLoading}
                              onClick={() => toggleClientPiece(item.key)}
                              style={{
                                padding: '5px 9px',
                                borderRadius: 999,
                                border: on ? '1px solid #93c5fd' : '1px solid #e2e8f0',
                                background: on ? '#eff6ff' : '#fff',
                                color: on ? '#1d4ed8' : '#64748b',
                                fontSize: 10,
                                fontWeight: 800,
                                cursor: 'pointer',
                              }}
                            >
                              {on ? 'Revoke' : 'Grant'} {item.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="zitu-page__section-title" style={{ margin: '14px 0 6px' }}>Recent activity</div>
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--sm"
                style={{ marginBottom: 8 }}
                onClick={() =>
                  navBack(`/admin/audit-log?subject=${encodeURIComponent(String(clientModal.id || ''))}`)
                }
              >
                Ouvrir le journal filtré
              </button>
              {clientAudit.length === 0 ? (
                <div style={{ fontSize: 11, color: '#94a3b8' }}>No audit rows for this client yet.</div>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', maxHeight: 200, overflowY: 'auto', fontSize: 11 }}>
                  {clientAudit.map((a) => (
                    <li
                      key={a.id}
                      style={{
                        padding: '6px 8px',
                        borderBottom: '1px solid #f1f5f9',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      <span style={{ fontWeight: 700, color: '#0f172a' }}>{a.action}</span>
                      <span style={{ color: '#64748b' }}>{a.details || a.entityId}</span>
                      <span style={{ color: '#94a3b8', fontSize: 10 }}>{a.createdAt}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="zitu-page__form-actions" style={{ marginTop: 14 }}>
                <button type="button" className="zitu-page__btn" onClick={() => setClientModal(null)}>Close</button>
                <div style={{ flex: 1 }} />
                <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={clientSaving} onClick={handleSaveClientAccess}>
                  {clientSaving ? 'Saving…' : 'Save access'}
                </button>
              </div>
            </div>
          ) : null}
        </AdminModal>

        <AdminModal open={!!confirmModal} onClose={() => setConfirmModal(null)}>
          {confirmModal?.action === 'delete' && (
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fef2f2', border: '1px solid #fee2e2' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </div>
              <h3 style={{ fontWeight: 700, fontSize: 14, color: '#0f172a', margin: 0 }}>Delete {confirmModal.name}?</h3>
              <p style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>This action cannot be undone.</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
                <button className="zitu-page__btn" onClick={() => setConfirmModal(null)}>Cancel</button>
                <button className="zitu-page__btn zitu-page__btn--danger" onClick={handleDelete}>Delete</button>
              </div>
            </div>
          )}
        </AdminModal>
      </div>
    </div>
  )
}
