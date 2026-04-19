# 04 — Public & Customer Pages Loading Audit

## Why this area matters

These are the pages that non-staff users see: the landing/browse pages, login/register, dashboard, installments, project/plot views. They mix public (no-auth) fetches with authenticated fetches, which multiplies the failure surface — a public page that accidentally awaits an auth hook will hang for unauthenticated visitors. A dashboard that fires 6 hooks in parallel will hang if any one of them stalls.

---

## 1. `DashboardPage` — six parallel hooks, any one hanging stalls the portfolio

**Severity: CRITICAL**
**Files:** [src/pages/DashboardPage.jsx:69-166](src/pages/DashboardPage.jsx:69), [src/lib/useSupabase.js:796-922](src/lib/useSupabase.js:796), [src/lib/useSupabase.js:936-965](src/lib/useSupabase.js:936), [src/lib/useSupabase.js:1415-1493](src/lib/useSupabase.js:1415), [src/lib/useSupabase.js:1500-1540](src/lib/useSupabase.js:1500)

### What happens
DashboardPage mounts six parallel data hooks: `useSalesScoped`, `useInstallmentsScoped`, `useAmbassadorReferralSummary`, `useSalesBySellerClientId`, `useMyCommissionLedger`, `useProjectsScoped`. If `clientProfile?.id` is `null` on first render (common — AuthContext resolves asynchronously):
- `useSalesScoped({ clientId: null })` treats null as "fetch all" (see cache/data finding #16).
- `useInstallmentsScoped({ clientId: null })` early-returns without `setLoading(false)` → **loading stays true forever**.
- `useMyCommissionLedger(null)` resolves `enabled=false` → loading=false on first render, but won't re-fire when clientId arrives because `enabled` evaluation is stale in deps.

`portfolioLoading = salesLoading || projectsLoading` at [src/pages/DashboardPage.jsx:169](src/pages/DashboardPage.jsx:169). If ANY sub-hook's loading flag is stuck, the entire portfolio skeleton shows forever.

### Why hard refresh fixes it
Forces AuthContext to fully hydrate clientProfile from cached localStorage BEFORE DashboardPage mounts. All hooks receive a valid clientId on their first effect run.

### Reproduction hint
Login → immediately navigate to `/dashboard` during a slow network cold-start → portfolio skeleton persists until Ctrl+F5.

---

## 2. `InstallmentsPage` — `clientProfile?.id ?? null` race with scoped hooks

**Severity: CRITICAL**
**Files:** [src/pages/InstallmentsPage.jsx:65-100](src/pages/InstallmentsPage.jsx:65)

### What happens
Same underlying mechanism as #1. The page passes `clientProfile?.id ?? null` into `useInstallmentsScoped` and `useSalesScoped`. If the effects run before clientProfile resolves (deterministic on first mount), the scoped hooks get null, take the early-return path, skeleton stays mounted. When clientProfile eventually resolves, the effect re-runs for the new clientId — but the component may have already shown the skeleton for 2–10 seconds.

### Why hard refresh fixes it
`clientProfile` is in sessionStorage-backed state and resolves synchronously from Supabase's cached session on reload.

### Reproduction hint
Login → directly visit `/installments` → skeleton for several seconds.

---

## 3. `ProjectPage` / `PlotPage` — route-param change mid-fetch leaves skeleton visible

**Severity: HIGH**
**Files:** [src/pages/ProjectPage.jsx:18-45](src/pages/ProjectPage.jsx:18), [src/pages/PlotPage.jsx:28-59](src/pages/PlotPage.jsx:28), [src/lib/useSupabase.js:545-600](src/lib/useSupabase.js:545)

### What happens
`usePublicProjectDetail(id)` has `useState(() => Boolean(id))` for initial loading. When route param `id` changes (user navigates `/project/1 → /project/2`):
1. Effect re-runs with new id.
2. `setLoading(true)` fires.
3. Previous fetch's `cancelled=true` prevents its `setLoading(false)`.
4. New fetch starts. If slow, skeleton shows for the new id.
5. User hits back → `/project/1` → new component mount, new fetch for id=1, still loading=true.
6. If the user bounces rapidly, the effect chain leaves multiple parked requests.

### Why hard refresh fixes it
Closes all pending sockets, single fresh fetch.

### Reproduction hint
Click rapidly between project cards on `/browse`. Some transitions show stale skeletons.

---

## 4. `ReferralInvitePage` — infinite "Chargement…" on invalid code

**Severity: HIGH**
**Files:** [src/pages/ReferralInvitePage.jsx:1-52](src/pages/ReferralInvitePage.jsx:1)

### What happens
```js
const [referrer, setReferrer] = useState(null)
const [err, setErr] = useState('')
// effect fetches clients.maybeSingle() by code
// if data is null: setReferrer(null)  // already null
// if error: setErr(error.message)
```
For a code that doesn't match any row: `data=null, error=null` → `setReferrer(null)`, `setErr('')`. Render logic shows `<p>Chargement…</p>` when neither `referrer` nor `err` is truthy. The "loading" message persists forever, even though the fetch completed.

### Why hard refresh fixes it
Doesn't actually fix it — the bug is deterministic on any invalid code. Users hard-refresh assuming it's a transient issue, but the "loading" stays.

### Reproduction hint
Visit `/ref/nonexistent-code` → infinite "Chargement…".

---

## 5. `LoginPage` — post-login redirect races with AuthContext propagation

**Severity: HIGH**
**Files:** [src/pages/LoginPage.jsx:35-55](src/pages/LoginPage.jsx:35)

### What happens
After `login()` succeeds, the component immediately calls `navigate(result.redirectTo)`. But `AuthContext.login()` has already called `syncSession()` internally, so state SHOULD be updated by the time navigate runs. However:
1. `login()` returns { ok: true, redirectTo: '/dashboard' } — before React re-renders.
2. `navigate('/dashboard')` fires before React batches the `setUser`/`setAdminUser`/`setClientProfile` updates.
3. `RequireCustomerAuth` mounts for `/dashboard`. React has NOT yet re-rendered with the new auth state.
4. Gate checks `loading || !ready` — if the state change isn't committed yet, this could evaluate stale → show spinner.
5. But actually: since `login()` awaits syncSession which awaits resolveProfiles, and all of those complete BEFORE `login()` returns, by the time `navigate` runs, the state updates have been issued but may not yet be reflected until the next render cycle.
6. Net effect: a one-frame flash of `.app-loader-spinner` before the dashboard renders. Users perceive this as "slow login".

In the rare case `isAuthenticated` evaluates false during this window, the gate redirects back to `/login`, creating a brief loop.

### Why hard refresh fixes it
Not applicable directly — users usually don't hard-refresh after login. But the flash is enough to cause confusion.

### Reproduction hint
Log in with throttled network → observe one-frame flash of spinner between login form and dashboard.

---

## 6. `BrowsePage` — `usePublicBrowseProjects` silently renders empty on error

**Severity: HIGH**
**Files:** [src/pages/BrowsePage.jsx:9-106](src/pages/BrowsePage.jsx:9), [src/lib/useSupabase.js:501-543](src/lib/useSupabase.js:501)

### What happens
The initial fetch in the effect catches errors but only `console.error`s — no visible user feedback. If the anon key is invalid, the DB is down, or RLS denies a public query, BrowsePage renders an empty project list with `loading=false`. User sees "no projects available" — they assume the catalog is empty, not that the app is broken.

Secondary issue: if the fetch hangs (no response, no error) the `loading=true` state never resolves. The skeleton is visible forever.

### Why hard refresh fixes it
If it was a transient error (rate-limit, network glitch), reload retries.

### Reproduction hint
Set `VITE_SUPABASE_ANON_KEY` to an invalid value in `.env` → BrowsePage shows empty or stuck skeleton.

---

## 7. `PurchaseMandatPage` — two hooks with independent loading, partial hang

**Severity: MEDIUM**
**Files:** [src/pages/PurchaseMandatPage.jsx:10-49](src/pages/PurchaseMandatPage.jsx:10)

### What happens
Uses `usePublicProjectDetail(projectId)` and `usePublicVisitSlotOptions()` in parallel. If slots fetch fails/hangs but project succeeds, the page renders half-complete: project loaded but slot dropdown shows "Chargement…" forever. User can't submit the visit request.

### Why hard refresh fixes it
Retries both hooks cleanly.

### Reproduction hint
Slow-throttle network → project loads, slots hang.

---

## 8. `PlotPage` — unfiltered realtime subscription on `parcel_tree_batches`

**Severity: MEDIUM**
**Files:** [src/pages/PlotPage.jsx:28-59](src/pages/PlotPage.jsx:28), [src/lib/useSupabase.js:591](src/lib/useSupabase.js:591)

### What happens
```js
.on('postgres_changes', { event: '*', schema: 'public', table: 'parcel_tree_batches' }, () => void refresh())
```
No filter! Any change to ANY tree batch in the entire DB triggers a refresh on every PlotPage instance. Under load, this causes frequent refetches, skeleton flicker, and can push the user's tab over Supabase's realtime rate limit. Channel may drop silently, data goes stale.

### Why hard refresh fixes it
Fresh channel; may happen to be a quieter moment.

### Reproduction hint
Open a PlotPage, watch Network tab for frequent refresh fetches even when idle.

---

## 9. `RegisterPage` — 20-second timeout but no retry affordance

**Severity: MEDIUM**
**Files:** [src/pages/RegisterPage.jsx:57-164](src/pages/RegisterPage.jsx:57)

### What happens
Race between `supabase.auth.signUp` and a 20 s timeout. If the timeout wins:
- Error state set to "signup_total_timeout"
- `setLoading(false)` in finally
- User sees error message, can retry manually

OK on surface, but: the underlying signup may have actually succeeded server-side (user row created) but the timeout cancelled the client's wait. User retries → "email already registered" → confusion → hard refresh to "try again", not realizing they already have an account.

### Why hard refresh fixes it
Doesn't really — the issue is state desync between client and server. But users default to hard refresh as troubleshooting.

### Reproduction hint
Throttle to "Slow 3G", register → timeout → try again → "email in use" error.

---

## 10. `ResetPasswordPage` — recovery flag dependency on hash timing

**Severity: MEDIUM**
**Files:** [src/pages/ResetPasswordPage.jsx](src/pages/ResetPasswordPage.jsx), [src/lib/supabase.js:76-130](src/lib/supabase.js:76)

### What happens
`ResetPasswordPage` checks `sessionStorage.getItem(RECOVERY_FLAG_KEY)` to determine if the session is a recovery flow. The flag is set by:
1. Sync hash detection at module load (line 108) — works if page loaded via recovery link.
2. `onAuthStateChange('PASSWORD_RECOVERY')` handler at line 118.

If the user arrives via recovery link and the page mounts BEFORE the onAuthStateChange fires (rare — but possible on fast networks), and the hash has already been stripped by previous logic, the page may not know it's a recovery flow and could either:
- Let the user change password as if they were a regular logged-in user (security concern, not a skeleton bug)
- Show a "session expired" screen (stuck "loading" until user navigates away)

### Why hard refresh fixes it
The hash is usually still in the URL on first load. After Ctrl+F5 WITHOUT the hash (since it was stripped), user is redirected to login.

### Reproduction hint
Open password reset email link → works first time. Reload page → recovery flag already consumed → may hang.

---

## 11. `NotificationToaster` — realtime channel fails silently

**Severity: MEDIUM**
**Files:** [src/components/NotificationToaster.jsx](src/components/NotificationToaster.jsx), [src/lib/notifications.js](src/lib/notifications.js)

### What happens
Mounted globally in App.jsx (line 66). Subscribes to a realtime channel on `notifications` table. `.subscribe()` returns before handshake completes. If handshake fails:
- No error surfaced to console (or only via `.subscribe((status) => ...)` which isn't used).
- Toaster appears to work (no visible error) but never shows new notifications.
- Every page the user visits shares this broken toaster, compounding the "the app is weird" feeling.

### Why hard refresh fixes it
New channel handshake.

### Reproduction hint
Exceed Supabase realtime channel limit (200 per user default) → new channels silently fail.

---

## 12. `NotificationsMenu` — bell indicator can desync from data

**Severity: LOW**
**Files:** [src/components/NotificationsMenu.jsx](src/components/NotificationsMenu.jsx), [src/lib/notifications.js:252-280](src/lib/notifications.js:252)

### What happens
Uses `useNotifications(userId)` which internally does `queueMicrotask` to defer fetches. If the microtask runs while the component is unmounted (rapid nav), state updates orphan. Bell count may show "5" while the menu shows empty.

### Why hard refresh fixes it
Clean mount → fresh fetch → count and list sync.

---

## 13. `RequireCustomerAuth` — profile heal doesn't run if gate blocks DashboardPage

**Severity: HIGH**
**Files:** [src/components/RequireCustomerAuth.jsx:6-68](src/components/RequireCustomerAuth.jsx:6), [src/pages/DashboardPage.jsx](src/pages/DashboardPage.jsx)

### What happens
A buyer account created via delegated seller flow may have no `clients.auth_user_id` link. When the buyer registers, `AuthContext.resolveProfiles` attempts heal — if it fails (phone conflict, etc.), `clientProfile` stays null.

`RequireCustomerAuth` at line 28-65 shows the "Profil introuvable" UI with a "Réessayer" button that calls `refreshAuth()`. But `refreshAuth` calls `getUser()` + `syncSession()` — NOT `ensureCurrentClientProfile()` directly, so if the underlying DB heal is still failing, the retry does nothing visible.

Meanwhile, DashboardPage has its own heal call (line 96 in DashboardPage — `heal_my_client_profile_now()`) — but DashboardPage NEVER MOUNTS because RequireCustomerAuth blocks it.

Result: user stuck on "Profil introuvable" panel, clicks Réessayer, nothing happens, hard-refreshes, same thing, logs out, tries again → user frustration.

### Why hard refresh fixes it
If the backend heal job has completed in the background, reload picks up the new profile.

### Reproduction hint
Create a buyer via delegated seller → delete the auth_user_id link manually in DB → buyer registers their own account → stuck at Profil introuvable.

---

## 14. `NotificationToaster` rendered in App.jsx outside Suspense

**Severity: LOW**
**Files:** [src/App.jsx:66](src/App.jsx:66)

### What happens
`<NotificationToaster />` is rendered as a sibling of `<Suspense>`, so it mounts immediately even before any route chunk loads. If its initial effect throws (e.g. AuthContext not ready), the AppErrorBoundary above catches → whole app shows error screen, not just the toaster.

### Why hard refresh fixes it
Fresh mount.

---

## 15. `TopBar` notifications bell polls independently of page hooks

**Severity: LOW**
**Files:** [src/TopBar.jsx](src/TopBar.jsx)

### What happens
Rendered on every page — its notification hook competes for Supabase realtime channel quota against the page's own hooks (e.g. `useSalesScoped`'s `realtime-sales-scoped-X` channel). On a page that uses 3+ scoped hooks + TopBar + Toaster, the user has 5+ concurrent realtime channels.

### Why hard refresh fixes it
Reset channel count.

---

## Cross-cutting patterns

### Pattern A: Scoped hooks stall on null clientId
**Affects:** DashboardPage, InstallmentsPage, any page using `useSalesScoped`/`useInstallmentsScoped`/`useMyCommissionLedger` before clientProfile resolves.
**Root:** [src/lib/useSupabase.js:942-945](src/lib/useSupabase.js:942), [src/lib/useSupabase.js:1527](src/lib/useSupabase.js:1527) — early return without `setLoading(false)`.

### Pattern B: Unfiltered realtime subscriptions
**Affects:** PlotPage (tree batches), NotificationToaster, any page with wildcard realtime.
**Root:** [src/lib/useSupabase.js:591](src/lib/useSupabase.js:591) and similar — missing `filter` clauses.

### Pattern C: Empty-data ambiguity
**Affects:** BrowsePage, ReferralInvitePage, dashboard tabs.
**Root:** A hook that resolves with `data=[]` and `loading=false` is indistinguishable from a hook that's still loading. Some pages render a skeleton on `data.length === 0` → it sticks forever after a legitimate empty result.

### Pattern D: Realtime silent failure
**Affects:** every page with realtime. NotificationToaster, TopBar bell, all admin pages.
**Root:** `.subscribe()` never checked for `CHANNEL_ERROR`/`CLOSED` statuses. When realtime drops, app runs on stale data.

### Pattern E: No retry UI on error
**Affects:** BrowsePage, most scoped hooks. Some pages (RequireCustomerAuth) have explicit retry, but most just render empty.
**Root:** fetchers only `console.error` — no state propagates to render an error banner.

---

## Summary

Hard refresh recovers because:
1. `clientProfile` hydrates synchronously from `localStorage` on a fresh `AuthContext.init()`.
2. All pending realtime channels close, new ones handshake cleanly.
3. React state is reset — no partial/stale loading flags.
4. Scoped hooks receive valid clientId on their FIRST effect run.
5. Any 5xx/transient errors get a second chance.

Between hard refreshes, the app has no automated way to detect a stuck state (no watchdog timer), no way to diagnose it (stdout-only errors), and no user-facing retry for most surfaces.
