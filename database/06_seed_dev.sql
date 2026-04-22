-- =============================================================================
-- ZITOUNA — 06_seed_dev.sql (single-file DEV reset + seed)
-- -----------------------------------------------------------------------------
-- Purpose:
--   Day-to-day ONE FILE reset+seed for development (after core schema is in place).
--
-- What it does:
--   1) Wipes auth users + business/catalog data (destructive, guard-gated)
--   2) Seeds 4 projects (workflow, checklist, commission rules, offers, slots)
--   3) Seeds 20 parcels per project (80 total)
--   4) Seeds 2 SUPER_ADMIN + 2 plain clients for RLS probes (password: 123456)
--      - lassad@gmail.com / saif@gmail.com — SUPER_ADMIN
--      - rls_probe_a@zitouna.test / rls_probe_b@zitouna.test — buyers (not staff)
--
-- IMPORTANT:
--   Run this in the same SQL session after:
--     SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
--
-- Prerequisite (run once before this script):
--   02_schema.sql -> 03_functions.sql -> 04_rls.sql -> 07_hardening.sql -> 08_notifications.sql
--
-- NOTE ON PASSWORD:
--   Supabase GoTrue enforces a minimum password length (default: 6 chars)
--   on BOTH sign-up and sign-in. Earlier versions of this seed tried
--   "13456" (5 chars) which made sign-in fail with "Invalid login
--   credentials" even though the row was in auth.users. Using "134567"
--   (6 chars) clears that policy.
-- =============================================================================

SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';

create extension if not exists pgcrypto;

-- Safety guard
do $guard$
declare v_token text;
begin
  v_token := current_setting('app.allow_destructive_reset', true);
  if v_token is distinct from 'I_UNDERSTAND_THIS_WIPES_DATA' then
    raise exception
      'Blocked. Run first in same session: SET app.allow_destructive_reset = ''I_UNDERSTAND_THIS_WIPES_DATA'';';
  end if;
end;
$guard$;

-- Prerequisite guard
do $pre$
begin
  if to_regclass('public.projects') is null
     or to_regclass('public.parcels') is null
     or to_regclass('public.clients') is null
     or to_regclass('public.admin_users') is null then
    raise exception
      'Core schema missing. Run once: 02_schema.sql -> 03_functions.sql -> 04_rls.sql -> 07_hardening.sql -> 08_notifications.sql';
  end if;
end;
$pre$;

-- -----------------------------------------------------------------------------
-- 1) Clean wipe (auth + business + catalog)
-- -----------------------------------------------------------------------------

-- Drop auth auto-link triggers before deleting public-linked functions/tables.
do $drop_auth_trg$
begin
  drop trigger if exists zitouna_auth_users_autolink_insert on auth.users;
  drop trigger if exists zitouna_auth_users_autolink_update on auth.users;
exception when undefined_table then null;
end;
$drop_auth_trg$;

-- Business data (FK-safe order)
delete from public.commission_payout_request_items;
delete from public.commission_payout_requests;
delete from public.commission_events;

delete from public.installment_payment_receipts;
delete from public.installment_payments;
delete from public.installment_plans;

delete from public.sale_reservation_events;
delete from public.legal_stamps;
delete from public.legal_notices;
delete from public.page_access_grants;
delete from public.sales;

delete from public.seller_parcel_assignments;
delete from public.seller_relations;
delete from public.ambassador_wallets;

delete from public.appointments;
delete from public.audit_logs;
delete from public.data_access_requests;
delete from public.phone_access_otp_codes;
delete from public.phone_access_requests;
delete from public.phone_verifications;
-- Notifications (see 08_notifications.sql): outbox → user_notifications; prefs are separate.
delete from public.notification_outbox;
delete from public.user_notifications;
delete from public.user_notification_prefs;
-- Staff-only error log from 08 (table may be absent on older DBs)
do $zit_notif_err$
begin
  delete from public.notification_errors;
exception when undefined_table then null;
end;
$zit_notif_err$;

delete from public.client_phone_identities;
delete from public.clients;
delete from public.admin_users;

delete from public.project_health_reports;
delete from public.parcel_tree_batches;
delete from public.parcels;
delete from public.project_offers;
delete from public.project_signature_checklist_items;
delete from public.project_commission_rules;
delete from public.project_workflow_settings;
delete from public.projects;
delete from public.visit_slot_options;

-- Auth cleanup
delete from auth.sessions;
delete from auth.refresh_tokens;
do $$
begin
  begin delete from auth.mfa_factors; exception when undefined_table then null; end;
  begin delete from auth.mfa_challenges; exception when undefined_table then null; end;
  begin delete from auth.mfa_amr_claims; exception when undefined_table then null; end;
  begin delete from auth.identities; exception when undefined_table then null; end;
end
$$;
delete from auth.users;

-- -----------------------------------------------------------------------------
-- 2) Projects + workflow + checklist + commission rules
-- -----------------------------------------------------------------------------

