-- =============================================================================
-- ZITOUNA — 06_seed_dev.sql  (dev/test seed — destructive for test data only)
--
-- Purpose: one-shot seed so you never have to manually create super-admin,
-- staff, clients, auth-link, sell & confirm through the UI while testing.
--
-- WORKFLOW (run in Supabase SQL Editor, in this exact order, each time you
-- want a fresh test dataset):
--   1) 01_reset_full.sql      — wipes auth.users + public schema
--   2) 02_schema.sql
--   3) 03_functions.sql
--   4) 04_rls.sql
--   5) 05_seed.sql            — projects, parcels, L1/L2 commission rules, offers
--   6) 06_seed_dev.sql        — THIS FILE (adds admins, 9 clients, ~120 sales)
--
-- Creates:
--   • 2 admin accounts (SUPER_ADMIN + STAFF), email login, password 123456
--   • 9 clients wired to auth (email + phone), password 123456
--   • 4-generation sponsor hierarchy (G1→G2→G3→G4)
--   • L3 + L4 commission rules on every project (05 only seeds L1/L2)
--   • 9 hand-crafted scenario sales (every status, both payment types, all
--     installment states, both plan states)
--   • ~100 additional random sales for volume/UI stress testing
--   • Installment plans + payments for all installment sales
--   • Triggers auto-fire commission_events for sales that reach 'completed'
--
-- Login credentials (printed again at the end via RAISE NOTICE):
--   superadmin@zitouna.dev / 123456   (SUPER_ADMIN)
--   staff@zitouna.dev      / 123456   (STAFF)
--   anis@zitouna.dev       / 123456   (G1 — top of chain, no sponsor)
--   bassem@zitouna.dev     / 123456   (G2 — sponsored by Anis)
--   chaima@zitouna.dev     / 123456   (G3 — sponsored by Bassem)
--   dhia@zitouna.dev       / 123456   (G3 — sponsored by Bassem)
--   emna@zitouna.dev       / 123456   (G4 — sponsored by Chaima)
--   fares@zitouna.dev      / 123456   (G4 — sponsored by Chaima)
--   ghada@zitouna.dev      / 123456   (G4 — sponsored by Dhia)
--   hichem@zitouna.dev     / 123456   (G4 — sponsored by Dhia)
--
-- Phones (E.164) follow the same order: +21620000001 … +21620000010.
-- =============================================================================

create extension if not exists pgcrypto;

do $zit_dev_guard$
begin
  if to_regclass('public.clients') is null
     or to_regclass('public.sales') is null
     or to_regclass('public.admin_users') is null then
    raise exception 'ZITOUNA: run 02_schema.sql → 03_functions.sql → 04_rls.sql before 06_seed_dev.sql.';
  end if;
  if not exists (select 1 from public.projects) then
    raise exception 'ZITOUNA: no projects found — run 05_seed.sql before 06_seed_dev.sql.';
  end if;
end;
$zit_dev_guard$;

-- -----------------------------------------------------------------------------
-- 1. Auth users (Supabase auth.users + auth.identities for email login)
-- -----------------------------------------------------------------------------
-- Password for all: 123456  (bcrypt hashed via pgcrypto's crypt()).
-- Using deterministic UUIDs (via md5 + uuid cast) so clients.auth_user_id can
-- be set in a single pass without RETURNING/lookup gymnastics.
do $zit_dev_auth$
declare
  v_pwd_hash text := crypt('123456', gen_salt('bf', 10));
  r record;
  v_uid uuid;
begin
  for r in
    select * from (values
      ('superadmin@zitouna.dev', 'Super Admin',  '+21620000000'),
      ('staff@zitouna.dev',      'Staff Member', '+21620000100'),
      ('anis@zitouna.dev',       'Anis Ben Ali',   '+21620000001'),
      ('bassem@zitouna.dev',     'Bassem Trabelsi','+21620000002'),
      ('chaima@zitouna.dev',     'Chaima Mejri',   '+21620000003'),
      ('dhia@zitouna.dev',       'Dhia Khalfallah','+21620000004'),
      ('emna@zitouna.dev',       'Emna Gharbi',    '+21620000005'),
      ('fares@zitouna.dev',      'Fares Saidi',    '+21620000006'),
      ('ghada@zitouna.dev',      'Ghada Hamdi',    '+21620000007'),
      ('hichem@zitouna.dev',     'Hichem Jebali',  '+21620000008')
    ) as t(email, full_name, phone)
  loop
    v_uid := ('00000000-0000-4000-8000-' || substr(md5(r.email), 1, 12))::uuid;

    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, email_change,
      email_change_token_new, recovery_token
    )
    values (
      v_uid,
      '00000000-0000-0000-0000-000000000000'::uuid,
      'authenticated',
      'authenticated',
      r.email,
      v_pwd_hash,
      now(),
      jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
      jsonb_build_object('full_name', r.full_name, 'phone', r.phone),
      now(), now(),
      '', '', '', ''
    )
    on conflict (id) do nothing;

    -- auth.identities row for email provider (required for password login)
    insert into auth.identities (
      id, provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    )
    values (
      gen_random_uuid(),
      r.email,
      v_uid,
      jsonb_build_object('sub', v_uid::text, 'email', r.email, 'email_verified', true),
      'email',
      now(), now(), now()
    )
    on conflict do nothing;
  end loop;
