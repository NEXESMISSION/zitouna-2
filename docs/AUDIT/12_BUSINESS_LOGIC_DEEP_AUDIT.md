# 12 — Business Logic Deep Audit

> Severity ordering: **Critical → High → Medium → Low**.
> Additive to [03_BUSINESS_LOGIC_FINDINGS.md](03_BUSINESS_LOGIC_FINDINGS.md). Every finding below is new unless otherwise noted in [Already covered](#already-covered).
> Scope: commission math, installment plans, sale pipeline, reservation expiry, seller quota, wallet, page grants, post-notary destination, and the new `database/08_notifications.sql` triggers.

## Summary

| Severity | # | Short list |
|---|---:|---|
| Critical | 3 | Missing `expire_pending_sales_reservations` RPC · Same commission event can enter TWO active payout requests (double-pay race) · Notary-completed → canceled leaves `notary_completed_at` set AND `commission_events.status='payable'` (money out the door) |
| High | 5 | Sale status notify trigger fires "Vente confirmée" on rollbacks TO `pending_finance` · Reservation expiry runs per-browser with no locking (double-flip race) · `sellerParcelsSoldCount` / `sellerParcelQuota` never read or incremented · `post_notary_destination = ''` (empty) silently treated as cash_sale AND as plan (counts in both pages) · Installment receipt upload has no client-side row-version guard → approve/re-upload race |
| Medium | 4 | Notary re-setting `notary_completed_at` after JS force-regeneration may race the DB backstop trigger · `cleanup_inconsistent_commission_events()` deletes events even when they belong to a `paid` payout request · `dossierStatus` in recouvrement flags `rejected` and `pending-overdue` as the same bucket · `isPayable(submitted)` lets the buyer overwrite a pending-admin-review receipt |
| Low  | 3 | `SALE_STATUS.PENDING_COORDINATION` has no `STATUS_FLOW` entry → admin cannot advance it manually · `commission_payout_requests` PK `(request_id, commission_event_id)` allows same event in another request · `sales_notify` ELSE branch silently drops transitions admins might expect to see |

---

## Critical

### BL2-C1 — `expire_pending_sales_reservations` RPC is invoked but does not exist in the DB
- Client call: [src/lib/db.js:4250-4254](../../src/lib/db.js#L4250)
  ```js
  const { data, error } = await supabase.rpc('expire_pending_sales_reservations', { p_limit: limit })
  ```
- SQL: `grep` of the entire `database/` finds **no** `create function public.expire_pending_sales_reservations`. Only the index `idx_sales_reservation_expires` exists.
- Repro: Staff calls the bulk reservation expiry; Supabase returns `PGRST202` (function not found); caller's `throw new Error(...)` surfaces as a toast. In production this has never expired a reservation at scale — only the per-sale CoordinationPage loop (BL2-H2) runs.
- Fix: add a plpgsql function that, atomically, flips `reservation_status='expired_pending_review'` for all rows whose `reservation_expires_at < now()` and are still `active`/`extended`, capped by `p_limit`, and logs to `sale_reservation_events`. Wrap in a single statement so two concurrent calls can't double-queue.

### BL2-C2 — Same `commission_event` can be locked into two active payout requests → double payout
- Schema: [database/02_schema.sql:497-501](../../database/02_schema.sql#L497)
  ```sql
  create table commission_payout_request_items (
    request_id uuid not null references commission_payout_requests(id) on delete cascade,
    commission_event_id uuid not null references commission_events(id) on delete restrict,
    primary key (request_id, commission_event_id)
  );
  ```
  The PK only forbids duplicate (request, event) pairs. Nothing forbids the **same event** in two different active requests.
- App guard: [src/lib/db.js:1947-1967](../../src/lib/db.js#L1947) filters out events already claimed by `pending_review`/`approved` requests — but does so by reading, then writing, with **no DB transaction or row-lock**.
- Repro: Two beneficiaries (or a beneficiary and an admin "submit on behalf") click *Demander virement* in the same ~200 ms. Both read the payable events list, both find the same events unclaimed, both insert a new `commission_payout_requests` row, both insert items → event E1 is now inside Request A and Request B. Admin approves and marks both `paid`. The beneficiary receives the commission twice.
- Fix: (a) Add `create unique index ux_payout_items_event_open on commission_payout_request_items(commission_event_id)` — requires cancelling items when a request is rejected/paid and using partial `WHERE` on request status (harder). Simpler: (b) wrap the insert in a DB RPC `submit_commission_payout_request(p_client_id)` that does `SELECT … FOR UPDATE` on the candidate events and inserts, under serializable isolation. (c) Add `CHECK` / trigger: before insert into `commission_payout_request_items`, verify no other active request already owns this event.

### BL2-C3 — Cancelling a completed sale does not clear commissions OR `notary_completed_at`
- There is **no** code path that, on sale cancellation, either:
  - resets `notary_completed_at := null`, or
  - updates `commission_events.status := 'cancelled'` for that sale.
- This is a superset of the already-filed BL-H4 (commission clawback stub) but ALSO:
  - the DB constraint [02_schema.sql:359](../../database/02_schema.sql#L359) `sales_completed_has_notary_date` does NOT force the inverse: a **cancelled** sale with `notary_completed_at = <date>` is legal.
  - the recompute_ambassador_wallet RPC ([03_functions.sql:1118-1144](../../database/03_functions.sql#L1118)) still sees these events as `status='payable'`.
- Repro: Admin completes sale S (notary), commissions fire, wallet shows balance. Dispute. Admin marks S as `cancelled` (update status). Nothing else changes — wallet still reads as payable, beneficiary can request payout, admin approves, money leaves.
- Fix (end-to-end):
  1. On `sales UPDATE status='cancelled'`, trigger flips any linked `commission_events` to `cancelled` with `rule_snapshot` metadata `{ reason: 'sale_cancelled' }`.
  2. If any of those events are already in a `paid` payout, raise exception (or emit a "clawback required" admin notification).
  3. Blocks in the wallet UI so the user understands a reversal is pending.

---

## High

### BL2-H1 — `trg_sales_notify` emits "Vente confirmée" on BACKWARD transitions to `pending_finance`
- File: [database/08_notifications.sql:528-547](../../database/08_notifications.sql#L528)
  ```plpgsql
  CASE NEW.status
    WHEN 'pending_finance' THEN
      v_type := 'sale_confirmed'; v_sev := 'success';
      v_title := 'Vente confirmée';
      v_body  := 'Votre achat ... est en cours de validation.';
  ```
  The CASE does not look at `OLD.status`. Every update that ends at `pending_finance` sends the success notification — including `active → pending_finance`, `pending_legal → pending_finance`, `completed → pending_finance`.
- Repro: Finance mistakenly flips a sale back from `pending_legal` to `pending_finance` to correct a checklist error. The buyer receives a second "Vente confirmée" success toast minutes after legal had already confirmed. Worse: this notification is deduped by `dedupe_key = 'sale_status:' || id || ':' || status`, so the FIRST legitimate confirmation (also at `pending_finance`) would be deduped as "already sent" and never fire again.
- Fix: gate each branch with `AND OLD.status IS NULL OR OLD.status NOT IN ('pending_legal','active','completed')` (forward-only). Also change dedupe_key to include a pass-counter or `coalesce(OLD.status,'null')` so a genuine re-visit after rollback can still emit.

### BL2-H2 — Reservation expiry auto-flip runs in every admin browser with no lock
- File: [src/admin/pages/CoordinationPage.jsx:273-301](../../src/admin/pages/CoordinationPage.jsx#L273)
  ```js
  useEffect(() => {
    // ... for each sale whose reservation expired:
    await salesUpdate(s.id, { reservationStatus: 'expired_pending_review' })
    await db.insertSaleReservationEvent(...)
  }, [sales, salesUpdate])
  ```
- Problems:
  1. Two admins with CoordinationPage open will both race: each calls `salesUpdate` and `insertSaleReservationEvent` → **two** `reservation_expired_queue` rows in `sale_reservation_events` per expired reservation.
  2. If one admin is actively editing sale S (e.g., extending reservation with `extendReservation`), the other admin's expiry hook may flip it to `expired_pending_review` between the first admin's read and write. The extension then overwrites to `extended` but the audit log shows the expiry pushed first, making it look like the extension overrode an expired state instead of a still-active one.
  3. Relies on client-side clock (`Date.now()`) — admins in the wrong timezone could expire early.
- Fix: move the expiry scan server-side. Implement the RPC from BL2-C1 (`expire_pending_sales_reservations`) and schedule it via pg_cron — the UI simply `refresh()`es, never writes the status itself.

### BL2-H3 — `sellerParcelsSoldCount` / `sellerParcelQuota` are dead columns
- Schema: [database/02_schema.sql:189-190](../../database/02_schema.sql#L189) declares both with defaults of 0.
- Usage in repo: **only** mapping getters/setters in [src/lib/db.js:630-631, 719-720](../../src/lib/db.js#L630). No code increments the count on a completed sale. No code checks the quota before allowing a new sale to be created. No DB trigger either.
- Repro: A seller with `seller_parcel_quota = 5` and `seller_enabled = true` can sell 500 parcels — the quota is purely decorative. Conversely, if an admin thinks they set a quota and later sees `_sold_count` still `0`, they assume nothing has sold; the number is always lying.
- Fix (minimum viable): add an AFTER INSERT trigger on `sales` that, on transition to `completed`, increments the seller's `_sold_count` (and, if > `_quota` and `_quota > 0`, raises a warning into `audit_logs`). On `cancelled` from `completed`, decrement. Then either delete the columns entirely or expose them in UserManagementPage.

### BL2-H4 — `post_notary_destination = ''` silently classified as both "cash sale" and "installment plan"
- File: [src/admin/pages/CashSalesPage.jsx:33-39](../../src/admin/pages/CashSalesPage.jsx#L33)
  ```js
  function isPostNotaryCashSale(sale) {
    if (String(sale.paymentType || '').toLowerCase() !== 'full') return false
    const dest = sale.postNotaryDestination
    if (dest === 'cash_sales' && isCompletedSale(sale)) return true
    if ((dest === undefined || dest === null || dest === '') && isCompletedSale(sale)) return true
    return false
  }
  ```
- File: [src/lib/db.js:2937-2940](../../src/lib/db.js#L2937) (`replayInstallmentPlansFromCompletedSales`)
  ```js
  const d = String(s.post_notary_destination || '').toLowerCase()
  return d === 'plans' || d === ''
  ```
- Repro: A pre-migration row or one created by a bypass path has `post_notary_destination = null`. CashSalesPage shows it as a cash sale. RecouvrementPage's auto-replay also picks it up as an installment candidate and tries to create a plan. For `payment_type='full'` sales it would fail (no offer) — but for `installments` with null dest, a plan *is* created while the sale ALSO appears in other listings that branch on the destination.
- Fix: (a) add `NOT NULL` + default to the column, and (b) run a one-shot migration to populate based on `payment_type`. Then remove the "empty string means cash" fallback.

### BL2-H5 — Buyer can overwrite a `submitted` receipt while admin is mid-review
- File: [src/pages/InstallmentsPage.jsx:23](../../src/pages/InstallmentsPage.jsx#L23)
  ```js
  function isPayable(status) { return status === 'pending' || status === 'rejected' || status === 'submitted' }
  ```
  → the "Payer" button stays enabled even for `submitted` rows.
- File: [src/pages/InstallmentsPage.jsx:161-164](../../src/pages/InstallmentsPage.jsx#L161)
  ```js
  await uploadInstallmentReceipt({ paymentId, file })
  await addInstallmentReceiptRecord(...)           // inserts a NEW receipts row
  await updatePaymentStatus(payment.id, 'submitted', { receiptUrl: url })
  ```
  No version/ETag check. If admin's RecouvrementPage `approve(paymentId)` lands between the upload and the status update, the admin approved the OLD receipt but the row now points at the NEW URL + the buyer thinks re-upload succeeded. If admin's `reject` lands in that window, the buyer's fresh upload is retrospectively tagged with the rejection note from the previous receipt.
- Fix: disable the pay button when status='submitted' (the happy-path UX). If re-upload is desired, route it through a dedicated "remplacer le reçu" action that:
  1. checks `status === 'submitted'` via `.match({ status: 'submitted' })` in the update (so a racing admin approval will 0-row update and the UI can reload);
  2. clears `approved_at` + `rejected_note` atomically.

---

## Medium

### BL2-M1 — JS force-regeneration and DB backstop trigger can collide
- JS: [src/lib/db.js:1752-1798](../../src/lib/db.js#L1752) — when `force=true`, deletes existing events, then inserts new ones.
- DB: [database/03_functions.sql:1083-1101](../../database/03_functions.sql#L1083) — `trg_sales_notary_commissions` fires on UPDATE of `notary_completed_at`, guarded only by "if any event exists, skip".
- Window: `force` regen path:
  1. JS deletes all rows for sale S.
  2. Simultaneously, another admin sets a new `notary_completed_at` (e.g., tries to clear+reset to correct the date).
  3. DB trigger fires; no events exist (JS just deleted them); DB inserts its own computed set.
  4. JS then inserts its own set → you have BOTH JS-computed and DB-computed events. The JS path doesn't look at rows inserted between its delete and insert.
- Fix: wrap the JS regen in an RPC that does DELETE + INSERT in one statement under `FOR UPDATE` on the sales row; or add `SELECT … FOR UPDATE` before the delete.

### BL2-M2 — `cleanup_inconsistent_commission_events()` deletes paid events
- File: [database/03_functions.sql:1921-1996](../../database/03_functions.sql#L1921)
- The function finds events that violate invariants (L1 beneficiary != seller, self-commission, etc.) and **deletes** them unconditionally. It does not check `status='paid'` or existence of a paid payout_request_item.
- Repro: Stale data from before the BL-C5 phone-theft fix has a sale S whose current `seller_client_id` is the buyer. A commission was already paid. Admin runs cleanup → the row is deleted → the FK on payout items is `on delete restrict`, so the delete **errors out** (ok), but the exception wipes the transaction and no other cleanup rows are removed either. At best: silent failure. At worst: if someone reviews as `on delete cascade`, money audit trail is lost.
- Fix: add `and not exists (select 1 from commission_payout_request_items pri where pri.commission_event_id = ce.id)` and log a WARNING row to `audit_logs` for every event skipped.

### BL2-M3 — `dossierStatus` in recouvrement conflates `rejected` with `pending-overdue`
- File: [src/admin/pages/RecouvrementPage.jsx:113-119](../../src/admin/pages/RecouvrementPage.jsx#L113)
  ```js
  const hasOverdue = d.payments.some((p) => (p.status === 'pending' && p.dueDate < TODAY) || p.status === 'rejected')
  ```
  So a dossier with a rejected receipt (buyer's action required) is shown with the same tone as an overdue pending (admin's chase required). The filter chip `overdue` catches both, but they're operationally different.
- Fix: split into `overdue` and `to_correct` buckets; already hinted in `statusMeta` in [InstallmentsPage.jsx:20](../../src/pages/InstallmentsPage.jsx#L20) (buyer-side) but not mirrored here.

### BL2-M4 — `auto_paid_from_wallet` column is unused; dashboards quietly over-report cash
- Schema: [database/02_schema.sql:411](../../database/02_schema.sql#L411) has the column.
- Usage: `grep auto_paid_from_wallet` across `src/` returns zero hits (checked 2026-04-18). Nothing sets it. Nothing reads it. Already foreshadowed in BL-H3 — reiterating because the trigger logic in `08_notifications.sql` treats every `approved` installment identically, meaning when we finally ship wallet auto-debit, the `installment_paid` notification will lie ("Échéance réglée" reads as cash in the door).
- Fix: when wiring wallet auto-debit, have `trg_installment_payments_notify` branch on `NEW.auto_paid_from_wallet` for a distinct `'installment_wallet_debit'` type/severity.

---

## Low

### BL2-L1 — `SALE_STATUS.PENDING_COORDINATION` missing from `STATUS_FLOW`
- File: [src/admin/pages/SellPage.jsx:113-126](../../src/admin/pages/SellPage.jsx#L113) — no entry for `pending_coordination`.
- File: [src/admin/pages/SellPage.jsx:938](../../src/admin/pages/SellPage.jsx#L938) — sales are created with exactly this status.
- Impact: the "advance status" button in SellPage is hidden for every fresh sale (the main pipeline entry-point) until Coordination manually dispatches to Finance. That's actually the intended flow, but the consequence is that sales stuck in `pending_coordination` because of a mis-configured project can't be manually recovered from SellPage — only from CoordinationPage.
- Fix: add `[SALE_STATUS.PENDING_COORDINATION]: { ..., next: SALE_STATUS.PENDING_FINANCE, nextLabel: 'Envoyer à la finance' }` to let a privileged admin override.

### BL2-L2 — `commission_payout_request_items` PK does not prevent double-claim across requests
- See BL2-C2 for the critical version. Low-priority sibling: this is a schema gap. A partial unique index `create unique index on commission_payout_request_items(commission_event_id) where <request is active>` is the cleanest guard but requires a migration and a status-propagation trigger. Filed separately so the team doesn't forget it while fixing BL2-C2.

### BL2-L3 — `trg_sales_notify` returns silently for status hops admins may expect to see
- File: [database/08_notifications.sql:545-546](../../database/08_notifications.sql#L545) — ELSE branch is `RETURN NEW;` for any status not in `{pending_finance, active, completed, cancelled}`.
- Consequence: transitions to `pending_legal`, `pending_coordination`, `rejected` never notify the buyer. A `rejected` dossier sits in silence until the buyer happens to check the dashboard.
- Fix: add an explicit `rejected` branch with severity=`danger`; consider a `pending_legal` branch so buyers know the finance step cleared.

---

## Already covered

Items I verified already exist in prior audits and I did **not** duplicate:
- `setMonth` drift + TZ off-by-one → [03 BL-C3 / BL-H5 / BL-M1](03_BUSINESS_LOGIC_FINDINGS.md#bl-c3--setmonth-causes-installment-schedule-to-skip-or-land-on-wrong-date)
- Fixed commission on zero-price sale → [03 BL-C2](03_BUSINESS_LOGIC_FINDINGS.md#bl-c2--fixed-amount-commission-fires-on-zero-value-or-negative-sale)
- Missing-level rule fallback → [03 BL-C1](03_BUSINESS_LOGIC_FINDINGS.md)
- Legacy status aliasing only on read → [03 BL-H1](03_BUSINESS_LOGIC_FINDINGS.md)
- `approvedPct` count-based → [03 BL-H2](03_BUSINESS_LOGIC_FINDINGS.md)
- `auto_paid_from_wallet` inflates cash (noted again in BL2-M4 with fresh angle — the new notify trigger)
- Clawback on cancel missing → [03 BL-H4](03_BUSINESS_LOGIC_FINDINGS.md); BL2-C3 extends with notary_completed_at invariant + wallet impact
- Upline 40-level cap → [03 BL-M3](03_BUSINESS_LOGIC_FINDINGS.md)
- Phone-based sale theft + self-referral guards → prior audits + schema constraint `sales_seller_neq_buyer` now enforced ([02_schema.sql:355](../../database/02_schema.sql#L355))
- `toIsoDate` off-by-one, `Number("1 234,56")=NaN` → [03 BL-M1, BL-M2](03_BUSINESS_LOGIC_FINDINGS.md)
- Commission idempotency by existence not correctness → [03 BL-M6](03_BUSINESS_LOGIC_FINDINGS.md)
- `formatMoneyTnd` / `fmtMoney` inconsistency → [03 BL-L1, BL-L4](03_BUSINESS_LOGIC_FINDINGS.md)

All items above in BL2-* are **net-new** observations not present in the 03 audit.
