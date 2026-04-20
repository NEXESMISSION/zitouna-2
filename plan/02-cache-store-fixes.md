## Plan 02 — Cache Store & Data Loading Layer Fixes

### Executive summary

The cache-store layer in [src/lib/useSupabase.js](src/lib/useSupabase.js) is the app's single largest source of "stuck skeleton" bugs: eight bespoke scoped hooks each reinvent fetch/retry/realtime lifecycle slightly wrong, the `createCachedStore` factory silently marks "empty-from-no-JWT" responses as healthy and never revives them, timeouts leak HTTP sockets, and retries only fire on literal timeout errors. This plan consolidates the scoped hooks behind a single `createScopedStore()` factory, introduces abortable timeouts, retry-on-any-error with exponential backoff, a watchdog for long-loading stores, and an `emptyVsLoading` distinction that lets `reviveStale` detect empty-from-no-auth results. Each fix is independently applicable, and the new infrastructure makes future data resources trivial (a ~10-line declaration instead of a 70-line copy-paste). After this plan lands, the app should survive transient network errors, user-switch events mid-fetch, and free-tier Supabase cold starts without the user ever reaching for Ctrl+F5.

### Prerequisites

This plan depends on plan 01 (auth session race fixes) landing first for four items. Before starting, confirm the following utilities exist (plan 01 is responsible for shipping them):

- **`awaitInitialAuth()` upgraded to guarantee a JWT** — today it resolves on a 2 s safety timer with no session. Plan 01 item 1 replaces the safety-timer resolve with a `{ok: false, reason: 'timeout'}` signal so fetchers can branch. Code in this plan that calls `awaitInitialAuth()` assumes the new signature.
- **`waitForAuthedFetch({maxWaitMs})` helper** — the sibling of `awaitInitialAuth` that resolves only when `getUser()` returns a real user. Plan 01 item 2 ships it. Used by scoped hooks that must NOT run without an authed session (e.g. `useMyCommissionLedger`, anything that calls an RLS-scoped RPC). If plan 01 has not landed, fall back to the existing `awaitInitialAuth()` and accept the empty-data risk — but flag every such call site with a `TODO(plan-01)` comment so it can be upgraded later.
- **`_initialAuthPromise` reset path expanded** — plan 01 item 6 teaches the module-scope auth-state listener to reset the promise when a belated `INITIAL_SESSION` arrives after the safety timer already fired. This is a prerequisite for fix 7 below (revive empty-but-loaded stores) to be fully effective.
- **`clientProfile` always resolves to a terminal value** (null, profile, or `{status: 'no-profile'}`) before `RequireCustomerAuth` lets children render — plan 01 item 3. Fix 1 and fix 5 below assume no hook ever mounts with `clientId === null` "because AuthContext is still resolving".

If plan 01 is delayed, this plan is still worth landing as-is. Mark each dependent fix with its `TODO(plan-01)` gate and merge them behind the fallback. The infrastructure (scoped store factory, retry with backoff, watchdog) is valuable independently.

### Plan items

Order is chosen so each item can land independently and deliver value; items that create shared utilities come first. Items 1–3 ship the foundational utilities. Items 4–10 apply them. Items 11–14 are polish.

---

#### 1. Introduce `withAbortableTimeout()` — HIGH

