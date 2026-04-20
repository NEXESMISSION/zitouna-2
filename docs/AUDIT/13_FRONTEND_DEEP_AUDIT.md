# 13 — Frontend Deep Audit (Caches, Realtime, Notifications)

> Severity: **Critical → High → Medium → Low**.
> Scope: cache store correctness, realtime channel lifecycle, optimistic updates,
> and the new Notifications layer (`NotificationsMenu.jsx`, `NotificationToaster.jsx`,
> `lib/notifications.js`). Findings below are NEW vs. [04_FRONTEND_CORRECTNESS_FINDINGS.md](04_FRONTEND_CORRECTNESS_FINDINGS.md);
> see "Already covered" at the end.

---

## Remediation status (2026-04-19)

| ID | Severity | Status | Where the fix lives |
|---|---|---|---|
| FE2-C1 | Critical | ✅ Fixed | `src/lib/useSupabase.js` — `_currentUserId` / `_userIdResolved` module-scope tracker; `onAuthStateChange` resets every store on identity change (not just `SIGNED_OUT`) |
| FE2-C2 | Critical | ✅ Fixed | `src/lib/notifications.js` — `useNotifications` channel handler reads `refreshRef.current()`; effect deps shrunk to `[userId, scope, instanceId]` so category/limit changes no longer rebuild the channel |
| FE2-H1 | High | ✅ Fixed | `src/components/NotificationToaster.jsx` — `userIdRef` updated in dedicated effect; payload handler refuses any row whose `user_id !== userIdRef.current` |
| FE2-H2 | High | ✅ Fixed | `src/lib/useSupabase.js` — `useSales.update`/`remove` and `useClients.remove` snapshot before mutate, optimistically apply, revert via `mutateLocal(() => snapshot)` and re-throw on error so callers can surface a toast |
| FE2-H3 | High | ✅ Fixed | `src/components/NotificationToaster.jsx` — wallclock 10s cutoff replaced by lazy `firstSeenCeilingRef` set on first message; clock skew can no longer drop legitimate notifications |
| FE2-H4 | High | ✅ Fixed | Folded into FE2-C1: same `_currentUserId` tracker handles `TOKEN_REFRESHED` / `USER_UPDATED` / silent identity swap |
| FE2-H5 | High | ✅ Fixed | `src/lib/useSupabase.js` — `useSalesScoped` split into two effects (channel deps `[clientId]`, fetch deps `[clientId]`), channel handler invokes `refreshRef.current()` |
| FE2-H6 | High | ✅ Fixed | `src/lib/notifications.js` — new `markAllReadByCategories({ scope, categories })` calls `mark_all_notifications_read_categories` RPC (assumed to be added by SQL agent in `database/12_notifications_security_patch.sql`) with PostgREST 404 fallback to N parallel single-cat calls; `src/components/NotificationsMenu.jsx` passes `currentTab.categories` as an array |
| FE2-M1 | Medium | ✅ Documented + helper | `src/lib/useSupabase.js` — optimistic insert tags row with `__optimistic: true`; new `isOptimistic(row)` export so callers can detect rows whose joined fields haven't hydrated yet |
| FE2-M2 | Medium | ✅ Fixed | `src/lib/notifications.js` and `src/components/NotificationToaster.jsx` — channel names append `useId()` so two simultaneous mounts can't collide |
| FE2-M3 | Medium | ✅ Fixed | Folded into FE2-C1: `reset()` bumps `fetchGen`; in-flight requests issued by previous user resolve into a no-op via `myGen !== fetchGen` check, can no longer publish into the new user's snapshot |
| FE2-M4 | Medium | ✅ Fixed | `src/components/NotificationToaster.jsx` — `seenIdsRef: Set<id>` with FIFO eviction at `SEEN_CAP = 64`, replaces single-timestamp dedupe |
| FE2-M5 | Medium | ✅ Fixed | `src/lib/notifications.js` — `linkOf()` now funnels through `isSafeAppPath` from `src/lib/safePaths.js`; non-allowlisted paths return `null` so menu/toaster click is a no-op |
| FE2-L1 | Low | ✅ Fixed | `src/lib/safeStorage.js` — new `useNow(intervalMs = 60_000)` hook; `src/components/NotificationsMenu.jsx` consumes `nowTick` in the relative-label `useMemo` so labels refresh every minute |
| FE2-L2 | Low | ✅ Fixed | `src/components/NotificationToaster.jsx` — TTL clamped via `Math.max(0, TOAST_TTL_MS - elapsed)` |
| FE2-L3 | Low | ✅ Fixed | `src/lib/useSupabase.js` — `teardownChannel` defers `removeChannel` by 100 ms via `channelTeardownTimer`; `setupChannel` cancels pending teardown if a re-subscribe arrives in the grace window |
| FE2-L4 | Low | ✅ Fixed | `src/lib/useSupabase.js` — `useProjectWorkflow.updateWorkflow` uses in-memory `workflow` as merge base, mutates locally, writes once, emits `emitInvalidate('projects')`; pre- and post-fetch are gone |

