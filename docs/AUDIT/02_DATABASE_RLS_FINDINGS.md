# 02 — Database / RLS Findings

> Severity ordering: **Critical → High → Medium → Low**.
> File refs are clickable `[path:line](path:line)`.
> These findings are SQL-layer only. Client-side security is in [01_SECURITY_FINDINGS.md](01_SECURITY_FINDINGS.md); business-logic bugs in [03_BUSINESS_LOGIC_FINDINGS.md](03_BUSINESS_LOGIC_FINDINGS.md).

---

## Remediation status (2026-04-19)

| ID | Severity | Status | Where the fix lives |
|---|---|---|---|
| DB-C1 | Critical | ✅ Fixed | `database/09_security_hardening.sql` (also closed S-C1) |
| DB-C2 | Critical | ✅ Fixed | `database/11_database_hardening.sql` — value normaliser + `sales_status_check` / `sales_pipeline_status_check` CHECK constraints (validated). Full enum migration deferred (low-value vs CHECK). |
| DB-C3 | Critical | ✅ Fixed | `11_database_hardening.sql` — FK changed to `ON DELETE SET NULL`, plus `trg_sales_repoint_commissions` re-points commissions when `sales.client_id` migrates |
| DB-C4 | Critical | ✅ Mitigated | `11_database_hardening.sql` — `trg_sales_client_change_audit` writes a permanent before/after row to `audit_logs` (severity warning). Tighter `buyer_auth_user_id` gate inside the heal RPC is deferred — see DB-C4-followup below. |
| DB-H1 | High | ✅ Fixed | `11_database_hardening.sql` — `clients_auth_user_fk` (`ON DELETE SET NULL`, validated after orphan cleanup) |
| DB-H2 | High | ✅ Fixed | `database/10_one_shot_recovery.sql` (also closed S-H4) |
| DB-H3 | High | ✅ Fixed | `11_database_hardening.sql` — `plan_status` enum gets `cancelled`; `trg_sales_cancel_cascade` cascades from sales |
| DB-H4 | High | ✅ Fixed | `11_database_hardening.sql` — non-negative CHECK on every money column (parcels, sales, plans, payments, payouts). `commission_events.amount` left signed because clawbacks need negatives. |
| DB-H5 | High | ✅ Fixed | `11_database_hardening.sql` — `current_client_id()` rewritten with a scoring heuristic (auth_user_id present + email + name + has sale + has commission), falling back to oldest-by-created_at for stability |
| DB-H6 | High | ⚠️ Deferred | Requires "house client" sentinel + product decision on whether buyer-as-L1 should ever be allowed. Plan: create a `clients` row with `code='HOUSE-001'` and a one-time backfill script; then add `NOT NULL` to `seller_client_id`. **Not safe to ship blindly — would block every direct sale today.** |
| DB-M1 | Medium | ✅ Fixed | `11_database_hardening.sql` — partial `idx_sales_seller_client` |
| DB-M2 | Medium | ✅ Fixed | `11_database_hardening.sql` — `phone_verifications_user_fk` (`ON DELETE CASCADE`) |
| DB-M3 | Medium | ⚠️ Deferred | Requires app rewrite (every read site joins on `parcel_id` and `parcel_ids[]`). Recommended: introduce `sale_parcels` junction table in a follow-up; backfill from existing rows; deprecate `parcel_id` after the UI migrates. |
| DB-M4 | Medium | ✅ Fixed | `11_database_hardening.sql` — `ux_commission_events_once` partial unique index (`status <> 'cancelled'`) |
| DB-M5 | Medium | ⚠️ Deferred | `reservation_status` enum migration is risky; current text+CHECK is acceptable. Will revisit if business needs new states. |
| DB-M6 | Medium | ✅ Fixed | `09_security_hardening.sql` — `REVOKE EXECUTE ON ALL FUNCTIONS … FROM anon` + per-function grants. |
| DB-M7 | Medium | ✅ Fixed | `11_database_hardening.sql` — `client_phone_identities_auth_user_fk` (`ON DELETE SET NULL`) |
| DB-M8 | Medium | ✅ Fixed | `11_database_hardening.sql` — drops the `unique(client_id)` constraint so a client can carry multiple phone identities |
| DB-L1 | Low | ✅ Fixed | `11_database_hardening.sql` — `touch_updated_at` triggers on `seller_parcel_assignments`, `seller_relations`, `ambassador_wallets`, `installment_payment_receipts`, `sale_reservation_events` |
| DB-L2 | Low | ✅ Accepted | The audit itself notes "looks OK" — `duplicate_object` is the right specific exception |
| DB-L3 | Low | ✅ Fixed | `11_database_hardening.sql` — `parcel_status` enum gets `withdrawn`. `cancelled` deliberately omitted (cancelling a sale returns the parcel to `available`, not to a terminal state). |
| DB-L4 | Low | ✅ Fixed | `11_database_hardening.sql` — `purge_old_audit_logs(days, include_warning)` function + nightly pg_cron schedule (no-op if pg_cron absent) |