end;
$zit_dev_auth$;

-- -----------------------------------------------------------------------------
-- 2. admin_users (SUPER_ADMIN + STAFF), linked to auth.users by email
-- -----------------------------------------------------------------------------
insert into public.admin_users (id, code, full_name, email, phone, phone_normalized, role, status)
values
  (
    ('00000000-0000-4000-8000-' || substr(md5('superadmin@zitouna.dev'), 1, 12))::uuid,
    'ADM-ROOT', 'Super Admin', 'superadmin@zitouna.dev',
    '+216 20 000 000', '+21620000000', 'SUPER_ADMIN', 'active'
  ),
  (
    ('00000000-0000-4000-8000-' || substr(md5('staff@zitouna.dev'), 1, 12))::uuid,
    'ADM-STAFF', 'Staff Member', 'staff@zitouna.dev',
    '+216 20 000 100', '+21620000100', 'STAFF', 'active'
  )
on conflict (email) do nothing;

-- -----------------------------------------------------------------------------
-- 3. clients (G1→G4 hierarchy), auth_user_id pre-linked
-- -----------------------------------------------------------------------------
do $zit_dev_clients$
declare
  v_anis uuid   := ('00000000-0000-4000-8000-' || substr(md5('anis@zitouna.dev'),   1, 12))::uuid;
  v_bassem uuid := ('00000000-0000-4000-8000-' || substr(md5('bassem@zitouna.dev'), 1, 12))::uuid;
  v_chaima uuid := ('00000000-0000-4000-8000-' || substr(md5('chaima@zitouna.dev'), 1, 12))::uuid;
  v_dhia uuid   := ('00000000-0000-4000-8000-' || substr(md5('dhia@zitouna.dev'),   1, 12))::uuid;
  v_emna uuid   := ('00000000-0000-4000-8000-' || substr(md5('emna@zitouna.dev'),   1, 12))::uuid;
  v_fares uuid  := ('00000000-0000-4000-8000-' || substr(md5('fares@zitouna.dev'),  1, 12))::uuid;
  v_ghada uuid  := ('00000000-0000-4000-8000-' || substr(md5('ghada@zitouna.dev'),  1, 12))::uuid;
  v_hichem uuid := ('00000000-0000-4000-8000-' || substr(md5('hichem@zitouna.dev'), 1, 12))::uuid;
  v_anis_cid uuid;
  v_bassem_cid uuid;
  v_chaima_cid uuid;
  v_dhia_cid uuid;
  v_emna_cid uuid;
  v_fares_cid uuid;
  v_ghada_cid uuid;
  v_hichem_cid uuid;
