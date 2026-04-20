# 00 — Master Plan Overview

## What this folder is

Seven implementation plans that fix the stuck-skeleton / hard-refresh-required bugs documented in [reserch/](../reserch). Each plan is a stand-alone markdown file a developer can execute. Plans cross-reference each other where dependencies exist, but each one is designed to be reviewed, estimated, and merged as its own stream of PRs.

**Before reading this:** skim [reserch/00-INDEX.md](../reserch/00-INDEX.md) so you understand the symptoms. This folder tells you how to fix them.

---

## The plan files

| # | File | Scope | Effort |
|---|---|---|---|
| 01 | [01-auth-session-fixes.md](01-auth-session-fixes.md) | AuthContext, Supabase Web Lock, StrictMode, auth-event bus, initial-auth gate | 2–3 dev-days |
| 02 | [02-cache-store-fixes.md](02-cache-store-fixes.md) | Cache store infra, `createScopedStore`, abortable timeout, watchdog | 3–5 dev-days |
| 03 | [03-admin-pages-fixes.md](03-admin-pages-fixes.md) | Per-admin-page migration to shared patterns; `RenderDataGate`, shared skeletons | 3–5 dev-days |
| 04 | [04-public-customer-pages-fixes.md](04-public-customer-pages-fixes.md) | Dashboard, Installments, Browse, Project/Plot, Login/Register, RequireCustomerAuth | 3–4 dev-days |
| 05 | [05-lazy-suspense-fixes.md](05-lazy-suspense-fixes.md) | `lazyWithRetry`, version manifest, Vercel caching, Suspense error boundary | 1–2 dev-days |
| 06 | [06-css-ui-skeleton-fixes.md](06-css-ui-skeleton-fixes.md) | Unified skeleton CSS, `aria-busy`, `prefers-reduced-motion`, three loader variants | 1–2 dev-days |

Total realistic budget for everything: **~3 weeks of focused work for one mid-level developer**, or ~2 weeks for two developers working in parallel streams.

---

## Dependency graph

