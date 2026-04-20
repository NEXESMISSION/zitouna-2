# 03 — Business Logic Findings

> Severity ordering: **Critical → High → Medium → Low**.
> File refs are clickable `[path:line](path:line)`.
> This file covers correctness of domain rules (commissions, installments, sell flow, recouvrement). Security is in [01](01_SECURITY_FINDINGS.md); SQL structural in [02](02_DATABASE_RLS_FINDINGS.md); frontend correctness in [04](04_FRONTEND_CORRECTNESS_FINDINGS.md).
>
> Your team's prior deep audits at [docs/AUDIT_RELATIONS_PROBLEMES.md](../AUDIT_RELATIONS_PROBLEMES.md) and [docs/DEEP_BUG_AUDIT.md](../DEEP_BUG_AUDIT.md) already flag ~17 issues. This file is **additive** — it does not re-state those, only adds what I observed that wasn't yet captured.

## Summary

| Severity | Count | Short list |
|---|---:|---|
| Critical | 4 | Missing-level rule falls through to next-index rule (wrong rate) · Fixed-amount commission triggers on $0 sales · Installment schedule drifts at end-of-month · `cashValidatedStrict` double-counts terrain deposit in some flows |
| High | 5 | `canonicalSaleStatus` aliasing happens only on read — writes can persist legacy values · `approvedPct` is count-based not amount-based · `auto_paid_from_wallet` payments inflate "cash received" · No commission clawback on sale cancellation (`clearPendingCommissionsForSale` stubbed) · Day-of-month drift (`setMonth`) when startDate is 29–31 |
| Medium | 6 | `toIsoDate` creates TZ-west off-by-one · `Number(parseFloat)` on localized strings (`"1 234,56"`) becomes NaN silently · Upline walk caps at 40 levels (policy unclear) · `refundedAmount` tracking absent · `notes`/free-form fields can mutate immutable snapshots · Idempotency check by existence not by correctness |
| Low | 4 | `formatMoneyTnd` `maximumFractionDigits: 2` allows 1-decimal output inconsistently · `fmtMoney` in recouvrement has no fractional digits (hides pennies) · Status alias table lacks entries for several DB-observed variants · Chain ordering uses JS sort on UUID strings when ties |

---

## 🔴 Critical

### BL-C1 — Missing-level commission rule falls through to the wrong rule
- File: [src/lib/db.js:1622](src/lib/db.js:1622)
- Code: `const rule = rules.find((rr) => Number(rr.level) === level) || rules[idx]`
- Scenario: `project_commission_rules` for a project has rows L1 and L3 but L2 was deleted or never configured. When the walker is computing level=2, `rules.find(...)` returns undefined, and the `|| rules[idx]` fallback returns `rules[1]` = the L3 row. L2 beneficiaries now get L3's rate (often much lower, sometimes wildly different).
- Why it matters: commissions are silently wrong for any project whose rules are non-contiguous. Compounds across every sale in that project.
- Fix: Remove the `|| rules[idx]` fallback. Either skip the level (return) or throw — never silently substitute. At the DB side, add a `CHECK` that levels are contiguous per project.

### BL-C2 — Fixed-amount commission fires on zero-value (or negative) sale
- File: [src/lib/db.js:1626-1627](src/lib/db.js:1626)
- Code: `if (rt === 'percent') amt = round... else amt = round(Number(rule.value || 0))` — fixed amount ignores `amountBase`.
- Scenario: a sale is created with `agreedPrice = 0` (staging data, test sale, fully-refunded sale where the price was zeroed), commission events are still inserted with the fixed-rule amount. Those go to `status = 'payable'` ([src/lib/db.js:1476](src/lib/db.js:1476)) and become due for payout.
- Fix: `if (amountBase <= 0) return` at the top of the forEach, OR require `amt = 0` when `amountBase = 0` for both rule types. If a sale gets cancelled / refunded to zero, ensure commissions are clawed back (see BL-H4).

