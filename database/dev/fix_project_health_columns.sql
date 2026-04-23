-- ============================================================================
-- fix_project_health_columns.sql
-- Symptom: editing "Santé du projet" in /admin saves appear to succeed, but the
-- /project/:id page keeps showing the old values (95 / 65 / 80). These three
-- numbers match the *defaults* hard-coded elsewhere in the frontend, which
-- means the `projects.tree_health_pct`, `.soil_humidity_pct`, `.nutrients_pct`
-- columns are missing on this environment — PostgREST silently drops the
-- three unknown keys on upsert and the row never changes.
--
-- This file is idempotent — safe to re-run.
-- ============================================================================

alter table public.projects
  add column if not exists total_trees        int,
  add column if not exists tree_health_pct    smallint check (tree_health_pct between 0 and 100),
  add column if not exists soil_humidity_pct  smallint check (soil_humidity_pct between 0 and 100),
  add column if not exists nutrients_pct      smallint check (nutrients_pct between 0 and 100),
  add column if not exists tree_batches       jsonb not null default '[]'::jsonb;

-- Reload the PostgREST schema cache so the API knows the new columns exist.
notify pgrst, 'reload schema';
