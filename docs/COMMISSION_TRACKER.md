# Commission Tracker

Technical reference for the `/admin/commissions` page.

## 1. Purpose

The Commission Tracker gives administrators a single surface to visualize the referral tree and the commission flow that rides on top of it. It renders the entire parrain/filleul forest as an interactive graph, surfaces KPIs for pending and paid payouts, and lets an admin drill down from any node into the per-client event history so they can audit why a given beneficiary received a given amount on a given sale.

## 2. Data model

- `clients` — one row per participant (seller, parrain, buyer).
- `seller_relations(child_client_id, parent_client_id)` — canonical upline, enforced one-to-one on `child_client_id`.
- `clients.referred_by_client_id` — legacy mirror column; values have been backfilled into `seller_relations` and the column is kept read-only for safety.
- `commission_events(beneficiary_client_id, level, amount, sale_id, status)` — payout rows attached to a sale; `status` transitions `pending -> accrued -> paid -> void`.

## 3. Commission flow

1. A sale is created and the row is stamped with a `commission_rule_snapshot` copied from `project_commission_rules` at creation time.
2. When the notary finalizes the sale, `notary_completed_at` is written and the `trg_sales_notary_commissions` trigger fires.
3. The trigger calls `compute_and_insert_commissions_for_sale`, which walks the upline via `seller_relations`, with `clients.referred_by_client_id` used as a temporary fallback for any row that has not been migrated yet.
4. One row is inserted per ancestor into `commission_events`, carrying `beneficiary_client_id` plus the computed `level` (1 = direct seller, 2 = parrain of the seller, 3 = grand-parrain, and so on).

### Parrainage automatique

When a sale is created, the trigger `zitouna_sales_auto_parrainage` auto-inserts `seller_relations(child=buyer, parent=seller)` if the buyer has no parrain yet (Option B — first sale wins; subsequent sales never re-parent an existing child). In the same pass, it also sets `clients.referred_by_client_id = seller` for new buyers so the legacy mirror column stays aligned. Historical sales created before this trigger existed are backfilled via `backfill_parrainage_from_sales()`, which runs once per `03_functions.sql` apply and skips any child already bound. For projects that never had commission rules configured, default rules (L1 = 60, L2 = 20, L3 = 10) are seeded by `seed_default_commission_rules()` so every sale can resolve a non-zero `commission_rule_snapshot` at creation time.

## 4. Page components

- `src/admin/pages/CommissionTrackerPage.jsx` — page shell, KPI strip, filters, and event list.
- `src/admin/components/CommissionNodeGraph.jsx` — SVG forest renderer with two modes: `global` and `byClient`.
- `src/admin/components/CommissionEventDetailModal.jsx` — drill-down modal for a single event.
- `src/admin/lib/referralTree.js` — pure helpers for building and traversing the tree.
- `src/admin/lib/useCommissionTracker.js` — data hook that batches the Supabase queries.

## 5. Known limitations

- Tree traversal capped at depth 40 (cycle-safe guard).
- No realtime subscription; reload the page to see fresh data.
- `get_my_referral_summary` now splits L1 and L2 counts separately (added in the `03_functions.sql` backfill).