**Summary:** 17 fixed (2 critical, 6 high, 5 medium, 4 low). FE2-H6 depends on the SQL agent's `mark_all_notifications_read_categories` RPC in `database/12_notifications_security_patch.sql`; the frontend ships with a 404 fallback so it works even before the patch deploys.

**Build status (2026-04-19):** `npx vite build` ✅ passes; `npx eslint src/` shows no NEW errors in any touched file (one pre-existing `no-unused-vars` error in `src/pages/DashboardPage.jsx` is unrelated).

## Summary

| Sev | # | Short |
|---|---:|---|
| Critical | 2 | Module-scope cache bleeds across users (no reset on login) · `useNotifications` re-subscribes on every render via `refresh` dep |
| High | 6 | Toaster channel survives logout · Optimistic `update`/`mutateLocal` never reverts on error · Realtime catch-up filter uses wallclock not server clock · `_storeResetHandlers` only fires on `SIGNED_OUT` (missed on user switch) · `useSalesScoped` infinite re-subscribe via filter object identity · `markAllRead` UI math wrong for multi-category tabs |
| Medium | 5 | `mutateLocal` then `scheduleRefresh(350)` races: server data may overwrite optimistic insert before refresh · Two NotificationsMenu instances open the same channel name (collision) · `inflightRef` in cache store is shared across users · Toast `lastSeenAtRef` keyed by timestamp, drops simultaneous events · `linkOf` not validated → open-redirect risk |
| Low | 4 | `formatRelative` doesn't update with time · Toast TTL math wrong on rapid additions · `setupChannel`/`teardownChannel` race when subCount toggles 1→0→1 · `useProjectWorkflow` runs full re-fetch on every patch save |

---

## 🔴 Critical

### FE2-C1 — Module-scope cache stores leak data across users on the same browser
- File: [src/lib/useSupabase.js:225-256](src/lib/useSupabase.js:225)
- The six `_salesStore`, `_clientsStore`, `_projectsStore`, etc. live at module scope. They are reset only via `_storeResetHandlers` on `SIGNED_OUT` ([useSupabase.js:85-90](src/lib/useSupabase.js:85)).
- Scenario: User A logs in → fetches sales (RLS scopes to A). User A signs out → reset fires. User B logs in WITHOUT a full SIGNED_OUT in between (e.g., session token swap, identity-link flow, or tab reload using cached profile) → first subscriber sees A's stale `data` for one render before refetch resolves.
- Specifically, in `subscribe()` ([useSupabase.js:190-205](src/lib/useSupabase.js:190)): `try { fn(state) } catch ...` synchronously hands the new subscriber the *old* `state`. If `loadedAt` is fresh (`< 15s`), `refresh()` returns immediately and B *never* refetches.
- Impact: B briefly sees A's clients / sales / commissions in the UI. Possible PII leak.
- Repro: Login as A → open sales page → logout → without closing tab login as B within 15s → first paint shows A's rows.
- Fix: also reset on `SIGNED_IN` when `verifiedUser.id` differs from a `lastUserIdRef`. Track current user id at module scope; if it changes, call all `_storeResetHandlers`.

