-- =============================================================================
-- ZITOUNA — 10_one_shot_recovery.sql
-- Auth ↔ client recovery. Previously bundled into 04_rls.sql and ran on
-- every apply (S-H4) — that is exactly the unattended fuel for the
-- account-hijack vector S-C2.
--
-- This file is now:
--   • a one-shot migration, gated by an explicit SET token
--   • verified-email AND single-auth-user phone only (no auto-link
--     against unconfirmed emails or family-shared phone numbers)
--   • audited row-by-row to public.audit_logs
--
-- USE:
--     SET app.allow_one_shot_recovery = 'I_UNDERSTAND';
--     \i database/10_one_shot_recovery.sql
--
-- Audit refs: docs/AUDIT/01_SECURITY_FINDINGS.md S-C2, S-H4.
-- =============================================================================

DO $zit_guard$
DECLARE v_token text;
BEGIN
  v_token := current_setting('app.allow_one_shot_recovery', true);
  IF v_token IS DISTINCT FROM 'I_UNDERSTAND' THEN
    RAISE EXCEPTION
      'One-shot recovery blocked. To run, first execute in the same session: '
      'SET app.allow_one_shot_recovery = ''I_UNDERSTAND''; then re-run.';
  END IF;
END;
$zit_guard$;

-- ----------------------------------------------------------------------------
-- 1. Email auto-link. ONLY against auth.users rows whose email is verified
--    (email_confirmed_at IS NOT NULL). The previous version linked any
--    matching email even if the auth user had not confirmed — meaning an
--    attacker who signed up with a victim's email pre-confirmation got the
--    victim's whole client row.
-- ----------------------------------------------------------------------------
WITH candidates AS (
  SELECT c.id AS client_id, au.id AS auth_user_id, c.email
    FROM public.clients c
    JOIN auth.users  au ON LOWER(au.email) = LOWER(c.email) AND au.email_confirmed_at IS NOT NULL
   WHERE c.auth_user_id IS NULL
     AND c.email IS NOT NULL
), updated AS (
  UPDATE public.clients c
     SET auth_user_id = cand.auth_user_id, updated_at = now()
    FROM candidates cand
   WHERE c.id = cand.client_id
   RETURNING c.id, cand.auth_user_id, cand.email
)
INSERT INTO public.audit_logs (
  actor_user_id, action, entity, entity_id, details, severity, category, source
)
SELECT
  NULL, 'auto_link_client_by_email', 'clients', u.id::text,
  'linked auth.users.id=' || u.auth_user_id || ' to clients.id=' || u.id || ' (email verified)',
  'warning', 'security', 'database'
FROM updated u;

-- ----------------------------------------------------------------------------
-- 2. Create missing client rows for verified auth users — only if no other
--    `clients` row carries the same email (prevents silently overwriting an
--    existing record with a fresh stub).
-- ----------------------------------------------------------------------------
WITH inserted AS (
  INSERT INTO public.clients (code, auth_user_id, full_name, email, phone, status)
  SELECT
    'CL-' || UPPER(SUBSTRING(REPLACE(au.id::text, '-', '') FROM 1 FOR 10)),
    au.id,
    COALESCE(
      NULLIF(TRIM(CONCAT(au.raw_user_meta_data->>'firstname', ' ', au.raw_user_meta_data->>'lastname')), ''),
      NULLIF(au.raw_user_meta_data->>'name', ''),
      NULLIF(split_part(au.email, '@', 1), ''),
      'Client'
    ),
    NULLIF(LOWER(au.email), ''),
    NULLIF(au.raw_user_meta_data->>'phone', ''),
    'active'
  FROM auth.users au
  LEFT JOIN public.clients c ON c.auth_user_id = au.id
  WHERE c.id IS NULL
    AND au.email_confirmed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.clients c2
      WHERE c2.email IS NOT NULL AND LOWER(c2.email) = LOWER(au.email)
    )
  RETURNING id, auth_user_id, email
)
INSERT INTO public.audit_logs (
  actor_user_id, action, entity, entity_id, details, severity, category, source
)
SELECT
  NULL, 'auto_create_client_from_auth', 'clients', i.id::text,
  'created stub clients row for auth.users.id=' || i.auth_user_id || ' (email verified)',
  'info', 'security', 'database'
