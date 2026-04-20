-- =============================================================================
-- ZITOUNA — 04_rls.sql
-- Row-level security policies (public catalog + private app), baseline grants,
-- and a one-shot auth ↔ client recovery block. Safe to re-run.
-- Apply after 03_functions.sql.
-- =============================================================================

DO $zit$
BEGIN
  IF to_regclass('public.clients') IS NULL THEN
    RAISE EXCEPTION 'ZITOUNA: run 02_schema.sql before 04_rls.sql.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_active_staff'
  ) THEN
    RAISE EXCEPTION 'ZITOUNA: run 03_functions.sql before 04_rls.sql.';
  END IF;
END;
$zit$;

-- ============================================================================
-- Public catalog (anon + authenticated read-only; staff CRUD)
-- ============================================================================

-- projects
alter table public.projects enable row level security;
drop policy if exists public_select_projects on public.projects;
create policy public_select_projects on public.projects
  for select to anon using (true);
drop policy if exists public_select_projects_auth on public.projects;
create policy public_select_projects_auth on public.projects
  for select to authenticated using (true);
drop policy if exists staff_projects_crud on public.projects;
create policy staff_projects_crud on public.projects
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- parcels
alter table public.parcels enable row level security;
drop policy if exists public_select_parcels on public.parcels;
create policy public_select_parcels on public.parcels
  for select to anon using (true);
drop policy if exists public_select_parcels_auth on public.parcels;
create policy public_select_parcels_auth on public.parcels
  for select to authenticated using (true);
drop policy if exists staff_parcels_crud on public.parcels;
create policy staff_parcels_crud on public.parcels
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- parcel_tree_batches
alter table public.parcel_tree_batches enable row level security;
drop policy if exists public_select_parcel_tree_batches on public.parcel_tree_batches;
create policy public_select_parcel_tree_batches on public.parcel_tree_batches
  for select to anon using (true);
drop policy if exists public_select_parcel_tree_batches_auth on public.parcel_tree_batches;
create policy public_select_parcel_tree_batches_auth on public.parcel_tree_batches
  for select to authenticated using (true);
drop policy if exists staff_parcel_tree_batches_crud on public.parcel_tree_batches;
create policy staff_parcel_tree_batches_crud on public.parcel_tree_batches
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- project_offers
alter table public.project_offers enable row level security;
drop policy if exists public_select_project_offers on public.project_offers;
create policy public_select_project_offers on public.project_offers
  for select to anon using (true);
drop policy if exists public_select_project_offers_auth on public.project_offers;
create policy public_select_project_offers_auth on public.project_offers
  for select to authenticated using (true);
drop policy if exists staff_project_offers_crud on public.project_offers;
create policy staff_project_offers_crud on public.project_offers
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- project_workflow_settings, project_signature_checklist_items, project_commission_rules
alter table public.project_workflow_settings enable row level security;
drop policy if exists public_select_project_workflow_settings on public.project_workflow_settings;
create policy public_select_project_workflow_settings on public.project_workflow_settings
  for select to authenticated using (true);
drop policy if exists staff_project_workflow_settings_crud on public.project_workflow_settings;
create policy staff_project_workflow_settings_crud on public.project_workflow_settings
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

alter table public.project_signature_checklist_items enable row level security;
drop policy if exists public_select_project_checklist_items on public.project_signature_checklist_items;
create policy public_select_project_checklist_items on public.project_signature_checklist_items
  for select to authenticated using (true);
drop policy if exists staff_project_checklist_items_crud on public.project_signature_checklist_items;
create policy staff_project_checklist_items_crud on public.project_signature_checklist_items
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

alter table public.project_commission_rules enable row level security;
drop policy if exists public_select_project_commission_rules on public.project_commission_rules;
create policy public_select_project_commission_rules on public.project_commission_rules
  for select to authenticated using (true);
drop policy if exists staff_project_commission_rules_crud on public.project_commission_rules;
create policy staff_project_commission_rules_crud on public.project_commission_rules
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

