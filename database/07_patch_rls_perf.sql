-- ============================================================================
-- RLS performance patch
-- ----------------------------------------------------------------------------
-- Apply this in the Supabase SQL editor on the live project.
--
-- Why: Postgres re-evaluates the USING/WITH CHECK expression for every row.
-- When the expression is a SECURITY DEFINER function (here
-- public.is_active_staff(), public.is_delegated_seller(),
-- public.current_client_id()), the function is executed N times per query,
-- which is the documented root cause of slow RLS on Supabase. Wrapping the
-- call in (SELECT ...) promotes the result to an InitPlan so the function is
-- executed exactly once per statement.
--
-- Safe to re-run. Only the policies for tables that timed out client-side are
-- touched: admin_users, project_offers, sales.
-- ============================================================================

-- admin_users --------------------------------------------------------------
drop policy if exists staff_admin_users_crud on public.admin_users;
create policy staff_admin_users_crud on public.admin_users
  for all to authenticated
  using ((select public.is_active_staff()))
  with check ((select public.is_active_staff()));

-- project_offers -----------------------------------------------------------
drop policy if exists staff_project_offers_crud on public.project_offers;
create policy staff_project_offers_crud on public.project_offers
  for all to authenticated
  using ((select public.is_active_staff()))
  with check ((select public.is_active_staff()));

-- sales --------------------------------------------------------------------
drop policy if exists staff_sales_crud on public.sales;
create policy staff_sales_crud on public.sales
  for all to authenticated
  using ((select public.is_active_staff()))
  with check ((select public.is_active_staff()));

drop policy if exists client_select_own_sales on public.sales;
create policy client_select_own_sales on public.sales
  for select to authenticated
  using (public.sales.client_id = (select public.current_client_id()));

drop policy if exists delegated_sellers_sales_select on public.sales;
create policy delegated_sellers_sales_select on public.sales for select
  to authenticated
  using ((select public.is_delegated_seller()));
