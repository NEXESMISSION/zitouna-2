-- Adds a free-form postal/physical address to projects. Complements the
-- existing city/region split, which is used for filtering and display but
-- is too coarse for things like notary paperwork or client welcome letters.
alter table public.projects
  add column if not exists address text;

-- Defaults for the installment cadence that sales inherit from the project.
-- These feed the Finance / Juridique handoff so every sale starts with the
-- same cadence unless an admin overrides at sell-time.
alter table public.project_workflow_settings
  add column if not exists default_advance_amount numeric(14,2),
  add column if not exists installments_first_due_date date,
  add column if not exists installments_end_date date;
