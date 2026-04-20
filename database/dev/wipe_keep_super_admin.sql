-- =============================================================================
-- ZITOUNA — dev/wipe_keep_super_admin.sql
-- Wipes ALL business data (sales, clients, projects, catalogue, audit, etc.)
-- and ALL auth users EXCEPT the one super-admin you keep.
--
-- After running, only the super admin remains logged in. Catalogue is empty;
-- reapply 05_seed.sql if you want demo projects.
--
-- Guard: requires SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
-- set in the same query.
-- =============================================================================

SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';

DO $zit_wipe_guard$
DECLARE v_token text;
BEGIN
  v_token := current_setting('app.allow_destructive_reset', true);
  IF v_token IS DISTINCT FROM 'I_UNDERSTAND_THIS_WIPES_DATA' THEN
    RAISE EXCEPTION
      'Wipe blocked. Set app.allow_destructive_reset = ''I_UNDERSTAND_THIS_WIPES_DATA'' first.';
  END IF;
END
$zit_wipe_guard$;

DO $zit_wipe_all$
DECLARE
  -- ── EDIT: email of the super-admin to keep ────────────────────────────────
  v_keep_email text := 'admin@zitouna.com';
  -- ──────────────────────────────────────────────────────────────────────────
  v_keep_email_n text := lower(trim(v_keep_email));
  v_keep_uid uuid;
  v_deleted_users bigint;
BEGIN
  SELECT id INTO v_keep_uid FROM auth.users WHERE lower(email) = v_keep_email_n LIMIT 1;
  IF v_keep_uid IS NULL THEN
    RAISE EXCEPTION 'Super admin % not found in auth.users. Run make_super_admin.sql first.', v_keep_email_n;
  END IF;

  -- 1) Commissions + payouts
  DELETE FROM public.commission_payout_request_items;
  DELETE FROM public.commission_payout_requests;
  DELETE FROM public.commission_events;

  -- 2) Installments (receipts → payments → plans)
  DELETE FROM public.installment_payment_receipts;
  DELETE FROM public.installment_payments;
  DELETE FROM public.installment_plans;

  -- 3) Sale lifecycle
  DELETE FROM public.sale_reservation_events;
  DELETE FROM public.legal_stamps;
  DELETE FROM public.legal_notices;
  DELETE FROM public.page_access_grants;
  DELETE FROM public.sales;

  -- 4) Seller / ambassador structures
  DELETE FROM public.seller_parcel_assignments;
  DELETE FROM public.seller_relations;
  DELETE FROM public.ambassador_wallets;

  -- 5) Appointments, audit, queues, notifications
  DELETE FROM public.appointments;
  DELETE FROM public.audit_logs;
  DELETE FROM public.data_access_requests;
  DELETE FROM public.phone_access_otp_codes;
  DELETE FROM public.phone_access_requests;
  DELETE FROM public.phone_verifications;
  BEGIN DELETE FROM public.user_notifications; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.notification_outbox; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 6) Catalogue (tree batches → parcels → projects; workflow children first)
  DELETE FROM public.project_health_reports;
  DELETE FROM public.parcel_tree_batches;
  DELETE FROM public.parcels;
  DELETE FROM public.project_offers;
  DELETE FROM public.project_signature_checklist_items;
  DELETE FROM public.project_commission_rules;
  DELETE FROM public.project_workflow_settings;
  DELETE FROM public.projects;
  DELETE FROM public.visit_slot_options;

  -- 7) Clients + phone identities (all of them — super admin is in admin_users,
  --    not clients, so nothing here to preserve)
  DELETE FROM public.client_phone_identities;
  UPDATE public.clients SET referred_by_client_id = NULL;
  DELETE FROM public.clients;

  -- 8) admin_users — keep only the super admin
  DELETE FROM public.admin_users WHERE lower(email) <> v_keep_email_n;

  -- 9) auth: wipe every user EXCEPT the super admin (and their sessions)
  --    auth.refresh_tokens.user_id is varchar in Supabase, so cast explicitly.
  DELETE FROM auth.sessions       WHERE user_id <> v_keep_uid;
  DELETE FROM auth.refresh_tokens WHERE user_id <> v_keep_uid::text;
  BEGIN DELETE FROM auth.mfa_factors    WHERE user_id <> v_keep_uid; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM auth.mfa_challenges WHERE factor_id IN (SELECT id FROM auth.mfa_factors); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM auth.mfa_amr_claims WHERE session_id NOT IN (SELECT id FROM auth.sessions); EXCEPTION WHEN undefined_table THEN NULL; END;
  DELETE FROM auth.identities     WHERE user_id <> v_keep_uid;
  DELETE FROM auth.users          WHERE id      <> v_keep_uid;
  GET DIAGNOSTICS v_deleted_users = ROW_COUNT;

  RAISE NOTICE 'Wipe complete.';
  RAISE NOTICE '  super admin kept: %  (uid %)', v_keep_email_n, v_keep_uid;
  RAISE NOTICE '  other auth users deleted: %', v_deleted_users;
  RAISE NOTICE '  all business tables are now empty.';
END
$zit_wipe_all$;