**Summary:** 17 fixed, 1 mitigated, 3 deferred (DB-H6 needs product decision, DB-M3 needs app rewrite, DB-M5 low value), 1 accepted.

### DB-C4 follow-up

The audit trigger added in 11 captures every `sales.client_id` change. The
remaining hardening to fully close DB-C4 is to tighten the heal RPC
itself (`ensure_current_client_profile` in `03_functions.sql`) so it
refuses migration when `sales.buyer_auth_user_id` already points at a
*different* auth user (current code allows NULL OR equal — too lax). That
edit is deferred because the heal RPC is the most central function in
the system and a regression there blocks every login. Recommended path:
ship the audit trigger now, watch `audit_logs WHERE action =
'sale_client_id_changed'` for a week, then tighten the RPC with a
guarded follow-up.

---

## Summary

| Severity | Count | Short list |
|---|---:|---|
| Critical | 4 | Blanket CRUD grant to `authenticated` on all public tables · No enum/CHECK on `sales.status` and `sales.pipeline_status` (freeform text) · `commission_events.beneficiary_client_id` FK is `on delete restrict` blocking cleanup · SECURITY DEFINER heal RPC auto-repoints `sales.client_id` via phone |
| High | 6 | No `clients.auth_user_id → auth.users(id)` FK (orphans allowed) · Auto-link in RLS file runs every apply · `plan_status` enum lacks `cancelled` · No CHECK on monetary columns (can go negative) · `current_client_id()` picks oldest row — wrong when stub is older than real · `seller_client_id` can be NULL on real sales |
| Medium | 8 | Missing index on `sales.seller_client_id` · Missing FK on `phone_verifications.user_id` · `sales.parcel_ids` array duplicates `parcel_id` · No uniqueness on `(sale_id, beneficiary_client_id, level)` in commissions · `reservation_status` uses text+CHECK instead of enum · SECURITY DEFINER functions callable by anon · `client_phone_identities.auth_user_id` no FK · Unique constraint on `client_phone_identities.(client_id)` blocks multi-phone clients |
| Low | 4 | `updated_at` not uniformly triggered · Many enums with `exception when duplicate_object then null` swallow real errors · `parcel_status` enum lacks `cancelled`/`withdrawn` · Audit logs lack retention policy |

---

## 🔴 Critical

