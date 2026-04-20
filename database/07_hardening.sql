-- =============================================================================
-- ZITOUNA — 07_hardening.sql
-- Consolidated hardening pass. Replaces the prior split files
-- (07_patch_rls_perf.sql, 09_security_hardening.sql, 11_database_hardening.sql).
--
-- Apply AFTER 02_schema.sql + 03_functions.sql + 04_rls.sql + (05/06 seed).
-- Apply BEFORE 08_notifications.sql.
--
-- Sections:
--   A. RLS index + policy perf patch       (was 07_patch_rls_perf.sql)
--   B. Security hardening — grants, views,
--      lookup RPC, MFA scaffold            (was 09_security_hardening.sql)
--   C. Database hardening — CHECKs, FKs,
--      triggers, retention helpers         (was 11_database_hardening.sql)
--
-- Each section is idempotent and safe to re-run individually.
-- Audit refs: docs/AUDIT/01_SECURITY_FINDINGS.md, 02_DATABASE_RLS_FINDINGS.md.
-- =============================================================================

-- ============================================================================
-- ===== SECTION A — RLS index + policy perf patch ===========================
-- ============================================================================
-- ============================================================================
-- RLS performance patch
-- ----------------------------------------------------------------------------
-- Apply this in the Supabase SQL editor on the live project.
--
-- Why: Postgres re-evaluates the USING/WITH CHECK expression for every row.
-- When the expression is a SECURITY DEFINER function (here
-- public.is_active_staff(), public.is_delegated_seller(),
-- public.current_client_id()), the function is executed N times per query,
-- which is the documented root cause of slow RLS on Supabase. Wrapping the
-- call in (SELECT ...) promotes the result to an InitPlan so the function is
-- executed exactly once per statement.
--
-- Safe to re-run. Only the policies for tables that timed out client-side are
-- touched: admin_users, project_offers, sales.
-- ============================================================================

-- admin_users --------------------------------------------------------------
drop policy if exists staff_admin_users_crud on public.admin_users;
create policy staff_admin_users_crud on public.admin_users
  for all to authenticated
  using ((select public.is_active_staff()))
  with check ((select public.is_active_staff()));

-- project_offers -----------------------------------------------------------
drop policy if exists staff_project_offers_crud on public.project_offers;
create policy staff_project_offers_crud on public.project_offers
  for all to authenticated
  using ((select public.is_active_staff()))
  with check ((select public.is_active_staff()));

-- sales --------------------------------------------------------------------
drop policy if exists staff_sales_crud on public.sales;
create policy staff_sales_crud on public.sales
  for all to authenticated
  using ((select public.is_active_staff()))
  with check ((select public.is_active_staff()));

drop policy if exists client_select_own_sales on public.sales;
create policy client_select_own_sales on public.sales
  for select to authenticated
  using (public.sales.client_id = (select public.current_client_id()));

drop policy if exists delegated_sellers_sales_select on public.sales;
create policy delegated_sellers_sales_select on public.sales for select
  to authenticated
  using ((select public.is_delegated_seller()));

-- ============================================================================
-- ===== SECTION B — Security hardening (grants, views, lookup RPC, MFA) =====
-- ============================================================================
-- =============================================================================
-- ZITOUNA — 09_security_hardening.sql
-- Closes the critical/high findings from docs/AUDIT/01_SECURITY_FINDINGS.md
-- that live in the database layer. Idempotent and safe to re-run.
--
-- Apply AFTER 02 → 03 → 04 → (05/06) → 07 → 08.
--
-- Coverage:
--   S-C1  — Replace blanket GRANTs with per-table grants. REVOKE anon
--           function execute. Drop ALTER DEFAULT PRIVILEGES so future
--           tables / functions are CLOSED-by-default.
--   S-C3  — Drop delegated_sellers_clients_select. Add a narrow lookup
--           RPC that lets the Sell wizard find a buyer by phone/email
--           WITHOUT granting the seller blanket SELECT on every client.
--   S-C5  — Tighten the anon-readable catalog: only `available` parcels
--           and active offers are exposed; raw pricing tables are
--           authenticated-only.
--   S-H3  — Scaffold for 2FA enforcement: admin_users.mfa_enrolled
--           column + helper. UI gating ships in a follow-up; column
--           defaults to false so nothing breaks today.
--   S-H6  — Document table↔guard mapping (see comment at end of file).
-- =============================================================================

DO $zit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_active_staff'
  ) THEN
    RAISE EXCEPTION 'ZITOUNA 09: run 03_functions.sql + 04_rls.sql first.';
  END IF;
END;
$zit$;

-- ============================================================================
-- 1. S-C1 — REVOKE blanket grants and ALTER DEFAULT PRIVILEGES so the
--    database is closed-by-default for any future table / function.
-- ============================================================================

REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public FROM authenticated;
REVOKE SELECT                            ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE EXECUTE                           ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE EXECUTE                           ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
REVOKE USAGE, SELECT                     ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Strip the OPEN-by-default ALTER DEFAULT PRIVILEGES previously set in
-- 04_rls.sql so any new table / function is CLOSED-by-default. We re-grant
-- the bits the app needs explicitly below. Wrapped in a DO block because
-- ALTER DEFAULT PRIVILEGES errors if the role can't be SET ROLE'd to.
DO $zit_def$
BEGIN
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE USAGE, SELECT ON SEQUENCES FROM authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM authenticated;

  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE SELECT ON TABLES FROM anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE USAGE, SELECT ON SEQUENCES FROM anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM anon;
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$zit_def$;

-- ============================================================================
-- 2. Per-table re-grant for `authenticated`. RLS still gates every row;
--    the grant is just the raw "is the role allowed to issue this verb"
--    permission. Adding a new table requires a one-line addition here —
--    that friction is the point.
-- ============================================================================

-- Schema usage (mandatory baseline)
GRANT USAGE ON SCHEMA public TO authenticated, anon;

