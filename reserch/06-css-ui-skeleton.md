# Skeleton/Loading Animation Investigation

**Research Period:** Hard-refresh (Ctrl+F5) clears stuck skeleton shimmer animations on multiple pages  
**Scope:** CSS animations, skeleton rendering, conditional logic, polling, theme initialization  
**Date Completed:** Investigation Phase

## Executive Summary

Pages exhibit stuck skeleton animations until a hard-refresh clears the browser cache and resets component state. The shimmer animations (.sp-sk-shimmer, .inv-sk-shimmer, .pub-sk-shimmer) use `animation: ... infinite` and are correctly placed inside conditional loading branches. The root cause appears to be premature or stalled data-loading state transitions where React loading flags never flip to false.

---

## Findings

### 1. **Skeleton CSS Animations Have Infinite Loop with No Fallback Disable**
**Severity: MEDIUM**  
**File: src/App.css:40**

All skeleton animations use `animation: {name} 1.3s ease-in-out infinite;`. If the loading state that controls their render condition never flips to false, the shimmer runs indefinitely. Hard refresh clears component state and re-triggers fresh data fetches, allowing the loading flag to reset to false.

---

### 2. **Multiple Data-Fetching Hooks with Potentially Stalled Loading Flags**
**Severity: HIGH**  
**File: src/lib/useSupabase.js:502-908**

Pages call multiple hooks (useSalesScoped, useInstallmentsScoped, useProjectsScoped, useAmbassadorReferralSummary). Each sets `loading = true` on mount, then `false` on completion. If async fetches hang or timeout without proper completion, `setLoading(false)` never fires. Hard refresh clears in-memory state and forces fresh network requests, completing the fetch cycle.

---

### 3. **Promise Race Condition in Async Data Hooks**
**Severity: HIGH**  
**File: src/lib/useSupabase.js:527-844**

Hooks use a `cancelled` flag to prevent setState on unmounted components:
```javascript
useEffect(() => {
  let cancelled = false
  refresh().then(() => {
    if (!cancelled) setLoading(false)
  })
  return () => { cancelled = true }
}, [refresh])
```

If component remounts quickly (navigation), old promises can resolve after new mounts, leaving cancelled flags stale. The dependency array on `refresh` changes when internal dependencies shift, tearing down and re-subscribing to data channels mid-flight.

---

### 4. **NotificationsMenu Realtime Subscription Heavy Polling Can Starve Data Fetches**
**Severity: MEDIUM**  
**File: src/components/NotificationsMenu.jsx:67-68, src/lib/notifications.js:296-315**

NotificationsMenu (rendered on every page in TopBar) opens a Supabase realtime channel with `useNotifications`. On every notification change, it calls `refresh()` to re-fetch the list. Combined with NotificationToaster (also listening to realtime), the tab has two realtime subscriptions competing for connection quota. Heavy backend notification traffic can starve other data hooks.

---

### 5. **theme-init.js Synchronous Bootstrap Safe but Ineffective on Stuck Skeletons**
**Severity: LOW**  
**File: public/theme-init.js:7-22**

Theme initialization runs before React mounts and is wrapped in try-catch with swallow. Unlikely to block skeletons, but confirms theme setup is defensive and non-blocking.

---

### 6. **Skeleton Markup Is Correctly Conditional**
**Severity: LOW** (not a bug—confirms good practice)  
**File: src/admin/pages/SellPage.jsx:1263, src/pages/DashboardPage.jsx:681**

Skeletons are correctly inside `{salesLoading && salesForList.length === 0 ? <Skeleton /> : <Data />}` conditionals. Persistence indicates loading state never flips to false, not that skeletons are unconditionally rendered.

---

### 7. **useNow Hook Forces Full Re-renders Every 60 Seconds**
**Severity: MEDIUM** (not stuck skeletons, but UI polish)  
**File: src/components/NotificationsMenu.jsx:75, src/lib/safeStorage.js**

NotificationsMenu uses `useNow(60_000)` to force minute-based re-renders for relative timestamps. Correct implementation, but causes full notification list re-render every 60 seconds. With large notification counts, this can cause layout thrashing.

---

### 8. **Skeleton Animation Duration Consistent (1.3s), But Perceived as Stuck on Slow Networks**
**Severity: LOW**  
**File: src/App.css:40, src/pages/dashboard-page.css:276, src/admin/pages/sell-field.css:445**

All skeletons animate at 1.3s with infinite loop. If API responses take >5 seconds, the user sees 3-4 shimmer loops before data lands. This is expected behavior, not a bug, but may be reported as "stuck."

---

### 9. **Multiple NotificationsMenu Instances use useId() to Prevent Channel Collision**
**Severity: MEDIUM** (theoretical, not observed)  
**File: src/components/NotificationsMenu.jsx:62, src/lib/notifications.js:256-262**

The `useNotifications` hook uses `useId()` to generate unique channel names per instance, preventing collision if two mounts occur. This is correct per React 18 best practices, but adds complexity. useId() is stable per mount, so should be reliable.

---

### 10. **CSS Transitions on Cards Can Create Staggered Fade-Out Illusion**
**Severity: MEDIUM** (UX perception, not animation bug)  
**File: src/admin/pages/sell-field.css:344**

Cards have `transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;`. When skeletons unmount and real data appears, the transitions animate style changes. Staggered load times create a visual "still loading" feel even though data is present.

---

### 11. **No aria-busy on Parent Container During Loading**
**Severity: LOW** (accessibility gap)  
**File: src/admin/pages/SellPage.jsx:1263**

Skeleton cards have `aria-hidden="true"` (correct), but the parent `.sp-cards` container lacks `aria-busy="true"` during loading. Assistive technologies don't know content is loading.

---

### 12. **No Stalled setInterval or setTimeout in CSS**
**Severity: VERY LOW** (non-issue—CSS cannot stall timers)  

CSS animations are browser-controlled and cannot stall independently. All animation timing delegates to the animation frame loop.

---

## Root Cause Summary

Primary cause: A `loading` state flag (salesLoading, referralLoading, ledgerLoading) is set to true but never flips to false due to:
- Network timeout or abort without proper completion handler
- Promise race condition with stale cancelled flag from previous mount
- Realtime subscription competing for connection resources
- Backend latency or error response not triggering `loading = false`

Hard refresh works because it:
- Clears all in-memory state (loading flags reset)
- Invalidates cache, forcing fresh network requests
- Closes stale realtime channels
- Re-triggers useEffect hooks with fresh dependency tracking

---

## Files Reviewed

- public/theme-init.js
- src/App.css (full)
- src/index.css (full)
- src/pages/dashboard-page.css (full)
- src/admin/admin-v2.css (partial)
- src/admin/pages/sell-field.css (full)
- src/admin/pages/finance-dashboard.css (partial)
- src/App.jsx
- src/components/NotificationToaster.jsx (full)
- src/components/NotificationsMenu.jsx (full)
- src/lib/notifications.js (full)
- src/lib/useSupabase.js (key sections)
- src/pages/DashboardPage.jsx (partial)
- src/admin/pages/SellPage.jsx (partial)
- src/TopBar.jsx (full)

---

## Conclusion

Skeleton animations are correctly implemented as CSS infinite loops mounted conditionally. The "stuck skeleton" symptom is caused by React state flags not transitioning, likely due to stalled network promises or realtime subscription congestion. Hard refresh fixes it by clearing state and re-triggering fresh network requests.

**No CSS-level skeleton animation bugs found.** The issue is at the data-fetching orchestration level.
