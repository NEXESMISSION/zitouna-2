## Admin Pages Loading-State Fixes — Implementation Plan

Companion plan to research finding [reserch/03-admin-pages-loading.md](../reserch/03-admin-pages-loading.md).
Scope: the ~15 admin pages under [src/admin/pages](../src/admin/pages) and the global
[src/admin/AdminLayout.jsx](../src/admin/AdminLayout.jsx) gate.

This plan is a migration plan as much as a bug-fix plan: the vast majority of the
"stuck skeleton until hard-refresh" bugs are symptoms of four recurring anti-patterns
(see research sections "Cross-Cutting Patterns A–D"). Rather than hand-patch each
page, we land a tiny layer of shared primitives (built on top of the new scoped
store layer from plan 02) and then migrate each page to them in order of severity.

Once the shared primitives exist, a single page fix is typically a 20–80 line diff:
remove inline `showSkeletons = loading && data.length === 0` trap, replace with
`<RenderDataGate>`, drop inline JSX skeleton for the canonical shared skeleton.

---

### Executive summary

Problem: admin pages get stuck on skeleton loaders until a hard refresh. Research
file identifies 15 pages with issues across four recurring anti-patterns
(A — AND-combined `loading && data.length === 0`, B — conditional subscriptions,
C — multi-hook deadlock, D — timeout without fallback).

Root cause: each page re-implements its own loading / empty / error rendering inline,
so the four-state rendering matrix collapses to a two-state `loading ? skeleton : data`
check that conflates "loading" with "loaded-but-empty".

Approach (three phases):

1. **Prerequisites (plan 02).** Land the scoped store + watchdog infrastructure.
   This fixes the deeper race causes. Without it, any per-page fix merely masks
   the symptom.
2. **Shared primitives.** Five small components/hooks — one file each, under
   [src/components/skeletons](../src/components/skeletons) and
   [src/components/state](../src/components/state) (new directories). Together they
   replace `~15 × 3` duplicated inline renderings.
3. **Per-page migration.** Each page gets one PR. Tier A pages (6) are detailed;
   Tier B pages (7) are one-paragraph migrations; Tier C items are cosmetic tidy-up.

Expected outcome: no page can stay stuck in a loading state for more than
`WATCHDOG_MS` seconds without surfacing a "Retry" affordance, and the four states
(loading / error / empty / data) are visually distinct on every page.

Estimated effort: 3–5 days after plan-02 infrastructure lands.

---

### Prerequisites

The fixes in this plan assume the following infrastructure from
[plan/02-cache-store-fixes.md](./02-cache-store-fixes.md) has shipped. Each bullet
links to the plan-02 section that introduces it.

- **`createScopedStore(fetcher, key, opts)`** — plan 02 replaces the per-mount
  `useState([])` + `useState(true)` pattern in every scoped hook with a shared
  module-scope store that dedupes concurrent fetches and survives rapid unmounts.
  Contract: returns `{ useValue, useStatus, invalidate, refresh }`.
- **`useStoreStatus(store)`** — returns a discriminated `{ state, error, data }`
  where `state` is exactly one of `'idle' | 'loading' | 'error' | 'ready'`. Pages
  should never build their own status out of `loading && data.length === 0` again.
- **Watchdog timer on scoped stores** — if a fetch exceeds `WATCHDOG_MS` (default
  12 s, configurable per store), the store transitions to `error` with an
  `AbortError` even if the underlying `fetch` never resolves. This is the layer
  that kills Pattern D (timeout without fallback) for every page simultaneously.
- **`fetchWithRetryOnAnyTransient`** — plan-02 item 2. Retries on 401, 5xx, and
  network drops, not only the literal "timed out" string.

If plan 02 is not yet merged, **do not proceed** with the per-page fixes — the
stuck-skeleton symptoms will come back through the hook layer.

One acceptable order of operations if plan 02 is delayed:
(a) ship the shared primitives in this plan with a temporary shim
`useStoreStatus(legacyLoading, legacyError, legacyData)` that compiles status from
the existing hooks, (b) migrate pages off inline conditionals to the primitives,
(c) swap the shim out when plan-02 hooks land. This keeps the page-level PRs small
and the shared-primitive PRs merge-first.

---

### Shared patterns

These are defined **once** and referenced throughout the per-page sections. Do not
re-implement; do not copy-paste. If you find yourself writing the same skeleton
JSX twice in two pages, make a new canonical skeleton instead.

#### 3.1 The four-state rendering rule

Every page that shows remote data has exactly four mutually exclusive states:

| State   | Condition (with plan-02 status) | UI                   |
|---------|----------------------------------|----------------------|
| loading | `status.state === 'loading'`     | `<Skeleton />`       |
| error   | `status.state === 'error'`       | `<ErrorPanel />`     |
| empty   | `status.state === 'ready' && data.length === 0` | `<EmptyState />`     |
| data    | `status.state === 'ready' && data.length > 0`   | the real list/detail |

Against the current codebase, the offending pattern is:

```js
// DO NOT. This is the root cause of 8 of the stuck-skeleton bugs.
const showSkeletons = loading && list.length === 0
return showSkeletons ? <Skeleton/> : <List items={list} />
```

The fix is to switch on the four-state status, not on `loading` + length. When
the hook errors with empty data, the page must show an error panel with a retry
button — never a permanent skeleton.

#### 3.2 `RenderDataGate` component — the four-state wrapper

New file: [src/components/state/RenderDataGate.jsx](../src/components/state/RenderDataGate.jsx).

Purpose: make the four-state switch a single JSX node. Pages that render one
primary collection (the majority of admin pages) can use this and skip all inline
status plumbing.

Sketch:

