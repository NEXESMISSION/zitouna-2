# Security Rollout Checklist

This runbook applies the security hardening safely and verifies that protections are active.

## 1) Pre-checks (required)

- Ensure you are connected to the correct Supabase project (prod vs staging).
- Take a database backup/snapshot before applying security migrations.
- Make sure at least one known admin email exists in `public.admin_users` with `status='active'`.

Quick pre-check query:

```sql
select id, email, role, status
from public.admin_users
order by created_at desc
limit 20;
```

## 2) Apply migrations in safe order

Apply these SQL files in this order:

1. `database/migrations/008_installment_receipts_history.sql`
2. `database/migrations/009_enable_realtime_installments.sql`
3. `database/migrations/010_realtime_indexes.sql`
4. `database/migrations/011_security_hardening.sql`

Notes:
- `006_schema_fixes.sql` no longer toggles RLS and is safe from lockout windows.
- Do **not** run reset/cleanup migrations (`003`, `007`) in production unless explicitly needed and with `app.allow_destructive_migrations=true`.

## 3) Post-apply verification

### A) RLS enabled on protected tables

```sql
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'admin_users','clients','sales','installment_plans','installment_payments',
    'installment_payment_receipts','data_access_requests','audit_logs',
    'commissions','payouts','legal_stamps','legal_notices','appointments','visit_requests',
    'projects','parcels','parcel_tree_batches','project_offers','project_health_reports'
  )
order by tablename;
```

Expected: `rowsecurity = true` for all rows returned.

### B) Policies exist

```sql
select schemaname, tablename, policyname, permissive, roles, cmd
from pg_policies
where schemaname in ('public', 'storage')
order by schemaname, tablename, policyname;
```

Expected: includes policies from `011_security_hardening.sql` (admin/owner/public/storage).

### C) Receipt bucket is private

```sql
select id, name, public
from storage.buckets
where id = 'installment-receipts';
```

Expected: `public = false`.

### D) Realtime publication scope present

```sql
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in ('installment_plans','installment_payments','installment_payment_receipts')
order by tablename;
```

Expected: three rows present.

## 4) Functional smoke test (must pass)

1. Non-admin user:
   - cannot access `/admin/*`
   - cannot read another client's installment/sales data
2. Admin user (`status='active'`):
   - can access admin pages
   - can approve/reject installment flows
3. Suspended admin (`status='suspended'`):
   - cannot access admin routes
4. Receipts:
   - upload works
   - URLs displayed in UI are signed/time-limited, not permanently public links

## 5) Rollback plan (if needed)

- Revert app deployment to previous known-good build.
- Restore DB backup/snapshot if policy rollout causes broad access failures.
- If emergency access is needed, adjust only the specific failing policy, do not disable RLS globally.

