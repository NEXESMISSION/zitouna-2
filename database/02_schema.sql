-- =============================================================================
-- ZITOUNA — 02_schema.sql
-- Tables, enums, indexes, updated_at triggers.
-- Self-contained DDL; run after 01_reset_full.sql (or on an empty DB).
-- Apply: 02_schema.sql → 03_functions.sql → 04_rls.sql → (optional) 05_seed.sql
-- =============================================================================

create extension if not exists "pgcrypto";

-- ========= Enums =========
do $$ begin
  create type app_role as enum ('SUPER_ADMIN','STAFF');
exception when duplicate_object then null; end $$;

do $$ begin
  create type parcel_status as enum ('available','reserved','sold');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_type as enum ('full','installments');
exception when duplicate_object then null; end $$;

do $$ begin
  create type plan_status as enum ('active','late','completed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type installment_payment_status as enum ('pending','submitted','approved','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type appointment_status as enum ('new','pending','confirmed','completed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type appointment_type as enum (
    'visit','signing','followup','legal_signature','finance','juridique'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type commission_event_status as enum ('pending','payable','paid','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payout_request_status as enum ('pending_review','approved','rejected','paid');
exception when duplicate_object then null; end $$;

-- ========= Staff / admin users =========
create table admin_users (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  full_name text not null,
  email text unique not null,
  phone text,
  phone_normalized text unique,
  role app_role not null default 'STAFF',
  status text not null default 'active' check (status in ('active','suspended')),
  manager_id uuid references admin_users(id) on delete set null,
  avatar_url text,
  allowed_pages jsonb,
  allowed_project_ids jsonb,
  allowed_parcel_keys jsonb,
  suspended_at timestamptz,
  suspended_by uuid references admin_users(id) on delete set null,
  suspension_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ========= Projects / parcels / offers =========
create table projects (
  id text primary key,
  title text not null,
  city text not null,
  region text,
  area text,
  year_started int,
  description text,
  map_url text,
  arabon_default numeric(14,2) not null default 50,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table project_workflow_settings (
  project_id text primary key references projects(id) on delete cascade,
  reservation_duration_hours int not null default 48,
  arabon_policy jsonb not null default '{}'::jsonb,
  company_fee_pct numeric(8,4),
  notary_fee_pct numeric(8,4),
  minimum_payout_threshold numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table parcels (
  id bigint generated always as identity primary key,
  project_id text not null references projects(id) on delete cascade,
  parcel_number int not null,
  area_m2 numeric(12,2) not null default 0,
  tree_count int not null default 0,
  total_price numeric(14,2) not null default 0,
  price_per_tree numeric(14,2) not null default 0,
  status parcel_status not null default 'available',
  map_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, parcel_number)
);

create table parcel_tree_batches (
  id bigint generated always as identity primary key,
  parcel_id bigint not null references parcels(id) on delete cascade,
  batch_year int not null,
  tree_count int not null default 0
);

create table project_offers (
  id bigint generated always as identity primary key,
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  price numeric(14,2) not null default 0,
  down_payment_pct numeric(5,2) not null default 0,
  duration_months int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ux_project_offers_project_name on project_offers(project_id, name);

create table project_health_reports (
  id bigint generated always as identity primary key,
  project_id text not null references projects(id) on delete cascade,
  parcel_id bigint references parcels(id) on delete cascade,
  tree_health_pct numeric(5,2) not null default 95,
  humidity_pct numeric(5,2) not null default 65,
  nutrients_pct numeric(5,2) not null default 80,
  co2_tons numeric(10,2) not null default 0,
  status_label text,
  next_action text,
  updated_by uuid references admin_users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique(project_id, parcel_id)
);

create table project_commission_rules (
  id bigint generated always as identity primary key,
  project_id text not null references projects(id) on delete cascade,
  level int not null check (level >= 1),
  rule_type text not null check (rule_type in ('fixed','percent')),
  value numeric(14,4) not null,
  max_cap_amount numeric(14,2),
  active_from date,
  active_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, level)
);

create table project_signature_checklist_items (
  id bigint generated always as identity primary key,
  project_id text not null references projects(id) on delete cascade,
  item_key text not null,
  label text not null,
  required boolean not null default true,
  sort_order int not null default 0,
  grant_allowed_pages jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, item_key)
);

-- ========= Clients =========
create table clients (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  full_name text not null,
  email text unique,
  phone text,
  phone_normalized text unique,
  cin text,
  city text,
  referral_code text unique,
  referred_by_client_id uuid references clients(id) on delete set null,
  owner_agent_id uuid references admin_users(id) on delete set null,
  auth_user_id uuid,
  seller_enabled boolean not null default false,
  seller_parcel_quota int not null default 0,
  seller_parcels_sold_count int not null default 0,
  seller_enabled_at timestamptz,
  seller_enabled_by uuid references admin_users(id) on delete set null,
  status text not null default 'active' check (status in ('active','suspended')),
  suspended_at timestamptz,
  suspended_by uuid references admin_users(id) on delete set null,
  suspension_reason text,
  allowed_pages jsonb,
  allowed_project_ids jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Partial UNIQUE index: one clients row per authenticated auth.users id.
-- Multiple NULLs are allowed (stub clients without an auth account).
create unique index ux_clients_auth_user on clients(auth_user_id) where auth_user_id is not null;
create index idx_clients_phone_norm on clients(phone_normalized) where phone_normalized is not null;

-- ========= Phone identities (canonical linking across auth/client/admin) =========
create table client_phone_identities (
  id uuid primary key default gen_random_uuid(),
  country_code text not null,
  phone_local text not null,
  phone_canonical text unique not null,
  client_id uuid references clients(id) on delete set null,
  auth_user_id uuid,
  admin_user_id uuid references admin_users(id) on delete set null,
  verification_status text not null default 'verified' check (verification_status in ('verified','pending_verification','rejected')),
  verification_reason text,
  verification_ticket text,
  created_by uuid references admin_users(id) on delete set null,
  updated_by uuid references admin_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id),
  unique (auth_user_id)
);
create index idx_client_phone_identities_canonical on client_phone_identities(phone_canonical);
create index idx_client_phone_identities_client on client_phone_identities(client_id);
create index idx_client_phone_identities_auth on client_phone_identities(auth_user_id);

-- O6: phone identity invalidation reason (added idempotently for parallel rollout).
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_phone_identities'
      and column_name = 'invalidation_reason'
  ) then
    alter table public.client_phone_identities
      add column invalidation_reason text;
  end if;
end $$;

-- ========= Seller relations / parcel assignments / wallet =========
create table seller_relations (
  id uuid primary key default gen_random_uuid(),
  child_client_id uuid not null references clients(id) on delete cascade,
  parent_client_id uuid not null references clients(id) on delete restrict,
  source_sale_id uuid,
  linked_at timestamptz not null default now(),
  constraint seller_relations_no_self check (child_client_id <> parent_client_id),
  unique(child_client_id)
);

create index idx_seller_relations_parent on seller_relations(parent_client_id);

create table seller_parcel_assignments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  parcel_id bigint not null references parcels(id) on delete cascade,
  active boolean not null default true,
  note text not null default '',
  assigned_by uuid references admin_users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  revoked_by uuid references admin_users(id) on delete set null,
  revoked_at timestamptz,
  revoked_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_parcel_assignments_revoked_consistency check (
    (active = true and revoked_at is null) or (active = false and revoked_at is not null)
  )
);

create unique index ux_seller_parcel_assignments_active_parcel
  on seller_parcel_assignments(parcel_id) where active = true;
create unique index ux_seller_parcel_assignments_active_client_parcel
  on seller_parcel_assignments(client_id, parcel_id) where active = true;

create table ambassador_wallets (
  client_id uuid primary key references clients(id) on delete cascade,
  balance numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);

-- ========= Sales (immutable snapshots at creation; status is text for flexible pipeline) =========
create table sales (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  project_id text not null references projects(id) on delete restrict,
  parcel_id bigint not null references parcels(id) on delete restrict,
  parcel_ids bigint[] not null default '{}',
  client_id uuid not null references clients(id) on delete restrict,
  payment_type payment_type not null,
  offer_id bigint references project_offers(id) on delete set null,
  agreed_price numeric(14,2) not null default 0,
  deposit numeric(14,2) not null default 0,
  advance_paid numeric(14,2) not null default 0,
  plots_total_price numeric(14,2) not null default 0,
  offer_name text not null default '',
  offer_down_payment_pct numeric(5,2) not null default 0,
  offer_duration_months int not null default 0,
  payment_method text not null default '',
  buyer_phone_normalized text,
  buyer_auth_user_id uuid,
  seller_contract_signed boolean not null default false,
  legal_offer_advance numeric(14,2) not null default 0,
  legal_terms_signed_at timestamptz,
  legal_sale_contract_signed_at timestamptz,
  legal_seller_choice text not null default 'pending',
  legal_seller_signed_at timestamptz,
  legal_seller_notes text not null default '',
  finance_confirmed_at timestamptz,
  finance_validated_by uuid references admin_users(id) on delete set null,
  finance_validated_at timestamptz,
  juridique_validated_by uuid references admin_users(id) on delete set null,
  juridique_validated_at timestamptz,
  coordination_finance_at timestamptz,
  coordination_juridique_at timestamptz,
  coordination_notes text not null default '',
  notary_completed_by uuid references admin_users(id) on delete set null,
  notary_completed_at timestamptz,
  reservation_started_at timestamptz,
  reservation_expires_at timestamptz,
  reservation_status text not null default 'none'
    check (reservation_status in ('none','active','expired_pending_review','released','extended')),
  reservation_released_at timestamptz,
  reservation_release_reason text not null default '',
  post_notary_destination text check (post_notary_destination is null or post_notary_destination in ('plans','cash_sales')),
  config_snapshot_version int not null default 1,
  pricing_snapshot jsonb not null default '{}'::jsonb,
  fee_snapshot jsonb not null default '{}'::jsonb,
  checklist_snapshot jsonb not null default '{}'::jsonb,
  notary_checklist_signed jsonb not null default '{}'::jsonb,
  commission_rule_snapshot jsonb not null default '{}'::jsonb,
  offer_snapshot jsonb not null default '{}'::jsonb,
  ambassador_cin text not null default '',
  notes text,
  status text not null default 'draft',
  pipeline_status text not null default 'draft',
  agent_id uuid references admin_users(id) on delete set null,
  manager_id uuid references admin_users(id) on delete set null,
  ambassador_client_id uuid references clients(id) on delete set null,
  seller_client_id uuid references clients(id) on delete set null,
  stamped_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_ambassador_neq_buyer check (ambassador_client_id is null or ambassador_client_id <> client_id),
  -- A seller cannot also be the buyer on the same sale. Prevents direct-sale
  -- cases from accidentally crediting L1 commissions to the buyer (audit M4)
  -- and catches any future write path that bypasses the application guard in
  -- computeCommissionEventPayloads.
  constraint sales_seller_neq_buyer check (seller_client_id is null or seller_client_id <> client_id)
);

create index idx_sales_project on sales(project_id);
create index idx_sales_client on sales(client_id);
create index idx_sales_agent on sales(agent_id);
create index idx_sales_status on sales(status);
create index idx_sales_buyer_phone on sales(buyer_phone_normalized) where buyer_phone_normalized is not null;
create index idx_sales_reservation_expires on sales(reservation_expires_at) where reservation_expires_at is not null;

alter table seller_relations
  add constraint seller_relations_source_sale_fk foreign key (source_sale_id) references sales(id) on delete set null;

create table sale_reservation_events (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  actor_user_id uuid,
  details text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_sale_reservation_events_sale on sale_reservation_events(sale_id, created_at desc);

-- ========= Installments =========
create table installment_plans (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  sale_id uuid unique not null references sales(id) on delete cascade,
  client_id uuid not null references clients(id) on delete restrict,
  project_id text not null references projects(id) on delete restrict,
  parcel_id bigint not null references parcels(id) on delete restrict,
  total_price numeric(14,2) not null,
  down_payment numeric(14,2) not null default 0,
  monthly_amount numeric(14,2) not null default 0,
  total_months int not null,
  start_date date not null,
  status plan_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table installment_payments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references installment_plans(id) on delete cascade,
  month_no int not null,
  due_date date not null,
  amount numeric(14,2) not null,
  status installment_payment_status not null default 'pending',
  auto_paid_from_wallet boolean not null default false,
  receipt_url text,
  rejected_note text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(plan_id, month_no)
);

create table installment_payment_receipts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references installment_payments(id) on delete cascade,
  receipt_url text not null default '',
  file_name text not null default '',
  note text not null default '',
  created_at timestamptz not null default now()
);

create index idx_installment_payment_receipts_payment on installment_payment_receipts(payment_id);

-- ========= Appointments =========
create table appointments (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  client_id uuid references clients(id) on delete set null,
  project_id text references projects(id) on delete set null,
  sale_id uuid references sales(id) on delete set null,
  type appointment_type not null default 'visit',
  status appointment_status not null default 'new',
  date date not null,
  time time not null,
  notes text,
  team text check (team is null or team in ('finance','juridique','coordination')),
  scheduled_by uuid references admin_users(id) on delete set null,
  created_by uuid references admin_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_appointments_sale on appointments(sale_id) where sale_id is not null;

-- ========= Public visit slot templates =========
create table visit_slot_options (
  id text primary key,
  label text not null,
  hint text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ========= Commissions =========
create table commission_events (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  beneficiary_client_id uuid not null references clients(id) on delete restrict,
  level int not null check (level >= 1),
  rule_snapshot jsonb not null default '{}'::jsonb,
  amount numeric(14,2) not null,
  status commission_event_status not null default 'pending',
  payable_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_commission_events_sale on commission_events(sale_id);
create index idx_commission_events_beneficiary on commission_events(beneficiary_client_id);
create index idx_commission_events_status on commission_events(status);

create table commission_payout_requests (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  beneficiary_client_id uuid not null references clients(id) on delete restrict,
  gross_amount numeric(14,2) not null,
  status payout_request_status not null default 'pending_review',
  reviewed_by uuid references admin_users(id) on delete set null,
  reviewed_at timestamptz,
  review_reason text,
  paid_at timestamptz,
  payment_ref text,
  paid_by uuid references admin_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table commission_payout_request_items (
  request_id uuid not null references commission_payout_requests(id) on delete cascade,
  commission_event_id uuid not null references commission_events(id) on delete restrict,
  primary key (request_id, commission_event_id)
);

-- ========= Page access grants (buyer post-signature access) =========
create table page_access_grants (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  page_key text not null,
  source_sale_id uuid references sales(id) on delete set null,
  source_checklist_key text,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references admin_users(id) on delete set null
);

create unique index ux_page_access_grants_active on page_access_grants(client_id, page_key)
  where revoked_at is null;

-- ========= Audit =========
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references admin_users(id) on delete set null,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  details text,
  metadata jsonb not null default '{}'::jsonb,
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  category text not null default 'business' check (category in ('business','security','auth','data_access','system','governance')),
  source text not null default 'database' check (source in ('database','client','edge','admin_ui')),
  subject_user_id uuid,
  created_at timestamptz not null default now()
);

create index idx_audit_logs_created on audit_logs(created_at desc);
create index idx_audit_logs_subject on audit_logs(subject_user_id) where subject_user_id is not null;

-- ========= Identity / phone verification queues =========
create table data_access_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text not null,
  user_name text not null,
  requested_cin text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  id_document_url text,
  reviewer_id uuid,
  reviewer_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index idx_dar_user on data_access_requests(user_id);

create table phone_access_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text not null,
  user_name text not null,
  requested_phone text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewer_id uuid,
  reviewer_note text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table phone_access_otp_codes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references phone_access_requests(id) on delete cascade,
  otp_code text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table phone_verifications (
  user_id uuid primary key,
  phone text not null,
  verified_at timestamptz not null default now(),
  method text not null default 'otp',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ========= Legal aux =========
create table legal_stamps (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references sales(id) on delete cascade,
  client_name text not null default '',
  project_title text not null default '',
  parcel_id bigint,
  stamped_by text not null default '',
  stamp_date timestamptz not null default now(),
  contract_ref text not null default '',
  notes text default '',
  created_at timestamptz not null default now()
);

create table legal_notices (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references sales(id) on delete set null,
  client_name text not null default '',
  client_email text default '',
  project_title text default '',
  parcel_id bigint,
  notice_type text not null default 'Relance amiable',
  reason text default '',
  missed_months int default 0,
  missed_amount numeric(14,2) default 0,
  status text not null default 'draft',
  sent_at timestamptz,
  resolved_at timestamptz,
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ========= Notifications (Supabase auth.users) =========
create table user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role_scope text not null check (role_scope in ('investor','admin')),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  dedupe_key text unique
);

create index idx_user_notifications_unread on user_notifications(user_id, created_at desc) where read_at is null;

-- ========= updated_at helper + triggers =========
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Normalize admin_users.email to lower(trim(...)) on every write so the
-- is_active_staff() RLS predicate cannot drift because of casing / whitespace.
create or replace function public.normalize_admin_user_email()
returns trigger
language plpgsql
as $$
begin
  if new.email is not null then
    new.email := lower(trim(new.email));
  end if;
  return new;
end;
$$;

create trigger trg_admin_users_email_norm
  before insert or update of email on admin_users
  for each row execute function normalize_admin_user_email();

create trigger trg_admin_users_touch before update on admin_users for each row execute function touch_updated_at();
create trigger trg_projects_touch before update on projects for each row execute function touch_updated_at();
create trigger trg_project_workflow_touch before update on project_workflow_settings for each row execute function touch_updated_at();
create trigger trg_parcels_touch before update on parcels for each row execute function touch_updated_at();
create trigger trg_offers_touch before update on project_offers for each row execute function touch_updated_at();
create trigger trg_project_commission_rules_touch before update on project_commission_rules for each row execute function touch_updated_at();
create trigger trg_project_signature_checklist_touch before update on project_signature_checklist_items for each row execute function touch_updated_at();
create trigger trg_clients_touch before update on clients for each row execute function touch_updated_at();
create trigger trg_client_phone_identities_touch before update on client_phone_identities for each row execute function touch_updated_at();
create trigger trg_seller_parcel_touch before update on seller_parcel_assignments for each row execute function touch_updated_at();
create trigger trg_sales_touch before update on sales for each row execute function touch_updated_at();
create trigger trg_plans_touch before update on installment_plans for each row execute function touch_updated_at();
create trigger trg_plan_payments_touch before update on installment_payments for each row execute function touch_updated_at();
create trigger trg_appointments_touch before update on appointments for each row execute function touch_updated_at();
create trigger trg_commission_events_touch before update on commission_events for each row execute function touch_updated_at();
create trigger trg_commission_payout_req_touch before update on commission_payout_requests for each row execute function touch_updated_at();
create trigger trg_visit_slot_options_touch before update on visit_slot_options for each row execute function touch_updated_at();
create trigger trg_legal_notices_touch before update on legal_notices for each row execute function touch_updated_at();
-- project_health_reports and phone_verifications also carry updated_at columns
-- (audited at 2026-04 — they were missing from the touch wiring above).
create trigger trg_project_health_reports_touch before update on project_health_reports for each row execute function touch_updated_at();
create trigger trg_phone_verifications_touch before update on phone_verifications for each row execute function touch_updated_at();
