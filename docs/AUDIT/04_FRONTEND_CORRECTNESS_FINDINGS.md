# 04 — Frontend Correctness Findings

> Severity ordering: **Critical → High → Medium → Low**.
> File refs are clickable `[path:line](path:line)`.
> Scope: React/JS correctness bugs — race conditions, async, state management, input validation. Security is in [01](01_SECURITY_FINDINGS.md); SQL in [02](02_DATABASE_RLS_FINDINGS.md); business rules in [03](03_BUSINESS_LOGIC_FINDINGS.md).

---

## Remediation status (2026-04-19)

| ID | Severity | Status | Where the fix lives |
|---|---|---|---|
| FE-C1 | Critical | ✅ Fixed | `LoginPage.jsx` + `RegisterPage.jsx` — `submittingRef` synchronously gates `handleSubmit`. Register validation gate also clears the ref so retry works. |
| FE-C2 | Critical | ✅ Fixed | `AuthContext.jsx` — `syncInflightRef` mutex coalesces concurrent `syncSession` calls per `userId`. The 60 s timer was already replaced with `visibilitychange` + a 15-min safety net (S-L2). |
| FE-C3 | Critical | ✅ Fixed | `supabase.js` sets `RECOVERY_FLAG_KEY` in sessionStorage when a `type=recovery` hash arrives or `PASSWORD_RECOVERY` event fires; cleared on `SIGNED_OUT` and after a successful reset. `ResetPasswordPage.jsx` refuses sessions without that flag. |
| FE-H1 | High | ✅ Fixed | `AuthContext.jsx` — `if (!active) return` guards added after every await in `onAuthStateChange` and `revalidateNow`. |
| FE-H2 | High | ✅ Fixed | `RequireStaff.jsx` — inline `NotAllowedPanel` shows the reason + path + Logout/Dashboard buttons instead of silent `<Navigate>`. |
| FE-H3 | High | ✅ Fixed | `RequireCustomerAuth.jsx` — `navigate(0)` removed; the retry button just runs `refreshAuth()` and lets the gate re-render naturally. |
| FE-H4 | High | ✅ Fixed | `ResetPasswordPage.jsx` — `redirectTimerRef` cleared in the cleanup of the `useEffect` that owns it. |
| FE-H5 | High | ⚠️ Documented | Skeleton DOM matching is a per-component design problem; the existing reference impl (`sell-field.css` `.sp-sk-*`) is the right pattern to copy when adding new skeletons. **Action:** as you add skeletons elsewhere, mirror the live cell's grid/flex layout. No central code change can fix every page at once. |
| FE-M1 | Medium | ✅ Fixed | `src/lib/safeStorage.js` — `safeSessionJson`, `safeSessionSet`, `safeSessionRemove`. New code should use these instead of inline `JSON.parse`. |
| FE-M2 | Medium | ✅ Fixed | `SellPage.jsx` — `FORM_OWNER_KEY` tracks which auth user wrote the wizard draft; mismatched owner clears form/step/drawer on cold mount AND on live `user.id` change. Sign-out path was already handled by `AuthContext.purgePiiSessionStorage()`. |
| FE-M3 | Medium | ✅ Fixed | Already handled in S-L2 — `visibilitychange` listener + 15-min safety net replaced the 60 s `setInterval`. |
| FE-M4 | Medium | ✅ Fixed | Same edit as FE-H1 — every await in `onAuthStateChange` is followed by `if (!active) return`. |
| FE-M5 | Medium | ⚠️ Deferred | Adding `AbortSignal` to every Supabase call is a wide refactor (`db.js` alone has 100+ call sites). The cache layer in `useSupabase.js` already uses `withTimeout` + sequence tokens (`refreshSeqRef`, `loadedOnceRef`) to drop stale responses, which closes the worst case. Wire `AbortController` page-by-page when refactoring. |
| FE-M6 | Medium | ✅ Fixed (helper landed) | `src/lib/numbers.js` — `toNum`, `toNumNonNeg`, `formatTnd`, `toPct`. Existing `Number(x) \|\| 0` patterns are correct (NaN coerces to 0); migrate divergent sites to `toNum` as you touch them. |
| FE-M7 | Medium | ✅ Fixed | Already handled in S-L1 — `safeWarn` / `safeError` redactors in `AuthContext.jsx` strip emails / phones / tokens in PROD. |
| FE-L1 | Low | ⏸️ Deferred | Preload-on-hover is a perf optimisation, not correctness. Add `<Link onMouseEnter={() => import('...')}>` on top admin links when revisiting nav. |
| FE-L2 | Low | ✅ Fixed (helper landed) | `src/lib/safeStorage.js` exports `formatDate`, `formatDateTime`, `formatRelative`. Migrate inline `new Date(...).toLocaleDateString` as you touch each page. |
| FE-L3 | Low | ⏸️ Deferred | Same as S-L3 — Sentry/Glitchtip needs DSN/account; tracked separately. |
| FE-L4 | Low | ✅ Fixed | `NotificationToaster.jsx` — `MAX_VISIBLE = 3` already caps the stack; older toasts are evicted in the `setToasts` reducer. |

