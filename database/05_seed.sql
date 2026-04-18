-- =============================================================================
-- ZITOUNA — 05_seed.sql  (optional)
-- Demo catalogue: 4 projects × 20 parcels + workflow + commission rules +
-- signature checklist + offers + visit slot templates.
-- Staff, clients, and sales are created from the app, not here.
-- Apply after 04_rls.sql.
-- =============================================================================

DO $zit$
BEGIN
  IF to_regclass('public.projects') IS NULL THEN
    RAISE EXCEPTION 'ZITOUNA: run 02_schema.sql before 05_seed.sql.';
  END IF;
END;
$zit$;

-- Projects
insert into public.projects (id, title, city, region, area, year_started, description, map_url)
values
('tunis', 'Projet Olivier — La Marsa',    'Tunis',  'La Marsa',    '15 Ha', 2016, 'Projet principal',
  'https://maps.google.com/maps?q=36.8892,10.3241&t=k&z=14&ie=UTF8&iwloc=&output=embed'),
('sousse','Projet Olivier — El Kantaoui', 'Sousse', 'El Kantaoui', '18 Ha', 2017, 'Projet Sousse',
  'https://maps.google.com/maps?q=35.8834,10.6004&t=k&z=14&ie=UTF8&iwloc=&output=embed'),
('sfax',  'Projet Olivier — Thyna',       'Sfax',   'Thyna',       '12 Ha', 2018, 'Projet Sfax',
  'https://maps.google.com/maps?q=34.7406,10.7603&t=k&z=14&ie=UTF8&iwloc=&output=embed'),
('nabeul','Projet Olivier — Hammamet',    'Nabeul', 'Hammamet',    '14 Ha', 2019, 'Projet Nabeul',
  'https://maps.google.com/maps?q=36.3947,10.6154&t=k&z=14&ie=UTF8&iwloc=&output=embed')
on conflict (id) do nothing;

-- Workflow settings (48h reservation, demo fees, 100 DT payout threshold)
insert into public.project_workflow_settings
  (project_id, reservation_duration_hours, arabon_policy, company_fee_pct, notary_fee_pct, minimum_payout_threshold)
values
('tunis',  48, '{"on_cancel":"configurable"}'::jsonb, 5, 2, 100),
('sousse', 48, '{"on_cancel":"configurable"}'::jsonb, 5, 2, 100),
('sfax',   48, '{"on_cancel":"configurable"}'::jsonb, 5, 2, 100),
('nabeul', 48, '{"on_cancel":"configurable"}'::jsonb, 5, 2, 100)
on conflict (project_id) do nothing;

-- Notary checklist template per project
insert into public.project_signature_checklist_items
  (project_id, item_key, label, required, sort_order, grant_allowed_pages)
values
('tunis',  'contract',        'Contrat de vente principal',           true,  1, null),
('tunis',  'cahier',          'كراس الشروط',                          true,  2, null),
('tunis',  'seller_contract', 'Contrat du vendeur / mandat (opt.)',   false, 3, '["/admin/sell"]'::jsonb),
('sousse', 'contract',        'Contrat de vente principal',           true,  1, null),
('sousse', 'cahier',          'كراس الشروط',                          true,  2, null),
('sousse', 'seller_contract', 'Contrat du vendeur / mandat (opt.)',   false, 3, '["/admin/sell"]'::jsonb),
('sfax',   'contract',        'Contrat de vente principal',           true,  1, null),
('sfax',   'cahier',          'كراس الشروط',                          true,  2, null),
('sfax',   'seller_contract', 'Contrat du vendeur / mandat (opt.)',   false, 3, '["/admin/sell"]'::jsonb),
('nabeul', 'contract',        'Contrat de vente principal',           true,  1, null),
('nabeul', 'cahier',          'كراس الشروط',                          true,  2, null),
('nabeul', 'seller_contract', 'Contrat du vendeur / mandat (opt.)',   false, 3, '["/admin/sell"]'::jsonb)
on conflict (project_id, item_key) do nothing;

-- Commission ladder (L1 = direct seller, L2 = parrain). Tweak from admin UI.
insert into public.project_commission_rules (project_id, level, rule_type, value, max_cap_amount)
values
('tunis',  1, 'fixed', 60, null),
('tunis',  2, 'fixed', 20, null),
('sousse', 1, 'fixed', 60, null),
('sousse', 2, 'fixed', 20, null),
('sfax',   1, 'fixed', 60, null),
('sfax',   2, 'fixed', 20, null),
('nabeul', 1, 'fixed', 60, null),
('nabeul', 2, 'fixed', 20, null)
on conflict (project_id, level) do nothing;

-- 20 parcels per project (generated sequence) + one tree batch per parcel.
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
cross join generate_series(0, 19) as gs(i)
on conflict (project_id, parcel_number) do nothing;

insert into public.parcel_tree_batches (parcel_id, batch_year, tree_count)
select pr.id, extract(year from now())::int, pr.tree_count
from public.parcels pr
where not exists (
  select 1 from public.parcel_tree_batches b
  where b.parcel_id = pr.id and b.batch_year = extract(year from now())::int
);

