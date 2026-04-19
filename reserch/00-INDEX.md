# 00 — Master Index: Why pages get stuck on skeletons until hard-refresh

## What this folder contains

Six research documents, each focused on a slice of the app where stuck-skeleton/weird-loading bugs originate. Nothing here is a fix — this is a **diagnosis** of every suspect code path we found. Fixing each requires a judgment call about priority vs. risk.

| File | Scope |
|---|---|
| [01-auth-session-races.md](01-auth-session-races.md) | AuthContext, Supabase Web Lock, StrictMode, `awaitInitialAuth` gate, multiple `onAuthStateChange` subscribers |
| [02-cache-store-data-layer.md](02-cache-store-data-layer.md) | `createCachedStore`, `withTimeout`, `fetchWithRetryOnTimeout`, scoped hooks, realtime channels, optimistic mutations |
| [03-admin-pages-loading.md](03-admin-pages-loading.md) | Every admin page under `src/admin/pages/*` — per-page loading state management |
| [04-public-customer-pages-loading.md](04-public-customer-pages-loading.md) | Public/customer pages (Browse, Dashboard, Installments, Project/Plot, Login/Register/Reset) |
| [05-lazy-suspense-bundling.md](05-lazy-suspense-bundling.md) | `lazy()` + `<Suspense>`, Vite chunk hashes, Vercel caching, service worker |
| [06-css-ui-skeleton.md](06-css-ui-skeleton.md) | CSS side of skeletons, theme-init.js, NotificationToaster polling, unmount cleanups |

---

## The TL;DR — one paragraph

The app has **no single "stuck skeleton" bug**. It has a constellation of ~40 race conditions and missing error-recovery paths that each can cause a page to hang, layered on top of each other. The most frequent root cause is a **2-second "safety timer" in the initial-auth gate** at [src/lib/useSupabase.js:65](src/lib/useSupabase.js:65) which — on slow/cold networks — lets the first data fetches run **before** the JWT is attached. RLS returns empty arrays, the cached store marks itself as "successfully loaded", and no built-in watchdog ever retries because the store looks healthy (no error, no loading, has `loadedAt`). Hard refresh recovers because the Supabase session is read synchronously from `localStorage` before the 2-second timer starts ticking — no race.

Compounding that: React **StrictMode** double-mounts the `AuthProvider`, two concurrent calls try to acquire the Supabase **Web Lock**, the second times out, the retry also fails, `clearState()` runs, and the user sees the **login page** flash even though they're signed in. In parallel, `ensureCurrentClientProfile()` is awaited **without any timeout** in `init()` and `login()`, so if that RPC hangs, `setLoading(false)` never runs and every `RequireCustomerAuth`/`RequireStaff` gate shows the `.app-loader-spinner` forever.

---

## Global ranking — most critical first

The issues below are drawn from all six research files and re-ranked by **how often they cause a stuck skeleton that only hard-refresh recovers from.**

### 🔴 CRITICAL — likely single biggest sources of the bug

