import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizePhone } from './phone.js'
import { supabase } from './supabase.js'
import * as db from './db.js'
import { emitInvalidate, onInvalidate } from './dataEvents.js'

// 20s timeout — high enough that slow free-tier DBs don't cascade-fail, low
// enough that a truly stuck socket still surfaces in the UI. On timeout the
// store retries once (see `doFetch`) before giving up.
const DEFAULT_FETCH_TIMEOUT_MS = 20000

async function withTimeout(promiseOrFactory, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, label = 'request') {
  // Accept both: an already-running promise (legacy callers) OR a factory
  // function. A factory defers request creation until after the initial-auth
  // gate resolves, so the first fetch on a cold page load carries the JWT
  // and RLS can match against the active user.
  const promise = typeof promiseOrFactory === 'function'
    ? (await awaitInitialAuth(), promiseOrFactory())
    : promiseOrFactory
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

// ----------------------------------------------------------------------------
// Initial-auth gate. Resolves on first `INITIAL_SESSION`/`SIGNED_IN` event;
// a 2s safety timer unblocks anon pages. Reset on `SIGNED_OUT` so the next
// login starts from a clean slate.
// ----------------------------------------------------------------------------
let _initialAuthPromise = null
function buildInitialAuthPromise() {
  return new Promise((resolve) => {
    const safetyTimer = window.setTimeout(() => resolve(), 2000)
    const done = () => {
      window.clearTimeout(safetyTimer)
      try { sub?.subscription?.unsubscribe() } catch { /* ignore */ }
      resolve()
    }
    const sub = supabase.auth.onAuthStateChange((event) => {
      if (
        event === 'INITIAL_SESSION' ||
        event === 'SIGNED_IN' ||
        event === 'SIGNED_OUT' ||
        event === 'TOKEN_REFRESHED'
      ) done()
    })
  })
}
export function awaitInitialAuth() {
  if (!_initialAuthPromise) _initialAuthPromise = buildInitialAuthPromise()
  return _initialAuthPromise
}
// Reset the gate on sign-out so a fresh login is awaited (and stale cached
// data is cleared by cache stores below).
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    _initialAuthPromise = null
    for (const reset of _storeResetHandlers) reset()
  }
})

// ============================================================================
// Cached store factory — the core of Fix A.
//
// Problem this solves: every hook used to fetch on every mount, so
// navigating between pages refetched the same data, overwhelming free-tier
// Supabase. With this store:
//   • State lives at module scope — reused across pages.
//   • First subscriber triggers ONE fetch; later subscribers read cached data.
//   • A single realtime channel per table (singleton).
//   • Stale-while-revalidate: return cache instantly, refetch in background.
//   • Debounced burst refresh (for realtime event storms).
//   • One automatic retry on timeout.
// ============================================================================
const DEFAULT_STALE_MS = 15_000
const _storeResetHandlers = new Set()

function createCachedStore({ key, fetcher, realtimeTables = [], staleMs = DEFAULT_STALE_MS, initial = [] }) {
  let state = { data: initial, loading: true, loadedAt: 0, error: null }
  const listeners = new Set()
  let inflight = null
  let channel = null
  let refreshTimer = null
  let subCount = 0

  function publish(patch) {
    state = { ...state, ...patch }
    for (const fn of listeners) {
      try { fn(state) } catch (e) { console.error(`[cache:${key}] listener`, e) }
    }
  }

  async function doFetch({ retry = true } = {}) {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const data = await withTimeout(() => fetcher(), DEFAULT_FETCH_TIMEOUT_MS, `fetch${key}`)
        publish({ data, loading: false, loadedAt: Date.now(), error: null })
      } catch (e) {
        const msg = String(e?.message || e)
        const timedOut = msg.includes('timed out')
        if (timedOut && retry) {
          console.warn(`[cache:${key}] timeout — retrying once…`)
          inflight = null
          return doFetch({ retry: false })
        }
        console.error(`[cache:${key}]`, e)
        publish({ loading: false, error: e instanceof Error ? e : new Error(msg) })
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  function scheduleRefresh(ms = 350) {
    if (refreshTimer) window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      doFetch()
    }, ms)
  }

  async function refresh({ force = false, background = false } = {}) {
    const fresh = state.loadedAt && Date.now() - state.loadedAt < staleMs
    if (!force && fresh) return state.data
    if (!background && !state.loadedAt) publish({ loading: true })
    await doFetch()
    return state.data
  }

  function mutateLocal(fn) {
    const next = fn(state.data)
    if (next !== state.data) publish({ data: next })
  }

  function setupChannel() {
    if (channel || realtimeTables.length === 0) return
    let ch = supabase.channel(`cache:${key}`)
    for (const table of realtimeTables) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        scheduleRefresh(500)
      })
    }
    ch.subscribe()
    channel = ch
  }

  function teardownChannel() {
    if (channel) {
      try { supabase.removeChannel(channel) } catch { /* ignore */ }
      channel = null
    }
    if (refreshTimer) {
      window.clearTimeout(refreshTimer)
      refreshTimer = null
    }
  }

  function subscribe(fn) {
    listeners.add(fn)
    subCount += 1
    if (subCount === 1) setupChannel()
    // Kick off the first load if we have no data yet AND nothing in-flight.
    // Subsequent subscribers just read the cached state — no new fetch.
    if (!state.loadedAt && !inflight) refresh().catch(() => {})
    // Hand the new subscriber the current snapshot immediately so it renders
    // cached data without waiting for the next publish.
    try { fn(state) } catch { /* ignore */ }
    return () => {
      listeners.delete(fn)
      subCount -= 1
      if (subCount === 0) teardownChannel()
    }
  }

  function reset() {
    state = { data: initial, loading: true, loadedAt: 0, error: null }
    inflight = null
    if (refreshTimer) { window.clearTimeout(refreshTimer); refreshTimer = null }
    for (const fn of listeners) { try { fn(state) } catch { /* ignore */ } }
  }
  _storeResetHandlers.add(reset)

  return { getState: () => state, subscribe, refresh, scheduleRefresh, mutateLocal, reset }
}