-- Offers
insert into public.project_offers (project_id, name, price, down_payment_pct, duration_months)
values
('tunis',  'Standard',  72000, 20, 24),
('tunis',  'Confort',   85000, 15, 36),
('sousse', 'Premium',  112500, 10, 60),
('sfax',   'Classique', 55000, 25, 18),
('nabeul', 'Standard',  78000, 20, 24)
on conflict (project_id, name) do nothing;

-- Public "visite" form slot templates
insert into public.visit_slot_options (id, label, hint, sort_order)
values
  ('morning-1',   '09h00 – 11h00', 'Créneau matinal — idéal pour les visites terrain', 1),
  ('morning-2',   '11h00 – 13h00', 'Fin de matinée — soleil optimal',                  2),
  ('afternoon-1', '14h00 – 16h00', 'Début d''après-midi — température agréable',       3),
  ('afternoon-2', '16h00 – 18h00', 'Fin d''après-midi — lumière douce',                4)
on conflict (id) do nothing;

-- ========= Demo referral chain (4 levels) =========
-- Creates a 4-level parrain demo: Abir (root) -> Saif -> Ayoub -> Med.
-- Strictly additive + idempotent: guarded by ON CONFLICT on phone_normalized
-- (clients) and child_client_id (seller_relations). No sales are inserted;
-- the admin creates those via the Sell UI.
do $zit_demo_chain$
declare
  v_abir_id  uuid;
  v_saif_id  uuid;
  v_ayoub_id uuid;
  v_med_id   uuid;
begin
  with ins_abir as (
    insert into public.clients (code, full_name, phone, phone_normalized, referred_by_client_id)
    values ('DEMO-ABIR', 'DEMO Abir', '+216 99 000 001', '+21699000001', null)
    on conflict (phone_normalized) do nothing
    returning id
  )
  select coalesce(
    (select id from ins_abir),
    (select id from public.clients where phone_normalized = '+21699000001')
  ) into v_abir_id;

  with ins_saif as (
    insert into public.clients (code, full_name, phone, phone_normalized, referred_by_client_id)
    values ('DEMO-SAIF', 'DEMO Saif', '+216 99 000 002', '+21699000002', v_abir_id)
    on conflict (phone_normalized) do nothing
    returning id
  )
  select coalesce(
    (select id from ins_saif),
    (select id from public.clients where phone_normalized = '+21699000002')
  ) into v_saif_id;

  with ins_ayoub as (
    insert into public.clients (code, full_name, phone, phone_normalized, referred_by_client_id)
    values ('DEMO-AYOUB', 'DEMO Ayoub', '+216 99 000 003', '+21699000003', v_saif_id)
    on conflict (phone_normalized) do nothing
    returning id
  )
  select coalesce(
    (select id from ins_ayoub),
    (select id from public.clients where phone_normalized = '+21699000003')
  ) into v_ayoub_id;

  with ins_med as (
    insert into public.clients (code, full_name, phone, phone_normalized, referred_by_client_id)
    values ('DEMO-MED', 'DEMO Med', '+216 99 000 004', '+21699000004', v_ayoub_id)
    on conflict (phone_normalized) do nothing
    returning id
  )
  select coalesce(
    (select id from ins_med),
    (select id from public.clients where phone_normalized = '+21699000004')
  ) into v_med_id;

  insert into public.seller_relations (child_client_id, parent_client_id)
  values
    (v_saif_id,  v_abir_id),
    (v_ayoub_id, v_saif_id),
    (v_med_id,   v_ayoub_id)
  on conflict (child_client_id) do nothing;
end;
$zit_demo_chain$;

-- ========= Demo chain extension: 5th level + branches =========
-- Extends the demo tree so the graph visualization has something meaningful:
--   Abir (root)
--    ├── Saif ── Ayoub ── Med ── Nour      (depth 5)
--    ├── Hedi                               (branch)
--    └── Salma                              (branch)
-- Fully idempotent: ON CONFLICT on phone_normalized + child_client_id.
do $zit_demo_chain_ext$
declare
  v_abir_id  uuid;
  v_med_id   uuid;
  v_nour_id  uuid;
  v_hedi_id  uuid;
  v_salma_id uuid;
