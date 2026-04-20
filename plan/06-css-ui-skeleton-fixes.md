## Plan 06 — CSS/UI-Layer Skeleton and Polling Fixes

Companion to [`reserch/06-css-ui-skeleton.md`](../reserch/06-css-ui-skeleton.md). This plan attacks the presentation-layer symptoms of stuck skeleton shimmers. The *root* cause (state flags that never flip to false) is handled in plan 03; this document deals with the CSS, components, accessibility, motion-sensitivity, and three-state rendering (loading/empty/error) that sit *on top of* that fix.

Research concluded that no CSS-level animation bug exists — shimmers are correctly `infinite` and correctly gated by `{loading ? <Skeleton/> : <Data/>}`. The failure mode is a React state flag not flipping. Still, the UI layer has real problems worth fixing in the same pass:

- Skeleton CSS is scattered across ~15 admin files with three parallel naming systems (`sp-sk-*`, `pub-sk-*`, `inv-sk-*`, `ct-skeleton-*`) and one inconsistent duration (1.2s vs 1.3s).
- No shared React component for "render a skeleton of shape X". Every page re-implements the same `<div className="sp-card sp-card--skeleton">…7 children…</div>`.
- No `prefers-reduced-motion` handling.
- `aria-busy` coverage is partial; `role="alert"` usage is ad-hoc.
- Three different "this could be anything" spinners (`AuthLoader`, `Suspense`, `RequireStaff`) all render the same hidden dot.
- No clear visual difference between *loading*, *empty*, and *error* when data fails to come back.

The plan delivers a shared skeleton CSS file, a set of React shape primitives, centralized accessibility helpers, and three semantically distinct loader variants — all plug-compatible with the `RenderDataGate` pattern from plan 03.

---

## Prerequisites

1. **Plan 03 must ship (or at least land its shared components)** — this plan reuses the `RenderDataGate`/`useDataGate` pattern from [`plan/03-admin-pages-loading-fixes.md`](./03-admin-pages-loading-fixes.md) (pending). Specifically, the `<SkeletonLine/>`, `<SkeletonCard/>`, `<SkeletonTable/>`, `<SkeletonDetailPage/>` components appear in both plans: plan 03 *declares* them as the loading branch of the gate, plan 06 *implements* their CSS and file layout. If 03 lands first, item 3.2 below becomes a migration task; if 06 lands first, plan 03 imports these components from `src/components/skeletons/`.
2. **Research read first** — [`reserch/06-css-ui-skeleton.md`](../reserch/06-css-ui-skeleton.md) documents the 12 findings this plan consolidates. No changes to `src/lib/useSupabase.js` promise race conditions happen here — those are in plan 03.
3. **No business-logic edits** — this plan is pure presentation. Files we touch: CSS, components, a handful of JSX wrappers to swap `sp-sk-*` → `<SkeletonLine/>`. No page logic changes.

---

## Plan Items

### 1. Consolidate skeleton CSS into `src/styles/skeletons.css`

Current state, discovered by scanning the tree:

| File | Prefix | Keyframe | Duration |
| ---- | ------ | -------- | -------- |
| [`src/App.css`](../src/App.css) (lines 13–43) | `.pub-sk-*` | `pub-sk-shimmer` | 1.3s |
| [`src/admin/pages/sell-field.css`](../src/admin/pages/sell-field.css) (lines 440–477) | `.sp-sk-*` | `sp-sk-shimmer` | 1.3s |
| [`src/pages/dashboard-page.css`](../src/pages/dashboard-page.css) (lines 267–290) | `.inv-sk-*` | `inv-sk-shimmer` | 1.3s |
| [`src/admin/pages/commission-tracker.css`](../src/admin/pages/commission-tracker.css) (lines 318–333) | `.ct-*skeleton*` | `ct-skeleton-pulse` | 1.2s (pulse not shimmer) |

All three of the shimmer keyframes are literally the same animation — a 200%-wide gradient panned from right to left — but are duplicated three times with different names. The pulse variant in commission-tracker is the odd one out (opacity pulse, 1.2s) and should be unified to the shimmer pattern too for visual consistency. Rename it only if the tracker owner approves; otherwise keep the pulse but centralize the keyframe.

**Action:** create `src/styles/skeletons.css` with the following shape. Import it once from `src/main.jsx` (or the nearest root that already imports global CSS). Remove the duplicated rules from their current files and leave **only** a `/* moved to src/styles/skeletons.css */` comment so grep can find the migration breadcrumb.