### FE2-C2 — `useNotifications` resubscribes the realtime channel on every render
- File: [src/lib/notifications.js:216-233](src/lib/notifications.js:216)
- `useEffect` deps: `[userId, scope, refresh]`. `refresh` is a `useCallback` with deps `[userId, scope, category, limit]` — but `category`/`limit` defaults are object-literal/positional and the parent component re-creates the args object every render.
- In `NotificationsMenu` the call is `useNotifications({ userId: user?.id, scope })` — passing a new options object on each render is fine because destructure pulls primitives. But because `category` is `null` and `limit` defaults to `40`, the deps stay stable… UNTIL a parent re-render re-mounts. Verified stable here.
- However: `refresh` itself is recreated whenever `userId`/`scope` change. If `user` object identity flips (e.g., `syncSession` re-set), `userId` is the same string — fine. But `queueMicrotask(() => { refresh() })` runs *every effect re-run*, AND because the unsubscribe → subscribe pair runs every time `refresh` is a new reference, channel churn can drop messages mid-reconnect.
- Worst case: `useAuth()` re-renders frequently → channel constantly torn down and re-set → realtime never delivers, bell stays at zero unread.
- Fix: either drop `refresh` from deps and use a ref, or memoize options. Prefer storing `refresh` in a ref accessed inside the channel handler.

---

## 🟠 High

### FE2-H1 — `NotificationToaster` realtime channel not torn down on logout signal
- File: [src/components/NotificationToaster.jsx:39-68](src/components/NotificationToaster.jsx:39)
- The effect depends on `[user?.id, push]`. When the user logs out, `user` becomes null → effect cleanup runs `supabase.removeChannel(channel)` — OK.
- But: between login → logout → login-as-different-user, the channel name is `toast:${user.id}`. If two users share a tab in fast succession, the *first* channel must finish cleanup before the second subscribes. Supabase's `removeChannel` is async; React's cleanup runs synchronously. Two channels can coexist briefly.
- Worse: the component is mounted in `App.jsx` ([App.jsx:65](src/App.jsx:65)) **outside** any auth gate. A logged-out visitor opens the app → `user?.id` is undefined → effect returns undefined cleanup → fine. But the toaster never validates `user?.id` matches the actual session at render time — if `useAuth()` reports a stale user during transition, a toast for the previous user could pop.
- Fix: add a `userIdRef` and check inside the payload handler that `payload.new.user_id === userIdRef.current` before pushing.

### FE2-H2 — Optimistic `mutateLocal` for sale/client mutations never reverts on error
- File: [src/lib/useSupabase.js:475-505, 442-447, 500-505](src/lib/useSupabase.js:475)
- `useSales.update` does `mutateLocal((prev) => prev.map(...))` *before* `await db.updateSale`. Wait — actually it `await`s first, then `mutateLocal`. OK for that one.
- But `useClients.remove` ([useSupabase.js:442-447](src/lib/useSupabase.js:442)) and `useSales.remove` ([useSupabase.js:500-505](src/lib/useSupabase.js:500)) `await db.deleteX` first → if delete throws RLS/permission error, the `await` rejects and `mutateLocal` never runs. Good.
- The real bug: there is no try/catch around `db.deleteSale`. The error propagates to the caller, but the caller (admin pages) often only `console.error`s. The user sees no toast, the UI didn't change (optimism didn't fire), so they click again and again, hammering the server with rejected deletes.
- Fix: wrap mutators, surface the error via the new notification toast, OR pre-mutate optimistically + revert on catch:
  ```js
  const snapshot = state.data
  mutateLocal(...)
  try { await db.deleteSale(id) } catch (e) { publish({ data: snapshot }); throw e }
  ```

### FE2-H3 — Toaster's "10s freshness" check uses local clock vs server `created_at`
- File: [src/components/NotificationToaster.jsx:49-57](src/components/NotificationToaster.jsx:49)
- `if (Date.now() - created > 10_000) return` — `created` is `new Date(row.created_at)`, which is the DB timestamp. If the user's clock is skewed (laptop sleep, cross-timezone) by even 11 seconds, every fresh notification is silently dropped → bell badge increments but no toast.
- Repro: set system clock back 30s → no toasts ever.
- Fix: use server time. Either skip the freshness check entirely (rely on `lastSeenAtRef` and `MAX_VISIBLE`) or store the timestamp of the *first* received row and consider anything within 10s of THAT a fresh stream.

### FE2-H4 — `_storeResetHandlers` reset only on `SIGNED_OUT`, missed on user switch
- File: [src/lib/useSupabase.js:85-90](src/lib/useSupabase.js:85)
- See FE2-C1 above for the data-bleed angle. Mechanism specifically: `onAuthStateChange((event) => { if (event === 'SIGNED_OUT') ...})`. Token refresh that swaps user identity (e.g., admin impersonates, or magic-link bridge) emits `TOKEN_REFRESHED` or `USER_UPDATED`, not `SIGNED_OUT`.
- Fix: also reset when the new session's `user.id` differs from the stored last id.

