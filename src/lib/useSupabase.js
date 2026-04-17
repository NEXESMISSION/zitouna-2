import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizePhone } from './phone.js'
import { supabase } from './supabase.js'
import * as db from './db.js'

const DEFAULT_FETCH_TIMEOUT_MS = 30000

function withTimeout(promise, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, label = 'request') {
  let timeoutId = null
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
  })
}

export function useProjects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const loadedOnceRef = useRef(false)
  const refreshTimerRef = useRef(null)
  const refreshInFlightRef = useRef(false)

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    setLoading(!loadedOnceRef.current)
    try {
      const data = await withTimeout(db.fetchProjects(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchProjects')
      setProjects(data)
    } catch (e) {
      console.error('fetchProjects', e)
    } finally {
      refreshInFlightRef.current = false
      loadedOnceRef.current = true
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(!loadedOnceRef.current)
      try {
        const data = await withTimeout(db.fetchProjects(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchProjects')
        if (!cancelled) setProjects(data)
      } catch (e) {
        console.error('fetchProjects', e)
      } finally {
        loadedOnceRef.current = true
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-projects-parcels')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => {
        if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = window.setTimeout(() => refresh(), 500)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels' }, () => {
        if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = window.setTimeout(() => refresh(), 500)
      })
      .subscribe()
    return () => {
      cancelled = true
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current)
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const updateParcelStatus = useCallback(
    async (parcelDbId, status) => {
      try {
        await db.updateParcelStatus(parcelDbId, status)
        await refresh()
      } catch (e) {
        console.error('updateParcelStatus', e)
      }
    },
    [refresh],
  )

  return { projects, loading, refresh, updateParcelStatus }
}

export function useProjectsScoped(projectIds = []) {
  const { projects, loading, refresh } = useProjects()
  const filtered = useMemo(() => {
    if (!Array.isArray(projectIds) || projectIds.length === 0) return projects
    const ids = new Set(projectIds)
    return projects.filter((p) => ids.has(p.id))
  }, [projects, projectIds])
  return { projects: filtered, loading, refresh }
}

export function usePublicBrowseProjects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await db.fetchPublicCatalogProjects()
      setProjects(data)
    } catch (e) {
      console.error('fetchPublicCatalogProjects', e)
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const data = await db.fetchPublicCatalogProjects()
        if (!cancelled) setProjects(data)
      } catch (e) {
        console.error('fetchPublicCatalogProjects', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-public-catalog')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  return { projects, loading, refresh }
}

export function usePublicProjectDetail(projectId) {
  const id = String(projectId || '').trim()
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(() => Boolean(id))

  const refresh = useCallback(async () => {
    if (!id) {
      setProject(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await db.fetchPublicProjectById(id)
      setProject(data)
    } catch (e) {
      console.error('fetchPublicProjectById', e)
      setProject(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (!id) {
      setProject(null)
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const data = await db.fetchPublicProjectById(id)
        if (!cancelled) setProject(data)
      } catch (e) {
        console.error('fetchPublicProjectById', e)
        if (!cancelled) setProject(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel(`realtime-public-project-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects', filter: `id=eq.${id}` }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels', filter: `project_id=eq.${id}` }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcel_tree_batches' }, () => void refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [id, refresh])

  return { project, loading, refresh }
}

export function usePublicVisitSlotOptions() {
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await db.fetchPublicVisitSlotOptions()
      setOptions(rows || [])
    } catch (e) {
      console.error('fetchPublicVisitSlotOptions', e)
      setOptions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchPublicVisitSlotOptions()
        if (!cancelled) setOptions(rows || [])
      } catch (e) {
        console.error('fetchPublicVisitSlotOptions', e)
        if (!cancelled) setOptions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-visit-slot-options')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visit_slot_options' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  return { options, loading, refresh }
}

export function useClients() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const loadedOnceRef = useRef(false)

  const refresh = useCallback(async () => {
    setLoading(!loadedOnceRef.current)
    try {
      const rows = await withTimeout(db.fetchClients(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchClients')
      setClients(rows)
    } catch (e) {
      console.error('fetchClients', e)
    } finally {
      loadedOnceRef.current = true
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(!loadedOnceRef.current)
      try {
        const rows = await withTimeout(db.fetchClients(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchClients')
        if (!cancelled) setClients(rows)
      } catch (e) {
        console.error('fetchClients', e)
      } finally {
        loadedOnceRef.current = true
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-clients')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clients' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const upsert = useCallback(
    async (client) => {
      const saved = await db.upsertClient(client)
      await refresh()
      return saved
    },
    [refresh],
  )

  const remove = useCallback(
    async (clientId) => {
      await db.deleteClient(clientId)
      await refresh()
    },
    [refresh],
  )

  return { clients, loading, refresh, upsert, remove }
}

export function useOffers() {
  const [liveOffers, setLiveOffers] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const by = await db.fetchOffers()
      setLiveOffers(by)
    } catch (e) {
      console.error('fetchOffers', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const by = await db.fetchOffers()
        if (!cancelled) setLiveOffers(by)
      } catch (e) {
        console.error('fetchOffers', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-offers')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_offers' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const offersByProject = useMemo(() => {
    const out = {}
    const base = liveOffers && typeof liveOffers === 'object' ? liveOffers : {}
    for (const [projectId, list] of Object.entries(base)) {
      out[projectId] = (list || []).map((o) => ({
        dbId: o.dbId ?? o.id,
        name: o.label || o.name,
        price: Number(o.price || 0),
        downPayment: Number(o.avancePct ?? o.downPayment ?? 0),
        duration: Number(o.duration || 0),
      }))
    }
    return out
  }, [liveOffers])

  return { offersByProject, loading, refresh }
}

export function useSales() {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const refreshTimer = useRef(null)
  const creatingIds = useRef(new Set())
  const loadedOnceRef = useRef(false)

  const refresh = useCallback(async () => {
    setLoading(!loadedOnceRef.current)
    try {
      const rows = await withTimeout(db.fetchSales(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSales')
      setSales(rows)
    } catch (e) {
      console.error('fetchSales', e)
    } finally {
      loadedOnceRef.current = true
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(!loadedOnceRef.current)
      try {
        const rows = await withTimeout(db.fetchSales(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSales')
        if (!cancelled) setSales(rows)
      } catch (e) {
        console.error('fetchSales', e)
      } finally {
        loadedOnceRef.current = true
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-sales')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => {
        // Debounce refresh bursts (multiple row updates happen in a row).
        if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
        refreshTimer.current = window.setTimeout(() => refresh(), 350)
      })
      .subscribe()
    return () => {
      cancelled = true
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const create = useCallback(
    async (sale) => {
      const row = await db.createSale({
        ...sale,
        buyerPhoneNormalized: normalizePhone(sale.buyerPhoneNormalized || sale.buyerPhone || ''),
      })
      // UX: show the new sale immediately without requiring manual refresh.
      // The row returned from insert may miss joined fields, so we also trigger a background refresh.
      if (row?.id && !creatingIds.current.has(String(row.id))) {
        creatingIds.current.add(String(row.id))
        setSales((prev) => [row, ...(prev || [])])
        window.setTimeout(() => {
          creatingIds.current.delete(String(row.id))
        }, 5_000)
      }
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => refresh(), 350)
      return row
    },
    [refresh],
  )

  const update = useCallback(
    async (saleId, patch = {}) => {
      await db.updateSale(saleId, patch)
      // Optimistic local patch, then background refresh to keep joins consistent.
      setSales((prev) => (prev || []).map((s) => (String(s.id) === String(saleId) ? { ...s, ...patch } : s)))
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => refresh(), 350)
      return { id: saleId, ...patch }
    },
    [refresh],
  )

  const remove = useCallback(
    async (saleId) => {
      await db.deleteSale(saleId)
      setSales((prev) => (prev || []).filter((s) => String(s.id) !== String(saleId)))
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => refresh(), 350)
    },
    [refresh],
  )

  return { sales, loading, refresh, create, update, remove }
}

function applySaleFilters(list, filters = {}) {
  let out = list || []
  if (filters.clientId != null && filters.clientId !== '') {
    out = out.filter((s) => String(s.clientId) === String(filters.clientId))
  }
  if (filters.postNotaryDestination) {
    out = out.filter((s) => s.postNotaryDestination === filters.postNotaryDestination)
  }
  if (filters.statusIn && Array.isArray(filters.statusIn)) {
    const set = new Set(filters.statusIn)
    out = out.filter((s) => set.has(s.status))
  }
  if (filters.minPipeline) {
    const order = ['draft', 'pending_finance', 'pending_legal', 'active', 'completed']
    const minIdx = order.indexOf(filters.minPipeline)
    if (minIdx >= 0) {
      out = out.filter((s) => order.indexOf(s.status) >= minIdx)
    }
  }
  return out
}

export function useSalesScoped(filters = {}) {
  const [liveSales, setLiveSales] = useState([])
  const [loading, setLoading] = useState(true)
  const clientId = filters.clientId
  const loadedOnceRef = useRef(false)

  const refresh = useCallback(async () => {
    setLoading(!loadedOnceRef.current)
    try {
      const rows =
        clientId != null && clientId !== ''
          ? await withTimeout(db.fetchSalesScoped({ clientId }), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSalesScoped')
          : await withTimeout(db.fetchSales(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSales')
      setLiveSales(rows)
    } catch (e) {
      console.error('fetchSalesScoped', e)
    } finally {
      loadedOnceRef.current = true
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(!loadedOnceRef.current)
      try {
        const rows =
          clientId != null && clientId !== ''
            ? await withTimeout(db.fetchSalesScoped({ clientId }), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSalesScoped')
            : await withTimeout(db.fetchSales(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSales')
        if (!cancelled) setLiveSales(rows)
      } catch (e) {
        console.error('fetchSalesScoped', e)
      } finally {
        loadedOnceRef.current = true
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel(`realtime-sales-scoped-${String(clientId || 'all')}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh, clientId])

  const filtered = useMemo(
    () => applySaleFilters(liveSales, filters),
    [liveSales, filters.postNotaryDestination, filters.statusIn, filters.minPipeline, filters.clientId],
  )

  return { sales: filtered, loading, refresh }
}

export function useSalesBySellerClientId(sellerClientId) {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const loadedOnceRef = useRef(false)

  const refresh = useCallback(async () => {
    if (sellerClientId == null || sellerClientId === '') return
    setLoading(!loadedOnceRef.current)
    try {
      const rows = await withTimeout(
        db.fetchSalesBySellerClientId(sellerClientId),
        DEFAULT_FETCH_TIMEOUT_MS,
        'fetchSalesBySellerClientId',
      )
      setSales(rows)
    } catch (e) {
      console.error('fetchSalesBySellerClientId', e)
    } finally {
      loadedOnceRef.current = true
      setLoading(false)
    }
  }, [sellerClientId])

  useEffect(() => {
    if (sellerClientId == null || sellerClientId === '') return
    let cancelled = false
    ;(async () => {
      setLoading(!loadedOnceRef.current)
      try {
        const rows = await withTimeout(
          db.fetchSalesBySellerClientId(sellerClientId),
          DEFAULT_FETCH_TIMEOUT_MS,
          'fetchSalesBySellerClientId',
        )
        if (!cancelled) setSales(rows)
      } catch (e) {
        console.error('fetchSalesBySellerClientId', e)
      } finally {
        loadedOnceRef.current = true
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel(`realtime-sales-seller-${String(sellerClientId)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh, sellerClientId])

  return { sales, loading, refresh }
}

export function useInstallments() {
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await db.fetchInstallments()
      setPlans(rows)
    } catch (e) {
      console.error('fetchInstallments', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchInstallments()
        if (!cancelled) setPlans(rows)
      } catch (e) {
        console.error('fetchInstallments', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-installments')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'installment_plans' }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'installment_payments' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const createPlan = useCallback(
    async (plan) => {
      const id = await db.createInstallmentPlan(plan)
      await refresh()
      return id
    },
    [refresh],
  )

  return { plans, loading, refresh, createPlan, updatePlan: async () => {} }
}

export function useInstallmentsScoped(filters = {}) {
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const clientId = filters.clientId

  const refresh = useCallback(async () => {
    if (clientId == null || clientId === '') {
      setPlans([])
      return
    }
    setLoading(true)
    try {
      const rows = await db.fetchInstallmentsScoped({ clientId })
      setPlans(rows)
    } catch (e) {
      console.error('fetchInstallmentsScoped', e)
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (clientId == null || clientId === '') {
      setPlans([])
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchInstallmentsScoped({ clientId })
        if (!cancelled) setPlans(rows)
      } catch (e) {
        console.error('fetchInstallmentsScoped', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel(`realtime-installments-scoped-${String(clientId)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'installment_plans' }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'installment_payments' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh, clientId])

  return { plans, loading, refresh }
}

export function useAdminUsers() {
  const [adminUsers, setAdminUsers] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await db.fetchAdminUsers()
      setAdminUsers(rows)
    } catch (e) {
      console.error('fetchAdminUsers', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchAdminUsers()
        if (!cancelled) setAdminUsers(rows)
      } catch (e) {
        console.error('fetchAdminUsers', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-admin-users')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_users' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const upsert = useCallback(
    async (user) => {
      const saved = await db.upsertAdminUser(user)
      await refresh()
      return saved
    },
    [refresh],
  )

  const remove = useCallback(
    async (userId) => {
      await db.deleteAdminUser(userId)
      await refresh()
    },
    [refresh],
  )

  return { adminUsers, loading, error: null, refresh, upsert, remove }
}

export function useProjectWorkflow(projectId) {
  const id = String(projectId || '').trim()
  const [workflow, setWorkflow] = useState(null)
  const [loading, setLoading] = useState(Boolean(id))

  const refresh = useCallback(async () => {
    if (!id) {
      setWorkflow(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const wf = await db.fetchProjectWorkflowConfig(id)
      setWorkflow(wf)
    } catch (e) {
      console.error('fetchProjectWorkflowConfig', e)
      setWorkflow(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const updateWorkflow = useCallback(
    async (patch) => {
      if (!id) return
      const cur = await db.fetchProjectWorkflowConfig(id)
      const next = { ...cur, ...patch, projectId: id }
      await db.upsertProjectWorkflowSettingsFromShape(id, next)
      if (Object.prototype.hasOwnProperty.call(patch, 'signatureChecklist')) {
        await db.replaceProjectSignatureChecklist(id, next.signatureChecklist || [])
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'commissionRules')) {
        await db.replaceProjectCommissionRules(id, next.commissionRules || [])
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'arabonDefault')) {
        await db.updateProjectArabonDefault(id, next.arabonDefault)
      }
      await refresh()
    },
    [id, refresh],
  )

  return { workflow, updateWorkflow, loading }
}

export function useWorkspaceAudit() {
  const [audit, setAudit] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await db.fetchAuditLog(8000)
      setAudit(rows)
    } catch (e) {
      console.error('fetchAuditLog', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchAuditLog(8000)
        if (!cancelled) setAudit(rows)
      } catch (e) {
        console.error('fetchAuditLog', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-audit-logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_logs' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const append = useCallback(
    async (entry) => {
      try {
        await db.appendAuditEntry({
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId != null ? String(entry.entityId) : '',
          details: entry.details || '',
          metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {},
          actorUserId: entry.actorUserId || null,
          user: entry.actorEmail || entry.user || '',
          actorEmail: entry.actorEmail || entry.user || '',
          subjectUserId: entry.subjectUserId || null,
          severity: entry.severity || 'info',
          category: entry.category || 'business',
          source: entry.source || 'admin_ui',
        })
        await refresh()
      } catch (e) {
        console.error('appendAuditEntry', e)
      }
    },
    [refresh],
  )

  return { audit, append, loading, refresh }
}

export function useAccessGrants() {
  const [accessGrants, setAccessGrants] = useState([])
  const [grantAuditLog, setGrantAuditLog] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, auditRows] = await Promise.all([
        db.fetchActivePageAccessGrants(),
        db.fetchPageAccessGrantsAudit(500),
      ])
      setAccessGrants(Array.isArray(rows) ? rows : [])
      const sorted = [...(Array.isArray(auditRows) ? auditRows : [])].sort(
        (a, b) => String(b.grantedAt || '').localeCompare(String(a.grantedAt || '')),
      )
      setGrantAuditLog(sorted)
    } catch (e) {
      console.error('fetchActivePageAccessGrants', e)
      setAccessGrants([])
      setGrantAuditLog([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const channel = supabase
      .channel('page-access-grants')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'page_access_grants' }, () => void refresh())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const grant = useCallback(
    async (clientId, pageKey, sourceSaleId, checklistKey, actorUserId) => {
      await db.grantPageAccessLive({ clientId, pageKey, sourceSaleId, sourceChecklistKey: checklistKey, actorUserId })
      await refresh()
    },
    [refresh],
  )

  const revoke = useCallback(
    async (grantId, actorUserId) => {
      try {
        return await db.revokePageAccessGrant(grantId, actorUserId)
      } catch (e) {
        console.error(e)
        return { ok: false }
      } finally {
        await refresh()
      }
    },
    [refresh],
  )

  return { accessGrants, grantAuditLog, grant, revoke, loading, refresh }
}

function useCommissionWorkspace() {
  const [commissionEvents, setCommissionEvents] = useState([])
  const [payoutRequests, setPayoutRequests] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [ev, pr] = await Promise.all([db.fetchCommissionEvents(), db.fetchCommissionPayoutRequestsWithItems()])
      setCommissionEvents(ev)
      setPayoutRequests(pr)
    } catch (e) {
      console.error('commissionWorkspace', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [ev, pr] = await Promise.all([db.fetchCommissionEvents(), db.fetchCommissionPayoutRequestsWithItems()])
        if (!cancelled) {
          setCommissionEvents(ev)
          setPayoutRequests(pr)
        }
      } catch (e) {
        console.error('commissionWorkspace', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-commission-workspace')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_events' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_payout_requests' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_payout_request_items' }, () => void refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const submitPayoutRequest = useCallback(
    async (beneficiaryClientId, actorUserId) => {
      try {
        const r = await db.submitCommissionPayoutRequest(beneficiaryClientId, actorUserId)
        await refresh()
        return r
      } catch (e) {
        console.error('submitCommissionPayoutRequest', e)
        return { ok: false, reason: 'error' }
      }
    },
    [refresh],
  )

  const reviewPayoutRequest = useCallback(
    async (requestId, decision, opts) => {
      try {
        const r = await db.reviewCommissionPayoutRequest(requestId, decision, opts)
        await refresh()
        return r
      } catch (e) {
        console.error('reviewCommissionPayoutRequest', e)
        return { ok: false, reason: 'error' }
      }
    },
    [refresh],
  )

  return { commissionEvents, payoutRequests, loading, refresh, submitPayoutRequest, reviewPayoutRequest }
}

export function useSellerRelations() {
  const [sellerRelations, setSellerRelations] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await db.fetchSellerRelations()
      setSellerRelations(rows)
    } catch (e) {
      console.error('sellerRelations', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchSellerRelations()
        if (!cancelled) setSellerRelations(rows)
      } catch (e) {
        console.error('sellerRelations', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-seller-relations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seller_relations' }, () => void refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh])

  const tryLink = useCallback(
    async (childClientId, parentClientId, sourceSaleId) => {
      try {
        const r = await db.upsertSellerRelation({ childClientId, parentClientId, sourceSaleId })
        await refresh()
        return r
      } catch (e) {
        console.error('upsertSellerRelation', e)
        return { ok: false, reason: 'error' }
      }
    },
    [refresh],
  )

  return { sellerRelations, tryLink, loading, refresh }
}

export function useCommissionData() {
  const { commissionEvents, payoutRequests, loading, refresh } = useCommissionWorkspace()
  return { commissionEvents, payoutRequests, loading, refresh }
}

export function useCommissionLedger() {
  const { commissionEvents, payoutRequests, loading, refresh, submitPayoutRequest, reviewPayoutRequest } =
    useCommissionWorkspace()
  return { commissionEvents, payoutRequests, loading, refresh, submitPayoutRequest, reviewPayoutRequest }
}

export function useMySellerParcelAssignments(enabled = true) {
  const [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(() => Boolean(enabled))

  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try {
      const rows = await db.fetchMySellerParcelAssignments()
      setAssignments(Array.isArray(rows) ? rows : [])
    } catch (e) {
      console.error('fetchMySellerParcelAssignments', e)
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setAssignments([])
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await db.fetchMySellerParcelAssignments()
        if (!cancelled) setAssignments(Array.isArray(rows) ? rows : [])
      } catch (e) {
        console.error('fetchMySellerParcelAssignments', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const channel = supabase
      .channel('realtime-seller-parcel-assignments')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seller_parcel_assignments' }, () => refresh())
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [refresh, enabled])

  return { assignments: enabled ? assignments : [], loading: enabled ? loading : false, refresh }
}

/**
 * Aggregated ambassador/parrainage KPIs fetched from the DB RPC
 * `get_my_referral_summary` and kept fresh via realtime subscriptions on
 * `commission_events`, `commission_payout_requests`, and `seller_relations`.
 *
 * @param {boolean} enabled Gate the fetch/subscriptions (e.g. skip while the
 *                          buyer's clientProfile is still resolving).
 */
export function useAmbassadorReferralSummary(enabled = true) {
  const [summary, setSummary] = useState({
    ok: false,
    gainsAccrued: 0,
    commissionsReleased: 0,
    walletBalance: 0,
    minPayoutAmount: 0,
    fieldDepositMin: 0,
    fullDepositTarget: 0,
    referralGross: 0,
    referralGrossPerLevel: 0,
    parrainageMaxDepth: 0,
    rsRatePct: 0,
    levelGrossRules: [],
    reason: 'pending',
    errorMessage: null,
    identityVerificationBlocked: false,
  })
  const [loading, setLoading] = useState(Boolean(enabled))
  const inflightRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled) return
    const seq = ++inflightRef.current
    setLoading(true)
    try {
      const next = await db.fetchAmbassadorReferralSummary()
      // Drop stale responses (e.g. enabled toggled, user logged out mid-fetch).
      if (seq !== inflightRef.current) return
      setSummary(next)
    } catch (e) {
      if (seq !== inflightRef.current) return
      setSummary((prev) => ({ ...prev, ok: false, reason: 'rpc_error', errorMessage: String(e?.message || e) }))
    } finally {
      if (seq === inflightRef.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setSummary((prev) => ({ ...prev, reason: 'not_enabled' }))
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const next = await db.fetchAmbassadorReferralSummary()
        if (!cancelled) setSummary(next)
      } catch (e) {
        if (!cancelled) setSummary((prev) => ({ ...prev, ok: false, reason: 'rpc_error', errorMessage: String(e?.message || e) }))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    const channel = supabase
      .channel('realtime-ambassador-referral')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_events' }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_payout_requests' }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seller_relations' }, () => refresh())
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [enabled, refresh])

  return { summary, loading, refresh }
}
