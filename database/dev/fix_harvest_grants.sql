-- ============================================================================
-- fix_harvest_grants.sql
-- Symptom: "permission denied for table project_harvests" when an admin opens
-- the Récoltes panel. Cause: the harvest-system grants / RLS policies in
-- 04_rls.sql §harvest were never applied to this environment. This file is
-- idempotent — safe to re-run.
-- ============================================================================

-- 1. Enable RLS ---------------------------------------------------------------
alter table public.project_harvests      enable row level security;
alter table public.harvest_distributions enable row level security;
alter table public.project_events        enable row level security;

-- 2. Policies -----------------------------------------------------------------
drop policy if exists public_select_project_harvests on public.project_harvests;
create policy public_select_project_harvests on public.project_harvests
  for select to anon using (true);

drop policy if exists public_select_project_harvests_auth on public.project_harvests;
create policy public_select_project_harvests_auth on public.project_harvests
  for select to authenticated using (true);

drop policy if exists staff_project_harvests_crud on public.project_harvests;
create policy staff_project_harvests_crud on public.project_harvests
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

drop policy if exists staff_harvest_distributions_crud on public.harvest_distributions;
create policy staff_harvest_distributions_crud on public.harvest_distributions
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

drop policy if exists public_select_project_events on public.project_events;
create policy public_select_project_events on public.project_events
  for select to anon using (true);

drop policy if exists public_select_project_events_auth on public.project_events;
create policy public_select_project_events_auth on public.project_events
  for select to authenticated using (true);

drop policy if exists staff_project_events_crud on public.project_events;
create policy staff_project_events_crud on public.project_events
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- 3. Public read-only views (safe column projection) --------------------------
create or replace view public.public_project_harvests as
  select id, project_id, harvest_year, harvest_date, status,
         projected_gross_tnd, actual_kg, actual_gross_tnd,
         costs_tnd, net_tnd, price_per_kg_tnd
    from public.project_harvests;

grant select on public.public_project_harvests to anon, authenticated;

create or replace view public.public_project_events as
  select id, project_id, event_date, kind, title, description, media_urls
    from public.project_events;

grant select on public.public_project_events to anon, authenticated;

-- 4. Table grants -------------------------------------------------------------
grant select, insert, update, delete on public.project_harvests      to authenticated;
grant select, insert, update, delete on public.harvest_distributions to authenticated;
grant select, insert, update, delete on public.project_events        to authenticated;

-- 5. Reload PostgREST schema cache so the app picks up the new privileges.
notify pgrst, 'reload schema';