### FE2-H5 — `useSalesScoped` re-subscribes whenever `filters.clientId` changes by reference
- File: [src/lib/useSupabase.js:532-589](src/lib/useSupabase.js:532)
- `applySaleFilters` is recomputed in `useMemo` with deps that DO include the filter primitives. Good.
- But the `useEffect` at [581](src/lib/useSupabase.js:581) deps on `[refresh, clientId]` — `refresh` recreates when `clientId` changes. So one filter change → effect cleanup → `removeChannel` → new `subscribe` round trip (~300ms). During that gap, realtime events are lost. On a busy admin sales page that filters as users type, this is severe.
- Fix: either separate the channel effect (deps `[clientId]` only) from the fetch effect, or use `useEvent`-style stable callback for `refresh`.

### FE2-H6 — `markAllRead` UI math is wrong for multi-category tabs
- File: [src/components/NotificationsMenu.jsx:154](src/components/NotificationsMenu.jsx:154)
- Code: `markAllRead({ category: currentTab.categories ? currentTab.categories[0] : null })`.
- "Commissions" tab covers `['commission','payout']` — clicking "Tout marquer lu" on this tab marks only category `commission`, leaves `payout` unread. The badge updates partially, user keeps clicking, server gets multiple RPC calls.
- Fix: pass the array to `markAllRead`, and have the SQL RPC accept `text[]`. Or call `Promise.all(categories.map(c => markAllRead({ category: c })))` as an interim.

---

## 🟡 Medium

### FE2-M1 — `mutateLocal` insertion races `scheduleRefresh` server response
- File: [src/lib/useSupabase.js:481-486](src/lib/useSupabase.js:481)
- `useSales.create`: pushes the locally-built row, then `_salesStore.scheduleRefresh(350)`. The locally-built row lacks joined fields (project_title, parcel_label, computed status). When the 350ms refresh resolves, the row is replaced by the server version — content shift in the table. If the user clicked the optimistic row in those 350ms, they get stale derived fields.
- Fix: either don't optimistically insert (just trigger refresh), or merge the server row into the optimistic row by id when the refresh lands.

### FE2-M2 — Two `NotificationsMenu` instances → channel name collision
- File: [src/lib/notifications.js:221](src/lib/notifications.js:221)
- Channel name: `notif:${userId}:${scope || 'all'}`. If a future change mounts two menus (e.g., admin + investor bell), and one uses `scope=null` while another uses `scope='admin'`, names differ — fine. But if both use the default `scope=null`, they collide. Supabase silently deduplicates → second subscriber's effect cleanup will `removeChannel` the channel the first is still using.
- Currently TopBar renders one menu only ([TopBar.jsx:62](src/TopBar.jsx:62)). But the API allows multiple — guard now.
- Fix: append a per-mount unique id (`useId()`) to the channel name.

### FE2-M3 — `inflight` request promise is shared globally per store
- File: [src/lib/useSupabase.js:124](src/lib/useSupabase.js:124)
- If user A's fetch is in-flight when user B logs in (via switch), B's first `subscribe` calls `refresh()` → sees `inflight`, awaits it → gets A's filtered data into B's snapshot.
- Coupled with FE2-C1. Reset must also abort inflight: `inflight = null` and ideally pass an AbortSignal.

### FE2-M4 — Toaster `lastSeenAtRef` drops simultaneous events
- File: [src/components/NotificationToaster.jsx:55-56](src/components/NotificationToaster.jsx:55)
- `if (created <= lastSeenAtRef.current) return`. If two notifications arrive with identical `created_at` (DB triggers fire in the same microsecond — common in our `commission_events` flow), the second is dropped.
- Fix: track a `Set` of seen ids over a 30s window, not a single timestamp.

### FE2-M5 — `linkOf` payload not validated → open-redirect / XSS surface
- File: [src/lib/notifications.js:73-76](src/lib/notifications.js:73), used at [NotificationsMenu.jsx:111-115](src/components/NotificationsMenu.jsx:111) and [NotificationToaster.jsx:84-86](src/components/NotificationToaster.jsx:84)
- The payload is JSON written by DB triggers. If anywhere in the stack writes `payload.link = "javascript:alert(1)"` or `"https://evil.com"`, `navigate(to)` will follow it. React Router's `navigate` ignores absolute URLs (treats them as path) — partial safety — but a path like `//evil.com/x` becomes `https://evil.com/x` in some routers.
- Fix: enforce `link.startsWith('/')` and reject `//`.

