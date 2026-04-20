-- =============================================================================
-- ZITOUNA — dev/make_super_admin.sql
-- Creates ONE super-admin account with password 123456.
-- Run AFTER 02_schema.sql + 03_functions.sql + 04_rls.sql are applied.
-- Idempotent: re-running only updates the password + linkage.
-- =============================================================================

create extension if not exists pgcrypto;

do $zit_mk_admin$
declare
  -- ── EDIT THESE 3 LINES ────────────────────────────────────────────────────
  v_email     text := 'admin@zitouna.com';
  v_full_name text := 'Super Admin';
  v_phone     text := '+21620000000';   -- used only for the admin_users row
  -- ──────────────────────────────────────────────────────────────────────────
  v_password  text := '123456';
  v_pwd_hash  text := crypt(v_password, gen_salt('bf', 10));
  v_email_n   text := lower(trim(v_email));
  v_phone_n   text := regexp_replace(coalesce(v_phone, ''), '\D', '', 'g');
  v_uid       uuid;
begin
  -- Deterministic UUID derived from email so re-runs hit the same row.
  v_uid := ('00000000-0000-4000-8000-' || substr(md5(v_email_n), 1, 12))::uuid;

  -- 1) auth.users — create or refresh the password/confirmation state.
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change,
    email_change_token_new, recovery_token
  )
  values (
    v_uid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated', 'authenticated',
    v_email_n,
    v_pwd_hash,
    now(),
    jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
    jsonb_build_object('full_name', v_full_name, 'phone', v_phone),
    now(), now(),
    '', '', '', ''
  )
  on conflict (id) do update
     set encrypted_password  = excluded.encrypted_password,
         email               = excluded.email,
         email_confirmed_at  = excluded.email_confirmed_at,
         raw_user_meta_data  = excluded.raw_user_meta_data,
         updated_at          = now();

  -- 2) auth.identities — required for email/password sign-in.
  insert into auth.identities (
    id, provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  )
  values (
    gen_random_uuid(), v_email_n, v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email_n, 'email_verified', true),
    'email', now(), now(), now()
  )
  on conflict (provider, provider_id) do update
     set identity_data = excluded.identity_data,
         updated_at    = now();

  -- 3) public.admin_users — SUPER_ADMIN role, active.
  insert into public.admin_users (
    id, code, full_name, email, phone, phone_normalized, role, status
  )
  values (
    v_uid, 'ADM-ROOT', v_full_name, v_email_n,
    v_phone, v_phone_n, 'SUPER_ADMIN', 'active'
  )
  on conflict (email) do update
     set id               = excluded.id,
         full_name        = excluded.full_name,
         phone            = excluded.phone,
         phone_normalized = excluded.phone_normalized,
         role             = 'SUPER_ADMIN',
         status           = 'active',
         updated_at       = now();

  raise notice 'Super admin ready:';
  raise notice '  email:    %', v_email_n;
  raise notice '  password: %', v_password;
  raise notice '  uid:      %', v_uid;
end
$zit_mk_admin$;