**Root cause.** [src/lib/useSupabase.js:14](src/lib/useSupabase.js:14) races `fetch` against `setTimeout`; timeout rejects the outer promise but the underlying HTTP request keeps running, burning sockets ([finding #4](reserch/02-cache-store-data-layer.md)).

**Target behavior.** Timed-out requests actually cancel so the browser releases the socket. On cancellation the underlying Supabase client sees `AbortError` and cleans up internal state.

**Implementation sketch.**

```js
// src/lib/withAbortableTimeout.js  (new file)
//
// Pattern: caller provides a factory (signal) => promise.
// Supabase client v2 accepts `.abortSignal(signal)` on every query builder,
// so fetcher code becomes:
//   fetchSales: (signal) => db().from('sales').select('*').abortSignal(signal)
//
// For RPCs (db.fetchAmbassadorReferralSummary etc.) wrap the same way.
export async function withAbortableTimeout(factory, { timeoutMs, label }) {
  const controller = new AbortController()
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const run = Promise.resolve(factory(controller.signal))
    return await Promise.race([run, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Custom error class so downstream code can reliably classify.
export class TimeoutError extends Error {
  constructor(message) { super(message); this.name = 'TimeoutError' }
}
```

Update fetchers in [src/lib/db.js](src/lib/db.js) to accept an optional `signal` argument and thread it through to `.abortSignal(signal)` on the query builder. Follow this pattern:

```js
// Before:
export async function fetchSales() {
  const salesRes = await db().from('sales').select('*').order('created_at', ...)
  ...
}
// After:
export async function fetchSales({ signal } = {}) {
  const salesRes = await db().from('sales').select('*')
    .order('created_at', { ascending: false })
    .abortSignal(signal)
  ...
}
```

Fetchers that fire multiple sub-queries (e.g. `fetchSales` does parcels+clients+projects in parallel) should pass `signal` to each. Do this migration top-down from the hot path: `fetchSales`, `fetchClients`, `fetchProjects`, `fetchInstallments`, `fetchAuditLog`, then the scoped variants, then RPCs.

Replace every call site of `withTimeout(factory, ...)` in [src/lib/useSupabase.js](src/lib/useSupabase.js) — currently at lines 194, 1441, 1466, 1516, 1532 — with `withAbortableTimeout((signal) => db.fetchX({signal}), ...)`.

**Verification.**
- DevTools Network tab: throttle to "Slow 3G", load an authed page, immediately navigate away before data arrives. The old "pending" request should flip to "canceled" within the timeout window (12 s) — not linger at "pending" for 30+ seconds.
- `curl` or Supabase dashboard → log server-side query cancellations; confirm they increase when users navigate mid-fetch.

**Rollback plan.** Keep the old `withTimeout` function as `withTimeoutLegacy`. If `withAbortableTimeout` introduces regressions, switch the export in one place. The `signal`-aware fetchers are backward-compatible because `signal` is optional.

**Risk / trade-offs.** Supabase v2 client's `.abortSignal` support was added in late 2023 — confirm the app's `@supabase/supabase-js` version is >= 2.39. Older versions: signal is accepted but not wired through, so abort is best-effort (still better than the current setup because at least the outer promise clears).

**Effort.** M — the utility itself is ~20 lines, but every fetcher in `db.js` needs a signal pass-through. Do it as a mechanical sweep, not one-by-one.

---

#### 2. Replace `fetchWithRetryOnTimeout` with `retryWithBackoff` (retry on any transient error) — HIGH

**Root cause.** [src/lib/useSupabase.js:42](src/lib/useSupabase.js:42): `if (!msg.includes('timed out')) throw e` — only literal timeouts retry. Network blips, stale-JWT 401s, PostgREST 500s, and free-tier rate limits all propagate with no retry ([finding #2](reserch/02-cache-store-data-layer.md)).

**Target behavior.** Any transient error retries up to N times with exponential backoff + jitter. Non-transient errors (4xx RLS rejections with definite status, user-cancel AbortError) propagate immediately.

**Implementation sketch.**

```js
// src/lib/retryWithBackoff.js  (new file)
//
// Classification helpers — call sites can override by passing a custom
// `isTransient`. Default: timeout + network + 5xx + "JWT expired" = transient.
// Definite 4xx (other than 401) and AbortError = not transient.
const TRANSIENT_CODES = new Set(['PGRST301', /* JWT expired */ 'PGRST116' /* empty */])
function defaultIsTransient(e) {
  if (!e) return false
  if (e.name === 'AbortError') return false                 // user cancelled
  if (e.name === 'TimeoutError') return true                // from item #1
  if (String(e.message || '').includes('Failed to fetch')) return true  // network
  if (e.status >= 500) return true
  if (e.status === 401) return true                         // stale JWT
  if (e.code && TRANSIENT_CODES.has(e.code)) return true
  return false
}

export async function retryWithBackoff(factory, {
  label,
  maxAttempts = 3,
  baseDelayMs = 300,
  maxDelayMs = 4000,
  timeoutMs = 12000,
  isTransient = defaultIsTransient,
  onRetry = null,  // optional observability callback
} = {}) {
  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withAbortableTimeout(factory, { timeoutMs, label })
    } catch (e) {
      lastErr = e
      const transient = isTransient(e)
      const hasMore = attempt < maxAttempts
      if (!transient || !hasMore) throw e
      // Exponential backoff with full jitter: delay in [0, 2^attempt * base]
      // capped at maxDelay. Jitter avoids retry-storm synchronization across
      // multiple stores recovering from the same incident.
      const cap = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs)
      const delay = Math.floor(Math.random() * cap)
      if (onRetry) onRetry({ attempt, delay, error: e, label })
      console.warn(`[${label}] attempt ${attempt} failed (${e.message}); retrying in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
```

Wire into `createCachedStore.doFetch` — replace lines 190–216:

```js
// Before (lines 190-216): bespoke two-attempt loop
// After:
const run = async () => {
  try {
    const data = await retryWithBackoff(
      (signal) => fetcher({ signal }),
      { label: `fetch:${key}`, maxAttempts: 3, timeoutMs: DEFAULT_FETCH_TIMEOUT_MS },
    )
    if (myGen !== fetchGen) return
    publish({ data, loading: false, loadedAt: Date.now(), error: null, emptyFromNoAuth: false })
  } catch (e) {
    if (myGen !== fetchGen) return
    console.error(`[cache:${key}]`, e)
    publish({ loading: false, error: e, lastAttemptAt: Date.now() })
  }
}
```

Delete `fetchWithRetryOnTimeout` in [src/lib/useSupabase.js:37-46](src/lib/useSupabase.js:37); callers (every scoped hook) will switch to `createScopedStore` in item 4 and stop calling it.

**Verification.**
- Intentionally revoke the JWT via Supabase dashboard → click a refresh button on an admin page → watch DevTools; you should see retry attempts with increasing delays; the data should populate once Supabase re-issues a token via the existing refresh machinery.
- Unit test: a mock fetcher that fails twice then succeeds; the hook's data arrives; no unhandled rejection in console.

**Rollback plan.** Revert the `doFetch` body to the old two-attempt loop; `retryWithBackoff` file stays but is unused.

**Risk / trade-offs.** More retries = more load on free-tier Supabase during incidents. The jitter + backoff prevents storms, but monitor the `onRetry` callback in production for 1 week and tune `maxAttempts` down to 2 if retry rate exceeds 5 % of fetches.

**Effort.** S — the utility is ~30 lines; the wiring is 1 site in `createCachedStore` plus eventual replacement of scoped hooks (covered by item 4).

---

#### 3. Introduce `safeSubscribe()` wrapper for realtime channels — MEDIUM

**Root cause.** [src/lib/useSupabase.js:263](src/lib/useSupabase.js:263) calls `.subscribe()` with no status handler. `CHANNEL_ERROR`, `CLOSED`, or `TIMED_OUT` from Supabase realtime is silently ignored — the page keeps running on stale data ([finding #11](reserch/02-cache-store-data-layer.md)).

**Target behavior.** Every channel subscription logs terminal statuses and, on error/close, bumps a retry counter and re-subscribes with backoff (up to 3 attempts). After 3 consecutive failures, emit a one-time console.error and mark the store as "realtime-degraded" so UI can show a "data may be stale" hint.

**Implementation sketch.**

```js
// src/lib/safeSubscribe.js  (new file)
//
// Usage:
//   const unsub = safeSubscribe({
//     channelName: `cache:${key}`,
//     attach: (ch) => ch.on('postgres_changes', {...}, onEvent),
//     onStatusChange: (status) => { ... }
//   })
//
// Returns an unsubscribe function. Internally owns the channel lifecycle
// including retries; callers never touch `.subscribe()` directly.
export function safeSubscribe({ channelName, attach, onStatusChange = null, onEvent = null, maxRetries = 3 }) {
  let channel = null
  let retries = 0
  let cancelled = false
  let retryTimer = null
  const build = () => {
    if (cancelled) return
    const ch = supabase.channel(channelName)
    attach(ch)
    ch.subscribe((status, err) => {
      if (onStatusChange) onStatusChange(status, err)
      switch (status) {
        case 'SUBSCRIBED':
          retries = 0
          break
        case 'CHANNEL_ERROR':
        case 'CLOSED':
        case 'TIMED_OUT':
          console.warn(`[realtime:${channelName}] status=${status}`, err)
          if (retries < maxRetries && !cancelled) {
            retries += 1
            const delay = Math.min(500 * Math.pow(2, retries), 8000)
            retryTimer = setTimeout(() => {
              try { supabase.removeChannel(channel) } catch {}
              build()
            }, delay)
          } else if (retries >= maxRetries) {
            console.error(`[realtime:${channelName}] exhausted retries; data may be stale`)
          }
          break
      }
    })
    channel = ch
  }
  build()
  return () => {
    cancelled = true
    if (retryTimer) clearTimeout(retryTimer)
    try { if (channel) supabase.removeChannel(channel) } catch {}
  }
}
```

Replace `.subscribe()` calls in the scoped hooks and `createCachedStore.setupChannel()` with `safeSubscribe`. For `createCachedStore`, the change is:

```js
// Before (lines 248-265):
function setupChannel() {
  ...
  let ch = supabase.channel(`cache:${key}`)
  for (const table of realtimeTables) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => scheduleRefresh(500))
  }
  ch.subscribe()
  channel = ch
}
// After:
function setupChannel() {
  if (channelTeardownTimer) { window.clearTimeout(channelTeardownTimer); channelTeardownTimer = null }
  if (channel || realtimeTables.length === 0) return
  channel = safeSubscribe({
    channelName: `cache:${key}`,
    attach: (ch) => {
      for (const table of realtimeTables) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => scheduleRefresh(500))
      }
    },
    onStatusChange: (status) => { realtimeStatus = status },
  })
}
```

`channel` now holds an unsubscribe function, not a channel object. Update `teardownChannel` accordingly:

```js
function teardownChannel() {
  ...
  channelTeardownTimer = window.setTimeout(() => {
    channelTeardownTimer = null
    if (subCount > 0) return
    try { channel() } catch {}  // channel is an unsub function now
    channel = null
  }, 100)
}
```

**Verification.**
- DevTools → Network → WS tab → throttle to offline; watch console for `CLOSED` log, followed by retry logs.
- Force `CHANNEL_ERROR` by temporarily using an invalid channel name in dev → confirm retry logs.

**Rollback plan.** Keep old `.subscribe()` calls commented alongside. If `safeSubscribe` misbehaves, revert one function at a time.

**Risk / trade-offs.** Auto-retry could mask a persistent server-side issue (e.g. Supabase realtime disabled for a table). Mitigate by logging the final "exhausted retries" error to an observability stream (Sentry if you add it in a future plan) so ops can investigate.

**Effort.** S — the utility is ~40 lines, replaces call sites one at a time.

---

#### 4. Introduce `createScopedStore()` factory; replace 8 bespoke scoped hooks — HIGH

**Root cause.** [src/lib/useSupabase.js:796-992](src/lib/useSupabase.js:796), [src/lib/useSupabase.js:1082-1549](src/lib/useSupabase.js:1082): eight near-duplicate `useSalesScoped`, `useInstallmentsScoped`, `useWorkspaceAudit`, `useAccessGrants`, `useCommissionWorkspace`, `useSellerRelations`, `useAmbassadorReferralSummary`, `useMyCommissionLedger` each implement their own `useState([])`, `useRef(false)`, effect + realtime channel + cleanup. No sharing, no retry-on-any-error, `loadedOnceRef` suppresses skeletons on refetch, `cancelled` flags unreliable across remounts ([findings #1, #3, #16, #17](reserch/02-cache-store-data-layer.md)).

**Target behavior.** One factory produces a hook per resource. The factory accepts `{key, fetcher, realtimeTables, scopeFilter}` and returns a React hook that:
- Shares state across mounts via module-scope store (like `createCachedStore` but scoped by the filter args).
- Uses `retryWithBackoff` + `withAbortableTimeout` by default.
- Uses `safeSubscribe` for realtime.
- Distinguishes `loading=true (never loaded)` from `loading=true (refetching)`.
- Exposes a `useStoreStatus()`-compatible shape: `{data, loading, error, lastFetchedAt, lastAttemptAt, canRetry, retry}`.
- Survives `clientId=null` (returns empty, `loading=false`, `ready=true`) without getting stuck.

**Implementation sketch.**

```js
// src/lib/createScopedStore.js  (new file)
//
// A scoped store keyed by arbitrary filter params. Internally maintains a Map
// of { filterKey -> store } so `useFooScoped({clientId: 'X'})` and
// `useFooScoped({clientId: 'Y'})` get independent state but share one instance
// per clientId across all mounts.
//
// The returned hook is stable: same identity across renders (useMemo safe).
export function createScopedStore({
  key,                    // 'sales' | 'installments' | ...
  fetcher,                // (filters, {signal}) => Promise<rows>
  realtimeTables = [],    // tables whose events invalidate this store
  filterKeyFn = defaultFilterKeyFn,  // serialize filters to cache key
  scopeRequired = false,  // if true, { ready:false } until filters non-empty
  scopeValidator = null,  // (filters) => boolean | 'waiting'; see below
}) {
  const stores = new Map()  // filterKey -> store

  function getStore(filters) {
    const fk = filterKeyFn(filters)
    let s = stores.get(fk)
    if (!s) {
      s = buildStoreInstance({ key: `${key}:${fk}`, fetcher, filters, realtimeTables })
      stores.set(fk, s)
    }
    return s
  }

  // Hook factory.
  return function useScoped(filters = {}) {
    // Early-out: scope not yet ready (e.g. clientId=null because clientProfile
    // is still resolving). Must distinguish "waiting for scope" from "scope
    // says return empty". See the scope-validator contract below.
    const scopeState = scopeValidator ? scopeValidator(filters) : 'ok'
    // scopeState can be:
    //   'ok'       — filters are valid, proceed to fetch
    //   'waiting'  — caller doesn't have enough info yet (e.g. clientId=null
    //                because profile is still resolving); return loading=true
    //   'empty'    — caller explicitly wants no rows (e.g. clientId='' means
    //                "filter by none"); return loading=false, data=[]
    if (scopeState === 'empty') {
      return { data: [], loading: false, ready: true, error: null, refresh: () => Promise.resolve() }
    }
    if (scopeState === 'waiting') {
      // Do NOT call getStore — no fetch fires. Return a stable "loading" tuple
      // so consumers render skeletons consistently.
      return { data: [], loading: true, ready: false, error: null, refresh: () => Promise.resolve() }
    }

    const store = getStore(filters)
    const [snap, setSnap] = useState(() => store.getState())
    useEffect(() => {
      return store.subscribe(setSnap)
    }, [store])
    const refresh = useCallback(() => store.refresh({ force: true }), [store])
    return {
      data: snap.data,
      loading: snap.loading,
      ready: snap.loadedAt > 0 || snap.error !== null,
      error: snap.error,
      lastFetchedAt: snap.loadedAt,
      lastAttemptAt: snap.lastAttemptAt,
      refresh,
    }
  }
}