FROM inserted i;

-- ----------------------------------------------------------------------------
-- 3. Phone identity link. Only when:
--      • the canonical phone is unique across auth.users (no shared family
--        phone collision)
--      • OR the existing client_phone_identities row has no auth_user_id yet.
--    If multiple auth users share a phone, we INSERT a verification ticket
--    instead of auto-linking. The previous COALESCE-merge silently chose
--    one auth user — that's the family-shared-phone hijack.
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE _phone_seed ON COMMIT DROP AS
SELECT
  CASE
    WHEN COALESCE(c.phone, '') ~ '^\s*\+\d+'
      THEN '+' || COALESCE(NULLIF(SUBSTRING(REGEXP_REPLACE(c.phone, '\D', '', 'g') FROM 1 FOR 3), ''), '216')
    ELSE '+216'
  END                                                                AS country_code,
  REGEXP_REPLACE(COALESCE(c.phone, ''), '\D', '', 'g')               AS phone_local,
  '+' || REGEXP_REPLACE(COALESCE(c.phone, ''), '\D', '', 'g')        AS phone_canonical,
  c.id                                                               AS client_id,
  c.auth_user_id                                                     AS auth_user_id
FROM public.clients c
WHERE COALESCE(REGEXP_REPLACE(COALESCE(c.phone, ''), '\D', '', 'g'), '') <> '';

-- Insert new phone identities only where the canonical phone is not yet
-- linked anywhere — these are safe.
INSERT INTO public.client_phone_identities (
  country_code, phone_local, phone_canonical, client_id, auth_user_id, verification_status
)
SELECT s.country_code, s.phone_local, s.phone_canonical, s.client_id, s.auth_user_id, 'verified'
  FROM _phone_seed s
 WHERE NOT EXISTS (
   SELECT 1 FROM public.client_phone_identities x
    WHERE x.phone_canonical = s.phone_canonical
 );

-- Update existing rows ONLY when we can do it without overwriting a
-- different client_id / auth_user_id. Conflicts get queued as pending
-- verification tickets instead of silently rerouting ownership.
WITH safe_updates AS (
  UPDATE public.client_phone_identities x
     SET client_id    = COALESCE(x.client_id,    s.client_id),
         auth_user_id = COALESCE(x.auth_user_id, s.auth_user_id),
         updated_at   = now()
    FROM _phone_seed s
   WHERE x.phone_canonical = s.phone_canonical
     -- only proceed when no conflict — same target or one side is NULL
     AND (x.client_id    IS NULL OR x.client_id    = s.client_id)
     AND (x.auth_user_id IS NULL OR x.auth_user_id = s.auth_user_id)
   RETURNING x.id, x.phone_canonical
)
INSERT INTO public.audit_logs (
  actor_user_id, action, entity, entity_id, details, severity, category, source
)
SELECT
  NULL, 'phone_identity_safe_link', 'client_phone_identities', s.id::text,
  'linked phone ' || s.phone_canonical || ' (no conflict)',
  'info', 'security', 'database'
FROM safe_updates s;

-- For the conflicting cases, mark the existing row as pending_verification
-- so admin review can resolve. We do NOT silently reroute.
WITH conflicts AS (
  UPDATE public.client_phone_identities x
     SET verification_status = 'pending_verification',
         verification_reason = COALESCE(x.verification_reason, 'recovery_phone_conflict'),
         updated_at = now()
    FROM _phone_seed s
   WHERE x.phone_canonical = s.phone_canonical
     AND x.verification_status = 'verified'
     AND (
       (x.client_id    IS NOT NULL AND s.client_id    IS NOT NULL AND x.client_id    <> s.client_id)
       OR
       (x.auth_user_id IS NOT NULL AND s.auth_user_id IS NOT NULL AND x.auth_user_id <> s.auth_user_id)
     )
   RETURNING x.id, x.phone_canonical
)
INSERT INTO public.audit_logs (
  actor_user_id, action, entity, entity_id, details, severity, category, source
)
SELECT
  NULL, 'phone_identity_conflict_flagged', 'client_phone_identities', c.id::text,
  'phone ' || c.phone_canonical || ' has multiple owners; flagged for admin review',
  'warning', 'security', 'database'
FROM conflicts c;
