## Plan 04 — Public & Customer Pages Loading Fixes

Research source: [reserch/04-public-customer-pages-loading.md](../reserch/04-public-customer-pages-loading.md).

Target files (13 touched directly, ~5 others consulted):

- [src/App.jsx](../src/App.jsx)
- [src/TopBar.jsx](../src/TopBar.jsx)
- [src/components/RequireCustomerAuth.jsx](../src/components/RequireCustomerAuth.jsx)
- [src/components/NotificationToaster.jsx](../src/components/NotificationToaster.jsx)
- [src/components/NotificationsMenu.jsx](../src/components/NotificationsMenu.jsx)
- [src/pages/BrowsePage.jsx](../src/pages/BrowsePage.jsx)
- [src/pages/DashboardPage.jsx](../src/pages/DashboardPage.jsx)
- [src/pages/InstallmentsPage.jsx](../src/pages/InstallmentsPage.jsx)
- [src/pages/LoginPage.jsx](../src/pages/LoginPage.jsx)
- [src/pages/PlotPage.jsx](../src/pages/PlotPage.jsx)
- [src/pages/ProjectPage.jsx](../src/pages/ProjectPage.jsx)
- [src/pages/PurchaseMandatPage.jsx](../src/pages/PurchaseMandatPage.jsx)
- [src/pages/ReferralInvitePage.jsx](../src/pages/ReferralInvitePage.jsx)
- [src/pages/RegisterPage.jsx](../src/pages/RegisterPage.jsx)
- [src/pages/ResetPasswordPage.jsx](../src/pages/ResetPasswordPage.jsx)
- [src/lib/AuthContext.jsx](../src/lib/AuthContext.jsx)
- [src/lib/notifications.js](../src/lib/notifications.js)
- [src/lib/useSupabase.js](../src/lib/useSupabase.js) (lines 501-600, 796-992, 1415-1548 — public/scoped hooks)

---

## 1. Executive Summary

The public/customer-facing surface of the app — the pages signed-in buyers see every day and the catalog pages unauthenticated visitors see — has three recurring failure modes:

1. **Portfolio hang.** `DashboardPage` and `InstallmentsPage` both fan out into scoped hooks (`useSalesScoped`, `useInstallmentsScoped`, `useMyCommissionLedger`, `useAmbassadorReferralSummary`, `useSalesBySellerClientId`, `useProjectsScoped`) that receive `clientProfile?.id ?? null` before `AuthContext` has resolved. Several of these hooks early-return on null without flipping `loading` back to false, or never re-fire when the id arrives. Because `portfolioLoading = salesLoading || projectsLoading` is an `OR` gate, any one stuck hook pins the whole skeleton on screen until the user hits Ctrl+F5.
2. **Infinite "Chargement…" on public pages.** `ReferralInvitePage` resolves `data=null, error=null` as a neutral state and never exits its "loading" branch; `BrowsePage` swallows fetch errors as empty arrays; `ProjectPage`/`PlotPage` leave skeletons visible after rapid-nav races because a previous fetch's `cancelled=true` suppresses `setLoading(false)`.
3. **Realtime silent failure.** `NotificationToaster`, `PlotPage`, `useSalesScoped`, `useAmbassadorReferralSummary` and friends never pass a callback to `.subscribe()` — if the channel handshake fails (rate limit, bad JWT, network), the app silently runs on stale data with no user feedback.

All three fail in the "app-kinda-works-but-I-keep-hard-refreshing" way that erodes trust. None of them are fixable at the page level alone — the root causes sit in shared infrastructure. This plan picks up the four shared primitives from **plan 03** (`RenderDataGate`, `Skeleton`, `EmptyState`, `ErrorPanel`, `useWatchdog`), adds three more built specifically for this tier (`usePublicResource`, `useScopedResource`, `useRealtimeChannel`, `AuthHealGate`), and then methodically migrates the pages to use them.

The deliverable, in priority order:

- **Tier A (CRITICAL)** — `DashboardPage`, `InstallmentsPage`, `RequireCustomerAuth` (self-healing), `ReferralInvitePage`. Blocks paying customers from seeing their portfolio. Fix first.
- **Tier B (HIGH)** — `ProjectPage`/`PlotPage` rapid-nav, `BrowsePage` error surfacing, `LoginPage` post-login flash.
- **Tier C (MEDIUM)** — `PurchaseMandatPage`, `RegisterPage`, `ResetPasswordPage`, `PlotPage` unfiltered realtime, `NotificationToaster` silent handshake failure, `NotificationsMenu` bell desync.

Every page section below follows the same five-heading template so future audits can fill the same shape without re-thinking.

---

## 2. Prerequisites

This plan **depends on** three earlier plans landing first. Do not merge fixes from Tier A until the corresponding prerequisite contract is available.

### 2.1 Plan 01 — Auth Session Races

Required contracts:

- `AuthContext.awaitInitialAuth(): Promise<void>` — resolves when `(loading, ready) = (false, true)` AND one of `(adminUser, clientProfile)` has been resolved to a stable value. Used by all scoped hooks to short-circuit the null-id-on-first-render race.
- `AuthContext.clientProfile` treated as **strict**: either a resolved object with a truthy `.id`, or `null`. No more "partial" states like `{ id: undefined }` or `{}`.
- `AuthContext.authReady` boolean — true once the initial session hydration resolves regardless of whether a profile was found. Distinct from `isAuthenticated`, which requires both.
- `AuthContext.clientHealStatus: 'idle' | 'healing' | 'healed' | 'failed' | 'blocked'` — see §5 below. Dashboard no longer owns the heal call.

What you get: every `useScopedResource({ clientId })` caller can block on `awaitInitialAuth()` before the first fetch, and `clientHealStatus` drives the `RequireCustomerAuth` UX.

### 2.2 Plan 02 — Cache/Scoped Store Infrastructure

Required contracts:

- `createScopedStore({ fetcher, key })` returning a typed store with `{ data, loading, error }` that **never** leaves `loading=true` after a fetch resolves or rejects. The null-id early-return bug in [useSupabase.js:942](../src/lib/useSupabase.js#L942) and [:1527](../src/lib/useSupabase.js#L1527) is fixed at the store layer — callers passing null get `{ data: [], loading: false, error: null }` synchronously.
- `invalidationBus` exposing `emitInvalidate(topic)` / `onInvalidate(topic, cb)` so scoped hooks can wire up reactivity without owning their own realtime channels. (Already partially exists — plan 02 hardens it.)
- `withTimeout(promise, ms, label)` as a **canonical** helper, so every fetcher errors cleanly instead of hanging. Exists in `useSupabase.js` today; plan 02 moves it to a named module and audits every callsite for consistency.

What you get: the scoped hooks inside this plan (`usePublicResource`, `useScopedResource`) become thin typed wrappers around `createScopedStore` with no chance of a leaked loading flag.

### 2.3 Plan 03 — Shared Rendering Components

Required contracts (all default-exported React components):

- `<RenderDataGate loading error empty emptyMessage retry>{children}</RenderDataGate>` — the universal 4-state gate. Decides between `<Skeleton>` (loading), `<ErrorPanel>` (error), `<EmptyState>` (empty), or `children` (data). Takes an explicit `empty: boolean` prop — fixes **Pattern C** (empty-data ambiguity).
- `<Skeleton variant="card|row|title|map|pill" count={1} />` — uses the `.sp-sk-*` / `.pub-sk-*` shimmer classes already in `sell-field.css` (per user's memory — skeleton+shimmer is the canonical loading state).
- `<ErrorPanel message onRetry>` — renders the "Réessayer" button consistently. Replaces the ad-hoc error UI on `RequireCustomerAuth` (which already exists) and adds it everywhere else.
- `<EmptyState title action?>` — the "no data yet" card. Used by `InstallmentsPage`'s three-branch empty state, `BrowsePage`'s "no projects match", and the new `ReferralInvitePage` "invalid code" state.
- `useWatchdog(loading, { timeoutMs, onTimeout })` — fires `onTimeout` once if `loading` stays true past `timeoutMs`. Used inside `RenderDataGate` to upgrade a stuck skeleton into an `ErrorPanel` with "Réessayer". Settles **Pattern D** at the render layer — even if realtime silently fails, the watchdog forces a user-visible escape.

What you get: every page section below renders its data through `<RenderDataGate>` and never writes ad-hoc `{loading ? <spinner /> : ...}` trees again.

### 2.4 Plan-local new primitives (built here, reusable)

These are small enough to live in this plan, but designed so plan 05 / future audits can consume them:

- `usePublicResource(fetcher, { key, realtime? })` — fetches without blocking on auth. See §6.
- `useScopedResource(fetcher, { clientId, key, realtime? })` — the auth-gated sibling. See §6.
- `useRealtimeChannel({ name, subscriptions, onStatus })` — wraps `.subscribe((status) => ...)` with `CHANNEL_ERROR` / `CLOSED` reporting. See §8.
- `<AuthHealGate>` — an auth-level retry component that runs `heal_my_client_profile_now()` with backoff. See §5.

---

## 3. Plan Items — per-page fixes

### Tier A (CRITICAL)

#### 3.1 DashboardPage — portfolio hang on first navigation

**Severity:** CRITICAL
**File:** [src/pages/DashboardPage.jsx](../src/pages/DashboardPage.jsx) (lines 69–169 for the hook fan-out, 89–109 for the heal call)
**Effort:** L (large — this is the showpiece page and has 6 hooks, auth-heal trap, and a ton of derived state)

##### Current broken behavior

- On first login → navigate to `/dashboard` cold, `clientProfile?.id` is `null` for ~50-600 ms. During that window:
  - `useSalesScoped({ clientId: null })` falls into the `clientId == null` branch at [useSupabase.js:807-808](../src/lib/useSupabase.js#L807) and runs `db.fetchSales()` — a staff-wide query that RLS will either accept (wrong data for the investor) or deny. Either way, `loading` flickers and `liveSales` gets populated with garbage.
  - `useInstallmentsScoped({ clientId: null })` early-returns at [useSupabase.js:961-964](../src/lib/useSupabase.js#L961) and sets `plans=[]` but **does not set `loading=false`** on the initial-mount path when `clientId` is null from the start (the initial `useState(true)` sticks).
  - `useMyCommissionLedger(null)` returns `loading=false` via the `enabled=false` branch, but when `clientId` arrives, the `enabled` evaluation inside `useEffect`'s dep array is stale → no re-fire.
- `portfolioLoading` (line 169) is a logical OR, so any one stuck sub-hook pins the skeleton forever.
- The heal call inside the component at [DashboardPage.jsx:89-109](../src/pages/DashboardPage.jsx#L89) only fires once `user?.id` is present and the component has already mounted — which is after `RequireCustomerAuth` has already let it through. If `RequireCustomerAuth` blocks (no `clientProfile`), the heal never fires. This is covered separately in §5 (the auth-heal trap), but the page-level change is to **remove** the heal `useEffect` entirely and let `AuthContext` own it.

##### Target behavior

- Hooks accept a resolved `clientId` on their first run, or explicitly skip with `loading=false`.
- The skeleton renders for as long as the user is legitimately waiting for an initial fetch (typically ≤500 ms on a warm connection) and never longer.
- If any individual hook times out (plan 02's `withTimeout` already wraps most of them at 12 s), that hook's section renders an `<ErrorPanel>` with "Réessayer" while the rest of the page stays interactive. **A single stalled hook cannot pin the whole page.**
- The heal call is owned by `AuthContext.clientHealStatus` (see §5). `DashboardPage` has no knowledge of the healing state machine — it just blocks on `awaitInitialAuth()`.

##### Specific changes

1. **Remove the in-component heal effect.** Delete lines 88–109 (`healedRef`, the `useEffect`, the `supabase.rpc('heal_my_client_profile_now')` call). This responsibility moves to `AuthContext` (§5) and `RequireCustomerAuth` (§3.3).
2. **Use `useScopedResource` everywhere.** Replace the direct calls to `useSalesScoped`, `useInstallmentsScoped`, etc. with wrappers that block on `awaitInitialAuth()` and a resolved `clientId`:
   ```js
   // Before:
   const { sales: mySalesRaw, loading: salesLoading } = useSalesScoped({ clientId })

   // After (if we keep the hook name but change its internals via plan 02):
   const { data: mySalesRaw, loading: salesLoading, error: salesError, retry: retrySales } =
     useSalesScoped({ clientId, enabled: Boolean(clientId) })
   ```
   The explicit `enabled` flag makes the "skip while auth is resolving" path visible in the callsite. The hook's internals (plan 02) guarantee `loading=false` on `enabled=false`.
3. **Split the page into sections, each gated by `<RenderDataGate>`.** Today the page is a single monolith. Split into:
   - `<PortfolioSection>` — depends on `mySales` + `allProjects`.
   - `<InstallmentsSection>` — depends on `myPlans`.
   - `<AmbassadorSection>` — depends on `ambassadorSales` + `referralSummary`.
   - `<CommissionLedgerSection>` — depends on `myCommissionEvents`.
   Each section owns its own `<RenderDataGate loading={sectionLoading} error={sectionError} empty={sectionData.length === 0} retry={retry}>`. A stalled ambassador section no longer hides the portfolio.
4. **Drop `portfolioLoading` as an aggregate.** The monolithic boolean is the root cause of the hang. Each section handles its own state.
5. **Wire `useWatchdog` at the section level** with a 10 s timeout — after that, the `<RenderDataGate>` upgrades to the error variant with "Réessayer". Mirrors what the user wrote for the referral card (`referralLoadStale` at [DashboardPage.jsx:118-127](../src/pages/DashboardPage.jsx#L118)) but made reusable.
6. **Pin the ambassador card off when `clientId` is absent.** The current code does `showAmbassadorCard = Boolean(clientId)` but still constructs the hook call. With `useScopedResource` and `enabled`, the hook is a no-op until `clientId` is ready.

##### Sketch

```jsx
// DashboardPage.jsx (simplified excerpt)
export default function DashboardPage() {
  const { user, clientProfile, awaitInitialAuth } = useAuth()
  const clientId = clientProfile?.id || null
  const authResolved = useAuthResolved(awaitInitialAuth)  // true once awaitInitialAuth() returns

  const sales = useScopedResource(
    () => db.fetchSalesScoped({ clientId }),
    { clientId, key: 'sales', enabled: authResolved && Boolean(clientId), realtime: { table: 'sales' } },
  )
  const plans = useScopedResource(
    () => db.fetchInstallmentsScoped({ clientId }),
    { clientId, key: 'installments', enabled: authResolved && Boolean(clientId), realtime: { table: 'installment_plans' } },
  )
  // ... etc. for ambassadorSales, referralSummary, commissionLedger

  return (
    <main className="screen screen--app">
      <TopBar />
      <PortfolioSection resource={sales} projects={projects} />
      <InstallmentsSection resource={plans} />
      <AmbassadorSection visible={Boolean(clientId)} resource={ambassadorReferral} />
      <CommissionLedgerSection resource={commissionLedger} />
    </main>
  )
}

function PortfolioSection({ resource, projects }) {
  const empty = resource.data?.length === 0
  return (
    <RenderDataGate
      loading={resource.loading}
      error={resource.error}
      empty={empty}
      emptyMessage={<p>Aucun achat pour le moment. <Link to="/browse">Explorer les projets</Link></p>}
      retry={resource.retry}
    >
      <PortfolioCards sales={resource.data} projects={projects.data} />
    </RenderDataGate>
  )
}
```

##### Verification steps

1. **Fresh-login smoke.** Log out, clear cookies, log in with throttled 3G, navigate straight to `/dashboard`. The skeleton appears, then the sections populate within ≤500 ms on warm cache, ≤3 s cold. No section stays stuck.
2. **Null-id race regression test.** Add a Vitest covering `useScopedResource({ clientId: null, enabled: false })` — must return `{ data: [], loading: false, error: null }` synchronously.
3. **Stalled hook simulation.** Block `db.fetchInstallmentsScoped` at the network layer for 30 s (throttle). The `InstallmentsSection` shows its skeleton up to the 10 s watchdog, then flips to `<ErrorPanel>`. The portfolio and ambassador sections remain fully interactive throughout.
4. **Heal removed.** `grep` confirms `heal_my_client_profile_now` is no longer referenced from `src/pages/DashboardPage.jsx`.
5. **No regressions in ambassador card.** The existing `referralLoadStale` stopgap can be deleted — the `<RenderDataGate>` + `useWatchdog` cover it.

---

#### 3.2 InstallmentsPage — `clientProfile?.id ?? null` race

**Severity:** CRITICAL
**File:** [src/pages/InstallmentsPage.jsx](../src/pages/InstallmentsPage.jsx) (lines 65–100)
**Effort:** M

##### Current broken behavior

Same root cause as §3.1: passes `clientProfile?.id ?? null` into two scoped hooks (`useInstallmentsScoped`, `useSalesScoped`). When the effects run with null on first mount, the installments skeleton stays visible until `clientProfile` resolves and a re-run fires. Research doc confirms 2–10 s stuck skeletons on cold navigation.

Additionally — the existing skeleton at lines 186–191 is NOT using the skeleton+shimmer pattern (just a spinner + "Chargement des plans…" text). Per the user's memory preference, we should swap in the `.pub-sk-*` skeleton markup the rest of the app uses.

##### Target behavior

- The page mounts and immediately blocks on `awaitInitialAuth()`.
- Once auth is ready, either (a) `clientId` is set and the fetch fires, or (b) `clientId` is null and we render an `<EmptyState>` with an "aucun profil client" message (unreachable in practice because `RequireCustomerAuth` already gates this route, but defensive).
- Skeleton uses `.pub-sk-*` shimmer, not the spinner.

##### Specific changes

1. Replace `useInstallmentsScoped({ clientId })` and `useSalesScoped({ clientId })` with `useScopedResource` calls — same pattern as §3.1.
2. Wrap the entire "plans list" and "focused plan detail" sections in a single `<RenderDataGate>`:
   ```jsx
   <RenderDataGate
     loading={plansRes.loading}
     error={plansRes.error}
     empty={plansRes.data.length === 0 && !hasAnyInstallmentSale}
     emptyMessage={<EmptyState title="Aucun plan d'échéances" body="Vous n'avez pas d'achat à tempérament pour le moment." />}
     retry={plansRes.retry}
   >
     {/* existing render */}
   </RenderDataGate>
   ```
3. The three empty-state branches at lines 278–302 (missing plan / finalisation / no sale) become three explicit `<EmptyState>` variants. `<RenderDataGate>` chooses between them via a custom `emptyRenderer` prop.
4. Replace lines 186–191 (the `ip__empty` with spinner) with `<Skeleton variant="title" />` + `<Skeleton variant="card" count={3} />` inside the hero.
5. Remove the double-fetch: today the page calls both `useInstallmentsScoped` and `useSalesScoped` just to detect "sale closed but no plan yet" at lines 73–83. This can stay — but both hooks must use the same `enabled` gate.

##### Verification steps

1. **Direct-nav smoke.** Login → directly paste `/installments` in the URL bar on a throttled connection. Skeleton shows for ≤800 ms, then either the plans list or the appropriate `<EmptyState>` variant appears.
2. **Empty vs still-loading.** With an investor who genuinely has no installment plans, confirm the `<EmptyState>` renders immediately after auth resolves (not after the fetch timeout).
3. **Mixed-state scenario.** Investor whose plan exists but the `installment_payments` rows are still being generated by a DB trigger. The `installmentSalesMissingPlan` branch should still render (it's a business concern, not a loading concern).

---

#### 3.3 RequireCustomerAuth — profile-heal UX trap

**Severity:** CRITICAL
**File:** [src/components/RequireCustomerAuth.jsx](../src/components/RequireCustomerAuth.jsx) (lines 28–66)
**Effort:** M

##### Current broken behavior

Quoting the research doc (finding #13) verbatim: *"A buyer account created via delegated seller flow may have no `clients.auth_user_id` link. When the buyer registers, `AuthContext.resolveProfiles` attempts heal — if it fails, `clientProfile` stays null. `RequireCustomerAuth` shows the 'Profil introuvable' UI with a 'Réessayer' button that calls `refreshAuth()`. But `refreshAuth` calls `getUser()` + `syncSession()` — NOT `ensureCurrentClientProfile()` directly, so if the underlying DB heal is still failing, the retry does nothing visible. Meanwhile, DashboardPage has its own heal call — but DashboardPage NEVER MOUNTS because RequireCustomerAuth blocks it."*

##### Target behavior

- The gate never shows "Profil introuvable" without having first attempted a server-side heal.
- When the gate does show the error screen, clicking "Réessayer" triggers an actual `heal_my_client_profile_now()` + `refreshAuth()` — not just a session re-read.
- The heal is attempted with exponential backoff (1 s → 2 s → 4 s, max 3 tries) before surfacing "Profil introuvable" at all, so transient DB races resolve silently.

##### Specific changes

1. **Move the heal call into `AuthContext`.** Plan 01 adds a `clientHealStatus` state machine:
   - `idle` — initial
   - `healing` — `heal_my_client_profile_now()` is in flight
   - `healed` — heal RPC returned `linked > 0 || (ok && clientId)`, `resolveProfiles` re-ran, `clientProfile` now populated.
   - `failed` — RPC error or exhausted retries.
   - `blocked` — RPC returned `reason: 'phone_conflict'` or similar terminal failure.
2. **Introduce `<AuthHealGate>`**, an inner wrapper inside `RequireCustomerAuth` that consumes `clientHealStatus`:
   ```jsx
   // Sketch
   function AuthHealGate({ children }) {
     const { clientHealStatus, retryHeal } = useAuth()
     if (clientHealStatus === 'idle' || clientHealStatus === 'healing') {
       return <Skeleton variant="full-page" /> // or a soft spinner + "Préparation du compte…"
     }
     if (clientHealStatus === 'failed') {
       return <ErrorPanel
         title="Profil introuvable"
         message="Nous n'avons pas pu lier votre profil. Réessayez ou contactez le support."
         onRetry={retryHeal} />
     }
     if (clientHealStatus === 'blocked') {
       return <ErrorPanel
         title="Vérification requise"
         message="Un conflit sur votre numéro doit être résolu par l'équipe support."
         onRetry={null} />
     }
     return children
   }
   ```
3. **Rewrite `RequireCustomerAuth`** to chain the three gates:
   ```jsx
   export default function RequireCustomerAuth({ children }) {
     const { loading, ready, isAuthenticated, adminUser, clientProfile } = useAuth()
     if (loading || !ready) return <Skeleton variant="full-page" />
     if (!isAuthenticated) return <Navigate to="/login" replace />
     if (adminUser || clientProfile) return children
     // No profile yet — let AuthHealGate run the heal loop
     return <AuthHealGate>{children}</AuthHealGate>
   }
   ```
4. **Automatic initial heal.** `AuthContext` inspects the post-syncSession state: if `user?.id && !adminUser && !clientProfile && !registrationInProgressRef.current`, it kicks off the heal state machine automatically on mount. The user never sees "Profil introuvable" unless the heal fails after retries.
5. **Retry semantics.** `retryHeal()` runs:
   ```js
   async function retryHeal() {
     setClientHealStatus('healing')
     try {
       const { data, error } = await supabase.rpc('heal_my_client_profile_now')
       if (error) return setClientHealStatus('failed')
       if (data?.reason === 'phone_conflict') return setClientHealStatus('blocked')
       if (data?.linked > 0 || data?.ok) {
         await syncSession(user)
         return  // clientProfile will be set; effect re-renders
       }
       setClientHealStatus('failed')
     } catch (e) { setClientHealStatus('failed') }
   }
   ```
6. **Kill the DashboardPage heal effect** — already covered in §3.1. Sanity check: `grep -r heal_my_client_profile_now src/pages/` should be empty after this change.

##### Verification steps

1. **Simulate orphan client.** In the DB, `UPDATE clients SET auth_user_id = NULL WHERE id = '<test-client>'`. Login as that test user.
2. **Before fix:** the gate shows "Profil introuvable" immediately, Réessayer is a no-op.
3. **After fix:** the gate shows a loading skeleton for ≤5 s while `heal_my_client_profile_now` runs, then either renders the dashboard (heal succeeded) or the error panel (heal failed). Réessayer actually retries the RPC.
4. **Retry with DB cooperation.** Trigger heal failure, then restore the link in the DB, click Réessayer — page should now render.
5. **Blocked path.** Simulate `phone_conflict` by inserting a conflicting `client_phone_identities` row. Gate must show the "Vérification requise" variant and disable Réessayer (user must contact support).

---

#### 3.4 ReferralInvitePage — infinite "Chargement…" on invalid code

**Severity:** CRITICAL (HIGH in research, promoted to CRITICAL because it's deterministic on bad input and unaffected by hard-refresh)
**File:** [src/pages/ReferralInvitePage.jsx](../src/pages/ReferralInvitePage.jsx) (lines 1–52)
**Effort:** S

##### Current broken behavior

```js
// current logic — ReferralInvitePage.jsx:18-26
const { data, error } = await supabase
  .from('clients')
  .select('id, full_name, code')
  .eq('referral_code', code)
  .maybeSingle()
if (error) setErr(error.message)
else setReferrer(data)
```

A non-matching `code` returns `{ data: null, error: null }` → `setReferrer(null)`, `setErr('')`. Render logic (line 47): neither truthy → falls through to `<p>Chargement…</p>`. Forever.

##### Target behavior

- Three explicit states: **loading**, **not-found**, **found**. The "Chargement…" branch only renders while the fetch is in flight.
- A not-found code shows an `<EmptyState>` with "Lien d'invitation introuvable" and a "Explorer les projets" CTA.
- An error (network/DB) shows an `<ErrorPanel>` with retry.

##### Specific changes

1. Add explicit `loading` state, initialize to `true`.
2. Clear `loading=false` in a `finally` block so it flips regardless of the branch.
3. Distinguish "not found" (data === null, no error) from "loaded" (data !== null):
   ```jsx
   const [state, setState] = useState({ loading: true, referrer: null, err: '' })
   useEffect(() => {
     if (!code) { setState({ loading: false, referrer: null, err: '' }); return }
     try { sessionStorage.setItem('zitouna_ref_code', code) } catch { /* ignore */ }
     let cancelled = false
     ;(async () => {
       const { data, error } = await supabase
         .from('clients').select('id, full_name, code').eq('referral_code', code).maybeSingle()
       if (cancelled) return
       setState({ loading: false, referrer: data || null, err: error?.message || '' })
     })()
     return () => { cancelled = true }
   }, [code])
   ```
4. Swap the render for `<RenderDataGate>`:
   ```jsx
   <RenderDataGate
     loading={state.loading}
     error={state.err}
     empty={!state.referrer}
     emptyMessage={
       <EmptyState
         title="Lien d'invitation introuvable"
         body="Ce code n'est plus valide. Vous pouvez tout de même créer un compte."
         action={<button onClick={() => navigate('/register')}>Créer un compte</button>} />
     }
     retry={null}
   >
     {/* existing "Vous êtes invité par ..." block */}
   </RenderDataGate>
   ```
5. Drop the bare `<p>Chargement…</p>` fallback entirely.

##### Verification steps

1. **Happy path.** Visit `/ref/<known-code>` — the invitation message renders.
2. **Invalid code.** Visit `/ref/not-a-real-code` — within 1 s, the "Lien d'invitation introuvable" `<EmptyState>` appears. No more infinite "Chargement…".
3. **Network error.** Kill Supabase in DevTools network tab, reload `/ref/<code>` — `<ErrorPanel>` with a working Réessayer button.
4. **Session storage preserved.** The code is still saved in `zitouna_ref_code` for the subsequent `/register` flow (line 14), regardless of whether the referrer lookup succeeds.

---

### Tier B (HIGH)

#### 3.5 ProjectPage / PlotPage — rapid-nav race leaves stale skeleton

**Severity:** HIGH
**Files:**
- [src/pages/ProjectPage.jsx](../src/pages/ProjectPage.jsx) (lines 18–45)
- [src/pages/PlotPage.jsx](../src/pages/PlotPage.jsx) (lines 28–59)
- [src/lib/useSupabase.js](../src/lib/useSupabase.js) (lines 545–600, `usePublicProjectDetail`)

**Effort:** M

##### Current broken behavior

`usePublicProjectDetail(id)`:
```js
// useSupabase.js:548
const [loading, setLoading] = useState(() => Boolean(id))
// effect at line 568 — when id changes:
//   setLoading(true)
//   async fetch: if cancelled, do not setLoading(false)
//   on unmount: cancelled = true
```

When user clicks rapidly from `/project/1 → /project/2 → /project/1`, the sequence is:

1. Component for id=1 unmounts; its `cancelled=true`; it never sets loading=false.
2. Component for id=2 mounts; `setLoading(true)`; fetch starts.
3. User clicks back; component for id=2 unmounts; its `cancelled=true`.
4. Component for id=1 mounts again; new effect runs; `setLoading(true)`; fetch starts.

In practice the loading flag does re-fire for each new mount. BUT: if the user navigates between *mounted* instances (hypothetically via a tab system — less relevant here) or if React's strict-mode / concurrent-mode rushes the deferred fetch, **the `cancelled=true` cleanup suppresses the eventual `setLoading(false)`**. The skeleton stays on until a subsequent navigation forces a remount.

More acutely: the **realtime channel** at [useSupabase.js:587-596](../src/lib/useSupabase.js#L587) is recreated on every id change. The cleanup tears down the previous channel, the new one handshakes ~300 ms later. During that window, changes to `parcel_tree_batches` are lost. When combined with §3.8 (unfiltered `parcel_tree_batches` subscription), every DB change across the whole app triggers a refresh on the currently-mounted project page — multiplying the flicker.

##### Target behavior

- Rapid nav cleanly cancels previous in-flight fetches via an `AbortController`, not just a cancellation flag.
- The realtime channel is **scoped per projectId** (filtered) and stays subscribed for the full page lifetime.
- Skeleton clears as soon as *any* fetch for the currently-requested id completes (success, error, or explicit abort-due-to-nav).

##### Specific changes

1. **Migrate `usePublicProjectDetail` to `usePublicResource`** (defined in §6):
   ```js
   export function usePublicProjectDetail(projectId) {
     const id = String(projectId || '').trim()
     return usePublicResource(
       (signal) => db.fetchPublicProjectById(id, { signal }),
       {
         key: `project:${id}`,
         enabled: Boolean(id),
         realtime: {
           name: `realtime-public-project-${id}`,
           subscriptions: [
             { table: 'projects', filter: `id=eq.${id}` },
             { table: 'parcels', filter: `project_id=eq.${id}` },
             { table: 'parcel_tree_batches', filter: `project_id=eq.${id}` },  // FIX §3.8
           ],
         },
       },
     )
   }
   ```
2. **Propagate `AbortSignal` to `db.fetchPublicProjectById`.** The current `db.js` fetcher doesn't take a signal — plan 02 is where this contract lives, but we tack on this specific fetcher here.
3. **Render pages through `<RenderDataGate>`:**
   ```jsx
   // ProjectPage.jsx (sketch)
   export default function ProjectPage() {
     const { id } = useParams()
     const project = usePublicProjectDetail(id)
     return (
       <main className="screen screen--app">
         <TopBar />
         <RenderDataGate
           loading={project.loading}
           error={project.error}
           empty={!project.data}
           emptyMessage={<EmptyState title="Projet introuvable" action={<Link to="/browse">Retour</Link>} />}
           retry={project.retry}
           skeleton={<ProjectPageSkeleton />}
         >
           <ProjectPageBody project={project.data} />
         </RenderDataGate>
       </main>
     )
   }
   ```
4. **Skeleton extraction.** Lift the existing skeleton markup at [ProjectPage.jsx:24-45](../src/pages/ProjectPage.jsx#L24) into a `ProjectPageSkeleton` component; same for `PlotPageSkeleton`. Both use the `.pub-sk-*` shimmer classes.
5. **Add a key-based remount on id change.** At the parent level (`App.jsx`), set `<ProjectPage key={id} />` so that navigating `/project/1 → /project/2` fully unmounts the previous instance. Cheaper than threading aborts through every useEffect; React handles cleanup naturally.

   ```jsx
   // App.jsx
   function ProjectPageWithKey() {
     const { id } = useParams()
     return <ProjectPage key={`project:${id}`} />
   }
   <Route path="/project/:id" element={<ProjectPageWithKey />} />
   ```

6. **Same treatment for `PlotPage`.** Apply `<PlotPage key={`plot:${projectId}:${plotId}`} />`.

##### Verification steps

1. **Rapid-click smoke.** On `/browse`, click 5 project cards in rapid succession (back-button between). Each transition renders a fresh skeleton within 50 ms, content within 500 ms (warm). No stale skeletons.
2. **Abort propagation.** In DevTools Network tab, navigate away during an in-flight fetch. The request status becomes `cancelled`. No duplicate fetches queue.
3. **Realtime filter.** With DevTools console open, `db.updateParcelTreeBatch` on an **unrelated project**. The current page should NOT refetch. Before fix: it does (see §3.8).
4. **Key-remount.** React DevTools should show `ProjectPage` unmount + remount between navigations, not just prop updates.

---

#### 3.6 BrowsePage — silent empty on error

**Severity:** HIGH
**File:** [src/pages/BrowsePage.jsx](../src/pages/BrowsePage.jsx) (lines 9–106), [src/lib/useSupabase.js](../src/lib/useSupabase.js) (lines 501–543)
**Effort:** S

##### Current broken behavior

```js
// useSupabase.js:525-529
} catch (e) {
  console.error('fetchPublicCatalogProjects', e)
} finally {
  if (!cancelled) setLoading(false)
}
```

On error, state stays `projects=[]`, `loading=false`. The page renders the `filtered.length === 0` branch (empty-state CTA "Réinitialiser"), which reads as "there are no projects in Tunisia" — not "we can't reach the backend". Users assume the catalog is empty.

Worse: if the fetch *hangs* (no resolve, no reject), `loading=true` forever. The skeleton sticks. Today there's no watchdog.

##### Target behavior

- Network errors render an `<ErrorPanel>` with "Réessayer" — clear distinction from "no search results".
- The legitimate "no search results" case (when `query` is set and `filtered.length === 0`) still renders the existing "Aucun projet ne correspond" branch.
- A hung fetch is watchdog'd to 12 s, after which it flips to `<ErrorPanel>`.

##### Specific changes

1. **Rewrite `usePublicBrowseProjects` on top of `usePublicResource`:**
   ```js
   export function usePublicBrowseProjects() {
     return usePublicResource(
       (signal) => db.fetchPublicCatalogProjects({ signal }),
       {
         key: 'public-catalog-projects',
         realtime: {
           name: 'realtime-public-catalog',
           subscriptions: [
             { table: 'projects' },
             { table: 'parcels' },
           ],
         },
       },
     )
   }
   ```
   The new hook returns `{ data, loading, error, retry }`.
2. **BrowsePage render path:**
   ```jsx
   export default function BrowsePage() {
     const { data: catalogProjects, loading, error, retry } = usePublicBrowseProjects()
     const [query, setQuery] = useState('')
     const filtered = useMemo(() => (catalogProjects || []).filter(p => /* ... */), [catalogProjects, query])
     const hasData = Array.isArray(catalogProjects) && catalogProjects.length > 0
     const isSearching = query.trim().length > 0

     return (
       <main className="screen screen--app browse-page-bg">
         <TopBar />
         {/* greeting + map + search bar unchanged */}
         <RenderDataGate
           loading={loading && !hasData}
           error={error}
           empty={hasData && filtered.length === 0 && isSearching}
           emptyMessage={<EmptyState title="Aucun projet ne correspond à votre recherche." action={<button onClick={() => setQuery('')}>Réinitialiser</button>} />}
           retry={retry}
           skeleton={<BrowsePageSkeleton />}
         >
           <div className="projects-grid">
             {filtered.map(project => <ProjectCard key={project.id} project={project} />)}
           </div>
         </RenderDataGate>
       </main>
     )
   }
   ```
   Note: `loading && !hasData` — once we have data, search-filtering doesn't re-trigger the skeleton.
3. **Extract `<BrowsePageSkeleton>`** from the existing skeleton markup at lines 50–61.
4. **Confirm error surfacing with anon-key test.** Set `VITE_SUPABASE_ANON_KEY=invalid` in `.env.local`, reload. Expect `<ErrorPanel>` with "Vérifiez votre connexion" copy, not an empty catalog.

##### Verification steps

1. **Happy path unchanged.** Anonymous user → `/browse` → projects render within 500 ms.
2. **Invalid anon key.** Set a bad key, reload → `<ErrorPanel>` appears; "Réessayer" calls `retry()` which re-runs the fetch. On fixing the key and retrying, the catalog appears.
3. **Search with no matches.** Type "zzzz" into the search bar → `<EmptyState>` with "Réinitialiser" action. Click it, catalog is visible again.
4. **Hung fetch.** Throttle Supabase request to "Offline", reload → skeleton for 12 s, then `<ErrorPanel>`. (Watchdog comes from `<RenderDataGate>`'s internal `useWatchdog`.)

---

#### 3.7 LoginPage — post-login redirect spinner flash

**Severity:** HIGH (UX blemish, but visible to every user who logs in)
**File:** [src/pages/LoginPage.jsx](../src/pages/LoginPage.jsx) (lines 35–55)
**Effort:** S

##### Current broken behavior

```js
// LoginPage.jsx:42-50
const result = await login(form.email, form.password)
// ... result.ok && navigate(result.redirectTo, { replace: true })
```

`login()` in AuthContext has already `await`ed `syncSession()` and `resolveProfiles()`, but the returned state changes (setUser, setAdminUser, setClientProfile) may not have been committed to React's reconciler by the time `navigate()` fires. The new route mounts `RequireCustomerAuth`, which evaluates `loading || !ready` → shows `.app-loader-spinner` for one frame before state catches up. Users perceive "slow login".

In the degenerate case — `isAuthenticated` evaluates false for a frame — `RequireCustomerAuth` redirects back to `/login`, creating a brief `/login → /dashboard → /login → /dashboard` loop.

##### Target behavior

- Navigation after login waits until `AuthContext` is **guaranteed** to have committed the new state. Ideally: let `AuthContext` perform the navigation, not the component.
- No one-frame spinner flash.
- No accidental redirect-loop.

##### Specific changes

1. **Move the redirect into `AuthContext.login()`'s resolution contract.** `login()` returns `{ ok, redirectTo }` today. Plan 01 upgrades it so the resolution of the returned promise **awaits a React flush** before resolving. Sketch:
   ```js
   // AuthContext.login (plan 01)
   await flushPromise()  // double-await microtask + animation frame
   return { ok: true, redirectTo }
   ```
   where `flushPromise = () => new Promise(r => { Promise.resolve().then(() => { requestAnimationFrame(() => r()) }) })`.
2. **Alternative (cheaper):** switch the component to use `<Navigate>` inside a dedicated effect that reads the committed auth state:
   ```jsx
   const [loginResult, setLoginResult] = useState(null)
   async function handleSubmit(e) {
     e.preventDefault()
     if (submittingRef.current) return
     submittingRef.current = true
     setSubmitting(true)
     setError('')
     try {
       const result = await login(form.email, form.password)
       if (!result.ok) { setError(result.error); return }
       setLoginResult(result)  // don't navigate yet — wait for auth state to flush
     } finally { setSubmitting(false); submittingRef.current = false }
   }
   // Redirect ONLY after both: (a) login returned ok, (b) AuthContext says ready+authenticated
   if (loginResult?.ok && ready && isAuthenticated && (adminUser || clientProfile)) {
     const fromPath = typeof location.state?.from === 'string' ? location.state.from : null
     const safePath = pickSafePath(fromPath, null)
     return <Navigate to={loginResult.redirectTo || safePath || '/browse'} replace />
   }
   ```
   The conditional-Navigate pattern is already used at line 26 for the already-logged-in case — just extend it.
3. **Keep the submit button "Connexion en cours…" state active** until the Navigate fires, to give the user continuous feedback. No mid-flight "flash to login form" possible.

##### Verification steps

1. **Throttled login.** With Network set to "Slow 3G", log in. Observe: submit button says "Connexion en cours…" for ~3-5 s, then the dashboard appears. No spinner flash, no route ping-pong.
2. **Fast login.** On a fast connection, transition is seamless (<100 ms).
3. **Already-logged-in redirect.** Visiting `/login` while authenticated still hard-redirects via the `<Navigate>` at line 26.
4. **Failed login.** Wrong password → error banner appears, submit button re-enables, no navigation.

---

### Tier C (MEDIUM)

#### 3.8 PlotPage — unfiltered realtime on `parcel_tree_batches`

**Severity:** MEDIUM
**File:** [src/pages/PlotPage.jsx](../src/pages/PlotPage.jsx), [src/lib/useSupabase.js:591](../src/lib/useSupabase.js#L591)
**Effort:** S (one-line DB filter, but part of broader §7 realtime filter pattern)

Covered structurally in §3.5 (see the realtime `subscriptions` config with `filter: 'project_id=eq.${id}'`). Verification is that a change to `parcel_tree_batches` for an *unrelated* project does not trigger a refresh on the open PlotPage.

---

#### 3.9 PurchaseMandatPage — partial hang

**Severity:** MEDIUM
**File:** [src/pages/PurchaseMandatPage.jsx](../src/pages/PurchaseMandatPage.jsx) (lines 10–49)
**Effort:** S

##### Current broken behavior

Two hooks in parallel: `usePublicProjectDetail(projectId)` and `usePublicVisitSlotOptions()`. If one succeeds and the other hangs, the page renders half-complete — project details shown, slot dropdown shows "Chargement…" forever. User cannot submit the visit request.

##### Specific changes

1. Wrap each sub-section in its own `<RenderDataGate>`:
   - Project header + map — gated by `project` resource.
   - Slot dropdown — gated by `slotOptions` resource.
2. Slot-dropdown gate behavior: if `slotOptions.error` → `<ErrorPanel>` with retry inline inside the form, leave the date picker usable.
3. Submit button disabled only if EITHER (a) slot options loading with no cached data, or (b) slot options errored and user hasn't retried.
4. Drop the top-level `loading && !proj` skeleton at lines 34–46 in favor of per-section skeletons.

##### Verification steps

1. Throttle `fetchPublicVisitSlotOptions` to 30 s. Project loads within 500 ms; slot dropdown shows `<Skeleton variant="row" />` for up to the 10 s watchdog, then `<ErrorPanel>`. User can retry just that section.
2. Submit stays disabled while slot selection is unavailable — but everything else is interactive.

---

#### 3.10 RegisterPage — 20 s timeout, no retry affordance

**Severity:** MEDIUM
**File:** [src/pages/RegisterPage.jsx](../src/pages/RegisterPage.jsx) (lines 57–164)
**Effort:** M

##### Current broken behavior

The 20 s `signup_total_timeout` correctly unblocks the UI, but the error message is confusing: users retry and hit "email already registered" because the signup actually succeeded server-side. No way to tell from the UI whether their account exists.

##### Specific changes

1. On `signup_total_timeout`, the error message should explicitly suggest **two paths**:
   ```jsx
   <ErrorPanel
     title="Le serveur n'a pas répondu à temps"
     message="Votre compte a peut-être été créé. Essayez de vous connecter d'abord."
     actions={[
       { label: 'Essayer la connexion', onClick: () => navigate(`/login?email=${encodeURIComponent(email)}`) },
       { label: 'Réessayer l\'inscription', onClick: () => handleSubmit(e) },
     ]}
   />
   ```
2. Add a `/forgot-password` CTA as a tertiary action ("Pas reçu de mail ? Réessayer mot de passe oublié").
3. Backend-side complement (out of scope for this plan, flag for plan 01): `AuthContext.register()` should check for an existing unconfirmed signup before issuing a new one, and surface a typed `existing_unconfirmed` reason.
4. **Dedupe guard persistence.** Today `submittingRef.current = true` is released in `finally`. If the user force-reloads during the 20 s wait, the ref is gone — they can resubmit and create a duplicate. Mitigation: set a `sessionStorage` flag `zitouna_signup_inflight` at submit, clear it on completion. On mount, if the flag is set, show "Une inscription semble en cours — essayez la connexion".

##### Verification steps

1. **Timeout path.** Throttle to Slow 3G, submit signup → after 20 s, the `<ErrorPanel>` offers login / retry actions.
2. **Timeout then login.** Click "Essayer la connexion" — email is prefilled (via `?email=` query), user logs in with the password they just typed.
3. **Force-reload resilience.** Submit, reload mid-signup. On remount, the "inscription en cours" notice appears.

---

#### 3.11 ResetPasswordPage — recovery flag timing

**Severity:** MEDIUM
**File:** [src/pages/ResetPasswordPage.jsx](../src/pages/ResetPasswordPage.jsx) (lines 38–64), [src/lib/supabase.js:76-130](../src/lib/supabase.js#L76)
**Effort:** S

##### Current broken behavior

The page reads `sessionStorage.getItem(RECOVERY_FLAG_KEY)` and assumes the sync hash handler in `supabase.js` has already set it. On a fast mount (especially with Suspense chunks already cached), the hash handler's `onAuthStateChange('PASSWORD_RECOVERY')` may fire *after* the page's `checking` flag has settled. User sees "Lien expiré ou invalide" despite the URL being valid.

##### Specific changes

1. **Make the recovery-flag resolution async-reactive.** Subscribe to `onAuthStateChange` inside the effect:
   ```js
   useEffect(() => {
     let cancelled = false
     let resolved = false
     async function probe() {
       const { data: { session } } = await supabase.auth.getSession()
       if (cancelled) return
       const recovered = (() => {
         try { return window.sessionStorage.getItem(RECOVERY_FLAG_KEY) === '1' } catch { return false }
       })()
       if (session && recovered) {
         resolved = true
         setHasRecoverySession(true)
         setChecking(false)
       }
     }
     probe()
     const { data: sub } = supabase.auth.onAuthStateChange((event) => {
       if (cancelled) return
       if (event === 'PASSWORD_RECOVERY') { void probe() }
     })
     // Failsafe: if probe hasn't resolved within 2 s, stop waiting and show the error screen.
     const t = window.setTimeout(() => {
       if (cancelled || resolved) return
       setHasRecoverySession(false)
       setChecking(false)
     }, 2000)
     return () => {
       cancelled = true
       window.clearTimeout(t)
       sub.subscription?.unsubscribe()
     }
   }, [])
   ```
2. The existing `<Skeleton>` / spinner at lines 102–110 stays, gated by `checking`.
3. After successful password change, the existing redirect timer is fine.

##### Verification steps

1. **Email link first-click.** Normal path works unchanged.
2. **Slow-mount race.** Throttle to "Slow 3G", click recovery link. Page should *not* flash "Lien expiré" before resolving to the reset form.
3. **Truly expired link.** After 2 s, error screen shows with "Demander un nouveau lien".

---

#### 3.12 NotificationToaster — silent channel failure

**Severity:** MEDIUM
**File:** [src/components/NotificationToaster.jsx](../src/components/NotificationToaster.jsx) (lines 72–128)
**Effort:** S

##### Current broken behavior

```js
// NotificationToaster.jsx:81-124
const channel = supabase
  .channel(`toast:${user.id}:${instanceId}`)
  .on('postgres_changes', { /* ... */ }, (payload) => { /* handler */ })
  .subscribe()
```

`.subscribe()` takes an **optional callback** receiving status (`SUBSCRIBED` / `TIMED_OUT` / `CLOSED` / `CHANNEL_ERROR`). Not passed here → no way to know if the handshake failed. On quota exhaust (>200 channels per user default), the toaster silently does nothing forever.

This applies to **every** `.subscribe()` in the codebase. See §8 for the global fix.

##### Specific changes

1. Replace the direct `.subscribe()` with the shared `useRealtimeChannel` hook (§8):
   ```js
   useRealtimeChannel({
     name: `toast:${user.id}:${instanceId}`,
     subscriptions: [{
       event: 'INSERT',
       table: 'user_notifications',
       filter: `user_id=eq.${user.id}`,
       handler: onInsert,
     }],
     onStatus: (status) => {
       if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
         console.warn('[NotificationToaster] realtime failed:', status)
         // Optional: show a single "Notifications temps-réel indisponibles" toast
         push({
           id: `realtime-error-${Date.now()}`,
           type: 'system_error',
           payload: {
             title: 'Notifications temps-réel indisponibles',
             body: 'Rechargez la page pour réessayer.',
             severity: 'warning',
             link: null,
           },
         })
       }
     },
   }, [user?.id, instanceId])
   ```
2. Also apply to `useNotifications` in [src/lib/notifications.js:296-315](../src/lib/notifications.js#L296).
3. And to all `.subscribe()` calls in `useSupabase.js` — see §8 for the full list.

##### Verification steps

1. **Normal path.** Login, receive a notification, toast appears.
2. **Simulated handshake failure.** Block `wss://` in DevTools → the toaster attempts subscribe → `CHANNEL_ERROR` → the "Notifications temps-réel indisponibles" notice appears once. Console shows the warning.
3. **Recovery.** Unblock WebSockets, reload → normal operation restored.

---

#### 3.13 NotificationsMenu — bell/list desync

**Severity:** LOW (kept LOW; not a blocker)
**File:** [src/components/NotificationsMenu.jsx](../src/components/NotificationsMenu.jsx) (lines 66–75), [src/lib/notifications.js:296-315](../src/lib/notifications.js#L296)

Covered indirectly by §8 (realtime hardening) and §3.12 (status callback). No page-level change beyond switching `useNotifications` to use `useRealtimeChannel`. Badge-vs-list desync is a symptom of silent realtime failures — fixing the handshake surfaces the real problem.

---

#### 3.14 NotificationToaster rendered outside Suspense

**Severity:** LOW
**File:** [src/App.jsx:66](../src/App.jsx#L66)

The toaster sits at `<AppErrorBoundary>` level, above `<Suspense>`. If its first render throws, the whole app shows the error boundary. The component is already defensive (returns null when `!user?.id`), but wrapping it in its own `<ErrorBoundary fallback={null}>` is cheap insurance:

```jsx
// App.jsx
<AppErrorBoundary>
  <ScrollToTopOnRouteChange />
  <ErrorBoundary fallback={null}>
    <NotificationToaster />
  </ErrorBoundary>
  <Suspense fallback={<div className="app-loader"><div className="app-loader-spinner" /></div>}>
    <Routes>{/* ... */}</Routes>
  </Suspense>
</AppErrorBoundary>
```

Trivial, no verification beyond "a thrown error in the toaster no longer kills the app". Include as part of §3.12 change.

---

## 4. Special Focus — The Auth-Heal UX Trap (Tier A infrastructure)

Covered in §3.3. Summary table:

| Concern | Before | After |
|---------|--------|-------|
| Where the heal RPC lives | Inside `DashboardPage` useEffect (never fires if gated) | `AuthContext` state machine + `retryHeal()` callable |
| User-visible state | "Profil introuvable" shown immediately | Loading skeleton while healing, `<ErrorPanel>` only after retries exhausted |
| Retry button behavior | Calls `refreshAuth()` (just re-reads session) | Calls `retryHeal()` (re-runs `heal_my_client_profile_now` + `syncSession`) |
| Phone-conflict handling | Fails silently; user keeps hitting Réessayer | Explicit `blocked` state with "contact support" message, Réessayer disabled |
| Retry policy | None; one-shot | Exponential backoff 1s → 2s → 4s, then surface error |
| Page-level heal | Dashboard has its own effect | Removed; trust the gate |

**Migration note for future pages:** any new customer-facing page that needs a `clientProfile` should wrap in `<RequireCustomerAuth>` and trust the gate. Never re-implement heal logic in the page.

---

## 5. Public / Anon Fetches — `usePublicResource`

### Problem

Research finding #6 (`BrowsePage`) and finding #3 (`ProjectPage`/`PlotPage`) both use "public" hooks (`usePublicBrowseProjects`, `usePublicProjectDetail`) that internally hit Supabase with the anon key. These hooks *should not* block on `awaitInitialAuth()` — unauthenticated visitors must see the catalog. But using the same scoped-resource helper as authenticated pages risks accidentally coupling them.

### Proposal

Two separate helpers in `src/lib/resources/` (new folder):

```js
// src/lib/resources/usePublicResource.js
//
// Public, anon-safe fetcher. Never blocks on auth. Caches per-key to avoid
// duplicate fetches when two components consume the same resource.
//
// Sketch — not final API. Plan 02's createScopedStore is the backing store.
export function usePublicResource(fetcher, { key, enabled = true, realtime }) {
  const store = useOrCreatePublicStore(key, fetcher)
  const { data, loading, error } = useCachedStore(store, { enabled })
  const retry = useCallback(() => store.refresh({ force: true }), [store])
  useRealtimeChannel(realtime, [key])  // §8
  return { data, loading, error, retry }
}
```

```js
// src/lib/resources/useScopedResource.js
//
// Auth-gated fetcher. Waits for awaitInitialAuth() before the first fetch
// and blocks on `enabled`. Re-fetches when clientId changes.
export function useScopedResource(fetcher, { clientId, key, enabled = true, realtime }) {
  const { awaitInitialAuth } = useAuth()
  const authReady = useAuthResolved(awaitInitialAuth)
  const effectiveEnabled = authReady && enabled && Boolean(clientId)
  const store = useOrCreateScopedStore(key, clientId, fetcher)
  const { data, loading, error } = useCachedStore(store, { enabled: effectiveEnabled })
  const retry = useCallback(() => store.refresh({ force: true }), [store])
  useRealtimeChannel(realtime, [key, clientId, effectiveEnabled])  // §8
  return {
    data: effectiveEnabled ? data : (Array.isArray(data) ? [] : null),
    loading: effectiveEnabled && loading,
    error: effectiveEnabled ? error : null,
    retry,
  }
}
```

Key differences:

| Aspect | `usePublicResource` | `useScopedResource` |
|--------|---------------------|---------------------|
| Waits for auth | No | Yes (`awaitInitialAuth`) |
| `clientId` dependency | No | Yes; refetches on change |
| Null/absent clientId | N/A | Returns `{ data: [], loading: false, error: null }` synchronously |
| Realtime channel | Allowed, no filter-on-user | Must filter on user/client scope |
| Used by | BrowsePage, ProjectPage, PlotPage, PurchaseMandatPage, ReferralInvitePage | DashboardPage, InstallmentsPage, all admin pages |

**Rationale for separation:** A mistake where a public page ends up using `useScopedResource` would make the page inaccessible to anon visitors (would wait forever on `awaitInitialAuth` for users without a session — plan 01 must make this return synchronously for unauth users, but keeping the two helpers separate is a defense-in-depth signal).

### Migration list

- `usePublicBrowseProjects` → `usePublicResource`
- `usePublicProjectDetail` → `usePublicResource`
- `usePublicVisitSlotOptions` → `usePublicResource`
- `useSalesScoped` → `useScopedResource`
- `useInstallmentsScoped` → `useScopedResource`
- `useMyCommissionLedger` → `useScopedResource`
- `useAmbassadorReferralSummary` → `useScopedResource`
- `useSalesBySellerClientId` → `useScopedResource`
- `useProjectsScoped` → `useScopedResource`

Public hooks stay in `useSupabase.js` as thin re-exports; scoped hooks get their internals replaced by `useScopedResource`.

---

## 6. Realtime Filtering — Project Scope Pattern

### Problem

From research Pattern B (§299): `PlotPage`'s `parcel_tree_batches` subscription has no filter, causing refetches on every app-wide tree-batch change. This pattern repeats for other child tables — e.g. `installment_payments` inside `useInstallmentsScoped` is subscribed wildcard despite being child of a user-scoped parent.

### Proposed pattern

Every `.on('postgres_changes', …)` call must declare a filter whenever the table has an obvious scope:

| Table | Filter template |
|-------|-----------------|
| `parcels` | `project_id=eq.${projectId}` |
| `parcel_tree_batches` | `project_id=eq.${projectId}` (requires DB column; if missing, filter by `parcel_id=in.(…)`) |
| `installment_plans` | `client_id=eq.${clientId}` |
| `installment_payments` | `client_id=eq.${clientId}` (add a denormalized column or join view) |
| `sales` | `buyer_client_id=eq.${clientId}` OR `seller_client_id=eq.${clientId}` (client pages) |
| `commission_events` | `beneficiary_client_id=eq.${clientId}` (already filtered at [useSupabase.js:1540](../src/lib/useSupabase.js#L1540)) |
| `user_notifications` | `user_id=eq.${userId}` (already filtered) |

Where the table does not have a direct scoping column (e.g. legacy `parcel_tree_batches` without `project_id`), plan 01 or a follow-up DB migration should add a generated column. Until then, the *client-side filter* inside the handler is acceptable as a fallback:

```js
.on('postgres_changes', { event: '*', schema: 'public', table: 'parcel_tree_batches' }, (payload) => {
  const pid = payload?.new?.project_id ?? payload?.old?.project_id
  if (String(pid) !== String(expectedProjectId)) return
  refresh()
})
```

But this is a band-aid — every message still crosses the wire. The DB-side filter is the real fix.

### Enforcement

Add a lint rule (custom ESLint) that flags `supabase.channel(...).on('postgres_changes', { table: '<t>' })` calls missing a `filter:` key for tables in the scoping table above. Plan 06 is where ESLint rules typically live, so file as a cross-plan task.

---

## 7. Shared Global Components — `useRealtimeChannel`

### Problem

All `.subscribe()` calls across the codebase ignore the status callback. From research Pattern D (§306): *"every page with realtime. NotificationToaster, TopBar bell, all admin pages."*

### Proposal

Canonical wrapper in `src/lib/realtime/useRealtimeChannel.js`:

```js
// Sketch — real impl should handle HMR, strict-mode remount, channel reuse.
export function useRealtimeChannel({ name, subscriptions, onStatus } = {}, deps = []) {
  useEffect(() => {
    if (!name || !Array.isArray(subscriptions) || subscriptions.length === 0) return undefined
    let cancelled = false
    const channel = supabase.channel(name)
    for (const sub of subscriptions) {
      const { event = '*', schema = 'public', table, filter, handler } = sub
      const opts = { event, schema, table }
      if (filter) opts.filter = filter
      channel.on('postgres_changes', opts, (payload) => {
        if (cancelled) return
        handler?.(payload)
      })
    }
    channel.subscribe((status) => {
      if (cancelled) return
      if (typeof onStatus === 'function') onStatus(status)
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn('[realtime]', name, status)
      }
    })
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
```

### What lands where

- **New file:** `src/lib/realtime/useRealtimeChannel.js` — implementation.
- **New file:** `src/lib/realtime/useRealtimeHealth.js` — global hook that tracks channel-error counts and exposes a `realtimeHealthy` boolean. Used by TopBar to display a small "offline" indicator. (Optional polish — Tier C.)
- **Migrations:** every `.subscribe()` callsite switches to `useRealtimeChannel`. Greppable list (approx. 40 callsites): `grep -rn '\.subscribe()' src/lib src/pages src/admin src/components`.

### Verification

- Every page + toaster + bell wraps their realtime through `useRealtimeChannel`.
- Manual: break WebSockets in DevTools → every channel logs a single `CHANNEL_ERROR` once, not per-retry.
- Automated: Vitest mocks supabase.channel and asserts the status callback is invoked.

---

## 8. Migration Guide for New Customer-Facing Pages

A copy-paste template for adding a new customer-facing page. Covers the happy path, the four failure modes, and the realtime wiring.

```jsx
// src/pages/MyNewPage.jsx
import { useParams } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import { useScopedResource } from '../lib/resources/useScopedResource.js'
import { RenderDataGate, Skeleton, EmptyState, ErrorPanel } from '../components/ui/index.js'
import * as db from '../lib/db.js'

function MyNewPageSkeleton() {
  return (
    <section className="dashboard-page">
      <TopBar />
      <Skeleton variant="title" />
      <Skeleton variant="card" count={3} />
    </section>
  )
}

export default function MyNewPage() {
  const { someId } = useParams()
  const { clientProfile } = useAuth()
  const clientId = clientProfile?.id || null

  const resource = useScopedResource(
    (signal) => db.fetchMyThing({ clientId, someId }, { signal }),
    {
      clientId,
      key: `my-thing:${someId}`,
      enabled: Boolean(someId),
      realtime: {
        name: `realtime-my-thing-${someId}`,
        subscriptions: [
          { table: 'my_thing', filter: `some_id=eq.${someId}` },
          // Add per-client filter for scoped tables
        ],
      },
    },
  )

  return (
    <main className="screen screen--app">
      <TopBar />
      <RenderDataGate
        loading={resource.loading}
        error={resource.error}
        empty={!resource.data || resource.data.length === 0}
        emptyMessage={<EmptyState title="Rien à afficher" body="Aucun enregistrement pour le moment." />}
        retry={resource.retry}
        skeleton={<MyNewPageSkeleton />}
      >
        <MyThingList items={resource.data} />
      </RenderDataGate>
    </main>
  )
}
```

### Checklist for new pages

- [ ] Wrap the route in `<RequireCustomerAuth>` in `App.jsx` (only if data is user-specific).
- [ ] Use `useScopedResource` or `usePublicResource` — **never** call `supabase` directly from a component.
- [ ] Render through `<RenderDataGate>` — no ad-hoc `{loading ? ... : ...}` trees.
- [ ] Pass a realtime `subscriptions` config with explicit filters (§7). Never subscribe with a bare `table:` and no `filter:` for scoped tables.
- [ ] Extract the skeleton into its own component using `.pub-sk-*` shimmer classes (user's documented preference).
- [ ] No spinner-only fallbacks — the app's loading state is skeleton+shimmer everywhere.
- [ ] Never implement heal/retry logic locally — trust `AuthContext` and `<RenderDataGate>`'s built-in watchdog.

---

## 9. Out of Scope

This plan explicitly does NOT cover:

- **Plan 01 — Auth Session Races.** `AuthContext` internals, `awaitInitialAuth()` contract, `clientHealStatus` state machine. This plan consumes those primitives but does not build them.
- **Plan 02 — Cache/Scoped Store Infrastructure.** `createScopedStore`, `useCachedStore`, `invalidationBus`, `withTimeout`, `fetchWithRetryOnTimeout`. This plan uses them but does not modify their internals.
- **Plan 03 — Admin Pages + Shared UI Components.** `RenderDataGate`, `Skeleton`, `ErrorPanel`, `EmptyState`, `useWatchdog`. This plan consumes them.
- **Plan 05 — Lazy / Suspense / Bundling.** `React.lazy()` chunk behavior, route-level suspense fallbacks, preload hints. Out of scope.
- **Plan 06 — CSS / UI / Skeleton.** `.pub-sk-*` / `.sp-sk-*` class definitions, shimmer keyframes, dark-mode support. This plan references the existing classes; it does not modify them.
- **Broader admin-page loading concerns.** Covered by plan 03.
- **Supabase row-level security / backend migrations.** Filters for `parcel_tree_batches` (§7) may require a DB column — that request lives in the DB migration track, not here.

---

## 10. Acceptance Checklist

### Tier A (blocks merge)

- [ ] `grep -r heal_my_client_profile_now src/pages/` returns zero matches. Heal lives in `AuthContext` only.
- [ ] Cold-login → `/dashboard` on throttled 3G: portfolio section renders within 5 s or shows `<ErrorPanel>` (never a stuck skeleton).
- [ ] Cold-login → `/installments` on throttled 3G: plans list renders within 5 s or shows empty / error state.
- [ ] `/ref/invalid-code`: `<EmptyState>` appears within 2 s, not the "Chargement…" placeholder.
- [ ] Orphan-client DB state: `RequireCustomerAuth` runs heal with retries, only shows "Profil introuvable" after exhaustion.
- [ ] Clicking "Réessayer" on the error panel actually re-runs the heal RPC.
- [ ] No React warning "Cannot set state on unmounted component" during rapid-nav between `/project/1` and `/project/2`.

### Tier B

- [ ] Rapid-nav between project cards on `/browse` never leaves a stale skeleton visible.
- [ ] Invalid `VITE_SUPABASE_ANON_KEY` on `/browse`: `<ErrorPanel>` shown, not empty catalog.
- [ ] No one-frame spinner flash between `/login` submit and `/dashboard` render on fast connections.
- [ ] `PurchaseMandatPage` usable even if `usePublicVisitSlotOptions` hangs — project section renders, slot section errors gracefully.

### Tier C

- [ ] `NotificationToaster` logs `CHANNEL_ERROR` via `.subscribe((status) => ...)` callback; shows user-visible warning toast.
- [ ] `PlotPage` does not refetch on unrelated `parcel_tree_batches` changes.
- [ ] `RegisterPage` timeout offers "Essayer la connexion" action with email prefilled.
- [ ] `ResetPasswordPage` waits for `PASSWORD_RECOVERY` event up to 2 s before showing "Lien expiré".

### Cross-cutting

- [ ] Every `.subscribe()` callsite in `src/**/*.{js,jsx}` is wrapped in `useRealtimeChannel` or documented exemption.
- [ ] Every scoping-needed realtime subscription has an explicit `filter:` or documented exemption.
- [ ] New `useScopedResource` / `usePublicResource` helpers exported from `src/lib/resources/`.
- [ ] `<RenderDataGate>` used by every customer-facing page; zero new `{loading ? <spinner /> : …}` patterns land in this plan's changes.
- [ ] Migration guide (§8) lives in-repo as `src/lib/resources/README.md` or equivalent (deferred to implementation PR, mention in plan commit).

### Regression guards (Vitest)

- [ ] `useScopedResource({ clientId: null, enabled: false })` → `{ data: [], loading: false, error: null }` synchronously.
- [ ] `useScopedResource({ clientId: 'x' })` → transitions `{ loading: true } → { loading: false, data: [...] }` within the test's async window.
- [ ] `useRealtimeChannel` calls `onStatus` with the string passed to the mock `.subscribe()` callback.
- [ ] `ReferralInvitePage` with an unknown code renders the "not found" `<EmptyState>`, not a loading state.
- [ ] `RequireCustomerAuth` with `clientHealStatus='healing'` renders a `<Skeleton>`, not the "Profil introuvable" error panel.

---

## Appendix — Touched-files summary (for PR hygiene)

Implementation will touch at least these files. Not exhaustive; nested component extractions may add more.

**Shared primitives (new):**
- `src/lib/resources/usePublicResource.js`
- `src/lib/resources/useScopedResource.js`
- `src/lib/realtime/useRealtimeChannel.js`
- `src/lib/realtime/useRealtimeHealth.js` (optional)
- `src/components/auth/AuthHealGate.jsx`

**Shared primitives (edit — from plan 03):**
- `src/components/ui/RenderDataGate.jsx`
- `src/components/ui/Skeleton.jsx`
- `src/components/ui/ErrorPanel.jsx`
- `src/components/ui/EmptyState.jsx`

**Pages (edit):**
- `src/pages/DashboardPage.jsx`
- `src/pages/InstallmentsPage.jsx`
- `src/pages/ReferralInvitePage.jsx`
- `src/pages/ProjectPage.jsx`
- `src/pages/PlotPage.jsx`
- `src/pages/BrowsePage.jsx`
- `src/pages/LoginPage.jsx`
- `src/pages/PurchaseMandatPage.jsx`
- `src/pages/RegisterPage.jsx`
- `src/pages/ResetPasswordPage.jsx`

**Components (edit):**
- `src/components/RequireCustomerAuth.jsx`
- `src/components/NotificationToaster.jsx`
- `src/components/NotificationsMenu.jsx`
- `src/App.jsx` (ErrorBoundary around NotificationToaster + key-remount for ProjectPage/PlotPage)

**Data layer (edit):**
- `src/lib/useSupabase.js` — `usePublicBrowseProjects`, `usePublicProjectDetail`, `usePublicVisitSlotOptions`, `useSalesScoped`, `useInstallmentsScoped`, `useMyCommissionLedger`, `useAmbassadorReferralSummary`, `useSalesBySellerClientId`, `useProjectsScoped`.
- `src/lib/notifications.js` — `useNotifications` realtime wiring.
- `src/lib/AuthContext.jsx` — heal state machine (owned by plan 01; this plan consumes).
- `src/lib/db.js` — propagate `{ signal }` through fetchers (owned by plan 02; this plan consumes).

**Tests (new):**
- `src/lib/resources/__tests__/useScopedResource.test.jsx`
- `src/lib/resources/__tests__/usePublicResource.test.jsx`
- `src/lib/realtime/__tests__/useRealtimeChannel.test.js`
- `src/components/__tests__/RequireCustomerAuth.test.jsx`
- `src/pages/__tests__/ReferralInvitePage.test.jsx`

---

## Appendix — Open Questions to Resolve Before Implementation

1. **Plan 01 timeline.** When does `AuthContext.awaitInitialAuth()` + `clientHealStatus` land? Without them, §3.1 and §3.3 are blocked.
2. **Plan 03 component API.** The `<RenderDataGate>` prop shape above is a proposal — plan 03's final signature may differ. If `empty` isn't a first-class prop, this plan needs to adapt.
3. **`parcel_tree_batches` project_id.** Does the DB table have a `project_id` column directly, or only via `parcels.project_id`? If the latter, the `filter:` pattern in §6 won't work without a DB migration. Check with the DB team before starting §3.5 realtime fixes.
4. **Toaster "realtime offline" UX.** Is a warning toast acceptable, or should it be more muted (e.g. a corner indicator in `TopBar`)? Product call needed before §3.12 implementation.
5. **RegisterPage sessionStorage dedupe flag (§3.10).** Need to confirm this won't interfere with the existing `zitouna_ref_code` flow that ReferralInvitePage sets.
6. **Login post-redirect flush (§3.7).** The `flushPromise` approach is slightly hackish — is a cleaner solution to set `RequireCustomerAuth`'s `loading` gate to double-check `user?.id` rather than just `loading`? Worth prototyping.
