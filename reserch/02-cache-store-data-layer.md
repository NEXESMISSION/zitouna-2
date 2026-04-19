# 02 — Cache Store & Data Loading Layer

## Why this area matters

The entire data model of the app flows through `src/lib/useSupabase.js` — either the `createCachedStore` factory (for top-level resources: sales, projects, clients, admin_users, offers, installments) OR bespoke scoped hooks (`useSalesScoped`, `useInstallmentsScoped`, `useWorkspaceAudit`, `useAccessGrants`, etc.). If any of these layers fail to transition `loading → false`, or if stale results from user A leak into user B's snapshot, every page that uses that hook shows a stuck skeleton.

---

## 1. Scoped hooks don't share state — each page mount refetches

**Severity: HIGH**
**Files:** [src/lib/useSupabase.js:796-869](src/lib/useSupabase.js:796) (useSalesScoped), [src/lib/useSupabase.js:936-992](src/lib/useSupabase.js:936) (useInstallmentsScoped), [src/lib/useSupabase.js:1082-1152](src/lib/useSupabase.js:1082) (useWorkspaceAudit), [src/lib/useSupabase.js:1154-1214](src/lib/useSupabase.js:1154) (useAccessGrants), [src/lib/useSupabase.js:1216-1291](src/lib/useSupabase.js:1216) (useCommissionWorkspace), [src/lib/useSupabase.js:1293-1347](src/lib/useSupabase.js:1293) (useSellerRelations), [src/lib/useSupabase.js:1415-1493](src/lib/useSupabase.js:1415) (useAmbassadorReferralSummary), [src/lib/useSupabase.js:1500-1549](src/lib/useSupabase.js:1500) (useMyCommissionLedger)

### What happens
Each scoped hook declares its own `useState([])` and `useState(true)`. Every mount fires a fresh fetch. On rapid navigation (back-and-forth between admin pages), a page mounts with `loading=true`, starts a fetch, user navigates away before it resolves, component unmounts, `cancelled=true` prevents `setLoading(false)`. But if the user comes back **while** the previous fetch is still in flight, the new mount starts a second concurrent fetch with a fresh `loading=true`, `cancelled=false`. The old fetch can't update state, the new one will — but if the new one hits the 12 s timeout, we've now waited ~24 s total for the user to see anything.

### Why hard refresh fixes it
Fresh module, fresh closures, no inflight ghosts. The first fetch on reload runs clean and resolves quickly because the DB connection is warm from the prior session.

### Reproduction hint
Rapid back/forward button mashing on admin pages (e.g. between `/admin/clients` and `/admin/finance`) — skeletons appear stuck.

---

## 2. `fetchWithRetryOnTimeout` only retries on timeout, not on any other error

**Severity: HIGH**
**Files:** [src/lib/useSupabase.js:37-46](src/lib/useSupabase.js:37)

### What happens
```js
if (!msg.includes('timed out')) throw e
```
The retry logic at line 43 throws for any error that doesn't literally contain "timed out". Network drops, PostgREST 500s, RLS rejections, stale JWT errors — all propagate immediately with no retry. The catch block in the calling hook logs the error via `logFetchError` and sets `loading=false`. Page shows empty data as if nothing happened. User sees "no data" or a stuck skeleton (depending on the page's render logic) with no retry button.

### Why hard refresh fixes it
Hard refresh re-establishes the JWT, re-runs the fetch with a fresh auth context. Transient errors (rate-limits, cold-start 500s) usually resolve on the second attempt.

### Reproduction hint
Intentionally revoke the JWT mid-session (via Supabase dashboard), then click a button that triggers a scoped fetch. The fetch gets a 401, throws, no retry, user sees stuck state.

---

## 3. Scoped hooks' `loadedOnceRef` silences the loading skeleton on retries

**Severity: HIGH**
**Files:** [src/lib/useSupabase.js:800](src/lib/useSupabase.js:800), [src/lib/useSupabase.js:803](src/lib/useSupabase.js:803), [src/lib/useSupabase.js:830](src/lib/useSupabase.js:830), [src/lib/useSupabase.js:874-878](src/lib/useSupabase.js:874)