### BL-C3 — `setMonth` causes installment schedule to skip or land on wrong date
- File: [src/installmentsStore.js:20-21](src/installmentsStore.js:20)
- Code: `const due = new Date(start); due.setMonth(due.getMonth() + i)`
- Scenario: `startDate = "2026-01-31"`. At `i = 1`, `setMonth(+1)` yields `2026-03-03` (Feb has no 31st — JS rolls over to March 3). At `i = 2`, it yields `2026-03-31`. The schedule has Feb 3, Mar 31, May 3, May 31, … — irregular and confusing.
- Fix: Use a last-day-of-month anchor pattern:
  ```js
  const due = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
  const targetDay = start.getUTCDate();
  const lastDay = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
  due.setUTCDate(Math.min(targetDay, lastDay));
  ```
- Also: do the whole computation in UTC to avoid DST flips.

### BL-C4 — `cashValidatedStrict` can double-count when an installment encodes the deposit
- File: [src/domain/installmentMetrics.js:66](src/domain/installmentMetrics.js:66)
- Code: `cashValidatedStrict = round2(terrainDeposit + approvedAmount)`
- Scenario: If the installment plan's first `payment` row was created to represent the deposit (some flows create month=0 or month=1 = down payment), then `terrainDeposit + approvedAmount` counts it twice.
- How to verify: Look at the sale's `pricing_snapshot` vs `installment_plans.down_payment` vs `installment_payments[0].amount`. If any flow creates both a `sales.deposit` record and a `payment` row for the same event, this bug will over-report cash received.
- Fix: Either (a) exclude `month === 0` / `month === 1 && p.isDeposit` from the sum; (b) infer the overlap by checking `approvedAmount >= terrainDeposit` and `payments.some(p => p.amount === terrainDeposit && p.status === 'approved')`; or (c) change the contract so the plan never includes the deposit as a row.

---

## 🟠 High