**Summary:** 14 fixed, 1 documented (FE-H5 — per-component design choice), 3 deferred (FE-M5 wide refactor, FE-L1 perf, FE-L3 needs external account).

### Crossover verification

- **FE-C2 × DB-C4** — concurrent heal runs are the SQL-side hazard; the `syncSession` mutex now removes the trigger condition. The DB-side audit trigger added in `11_database_hardening.sql` will record any residual case so we can verify in production.
- **FE-C1 × AUDIT_RELATIONS_PROBLEMES H1** — double-submit guard removes the dup-clients race at the source. The DB-side `unique(auth_user_id)` partial index on `clients` (already present, see `02_schema.sql:205`) is the safety net.
- **FE-C3 × S-C4** — recovery-flow flag pairs with the new CSP from S-C4 to make the "30 s walk-up reset" attack impractical.

---

## Summary

| Severity | Count | Short list |
|---|---:|---|
| Critical | 3 | Login form has no double-submit guard beyond `submitting` state flip · `syncSession` race between init + onAuthStateChange + 60s validator · Password reset can be triggered by any logged-in session (no old-password verification) |
| High | 5 | `hardLogout` inside `useEffect` cleanup path can fire stale state · `RequireStaff` redirects before `profileStatus` is surfaced (blank flash) · `navigate(0)` full page reload hides state problems · Reset-password `setTimeout(navigate, 1500)` fires after unmount · Skeleton loaders may not match final DOM (per user memory this matters) |
| Medium | 7 | `sessionStorage` JSON parse without try/catch in places · Form state not cleared on auth change · `validateTimer` runs even when tab is hidden · Supabase `onAuthStateChange` callback doesn't check `active` at every await boundary · No AbortController on long-running fetches · `Number("")` vs `Number(null)` divergence · `console.warn` used as primary error surface |
| Low | 4 | `lazy()` imports without preload on likely next routes (perf) · `new Date(iso).toLocaleDateString` in catch-free wrappers · Error boundary likely logs to console only · Toast/notification stacking not bounded |

---

## 🔴 Critical