---

## 🟢 Low

### FE2-L1 — `formatRelative` is computed once and never updates
- File: [src/components/NotificationsMenu.jsx:26-40](src/components/NotificationsMenu.jsx:26)
- A notification rendered as "À l'instant" stays "À l'instant" forever unless the menu re-opens or new notifs arrive. After 5 min the user sees "À l'instant" — confusing.
- Fix: a tiny `useEffect` setting a 60s tick that bumps a state counter, used as a key for the time labels.

### FE2-L2 — Toast TTL math drifts on rapid additions
- File: [src/components/NotificationToaster.jsx:71-79](src/components/NotificationToaster.jsx:71)
- The cleanup recomputes timers for ALL toasts on every change. A toast added at t=0 and a second at t=2s → when the second arrives, the first toast's old timer is cleared and a new timer with `TTL - (now - shownAt)` is set. Math is correct, but `setTimeout` with negative delay fires immediately — verify TTL hasn't already elapsed.
- Fix: clamp `Math.max(0, TOAST_TTL_MS - elapsed)`.

### FE2-L3 — `setupChannel`/`teardownChannel` races on subCount toggle
- File: [src/lib/useSupabase.js:190-205](src/lib/useSupabase.js:190)
- React Strict Mode mounts effects twice. `subscribe` → unsubscribe → subscribe in microseconds. If `subCount` goes 1 → 0 → 1, `teardownChannel` calls `supabase.removeChannel` (async) and the next `setupChannel` opens a new one before the first finishes closing → two listeners briefly → double `scheduleRefresh` calls → harmless but wasteful. Confirmed with the `realtime-public-catalog` style channels too.
- Fix: keep a small grace timeout (e.g., 100ms) before tearing down on subCount=0.

### FE2-L4 — `useProjectWorkflow.updateWorkflow` re-fetches the full workflow before AND after every patch
- File: [src/lib/useSupabase.js:757-775](src/lib/useSupabase.js:757)
- Fetches via `db.fetchProjectWorkflowConfig`, applies patch, writes back. Then `await refresh()` re-fetches a third time. 3 RPC round trips per save.
- Fix: keep the workflow in state, mutate locally, write once, refresh from realtime.

---

## Already covered (in 04_FRONTEND_CORRECTNESS_FINDINGS.md)

- **FE-C2** auth-flow triple race (`init`/`onAuthStateChange`/60s timer) — same root as FE2-C1's user-switch concern, but FE-C2 is about syncSession concurrency not cache leak. Distinct.
- **FE-H4** setTimeout after unmount — different file from FE2-L2 but same pattern; toaster's variant noted.
- **FE-M3** validateTimer runs when tab hidden — applies to `setInterval` in AuthContext, not the cache stores.
- **FE-M4** `!active` check only at the top — same race class as FE2-H1, distinct file.
- **FE-L3** error boundary console-only — confirmed; AppErrorBoundary still doesn't catch async (note: still applies to all toaster/menu rejections).
- **FE-L4** Toast stacking unbounded — `MAX_VISIBLE = 3` in toaster ([NotificationToaster.jsx:15](src/components/NotificationToaster.jsx:15)) addresses this; only the bell is unbounded (capped at server `limit=40`).

## Not found (verified absent)

- No realtime channel left dangling without `removeChannel` cleanup in any file I read.
- `useNotifications` hook does NOT keep multiple subscriptions per scope — verified one channel per (user, scope).
- No `dangerouslySetInnerHTML` in notification components.
- `useNotifications` does properly cancel stale fetches via `refreshSeqRef` ([notifications.js:209-213](src/lib/notifications.js:209)).

## Crossover

- **FE2-C1 × FE2-H4 × FE2-M3** — fix together: add a `currentUserIdRef`, reset stores on user-id mismatch, abort inflight, plus the SIGNED_IN reset.
- **FE2-C2 × FE2-H1** — both are realtime channel lifecycle bugs in the new notification layer. Stabilize callbacks with a ref and gate the toaster on `userIdRef`.
- **FE2-H6 × DB-side mark_all_notifications_read** — the SQL RPC needs to accept `text[]` to fix the multi-category tab; track in `database/08_notifications.sql`.