insert into public.projects (id, title, city, region, area, year_started, description, map_url)
values
  ('tunis',  'Projet Olivier — La Marsa',    'Tunis',  'La Marsa',    '15 Ha', 2016, 'Catalogue démo',
    'https://maps.google.com/maps?q=36.8892,10.3241&t=k&z=14&ie=UTF8&iwloc=&output=embed'),
  ('sousse', 'Projet Olivier — El Kantaoui', 'Sousse', 'El Kantaoui', '18 Ha', 2017, 'Catalogue démo',
    'https://maps.google.com/maps?q=35.8834,10.6004&t=k&z=14&ie=UTF8&iwloc=&output=embed'),
  ('sfax',   'Projet Olivier — Thyna',       'Sfax',   'Thyna',       '12 Ha', 2018, 'Catalogue démo',
    'https://maps.google.com/maps?q=34.7406,10.7603&t=k&z=14&ie=UTF8&iwloc=&output=embed'),
  ('nabeul', 'Projet Olivier — Hammamet',    'Nabeul', 'Hammamet',    '14 Ha', 2019, 'Catalogue démo',
    'https://maps.google.com/maps?q=36.3947,10.6154&t=k&z=14&ie=UTF8&iwloc=&output=embed');

insert into public.project_workflow_settings
  (project_id, reservation_duration_hours, arabon_policy, company_fee_pct, notary_fee_pct, minimum_payout_threshold)
values
  ('tunis', 48, '{"on_cancel":"configurable"}'::jsonb, 5, 2, 100),
  ('sousse', 48, '{"on_cancel":"configurable"}'::jsonb, 5, 2, 100),
  ('sfax', 48, '{"on_cancel":"configurable"}'::jsonb, 5, 2, 100),
  ('nabeul', 48, '{"on_cancel":"configurable"}'::jsonb, 5, 2, 100);

insert into public.project_signature_checklist_items
  (project_id, item_key, label, required, sort_order, grant_allowed_pages)
values
  ('tunis',  'contract',        'Contrat de vente principal',         true, 1, null),
  ('tunis',  'cahier',          'كراس الشروط',                        true, 2, null),
  ('tunis',  'seller_contract', 'Contrat vendeur / mandat (option)', false, 3, '["/admin/sell"]'::jsonb),
  ('sousse', 'contract',        'Contrat de vente principal',         true, 1, null),
  ('sousse', 'cahier',          'كراس الشروط',                        true, 2, null),
  ('sousse', 'seller_contract', 'Contrat vendeur / mandat (option)', false, 3, '["/admin/sell"]'::jsonb),
  ('sfax',   'contract',        'Contrat de vente principal',         true, 1, null),
  ('sfax',   'cahier',          'كراس الشروط',                        true, 2, null),
  ('sfax',   'seller_contract', 'Contrat vendeur / mandat (option)', false, 3, '["/admin/sell"]'::jsonb),
  ('nabeul', 'contract',        'Contrat de vente principal',         true, 1, null),
  ('nabeul', 'cahier',          'كراس الشروط',                        true, 2, null),
  ('nabeul', 'seller_contract', 'Contrat vendeur / mandat (option)', false, 3, '["/admin/sell"]'::jsonb);

insert into public.project_commission_rules (project_id, level, rule_type, value, max_cap_amount)
values
  ('tunis', 1, 'fixed', 60, null), ('tunis', 2, 'fixed', 20, null),
  ('sousse', 1, 'fixed', 60, null), ('sousse', 2, 'fixed', 20, null),
  ('sfax', 1, 'fixed', 60, null), ('sfax', 2, 'fixed', 20, null),
  ('nabeul', 1, 'fixed', 60, null), ('nabeul', 2, 'fixed', 20, null);

-- -----------------------------------------------------------------------------
-- 3) 20 parcels per project (+ one tree batch each)
-- -----------------------------------------------------------------------------

insert into public.parcels
  (project_id, parcel_number, area_m2, tree_count, total_price, price_per_tree, status, map_url)
select
  p.project_id,
  p.start_no + gs.i,
  (p.base_area_m2 + (gs.i * p.area_step_m2))::numeric(12,2),
  (p.base_tree_count + (gs.i * p.tree_step))::int,
  ((p.base_tree_count + (gs.i * p.tree_step)) * p.price_per_tree)::numeric(14,2),
  p.price_per_tree::numeric(14,2),
  'available'::parcel_status,
  concat(
    'https://maps.google.com/maps?q=',
    (p.lat + (gs.i * 0.0001))::text, ',', (p.lng + (gs.i * 0.0001))::text,
    '&t=k&z=17&ie=UTF8&iwloc=&output=embed'
  )
from (values
  ('tunis',  101, 2500, 120, 50, 2, 600, 36.8782, 10.3247),
  ('sousse', 201, 3000, 150, 50, 2, 750, 35.8968, 10.5965),
  ('sfax',   301, 2200,  95, 50, 2, 579, 34.7398, 10.7600),
  ('nabeul', 401, 2300, 108, 50, 2, 722, 36.4019, 10.6226)
) as p(project_id, start_no, base_area_m2, base_tree_count, area_step_m2, tree_step, price_per_tree, lat, lng)
cross join generate_series(0, 19) as gs(i);