function useCachedStore(store) {
  const [snap, setSnap] = useState(() => store.getState())
  useEffect(() => store.subscribe(setSnap), [store])
  return snap
}

// ── Store instances — one per top-level resource ────────────────────────────
const _salesStore = createCachedStore({
  key: 'sales',
  fetcher: () => db.fetchSales(),
  realtimeTables: ['sales'],
})
const _clientsStore = createCachedStore({
  key: 'clients',
  fetcher: () => db.fetchClients(),
  realtimeTables: ['clients'],
})
const _projectsStore = createCachedStore({
  key: 'projects',
  fetcher: () => db.fetchProjects(),
  realtimeTables: ['projects', 'parcels'],
})
const _adminUsersStore = createCachedStore({
  key: 'admin_users',
  fetcher: () => db.fetchAdminUsers(),
  realtimeTables: ['admin_users'],
})
const _offersStore = createCachedStore({
  key: 'offers',
  fetcher: () => db.fetchOffers(),
  realtimeTables: ['project_offers'],
  initial: null,
})
const _installmentsStore = createCachedStore({
  key: 'installments',
  fetcher: () => db.fetchInstallments(),
  realtimeTables: ['installment_plans', 'installment_payments'],
})

// Bus → store: pages that emit `emitInvalidate('sales')` bump the cache.
onInvalidate('sales',            () => _salesStore.refresh({ force: true, background: true }))
onInvalidate('clients',          () => _clientsStore.refresh({ force: true, background: true }))
onInvalidate('projects',         () => _projectsStore.refresh({ force: true, background: true }))
onInvalidate('installmentPlans', () => _installmentsStore.refresh({ force: true, background: true }))

export function useProjects() {
  const { data: projects, loading } = useCachedStore(_projectsStore)
  const refresh = useCallback(() => _projectsStore.refresh({ force: true }), [])
  const updateParcelStatus = useCallback(async (parcelDbId, status) => {
    try {
      await db.updateParcelStatus(parcelDbId, status)
      _projectsStore.scheduleRefresh(250)
      emitInvalidate('projects')
    } catch (e) {
      console.error('updateParcelStatus', e)
    }
  }, [])
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
  const { data: clients, loading } = useCachedStore(_clientsStore)
  const refresh = useCallback(() => _clientsStore.refresh({ force: true }), [])
  const upsert = useCallback(async (client) => {
    const saved = await db.upsertClient(client)
    _clientsStore.scheduleRefresh(250)
    emitInvalidate('clients')
    return saved
  }, [])
  const remove = useCallback(async (clientId) => {
    await db.deleteClient(clientId)
    _clientsStore.mutateLocal((prev) => (prev || []).filter((c) => String(c.id) !== String(clientId)))
    _clientsStore.scheduleRefresh(250)
    emitInvalidate('clients')
  }, [])
  return { clients, loading, refresh, upsert, remove }
}

export function useOffers() {
  const { data: liveOffers, loading, error } = useCachedStore(_offersStore)
  const refresh = useCallback(() => _offersStore.refresh({ force: true }), [])
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
  return { offersByProject, loading, error: error || null, refresh }
}

