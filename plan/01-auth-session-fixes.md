# Plan 01 — Auth / Session Race Condition Fixes

## Executive summary

This plan fixes the 13 boot-time auth/session race conditions documented in [reserch/01-auth-session-races.md](../reserch/01-auth-session-races.md). These races cause the symptom the team keeps hitting: "cold load hangs on the spinner, empty data, or bounces to `/login` — hard refresh fixes it." Root causes cluster around (a) a 2-second safety timer that resolves the auth gate with no JWT, (b) un-timed RPC calls inside `init()` that can hang forever, (c) React StrictMode + un-aborted `getSession()` triggering Web Lock contention, and (d) multiple scattered `onAuthStateChange` subscribers duplicating work.

Scope: roughly 5 source files touched directly ([src/lib/AuthContext.jsx](../src/lib/AuthContext.jsx), [src/lib/supabase.js](../src/lib/supabase.js), [src/lib/useSupabase.js](../src/lib/useSupabase.js), [src/components/RequireCustomerAuth.jsx](../src/components/RequireCustomerAuth.jsx), [src/components/RequireStaff.jsx](../src/components/RequireStaff.jsx)) plus 2–3 new utility files under `src/lib/`. Estimated total effort: 2–3 developer days if done sequentially, or a single focused sprint if split across two developers working on independent items in parallel.

Each fix below is designed to ship as its own commit / PR so you can land the CRITICAL items first and gate the rest behind QA.

---

## Prerequisites

- **No hard dependency on Plan 02 (cache-store fixes).** Both plans are independent. However, item 1 here (replace the 2-second timer) directly reduces the "empty cache on cold load" symptom that Plan 02 also works around. Landing this plan first makes Plan 02 simpler because you can delete some defensive revive-stale code.
- **Light dependency on Plan 07 (watchdog & retry UI).** Item 3 (wrapping `ensureCurrentClientProfile`) and item 9 (wrapping `signOut` in `hardLogout`) rely on a generic `withAuthTimeout` utility that Plan 07's UI watchdog can also reuse. Ship the utility here first, then Plan 07 consumes it.
- Node + pnpm/npm toolchain unchanged. No database migrations required. No env var changes.
- Before starting, confirm that `@supabase/supabase-js` is pinned (check [package.json](../package.json)) — some of the event names referenced (`INITIAL_SESSION`, `PASSWORD_RECOVERY`) are only emitted by v2.33+. If older, bump first.
- Dev reproduction should be possible via DevTools Network → "Slow 3G" and React StrictMode already enabled in [main.jsx:9](../src/main.jsx:9). Verify both work on your machine before writing fixes.

---

## Plan items

Items are numbered in recommended implementation order. Each item is a self-contained, revertable commit. Severity tags come from the research file.

---

### 1. Replace the 2-second `awaitInitialAuth` safety timer with a session-aware gate

Severity: **CRITICAL**

**Root cause**: [src/lib/useSupabase.js:62-84](../src/lib/useSupabase.js:62) — `buildInitialAuthPromise` resolves on the first of `INITIAL_SESSION` / `SIGNED_IN` / `SIGNED_OUT` / `TOKEN_REFRESHED` OR a 2000 ms safety timer; on slow networks the timer wins and every subsequent fetcher runs with no JWT attached.

**Target behavior**: the gate resolves only when we have a definitive answer about the session state: either an auth event fired, OR `supabase.auth.getSession()` returned and we know whether a JWT is attached. Anonymous visitors resolve fast (no session in storage → resolve immediately). Authenticated users wait until the JWT is actually attached to the client.

**Implementation sketch** (new shape of `buildInitialAuthPromise`):

```js
// src/lib/useSupabase.js
function buildInitialAuthPromise() {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try { sub?.subscription?.unsubscribe() } catch { /* ignore */ }
      resolve()
    }

    // Path A: subscribe to the event stream. If INITIAL_SESSION / SIGNED_IN /
    // SIGNED_OUT / TOKEN_REFRESHED arrives, we're done.
    const sub = supabase.auth.onAuthStateChange((event) => {
      if (
        event === 'INITIAL_SESSION' || event === 'SIGNED_IN' ||
        event === 'SIGNED_OUT'      || event === 'TOKEN_REFRESHED'
      ) finish()
    })

    // Path B: synchronously check storage. getSession() reads the
    // persisted JWT from localStorage FAST — it does NOT make a network
    // call. If there is no session, resolve immediately (anon visitor).
    // If there IS a session, stay subscribed; the INITIAL_SESSION event
    // will arrive on the next tick with the decoded user attached.
    supabase.auth.getSession().then(({ data }) => {
      if (!data?.session) finish() // anon — unblock hooks
      // else: wait for INITIAL_SESSION. Do NOT resolve on a timer.
    }).catch(() => finish()) // broken client — unblock so UI can render error

    // Last-resort failsafe: if NO event fires in 15s AND getSession() did
    // not resolve either, something is catastrophically wrong. Unblock
    // so the UI can show an error instead of a forever-spinner.
    // This is ~7x the old timeout — long enough to be conservative,
    // short enough that a truly dead network surfaces in the UI.
    window.setTimeout(finish, 15_000)
  })
}
```

**Key differences from current code**:

- No more 2000 ms unconditional timer. The 15 s ceiling is a failsafe, not a race trigger.
- An anon visitor's `getSession()` returns `null` → resolves immediately → no wait for data pages.
- An authenticated user's `getSession()` returns a session → we stay subscribed and wait for `INITIAL_SESSION` (typically arrives <500 ms after `getSession`).

**Verification**:

1. DevTools → Network → "Slow 3G". Clear localStorage. Load `/login`. Page renders immediately (anon path).
2. Log in, let the JWT persist. Reload on "Slow 3G". Page waits up to a few seconds then renders data — not a skeleton and not an empty table.
3. Add `console.log('[gate] resolved')` inside `finish()` for the test. Confirm it only fires once.
4. Confirm in the Network tab that the first `/rest/v1/` query carries an `apikey` AND `Authorization: Bearer ...` header.

**Rollback plan**: revert the commit. The old 2 s timer behavior returns. No data migration, no config, single file change.

**Risk / trade-offs**:

- Slightly longer cold-load on slow networks for authenticated users (up to ~3–5 s vs. old 2 s). This is the correct trade-off — the old fast path was returning empty data silently.
- If Supabase v2 ever changes the event semantics (e.g. stops emitting `INITIAL_SESSION` when there's no session), the 15 s failsafe still unblocks the UI. Document the failsafe in a comment.
- Edge case: `getSession()` rejects (very rare). The `.catch(finish)` ensures we don't hang.

**Estimated effort**: **S** (under 2 hours). Single function rewrite.

---

### 2. Abort in-flight `init()` work on StrictMode double-mount

Severity: **CRITICAL**

**Root cause**: [src/lib/AuthContext.jsx:400-463](../src/lib/AuthContext.jsx:400) — the `useEffect` starts `init()` which awaits `supabase.auth.getSession()`/`getUser()`; when StrictMode runs the effect twice in dev, the first effect's promise is not aborted on cleanup, so the second `init()` competes for the Web Lock, times out, and triggers `clearState()` → user gets bounced to `/login`.

**Target behavior**: when the effect cleans up (StrictMode unmount, route change, tab close), any in-flight auth calls made by that effect are best-effort cancelled or at minimum their results are ignored. The second effect run acquires the lock cleanly.

**Implementation sketch**:

```jsx
// src/lib/AuthContext.jsx, inside the main useEffect (~line 400)
useEffect(() => {
  let active = true
  const ac = new AbortController() // NEW
  let validateTimer = null

  async function init(allowLockRetry = true) {
    try {
      // Pass ac.signal down. Supabase SDK does not accept AbortSignal
      // on auth calls directly (as of v2), so we also check `active`
      // after every await (already done) AND race the call against
      // the signal to short-circuit on abort.
      const sessionPromise = supabase.auth.getSession()
      const { data: { session } } = await raceAgainstAbort(sessionPromise, ac.signal)
      if (!active || ac.signal.aborted) return
      // ... rest of init unchanged ...
    } catch (e) {
      if (e?.name === 'AbortError' || ac.signal.aborted) return
      if (isTransientAuthLockError(e)) {
        // existing retry logic, but also abort-aware:
        if (allowLockRetry && active && !ac.signal.aborted) {
          await new Promise((r) => setTimeout(r, 200))
          if (active && !ac.signal.aborted) {
            await init(false)
            return
          }
        }
        if (active) clearState()
        return
      }
      // ... existing error paths ...
    }
  }

  init()
  // ... subscribe to visibility, interval, onAuthStateChange (unchanged) ...

  return () => {
    active = false
    ac.abort() // NEW — the signal propagation above short-circuits awaits
    if (validateTimer) window.clearInterval(validateTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    subscription?.unsubscribe?.()
  }
}, [syncSession, clearState, hardLogout])
```

Where `raceAgainstAbort` is a new helper in [src/lib/authHelpers.js](../src/lib/authHelpers.js) (new file — see "New infrastructure to introduce" below):

```js
// src/lib/authHelpers.js
export function raceAgainstAbort(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}
```

**Why this works**: the first effect's inflight `getSession()` can't be truly cancelled (Supabase holds the Web Lock), but (a) we immediately drop its result via the `AbortError` reject, (b) we skip the `clearState` path that was causing the `/login` bounce, and (c) when the second effect runs, it starts clean and gets a fresh chance at the lock once the native lock timeout expires.

**Verification**:

1. Dev mode, React StrictMode enabled. Clear localStorage. Log in fresh. Reload the page 10 times. Console should show no `NavigatorLockAcquireTimeoutError` warnings **and** no `/login` flicker.
2. Add `console.log('[auth] init start')` and `console.log('[auth] init end')`. Confirm you see two starts and up to two ends, but the first end is cleanly short-circuited (log "aborted" if you want to observe).
3. Prod build (`pnpm build && pnpm preview`): StrictMode is stripped. Verify init runs once.

**Rollback plan**: revert. No storage / config change.

**Risk / trade-offs**:

- Supabase's internal Web Lock is NOT aborted — the underlying network request may still complete in the background. That's OK; we just don't use its result.
- Edge case: if `abort()` fires between awaits where we don't race, the code still relies on the existing `!active` checks. Audit the function to ensure every post-await early-return uses `!active || ac.signal.aborted`.
- Do NOT pass `ac.signal` into helpers that will abort underlying Supabase internals — `supabase-js` does not yet support cancellation tokens and a reject inside its lock path could leave the lock orphaned.

**Estimated effort**: **M** (half a day). Careful `await`-point audit required.

---

### 3. Add timeouts to every `ensureCurrentClientProfile()` call in `init()` and `login()`

Severity: **HIGH**

**Root cause**: [src/lib/AuthContext.jsx:164](../src/lib/AuthContext.jsx:164) (admin path) and [src/lib/AuthContext.jsx:262](../src/lib/AuthContext.jsx:262) (buyer path) — the heal RPC is awaited raw with no timeout. `register()` wraps it with `withAuthTimeout` at [line 688](../src/lib/AuthContext.jsx:688); `init()` and `login()` do not.

**Target behavior**: every `ensureCurrentClientProfile()` call (and every Supabase auth call anywhere in this file) is wrapped in `withAuthTimeout`. On timeout we log a warning and continue with whatever data we have — we never hang forever.

**Implementation sketch**:

```js
// src/lib/AuthContext.jsx, inside resolveProfiles (admin branch, ~line 164)
let healed = null
try {
  healed = await withAuthTimeout(
    ensureCurrentClientProfile(),
    8_000,                // 8s — generous for cold RPC, short enough to not feel dead
    'ensureClientProfile[admin]',
  )
} catch (e) {
  // Timeout or RPC error. Log and continue with `client = initialClient`.
  safeWarn('resolveProfiles[admin] heal timed out/failed:', e)
  healError = String(e?.message || e)
  // Continue — we still have initialClient.
}
```

Same shape at line 262 (buyer branch). Additionally, the subsequent `fetchAuthClientProfile(authUser.id)` call on line 174 and line 275 should also get a timeout wrap — they are network calls that can hang.

`login()` at [AuthContext.jsx:580](../src/lib/AuthContext.jsx:580) calls `ensureCurrentClientProfile()` raw as a retry fallback — wrap it too with `withAuthTimeout(..., 5_000, 'ensureClientProfile[loginRetry]')`.

**Pattern to standardize**: in this file, every `await <supabase-or-RPC-call>` MUST be inside a `withAuthTimeout`. Audit for `await supabase.auth.`, `await ensureCurrentClientProfile`, `await fetchAuth*`, `await upsertClient*` — wrap anything that's bare. Create a checklist at the top of the file:

```js
// AUDIT RULE: every network call in AuthContext MUST be wrapped in
// withAuthTimeout(). Exceptions: storage-only calls (getSession reads
// localStorage, is effectively synchronous) are exempt but still
// benefit from a generous 10s wrapper for defensive clarity.
```

**Verification**:

1. Monkey-patch `ensureCurrentClientProfile` to `await new Promise(()=>{})` (never resolves). Load the app. After 8 s you should see: `safeWarn('... heal timed out/failed ...')` in console, AuthContext transitions to `ready=true, loading=false, clientProfile=null`, and `RequireCustomerAuth` shows the "Profil introuvable" panel — NOT the infinite spinner.
2. Normal-network run: no timeouts fire, behavior unchanged from today.

**Rollback plan**: revert. No side effects on the DB.

**Risk / trade-offs**:

- Timeouts mean a slow-but-legitimate heal RPC might get abandoned. 8 s is the compromise; adjust if logs show frequent timeouts in prod.
- If `fetchAuthClientProfile` times out, `client` stays `null`, and the user may see "Profil introuvable" even though their profile exists. The existing "Réessayer" button in [RequireCustomerAuth](../src/components/RequireCustomerAuth.jsx:39) recovers — verify that flow still works.
- Do NOT swallow the timeout silently without logging — loss of observability.

**Estimated effort**: **S** (1–2 hours). Mechanical wrapping.

---

### 4. Buffer auth events that arrive during `init()` instead of dropping them

Severity: **HIGH**

**Root cause**: [src/lib/AuthContext.jsx:497](../src/lib/AuthContext.jsx:497) — the handler does `if (!active || !initDone.current) return`, silently dropping any event that arrives mid-init. If `init()` itself fails and runs `clearState()`, the dropped `SIGNED_IN` is never replayed because Supabase does not re-emit it.

**Target behavior**: events received during init are queued in a ref. When init finishes, we drain the queue and process the last meaningful event (the `SIGNED_IN` or `TOKEN_REFRESHED` with the freshest session) if our post-init state doesn't already reflect it.

**Implementation sketch**:

```jsx
// src/lib/AuthContext.jsx
const pendingAuthEventRef = useRef(null) // NEW

// In the useEffect, inside onAuthStateChange handler (~line 496):
const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
  if (!active) return
  if (!initDone.current) {
    // Buffer the most recent meaningful event. Overwrite older ones
    // (the latest session is always the most authoritative).
    if (
      event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' ||
      event === 'USER_UPDATED' || event === 'SIGNED_OUT' ||
      event === 'INITIAL_SESSION'
    ) {
      pendingAuthEventRef.current = { event, session }
    }
    return
  }
  // ... existing processing unchanged ...
})

// In init()'s finally block (~line 455):
} finally {
  if (active) {
    initDone.current = true
    setLoading(false)
    // Drain any event we queued during init.
    const pending = pendingAuthEventRef.current
    pendingAuthEventRef.current = null
    if (pending) {
      // Only process if our current state doesn't already match the
      // pending event's session. Otherwise it's redundant.
      const currentUid = /* read user state */
      const pendingUid = pending.session?.user?.id || null
      if (pendingUid !== currentUid) {
        // Replay by calling the handler ourselves. Wrap in queueMicrotask
        // so we don't recursively enter init's finally.
        queueMicrotask(() => {
          // Re-dispatch into the same handler logic. Factor the body of
          // the onAuthStateChange callback into a named function you can
          // call from here AND from the subscribe itself.
        })
      }
    }
  }
}
```

**Refactor** (needed to make the drain clean): extract the body of the `onAuthStateChange` callback into a local `handleAuthEvent(event, session)` function. The subscribe just calls it; the drain calls it. Easier to test and reason about.

**Verification**:

1. Artificially slow `ensureCurrentClientProfile` to take 6 s. Inside that window, refresh the page (triggers `INITIAL_SESSION` on the new mount). Confirm the event is buffered — log `'[auth] buffered event:', event` in the `initDone.current === false` branch.
2. Log `'[auth] draining buffered event'` at drain time. Confirm it fires AFTER `init()` settles.
3. Regression test: normal-speed login should still work; the buffer is typically empty.

**Rollback plan**: revert. The pre-existing `if (!active || !initDone.current) return` is safe to restore.

**Risk / trade-offs**:

- If the buffered event is stale by the time we drain (e.g. user signed out in another tab between buffer and drain), processing it is wasted work but not incorrect — the subsequent `getUser()` check will catch the mismatch.
- Order matters: drain ONLY after `setLoading(false)` and `initDone.current = true` so the handler's early-return is no longer active.

**Estimated effort**: **M** (half a day). Includes the refactor of the handler body into a named function.

---

### 5. Delay visibility / focus revalidation until `init()` has finished

Severity: **HIGH**

**Root cause**: [src/lib/AuthContext.jsx:488-494](../src/lib/AuthContext.jsx:488) — the visibility listener is attached right after `init()` is called synchronously. A `visibilitychange` event fired while `init()` is still awaiting `getUser()` triggers a second concurrent `getUser()`, competing for the same Web Lock.

**Target behavior**: revalidation triggers (visibility, focus, online, safety-net interval) are no-ops until `initDone.current === true`. On init completion, we run one catch-up revalidation if the tab was hidden during init.

**Implementation sketch**:

```jsx
// src/lib/AuthContext.jsx, ~line 469
async function revalidateNow(reason) {
  if (!active || !initDone.current) {
    // Mark that we wanted a revalidation but skipped it.
    pendingRevalidationRef.current = reason
    return
  }
  // ... existing body ...
}

// In init's finally (alongside event-buffer drain):
if (pendingRevalidationRef.current) {
  const reason = pendingRevalidationRef.current
  pendingRevalidationRef.current = null
  queueMicrotask(() => revalidateNow(`post-init:${reason}`))
}
```

Also: the interval at [line 494](../src/lib/AuthContext.jsx:494) should be armed **inside** `init()`'s finally block, not synchronously. Otherwise its first tick can race too (though at 15 min intervals, much less likely).

**Verification**:

1. Open app in a hidden tab (open in background), let cold-init start, switch to the tab mid-init. Previously: lock-contention warning + possible `/login` bounce. After fix: clean init, then one post-init revalidation.
2. Count network requests to `/auth/v1/user` on cold load — should be exactly 1 during init (the one `init()` itself makes), not 2 or 3.

**Rollback plan**: revert. Low risk.

**Risk / trade-offs**:

- Slightly delayed "catch-up" revalidation on visibility. For the user this is invisible.
- The safety-net interval first firing gets pushed to `init + 15min` instead of raw 15 min from mount — preferred.

**Estimated effort**: **S** (1–2 hours).

---

### 6. Reset `_initialAuthPromise` when `INITIAL_SESSION` finally arrives late

Severity: **HIGH**

**Root cause**: [src/lib/useSupabase.js:62-84](../src/lib/useSupabase.js:62) — once the 2 s safety timer resolves the module-level promise, a later `INITIAL_SESSION` does not re-resolve it; all subsequent navigations reuse the already-resolved (JWT-less) promise.

**Note**: item 1 above largely removes this issue by eliminating the 2 s timer. But the 15 s failsafe remains and the defensive reset is still worth adding for robustness.

**Target behavior**: if the failsafe timer (not an event) is what resolved the gate, the next arriving real auth event causes a re-resolution AND triggers a `reviveStale` pass across all cached stores.

**Implementation sketch**:

```js
// src/lib/useSupabase.js
let _gateResolvedVia = null // 'event' | 'failsafe' | 'no-session'

function buildInitialAuthPromise() {
  return new Promise((resolve) => {
    let settled = false
    const finish = (via) => {
      if (settled) return
      settled = true
      _gateResolvedVia = via
      try { sub?.subscription?.unsubscribe() } catch { /* ignore */ }
      resolve()
    }
    const sub = supabase.auth.onAuthStateChange((event) => {
      if (/* meaningful events */) finish('event')
    })
    supabase.auth.getSession().then(({ data }) => {
      if (!data?.session) finish('no-session')
    }).catch(() => finish('failsafe'))
    window.setTimeout(() => finish('failsafe'), 15_000)
  })
}

// In the top-level onAuthStateChange subscriber (~line 108):
supabase.auth.onAuthStateChange((event, session) => {
  // ... existing user-switch detection ...

  // If the gate was resolved via the failsafe path (no JWT was attached
  // when fetchers started), a late arriving real auth event means we
  // must (a) reset the gate so future callers re-await, and (b) trigger
  // a reviveStale pass so cached stores refetch with the real JWT.
  if (
    _gateResolvedVia === 'failsafe' &&
    (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')
  ) {
    _initialAuthPromise = null
    _gateResolvedVia = null
    // Force-revive all stores — their cache was loaded without a JWT.
    for (const s of _allCachedStores) {
      try { s.refresh({ force: true, background: false }).catch(() => {}) } catch { /* ignore */ }
    }
  }
})
```

**Verification**:

1. Monkey-patch `getSession` to resolve after 20 s (simulating network stall). Load a data page. Observe: failsafe fires, page shows "empty" briefly, then when `INITIAL_SESSION` arrives, stores refetch and data appears. No hard refresh needed.
2. Grep for `_gateResolvedVia` in DevTools — should be `'event'` in the common case, `'failsafe'` only in the stall scenario.

**Rollback plan**: revert.

**Risk / trade-offs**:

- The force-refresh bypasses the normal `staleMs` check; OK because we know the prior load was JWT-less.
- Keep `_gateResolvedVia` module-scope. Do NOT expose it to components — it's a gate-internal concept.

**Estimated effort**: **S** (1–2 hours). Requires item 1 to land first.

---

### 7. Make `syncInflightRef` robust against `uid === null` collisions

Severity: **HIGH** (per research, "less of a bug than initially suspected, but worth observability")

**Root cause**: [src/lib/AuthContext.jsx:371-398](../src/lib/AuthContext.jsx:371) — the inflight coalescing keys by `userId`. The research notes the current code's early-return branch handles `null` safely, but there's no observability if coalescing ever misfires.

**Target behavior**: logging + defensive guards for the `null`/`undefined` uid case; fail-loud in dev if two concurrent syncs with different uids ever coalesce into the same promise.

**Implementation sketch**:

```js
// src/lib/AuthContext.jsx ~line 371
const syncSession = useCallback(async (supabaseUser) => {
  const uid = supabaseUser?.id ?? null
  if (!uid) {
    // Null-uid path: always clears state. Never coalesces.
    syncInflightRef.current = null
    clearState()
    return { admin: null, client: null, profileStatus: null }
  }

  const inflight = syncInflightRef.current
  if (inflight) {
    if (inflight.userId === uid) return inflight.promise
    // DIFFERENT uid is already inflight. Rare but possible with rapid
    // cross-tab identity switches. Log it so we notice if it becomes
    // a pattern. We DO NOT coalesce mismatched uids.
    if (!import.meta.env?.PROD) {
      console.warn('[auth] syncSession race: prior inflight uid=', inflight.userId, 'new uid=', uid)
    }
  }

  const promise = (async () => { /* existing body */ })()
    .finally(() => {
      if (syncInflightRef.current?.userId === uid) syncInflightRef.current = null
    })
  syncInflightRef.current = { userId: uid, promise }
  return promise
}, [clearState])
```

**Verification**:

1. Devtools Console: no "syncSession race" warnings in normal usage.
2. Simulate user switch (sign out + sign in with another account rapidly in another tab) — at most one warning may appear, and it should not correspond to data leakage.

**Rollback plan**: revert.

**Risk / trade-offs**: purely observability/logging. No behavior change.

**Estimated effort**: **S** (30 minutes).

---

### 8. Use `try { ... } finally { registrationInProgressRef.current = false }` around all of `register()`

Severity: **MEDIUM**

**Root cause**: [src/lib/AuthContext.jsx:599-739](../src/lib/AuthContext.jsx:599) — the register flow has 7+ return paths that manually reset `registrationInProgressRef.current = false`. A synchronous throw before the explicit reset leaves it stuck `true`, causing the `onAuthStateChange` handler at [line 531](../src/lib/AuthContext.jsx:531) to drop all future `SIGNED_IN` events.

**Target behavior**: the ref is guaranteed to be reset exactly once, no matter which exit path is taken.

**Implementation sketch**:

```jsx
const register = useCallback(async (args) => {
  registrationInProgressRef.current = true
  try {
    // ... existing body verbatim, BUT DELETE every manual
    // `registrationInProgressRef.current = false` line inside.
    // All return statements keep their return values unchanged.
    // ...
    return /* whatever each branch returns */
  } finally {
    registrationInProgressRef.current = false
  }
}, [syncSession, clearState])
```

**Verification**:

1. Add `throw new Error('test')` synchronously after the `registrationInProgressRef.current = true` line (just for this test). Observe: the ref is `false` after the exception bubbles up. Remove the test throw.
2. Run the normal registration flow happy path and both failure paths (email conflict, phone conflict). Log the ref value after each — always `false`.
3. Make sure the extracted body has no syntactic regressions — the function is long and refactoring it into a try/finally requires careful line-by-line diff review.

**Rollback plan**: revert.

**Risk / trade-offs**:

- None functional. Pure correctness fix.
- Take care with the existing `safeError(...)` + `supabase.auth.signOut()` + `return` sequences inside the try — the finally block runs AFTER those, and we want the ref cleared AFTER signOut completes. That's exactly the desired order.

**Estimated effort**: **S** (1 hour). Mostly reading + verifying.

---

### 9. Wrap `signOut()` inside `hardLogout` with `withAuthTimeout`

Severity: **MEDIUM**

**Root cause**: [src/lib/AuthContext.jsx:355-369](../src/lib/AuthContext.jsx:355) — `hardLogout` awaits `supabase.auth.signOut()` raw. The `logout` callback at [line 745](../src/lib/AuthContext.jsx:745) does use `withAuthTimeout`; `hardLogout` does not. If signOut hangs (flaky network + held Web Lock), the catch block in `init()` stalls and `setLoading(false)` never runs.

**Target behavior**: `hardLogout` never blocks indefinitely. On timeout, the local state is cleared regardless of whether signOut succeeded.

**Implementation sketch**:

```js
// src/lib/AuthContext.jsx ~line 355
const hardLogout = useCallback(async (reason = '') => {
  try {
    if (reason) safeWarn('[auth] force signOut', reason)
    await withAuthTimeout(supabase.auth.signOut(), 5_000, 'hardLogout.signOut')
  } catch (e) {
    safeWarn('[auth] signOut failed or timed out (continuing):', e)
  } finally {
    forceClearSupabaseToken()
    clearState()
  }
}, [clearState])
```

**Verification**:

1. Monkey-patch `supabase.auth.signOut` to `async () => new Promise(() => {})` (hangs forever). Trigger a hardLogout path (e.g. set suspended admin user in DB, reload). Confirm: after 5 s the app is in signed-out state, spinner is gone, user is at `/login`.
2. Normal logout still works.

**Rollback plan**: revert.

**Risk / trade-offs**:

- If signOut's server call times out, the refresh token may still be valid server-side briefly. `forceClearSupabaseToken` handles the client side; the token will expire naturally or on next refresh attempt.
- Align the timeout (5 s) with the existing `logout()` callback for consistency.

**Estimated effort**: **S** (30 minutes).

---

### 10. Consolidate `onAuthStateChange` subscribers into a single module-level router

Severity: **MEDIUM**

**Root cause**: five distinct `onAuthStateChange` subscribers exist across [supabase.js:117](../src/lib/supabase.js:117), [useSupabase.js:71](../src/lib/useSupabase.js:71), [useSupabase.js:108](../src/lib/useSupabase.js:108), [useSupabase.js:373](../src/lib/useSupabase.js:373), and [AuthContext.jsx:496](../src/lib/AuthContext.jsx:496). Under StrictMode, some are duplicated. Each runs its own async work on every auth event, causing Web Lock contention and duplicated `getUser()` calls.

**Target behavior**: exactly ONE module-level subscriber that fans out to named internal listeners. Listeners register/unregister via a lightweight bus. The subscriber itself is idempotent — registering it twice is safe.

**Implementation sketch** (new file [src/lib/authEventBus.js](../src/lib/authEventBus.js)):

```js
// src/lib/authEventBus.js
import { supabase } from './supabase.js'

const listeners = new Map() // name -> (event, session) => void | Promise<void>
let registered = false

function ensureSubscribed() {
  if (registered) return
  registered = true
  try {
    supabase.auth.onAuthStateChange((event, session) => {
      for (const [name, fn] of listeners) {
        try {
          const r = fn(event, session)
          if (r && typeof r.catch === 'function') {
            r.catch((e) => console.warn(`[authEventBus:${name}]`, e))
          }
        } catch (e) {
          console.warn(`[authEventBus:${name}]`, e)
        }
      }
    })
  } catch {
    // Supabase client not constructed (missing env). Leave registered=false
    // so tests can retry.
    registered = false
  }
}

export function onAuth(name, fn) {
  ensureSubscribed()
  listeners.set(name, fn)
  return () => { listeners.delete(name) }
}
```

Then refactor the five current subscribers:

- [supabase.js:117](../src/lib/supabase.js:117) — replace with `onAuth('recovery-hash-strip', (event) => { ... })`.
- [useSupabase.js:71](../src/lib/useSupabase.js:71) — one-shot initial-auth listener. Keep a direct `supabase.auth.onAuthStateChange` here because it self-unsubscribes; OR (cleaner) use `onAuth('initial-gate', (event) => { ...; unsub() })` and have the returned `unsub` self-call.
- [useSupabase.js:108](../src/lib/useSupabase.js:108) — replace with `onAuth('user-switch-detect', ...)`.
- [useSupabase.js:373](../src/lib/useSupabase.js:373) — replace with `onAuth('revive-stale', ...)`.
- [AuthContext.jsx:496](../src/lib/AuthContext.jsx:496) — this is per-mount (registers inside useEffect). Keep it as-is OR route through `onAuth('auth-context-sync', ...)` and return the unsub in the effect's cleanup. Either is fine; routing through the bus makes it uniform.

**Verification**:

1. Open DevTools → Network → log auth events with `console.log`. After the refactor, on a `TOKEN_REFRESHED`: the bus logs each listener running in order; only ONE outer subscription exists (add a counter in `ensureSubscribed`).
2. Under StrictMode: the bus is still registered once. No doubled listeners.
3. Network tab: on a `TOKEN_REFRESHED`, the number of `/auth/v1/user` calls drops to exactly 1 (previously 2–4 due to duplicates).

**Rollback plan**: revert. This is the biggest refactor of the set; consider it a separate PR.

**Risk / trade-offs**:

- Changing the listener-registration order can change the observable order of side-effects on a given auth event. Preserve the current implicit order by registering in the same sequence (supabase.js first, then useSupabase.js pieces, then AuthContext).
- The bus deliberately does not support unsubscribing the outer Supabase subscription — for simplicity, it lives for the app's lifetime.

**Estimated effort**: **M/L** (half to full day). The refactor itself is small, but thorough testing across all auth transitions is required.

---

### 11. (Optional) Reduce the 15-minute safety-net interval's footprint

Severity: **LOW**

**Root cause**: [src/lib/AuthContext.jsx:494](../src/lib/AuthContext.jsx:494) — the 15-min interval calls `revalidateNow('safety-net')`. On a cross-tab lock steal it can flash the skeleton briefly.

**Target behavior**: only fire the safety-net tick when the tab is visible; otherwise skip.

**Implementation sketch**:

```js
validateTimer = window.setInterval(() => {
  if (document.visibilityState === 'visible') {
    revalidateNow('safety-net')
  }
}, 15 * 60_000)
```

**Verification**: tab hidden for 30 min → zero `getUser()` calls. Tab visible → one per 15 min.

**Rollback plan**: revert (one-line change).

**Risk / trade-offs**: trivial.

**Estimated effort**: **S** (15 minutes).

---

### 12. (Optional) Make `detectAndFlagRecoveryHash` idempotent across re-entries

Severity: **LOW**

**Root cause**: [src/lib/supabase.js:107-111](../src/lib/supabase.js:107) — documented design is correct (detect before strip), but if a `SIGNED_OUT` runs between the initial detection and a later hash event, the flag may be cleared prematurely.

**Target behavior**: the flag's lifecycle is explicitly scoped to "from PASSWORD_RECOVERY or initial-hash detection UNTIL the password is successfully reset OR user navigates away from /reset-password". Don't clear on `SIGNED_OUT` if we're on the `/reset-password` route.

**Implementation sketch**:

```js
// src/lib/supabase.js
if (event === 'SIGNED_OUT') {
  try {
    // Only clear the recovery flag if we're NOT on the reset-password page.
    const onResetPage = typeof window !== 'undefined' &&
      window.location.pathname.startsWith('/reset-password')
    if (!onResetPage) {
      window.sessionStorage.removeItem(RECOVERY_FLAG_KEY)
    }
  } catch { /* ignore */ }
}
```

**Verification**: open a recovery link, see `/reset-password` render. In another tab, sign out. Go back to reset-password tab — flag is still present, page still gates to password-reset mode.

**Rollback plan**: revert.

**Risk / trade-offs**:

- Minor: cross-tab isolation could lead to flag living beyond its usefulness. Acceptable because the reset-password page itself should clear it on successful reset.

**Estimated effort**: **S** (30 minutes).

---

### 13. (No fix) Confirm no bug in `verifiedUser` re-check

Severity: **LOW**

**Root cause**: The research file concludes "No real bug found here" for [AuthContext.jsx:546-551](../src/lib/AuthContext.jsx:546). No action required.

**Target behavior**: document this in the code as an explicit comment so future auditors don't re-open it:

```jsx
// [src/lib/AuthContext.jsx cleanup at ~line 546]
return () => {
  active = false
  // Note: in-flight async work in revalidateNow is guarded by `if (!active) return`
  // after every await. We do not need to abort those promises; they settle
  // into dead code. Verified in research/01-auth-session-races.md #13.
  if (validateTimer) window.clearInterval(validateTimer)
  // ...
}
```

**Verification**: N/A. Documentation-only.

**Estimated effort**: **S** (5 minutes).

---

## New infrastructure to introduce

These utilities are shared across multiple items above. Define them once, reference them from item sketches. Put them in a dedicated file so future features (Plan 07's watchdog UI, future hooks) can reuse them.

### `src/lib/authHelpers.js` (new file)

Exports:

- **`withAuthTimeout(promise, ms, label)`** — already exists inside [AuthContext.jsx:103](../src/lib/AuthContext.jsx:103) as a local function. Move it here and re-export. All call sites in `AuthContext.jsx` import from here. Also usable by Plan 07 and any future hook.

```js
export function withAuthTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error(`auth_timeout:${label}`)),
      ms,
    )),
  ])
}
```

- **`isTransientAuthLockError(errorLike)`** — move from [AuthContext.jsx:110](../src/lib/AuthContext.jsx:110) so other files can detect and handle these uniformly.

- **`raceAgainstAbort(promise, signal)`** — new, used by item 2. See sketch above.

- **`isAuthTimeoutError(e)`** — small helper for reading `auth_timeout:` prefix on error messages, so UI code can distinguish timeouts from genuine auth failures.

```js
export function isAuthTimeoutError(e) {
  return String(e?.message || '').startsWith('auth_timeout:')
}
```

### `src/lib/authEventBus.js` (new file, item 10)

Single fan-out `onAuthStateChange` wrapper. See item 10's sketch. Exports `onAuth(name, fn)`.

### `src/lib/initialAuthGate.js` (optional refactor — move from useSupabase.js)

The `awaitInitialAuth`, `buildInitialAuthPromise`, and associated `_gateResolvedVia` / `_initialAuthPromise` module state currently live inline in [useSupabase.js:57-134](../src/lib/useSupabase.js:57). Items 1 and 6 modify this heavily. Consider extracting them to their own file `src/lib/initialAuthGate.js` for:

- testability (gate logic is independent of the cached-store infrastructure),
- reuse (future modules may want `awaitInitialAuth()` without pulling in the whole store machinery),
- readability (`useSupabase.js` is already ~500 lines of its own mixed concerns).

Only do this extraction if you're landing items 1+6 in the same PR; otherwise leave in place to minimize churn.

---

## Migration guide for new code

Read this section if you are **writing a new page/hook/feature that needs auth**. It codifies the patterns this plan establishes.

### DO

- **Await the initial-auth gate before any data query.** Use the `createCachedStore` factory (which already awaits `awaitInitialAuth()` through `withTimeout`), or, if you must write a one-off fetch, call `await awaitInitialAuth()` explicitly before the Supabase query.

- **Gate data hooks on `ready && clientId` (or `ready && adminUser`).** Example:
  ```jsx
  const { ready, clientProfile } = useAuth()
  const clientId = clientProfile?.id ?? null
  const { data } = useMyDataHook({ clientId, enabled: ready && !!clientId })
  ```
  Never pass `clientId=null` into a fetcher that keys RLS queries by it.

- **Wrap every Supabase / RPC call in `withAuthTimeout`** when it lives inside `AuthContext.jsx` or the auth boot path. Elsewhere, `createCachedStore`'s internal timeout covers you.

- **Use the `authEventBus`** (item 10) instead of calling `supabase.auth.onAuthStateChange` directly. Named listeners = easier to audit, automatic fan-out.

- **Guard every `await`-point in long-running code** with a post-await `if (!active || signal.aborted) return` check. React effect cleanups MUST set `active = false` and (preferably) `ac.abort()`.

### DON'T

- **Don't write your own `onAuthStateChange` listener.** Register with the bus.

- **Don't `await` a Supabase auth call without a timeout.** Even `getSession()` (storage read) is safer with a 10 s cap because the Web Lock inside it can orphan.

- **Don't rely on a raw setTimeout fallback to "unblock" UI.** If your hook would want a `setTimeout(finish, 2000)` to avoid a hang, something upstream is wrong. Fix the upstream cause.

- **Don't introduce a new module-scope mutable that persists across HMR reloads unless you also handle the reset.** Tie resets to `SIGNED_OUT` and user-switch events via the `_storeResetHandlers` set pattern in [useSupabase.js:150](../src/lib/useSupabase.js:150).

- **Don't redirect to `/login` on `!isAuthenticated` without first checking `ready`.** The existing gates ([RequireCustomerAuth](../src/components/RequireCustomerAuth.jsx:16), [RequireStaff](../src/components/RequireStaff.jsx:83)) already do this correctly — mirror their shape.

### Pattern snippets to copy/paste when writing new code

**Hook that depends on a resolved client profile**:

```jsx
export function useMyThing() {
  const { ready, clientProfile } = useAuth()
  const clientId = clientProfile?.id ?? null

  // Bail out until auth is resolved AND we have an id. Do NOT
  // pre-fetch with clientId=null — RLS returns [] and confuses the
  // cached store.
  return useCachedHook({ enabled: ready && !!clientId, clientId })
}
```

**Protected route gate** (if you ever need a new one beyond the two existing):

```jsx
export default function RequireSomething({ children }) {
  const { loading, ready, isAuthenticated, /* ... */ } = useAuth()
  const location = useLocation()
  if (loading || !ready) {
    return <div className="app-loader"><div className="app-loader-spinner" /></div>
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  // ... custom permission checks ...
  return children
}
```

---

## Out of scope

These issues are real but belong to other plans, not this one. Do NOT try to fix them in this PR series.

- **Cache store invariants** (stale tracking, fetch generations, realtime channel teardown): handled in `plan/02-cache-store-fixes.md`. This plan's item 6 touches `reviveStale` minimally but leaves store internals alone.

- **UI watchdog / "slow connection" banner**: handled in `plan/07-watchdog-and-retry-ui.md`. The `withAuthTimeout` and `isAuthTimeoutError` helpers introduced here are consumed by that plan.

- **Per-page skeleton hangs** (admin page components reading stores incorrectly): handled in `plan/03-admin-pages-loading.md` (see research file `reserch/03-admin-pages-loading.md` finding #7).

- **RLS / database heal RPC latency**: fixing slow RPCs belongs in a backend plan. This plan only ensures that slow RPCs no longer hang the UI.

- **Session hijack / security hardening beyond recovery-hash**: belongs in the security audit plan (`plan/08-security-hardening.md` if/when created).

---

## Acceptance checklist

Tick each when verified in dev AND in a prod build.

### Functional

- [ ] Cold-load on "Slow 3G" with a valid session: page data renders within ~5 s; no permanent skeleton; no `/login` redirect.
- [ ] Cold-load on "Slow 3G" as anon: `/login` renders within 1 s (no waiting on the gate).
- [ ] Hard refresh on any authenticated page: still works as before (the regression we're avoiding).
- [ ] Logging in, then reloading 10 times back-to-back in dev (StrictMode) produces ZERO `/login` flickers.
- [ ] Logging in, then backgrounding the tab during init, then foregrounding: no duplicate `getUser()` calls (verify Network tab).
- [ ] Logging out on a network-stall simulation completes within 5 s; UI is in signed-out state.
- [ ] Password-reset link flow: `/reset-password` still gates correctly; signing out in another tab doesn't prematurely clear the recovery flag.

### Observability

- [ ] No `NavigatorLockAcquireTimeoutError` in console during normal dev usage.
- [ ] No `Uncaught (in promise)` errors on any auth transition.
- [ ] On `TOKEN_REFRESHED`: exactly ONE `/auth/v1/user` network request (verify in Network tab).
- [ ] `console.warn('[auth] syncSession race: ...')` fires zero times on normal usage.
- [ ] `[auth] buffered event:` log fires when artificially slowing init, and `[auth] draining buffered event` fires after init completes.

### Regression

- [ ] Existing registration flow (happy path + email-conflict + phone-conflict) unchanged in behavior.
- [ ] Existing admin-access checks unchanged; `RequireStaff` still shows `NotAllowedPanel` correctly.
- [ ] Existing 15-min safety-net revalidation still fires while tab is visible.
- [ ] All prior E2E tests pass (if any exist — run `pnpm test` / `pnpm e2e`).

### Code hygiene

- [ ] `withAuthTimeout` is imported from `src/lib/authHelpers.js` in every consumer (no duplicate local definitions).
- [ ] `authEventBus` is the only place in the codebase calling `supabase.auth.onAuthStateChange` (grep: a single match, inside `ensureSubscribed`).
- [ ] Each item landed as its own commit with a descriptive message referencing the severity tag (`fix(auth): [CRITICAL] ...`).
- [ ] `plan/01-auth-session-fixes.md` referenced from each commit message.

---

## Implementation order recap

Recommended sequence (respects dependencies):

1. Land the shared utilities first: `src/lib/authHelpers.js` (items 3 + 9 consume it).
2. Item 1 (initial-auth gate rewrite) — biggest win for cold-load symptoms.
3. Item 3 (wrap `ensureCurrentClientProfile`) — fast and unblocks infinite-spinner reports.
4. Item 9 (wrap `signOut`) — mechanical, low risk.
5. Item 2 (AbortController in `init()`) — eliminates the StrictMode lock contention.
6. Item 5 (delay visibility revalidation) — pairs naturally with item 2.
7. Item 4 (buffer auth events) — requires item 2's abort-awareness landing first.
8. Item 6 (reset gate on late INITIAL_SESSION) — requires item 1.
9. Item 8 (register try/finally) — independent, drop in anywhere.
10. Item 7 (syncInflight logging) — independent.
11. Item 10 (event bus refactor) — land LAST, biggest PR, requires stability from the others.
12. Items 11, 12 (optional polish).

Ship items 1–5 as PR 1 (CRITICAL + HIGH, half a sprint). Items 6–10 as PR 2 (MEDIUM, another half-sprint). Items 11–12 any time.