The plans are not strictly sequential. This is the dependency map — "X depends on Y" means X's items assume Y's infrastructure exists (you can still start X before Y finishes, but you'll need shim fallbacks for anything that imports from Y).

```
                  ┌───────────────────────────┐
                  │ 01 auth-session-fixes     │
                  │   (new: authHelpers.js,   │
                  │    authEventBus.js)       │
                  └───────────┬───────────────┘
                              │
                              ▼
          ┌───────────────────┴───────────────────┐
          │ 02 cache-store-fixes                  │
          │   (new: createScopedStore,            │
          │    withAbortableTimeout,              │
          │    retryWithBackoff, safeSubscribe,   │
          │    useStoreStatus, watchdog)          │
          └───────────┬───────────────────────────┘
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │ 03 admin │  │ 04 cust. │  │ 06 CSS   │
   │ pages    │  │ pages    │  │ & UI     │
   │ (new:    │  │ depends  │  │ depends  │
   │  Render- │  │ on 03's  │  │ on 03's  │
   │  DataGate│  │ Render-  │  │ Skeleton │
   │  useWD,  │  │  DataGate│  │  comps   │
   │  skel-   │  │          │  │          │
   │  tons/)  │  │          │  │          │
   └──────────┘  └──────────┘  └──────────┘

        ┌─────────────────────────────────┐
        │ 05 lazy-suspense-fixes          │
        │   (independent of 01/02/03/04/06)│
        └─────────────────────────────────┘
```

Plan 05 is a side-quest — it can be done in parallel with anything and ships independently. Plans 01 and 02 are the bedrock — they produce the utilities the rest of the codebase will consume. 03 and 04 are mostly mechanical migrations once 02 is in place. 06 is a polish layer.

---

## Recommended implementation sequence

### Phase 1 — Foundations (week 1)

Work on **plan 01 + plan 02 + plan 05 in parallel** if you have multiple devs. If solo, 01 → 02 → 05 is the safe serial order.

**Goal of Phase 1:** the infrastructure exists. No user-visible behavior change yet other than "login no longer flashes to /login" and "Vercel deploys no longer leave users on stuck spinners".

**Deliverables:**
- `src/lib/authHelpers.js`, `src/lib/authEventBus.js` (plan 01)
- `src/lib/createScopedStore.js`, `src/lib/withAbortableTimeout.js`, `src/lib/retryWithBackoff.js`, `src/lib/safeSubscribe.js`, `src/lib/useStoreStatus.js` (plan 02)
- `src/lib/lazyWithRetry.js`, `src/components/ChunkLoadErrorBoundary.jsx`, `public/version.json`, `src/lib/useVersionPoller.js`, `src/components/VersionBanner.jsx` (plan 05)
- `vercel.json` cache-control updates (plan 05)

### Phase 2 — Shared rendering primitives (week 1 end / week 2 start)

**Plan 03 section 3 only** — ship the shared `RenderDataGate`, `useWatchdog`, skeleton components, `EmptyState`, `ErrorPanel` BEFORE migrating individual pages. These are low-risk pure-component additions.

Also plan 06 can land its CSS consolidation here, since plan 03's skeleton components will use those CSS classes.

**Deliverables:**
- `src/components/RenderDataGate.jsx`
- `src/hooks/useWatchdog.js`
- `src/components/skeletons/` (SkeletonLine, SkeletonCard, SkeletonTable, SkeletonDetail, SkeletonTree, SkeletonKPI)
- `src/components/EmptyState.jsx`, `src/components/ErrorPanel.jsx`
- `src/styles/skeletons.css` (consolidated)

### Phase 3 — Page migrations (week 2)

With all infrastructure in place, migrate the pages. These are mostly mechanical: replace inline skeleton JSX with `<RenderDataGate>`, replace `useSalesScoped`/`useInstallmentsScoped` call sites with the new `createScopedStore`-backed hooks.

**Order within phase:**
1. **Tier A Admin (plan 03)** — ClientProfilePage, CommissionLedgerPage, CommissionAnomaliesPage, CommissionTracker/Analytics. These are the pages that stuck-skeleton most often.
2. **Tier A Customer (plan 04)** — DashboardPage, InstallmentsPage, RequireCustomerAuth heal trap.
3. **Tier B Admin (plan 03)** — AdminProfile, AuditLog, CallCenter, CashSales, Clients, ProjectDetail, Projects, Sell wizard, Recouvrement, UserManagement.
4. **Tier B/C Customer (plan 04)** — BrowsePage, ProjectPage/PlotPage, LoginPage/RegisterPage/ResetPasswordPage, ReferralInvitePage, PurchaseMandatPage.

### Phase 4 — Polish (week 3)

- Plan 06 remaining items: `aria-busy`/`aria-live`, `prefers-reduced-motion`, three distinct loader variants.
- Any Tier C cleanups (NotificationToaster polling, shimmer duration consistency).
- ESLint rules to prevent regressions (the "no `loading && data.length === 0`" anti-pattern rule; the "no bare `lazy()`" rule).
- Documentation pass: CLAUDE.md / CONTRIBUTING.md updates referencing the migration guides from plans 01–06.

---

## Quick-wins (landable in < 1 day each, independently)

If you need to ship improvement NOW without committing to the full plan, these are the biggest ROI isolated fixes:

1. **Wrap `ensureCurrentClientProfile()` in `withAuthTimeout`** in `init()` and `login()` — [plan 01 item 3](01-auth-session-fixes.md). 30 minutes. Kills the #1 "infinite spinner" cause.
2. **Make `CommissionTrackerPage` lazy** — [plan 05 item 5](05-lazy-suspense-fixes.md). 10 minutes. Consistency + smaller main bundle.
3. **Fix `usePublicBrowseProjects` no-visible-error path** — [plan 04](04-public-customer-pages-fixes.md). 1 hour. Public catalog stops silently failing.
4. **`fetchWithRetryOnTimeout` → retry on any transient error** — [plan 02 item 2](02-cache-store-fixes.md). 2 hours. Broadest impact for lowest risk.
5. **Vercel `index.html` cache-control** — [plan 05 item 3](05-lazy-suspense-fixes.md). 15 minutes. Prevents post-deploy chunk 404 hangs.

Any one of these is an isolated merge, testable in a single page-load cycle.

---

## Cross-cutting new code being introduced

By the end of the plan, you'll have this new lib / component surface:

### `src/lib/`
- `authHelpers.js` — `withAuthTimeout`, `raceAgainstAbort`, `isAuthTimeoutError`, `isTransientAuthLockError` (consolidated from AuthContext)
- `authEventBus.js` — single module-level `onAuthStateChange` fan-out
- `createScopedStore.js` — factory for all data hooks; replaces 8 bespoke scoped hook implementations
- `withAbortableTimeout.js` — real HTTP cancellation
- `retryWithBackoff.js` — exponential backoff + jitter
- `safeSubscribe.js` — realtime channel with status reporting
- `useStoreStatus.js` — unified `{ loading, data, error, canRetry }` reader
- `lazyWithRetry.js` — `lazy()` with hard-refresh fallback
- `useVersionPoller.js` — deploy-version manifest poller

### `src/components/`
- `RenderDataGate.jsx` — `{loading, error, data, empty, children}` uniform rendering
- `ChunkLoadErrorBoundary.jsx` — Suspense + retry + "deploy update" banner
- `VersionBanner.jsx` — "new version available, click to refresh"
- `EmptyState.jsx`, `ErrorPanel.jsx` — uniform feedback surfaces
- `skeletons/` — SkeletonLine, SkeletonCard, SkeletonTable, SkeletonDetail, SkeletonTree, SkeletonKPI

### `src/hooks/`
- `useWatchdog.js` — surfaces a retry button after N seconds of stuck loading

### `src/styles/`
- `skeletons.css` — consolidated shimmer + shapes
- `accessibility.css` — `prefers-reduced-motion` handlers

### Config
- `public/version.json` — `{ build: "<git-sha>" }`, written at build time
- `vite.config.js` — optional `closeBundle` plugin to write version.json; optional `__BUILD_SHA__` define
- `vercel.json` — explicit `Cache-Control` headers for HTML vs assets

### Public contracts (what new feature code must follow)
- **New page with data:** wrap with `<RenderDataGate>`. See plan 03 migration guide.
- **New hook with data:** use `createScopedStore({ key, fetcher, realtimeTables, scope })`. See plan 02 migration guide.
- **New lazy route:** use `lazyWithRetry(() => import(...))`. See plan 05 migration guide.
- **New auth-dependent operation:** use `withAuthTimeout(..., ms, label)` and `await authEventBus.readyPromise`. See plan 01 migration guide.

---

## How to use this folder

### If you're a developer about to start work
1. Read this file (you're here).
2. Read [reserch/00-INDEX.md](../reserch/00-INDEX.md) — 10 minutes — to understand the symptoms.
3. Read the plan file for your first phase (01, 02, or 05).
4. Skim the "Migration guide" section of plans 02, 03, 05 — these define the new code patterns.
5. Start with the first "Plan items" in your chosen plan.

### If you're a tech lead reviewing scope
- Read this file (you're here).
- Read each plan's "Executive summary" and "Acceptance checklist" sections. That's ~15 minutes per plan.
- Use the effort table above for rough sprint-planning.

### If you're a PM / stakeholder
- Read the "Phase 1/2/3/4" section above. That's your release timeline.
- User-visible improvements land in Phase 3. Before that, it's infrastructure invisible to users.
- Phase 1's quick-win #1 and #5 (above) can ship independently in the first week if you want a visible "the infinite spinners are gone" result before the rest.

### If you're writing new features during this plan
- Default to using whichever Phase's infrastructure has landed. Check the file-exists status in `src/lib/` — if `createScopedStore.js` is there, use it; if not, write a minimal local hook using the old pattern but call out in the PR that it's pending migration.
- If in doubt, open the appropriate "Migration guide" section and copy the template.

---

## What this plan deliberately does NOT cover

- **Business logic bugs** — the research is about loading/rendering state. Bugs in commission math, RLS policies, visit-slot allocation etc. are out of scope.
- **Backend / SQL changes** — some symptoms could be mitigated server-side (e.g. `heal_my_client_profile_now` could retry internally), but the plans focus on frontend-only fixes. If a companion backend task surfaces, file it separately.
- **Redesign** — no visual redesign. Same layouts, same flows. Only "this thing sometimes hangs, now it doesn't".
- **Performance optimization beyond the scope of loading** — bundle-size micro-optimizations, render-frame cost, etc. are out of scope unless they directly cause a stuck skeleton.
- **Testing framework introduction** — the acceptance checklists are manual-QA-oriented. Automated test coverage for these paths is a reasonable follow-on project but is not required to close out the plan.

---

## Sanity checks after the plan is complete

Before declaring the work done, run this end-user QA pass. Use throttled Slow 3G in DevTools.

- [ ] Cold load `/` → Browse renders within 8s with projects OR a visible retry button. No indefinite skeleton.
- [ ] Log in as a customer → lands on `/dashboard` with data in <10s, no flash to `/login`, no "Profil introuvable" gate.
- [ ] Log in as an admin → lands on `/admin` with data in <10s, no flash.
- [ ] Navigate rapidly between admin pages (click Projects, Clients, Finance, back-and-forth) → no stuck skeletons.
- [ ] Open the app, keep the tab open overnight, return → data refreshes silently, no stale-cache UI.
- [ ] Deploy a new build with a trivial change → existing open tabs show a "new version available" banner within 5 min. Click → refreshes cleanly.
- [ ] Revoke the session via Supabase dashboard → open tabs detect on next action and redirect to login, no stuck spinner.
- [ ] In dev (StrictMode on) → first-load console is clean of `NavigatorLockAcquireTimeoutError` and orphan-lock warnings.
- [ ] `prefers-reduced-motion: reduce` user → skeletons show no shimmer, just static placeholder shapes.
- [ ] Offline toggle → any page shows a clear "you're offline" state within 8s, not an infinite skeleton.

Pass all 10 → plan is complete.
