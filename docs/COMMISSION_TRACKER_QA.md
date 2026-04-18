# Commission Tracker — QA Smoke Test

Fast checklist to validate `/admin/commissions` after a deploy.

## 1. Pre-check

Run in the Supabase SQL editor to confirm source rows exist before touching the UI:

```sql
select count(*) from public.commission_events;
select count(*) from public.seller_relations;
select count(*) from public.clients where referred_by_client_id is not null;
```

All three counts should be greater than zero on a seeded environment. If `seller_relations` is empty but `referred_by_client_id` is not, the backfill has not run yet.

## 2. UI checks

- [ ] `/admin/commissions` loads under 3 seconds on a warm cache.
- [ ] KPI bar shows real numbers (not zero when `commission_events` has rows).
- [ ] Graph renders; global mode shows a forest of disjoint trees.
- [ ] Clicking a node switches the view to `byClient` and shows both the upline and the downline of that client.
- [ ] List filters (search, level, status) narrow the results correctly and can be combined.
- [ ] Clicking an event row opens the detail modal with all 7 sections populated.

## 3. Commission correctness

- [ ] L1 amount equals the `project_commission_rules` row with `level = 1` for the sale's project.
- [ ] L2 amount equals the `level = 2` rule value and only appears when the seller has a parrain.
- [ ] Beneficiaries are distinct: the buyer never receives commission, and the seller is never the L1 beneficiary of their own sale.

## 4. Hang checks

- [ ] `useAmbassadorReferralSummary` resolves within 30 seconds, even on an empty database (no infinite spinner).
- [ ] The dashboard Parrainage tab does not get stuck on "Chargement du portefeuille…".

### Auto-parrainage

- [ ] Create Sale 1: Abir sells to Saif. Check `select * from seller_relations where child_client_id = <Saif>` — expect one row with parent=Abir.
- [ ] Create Sale 2 (next day): Abir sells to Saif AGAIN. `select count(*) from seller_relations where child_client_id = <Saif>` — expect still 1 (no re-parenting).
- [ ] Create Sale 3: Saif sells to Ayoub. Now `seller_relations(Ayoub→Saif)` exists.
- [ ] Complete Sale 3 via Notary. Check `commission_events where sale_id = <Sale3>` — expect 2 rows: L1=Saif, L2=Abir.