```jsx
// src/components/state/RenderDataGate.jsx
import { useWatchdog } from './useWatchdog'

export function RenderDataGate({
  status,         // from useStoreStatus — { state, error, data }
  skeleton,       // React element or function() => element
  error,          // React element or function(err, retry) => element
  empty,          // React element or function() => element
  children,       // function(data) => element, only called when state==='ready' && non-empty
  isEmpty,        // optional (data) => bool; default: Array.isArray(data) ? data.length === 0 : data == null
  onRetry,        // optional () => void; typically status.refresh or store.invalidate
  watchdogMs,     // optional; surfaces retry affordance when stuck
}) {
  const stuck = useWatchdog(status, watchdogMs ?? 12_000)
  const render = (v) => (typeof v === 'function' ? v() : v)

  if (status.state === 'loading' || status.state === 'idle') {
    return (
      <>
        {render(skeleton)}
        {stuck && onRetry ? <StuckBanner onRetry={onRetry} /> : null}
      </>
    )
  }
  if (status.state === 'error') {
    return typeof error === 'function'
      ? error(status.error, onRetry)
      : <ErrorPanel error={status.error} onRetry={onRetry} />
  }
  const data = status.data
  const isEmpt = isEmpty ? isEmpty(data) : (Array.isArray(data) ? data.length === 0 : data == null)
  if (isEmpt) return render(empty) ?? <EmptyState />
  return typeof children === 'function' ? children(data) : children
}
```

Usage on any list page becomes one line:

```jsx
<RenderDataGate
  status={clientsStatus}
  skeleton={<ListSkeleton rows={8} />}
  empty={<EmptyState title="Aucun client" hint="Ajoutez un client pour commencer." />}
  onRetry={clientsStatus.refresh}
>
  {(clients) => <ClientTable clients={clients} />}
</RenderDataGate>
```

This one abstraction eliminates Patterns A, C, and D for any page that fits the
single-collection shape. Pages with multi-collection dependencies (SellPage,
RecouvrementPage) compose it (see those sections).

#### 3.3 `useWatchdog(status, ms)` hook

New file: [src/components/state/useWatchdog.js](../src/components/state/useWatchdog.js).

Purpose: surface a retry affordance after `ms` of stuck loading. A true safety
net — plan-02's per-store watchdog should normally fire first and transition the
store into `error`, but if something slips through (nested suspense boundary,
event-loop starvation), the component-level watchdog still saves the user.

Sketch:

```js
// src/components/state/useWatchdog.js
import { useEffect, useState } from 'react'

export function useWatchdog(status, ms = 12_000) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    if (status.state !== 'loading' && status.state !== 'idle') {
      setStuck(false)
      return
    }
    setStuck(false)
    const id = setTimeout(() => setStuck(true), ms)
    return () => clearTimeout(id)
  }, [status.state, ms])
  return stuck
}
```

When `stuck` becomes true, the gate shows a subtle "Chargement lent — Réessayer"
banner overlaid on the skeleton. The user keeps seeing the skeleton (we don't
rip them out of it) but now has agency.

#### 3.4 Skeleton components — one per shape

New directory: [src/components/skeletons/](../src/components/skeletons/). Move the
skeleton JSX currently inlined in each page here. Each file is a small presentational
component that uses the existing `sp-sk-*` CSS classes (see
[src/admin/pages/sell-field.css:440-474](../src/admin/pages/sell-field.css)) so
we reuse the shimmer already tuned for the product.

Files (sketch shapes — see existing inline markups in the page files for exact
layout):

- `ListSkeleton.jsx` — repeating row skeleton for tables/lists (ClientsPage,
  ProjectsPage, AuditLogPage, CashSalesPage, CallCenterPage). Props: `rows`,
  `density` (`'compact' | 'comfortable'`).
- `CardGridSkeleton.jsx` — for AdminProfilePage nav-cards and FinanceDashboard.
  Props: `cards`, `columns`.
- `TableSkeleton.jsx` — for CommissionLedgerPage ledger table and
  UserManagementPage staff/clients tables. Props: `rows`, `columns`.
- `DetailSkeleton.jsx` — for ClientProfilePage, ProjectDetailPage hero + multiple
  sections. Props: `sections`.
- `TreeSkeleton.jsx` — for CommissionTrackerPage upline tree. Props: `depth`.
- `KPISkeleton.jsx` — for dashboard number-tiles (AdminProfile, FinanceDashboard,
  CommissionAnalyticsPage). Props: `tiles`.

Each exported component is ~30–60 lines, wraps `sp-sk-box`/`sp-sk-line` with a
semantic `role="status"` + `aria-label="Chargement…"` for a11y. No business
logic, no hooks, no data awareness. A central barrel
[src/components/skeletons/index.js](../src/components/skeletons/index.js) re-exports
all of them.

Why a directory per shape rather than per page: prevents fragmentation. Right
now there are ~15 `sp-sk-*`-based skeleton blobs duplicated across pages with
subtle differences (row count, gap size) that add up to inconsistent UX.

#### 3.5 `EmptyState` component

New file: [src/components/state/EmptyState.jsx](../src/components/state/EmptyState.jsx).

Purpose: distinct visual that cannot be confused with the shimmer skeleton. The
CSS should deliberately avoid any shimmer animation — a soft icon, a short title,
an optional hint line, and an optional primary action.

Sketch:

```jsx
export function EmptyState({
  icon,          // React element or string emoji
  title,         // required short label
  hint,          // optional longer description
  action,        // optional { label, onClick, variant }
  children,      // optional extra slot (e.g. secondary buttons)
}) {
  return (
    <div className="sp-empty" role="status">
      {icon ? <div className="sp-empty__icon">{icon}</div> : null}
      <div className="sp-empty__title">{title}</div>
      {hint ? <div className="sp-empty__hint">{hint}</div> : null}
      {action ? (
        <button
          type="button"
          className={`sp-empty__btn sp-empty__btn--${action.variant || 'primary'}`}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
      {children}
    </div>
  )
}
```

Add corresponding CSS in the shared admin stylesheet (not per page). Explicit
visual delta from the shimmer: solid neutral border, no gradient.

#### 3.6 `ErrorPanel` component

New file: [src/components/state/ErrorPanel.jsx](../src/components/state/ErrorPanel.jsx).

Purpose: unified error display with a retry button. Crucially, this is what
replaces the "blank page / stuck skeleton" outcome of Pattern D.

Sketch:

```jsx
export function ErrorPanel({ error, onRetry, title, hint }) {
  const message = (error && (error.message || String(error))) || 'Erreur inconnue'
  return (
    <div className="sp-error" role="alert">
      <div className="sp-error__title">{title || 'Impossible de charger'}</div>
      <div className="sp-error__hint">{hint || message}</div>
      {onRetry ? (
        <button type="button" className="sp-error__btn" onClick={onRetry}>
          Réessayer
        </button>
      ) : null}
    </div>
  )
}
```

Always pair with `onRetry` from the store's `refresh` / `invalidate`. A page that
catches an error and shows `<ErrorPanel>` without a retry callback is a bug;
lint rule below.