-- Catalog tables (authenticated read+staff CRUD via RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects                          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_workflow_settings         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.parcels                           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.parcel_tree_batches               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_offers                    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_health_reports            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_commission_rules          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_signature_checklist_items TO authenticated;

-- Identity / accounts
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_users                       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients                           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_phone_identities           TO authenticated;

-- Sales
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales                             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_reservation_events           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.installment_plans                 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.installment_payments              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.installment_payment_receipts      TO authenticated;

-- Appointments + visit slots
GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointments                      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.visit_slot_options                TO authenticated;

-- Commissions
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commission_events                 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commission_payout_requests        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commission_payout_request_items   TO authenticated;

-- Seller / wallet / parrainage
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seller_relations                  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seller_parcel_assignments         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ambassador_wallets                TO authenticated;

-- Misc business
GRANT SELECT, INSERT, UPDATE, DELETE ON public.page_access_grants                TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_logs                        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_stamps                      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_notices                     TO authenticated;

-- Identity / phone verification queues (SELECT only for non-staff via RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.data_access_requests              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.phone_access_requests             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.phone_access_otp_codes            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.phone_verifications               TO authenticated;

-- Notifications (tables are created by 08_notifications.sql — skip silently if
-- 07 is applied before 08; 08 re-grants idempotently via its own block).
DO $notif_grants$
BEGIN
  IF to_regclass('public.user_notifications')      IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notifications      TO authenticated';
  END IF;
  IF to_regclass('public.notification_channels')   IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_channels   TO authenticated';
  END IF;
  IF to_regclass('public.user_notification_prefs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notification_prefs TO authenticated';
  END IF;
  IF to_regclass('public.notification_outbox')     IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_outbox     TO authenticated';
  END IF;
END;
$notif_grants$;

-- Sequences — every identity column needs USAGE/SELECT for inserts.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- service_role keeps full access (used by edge functions / workers only).
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- ============================================================================
-- 3. S-C5 — Tighten anon (unauthenticated) access. The previous
--    `using (true)` policies + blanket SELECT grant let scrapers exfiltrate
--    the whole portfolio with one anon-key request. We:
--      • Restrict anon access on sensitive raw tables to nothing.
--      • Expose a narrow set of public views that carry only what the
--        public marketing site actually needs.
--      • Keep `projects` SELECT on the raw table because the public
--        catalog still reads it directly today; the policy is unchanged
--        but you can swap to a view in a follow-up.
-- ============================================================================

-- Drop anon SELECT policies that leak internal pricing & reservation state.
DROP POLICY IF EXISTS public_select_parcels             ON public.parcels;
DROP POLICY IF EXISTS public_select_parcel_tree_batches ON public.parcel_tree_batches;
DROP POLICY IF EXISTS public_select_offers              ON public.project_offers;
DROP POLICY IF EXISTS public_select_visit_slot_options  ON public.visit_slot_options;

-- Public views: column-narrowed projections of the raw tables. Use these
-- from the public marketing pages (BrowsePage / ProjectPage) — they carry
-- only what's safe to publish.
CREATE OR REPLACE VIEW public.public_parcels AS
  SELECT id,
         project_id,
         parcel_number,
         ('Parcelle ' || parcel_number::text) AS label,
         area_m2,
         tree_count,
         total_price, price_per_tree, status, map_url
    FROM public.parcels
   WHERE status = 'available';

CREATE OR REPLACE VIEW public.public_offers AS
  SELECT id, project_id, name, price, down_payment_pct, duration_months
    FROM public.project_offers;

CREATE OR REPLACE VIEW public.public_parcel_tree_batches AS
  SELECT id, parcel_id, batch_year, tree_count
    FROM public.parcel_tree_batches
   WHERE parcel_id IN (SELECT id FROM public.parcels WHERE status = 'available');

CREATE OR REPLACE VIEW public.public_visit_slots AS
  SELECT id, label, hint, sort_order
    FROM public.visit_slot_options;

-- Anon gets read on the projects table (already public) AND on the public
-- views above. NOTHING ELSE.
GRANT SELECT ON public.projects                    TO anon;
GRANT SELECT ON public.public_parcels              TO anon;
GRANT SELECT ON public.public_offers               TO anon;
GRANT SELECT ON public.public_parcel_tree_batches  TO anon;
GRANT SELECT ON public.public_visit_slots          TO anon;

-- Authenticated users still get raw-table read for the dashboards (RLS
-- gates per-row); the views above are convenience for anon only.
GRANT SELECT ON public.public_parcels              TO authenticated;
GRANT SELECT ON public.public_offers               TO authenticated;
GRANT SELECT ON public.public_parcel_tree_batches  TO authenticated;
GRANT SELECT ON public.public_visit_slots          TO authenticated;

-- ============================================================================
-- 4. S-C3 — Replace `delegated_sellers_clients_select` (which let any
--    delegated seller dump the full clients table) with a narrow
--    SECURITY DEFINER RPC. The seller can search by exact phone or email
--    only, gets only the columns the wizard needs, and every lookup
--    lands in audit_logs.
-- ============================================================================

DROP POLICY IF EXISTS delegated_sellers_clients_select ON public.clients;

CREATE OR REPLACE FUNCTION public.lookup_client_for_sale(p_query text)
RETURNS TABLE (
  id uuid, full_name text, email text, phone text, code text, status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit_lookup$
DECLARE
  v_query text;
  v_norm_phone text;
  v_who uuid;
BEGIN
  v_query := trim(coalesce(p_query, ''));
  IF length(v_query) < 4 THEN
    -- Refuse short queries — would otherwise let a seller iterate prefixes.
    RETURN;
  END IF;

  -- Authorization: only active staff OR a delegated seller may call this.
  IF NOT (public.is_active_staff() OR public.is_delegated_seller()) THEN
    RAISE EXCEPTION 'lookup_client_for_sale: not authorized';
  END IF;

  v_who := auth.uid();
  v_norm_phone := regexp_replace(v_query, '\D', '', 'g');

  -- Audit every lookup. Failures here must NOT swallow the result.
  BEGIN
    INSERT INTO public.audit_logs (
      actor_user_id, action, entity, entity_id, details, severity, category, source
    ) VALUES (
      v_who, 'client_lookup', 'clients', NULL,
      'lookup_client_for_sale query=' || left(v_query, 64),
      'info', 'data_access', 'database'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'lookup_client_for_sale: audit failed: %', sqlerrm;
  END;

  -- Phone match: exact digit string OR last 8 digits (TN local vs +216… stored forms).
  -- Include active + stub-like statuses (pending / unverified / pre-signup) so a
  -- seller who knows the buyer's phone can still attach — we only exclude
  -- explicit 'deleted' / 'archived' rows so they can't resurface via search.
  RETURN QUERY
    SELECT c.id, c.full_name, c.email, c.phone, c.code, c.status
      FROM public.clients c
     WHERE coalesce(c.status, 'active') NOT IN ('deleted', 'archived', 'banned')
       AND (
         lower(c.email) = lower(v_query)
         OR lower(c.code)  = lower(v_query)
         OR (
           length(v_norm_phone) >= 6
           AND (
             regexp_replace(coalesce(c.phone,''), '\D', '', 'g') = v_norm_phone
             OR (
               length(regexp_replace(coalesce(c.phone,''), '\D', '', 'g')) >= 8
               AND length(v_norm_phone) >= 8
               AND right(regexp_replace(coalesce(c.phone,''), '\D', '', 'g'), 8) = right(v_norm_phone, 8)
             )
           )
         )
       )
     LIMIT 5;
END;
$zit_lookup$;

REVOKE ALL ON FUNCTION public.lookup_client_for_sale(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.lookup_client_for_sale(text) TO authenticated;

-- ============================================================================
-- 5. S-H3 (scaffold) — admin_users.mfa_enrolled column + helper. Default
--    false so no admin is locked out today; UI gating ships in a follow-up.
-- ============================================================================
DO $zit_mfa$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='admin_users' AND column_name='mfa_enrolled'
  ) THEN
    ALTER TABLE public.admin_users ADD COLUMN mfa_enrolled boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='admin_users' AND column_name='mfa_required'
  ) THEN
    -- A super-admin can flip this per-row to FORCE 2FA enrolment for
    -- specific staff (e.g. finance + danger-zone). Future RLS / UI gates
    -- will check this column.
    ALTER TABLE public.admin_users ADD COLUMN mfa_required boolean NOT NULL DEFAULT false;
  END IF;
END;
$zit_mfa$;

CREATE OR REPLACE FUNCTION public.staff_needs_mfa()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $zit_auto_1$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users au
    WHERE lower(trim(coalesce(au.email,''))) = lower(trim(coalesce(auth.email(),'')))
      AND au.status = 'active'
      AND au.mfa_required = true
      AND au.mfa_enrolled = false
  );
$zit_auto_1$;
GRANT EXECUTE ON FUNCTION public.staff_needs_mfa() TO authenticated;

-- ============================================================================
-- 6. S-H6 — Documentation: which auth-gated React route reads which table.
--    When tightening RLS in the future, refer to this matrix to ensure the
--    DB enforces the same scope the React guard enforces.
--
--    /admin                       → admin_users, audit_logs (staff only)
--    /admin/projects              → projects, parcels, project_offers,
--                                   parcel_tree_batches, project_health_reports
--    /admin/clients[/:id]         → clients, client_phone_identities,
--                                   sales, installment_plans, page_access_grants
--    /admin/finance               → installment_payments, installment_payment_receipts,
--                                   commission_payout_requests
--    /admin/legal                 → legal_stamps, legal_notices, sales(status)
--    /admin/coordination          → sales (pipeline transitions)
--    /admin/commissions[*]        → commission_events, commission_payout_requests,
--                                   commission_payout_request_items, seller_relations
--    /admin/users                 → admin_users (super-admin only)
--    /admin/sell                  → sales (insert), parcels (status updates)
--    /admin/recouvrement          → installment_payments (overdue), legal_notices
--    /dashboard                   → sales(own), commission_events(own),
--                                   page_access_grants(own), user_notifications(own)
--    /installments                → installment_plans(own), installment_payments(own)
--    /browse,/project/:id (anon)  → projects, public_parcels (view)
-- ============================================================================

-- ============================================================================
-- ===== SECTION C — Database hardening (CHECKs, FKs, triggers, retention) ===
-- ============================================================================
-- =============================================================================
-- ZITOUNA — 11_database_hardening.sql
-- Closes the findings in docs/AUDIT/02_DATABASE_RLS_FINDINGS.md that the
-- previous hardening pass (09) did not address. Idempotent and safe to
-- re-run. Apply after 02 → 03 → 04 → (05/06) → 07 → 08 → 09 → 10.
--
-- Coverage:
--   DB-C2  — sales.status / pipeline_status CHECK constraints + normaliser.
--   DB-C3  — commission_events.beneficiary_client_id ON DELETE SET NULL +
--            re-point trigger when stub clients are merged.
--   DB-C4  — audit trigger on every sales.client_id change.
--   DB-H1  — clients.auth_user_id FK to auth.users.
--   DB-H3  — plan_status enum gets 'cancelled'; cascade trigger from sales.
--   DB-H4  — non-negative CHECK on every money column.
--   DB-H5  — current_client_id() picks the best row, not just the oldest.
--   DB-M1  — index on sales.seller_client_id.
--   DB-M2  — phone_verifications.user_id FK.
--   DB-M4  — unique constraint preventing duplicate commission events.
--   DB-M7  — client_phone_identities.auth_user_id FK.
--   DB-M8  — drop unique(client_id) on client_phone_identities.
--   DB-L1  — touch_updated_at triggers on every "updated_at" table.
--   DB-L3  — parcel_status enum gets 'withdrawn'.
--   DB-L4  — purge_old_audit_logs(days) function.
--
-- Deferred (require product input — see docs/AUDIT/02_DATABASE_RLS_FINDINGS.md):
--   DB-H6  — sales.seller_client_id NOT NULL: needs a "house client" sentinel
--   DB-M3  — drop sales.parcel_id in favour of parcel_ids[]: app rewrite
--   DB-M5  — convert reservation_status text+CHECK to enum: enum migration risk
--   DB-L2  — already accepted as fine in the audit.
-- =============================================================================

DO $zit$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='is_active_staff') THEN
    RAISE EXCEPTION 'ZITOUNA 11: run 03_functions.sql + 04_rls.sql first.';
  END IF;
END;
$zit$;

-- ============================================================================
-- DB-C2 — sales.status / sales.pipeline_status CHECK constraints.
--
-- A full enum migration is risky (existing data may carry whitespace, casing,
-- typo variants). We:
--   1. Normalise existing data (trim + lowercase) so the CHECK passes.
--   2. Reroute any unknown value to 'draft' and audit-log it.
--   3. Add the CHECK constraints NOT VALID, then VALIDATE.
--
-- The string set was derived from every literal in src/lib/db.js,
-- src/admin/pages/* and src/pages/* (see audit comment).
-- ============================================================================

DO $zit$
DECLARE
  v_canonical_status text[]   := ARRAY['draft','pending_finance','pending_legal','active','completed','cancelled'];
  v_canonical_pipe   text[]   := ARRAY['draft','pending_finance','pending_coordination','pending_legal','completed','cancelled'];
  v_changed int;
BEGIN
  -- Trim + lowercase first — a stray ' completed' would break the CHECK.
  UPDATE public.sales SET status = lower(trim(status))                 WHERE status         <> lower(trim(status));
  UPDATE public.sales SET pipeline_status = lower(trim(pipeline_status)) WHERE pipeline_status <> lower(trim(pipeline_status));

  -- Reroute unknown values to 'draft' and audit-log every reroute so an
  -- admin can review later. Wrapped in exception handler — audit_logs
  -- write must never abort the migration.
  WITH bad AS (
    UPDATE public.sales
       SET status = 'draft', updated_at = now()
     WHERE NOT (status = ANY(v_canonical_status))
    RETURNING id, status AS new_status
  )
  INSERT INTO public.audit_logs (actor_user_id, action, entity, entity_id, details, severity, category, source)
  SELECT NULL, 'status_normalised_to_draft', 'sales', b.id::text,
         'sale.status not in canonical set; reset to draft',
         'warning', 'system', 'database'
    FROM bad b;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed > 0 THEN RAISE NOTICE 'sales.status normalised: % rows', v_changed; END IF;

  WITH bad AS (
    UPDATE public.sales
       SET pipeline_status = 'draft', updated_at = now()
     WHERE NOT (pipeline_status = ANY(v_canonical_pipe))
    RETURNING id, pipeline_status AS new_pipe
  )
  INSERT INTO public.audit_logs (actor_user_id, action, entity, entity_id, details, severity, category, source)
  SELECT NULL, 'pipeline_status_normalised_to_draft', 'sales', b.id::text,
         'sale.pipeline_status not in canonical set; reset to draft',
         'warning', 'system', 'database'
    FROM bad b;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'sales status normalisation skipped: %', sqlerrm;
END;
$zit$;

-- Drop any older check constraints we created in a previous run, then
-- recreate. Postgres has no `IF EXISTS … CHECK` on column constraints so
-- we go through pg_constraint catalogue.
DO $zit$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_status_check') THEN
    ALTER TABLE public.sales DROP CONSTRAINT sales_status_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_pipeline_status_check') THEN
    ALTER TABLE public.sales DROP CONSTRAINT sales_pipeline_status_check;
  END IF;
END;
$zit$;

ALTER TABLE public.sales
  ADD CONSTRAINT sales_status_check
  CHECK (status IN ('draft','pending_finance','pending_coordination','pending_legal','active','completed','cancelled'))
  NOT VALID;
ALTER TABLE public.sales VALIDATE CONSTRAINT sales_status_check;

ALTER TABLE public.sales
  ADD CONSTRAINT sales_pipeline_status_check
  CHECK (pipeline_status IN ('draft','pending_finance','pending_coordination','pending_legal','completed','cancelled'))
  NOT VALID;
ALTER TABLE public.sales VALIDATE CONSTRAINT sales_pipeline_status_check;

-- ============================================================================
-- DB-C3 — commission_events.beneficiary_client_id ON DELETE SET NULL +
-- re-point trigger.
--
-- Today the FK is ON DELETE RESTRICT, which means a stub client linked to
-- commission events cannot be deleted or merged into the real auth user.
-- We loosen to SET NULL so the row is preserved (auditability) but the
-- stub can be cleaned up. A separate trigger re-points commissions when
-- the heal RPC migrates a sale to a new client_id.
-- ============================================================================

DO $zit$
BEGIN
  -- Drop existing FK constraint regardless of name; pg auto-names them.
  PERFORM 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'commission_events'
     AND c.contype = 'f'
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = t.oid
          AND a.attnum  = ANY(c.conkey)
          AND a.attname = 'beneficiary_client_id'
     );
  IF FOUND THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.commission_events DROP CONSTRAINT ' || quote_ident(c.conname)
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'commission_events'
         AND c.contype = 'f'
         AND EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = t.oid
              AND a.attnum  = ANY(c.conkey)
              AND a.attname = 'beneficiary_client_id'
         )
       LIMIT 1
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'commission_events FK drop skipped: %', sqlerrm;
END;
$zit$;

ALTER TABLE public.commission_events
  ADD CONSTRAINT commission_events_beneficiary_fk
  FOREIGN KEY (beneficiary_client_id) REFERENCES public.clients(id) ON DELETE SET NULL;

-- Trigger: when a sale's client_id is migrated to a new client, re-point
-- the related commission_events.beneficiary_client_id from the old stub
-- to the new client. Only re-points when the old beneficiary == old
-- client_id (i.e. the L0/buyer events) — upline (L1+) commissions are
-- never silently re-routed.
CREATE OR REPLACE FUNCTION public.trg_sales_repoint_commissions()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE v_count int;
BEGIN
  IF NEW.client_id IS NOT DISTINCT FROM OLD.client_id THEN
    RETURN NEW;
  END IF;
  BEGIN
    UPDATE public.commission_events ce
       SET beneficiary_client_id = NEW.client_id, updated_at = now()
     WHERE ce.sale_id = NEW.id
       AND ce.beneficiary_client_id = OLD.client_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      INSERT INTO public.audit_logs (
        actor_user_id, action, entity, entity_id, details, severity, category, source
      ) VALUES (
        auth.uid(), 'commissions_repointed', 'commission_events', NEW.id::text,
        'Re-pointed ' || v_count || ' commission_events from client ' ||
        coalesce(OLD.client_id::text,'NULL') || ' to ' || NEW.client_id::text ||
        ' (sale ' || NEW.code || ')',
        'warning', 'business', 'database'
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'trg_sales_repoint_commissions skipped for %: %', NEW.id, sqlerrm;
  END;
  RETURN NEW;
END;
$zit$;

DO $zit$
BEGIN
  DROP TRIGGER IF EXISTS zitouna_sales_repoint_commissions ON public.sales;
  CREATE TRIGGER zitouna_sales_repoint_commissions
    AFTER UPDATE OF client_id ON public.sales
    FOR EACH ROW EXECUTE FUNCTION public.trg_sales_repoint_commissions();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'sales_repoint_commissions trigger wiring failed: %', sqlerrm;
END;
$zit$;

-- ============================================================================
-- DB-C4 — Audit trigger on every sales.client_id change.
--
-- The heal RPC ensure_current_client_profile() can re-point sales between
-- clients based on phone match. This trigger writes a permanent
-- before/after record so any silent re-attribution is forensically
-- recoverable. Severity = 'warning' so the audit-log UI surfaces it.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_sales_client_change_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
BEGIN
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    BEGIN
      INSERT INTO public.audit_logs (
        actor_user_id, action, entity, entity_id, details,
        metadata, severity, category, source
      ) VALUES (
        auth.uid(), 'sale_client_id_changed', 'sales', NEW.id::text,
        'sale.client_id changed from ' || coalesce(OLD.client_id::text,'NULL') ||
        ' to ' || coalesce(NEW.client_id::text,'NULL'),
        jsonb_build_object(
          'sale_code', NEW.code,
          'old_client_id', OLD.client_id,
          'new_client_id', NEW.client_id,
          'buyer_auth_user_id', NEW.buyer_auth_user_id,
          'buyer_phone_normalized', NEW.buyer_phone_normalized
        ),
        'warning', 'security', 'database'
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'trg_sales_client_change_audit skipped for %: %', NEW.id, sqlerrm;
    END;
  END IF;
  RETURN NEW;
END;
$zit$;

DO $zit$
BEGIN
  DROP TRIGGER IF EXISTS zitouna_sales_client_change_audit ON public.sales;
  CREATE TRIGGER zitouna_sales_client_change_audit
    AFTER UPDATE OF client_id ON public.sales
    FOR EACH ROW EXECUTE FUNCTION public.trg_sales_client_change_audit();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'sales_client_change_audit trigger wiring failed: %', sqlerrm;
END;
$zit$;

-- ============================================================================
-- DB-H1 / DB-M2 / DB-M7 — FKs to auth.users with ON DELETE SET NULL.
-- Step 1: null out orphans (auth_user_id pointing nowhere).
-- Step 2: add the FK NOT VALID, then VALIDATE.
-- ============================================================================

-- clients.auth_user_id
DO $zit$
BEGIN
  UPDATE public.clients
     SET auth_user_id = NULL, updated_at = now()
   WHERE auth_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = clients.auth_user_id);

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_auth_user_fk') THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_auth_user_fk FOREIGN KEY (auth_user_id)
      REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE public.clients VALIDATE CONSTRAINT clients_auth_user_fk;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'clients_auth_user_fk skipped: %', sqlerrm;
END;
$zit$;

-- client_phone_identities.auth_user_id
DO $zit$
BEGIN
  UPDATE public.client_phone_identities
     SET auth_user_id = NULL, updated_at = now()
   WHERE auth_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = client_phone_identities.auth_user_id);

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_phone_identities_auth_user_fk') THEN
    ALTER TABLE public.client_phone_identities
      ADD CONSTRAINT client_phone_identities_auth_user_fk FOREIGN KEY (auth_user_id)
      REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE public.client_phone_identities VALIDATE CONSTRAINT client_phone_identities_auth_user_fk;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'client_phone_identities_auth_user_fk skipped: %', sqlerrm;
END;
$zit$;

-- phone_verifications.user_id (FK is mandatory — can't be NULL given the PK)
DO $zit$
BEGIN
  -- Delete orphan rows; user_id is the PK, can't null it out.
  DELETE FROM public.phone_verifications
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = phone_verifications.user_id);

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phone_verifications_user_fk') THEN
    ALTER TABLE public.phone_verifications
      ADD CONSTRAINT phone_verifications_user_fk FOREIGN KEY (user_id)
      REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE public.phone_verifications VALIDATE CONSTRAINT phone_verifications_user_fk;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'phone_verifications_user_fk skipped: %', sqlerrm;
END;
$zit$;

-- ============================================================================
-- DB-H3 — plan_status gets 'cancelled'; cascade trigger from sales.
-- ============================================================================
ALTER TYPE plan_status ADD VALUE IF NOT EXISTS 'cancelled';

CREATE OR REPLACE FUNCTION public.trg_sales_cancel_cascade()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE v_plans int;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;
  BEGIN
    UPDATE public.installment_plans p
       SET status = 'cancelled', updated_at = now()
     WHERE p.sale_id = NEW.id AND p.status <> 'cancelled';
    GET DIAGNOSTICS v_plans = ROW_COUNT;
    IF v_plans > 0 THEN
      INSERT INTO public.audit_logs (
        actor_user_id, action, entity, entity_id, details, severity, category, source
      ) VALUES (
        auth.uid(), 'plans_cancelled_with_sale', 'installment_plans', NEW.id::text,
        'Cancelled ' || v_plans || ' installment plan(s) because sale ' || NEW.code || ' was cancelled.',
        'info', 'business', 'database'
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'trg_sales_cancel_cascade skipped for %: %', NEW.id, sqlerrm;
  END;
  RETURN NEW;
END;
$zit$;

DO $zit$
BEGIN
  DROP TRIGGER IF EXISTS zitouna_sales_cancel_cascade ON public.sales;
  CREATE TRIGGER zitouna_sales_cancel_cascade
    AFTER UPDATE OF status ON public.sales
    FOR EACH ROW EXECUTE FUNCTION public.trg_sales_cancel_cascade();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'sales_cancel_cascade trigger wiring failed: %', sqlerrm;
END;
$zit$;

-- ============================================================================
-- DB-H4 — Non-negative CHECK on every money column.
--
-- commission_events.amount is the only one that may legitimately be
-- negative (clawback). All others are >= 0.
-- ============================================================================

DO $zit$
DECLARE
  v_pairs text[][] := ARRAY[
    ['parcels',                    'total_price'],
    ['parcels',                    'price_per_tree'],
    ['sales',                      'agreed_price'],
    ['sales',                      'deposit'],
    ['sales',                      'advance_paid'],
    ['sales',                      'plots_total_price'],
    ['installment_plans',          'total_price'],
    ['installment_plans',          'down_payment'],
    ['installment_plans',          'monthly_amount'],
    ['installment_payments',       'amount'],
    ['commission_payout_requests', 'gross_amount']
  ];
  i int;
  v_table text; v_col text; v_cname text;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_table := v_pairs[i][1];
    v_col   := v_pairs[i][2];
    v_cname := v_table || '_' || v_col || '_nonneg_check';

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_cname) THEN
      -- Sanitise existing negatives by clamping to 0 — never silently
      -- corrupt sums by leaving negatives in.
      EXECUTE format(
        'UPDATE public.%I SET %I = 0 WHERE %I < 0',
        v_table, v_col, v_col
      );
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I >= 0) NOT VALID',
        v_table, v_cname, v_col
      );
      EXECUTE format(
        'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
        v_table, v_cname
      );
    END IF;
  END LOOP;
END;
$zit$;

-- ============================================================================
-- DB-H5 — current_client_id() prefers the best row, not just the oldest.
-- Heuristic: linked auth_user_id present + email_confirmed_at not null +
-- non-empty full_name + has at least one sale → highest score. Falls
-- back to the previous "oldest by created_at" rule for stable resolution
-- when scores tie.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.current_client_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $zit_auto_2$
  WITH candidates AS (
    SELECT
      c.id,
      c.created_at,
      (CASE WHEN c.email IS NOT NULL AND length(trim(c.email)) > 0       THEN 1 ELSE 0 END
      + CASE WHEN c.full_name IS NOT NULL AND length(trim(c.full_name)) > 0 THEN 1 ELSE 0 END
      + CASE WHEN c.status = 'active'                                       THEN 1 ELSE 0 END
      + CASE WHEN EXISTS (SELECT 1 FROM public.sales s WHERE s.client_id = c.id) THEN 2 ELSE 0 END
      + CASE WHEN EXISTS (
                  SELECT 1 FROM public.commission_events ce
                  WHERE ce.beneficiary_client_id = c.id
                ) THEN 1 ELSE 0 END
      ) AS score
    FROM public.clients c
    WHERE c.auth_user_id = auth.uid()
  )
  SELECT id FROM candidates
  ORDER BY score DESC, created_at ASC, id ASC
  LIMIT 1;
$zit_auto_2$;

-- ============================================================================
-- DB-M1 — Index on sales.seller_client_id (commission upline walk).
-- DB-M4 — Unique commission_events to prevent double-insert.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_sales_seller_client
  ON public.sales(seller_client_id) WHERE seller_client_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_commission_events_once
  ON public.commission_events(sale_id, beneficiary_client_id, level)
  WHERE status <> 'cancelled';

-- ============================================================================
-- DB-M8 — Drop unique(client_id) on client_phone_identities.
-- The table name is plural ("identities") and clients legitimately have
-- multiple phones (work / personal). Keep unique(phone_canonical),
-- unique(auth_user_id).
-- ============================================================================
DO $zit$
BEGIN
  PERFORM 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'client_phone_identities'
     AND c.contype = 'u'
     AND array_length(c.conkey, 1) = 1
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = t.oid
          AND a.attnum = c.conkey[1]
          AND a.attname = 'client_id'
     );
  IF FOUND THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.client_phone_identities DROP CONSTRAINT ' || quote_ident(c.conname)
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'client_phone_identities'
         AND c.contype = 'u'
         AND array_length(c.conkey, 1) = 1
         AND EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = t.oid
              AND a.attnum = c.conkey[1]
              AND a.attname = 'client_id'
         )
       LIMIT 1
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'client_phone_identities client_id unique drop skipped: %', sqlerrm;
END;
$zit$;

-- ============================================================================
-- DB-L1 — touch_updated_at triggers on tables that have updated_at but
-- no trigger.
-- ============================================================================
DO $zit$
DECLARE
  v_tables text[] := ARRAY[
    'seller_parcel_assignments',
    'seller_relations',
    'ambassador_wallets',
    'installment_payment_receipts',
    'sale_reservation_events'
  ];
  i int;
  v_table text; v_trg text;
BEGIN
  FOR i IN 1 .. array_length(v_tables, 1) LOOP
    v_table := v_tables[i];
    v_trg := 'trg_' || v_table || '_touch';

    -- Only add if the table actually carries `updated_at`.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_table AND column_name = 'updated_at'
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', v_trg, v_table);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
        v_trg, v_table
      );
    END IF;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'touch_updated_at trigger wiring skipped: %', sqlerrm;
END;
$zit$;

-- ============================================================================
-- DB-L3 — parcel_status enum gets 'withdrawn'. We don't add 'cancelled'
-- because the audit suggests staff revoke vs withdraw; cancellation of a
-- sale does NOT cancel the parcel (it returns to 'available').
-- ============================================================================
ALTER TYPE parcel_status ADD VALUE IF NOT EXISTS 'withdrawn';

-- ============================================================================
-- DB-L4 — Audit log retention helper.
-- Truncates info-severity rows older than `p_days` days. Warning and
-- critical rows are preserved by default (they are the forensic record);
-- pass include_warning => true to also drop those.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.purge_old_audit_logs(
  p_days int DEFAULT 365,
  p_include_warning boolean DEFAULT false
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE v_count int;
BEGIN
  IF p_days < 30 THEN
    RAISE EXCEPTION 'purge_old_audit_logs: refuse to purge less than 30 days old';
  END IF;

  DELETE FROM public.audit_logs
   WHERE created_at < (now() - make_interval(days => p_days))
     AND (severity = 'info' OR (p_include_warning AND severity = 'warning'));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$zit$;

REVOKE ALL ON FUNCTION public.purge_old_audit_logs(int, boolean) FROM PUBLIC;
-- Staff-only: do not grant to authenticated; service_role can execute via 09's blanket service_role grant.

-- ============================================================================
-- Optional pg_cron hook for the retention purge — runs nightly at 04:00.
-- No-ops if pg_cron is not installed.
-- ============================================================================
DO $zit_cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'zitouna_audit_log_purge';
    PERFORM cron.schedule(
      'zitouna_audit_log_purge',
      '0 4 * * *',
      $$SELECT public.purge_old_audit_logs(365, false);$$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron audit_log_purge schedule skipped: %', sqlerrm;
END;
$zit_cron$;

-- ============================================================================
-- END — 11_database_hardening.sql
-- ============================================================================

-- ============================================================================
-- ===== SECTION D — Commission model v2 (was 09_commission_model_v2.sql) ====
-- ============================================================================
-- Sale-based pyramid. Replaces the legacy "link at sale creation" flow with
-- "link at notary completion" and drops the buyer-upline fallback. Idempotent.
--
--   • seller_relations is populated at NOTARY COMPLETION, not at sale create.
--   • Link direction: child = buyer, parent = seller.
--   • Commission walks seller_relations ONLY (no clients.referred_by_client_id).
--   • No seller / self-sale → zero commission events.
--   • Reverse-sale guard: the buyer is filtered out of the commission chain.
-- ============================================================================

-- 1. Drop the old AFTER-INSERT trigger that materialised the link too early.
drop trigger if exists zitouna_sales_auto_parrainage on public.sales;

-- 2. New trigger: create buyer→seller edge when notary_completed_at is set.
create or replace function public.trg_sales_notary_parrainage()
returns trigger
language plpgsql
security definer
set search_path = public
as $zit_auto_3$
declare
  v_buyer uuid;
  v_seller uuid;
begin
  if NEW.notary_completed_at is null then return NEW; end if;
  if OLD.notary_completed_at is not null
     and OLD.notary_completed_at = NEW.notary_completed_at then
    return NEW;
  end if;

  v_buyer  := NEW.client_id;
  v_seller := NEW.seller_client_id;

  if v_seller is null or v_buyer is null or v_seller = v_buyer then
    return NEW;
  end if;

  begin
    insert into public.seller_relations (
      child_client_id, parent_client_id, source_sale_id, linked_at
    ) values (
      v_buyer, v_seller, NEW.id, now()
    )
    on conflict (child_client_id) do nothing;
  exception
    when undefined_table or undefined_column then
      return NEW;
    when others then
      insert into public.audit_logs (action, entity, entity_id, details, metadata, category, source, severity)
      values (
        'parrainage_link_failed', 'sale', NEW.id::text,
        'trg_sales_notary_parrainage failed to insert link: ' || SQLERRM,
        jsonb_build_object('buyer', v_buyer, 'seller', v_seller, 'saleId', NEW.id),
        'business', 'database', 'warning'
      );
      return NEW;
  end;

  return NEW;
end;
$zit_auto_3$;

drop trigger if exists zitouna_sales_notary_parrainage on public.sales;
create trigger zitouna_sales_notary_parrainage
  after update of notary_completed_at on public.sales
  for each row execute function public.trg_sales_notary_parrainage();

-- 3. Rewrite compute_and_insert_commissions_for_sale for the sale-based model.
create or replace function public.compute_and_insert_commissions_for_sale(p_sale_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $zit_auto_4$
declare
  v_sale record;
  v_buyer uuid;
  v_seller uuid;
  v_walk uuid;
  v_parent uuid;
  v_chain uuid[] := '{}';
  v_filtered uuid[] := '{}';
  v_i int;
  v_steps int := 0;
  v_level int;
  v_max_level int := 0;
  v_rule jsonb;
  v_rules jsonb;
  v_amount numeric(14,2);
  v_base numeric(14,2);
  v_inserted int := 0;
  v_beneficiary uuid;
  v_cap numeric(14,2);
  v_rule_type text;
  v_rule_value numeric(14,4);
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then return 0; end if;

  if exists (select 1 from public.commission_events where sale_id = p_sale_id) then
    return 0;
  end if;

  v_buyer  := v_sale.client_id;
  v_seller := v_sale.seller_client_id;

  if v_seller is null or v_buyer is null or v_seller = v_buyer then
    return 0;
  end if;

  v_rules := coalesce(v_sale.commission_rule_snapshot -> 'levels', '[]'::jsonb);
  if jsonb_array_length(v_rules) = 0 then
    select jsonb_agg(jsonb_build_object(
      'level', pcr.level,
      'rule_type', pcr.rule_type,
      'value', pcr.value,
      'maxCapAmount', pcr.max_cap_amount
    ) order by pcr.level)
    into v_rules
    from public.project_commission_rules pcr
    where pcr.project_id = v_sale.project_id;
    v_rules := coalesce(v_rules, '[]'::jsonb);
  end if;
  if jsonb_array_length(v_rules) = 0 then return 0; end if;

  v_walk := v_seller;
  while v_walk is not null and v_steps < 40 loop
    if v_walk = any (v_chain) then exit; end if;
    v_chain := v_chain || v_walk;

    select sr.parent_client_id into v_parent
    from public.seller_relations sr where sr.child_client_id = v_walk limit 1;

    v_walk := v_parent;
    v_parent := null;
    v_steps := v_steps + 1;
  end loop;

  if array_length(v_chain, 1) is null then return 0; end if;

  for v_i in 1 .. array_length(v_chain, 1) loop
    if v_chain[v_i] is not null and v_chain[v_i] <> v_buyer then
      v_filtered := v_filtered || v_chain[v_i];
    end if;
  end loop;

  if array_length(v_filtered, 1) is null then return 0; end if;

  select max((elem ->> 'level')::int) into v_max_level
  from jsonb_array_elements(v_rules) as elem;

  v_base := coalesce(v_sale.agreed_price, 0);

  for v_i in 1 .. coalesce(array_length(v_filtered, 1), 0) loop
    v_level := v_i;
    if v_max_level > 0 and v_level > v_max_level then exit; end if;
    v_beneficiary := v_filtered[v_i];
    if v_beneficiary is null then continue; end if;

    select elem into v_rule
    from jsonb_array_elements(v_rules) as elem
    where (elem ->> 'level')::int = v_level
    limit 1;
    if v_rule is null then
      v_rule := v_rules -> (v_i - 1);
    end if;
    if v_rule is null then continue; end if;

    v_rule_type := coalesce(v_rule ->> 'rule_type', v_rule ->> 'ruleType', 'fixed');
    v_rule_value := coalesce((v_rule ->> 'value')::numeric, 0);
    v_cap := nullif(v_rule ->> 'maxCapAmount', '')::numeric;

    if v_rule_type = 'percent' then
      v_amount := round(v_base * v_rule_value / 100, 2);
    else
      v_amount := round(v_rule_value, 2);
    end if;
    if v_cap is not null then v_amount := least(v_amount, v_cap); end if;
    if v_amount <= 0 then continue; end if;

    insert into public.commission_events (
      sale_id, beneficiary_client_id, level, rule_snapshot, amount, status, payable_at
    ) values (
      p_sale_id, v_beneficiary, v_level,
      jsonb_build_object(
        'source', 'db_trigger',
        'rule', v_rule,
        'meta', jsonb_build_object(
          'saleId', p_sale_id,
          'saleProjectId', v_sale.project_id,
          'buyerClientId', v_buyer,
          'level', v_level,
          'beneficiaryClientId', v_beneficiary,
          'directSeller', v_seller::text,
          'chainPath', to_jsonb(v_filtered[1:v_i]),
          'computedAmount', v_amount,
          'amountBase', v_base,
          'computedAt', now()
        )
      ),
      v_amount, 'payable', coalesce(v_sale.notary_completed_at, now())
    );
    v_inserted := v_inserted + 1;
  end loop;

  if v_inserted > 0 then
    insert into public.audit_logs (action, entity, entity_id, details, metadata, category, source)
    values (
      'commission_events_created', 'sale', p_sale_id::text,
      'DB backstop created ' || v_inserted || ' commission line(s) (sale-based model).',
      jsonb_build_object('source', 'db_trigger', 'count', v_inserted, 'model', 'sale_based_v2'),
      'business', 'database'
    );
  end if;
  return v_inserted;
end;
$zit_auto_4$;

-- 4. Re-assert commissions trigger. Named "zitouna_sales_notary_commissions"
-- so it sorts BEFORE "zitouna_sales_notary_parrainage" and computes
-- commissions against the graph *before* this sale's edge is added.
drop trigger if exists trg_sales_notary_commissions on public.sales;
drop trigger if exists zitouna_sales_notary_commissions on public.sales;
create trigger zitouna_sales_notary_commissions
  after update of notary_completed_at on public.sales
  for each row execute function public.trg_sales_notary_commissions();

-- ============================================================================
-- ===== SECTION E — Parcel labels + Offer payment modes =====================
-- ============================================================================
-- Two small, idempotent additions kept in the same hardening file so the
-- canonical apply-order stays short. Both are optional at the app layer
-- (db.js retries on 42703 `undefined_column` errors if these haven't
-- landed yet), but the UI only persists the new fields once they exist.
--
--   E1 — parcels.label (user-facing identifier like "a1", "b1", "A-42")
--   E2 — project_offers: mode / cash_amount / price_per_sqm
-- ============================================================================

-- E1.a — Column. Optional text, trimmed client-side, max ~16 chars.
ALTER TABLE public.parcels
  ADD COLUMN IF NOT EXISTS label text;

-- E1.b — Case-insensitive uniqueness per project (NULLs allowed).
CREATE UNIQUE INDEX IF NOT EXISTS ux_parcels_project_label
  ON public.parcels (project_id, lower(label))
  WHERE label IS NOT NULL;

-- E1.c — Ordering helper: matches the UI's `label || parcel_number` rule.
CREATE INDEX IF NOT EXISTS ix_parcels_project_label_sort
  ON public.parcels (project_id, coalesce(label, parcel_number::text));

-- E2 — Offer payment modes. Default 'installments' preserves legacy rows.
ALTER TABLE public.project_offers
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'installments';
ALTER TABLE public.project_offers
  ADD COLUMN IF NOT EXISTS cash_amount numeric(14,2);
ALTER TABLE public.project_offers
  ADD COLUMN IF NOT EXISTS price_per_sqm numeric(14,2);

-- Enforce the two modes at the DB layer.
DO $zit_offer_mode$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_offers_mode_check') THEN
    ALTER TABLE public.project_offers
      ADD CONSTRAINT project_offers_mode_check
      CHECK (mode IN ('installments','cash'));
  END IF;
END
$zit_offer_mode$;

-- ============================================================================
-- F1 — Denormalized buyer snapshot on sales
-- ----------------------------------------------------------------------------
-- Why: RLS hides the clients row from sellers / coordinators who did not
-- create the buyer. The join in fetchSales() then returns NULL for
-- s.client and the Coordination / Finance / Legal screens show an empty
-- "Nom" field even though a buyer was recorded. Keeping a denormalized
-- snapshot (name, phone, cin, email, city) on the sale row serves TWO
-- goals simultaneously:
--   1. UI always has a buyer label, regardless of who is looking.
--   2. If the buyer row is later hard-deleted, the contract history
--      still carries the name the sale was signed with (audit trail).
-- ============================================================================
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS client_name_snapshot  text,
  ADD COLUMN IF NOT EXISTS client_phone_snapshot text,
  ADD COLUMN IF NOT EXISTS client_cin_snapshot   text,
  ADD COLUMN IF NOT EXISTS client_email_snapshot text,
  ADD COLUMN IF NOT EXISTS client_city_snapshot  text;

CREATE OR REPLACE FUNCTION public.sales_snapshot_client_info()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit_sales_snap$
DECLARE
  v_name  text; v_phone text; v_cin text; v_email text; v_city text;
BEGIN
  IF NEW.client_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    SELECT c.full_name, c.phone, c.cin, c.email, c.city
      INTO v_name, v_phone, v_cin, v_email, v_city
      FROM public.clients c WHERE c.id = NEW.client_id;
    -- Only overwrite when we actually read a row (client_id is FK-checked so
    -- this should always succeed, but be defensive against replica drift).
    IF v_name IS NOT NULL OR v_phone IS NOT NULL THEN
      NEW.client_name_snapshot  := COALESCE(NULLIF(v_name, ''),  NEW.client_name_snapshot);
      NEW.client_phone_snapshot := COALESCE(NULLIF(v_phone, ''), NEW.client_phone_snapshot);
      NEW.client_cin_snapshot   := COALESCE(NULLIF(v_cin, ''),   NEW.client_cin_snapshot);
      NEW.client_email_snapshot := COALESCE(NULLIF(v_email, ''), NEW.client_email_snapshot);
      NEW.client_city_snapshot  := COALESCE(NULLIF(v_city, ''),  NEW.client_city_snapshot);
    END IF;
  END IF;
  RETURN NEW;
END;
$zit_sales_snap$;

DROP TRIGGER IF EXISTS sales_snapshot_client_info_trg ON public.sales;
CREATE TRIGGER sales_snapshot_client_info_trg
  BEFORE INSERT OR UPDATE OF client_id ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.sales_snapshot_client_info();

-- Backfill: populate any existing rows where the snapshot is missing.
UPDATE public.sales s SET
  client_name_snapshot  = COALESCE(NULLIF(s.client_name_snapshot, ''),  c.full_name),
  client_phone_snapshot = COALESCE(NULLIF(s.client_phone_snapshot, ''), c.phone),
  client_cin_snapshot   = COALESCE(NULLIF(s.client_cin_snapshot, ''),   c.cin),
  client_email_snapshot = COALESCE(NULLIF(s.client_email_snapshot, ''), c.email),
  client_city_snapshot  = COALESCE(NULLIF(s.client_city_snapshot, ''),  c.city)
FROM public.clients c
WHERE s.client_id = c.id
  AND (
    coalesce(s.client_name_snapshot, '') = '' OR
    coalesce(s.client_phone_snapshot, '') = ''
  );

-- ============================================================================
-- END — 07_hardening.sql
-- ============================================================================
