# 01 — Auth / Session Boot Race Conditions

## Why this area matters

The whole app gates render on `AuthContext` state (`loading`, `ready`, `isAuthenticated`, `adminUser`, `clientProfile`). Every protected page depends on the auth pipeline resolving **before** any data hook fires. If the auth pipeline stalls, forks, or drops an event silently, downstream pages see either:

- `loading=true` forever → `RequireCustomerAuth`/`RequireStaff` keep showing the `.app-loader-spinner`, OR
- `isAuthenticated=false` → pages redirect to `/login` even though a session exists in `localStorage`, OR
- `adminUser=null && clientProfile=null` → pages render with RLS failing silently → empty data → stuck skeletons.

A hard refresh fixes it because the cached JWT in `localStorage` under `sb-<ref>-auth-token` is read **synchronously** by `getSession()` before any race has a chance to start.

---

## 1. The 2-second `awaitInitialAuth` safety-timer race

**Severity: CRITICAL**
**Files:** [src/lib/useSupabase.js:62-84](src/lib/useSupabase.js:62), [src/lib/useSupabase.js:14-31](src/lib/useSupabase.js:14), [src/lib/useSupabase.js:179-224](src/lib/useSupabase.js:179)

### What happens
1. On a cold page load, `awaitInitialAuth()` builds a promise that resolves on the FIRST of: `INITIAL_SESSION`, `SIGNED_IN`, `SIGNED_OUT`, `TOKEN_REFRESHED` — OR a **2000 ms safety timer**.
2. On slow networks / free-tier Supabase cold start, the first auth event arrives at ~2.5–5 s. The safety timer wins.
3. `_initialAuthPromise` resolves with **no JWT still attached** to the Supabase client.
4. All cached stores are waiting on this promise inside `withTimeout(() => fetcher(), …)` — they immediately proceed to call the fetcher.
5. The fetcher issues Supabase queries **without a JWT** (anon key only) → RLS returns `[]` for authenticated tables.
6. `createCachedStore.publish({ data: [], loading: false, loadedAt: Date.now(), error: null })` — the store is now marked "successfully loaded" with empty data.
7. Later, `INITIAL_SESSION` arrives. `reviveStale()` at [src/lib/useSupabase.js:353-360](src/lib/useSupabase.js:353) runs — but its condition is `st.error || (st.loading && !st.loadedAt) || stale`. The store has `error=null`, `loading=false`, `loadedAt=Date.now()` → **fails all three** → never refetches.
8. Page shows "empty" state (which may render as a permanent skeleton depending on the component — see finding #7 in `03-admin-pages-loading.md`).

### Why hard refresh fixes it
Hard refresh restarts the bundle. `supabase.auth.getSession()` reads the serialized session from `localStorage` **synchronously before the 2 s timer starts ticking**, so the JWT is already attached before any fetcher runs.

### Reproduction hint
DevTools → Network → "Slow 3G" → load any authenticated page cold. Skeleton hangs. Ctrl+F5 → loads instantly.

---

## 2. React StrictMode double-mount Web-Lock contention

**Severity: CRITICAL**
**Files:** [src/main.jsx:9](src/main.jsx:9), [src/lib/AuthContext.jsx:400-463](src/lib/AuthContext.jsx:400), [src/lib/AuthContext.jsx:442-451](src/lib/AuthContext.jsx:442)

### What happens
1. StrictMode wraps `<AuthProvider>` in `main.jsx`, so in dev the `useEffect` runs twice.
2. First effect: `init()` calls `supabase.auth.getSession()` which acquires the Web Lock (`sb-<ref>-auth-token-lock` via `navigator.locks`).
3. Cleanup runs: sets `active = false` and unsubscribes. But the pending `getSession()`/`getUser()` promise is **not aborted** — there's no AbortController.
4. Second effect starts: `init()` again calls `getSession()` → tries to acquire the same Web Lock.
5. After ~5 s, Supabase throws `NavigatorLockAcquireTimeoutError` ("Acquiring an exclusive Navigator LockManager lock 'sb-...auth-token-lock' immediately failed" or "Lock broken/orphaned").
6. The catch block at [src/lib/AuthContext.jsx:442-451](src/lib/AuthContext.jsx:442) checks `isTransientAuthLockError(e)` → retries once after 200 ms.
7. If retry ALSO hits the orphaned lock (common when the first effect's promise is still running), we reach `if (active) clearState()` at line 450.
8. State becomes `{ isAuthenticated: false, loading: false, ready: true }`.
9. `RequireCustomerAuth`/`RequireStaff` see `!isAuthenticated` → `<Navigate to="/login">`.
10. User sees the login page blinking even though a valid session exists in `localStorage`.

### Why hard refresh fixes it
A full page reload means `createRoot().render()` runs once (StrictMode's double-invoke only happens across a component mount/unmount cycle, not across a full reload). One Web Lock acquisition, no contention.

### Reproduction hint
Observable in dev mode (prod drops StrictMode double-invoke). Watch the console — you'll see `NavigatorLockAcquireTimeoutError` during first load. Prod users can still hit this if they open the app in two tabs nearly simultaneously (cross-tab lock steal).

---

## 3. `ensureCurrentClientProfile()` called without a timeout in `init()`

**Severity: HIGH**
**Files:** [src/lib/AuthContext.jsx:164](src/lib/AuthContext.jsx:164), [src/lib/AuthContext.jsx:262](src/lib/AuthContext.jsx:262), [src/lib/AuthContext.jsx:427](src/lib/AuthContext.jsx:427)

### What happens
1. `init()` awaits `syncSession(verifiedUser)` at [src/lib/AuthContext.jsx:427](src/lib/AuthContext.jsx:427).
2. `syncSession` awaits `resolveProfiles(supabaseUser)` at [src/lib/AuthContext.jsx:385](src/lib/AuthContext.jsx:385).
3. `resolveProfiles` awaits `ensureCurrentClientProfile()` at line 164 (admin path) **and** line 262 (buyer path) — **both with bare `await`, no timeout wrapper**.
4. If the heal RPC hangs (long-running DB transaction, RLS stall, free-tier cold start), this await blocks indefinitely.
5. `init()` never reaches its `finally { setLoading(false) }` block.
6. AuthContext state stays `{ loading: true, ready: false }` forever.
7. Every `RequireCustomerAuth`/`RequireStaff` gate shows `.app-loader-spinner` indefinitely.

**Notable asymmetry**: `register()` at line 688 and line 715 DOES wrap `ensureCurrentClientProfile` and `syncSession` with `withAuthTimeout(..., 5_000|6_000, ...)`. The `init()` and `login()` paths do NOT. This is an oversight.

### Why hard refresh fixes it
Hard refresh re-triggers `init()`. The RPC may complete faster on retry (warm connection, cached plan). Also: if a network glitch was the cause, the retry often succeeds.

### Reproduction hint
Artificially slow the RPC (e.g. add `pg_sleep(60)` in `heal_my_client_profile_now`). Load the app cold. Infinite spinner. Hard refresh → eventually completes.

---

## 4. `initDone.current` drops `SIGNED_IN` events that arrive during slow init

**Severity: HIGH**
**Files:** [src/lib/AuthContext.jsx:334](src/lib/AuthContext.jsx:334), [src/lib/AuthContext.jsx:496-499](src/lib/AuthContext.jsx:496), [src/lib/AuthContext.jsx:455-460](src/lib/AuthContext.jsx:455)

### What happens
1. `init()` starts. `initDone.current = false`.
2. An auth event (`INITIAL_SESSION` / `TOKEN_REFRESHED` / `SIGNED_IN`) fires mid-init.
3. The `onAuthStateChange` handler at [line 496-499](src/lib/AuthContext.jsx:496): `if (!active || !initDone.current) return` — **event dropped silently**.
4. `init()` eventually completes and sets `initDone.current = true` in the finally block at line 457. But by then, the only `SIGNED_IN` event we had for this session has already been discarded.
5. If `init()` itself failed to resolve profiles (e.g. the getSession/getUser path errored but `clearState()` ran), we're now in `{ adminUser: null, clientProfile: null, isAuthenticated: false }`, and no future event will re-sync because Supabase doesn't re-emit `INITIAL_SESSION`.
6. User is stuck at login screen despite a valid session.

### Why hard refresh fixes it
Fresh page load → `INITIAL_SESSION` fires again → this time init() hopefully completes in sequence without racing with the event.

### Reproduction hint
Rare — needs precise timing. Most visible when auth init path is slow (e.g. ensureCurrentClientProfile hangs, see #3).

---

## 5. Visibility `revalidateNow` runs in parallel with `init()` on first mount

**Severity: HIGH**
**Files:** [src/lib/AuthContext.jsx:488-494](src/lib/AuthContext.jsx:488), [src/lib/useSupabase.js:365-367](src/lib/useSupabase.js:365)

### What happens
1. Effect registers `document.addEventListener('visibilitychange', onVisibility)` AFTER `init()` is called synchronously at line 463.
2. But a `visibilitychange` event can fire at any time after the listener is registered — including while init() is still awaiting `getUser()`.
3. `revalidateNow('visibilitychange')` calls `supabase.auth.getUser()` — which goes to the same Web Lock that init() is holding.
4. Free-tier cold start + StrictMode double-mount + visibility revalidate = three competitors for the same lock.
5. The one that times out first can trigger `hardLogout(error)` from line 477 → `clearState()` → user kicked out.

Also: [src/lib/useSupabase.js:365-367](src/lib/useSupabase.js:365) attaches `reviveStale` on visibility/focus/online. Fires concurrently with the above.

### Why hard refresh fixes it
Fresh page usually starts while the tab is already "visible" (user just clicked refresh), so no visibilitychange fires. Simpler sequence, less contention.

### Reproduction hint
Cold-load the app, immediately alt-tab away and back. Skeleton appears more often than normal load.

---

## 6. `_initialAuthPromise` never resets except on `SIGNED_OUT` or user-switch

**Severity: HIGH**
**Files:** [src/lib/useSupabase.js:62-84](src/lib/useSupabase.js:62), [src/lib/useSupabase.js:108-134](src/lib/useSupabase.js:108)

### What happens
1. `_initialAuthPromise` is module-scoped. Built lazily, resolves on first auth event OR 2 s safety timer.
2. If the safety-timer path resolves it (finding #1), the promise stays resolved forever.
3. Subsequent navigations call `awaitInitialAuth()` → get the already-resolved promise → proceed without the JWT check.
4. Every subsequent fetch on the session inherits the "resolved-without-auth" state.
5. Reset only happens on `SIGNED_OUT` (line 111-117) or user-switch (line 122-128). A slow-but-eventual `INITIAL_SESSION` DOES NOT re-resolve the promise, so nothing triggers a re-fetch.

### Why hard refresh fixes it
Module re-evaluation → `_initialAuthPromise = null` → first `awaitInitialAuth()` rebuilds it from scratch, this time with the (now-cached) session.

### Reproduction hint
Use the app normally after cold-loading on slow network. Navigating between pages shows empty data indefinitely until you hard-refresh.

---

## 7. `syncInflightRef` coalesces by `userId`, silently dropping distinct sessions

**Severity: HIGH**
**Files:** [src/lib/AuthContext.jsx:371-398](src/lib/AuthContext.jsx:371)

### What happens
1. `syncSession` coalesces concurrent calls for the **same** `uid` to share a single in-flight promise.
2. When two concurrent `syncSession(user)` calls happen with `user.id = null` (e.g. during sign-out transition where a lingering `USER_UPDATED` fires after `SIGNED_OUT`), they coalesce using `uid = undefined` — both end up sharing one "clear state" promise.
3. The `.finally` at line 391 checks `if (syncInflightRef.current && syncInflightRef.current.userId === uid)` — this clears correctly for the `uid=undefined` case.
4. But there's a narrow window: if `syncSession(null)` is called, it enters the `!supabaseUser` branch at line 372, clears state, and returns `{admin:null, client:null, profileStatus:null}`. It never goes through the inflight coalescing path. Not a real bug.
5. Real concern: if two TABS rapidly swap identity (via `onAuthStateChange` cross-tab propagation), the second tab's `syncSession(userB)` starts while tab A's `syncSession(userA)` is still inflight. Different uids, so they don't coalesce — **both run**. OK.

This one is actually less of a bug than initially suspected, but still worth noting for observability.

### Why hard refresh fixes it
Module re-initialization.

---

## 8. `registrationInProgressRef` can stick `true` on exception

**Severity: MEDIUM**
**Files:** [src/lib/AuthContext.jsx:599-739](src/lib/AuthContext.jsx:599)

### What happens
1. `register()` sets `registrationInProgressRef.current = true` at line 600.
2. The function has 7+ return paths. Most reset the ref before returning.
3. But some paths — e.g. an exception thrown from `upsertClient` that bubbles up BEFORE the `catch (e)` block at line 659 captures it — would skip the ref reset.
4. If the ref is stuck `true`, the `onAuthStateChange` handler at line 531 drops `SIGNED_IN` events indefinitely: `if (registrationInProgressRef.current && event === 'SIGNED_IN') return`.
5. The user stays signed-in-without-profile forever, showing RequireCustomerAuth's "Profil introuvable" panel.

### Why hard refresh fixes it
Ref is a React ref, reset on component remount. Full reload → fresh ref.

### Reproduction hint
Hard to trigger by design; happens if a synchronous throw occurs inside the register `try` block before the explicit `catch` at the top of the function.

---

## 9. `hardLogout` in the init `catch` block can stall itself

**Severity: MEDIUM**
**Files:** [src/lib/AuthContext.jsx:454](src/lib/AuthContext.jsx:454), [src/lib/AuthContext.jsx:355-369](src/lib/AuthContext.jsx:355)

### What happens
1. `init()` catch block at line 454 awaits `hardLogout(e?.message || 'init error')`.
2. `hardLogout` awaits `supabase.auth.signOut()` — which can hang (e.g. flaky network + held Web Lock).
3. `signOut()` is NOT wrapped in `withAuthTimeout` here (only in `logout()` at line 745).
4. If it hangs, the catch block hangs → finally never runs → `setLoading(false)` never fires.
5. UI is stuck on `.app-loader-spinner`.

### Why hard refresh fixes it
Restarts the hung request.

### Reproduction hint
Artificially throttle network to zero after page load but before signOut completes.

---

## 10. Three concurrent `onAuthStateChange` subscribers

**Severity: MEDIUM**
**Files:** [src/lib/supabase.js:116-130](src/lib/supabase.js:116), [src/lib/useSupabase.js:71-78](src/lib/useSupabase.js:71), [src/lib/useSupabase.js:108-134](src/lib/useSupabase.js:108), [src/lib/AuthContext.jsx:496-544](src/lib/AuthContext.jsx:496)

### What happens
1. **Subscriber A** (supabase.js line 117): hash stripping + recovery flag. Always runs.
2. **Subscriber B** (useSupabase.js line 71): `buildInitialAuthPromise`'s one-shot listener. Unsubs itself after first matching event.
3. **Subscriber C** (useSupabase.js line 108): user-switch detector. Module-scope, never unsubs.
4. **Subscriber D** (useSupabase.js line 373): `reviveStale` on auth events. Module-scope, never unsubs.
5. **Subscriber E** (AuthContext.jsx line 496): session sync. Unsubs on unmount.

Five subscribers. They all run on every auth event. Order is "registration order" (Supabase client internals). Each does its own async work.

**Consequence:** for a single `TOKEN_REFRESHED` event, the client makes concurrent `getUser()` calls from both the revalidator (AuthContext line 472) and the stores being refreshed by `reviveStale`. Web Lock contention again.

Under StrictMode, subscribers B, C, D are duplicated (never unsubbed) because the effect re-runs and re-registers them at module scope. **Four `reviveStale` handlers on auth events means 4x the refresh storms on every TOKEN_REFRESHED.**

### Why hard refresh fixes it
All module-scope state is reset, duplicates are gone.

### Reproduction hint
Dev mode only. Observable in the Network tab: on a TOKEN_REFRESHED, 4x the expected number of fetches fire.

---

## 11. `safety-net` 15-minute revalidate interval compounds with visibility revalidate

**Severity: LOW**
**Files:** [src/lib/AuthContext.jsx:494](src/lib/AuthContext.jsx:494)

### What happens
Not a stuck-skeleton cause directly, but: a 15-minute `setInterval` calls `revalidateNow('safety-net')`. For a user keeping the tab open for hours, this periodically fires `getUser()`. If it throws a transient lock error while the user is actively using the page, we hit the existing `isTransientAuthLockError` path which quietly swallows — OK. But on a cross-tab steal, the user sees a brief skeleton flash.

### Why hard refresh fixes it
N/A — this path doesn't stick, just causes intermittent flicker.

---

## 12. Recovery hash `type=recovery` detected AFTER `maybeStripAuthHash`

**Severity: LOW**
**Files:** [src/lib/supabase.js:107-111](src/lib/supabase.js:107)

### What happens
Line 108: `detectAndFlagRecoveryHash()` runs.
Line 111: `maybeStripAuthHash()` runs.

The detection DOES happen first, flag is set, then strip runs. OK.

But the comment at line 107-110 says "Detect type=recovery FIRST so the flag survives the hash strip." — that's the design. But if `maybeStripAuthHash` is also called AGAIN from the `onAuthStateChange` handler at line 126, and the hash arrived late (e.g. via `detectSessionInUrl`), the flag may already have been cleared by a `SIGNED_OUT`.

Low impact on stuck skeletons but worth noting.

---

## 13. `verifiedUser` re-check uses `!active` ref but doesn't unregister the listener on unmount

**Severity: LOW**
**Files:** [src/lib/AuthContext.jsx:546-551](src/lib/AuthContext.jsx:546)

### What happens
Cleanup at line 546 sets `active = false` and unsubs the `onAuthStateChange` subscription. OK. But the `revalidateNow` has async network calls in flight that check `if (!active) return` — these paths are correct.

No real bug found here.

---

## Summary: the cascade

The recurring pattern is:

1. **Slow cold network** → `awaitInitialAuth` 2 s timer wins → first fetches run with no JWT → RLS returns empty → stores mark "loaded" with empty data → `reviveStale` never retriggers because `error=null, loading=false, loadedAt>0`.
2. **StrictMode in dev** → Web Lock contention → false negatives on `!isAuthenticated` → redirect loops.
3. **`ensureCurrentClientProfile` with no timeout** → indefinite hang → `setLoading(false)` never runs → `.app-loader-spinner` forever.
4. **Subscribers accumulating at module scope** → duplicate refreshes on every auth event → apparent "weird stuff" from the user's POV.

Hard refresh resets module scope, rereads the cached session synchronously, and re-serializes the auth pipeline before any store fetches.
