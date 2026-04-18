# Commissions Page Redesign Brief (Agent 1 of 5)

Target: `src/admin/pages/CommissionTrackerPage.jsx` (`/admin/commissions`). Page-level rewrite only.

## 1. Current state summary

- Single scroll: hero, 5 KPIs, pill switcher (Global / Par client), node graph, filters (byClient only), events card list. No tabs, no deep linking.
- Page-local `<style>` duplicates ~160 lines that belong in `commission-tracker.css`; `zitu-page__*`, `adm-btn`, `ds-back-btn` mix with ad-hoc inline styles.
- Filters miss date range, project, multi-status, URL sync; search is dead in global mode.
- Unused data: `sales[].project_id` / `agreed_price` never aggregated; `DownlinePerformanceTable.jsx` exists but unimported; upline chain only in the event modal.
- UX gaps: modal blocks the page; no sort, pagination, export, refresh indicator; no cross-link to `/admin/commissions/analytics` or `/admin/commissions/anomalies`.

## 2. Redesign principles

- Admin reaches any event in <= 3 clicks: overview -> beneficiary/project -> side panel.
- Tab, filters, sort, selection serialise to URL params so views are shareable and back-restorable.
- All TND amounts go through one `fmtMoney()` helper (`fr-FR` locale + `TND`); no hand-rolled concatenation.
- Dates render relative ("il y a 3 j") with absolute ISO in `title` tooltip via `fmtRelativeDate()`.
- Empty states name the next action; errors stay non-blocking.

## 3. New layout (top -> bottom)

Root stays `<div className="zitu-page" dir="ltr"><div className="zitu-page__column">`.

1. **Header** `.ct-header`: left `.ds-back-btn`; center `<h1>Suivi des commissions</h1>` + subtitle; right `.ct-header__actions` = "Actualiser" (`refresh()`) + "Autres vues" dropdown linking `/admin/commissions/analytics`, `/admin/commissions/anomalies`, `/admin/commission-ledger` + primary "Exporter" (client-side CSV of visible events).
2. **Quick filters** `.ct-filters`: preset pills `.ct-chip` (7j / 30j / 90j / annee / tout, default 30j); project `<select className="zitu-page__select">` (de-duped `sales[].project_id`); status multi `.ct-multi` (pending / payable / paid / cancelled); level multi (1 / 2 / 3+); `.zitu-page__search` "Nom, code, vente...".
3. **KPI strip** `.ct-kpi-6` (6 / 3 / 2 cols): Evenements, Direct L1 TND, Indirect L2+ TND, Montant du, Paye, Beneficiaires uniques. Each tile: label, value, delta vs previous equivalent range.
4. **Trend** `.ct-trend`: 72 px SVG sparkline of daily totals, hover tooltip (date + amount). Pure SVG.
5. **Tabbed body** `.ct-tabs` (URL `?tab=`):
   - **A "Vue d'ensemble"** — `.ct-overview` two columns: `.ct-top-people` Top 10 beneficiaires (Nom, Code, L1, L2+, Total, Evenements; row click -> Tab D) + `.ct-top-projects` Top 5 projets (Projet, Evenements, Volume, % total).
   - **B "Arbre parrainage"** — existing `<CommissionNodeGraph>` inside `.ct-graph-box` (keep 480 / 360 px heights). Toolbar: Global / Focus switch; selected client as `.ct-selected-chip` with clear.
   - **C "Evenements"** — sortable `<table className="ct-events-table">` (Date, Beneficiaire, Vente, Projet, Niveau, Montant, Statut, Actions). Row / action click opens the side panel. Headers toggle asc/desc and write URL `?sort=date:desc`.
   - **D "Filleuls d'un client"** — `.zitu-page__search` picks a client, then `<DownlinePerformanceTable rootClientId=... data=... onNodeClick=... />` plus compact upline breadcrumb `L0 > L1 > L2...` from `resolveUplineChain`.
6. **Side panel** `.ct-panel` (~380 px slide-in) for event detail. Reuse `CommissionEventDetailModal` section renderers inside; fall back to centered modal on <640 px.
7. **Footer** `.ct-footer`: events-tab pagination (page size 50, Prec / Suiv, range label).

## 4. Interaction improvements

- Sortable columns in Tab C with URL-synced arrows.
- Row hover (Tabs A + C) shows preview tooltip (beneficiary total + last event date).
- Event detail opens in the side panel; "Ouvrir en plein" promotes to the modal.
- Sale code has a copy-to-clipboard button (`aria-label="Copier le code vente"`).
- Clicking a beneficiary name anywhere -> Tab C with `?beneficiary=<id>` preset.
- Internal `useUrlState(['tab','range','project','status','level','q','sort','page','beneficiary'])` hook syncs all state (no router rework).

## 5. New data / computations

- **Daily series** for sparkline: group `commissionEvents` by local-date of `created_at`.
- **Top N beneficiaries**: group by `beneficiary_client_id`, sum by level, top 10 by total desc.
- **Top N projects**: event -> `sale_id` -> `sales.project_id` -> `projects.title`, sum, top 5 (if `projects` missing from payload, use `sale.project_id` as label fallback).
- **Unique beneficiaries**: `new Set(events.map(e => e.beneficiary_client_id)).size`.
- **Per-beneficiary quick counts**: downline size (BFS on `buildChildrenMap`) + upline depth (`resolveUplineChain`). Reuse helpers verbatim.

## 6. Integration touchpoints

- Nav `/admin/commissions` already exists; untouched.
- Header dropdown `<Link>`s to `/admin/commissions/analytics`, `/admin/commissions/anomalies`, `/admin/commission-ledger`.
- Reuse `CommissionEventDetailModal`, `CommissionNodeGraph`, `DownlinePerformanceTable`. **NOTE:** `CommissionOverrideModal` is named in the relay prompt but does not exist today. Do not invent it; add a disabled "Ajuster" button (`title="Bientot"`) in Tab C actions as a hook point.

## 7. Files Agent 2 will touch

- `src/admin/pages/CommissionTrackerPage.jsx` — full rewrite per this brief.
- `src/admin/pages/commission-tracker.css` — add `.ct-header`, `.ct-filters`, `.ct-chip`, `.ct-kpi-6`, `.ct-trend`, `.ct-tabs`, `.ct-overview`, `.ct-top-people`, `.ct-top-projects`, `.ct-events-table`, `.ct-panel`, `.ct-footer`. Delete the inlined `<style>` block.
- Optional `src/admin/components/CommissionSparkline.jsx` (<80 lines, pure SVG). No other new files.
- Zero DB / route / nav / shared-CSS edits.

## 8. Anti-scope (do NOT)

- No SQL, views, RPCs, columns; reuse `db.fetchCommissionTrackerData()` as-is.
- No new routes or nav entries. Cross-links are plain `<Link>`.
- Do not edit `useCommissionTracker.js`, `referralTree.js`, `DownlinePerformanceTable.jsx`, `CommissionNodeGraph.jsx`, `CommissionEventDetailModal.jsx`, `zitouna-admin-page.css`, or sibling pages.
- No chart / date / table libraries. Pure React + SVG.
- Do not rename, inline, or duplicate existing components — import and compose.
- Do not invent `CommissionOverrideModal`; leave the disabled placeholder.

## Open questions

- Paginate events client-side (<= ~5 k rows) or add a server limit in `useCommissionTracker` later?
- CSV blob client-side enough, or must export route through an audited endpoint?
- Is `CommissionOverrideModal` in scope this wave, or is the placeholder final?
- Tab D: plain breadcrumb upline, or expandable per-level earnings breakdown?
- Default date range: 30 j (current) or all-time?
