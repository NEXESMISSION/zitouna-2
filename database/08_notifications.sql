-- =============================================================================
-- ZITOUNA — 08_notifications.sql
-- Notification infrastructure: helpers, triggers, scheduled scans, prefs,
-- and an outbox table ready for future SMS / email / native-push delivery.
--
-- Apply after 03_functions.sql (needs public.is_active_staff). Re-runnable.
-- Everything here is additive — no existing columns are dropped or renamed.
--
-- Design goals
-- ------------
-- 1. Single source of truth: triggers on source tables (sales, payouts,
--    installments, commissions, grants, appointments) insert into
--    user_notifications. Nothing app-side needs to remember to notify.
-- 2. Fanout by scope: 'investor' → one recipient (the auth user), 'admin'
--    → every active staff auth user. Always deduped.
-- 3. Channels-ready: user_notification_prefs + notification_outbox let us
--    plug in Resend/Twilio/FCM later without touching trigger code.
-- 4. Safe-by-default: every emit is wrapped so a notification failure
--    cannot abort the business write that spawned it.
-- =============================================================================

-- Guard: 03_functions.sql must have loaded is_active_staff() before this file.
DO $zit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_active_staff'
  ) THEN
    RAISE EXCEPTION 'ZITOUNA 08_notifications: run 03_functions.sql first.';
  END IF;
END;
$zit$;