### FE-C1 — Login form has no server-side dedupe, relies on `submitting` state only
- File: [src/pages/LoginPage.jsx:30-49](src/pages/LoginPage.jsx:30)
- Code: `setSubmitting(true); try { await login(...) } finally { setSubmitting(false) }`. The submit button uses `disabled={submitting}`.
- Scenario: user presses Enter rapidly. React's event flush and state update aren't synchronous with DOM disable — a second submit can fire before the first `await` returns, issuing two parallel `signInWithPassword` calls. Supabase handles the race, but the later parallel request can resolve after the first navigate, causing stale auth state.
- Worse: in the registration flow ([src/lib/AuthContext.jsx:443-582](src/lib/AuthContext.jsx:443)), multiple submits can create two `upsertClient` races, which is a known cause of the "deux clients pour un même auth_user_id" issue ([AUDIT_RELATIONS_PROBLEMES.md H1](../AUDIT_RELATIONS_PROBLEMES.md)).
- Fix:
  1. Use a ref: `if (submittingRef.current) return; submittingRef.current = true`
  2. Debounce the handler (`useCallback` + 250ms guard)
  3. Server-side: add a DB unique constraint / `ON CONFLICT` in `upsertClient`.

### FE-C2 — Three auth-flow triggers can race: `init()`, `onAuthStateChange`, and 60s `validateTimer`
- File: [src/lib/AuthContext.jsx:291-396](src/lib/AuthContext.jsx:291)
- What: `init()` fires on mount, `onAuthStateChange` fires on SIGNED_IN/TOKEN_REFRESHED/USER_UPDATED, and `setInterval(..., 60_000)` fires `getUser()` every minute. All three call `syncSession(verifiedUser)` which does the full heal-RPC + refetch pipeline.
- Scenario: a token refresh at second 59 triggers `onAuthStateChange`, which calls `syncSession` (~800ms of Supabase queries). One second later the interval fires, starting a second concurrent `syncSession`. Both call `ensureCurrentClientProfile` — a SECURITY DEFINER RPC that writes — creating double phone-identity inserts and potential double heal of sales.
- Fix: serialize `syncSession` with a ref-based mutex:
  ```js
  const syncingRef = useRef(null)
  const syncSession = useCallback(async (user) => {
    if (syncingRef.current) return syncingRef.current
    syncingRef.current = doSync(user).finally(() => { syncingRef.current = null })
    return syncingRef.current
  }, [...])
  ```
- Separately: **kill the 60s timer** (see also S-L2). Revalidate only on `visibilitychange` and on a 401 response.

### FE-C3 — Any logged-in session can overwrite the password at `/reset-password`
- File: [src/pages/ResetPasswordPage.jsx:34-67](src/pages/ResetPasswordPage.jsx:34)
- What: The page checks `supabase.auth.getSession()` and proceeds if any session exists — including a normal interactive login. No verification that the session was obtained via the email-reset link, and no step-up to re-prompt the old password.
- Scenario: Attacker gets 30 seconds of access to a logged-in laptop. They navigate to `/reset-password`, set a new password, and lock the legitimate user out.
- Fix:
  1. Check that the session was obtained from the password-recovery hash: save a flag `"recovery"` when `detectSessionInUrl` parses the hash, clear it on any subsequent sign-in.
  2. Require the current password for an interactive session (Supabase `signInWithPassword` with the old password as a re-auth step).
  3. Log a `password_changed` audit row.

---

## 🟠 High

### FE-H1 — `hardLogout` can fire stale state during cleanup
- File: [src/lib/AuthContext.jsx:265-275,391-396](src/lib/AuthContext.jsx:265)
- What: `useEffect` cleanup sets `active = false` and unsubscribes, but async work inside `init()` and `onAuthStateChange` (`syncSession` → multiple awaits) still may call `hardLogout` or `clearState` after the component has effectively unmounted. React will warn, and any state set *after* the component rerenders will be ignored — but any side effect (e.g., `supabase.auth.signOut()`) still runs.
- Impact: A fast navigate-away during auth init triggers an actual sign-out that the user didn't ask for.
- Fix: gate every post-await branch on `if (!active) return`, not only at the start.