export function useSales() {
  const { data: sales, loading, error } = useCachedStore(_salesStore)
  const refresh = useCallback(() => _salesStore.refresh({ force: true }), [])

  const create = useCallback(async (sale) => {
    const row = await db.createSale({
      ...sale,
      buyerPhoneNormalized: normalizePhone(sale.buyerPhoneNormalized || sale.buyerPhone || ''),
    })
    // Optimistic: insert the new row at the top immediately, then schedule a
    // background refresh to pick up joined fields the insert didn't return.
    if (row?.id) {
      _salesStore.mutateLocal((prev) => [row, ...(prev || [])])
    }
    _salesStore.scheduleRefresh(350)
    emitInvalidate('sales')
    return row
  }, [])

  const update = useCallback(async (saleId, patch = {}) => {
    await db.updateSale(saleId, patch)
    _salesStore.mutateLocal((prev) => (prev || []).map((s) =>
      String(s.id) === String(saleId) ? { ...s, ...patch } : s
    ))
    _salesStore.scheduleRefresh(350)
    emitInvalidate('sales')
    return { id: saleId, ...patch }
  }, [])

  const remove = useCallback(async (saleId) => {
    await db.deleteSale(saleId)
    _salesStore.mutateLocal((prev) => (prev || []).filter((s) => String(s.id) !== String(saleId)))
    _salesStore.scheduleRefresh(350)
    emitInvalidate('sales')
  }, [])

  return { sales, loading, error: error || null, refresh, create, update, remove }
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
          ? await withTimeout(() => db.fetchSalesScoped({ clientId }), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSalesScoped')
          : await withTimeout(() => db.fetchSales(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSales')
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
            ? await withTimeout(() => db.fetchSalesScoped({ clientId }), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSalesScoped')
            : await withTimeout(() => db.fetchSales(), DEFAULT_FETCH_TIMEOUT_MS, 'fetchSales')
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
    const unsubBus = onInvalidate('sales', () => refresh())
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
      unsubBus()
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
        () => db.fetchSalesBySellerClientId(sellerClientId),
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
          () => db.fetchSalesBySellerClientId(sellerClientId),
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
  const { data: plans, loading } = useCachedStore(_installmentsStore)
  const refresh = useCallback(() => _installmentsStore.refresh({ force: true }), [])
  const createPlan = useCallback(async (plan) => {
    const id = await db.createInstallmentPlan(plan)
    _installmentsStore.scheduleRefresh(250)
    emitInvalidate('installmentPlans')
    return id
  }, [])
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
      const rows = await withTimeout(
        () => db.fetchInstallmentsScoped({ clientId }),
        DEFAULT_FETCH_TIMEOUT_MS,
        'fetchInstallmentsScoped',
      )
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
        const rows = await withTimeout(
          () => db.fetchInstallmentsScoped({ clientId }),
          DEFAULT_FETCH_TIMEOUT_MS,
          'fetchInstallmentsScoped',
        )
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
  const { data: adminUsers, loading, error } = useCachedStore(_adminUsersStore)
  const refresh = useCallback(() => _adminUsersStore.refresh({ force: true }), [])
  const upsert = useCallback(async (user) => {
    const saved = await db.upsertAdminUser(user)
    _adminUsersStore.scheduleRefresh(250)
    return saved
  }, [])
  const remove = useCallback(async (userId) => {
    await db.deleteAdminUser(userId)
    _adminUsersStore.mutateLocal((prev) => (prev || []).filter((u) => String(u.id) !== String(userId)))
    _adminUsersStore.scheduleRefresh(250)
  }, [])
  return { adminUsers, loading, error: error || null, refresh, upsert, remove }
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
      const next = await withTimeout(
        () => db.fetchAmbassadorReferralSummary(),
        DEFAULT_FETCH_TIMEOUT_MS,
        'fetchAmbassadorReferralSummary',
      )
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
        const next = await withTimeout(
          () => db.fetchAmbassadorReferralSummary(),
          DEFAULT_FETCH_TIMEOUT_MS,
          'fetchAmbassadorReferralSummary',
        )
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

/**
 * Detailed commission ledger for the signed-in client: one enriched row per
 * commission_events row where they are the beneficiary. Used by the Parrainage
 * tab to show WHERE each DT comes from (which sale, which filleul, L1 vs L2+).
 */
export function useMyCommissionLedger(clientIdOrEnabled = null) {
  // Back-compat: previously took a boolean `enabled`. Now takes the caller's
  // clientId so staff sessions don't bleed other users' events via RLS bypass.
  // If a boolean is passed we treat it as enabled flag (no explicit id — the
  // fetcher falls back to heal_my_client_profile_now() to self-resolve).
  const explicitId = typeof clientIdOrEnabled === 'string' ? clientIdOrEnabled : null
  const enabled = typeof clientIdOrEnabled === 'boolean' ? clientIdOrEnabled : Boolean(explicitId)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(Boolean(enabled))
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError(null)
    try {
      const rows = await withTimeout(() => db.fetchMyCommissionLedger(explicitId), DEFAULT_FETCH_TIMEOUT_MS, 'fetchMyCommissionLedger')
      setEvents(rows || [])
    } catch (e) {
      console.warn('[useMyCommissionLedger]', e?.message || e)
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [enabled, explicitId])

  useEffect(() => {
    if (!enabled) { setLoading(false); return }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await withTimeout(() => db.fetchMyCommissionLedger(explicitId), DEFAULT_FETCH_TIMEOUT_MS, 'fetchMyCommissionLedger')
        if (!cancelled) setEvents(rows || [])
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    const filter = explicitId ? `beneficiary_client_id=eq.${explicitId}` : undefined
    const channel = supabase
      .channel(`realtime-my-commission-ledger-${explicitId || 'self'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_events', ...(filter ? { filter } : {}) }, () => refresh())
      .subscribe()
    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [enabled, explicitId, refresh])

  return { events, loading, error, refresh }
}