-- ============================================================================
-- 1. Additive columns on user_notifications
--    severity / category are promoted from payload to real columns so tabs,
--    badges, and future per-category prefs can filter with an index.
--    archived_at powers user-initiated archive without hard delete.
--    delivered_channels tracks which channels have successfully sent this
--    notification (outbox fills it in).
-- ============================================================================
DO $zit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_notifications' AND column_name='severity'
  ) THEN
    ALTER TABLE public.user_notifications
      ADD COLUMN severity text NOT NULL DEFAULT 'info'
        CHECK (severity IN ('info','success','warning','danger'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_notifications' AND column_name='category'
  ) THEN
    ALTER TABLE public.user_notifications
      ADD COLUMN category text NOT NULL DEFAULT 'system'
        CHECK (category IN ('commission','payout','sale','installment','visit','kyc','access','referral','system'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_notifications' AND column_name='archived_at'
  ) THEN
    ALTER TABLE public.user_notifications ADD COLUMN archived_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_notifications' AND column_name='delivered_channels'
  ) THEN
    ALTER TABLE public.user_notifications
      ADD COLUMN delivered_channels jsonb NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END;
$zit$;

-- Indexes for the common read paths. Partial indexes keep them small.
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_cat_created
  ON public.user_notifications(user_id, category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_unread_scope
  ON public.user_notifications(user_id, role_scope, created_at DESC)
  WHERE read_at IS NULL AND archived_at IS NULL;

-- Retrofit existing rows so category/severity aren't all 'system'/'info'.
-- Derived from the existing `type` enum already written by the legacy trigger.
UPDATE public.user_notifications SET
  category = CASE
    WHEN type LIKE 'commission_%'  THEN 'commission'
    WHEN type LIKE 'payout_%'      THEN 'payout'
    WHEN type LIKE 'installment_%' THEN 'installment'
    WHEN type LIKE 'sale_%'        THEN 'sale'
    WHEN type LIKE 'visit_%'       THEN 'visit'
    WHEN type LIKE 'kyc_%'         THEN 'kyc'
    WHEN type LIKE 'page_access_%' THEN 'access'
    WHEN type LIKE 'referral_%'    THEN 'referral'
    ELSE 'system'
  END,
  severity = CASE
    WHEN type IN ('commission_earned','payout_approved','payout_paid','installment_paid','sale_confirmed','kyc_approved','page_access_granted') THEN 'success'
    WHEN type IN ('payout_rejected','installment_overdue','kyc_rejected','sale_cancelled','commission_reversed')                                 THEN 'danger'
    WHEN type IN ('installment_due','visit_reminder','commission_pending')                                                                      THEN 'warning'
    ELSE 'info'
  END
WHERE (category = 'system' OR severity = 'info');

-- ============================================================================
-- 2. Catalog tables — channels, prefs, outbox
--    All prepared now so the future SMS/email/push integration is a config
--    change, not a schema migration.
-- ============================================================================

-- Catalog of delivery channels. 'in_app' is the only one enabled today; the
-- others exist as rows so the preferences UI can render them as toggles and
-- the outbox worker (future) can branch on channel_key.
CREATE TABLE IF NOT EXISTS public.notification_channels (
  channel_key text PRIMARY KEY,
  label       text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.notification_channels(channel_key, label, enabled) VALUES
  ('in_app', 'Application web',   true),
  ('email',  'Courriel',          false),
  ('sms',    'SMS',               false),
  ('push',   'Notification push', false)
ON CONFLICT (channel_key) DO NOTHING;

-- Per-user opt-outs. Default behaviour (no row) = everything ON for in_app,
-- everything OFF for other channels until enabled above. Composite PK
-- ensures one row per (user, category, channel).
CREATE TABLE IF NOT EXISTS public.user_notification_prefs (
  user_id      uuid NOT NULL,
  category     text NOT NULL CHECK (category IN ('commission','payout','sale','installment','visit','kyc','access','referral','system')),
  channel_key  text NOT NULL REFERENCES public.notification_channels(channel_key) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, channel_key)
);

-- Outbox: every emit produces one row per (recipient × channel). The in_app
-- channel short-circuits (marked delivered immediately). Other channels stay
-- status='pending' until a worker drains them. Retry/backoff fields let a
-- future edge function do exponential backoff without schema churn.
CREATE TABLE IF NOT EXISTS public.notification_outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id   uuid NOT NULL REFERENCES public.user_notifications(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL,
  channel_key       text NOT NULL REFERENCES public.notification_channels(channel_key) ON DELETE RESTRICT,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','in_flight','sent','failed','skipped')),
  attempts          int  NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  target            text,                                    -- resolved phone/email/device token
  provider_msg_id   text,                                    -- vendor side id after send
  last_error        text,
  payload_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,      -- frozen copy for replay
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON public.notification_outbox(next_attempt_at)
  WHERE status IN ('pending','in_flight');
CREATE INDEX IF NOT EXISTS idx_outbox_user_notif
  ON public.notification_outbox(notification_id);

-- ============================================================================
-- 3. RLS for new tables
-- ============================================================================

-- Table-level grants (mirrors 07_hardening.sql; kept here too so the tables
-- work even if 08 is applied standalone / before 07).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notifications      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_channels   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notification_prefs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_outbox     TO authenticated;

ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_channels_read_all ON public.notification_channels;
CREATE POLICY notif_channels_read_all ON public.notification_channels
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS notif_channels_staff_crud ON public.notification_channels;
CREATE POLICY notif_channels_staff_crud ON public.notification_channels
  FOR ALL TO authenticated
  USING (public.is_active_staff()) WITH CHECK (public.is_active_staff());

ALTER TABLE public.user_notification_prefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_prefs_self ON public.user_notification_prefs;
CREATE POLICY user_prefs_self ON public.user_notification_prefs
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_active_staff())
  WITH CHECK (user_id = auth.uid() OR public.is_active_staff());

-- Outbox is staff-only at the API layer; workers use the service_role key.
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_staff_only ON public.notification_outbox;
CREATE POLICY outbox_staff_only ON public.notification_outbox
  FOR ALL TO authenticated
  USING (public.is_active_staff()) WITH CHECK (public.is_active_staff());

-- ============================================================================
-- 4. Emit helpers
--    emit_notification  — insert one row (dedup, prefs-aware, outbox fanout)
--    emit_admin_notify  — fanout to every active staff user
--    Both are SECURITY DEFINER so any trigger can call them regardless of
--    the caller's RLS identity.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.emit_notification(
  p_user_id   uuid,
  p_scope     text,
  p_type      text,
  p_category  text,
  p_severity  text,
  p_payload   jsonb,
  p_dedupe    text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit_emit$
DECLARE
  v_id       uuid;
  v_ch       record;
  v_enabled  boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;  -- anonymous or unlinked client — silently drop
  END IF;

  -- Skip if the user has opted out of this category on in_app. Other
  -- channels are evaluated in the outbox fanout below.
  SELECT enabled INTO v_enabled
    FROM public.user_notification_prefs
    WHERE user_id = p_user_id AND category = p_category AND channel_key = 'in_app';
  IF v_enabled IS NOT NULL AND v_enabled = false THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.user_notifications (
    user_id, role_scope, type, category, severity, payload, dedupe_key
  ) VALUES (
    p_user_id, p_scope, p_type, p_category, p_severity, coalesce(p_payload, '{}'::jsonb), p_dedupe
  )
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  -- Dedupe hit: nothing to do. Safe because the originating record already
  -- had a notification written on its first pass.
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Fanout to each enabled channel. 'in_app' is marked sent immediately
  -- because the row in user_notifications IS the in-app delivery. Other
  -- channels stay pending until a worker picks them up.
  FOR v_ch IN
    SELECT c.channel_key, c.enabled
    FROM public.notification_channels c
    WHERE c.channel_key = 'in_app'
       OR c.enabled = true
  LOOP
    -- Per-user per-channel opt-out check.
    SELECT enabled INTO v_enabled
      FROM public.user_notification_prefs
      WHERE user_id = p_user_id AND category = p_category AND channel_key = v_ch.channel_key;
    IF v_enabled IS NOT NULL AND v_enabled = false THEN
      CONTINUE;
    END IF;

    INSERT INTO public.notification_outbox (
      notification_id, user_id, channel_key, status, payload_snapshot,
      sent_at
    ) VALUES (
      v_id, p_user_id, v_ch.channel_key,
      CASE WHEN v_ch.channel_key = 'in_app' THEN 'sent' ELSE 'pending' END,
      coalesce(p_payload, '{}'::jsonb),
      CASE WHEN v_ch.channel_key = 'in_app' THEN now() ELSE NULL END
    );
  END LOOP;

  -- Mark the in_app channel as delivered on the notification row itself so
  -- clients that read one row get the delivery state without a join.
  UPDATE public.user_notifications
     SET delivered_channels = delivered_channels || jsonb_build_array('in_app')
   WHERE id = v_id;

  RETURN v_id;
END;
$zit_emit$;

REVOKE ALL ON FUNCTION public.emit_notification(uuid,text,text,text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.emit_notification(uuid,text,text,text,text,jsonb,text) TO authenticated;

-- Admin fanout: broadcast to every active staff auth user. Admin rows carry
-- role_scope='admin' so the UI can show them in the staff bell separately
-- from a staff user's personal (investor-scope) notifications.
CREATE OR REPLACE FUNCTION public.emit_admin_notification(
  p_type      text,
  p_category  text,
  p_severity  text,
  p_payload   jsonb,
  p_dedupe    text
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit_emit_admin$
DECLARE
  v_admin record;
  v_count int := 0;
BEGIN
  FOR v_admin IN
    SELECT u.id AS auth_user_id
    FROM public.admin_users au
    JOIN auth.users u
      ON lower(trim(coalesce(u.email,''))) = lower(trim(coalesce(au.email,'')))
    WHERE au.status = 'active'
  LOOP
    BEGIN
      PERFORM public.emit_notification(
        v_admin.auth_user_id,
        'admin',
        p_type,
        p_category,
        p_severity,
        p_payload,
        p_dedupe || ':' || v_admin.auth_user_id::text
      );
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'emit_admin_notification skipped for %: %', v_admin.auth_user_id, sqlerrm;
    END;
  END LOOP;
  RETURN v_count;
END;
$zit_emit_admin$;

REVOKE ALL ON FUNCTION public.emit_admin_notification(text,text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.emit_admin_notification(text,text,text,jsonb,text) TO authenticated;

-- ============================================================================
-- 5. Internal lookup helper: client → auth.users.id
-- ============================================================================
CREATE OR REPLACE FUNCTION public._notif_auth_user_for_client(p_client_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $zit_auto_1$
  SELECT auth_user_id FROM public.clients WHERE id = p_client_id LIMIT 1;
$zit_auto_1$;

-- ============================================================================
-- 6. Upgrade the existing commission trigger to write category/severity and
--    to fan out a parallel admin notification so staff know when large
--    commissions hit. Payload shape stays backward compatible.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_commission_events_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit_commission_notify$
DECLARE
  v_auth_user uuid;
  v_sale_code text;
  v_buyer_name text;
  v_project_title text;
  v_parcel_label text;
  v_parcel_ids integer[];
  v_amount_fmt text;
  v_title text;
  v_body text;
  v_payload jsonb;
  v_dedupe text;
BEGIN
  BEGIN
    v_auth_user := public._notif_auth_user_for_client(NEW.beneficiary_client_id);

    SELECT
      s.code,
      coalesce(buyer.full_name, ''),
      p.title,
      coalesce(s.parcel_ids, CASE WHEN s.parcel_id IS NOT NULL THEN ARRAY[s.parcel_id] ELSE ARRAY[]::integer[] END)
    INTO v_sale_code, v_buyer_name, v_project_title, v_parcel_ids
    FROM public.sales s
    LEFT JOIN public.clients  buyer ON buyer.id = s.client_id
    LEFT JOIN public.projects p     ON p.id     = s.project_id
    WHERE s.id = NEW.sale_id;

    IF v_parcel_ids IS NOT NULL AND array_length(v_parcel_ids, 1) IS NOT NULL THEN
      IF array_length(v_parcel_ids, 1) <= 3 THEN
        SELECT string_agg('#' || x::text, ', ') INTO v_parcel_label FROM unnest(v_parcel_ids) AS x;
      ELSE
        v_parcel_label := array_length(v_parcel_ids, 1)::text || ' parcelles';
      END IF;
    END IF;

    v_amount_fmt := trim(trailing '.' from trim(trailing '0' from NEW.amount::text));
    IF v_amount_fmt = '' THEN v_amount_fmt := NEW.amount::text; END IF;

    v_title := 'Commission L' || NEW.level::text || ' — ' || v_amount_fmt || ' DT';
    v_body := 'Commission niveau ' || NEW.level::text || ' de ' || v_amount_fmt || ' DT';
    IF v_buyer_name   <> '' THEN v_body := v_body || ' sur la vente de ' || v_buyer_name; END IF;
    IF v_project_title IS NOT NULL AND v_project_title <> '' THEN v_body := v_body || ' — ' || v_project_title; END IF;
    IF v_parcel_label IS NOT NULL THEN v_body := v_body || ' (' || v_parcel_label || ')';
    ELSIF v_sale_code IS NOT NULL THEN v_body := v_body || ' [' || v_sale_code || ']';
    END IF;
    v_body := v_body || '.';

    v_payload := jsonb_build_object(
      'title', v_title, 'body', v_body,
      'link',  '/dashboard?tab=parrainage',
      'event_id', NEW.id, 'sale_id', NEW.sale_id, 'sale_code', v_sale_code,
      'buyer_name', v_buyer_name, 'project_title', v_project_title,
      'parcel_label', v_parcel_label, 'level', NEW.level,
      'amount', NEW.amount, 'status', NEW.status::text,
      'entity', jsonb_build_object('kind','commission_event','id', NEW.id)
    );

    v_dedupe := 'commission_event:' || NEW.id::text;

    IF v_auth_user IS NOT NULL THEN
      PERFORM public.emit_notification(
        v_auth_user, 'investor', 'commission_earned',
        'commission', 'success', v_payload, v_dedupe
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- S2-M4 retrofit example: persistent error log instead of bare RAISE NOTICE.
    -- _notif_log_error is defined in database/12_notifications_security_patch.sql.
    -- Falls back to NOTICE if the helper is not yet installed (re-run 12 to enable).
    BEGIN
      PERFORM public._notif_log_error(
        'trg_commission_events_notify',
        'commission_event:' || NEW.id::text,
        sqlerrm
      );
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'trg_commission_events_notify skipped for event %: %', NEW.id, sqlerrm;
    END;
  END;
  RETURN NEW;
END;
$zit_commission_notify$;

-- Reversal / cancellation: fires when a commission event is cancelled.
CREATE OR REPLACE FUNCTION public.trg_commission_events_reversed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_auth_user uuid;
  v_amount_fmt text;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status <> 'cancelled' THEN RETURN NEW; END IF;

  BEGIN
    v_auth_user := public._notif_auth_user_for_client(NEW.beneficiary_client_id);
    v_amount_fmt := trim(trailing '.' from trim(trailing '0' from NEW.amount::text));
    IF v_amount_fmt = '' THEN v_amount_fmt := NEW.amount::text; END IF;

    IF v_auth_user IS NOT NULL THEN
      PERFORM public.emit_notification(
        v_auth_user, 'investor', 'commission_reversed', 'commission', 'danger',
        jsonb_build_object(
          'title', 'Commission annulée',
          'body',  'La commission de ' || v_amount_fmt || ' DT a été annulée.',
          'link',  '/dashboard?tab=parrainage',
          'event_id', NEW.id, 'amount', NEW.amount,
          'entity', jsonb_build_object('kind','commission_event','id', NEW.id)
        ),
        'commission_event_reversed:' || NEW.id::text
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'trg_commission_events_reversed skipped for %: %', NEW.id, sqlerrm;
  END;
  RETURN NEW;
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_commission_events_reversed ON public.commission_events;
  CREATE TRIGGER zitouna_commission_events_reversed
    AFTER UPDATE OF status ON public.commission_events
    FOR EACH ROW EXECUTE FUNCTION public.trg_commission_events_reversed();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'zitouna_commission_events_reversed wiring failed: %', sqlerrm;
END; $zit$;

-- ============================================================================
-- 7. Sales — INSERT alerts admins, status transitions alert the buyer.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_sales_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_auth uuid;
  v_title text;
  v_body text;
  v_sev text;
  v_type text;
  v_project_title text;
BEGIN
  SELECT title INTO v_project_title FROM public.projects WHERE id = NEW.project_id;

  -- Admin notification on INSERT
  IF TG_OP = 'INSERT' THEN
    BEGIN
      PERFORM public.emit_admin_notification(
        'new_sale_created', 'sale', 'info',
        jsonb_build_object(
          'title', 'Nouvelle vente',
          'body',  'Vente ' || coalesce(NEW.code, '—') || ' — ' || coalesce(v_project_title, ''),
          'link',  '/admin/sales',
          'sale_id', NEW.id, 'sale_code', NEW.code,
          'entity', jsonb_build_object('kind','sale','id', NEW.id)
        ),
        'sale_created:' || NEW.id::text
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'sales_notify INSERT admin skipped for %: %', NEW.id, sqlerrm;
    END;
    RETURN NEW;
  END IF;

  -- Status changes on UPDATE — notify the buyer.
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    BEGIN
      v_auth := public._notif_auth_user_for_client(NEW.client_id);
      IF v_auth IS NULL THEN RETURN NEW; END IF;

      CASE NEW.status
        WHEN 'pending_finance' THEN
          v_type := 'sale_confirmed'; v_sev := 'success';
          v_title := 'Vente confirmée';
          v_body  := 'Votre achat ' || coalesce(NEW.code,'') || ' est en cours de validation.';
        WHEN 'active' THEN
          v_type := 'sale_active'; v_sev := 'success';
          v_title := 'Vente activée';
          v_body  := 'Votre dossier ' || coalesce(NEW.code,'') || ' est actif.';
        WHEN 'completed' THEN
          v_type := 'sale_completed'; v_sev := 'success';
          v_title := 'Vente finalisée';
          v_body  := 'Votre acte de ' || coalesce(v_project_title,'') || ' est finalisé.';
        WHEN 'cancelled' THEN
          v_type := 'sale_cancelled'; v_sev := 'danger';
          v_title := 'Vente annulée';
          v_body  := 'La vente ' || coalesce(NEW.code,'') || ' a été annulée.';
        ELSE
          RETURN NEW;  -- don't spam for internal pipeline hops we don't want surfaced
      END CASE;

      PERFORM public.emit_notification(
        v_auth, 'investor', v_type, 'sale', v_sev,
        jsonb_build_object(
          'title', v_title, 'body', v_body,
          'link',  '/dashboard',
          'sale_id', NEW.id, 'sale_code', NEW.code,
          'status', NEW.status, 'prev_status', OLD.status,
          'project_title', v_project_title,
          'entity', jsonb_build_object('kind','sale','id', NEW.id)
        ),
        'sale_status:' || NEW.id::text || ':' || NEW.status
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'sales_notify UPDATE skipped for %: %', NEW.id, sqlerrm;
    END;
  END IF;

  RETURN NEW;
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_sales_notify_ins ON public.sales;
  CREATE TRIGGER zitouna_sales_notify_ins
    AFTER INSERT ON public.sales
    FOR EACH ROW EXECUTE FUNCTION public.trg_sales_notify();

  DROP TRIGGER IF EXISTS zitouna_sales_notify_upd ON public.sales;
  CREATE TRIGGER zitouna_sales_notify_upd
    AFTER UPDATE OF status ON public.sales
    FOR EACH ROW EXECUTE FUNCTION public.trg_sales_notify();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'sales_notify wiring failed: %', sqlerrm;
END; $zit$;

-- ============================================================================
-- 8. Commission payout requests — INSERT alerts admins, status transitions
--    alert the beneficiary.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_payout_requests_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_auth uuid;
  v_title text; v_body text; v_type text; v_sev text;
  v_amount_fmt text;
  v_beneficiary_name text;
BEGIN
  v_amount_fmt := trim(trailing '.' from trim(trailing '0' from coalesce(NEW.gross_amount, 0)::text));
  IF v_amount_fmt = '' THEN v_amount_fmt := coalesce(NEW.gross_amount, 0)::text; END IF;

  SELECT coalesce(c.full_name,'') INTO v_beneficiary_name
    FROM public.clients c WHERE c.id = NEW.beneficiary_client_id;

  IF TG_OP = 'INSERT' THEN
    BEGIN
      PERFORM public.emit_admin_notification(
        'payout_requested', 'payout', 'warning',
        jsonb_build_object(
          'title', 'Demande de virement',
          'body',  coalesce(v_beneficiary_name,'') || ' — ' || v_amount_fmt || ' DT',
          'link',  '/admin/commissions?tab=payouts',
          'request_id', NEW.id, 'code', NEW.code,
          'amount', NEW.gross_amount, 'beneficiary', v_beneficiary_name,
          'entity', jsonb_build_object('kind','payout_request','id', NEW.id)
        ),
        'payout_requested:' || NEW.id::text
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'payout_notify INSERT admin skipped for %: %', NEW.id, sqlerrm;
    END;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    BEGIN
      v_auth := public._notif_auth_user_for_client(NEW.beneficiary_client_id);
      IF v_auth IS NULL THEN RETURN NEW; END IF;

      CASE NEW.status
        WHEN 'approved' THEN
          v_type := 'payout_approved'; v_sev := 'success';
          v_title := 'Virement approuvé';
          v_body  := v_amount_fmt || ' DT approuvés. Virement en préparation.';
        WHEN 'paid' THEN
          v_type := 'payout_paid'; v_sev := 'success';
          v_title := 'Virement effectué';
          v_body  := v_amount_fmt || ' DT virés' ||
                     CASE WHEN NEW.payment_ref IS NOT NULL AND NEW.payment_ref <> '' THEN ' — réf ' || NEW.payment_ref ELSE '' END || '.';
        WHEN 'rejected' THEN
          v_type := 'payout_rejected'; v_sev := 'danger';
          v_title := 'Virement refusé';
          v_body  := 'Votre demande de virement a été refusée' ||
                     CASE WHEN NEW.review_reason IS NOT NULL AND NEW.review_reason <> '' THEN ' : ' || NEW.review_reason ELSE '.' END;
        ELSE
          RETURN NEW;
      END CASE;

      PERFORM public.emit_notification(
        v_auth, 'investor', v_type, 'payout', v_sev,
        jsonb_build_object(
          'title', v_title, 'body', v_body,
          'link',  '/dashboard?tab=parrainage',
          'request_id', NEW.id, 'code', NEW.code,
          'amount', NEW.gross_amount, 'payment_ref', NEW.payment_ref,
          'reason', NEW.review_reason,
          'entity', jsonb_build_object('kind','payout_request','id', NEW.id)
        ),
        'payout_status:' || NEW.id::text || ':' || NEW.status
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'payout_notify UPDATE skipped for %: %', NEW.id, sqlerrm;
    END;
  END IF;
  RETURN NEW;
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_payout_requests_notify_ins ON public.commission_payout_requests;
  CREATE TRIGGER zitouna_payout_requests_notify_ins
    AFTER INSERT ON public.commission_payout_requests
    FOR EACH ROW EXECUTE FUNCTION public.trg_payout_requests_notify();

  DROP TRIGGER IF EXISTS zitouna_payout_requests_notify_upd ON public.commission_payout_requests;
  CREATE TRIGGER zitouna_payout_requests_notify_upd
    AFTER UPDATE OF status ON public.commission_payout_requests
    FOR EACH ROW EXECUTE FUNCTION public.trg_payout_requests_notify();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'payout_requests_notify wiring failed: %', sqlerrm;
END; $zit$;

-- ============================================================================
-- 9. Installment payments — receipts approved/rejected.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_installment_payments_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_auth uuid;
  v_client_id uuid;
  v_project_title text;
  v_amount_fmt text;
  v_title text; v_body text; v_type text; v_sev text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT p.client_id, pr.title
    INTO v_client_id, v_project_title
    FROM public.installment_plans p
    LEFT JOIN public.projects pr ON pr.id = p.project_id
   WHERE p.id = NEW.plan_id;

  v_auth := public._notif_auth_user_for_client(v_client_id);
  IF v_auth IS NULL THEN RETURN NEW; END IF;

  v_amount_fmt := trim(trailing '.' from trim(trailing '0' from coalesce(NEW.amount,0)::text));
  IF v_amount_fmt = '' THEN v_amount_fmt := coalesce(NEW.amount,0)::text; END IF;

  CASE NEW.status
    WHEN 'approved' THEN
      v_type := 'installment_paid'; v_sev := 'success';
      v_title := 'Échéance réglée';
      v_body  := 'Mois ' || NEW.month_no || ' — ' || v_amount_fmt || ' DT' ||
                 CASE WHEN v_project_title IS NOT NULL THEN ' (' || v_project_title || ')' ELSE '' END || '.';
    WHEN 'rejected' THEN
      v_type := 'installment_rejected'; v_sev := 'danger';
      v_title := 'Reçu rejeté';
      v_body  := 'Votre reçu du mois ' || NEW.month_no || ' a été rejeté' ||
                 CASE WHEN NEW.rejected_note IS NOT NULL AND NEW.rejected_note <> '' THEN ' : ' || NEW.rejected_note ELSE '.' END;
    WHEN 'submitted' THEN
      RETURN NEW;  -- buyer uploaded a receipt — don't notify them about their own action
    ELSE
      RETURN NEW;
  END CASE;

  BEGIN
    PERFORM public.emit_notification(
      v_auth, 'investor', v_type, 'installment', v_sev,
      jsonb_build_object(
        'title', v_title, 'body', v_body,
        'link',  '/installments',
        'payment_id', NEW.id, 'plan_id', NEW.plan_id,
        'month_no', NEW.month_no, 'amount', NEW.amount,
        'project_title', v_project_title,
        'entity', jsonb_build_object('kind','installment_payment','id', NEW.id)
      ),
      'installment_status:' || NEW.id::text || ':' || NEW.status
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'installment_payments_notify skipped for %: %', NEW.id, sqlerrm;
  END;
  RETURN NEW;
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_installment_payments_notify ON public.installment_payments;
  CREATE TRIGGER zitouna_installment_payments_notify
    AFTER UPDATE OF status ON public.installment_payments
    FOR EACH ROW EXECUTE FUNCTION public.trg_installment_payments_notify();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'installment_payments_notify wiring failed: %', sqlerrm;
END; $zit$;

-- ============================================================================
-- 10. Page access grants — buyer gets access to a dashboard tab.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_page_access_grants_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_auth uuid;
BEGIN
  BEGIN
    v_auth := public._notif_auth_user_for_client(NEW.client_id);
    IF v_auth IS NULL THEN RETURN NEW; END IF;

    PERFORM public.emit_notification(
      v_auth, 'investor', 'page_access_granted', 'access', 'success',
      jsonb_build_object(
        'title', 'Nouvel accès débloqué',
        'body',  'La section « ' || NEW.page_key || ' » est désormais disponible.',
        'link',  NEW.page_key,
        'grant_id', NEW.id, 'page_key', NEW.page_key,
        'entity', jsonb_build_object('kind','page_access_grant','id', NEW.id)
      ),
      'page_access:' || NEW.id::text
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'page_access_grants_notify skipped for %: %', NEW.id, sqlerrm;
  END;
  RETURN NEW;
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_page_access_grants_notify ON public.page_access_grants;
  CREATE TRIGGER zitouna_page_access_grants_notify
    AFTER INSERT ON public.page_access_grants
    FOR EACH ROW EXECUTE FUNCTION public.trg_page_access_grants_notify();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'page_access_grants_notify wiring failed: %', sqlerrm;
END; $zit$;

-- ============================================================================
-- 11. Appointments — visit scheduled + status updates. Notifies the client.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_appointments_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_auth uuid;
  v_project_title text;
  v_title text; v_body text; v_type text; v_sev text;
  v_when text;
BEGIN
  IF NEW.client_id IS NULL THEN RETURN NEW; END IF;
  v_auth := public._notif_auth_user_for_client(NEW.client_id);
  IF v_auth IS NULL THEN RETURN NEW; END IF;

  SELECT title INTO v_project_title FROM public.projects WHERE id = NEW.project_id;

  v_when := to_char(NEW.date, 'DD/MM') || ' ' || to_char(NEW.time, 'HH24:MI');

  IF TG_OP = 'INSERT' THEN
    v_type := 'visit_scheduled'; v_sev := 'info';
    v_title := 'Visite planifiée';
    v_body  := coalesce(v_project_title,'') || ' — ' || v_when;
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    CASE NEW.status
      WHEN 'confirmed' THEN v_type := 'visit_confirmed';  v_sev := 'success'; v_title := 'Visite confirmée';
      WHEN 'cancelled' THEN v_type := 'visit_cancelled';  v_sev := 'danger';  v_title := 'Visite annulée';
      WHEN 'completed' THEN v_type := 'visit_completed';  v_sev := 'success'; v_title := 'Visite effectuée';
      ELSE RETURN NEW;
    END CASE;
    v_body := coalesce(v_project_title,'') || ' — ' || v_when;
  ELSE
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM public.emit_notification(
      v_auth, 'investor', v_type, 'visit', v_sev,
      jsonb_build_object(
        'title', v_title, 'body', v_body,
        'link',  '/dashboard',
        'appointment_id', NEW.id, 'appointment_code', NEW.code,
        'date', NEW.date, 'time', NEW.time,
        'project_title', v_project_title,
        'entity', jsonb_build_object('kind','appointment','id', NEW.id)
      ),
      'appointment:' || NEW.id::text || ':' || coalesce(NEW.status::text, 'init')
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'appointments_notify skipped for %: %', NEW.id, sqlerrm;
  END;
  RETURN NEW;
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_appointments_notify_ins ON public.appointments;
  CREATE TRIGGER zitouna_appointments_notify_ins
    AFTER INSERT ON public.appointments
    FOR EACH ROW EXECUTE FUNCTION public.trg_appointments_notify();

  DROP TRIGGER IF EXISTS zitouna_appointments_notify_upd ON public.appointments;
  CREATE TRIGGER zitouna_appointments_notify_upd
    AFTER UPDATE OF status ON public.appointments
    FOR EACH ROW EXECUTE FUNCTION public.trg_appointments_notify();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'appointments_notify wiring failed: %', sqlerrm;
END; $zit$;

-- ============================================================================
-- 12. New client registered — alert admins (so the call center / onboarding
--     team sees the lead). Only fires when auth_user_id gets set (i.e. the
--     client actually created an account).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_clients_registered_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
BEGIN
  -- Only on the transition NULL → value. Stub client linked to an account.
  IF NEW.auth_user_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.auth_user_id IS NOT DISTINCT FROM NEW.auth_user_id THEN RETURN NEW; END IF;

  BEGIN
    PERFORM public.emit_admin_notification(
      'new_client_registered', 'system', 'info',
      jsonb_build_object(
        'title', 'Nouveau client',
        'body',  coalesce(NEW.full_name,'') || ' — ' || coalesce(NEW.phone,''),
        'link',  '/admin/clients/' || NEW.id::text,
        'client_id', NEW.id,
        'entity', jsonb_build_object('kind','client','id', NEW.id)
      ),
      'client_registered:' || NEW.id::text
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'clients_registered_notify skipped for %: %', NEW.id, sqlerrm;
  END;
  RETURN NEW;
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_clients_registered_notify ON public.clients;
  CREATE TRIGGER zitouna_clients_registered_notify
    AFTER INSERT OR UPDATE OF auth_user_id ON public.clients
    FOR EACH ROW EXECUTE FUNCTION public.trg_clients_registered_notify();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'clients_registered_notify wiring failed: %', sqlerrm;
END; $zit$;

-- ============================================================================
-- 13. Scheduled scans — idempotent, safe to call from any scheduler
--     (pg_cron, Supabase scheduled edge function, or a manual cron).
--     Dedupe keys carry the date so the same row emits at most one
--     "due" / "overdue" per scan, and one reminder per appointment.
-- ============================================================================

-- T-3 reminder for upcoming installments + overdue emission when a row
-- stays pending past its due date.
CREATE OR REPLACE FUNCTION public.scan_installments_due_and_overdue()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_row record;
  v_auth uuid;
  v_project_title text;
  v_amount_fmt text;
  v_count int := 0;
BEGIN
  FOR v_row IN
    SELECT ip.*, p.client_id, p.project_id, pr.title AS project_title
      FROM public.installment_payments ip
      JOIN public.installment_plans p ON p.id = ip.plan_id
      LEFT JOIN public.projects pr ON pr.id = p.project_id
     WHERE ip.status = 'pending'
       AND (ip.due_date = (current_date + 3) OR ip.due_date < current_date)
  LOOP
    v_auth := public._notif_auth_user_for_client(v_row.client_id);
    IF v_auth IS NULL THEN CONTINUE; END IF;

    v_amount_fmt := trim(trailing '.' from trim(trailing '0' from coalesce(v_row.amount,0)::text));
    IF v_amount_fmt = '' THEN v_amount_fmt := coalesce(v_row.amount,0)::text; END IF;

    IF v_row.due_date = current_date + 3 THEN
      BEGIN
        PERFORM public.emit_notification(
          v_auth, 'investor', 'installment_due', 'installment', 'warning',
          jsonb_build_object(
            'title', 'Échéance à venir',
            'body',  'Mois ' || v_row.month_no || ' — ' || v_amount_fmt || ' DT à régler avant le ' || to_char(v_row.due_date,'DD/MM'),
            'link',  '/installments',
            'payment_id', v_row.id, 'plan_id', v_row.plan_id,
            'due_date', v_row.due_date, 'amount', v_row.amount,
            'project_title', v_row.project_title,
            'entity', jsonb_build_object('kind','installment_payment','id', v_row.id)
          ),
          'installment_due:' || v_row.id::text || ':' || to_char(v_row.due_date,'YYYY-MM-DD')
        );
        v_count := v_count + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'scan_installments due skipped for %: %', v_row.id, sqlerrm;
      END;
    ELSIF v_row.due_date < current_date THEN
      BEGIN
        -- Dedupe is per-payment (not per-day) so the overdue notification
        -- fires exactly once when it first crosses the line.
        PERFORM public.emit_notification(
          v_auth, 'investor', 'installment_overdue', 'installment', 'danger',
          jsonb_build_object(
            'title', 'Échéance en retard',
            'body',  'Mois ' || v_row.month_no || ' — ' || v_amount_fmt || ' DT en retard depuis le ' || to_char(v_row.due_date,'DD/MM'),
            'link',  '/installments',
            'payment_id', v_row.id, 'plan_id', v_row.plan_id,
            'due_date', v_row.due_date, 'amount', v_row.amount,
            'project_title', v_row.project_title,
            'entity', jsonb_build_object('kind','installment_payment','id', v_row.id)
          ),
          'installment_overdue:' || v_row.id::text
        );
        v_count := v_count + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'scan_installments overdue skipped for %: %', v_row.id, sqlerrm;
      END;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$zit$;

REVOKE ALL ON FUNCTION public.scan_installments_due_and_overdue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scan_installments_due_and_overdue() TO authenticated;

-- T-1 reminder for appointments still scheduled for tomorrow.
CREATE OR REPLACE FUNCTION public.scan_visit_reminders()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_row record;
  v_auth uuid;
  v_project_title text;
  v_count int := 0;
BEGIN
  FOR v_row IN
    SELECT a.*, pr.title AS project_title
      FROM public.appointments a
      LEFT JOIN public.projects pr ON pr.id = a.project_id
     WHERE a.date = current_date + 1
       AND a.status IN ('pending','confirmed','new')
       AND a.type = 'visit'
       AND a.client_id IS NOT NULL
  LOOP
    v_auth := public._notif_auth_user_for_client(v_row.client_id);
    IF v_auth IS NULL THEN CONTINUE; END IF;

    BEGIN
      PERFORM public.emit_notification(
        v_auth, 'investor', 'visit_reminder', 'visit', 'warning',
        jsonb_build_object(
          'title', 'Rappel de visite',
          'body',  'Demain à ' || to_char(v_row.time, 'HH24:MI') ||
                   CASE WHEN v_row.project_title IS NOT NULL THEN ' — ' || v_row.project_title ELSE '' END,
          'link',  '/dashboard',
          'appointment_id', v_row.id, 'appointment_code', v_row.code,
          'date', v_row.date, 'time', v_row.time,
          'project_title', v_row.project_title,
          'entity', jsonb_build_object('kind','appointment','id', v_row.id)
        ),
        'visit_reminder:' || v_row.id::text || ':' || to_char(v_row.date,'YYYY-MM-DD')
      );
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'scan_visit_reminders skipped for %: %', v_row.id, sqlerrm;
    END;
  END LOOP;
  RETURN v_count;
END;
$zit$;

REVOKE ALL ON FUNCTION public.scan_visit_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scan_visit_reminders() TO authenticated;

-- Convenience aggregator — call once per day from any scheduler.
CREATE OR REPLACE FUNCTION public.run_notification_scans()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_due int := 0;
  v_visit int := 0;
BEGIN
  v_due   := public.scan_installments_due_and_overdue();
  v_visit := public.scan_visit_reminders();
  RETURN jsonb_build_object('installments', v_due, 'visits', v_visit, 'ran_at', now());
END;
$zit$;

REVOKE ALL ON FUNCTION public.run_notification_scans() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_notification_scans() TO authenticated;

-- Wire pg_cron if the extension is installed. No-op otherwise — you can
-- also invoke run_notification_scans() from a Supabase scheduled function.
DO $zit_cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'zitouna_notification_scans';
    PERFORM cron.schedule(
      'zitouna_notification_scans',
      '0 6 * * *',                                       -- 06:00 UTC every day
      $$SELECT public.run_notification_scans();$$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', sqlerrm;
END;
$zit_cron$;

-- ============================================================================
-- 14. Archive + mark-read RPCs — the client API.
--     Using SECURITY DEFINER so they can apply atomic updates without the
--     caller needing UPDATE rights on the table in every RLS policy matrix.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[])
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_count int;
BEGIN
  UPDATE public.user_notifications
     SET read_at = coalesce(read_at, now())
   WHERE user_id = auth.uid()
     AND id = ANY(coalesce(p_ids, ARRAY[]::uuid[]))
     AND read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$zit$;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(
  p_scope    text DEFAULT NULL,
  p_category text DEFAULT NULL
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_count int;
BEGIN
  UPDATE public.user_notifications
     SET read_at = now()
   WHERE user_id = auth.uid()
     AND read_at IS NULL
     AND (p_scope    IS NULL OR role_scope = p_scope)
     AND (p_category IS NULL OR category   = p_category);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$zit$;

CREATE OR REPLACE FUNCTION public.archive_notification(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_count int;
BEGIN
  UPDATE public.user_notifications
     SET archived_at = coalesce(archived_at, now()),
         read_at     = coalesce(read_at, now())
   WHERE user_id = auth.uid() AND id = p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$zit$;

REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[])        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_all_notifications_read(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archive_notification(uuid)             FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[])        TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_notification(uuid)             TO authenticated;


-- ============================================================================
-- ===== SECURITY PATCH (was 12_notifications_security_patch.sql) ============
-- Closes findings from docs/AUDIT/10_SECURITY_DEEP_AUDIT.md (S2-C1, S2-C2,
-- S2-H1, S2-H2, S2-H3, S2-M1, S2-M2, S2-M3, S2-M4, S2-M5) and the cross-cut
-- FE2-H6 (categories[] overload) from docs/AUDIT/13_FRONTEND_DEEP_AUDIT.md.
-- Re-runnable: every CREATE / ALTER is guarded.
-- ============================================================================

DO $zit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_active_staff'
  ) THEN
    RAISE EXCEPTION 'ZITOUNA 12_notifications_security_patch: run 03_functions.sql + 08_notifications.sql first.';
  END IF;
END;
$zit$;

-- =============================================================================
-- S2-C1 — admin_users.auth_user_id linkage column + safer fanout
-- ---------------------------------------------------------------------------
-- The original emit_admin_notification joined admin_users.email <-> auth.users.email
-- which is hijackable by a duplicate-email signup. We add an auth_user_id FK,
-- backfill conservatively (only when confirmation gate passes AND a single
-- match exists), then rewrite the function to fan out via the FK.
-- =============================================================================

DO $zit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='admin_users' AND column_name='auth_user_id'
  ) THEN
    ALTER TABLE public.admin_users
      ADD COLUMN auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  -- Single-row uniqueness on auth_user_id (one staff identity per auth user).
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_admin_users_auth_user_id'
  ) THEN
    CREATE UNIQUE INDEX ux_admin_users_auth_user_id
      ON public.admin_users(auth_user_id) WHERE auth_user_id IS NOT NULL;
  END IF;
END;
$zit$;

-- Conservative backfill: only set auth_user_id when:
--   (a) admin_users.auth_user_id IS NULL (don't overwrite),
--   (b) auth.users.email_confirmed_at IS NOT NULL (verified email), and
--   (c) there is EXACTLY ONE auth user with that email.
-- This prevents the hijack window where multiple signups share an email.
DO $zit$
DECLARE
  v_updated int := 0;
BEGIN
  WITH candidates AS (
    SELECT au.id AS admin_id,
           (SELECT u.id
              FROM auth.users u
             WHERE lower(trim(u.email)) = lower(trim(au.email))
               AND u.email_confirmed_at IS NOT NULL
             LIMIT 2) AS auth_id_first,
           (SELECT count(*)
              FROM auth.users u
             WHERE lower(trim(u.email)) = lower(trim(au.email))
               AND u.email_confirmed_at IS NOT NULL) AS auth_match_count
    FROM public.admin_users au
    WHERE au.auth_user_id IS NULL
      AND au.email IS NOT NULL
      AND trim(au.email) <> ''
  )
  UPDATE public.admin_users au
     SET auth_user_id = c.auth_id_first
    FROM candidates c
   WHERE au.id = c.admin_id
     AND c.auth_match_count = 1
     AND c.auth_id_first IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated > 0 THEN
    RAISE NOTICE 'S2-C1 backfill: linked auth_user_id for % admin_users row(s).', v_updated;
  END IF;
END;
$zit$;

-- Replace emit_admin_notification: fanout via the FK only. Skip rows where
-- auth_user_id IS NULL (admin not yet linked) and log a NOTICE so support
-- can spot un-linked admins by tailing pg_log.
CREATE OR REPLACE FUNCTION public.emit_admin_notification(
  p_type      text,
  p_category  text,
  p_severity  text,
  p_payload   jsonb,
  p_dedupe    text
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit_emit_admin$
DECLARE
  v_admin record;
  v_count int := 0;
  v_unlinked int := 0;
BEGIN
  FOR v_admin IN
    SELECT au.id AS admin_id, au.auth_user_id, au.email
    FROM public.admin_users au
    WHERE au.status = 'active'
  LOOP
    IF v_admin.auth_user_id IS NULL THEN
      v_unlinked := v_unlinked + 1;
      CONTINUE;  -- do not fan out via email join (S2-C1)
    END IF;

    BEGIN
      PERFORM public.emit_notification(
        v_admin.auth_user_id,
        'admin',
        p_type,
        p_category,
        p_severity,
        p_payload,
        p_dedupe || ':' || v_admin.auth_user_id::text
      );
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      PERFORM public._notif_log_error(
        'emit_admin_notification',
        p_dedupe || ':' || v_admin.auth_user_id::text,
        sqlerrm
      );
    END;
  END LOOP;

  IF v_unlinked > 0 THEN
    RAISE NOTICE 'emit_admin_notification: skipped % unlinked admin(s) (auth_user_id IS NULL). Backfill required.', v_unlinked;
  END IF;
  RETURN v_count;
END;
$zit_emit_admin$;

REVOKE ALL ON FUNCTION public.emit_admin_notification(text,text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.emit_admin_notification(text,text,text,jsonb,text) TO authenticated;

-- =============================================================================
-- S2-C2 — drop the staff-write branch on user_notification_prefs.
-- Add created_by/updated_by + trigger so every pref row carries an actor.
-- Provide an audited admin-only RPC for legitimate cross-user resets.
-- =============================================================================

DO $zit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_notification_prefs' AND column_name='created_by'
  ) THEN
    ALTER TABLE public.user_notification_prefs ADD COLUMN created_by uuid;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_notification_prefs' AND column_name='updated_by'
  ) THEN
    ALTER TABLE public.user_notification_prefs ADD COLUMN updated_by uuid;
  END IF;
END;
$zit$;

CREATE OR REPLACE FUNCTION public._user_prefs_stamp_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $zit$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, v_actor);
    NEW.updated_by := COALESCE(NEW.updated_by, v_actor);
    NEW.updated_at := COALESCE(NEW.updated_at, now());
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.updated_by := v_actor;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_user_prefs_stamp ON public.user_notification_prefs;
  CREATE TRIGGER zitouna_user_prefs_stamp
    BEFORE INSERT OR UPDATE ON public.user_notification_prefs
    FOR EACH ROW EXECUTE FUNCTION public._user_prefs_stamp_actor();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'zitouna_user_prefs_stamp wiring failed: %', sqlerrm;
END; $zit$;

-- Replace the over-permissive policy: only the owner may write their prefs.
DROP POLICY IF EXISTS user_prefs_self ON public.user_notification_prefs;
CREATE POLICY user_prefs_self ON public.user_notification_prefs
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Admin reset path — SECURITY DEFINER, requires active staff, audited.
CREATE OR REPLACE FUNCTION public.admin_reset_user_prefs(
  p_user_id     uuid,
  p_category    text,
  p_channel_key text,
  p_enabled     boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit$
DECLARE
  v_actor uuid := auth.uid();
  v_before jsonb;
BEGIN
  IF NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'admin_reset_user_prefs: caller is not active staff';
  END IF;
  IF p_user_id IS NULL OR p_category IS NULL OR p_channel_key IS NULL THEN
    RAISE EXCEPTION 'admin_reset_user_prefs: required arguments missing';
  END IF;

  SELECT to_jsonb(t) INTO v_before
    FROM public.user_notification_prefs t
   WHERE t.user_id = p_user_id AND t.category = p_category AND t.channel_key = p_channel_key;

  INSERT INTO public.user_notification_prefs (user_id, category, channel_key, enabled, created_by, updated_by)
  VALUES (p_user_id, p_category, p_channel_key, p_enabled, v_actor, v_actor)
  ON CONFLICT (user_id, category, channel_key) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        updated_by = v_actor,
        updated_at = now();

  INSERT INTO public.audit_logs (
    actor_user_id, action, entity, entity_id, details, metadata, category, source, subject_user_id
  ) VALUES (
    NULL, 'admin_reset_prefs', 'user_notification_prefs',
    p_user_id::text || ':' || p_category || ':' || p_channel_key,
    'Staff reset another user''s notification pref',
    jsonb_build_object(
      'actor', v_actor,
      'subject', p_user_id,
      'category', p_category,
      'channel_key', p_channel_key,
      'before', v_before,
      'after_enabled', p_enabled
    ),
    'governance', 'database', p_user_id
  );
  RETURN true;
END;
$zit$;

REVOKE ALL ON FUNCTION public.admin_reset_user_prefs(uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reset_user_prefs(uuid, text, text, boolean) TO authenticated;

-- =============================================================================
-- S2-H1 — audit-log every admin-scope read/archive action.
-- Wrappers around the existing 08-defined RPCs. The new functions are the
-- only surface granted to authenticated; the original RPCs are kept (with
-- their original signatures) for any direct callers, but this patch revokes
-- their EXECUTE from authenticated and re-exposes them via the audited
-- wrappers below. The wrappers retain the original return types.
-- =============================================================================

CREATE OR REPLACE FUNCTION public._notif_audit_touch(
  p_action  text,
  p_id      uuid,
  p_payload jsonb,
  p_scope   text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit$
BEGIN
  IF p_scope = 'admin' THEN
    BEGIN
      INSERT INTO public.audit_logs (
        actor_user_id, action, entity, entity_id, details, metadata, category, source, subject_user_id
      ) VALUES (
        NULL, p_action, 'user_notifications', p_id::text,
        'Admin-scope notification touched',
        jsonb_build_object(
          'actor', auth.uid(),
          'notification_id', p_id,
          'payload_snapshot', p_payload
        ),
        'security', 'database', auth.uid()
      );
    EXCEPTION WHEN OTHERS THEN
      -- Never block the read/archive call on a failed audit write.
      -- An RLS policy mismatch or audit_logs schema drift must not cause
      -- the bell's "Tout marquer lu" button to silently fail, because
      -- the user-visible behavior is "clicked, still unread after refresh".
      RAISE WARNING '[_notif_audit_touch] audit insert failed: %', SQLERRM;
    END;
  END IF;
END;
$zit$;

REVOKE ALL ON FUNCTION public._notif_audit_touch(text, uuid, jsonb, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[])
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_count int;
  v_row record;
BEGIN
  -- Audit each admin-scope notification before mutating it.
  FOR v_row IN
    SELECT id, role_scope, payload
      FROM public.user_notifications
     WHERE user_id = auth.uid()
       AND id = ANY(coalesce(p_ids, ARRAY[]::uuid[]))
       AND read_at IS NULL
       AND role_scope = 'admin'
  LOOP
    PERFORM public._notif_audit_touch('notification_marked_read', v_row.id, v_row.payload, v_row.role_scope);
  END LOOP;

  UPDATE public.user_notifications
     SET read_at = coalesce(read_at, now())
   WHERE user_id = auth.uid()
     AND id = ANY(coalesce(p_ids, ARRAY[]::uuid[]))
     AND read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$zit$;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(
  p_scope    text DEFAULT NULL,
  p_category text DEFAULT NULL
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_count int;
  v_row record;
BEGIN
  FOR v_row IN
    SELECT id, role_scope, payload
      FROM public.user_notifications
     WHERE user_id = auth.uid()
       AND read_at IS NULL
       AND role_scope = 'admin'
       AND (p_scope    IS NULL OR role_scope = p_scope)
       AND (p_category IS NULL OR category   = p_category)
  LOOP
    PERFORM public._notif_audit_touch('notification_marked_read', v_row.id, v_row.payload, v_row.role_scope);
  END LOOP;

  UPDATE public.user_notifications
     SET read_at = now()
   WHERE user_id = auth.uid()
     AND read_at IS NULL
     AND (p_scope    IS NULL OR role_scope = p_scope)
     AND (p_category IS NULL OR category   = p_category);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$zit$;

REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[])        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_all_notifications_read(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[])        TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read(text,text) TO authenticated;

-- =============================================================================
-- FE2-H6 — categories[] overload so the "Commissions" tab can mark both
-- 'commission' AND 'payout' read in a single round trip.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read_categories(
  p_scope      text,
  p_categories text[]
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_count int;
  v_row record;
  v_cats text[] := COALESCE(p_categories, ARRAY[]::text[]);
BEGIN
  FOR v_row IN
    SELECT id, role_scope, payload
      FROM public.user_notifications
     WHERE user_id = auth.uid()
       AND read_at IS NULL
       AND role_scope = 'admin'
       AND (p_scope IS NULL OR role_scope = p_scope)
       AND (array_length(v_cats, 1) IS NULL OR category = ANY(v_cats))
  LOOP
    PERFORM public._notif_audit_touch('notification_marked_read', v_row.id, v_row.payload, v_row.role_scope);
  END LOOP;

  UPDATE public.user_notifications
     SET read_at = now()
   WHERE user_id = auth.uid()
     AND read_at IS NULL
     AND (p_scope IS NULL OR role_scope = p_scope)
     AND (array_length(v_cats, 1) IS NULL OR category = ANY(v_cats));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$zit$;

REVOKE ALL ON FUNCTION public.mark_all_notifications_read_categories(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read_categories(text, text[]) TO authenticated;

-- =============================================================================
-- S2-H2 — narrow notification_channels writes to SUPER_ADMIN, audit changes.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $zit_auto_2$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users au
    WHERE au.status = 'active'
      AND au.role = 'SUPER_ADMIN'
      AND (
        au.auth_user_id = auth.uid()
        OR (
          au.auth_user_id IS NULL
          AND lower(trim(coalesce(au.email,''))) = lower(trim(coalesce(auth.email(),'')))
        )
      )
  );
$zit_auto_2$;

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

DROP POLICY IF EXISTS notif_channels_staff_crud ON public.notification_channels;
DROP POLICY IF EXISTS notif_channels_read_staff ON public.notification_channels;
DROP POLICY IF EXISTS notif_channels_write_super ON public.notification_channels;

-- All active staff may read the channel catalog (label, enabled flag).
CREATE POLICY notif_channels_read_staff ON public.notification_channels
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

-- Only SUPER_ADMIN may write/insert/delete channels.
CREATE POLICY notif_channels_write_super ON public.notification_channels
  FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

CREATE POLICY notif_channels_update_super ON public.notification_channels
  FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

CREATE POLICY notif_channels_delete_super ON public.notification_channels
  FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- Audit trigger on notification_channels — every change leaves a trail.
CREATE OR REPLACE FUNCTION public._notif_channels_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit$
BEGIN
  INSERT INTO public.audit_logs (
    actor_user_id, action, entity, entity_id, details, metadata, category, source
  ) VALUES (
    NULL,
    'notification_channel_' || lower(TG_OP),
    'notification_channels',
    COALESCE((NEW).channel_key, (OLD).channel_key),
    'notification_channels mutated',
    jsonb_build_object(
      'actor', auth.uid(),
      'op', TG_OP,
      'before', CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,
      'after',  CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END
    ),
    'governance', 'database'
  );
  RETURN COALESCE(NEW, OLD);
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_notif_channels_audit ON public.notification_channels;
  CREATE TRIGGER zitouna_notif_channels_audit
    AFTER INSERT OR UPDATE OR DELETE ON public.notification_channels
    FOR EACH ROW EXECUTE FUNCTION public._notif_channels_audit();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'zitouna_notif_channels_audit wiring failed: %', sqlerrm;
END; $zit$;

-- =============================================================================
-- S2-H3 — _notif_auth_user_for_client is internal only.
-- The function is invoked by SECURITY DEFINER triggers; clients should
-- never reach it. REVOKE it from PUBLIC and authenticated.
-- =============================================================================
REVOKE ALL ON FUNCTION public._notif_auth_user_for_client(uuid) FROM PUBLIC;
DO $zit$ BEGIN
  REVOKE EXECUTE ON FUNCTION public._notif_auth_user_for_client(uuid) FROM authenticated;
EXCEPTION WHEN undefined_object THEN
  -- No grant present — nothing to revoke.
  NULL;
END; $zit$;

-- =============================================================================
-- S2-M1 — purge old admin-scope notifications. Mirror purge_old_audit_logs.
-- Investor-scope rows are kept (the user owns them).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.purge_old_notifications(
  p_days  int  DEFAULT 90,
  p_scope text DEFAULT 'admin'
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit$
DECLARE
  v_deleted int;
BEGIN
  IF p_days < 30 THEN
    RAISE EXCEPTION 'purge_old_notifications: refuse to purge less than 30 days old';
  END IF;
  IF p_scope NOT IN ('admin','investor') THEN
    RAISE EXCEPTION 'purge_old_notifications: invalid scope %', p_scope;
  END IF;

  DELETE FROM public.user_notifications
   WHERE created_at < (now() - (p_days || ' days')::interval)
     AND role_scope = p_scope;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$zit$;

REVOKE ALL ON FUNCTION public.purge_old_notifications(int, text) FROM PUBLIC;
-- service_role calls it via cron / scheduled function. Do not grant to authenticated.

DO $zit_cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'zitouna_notification_purge';
    PERFORM cron.schedule(
      'zitouna_notification_purge',
      '30 4 * * *',
      $$SELECT public.purge_old_notifications(90, 'admin');$$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule (notification_purge) skipped: %', sqlerrm;
END;
$zit_cron$;

-- =============================================================================
-- S2-M2 — archive_notification requires a reason; record acknowledged_by.
-- The original 1-arg RPC is preserved as a wrapper over the 2-arg version
-- with p_reason='unspecified' for backward compat with any existing callers.
-- =============================================================================
DO $zit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_notifications' AND column_name='archived_reason'
  ) THEN
    ALTER TABLE public.user_notifications ADD COLUMN archived_reason text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_notifications' AND column_name='acknowledged_by'
  ) THEN
    ALTER TABLE public.user_notifications ADD COLUMN acknowledged_by uuid;
  END IF;
END;
$zit$;

CREATE OR REPLACE FUNCTION public.archive_notification(p_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
DECLARE
  v_count int;
  v_row record;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'archive_notification: id is required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'archive_notification: reason is required';
  END IF;

  SELECT id, role_scope, payload INTO v_row
    FROM public.user_notifications
   WHERE user_id = auth.uid() AND id = p_id;

  IF v_row.id IS NOT NULL AND v_row.role_scope = 'admin' THEN
    PERFORM public._notif_audit_touch('notification_archived', v_row.id, v_row.payload, v_row.role_scope);
  END IF;

  UPDATE public.user_notifications
     SET archived_at      = coalesce(archived_at, now()),
         read_at          = coalesce(read_at, now()),
         archived_reason  = coalesce(archived_reason, p_reason),
         acknowledged_by  = coalesce(acknowledged_by, auth.uid())
   WHERE user_id = auth.uid() AND id = p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$zit$;

-- 1-arg backward-compat wrapper. Keeps the old API working.
CREATE OR REPLACE FUNCTION public.archive_notification(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $zit$
BEGIN
  RETURN public.archive_notification(p_id, 'unspecified');
END;
$zit$;

REVOKE ALL ON FUNCTION public.archive_notification(uuid)       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archive_notification(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_notification(uuid)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_notification(uuid, text) TO authenticated;

-- =============================================================================
-- S2-M3 — pg_cron job-owner pinning.
-- ---------------------------------------------------------------------------
-- pg_cron schedules created via cron.schedule(...) inherit the role that
-- called the function (typically `postgres`). On Supabase, fully pinning
-- job ownership and the target database from inside SQL requires Supabase
-- platform privileges that are not available to migration scripts.
--
-- Operational guidance:
--   * Lock the cron.job table from the Supabase dashboard so only platform
--     admins can re-schedule.
--   * Any future cron.schedule() call should be reviewed for owner pinning.
--   * Monitor cron.job_run_details for unexpected role changes.
-- =============================================================================

-- =============================================================================
-- S2-M4 — persistent error log for notification triggers.
-- The pattern in 08_notifications.sql is `EXCEPTION WHEN OTHERS THEN
-- RAISE NOTICE`. NOTICE lands in pg_log only; operators do not see it.
-- We provide a table + helper so future trigger edits can swap RAISE NOTICE
-- for a persistent row. ONE example trigger (trg_commission_events_notify)
-- has been retrofitted in 08_notifications.sql to demonstrate the pattern.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.notification_errors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_function text NOT NULL,
  dedupe_key      text,
  error_text      text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_errors_recent
  ON public.notification_errors(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_errors_source
  ON public.notification_errors(source_function, occurred_at DESC);

ALTER TABLE public.notification_errors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_errors_staff_read ON public.notification_errors;
CREATE POLICY notif_errors_staff_read ON public.notification_errors
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

CREATE OR REPLACE FUNCTION public._notif_log_error(
  _source text,
  _dedupe text,
  _error  text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $zit$
BEGIN
  INSERT INTO public.notification_errors (source_function, dedupe_key, error_text)
  VALUES (_source, _dedupe, _error);
EXCEPTION WHEN OTHERS THEN
  -- Last-ditch: if we cannot even log the error, fall back to NOTICE so we
  -- do not abort the originating trigger.
  RAISE NOTICE '_notif_log_error fallback (% | %): %', _source, _dedupe, sqlerrm;
END;
$zit$;

REVOKE ALL ON FUNCTION public._notif_log_error(text, text, text) FROM PUBLIC;
-- Triggers run as definer, so the function is invoked with elevated rights;
-- no grant to authenticated needed.

-- =============================================================================
-- S2-M5 — notification_outbox cleartext PII hardening.
-- Add target_hash + target_purged_at columns. On status='sent', clear the
-- cleartext target. The worker is expected to populate target_hash with a
-- one-way hash of the destination BEFORE sending (out of scope for SQL).
-- =============================================================================
DO $zit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='notification_outbox' AND column_name='target_hash'
  ) THEN
    ALTER TABLE public.notification_outbox ADD COLUMN target_hash text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='notification_outbox' AND column_name='target_purged_at'
  ) THEN
    ALTER TABLE public.notification_outbox ADD COLUMN target_purged_at timestamptz;
  END IF;
END;
$zit$;

CREATE OR REPLACE FUNCTION public._notif_outbox_purge_target()
RETURNS trigger
LANGUAGE plpgsql
AS $zit$
BEGIN
  -- When a row transitions into status='sent', clear the cleartext target.
  IF NEW.status = 'sent'
     AND (OLD.status IS DISTINCT FROM 'sent')
     AND NEW.target IS NOT NULL THEN
    NEW.target := NULL;
    NEW.target_purged_at := COALESCE(NEW.target_purged_at, now());
  END IF;
  RETURN NEW;
END;
$zit$;

DO $zit$ BEGIN
  DROP TRIGGER IF EXISTS zitouna_outbox_purge_target ON public.notification_outbox;
  CREATE TRIGGER zitouna_outbox_purge_target
    BEFORE UPDATE OF status ON public.notification_outbox
    FOR EACH ROW EXECUTE FUNCTION public._notif_outbox_purge_target();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'zitouna_outbox_purge_target wiring failed: %', sqlerrm;
END; $zit$;

-- =============================================================================
-- S2-M4 example retrofit applied in 08_notifications.sql:
-- trg_commission_events_notify now calls public._notif_log_error(...)
-- instead of bare RAISE NOTICE. See 08_notifications.sql for the diff.
-- =============================================================================

-- =============================================================================
-- END — 12_notifications_security_patch.sql
-- =============================================================================

-- ============================================================================
-- END — 08_notifications.sql
-- ============================================================================
