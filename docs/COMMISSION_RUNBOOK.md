# Commission Runbook

Operator playbook for the Zitouna commission engine. For design context see
[Architecture](./COMMISSION_ARCHITECTURE.md); for verification steps see
[QA](./COMMISSION_QA.md).

Every SQL snippet is safe to run from the Supabase SQL editor as `service_role`.

## A) Duplicate commissions on one sale

- **Symptom** – Ambassador sees the same sale twice in the ledger; totals
  inflated.
- **Quick check**

  ```sql
  select sale_id, beneficiary_client_id, count(*)
  from commission_events
  group by 1, 2
  having count(*) > 1;
  ```

- **Fix** – one-liner:

  ```sql
  select cleanup_inconsistent_commission_events();
  ```

## B) L2+ commissions missing

- **Symptom** – Parrain did not receive an event on a child's sale.
- **Quick check**

  ```sql
  select * from seller_relations where child_client_id = :child;
  ```

- **Fix** – rebuild the edge, then replay:

  ```sql
  select backfill_parrainage_from_sales();
  select compute_and_insert_commissions_for_sale(:sale_id);
  ```

## C) Dashboard Parrainage hangs at "loading"

- **Symptom** – Ambassador card spins forever on `/dashboard`.
- **Quick check** – `useAmbassadorReferralSummary` guards with a 12 s timeout.
  Verify the underlying RPC in Supabase:

  ```sql
  explain analyze select * from rpc_ambassador_summary(:client_id);
  ```

  Look for execution time `> 2000 ms`.
- **Fix** – add the missing index (`seller_relations(parent_client_id)`) or
  vacuum the table. Timeouts bubble up as an error state in the UI.

## D) Commission events exist but user can't see them

- **Symptom** – Row exists in `commission_events`, dashboard shows zero.
- **Quick check** – RLS policy `client_select_own_commission_events` requires
  `beneficiary_client_id = current_client_id()`:

  ```sql
  select c.id, c.auth_user_id
  from clients c
  where c.id = :beneficiary_client_id;
  ```

- **Fix** – the row's `auth_user_id` must match the signed-in user. Link it:

  ```sql
  update clients set auth_user_id = :auth_uid where id = :client_id;
  ```

## E) Manual adjust needed

- **Symptom** – Legitimate business reason to change a sale's commission.
- **Fix (preferred)** – open **Admin -> Commission Tracker**, use the override
  action (wraps `overrideSaleCommissionSnapshot` in `src/lib/db.js`). A motif
  is mandatory.
- **Fix (SQL)** – only if the sale has not reached notary yet:

  ```sql
  update sales
     set commission_rule_snapshot = :jsonb
   where id = :sale_id and notary_completed_at is null;
  ```

  Post-notary edits are blocked: delete events, adjust snapshot, replay via
  `compute_and_insert_commissions_for_sale`.

## F) Anomaly detected

- **Symptom** – Admin banner or `/admin/commissions/anomalies` lights up.
- **Quick check**

  ```sql
  select * from detect_parrainage_anomalies();
  ```

- **Interpretation** – the function returns labeled buckets:
  - `cycles` – a parent chain loops back. Break the oldest edge.
  - `self_referrals` – `child = parent`. Null out the parent.
  - `orphan_commissions` – event without matching `seller_relations`.
  - `mismatched_l1` – L1 beneficiary != seller. Re-run cleanup.
  - `duplicate_upline` – two parents for one child. Keep the earliest.

## G) Payout requested but never paid

- **Symptom** – Ambassador says "payment missing" although ledger shows paid.
- **Quick check**

  ```sql
  select id, status, requested_at, paid_at
  from commission_payouts
  where beneficiary_client_id = :client_id
  order by requested_at desc;
  ```

- **Fix** – `status` flow is `requested -> approved -> paid`. If stuck at
  `approved`, mark paid via Finance Dashboard. If `paid_at` is set but the
  transfer failed, flip back to `approved` and re-issue.