alter table public.project_health_reports enable row level security;
drop policy if exists public_select_project_health_reports on public.project_health_reports;
create policy public_select_project_health_reports on public.project_health_reports
  for select to authenticated using (true);
drop policy if exists staff_project_health_reports_crud on public.project_health_reports;
create policy staff_project_health_reports_crud on public.project_health_reports
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- visit_slot_options (public form reads + staff CRUD)
alter table public.visit_slot_options enable row level security;
drop policy if exists public_select_visit_slot_options on public.visit_slot_options;
create policy public_select_visit_slot_options on public.visit_slot_options
  for select to anon using (true);
drop policy if exists public_select_visit_slot_options_auth on public.visit_slot_options;
create policy public_select_visit_slot_options_auth on public.visit_slot_options
  for select to authenticated using (true);
drop policy if exists staff_visit_slot_options_crud on public.visit_slot_options;
create policy staff_visit_slot_options_crud on public.visit_slot_options
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- ============================================================================
-- Private app (buyer self-access + staff CRUD)
-- ============================================================================

-- admin_users (staff-only; buyers must not see the staff directory)
alter table public.admin_users enable row level security;
drop policy if exists staff_admin_users_crud on public.admin_users;
create policy staff_admin_users_crud on public.admin_users
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- clients: staff CRUD + buyer self-select / self-insert / safe-self-update
alter table public.clients enable row level security;
drop policy if exists staff_clients_crud on public.clients;
create policy staff_clients_crud on public.clients
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

drop policy if exists client_select_own_profile on public.clients;
create policy client_select_own_profile on public.clients
  for select to authenticated
  using (public.clients.auth_user_id = auth.uid());

drop policy if exists client_insert_own_profile on public.clients;
create policy client_insert_own_profile on public.clients
  for insert to authenticated
  with check (public.clients.auth_user_id = auth.uid());

drop policy if exists client_update_safe_self on public.clients;
create policy client_update_safe_self on public.clients
  for update to authenticated
  using (public.clients.auth_user_id = auth.uid())
  with check (
    public.clients.auth_user_id = auth.uid()
    and public.clients.allowed_pages         is not distinct from (select c.allowed_pages         from public.clients c where c.id = public.clients.id)
    and public.clients.allowed_project_ids   is not distinct from (select c.allowed_project_ids   from public.clients c where c.id = public.clients.id)
    and public.clients.suspended_at          is not distinct from (select c.suspended_at          from public.clients c where c.id = public.clients.id)
    and public.clients.suspended_by          is not distinct from (select c.suspended_by          from public.clients c where c.id = public.clients.id)
    and public.clients.suspension_reason     is not distinct from (select c.suspension_reason     from public.clients c where c.id = public.clients.id)
    and public.clients.status                is not distinct from (select c.status                from public.clients c where c.id = public.clients.id)
    and public.clients.seller_enabled        is not distinct from (select c.seller_enabled        from public.clients c where c.id = public.clients.id)
    and public.clients.seller_parcel_quota   is not distinct from (select c.seller_parcel_quota   from public.clients c where c.id = public.clients.id)
    and public.clients.seller_parcels_sold_count is not distinct from (select c.seller_parcels_sold_count from public.clients c where c.id = public.clients.id)
    and public.clients.seller_enabled_at     is not distinct from (select c.seller_enabled_at     from public.clients c where c.id = public.clients.id)
    and public.clients.seller_enabled_by     is not distinct from (select c.seller_enabled_by     from public.clients c where c.id = public.clients.id)
  );

-- client_phone_identities: self + staff
alter table public.client_phone_identities enable row level security;
drop policy if exists staff_phone_identities_crud on public.client_phone_identities;
create policy staff_phone_identities_crud on public.client_phone_identities
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

drop policy if exists client_select_own_phone_identity on public.client_phone_identities;
create policy client_select_own_phone_identity on public.client_phone_identities
  for select to authenticated
  using (
    public.client_phone_identities.client_id = public.current_client_id()
    or public.client_phone_identities.auth_user_id = auth.uid()
  );

