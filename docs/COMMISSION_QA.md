# Commission QA Checklist

End-to-end test plan. Pair with [Architecture](./COMMISSION_ARCHITECTURE.md)
and [Runbook](./COMMISSION_RUNBOOK.md).

## 1. Setup

- [ ] Apply `database/01_reset_full.sql` (or `01b_reset_keep_accounts.sql`).
- [ ] Apply `02_schema.sql`.
- [ ] Apply `03_functions.sql` (runs seed + backfill + cleanup).
- [ ] Apply `04_rls.sql`.
- [ ] Apply `05_seed.sql`.
- [ ] Create a test admin and one test project.

## 2. Single sale (L1 only)

- [ ] Abir sells to Saif; mark notary complete.
- [ ] `commission_events` has one row: L1 = Abir, 60 TND.
- [ ] No L2 row (Abir has no parrain).

## 3. Multi-level (L1 + L2)

- [ ] Saif (child of Abir) sells to Ayoub; mark notary complete.
- [ ] L1 = Saif, 60 TND.
- [ ] L2 = Abir, 30 TND (project override).

## 4. Deep chain (L1 -> L5)

- [ ] Seed deeper rules (L1=60, L2=30, L3=20, L4=15, L5=10).
- [ ] Chain Abir -> Saif -> Ayoub -> Med -> Nour. Nour sells.
- [ ] Events: L1 Nour, L2 Med, L3 Ayoub, L4 Saif, L5 Abir.
- [ ] Amounts match seeded rules.

## 5. Idempotence

- [ ] Re-mark notary complete on a processed sale.
- [ ] Row count in `commission_events` unchanged.
- [ ] `cleanup_inconsistent_commission_events()` reports 0 fixes.

## 6. Invariant triggers

- [ ] Insert raw row with level=1 and beneficiary != seller.
- [ ] Expect `ERROR 23514` from `trg_commission_events_validate`.
- [ ] Duplicate `(sale_id, beneficiary_client_id)` raises unique violation.

## 7. Anomaly detection

- [ ] `UPDATE seller_relations` to form a cycle.
- [ ] `select * from detect_parrainage_anomalies();` returns `kind='cycles'`.
- [ ] Banner appears on `/admin/commissions/anomalies`.
- [ ] Fix the edge; RPC returns clean.

## 8. Dashboard UX

- [ ] Ledger differentiates L1 (Vente directe) from L2+ (Parrainage).
- [ ] Breakdown totals match SQL sum grouped by level.
- [ ] Payout history lists requested / approved / paid.

## 9. Admin pages (< 3 s)

- [ ] `/admin/commissions` renders under 3 s.
- [ ] `/admin/finance` renders under 3 s.
- [ ] `/admin/commissions/anomalies` renders under 3 s.
- [ ] `/admin/commission-ledger` renders under 3 s.

## 10. Notifications

- [ ] New sale inserts a `user_notifications` row via
      `trg_commission_events_notify`.
- [ ] Bell badge increments in `NotificationsMenu`.
- [ ] Click-to-mark-read updates `read_at`; badge clears.