```css
/* src/styles/skeletons.css
   Single source of truth for skeleton shapes. All page-level code that used
   to render .sp-sk-*, .pub-sk-*, or .inv-sk-* should now render .sk-* or
   (better) the <Skeleton*> React components from src/components/skeletons/.
   Keyframes live here once. */

/* ── Tokens ─────────────────────────────────────────────────────── */
:root {
  --sk-base-light: #eef2f7;
  --sk-glint-light: #f8fafc;
  --sk-base-dark: rgba(168, 204, 80, 0.06);
  --sk-glint-dark: rgba(168, 204, 80, 0.18);
  --sk-radius: 6px;
  --sk-radius-pill: 999px;
  --sk-duration: 1.5s; /* single global duration — see item 6 */
  --sk-easing: ease-in-out;
}

/* ── Base shimmer ──────────────────────────────────────────────── */
.sk {
  display: block;
  background: linear-gradient(
    90deg,
    var(--sk-base-light) 0%,
    var(--sk-glint-light) 50%,
    var(--sk-base-light) 100%
  );
  background-size: 200% 100%;
  animation: sk-shimmer var(--sk-duration) var(--sk-easing) infinite;
  border-radius: var(--sk-radius);
}

/* Dark-theme / admin variant. Added by the theme root
   (data-theme="admin" sets light tokens; data-theme="dark" keeps these). */
[data-theme="dark"] .sk,
.sk--on-dark {
  background: linear-gradient(
    90deg,
    var(--sk-base-dark) 0%,
    var(--sk-glint-dark) 50%,
    var(--sk-base-dark) 100%
  );
}

/* ── Shapes ────────────────────────────────────────────────────── */
.sk-line         { height: 12px; }
.sk-line--title  { height: 16px; width: 55%; margin: 4px 0 10px; }
.sk-line--sub    { height: 10px; width: 75%; }
.sk-line--badge  { height: 20px; width: 78px; border-radius: var(--sk-radius-pill); }
.sk-line--price  { height: 18px; width: 110px; }
.sk-line--info   { height: 12px; width: 80px; }

.sk-box          { width: 36px; height: 36px; border-radius: 10px; }
.sk-avatar       { width: 40px; height: 40px; border-radius: 50%; }

.sk-num          { display: inline-block; vertical-align: middle; height: 0.9em; width: 36px; border-radius: 5px; }
.sk-num--wide    { width: 64px; }
.sk-num--xl      { width: 96px; height: 1em; }

.sk-button       { height: 36px; width: 120px; border-radius: 8px; }
.sk-map          { width: 100%; aspect-ratio: 16 / 9; border-radius: 12px; }

/* ── Composed containers ───────────────────────────────────────── */
.sk-card {
  padding: 14px;
  background: rgba(22, 41, 23, 0.55);
  border: 1px solid rgba(42, 75, 44, 0.55);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 200px;
}

.sk-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
}

.sk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}

/* ── Keyframes (ONCE) ──────────────────────────────────────────── */
@keyframes sk-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

Then in each of the old files, replace the class definitions with a comment breadcrumb:

```css
/* ──────────────────────────────────────────────────────────
   Skeleton classes (.sp-sk-*, .pub-sk-*, .inv-sk-*) moved to
   src/styles/skeletons.css — use .sk-* or <SkeletonLine/> etc.
   Legacy aliases kept below for pages not yet migrated.
   ────────────────────────────────────────────────────────── */
```

**Temporary alias layer** — keep legacy classes working while pages are migrated. Add to the bottom of `skeletons.css`:

```css
/* Legacy aliases — delete once all pages use .sk-* / <Skeleton*> */
.sp-sk-line, .pub-sk, .inv-sk { /* … same as .sk … */ }
.sp-sk-line--title, .pub-sk--title, .inv-sk--title { /* … same as .sk-line--title … */ }
/* etc. */
```

Rather than duplicate declarations, the aliases can share rules via comma-joined selectors. Shipping aliases first, then migrating per-page, then deleting aliases is the safest path (three separate PRs).

### 2. Skeleton React components in `src/components/skeletons/`

Create one file per shape. Each is a thin, zero-logic wrapper so they tree-shake and so teams can style-swap in the future without touching consumers.

```
src/components/skeletons/
  index.js              (barrel export)
  SkeletonLine.jsx
  SkeletonNum.jsx       (inline replacement for a "0"/"—")
  SkeletonBox.jsx
  SkeletonAvatar.jsx
  SkeletonButton.jsx
  SkeletonCard.jsx      (composed: avatar + 2 lines + badge + price)
  SkeletonRow.jsx       (composed: avatar + line row, for tables)
  SkeletonTable.jsx     (rows × cols, uses SkeletonRow)
  SkeletonDetailPage.jsx (hero + stat strip + three cards — matches ProjectDetailPage shape)
  SkeletonGrid.jsx      (wraps N SkeletonCards in .sk-grid)
```

Sketch for `SkeletonLine.jsx`:

```jsx
// src/components/skeletons/SkeletonLine.jsx
export default function SkeletonLine({ width, height, className = '', style = {}, variant }) {
  const cls = ['sk', 'sk-line', variant && `sk-line--${variant}`, className]
    .filter(Boolean).join(' ')
  const s = { ...style }
  if (width) s.width = typeof width === 'number' ? `${width}px` : width
  if (height) s.height = typeof height === 'number' ? `${height}px` : height
  return <span className={cls} style={s} aria-hidden="true" />
}
```

Sketch for `SkeletonCard.jsx` — replaces the 14-line inline block that appears in eight admin pages:

```jsx
// src/components/skeletons/SkeletonCard.jsx
import SkeletonLine from './SkeletonLine.jsx'
import SkeletonBox from './SkeletonBox.jsx'

