# Deep Bug and Logic Audit

Date: 2026-04-09  
Scope: `src/` runtime behavior, auth/guards, admin flows, data layer migration quality, and DB-only compliance.

---

## Executive Summary

The codebase is currently in a **hybrid migration state**:

- Part of the app uses new Supabase hooks (`useSupabase.js` + `db.js`)
- Many pages still use legacy sync loaders (`loadProjects`, `loadOffersByProject`, `loadInstallments`, `loadClients`, `loadAdminUsers`)
- Several legacy compatibility shims were added to keep runtime alive, but they introduce stale data and logic drift

Result: app can run, but there are still high-probability redirect issues, stale state bugs, role gating inconsistencies, and data write-path mismatches.

---

## Critical Problems (P0)

### 1) Guard inconsistency can still block admin sub-routes
- `RequireAdmin` allows when `isAdmin || adminRole`
- `RequireRole` still requires strict `isAdmin` before checking role
- If `adminRole` is present from metadata fallback but `isAdmin` is false (timing/resolve edge), `/admin/profile` may work while role routes can still fail.
- Files:
  - `src/lib/guards.jsx`

### 2) Legacy pages rely on sync cache loaders (possible empty/stale data after refresh)
- Multiple pages still do `useMemo(() => loadX(), [])` or `useState(() => loadX())`.
- `loadX()` now frequently returns in-memory cache, not live DB query.
- If preload misses or races, these pages render incorrect empty state or wrong logic decisions.
- Files:
  - `src/admin/pages/ProjectsPage.jsx`
  - `src/admin/pages/ParcelsPage.jsx`
  - `src/admin/pages/HealthPage.jsx`
  - `src/admin/pages/OffersPage.jsx`
  - `src/admin/pages/OperationsDashboardPage.jsx`
  - `src/admin/pages/SalesManagerDashboardPage.jsx`
  - `src/admin/pages/SalesAgentAppPage.jsx`
  - `src/admin/pages/ClientProfilePage.jsx`

### 3) Deprecated/no-op save APIs are still called in active flows
- `saveProjects`, `saveOffersByProject`, `saveInstallments` are deprecated wrappers (not guaranteed persistence behavior).
- Active pages still call them as if they were authoritative writes.
- Files:
  - `src/projectsStore.js`
  - `src/offersStore.js`
  - `src/installmentsStore.js`
  - plus usage in `ProjectDetailPage`, `ProjectsPage`, `OffersPage`, `SalesAgentAppPage`

### 4) Commission logic has stubbed functions in production paths
- `clearPendingCommissionsForSale`, `ensureAgentMilestoneBonus`, `ensureManagerTeamBonus` are stubs.
- Notary/sales approval flows may skip expected commission/business outcomes.
- Files:
  - `src/admin/stores/commissionStore.js`
  - called from `src/admin/pages/NotaryDashboardPage.jsx`

---

## High Severity Problems (P1)

### 5) `fetchInstallments()` still uses embedded joins (ambiguity risk)
- `fetchSales` ambiguity was fixed by manual mapping.
- `fetchInstallments` still embeds:
  - `client:clients(...)`
  - `project:projects(...)`
- If multiple FK paths exist or schema changes, same ambiguity error can reappear.
- File:
  - `src/lib/db.js`

### 6) Login redirect logic no longer branch-checks admin immediately
- Login now always routes to `/browse`; admin navigation depends on auth/guard resolution later.
- Not strictly wrong, but contributes to “I am admin but landed in browse” perception.
- File:
  - `src/pages/LoginPage.jsx`

### 7) TopBar notification dismissal is now session-memory only
- local persistence removed (good for DB-only requirement), but user dismissals reset on refresh.
- Potential UX regression unless replaced with server/user preference storage.
- File:
  - `src/TopBar.jsx`

### 8) `SalesAgentAppPage` mixed architecture remains
- Partially migrated to `useSales`, but still uses legacy loaders for projects/offers/users/clients/installments.
- Can produce inconsistent snapshots in same render.
- File:
  - `src/admin/pages/SalesAgentAppPage.jsx`

### 9) AuthContext still reads client + verification from sync caches
- `findClientByCin`, `findClientByEmail`, verification request lookup use `loadClients()` and `loadVerificationRequests()`.
- These are cache-backed and may be stale/missing, causing wrong `clientProfile`/verification decisions.
- File:
  - `src/lib/AuthContext.jsx`

---

## Medium Severity Problems (P2)

### 10) Compatibility layer hides migration incompleteness
- Backward-compat exports (e.g. deprecated saves, no-op repair methods) keep app booting but mask real migration gaps.
- This increases risk of “works visually, not persisted correctly.”
- Files:
  - `src/installmentsStore.js`
  - `src/projectsStore.js`
  - `src/offersStore.js`
  - `src/healthReportsStore.js`

