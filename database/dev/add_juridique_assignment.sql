-- ════════════════════════════════════════════════════════════════════════
-- add_juridique_assignment.sql
-- Adds the per-sale juridique assignee column. Coordination picks one
-- admin user per file when scheduling the juridique RDV; only that user
-- (and Super Admin) sees it on /admin/juridique.
--
-- Idempotent — safe to run on prod even if the column already exists.
-- Apply with: psql $DATABASE_URL -f database/dev/add_juridique_assignment.sql
-- ════════════════════════════════════════════════════════════════════════

alter table public.sales
  add column if not exists juridique_user_id uuid references public.admin_users(id) on delete set null;

create index if not exists sales_juridique_user_id_idx
  on public.sales (juridique_user_id)
  where juridique_user_id is not null;

comment on column public.sales.juridique_user_id is
  'Admin user (juridique team) assigned to this sale. Only that user — and Super Admin — sees the file on /admin/juridique. Picked in /admin/coordination when scheduling the juridique RDV. NULL = unassigned (visible to Super Admin only).';
