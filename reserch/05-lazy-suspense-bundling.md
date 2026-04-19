# Lazy Loading, Suspense & Chunk Loading Investigation

## Overview

Users report pages get stuck on skeleton/loading animations until Ctrl+F5. This indicates Suspense boundaries hang during dynamic module imports due to stale chunk references after deploy, network failures without retry, or bundling issues. Hard refresh clears browser cache and fetches fresh chunk manifests.

---

## 18 Key Findings

### 1. CRITICAL: No Retry Logic on Lazy Import Failures
**File: src/App.jsx:1-46**
All lazy routes lack .catch() handlers. Failed imports (404, timeout, network) cause Suspense to display spinner forever with no retry, backoff, or error message. Ctrl+F5 clears cache, loads new manifest with correct chunk hashes.

### 2. CRITICAL: Suspense Fallback Has No Timeout, Error Boundary, or Retry Button
**File: src/App.jsx:67**
Bare spinner with no timeout, error state, or retry. Auth guards (RequireCustomerAuth, RequireStaff) show distinct error panels with retry buttons, but Suspense never transitions to error state even when chunks fail.

### 3. CRITICAL: Stale Chunk Hashes After Deploy — No Manifest Update Detection
**File: dist/index.html:14, vercel.json:1-2**
Vite generates content-hashed chunk names. Deploy v2 changes names; users with v1 tabs still have cached index.html referencing old hashes. Navigating triggers 404s, Suspense hangs. Ctrl+F5 redownloads index.html with new hashes.

### 4. HIGH: Vercel Cache-Control Headers Missing
**File: vercel.json:3-18**
No explicit Cache-Control headers. Default Vercel caches index.html aggressively. Old HTML persists with deleted chunk references. Ctrl+F5 bypasses cache, fetches fresh HTML.

### 5. MEDIUM: CommissionTrackerPage Imported Eagerly (Only One!)
**File: src/App.jsx:45 vs lines 22-44**
Unique: CommissionTrackerPage eagerly bundled in main chunk; all 22+ other admin pages lazy. Adds 10-20 KB to main bundle, loads even if never accessed, entire app fails if CommissionTrackerPage has syntax error.

### 6. HIGH: AppErrorBoundary Soft Refresh Doesn't Solve Stale Chunks
**File: src/components/AppErrorBoundary.jsx:10-40**
Shows generic error + reload button. Button calls window.location.reload() (soft F5), may reload with same stale manifest → 404 → error loop. Only Ctrl+F5 breaks loop.

### 7. HIGH: No Automatic Chunk Health Check or Stale Manifest Detection
**File: src/main.jsx, src/App.jsx**
No code detects stale index.html, polls version manifest, pre-validates chunks, or auto-triggers hard refresh on failures. User must manually Ctrl+F5.

### 8. LOW: ScrollToTopOnRouteChange Error Handling
**File: src/App.jsx:52-60**
window.scrollTo throws in sandboxed contexts only. Low-impact edge case.

### 9. MEDIUM: React 19.2.4 Strict Mode Double-Mount Race Conditions
**File: src/main.jsx:8-16, src/lib/AuthContext.jsx:400-461**
StrictMode double-mounts effects in dev. AuthContext init() defensive but can cause brief state inconsistency.

### 10. MEDIUM: Identical Spinners Across Auth and Suspense
**File: src/components/RequireCustomerAuth.jsx:16-22, RequireStaff.jsx:83-89**
Same .app-loader-spinner for auth wait, chunk load, and chunk failure. Users can't distinguish; error states differ visually but loading states don't.

### 11. MEDIUM: No Cache-Busting Query Params
**File: dist/index.html:14-26**
Module preload links use absolute paths without ?v=xyz. No way to force fresh fetch if CDN caches incorrectly.

### 12. MEDIUM: No Service Worker or Offline Strategy
**File: (none present)**
No offline fallback, no background retry, no granular cache policy. Offline chunk loads hang indefinitely; Ctrl+F5 with restored connection might load if cached.

### 13. LOW: No Resource Hints for Preload Chunks
**File: dist/index.html:15-23**
No importance="high" hints. Chunks deprioritized by browser heuristics.

### 14. MEDIUM: Manifest Drift — Stale modulepreload Paths
**File: dist/index.html:15-23**
Hardcoded modulepreload links may reference non-existent chunks (partial deploy, build cache). Preload fails silently → later import() fails → Suspense hangs.

### 15. LOW: No Manual Chunk Boundaries in Vite Config
**File: vite.config.js (no build.rollupOptions)**
Automatic chunk splitting can produce different hashes between builds with no code changes (non-deterministic).

### 16. MEDIUM: No Boundary Between Auth Guards and Suspense
**File: src/App.jsx:64-122**
Suspense outside guards. Auth spinner and Suspense fallback separate. If both active, whichever renders last shown (both identical), prolonging wait.

### 17. MEDIUM: No Timeout on Supabase Auth Calls
**File: src/lib/AuthContext.jsx:103-108, 400-461**
withAuthTimeout() exists but unused consistently. init() getSession() and revalidateNow() getUser() have no timeout. Stalled Supabase calls hang auth context.

### 18. HIGH: Index.html Cached 60 Seconds by Default
**File: vercel.json (missing Cache-Control), dist/index.html**
Vercel caches ~60 sec. Deploy v2 at second 45, user navigates at second 65 → fresh index.html but JS engine retains stale v1 chunk references. Ctrl+F5 discards cached HTML immediately.

---

## Root Cause: Chicken-and-Egg Caching/Hashing Problem

1. **Stale Chunk Hashes** (Finding #3): Vite assumes unique filenames per build. Old index.html → old hashes → 404 on new deploy.
2. **No Retry** (Finding #1): lazy() without .catch() fails silently, Suspense hangs.
3. **Cache Misconfiguration** (Findings #4, #18): No Cache-Control on index.html → old manifests persist.
4. **Identical Spinners** (Finding #10): Users can't tell auth wait from stuck chunk.
5. **No Detection** (Finding #7): App can't detect stale manifests or auto-recover.

**Ctrl+F5 works: bypasses all caches, refetches entire manifest with correct chunk hashes for current deploy.**