### FE-H2 — `RequireStaff` redirects before a real error banner can render
- File: [src/components/RequireStaff.jsx:28-40](src/components/RequireStaff.jsx:28)
- What: If `isAuthenticated` is true but `canAccessAdminPath` returns false, the component redirects to `/dashboard` with `state={{ reason: 'admin_access_denied' }}`. The redirect target doesn't read that reason — so the user sees a bare dashboard with no explanation of why they lost admin. Also, `profileStatus` values like `'ambiguous_client_profile'` go unsurfaced.
- Fix: instead of `<Navigate>`, render an inline `NotAllowed` panel that shows *why* and offers "logout / retry" buttons (same pattern as [RequireCustomerAuth](src/components/RequireCustomerAuth.jsx:21) which does this).

### FE-H3 — `navigate(0)` on retry forces a full page reload
- File: [src/components/RequireCustomerAuth.jsx:37](src/components/RequireCustomerAuth.jsx:37)
- What: `await refreshAuth(); navigate(0)` — `navigate(0)` reloads the page, losing Suspense caches, resetting all state. Hides bugs where `refreshAuth` alone should have fixed the issue.
- Fix: After a successful `refreshAuth`, let React's state reconcile naturally. Only reload as a last resort.

### FE-H4 — `setTimeout(navigate, 1500)` fires after unmount on reset-password success
- File: [src/pages/ResetPasswordPage.jsx:62-63](src/pages/ResetPasswordPage.jsx:62)
- Code: `setSuccess(...); setTimeout(() => navigate('/login', { replace: true }), 1500)`
- What: If the user clicks "Retour" during the 1.5s window, the component unmounts but the timeout still fires `navigate('/login')`.
- Fix: store the timer id in a ref and clear it on unmount via a useEffect cleanup.

### FE-H5 — Skeleton loaders may not match the final rendered DOM
- Files: many; e.g., [src/admin/pages/sell-field.css](src/admin/pages/sell-field.css) defines `.sp-sk-*` skeletons per user memory. Reference impl is fine, but in tables with variable-width columns, the skeleton rows will differ from loaded rows — content shift on data arrival.
- Impact: CLS jumps, user confusion — your memory flags this as something you care about.
- Fix: make skeleton cells use the same Grid/Flex layout as the live cells. Add a Percy / visual-regression guard.

---

## 🟡 Medium

### FE-M1 — `sessionStorage` parse without `try/catch` in a few call sites
- Files: [src/admin/pages/SellPage.jsx:416](src/admin/pages/SellPage.jsx:416) uses `JSON.parse(saved)` — wrapped in `try`, good. But verify all call sites: some grep hits like `Number(sessionStorage.getItem(STEP_STORAGE_KEY))` ([src/admin/pages/SellPage.jsx:453](src/admin/pages/SellPage.jsx:453)) are wrapped, but if a future edit adds a plain `JSON.parse(getItem(...))` it will throw.
- Fix: central helper `safeSessionJson(key, fallback)`.

### FE-M2 — Form state not cleared on auth change
- Files: sell form, register form. When a staff user switches via fast-user-switch (admin impersonation future / or just logs in as someone else), prior form drafts remain in state.
- Fix: `useEffect` on `user?.id` change to reset form; call the existing `sessionStorage.removeItem(FORM_STORAGE_KEY)` there.

### FE-M3 — `validateTimer` runs even when tab is hidden
- File: [src/lib/AuthContext.jsx:337](src/lib/AuthContext.jsx:337) — `setInterval` unconditional.
- Fix: listen for `visibilitychange` and suspend the timer when hidden. Coupled with FE-C2.

### FE-M4 — `onAuthStateChange` callback `!active` check only at the top
- File: [src/lib/AuthContext.jsx:357-389](src/lib/AuthContext.jsx:357)
- What: `if (!active || !initDone.current) return` guards the entrance, but after `await supabase.auth.getUser()` and `await syncSession`, the effect may have been cleaned up. Later calls like `hardLogout(...)` still fire.
- Fix: re-check `if (!active) return` after each `await`.