### DB-C1 — `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated`
- File: [database/04_rls.sql:479-489](database/04_rls.sql:479) + `ALTER DEFAULT PRIVILEGES` at [database/04_rls.sql:491-511](database/04_rls.sql:491)
- What: Every logged-in user has full DML on every table in the `public` schema. The only protection is RLS being correctly set on every table.
- Impact: One new table merged without `alter table … enable row level security` = fully open to every buyer. Supabase's docs explicitly advise against blanket grants precisely for this reason.
- Fix: Replace with per-table, per-operation grants. Remove `ALTER DEFAULT PRIVILEGES` so future tables are closed by default.
- Cross-reference: duplicate of security finding [S-C1](01_SECURITY_FINDINGS.md#s-c1--blanket-tablefunction-grants-to-anon-and-authenticated), repeated here because the SQL layer is where the fix lives.

### DB-C2 — `sales.status` and `sales.pipeline_status` are freeform `text` with no CHECK
- File: [database/02_schema.sql:340-341](database/02_schema.sql:340) — `status text not null default 'draft', pipeline_status text not null default 'draft'`
- What: The entire sale state machine runs on a non-enum, non-checked `text` column. Code inserts/updates arbitrary strings.
- Impact:
  - Typos (`'compleed'`, `'completed '`) pass the DB and silently break every query filtering by status.
  - Invalid transitions (`'notary_completed' → 'draft'`) are not prevented.
  - Aggregations (`WHERE status = 'completed'`) silently miss rows.
- Fix: Create `sales_status` and `sales_pipeline_status` enums, migrate existing rows to the canonical set, then `ALTER TABLE sales ALTER COLUMN status TYPE sales_status USING status::sales_status`. Consider a state-machine trigger enforcing legal transitions.

### DB-C3 — `commission_events.beneficiary_client_id` FK is `ON DELETE RESTRICT`
- File: [database/02_schema.sql:466](database/02_schema.sql:466) — `references clients(id) on delete restrict`
- What: A stub client linked to commission events **cannot be deleted or merged** — the FK blocks it. Combined with the auto-heal that creates a fresh `clients` row for the real auth user, the stub is orphaned with commissions attached, and [ensure_current_client_profile()](database/03_functions.sql:168) does not migrate `commission_events.beneficiary_client_id` to the new client (per C2 in [AUDIT_RELATIONS_PROBLEMES.md](../AUDIT_RELATIONS_PROBLEMES.md)).
- Impact: Legitimate commissions invisible to the beneficiary, impossible to pay out without manual SQL surgery.
- Fix: (a) Extend `ensure_current_client_profile` to re-point `commission_events.beneficiary_client_id` when a stub is replaced; (b) loosen FK to `ON DELETE SET NULL` with a separate "orphaned commission" audit log; (c) add a periodic "commissions pointing at a stub" health check.

### DB-C4 — SECURITY DEFINER heal RPC silently re-points `sales.client_id` based on phone match
- File: [database/03_functions.sql:222-260](database/03_functions.sql:222) (inside `ensure_current_client_profile`)
- What: Every session resolution replays a phone-based match that UPDATEs `sales.client_id` from an old stub to the current auth user's client. No transactionally-strict guard against phone reuse, no audit trail, no "already linked to another auth user" check beyond `c_old.auth_user_id is null or = v_uid`.
- Impact: Phone number recycling or family-shared phones can transfer sales between auth users silently. Direct exploitation of S-C2 at the SQL layer.
- Fix:
  1. Before migrating a sale, INSERT into `audit_logs` (source='database', severity='warning') with before/after.
  2. Require phone verification (`client_phone_identities.verification_status = 'verified'`) before migration.
  3. Refuse migration if `s.buyer_auth_user_id IS NOT NULL AND s.buyer_auth_user_id <> v_uid` (stronger than current OR clause).
  4. Surface a `migration_requires_review` reason and let a human admin approve.

---

## 🟠 High

### DB-H1 — `clients.auth_user_id` has no foreign key to `auth.users(id)`
- File: [database/02_schema.sql:187](database/02_schema.sql:187) — plain `uuid` column, no FK
- What: Nothing prevents `auth_user_id` from pointing at a deleted or nonexistent auth user. If an admin deletes an auth user, `clients.auth_user_id` goes stale but RLS policies still resolve `auth.uid() = clients.auth_user_id` against nothing, silently hiding the data.
- Impact: Ghost rows; `current_client_id()` returns NULL for the affected user; a new signup with the same uuid (impossibly rare but engineered scenarios exist) could inherit the row.
- Fix: `ALTER TABLE clients ADD CONSTRAINT clients_auth_user_fk FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;`. Same for `client_phone_identities.auth_user_id` ([database/02_schema.sql:215](database/02_schema.sql:215)) and `phone_verifications.user_id` ([database/02_schema.sql:580](database/02_schema.sql:580)).

### DB-H2 — Recovery block in [database/04_rls.sql:527-575](database/04_rls.sql:527) runs every time the RLS file is applied
- What: `UPDATE public.clients … SET auth_user_id = au.id` and `INSERT … ON CONFLICT DO UPDATE` on `client_phone_identities`. These are destructive data-migration operations bundled with RLS.
- Impact: Any apply of the RLS file re-links existing rows, creating subtle data motion. There is no audit of what it touched.
- Fix: Split into a separate `08_one_time_link_recovery.sql` that you apply **once**, logs each affected row to `audit_logs`, and is kept out of the regular RLS pipeline.

### DB-H3 — `plan_status` enum lacks `cancelled`
- File: [database/02_schema.sql:24](database/02_schema.sql:24) — `create type plan_status as enum ('active','late','completed');`
- What: When a sale is cancelled, the related `installment_plans` row has no legal status. Code either keeps `active` (filters include cancelled sales in "active plans") or leaves the enum in a limbo.
- Impact: Recouvrement queries, dashboards, commission clawback all include rows from cancelled sales.
- Fix: `ALTER TYPE plan_status ADD VALUE 'cancelled';` + a trigger that sets `installment_plans.status = 'cancelled'` when the parent `sales.status` transitions to a cancelled state.

### DB-H4 — No CHECK constraints on monetary columns preventing negative values
- Files: [database/02_schema.sql:103-104](database/02_schema.sql:103) (`parcels.total_price`, `price_per_tree`), [database/02_schema.sql:296-300](database/02_schema.sql:296) (`sales.agreed_price`, `deposit`, `advance_paid`, `plots_total_price`), [database/02_schema.sql:394-396](database/02_schema.sql:394) (`installment_plans.total_price`, `down_payment`, `monthly_amount`), [database/02_schema.sql:409](database/02_schema.sql:409) (`installment_payments.amount`), [database/02_schema.sql:469](database/02_schema.sql:469) (`commission_events.amount`)
- What: Any of these can be stored negative. A bug in the app or a mistyped admin edit allows negative installments that reduce the "paid total" below zero.
- Fix: Add `CHECK (total_price >= 0)` etc. Explicitly decide for each column whether zero is allowed. For `commission_events.amount` the answer is probably "allow negative for clawback, but require a linked positive event id".

### DB-H5 — `current_client_id()` picks the oldest row by `created_at`, which can be the stub
- File: [database/03_functions.sql:54-57](database/03_functions.sql:54) — `order by c.created_at asc, c.id asc limit 1`
- What: When a stub client was created before the real signup (normal ambassador flow: stub → signup → stub-should-be-replaced), the stub is older. If the real client row exists but the stub also has the same auth_user_id set (possible via a failed heal), the function returns the stub.
- Impact: The user sees stub data (empty wallet, missing sales) because subsequent heal logic failed. Worse, because the function is deterministic, this state is stuck until admin intervenes.
- Fix: Prefer the row with `email IS NOT NULL` and non-empty `full_name`. Or: prefer the row created AFTER the auth user's `created_at`. Add `current_client_id_v2()` that returns a struct `{client_id, confidence}` so UI can display a health flag.

### DB-H6 — `seller_client_id` can be NULL on a real sale + application fallback to buyer as L1
- File: [database/02_schema.sql:345](database/02_schema.sql:345) — column is nullable; check [database/02_schema.sql:355](database/02_schema.sql:355) only blocks `seller_client_id = client_id` when it's not null
- What: The schema allows `seller_client_id IS NULL`. The application code ([src/lib/db.js:1320](src/lib/db.js:1320), per [AUDIT_RELATIONS_PROBLEMES.md C4](../AUDIT_RELATIONS_PROBLEMES.md)) falls back to the buyer when seller is null, crediting the buyer's upline for their own purchase.
- Fix: `ALTER TABLE sales ALTER COLUMN seller_client_id SET NOT NULL` after backfilling historical nulls with a sentinel "house" client, OR add a trigger that sets `seller_client_id` to a company-owned client when null. Change the app to refuse sales with null seller.

---

## 🟡 Medium

### DB-M1 — Missing index on `sales.seller_client_id`
- File: [database/02_schema.sql:362-367](database/02_schema.sql:362)
- What: The commission upline walk (`insertCommissionEventsForCompletedSale`) queries `sales WHERE seller_client_id = X`; no index exists. Only `idx_sales_project`, `idx_sales_client`, `idx_sales_agent`, `idx_sales_status`, `idx_sales_buyer_phone`, `idx_sales_reservation_expires`.
- Fix: `create index idx_sales_seller_client on sales(seller_client_id) where seller_client_id is not null;`

### DB-M2 — `phone_verifications.user_id` has no FK
- File: [database/02_schema.sql:580](database/02_schema.sql:580)
- Fix: add `REFERENCES auth.users(id) ON DELETE CASCADE`.

### DB-M3 — `sales.parcel_ids` array duplicates `sales.parcel_id`
- File: [database/02_schema.sql:292-293](database/02_schema.sql:292) — `parcel_id bigint not null`, `parcel_ids bigint[] not null default '{}'`
- What: Multi-parcel sales store the "main" parcel in `parcel_id` and the rest in `parcel_ids`. Queries must check both. Any sync bug means a parcel appears sold twice or not at all.
- Fix: Make `parcel_ids` the sole source (array of 1+) and drop `parcel_id`, OR introduce a `sale_parcels` junction table with a unique constraint on `(parcel_id)` where `sale_status != 'cancelled'`.

### DB-M4 — No unique constraint on `commission_events(sale_id, beneficiary_client_id, level)`
- File: [database/02_schema.sql:463-478](database/02_schema.sql:463)
- What: Nothing prevents double-insert of the same commission. The app's idempotency guard ([src/lib/db.js:1453-1455](src/lib/db.js:1453)) is a SELECT-then-skip pattern which races, and any re-run inserts duplicates. See H2 in [AUDIT_RELATIONS_PROBLEMES.md](../AUDIT_RELATIONS_PROBLEMES.md).
- Fix: `create unique index ux_commission_events_once on commission_events(sale_id, beneficiary_client_id, level) where status <> 'cancelled';`. Then change insert to `ON CONFLICT DO NOTHING` (or DO UPDATE with a justification).

### DB-M5 — `reservation_status` uses text+CHECK instead of enum
- File: [database/02_schema.sql:326-327](database/02_schema.sql:326)
- What: Mismatches between enum values in code and the CHECK constraint won't surface until insert fails at runtime. Enum is clearer and gives better type safety.
- Fix: Convert to enum.

### DB-M6 — SECURITY DEFINER functions callable by `anon`
- Files: `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon` at [database/04_rls.sql:485](database/04_rls.sql:485); several SECURITY DEFINER functions exist ([database/03_functions.sql:30, 64, 112, 472, 500, 785, 888, 1086, 1121, 1149, 1173, 1200, 1227, 1283, 1314, 1337, 1432, 1477, 1524, 1559, 1627, 1681, 1736, 1813, 1924, 2080, 2213](database/03_functions.sql)).
- What: If any SECURITY DEFINER function does not first check `if auth.uid() is null then raise exception`, `anon` can invoke it with privileged rights.
- Fix: (a) remove `GRANT EXECUTE ... TO anon` as blanket; (b) audit each SECURITY DEFINER function and add an explicit `if auth.uid() is null then raise exception 'auth required'; end if;` where appropriate.

### DB-M7 — `client_phone_identities.auth_user_id` has no FK
- File: [database/02_schema.sql:215](database/02_schema.sql:215)
- Fix: as DB-H1.

### DB-M8 — `unique (client_id)` on `client_phone_identities` forbids multi-phone clients
- File: [database/02_schema.sql:224](database/02_schema.sql:224) — `unique (client_id)`
- What: A client legitimately has work + personal phones. The table is named "*_identities" (plural) but the unique constraint forbids multiple rows per client.
- Fix: Drop `unique (client_id)`. Keep `unique (phone_canonical)`. If exactly-one is intentional, rename the table to singular and document why.

---

## 🟢 Low

### DB-L1 — `updated_at` not uniformly triggered
- File: [database/02_schema.sql:660-685](database/02_schema.sql:660) — `seller_parcel_assignments`, `seller_relations`, `ambassador_wallets`, `installment_payment_receipts`, `sale_reservation_events` lack the `touch_updated_at` trigger.
- Impact: staleness detection and audit queries miss these updates.
- Fix: add the trigger or remove `updated_at` where truly immutable.

### DB-L2 — `exception when duplicate_object then null` swallows real errors
- File: [database/02_schema.sql:11-47](database/02_schema.sql:11) — enum creation wrapped in anonymous DO blocks with blanket exception handler.
- Impact: a genuine typo in the enum name appears as "enum created" on re-run when it actually failed the first time and only the DO block rewrite succeeded.
- Fix: catch only the specific exception (`duplicate_object`) and re-raise anything else. Already done (looks OK) — but consider moving to `CREATE TYPE IF NOT EXISTS` (pg 15+).

### DB-L3 — `parcel_status` enum lacks `cancelled` / `withdrawn`
- File: [database/02_schema.sql:16](database/02_schema.sql:16)
- Impact: inventory accuracy when a parcel is pulled from sale.
- Fix: extend enum.

### DB-L4 — No retention policy on `audit_logs`
- File: [database/02_schema.sql:519-536](database/02_schema.sql:519)
- Impact: audit table grows unbounded; cost and query perf.
- Fix: monthly partition + archive policy; or at least an `audit_logs_purged_before` setting.

---

## What I did NOT find (verified absent)

- No `drop table` or `truncate` inside the regular `02_schema.sql`/`03_functions.sql` — good.
- All policy-protected tables have `enable row level security`. No table has RLS missing.
- No `float` money columns — all money is `numeric(14,2)`.
- No RLS policy with `USING (true)` on a private table — only public catalog tables use `USING (true)` and only for `anon` select (which is by design, though see S-C5).
- Several SECURITY DEFINER functions correctly `set search_path = public[, auth]` — good defense against search_path hijack.

---

## Cross-reference

Your team's [AUDIT_RELATIONS_PROBLEMES.md](../AUDIT_RELATIONS_PROBLEMES.md) already captures many of the flow-level issues (C1–L1). My findings here are additive: structural schema/RLS issues that the flow audit did not emphasize. Combined priority order for the DB work is in [00_INDEX.md](00_INDEX.md).