function defaultFilterKeyFn(filters) {
  // Stable JSON key — sort object keys to avoid {a,b} ≠ {b,a}.
  const entries = Object.entries(filters || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  entries.sort(([a], [b]) => a.localeCompare(b))
  return entries.length === 0 ? '_' : JSON.stringify(entries)
}

function buildStoreInstance({ key, fetcher, filters, realtimeTables }) {
  // Mirrors createCachedStore but:
  //   - fetcher is called with (filters, {signal}) not ()
  //   - realtime payloads trigger scheduleRefresh(500) same as cached store
  //   - state shape adds `emptyFromNoAuth`, `lastAttemptAt` (see item #7, #8)
  //   - reset handler is registered in _storeResetHandlers for user-switch
  ... // same structure as createCachedStore, parameterized
}
```

Migration table — replace each bespoke hook with a `createScopedStore` declaration. Numbers in brackets are line ranges in [useSupabase.js](src/lib/useSupabase.js) that will be deleted.

| Hook | Lines | New declaration |
|---|---|---|
| `useSalesScoped` | 796-869 | `const _s = createScopedStore({key:'sales-scoped', fetcher:(f,{signal})=>f.clientId?db.fetchSalesScoped({clientId:f.clientId,signal}):db.fetchSales({signal}), realtimeTables:['sales'], scopeValidator: (f)=> f.clientId==null?'empty':(f.clientId===''?'waiting':'ok')})` |
| `useInstallmentsScoped` | 936-992 | `const _s = createScopedStore({key:'installments-scoped', fetcher:(f,{signal})=>db.fetchInstallmentsScoped({clientId:f.clientId,signal}), realtimeTables:['installment_plans','installment_payments'], scopeValidator:(f)=>(f.clientId==null?'waiting':(f.clientId===''?'empty':'ok'))})` |
| `useWorkspaceAudit` | 1082-1152 | no filters; fetcher is `db.fetchAuditLog`, realtimeTables `['audit_logs']` |
| `useAccessGrants` | 1154-1214 | fetcher returns `{grants, auditLog}` shape; realtimeTables `['page_access_grants']` |
| `useCommissionWorkspace` | 1216-1291 | returns `{commissionEvents, payoutRequests}`; realtimeTables `['commission_events','commission_payout_requests','commission_payout_request_items']` |
| `useSellerRelations` | 1293-1347 | realtimeTables `['seller_relations']` |
| `useAmbassadorReferralSummary` | 1415-1493 | fetcher is `db.fetchAmbassadorReferralSummary`; see scope note below |
| `useMyCommissionLedger` | 1500-1549 | filter keys `{clientId}`; scopeValidator handles `typeof==='boolean'` back-compat |

**Scope-validator contract.** Crucial for fix 5. `scopeValidator(filters)` returns one of three strings:
- `'ok'` — fetch normally
- `'waiting'` — return `{loading:true, data:[], ready:false}` without firing a fetch. Caller should poll for filter change.
- `'empty'` — return `{loading:false, data:[], ready:true}` without firing a fetch. Represents "filter says no data possible".

The distinction matters because `clientId=null` during auth resolution and `clientId=''` meaning "no filter" look identical otherwise. Plan 01 item 3 should make this unambiguous by having AuthContext store `clientProfile=null | {id}` and never return an empty string during loading.

Write one mutation method per hook (e.g. `useSales.create`, `useInstallments.createPlan`) as thin wrappers that call `db.*`, then `store.scheduleRefresh(350)`, then `emitInvalidate(key)`. Copy the optimistic-with-rollback pattern from the existing [`useSales.create`](src/lib/useSupabase.js:704) — it's already correct.

For `useAmbassadorReferralSummary`, the existing `inflightRef` sequence-number guard (finding #18, no bug) becomes free once state lives in a shared store.

**Verification.**
- Navigate `/admin/clients` → `/admin/finance` → back to `/admin/clients` rapidly. Each page loads instantly after the first fetch (data is shared).
- Open two tabs side by side as the same user, create a sale in tab A; tab B's sales list updates within ~500ms via realtime.
- Switch users in tab A (logout, login as different user). Confirm sales from user A are gone in tab A immediately (reset handler fires).
- Intentionally pass `clientId=null` to a scoped hook (e.g. mock `useAuth` to return unresolved profile); component renders skeleton, not stuck.

**Rollback plan.** Keep the bespoke hooks (renamed `useSalesScopedLegacy` etc.) in a branch. Flip a feature flag at the export line to switch between new and old implementations.

**Risk / trade-offs.** Behavioural change: scoped hooks now share state. A page that relied on "each mount refetches" will see cached data first. Audit each consumer: if a caller does `window.location.reload()` expecting fresh data, it still works; if a caller calls `refresh()` expecting a full refetch, it still works because `{force:true}` bypasses the staleness check. Nothing to change in consumers — but test the migration carefully.

**Effort.** L — this is the biggest item. Budget 2–3 days with thorough testing. Migrate one hook at a time, land each PR, bake for a day, then the next.

---

#### 5. Fix `clientId=null` early-return leaving `loading=true` — CRITICAL

**Root cause.** [src/lib/useSupabase.js:942-945](src/lib/useSupabase.js:942) and [src/lib/useSupabase.js:806-808](src/lib/useSupabase.js:806): scoped hooks early-return on `clientId==null` without setting `loading=false`. For hybrid staff+buyer users whose `clientProfile` heal takes >5 s, the skeleton never resolves ([finding #16](reserch/02-cache-store-data-layer.md)).

**Target behavior.** If item 4 ships, this is automatic — `scopeValidator` returns `'waiting'` or `'empty'` and the hook returns the correct state. If item 4 is deferred, apply this patch inline.

**Implementation sketch.** Inline patch if `createScopedStore` is not yet available:

```js
// useInstallmentsScoped, useSalesScoped: update the early-return branches.
// Before:
if (clientId == null || clientId === '') {
  setPlans([])
  return
}
// After:
if (clientId === null || clientId === undefined) {
  // Auth still resolving — keep showing skeleton, wait for clientId change.
  return
}
if (clientId === '') {
  // Explicit empty — no rows possible.
  setPlans([])
  setLoading(false)
  return
}
```

The real fix is in `AuthContext`: ensure `clientProfile` is never in an ambiguous state once `ready=true`. See plan 01 item 3. Every consumer should read `clientProfile?.id ?? null` where `null` unambiguously means "not a buyer".

**Verification.**
- Login as hybrid staff+buyer whose heal takes artificially long (add `pg_sleep(10)` to `heal_my_client_profile_now`). Navigate to `/dashboard/installments`. The page shows a skeleton for up to 10 seconds then renders. Previously: skeleton forever.
- Login as pure-staff user (no client profile). Navigate to `/dashboard/installments`. Should show the "no data" empty state after <1 s, not a stuck skeleton.

**Rollback plan.** Revert the inline branch to the old version.

**Risk / trade-offs.** Depends on plan 01. If plan 01 doesn't clean up the `clientProfile` ambiguity, `clientId=''` could mean either "no filter" or "no profile yet" and this fix alone is insufficient. Combining this fix with the scope validator from item 4 handles both cases explicitly.

**Effort.** S — once item 4 is in place, this is automatic. Standalone: 1 hour per hook.

---

#### 6. Kill `loadedOnceRef` skeleton suppression on refetch — HIGH

**Root cause.** [src/lib/useSupabase.js:800,803,830,874,878](src/lib/useSupabase.js:800): `setLoading(!loadedOnceRef.current)` means after the first load, refetches set `loading=false`, so the skeleton never shows and the user has no feedback that work is happening ([finding #3](reserch/02-cache-store-data-layer.md)).

**Target behavior.** Distinguish initial load skeleton ("never had data — show skeleton") from refetch indicator ("have data, fetching newer — show subtle spinner or stale badge"). Components opt into the refetch indicator via `isRefreshing`.

**Implementation sketch.** The store state gains `isRefreshing` alongside `loading`:

```js
// Before (in createCachedStore.refresh):
if (!background && !state.loadedAt) publish({ loading: true })
await doFetch()

// After:
if (!background && !state.loadedAt) {
  publish({ loading: true, isRefreshing: false })
} else {
  publish({ isRefreshing: true })
}
await doFetch()
// doFetch's publish clears both: { loading: false, isRefreshing: false }
```

Hooks expose both flags:

```js
return {
  sales, loading, isRefreshing,  // <-- new
  refresh,
  ...
}
```

UI convention:
- `loading && !data.length` → full skeleton
- `isRefreshing && data.length > 0` → subtle top-right spinner or "updating…" badge
- `loading=false && data.length === 0` → empty state with a "Retry" button if `error` is set

Components that need a manual refresh indicator can use `useStoreStatus()` from item 12.

**Verification.**
- Click a manual "Refresh" button on an admin page → spinner appears in corner, data updates when fetch resolves. No skeleton flash if data already rendered.
- Cause the refetch to error → data stays visible, error banner appears, no stuck skeleton.

**Rollback plan.** Remove `isRefreshing` from the publish path; UI ignores it.

**Risk / trade-offs.** Every page that currently destructures `{sales, loading}` gets one more field. Backward compatible (extra keys are ignored by existing consumers). Opt-in to the new indicator one page at a time.

**Effort.** S — ~20 lines in `createCachedStore` + docs.

---

#### 7. Distinguish `emptyFromNoAuth` from `loaded=[]`; fix `reviveStale` — HIGH

**Root cause.** [src/lib/useSupabase.js:353-360](src/lib/useSupabase.js:353): `reviveStale` treats any `{error=null, loading=false, loadedAt>0}` store as healthy, even when `data=[]` because the first fetch ran without a JWT ([finding #7](reserch/02-cache-store-data-layer.md)).

**Target behavior.** The store tracks *why* the last fetch returned `[]`. Only `emptyFromNoAuth=true` is considered unhealthy by `reviveStale`; `emptyFromAuthedFetch` with genuine no-rows is considered healthy.

**Implementation sketch.** Add `emptyFromNoAuth` to store state. The fetcher wrapper determines it:

```js
// In createCachedStore.doFetch, around the fetch call:
const run = async () => {
  // Require a genuine authed session before publishing a non-empty result
  // as "healthy". `awaitInitialAuth` (upgraded in plan 01 item 1) returns
  // `{ok, reason}`; fall back to no-JWT empty if reason === 'timeout'.
  const auth = await awaitInitialAuth()
  try {
    const data = await retryWithBackoff(
      (signal) => fetcher({ signal }),
      { label: `fetch:${key}`, ... }
    )
    if (myGen !== fetchGen) return
    const emptyFromNoAuth = Array.isArray(data) && data.length === 0 && auth.ok !== true
    publish({
      data,
      loading: false,
      loadedAt: Date.now(),
      error: null,
      emptyFromNoAuth,
    })
  } catch (e) {
    ...
  }
}
```

`reviveStale` adds `emptyFromNoAuth` to its revival conditions:

```js
// Before:
if (st.error || (st.loading && !st.loadedAt) || stale) { ... }
// After:
if (st.error || (st.loading && !st.loadedAt) || stale || st.emptyFromNoAuth) {
  s.refresh({ force: true, background: Boolean(st.loadedAt) }).catch(() => {})
}
```

Also: when the belated `INITIAL_SESSION` fires (after plan 01 item 6 teaches the auth-state listener to re-resolve `_initialAuthPromise`), immediately call `reviveStale('auth:delayed-session')` — which will now refresh every store with `emptyFromNoAuth=true`.

**Verification.**
- Throttle Network to "Slow 3G"; cold-load an authed page. Observe in DevTools console: first fetch returns `[]` with `emptyFromNoAuth=true`. When the JWT eventually arrives, `reviveStale` fires and the data populates within 1–2 s.
- Verify the genuine empty-data case still works: user with zero sales should not trigger infinite revival loops. Look for `emptyFromNoAuth=false` in that case.

**Rollback plan.** Remove `emptyFromNoAuth` from state and revert `reviveStale` condition.

**Risk / trade-offs.** Requires plan 01 items 1 and 6 for full effectiveness. Without plan 01, `auth.ok` check always falls through and `emptyFromNoAuth` is always `true` → revival loops until the JWT arrives, which is actually the desired behavior but logs noise. Tune throttling if log noise bothers you.

**Effort.** S — ~15 lines.

---

#### 8. Add a watchdog for stuck-loading stores — MEDIUM

**Root cause.** [src/lib/useSupabase.js:405-420](src/lib/useSupabase.js:405): `useConnectionHealth` just sets a `slow` flag; no code actually does anything about it. Combined with the 3-second `reviveStale` throttle ([finding #6](reserch/02-cache-store-data-layer.md)), a truly stuck store can sit `loading=true, loadedAt=0` for 8+ seconds before the user alt-tabs to trigger revival.

**Target behavior.** A module-scope timer checks every 2 s for stores that have been `loading=true && loadedAt=0` for more than `WATCHDOG_MS` (default 8000). If found, force a refresh — independent of visibility or focus events.

**Implementation sketch.**

```js
// Add to useSupabase.js near the reviveStale block (~line 342).
const WATCHDOG_MS = 8000
if (typeof window !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const s of _allCachedStores) {
      const st = s.getState()
      if (st.loading && !st.loadedAt && !st.error) {
        // Track firstLoadingAt on the handle so we can age stores.
        if (!s._loadingStartedAt) s._loadingStartedAt = now
        if (now - s._loadingStartedAt > WATCHDOG_MS) {
          console.warn(`[watchdog:${s.key}] stuck loading for ${now - s._loadingStartedAt}ms; forcing refresh`)
          s._loadingStartedAt = now  // reset so we don't spam every tick
          try {
            s.refresh({ force: true, background: false }).catch(() => {})
          } catch {}
        }
      } else {
        s._loadingStartedAt = 0
      }
    }
  }, 2000)
}
```

Pair with a UI component from plan 07 (watchdog UI) that listens to `useStoreStatus()` (item 12) and shows a "Taking longer than usual — retrying…" hint.

**Verification.**
- Block network requests for the Supabase host in DevTools. Load a page. After 8 s, watchdog logs a warning and kicks off a refresh attempt; user sees a "retrying" indicator.
- Under normal conditions, no watchdog logs at all.

**Rollback plan.** Remove the `setInterval` block.

**Risk / trade-offs.** The 2-second poll is lightweight (reads getState only) but if 20+ stores exist it adds up. Tune the interval to 3 s if perf profiling shows impact.

**Effort.** S — ~25 lines.

---

#### 9. Fix race between `reset()` and in-flight fetches — MEDIUM

**Root cause.** [src/lib/useSupabase.js:192-216](src/lib/useSupabase.js:192): the retry loop only checks `myGen !== fetchGen` after each await. If `reset()` fires between attempt 1's timeout and attempt 2 starting, attempt 2 still runs (waste) and only returns at the final check ([finding #5](reserch/02-cache-store-data-layer.md)).

**Target behavior.** The retry loop checks `myGen !== fetchGen` at the top of every iteration — if it changed, bail out immediately.

**Implementation sketch.**

```js
// Inside retryWithBackoff or doFetch:
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  if (shouldCancel && shouldCancel()) return null  // new: cancel check
  try {
    return await withAbortableTimeout(factory, ...)
  } catch (e) {
    // Only retry if transient AND not cancelled.
    if (!isTransient(e) || attempt === maxAttempts) throw e
    if (shouldCancel && shouldCancel()) return null
    await sleep(delay)
  }
}