export default function SkeletonCard() {
  return (
    <div className="sp-card sp-card--skeleton" aria-hidden="true">
      <div className="sp-card__head">
        <SkeletonBox />
        <div style={{ flex: 1 }}>
          <SkeletonLine variant="title" />
          <SkeletonLine variant="sub" />
        </div>
      </div>
      <div className="sp-card__body">
        <SkeletonLine variant="badge" />
      </div>
      <div className="sp-card__foot">
        <SkeletonLine variant="price" />
        <SkeletonLine variant="info" />
      </div>
    </div>
  )
}
```

`SkeletonTable.jsx`:

```jsx
export default function SkeletonTable({ rows = 8, cols = 5, ariaLabel = 'Chargement du tableau' }) {
  return (
    <table className="sk-table" role="presentation" aria-busy="true" aria-label={ariaLabel}>
      <tbody>
        {Array.from({ length: rows }, (_, r) => (
          <tr key={r} className="sk-table__row">
            {Array.from({ length: cols }, (_, c) => (
              <td key={c}><SkeletonLine /></td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

`index.js` barrel:

```js
export { default as SkeletonLine } from './SkeletonLine.jsx'
export { default as SkeletonNum } from './SkeletonNum.jsx'
export { default as SkeletonBox } from './SkeletonBox.jsx'
export { default as SkeletonAvatar } from './SkeletonAvatar.jsx'
export { default as SkeletonButton } from './SkeletonButton.jsx'
export { default as SkeletonCard } from './SkeletonCard.jsx'
export { default as SkeletonRow } from './SkeletonRow.jsx'
export { default as SkeletonTable } from './SkeletonTable.jsx'
export { default as SkeletonDetailPage } from './SkeletonDetailPage.jsx'
export { default as SkeletonGrid } from './SkeletonGrid.jsx'
```

Usage pattern after migration:

```jsx
import { SkeletonGrid } from '../../components/skeletons/index.js'

{loading ? <SkeletonGrid count={8} /> : <SalesCards data={sales} />}
```

### 3. Verify every skeleton is mounted conditionally

Research finding 6 confirmed all skeletons are properly gated. Verify once more during migration by grepping for:

```
grep -rn "sp-sk-\|sk-line\|sk-card\|Skeleton" src/ | grep -v "//\|/\*"
```

Each hit should either be:
- Inside a `{loading ? … : …}` ternary, **or**
- Inside a `<RenderDataGate loading={…}>` branch (plan 03), **or**
- A pure component definition inside `src/components/skeletons/`.

Any unconditional `<SkeletonCard/>` at the top of a page template is a bug. Add a one-shot CI grep guard if you want belt-and-suspenders:

```bash
# scripts/check-skeleton-conditional.sh
# Fails if a skeleton component is used without a loading/isLoading/showSk nearby
```

Low-priority — the research found zero current offenders.

### 4. `aria-busy` and `aria-live` on loading regions

Partial coverage exists today (see grep in the research appendix). The pattern we want:

| State | Parent attribute | Child content |
| ----- | ---------------- | ------------- |
| loading | `aria-busy="true"` + `aria-live="polite"` | skeletons with `aria-hidden="true"` |
| error | `role="alert"` (implicit `aria-live="assertive"`) | error message + retry button |
| empty | no special attr needed; semantic `<p>` is enough | illustration + CTA |
| success | (nothing) | data |

Bake the pattern into `RenderDataGate` (plan 03) so every page gets it for free. Authoring sketch:

```jsx
// From plan 03 — exposed here for context
export function RenderDataGate({ loading, error, empty, children, skeleton, onRetry }) {
  if (loading) {
    return (
      <div aria-busy="true" aria-live="polite" className="dg dg--loading">
        {skeleton}
      </div>
    )
  }
  if (error) {
    return <ErrorState message={error.message} onRetry={onRetry} />
  }
  if (empty) {
    return <EmptyState />
  }
  return <>{children}</>
}
```

For pages that don't adopt the gate yet, patch their loading branches manually:

```jsx
// before
<div className="sp-cards">
  {loading ? skeletons : cards}
</div>

// after
<div className="sp-cards" aria-busy={loading} aria-live="polite">
  {loading ? skeletons : cards}
</div>
```

Open files found with missing `aria-busy`:
- [`src/admin/pages/SellPage.jsx`](../src/admin/pages/SellPage.jsx) (`.sp-cards` container)
- [`src/admin/pages/CashSalesPage.jsx`](../src/admin/pages/CashSalesPage.jsx)
- [`src/admin/pages/ClientsPage.jsx`](../src/admin/pages/ClientsPage.jsx)
- [`src/admin/pages/CoordinationPage.jsx`](../src/admin/pages/CoordinationPage.jsx)
- [`src/admin/pages/CommissionLedgerPage.jsx`](../src/admin/pages/CommissionLedgerPage.jsx)
- [`src/admin/pages/FinanceDashboardPage.jsx`](../src/admin/pages/FinanceDashboardPage.jsx)
- [`src/admin/pages/NotaryDashboardPage.jsx`](../src/admin/pages/NotaryDashboardPage.jsx)
- [`src/admin/pages/ServiceJuridiquePage.jsx`](../src/admin/pages/ServiceJuridiquePage.jsx)
- [`src/admin/pages/ProjectsPage.jsx`](../src/admin/pages/ProjectsPage.jsx)
- [`src/admin/pages/RecouvrementPage.jsx`](../src/admin/pages/RecouvrementPage.jsx)
- [`src/admin/pages/UserManagementPage.jsx`](../src/admin/pages/UserManagementPage.jsx)
- [`src/admin/pages/AuditLogPage.jsx`](../src/admin/pages/AuditLogPage.jsx)
- [`src/admin/pages/CallCenterPage.jsx`](../src/admin/pages/CallCenterPage.jsx)

A single-line edit per file. Target: all admin list containers and the dashboard `.inv-kpi-strip` already has it.

### 5. `prefers-reduced-motion` handling

One media query in `skeletons.css` kills the shimmer for users who opted out at the OS level. A few spots already respect the query ([`src/admin/admin-v2.css`](../src/admin/admin-v2.css) line 1072) but not the shimmer animations.

```css
/* Add at the END of src/styles/skeletons.css */
@media (prefers-reduced-motion: reduce) {
  .sk,
  .sp-sk-box, .sp-sk-line, .sp-sk-num,
  .pub-sk,
  .inv-sk,
  .ct-kpi-6__skeleton-label,
  .ct-kpi-6__skeleton-value,
  .ct-kpi-6__skeleton-delta,
  .ct-skeleton-bar {
    animation: none !important;
    background: var(--sk-base-light);
  }
  [data-theme="dark"] .sk,
  .sk--on-dark {
    background: var(--sk-base-dark);
  }
}
```

Alongside, create `src/styles/accessibility.css` for broader reduced-motion handling (page transitions, the orb pulse animation, toast slide-in):

```css
/* src/styles/accessibility.css */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  /* Opt-in exception for animations that ARE the feature, not decoration */
  .allow-motion, .allow-motion *  {
    animation-duration: revert !important;
    transition-duration: revert !important;
  }
}

/* Screen-reader-only text helper, referenced by EmptyState/ErrorState */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
```

Import from `src/main.jsx` after global CSS.

### 6. Shimmer duration consistency — pick 1.5s

Current state:

| File | Duration |
| ---- | -------- |
| sell-field.css | 1.3s |
| App.css (pub-sk) | 1.3s |
| dashboard-page.css (inv-sk) | 1.3s |
| commission-tracker.css (ct-skeleton) | **1.2s** (outlier) |

The user's memory note ("feedback_loading_animations.md") references sell-field.css as the canonical source and states the prefered shape is "skeleton+shimmer". The numeric reference in the research is 1.3s but the prompt says "1.5s seems to be the norm". Both are fine; **the point is one value**. Use `--sk-duration: 1.5s` in `skeletons.css` — 1.5s reads as more relaxed on slow networks, which is where the "stuck" perception kicks in.

Commit this as a single-line change (`var(--sk-duration)` in the shared CSS). Remove hardcoded `1.3s` / `1.2s` values from the four legacy files.

### 7. Distinct loading / empty / error visuals

Research finding 4 (plan 04) surfaced that `EmptyState` already exists for public pages as `.pub-sk-card` — but when a fetch returns `[]` the same skeleton grid shows forever, indistinguishable from "still loading". We need three visually distinct presentations. Create two new components:

```jsx
// src/components/EmptyState.jsx
export default function EmptyState({
  title = 'Rien à afficher',
  description = null,
  illustration = '📭',
  cta = null, // { label, onClick }
}) {
  return (
    <div className="empty-state" role="status">
      <div className="empty-state__illustration" aria-hidden="true">{illustration}</div>
      <h3 className="empty-state__title">{title}</h3>
      {description && <p className="empty-state__desc">{description}</p>}
      {cta && (
        <button type="button" className="empty-state__cta" onClick={cta.onClick}>
          {cta.label}
        </button>
      )}
    </div>
  )
}
```

```jsx
// src/components/ErrorState.jsx
export default function ErrorState({
  title = 'Erreur de chargement',
  message = 'Impossible de récupérer les données. Réessayez dans un instant.',
  onRetry = null,
}) {
  return (
    <div className="error-state" role="alert">
      <div className="error-state__icon" aria-hidden="true">⚠</div>
      <h3 className="error-state__title">{title}</h3>
      <p className="error-state__msg">{message}</p>
      {onRetry && (
        <button type="button" className="error-state__retry" onClick={onRetry}>
          Réessayer
        </button>
      )}
    </div>
  )
}
```

Styles (add to `skeletons.css` or a new `states.css` — either is fine, pick one and be consistent):

```css
.empty-state, .error-state {
  padding: 32px 24px;
  text-align: center;
  border-radius: 12px;
  border: 1px dashed transparent;
}
.empty-state {
  background: rgba(148, 163, 184, 0.04);
  border-color: rgba(148, 163, 184, 0.3);
  color: #64748b;
}
.empty-state__illustration { font-size: 40px; margin-bottom: 8px; }
.empty-state__title { margin: 0 0 4px; font-size: 16px; color: #0f172a; }
.empty-state__desc { margin: 0 0 16px; font-size: 13px; }
.empty-state__cta {
  height: 36px; padding: 0 16px; border-radius: 8px;
  background: #164e63; color: #fff; border: 0; font-weight: 600; cursor: pointer;
}

.error-state {
  background: rgba(254, 226, 226, 0.4);
  border-color: rgba(239, 68, 68, 0.4);
  color: #991b1b;
}
.error-state__icon { font-size: 32px; color: #dc2626; margin-bottom: 4px; }
.error-state__title { margin: 0 0 4px; font-size: 16px; color: #7f1d1d; }
.error-state__msg { margin: 0 0 16px; font-size: 13px; }
.error-state__retry {
  height: 36px; padding: 0 16px; border-radius: 8px;
  background: #dc2626; color: #fff; border: 0; font-weight: 600; cursor: pointer;
}
```

**Key rule:** loading, empty, and error must never overlap visually.
- Skeleton: shimmer gradient, no text, `aria-hidden` children.
- Empty: static soft-gray card with illustration + CTA.
- Error: red-tinted card, alert role, retry button.

This lives behind `RenderDataGate` once plan 03 ships. Until then, consumers import the three components and compose them manually.

### 8. `public/theme-init.js` audit

Re-read [`public/theme-init.js`](../public/theme-init.js) — 22 lines, wrapped in `try/catch` with a swallow. No network calls, no async. Worst case: the try block throws, we silently keep whatever `data-theme` the browser had (likely nothing, which means CSS falls back to its light defaults). This matches research finding 5: "Theme initialization runs before React mounts and is wrapped in try-catch with swallow. Unlikely to block skeletons, but confirms theme setup is defensive and non-blocking."

**Recommendation:** leave it alone. Optionally add an explicit fallback:

```js
// public/theme-init.js — optional hardening
(function () {
  try {
    var p = location.pathname || '';
    var theme = 'dark';
    if (p.indexOf('/admin') === 0) theme = 'admin';
    else if (p === '/login' || p === '/register' || p === '/forgot-password' || p === '/reset-password') theme = 'auth';
    document.documentElement.setAttribute('data-theme', theme);
    var color = theme === 'admin' ? '#f8fafc' : '#071009';
    var meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    document.head.appendChild(meta);
  } catch (e) {
    // Explicit fallback: if ANY of the above throws, force dark theme so the
    // CSS cascade has a predictable starting point. The existing swallow is
    // fine, but a data-theme="dark" is safer than no attribute at all.
    try { document.documentElement.setAttribute('data-theme', 'dark'); } catch (_) {}
  }
})();
```

The change is one-liner safe — it can ship independently of this plan. Flag only if you observe a flash-of-unstyled-content in production. Research says unlikely.

### 9. `NotificationToaster` / `NotificationsMenu` polling audit

Research finding 4 identified the potential starvation: two realtime channels (toaster + bell) both listening to `INSERT` on `user_notifications`, plus the `useNotifications` hook's realtime + `refresh()` cascade. On large accounts this **can** compete for the 100-channel-per-connection Supabase soft-limit and **can** slow other data fetches on the same connection.

**Current wiring** (from [`src/components/NotificationsMenu.jsx`](../src/components/NotificationsMenu.jsx) line 66 and [`src/lib/notifications.js`](../src/lib/notifications.js) lines 252–315):
- `NotificationsMenu` → `useNotifications` → opens channel `notif:${userId}:${scope||'all'}:${instanceId}` listening to `*` events on `user_notifications`.
- `NotificationToaster` → opens channel `toast:${userId}:${instanceId}` listening to `INSERT` on `user_notifications`.
- Both run in parallel for every authenticated user.

**Observations:**
- Each opens ONE channel per mount, and both use `useId()` to prevent collision on dev remount — correct.
- The toaster filters `INSERT` at the server; the menu filters `*` at the server. Both are user-scoped. Server load is fine.
- The bell's handler calls `refreshRef.current()` on every event → one fresh `SELECT * FROM user_notifications WHERE user_id = X LIMIT 40` per notification. For a user who receives a burst of 20 notifications in 2 seconds, that's 20 fetches. Fine today; brittle if notification volume grows.

**Recommendations** (none are blockers — document as "known soft rate limits"):

1. **Coalesce bell refreshes.** In `useNotifications`, debounce `refresh()` to at most once per 500ms:

```js
// src/lib/notifications.js — inside useNotifications
const refreshTimerRef = useRef(null)
function scheduleRefresh() {
  if (refreshTimerRef.current) return
  refreshTimerRef.current = window.setTimeout(() => {
    refreshTimerRef.current = null
    refreshRef.current()
  }, 500)
}
// inside the channel handler:
() => scheduleRefresh(),
```

2. **Document the rate-limit semantics** in [`src/lib/notifications.js`](../src/lib/notifications.js) header comment:

```
// Polling/realtime rate limits:
//   • Channel budget: 2 per authenticated user (1 bell + 1 toaster). Kept
//     <100 total per Supabase connection so other realtime subscribers
//     (e.g. future live-sale channels) still have room.
//   • Refresh debounce: 500ms. A burst of N notifications within a 500ms
//     window triggers a single refresh, not N.
//   • Toaster dedup window: 6s TTL + FIFO Set of 64 seen IDs.
//   • Reconnect catch-up: filtered by firstSeenCeilingRef to skip the
//     backfill burst Supabase delivers on WS reconnect (see FE2-H3).
```

3. **Do NOT** merge the two channels — the separation makes the toaster's FE2-H3 skip-batch logic clean. Merging saves one channel but forces the toaster to share a fetcher with the bell, which couples unrelated lifecycles.

4. **Test the `useNow(60_000)` re-render cost** on a user with 200 notifications. If layout thrashing is visible (research finding 7), virtualize the list — but that's plan 04 territory, not this one.

### 10. Three distinct global loader variants

Today every "loading…" branch renders the same empty `<div className="app-loader-spinner"/>` — which has `display: none` in CSS (see [`src/App.css`](../src/App.css) line 9). The visual is: a blank white page. That blankness is intentional (per the comment block on lines 1–3) but it **conflates three semantically different waits**:

- **Auth check** → `RequireStaff` / `RequireCustomerAuth` waiting for session hydration.
- **Chunk loading** → React `Suspense` fallback waiting for a lazy import to fetch.
- **Data loading** → per-page data fetch (skeletons handle this).

Proposal: split into three components. Loose coupling — no abstract base class, just three sibling files.

**`src/components/loaders/AuthLoader.jsx`** — shown during auth-context hydration. Currently a white page. Should be a minimal centered brand element so the user knows something *is* happening without a spinner war with whatever lands next.

```jsx
export default function AuthLoader() {
  return (
    <div className="auth-loader" aria-busy="true" aria-live="polite">
      <span className="sr-only">Vérification de la session…</span>
      <div className="auth-loader__brand">Zitouna Garden</div>
    </div>
  )
}
```

```css
.auth-loader {
  min-height: 100vh;
  display: grid; place-items: center;
  background: var(--screen-bg, #071009);
  color: rgba(215, 229, 216, 0.7);
}
.auth-loader__brand { font-size: 18px; letter-spacing: 0.1em; opacity: 0.7; }
```

**`src/components/loaders/ChunkLoader.jsx`** — shown as the `<Suspense>` fallback for route-level lazy imports. Subtle top-of-page progress bar, NOT a full-screen spinner — users have already seen the chrome (TopBar, sidebar), so the illusion of continuity matters.

```jsx
export default function ChunkLoader() {
  return (
    <>
      <div className="chunk-loader" role="progressbar" aria-busy="true" aria-label="Chargement de la page…">
        <div className="chunk-loader__bar" />
      </div>
      <div className="app-loader" aria-hidden="true" />
    </>
  )
}
```

```css
.chunk-loader {
  position: fixed; top: 0; left: 0; right: 0; height: 3px;
  background: rgba(22, 163, 74, 0.1); overflow: hidden;
  z-index: 9999;
}
.chunk-loader__bar {
  position: absolute; top: 0; left: -30%; width: 30%; height: 100%;
  background: linear-gradient(90deg, transparent 0%, #16a34a 50%, transparent 100%);
  animation: chunk-bar-slide 1.2s ease-in-out infinite;
}
@keyframes chunk-bar-slide {
  0%   { left: -30%; }
  100% { left: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .chunk-loader__bar { animation: none; left: 0; width: 100%; opacity: 0.5; }
}
```

**`DataLoader`** is simply a renamed "use `<SkeletonCard/>` or `<SkeletonTable/>`" — not a separate component. Callers pick the shape that matches their layout.

**Wiring:**

```jsx
// src/App.jsx — change from this:
<Suspense fallback={<div className="app-loader"><div className="app-loader-spinner" /></div>}>

// to this:
import ChunkLoader from './components/loaders/ChunkLoader.jsx'
<Suspense fallback={<ChunkLoader />}>
```

```jsx
// src/components/RequireCustomerAuth.jsx (and RequireStaff, AdminLayout)
// from:
<div className="app-loader" style={{ minHeight: '50vh' }}>
  <div className="app-loader-spinner" />
</div>
// to:
<AuthLoader />
```

After migration, delete `.app-loader-spinner` from [`src/App.css`](../src/App.css) (it's `display: none` anyway) and `.app-loader` if no consumers remain.

---

## New Infrastructure

Files to create — all additive, no source changes needed to land them on their own:

| Path | Purpose |
| ---- | ------- |
| `src/styles/skeletons.css` | Single source of truth for `.sk-*` classes + shimmer keyframe |
| `src/styles/accessibility.css` | `prefers-reduced-motion`, `.sr-only` helper |
| `src/components/skeletons/SkeletonLine.jsx` | line shape (title, sub, badge, price, info variants) |
| `src/components/skeletons/SkeletonNum.jsx` | inline number/text shimmer |
| `src/components/skeletons/SkeletonBox.jsx` | square/icon shape |
| `src/components/skeletons/SkeletonAvatar.jsx` | circular avatar shape |
| `src/components/skeletons/SkeletonButton.jsx` | rectangular button shape |
| `src/components/skeletons/SkeletonCard.jsx` | composed card (for list views) |
| `src/components/skeletons/SkeletonRow.jsx` | composed table row |
| `src/components/skeletons/SkeletonTable.jsx` | `rows × cols` grid of SkeletonRow |
| `src/components/skeletons/SkeletonDetailPage.jsx` | hero + stat strip + three cards composite |
| `src/components/skeletons/SkeletonGrid.jsx` | N cards in `.sk-grid` |
| `src/components/skeletons/index.js` | barrel export |
| `src/components/EmptyState.jsx` | illustration + optional CTA (`role="status"`) |
| `src/components/ErrorState.jsx` | red icon + retry (`role="alert"`) |
| `src/components/loaders/AuthLoader.jsx` | auth-hydration wait |
| `src/components/loaders/ChunkLoader.jsx` | Suspense fallback (top progress bar) |

Files to modify (in the migration phase, not the creation phase):

| Path | Change |
| ---- | ------ |
| [`src/App.css`](../src/App.css) | delete `.pub-sk-*` definitions (keep legacy alias in skeletons.css); delete `.app-loader-spinner` after migration |
| [`src/admin/pages/sell-field.css`](../src/admin/pages/sell-field.css) | delete `.sp-sk-*` definitions |
| [`src/pages/dashboard-page.css`](../src/pages/dashboard-page.css) | delete `.inv-sk-*` definitions |
| [`src/admin/pages/commission-tracker.css`](../src/admin/pages/commission-tracker.css) | decide: keep `ct-skeleton-pulse` as-is or migrate to `.sk` |
| [`src/main.jsx`](../src/main.jsx) | `import './styles/skeletons.css'; import './styles/accessibility.css'` |
| [`src/App.jsx`](../src/App.jsx) | swap `Suspense` fallback → `<ChunkLoader/>` |
| [`src/components/RequireStaff.jsx`](../src/components/RequireStaff.jsx) | swap `<div className="app-loader">…</div>` → `<AuthLoader/>` |
| [`src/components/RequireCustomerAuth.jsx`](../src/components/RequireCustomerAuth.jsx) | same swap |
| [`src/admin/AdminLayout.jsx`](../src/admin/AdminLayout.jsx) | same swap |
| [`src/pages/LoginPage.jsx`](../src/pages/LoginPage.jsx) | swap `.app-loader-spinner` → `<AuthLoader/>` |
| [`src/pages/ResetPasswordPage.jsx`](../src/pages/ResetPasswordPage.jsx) | same swap |
| [`src/pages/PurchaseMandatPage.jsx`](../src/pages/PurchaseMandatPage.jsx) | same swap |
| [`src/pages/InstallmentsPage.jsx`](../src/pages/InstallmentsPage.jsx) | re-evaluate: likely `<DataLoader/>` = skeleton |
| [`src/lib/notifications.js`](../src/lib/notifications.js) | add 500ms debounce on `refresh`; add rate-limit doc comment |

All JSX swaps in the admin pages (13 files listed in item 4) for `aria-busy` — one attribute per file.

---

## Migration Guide (for future pages)

When building a new section that can be loading / empty / error / success:

1. **Import the gate** (once plan 03 ships):

```jsx
import { RenderDataGate } from '../components/RenderDataGate.jsx'
import { SkeletonGrid } from '../components/skeletons/index.js'
```

2. **Wrap the render branch:**

```jsx
function MyNewPage() {
  const { data, loading, error, refresh } = useMyData()

  return (
    <section>
      <h1>Nouveau module</h1>
      <RenderDataGate
        loading={loading}
        error={error}
        empty={!loading && !error && data.length === 0}
        skeleton={<SkeletonGrid count={6} />}
        onRetry={refresh}
      >
        <div className="sp-cards">
          {data.map((item) => <MyCard key={item.id} item={item} />)}
        </div>
      </RenderDataGate>
    </section>
  )
}
```

3. **Pick your skeleton shape from [`src/components/skeletons/`](../src/components/skeletons/):**
   - List of cards → `<SkeletonGrid count={N} />`
   - Table → `<SkeletonTable rows={N} cols={M} />`
   - Detail page (hero + strip + body) → `<SkeletonDetailPage />`
   - A single stat number inline with text → `<SkeletonNum width={64} />`
   - Custom shape → compose `<SkeletonLine/>` + `<SkeletonBox/>` manually in a new `Skeleton<Whatever>.jsx` and add to the barrel export.

4. **Customize the empty state with context**:

```jsx
<RenderDataGate
  …
  emptyState={
    <EmptyState
      illustration="🌱"
      title="Aucune parcelle vendue"
      description="Les ventes confirmées apparaîtront ici."
      cta={{ label: 'Créer une vente', onClick: () => navigate('/admin/sell') }}
    />
  }
>
```

5. **Do NOT write new shimmer CSS.** Reuse `src/styles/skeletons.css`. If you need a new shape, add a new `.sk-*` class there, not in a page file.

6. **Keep the three states visually distinct** — checklist in the next section.

---

## Visual Consistency Checklist (30-minute designer audit)

Walk through each page with a slow-3G throttle enabled:

- [ ] Does the loading skeleton **resemble** the final content (same roughly-sized boxes)?
- [ ] Does the shimmer animation run at **1.5s** (or whatever the single source of truth is set to)?
- [ ] When data is empty (e.g. brand-new account with no sales), does the page show an **illustration + CTA**, NOT a shimmer?
- [ ] When the fetch fails (simulate by blocking the Supabase URL in devtools), does the page show a **red card with a retry button**?
- [ ] Do the three states (loading / empty / error) look **visually different** — no two could be confused for each other?
- [ ] Does `prefers-reduced-motion: reduce` kill the shimmer? (devtools → Rendering → Emulate CSS media feature)
- [ ] Does the page have `aria-busy="true"` on the parent container while loading? (inspect element)
- [ ] Does the error card have `role="alert"` so screen readers announce it? (inspect element)
- [ ] Are the auth loader, chunk loader, and data loader **visually distinct**? (Simulate each: clear session, throttle chunks, throttle data)
- [ ] Does the toaster stack show ≤ 3 toasts and each dismiss after ~6s?
- [ ] Does the bell badge update within 500ms of a new notification? (run a DB trigger)

Any "No" answer is a ticket.

---

## Out of Scope

- Business-logic pages (SellPage order flow, installment entry) — only their loading/empty/error skins.
- Authentication (session races, token refresh) — plan 01.
- Cache / store / data-fetching hooks — plan 02 and 03.
- Lazy/Suspense/bundling optimizations beyond the ChunkLoader swap — plan 05.
- Deploy / infrastructure — unchanged.
- Migrating `ct-skeleton-pulse` from opacity pulse to gradient shimmer — optional polish, not a bug.
- Refactoring `useSupabase.js` to fix the promise race condition that causes the actual stuck-skeleton symptom — that is plan 03 item 4. **This plan cannot fix the stuck state by itself.**

---

## Acceptance Checklist

Before merging this plan's PR(s):

- [ ] `src/styles/skeletons.css` exists and is imported from `main.jsx`.
- [ ] `src/styles/accessibility.css` exists and is imported from `main.jsx`.
- [ ] `src/components/skeletons/` contains the 10 shape components + barrel.
- [ ] `src/components/EmptyState.jsx` and `src/components/ErrorState.jsx` exist.
- [ ] `src/components/loaders/AuthLoader.jsx` and `ChunkLoader.jsx` exist.
- [ ] Exactly **one** `@keyframes sk-shimmer` definition in the entire repo (grep `@keyframes.*shimmer` should return one match, plus the legacy-alias note if still present).
- [ ] Exactly **one** `--sk-duration` variable, with value `1.5s` (or the agreed single value).
- [ ] Legacy classes `.sp-sk-*`, `.pub-sk*`, `.inv-sk*` still resolve (aliases) — all admin pages still render during migration.
- [ ] Every `aria-busy` candidate in the 13-file list has the attribute on its loading container.
- [ ] `prefers-reduced-motion: reduce` kills shimmer — verify in devtools.
- [ ] `Suspense` fallback in [`src/App.jsx`](../src/App.jsx) uses `<ChunkLoader/>`.
- [ ] `RequireStaff` / `RequireCustomerAuth` / `AdminLayout` use `<AuthLoader/>`.
- [ ] Data pages still use skeletons (no change — just the shared components).
- [ ] `useNotifications` has a 500ms debounce on `refresh` and a header comment documenting the rate-limit semantics.
- [ ] `theme-init.js` reviewed — no changes, or the optional hardening in item 8 applied.
- [ ] Visual consistency checklist (previous section) passes.
- [ ] No regression in auto-refresh cadence of the bell badge.
- [ ] Lint + typecheck clean (`eslint`, no new warnings in skeleton files).
- [ ] Design review: a designer walks through 5 pages on slow-3G and confirms the three states are distinguishable.
