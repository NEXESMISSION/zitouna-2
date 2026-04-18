# Zitouna Admin — Design System V2 (ZADM)

Source of truth for the 9 page-redesign agents. Pair this doc with `src/admin/admin-v2.css`. Do not deviate.

## Design goals
- Airy: generous 16/24 px spacing, no cramped 8–10 px forms. Breathing room over density.
- Consistent: one spacing scale, one type scale, one set of pills/buttons/cards — zero per-page reinvention.
- Data-first: KPIs, tables, filters lead. Decoration (gradients, hero cards) is banned unless the page agent is told explicitly.
- Fast-scannable: clear hierarchy (head / body), sticky toolbars, zebra tables, strong empty states.
- Professional: Stripe / Linear feel. Subtle shadows, thin 1 px borders, crisp focus rings, motion under 250 ms.

## Visual language

### Palette (light-only for now)
| Token | Hex | Use |
|---|---|---|
| `--zadm-primary` | `#2563eb` | CTA buttons, active tabs, focus ring |
| `--zadm-primary-600` | `#1d4ed8` | Hover of primary |
| `--zadm-primary-50` | `#eff6ff` | Primary tint backgrounds |
| `--zadm-accent` | `#0ea5e9` | Info accents (links inside cards) |
| `--zadm-bg` | `#f8fafc` | Page background |
| `--zadm-surface` | `#ffffff` | Cards, modals, drawers |
| `--zadm-surface-2` | `#f1f5f9` | Inset / muted fills |
| `--zadm-border` | `#e2e8f0` | 1 px borders |
| `--zadm-border-strong` | `#cbd5e1` | Dividers in tables |
| `--zadm-text` | `#0f172a` | Body text |
| `--zadm-text-dim` | `#475569` | Secondary |
| `--zadm-text-muted` | `#94a3b8` | Tertiary / placeholders |
| `--zadm-success` | `#059669` | Paid, active |
| `--zadm-warn` | `#d97706` | Pending, attention |
| `--zadm-danger` | `#dc2626` | Errors, destructive |

### Type scale
12 / 13 / 14 / 16 / 20 / 24 px. 14 px is default body. 20 px for page titles, 24 px for hero KPI values. Weights: 400 body, 500 UI label, 600 emphasis, 700 headings. Line-height 1.45.

### Spacing scale (`--zadm-space-*`)
`4 / 8 / 12 / 16 / 24 / 32 / 48`. Use multiples — never 6, 10, 14, 20.

### Radii
`--zadm-r-sm: 6px` chips, pills. `--zadm-r: 10px` cards, inputs. `--zadm-r-lg: 14px` modals.

### Shadow tokens
- `--zadm-shadow-xs` 0 1px 2px rgba(15,23,42,.04)
- `--zadm-shadow-sm` 0 2px 6px rgba(15,23,42,.06)
- `--zadm-shadow-md` 0 10px 24px rgba(15,23,42,.08)

## Layout primitives (`.zadm-*`)
- `.zadm-page` / `.zadm-page__head` (title + subtitle + action slot, 16 px bottom margin) / `.zadm-page__body` (stack of 24 px gap sections).
- `.zadm-kpi-grid` auto-fit min 220 px — holds `.zadm-kpi` cards with `.zadm-kpi__value` (24 px, 700) + `.zadm-kpi__label` (12 px muted uppercase) + optional `.zadm-kpi__delta` (`--up/--down`).
- `.zadm-card` 1 px border + 10 px radius + 16 px padding. `.zadm-card__head` row with title and actions. `.zadm-card__body` 16 px top padding.
- `.zadm-filters` wrap row, `.zadm-filter` label+input pair, `.zadm-chip` (toggle-able) with `--active` modifier.
- `.zadm-btn` base + modifiers `--primary / --secondary / --ghost / --danger / --subtle`, sizes `--sm / --md / --lg`. Min-height 32/36/44.
- `.zadm-tabs` row of `.zadm-tab`, active gets underline + primary color.
- `.zadm-table` with `.zadm-th` (12 px uppercase), `.zadm-tr` (hover tint), `.zadm-td` (14 px). Zebra on even rows.
- `.zadm-pill` with tones `neutral / info / success / warn / danger`.
- `.zadm-empty` dashed 2 px border, centered icon + title + hint. `.zadm-skeleton` shimmer block. `.zadm-loading` spinner container.
- `.zadm-drawer` right-side slide panel, width default 480 px, slides in from right with 160 ms ease-out. Overlay is `rgba(15,23,42,.45)` with 6 px backdrop blur.
- `.zadm-toolbar` sticky top-0 inside `.zadm-card`, white, 1 px bottom border.

## Component rules
- **Modal** (`.zadm-modal`): centered, max-width set via prop, radius 14, shadow-md. Escape closes. Backdrop click closes. Scroll-locks body. Fade 160 ms.
- **Drawer** (`.zadm-drawer`): right-anchored, full height, slide 200 ms with `cubic-bezier(0.2,0.8,0.2,1)`. Header sticky, body scrolls.
- **Toast** (unchanged behavior): top-right stack, 240 ms slide-in. One toast per action.

## Motion
- `--zadm-t-fast: 120ms`, `--zadm-t-base: 160ms`, `--zadm-t-slow: 240ms`
- Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` for enter; `ease-in` for exit.
- Hover on clickables: border-color shift + 1 px translateY, under 150 ms. Never animate layout.

## Migration map (old → new)
| Old | New |
|---|---|
| `.adm-shell` | Keep outer, plus add `.zadm-shell` |
| `.zitu-page` | `.zadm-page` |
| `.zitu-page__column` | `.zadm-page__body` |
| `.zitu-page__header` | `.zadm-page__head` |
| `.zitu-page__btn` / `.adm-btn` | `.zadm-btn` (+ variants) |
| `.zitu-page__section` / `.adm-card` | `.zadm-card` |
| `.zitu-page__stats` | `.zadm-kpi-grid` + `.zadm-kpi` |
| `.zitu-page__tab(s)` | `.zadm-tabs` + `.zadm-tab` |
| `.zitu-page__badge` / `.cli-pill` | `.zadm-pill--<tone>` |
| `.zitu-page__empty` / `.ds-empty` | `.zadm-empty` |
| `.adm-modal` / `.adm-drawer` | `.zadm-modal` / `.zadm-drawer` |

## Rule for page agents
Use `.zadm-*` classes. Keep behavior identical. Reuse existing hooks (`useSales`, `useClients`, etc.). Remove page-local `<style>` blocks where the system covers them. Do not introduce new colors, radii, or shadows outside the tokens above. If a page needs a one-off, propose it in the PR body — don't inline `style={}` with raw hex.