// In createCachedStore.doFetch:
const myGen = fetchGen
const result = await retryWithBackoff(
  (signal) => fetcher({ signal }),
  { ..., shouldCancel: () => myGen !== fetchGen }
)
if (myGen !== fetchGen) return
```

Additionally, `reset()` (line 306) should call `controller.abort()` on any in-flight `AbortController`. Track it:

```js
let inflightController = null  // at store scope
function doFetch() {
  if (inflight) return inflight
  const controller = new AbortController()
  inflightController = controller
  ...
}
function reset() {
  fetchGen += 1
  if (inflightController) {
    try { inflightController.abort() } catch {}
    inflightController = null
  }
  ...
}
```

**Verification.**
- Login as user A, trigger a slow fetch (throttle Network), immediately logout and login as user B. Verify DevTools Network shows user A's request as "canceled", not "pending".
- Verify user B's store state does not contain any of user A's data even transiently.

**Rollback plan.** Revert to the old `if (myGen !== fetchGen)` check only after each await.

**Risk / trade-offs.** AbortController on user switch means the user might briefly see "loading" again — intended behavior. Make sure the UI handles `loading` after a successful data render without flashing.

**Effort.** S — ~10 lines.

---

#### 10. Fix `useAccessGrants` missing `cancelled` flag in effect — MEDIUM

**Root cause.** [src/lib/useSupabase.js:1180-1189](src/lib/useSupabase.js:1180): initial `refresh()` fires without a `cancelled` guard. On rapid unmount, setState fires on unmounted component ([finding #17](reserch/02-cache-store-data-layer.md)).

**Target behavior.** No setState after unmount. Clean cleanup on route change.

**Implementation sketch.** If item 4 (createScopedStore) has shipped, `useAccessGrants` becomes a one-line declaration and this is automatic. If not:

```js
// Patch the effect at line 1180:
useEffect(() => {
  let cancelled = false
  ;(async () => {
    if (cancelled) return
    try {
      await refresh()
    } catch {}  // refresh swallows internally
  })()
  const channel = supabase.channel('page-access-grants')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'page_access_grants' }, () => {
      if (!cancelled) void refresh()
    })
    .subscribe()
  return () => {
    cancelled = true
    supabase.removeChannel(channel)
  }
}, [refresh])
```

Also update `refresh` itself to accept a cancel token if used outside an effect — but since item 4 obviates this, don't go deeper.

**Verification.** Spam route transitions in/out of the AccessGrants page. No React warnings about setState on unmounted component.

**Rollback plan.** Keep old version.

**Risk / trade-offs.** None.

**Effort.** S — 5 minutes.

---

#### 11. Harden module-scope state against Vite HMR — MEDIUM

**Root cause.** [src/lib/useSupabase.js:150-154](src/lib/useSupabase.js:150), [src/lib/useSupabase.js:438-468](src/lib/useSupabase.js:438): module re-evaluation under HMR creates new `_salesStore`/`_clientsStore` etc. alongside the old ones. Old and new are both subscribed to realtime. Pages pick up whichever module instance they imported first ([finding #8](reserch/02-cache-store-data-layer.md)).

**Target behavior.** In dev, reuse the existing store instances across HMR updates.

**Implementation sketch.** Stash stores on `globalThis` with a stable key.

```js
// Near the top of useSupabase.js, above `_storeResetHandlers`:
const HMR_KEY = '__zitouna_cache_stores__'
const hmrGlobal = typeof globalThis !== 'undefined' ? globalThis : window
if (!hmrGlobal[HMR_KEY]) {
  hmrGlobal[HMR_KEY] = {
    resetHandlers: new Set(),
    allStores: new Set(),
    stores: new Map(),
  }
}
const _storeResetHandlers = hmrGlobal[HMR_KEY].resetHandlers
const _allCachedStores = hmrGlobal[HMR_KEY].allStores
const _namedStores = hmrGlobal[HMR_KEY].stores