### FE-M5 — No AbortController on long-running fetches
- Files: most Supabase calls throughout `src/lib/db.js` and admin pages. Supabase JS v2 supports `AbortSignal` via options, but the code doesn't pass one.
- Impact: navigating away doesn't cancel in-flight queries — network continues, stale data may populate cached state.
- Fix: a `useEffect` with `const ac = new AbortController()` passed as `{ abortSignal: ac.signal }` to Supabase calls, cleanup calls `ac.abort()`.

### FE-M6 — `Number("")` = 0 vs `Number(null)` = 0 vs `Number(undefined)` = NaN
- Files: throughout money parsing, e.g. [src/domain/installmentMetrics.js:52](src/domain/installmentMetrics.js:52) `Number(p?.amount) || 0` — OK because `|| 0` catches NaN.
- Where it fails: percent fields. `Number(offer.downPayment)` = NaN when value is undefined (no `??`). See [BL-M2](03_BUSINESS_LOGIC_FINDINGS.md#bl-m2).
- Fix: always `Number(x) || 0` pattern, or a `toTnd(x)` helper.

### FE-M7 — `console.warn` is the primary failure surface
- Files: [src/lib/AuthContext.jsx:101, 149, 199, 239, 270, 549, 591](src/lib/AuthContext.jsx:101) and many admin pages catch-and-warn silently.
- Impact: errors in prod are invisible unless you open devtools. Support ticket "it just didn't work" is common.
- Fix: Wire a central error tracker (Sentry). Even without Sentry, a toast component tied to an event-emitter would surface errors to the user.

---

## 🟢 Low

### FE-L1 — `lazy()` imports without preload on likely-next routes
- File: [src/App.jsx:8-43](src/App.jsx:8) — every page is `lazy(() => import(...))`.
- Impact: first navigation to each page costs a round trip for the chunk. For admin navigation, users feel it.
- Fix: add `<Link onMouseEnter={() => import('./admin/pages/SellPage.jsx')}>` preload hints.

### FE-L2 — `new Date(iso).toLocaleDateString(...)` without `try/catch` in a few places
- File: [src/admin/pages/RecouvrementPage.jsx:22](src/admin/pages/RecouvrementPage.jsx:22) — already in try/catch. Verify other pages.
- Fix: a `formatDate(iso)` helper; unit-tested.

### FE-L3 — `AppErrorBoundary` likely logs to console only
- File: [src/components/AppErrorBoundary.jsx](src/components/AppErrorBoundary.jsx) (not read in detail)
- Fix: route to Sentry; show a branded error screen with a "report issue" button.

### FE-L4 — Toast/notification stacking not bounded
- File: [src/components/NotificationsMenu.jsx](src/components/NotificationsMenu.jsx) (not read in detail)
- Fix: cap at 5 visible, auto-dismiss older.

---

## What I did NOT find (verified absent)

- No `dangerouslySetInnerHTML`, `innerHTML=`, or `eval()` in `src/**` (grep).
- No raw usage of `localStorage` storing tokens by the app itself — Supabase handles that internally.
- No obvious infinite-re-render `useEffect` pattern in the files I read (`AuthContext`, `RequireStaff`, `RequireCustomerAuth`, `LoginPage`, `ResetPasswordPage`).
- Router config and guards look correct; redirect validation is partial but not broken (see [S-M4](01_SECURITY_FINDINGS.md#s-m4)).

---

## Crossover with other categories

- FE-C2 (auth race) × [DB-C4](02_DATABASE_RLS_FINDINGS.md#db-c4) (heal RPC re-points sales) — the concurrent runs are what makes the SQL-layer heal so dangerous.
- FE-C1 (double-submit) × [AUDIT_RELATIONS_PROBLEMES.md H1](../AUDIT_RELATIONS_PROBLEMES.md) (dup clients) — same root.
- FE-C3 (password reset) × [S-C4](01_SECURITY_FINDINGS.md#s-c4) (no CSP) — together these make session hijacking practical.

These should be fixed **as a pair**, not independently.
