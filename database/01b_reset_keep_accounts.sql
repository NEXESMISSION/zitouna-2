-- =============================================================================
-- ZITOUNA — 01b_reset_keep_accounts.sql
-- Soft reset: wipes all business data (sales, installments, commissions,
-- catalogue, audit) but preserves:
--   - auth.users
--   - public.admin_users (staff)
--   - public.clients where auth_user_id IS NOT NULL (linked accounts)
--
-- After running, re-seed the catalogue with 05_seed.sql if needed.
-- Does NOT touch Supabase Storage (clear buckets from the dashboard).
-- =============================================================================

-- 1) Commission / payouts (FK order)
DELETE FROM public.commission_payout_request_items;
DELETE FROM public.commission_payout_requests;
DELETE FROM public.commission_events;

-- 2) Installments
DELETE FROM public.installment_payment_receipts;
DELETE FROM public.installment_payments;
DELETE FROM public.installment_plans;

-- 3) Sales lifecycle
DELETE FROM public.sale_reservation_events;
DELETE FROM public.legal_stamps;
DELETE FROM public.legal_notices;
DELETE FROM public.page_access_grants;
DELETE FROM public.sales;

-- 4) Seller / ambassador structures
DELETE FROM public.seller_parcel_assignments;
DELETE FROM public.seller_relations;
DELETE FROM public.ambassador_wallets;

-- 5) Appointments, audit, queues
DELETE FROM public.appointments;
DELETE FROM public.audit_logs;
DELETE FROM public.data_access_requests;
DELETE FROM public.phone_access_otp_codes;
DELETE FROM public.phone_access_requests;
DELETE FROM public.phone_verifications;
DELETE FROM public.user_notifications;

-- 6) Catalogue
DELETE FROM public.project_health_reports;
DELETE FROM public.parcel_tree_batches;
DELETE FROM public.parcels;
DELETE FROM public.project_offers;
DELETE FROM public.project_signature_checklist_items;
DELETE FROM public.project_commission_rules;
DELETE FROM public.project_workflow_settings;
DELETE FROM public.projects;
DELETE FROM public.visit_slot_options;

-- 7) Client stubs (no auth binding) + their phone identities
DELETE FROM public.client_phone_identities
WHERE client_id IN (SELECT id FROM public.clients WHERE auth_user_id IS NULL);

UPDATE public.clients
SET referred_by_client_id = NULL
WHERE referred_by_client_id IN (SELECT id FROM public.clients WHERE auth_user_id IS NULL);

DELETE FROM public.clients WHERE auth_user_id IS NULL;

-- 8) Reset business fields on preserved investor profiles
UPDATE public.clients
SET
  seller_enabled = false,
  seller_parcel_quota = 0,
  seller_parcels_sold_count = 0,
  seller_enabled_at = NULL,
  seller_enabled_by = NULL,
  referred_by_client_id = NULL,
  owner_agent_id = NULL,
  allowed_pages = NULL,
  allowed_project_ids = NULL,
  updated_at = now()
WHERE auth_user_id IS NOT NULL;