### What happens
```js
setLoading(!loadedOnceRef.current)  // true only on FIRST load
```
After the first fetch completes (even if it errored), `loadedOnceRef.current = true`. On any subsequent refetch, `setLoading(true)` is called with `false` — so no skeleton ever shows again. If the refetch hangs or errors, the user has **no UI feedback at all** — they think nothing is happening. Eventually they hard-refresh out of confusion.

This is a UX bug masquerading as a stuck-skeleton — there's no skeleton to be stuck, but the page is still effectively frozen from the user's perspective.

### Why hard refresh fixes it
Fresh `useRef(false)`, so the skeleton shows again on the refetch after reload.

### Reproduction hint
Load a scoped-hook page fully, then make the network throw an error and click a "refresh" button. No skeleton, no error, no spinner.

---

## 4. `withTimeout` uses `setTimeout` with no `AbortController`

**Severity: MEDIUM**
**Files:** [src/lib/useSupabase.js:14-31](src/lib/useSupabase.js:14)

### What happens
The timeout racer rejects the outer promise, but the underlying `fetch` inside the Supabase client keeps running. The HTTP socket stays busy. If the user reloads the page immediately, up to 5–10 parked Supabase requests may still be on the wire — browser may queue them behind the fresh requests, slowing the "recovery" reload.

### Why hard refresh fixes it
Hard refresh closes all sockets.

### Reproduction hint
DevTools → Network → throttle to "Slow 3G" → load app → on reload after skeleton hang, notice lingering "pending" requests in the Network tab.

---

## 5. `createCachedStore.doFetch` — second retry is unreachable when `reset()` fires mid-fetch

**Severity: MEDIUM**
**Files:** [src/lib/useSupabase.js:179-225](src/lib/useSupabase.js:179), [src/lib/useSupabase.js:306-321](src/lib/useSupabase.js:306)

### What happens
The retry loop:
```js
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    const data = await withTimeout(...)
    if (myGen !== fetchGen) return  // check #1
    publish(...)
    return
  } catch (e) {
    // ... retry continue
  }
}
if (myGen !== fetchGen) return  // check #2
```

The `myGen !== fetchGen` check is only after the await. If `reset()` fires BETWEEN the first attempt's timeout and the second attempt starting, `fetchGen` has already been bumped. The second attempt still runs (waste of a request), and only returns at check #2 after hitting another timeout.

Minor perf issue, but in a slow-network scenario where reset() fires after a visibility event → user loses another 12s waiting for doomed retries.

### Why hard refresh fixes it
Module reinitialized, fresh fetchGen.

---

## 6. `reviveStale` 3-second throttle + `SLOW_MS=5000` → stuck-skeleton window of 5–8 seconds

**Severity: MEDIUM**
**Files:** [src/lib/useSupabase.js:343-379](src/lib/useSupabase.js:343), [src/lib/useSupabase.js:405-420](src/lib/useSupabase.js:405)

### What happens
1. A page loads, store is stuck with `loading=true, loadedAt=0`.
2. The user switches tabs away (visibility hidden) and comes back.
3. `visibilitychange` fires. `reviveStale` checks throttle: `now - lastRevive < 3000` — if within 3 s of last revive, **skipped**.
4. `useConnectionHealth` signals `slow=true` after 5 s but has no retry mechanism — it just sets a flag.
5. User stares at skeleton for up to 5 + 3 = 8 s before the next revive attempt, IF they happen to alt-tab.
6. If the user never alt-tabs, `reviveStale` never fires — skeleton forever.

### Why hard refresh fixes it
Immediate retry, no throttle.

### Reproduction hint
Slow-network cold load → alt-tab away within 1 s → alt-tab back. Skeleton visible for 8 s.

---

## 7. `reviveStale` condition misses "successfully loaded empty data" case

**Severity: HIGH**
**Files:** [src/lib/useSupabase.js:353-360](src/lib/useSupabase.js:353)