begin
  -- G1
  insert into public.clients (code, full_name, email, phone, phone_normalized,
    referral_code, referred_by_client_id, auth_user_id, seller_enabled, seller_parcel_quota)
  values ('DEV-G1-ANIS', 'Anis Ben Ali', 'anis@zitouna.dev',
    '+216 20 000 001', '+21620000001', 'REF-ANIS', null, v_anis, true, 50)
  on conflict (phone_normalized) do update set auth_user_id = excluded.auth_user_id
  returning id into v_anis_cid;

  -- G2
  insert into public.clients (code, full_name, email, phone, phone_normalized,
    referral_code, referred_by_client_id, auth_user_id, seller_enabled, seller_parcel_quota)
  values ('DEV-G2-BASSEM', 'Bassem Trabelsi', 'bassem@zitouna.dev',
    '+216 20 000 002', '+21620000002', 'REF-BASSEM', v_anis_cid, v_bassem, true, 30)
  on conflict (phone_normalized) do update set auth_user_id = excluded.auth_user_id,
    referred_by_client_id = excluded.referred_by_client_id
  returning id into v_bassem_cid;

  -- G3a
  insert into public.clients (code, full_name, email, phone, phone_normalized,
    referral_code, referred_by_client_id, auth_user_id, seller_enabled, seller_parcel_quota)
  values ('DEV-G3-CHAIMA', 'Chaima Mejri', 'chaima@zitouna.dev',
    '+216 20 000 003', '+21620000003', 'REF-CHAIMA', v_bassem_cid, v_chaima, true, 20)
  on conflict (phone_normalized) do update set auth_user_id = excluded.auth_user_id,
    referred_by_client_id = excluded.referred_by_client_id
  returning id into v_chaima_cid;

  -- G3b
  insert into public.clients (code, full_name, email, phone, phone_normalized,
    referral_code, referred_by_client_id, auth_user_id, seller_enabled, seller_parcel_quota)
  values ('DEV-G3-DHIA', 'Dhia Khalfallah', 'dhia@zitouna.dev',
    '+216 20 000 004', '+21620000004', 'REF-DHIA', v_bassem_cid, v_dhia, true, 20)
  on conflict (phone_normalized) do update set auth_user_id = excluded.auth_user_id,
    referred_by_client_id = excluded.referred_by_client_id
  returning id into v_dhia_cid;

  -- G4
  insert into public.clients (code, full_name, email, phone, phone_normalized,
    referral_code, referred_by_client_id, auth_user_id, seller_enabled, seller_parcel_quota)
  values ('DEV-G4-EMNA', 'Emna Gharbi', 'emna@zitouna.dev',
    '+216 20 000 005', '+21620000005', 'REF-EMNA', v_chaima_cid, v_emna, true, 10)
  on conflict (phone_normalized) do update set auth_user_id = excluded.auth_user_id,
    referred_by_client_id = excluded.referred_by_client_id
  returning id into v_emna_cid;

  insert into public.clients (code, full_name, email, phone, phone_normalized,
    referral_code, referred_by_client_id, auth_user_id, seller_enabled, seller_parcel_quota)
  values ('DEV-G4-FARES', 'Fares Saidi', 'fares@zitouna.dev',
    '+216 20 000 006', '+21620000006', 'REF-FARES', v_chaima_cid, v_fares, false, 0)
  on conflict (phone_normalized) do update set auth_user_id = excluded.auth_user_id,
    referred_by_client_id = excluded.referred_by_client_id
  returning id into v_fares_cid;

  insert into public.clients (code, full_name, email, phone, phone_normalized,
    referral_code, referred_by_client_id, auth_user_id, seller_enabled, seller_parcel_quota)
  values ('DEV-G4-GHADA', 'Ghada Hamdi', 'ghada@zitouna.dev',
    '+216 20 000 007', '+21620000007', 'REF-GHADA', v_dhia_cid, v_ghada, true, 10)
  on conflict (phone_normalized) do update set auth_user_id = excluded.auth_user_id,
    referred_by_client_id = excluded.referred_by_client_id
  returning id into v_ghada_cid;

  insert into public.clients (code, full_name, email, phone, phone_normalized,
    referral_code, referred_by_client_id, auth_user_id, seller_enabled, seller_parcel_quota)
  values ('DEV-G4-HICHEM', 'Hichem Jebali', 'hichem@zitouna.dev',
    '+216 20 000 008', '+21620000008', 'REF-HICHEM', v_dhia_cid, v_hichem, false, 0)
  on conflict (phone_normalized) do update set auth_user_id = excluded.auth_user_id,
    referred_by_client_id = excluded.referred_by_client_id
  returning id into v_hichem_cid;

  -- Seller relations (authoritative hierarchy used by commission walker)
  insert into public.seller_relations (child_client_id, parent_client_id)
  values
    (v_bassem_cid, v_anis_cid),
    (v_chaima_cid, v_bassem_cid),
    (v_dhia_cid,   v_bassem_cid),
    (v_emna_cid,   v_chaima_cid),
    (v_fares_cid,  v_chaima_cid),
    (v_ghada_cid,  v_dhia_cid),
    (v_hichem_cid, v_dhia_cid)
  on conflict (child_client_id) do nothing;