#### 3.7 Stuck-loading banner (internal to RenderDataGate)

Sketch (inline in `RenderDataGate.jsx`):

```jsx
function StuckBanner({ onRetry }) {
  return (
    <div className="sp-stuck">
      <span className="sp-stuck__msg">Chargement lent…</span>
      <button type="button" className="sp-stuck__btn" onClick={onRetry}>
        Réessayer
      </button>
    </div>
  )
}
```

Keep the skeleton visible behind this banner — don't replace it — so the page
doesn't flicker between skeleton and banner.

#### 3.8 One lint rule (optional but strongly recommended)

Add an ESLint rule (custom, via `no-restricted-syntax` or a tiny custom rule
under [tools/eslint](../tools/eslint/)) that bans the expression pattern:

```text
<identifier>Loading && <identifier>.length === 0
```

as an anti-pattern. Message: "Use <RenderDataGate> or useStoreStatus; see
plan/03-admin-pages-fixes.md#3.1". This is the single biggest lever to prevent
regressions in new admin pages.

---

### Tier A — CRITICAL / HIGH severity pages

Six pages that either (a) frequently hang based on production tickets, (b) have
no loading fallback at all (Pattern D), or (c) block all admin navigation
(AdminLayout). Each has a detailed migration section below.

- [#4.1 AdminLayout.jsx — global admin gate](../src/admin/AdminLayout.jsx) — HIGH
- [#4.2 ClientProfilePage.jsx](../src/admin/pages/ClientProfilePage.jsx) — HIGH
- [#4.3 CommissionLedgerPage.jsx](../src/admin/pages/CommissionLedgerPage.jsx) — HIGH
- [#4.4 CommissionAnomaliesPage.jsx](../src/admin/pages/CommissionAnomaliesPage.jsx) — HIGH
- [#4.5 CommissionTrackerPage.jsx](../src/admin/pages/CommissionTrackerPage.jsx) — MEDIUM → HIGH (Pattern D)
- [#4.6 CommissionAnalyticsPage.jsx](../src/admin/pages/CommissionAnalyticsPage.jsx) — MEDIUM → HIGH (Pattern D)

AdminLayout is broken out as section 5 because it is structurally different
(gate rather than a data page).

#### 4.2 ClientProfilePage.jsx — HIGH

Research ref: [reserch/03-admin-pages-loading.md:27-33](../reserch/03-admin-pages-loading.md).
Source: [src/admin/pages/ClientProfilePage.jsx:140-164](../src/admin/pages/ClientProfilePage.jsx).

##### Current broken behavior

On `/admin/clients/:id`, the component destructures `const client = clients.find(...)`
inside a `useMemo` and then hits `if (!client) return <…empty card…>` at line 140
**before** `useClients()` has resolved on first mount. On initial load, `clients`
is `[]`, so `client` is always `undefined`, so the "Client introuvable" empty card
is rendered every single time — even when the id is valid. Once `useClients()`
resolves, the component re-renders and `client` becomes the real row; the user
briefly sees "introuvable" flicker to the real profile. If `useClients()` times
out, the user is stuck on "Client introuvable" forever.

This conflates three states: (i) hook not yet loaded, (ii) hook loaded and found,
(iii) hook loaded and not found. It also means a nonexistent id shows the same
UI as a still-loading request — misleading, and it hides the hook-stall case.

##### Target behavior after fix

Four distinct states:

1. `clientsStatus.state === 'loading'` → `<DetailSkeleton sections={5} />` with
   the familiar shimmer.
2. `clientsStatus.state === 'error'` → `<ErrorPanel />` with a "Réessayer" button
   wired to `clientsStatus.refresh`.
3. `clientsStatus.state === 'ready'` and the id resolves to a row → real profile.
4. `clientsStatus.state === 'ready'` and the id does not resolve → the existing
   "Client introuvable" empty card (legitimate 404), now clearly visually distinct
   from the skeleton.

Subscription must always mount, regardless of whether `client` is found.

##### Specific changes

- Import the new primitives at the top:
  ```js
  import { RenderDataGate } from '../../components/state/RenderDataGate'
  import { DetailSkeleton } from '../../components/skeletons'
  import { EmptyState } from '../../components/state/EmptyState'
  import { useStoreStatus } from '../../lib/useStoreStatus' // from plan 02
  ```
- Replace `const { clients } = useClients()` with the plan-02 equivalent:
  ```js
  const clientsStatus = useStoreStatus(clientsStore)
  const clients = clientsStatus.data || []
  ```
- Move the `if (!client)` early return **out** of the top of the component. Only
  compute `client` once `clientsStatus.state === 'ready'`.
- Wrap the page body in `<RenderDataGate>`:
  ```jsx
  return (
    <RenderDataGate
      status={clientsStatus}
      skeleton={<DetailSkeleton sections={5} />}
      onRetry={clientsStatus.refresh}
      empty={null /* ready+emptyList is impossible for admin clients; handle below */}
    >
      {(clients) => {
        const client = clients.find((c) => String(c.id) === String(id))
        if (!client) {
          return (
            <EmptyState
              icon="🔎"
              title="Client introuvable"
              hint="Ce client n'existe plus ou a été supprimé."
              action={{ label: 'Voir la liste', onClick: () => navigate('/admin/clients') }}
            />
          )
        }
        return <ClientProfileBody client={client} />
      }}
    </RenderDataGate>
  )
  ```
- All existing inline derivations of `clientCommissions`, stats, etc. move inside
  the `ClientProfileBody` subcomponent (or stay in the `children` callback; same
  thing). This guarantees they never run on a `undefined` client.

##### Verification steps

1. `/admin/clients/<valid-id>`: skeleton → full profile, no intermediate "introuvable"
   flash.
2. `/admin/clients/<nonexistent-id>`: skeleton → "introuvable" empty card.
3. DevTools block requests to `admin_users` table mid-load: skeleton stays, then
   transitions to `<ErrorPanel>` within 12 s with a working "Réessayer" button.
4. Click "Réessayer": skeleton → data.
5. Rapid back/forward 10× between `/admin/clients` and `/admin/clients/:id`: no
   stuck skeleton on either.

##### Estimated effort

M (2–3 h). Medium because `ClientProfilePage` has many derived stats that need
to land inside the data callback rather than as top-level `useMemo` over possibly
undefined `client`.

---

#### 4.3 CommissionLedgerPage.jsx — HIGH

Research ref: [reserch/03-admin-pages-loading.md:66-72](../reserch/03-admin-pages-loading.md).
Source: [src/admin/pages/CommissionLedgerPage.jsx:59-71](../src/admin/pages/CommissionLedgerPage.jsx).

##### Current broken behavior

`useCommissionLedger()` aggregates multiple internal queries (commission events,
payout requests, beneficiaries). The hook exposes one composite `loading`. If
any internal query stalls, `loading` stays `true` forever. The page either shows
no skeleton at all (depending on which tab is open) or shows one indefinitely.
There is no error panel and no retry button.

This is Pattern C (multi-hook deadlock) + Pattern A (AND-combined checks in
the tabs).

##### Target behavior after fix

Four sub-states per tab:

- Tab "Bénéficiaires": uses `ledgerStatus.data.beneficiaries` — show
  `<TableSkeleton rows={8} columns={6} />`, `<ErrorPanel>`, `<EmptyState>`, data.
- Tab "Événements": same with events list.
- Tab "Demandes": same with payout requests.

Whole-page loader only for the very first load before **any** sub-collection has
arrived. Once one of them resolves, the page chrome renders and per-tab gates
take over.

Retry actions per tab call `refresh()` from the hook, which plan-02 exposes as
a store invalidator.

##### Specific changes

- Refactor `useCommissionLedger()` (in [src/lib/useSupabase.js](../src/lib/useSupabase.js))
  to return a **discriminated status per sub-collection** instead of one blanket
  `loading`:
  ```js
  return {
    commissionEvents: eventsStatus,       // full { state, data, error, refresh }
    payoutRequests: requestsStatus,
    beneficiaries: beneficiariesStatus,
    submitPayoutRequest, reviewPayoutRequest,
    refreshAll: () => { eventsStore.refresh(); requestsStore.refresh(); /*…*/ },
  }
  ```
  This is strictly a plan-02 concern, but this page's fix depends on it. Without
  it, the tab-level gating is impossible.
- In the page, wrap each tab content in `<RenderDataGate>` using the tab's own
  status object.
- Drop the single top-level `loading` destructure.
- Add a small `<PageHeaderSkeleton />` for the brief first-frame while all three
  stores are idle (very short; typically invisible after one tick).

##### Verification steps

1. Load page, observe each tab's skeleton independently. Switch tabs before any
   of them have resolved: skeleton in the new tab, not a blank panel.
2. Intentionally break the events query (Supabase dashboard → revoke RLS on
   `commission_events`): events tab shows `<ErrorPanel>`; requests tab still
   renders.
3. Click "Réessayer" on the events tab: skeleton → error or data. Does not
   retrigger the other two queries.
4. On a workspace with zero commission events, events tab shows `<EmptyState>`
   with title "Aucune commission émise" — not a skeleton.

##### Estimated effort

L (4–6 h). Large because the plan-02 hook refactor is non-trivial — it has
three internal queries that need to become three independent stores — and the
page has three tabs plus modal flows that all read from the same hook.

---

#### 4.4 CommissionAnomaliesPage.jsx — HIGH

Research ref: [reserch/03-admin-pages-loading.md:90-96](../reserch/03-admin-pages-loading.md).
Source: [src/admin/pages/CommissionAnomaliesPage.jsx:135-164](../src/admin/pages/CommissionAnomaliesPage.jsx).

##### Current broken behavior

Manual inline RPC with no timeout:

```js
const refresh = useCallback(async () => {
  setLoading(true); setErr(null)
  try {
    const { data: rpcData, error } = await supabase.rpc('detect_parrainage_anomalies')
    if (error) throw new Error(error.message)
    setData(rpcData || {})
  } catch (e) { setErr(String(e?.message || e)) }
  finally { setLoading(false) }
}, [])
```

If Supabase is unreachable (connection drop mid-call), the RPC promise never
resolves. `finally` never fires. `loading` stays `true` forever. No error,
no retry, no timeout. Pure Pattern D.

##### Target behavior after fix

The page acquires data via a small scoped store, so it gets the plan-02 watchdog
automatically. On RPC timeout, the store transitions to `error` with an
`AbortError`; the page shows `<ErrorPanel>` with "Réessayer". On success, the
categorized sections render as today.

##### Specific changes

- Introduce a scoped store in [src/lib/useSupabase.js](../src/lib/useSupabase.js):
  ```js
  export const useParrainageAnomalies = createScopedStore(
    () => supabase.rpc('detect_parrainage_anomalies'),
    'parrainage-anomalies',
    { watchdogMs: 15_000 }, // RPC is heavy; give it extra
  )
  ```
- In the page, replace the `useState`-based data/loading/err triple with:
  ```js
  const anomaliesStatus = useStoreStatus(anomaliesStore)
  ```
- Wrap the page body:
  ```jsx
  <RenderDataGate
    status={anomaliesStatus}
    skeleton={<CardGridSkeleton cards={5} />}
    onRetry={anomaliesStatus.refresh}
    empty={<EmptyState title="Aucune anomalie détectée" />}
    isEmpty={(d) => Object.values(d || {}).every((v) => !Array.isArray(v) || v.length === 0)}
  >
    {(data) => <AnomaliesBody data={data} /*  openSections, toggleSection, etc.  */ />}
  </RenderDataGate>
  ```
- Keep the `openSections`/`toggleSection` local UI state inside `AnomaliesBody`.

##### Verification steps

1. Disconnect network, load page: skeleton visible. After 15 s, `<ErrorPanel>`
   with "Réessayer".
2. Reconnect, click "Réessayer": skeleton → data.
3. Workspace with zero anomalies: `<EmptyState>`, not a skeleton.

##### Estimated effort

S (1 h). Small because the page is mostly presentational and the RPC already
has a single shape.

---

#### 4.5 CommissionTrackerPage.jsx — HIGH (upgraded from MEDIUM)

Research ref: [reserch/03-admin-pages-loading.md:74-80](../reserch/03-admin-pages-loading.md).
Source: [src/admin/pages/CommissionTrackerPage.jsx:31-33](../src/admin/pages/CommissionTrackerPage.jsx).

##### Current broken behavior

```js
const { data, error, refresh } = useCommissionTracker()
```

No `loading` destructure. If the hook hangs, the page returns `undefined` or an
empty fragment for the tree body. The user sees a blank page with no affordance.
Pattern D.

##### Target behavior after fix

Blank page becomes impossible:

- loading → `<TreeSkeleton depth={3} />`
- error → `<ErrorPanel />`
- ready + empty tree → `<EmptyState title="Aucune commission enregistrée" />`
- ready + data → tree renders.

##### Specific changes

- Migrate `useCommissionTracker()` to `createScopedStore` (plan 02).
- Replace the destructure with:
  ```js
  const trackerStatus = useStoreStatus(trackerStore)
  ```
- Wrap body in `<RenderDataGate>` with `skeleton={<TreeSkeleton depth={3} />}`,
  `empty={<EmptyState title="Aucune commission" />}`, `onRetry={trackerStatus.refresh}`.

##### Verification steps

1. Network-offline: skeleton → `<ErrorPanel>` within watchdog.
2. Empty workspace: `<EmptyState>`.
3. Full data: tree renders as today, no regression.

##### Estimated effort

S (1 h).

---

#### 4.6 CommissionAnalyticsPage.jsx — HIGH (upgraded from MEDIUM)

Research ref: [reserch/03-admin-pages-loading.md:82-88](../reserch/03-admin-pages-loading.md).
Source: [src/admin/pages/CommissionAnalyticsPage.jsx:40-47](../src/admin/pages/CommissionAnalyticsPage.jsx).

##### Current broken behavior

Same shape as 4.5 — `useCommissionTracker()` exposes `loading`, but the page
wires it into chart-specific AND-conditions. Page silently shows zero-state
charts when the hook stalls (axes with no bars, looks like a cold workspace).
Pattern D disguised as a "no data yet" chart.

##### Target behavior after fix

Same four-state treatment. Skeleton uses `<KPISkeleton tiles={4} />` for the
top stat row plus chart-shaped placeholders.

##### Specific changes

- Share `trackerStore` with 4.5 so both pages benefit from the same data
  invalidation. Plan 02 already guarantees this via the module-scope store.
- Page uses:
  ```js
  const trackerStatus = useStoreStatus(trackerStore)
  ```
- Wrap KPI row and each chart in their own `<RenderDataGate>` for isolated
  loading states (alternative: wrap the whole page in one gate — simpler,
  acceptable given the charts all read from the same store).

##### Verification steps

Same as 4.5.

##### Estimated effort

S (1 h).

---

### 5. AdminLayout — global admin gate fix

Research ref: [reserch/03-admin-pages-loading.md:139-146](../reserch/03-admin-pages-loading.md).
Source: [src/admin/AdminLayout.jsx:37-43](../src/admin/AdminLayout.jsx).

##### Current broken behavior

```js
function AdminAccessGate() {
  const { loading, ready, isAuthenticated, adminUser, clientProfile } = useAuth()
  if (loading || !ready) {
    return <div className="app-loader"><div className="app-loader-spinner" /></div>
  }
  // … gating logic …
}
```

`loading || !ready` is an OR on two fallible auth booleans. If `loading` never
transitions to `false` (auth token refresh race — see plan 01), the admin UI
is completely blocked with nothing but a spinner. No error, no retry, no
timeout. This is the **single highest-impact bug** in this plan because it
blocks every admin page, not just one.

##### Target behavior after fix

1. Spinner for up to `AUTH_WATCHDOG_MS` (default 10 s).
2. After watchdog, show `<AuthStuckPanel>` with:
   - Description of the issue ("Authentification bloquée").
   - "Réessayer" button → calls `refreshSession()` from AuthContext (plan 01 API).
   - "Se déconnecter" button → calls `signOut()` + redirect to `/login`.
3. If `ready === true` and `!isAuthenticated`, unchanged `<Navigate to="/login" />`.
4. If `adminUser === null && clientProfile === null` after ready, render a
   dedicated "No role assigned" empty state (currently falls through to a
   silent navigate).

This ensures no user is ever locked behind a permanent spinner.

##### Specific changes

- New file: [src/admin/AuthStuckPanel.jsx](../src/admin/AuthStuckPanel.jsx):
  ```jsx
  export function AuthStuckPanel({ onRetry, onSignOut }) {
    return (
      <div className="zitu-page" dir="ltr" style={{ padding: 24, maxWidth: 480, margin: '0 auto' }}>
        <h1 style={{ fontSize: 18 }}>Authentification bloquée</h1>
        <p style={{ fontSize: 13, color: '#64748b' }}>
          Le chargement de votre session prend plus de temps que prévu. Veuillez réessayer
          ou vous reconnecter.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={onRetry}>Réessayer</button>
          <button onClick={onSignOut}>Se déconnecter</button>
        </div>
      </div>
    )
  }
  ```
- In `AdminAccessGate`, replace the `if (loading || !ready)` branch:
  ```jsx
  const authStatus = useAuthStatus() // provided by plan 01; { state, retry, signOut }
  if (authStatus.state === 'loading' || authStatus.state === 'idle') {
    return (
      <AuthLoader>
        {/* reuse RenderDataGate for consistency */}
        <RenderDataGate
          status={authStatus}
          skeleton={<AppLoaderSpinner />}
          error={() => <AuthStuckPanel onRetry={authStatus.retry} onSignOut={authStatus.signOut} />}
          onRetry={authStatus.retry}
          watchdogMs={10_000}
        >
          {/* no children — we only render when state is 'ready', which falls through */}
          {() => null}
        </RenderDataGate>
      </AuthLoader>
    )
  }
  ```
  If plan 01's `useAuthStatus` isn't available yet, a simpler temporary shim:
  `useWatchdog({ state: loading ? 'loading' : 'ready' }, 10_000)` drives a conditional
  `<AuthStuckPanel>` overlay.
- Handle the `!adminUser && !clientProfile && isAuthenticated` case at the bottom
  — currently falls through to `<Navigate to="/browse" />`. Replace with an
  explicit `<EmptyState>` page: "Votre compte n'a pas de rôle assigné. Contactez
  un administrateur."

##### Verification steps

1. Normal login: spinner → admin page, under 1 s, no visible stuck banner.
2. Simulated stuck auth (throttle DevTools → "Offline" mid-load of AuthContext):
   spinner → `<AuthStuckPanel>` within 10 s. "Réessayer" kicks off session
   refresh. "Se déconnecter" redirects to login.
3. Expired token (forced by wiping `localStorage.session` between navigations):
   spinner → login redirect, no stuck panel (because `ready` transitions without
   `loading` hanging).
4. A client logged in with no allowed pages: "No role assigned" panel, not
   a silent redirect loop.

##### Estimated effort

M (2–3 h). Non-trivial because plan 01's AuthContext API isn't fully known yet;
budget time for the shim.

---

### Tier B — MEDIUM severity pages

Seven pages where the same AND-combined `loading && data.length === 0` pattern
hangs occasionally, typically on cold sessions or slow networks. Each is a
mechanical migration to `<RenderDataGate>` and one of the shared skeletons.
One paragraph each.

#### 6.1 AdminProfilePage.jsx

[src/admin/pages/AdminProfilePage.jsx:236-238](../src/admin/pages/AdminProfilePage.jsx).
Two flags, `showSalesSkeleton` and `showStaffSkeleton`, both use the AND-empty
trap. Migrate each to `<RenderDataGate>` over its respective store
(`salesStatus`, `adminUsersStatus`). Use `<KPISkeleton tiles={6} />` for the
sales count row and `<CardGridSkeleton cards={8} columns={4} />` for the nav
cards. Keep the `isSuperAdmin` branch around the staff-skeleton gate, as it's
a permissions gate, not a loading gate. Effort: S.

#### 6.2 AuditLogPage.jsx

[src/admin/pages/AuditLogPage.jsx:176](../src/admin/pages/AuditLogPage.jsx).
Classic Pattern A: `showSkeletons = loading && list.length === 0`. Migrate to
`<RenderDataGate>` with `<ListSkeleton rows={10} />` and a dedicated
`<EmptyState title="Aucun événement" hint="L'historique d'audit est vide pour ce workspace." />`.
Be aware that the page also has `hasActiveFilters` — when filters are active
and filtered list is empty, show a **different** empty state ("Aucun événement
pour ces filtres") rather than the "workspace empty" state. Add an
`isEmpty` prop that accounts for this: `isEmpty={(data) => data.length === 0}`
and render different empty children based on `hasActiveFilters`. Effort: S.

#### 6.3 CallCenterPage.jsx

[src/admin/pages/CallCenterPage.jsx:136](../src/admin/pages/CallCenterPage.jsx).
`showSkeletons = projectsLoading && calls.length === 0`. Skeleton depends on
**projects** loading, not on calls — this is wrong. Swap the source: the
skeleton should gate on the calls store (scoped, not `useProjects`). Use
`<ListSkeleton rows={8} />`. If projects is still loading separately, that's
a filter dropdown, not a page blocker — show a small inline "Chargement…" label
on the dropdown instead of blocking the whole page. Effort: S.

#### 6.4 CashSalesPage.jsx

[src/admin/pages/CashSalesPage.jsx:87](../src/admin/pages/CashSalesPage.jsx).
`showSkeletons = salesLoading && cashSales.length === 0`, AND-empty trap.
Migrate to `<RenderDataGate>` over `salesStatus`, filtered view computed inside
the children callback. `<ListSkeleton rows={8} />`, `<EmptyState title="Aucune vente comptant" />`.
Effort: S.

#### 6.5 ClientsPage.jsx

[src/admin/pages/ClientsPage.jsx:92](../src/admin/pages/ClientsPage.jsx).
`showSkeletons = clientsLoading && (clients || []).length === 0`. Textbook
Pattern A. Direct `<RenderDataGate>` migration, `<ListSkeleton rows={10} />`,
`<EmptyState title="Aucun client" action={{ label: 'Ajouter un client', onClick: … }} />`.
Active filters branch same as AuditLogPage. Effort: S.

#### 6.6 ProjectDetailPage.jsx

[src/admin/pages/ProjectDetailPage.jsx:56-57](../src/admin/pages/ProjectDetailPage.jsx).
Pattern B (conditional subscription): `useProjectWorkflow(project?.id || '')`
skips fetching when project is undefined. Two-stage gate: outer gate on
`projectsStatus` (pull the project row from the list), inner gate on
`workflowStatus` (scoped to the resolved project id). Once plan 02's scoped
stores land with parameterized stores (`createScopedStore` keyed by id), this
is straightforward. Use `<DetailSkeleton sections={6} />` for the outer gate
and small per-section skeletons inside. Nonexistent projectId shows an
`<EmptyState title="Projet introuvable" />` similar to ClientProfilePage.
Effort: M (similar complexity to ClientProfilePage).

#### 6.7 ProjectsPage.jsx

[src/admin/pages/ProjectsPage.jsx:41-44](../src/admin/pages/ProjectsPage.jsx).
Hook with no loading fallback on the list. Migrate to `<RenderDataGate>` over
`projectsStatus`, `<ListSkeleton rows={8} />`, `<EmptyState title="Aucun projet" action={{ label: 'Créer un projet', onClick: () => setShowCreate(true) }} />`.
The `offersByProject` hook is a secondary dependency — render the list as soon
as projects arrive, show `-` for offer counts while offers are still loading,
don't block the whole page on offers. Effort: S.

#### 6.8 SellPage.jsx

[src/admin/pages/SellPage.jsx:1-15](../src/admin/pages/SellPage.jsx).
Six independent hooks drive a six-step wizard. Pattern C (multi-hook deadlock).
**Do not** try to make the wizard wait for all six hooks — that's how it hangs
today. Instead: each wizard step gates on only the hooks it actually needs,
using `<RenderDataGate>` per step. Step 1 (pick project) only needs
`projectsStatus`. Step 2 (pick parcel) additionally needs `mySellerParcelAssignmentsStatus`.
Step 3 (client) needs `clientsStatus`. Etc. This is the biggest architectural
change in Tier B; plan the PR with a step-by-step migration (one step per
commit). Add a top-level `<WizardSkeleton />` only while the **first-step
dependencies** are loading, not all six. Effort: L (1 day — large mostly
because of the number of steps, not because any one of them is hard).

#### 6.9 RecouvrementPage.jsx

[src/admin/pages/RecouvrementPage.jsx:50-94](../src/admin/pages/RecouvrementPage.jsx).
Three hooks (`useInstallments`, `useSales`, `useClients`); the `missingPlanSales`
memo at lines 84-94 returns `[]` while either `plansLoading` or `salesLoading`
is true, which is correct **only** if we also show a skeleton during that
period. Today we don't; we show "0 missing plans" which is misleading. Migrate
to a composed gate: show a single `<TableSkeleton rows={8} columns={5} />`
while any of the three stores is still loading, then render the full page.
If just one of the three errors, show an inline `<ErrorPanel>` scoped to that
tab's data (installments tab → installments error; clients tab → clients error).
Effort: M.

#### 6.10 UserManagementPage.jsx

[src/admin/pages/UserManagementPage.jsx:47-50](../src/admin/pages/UserManagementPage.jsx).
Single shared `loading` flag between the staff tab and the clients tab; clicking
clients tab before staff loads shows wrong loading. Split the loading: each tab
gets its own status object (`adminUsersStatus` for staff, `clientsStatus` for
clients). Wrap each tab's list in `<RenderDataGate>` with `<TableSkeleton rows={8} columns={5} />`.
Swap tab behavior: tab switch should never re-trigger a loading state if that
tab's data is already `ready`. Effort: M (tab plumbing is fiddly).

---

### Tier C — LOW severity / cosmetic

These are not stuck-skeleton bugs, but cleanup items that fall out of the same
migration. Pick them up opportunistically as part of Tier A/B PRs that touch
the same file.

- Move all inline `<style>{LOCAL_STYLES}</style>` blocks (ClientProfilePage and
  others) into the shared admin stylesheet once the skeletons are in.
- Unify French empty-state copy: one of "Aucun(e) X", not three variants.
- Replace any remaining `role="status"` divs on skeleton containers with a
  single `role="progressbar" aria-busy="true"` — better AT support.
- Remove dead code in the Tier-B pages once the gates are in (orphan
  `showSkeletons` const assignments, unused conditional renders).
- Adopt the `<Suspense fallback={<PageSkeleton />}>` wrapping at the route level
  for lazy-loaded pages (cross-reference [plan/05-lazy-suspense-bundling.md](./05-lazy-suspense-bundling.md)).
- Add a `loading.json` ARIA-live announcement string for screen readers.

---

### 7. Migration guide — template for new admin pages

Copy this template when adding a new admin page. It guarantees the four-state
contract out of the box. See also: the pattern on every migrated page in this
plan.

```jsx
// src/admin/pages/MyNewAdminPage.jsx
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStoreStatus } from '../../lib/useStoreStatus'      // plan 02
import { myEntityStore } from '../../lib/useSupabase'          // plan 02 store export
import { RenderDataGate } from '../../components/state/RenderDataGate'
import { EmptyState } from '../../components/state/EmptyState'
import { ErrorPanel } from '../../components/state/ErrorPanel'
import { ListSkeleton } from '../../components/skeletons'

export default function MyNewAdminPage() {
  const navigate = useNavigate()
  const status = useStoreStatus(myEntityStore)
  const [query, setQuery] = useState('')

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        ← Retour
      </button>

      <header className="sp-hero">
        <h1>Ma nouvelle page</h1>
      </header>

      <RenderDataGate
        status={status}
        skeleton={<ListSkeleton rows={8} />}
        onRetry={status.refresh}
        empty={
          <EmptyState
            title="Aucun élément"
            hint="Commencez par en créer un."
            action={{ label: 'Créer', onClick: () => {/* … */} }}
          />
        }
      >
        {(items) => {
          const filtered = items.filter((x) => x.name.includes(query))
          if (filtered.length === 0) {
            return <EmptyState title="Aucun résultat pour ces filtres" />
          }
          return (
            <ul className="sp-list">
              {filtered.map((x) => <li key={x.id}>{x.name}</li>)}
            </ul>
          )
        }}
      </RenderDataGate>
    </div>
  )
}
```

Checklist when adding a new admin page (paste into PR description):

- [ ] Data comes from a scoped store (plan 02), not per-mount `useState` +
  `useEffect(() => fetch())`.
- [ ] Status consumed via `useStoreStatus(store)`, not raw `loading` boolean.
- [ ] Body wrapped in `<RenderDataGate>` with all four slots filled (or an
  explicit reason why a slot is null/undefined).
- [ ] `skeleton` is one of `<ListSkeleton>`, `<TableSkeleton>`, `<CardGridSkeleton>`,
  `<DetailSkeleton>`, `<TreeSkeleton>`, `<KPISkeleton>` — not an inline JSX blob.
- [ ] `empty` uses `<EmptyState>` with a concrete title, hint, and (when
  actionable) action button.
- [ ] `onRetry` is wired to `status.refresh` (or store.invalidate).
- [ ] No expression of the form `XLoading && X.length === 0` anywhere in the
  file. Run `eslint` to confirm the lint rule (see 3.8) passes.
- [ ] If the page has filters, distinguish "empty workspace" from "empty filter
  result" with two `<EmptyState>` variants.
- [ ] If the page has tabs, each tab gets its own gate (never a single shared
  `loading`).

---

### 8. Out of scope

Explicitly NOT covered by this plan (tracked elsewhere):

- Auth session races and AuthContext internals → [plan/01-auth-session-races.md](./01-auth-session-races.md).
- `createCachedStore` / `fetchWithRetryOnTimeout` / scoped-hook store plumbing →
  [plan/02-cache-store-fixes.md](./02-cache-store-fixes.md).
- Public customer pages (RegisterPage, LoginPage, dashboards, browse) →
  [plan/04-public-customer-pages.md](./04-public-customer-pages.md).
- Lazy-loading / Suspense / bundle splitting → [plan/05-lazy-suspense-bundling.md](./05-lazy-suspense-bundling.md).
- CSS of the skeleton shimmer, sp-sk-* classes, visual tuning →
  [plan/06-css-ui-skeleton.md](./06-css-ui-skeleton.md).
- Page-specific business-logic bugs (wrong totals, wrong filters, missing
  validations). Each of those is its own ticket.
- Internationalization (FR/AR) of empty-state copy — follow-up.
- Accessibility audit of new skeletons (beyond adding role/aria-label baseline)
  — follow-up.

---

### 9. Acceptance checklist

Ship when all of the following are true.

Shared primitives:

- [ ] `src/components/skeletons/` contains `ListSkeleton`, `TableSkeleton`,
  `CardGridSkeleton`, `DetailSkeleton`, `TreeSkeleton`, `KPISkeleton`, and an
  `index.js` barrel.
- [ ] `src/components/state/RenderDataGate.jsx`, `EmptyState.jsx`,
  `ErrorPanel.jsx`, `useWatchdog.js` exist and pass unit tests.
- [ ] `RenderDataGate` is covered by tests for each of its four states plus
  the stuck-loading path.
- [ ] Lint rule (3.8) lands and is enforced in CI.

Tier A pages:

- [ ] AdminLayout shows `<AuthStuckPanel>` within 10 s of stuck auth.
- [ ] ClientProfilePage shows skeleton → profile, no "introuvable" flash on
  valid ids, proper empty on invalid ids.
- [ ] CommissionLedgerPage: each tab has its own gate; a broken query in one
  tab does not block the others.
- [ ] CommissionAnomaliesPage: stuck RPC transitions to `<ErrorPanel>` within
  15 s.
- [ ] CommissionTrackerPage and CommissionAnalyticsPage: never render blank;
  always one of skeleton / error / empty / data.

Tier B pages:

- [ ] All 7 pages migrated to `<RenderDataGate>` and shared skeletons.
- [ ] No page in `src/admin/pages/` contains the regex
  `\b\w+Loading && \w+\.length === 0`.

Regression checks:

- [ ] Ten back-and-forth navigations across `/admin/clients`, `/admin/projects`,
  `/admin/commission-ledger`, `/admin/sell` produce zero stuck skeletons
  (enforced by an integration test with Playwright).
- [ ] On a workspace with zero rows for every entity, every admin page shows
  a meaningful `<EmptyState>`, never a skeleton.
- [ ] DevTools "offline" mode during any admin page load produces
  `<ErrorPanel>` with a working "Réessayer" button within the watchdog.

Documentation:

- [ ] Section 7 template added to the contribution guide (CONTRIBUTING.md or
  equivalent).
- [ ] Lint rule message points at this plan section 3.1.
- [ ] Future-audit note: the next loading-state audit should only need to check
  that new pages use the primitives; no individual page should ever re-acquire
  the old AND-empty anti-pattern.

---

### Appendix A — Effort roll-up

| Item                                          | Effort | Depends on          |
|-----------------------------------------------|--------|---------------------|
| Shared primitives (skeletons + state)         | M      | —                   |
| Lint rule (3.8)                               | S      | primitives          |
| 4.1 AdminLayout                               | M      | plan 01 API         |
| 4.2 ClientProfilePage                         | M      | primitives, plan 02 |
| 4.3 CommissionLedgerPage                      | L      | primitives, plan 02 |
| 4.4 CommissionAnomaliesPage                   | S      | primitives, plan 02 |
| 4.5 CommissionTrackerPage                     | S      | primitives, plan 02 |
| 4.6 CommissionAnalyticsPage                   | S      | primitives, plan 02 |
| 6.1–6.7 Tier B (7 pages)                      | S×5+M×2| primitives, plan 02 |
| 6.8 SellPage (6-step wizard)                  | L      | primitives, plan 02 |
| 6.9 RecouvrementPage                          | M      | primitives, plan 02 |
| 6.10 UserManagementPage                       | M      | primitives, plan 02 |
| Tier C cosmetic                               | —      | opportunistic       |

Total: ~3–5 engineer-days after plan 02 infrastructure ships.

---

### Appendix B — Files created / modified summary

New files (created):

- `src/components/skeletons/ListSkeleton.jsx`
- `src/components/skeletons/TableSkeleton.jsx`
- `src/components/skeletons/CardGridSkeleton.jsx`
- `src/components/skeletons/DetailSkeleton.jsx`
- `src/components/skeletons/TreeSkeleton.jsx`
- `src/components/skeletons/KPISkeleton.jsx`
- `src/components/skeletons/index.js`
- `src/components/state/RenderDataGate.jsx`
- `src/components/state/EmptyState.jsx`
- `src/components/state/ErrorPanel.jsx`
- `src/components/state/useWatchdog.js`
- `src/admin/AuthStuckPanel.jsx`
- `tools/eslint/no-loading-empty-and-pattern.js` (custom lint rule)

Modified files (per Tier A/B sections):

- `src/admin/AdminLayout.jsx`
- `src/admin/pages/AdminProfilePage.jsx`
- `src/admin/pages/AuditLogPage.jsx`
- `src/admin/pages/CallCenterPage.jsx`
- `src/admin/pages/CashSalesPage.jsx`
- `src/admin/pages/ClientProfilePage.jsx`
- `src/admin/pages/ClientsPage.jsx`
- `src/admin/pages/CommissionAnalyticsPage.jsx`
- `src/admin/pages/CommissionAnomaliesPage.jsx`
- `src/admin/pages/CommissionLedgerPage.jsx`
- `src/admin/pages/CommissionTrackerPage.jsx`
- `src/admin/pages/ProjectDetailPage.jsx`
- `src/admin/pages/ProjectsPage.jsx`
- `src/admin/pages/RecouvrementPage.jsx`
- `src/admin/pages/SellPage.jsx`
- `src/admin/pages/UserManagementPage.jsx`
- `src/lib/useSupabase.js` (exposes scoped stores; plan 02 work)
- One shared admin stylesheet for `.sp-empty`, `.sp-error`, `.sp-stuck` styles.

---

### Appendix C — Quick reference: old → new patterns

| Old pattern | New pattern |
|-------------|-------------|
| `const { items, loading } = useItems()` | `const status = useStoreStatus(itemsStore); const items = status.data || []` |
| `const showSkeletons = loading && items.length === 0` | `<RenderDataGate status={status} skeleton={<ListSkeleton/>} ...>` |
| `{loading ? <Skel/> : <List items={items}/>}` | `<RenderDataGate>{(items) => <List items={items}/>}</RenderDataGate>` |
| `if (!entity) return <…empty card…>` (before hook settles) | gate + `isEmpty` in children callback |
| inline `<div className="sp-sk-box"/>` | `<ListSkeleton rows={N} />` |
| no error branch (Pattern D) | `<RenderDataGate>` always handles `error` via `<ErrorPanel>` |
| no retry button | every `<RenderDataGate>` has `onRetry` wired to `status.refresh` |

This table is the one-slide summary for the team. If a code review mentions
"why all these new wrappers", point to this table.