### What happens
```js
if (st.error || (st.loading && !st.loadedAt) || stale) {
  s.refresh({ force: true, background: ... })
}
```
A store that completed a fetch with `data=[]` (because JWT wasn't attached — see `01-auth-session-races.md` finding #1) has `error=null, loading=false, loadedAt=Date.now()`. None of the three conditions fire. The store is considered healthy with empty data, forever. Every page that renders off this store shows "empty" (which many pages interpret as "keep showing skeleton" — see `03-admin-pages-loading.md`).

### Why hard refresh fixes it
Fresh module, fresh fetch with proper JWT.

### Reproduction hint
Same as 01-auth-session-races.md #1 — slow cold load.

---

## 8. Module-scope stores duplicated on Vite HMR (dev only)

**Severity: MEDIUM (dev only, but likely source of "weird stuff")**
**Files:** [src/lib/useSupabase.js:150](src/lib/useSupabase.js:150), [src/lib/useSupabase.js:154](src/lib/useSupabase.js:154), [src/lib/useSupabase.js:438-468](src/lib/useSupabase.js:438)

### What happens
```js
const _storeResetHandlers = new Set()
const _allCachedStores = new Set()
// ...
const _salesStore = createCachedStore({ key: 'sales', ... })
```
When Vite HMR reloads this module (any edit), a NEW `_salesStore` is created. The OLD one is still in memory, still subscribed to realtime. Pages that were importing the old store hold references to that. New pages get the new store. Different data views per page.

Additionally, every HMR reload adds its channel to Supabase, named `cache:sales`, `cache:projects`, etc. Supabase deduplicates by channel name, but the double-`.subscribe()` + `.unsubscribe` race during HMR can leave dangling channels.

### Why hard refresh fixes it
Fresh bundle, single store instance.

### Reproduction hint
Save `useSupabase.js` in dev → watch console for "channel X already subscribed" or duplicated realtime events.

---

## 9. `useProjectWorkflow.updateWorkflow` has no loading UI during the DB write

**Severity: MEDIUM**
**Files:** [src/lib/useSupabase.js:1045-1077](src/lib/useSupabase.js:1045)

### What happens
The optimistic update at line 1054 sets the local state. Then 4 sequential DB writes. None of them set a `saving=true` flag on the returned object. Consumers (`ProjectDetailPage`) have to implement their own spinner logic. If any write hangs, the UI looks responsive but nothing is actually being saved — user has no feedback.

Not a stuck-skeleton, but a stuck-save. User mashes the save button → triggers more writes → data corruption risk.

### Why hard refresh fixes it
Cancels hung writes.

---

## 10. Optimistic `create/update/delete` race with realtime refresh

**Severity: MEDIUM**
**Files:** [src/lib/useSupabase.js:704-745](src/lib/useSupabase.js:704) (useSales.create/update), [src/lib/useSupabase.js:750-761](src/lib/useSupabase.js:750) (useSales.remove)

### What happens
1. `create()` → `db.createSale()` → `mutateLocal` prepends `__optimistic=true` row → `scheduleRefresh(350)`.
2. The realtime channel on `sales` table fires a `postgres_changes` event for the INSERT → `scheduleRefresh(500)` at line 261.
3. Both timers fire — `doFetch` runs once (scheduled timers overwrite each other). The refresh fetches all sales, replaces the optimistic row with the server row. **OK.**
4. BUT: if the server responds to `createSale` quickly (<350 ms) and the realtime event arrives before the local `scheduleRefresh(350)` fires, the refetch lands with `__optimistic` row still in state. The fetch result doesn't include `__optimistic` — it replaces the state entirely. OK.
5. Where it breaks: if `createSale` returns a row with different shape than `fetchSales` produces (different join fields), there's a visible "flicker" as the optimistic row swaps out. User perceives as "loading".

### Why hard refresh fixes it
Canonical data only.

---

## 11. Realtime channels never verify `SUBSCRIBED` state before reacting

**Severity: MEDIUM**
**Files:** [src/lib/useSupabase.js:257-265](src/lib/useSupabase.js:257), and every scoped hook with `.channel(...).on(...).subscribe()`

### What happens
`.subscribe()` returns immediately; the websocket handshake is async. Between subscribe and actual `SUBSCRIBED` state (can be 1–3 s on slow network), the channel is not receiving events. Inserts that happen in this window are missed. After the handshake completes, only events from THAT moment onward are delivered.

The code never logs or reacts to `CHANNEL_ERROR` or `CLOSED` status from `.subscribe(status => ...)`. If the channel silently fails (e.g. Supabase rate-limited realtime), the page appears to work but doesn't refresh on server changes → stale data → user hard-refreshes to "force update".

### Why hard refresh fixes it
Fresh channel, fresh handshake.

---

## 12. Channel teardown grace timer (100 ms) too short for Strict Mode on slow machines

**Severity: MEDIUM**
**Files:** [src/lib/useSupabase.js:267-287](src/lib/useSupabase.js:267)

### What happens
Grace period at line 280: `window.setTimeout(() => { ... }, 100)`. On a slow machine or under memory pressure, StrictMode's mount → unmount → remount cycle can take >100 ms, during which `channelTeardownTimer` fires and removes the channel before the new mount's `setupChannel` runs. Next subscriber hits a missing channel path; on re-subscribe, a new channel is created anyway. Minor performance hit; intermittent "stuck during remount".

### Why hard refresh fixes it
No double-mount race.

---

## 13. `usePublicBrowseProjects` has no `finally` block in its refresh callback

**Severity: HIGH**
**Files:** [src/lib/useSupabase.js:501-543](src/lib/useSupabase.js:501)

### What happens
```js
const refresh = useCallback(async () => {
  setLoading(true)
  try { ... } catch (e) { console.error(...); setProjects([]) } finally { setLoading(false) }
}, [])
```
Wait — this DOES have a finally. OK. But line 518's inline IIFE inside the effect:
```js
;(async () => {
  setLoading(true)
  try { ... } catch (e) { console.error(...) } finally { if (!cancelled) setLoading(false) }
})()
```
`setProjects([])` is only called in the refresh callback's catch, NOT in the initial IIFE's catch. If the initial load throws, projects stays at `[]` (initial state), `loading=false`, but any previous projects state is not cleared. Minor.

The real concern: both catch blocks only `console.error` — no visible user feedback. Users see empty page.

---

## 14. `_allCachedStores` registry is never garbage-collected per instance

**Severity: LOW**
**Files:** [src/lib/useSupabase.js:154](src/lib/useSupabase.js:154), [src/lib/useSupabase.js:325](src/lib/useSupabase.js:325)

### What happens
Each `createCachedStore` call adds its handle to `_allCachedStores`. There's no removal path. In dev HMR this creates a memory leak — old HMR'd stores accumulate. In production, stores are created once, so not a leak, but it means `reviveStale` iterates over every store on every visibility/focus/online/TOKEN_REFRESHED event — 6 stores × reviveStale-rate = potential refresh storm.

### Why hard refresh fixes it
Fresh set.

---

## 15. `setSnap(store.getState())` via `useCachedStore` runs with initial state on first render

**Severity: LOW**
**Files:** [src/lib/useSupabase.js:381-385](src/lib/useSupabase.js:381), [src/lib/useSupabase.js:289-298](src/lib/useSupabase.js:289)

### What happens
```js
function useCachedStore(store) {
  const [snap, setSnap] = useState(() => store.getState())
  useEffect(() => store.subscribe(setSnap), [store])
  return snap
}
```
On first render, returns `store.getState()` which is `{loading:true, loadedAt:0}` for a fresh store. This is the skeleton state. The subscribe in the effect fires AFTER render — so the first render always shows a skeleton. This is intentional but means you can't render cached data on the first frame — even if the data was loaded 5 seconds ago, you still get one render of "loading=true" before the effect runs.

Actually wait — line 298 `try { fn(state) } catch { /* ignore */ }` — this fires `fn(state)` IMMEDIATELY on subscribe, which would call setSnap and trigger a re-render with the current data. So the "first render has skeleton" stutter is limited to one frame.

Probably not a bug, but worth noting for the skeleton-flash complaint.

---

## 16. `useInstallmentsScoped` / `useSalesScoped` with `clientId=null` skip the fetch but leave `loading=true`

**Severity: CRITICAL**
**Files:** [src/lib/useSupabase.js:942-945](src/lib/useSupabase.js:942), [src/lib/useSupabase.js:806](src/lib/useSupabase.js:806)

### What happens
Look at `useInstallmentsScoped`:
```js
const refresh = useCallback(async () => {
  if (clientId == null || clientId === '') {
    setPlans([])
    return        // <-- DOES NOT setLoading(false)
  }
  setLoading(true)
  try { ... } finally { setLoading(false) }
}, [clientId])

useEffect(() => {
  if (clientId == null || clientId === '') {
    setPlans([])
    return        // <-- DOES NOT setLoading(false)
  }
  ...
}, [refresh, clientId])
```

The initial state is `loading=true` from line 938. If the first render has `clientId=null` (because `clientProfile` is still resolving), the early-return path at line 942-945 leaves `loading=true` forever. When `clientId` later becomes valid, the effect re-runs — OK. But **if `clientId` NEVER becomes valid** (customer has no profile / hybrid account / heal failed), loading stays true forever.

Same issue in `useSalesScoped` at line 806-808 (but wait — that one does check `clientId == null` at line 806, and does NOT have an early return; it branches to `fetchSales()` for the "all" case. Still, if the caller passes `clientId=null` intending "not yet known, please wait", the hook treats it as "show me all" — potentially a data leak for unprivileged users).

### Why hard refresh fixes it
Forces AuthContext to fully resolve clientProfile before any hook mounts.

### Reproduction hint
Login as a hybrid staff + buyer user → navigate to `/dashboard/installments` → watch skeleton forever if heal is delayed.

---

## 17. `useAccessGrants` has no `cancelled` flag in the effect

**Severity: MEDIUM**
**Files:** [src/lib/useSupabase.js:1180-1189](src/lib/useSupabase.js:1180)

### What happens
```js
useEffect(() => {
  void refresh()
  const channel = supabase.channel('page-access-grants')
    .on(...)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}, [refresh])
```
The initial `refresh()` runs. `refresh` internally sets `setAccessGrants`, `setGrantAuditLog`, `setLoading`. If the component unmounts before refresh() resolves, those setState calls fire on an unmounted component — React warning, and worse, the old component's cleanup has already run, so the `channel` is removed BUT the setState fires after.

Minor bug, low impact, but pollutes state across navigations.

---

## 18. `useAmbassadorReferralSummary` sequence-number guard is correct

**Severity: NONE**
**Files:** [src/lib/useSupabase.js:1436-1455](src/lib/useSupabase.js:1436)

### What happens
Uses `inflightRef.current` counter properly. No bug found.

---

## 19. `useMyCommissionLedger` signature back-compat is confusing

**Severity: LOW**
**Files:** [src/lib/useSupabase.js:1500-1549](src/lib/useSupabase.js:1500)

### What happens
Accepts either `string` (clientId) or `boolean` (enabled). This is fragile — a caller that passes `""` (empty string) or `0` would be treated as `typeof==='string'` (empty clientId → `enabled=false`). OK by luck, but any future caller could misuse it.

Not a stuck-skeleton cause.

---

## 20. `emitInvalidate` bus — unhandled rejections in store.refresh

**Severity: LOW**
**Files:** [src/lib/useSupabase.js:471-474](src/lib/useSupabase.js:471)

### What happens
```js
onInvalidate('sales', () => _salesStore.refresh({ force: true, background: true }))
```
`refresh` returns a promise — the return value is ignored. If it rejects (shouldn't, because refresh swallows errors internally), the rejection bubbles to `window.onunhandledrejection`. Ugly console output, but no stuck skeleton.

---

## Summary: the cascade

1. **`clientId=null` early return** (finding #16) → loading stays true → skeleton forever for hybrid/unhealed accounts.
2. **`reviveStale` misses empty-but-loaded stores** (finding #7) → cold-load empty data persists forever.
3. **Scoped hooks don't share state, don't retry on non-timeout errors, silence skeletons on retries** (findings #1, #2, #3) → admin pages feel stuck after transient errors.
4. **Module-scope state + HMR** (finding #8) → dev-only but explains "weird stuff" during testing.
5. **Realtime channels fail silently** (finding #11) → app runs on stale data → user hard-refreshes to force update.

Hard refresh fixes all of these because module-scope state resets, `clientId` resolves from localStorage before first render, and all pending sockets close.