end;
$zit_dev_clients$;

-- -----------------------------------------------------------------------------
-- 4. Extend commission rules to L3 + L4 on every project (05 only seeds L1/L2)
-- -----------------------------------------------------------------------------
insert into public.project_commission_rules (project_id, level, rule_type, value, max_cap_amount)
select p.id, 3, 'fixed', 10, null from public.projects p
on conflict (project_id, level) do nothing;

insert into public.project_commission_rules (project_id, level, rule_type, value, max_cap_amount)
select p.id, 4, 'fixed',  5, null from public.projects p
on conflict (project_id, level) do nothing;

-- -----------------------------------------------------------------------------
-- 5. Hand-crafted scenario sales (9 — every status/payment path)
-- -----------------------------------------------------------------------------
-- Helper: pick next parcel for a project, round-robin across sales (we reuse
-- parcels — schema doesn't enforce unique parcel per sale, good enough for dev).
do $zit_dev_scenarios$
declare
  v_proj_tunis  text := 'tunis';
  v_proj_sousse text := 'sousse';
  v_proj_sfax   text := 'sfax';
  v_proj_nabeul text := 'nabeul';

  v_anis_cid   uuid := (select id from public.clients where phone_normalized='+21620000001');
  v_bassem_cid uuid := (select id from public.clients where phone_normalized='+21620000002');
  v_chaima_cid uuid := (select id from public.clients where phone_normalized='+21620000003');
  v_dhia_cid   uuid := (select id from public.clients where phone_normalized='+21620000004');
  v_emna_cid   uuid := (select id from public.clients where phone_normalized='+21620000005');
  v_fares_cid  uuid := (select id from public.clients where phone_normalized='+21620000006');
  v_ghada_cid  uuid := (select id from public.clients where phone_normalized='+21620000007');
  v_hichem_cid uuid := (select id from public.clients where phone_normalized='+21620000008');

  v_parcel bigint;
  v_sale_id uuid;
  v_plan_id uuid;

  -- Inline row-type: (code, seller, buyer, project, price, payment_type, target_status, with_installments)
  r record;
begin
  for r in
    select * from (values
      ('DEV-SALE-001', v_chaima_cid, v_emna_cid,   v_proj_tunis,  85000, 'full',         'completed',       false),  -- S1 happy path, 4-gen cascade
      ('DEV-SALE-002', v_chaima_cid, v_fares_cid,  v_proj_sousse, 60000, 'installments', 'completed',       true),   -- S2 completed + active plan
      ('DEV-SALE-003', v_dhia_cid,   v_ghada_cid,  v_proj_tunis,  72000, 'full',         'pending_finance', false),  -- S3 stuck at finance
      ('DEV-SALE-004', v_dhia_cid,   v_hichem_cid, v_proj_sousse, 55000, 'installments', 'pending_legal',   false),  -- S4 finance ok, notary pending
      ('DEV-SALE-005', v_bassem_cid, v_chaima_cid, v_proj_sfax,   95000, 'installments', 'active_late',     true),   -- S5 active, plan LATE
      ('DEV-SALE-006', v_anis_cid,   v_bassem_cid, v_proj_tunis,110000, 'full',         'completed',       false),  -- S6 top of chain (short cascade)
      ('DEV-SALE-007', v_chaima_cid, v_emna_cid,   v_proj_nabeul, 78000, 'full',         'cancelled',       false),  -- S7 cancelled
      ('DEV-SALE-008', v_dhia_cid,   v_ghada_cid,  v_proj_tunis,  65000, 'full',         'rejected',        false),  -- S8 rejected by finance
      ('DEV-SALE-009', v_chaima_cid, v_fares_cid,  v_proj_sfax,   45000, 'installments', 'draft',           false)   -- S9 untouched draft
    ) as t(code, seller, buyer, project, price, ptype, target, with_plan)
  loop
    -- Pick any parcel from the project; order by id for determinism
    select id into v_parcel from public.parcels
      where project_id = r.project order by parcel_number limit 1;

    if v_parcel is null then continue; end if;

    -- Insert as draft (check constraint requires notary date for 'completed',
    -- so we always insert draft first then UPDATE status to fire triggers).
    insert into public.sales (
      code, project_id, parcel_id, parcel_ids,
      client_id, seller_client_id,
      payment_type, agreed_price,
      status, pipeline_status
    )
    values (
      r.code, r.project, v_parcel, array[v_parcel]::bigint[],
      r.buyer, r.seller,
      r.ptype::payment_type, r.price,
      'draft', 'draft'
    )
    on conflict (code) do nothing
    returning id into v_sale_id;

    if v_sale_id is null then continue; end if;

    -- Transition to target status + set the right timestamps so triggers fire
    if r.target = 'completed' then
      update public.sales
         set status='completed', pipeline_status='completed',
             finance_confirmed_at = now() - interval '30 days',
             finance_validated_at = now() - interval '30 days',
             juridique_validated_at = now() - interval '20 days',
             legal_sale_contract_signed_at = now() - interval '15 days',
             notary_completed_at = now() - interval '10 days',
             paid_at = case when r.ptype = 'full' then now() - interval '5 days' else null end,
             updated_at = now()
       where id = v_sale_id;
    elsif r.target = 'pending_finance' then
      update public.sales set status='pending_finance', pipeline_status='pending_finance', updated_at = now() where id = v_sale_id;
    elsif r.target = 'pending_legal' then
      update public.sales
         set status='pending_legal', pipeline_status='pending_legal',
             finance_confirmed_at = now() - interval '5 days',
             finance_validated_at = now() - interval '5 days',
             updated_at = now()
       where id = v_sale_id;
    elsif r.target in ('active', 'active_late') then
      update public.sales
         set status='active', pipeline_status='active',
             finance_confirmed_at = now() - interval '60 days',
             finance_validated_at = now() - interval '60 days',
             juridique_validated_at = now() - interval '50 days',
             notary_completed_at = now() - interval '40 days',
             updated_at = now()
       where id = v_sale_id;
    elsif r.target = 'cancelled' then
      update public.sales
         set status='cancelled', pipeline_status='cancelled',
             finance_confirmed_at = now() - interval '20 days',
             updated_at = now()
       where id = v_sale_id;
    elsif r.target = 'rejected' then
      update public.sales
         set status='rejected', pipeline_status='rejected',
             updated_at = now()
       where id = v_sale_id;
    end if;

    -- Installment plan (S2, S4, S5, S9). Only create plan for sales that
    -- actually reached finance confirmation (S2, S5).
    if r.with_plan and r.target in ('completed', 'active', 'active_late') then
      insert into public.installment_plans (
        code, sale_id, client_id, project_id, parcel_id,
        total_price, down_payment, monthly_amount, total_months,
        start_date, status
      )
      values (
        'DEV-PLAN-' || substr(r.code, 10),
        v_sale_id, r.buyer, r.project, v_parcel,
        r.price, r.price * 0.20, (r.price * 0.80) / 24, 24,
        (current_date - interval '6 months')::date,
        case when r.target = 'active_late' then 'late'::plan_status else 'active'::plan_status end
      )
      on conflict (sale_id) do nothing
      returning id into v_plan_id;

      if v_plan_id is not null then
        -- 6 approved past months, 1 submitted, 1 rejected, rest pending
        insert into public.installment_payments (plan_id, month_no, due_date, amount, status, approved_at)
        select
          v_plan_id, m,
          ((current_date - interval '6 months') + (m * interval '1 month'))::date,
          (r.price * 0.80) / 24,
          case
            when m <= 4 then 'approved'::installment_payment_status
            when m = 5 then 'submitted'::installment_payment_status
            when m = 6 then 'rejected'::installment_payment_status
            else 'pending'::installment_payment_status
          end,
          case when m <= 4 then now() - ((6 - m) || ' months')::interval else null end
        from generate_series(1, 24) as m;
      end if;
    end if;

    v_sale_id := null;
  end loop;
end;
$zit_dev_scenarios$;

-- -----------------------------------------------------------------------------
-- 6. Bulk random sales (~100) for volume / UI stress testing
-- -----------------------------------------------------------------------------
-- Random (seller, buyer) pairs from the 9 clients, random project, random
-- status distribution, spread over ~18 months. Uses setseed for reproducibility.
--
-- IMPORTANT: the zitouna_sales_auto_parrainage trigger on public.sales turns
-- every first-time buyer into a filleul of their seller. With random bulk
-- sales this would corrupt the 4-generation hierarchy we just seeded (and can
-- even create A→B→A cycles when two sales are swapped). Disable it for the
-- bulk loop only — re-enable right after. Scenario sales above already ran
-- under the trigger, matching their hand-picked hierarchy.
alter table public.sales disable trigger zitouna_sales_auto_parrainage;

do $zit_dev_bulk$
declare
  v_client_ids uuid[];
  v_projects text[];
  v_n int := 100;
  i int;
  v_seller uuid; v_buyer uuid; v_project text;
  v_price numeric; v_ptype text; v_status text; v_parcel bigint;
  v_sale_id uuid; v_plan_id uuid;
  v_created timestamptz; v_rand float;
begin
  perform setseed(0.42);

  select array_agg(id order by created_at) into v_client_ids from public.clients
    where code like 'DEV-G%';
  select array_agg(id order by id) into v_projects from public.projects;

  if array_length(v_client_ids, 1) is null or array_length(v_projects, 1) is null then
    raise notice 'ZITOUNA: skipping bulk sales (no dev clients or projects).';
    return;
  end if;

  for i in 1..v_n loop
    -- Random seller and buyer (must be distinct)
    v_seller := v_client_ids[1 + (floor(random() * array_length(v_client_ids, 1))::int)];
    loop
      v_buyer := v_client_ids[1 + (floor(random() * array_length(v_client_ids, 1))::int)];
      exit when v_buyer <> v_seller;
    end loop;

    v_project := v_projects[1 + (floor(random() * array_length(v_projects, 1))::int)];
    v_price := (30000 + floor(random() * 120000))::numeric(14,2);
    v_ptype := case when random() < 0.55 then 'installments' else 'full' end;
    v_created := now() - (floor(random() * 540) || ' days')::interval;

    v_rand := random();
    v_status := case
      when v_rand < 0.45 then 'completed'
      when v_rand < 0.60 then 'active'
      when v_rand < 0.72 then 'pending_legal'
      when v_rand < 0.82 then 'pending_finance'
      when v_rand < 0.88 then 'draft'
      when v_rand < 0.94 then 'cancelled'
      else 'rejected'
    end;

    select id into v_parcel from public.parcels
      where project_id = v_project
      order by parcel_number
      offset floor(random() * 20)::int limit 1;
    if v_parcel is null then continue; end if;

    insert into public.sales (
      code, project_id, parcel_id, parcel_ids,
      client_id, seller_client_id,
      payment_type, agreed_price,
      status, pipeline_status,
      created_at, updated_at
    )
    values (
      'DEV-BULK-' || lpad(i::text, 4, '0'),
      v_project, v_parcel, array[v_parcel]::bigint[],
      v_buyer, v_seller,
      v_ptype::payment_type, v_price,
      'draft', 'draft',
      v_created, v_created
    )
    on conflict (code) do nothing
    returning id into v_sale_id;

    if v_sale_id is null then continue; end if;

    -- Transition to target status with appropriate timestamps
    if v_status = 'completed' then
      update public.sales
         set status='completed', pipeline_status='completed',
             finance_confirmed_at = v_created + interval '3 days',
             finance_validated_at = v_created + interval '3 days',
             juridique_validated_at = v_created + interval '7 days',
             legal_sale_contract_signed_at = v_created + interval '10 days',
             notary_completed_at = v_created + interval '14 days',
             paid_at = case when v_ptype='full' then v_created + interval '15 days' else null end,
             updated_at = now()
       where id = v_sale_id;
    elsif v_status = 'active' then
      update public.sales
         set status='active', pipeline_status='active',
             finance_confirmed_at = v_created + interval '3 days',
             finance_validated_at = v_created + interval '3 days',
             juridique_validated_at = v_created + interval '7 days',
             notary_completed_at = v_created + interval '14 days',
             updated_at = now()
       where id = v_sale_id;
    elsif v_status = 'pending_legal' then
      update public.sales
         set status='pending_legal', pipeline_status='pending_legal',
             finance_confirmed_at = v_created + interval '3 days',
             finance_validated_at = v_created + interval '3 days',
             updated_at = now()
       where id = v_sale_id;
    elsif v_status = 'pending_finance' then
      update public.sales set status='pending_finance', pipeline_status='pending_finance', updated_at = now()
        where id = v_sale_id;
    elsif v_status = 'cancelled' then
      update public.sales set status='cancelled', pipeline_status='cancelled', updated_at = now()
        where id = v_sale_id;
    elsif v_status = 'rejected' then
      update public.sales set status='rejected', pipeline_status='rejected', updated_at = now()
        where id = v_sale_id;
    end if;

    -- Installment plan for 'installments' sales that reached notary
    if v_ptype = 'installments' and v_status in ('completed', 'active') then
      insert into public.installment_plans (
        code, sale_id, client_id, project_id, parcel_id,
        total_price, down_payment, monthly_amount, total_months,
        start_date, status
      )
      values (
        'DEV-PLAN-BULK-' || lpad(i::text, 4, '0'),
        v_sale_id, v_buyer, v_project, v_parcel,
        v_price, v_price * 0.20, (v_price * 0.80) / 24, 24,
        (v_created + interval '14 days')::date,
        case when random() < 0.15 then 'late'::plan_status else 'active'::plan_status end
      )
      on conflict (sale_id) do nothing
      returning id into v_plan_id;

      if v_plan_id is not null then
        -- Random number of approved months (0-18)
        insert into public.installment_payments (plan_id, month_no, due_date, amount, status, approved_at)
        select
          v_plan_id, m,
          ((v_created + interval '14 days')::date + ((m - 1) * interval '1 month'))::date,
          (v_price * 0.80) / 24,
          case
            when m <= floor(random() * 18)::int then 'approved'::installment_payment_status
            else 'pending'::installment_payment_status
          end,
          case when m <= floor(random() * 18)::int then v_created + ((14 + 30*m) || ' days')::interval else null end
        from generate_series(1, 24) as m;
      end if;
    end if;

    v_sale_id := null;
  end loop;
end;
$zit_dev_bulk$;

-- Re-enable the parrainage trigger so future real sales still auto-link uplines.
alter table public.sales enable trigger zitouna_sales_auto_parrainage;

-- -----------------------------------------------------------------------------
-- 6b. Heal broken hierarchy + prune stray parrainage
-- -----------------------------------------------------------------------------
-- If this seed file is re-run over an already-polluted DB (or if earlier
-- bulk sales created stray seller_relations rows), reset the hierarchy to the
-- intended 4-generation shape. Scenario sales still run under the trigger so
-- they seed the correct parent chain; this block just enforces it.
do $zit_dev_heal$
declare
  v_anis uuid   := (select id from public.clients where phone_normalized='+21620000001');
  v_bassem uuid := (select id from public.clients where phone_normalized='+21620000002');
  v_chaima uuid := (select id from public.clients where phone_normalized='+21620000003');
  v_dhia uuid   := (select id from public.clients where phone_normalized='+21620000004');
  v_emna uuid   := (select id from public.clients where phone_normalized='+21620000005');
  v_fares uuid  := (select id from public.clients where phone_normalized='+21620000006');
  v_ghada uuid  := (select id from public.clients where phone_normalized='+21620000007');
  v_hichem uuid := (select id from public.clients where phone_normalized='+21620000008');
begin
  -- Delete any seller_relations whose child is one of our G1-G4 clients,
  -- except the intended ones (enforced by re-insert below).
  delete from public.seller_relations
   where child_client_id in (v_bassem, v_chaima, v_dhia, v_emna, v_fares, v_ghada, v_hichem, v_anis);

  -- Re-insert the canonical hierarchy.
  insert into public.seller_relations (child_client_id, parent_client_id)
  values
    (v_bassem, v_anis),
    (v_chaima, v_bassem),
    (v_dhia,   v_bassem),
    (v_emna,   v_chaima),
    (v_fares,  v_chaima),
    (v_ghada,  v_dhia),
    (v_hichem, v_dhia)
  on conflict (child_client_id) do update set parent_client_id = excluded.parent_client_id;

  -- Reset legacy referred_by column too (some views still read it).
  update public.clients set referred_by_client_id = null where id = v_anis;
  update public.clients set referred_by_client_id = v_anis   where id = v_bassem;
  update public.clients set referred_by_client_id = v_bassem where id in (v_chaima, v_dhia);
  update public.clients set referred_by_client_id = v_chaima where id in (v_emna, v_fares);
  update public.clients set referred_by_client_id = v_dhia   where id in (v_ghada, v_hichem);
end;
$zit_dev_heal$;

-- -----------------------------------------------------------------------------
-- 7. Summary + login credentials
-- -----------------------------------------------------------------------------
do $zit_dev_summary$
declare
  v_clients int; v_sales int; v_plans int; v_payments int;
  v_completed int; v_active int; v_pending_fin int; v_pending_leg int;
  v_cancelled int; v_rejected int; v_draft int; v_comms int;
begin
  select count(*) into v_clients from public.clients where code like 'DEV-G%';
  select count(*) into v_sales   from public.sales   where code like 'DEV-%';
  select count(*) into v_plans   from public.installment_plans where code like 'DEV-PLAN-%';
  select count(*) into v_payments from public.installment_payments ip
    join public.installment_plans p on p.id = ip.plan_id
    where p.code like 'DEV-PLAN-%';
  select count(*) into v_completed    from public.sales where code like 'DEV-%' and status='completed';
  select count(*) into v_active       from public.sales where code like 'DEV-%' and status='active';
  select count(*) into v_pending_fin  from public.sales where code like 'DEV-%' and status='pending_finance';
  select count(*) into v_pending_leg  from public.sales where code like 'DEV-%' and status='pending_legal';
  select count(*) into v_cancelled    from public.sales where code like 'DEV-%' and status='cancelled';
  select count(*) into v_rejected     from public.sales where code like 'DEV-%' and status='rejected';
  select count(*) into v_draft        from public.sales where code like 'DEV-%' and status='draft';
  select count(*) into v_comms from public.commission_events ce
    join public.sales s on s.id = ce.sale_id
    where s.code like 'DEV-%';

  raise notice '========================================================';
  raise notice 'ZITOUNA dev seed complete.';
  raise notice '  Clients (G1-G4):          %', v_clients;
  raise notice '  Sales total:              %', v_sales;
  raise notice '    completed:              %', v_completed;
  raise notice '    active:                 %', v_active;
  raise notice '    pending_legal:          %', v_pending_leg;
  raise notice '    pending_finance:        %', v_pending_fin;
  raise notice '    draft:                  %', v_draft;
  raise notice '    cancelled:              %', v_cancelled;
  raise notice '    rejected:               %', v_rejected;
  raise notice '  Installment plans:        %', v_plans;
  raise notice '  Installment payments:     %', v_payments;
  raise notice '  Commission events fired:  %', v_comms;
  raise notice '';
  raise notice 'Login (all password: 123456):';
  raise notice '  superadmin@zitouna.dev   SUPER_ADMIN';
  raise notice '  staff@zitouna.dev        STAFF';
  raise notice '  anis@zitouna.dev         G1 (top of chain)';
  raise notice '  bassem@zitouna.dev       G2 (child of Anis)';
  raise notice '  chaima@zitouna.dev       G3 (child of Bassem)';
  raise notice '  dhia@zitouna.dev         G3 (child of Bassem)';
  raise notice '  emna@zitouna.dev         G4 (child of Chaima)';
  raise notice '  fares@zitouna.dev        G4 (child of Chaima)';
  raise notice '  ghada@zitouna.dev        G4 (child of Dhia)';
  raise notice '  hichem@zitouna.dev       G4 (child of Dhia)';
  raise notice '========================================================';
end;
$zit_dev_summary$;
