# Admin Pages Loading State Audit

## Executive Summary

This audit investigated why admin pages get stuck on skeleton/loading animations until hard refresh.

**Key Findings:**
- 11 active pages identified with loading state issues (14 pages are empty stubs)
- Pattern 1: Early returns before async hooks complete
- Pattern 2: AND-combined loading flags that confuse empty data with still-loading
- Pattern 3: Hooks with conditional early-returns that skip subscriptions
- Pattern 4: Multiple async dependencies where one timeout blocks entire page

---

## Pages with Issues

### AdminProfilePage.jsx - MEDIUM

File:236-238: Multiple loading flags combined in AND pattern
- `const showSalesSkeleton = salesLoading && (sales || []).length === 0`
- If sales hook loads but data is empty, skeleton shows permanently
- Why hard refresh fixes: Clears hook cache, forces loading→false transition
- Reproduction: Super admin with zero sales

### ClientProfilePage.jsx - HIGH

File:140-164: Early return before hooks complete
- Page returns null if !client before useClients() hook resolves
- Stale subscription; hook tries to update unmounted component
- Why hard refresh fixes: Forces re-subscription to useClients()
- Reproduction: Navigate to /admin/clients/nonexistent-id

### AuditLogPage.jsx - MEDIUM

File:176: Skeleton visibility gate with data-empty trap
- `const showSkeletons = loading && list.length === 0`
- If hook loads with zero events, skeleton persists indefinitely
- Why hard refresh fixes: Forces subscription and loading transition
- Reproduction: Workspace with zero audit events

### CallCenterPage.jsx - MEDIUM

File:136: Skeleton depends on project loading status
- `const showSkeletons = projectsLoading && calls.length === 0`
- If useProjects() times out, projectsLoading stays true forever
- Why hard refresh fixes: New subscription attempt to useProjects()
- Reproduction: Slow projects endpoint

### CashSalesPage.jsx - MEDIUM

File:87: Double-loading gate with empty-data trap
- `const showSkeletons = salesLoading && cashSales.length === 0`
- If useSales() times out, salesLoading stays true
- Why hard refresh fixes: Forces new hook subscription
- Reproduction: Supabase RLS denies query

### ClientsPage.jsx - MEDIUM

File:92: Loading gate depends on hook that may not transition
- `const showSkeletons = clientsLoading && (clients || []).length === 0`
- If useClients() times out, loading state stays true
- Why hard refresh fixes: Clears hook cache
- Reproduction: Network flaky; first fetch hangs

### CommissionLedgerPage.jsx - HIGH

File:64-71: Complex multi-hook loading with no skeleton fallback
- useCommissionLedger() aggregates multiple queries
- If one internal query stalls, overall loading stays true
- Why hard refresh fixes: Forces retry of all internal queries
- Reproduction: /admin/commission-ledger with hanging commission events fetch

### CommissionTrackerPage.jsx - MEDIUM

File:33: Single hook with no error/loading fallback
- `const { data, error, refresh } = useCommissionTracker()`
- If fetch hangs, page shows blank (no skeleton, no error)
- Why hard refresh fixes: New hook subscription
- Reproduction: /admin/commissions shows blank page

### CommissionAnalyticsPage.jsx - MEDIUM

File:41: Same pattern as CommissionTrackerPage
- `const { data, loading, error, refresh } = useCommissionTracker()`
- Blank page if hook stalls
- Why hard refresh fixes: New hook subscription
- Reproduction: /admin/commissions/analytics blank

### CommissionAnomaliesPage.jsx - HIGH

File:138-162: Manual async RPC without timeout
- RPC call to detect_parrainage_anomalies() with no timeout
- If Supabase down, promise hangs forever; finally never fires
- Why hard refresh fixes: New component instance
- Reproduction: Supabase connection down; RPC hangs

### ProjectDetailPage.jsx - MEDIUM

File:56-57: Undefined project with conditional hook subscription
- useProjectWorkflow(project?.id || '') receives empty string if project undefined
- Hook may skip subscription
- Why hard refresh fixes: Forces hooks to reset
- Reproduction: /admin/projects/nonexistent-uuid

### ProjectsPage.jsx - MEDIUM

File:44: Hook with no loading fallback
- If useProjects() fails, page doesn't render list
- Why hard refresh fixes: New hook subscription
- Reproduction: Slow projects endpoint

### SellPage.jsx - MEDIUM

File:1-11: Multiple cascading hook dependencies
- 6 independent hooks: useProjects, useClients, useOffers, useSales, useAdminUsers, useMySellerParcelAssignments
- 6-step wizard; if one hook times out, wizard cannot progress
- Why hard refresh fixes: Forces all hooks to retry
- Reproduction: Advance through wizard; network hangs on step 2

### RecouvrementPage.jsx - MEDIUM

File:52-54: Three independent loading flags
- useInstallments(), useSales(), useClients() all independent
- If any times out, complex conditional logic at lines 84-94 cannot compute missingPlanSales
- Why hard refresh fixes: New subscriptions
- Reproduction: Installments endpoint down

### UserManagementPage.jsx - MEDIUM

File:47-50: Multiple hooks with single shared loading flag
- Page has staff/clients tabs but single loading flag from useAdminUsers
- Clicking clients tab before staff loads shows wrong loading state
- Why hard refresh fixes: Resets hooks
- Reproduction: Load page, click clients tab before staff loads

---

## AdminLayout.jsx - GLOBAL GATE - HIGH

File:37-43: Root gate blocking all admin pages
- `if (loading || !ready) return <app-loader>`
- If loading from useAuth() never transitions to false, entire admin UI blocked
- Why hard refresh fixes: Forces auth context re-initialization
- Reproduction: Auth state stuck during token refresh

---

## Cross-Cutting Patterns

Pattern A: AND-Combined Checks (8 pages)
- loading && data.length === 0 confuses empty data with still-loading
- AdminProfilePage, AuditLogPage, CallCenterPage, CashSalesPage, ClientsPage, ProjectsPage, UserManagementPage

Pattern B: Conditional Subscriptions (4 pages)
- Hooks skip subscription if parameters missing
- ClientProfilePage, ProjectDetailPage, CoordinationPage, SellPage

Pattern C: Multi-Hook Deadlock (5 pages)
- One hook timing out blocks entire page
- AdminProfilePage, CommissionLedgerPage, CommissionTrackerPage, RecouvrementPage, UserManagementPage

Pattern D: Timeout Without Fallback (3 pages)
- Promise hangs forever; finally never fires
- CommissionAnomaliesPage, CommissionTrackerPage, CommissionAnalyticsPage

---

## Why Hard Refresh Fixes It

Ctrl+F5 forces:
1. Module-scope hook caches to reset (useSupabase.js createCachedStore)
2. New Supabase subscriptions
3. Auth context re-initialization (AdminLayout gate re-evaluates)
4. Components re-mount; at least one loading→false transition occurs
5. Stale subscriptions are abandoned; new ones start fresh