1. **`awaitInitialAuth` 2-second safety timer fires before JWT arrives** → fetches run unauthenticated → RLS returns `[]` → stores mark healthy → no retry. See [01 #1](01-auth-session-races.md), [02 #7](02-cache-store-data-layer.md).
2. **`ensureCurrentClientProfile()` awaited with no timeout** in `init()` and `login()` → hangs indefinitely on slow RPC → `setLoading(false)` never runs. See [01 #3](01-auth-session-races.md).
3. **StrictMode double-mount + Supabase Web Lock** → retry-then-clearState path → user kicked to `/login` despite valid session. See [01 #2](01-auth-session-races.md).
4. **Scoped hooks (`useInstallmentsScoped`, `useMyCommissionLedger`) early-return without `setLoading(false)`** when `clientId` is null → skeleton forever until clientProfile resolves. See [02 #16](02-cache-store-data-layer.md), [04 #1](04-public-customer-pages-loading.md), [04 #2](04-public-customer-pages-loading.md).
5. **No retry on lazy-import failure** → after a deploy, users with old `index.html` hit 404 on new chunk hashes → `<Suspense>` spins forever, no error boundary catches it. See [05](05-lazy-suspense-bundling.md).
6. **DashboardPage's 6 parallel hooks** — any one stalling pins the whole portfolio skeleton. See [04 #1](04-public-customer-pages-loading.md).

### 🟠 HIGH — frequent, compounding

7. **`fetchWithRetryOnTimeout` only retries on timeout, not on 500/network/RLS errors** → transient error kills the page. See [02 #2](02-cache-store-data-layer.md).
8. **`reviveStale` misses "successfully loaded empty data"** — the most likely end-state after issue #1 — so there is no automatic recovery. See [02 #7](02-cache-store-data-layer.md).
9. **`initDone.current` drops `SIGNED_IN` events** arriving during a slow `init()` → profile never syncs, user redirected to `/login`. See [01 #4](01-auth-session-races.md).
10. **Multiple `onAuthStateChange` subscribers** at module scope (5 total) → duplicate refreshes on every `TOKEN_REFRESHED`, Web Lock contention. See [01 #10](01-auth-session-races.md).
11. **Scoped hooks' `loadedOnceRef` silences the skeleton on retry** → on any error, user sees no feedback, eventually hard-refreshes. See [02 #3](02-cache-store-data-layer.md).
12. **`RequireCustomerAuth` "Profil introuvable" panel blocks DashboardPage** — which is where the heal RPC lives → user stuck in a loop with no way to self-recover. See [04 #13](04-public-customer-pages-loading.md).
13. **`ProjectPage`/`PlotPage` rapid-navigation races** — param change mid-fetch leaves skeleton flagged for a different id. See [04 #3](04-public-customer-pages-loading.md).
14. **`BrowsePage` silently empty on error** — no visible error UI, no retry. Public-facing first impression broken. See [04 #6](04-public-customer-pages-loading.md).
15. **`ReferralInvitePage` infinite "Chargement…" on invalid code** — deterministic, not transient. See [04 #4](04-public-customer-pages-loading.md).
16. **`CommissionLedgerPage`, `CommissionAnomaliesPage`, `ClientProfilePage`** — complex multi-query pages with no fallback. See [03](03-admin-pages-loading.md).
17. **Stale chunk hashes after deploy + no `Cache-Control` on `index.html`** — 404 on chunk import → Suspense hang. See [05](05-lazy-suspense-bundling.md).
18. **`Suspense` fallback has no error state** — identical spinner for auth loading, chunk loading, and chunk failure → user can't tell why. See [05](05-lazy-suspense-bundling.md).
19. **Visibility `revalidateNow` racing with `init()`** on first mount → extra Web Lock contention. See [01 #5](01-auth-session-races.md).
20. **`_initialAuthPromise` never resets** except on sign-out → stuck in "resolved-without-auth" state for the whole session. See [01 #6](01-auth-session-races.md).
21. **`usePublicBrowseProjects` has no retry on non-timeout error** → public catalog can go blank and stay blank. See [04 #6](04-public-customer-pages-loading.md).

### 🟡 MEDIUM — contribute to the "weird stuff" feeling

22. **`reviveStale` 3-second throttle** + `SLOW_MS = 5000` → stuck-skeleton window of 5–8 s even when a retry would succeed. See [02 #6](02-cache-store-data-layer.md).
23. **`withTimeout` has no `AbortController`** → hung requests stay on sockets, slow subsequent reloads. See [02 #4](02-cache-store-data-layer.md).
24. **Realtime channels never check `SUBSCRIBED` state** — silent handshake failure → app runs on stale data → user hard-refreshes to "force update". See [02 #11](02-cache-store-data-layer.md).
25. **Unfiltered realtime subscription on `parcel_tree_batches`** in `PlotPage` → flood of refreshes → skeleton flicker + channel drop risk. See [04 #8](04-public-customer-pages-loading.md).
26. **Module-scope cached stores duplicated on Vite HMR** (dev only) → old channels linger → duplicated events during testing. See [02 #8](02-cache-store-data-layer.md).
27. **`useProjectWorkflow.updateWorkflow` has no loading flag during DB writes** → UI looks frozen → users mash save button → duplicate writes. See [02 #9](02-cache-store-data-layer.md).
28. **`LoginPage` post-login redirect races with AuthContext propagation** → one-frame flash of spinner, occasional login-loop. See [04 #5](04-public-customer-pages-loading.md).
29. **`RegisterPage` 20-s timeout cancels client but not server** → user retries, gets "email in use" error. See [04 #9](04-public-customer-pages-loading.md).
30. **`NotificationToaster` realtime channel fails silently** → app feels broken without any error. See [04 #11](04-public-customer-pages-loading.md), [06](06-css-ui-skeleton.md).
31. **`registrationInProgressRef` can stick `true`** on certain exception paths → `SIGNED_IN` events permanently dropped. See [01 #8](01-auth-session-races.md).
32. **`hardLogout` in `init()` catch is not timeout-wrapped** → can itself hang. See [01 #9](01-auth-session-races.md).
33. **`ResetPasswordPage` recovery flag timing** — flag can be consumed before page reads it. See [04 #10](04-public-customer-pages-loading.md).
34. **Admin pages with AND-combined loading flags** (`loading && data.length === 0`) mistake empty data for loading state → skeleton forever. See [03](03-admin-pages-loading.md).
35. **`useAccessGrants` has no cancelled flag** → setState on unmounted component. See [02 #17](02-cache-store-data-layer.md).
36. **Channel teardown 100 ms grace** may be too short under memory pressure. See [02 #12](02-cache-store-data-layer.md).
37. **Eager import of `CommissionTrackerPage`** in `App.jsx:45` while every other admin page is lazy → inconsistent bundle + no lazy-retry scaffolding. See [05](05-lazy-suspense-bundling.md).
38. **`AppErrorBoundary` reload button uses `window.location.reload()`** (soft refresh) — may reload with stale manifest → error loop. See [05](05-lazy-suspense-bundling.md).

### 🟢 LOWER — cosmetic or edge cases

39. **Memory leak on `_allCachedStores`** — only affects HMR, no prod impact. See [02 #14](02-cache-store-data-layer.md).
40. **`safety-net` 15-min interval compounds with visibility revalidate** on long-open tabs. See [01 #11](01-auth-session-races.md).
41. **`useMyCommissionLedger` overloaded signature** (string OR boolean) — fragile API. See [02 #19](02-cache-store-data-layer.md).
42. **Skeleton CSS has no `aria-busy`** — accessibility gap, not a bug. See [06](06-css-ui-skeleton.md).
43. **`emitInvalidate` bus unhandled rejections** — console noise only. See [02 #20](02-cache-store-data-layer.md).

---

## Patterns that repeat across the codebase

### Pattern A — "early return without `setLoading(false)`"
Any hook that gates on a parameter being present (clientId, projectId, enabled flag) but forgets to clear the loading flag on the no-op path. **Affects scoped hooks → propagates to every page that uses them.**

### Pattern B — "timeout without AbortController"
Timeouts reject the outer promise but leave the underlying fetch running. Sockets accumulate, subsequent reloads are slower.

### Pattern C — "retry only on timeout, never on other errors"
`fetchWithRetryOnTimeout` at [src/lib/useSupabase.js:37](src/lib/useSupabase.js:37). A 500 from Supabase or a transient RLS error gets no retry.

### Pattern D — "realtime `.subscribe()` without status check"
Every channel in the codebase calls `.subscribe()` and walks away. No reaction to `CHANNEL_ERROR` or `CLOSED`. Handshake failures are invisible.

### Pattern E — "two identical spinners that mean different things"
`.app-loader-spinner` used by: AuthContext loader, Suspense fallback, RequireCustomerAuth gate, RequireStaff gate. User can't tell if it's auth, chunk loading, or a hang.

### Pattern F — "empty data treated as success"
Once a store has `data=[], loading=false, loadedAt>0`, the auto-revive logic considers it healthy. No page-level heuristic distinguishes "truly empty" from "empty because auth wasn't ready when we fetched."

### Pattern G — "no user-facing retry UI"
Almost every fetcher only `console.error`s on failure. Users have no button to retry other than hard-refresh.

---

## Why hard refresh is the only reliable recovery

A hard refresh (Ctrl+F5 / Cmd+Shift+R) succeeds because, in roughly this order:

1. **Module re-evaluation** — every `let`/`const` at module scope in `useSupabase.js`, `supabase.js`, `AuthContext.jsx` is freshly initialized. `_initialAuthPromise = null`, `_storeResetHandlers = new Set()`, `_allCachedStores = new Set()`, no duplicate subscribers.
2. **Session read is synchronous** — Supabase's `getSession()` reads the serialized token from `localStorage` before any effect runs. JWT is attached before the 2-second safety timer matters.
3. **All sockets close** — parked requests from the previous session are GC'd. No Web Lock contention from inflight promises.
4. **Single mount** — StrictMode's double-invoke doesn't happen across a full reload.
5. **Chunk manifest refreshes** — bypassing browser cache means the latest deploy's `index.html` is fetched, with correct chunk hashes.
6. **React state reset** — no stale `loading=true, loadedAt=0` from the prior session lurking in component closures.

Between hard refreshes, the app has **no watchdog, no global retry button, no automated detection** of a wedged state. Every failure path that doesn't emit an error leaves the UI in a plausibly-normal "loading" or "empty" state indefinitely.

---

## How to navigate this folder

- **For a quick fix-priority roadmap:** read this file's ranked list above.
- **For understanding why login/logout feels flaky:** [01-auth-session-races.md](01-auth-session-races.md).
- **For understanding why clicking a sidebar item sometimes does nothing:** [02-cache-store-data-layer.md](02-cache-store-data-layer.md) and [03-admin-pages-loading.md](03-admin-pages-loading.md).
- **For understanding why `/dashboard` loads skeletons forever:** [04-public-customer-pages-loading.md](04-public-customer-pages-loading.md).
- **For understanding why the app goes white/spinning after a deploy:** [05-lazy-suspense-bundling.md](05-lazy-suspense-bundling.md).
- **For understanding skeleton shimmer that never stops animating even when data arrived:** [06-css-ui-skeleton.md](06-css-ui-skeleton.md).

The individual files each have their own severity-ranked lists with file:line citations and reproduction hints.