insert into public.parcel_tree_batches (parcel_id, batch_year, tree_count)
select pr.id, extract(year from now())::int, pr.tree_count
from public.parcels pr;

insert into public.project_offers (project_id, name, price, down_payment_pct, duration_months)
values
  ('tunis',  'Standard',  72000, 20, 24),
  ('tunis',  'Confort',   85000, 15, 36),
  ('sousse', 'Premium',  112500, 10, 60),
  ('sfax',   'Classique', 55000, 25, 18),
  ('nabeul', 'Standard',  78000, 20, 24);

insert into public.visit_slot_options (id, label, hint, sort_order)
values
  ('morning-1',   '09h00 – 11h00', 'Créneau matinal', 1),
  ('morning-2',   '11h00 – 13h00', 'Fin de matinée', 2),
  ('afternoon-1', '14h00 – 16h00', 'Début d''après-midi', 3),
  ('afternoon-2', '16h00 – 18h00', 'Fin d''après-midi', 4);

-- -----------------------------------------------------------------------------
-- 3b) Plain client stubs for RLS security probes (linked when auth rows insert)
--     Emails/passwords match defaults in scripts/security/rls-rpc-probe.mjs
-- -----------------------------------------------------------------------------

insert into public.clients (id, code, full_name, email, phone, phone_normalized, status)
values
  (('d0000000-0000-4000-8000-' || substr(md5('rls_probe_a@zitouna.test'),1,12))::uuid,
   'PROBE-A', 'RLS Probe A', 'rls_probe_a@zitouna.test', '+216 30 000 001', '+21630000001', 'active'),
  (('d0000000-0000-4000-8001-' || substr(md5('rls_probe_b@zitouna.test'),1,12))::uuid,
   'PROBE-B', 'RLS Probe B', 'rls_probe_b@zitouna.test', '+216 30 000 002', '+21630000002', 'active');

-- -----------------------------------------------------------------------------
-- 4) SUPER_ADMIN + RLS probe auth accounts (password: 123456) + identities
-- -----------------------------------------------------------------------------

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
select
  ('00000000-0000-4000-8000-' || substr(md5(t.email),1,12))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  t.email,
  crypt('123456', gen_salt('bf', 10)),
  now(),
  jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
  jsonb_build_object('full_name', t.full_name, 'phone', t.phone),
  now(),
  now(),
  '',
  '',
  '',
  ''
from (values
  ('lassad@gmail.com',       'Lassad',    '+216 20 000 001'),
  ('saif@gmail.com',         'Saif',      '+216 20 000 002'),
  ('rls_probe_a@zitouna.test', 'RLS Probe A', '+216 30 000 001'),
  ('rls_probe_b@zitouna.test', 'RLS Probe B', '+216 30 000 002')
) as t(email, full_name, phone);

insert into auth.identities (
  id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  t.email,
  ('00000000-0000-4000-8000-' || substr(md5(t.email),1,12))::uuid,
  jsonb_build_object(
    'sub', ('00000000-0000-4000-8000-' || substr(md5(t.email),1,12)),
    'email', t.email,
    'email_verified', true
  ),
  'email',
  now(),
  now(),
  now()
from (values
  ('lassad@gmail.com'),
  ('saif@gmail.com'),
  ('rls_probe_a@zitouna.test'),
  ('rls_probe_b@zitouna.test')
) as t(email);

-- -----------------------------------------------------------------------------
-- 5) admin_users rows — both SUPER_ADMIN
-- -----------------------------------------------------------------------------

insert into public.admin_users (id, code, full_name, email, phone, phone_normalized, role, status)
values
  (('00000000-0000-4000-8000-' || substr(md5('lassad@gmail.com'),1,12))::uuid,
   'ADM-LASSAD', 'Lassad', 'lassad@gmail.com', '+216 20 000 001', '+21620000001', 'SUPER_ADMIN', 'active'),
  (('00000000-0000-4000-8000-' || substr(md5('saif@gmail.com'),1,12))::uuid,
   'ADM-SAIF',   'Saif',   'saif@gmail.com',   '+216 20 000 002', '+21620000002', 'SUPER_ADMIN', 'active');

-- Recreate auth auto-link triggers for future account creation
do $recreate_auth_trg$
begin
  if exists (
    select 1
    from pg_proc
    where proname = 'trg_auth_users_autolink_clients'
      and pg_function_is_visible(oid)
  ) then
    create trigger zitouna_auth_users_autolink_insert
      after insert on auth.users
      for each row execute function public.trg_auth_users_autolink_clients();
    create trigger zitouna_auth_users_autolink_update
      after update of email, phone, raw_user_meta_data on auth.users
      for each row execute function public.trg_auth_users_autolink_clients();
  end if;
exception when duplicate_object then null;
end;
$recreate_auth_trg$;

-- Final sanity report
select
  'Dev reset+seed complete' as result,
  (select count(*) from public.projects)    as projects,
  (select count(*) from public.parcels)     as parcels,
  (select count(*) from public.project_offers) as offers,
  (select count(*) from auth.users)         as auth_users,
  (select count(*) from public.admin_users) as admin_users,
  (select count(*) from public.clients)     as clients;