// Replace direct `createCachedStore` calls (lines 438-468) with a reuse guard:
function getOrCreateStore(key, options) {
  let store = _namedStores.get(key)
  if (store) return store
  store = createCachedStore({ key, ...options })
  _namedStores.set(key, store)
  return store
}
const _salesStore = getOrCreateStore('sales', { fetcher: (opts)=>db.fetchSales(opts), realtimeTables: ['sales'] })
// ... same for clients, projects, adminUsers, offers, installments
```

Clean up teardown for the old channel in the `createCachedStore.reset()` path: if `channel` was already subscribed, unsubscribe before the caller creates a new one. This is already handled by `setupChannel`'s `channel || ...` guard, so no change there.

Also add an HMR dispose hook:

```js
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // Tear down channels so a fresh module re-subscribes cleanly.
    for (const s of _allCachedStores) {
      try { s.reset() } catch {}
    }
  })
}
```

**Verification.**
- Save [useSupabase.js](src/lib/useSupabase.js) repeatedly in dev. Monitor DevTools Network WS tab → no duplicate `cache:sales` channel subscriptions.
- Console should not log "channel already subscribed" warnings.

**Rollback plan.** Remove the globalThis stash; behavior reverts to current.

**Risk / trade-offs.** Dev-only. Prod bundles don't hit HMR. If the stash gets corrupted (e.g. partial HMR update where the shape changed), a hard refresh restores sanity.

**Effort.** M — ~40 lines. Needs dev-only testing.

---

#### 12. Introduce `useStoreStatus()` hook — MEDIUM

**Root cause.** Components each implement their own loading/error/retry UI glue. There's no shared primitive for "show a retry button if the fetch failed and we have no cached data".

**Target behavior.** Components can subscribe to any store and get `{loading, isRefreshing, data, error, lastFetchedAt, lastAttemptAt, canRetry, retry, nextRetryAt}` as a stable object.

**Implementation sketch.**

```js
// In useSupabase.js or a new src/lib/useStoreStatus.js:
export function useStoreStatus(store) {
  // `store` is the handle returned by createCachedStore or createScopedStore.
  const [snap, setSnap] = useState(() => store.getState())
  useEffect(() => store.subscribe(setSnap), [store])
  const retry = useCallback(() => store.refresh({ force: true }), [store])
  return {
    data: snap.data,
    loading: snap.loading,
    isRefreshing: snap.isRefreshing || false,
    error: snap.error,
    lastFetchedAt: snap.loadedAt,
    lastAttemptAt: snap.lastAttemptAt,
    canRetry: Boolean(snap.error) || snap.emptyFromNoAuth,
    // nextRetryAt is computed by the watchdog + backoff scheduler; expose if
    // you extend the store to track it. For MVP, omit and let retry be manual.
    retry,
  }
}
```

Consumers use it like:

```js
function SalesPage() {
  const { data: sales, loading, isRefreshing, error, canRetry, retry } = useStoreStatus(_salesStore)
  if (loading && !sales.length) return <Skeleton />
  if (error && !sales.length) return <ErrorBanner onRetry={retry} />
  return (
    <>
      {isRefreshing && <TopBarIndicator />}
      <SalesList rows={sales} />
    </>
  )
}
```

**Verification.**
- Refactor one admin page (suggest [ClientsPage.jsx](src/admin/pages/ClientsPage.jsx)) to use `useStoreStatus`; verify it behaves identically. Then optionally migrate other pages in plan 03.

**Rollback plan.** Keep the existing `useClients()` hook untouched; `useStoreStatus` is additive.

**Risk / trade-offs.** Duplicate pathways (`useClients` and `useStoreStatus(_clientsStore)`) until migration completes. Document which is the preferred primitive.

**Effort.** S — ~15 lines.

---

#### 13. Fix `usePublicBrowseProjects` initial load does not clear stale projects on error — LOW

**Root cause.** [src/lib/useSupabase.js:520-529](src/lib/useSupabase.js:520): the initial-load IIFE catches errors but only `console.error`s — the `projects` state is never cleared. On first load this is fine (stays `[]`). But if the hook remounts with a prior state (e.g. via StoreProvider migration), stale data persists ([finding #13](reserch/02-cache-store-data-layer.md)).

**Target behavior.** On load error, clear to `[]` AND surface a user-visible error state.

**Implementation sketch.**

```js
// src/lib/useSupabase.js line 501:
export function usePublicBrowseProjects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await db.fetchPublicCatalogProjects()
      setProjects(data)
    } catch (e) {
      console.error('fetchPublicCatalogProjects', e)
      setProjects([])
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await db.fetchPublicCatalogProjects()
        if (!cancelled) setProjects(data)
      } catch (e) {
        console.error('fetchPublicCatalogProjects', e)
        if (!cancelled) {
          setProjects([])
          setError(e)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    ...
  }, [refresh])

  return { projects, loading, error, refresh }
}
```

**Verification.** Force `db.fetchPublicCatalogProjects` to throw; confirm the browse page shows an error banner instead of an empty catalog.

**Rollback plan.** Trivial.

**Risk / trade-offs.** Components that destructure `{projects, loading}` ignore the new `error` field — backward compatible.

**Effort.** S — 10 minutes.

---

#### 14. Clarify `useMyCommissionLedger` signature; deprecate boolean form — LOW

**Root cause.** [src/lib/useSupabase.js:1500-1549](src/lib/useSupabase.js:1500): accepts `string | boolean`; fragile. Empty string would treat as "enabled=false" by luck ([finding #19](reserch/02-cache-store-data-layer.md)).

**Target behavior.** Accept `{clientId, enabled}` options object. Deprecate the boolean form with a console.warn in dev.

**Implementation sketch.**

```js
export function useMyCommissionLedger(optsOrLegacy) {
  let opts
  if (optsOrLegacy === null || optsOrLegacy === undefined) {
    opts = { clientId: null, enabled: true }
  } else if (typeof optsOrLegacy === 'boolean') {
    if (import.meta.env.DEV) console.warn('useMyCommissionLedger(boolean) is deprecated; pass {clientId, enabled}')
    opts = { clientId: null, enabled: optsOrLegacy }
  } else if (typeof optsOrLegacy === 'string') {
    if (import.meta.env.DEV) console.warn('useMyCommissionLedger(clientId) is deprecated; pass {clientId}')
    opts = { clientId: optsOrLegacy, enabled: Boolean(optsOrLegacy) }
  } else {
    opts = { clientId: null, enabled: true, ...optsOrLegacy }
  }
  const { clientId, enabled } = opts
  // ... existing body using clientId, enabled
}
```

Update all ~5 call sites (`Grep` for `useMyCommissionLedger(` in `src/`) to pass the object form.

**Verification.** Lint + grep for call sites; all pass the object form; dev warnings are silent.

**Rollback plan.** Keep both forms; revert the deprecation warning.

**Risk / trade-offs.** Nil.

**Effort.** S — 30 minutes including call-site updates.

---

### New infrastructure to introduce

A recap of the shared utilities introduced by this plan. Each belongs in its own file under `src/lib/` so they can be imported independently from other plans.

- **[src/lib/withAbortableTimeout.js](src/lib/withAbortableTimeout.js)** (item 1) — replaces the setTimeout-only `withTimeout`. Uses AbortController to actually cancel. Exports `withAbortableTimeout(factory, {timeoutMs, label})` and a `TimeoutError` class.

- **[src/lib/retryWithBackoff.js](src/lib/retryWithBackoff.js)** (item 2) — retry-on-any-transient-error with exponential backoff + jitter. Exports `retryWithBackoff(factory, opts)` and `defaultIsTransient(e)`.

- **[src/lib/safeSubscribe.js](src/lib/safeSubscribe.js)** (item 3) — wraps Supabase realtime channels with status handling, retry-on-close, and degradation flag. Exports `safeSubscribe({channelName, attach, onStatusChange})`.

- **[src/lib/createScopedStore.js](src/lib/createScopedStore.js)** (item 4) — the single factory that replaces 8+ bespoke scoped hooks. Parameterized by fetcher + filters + realtime tables + scope validator. Each scoped store gets abort, retry, shared state, and watchdog semantics for free.

- **[src/lib/waitForAuthedFetch.js](src/lib/waitForAuthedFetch.js)** — prerequisite from plan 01, but this plan's stores call it. Contrast with `awaitInitialAuth`: resolves only when `supabase.auth.getUser()` returns a user, times out with a clear `reason: 'no-session'` error. Never resolves "auth-less" on a 2-second timer. Called inside `createCachedStore.doFetch` for stores whose RLS would reject without auth.

- **Watchdog interval** (item 8) — runs every 2 s; for each store stuck `loading=true, loadedAt=0` longer than 8 s, force a background refresh. Lives inside [useSupabase.js](src/lib/useSupabase.js).

- **`emptyVsLoading` state distinction** (item 7) — `{emptyFromNoAuth: bool}` on every store snapshot. `reviveStale` uses it to identify stores that completed a fetch without a real session.

- **[src/lib/useStoreStatus.js](src/lib/useStoreStatus.js)** (item 12) — a hook components subscribe to, exposing `{loading, isRefreshing, data, error, lastFetchedAt, canRetry, retry}`. Components use this to render uniform retry UIs.

- **HMR-safe globalThis stash** (item 11) — prevents duplicate stores under Vite HMR in dev.

- **Store-level `isRefreshing` flag** (item 6) — distinguishes initial skeleton from background refetch.

### Migration guide for new hooks

The old pattern (~70 lines per hook) is now obsolete. For a new data resource "Foo":

1. Define the fetcher in [src/lib/db.js](src/lib/db.js) accepting `{signal}`:

   ```js
   export async function fetchFoos({ signal, filters = {} } = {}) {
     const res = await db().from('foos').select('*')
       .eq('something', filters.something)
       .abortSignal(signal)
     return throwIfError(res, 'fetchFoos')
   }
   ```

2. Create the store hook in [useSupabase.js](src/lib/useSupabase.js):

   ```js
   export const useFoosScoped = createScopedStore({
     key: 'foos',
     fetcher: (filters, { signal }) => db.fetchFoos({ filters, signal }),
     realtimeTables: ['foos'],
     scopeValidator: (filters) => filters.something == null ? 'waiting' : 'ok',
   })
   ```

3. Use in a component:

   ```js
   function FooPage() {
     const { data: foos, loading, error, refresh } = useFoosScoped({ something: 'x' })
     if (loading && !foos.length) return <Skeleton />
     if (error) return <ErrorBanner onRetry={refresh} />
     return <FooList items={foos} />
   }
   ```

That's it. No `useState`, no `useRef(false)`, no bespoke effect with cancellation flag, no channel setup, no error-swallow. Retry, abort, realtime, watchdog, and user-switch reset are handled by the factory.

### Patterns to follow

- **Always accept `{signal}` in a fetcher.** Even if you don't need abort today, you will once the watchdog fires a preemptive retry.
- **Always return `throwIfError(res, label)`.** The uniform error shape lets `retryWithBackoff` classify transience.
- **Realtime channel names include the scope key.** E.g. `realtime-foos-${clientId}`, not `realtime-foos`. Supabase deduplicates by name, and two different scopes sharing a channel name cause cross-contamination.
- **Use `emitInvalidate(key)` after every mutation.** This is what makes cross-page updates near-instant — do not rely solely on Supabase realtime replication.
- **Treat `loading && data.length>0` as "refreshing".** Render the existing data; show a subtle indicator. Don't blank out the UI.
- **Treat `error && data.length>0` as "stale-with-error".** Render existing data; show an error banner offering a retry.
- **Check `ready` (or `loadedAt>0`) before deriving memoized output from `data`.** If `data=[]` because we haven't loaded yet, the derivation will be wrong.

### Anti-patterns to avoid

- **`useState([])` + `useState(true)` at the top of a new hook.** You are re-implementing `createScopedStore`. Stop. Use the factory.
- **`useRef(false)` to suppress re-skeletoning on refetch.** The new `isRefreshing` flag handles this. Never have "the skeleton only shows once".
- **`if (!clientId) return;` inside an async effect.** This leaves `loading=true` forever. Use `scopeValidator` instead.
- **`cancelled = true` flags as the only protection.** Fine for remount races, but not for actual request cancellation. Use AbortController.
- **`.catch(() => {})` on every await.** Silently swallows transient errors that should trigger a retry. Let errors propagate to `retryWithBackoff`.
- **Fetching inside `useMemo`.** React does not guarantee memo re-runs; a fetch here is both wasteful and racy. Always fetch in `useEffect` or in a dedicated store.
- **Calling `supabase.channel(...).subscribe()` directly.** Use `safeSubscribe` so you automatically handle CHANNEL_ERROR/CLOSED.
- **Treating `setLoading(!loadedOnceRef.current)` as "only show skeleton the first time".** It is, but the user sees nothing during subsequent refetches. Use `isRefreshing`.
- **`fetchWithRetryOnTimeout` (deprecated).** Only retried on literal timeout string. Replace with `retryWithBackoff`.
- **Passing boolean flags that also double as data (`useMyCommissionLedger(true)`).** Use named options objects.

### Out of scope

These issues are adjacent but belong in other plans:

- **Auth session race conditions** ([plan 01](reserch/01-auth-session-races.md)). `awaitInitialAuth`'s 2-second safety timer, Web Lock contention, `ensureCurrentClientProfile` without timeout — all live in plan 01. This plan assumes plan 01 has shipped the `awaitInitialAuth` and `waitForAuthedFetch` upgrades.
- **Admin page-level stuck UIs.** Components like [ClientsPage.jsx](src/admin/pages/ClientsPage.jsx) that render stuck skeletons when the store has `loading=false` but `data=[]` are plan 03. This plan fixes the store layer; plan 03 fixes page-level rendering decisions.
- **Customer/public page stuck UIs.** Same as above for [CustomerDashboard](src/pages), plan 04.
- **Lazy-loading and code-split suspense traps.** Plan 05. This plan's `useStoreStatus` is the primitive plan 05's suspense fallbacks will use.
- **Skeleton CSS + uniform shimmer.** Plan 06. Components are free to continue using `.sp-sk-*` classes; this plan changes the conditions under which the skeleton renders, not its styling.
- **Watchdog UI banner** ("taking longer than usual…"). Plan 07. This plan ships the watchdog timer; plan 07 wires it to UI.
- **Supabase server-side hardening.** RLS audits, RPC timeouts, database function refactoring — separate DB plans.
- **Observability / error reporting (Sentry or similar).** Not yet adopted; when it lands, wire `onRetry` and watchdog warnings to it. Out of scope for now.

### Acceptance checklist

Merge criteria for this plan, verified by a QA pass:

- [ ] `withAbortableTimeout` replaces all call sites of `withTimeout`; DevTools Network tab shows canceled requests on navigation, not pending.
- [ ] `retryWithBackoff` with `maxAttempts=3` handles network failure, stale JWT, 5xx. Manual test: disconnect network mid-fetch, reconnect; data appears.
- [ ] `safeSubscribe` wraps all `.subscribe()` calls; forced CHANNEL_ERROR triggers automatic re-subscribe after ≤ 500 ms.
- [ ] `createScopedStore` replaces every scoped hook in the migration table; all admin and customer pages render identically. Line count of [useSupabase.js](src/lib/useSupabase.js) drops by ≥ 300 lines.
- [ ] Scope validator: a scoped hook called with `clientId=null` shows skeleton; called with `clientId=''` shows empty state; called with `clientId='real-id'` fetches.
- [ ] `isRefreshing` flag available on every store hook; refactored pages show a subtle indicator during manual refresh without re-skeletoning.
- [ ] `emptyFromNoAuth` distinction: slow-cold-load test (throttle to Slow 3G, then load auth page) ends with real data, not permanent `[]`.
- [ ] Watchdog timer: block Supabase network, load page, confirm watchdog warning after 8 s and automatic retry attempt.
- [ ] `reset()` on user-switch aborts in-flight fetches; DevTools shows "canceled" for user A's requests after user B signs in.
- [ ] HMR stash: save `useSupabase.js` 10 times in dev; no "channel already subscribed" warnings; no duplicate `cache:sales` entries in DevTools WS tab.
- [ ] `useStoreStatus` hook exports `{loading, isRefreshing, data, error, lastFetchedAt, canRetry, retry}`; at least one admin page refactored to use it.
- [ ] Deprecated-API console warnings fire in dev for legacy `useMyCommissionLedger(boolean|string)` calls; all call sites migrated to options object.
- [ ] `npm run build` succeeds; `npm run lint` clean.
- [ ] Manual regression sweep: all admin pages load within 3 s on Fast 3G; admin→customer navigation is instant; customer→admin idem.
- [ ] Slow-network cold-load end-to-end: throttle to Slow 3G, load app fresh, sign in, navigate to `/admin/clients`, `/admin/projects`, `/admin/finance` — every page shows a skeleton that resolves; none stuck > 20 s.
- [ ] Rapid-navigation test: open an admin page, navigate away within 300 ms, repeat 20 times. No stuck skeletons. No lingering "pending" requests in DevTools.
- [ ] User-switch test: login as A, navigate through data pages, logout, login as B. No data from A visible even briefly in B's session.
- [ ] Realtime test: open tab A and tab B as the same user. Create a sale in tab A; tab B's list updates within 2 s.
- [ ] Zero React console warnings about "setState on unmounted component" during any of the above tests.