begin
  select id into v_abir_id from public.clients where phone_normalized = '+21699000001';
  select id into v_med_id  from public.clients where phone_normalized = '+21699000004';

  if v_abir_id is null or v_med_id is null then
    raise notice 'ZITOUNA: base demo chain (Abir/Med) missing — skipping chain extension.';
    return;
  end if;

  -- 5th level: Nour referred by Med
  with ins_nour as (
    insert into public.clients (code, full_name, phone, phone_normalized, referred_by_client_id)
    values ('DEMO-NOUR', 'DEMO Nour', '+216 99 000 005', '+21699000005', v_med_id)
    on conflict (phone_normalized) do nothing
    returning id
  )
  select coalesce(
    (select id from ins_nour),
    (select id from public.clients where phone_normalized = '+21699000005')
  ) into v_nour_id;

  -- Extra branches off Abir: Hedi + Salma
  with ins_hedi as (
    insert into public.clients (code, full_name, phone, phone_normalized, referred_by_client_id)
    values ('DEMO-HEDI', 'DEMO Hedi', '+216 99 000 006', '+21699000006', v_abir_id)
    on conflict (phone_normalized) do nothing
    returning id
  )
  select coalesce(
    (select id from ins_hedi),
    (select id from public.clients where phone_normalized = '+21699000006')
  ) into v_hedi_id;

  with ins_salma as (
    insert into public.clients (code, full_name, phone, phone_normalized, referred_by_client_id)
    values ('DEMO-SALMA', 'DEMO Salma', '+216 99 000 007', '+21699000007', v_abir_id)
    on conflict (phone_normalized) do nothing
    returning id
  )
  select coalesce(
    (select id from ins_salma),
    (select id from public.clients where phone_normalized = '+21699000007')
  ) into v_salma_id;

  insert into public.seller_relations (child_client_id, parent_client_id)
  values
    (v_nour_id,  v_med_id),
    (v_hedi_id,  v_abir_id),
    (v_salma_id, v_abir_id)
  on conflict (child_client_id) do nothing;
end;
$zit_demo_chain_ext$;

-- ========= Demo sales to trigger commissions =========
-- Creates up to 3 scripted sales along the demo chain so the referral
-- commission pipeline has live data:
--   (a) Saif  sells to Ayoub
--   (b) Ayoub sells to Med
--   (c) Med   sells to Nour
-- Each sale:
--   * Uses the first available parcel of "Projet Olivier — La Marsa" (tunis).
--   * agreed_price = 85000, status = 'completed', notary_completed_at = now()
--     (UPDATE after INSERT so the notary commission trigger fires).
--   * Marks the consumed parcel as 'reserved' to avoid double-booking.
-- Fully idempotent: skipped when a sale already exists for the same
-- (seller_client_id, client_id) pair.
do $zit_demo_sales$
declare
  r record;
  v_project_id text;
  v_seller_id  uuid;
  v_buyer_id   uuid;
  v_parcel_id  bigint;
  v_sale_id    uuid;
  v_sale_code  text;
  v_created    int := 0;
  v_skipped    int := 0;
begin
  -- Resolve the demo project by title (fall back to the seeded 'tunis' id).
  select id into v_project_id
  from public.projects
  where title = 'Projet Olivier — La Marsa'
  limit 1;

  if v_project_id is null then
    raise notice 'ZITOUNA: Projet Olivier not found — skipping demo sales.';
    return;
  end if;

  for r in
    select *
    from (values
      ('DEMO-SALE-1', '+21699000002', '+21699000003'),  -- Saif  -> Ayoub
      ('DEMO-SALE-2', '+21699000003', '+21699000004'),  -- Ayoub -> Med
      ('DEMO-SALE-3', '+21699000004', '+21699000005')   -- Med   -> Nour
    ) as t(sale_code, seller_phone, buyer_phone)
  loop
    v_sale_code := r.sale_code;

    select id into v_seller_id
    from public.clients where phone_normalized = r.seller_phone;
    select id into v_buyer_id
    from public.clients where phone_normalized = r.buyer_phone;

    if v_seller_id is null or v_buyer_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Idempotency: one sale per (seller, buyer) pair in this demo dataset.
    if exists (
      select 1 from public.sales
      where seller_client_id = v_seller_id
        and client_id        = v_buyer_id
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Pick the first still-available parcel in the demo project.
    select id into v_parcel_id
    from public.parcels
    where project_id = v_project_id
      and status = 'available'
    order by parcel_number
    limit 1;

    if v_parcel_id is null then
      raise notice 'ZITOUNA: no available parcels left in % for %; skipping.',
        v_project_id, v_sale_code;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Insert sale first with notary_completed_at NULL so the CHECK constraint
    -- (status='completed' => notary_completed_at NOT NULL) is satisfied, then
    -- UPDATE to flip status + set notary timestamp: this is what fires the
    -- trg_sales_notary_commissions trigger.
    insert into public.sales (
      code, project_id, parcel_id, parcel_ids,
      client_id, seller_client_id,
      payment_type, agreed_price,
      status, pipeline_status
    )
    values (
      v_sale_code, v_project_id, v_parcel_id, array[v_parcel_id]::bigint[],
      v_buyer_id, v_seller_id,
      'full'::payment_type, 85000,
      'draft', 'draft'
    )
    returning id into v_sale_id;

    update public.sales
       set status                = 'completed',
           pipeline_status       = 'completed',
           notary_completed_at   = now(),
           finance_confirmed_at  = now(),
           legal_sale_contract_signed_at = now(),
           updated_at            = now()
     where id = v_sale_id;

    -- Reserve the parcel so the next iteration picks a fresh one.
    update public.parcels
       set status = 'reserved'
     where id = v_parcel_id
       and status = 'available';

    v_created := v_created + 1;
  end loop;

  raise notice
    'ZITOUNA demo extension: added up to 3 clients (Nour/Hedi/Salma), extended chain to 5 levels, created % demo sale(s), skipped % (already present or missing prereqs).',
    v_created, v_skipped;
end;
$zit_demo_sales$;