drop policy if exists client_insert_own_phone_identity on public.client_phone_identities;
create policy client_insert_own_phone_identity on public.client_phone_identities
  for insert to authenticated
  with check (public.client_phone_identities.auth_user_id = auth.uid());

drop policy if exists client_update_own_phone_identity on public.client_phone_identities;
create policy client_update_own_phone_identity on public.client_phone_identities
  for update to authenticated
  using (public.client_phone_identities.auth_user_id = auth.uid())
  with check (public.client_phone_identities.auth_user_id = auth.uid());

-- sales
alter table public.sales enable row level security;
drop policy if exists staff_sales_crud on public.sales;
create policy staff_sales_crud on public.sales
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

drop policy if exists client_select_own_sales on public.sales;
create policy client_select_own_sales on public.sales
  for select to authenticated
  using (public.sales.client_id = public.current_client_id());

-- sale_reservation_events (staff-only read/write; derived audit rows)
alter table public.sale_reservation_events enable row level security;
drop policy if exists staff_sale_reservation_events_crud on public.sale_reservation_events;
create policy staff_sale_reservation_events_crud on public.sale_reservation_events
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- installment_plans
alter table public.installment_plans enable row level security;
drop policy if exists staff_plans_crud on public.installment_plans;
create policy staff_plans_crud on public.installment_plans
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

drop policy if exists client_select_own_plans on public.installment_plans;
create policy client_select_own_plans on public.installment_plans
  for select to authenticated
  using (public.installment_plans.client_id = public.current_client_id());

-- installment_payments: self-read + submit-only transitions (approval is staff)
alter table public.installment_payments enable row level security;
drop policy if exists staff_payments_crud on public.installment_payments;
create policy staff_payments_crud on public.installment_payments
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

drop policy if exists client_select_own_payments on public.installment_payments;
create policy client_select_own_payments on public.installment_payments
  for select to authenticated
  using (
    exists (
      select 1 from public.installment_plans p
      where p.id = public.installment_payments.plan_id
        and p.client_id = public.current_client_id()
    )
  );

drop policy if exists client_update_own_payment_submit on public.installment_payments;
create policy client_update_own_payment_submit on public.installment_payments
  for update to authenticated
  using (
    exists (
      select 1 from public.installment_plans p
      where p.id = public.installment_payments.plan_id
        and p.client_id = public.current_client_id()
    )
  )
  with check (
    exists (
      select 1 from public.installment_plans p
      where p.id = public.installment_payments.plan_id
        and p.client_id = public.current_client_id()
    )
    and public.installment_payments.status in ('pending','submitted','rejected')
  );

-- installment_payment_receipts
alter table public.installment_payment_receipts enable row level security;
drop policy if exists staff_receipts_crud on public.installment_payment_receipts;
create policy staff_receipts_crud on public.installment_payment_receipts
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

drop policy if exists client_select_own_receipts on public.installment_payment_receipts;
create policy client_select_own_receipts on public.installment_payment_receipts
  for select to authenticated
  using (
    exists (
      select 1
      from public.installment_payments pm
      join public.installment_plans p on p.id = pm.plan_id
      where pm.id = public.installment_payment_receipts.payment_id
        and p.client_id = public.current_client_id()
    )
  );

drop policy if exists client_insert_own_receipt on public.installment_payment_receipts;
create policy client_insert_own_receipt on public.installment_payment_receipts
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.installment_payments pm
      join public.installment_plans p on p.id = pm.plan_id
      where pm.id = public.installment_payment_receipts.payment_id
        and p.client_id = public.current_client_id()
    )
  );

-- page_access_grants
alter table public.page_access_grants enable row level security;
drop policy if exists staff_page_access_grants_crud on public.page_access_grants;
create policy staff_page_access_grants_crud on public.page_access_grants
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

drop policy if exists client_select_own_grants on public.page_access_grants;
create policy client_select_own_grants on public.page_access_grants
  for select to authenticated
  using (public.page_access_grants.client_id = public.current_client_id());