### BL-H1 — `canonicalSaleStatus` alias applies only on read
- File: [src/domain/workflowModel.js:14-22](src/domain/workflowModel.js:14)
- What: `LEGACY_SALE_STATUS_ALIAS` rewrites `'pending' → 'pending_finance'` and `'signed' → 'pending_legal'` when **reading** the status. But nothing rewrites on **write**. Code writing `status: 'pending'` or `status: 'signed'` ([src/lib/db.js:2416-2417](src/lib/db.js:2416) mirrors the raw `sale.status`) still persists legacy values.
- Impact: DB ends up with a mixture of legacy and canonical statuses. Every consumer must remember to call `canonicalSaleStatus`. Any direct SQL query (`WHERE status = 'pending_finance'`) misses legacy rows.
- Fix: (a) Normalize on write too; (b) run a one-shot migration `UPDATE sales SET status = CASE status WHEN 'pending' THEN 'pending_finance' ...`; (c) then apply the enum from [DB-C2](02_DATABASE_RLS_FINDINGS.md#db-c2).

### BL-H2 — `approvedPct` is count-based, misleading on back-loaded schedules
- File: [src/domain/installmentMetrics.js:74](src/domain/installmentMetrics.js:74)
- Code: `approvedPct = totalMonths > 0 ? round2((approvedCount / totalMonths) * 100) : 0`
- Impact: When the last month is the balance (often 2–5x the regular monthly), paying 11/12 "count" is 92% but the remaining balance can be 40% of the total. UI shows "92% paid" to both admin and buyer.
- Fix: `approvedPct = saleAgreed > 0 ? round2((cashValidatedStrict / saleAgreed) * 100) : 0`. Or show both and label them clearly.

### BL-H3 — Auto-wallet payments inflate "cash received" metrics
- File: [src/domain/installmentMetrics.js:51-58](src/domain/installmentMetrics.js:51) — the loop doesn't branch on `p.auto_paid_from_wallet`; all approved amounts count as cash.
- Context: the DB flag exists ([database/02_schema.sql:411](database/02_schema.sql:411) `auto_paid_from_wallet boolean`). When a commission wallet balance pays an installment automatically, that's accounting-wise a wallet draw, not a cash inflow.
- Impact: Finance dashboards that need "cash in the door this month" include wallet transfers. Reconciliation with bank deposits fails silently.
- Fix: Separate the tally. Return `{ cashApprovedAmount, walletApprovedAmount }` and recompute `cashValidatedStrict` from cash only.

### BL-H4 — No clawback path when a sale is cancelled after commissions are inserted
- Context: [DEEP_BUG_AUDIT.md](../DEEP_BUG_AUDIT.md) Critical #4 flags `clearPendingCommissionsForSale` as stubbed. I confirmed: there is no call site that marks `commission_events.status = 'cancelled'` on sale cancellation, and the upsert path ([src/lib/db.js:1752 `insertCommissionEventsForCompletedSale`](src/lib/db.js:1752)) only inserts when none exist.
- Impact: A sale that reaches notary_completed → generates commissions → later gets cancelled → commissions remain `payable` and can be paid out. Money out the door on a non-existent sale.
- Fix: On sale cancellation, mark all linked `commission_events` as `cancelled`, add an entry to `audit_logs`, and, if any had already been `paid`, issue a `negative-amount` commission event referencing the original (for accounting continuity).

### BL-H5 — Day-of-month drift via native `Date` + local timezone
- File: [src/installmentsStore.js:1-30](src/installmentsStore.js:1)
- What: `toIsoDate` subtracts `getTimezoneOffset()` but the start date itself is `new Date(startDate)` which interprets `"2026-01-31"` as UTC midnight. For users west of UTC, the slice returns `2026-01-30`.
- Compounds: the `setMonth` bug (BL-C3). Both rooted in using local Date semantics instead of UTC throughout.
- Fix: Use `Date.UTC(...)` everywhere dates are computed, and never rely on `getTimezoneOffset()`. Adopt a rule: all date math in UTC; only at display time convert to local.

---

## 🟡 Medium

### BL-M1 — `toIsoDate` produces off-by-one on negative UTC offsets
- File: [src/installmentsStore.js:1-3](src/installmentsStore.js:1)
- Code: `return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)`
- Impact: users running the dashboard in UTC-8 see due dates one day early.
- Fix: `return d.toISOString().slice(0, 10)` if you construct `d` as `Date.UTC(...)`.

### BL-M2 — `Number()` / `parseFloat` of localized strings silently returns NaN
- File: [src/domain/installmentMetrics.js:16,23,24,52](src/domain/installmentMetrics.js:16) and 14 other files (per grep: `Number(` / `parseFloat` occurrences in `src/admin/pages/*.jsx`).
- What: user-entered amounts like `"1 234,56"` (French formatting) → `Number("1 234,56")` = NaN. Downstream: `NaN * rate = NaN`, then `Math.round(NaN*100)/100 = NaN`, then `(Number(n)||0)` coerces to 0 only in some helpers. Silent data loss.
- Fix: Create a single `parseTnd(value)` that strips spaces and replaces `,` with `.` before `Number()`.

### BL-M3 — Upline walker caps at 40 levels
- File: [src/lib/db.js:1598](src/lib/db.js:1598) — `while (walkId && steps < 40)`
- Policy question: is 40 correct? Most MLM/referral systems cap at 5–7. If the real intent is "cap at `maxLevel`" (rules-driven), the 40 is a safety-net that may hide a bug.
- Fix: Set the cap from the rules: `while (walkId && steps <= maxLevel + 1)`.

### BL-M4 — No tracked "refunded amount" per sale
- Files: sales schema [database/02_schema.sql:288-360](database/02_schema.sql:288) has `deposit`, `advance_paid`, `plots_total_price` but no `refunded_amount` or `refunded_at`.
- Impact: When a sale is partially refunded, there's no canonical record. Commission clawback (BL-H4) has no threshold to pro-rate against.
- Fix: Add `refunded_amount numeric(14,2) default 0` + `refunded_at timestamptz`, or a `sale_refund_events` table.

### BL-M5 — Free-form `notes` fields can mutate immutable snapshots
- Files: [database/02_schema.sql:332-338](database/02_schema.sql:332) — `pricing_snapshot`, `fee_snapshot`, `checklist_snapshot`, `commission_rule_snapshot`, `offer_snapshot` are JSONB. Marked "immutable at creation" in comments but no DB constraint enforces it.
- Impact: An admin edit path (e.g., support fixing a typo) can overwrite snapshots, retroactively changing what commissions were computed on.
- Fix: Trigger that refuses UPDATE on those columns unless `status IN ('draft', 'pending_finance')`, or move to an append-only `sale_snapshots` table.

### BL-M6 — Commission idempotency checks existence, not correctness
- Files: [src/lib/db.js:1453-1455 (per AUDIT_RELATIONS_PROBLEMES H2)](../AUDIT_RELATIONS_PROBLEMES.md), `insertCommissionEventsForCompletedSale` gates on "any commission exists for this sale".
- Impact: if the first run created wrong rows (wrong upline), re-running does nothing. Recovery requires SQL.
- Fix: (a) Compute target payload, (b) diff against existing events, (c) insert missing, mark stale as cancelled. Always audit.

---

## 🟢 Low

### BL-L1 — `formatMoneyTnd` vs `fmtMoney` inconsistency
- Files: [src/domain/installmentMetrics.js:106](src/domain/installmentMetrics.js:106) uses `{ minimumFractionDigits: 0, maximumFractionDigits: 2 }`. [src/admin/pages/RecouvrementPage.jsx:19](src/admin/pages/RecouvrementPage.jsx:19) uses `.toLocaleString('fr-FR')` with no options, defaulting to 3 fraction digits (locale default for numbers).
- Impact: same amount rendered differently on different pages. Accounting screenshots don't match.
- Fix: central `formatTND(amount, { minFrac = 0, maxFrac = 2 } = {})` imported everywhere.

### BL-L2 — `SALE_STATUS_META` has no entry for `PENDING` or `SIGNED`
- File: [src/domain/workflowModel.js:24-33](src/domain/workflowModel.js:24) — alias table rewrites `pending→pending_finance`, `signed→pending_legal`, but since alias happens pre-lookup via `canonicalSaleStatus`, these are only missing if a non-canonicalized raw status hits `getSaleStatusMeta`. That fallback `|| { label: canonical || 'Inconnu', badge: 'gray' }` is OK but shows the raw string.
- Fix: explicitly add labels for `'pending'` and `'signed'` as safety nets, or enforce canonicalization at every call site.

### BL-L3 — Chain ordering ties on UUID string comparison
- File: [src/lib/db.js:1615](src/lib/db.js:1615) — `ordered = directSeller ? [directSeller, ...upline] : [...upline]`. Upline is chain order, fine. But if `relations` list is in arbitrary Map-insertion order, and a client has multiple parents (violating `unique(child_client_id)`), the first parent wins non-deterministically.
- Fix: lean on the DB `unique(child_client_id)` constraint (already present per [DB schema:252](database/02_schema.sql:252)) — so this is belt-and-suspenders, low priority.

### BL-L4 — `fmtMoney` in recouvrement drops fractional dinars
- File: [src/admin/pages/RecouvrementPage.jsx:19](src/admin/pages/RecouvrementPage.jsx:19) — `${(Number(v) || 0).toLocaleString('fr-FR')} DT` — locale default is up to 3 fraction digits for numbers. If value is `1234`, renders `1 234`. If value is `1234.5`, renders `1 234,5`. Inconsistent.
- Fix: unify via BL-L1.

---

## Cross-reference / already-captured

The following items are already well-documented in your existing audits and I did **not** duplicate:
- C1 (client uniqueness) → [AUDIT_RELATIONS_PROBLEMES.md C1](../AUDIT_RELATIONS_PROBLEMES.md)
- C2 (auto-heal missing commission migration)
- C3 (no DB trigger for commissions)
- C5 (phone-based sale theft)
- C6 (RPC zero-masking)
- H1–H6, M1–M5, L1 all covered in that doc.
- P0-P3 items in [DEEP_BUG_AUDIT.md](../DEEP_BUG_AUDIT.md) remain the fastest path for engineering triage of hybrid-migration bugs.

My findings above are net-new and independent of those.