### 11) In-memory replacements in finance/operations stores are non-persistent
- localStorage removed, but these stores are now process-memory only.
- Data resets on refresh; may be unexpected for admin workflows.
- Files:
  - `src/admin/stores/financeStore.js`
  - `src/admin/stores/operationsStore.js`

### 12) `SalesManagerDashboardPage` targets persistence removed
- Targets currently no-op persistence.
- Users can edit target UI values but they reset with navigation/reload.
- File:
  - `src/admin/pages/SalesManagerDashboardPage.jsx`

### 13) Route-role matrix may be too restrictive for intended behavior
- Some routes only allow narrow roles (`legal`, `finance`, etc.); users expecting broader admin access may be blocked unless role mapping exactly matches.
- File:
  - `src/App.jsx`

### 14) Potential app_metadata/user_metadata role normalization drift
- Role parser maps many cases, but unexpected values still possible.
- Requires strict role governance in auth metadata.
- File:
  - `src/lib/AuthContext.jsx`

---

## Low Severity Problems (P3)

### 15) Duplicate path representations in scans (`src/...` and `src\...`)
- Tooling output shows both separators; usually same file on Windows, but makes audits noisy and can hide true duplicates if they ever appear.

### 16) Legacy domain alias still present
- `zitounaBusinessModel.js` marked deprecated in favor of `zitounatBusinessModel.js`.
- Minor maintainability issue.
- File:
  - `src/domain/zitounaBusinessModel.js`

### 17) Error surfacing mostly console-based
- `useEntity` logs fetch errors but UI often just appears empty without clear reason.
- Better global error boundary/reporting is needed.
- File:
  - `src/lib/useSupabase.js`

---

## Detailed Area Breakdown

### A) Auth and Access Control

Observed risks:
- Split trust source (DB admin row + auth metadata role + cache-based profile data)
- Guard asymmetry (`RequireAdmin` vs `RequireRole`)
- Potential timing race during session restore and admin resolve

Primary impacted files:
- `src/lib/AuthContext.jsx`
- `src/lib/guards.jsx`
- `src/App.jsx`

---

### B) Data Layer / Stores

Observed risks:
- Legacy sync store API shape still heavily used
- Multiple compatibility wrappers are cache-backed without guaranteed freshness
- Deprecated mutators still called by pages

Primary impacted files:
- `src/projectsStore.js`
- `src/offersStore.js`
- `src/installmentsStore.js`
- `src/healthReportsStore.js`
- `src/admin/stores/*.js` (several)

---

### C) Admin Pages

Observed risks:
- Many admin pages still not fully hook-migrated
- Business actions may call mixed APIs in one action path
- Commission side-effects partially stubbed

Primary impacted files:
- `src/admin/pages/ProjectDetailPage.jsx`
- `src/admin/pages/ProjectsPage.jsx`
- `src/admin/pages/OffersPage.jsx`
- `src/admin/pages/SalesAgentAppPage.jsx`
- `src/admin/pages/SalesManagerDashboardPage.jsx`

---

### D) User Pages

Observed risks:
- Recently migrated pages improved, but some flows still depend on compatibility data shape
- Notification and profile side effects rely on non-persistent memory fallback

Primary impacted files:
- `src/pages/ProjectPage.jsx`
- `src/pages/PlotPage.jsx`
- `src/pages/PurchaseMandatPage.jsx`
- `src/TopBar.jsx`

---

## Migration Completeness Scorecard

- DB layer (`db.js`): **Mostly present**
- Hooks layer (`useSupabase.js`): **Present**
- Store rewrite: **Partial + compatibility**
- Admin pages migration: **Partial**
- User pages migration: **Partial**
- LocalStorage removal: **Mostly removed in `src/`**, but replaced in places by volatile memory stores (non-persistent)

---

## What “fully fixed” should mean

A truly complete state requires:

1. Remove remaining sync `loadX()` dependencies from active pages  
2. Remove deprecated `saveX()` calls from live flows  
3. Make all writes go through explicit async DB mutations  
4. Align `RequireAdmin` and `RequireRole` logic consistently  
5. Replace stubs in commission logic with real DB-backed logic  
6. Add visible UI error states for failed DB fetches  
7. Decide and implement persistence for admin ops/finance/targets data in DB tables (not memory)

---

## Final Note

This report intentionally lists **all currently visible architectural and logic risks** from static analysis and recent runtime failures.  
It does not apply fixes; it is a deep inventory to drive full stabilization work.