-- ============================================================================
-- Commissions + payouts + ambassador wallet
-- ============================================================================
alter table public.commission_events enable row level security;
drop policy if exists staff_commission_events_crud on public.commission_events;
create policy staff_commission_events_crud on public.commission_events
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists client_select_own_commission_events on public.commission_events;
create policy client_select_own_commission_events on public.commission_events
  for select to authenticated
  using (public.commission_events.beneficiary_client_id = public.current_client_id());

alter table public.commission_payout_requests enable row level security;
drop policy if exists staff_commission_payout_requests_crud on public.commission_payout_requests;
create policy staff_commission_payout_requests_crud on public.commission_payout_requests
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists client_select_own_payout_requests on public.commission_payout_requests;
create policy client_select_own_payout_requests on public.commission_payout_requests
  for select to authenticated
  using (public.commission_payout_requests.beneficiary_client_id = public.current_client_id());

alter table public.commission_payout_request_items enable row level security;
drop policy if exists staff_commission_payout_items_crud on public.commission_payout_request_items;
create policy staff_commission_payout_items_crud on public.commission_payout_request_items
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists client_select_own_payout_items on public.commission_payout_request_items;
create policy client_select_own_payout_items on public.commission_payout_request_items
  for select to authenticated
  using (
    exists (
      select 1 from public.commission_payout_requests pr
      where pr.id = public.commission_payout_request_items.request_id
        and pr.beneficiary_client_id = public.current_client_id()
    )
  );

alter table public.ambassador_wallets enable row level security;
drop policy if exists staff_ambassador_wallets_crud on public.ambassador_wallets;
create policy staff_ambassador_wallets_crud on public.ambassador_wallets
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists client_select_own_wallet on public.ambassador_wallets;
create policy client_select_own_wallet on public.ambassador_wallets
  for select to authenticated
  using (public.ambassador_wallets.client_id = public.current_client_id());

-- ============================================================================
-- Seller relations / seller parcel assignments
-- ============================================================================
alter table public.seller_relations enable row level security;
drop policy if exists staff_seller_relations_crud on public.seller_relations;
create policy staff_seller_relations_crud on public.seller_relations
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists client_select_own_seller_relations on public.seller_relations;
create policy client_select_own_seller_relations on public.seller_relations
  for select to authenticated
  using (
    public.seller_relations.child_client_id  = public.current_client_id()
    or public.seller_relations.parent_client_id = public.current_client_id()
  );

alter table public.seller_parcel_assignments enable row level security;
drop policy if exists staff_seller_parcel_assignments_crud on public.seller_parcel_assignments;
create policy staff_seller_parcel_assignments_crud on public.seller_parcel_assignments
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists client_select_own_seller_parcel_assignments on public.seller_parcel_assignments;
create policy client_select_own_seller_parcel_assignments on public.seller_parcel_assignments
  for select to authenticated
  using (public.seller_parcel_assignments.client_id = public.current_client_id());

-- ============================================================================
-- Appointments, audit, legal, notifications, verification queues (staff-only)
-- ============================================================================
alter table public.appointments enable row level security;
drop policy if exists staff_appointments_crud on public.appointments;
create policy staff_appointments_crud on public.appointments
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

alter table public.audit_logs enable row level security;
drop policy if exists staff_audit_logs_crud on public.audit_logs;
create policy staff_audit_logs_crud on public.audit_logs
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

alter table public.legal_stamps enable row level security;
drop policy if exists staff_legal_stamps_crud on public.legal_stamps;
create policy staff_legal_stamps_crud on public.legal_stamps
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

alter table public.legal_notices enable row level security;
drop policy if exists staff_legal_notices_crud on public.legal_notices;
create policy staff_legal_notices_crud on public.legal_notices
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

alter table public.data_access_requests enable row level security;
drop policy if exists staff_data_access_requests_crud on public.data_access_requests;
create policy staff_data_access_requests_crud on public.data_access_requests
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists client_select_own_dar on public.data_access_requests;
create policy client_select_own_dar on public.data_access_requests
  for select to authenticated
  using (public.data_access_requests.user_id = auth.uid());
