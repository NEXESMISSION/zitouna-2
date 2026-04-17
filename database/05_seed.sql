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