drop policy if exists client_insert_own_dar on public.data_access_requests;
create policy client_insert_own_dar on public.data_access_requests
  for insert to authenticated
  with check (public.data_access_requests.user_id = auth.uid());

alter table public.phone_access_requests enable row level security;
drop policy if exists staff_phone_access_requests_crud on public.phone_access_requests;
create policy staff_phone_access_requests_crud on public.phone_access_requests
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists client_select_own_par on public.phone_access_requests;
create policy client_select_own_par on public.phone_access_requests
  for select to authenticated
  using (public.phone_access_requests.user_id = auth.uid());
drop policy if exists client_insert_own_par on public.phone_access_requests;
create policy client_insert_own_par on public.phone_access_requests
  for insert to authenticated
  with check (public.phone_access_requests.user_id = auth.uid());

alter table public.phone_access_otp_codes enable row level security;
drop policy if exists staff_phone_otp_codes_crud on public.phone_access_otp_codes;
create policy staff_phone_otp_codes_crud on public.phone_access_otp_codes
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

alter table public.phone_verifications enable row level security;
drop policy if exists staff_phone_verifications_crud on public.phone_verifications;
create policy staff_phone_verifications_crud on public.phone_verifications
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists client_select_own_phone_verif on public.phone_verifications;
create policy client_select_own_phone_verif on public.phone_verifications
  for select to authenticated
  using (public.phone_verifications.user_id = auth.uid());

alter table public.user_notifications enable row level security;
drop policy if exists staff_user_notifications_crud on public.user_notifications;
create policy staff_user_notifications_crud on public.user_notifications
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());
drop policy if exists user_select_own_notifications on public.user_notifications;
create policy user_select_own_notifications on public.user_notifications
  for select to authenticated
  using (public.user_notifications.user_id = auth.uid());
drop policy if exists user_update_own_notifications on public.user_notifications;
create policy user_update_own_notifications on public.user_notifications
  for update to authenticated
  using (public.user_notifications.user_id = auth.uid())
  with check (public.user_notifications.user_id = auth.uid());

-- ============================================================================
-- Baseline grants + default privileges
--
-- *** REMOVED *** — see database/09_security_hardening.sql.
-- The blanket GRANTs and ALTER DEFAULT PRIVILEGES that used to live here
-- meant every new table was OPEN-by-default to authenticated/anon (audit
-- ref: 01_SECURITY_FINDINGS.md S-C1). 09 replaces them with explicit
-- per-table grants + REVOKEs the dangerous defaults. service_role still
-- gets ALL via 09 since it's the trusted edge-function key.
--
-- The few explicit per-function grants below stay here because they are
-- pre-existing helpers; future per-function grants belong in 09 too.
-- ============================================================================

-- Explicit grants for critical helpers/RPCs (idempotent; function must exist).
GRANT EXECUTE ON FUNCTION public.current_client_id()                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_client_id_is_ambiguous()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_current_client_profile()                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_active_staff()                                TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_seller_assignments(uuid)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_referral_summary()                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_ambassador_payout(numeric, text)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ambassador_wallet_balance(uuid, numeric) TO authenticated;

-- ============================================================================
-- Auth ↔ client recovery
--
-- *** MOVED *** — see database/10_one_shot_recovery.sql.
-- Bundling this into 04_rls.sql meant it ran on every apply, which is
-- exactly the unattended fuel for the account-hijack vector S-C2 (audit
-- ref: 01_SECURITY_FINDINGS.md S-H4). The new file is one-shot, gated by
-- an explicit SET token, requires email_confirmed_at, and audit-logs
-- every link.
-- ============================================================================

-- ============================================================================
-- Delegated seller policies
--
-- A "delegated seller" is a client whose effective allowed pages (column
-- clients.allowed_pages UNION active page_access_grants) include /admin/sell.
-- They can go through the Sell wizard end-to-end without holding staff
-- rights. Everything is scoped to their own clients.id via
-- current_delegated_seller_client_id() so they cannot touch sales / parcels
-- they don't own.
--
-- These policies are ADDITIVE next to the existing staff_* policies.
-- ============================================================================

-- *** REMOVED *** — see database/09_security_hardening.sql.
-- Previous policy let delegated sellers SELECT every client row (mass
-- PII leak, audit ref: 01_SECURITY_FINDINGS.md S-C3). Replaced by the
-- narrow `lookup_client_for_sale(query)` RPC defined in 09.
drop policy if exists delegated_sellers_clients_select on public.clients;

-- sales: INSERT when attributed to themselves; SELECT and UPDATE their own.
drop policy if exists delegated_sellers_sales_insert on public.sales;
create policy delegated_sellers_sales_insert on public.sales for insert
  to authenticated
  with check (
    public.is_delegated_seller()
    and seller_client_id = public.current_delegated_seller_client_id()
  );

drop policy if exists delegated_sellers_sales_select on public.sales;
create policy delegated_sellers_sales_select on public.sales for select
  to authenticated
  using (
    public.is_delegated_seller()
    and seller_client_id = public.current_delegated_seller_client_id()
  );

drop policy if exists delegated_sellers_sales_update on public.sales;
create policy delegated_sellers_sales_update on public.sales for update
  to authenticated
  using (
    public.is_delegated_seller()
    and seller_client_id = public.current_delegated_seller_client_id()
  )
  with check (
    public.is_delegated_seller()
    and seller_client_id = public.current_delegated_seller_client_id()
  );

-- parcels: SELECT + UPDATE only (for the reserved transition on sale create).
drop policy if exists delegated_sellers_parcels_select on public.parcels;
create policy delegated_sellers_parcels_select on public.parcels for select
  to authenticated
  using (public.is_delegated_seller());

drop policy if exists delegated_sellers_parcels_update on public.parcels;
create policy delegated_sellers_parcels_update on public.parcels for update
  to authenticated
  using (public.is_delegated_seller())
  with check (public.is_delegated_seller() and status in ('reserved','available'));

-- seller_relations: delegated sellers auto-link their upline parrain.
drop policy if exists delegated_sellers_seller_relations_insert on public.seller_relations;
create policy delegated_sellers_seller_relations_insert on public.seller_relations for insert
  to authenticated
  with check (
    public.is_delegated_seller()
    and child_client_id = public.current_delegated_seller_client_id()
  );

drop policy if exists delegated_sellers_seller_relations_select on public.seller_relations;
create policy delegated_sellers_seller_relations_select on public.seller_relations for select
  to authenticated
  using (
    public.is_delegated_seller()
    and child_client_id = public.current_delegated_seller_client_id()
  );

-- sale_reservation_events: append+read for their own sales.
drop policy if exists delegated_sellers_sale_reservation_events_insert on public.sale_reservation_events;
create policy delegated_sellers_sale_reservation_events_insert on public.sale_reservation_events for insert
  to authenticated
  with check (
    public.is_delegated_seller() and exists (
      select 1 from public.sales s
      where s.id = sale_reservation_events.sale_id
        and s.seller_client_id = public.current_delegated_seller_client_id()
    )
  );

drop policy if exists delegated_sellers_sale_reservation_events_select on public.sale_reservation_events;
create policy delegated_sellers_sale_reservation_events_select on public.sale_reservation_events for select
  to authenticated
  using (
    public.is_delegated_seller() and exists (
      select 1 from public.sales s
      where s.id = sale_reservation_events.sale_id
        and s.seller_client_id = public.current_delegated_seller_client_id()
    )
  );

-- audit_logs: delegated sellers (and staff) can append/read audit entries.
drop policy if exists delegated_users_audit_logs_insert on public.audit_logs;
create policy delegated_users_audit_logs_insert on public.audit_logs for insert
  to authenticated
  with check (public.is_delegated_seller() or public.is_active_staff());

drop policy if exists delegated_users_audit_logs_select on public.audit_logs;
create policy delegated_users_audit_logs_select on public.audit_logs for select
  to authenticated
  using (public.is_delegated_seller() or public.is_active_staff());
