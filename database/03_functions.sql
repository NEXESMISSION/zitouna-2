-- =============================================================================
-- ZITOUNA — 03_functions.sql
-- Stored functions and RPCs consumed by the app.
-- Apply after 02_schema.sql (needs the tables).
-- Safe to re-run (all CREATE OR REPLACE).
-- =============================================================================

-- Prerequisite: schema applied.
DO $zit$
BEGIN
  IF to_regclass('public.clients') IS NULL THEN
    RAISE EXCEPTION 'ZITOUNA: run 02_schema.sql before 03_functions.sql.';
  END IF;
END;
$zit$;

-- ============================================================================
-- Helper predicates
-- ============================================================================

-- "is active staff": admin_users row matching the JWT email.
-- Case-insensitive + trim on BOTH sides so "Email@Example.com" in admin_users
-- matches "email@example.com" in the JWT (and vice-versa). Historically the
-- raw equality caused RLS denials on clients/sales INSERT for staff whose
-- email casing drifted between the two tables.
create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $zit_auto_1$
  select exists (
    select 1 from public.admin_users au
    where lower(trim(coalesce(au.email, ''))) = lower(trim(coalesce(auth.email(), '')))
      and au.status = 'active'
      and coalesce(trim(auth.email()), '') <> ''
  );
$zit_auto_1$;

-- Current client id from auth.uid(). Null when the caller is not a buyer.
-- Deterministic: if multiple clients rows ever share the same auth_user_id
-- (which ux_clients_auth_user should prevent, but historical data may have it),
-- always return the oldest row by created_at, then by id, so the resolution is
-- stable across sessions. current_client_id_is_ambiguous() lets callers
-- diagnose the duplicate case explicitly.
create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $zit_auto_2$
  select c.id from public.clients c
  where c.auth_user_id = auth.uid()
  order by c.created_at asc, c.id asc
  limit 1;
$zit_auto_2$;

create or replace function public.current_client_id_is_ambiguous()
returns boolean
language sql
stable
security definer
set search_path = public
as $zit_auto_3$
  select (select count(*) from public.clients c where c.auth_user_id = auth.uid()) > 1;
$zit_auto_3$;

-- Mirrors src/lib/phone.js `normalizePhone` (E.164-style + TN country handling).
create or replace function public.normalize_phone_e164(raw text)
returns text
language plpgsql
immutable
as $zit_auto_4$
declare
  s text;
  digits text;
begin
  if raw is null then return null; end if;
  s := trim(raw);
  if s = '' then return null; end if;
  s := regexp_replace(s, '\s+', '', 'g');
  digits := regexp_replace(s, '\D', '', 'g');
  if coalesce(digits, '') = '' then return null; end if;
  if s ~ '^\+' then return '+' || digits; end if;
  if length(digits) = 8 and substring(s from 1 for 3) <> '216' then
    return '+216' || digits;
  end if;
  if substring(digits from 1 for 3) = '216' then return '+' || digits; end if;
  return '+' || digits;
end;
$zit_auto_4$;

-- ============================================================================
-- Profile self-heal: ensures a public.clients row linked to the current JWT,
-- and re-attaches sales / installment plans / page grants / commission events /
-- ambassador wallet rows that were created against a pre-signup stub client
-- (phone-based lookup).
--
-- Returns jsonb:
--   { ok: boolean, reason: text|null, clientId: uuid|null, ambiguous: boolean,
--     phoneConflict: boolean, migrated: { sales, plans, grants, commissions,
--     wallets } }
--
-- Distinct reasons let the UI differentiate "profil absent" vs "profil ambigu"
-- vs "téléphone déjà lié à un autre compte" instead of a generic "en cours".
-- ============================================================================
create or replace function public.ensure_current_client_profile()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $zit_auto_5$
declare
  v_uid uuid := auth.uid();
  v_email text := nullif(lower(auth.email()), '');
  v_full_name text := 'Client';
  v_phone text := null;
  v_client_id uuid := null;
  v_code text;
  v_phone_digits text;
  v_cc text;
  v_cl_phone text;
  v_cl_pn text;
  v_candidates text[];
  v_ambiguous boolean := false;
  v_phone_conflict boolean := false;
  v_existing_auth_owner uuid := null;
  v_migrated_sales int := 0;
  v_migrated_plans int := 0;
  v_migrated_grants int := 0;
  v_migrated_commissions int := 0;
  v_migrated_wallets int := 0;
begin
  if v_uid is null then
    return jsonb_build_object(
      'ok', false, 'reason', 'not_authenticated',
      'clientId', null, 'ambiguous', false, 'phoneConflict', false,
      'migrated', jsonb_build_object('sales',0,'plans',0,'grants',0,'commissions',0,'wallets',0)
    );
  end if;

  v_full_name := coalesce(
    (select nullif(trim(concat(au.raw_user_meta_data->>'firstname', ' ', au.raw_user_meta_data->>'lastname')), '')
       from auth.users au where au.id = v_uid),
    (select nullif(au.raw_user_meta_data->>'name', '')
       from auth.users au where au.id = v_uid),
    (select nullif(split_part(au.email, '@', 1), '')
       from auth.users au where au.id = v_uid),
    'Client'
  );
  v_phone := (select nullif(au.raw_user_meta_data->>'phone', '')
                from auth.users au where au.id = v_uid);

  -- Link existing client row by email if not already linked.
  update public.clients c
  set auth_user_id = v_uid, updated_at = now()
  where c.auth_user_id is null
    and v_email is not null
    and c.email is not null
    and lower(c.email) = v_email;

  select c.id into v_client_id
  from public.clients c where c.auth_user_id = v_uid limit 1;

  if v_client_id is null then
    v_code := 'CL-' || upper(substring(replace(v_uid::text, '-', '') from 1 for 10));

    -- 2026-04 fix: the original INSERT had `ON CONFLICT (email) DO UPDATE`
    -- only. But `clients.code` is ALSO unique (constraint `clients_code_key`).
    -- When a stub row already exists with the same deterministic code
    -- (derived from `auth.uid()` — e.g. a previous heal that rolled back,
    -- or an admin-created stub) and a DIFFERENT email, the INSERT raised
    -- `unique_violation` on `clients_code_key` and the whole heal RPC
    -- aborted. That left the UI with `clientProfile = null`, which in turn
    -- pinned every `useSalesScoped / useInstallmentsScoped / …` on a stuck
    -- skeleton forever.
    --
    -- Wrap the INSERT in a BEGIN/EXCEPTION block so a code collision
    -- falls through to a claim-the-orphan UPDATE. If the orphan belongs
    -- to a different auth user, fall back to a suffixed code so we still
    -- create a fresh row instead of blowing up the whole login.
    begin
      insert into public.clients (code, full_name, email, phone, auth_user_id, status)
      values (v_code, coalesce(v_full_name, 'Client'), v_email, v_phone, v_uid, 'active')
      on conflict (email) do update
        set auth_user_id = excluded.auth_user_id, updated_at = now()
      returning id into v_client_id;
    exception when unique_violation then
      -- Most likely: clients_code_key collided. Try to claim the orphan
      -- (row with the same generated code that has no auth_user_id yet,
      -- or whose auth_user_id is already us).
      update public.clients c
      set auth_user_id = coalesce(c.auth_user_id, v_uid),
          email        = coalesce(c.email, v_email),
          full_name    = coalesce(nullif(c.full_name, ''), v_full_name, 'Client'),
          phone        = coalesce(nullif(c.phone, ''), v_phone),
          updated_at   = now()
      where c.code = v_code
        and (c.auth_user_id is null or c.auth_user_id = v_uid)
      returning c.id into v_client_id;

      -- The code belongs to a different authenticated user → regenerate
      -- with a short random suffix so we can still provision a profile
      -- for the current user. This is an exceptional path; normal sign-ups
      -- keep the clean CL-XXXXXXXXXX shape.
      if v_client_id is null then
        v_code := v_code || '-' || substring(md5(random()::text || clock_timestamp()::text) from 1 for 6);
        insert into public.clients (code, full_name, email, phone, auth_user_id, status)
        values (v_code, coalesce(v_full_name, 'Client'), v_email, v_phone, v_uid, 'active')
        on conflict (email) do update
          set auth_user_id = excluded.auth_user_id, updated_at = now()
        returning id into v_client_id;
      end if;
    end;
  end if;

  -- Register the phone identity for future phone-based linking.
  if coalesce(trim(v_phone), '') <> '' then
    v_phone_digits := regexp_replace(v_phone, '\D', '', 'g');
    if v_phone_digits <> '' then
      if v_phone ~ '^\s*\+\d+' then
        v_cc := '+' || coalesce(nullif(substring(v_phone_digits from 1 for 3), ''), '216');
      else
        v_cc := '+216';
      end if;
      insert into public.client_phone_identities (
        country_code, phone_local, phone_canonical, client_id, auth_user_id, verification_status
      )
      values (v_cc, v_phone_digits, '+' || v_phone_digits, v_client_id, v_uid, 'verified')
      on conflict (phone_canonical) do update
        set
          client_id = coalesce(public.client_phone_identities.client_id, excluded.client_id),
          auth_user_id = coalesce(public.client_phone_identities.auth_user_id, excluded.auth_user_id),
          updated_at = now();
    end if;
  end if;

  -- Detect duplicate clients rows bound to the same auth user (historical data
  -- pre-ux_clients_auth_user). current_client_id() already picks the oldest,
  -- but we flag the caller so the UI can surface a diagnostic instead of
  -- silently using one branch's data.
  v_ambiguous := (
    select count(*) > 1
    from public.clients c where c.auth_user_id = v_uid
  );

  -- Detect phone conflict: the canonical phone identity for this phone points
  -- at a different auth user than the current one. Surface it so the UI can
  -- show "numéro déjà lié à un autre compte" instead of "en cours".
  if coalesce(trim(v_phone), '') <> '' then
    select cpi.auth_user_id into v_existing_auth_owner
    from public.client_phone_identities cpi
    where cpi.phone_canonical = '+' || coalesce(
      nullif(regexp_replace(v_phone, '\D', '', 'g'), ''), ''
    )
    limit 1;
    if v_existing_auth_owner is not null
       and v_existing_auth_owner is distinct from v_uid then
      v_phone_conflict := true;
    end if;
  end if;

  -- Re-attach sales owned by a stub client that matches this buyer's phone.
  select c.phone, c.phone_normalized::text into v_cl_phone, v_cl_pn
  from public.clients c where c.id = v_client_id;

  select coalesce(array_agg(distinct x), '{}'::text[]) into v_candidates
  from (
    select public.normalize_phone_e164(v_phone) as x
    union all select public.normalize_phone_e164(v_cl_phone)
    union all select public.normalize_phone_e164(v_cl_pn)
    union all
    select cpi.phone_canonical
    from public.client_phone_identities cpi
    where cpi.client_id = v_client_id or cpi.auth_user_id = v_uid
  ) q
  where x is not null and x <> '';

  if v_candidates is not null and cardinality(v_candidates) > 0 then
    update public.sales s
    set
      client_id = v_client_id,
      buyer_auth_user_id = coalesce(s.buyer_auth_user_id, v_uid),
      buyer_phone_normalized = coalesce(
        nullif(trim(both from s.buyer_phone_normalized), ''),
        public.normalize_phone_e164(c_old.phone),
        public.normalize_phone_e164(c_old.phone_normalized::text)
      ),
      updated_at = now()
    from public.clients c_old
    where s.client_id = c_old.id
      and s.client_id is distinct from v_client_id
      and (s.buyer_auth_user_id is null or s.buyer_auth_user_id = v_uid)
      and (c_old.auth_user_id is null or c_old.auth_user_id = v_uid)
      and (
        (
          coalesce(nullif(trim(both from s.buyer_phone_normalized), ''), '') <> ''
          and (
            s.buyer_phone_normalized = any (v_candidates)
            or regexp_replace(s.buyer_phone_normalized, '\D', '', 'g') = any (
              select regexp_replace(t, '\D', '', 'g') from unnest(v_candidates) as t
            )
            or (
              length(regexp_replace(s.buyer_phone_normalized, '\D', '', 'g')) >= 8
              and right(regexp_replace(s.buyer_phone_normalized, '\D', '', 'g'), 8) = any (
                select right(regexp_replace(t, '\D', '', 'g'), 8)
                from unnest(v_candidates) as t
                where length(regexp_replace(t, '\D', '', 'g')) >= 8
              )
            )
          )
        )
        or (
          coalesce(nullif(trim(both from s.buyer_phone_normalized), ''), '') = ''
          and (
            public.normalize_phone_e164(c_old.phone) = any (v_candidates)
            or public.normalize_phone_e164(c_old.phone_normalized::text) = any (v_candidates)
            or regexp_replace(coalesce(c_old.phone, ''), '\D', '', 'g')
              = any (select regexp_replace(t, '\D', '', 'g') from unnest(v_candidates) as t)
            or (
              length(regexp_replace(coalesce(c_old.phone, ''), '\D', '', 'g')) >= 8
              and right(regexp_replace(coalesce(c_old.phone, ''), '\D', '', 'g'), 8) = any (
                select right(regexp_replace(t, '\D', '', 'g'), 8)
                from unnest(v_candidates) as t
                where length(regexp_replace(t, '\D', '', 'g')) >= 8
              )
            )
          )
        )
      );
    GET DIAGNOSTICS v_migrated_sales = ROW_COUNT;
  end if;

  -- Keep installment_plans.client_id aligned with its sale.
  update public.installment_plans p
  set client_id = v_client_id, updated_at = now()
  from public.sales s
  where p.sale_id = s.id
    and s.client_id = v_client_id
    and p.client_id is distinct from v_client_id;
  GET DIAGNOSTICS v_migrated_plans = ROW_COUNT;

  -- Re-point commission_events whose underlying sale now belongs to v_client_id
  -- but whose beneficiary_client_id is still on the old stub client. Only move
  -- rows whose current beneficiary has no independent auth user — we never
  -- steal commissions from another authenticated buyer's account.
  --
  -- Note: Postgres forbids joining the UPDATE target (ce) as a secondary table
  -- in the FROM clause, so the "old beneficiary is unclaimed" check must go
  -- through an EXISTS / NOT EXISTS subquery correlated on ce.beneficiary_client_id.
  update public.commission_events ce
  set beneficiary_client_id = v_client_id, updated_at = now()
  from public.sales s
  where ce.sale_id = s.id
    and s.client_id = v_client_id
    and ce.beneficiary_client_id is distinct from v_client_id
    and (
      not exists (
        select 1 from public.clients oc where oc.id = ce.beneficiary_client_id
      )
      or exists (
        select 1 from public.clients oc
        where oc.id = ce.beneficiary_client_id
          and (oc.auth_user_id is null or oc.auth_user_id = v_uid)
      )
    );
  GET DIAGNOSTICS v_migrated_commissions = ROW_COUNT;

  -- Merge ambassador_wallets rows that belonged to old stubs of this user into
  -- the canonical v_client_id row.
  with candidates as (
    select w.client_id, w.balance
    from public.ambassador_wallets w
    join public.clients oc on oc.id = w.client_id
    where oc.id <> v_client_id
      and (oc.auth_user_id is null or oc.auth_user_id = v_uid)
      and exists (
        select 1 from public.commission_events ce
        join public.sales s on s.id = ce.sale_id
        where s.client_id = v_client_id
          and ce.beneficiary_client_id = oc.id
      )
  ), merged as (
    insert into public.ambassador_wallets (client_id, balance, updated_at)
    select v_client_id, coalesce(sum(c.balance), 0), now() from candidates c
    on conflict (client_id) do update
      set balance = public.ambassador_wallets.balance + excluded.balance,
          updated_at = now()
    returning client_id
  ), deleted as (
    delete from public.ambassador_wallets w
    using candidates c where w.client_id = c.client_id
    returning w.client_id
  )
  select count(*) into v_migrated_wallets from deleted;

  -- Re-point checklist page grants that still reference the old stub.
  update public.page_access_grants g
  set client_id = v_client_id
  from public.sales s
  where g.source_sale_id = s.id
    and s.client_id = v_client_id
    and g.revoked_at is null
    and g.client_id is distinct from v_client_id
    and not exists (
      select 1 from public.clients oc
      where oc.id = g.client_id
        and oc.auth_user_id is not null
        and oc.auth_user_id is distinct from v_uid
    )
    and not exists (
      select 1 from public.page_access_grants ex
      where ex.client_id = v_client_id and ex.page_key = g.page_key and ex.revoked_at is null
    );

  -- Copy any still-active grants owned by an old stub onto v_client_id. Two old
  -- grants for the same (client_id, page_key) can both pass the NOT EXISTS
  -- pre-check against the pre-statement snapshot, so we also guard with
  -- ON CONFLICT on the partial unique index to avoid unique violations.
  insert into public.page_access_grants (client_id, page_key, source_sale_id, source_checklist_key)
  select v_client_id, g.page_key, g.source_sale_id, g.source_checklist_key
  from public.page_access_grants g
  inner join public.sales s on s.id = g.source_sale_id
  where s.client_id = v_client_id
    and g.revoked_at is null
    and g.client_id is distinct from v_client_id
    and not exists (
      select 1 from public.page_access_grants ex
      where ex.client_id = v_client_id and ex.page_key = g.page_key and ex.revoked_at is null
    )
  on conflict do nothing;
  GET DIAGNOSTICS v_migrated_grants = ROW_COUNT;

  -- Audit trail: leave a trace whenever the heal actually migrated something.
  -- Zero-row runs stay quiet to keep audit_logs manageable. This lets support
  -- correlate "mysterious" wallet/parrainage recoveries to a specific login.
  if (v_migrated_sales + v_migrated_plans + v_migrated_grants
       + v_migrated_commissions + v_migrated_wallets) > 0
     or v_ambiguous or v_phone_conflict then
    insert into public.audit_logs (
      actor_user_id, actor_email, action, entity, entity_id,
      details, metadata, category, source, subject_user_id
    ) values (
      null, v_email, 'client_profile_heal', 'client',
      coalesce(v_client_id::text, v_uid::text),
      case
        when v_ambiguous then 'Heal: doublons clients détectés'
        when v_phone_conflict then 'Heal: conflit téléphone détecté'
        else 'Heal: rattachement effectué'
      end,
      jsonb_build_object(
        'auth_user_id', v_uid,
        'client_id', v_client_id,
        'ambiguous', v_ambiguous,
        'phone_conflict', v_phone_conflict,
        'migrated', jsonb_build_object(
          'sales', v_migrated_sales,
          'plans', v_migrated_plans,
          'grants', v_migrated_grants,
          'commissions', v_migrated_commissions,
          'wallets', v_migrated_wallets
        )
      ),
      'governance', 'database', v_uid
    );
  end if;

  return jsonb_build_object(
    'ok', not (v_ambiguous or v_phone_conflict),
    'reason', case
      when v_ambiguous then 'ambiguous_client_profile'
      when v_phone_conflict then 'phone_conflict'
      else null
    end,
    'clientId', v_client_id,
    'ambiguous', v_ambiguous,
    'phoneConflict', v_phone_conflict,
    'migrated', jsonb_build_object(
      'sales', v_migrated_sales,
      'plans', v_migrated_plans,
      'grants', v_migrated_grants,
      'commissions', v_migrated_commissions,
      'wallets', v_migrated_wallets
    )
  );
end;
$zit_auto_5$;

-- ============================================================================
-- Seller parcel assignments listing (staff or self).
-- ============================================================================
create or replace function public.list_seller_assignments(p_client_id uuid)
returns table (
  assignment_id uuid,
  client_id uuid,
  client_name text,
  project_id text,
  project_title text,
  parcel_id bigint,
  parcel_number int,
  active boolean,
  note text,
  assigned_by uuid,
  assigned_by_name text,
  assigned_at timestamptz,
  revoked_by uuid,
  revoked_by_name text,
  revoked_at timestamptz,
  revoked_reason text
)
language sql
stable
security definer
set search_path = public
as $zit_auto_6$
  select
    spa.id, spa.client_id, c.full_name, spa.project_id, pr.title,
    spa.parcel_id, pa.parcel_number, spa.active, spa.note,
    spa.assigned_by, au1.full_name, spa.assigned_at,
    spa.revoked_by, au2.full_name, spa.revoked_at, spa.revoked_reason
  from public.seller_parcel_assignments spa
  join public.clients c on c.id = spa.client_id
  left join public.projects pr on pr.id = spa.project_id
  left join public.parcels pa on pa.id = spa.parcel_id
  left join public.admin_users au1 on au1.id = spa.assigned_by
  left join public.admin_users au2 on au2.id = spa.revoked_by
  where p_client_id is not null
    and spa.client_id = p_client_id
    and (public.is_active_staff() or p_client_id = public.current_client_id())
  order by spa.assigned_at desc;
$zit_auto_6$;

-- Same rows as list_seller_assignments for the authenticated client (SellPage seller mode).
-- Exposed as a parameterless RPC for PostgREST / supabase-js (.rpc without args).
create or replace function public.list_my_seller_assignments()
returns table (
  assignment_id uuid,
  client_id uuid,
  client_name text,
  project_id text,
  project_title text,
  parcel_id bigint,
  parcel_number int,
  active boolean,
  note text,
  assigned_by uuid,
  assigned_by_name text,
  assigned_at timestamptz,
  revoked_by uuid,
  revoked_by_name text,
  revoked_at timestamptz,
  revoked_reason text
)
language sql
stable
security definer
set search_path = public
as $zit_auto_6b$
  select
    spa.id, spa.client_id, c.full_name, spa.project_id, pr.title,
    spa.parcel_id, pa.parcel_number, spa.active, spa.note,
    spa.assigned_by, au1.full_name, spa.assigned_at,
    spa.revoked_by, au2.full_name, spa.revoked_at, spa.revoked_reason
  from public.seller_parcel_assignments spa
  join public.clients c on c.id = spa.client_id
  left join public.projects pr on pr.id = spa.project_id
  left join public.parcels pa on pa.id = spa.parcel_id
  left join public.admin_users au1 on au1.id = spa.assigned_by
  left join public.admin_users au2 on au2.id = spa.revoked_by
  where public.current_client_id() is not null
    and spa.client_id = public.current_client_id()
  order by spa.assigned_at desc;
$zit_auto_6b$;

-- ============================================================================
-- Seller parcel assignment mutations (staff-only).
-- Assign: create/reactivate a (client_id, parcel_id) row, rejecting if the
--         parcel is already actively assigned to a DIFFERENT client.
-- Revoke: mark the row inactive (supports lookup by assignment_id OR by
--         (client_id, parcel_id) so the UI can call it without tracking ids).
-- ============================================================================
create or replace function public.assign_seller_parcel(
  p_client_id uuid,
  p_project_id text,
  p_parcel_id bigint,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $zit_assign_seller$
declare
  v_actor_id uuid;
  v_existing record;
  v_row record;
begin
  if not public.is_active_staff() then
    raise exception 'forbidden: active staff required' using errcode = '42501';
  end if;
  if p_client_id is null or p_project_id is null or p_parcel_id is null then
    raise exception 'assign_seller_parcel: client_id/project_id/parcel_id required' using errcode = '22023';
  end if;

  select au.id into v_actor_id
  from public.admin_users au
  where lower(trim(coalesce(au.email, ''))) = lower(trim(coalesce(auth.email(), '')))
  limit 1;

  -- Block if another active owner already holds this parcel.
  select spa.id, spa.client_id into v_existing
  from public.seller_parcel_assignments spa
  where spa.parcel_id = p_parcel_id and spa.active = true
  limit 1;
  if found and v_existing.client_id <> p_client_id then
    raise exception 'parcel_already_assigned' using errcode = 'P0001';
  end if;

  -- Reactivate an existing (possibly inactive) row for the same client, or insert.
  update public.seller_parcel_assignments spa
     set active = true,
         project_id = p_project_id,
         note = coalesce(p_note, ''),
         assigned_by = v_actor_id,
         assigned_at = now(),
         revoked_by = null,
         revoked_at = null,
         revoked_reason = ''
   where spa.client_id = p_client_id and spa.parcel_id = p_parcel_id
  returning spa.* into v_row;

  if not found then
    insert into public.seller_parcel_assignments(
      client_id, project_id, parcel_id, active, note, assigned_by, assigned_at
    ) values (
      p_client_id, p_project_id, p_parcel_id, true, coalesce(p_note, ''), v_actor_id, now()
    )
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'assignment_id', v_row.id,
    'client_id', v_row.client_id,
    'project_id', v_row.project_id,
    'parcel_id', v_row.parcel_id,
    'active', v_row.active,
    'assigned_at', v_row.assigned_at
  );
end;
$zit_assign_seller$;

create or replace function public.revoke_seller_parcel(
  p_assignment_id uuid default null,
  p_client_id uuid default null,
  p_parcel_id bigint default null,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $zit_revoke_seller$
declare
  v_actor_id uuid;
  v_row record;
begin
  if not public.is_active_staff() then
    raise exception 'forbidden: active staff required' using errcode = '42501';
  end if;
  if p_assignment_id is null and (p_client_id is null or p_parcel_id is null) then
    raise exception 'revoke_seller_parcel: assignment_id OR (client_id+parcel_id) required' using errcode = '22023';
  end if;

  select au.id into v_actor_id
  from public.admin_users au
  where lower(trim(coalesce(au.email, ''))) = lower(trim(coalesce(auth.email(), '')))
  limit 1;

  update public.seller_parcel_assignments spa
     set active = false,
         revoked_by = v_actor_id,
         revoked_at = now(),
         revoked_reason = coalesce(p_reason, '')
   where spa.active = true
     and (
       (p_assignment_id is not null and spa.id = p_assignment_id)
       or (p_assignment_id is null and spa.client_id = p_client_id and spa.parcel_id = p_parcel_id)
     )
  returning spa.* into v_row;

  if not found then
    return jsonb_build_object('revoked', false, 'reason', 'not_found');
  end if;

  return jsonb_build_object(
    'revoked', true,
    'assignment_id', v_row.id,
    'client_id', v_row.client_id,
    'parcel_id', v_row.parcel_id,
    'revoked_at', v_row.revoked_at
  );
end;
$zit_revoke_seller$;

grant execute on function public.assign_seller_parcel(uuid, text, bigint, text) to authenticated;
grant execute on function public.revoke_seller_parcel(uuid, uuid, bigint, text) to authenticated;

-- ============================================================================
-- Referral wallet summary: consumed by the buyer dashboard "Parrainage" card.
-- Aggregates commission events without requiring a precomputed wallet table,
-- so numbers stay correct even if ambassador_wallets isn't maintained.
-- ============================================================================
create or replace function public.get_my_referral_summary()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $zit_auto_7$
declare
  v_client_id uuid := public.current_client_id();
  v_ambiguous boolean := public.current_client_id_is_ambiguous();
  v_gains numeric(14,2) := 0;
  v_released numeric(14,2) := 0;
  v_wallet numeric(14,2) := 0;
  v_min_payout numeric(14,2) := 0;
  v_project_ids text[];
  v_max_depth int := 0;
  -- Diagnostic counters: let the UI explain why the wallet is empty
  -- ("you're not the seller on any sale", "no notary yet", etc.).
  v_linked_as_buyer int := 0;
  v_linked_as_seller int := 0;
  v_linked_as_ambassador int := 0;
  v_linked_as_agent int := 0;
  v_notary_complete_total int := 0;
  v_commission_event_count int := 0;
  v_latest_sale_summary jsonb := '[]'::jsonb;
  -- Referral gross (commissions earned per level, from commission_events).
  v_referral_gross numeric(14,2) := 0;
  v_referral_gross_per_level jsonb := '[]'::jsonb;
  v_level_gross_rules jsonb := '[]'::jsonb;
  v_l1_total numeric(14,2) := 0;
  v_l2_total numeric(14,2) := 0;
begin
  if v_client_id is null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'no_client_profile',
      'clientId', null,
      'ambiguous', false,
      'gainsAccrued', 0,
      'commissionsReleased', 0,
      'walletBalance', 0,
      'minPayoutAmount', 0,
      'fieldDepositMin', 0,
      'fullDepositTarget', 0,
      'referralGross', 0,
      'referralGrossPerLevel', '[]'::jsonb,
      'parrainageMaxDepth', 0,
      'rsRatePct', 0,
      'levelGrossRules', '[]'::jsonb,
      'l1Total', 0,
      'l2Total', 0,
      'identityVerificationBlocked', false,
      'diagnostics', jsonb_build_object(
        'linkedAsBuyer', 0, 'linkedAsSeller', 0, 'linkedAsAmbassador', 0,
        'linkedAsAgent', 0, 'notaryCompleteTotal', 0, 'commissionEventCount', 0,
        'latestSales', '[]'::jsonb
      )
    );
  end if;

  -- gainsAccrued: commissions on sales whose notary step isn't completed yet
  -- (real "in-progress" money — independent of the commission_events.status
  -- enum, which the current flow inserts directly as 'payable').
  select coalesce(sum(ce.amount), 0) into v_gains
  from public.commission_events ce
  join public.sales s on s.id = ce.sale_id
  where ce.beneficiary_client_id = v_client_id
    and ce.status in ('pending', 'payable')
    and s.notary_completed_at is null;

  -- commissionsReleased: notary-stamped, not yet paid.
  select coalesce(sum(ce.amount), 0) into v_released
  from public.commission_events ce
  join public.sales s on s.id = ce.sale_id
  where ce.beneficiary_client_id = v_client_id
    and ce.status in ('payable')
    and s.notary_completed_at is not null;

  -- walletBalance: payable and NOT locked in an open/approved payout request.
  select coalesce(sum(ce.amount), 0) into v_wallet
  from public.commission_events ce
  where ce.beneficiary_client_id = v_client_id
    and ce.status = 'payable'
    and not exists (
      select 1
      from public.commission_payout_request_items pri
      join public.commission_payout_requests pr on pr.id = pri.request_id
      where pri.commission_event_id = ce.id
        and pr.status in ('pending_review', 'approved')
    );

  -- minPayoutAmount: highest threshold across projects the beneficiary has events in.
  select array_agg(distinct s.project_id) into v_project_ids
  from public.commission_events ce
  join public.sales s on s.id = ce.sale_id
  where ce.beneficiary_client_id = v_client_id;

  if v_project_ids is not null and array_length(v_project_ids, 1) > 0 then
    -- Use the LOWEST project threshold across the beneficiary's projects so a
    -- cross-project wallet can cash out once any one project's floor is met
    -- (matches maxMinPayoutThresholdForSaleIds in db.js). Ignores zero/NULL
    -- thresholds.
    select coalesce(min(nullif(wf.minimum_payout_threshold, 0)), 0) into v_min_payout
    from public.project_workflow_settings wf
    where wf.project_id = any(v_project_ids)
      and wf.minimum_payout_threshold is not null
      and wf.minimum_payout_threshold > 0;

    select coalesce(max(pcr.level), 0) into v_max_depth
    from public.project_commission_rules pcr
    where pcr.project_id = any(v_project_ids);
  end if;

  -- Diagnostic counters: compute how this client is actually linked so the
  -- dashboard can explain a zero wallet ("0 ventes avec seller_client_id
  -- = vous → pas de commission possible", etc.) instead of just showing 0 DT.
  select count(*) into v_linked_as_buyer
  from public.sales s where s.client_id = v_client_id;

  select count(*) into v_linked_as_seller
  from public.sales s where s.seller_client_id = v_client_id;

  select count(*) into v_linked_as_ambassador
  from public.sales s where s.ambassador_client_id = v_client_id;

  -- Agent linkage goes through admin_users: only fills if the current email
  -- maps to an admin_users.id AND that id appears as sales.agent_id.
  select count(*) into v_linked_as_agent
  from public.sales s
  join public.admin_users au on au.id = s.agent_id
  where au.email = lower(trim(coalesce(auth.email(), '')));

  select count(*) into v_notary_complete_total
  from public.sales s
  where (s.client_id = v_client_id
      or s.seller_client_id = v_client_id
      or s.ambassador_client_id = v_client_id)
    and s.notary_completed_at is not null;

  select count(*) into v_commission_event_count
  from public.commission_events ce
  where ce.beneficiary_client_id = v_client_id;

  -- Last 5 linked sales with the fields that matter for commission eligibility.
  -- Using jsonb_build_object explicitly instead of row_to_jsonb(subquery) which
  -- doesn't always resolve under a restricted search_path.
  with recent as (
    select
      s.id,
      s.code,
      s.status,
      s.notary_completed_at is not null as notary_done,
      s.client_id = v_client_id as as_buyer,
      s.seller_client_id = v_client_id as as_seller,
      s.ambassador_client_id = v_client_id as as_ambassador,
      s.agreed_price,
      s.created_at
    from public.sales s
    where s.client_id = v_client_id
       or s.seller_client_id = v_client_id
       or s.ambassador_client_id = v_client_id
    order by s.created_at desc
    limit 5
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'code', r.code,
        'status', r.status,
        'notary_done', r.notary_done,
        'as_buyer', r.as_buyer,
        'as_seller', r.as_seller,
        'as_ambassador', r.as_ambassador,
        'agreed_price', r.agreed_price,
        'created_at', r.created_at
      )
      order by r.created_at desc
    ),
    '[]'::jsonb
  )
  into v_latest_sale_summary
  from recent r;

  -- Referral gross: total and per-level breakdown from commission_events.
  -- "Gross" = sum of commission_events.amount for this beneficiary across all
  -- statuses (pending, payable, paid, etc.) so the dashboard shows lifetime
  -- earnings, not just unlocked wallet balance.
  select coalesce(sum(ce.amount), 0) into v_referral_gross
  from public.commission_events ce
  where ce.beneficiary_client_id = v_client_id;

  -- Per-level breakdown: one object per level with total amount and count.
  with by_level as (
    select ce.level as lvl,
           coalesce(sum(ce.amount), 0) as total,
           count(*) as event_count
    from public.commission_events ce
    where ce.beneficiary_client_id = v_client_id
    group by ce.level
    order by ce.level
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'level', lvl,
        'total', total,
        'count', event_count
      )
      order by lvl
    ),
    '[]'::jsonb
  )
  into v_referral_gross_per_level
  from by_level;

  -- levelGrossRules: per-level amount (distinct values) observed on events,
  -- useful for the UI to display what each level pays today.
  with rules_by_level as (
    select ce.level as lvl,
           coalesce(sum(ce.amount), 0) as total
    from public.commission_events ce
    where ce.beneficiary_client_id = v_client_id
    group by ce.level
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object('level', lvl, 'grossAmount', total)
      order by lvl
    ),
    '[]'::jsonb
  )
  into v_level_gross_rules
  from rules_by_level;

  -- L1 / L2 totals for quick access.
  select coalesce(sum(ce.amount), 0) into v_l1_total
  from public.commission_events ce
  where ce.beneficiary_client_id = v_client_id
    and ce.level = 1;

  select coalesce(sum(ce.amount), 0) into v_l2_total
  from public.commission_events ce
  where ce.beneficiary_client_id = v_client_id
    and ce.level = 2;

  return jsonb_build_object(
    'ok', not v_ambiguous,
    'reason', case when v_ambiguous then 'ambiguous_client_profile' else null end,
    'clientId', v_client_id,
    'ambiguous', v_ambiguous,
    'gainsAccrued', v_gains,
    'commissionsReleased', v_released,
    'walletBalance', v_wallet,
    'minPayoutAmount', v_min_payout,
    'fieldDepositMin', 0,
    'fullDepositTarget', 0,
    'referralGross', v_referral_gross,
    'referralGrossPerLevel', v_referral_gross_per_level,
    'parrainageMaxDepth', v_max_depth,
    'rsRatePct', 0,
    'levelGrossRules', v_level_gross_rules,
    'l1Total', v_l1_total,
    'l2Total', v_l2_total,
    'identityVerificationBlocked', false,
    'diagnostics', jsonb_build_object(
      'linkedAsBuyer', v_linked_as_buyer,
      'linkedAsSeller', v_linked_as_seller,
      'linkedAsAmbassador', v_linked_as_ambassador,
      'linkedAsAgent', v_linked_as_agent,
      'notaryCompleteTotal', v_notary_complete_total,
      'commissionEventCount', v_commission_event_count,
      'latestSales', v_latest_sale_summary
    )
  );
end;
$zit_auto_7$;

-- ============================================================================
-- Ambassador payout request: aggregates unlocked payable events up to p_amount.
-- Idempotent when p_idempotency_key is provided (looked up in audit_logs).
-- ============================================================================
create or replace function public.request_ambassador_payout(
  p_amount numeric,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $zit_auto_8$
declare
  v_client_id uuid := public.current_client_id();
  v_request_id uuid;
  v_code text;
  v_sum numeric(14,2) := 0;
  v_existing_id uuid;
  v_event_ids uuid[];
begin
  if v_client_id is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = '22023';
  end if;

  -- Serialize concurrent payout requests from the same beneficiary. Without
  -- this lock, two parallel calls can both read the same "unclaimed" payable
  -- events and insert duplicate claim rows, letting the client double-book
  -- the same balance across two pending requests. The lock is scoped to the
  -- transaction and released automatically at COMMIT/ROLLBACK.
  perform pg_advisory_xact_lock(hashtext('payout:' || v_client_id::text));

  -- Idempotency: same key from same client returns the prior request id.
  if coalesce(trim(p_idempotency_key), '') <> '' then
    select (metadata->>'request_id')::uuid
    into v_existing_id
    from public.audit_logs
    where action = 'payout_request_submitted'
      and metadata->>'client_id' = v_client_id::text
      and metadata->>'idempotency_key' = p_idempotency_key
    order by created_at desc
    limit 1;
    if v_existing_id is not null then
      return jsonb_build_object('ok', true, 'requestId', v_existing_id, 'idempotent', true);
    end if;
  end if;

  -- Collect unlocked payable events in chronological order.
  select array_agg(ev_id order by created_at), coalesce(sum(amt), 0)
  into v_event_ids, v_sum
  from (
    select ce.id as ev_id, ce.amount as amt, ce.created_at as created_at
    from public.commission_events ce
    where ce.beneficiary_client_id = v_client_id
      and ce.status = 'payable'
      and not exists (
        select 1
        from public.commission_payout_request_items pri
        join public.commission_payout_requests pr on pr.id = pri.request_id
        where pri.commission_event_id = ce.id
          and pr.status in ('pending_review', 'approved')
      )
  ) t;

  if v_event_ids is null or array_length(v_event_ids, 1) = 0 then
    raise exception 'NO_PAYABLE_EVENTS' using errcode = 'P0001';
  end if;
  if v_sum < p_amount then
    raise exception 'INSUFFICIENT_BALANCE' using errcode = 'P0001';
  end if;

  v_code := 'PR-' || to_char(now(), 'YYYYMMDD') || '-' ||
            upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6));

  insert into public.commission_payout_requests (code, beneficiary_client_id, gross_amount, status)
  values (v_code, v_client_id, p_amount, 'pending_review')
  returning id into v_request_id;

  insert into public.commission_payout_request_items (request_id, commission_event_id)
  select v_request_id, evid from unnest(v_event_ids) as t(evid);

  insert into public.audit_logs (actor_user_id, action, entity, entity_id, details, metadata, category, source)
  values (
    null, 'payout_request_submitted', 'commission_payout_request', v_request_id::text,
    'Demande de paiement initiée par le client',
    jsonb_build_object(
      'client_id', v_client_id,
      'idempotency_key', p_idempotency_key,
      'request_id', v_request_id,
      'amount', p_amount,
      'event_ids', v_event_ids
    ),
    'business', 'database'
  );

  return jsonb_build_object('ok', true, 'requestId', v_request_id, 'code', v_code, 'amount', p_amount);
end;
$zit_auto_8$;

-- ============================================================================
-- Commission events — DB-side backstop
--
-- Mirrors computeCommissionEventPayloads (src/lib/db.js) so that even if a
-- sale gets its notary_completed_at set by a code path that doesn't call
-- insertCommissionEventsForCompletedSale, commissions are still created.
--
-- Rules:
--   * Fires AFTER UPDATE when notary_completed_at transitions to non-null.
--   * Idempotent: skips when commission_events already exist for the sale.
--   * Mirror of JS guard: L1 never credited to the buyer; upline walks
--     seller_relations up to the deepest configured rule level.
--   * Rules come from sales.commission_rule_snapshot->'levels' when present,
--     otherwise from project_commission_rules for the sale's project.
-- ============================================================================
create or replace function public.compute_and_insert_commissions_for_sale(p_sale_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $zit_auto_9$
declare
  v_sale record;
  v_buyer uuid;
  v_seller uuid;
  v_has_real_seller boolean;
  v_walk uuid;
  v_parent uuid;
  v_parent_from_sr uuid;
  v_parent_from_legacy uuid;
  v_parent_source text;
  v_chain uuid[] := '{}';
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

  -- Idempotent guard: do nothing if any commission already exists.
  if exists (select 1 from public.commission_events where sale_id = p_sale_id) then
    return 0;
  end if;

  v_buyer  := v_sale.client_id;
  v_seller := v_sale.seller_client_id;
  v_has_real_seller := v_seller is not null and v_seller <> v_buyer;

  -- Build rules: prefer per-sale snapshot; otherwise project-level rules.
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

  -- Upline walk: start at seller (if real) else at buyer; drop buyer from
  -- the chain so L1 never credits the buyer.
  --
  -- Parent resolution strategy:
  --   1. Prefer public.seller_relations (authoritative upline tree).
  --   2. Safety net: if no seller_relations row exists for this child, fall
  --      back to clients.referred_by_client_id (legacy column that drifts).
  --      The backfill function public.backfill_seller_relations_from_referred_by()
  --      is the real fix — this fallback exists so L2 chains don't silently
  --      break if the backfill hasn't run yet or a new signup skipped it.
  --   Cycle detection via v_chain membership is preserved for both sources.
  v_walk := case when v_has_real_seller then v_seller else v_buyer end;
  while v_walk is not null and v_steps < 40 loop
    if v_walk = any (v_chain) then exit; end if;
    v_chain := v_chain || v_walk;

    v_parent_from_sr := null;
    v_parent_from_legacy := null;
    v_parent_source := null;

    select sr.parent_client_id into v_parent_from_sr
    from public.seller_relations sr where sr.child_client_id = v_walk limit 1;

    if v_parent_from_sr is not null then
      v_parent := v_parent_from_sr;
      v_parent_source := 'seller_relations';
    else
      -- Safety net: consult legacy clients.referred_by_client_id.
      select c.referred_by_client_id into v_parent_from_legacy
      from public.clients c where c.id = v_walk limit 1;

      if v_parent_from_legacy is not null and v_parent_from_legacy <> v_walk then
        v_parent := v_parent_from_legacy;
        v_parent_source := 'clients.referred_by_client_id';

        insert into public.audit_logs (action, entity, entity_id, details, metadata, category, source)
        values (
          'commission_upline_legacy_fallback', 'sale', p_sale_id::text,
          'Upline resolution fell back to clients.referred_by_client_id (no seller_relations row).',
          jsonb_build_object(
            'source', 'db_trigger',
            'saleId', p_sale_id,
            'childClientId', v_walk,
            'parentClientId', v_parent_from_legacy,
            'step', v_steps + 1,
            'fallbackReason', 'missing_seller_relations_row'
          ),
          'business', 'database'
        );
      else
        v_parent := null;
      end if;
    end if;

    v_walk := v_parent;
    v_parent := null;
    v_steps := v_steps + 1;
  end loop;

  if not v_has_real_seller then
    -- Drop the buyer from the front of the chain.
    v_chain := array_remove(v_chain, v_buyer);
  end if;

  if array_length(v_chain, 1) is null then return 0; end if;

  -- Determine max level from rules.
  select max((elem ->> 'level')::int) into v_max_level
  from jsonb_array_elements(v_rules) as elem;

  v_base := coalesce(v_sale.agreed_price, 0);

  for v_i in 1 .. coalesce(array_length(v_chain, 1), 0) loop
    v_level := v_i;
    if v_max_level > 0 and v_level > v_max_level then exit; end if;
    v_beneficiary := v_chain[v_i];
    if v_beneficiary is null then continue; end if;

    -- Find matching rule by level, fallback to the v_i-th element.
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
          'directSeller', case when v_has_real_seller then v_seller::text else null end,
          'fallbackFromBuyerUpline', not v_has_real_seller,
          'chainPath', to_jsonb(v_chain[1:v_i]),
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
      'DB backstop created ' || v_inserted || ' commission line(s).',
      jsonb_build_object('source', 'db_trigger', 'count', v_inserted),
      'business', 'database'
    );
  end if;

  -- Second pass: reverse-sale grants. Declared further down; safe to call
  -- because Postgres resolves function references at execution time.
  begin
    v_inserted := v_inserted + public.compute_reverse_grant_commissions_for_sale(p_sale_id);
  exception when undefined_function then
    -- Function not yet migrated in this DB; main pass already committed.
    null;
  end;

  return v_inserted;
end;
$zit_auto_9$;

create or replace function public.trg_sales_notary_commissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $zit_auto_10$
begin
  if NEW.notary_completed_at is not null
     and (OLD.notary_completed_at is null or OLD.notary_completed_at is distinct from NEW.notary_completed_at) then
    perform public.compute_and_insert_commissions_for_sale(NEW.id);
  end if;
  return NEW;
end;
$zit_auto_10$;

drop trigger if exists trg_sales_notary_commissions on public.sales;
create trigger trg_sales_notary_commissions
  after update of notary_completed_at on public.sales
  for each row execute function public.trg_sales_notary_commissions();

-- ============================================================================
-- Reverse-sale commission grants
--
-- When a sale is notarized and the buyer sits in the seller's upline chain
-- (a reverse sale), the seller earns a perpetual right to receive a flat L1
-- commission on any future sale whose chain traces back to that buyer through
-- a seller_relations edge created AFTER the grant date.
-- ============================================================================

-- Walks seller_relations upline from p_from_client_id looking for p_target.
-- Returns true if target is reachable within 40 hops. Used to detect reverse
-- sales: the buyer is an ancestor of the seller.
create or replace function public.is_ancestor_via_seller_relations(
  p_from_client_id uuid,
  p_target_client_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $zit_rg_anc$
declare
  v_walk uuid := p_from_client_id;
  v_seen uuid[] := '{}';
  v_parent uuid;
  v_steps int := 0;
begin
  if p_from_client_id is null or p_target_client_id is null then return false; end if;
  if p_from_client_id = p_target_client_id then return false; end if;
  while v_walk is not null and v_steps < 40 loop
    if v_walk = any(v_seen) then return false; end if;
    v_seen := v_seen || v_walk;
    select sr.parent_client_id into v_parent
      from public.seller_relations sr
     where sr.child_client_id = v_walk
     limit 1;
    if v_parent is null then return false; end if;
    if v_parent = p_target_client_id then return true; end if;
    v_walk := v_parent;
    v_steps := v_steps + 1;
  end loop;
  return false;
end;
$zit_rg_anc$;

-- Upsert a reverse-sale grant when a completed sale is a reverse sale.
-- Idempotent: unique(beneficiary, source, trigger_sale_id).
create or replace function public.create_reverse_grant_for_sale(p_sale_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $zit_rg_create$
declare
  v_sale record;
  v_grant_id uuid;
  v_effective timestamptz;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then return null; end if;
  if v_sale.notary_completed_at is null then return null; end if;
  if v_sale.seller_client_id is null or v_sale.client_id is null then return null; end if;
  if v_sale.seller_client_id = v_sale.client_id then return null; end if;

  -- Reverse = buyer is ancestor of seller in seller_relations.
  if not public.is_ancestor_via_seller_relations(v_sale.seller_client_id, v_sale.client_id) then
    return null;
  end if;

  v_effective := coalesce(v_sale.notary_completed_at, now());

  insert into public.commission_reverse_grants (
    beneficiary_client_id, source_client_id, trigger_sale_id,
    effective_from, status
  ) values (
    v_sale.seller_client_id, v_sale.client_id, p_sale_id,
    v_effective, 'active'
  )
  on conflict (beneficiary_client_id, source_client_id, trigger_sale_id)
  do nothing
  returning id into v_grant_id;

  if v_grant_id is not null then
    insert into public.audit_logs (action, entity, entity_id, details, metadata, category, source)
    values (
      'reverse_grant_created', 'commission_reverse_grants', v_grant_id::text,
      'Reverse-sale grant created from sale ' || coalesce(v_sale.code, p_sale_id::text),
      jsonb_build_object(
        'saleId', p_sale_id,
        'beneficiaryClientId', v_sale.seller_client_id,
        'sourceClientId', v_sale.client_id,
        'effectiveFrom', v_effective
      ),
      'business', 'database'
    );
  end if;

  return v_grant_id;
end;
$zit_rg_create$;

create or replace function public.trg_sales_create_reverse_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $zit_rg_trg$
begin
  if NEW.notary_completed_at is not null
     and (OLD.notary_completed_at is null
          or OLD.notary_completed_at is distinct from NEW.notary_completed_at) then
    perform public.create_reverse_grant_for_sale(NEW.id);
  end if;
  return NEW;
end;
$zit_rg_trg$;

drop trigger if exists trg_sales_create_reverse_grant on public.sales;
create trigger trg_sales_create_reverse_grant
  after update of notary_completed_at on public.sales
  for each row execute function public.trg_sales_create_reverse_grant();

-- When a trigger sale is deleted or moved to a non-completed status, the
-- grant it created must no longer pay. ON DELETE CASCADE removes the row, so
-- this handler only covers the status-change case.
create or replace function public.trg_sales_supersede_reverse_grants()
returns trigger
language plpgsql
security definer
set search_path = public
as $zit_rg_sup$
begin
  if TG_OP = 'UPDATE'
     and OLD.notary_completed_at is not null
     and NEW.notary_completed_at is null then
    update public.commission_reverse_grants
       set status = 'superseded', updated_at = now()
     where trigger_sale_id = NEW.id
       and status = 'active';
  end if;
  return NEW;
end;
$zit_rg_sup$;

drop trigger if exists trg_sales_supersede_reverse_grants on public.sales;
create trigger trg_sales_supersede_reverse_grants
  after update of notary_completed_at on public.sales
  for each row execute function public.trg_sales_supersede_reverse_grants();

-- Second-pass commission computation: for a given sale, walk the chain built
-- by compute_and_insert_commissions_for_sale and look up reverse-sale grants
-- whose source_client_id sits on the chain and whose effective_from predates
-- the seller_relations edge linking their downline child. Each qualifying
-- grant awards the beneficiary a flat L1 commission. Cycle-guarded by
-- skipping beneficiaries already present in the chain.
create or replace function public.compute_reverse_grant_commissions_for_sale(p_sale_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $zit_rg_compute$
declare
  v_sale record;
  v_buyer uuid;
  v_seller uuid;
  v_has_real_seller boolean;
  v_walk uuid;
  v_parent uuid;
  v_chain uuid[] := '{}';
  v_steps int := 0;
  v_i int;
  v_ancestor uuid;
  v_child uuid;
  v_edge_at timestamptz;
  v_rules jsonb;
  v_l1_rule jsonb;
  v_rule_type text;
  v_rule_value numeric(14,4);
  v_cap numeric(14,2);
  v_base numeric(14,2);
  v_amount numeric(14,2);
  v_inserted int := 0;
  v_grant record;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then return 0; end if;
  if v_sale.notary_completed_at is null then return 0; end if;

  v_buyer  := v_sale.client_id;
  v_seller := v_sale.seller_client_id;
  v_has_real_seller := v_seller is not null and v_seller <> v_buyer;
  if not v_has_real_seller then return 0; end if;

  -- Build v_chain = [seller, P1, P2, ...] using seller_relations only.
  v_walk := v_seller;
  while v_walk is not null and v_steps < 40 loop
    if v_walk = any (v_chain) then exit; end if;
    v_chain := v_chain || v_walk;
    select sr.parent_client_id into v_parent
      from public.seller_relations sr
     where sr.child_client_id = v_walk
     limit 1;
    v_walk := v_parent;
    v_parent := null;
    v_steps := v_steps + 1;
  end loop;

  if coalesce(array_length(v_chain, 1), 0) < 2 then return 0; end if;

  -- Resolve L1 rule from per-sale snapshot or project rules.
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
  select elem into v_l1_rule
    from jsonb_array_elements(v_rules) as elem
   where (elem ->> 'level')::int = 1
   limit 1;
  if v_l1_rule is null then return 0; end if;

  v_rule_type := coalesce(v_l1_rule ->> 'rule_type', v_l1_rule ->> 'ruleType', 'fixed');
  v_rule_value := coalesce((v_l1_rule ->> 'value')::numeric, 0);
  v_cap := nullif(v_l1_rule ->> 'maxCapAmount', '')::numeric;
  v_base := coalesce(v_sale.agreed_price, 0);

  if v_rule_type = 'percent' then
    v_amount := round(v_base * v_rule_value / 100, 2);
  else
    v_amount := round(v_rule_value, 2);
  end if;
  if v_cap is not null then v_amount := least(v_amount, v_cap); end if;
  if v_amount <= 0 then return 0; end if;

  -- For each ancestor at position i >= 2, lookup edge (parent=ancestor,
  -- child=v_chain[i-1]) and find active grants where source=ancestor and
  -- effective_from <= edge.linked_at. Earliest grant per beneficiary wins.
  for v_i in 2 .. coalesce(array_length(v_chain, 1), 0) loop
    v_ancestor := v_chain[v_i];
    v_child    := v_chain[v_i - 1];
    if v_ancestor is null or v_child is null then continue; end if;

    select sr.linked_at into v_edge_at
      from public.seller_relations sr
     where sr.parent_client_id = v_ancestor
       and sr.child_client_id  = v_child
     limit 1;
    if v_edge_at is null then continue; end if;

    for v_grant in
      select g.*
        from public.commission_reverse_grants g
       where g.source_client_id = v_ancestor
         and g.status = 'active'
         and g.effective_from <= v_edge_at
         and g.beneficiary_client_id <> all (v_chain)
       order by g.effective_from asc
    loop
      -- Skip if a grant-tagged row already exists for this (sale, beneficiary).
      if exists (
        select 1
          from public.commission_events ce
         where ce.sale_id = p_sale_id
           and ce.beneficiary_client_id = v_grant.beneficiary_client_id
           and (ce.rule_snapshot -> 'meta' ->> 'grantId') = v_grant.id::text
      ) then
        continue;
      end if;

      insert into public.commission_events (
        sale_id, beneficiary_client_id, level, rule_snapshot, amount, status, payable_at
      ) values (
        p_sale_id, v_grant.beneficiary_client_id, 1,
        jsonb_build_object(
          'source', 'reverse_sale_grant',
          'rule', v_l1_rule,
          'meta', jsonb_build_object(
            'saleId', p_sale_id,
            'saleProjectId', v_sale.project_id,
            'buyerClientId', v_buyer,
            'level', 1,
            'beneficiaryClientId', v_grant.beneficiary_client_id,
            'directSeller', v_seller::text,
            'grantId', v_grant.id,
            'grantSourceClientId', v_ancestor,
            'grantEffectiveFrom', v_grant.effective_from,
            'edgeLinkedAt', v_edge_at,
            'chainPath', to_jsonb(v_chain[1:v_i]),
            'computedAmount', v_amount,
            'amountBase', v_base,
            'computedAt', now()
          )
        ),
        v_amount, 'payable', coalesce(v_sale.notary_completed_at, now())
      );
      v_inserted := v_inserted + 1;
    end loop;
  end loop;

  if v_inserted > 0 then
    insert into public.audit_logs (action, entity, entity_id, details, metadata, category, source)
    values (
      'reverse_grant_commissions_created', 'sale', p_sale_id::text,
      'Reverse-grant pass created ' || v_inserted || ' commission line(s).',
      jsonb_build_object('source', 'reverse_sale_grant', 'count', v_inserted),
      'business', 'database'
    );
  end if;
  return v_inserted;
end;
$zit_rg_compute$;

-- Backfill: detect all past completed reverse sales and create grants (idempotent).
create or replace function public.backfill_reverse_grants()
returns jsonb
language plpgsql
security definer
set search_path = public
as $zit_rg_bf1$
declare
  v_sale record;
  v_grants_created int := 0;
  v_sales_scanned  int := 0;
  v_grant_id uuid;
begin
  for v_sale in
    select s.id
      from public.sales s
     where s.notary_completed_at is not null
       and s.seller_client_id is not null
       and s.client_id is not null
       and s.seller_client_id <> s.client_id
  loop
    v_sales_scanned := v_sales_scanned + 1;
    v_grant_id := public.create_reverse_grant_for_sale(v_sale.id);
    if v_grant_id is not null then
      v_grants_created := v_grants_created + 1;
    end if;
  end loop;
  return jsonb_build_object(
    'sales_scanned', v_sales_scanned,
    'grants_created', v_grants_created,
    'generated_at', to_jsonb(now())
  );
end;
$zit_rg_bf1$;

-- Backfill: for every active grant, find qualifying sales and insert any
-- missing commission_events rows tagged with grantId.
create or replace function public.backfill_reverse_grant_commissions()
returns jsonb
language plpgsql
security definer
set search_path = public
as $zit_rg_bf2$
declare
  v_grant record;
  v_sale_id uuid;
  v_events_inserted int := 0;
  v_grants_scanned int := 0;
  v_sales_touched int := 0;
  v_inserted_this int := 0;
  v_sale_ids uuid[] := '{}';
begin
  for v_grant in
    select g.*
      from public.commission_reverse_grants g
     where g.status = 'active'
  loop
    v_grants_scanned := v_grants_scanned + 1;

    -- Candidate sales: any completed sale whose seller's chain traces through
    -- the grant's source, with the source→child edge linked after the grant.
    for v_sale_id in
      select distinct s.id
        from public.sales s
        join public.seller_relations sr
          on sr.parent_client_id = v_grant.source_client_id
         and sr.linked_at >= v_grant.effective_from
       where s.notary_completed_at is not null
         and s.seller_client_id is not null
         and (
           s.seller_client_id = sr.child_client_id
           or public.is_ancestor_via_seller_relations(s.seller_client_id, sr.child_client_id)
         )
    loop
      v_inserted_this := public.compute_reverse_grant_commissions_for_sale(v_sale_id);
      if v_inserted_this > 0 then
        v_events_inserted := v_events_inserted + v_inserted_this;
        if not (v_sale_id = any(v_sale_ids)) then
          v_sale_ids := v_sale_ids || v_sale_id;
          v_sales_touched := v_sales_touched + 1;
        end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'grants_scanned', v_grants_scanned,
    'sales_touched',  v_sales_touched,
    'events_inserted', v_events_inserted,
    'generated_at', to_jsonb(now())
  );
end;
$zit_rg_bf2$;

-- Admin helper: revoke a grant and cancel any unpaid commission_events it
-- produced. Paid events are left intact.
create or replace function public.revoke_reverse_grant(
  p_grant_id uuid,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $zit_rg_revoke$
declare
  v_grant record;
  v_cancelled int := 0;
  v_admin_id uuid;
begin
  if not public.is_active_staff() then
    raise exception 'revoke_reverse_grant requires staff privileges';
  end if;

  select au.id into v_admin_id
    from public.admin_users au
   where lower(au.email) = lower(auth.email())
   limit 1;

  update public.commission_reverse_grants
     set status = 'revoked',
         revoked_at = now(),
         revoked_by = v_admin_id,
         revoke_reason = p_reason,
         updated_at = now()
   where id = p_grant_id
     and status = 'active'
   returning * into v_grant;
  if v_grant.id is null then
    return jsonb_build_object('ok', false, 'reason', 'grant_not_active_or_missing');
  end if;

  with upd as (
    update public.commission_events ce
       set status = 'cancelled', updated_at = now()
     where (ce.rule_snapshot -> 'meta' ->> 'grantId') = p_grant_id::text
       and ce.status in ('pending','payable')
     returning ce.id
  )
  select count(*) into v_cancelled from upd;

  insert into public.audit_logs (action, entity, entity_id, details, metadata, category, source)
  values (
    'reverse_grant_revoked', 'commission_reverse_grants', p_grant_id::text,
    'Reverse-sale grant revoked; ' || v_cancelled || ' pending/payable event(s) cancelled.',
    jsonb_build_object('reason', p_reason, 'cancelled_events', v_cancelled, 'admin_id', v_admin_id),
    'business', 'database'
  );

  return jsonb_build_object(
    'ok', true,
    'grant_id', p_grant_id,
    'cancelled_events', v_cancelled
  );
end;
$zit_rg_revoke$;

-- ============================================================================
-- ambassador_wallets: transactional projection
--
-- The "truth" for available balance lives in commission_events minus events
-- locked in an active payout request. Previously ambassador_wallets was an
-- unused mirror; now we keep it in sync via triggers on commission_events and
-- commission_payout_request_items, so downstream consumers (BI, dashboards)
-- can read a stable denormalized row without re-running the aggregation.
--
-- Rules:
--   * One row per beneficiary_client_id.
--   * balance = sum(amount) where status='payable' AND not locked in a
--     pending_review/approved payout request.
--   * Triggers recompute the affected client's row on any change.
-- ============================================================================
create or replace function public.recompute_ambassador_wallet(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $zit_auto_11$
declare
  v_balance numeric(14,2) := 0;
begin
  if p_client_id is null then return; end if;
  select coalesce(sum(ce.amount), 0) into v_balance
  from public.commission_events ce
  where ce.beneficiary_client_id = p_client_id
    and ce.status = 'payable'
    and not exists (
      select 1
      from public.commission_payout_request_items pri
      join public.commission_payout_requests pr on pr.id = pri.request_id
      where pri.commission_event_id = ce.id
        and pr.status in ('pending_review', 'approved')
    );
  insert into public.ambassador_wallets (client_id, balance, updated_at)
  values (p_client_id, v_balance, now())
  on conflict (client_id) do update
    set balance = excluded.balance, updated_at = now();
end;
$zit_auto_11$;

create or replace function public.trg_ambassador_wallet_from_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $zit_auto_12$
begin
  if (TG_OP = 'DELETE') then
    perform public.recompute_ambassador_wallet(OLD.beneficiary_client_id);
    return OLD;
  end if;
  perform public.recompute_ambassador_wallet(NEW.beneficiary_client_id);
  if TG_OP = 'UPDATE' and NEW.beneficiary_client_id is distinct from OLD.beneficiary_client_id then
    perform public.recompute_ambassador_wallet(OLD.beneficiary_client_id);
  end if;
  return NEW;
end;
$zit_auto_12$;

drop trigger if exists trg_commission_events_wallet on public.commission_events;
create trigger trg_commission_events_wallet
  after insert or update or delete on public.commission_events
  for each row execute function public.trg_ambassador_wallet_from_event();

create or replace function public.trg_ambassador_wallet_from_payout_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $zit_auto_13$
declare
  v_client uuid;
begin
  if (TG_OP = 'DELETE') then
    select ce.beneficiary_client_id into v_client
    from public.commission_events ce where ce.id = OLD.commission_event_id;
    if v_client is not null then perform public.recompute_ambassador_wallet(v_client); end if;
    return OLD;
  end if;
  select ce.beneficiary_client_id into v_client
  from public.commission_events ce where ce.id = NEW.commission_event_id;
  if v_client is not null then perform public.recompute_ambassador_wallet(v_client); end if;
  return NEW;
end;
$zit_auto_13$;

drop trigger if exists trg_payout_items_wallet on public.commission_payout_request_items;
create trigger trg_payout_items_wallet
  after insert or update or delete on public.commission_payout_request_items
  for each row execute function public.trg_ambassador_wallet_from_payout_item();

create or replace function public.trg_ambassador_wallet_from_payout_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $zit_auto_14$
begin
  if (TG_OP = 'UPDATE' and NEW.status is distinct from OLD.status) or TG_OP = 'INSERT' or TG_OP = 'DELETE' then
    perform public.recompute_ambassador_wallet(coalesce(NEW.beneficiary_client_id, OLD.beneficiary_client_id));
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$zit_auto_14$;

drop trigger if exists trg_payout_req_wallet on public.commission_payout_requests;
create trigger trg_payout_req_wallet
  after insert or update or delete on public.commission_payout_requests
  for each row execute function public.trg_ambassador_wallet_from_payout_status();

-- ============================================================================
-- Staff-only wallet delta helper (optional; wallet balance is derived by
-- get_my_referral_summary, this is here for manual adjustments / migrations).
-- ============================================================================
create or replace function public.increment_ambassador_wallet_balance(
  p_client_id uuid,
  p_delta numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $zit_auto_15$
declare
  v_new numeric(14,2);
begin
  if p_client_id is null or p_delta is null then
    raise exception 'INVALID_PARAMS' using errcode = '22023';
  end if;
  if not public.is_active_staff() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  insert into public.ambassador_wallets (client_id, balance, updated_at)
  values (p_client_id, p_delta, now())
  on conflict (client_id) do update
    set balance = public.ambassador_wallets.balance + excluded.balance,
        updated_at = now()
  returning balance into v_new;

  return v_new;
end;
$zit_auto_15$;

-- ============================================================================
-- Admin page path normalizer (mirrors src/admin/adminNavConfig.js).
-- Lowercased, leading slash, no trailing slash, collapse duplicate slashes.
-- ============================================================================
create or replace function public.normalize_admin_page_path(raw text)
returns text
language plpgsql
immutable
as $zit_auto_16$
declare
  s text;
begin
  if raw is null then return ''; end if;
  s := lower(trim(raw));
  if s = '' then return ''; end if;
  s := regexp_replace(s, '/+', '/', 'g');
  if left(s, 1) <> '/' then s := '/' || s; end if;
  if length(s) > 1 and right(s, 1) = '/' then s := left(s, length(s) - 1); end if;
  return s;
end;
$zit_auto_16$;

-- ============================================================================
-- Delegated seller predicate: caller is a client whose effective allowed
-- pages (clients.allowed_pages UNION active page_access_grants) include
-- /admin/sell (or /sell). Used by RLS policies and by the Sell RPC to
-- authorize stub-buyer creation without staff rights.
-- ============================================================================
create or replace function public.is_delegated_seller()
returns boolean
language sql
stable
security definer
set search_path = public
as $zit_auto_17$
  with me as (
    select id, allowed_pages
    from public.clients
    where auth_user_id = auth.uid()
    order by created_at asc, id asc
    limit 1
  )
  select exists (
    select 1 from me m
    where exists (
      select 1 from jsonb_array_elements_text(coalesce(m.allowed_pages, '[]'::jsonb)) e
      where public.normalize_admin_page_path(e) in ('/admin/sell', '/sell')
    )
    or exists (
      select 1 from public.page_access_grants g
      where g.client_id = m.id
        and g.revoked_at is null
        and public.normalize_admin_page_path(g.page_key) in ('/admin/sell', '/sell')
    )
  );
$zit_auto_17$;

-- Caller's clients.id (or null) — used as a WITH CHECK guard on delegated
-- seller policies so they can only act on their own sales.
create or replace function public.current_delegated_seller_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $zit_auto_18$
  select id from public.clients where auth_user_id = auth.uid()
  order by created_at asc, id asc
  limit 1;
$zit_auto_18$;

-- ============================================================================
-- Buyer stub RPC: Sell wizard calls this when a new buyer fiche must be
-- created. security definer so it bypasses staff_clients_crud; authorization
-- checks is_active_staff() OR /admin/sell grant. Idempotent on phone / email.
-- ============================================================================
create or replace function public.create_buyer_stub_for_sale(
  p_code text,
  p_name text,
  p_email text,
  p_phone text,
  p_cin text,
  p_city text
)
returns public.clients
language plpgsql
security definer
set search_path = public, auth
as $zit_auto_19$
declare
  v_uid uuid := auth.uid();
  v_is_staff boolean := public.is_active_staff();
  v_caller_client_id uuid := null;
  v_caller_allowed jsonb := null;
  v_has_allowed boolean := false;
  v_has_grant boolean := false;
  v_phone_normalized text;
  v_email text;
  v_code text;
  v_full_name text;
  v_existing public.clients%rowtype;
  v_new public.clients%rowtype;
begin
  if v_uid is null and not v_is_staff then
    raise exception 'create_buyer_stub_for_sale: not_authenticated' using errcode = '42501';
  end if;

  if not v_is_staff then
    select id, allowed_pages into v_caller_client_id, v_caller_allowed
    from public.clients where auth_user_id = v_uid
    order by created_at asc, id asc limit 1;

    if v_caller_client_id is null then
      raise exception 'create_buyer_stub_for_sale: caller_not_linked_to_client' using errcode = '42501';
    end if;

    if v_caller_allowed is not null and jsonb_typeof(v_caller_allowed) = 'array' then
      select exists (
        select 1 from jsonb_array_elements_text(v_caller_allowed) e
        where public.normalize_admin_page_path(e) in ('/admin/sell', '/sell')
      ) into v_has_allowed;
    end if;

    select exists (
      select 1 from public.page_access_grants g
      where g.client_id = v_caller_client_id
        and g.revoked_at is null
        and public.normalize_admin_page_path(g.page_key) in ('/admin/sell', '/sell')
    ) into v_has_grant;

    if not (v_has_allowed or v_has_grant) then
      raise exception 'create_buyer_stub_for_sale: no_sell_grant' using errcode = '42501';
    end if;
  end if;

  v_phone_normalized := public.normalize_phone_e164(p_phone);
  if v_phone_normalized is null or v_phone_normalized = '' then
    raise exception 'create_buyer_stub_for_sale: phone_required' using errcode = '22023';
  end if;

  v_full_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), 'Client');
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_code := coalesce(nullif(trim(coalesce(p_code, '')), ''),
                     'CLI-' || extract(epoch from now())::bigint::text);

  select * into v_existing from public.clients
  where phone_normalized = v_phone_normalized
  order by created_at asc, id asc limit 1;
  if v_existing.id is not null then return v_existing; end if;

  if v_email is not null then
    select * into v_existing from public.clients
    where lower(email) = v_email
    order by created_at asc, id asc limit 1;
    if v_existing.id is not null then return v_existing; end if;
  end if;

  insert into public.clients (code, full_name, email, phone, phone_normalized, cin, city, status)
  values (v_code, v_full_name, v_email, coalesce(p_phone, ''), v_phone_normalized,
          nullif(trim(coalesce(p_cin, '')), ''), nullif(trim(coalesce(p_city, '')), ''),
          'active')
  returning * into v_new;

  return v_new;
end;
$zit_auto_19$;

-- ============================================================================
-- Auto-link clients.auth_user_id ↔ auth.users.id
--
-- Without this, a stub buyer created by a delegated seller stays unlinked
-- from its future auth account — the buyer dashboard (RLS on current_client_id())
-- then shows an empty portfolio and no commissions.
-- Linking works in both directions, fired by triggers on each side.
-- Matching keys: email, phone E.164, phone last-8 fallback.
-- All helpers respect the ux_clients_auth_user UNIQUE (one-to-one) invariant.
-- ============================================================================

create or replace function public.autolink_clients_for_auth_user(p_auth_uid uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $zit_auto_20$
declare
  v_email text; v_meta_phone text; v_e164 text; v_last8 text;
  v_linked integer := 0;
begin
  if p_auth_uid is null then return 0; end if;
  if exists (select 1 from public.clients where auth_user_id = p_auth_uid) then
    return 0;
  end if;

  select lower(trim(u.email)), nullif(trim(u.raw_user_meta_data->>'phone'), '')
    into v_email, v_meta_phone
  from auth.users u where u.id = p_auth_uid;

  if v_meta_phone is not null then
    v_e164  := public.normalize_phone_e164(v_meta_phone);
    v_last8 := nullif(right(regexp_replace(v_meta_phone, '\D', '', 'g'), 8), '');
  end if;

  with cand as (
    select c.id from public.clients c
    where c.auth_user_id is null
      and (
            (v_email is not null and c.email is not null and lower(trim(c.email)) = v_email)
         or (v_e164  is not null and c.phone_normalized = v_e164)
         or (v_last8 is not null
              and right(regexp_replace(coalesce(c.phone_normalized, ''), '\D', '', 'g'), 8) = v_last8)
      )
    order by c.created_at asc, c.id asc
    limit 1
  )
  update public.clients c
     set auth_user_id = p_auth_uid, updated_at = now()
    from cand where c.id = cand.id;

  get diagnostics v_linked = row_count;
  return v_linked;
end;
$zit_auto_20$;

create or replace function public.autolink_client_to_auth_user(p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $zit_auto_21$
declare
  v_email text; v_phone text; v_last8 text; v_uid uuid;
begin
  if p_client_id is null then return null; end if;

  select lower(trim(c.email)), c.phone_normalized into v_email, v_phone
  from public.clients c where c.id = p_client_id and auth_user_id is null;
  if not found then return null; end if;

  if v_phone is not null then
    v_last8 := nullif(right(regexp_replace(v_phone, '\D', '', 'g'), 8), '');
  end if;

  if v_email is not null then
    select u.id into v_uid from auth.users u
     where lower(trim(u.email)) = v_email
     order by u.created_at asc limit 1;
  end if;
  if v_uid is null and v_phone is not null then
    select u.id into v_uid from auth.users u
     where public.normalize_phone_e164(nullif(u.raw_user_meta_data->>'phone', '')) = v_phone
     order by u.created_at asc limit 1;
  end if;
  if v_uid is null and v_last8 is not null then
    select u.id into v_uid from auth.users u
     where right(regexp_replace(coalesce(u.raw_user_meta_data->>'phone', ''), '\D', '', 'g'), 8) = v_last8
     order by u.created_at asc limit 1;
  end if;

  if v_uid is null then return null; end if;
  if exists (select 1 from public.clients where auth_user_id = v_uid) then
    return null;
  end if;

  update public.clients set auth_user_id = v_uid, updated_at = now()
   where id = p_client_id and auth_user_id is null;
  return v_uid;
end;
$zit_auto_21$;

-- Trigger: on auth.users INSERT or email/metadata UPDATE, link matching clients.
create or replace function public.trg_auth_users_autolink_clients()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $zit_auto_22$
begin
  perform public.autolink_clients_for_auth_user(NEW.id);
  return NEW;
end;
$zit_auto_22$;

drop trigger if exists zitouna_auth_users_autolink_insert on auth.users;
create trigger zitouna_auth_users_autolink_insert
  after insert on auth.users
  for each row execute function public.trg_auth_users_autolink_clients();

drop trigger if exists zitouna_auth_users_autolink_update on auth.users;
create trigger zitouna_auth_users_autolink_update
  after update of email, raw_user_meta_data on auth.users
  for each row execute function public.trg_auth_users_autolink_clients();

-- Forward trigger on public.clients INSERT was removed intentionally.
--
-- It scanned auth.users sequentially (no index on metadata phone, per-row
-- function calls) and could easily exceed 15 s on any non-trivial auth
-- table, breaking the Sell wizard with "délai dépassé". The REVERSE trigger
-- on auth.users (above) covers the common case (buyer signs up after the
-- stub exists — the cheap, indexed path). For the rare case where the auth
-- user already exists when the stub is created, heal_my_client_profile_now()
-- on dashboard mount closes the gap. Do NOT re-add a BEFORE INSERT trigger
-- on public.clients that queries auth.users.

-- App-callable self-heal — dashboard calls this on mount when clientProfile
-- is missing but auth.uid exists (session loaded before the link was made).
create or replace function public.heal_my_client_profile_now()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $zit_auto_23$
declare
  v_uid uuid := auth.uid();
  v_linked integer;
  v_cid uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  v_linked := public.autolink_clients_for_auth_user(v_uid);
  select id into v_cid from public.clients where auth_user_id = v_uid
   order by created_at asc, id asc limit 1;
  return jsonb_build_object('ok', v_cid is not null, 'linked', v_linked, 'clientId', v_cid);
end;
$zit_auto_23$;

-- ============================================================================
-- Sale completion invariant safety net
--
-- The CHECK constraint sales_completed_has_notary_date (in 02_schema.sql)
-- guarantees status='completed' ⇒ notary_completed_at set. This trigger
-- auto-fills notary_completed_at = now() if a caller tries to set
-- status='completed' without providing the date, so the CHECK never fires
-- and users never lose dashboard visibility.
-- ============================================================================
create or replace function public.trg_sales_fill_notary_on_complete()
returns trigger
language plpgsql
as $zit_auto_24$
begin
  if NEW.status = 'completed' and NEW.notary_completed_at is null then
    NEW.notary_completed_at := coalesce(OLD.notary_completed_at, now());
    if coalesce(NEW.pipeline_status, '') <> 'completed' then
      NEW.pipeline_status := 'completed';
    end if;
  end if;
  return NEW;
end;
$zit_auto_24$;

drop trigger if exists zitouna_sales_fill_notary_on_complete on public.sales;
create trigger zitouna_sales_fill_notary_on_complete
  before insert or update of status, notary_completed_at on public.sales
  for each row execute function public.trg_sales_fill_notary_on_complete();

-- ============================================================================
-- Backfill seller_relations from the legacy clients.referred_by_client_id.
--
-- Historically the referral tree was stored only on clients.referred_by_client_id.
-- The authoritative source today is public.seller_relations, but the legacy
-- column keeps getting populated on some signup paths and then drifts. This
-- one-time (and safe-to-re-run) backfill copies every legacy edge into
-- seller_relations so the commission walker in
-- compute_and_insert_commissions_for_sale sees a complete L1/L2 chain.
--
-- Rules:
--   * Skip rows where referred_by_client_id is null.
--   * Skip self-referential rows (child = parent) — the CHECK constraint
--     seller_relations_no_self would reject them anyway.
--   * ON CONFLICT (child_client_id) DO NOTHING — the schema enforces
--     uniqueness on child_client_id, so existing rows are never overwritten.
--   * Returns the number of rows actually inserted (i.e. newly backfilled).
-- ============================================================================
create or replace function public.backfill_seller_relations_from_referred_by()
returns integer
language plpgsql
security definer
set search_path = public
as $zit_auto_25$
declare
  v_inserted integer := 0;
begin
  with inserted as (
    insert into public.seller_relations (child_client_id, parent_client_id, source_sale_id, linked_at)
    select c.id, c.referred_by_client_id, null, now()
    from public.clients c
    where c.referred_by_client_id is not null
      and c.referred_by_client_id <> c.id
    on conflict (child_client_id) do nothing
    returning 1
  )
  select count(*) into v_inserted from inserted;

  if v_inserted > 0 then
    insert into public.audit_logs (action, entity, entity_id, details, metadata, category, source)
    values (
      'seller_relations_backfilled', 'seller_relations', null,
      'Backfilled ' || v_inserted || ' seller_relations row(s) from clients.referred_by_client_id.',
      jsonb_build_object('source', 'backfill_seller_relations_from_referred_by', 'count', v_inserted),
      'business', 'database'
    );
  end if;

  return v_inserted;
end;
$zit_auto_25$;

-- ============================================================================
-- Auto-parrainage on sale insert
--
-- Every time a sale is created we materialize the buyer → seller parrainage
-- edge in public.seller_relations. Without this, the buyer's upline stays
-- empty and if they later become a seller themselves the commission walker
-- in compute_and_insert_commissions_for_sale cannot climb past L1.
--
-- Rules:
--   * Skip if the sale has no seller_client_id, or seller equals buyer.
--   * ON CONFLICT (child_client_id) DO NOTHING — Option B "first sale wins":
--     a buyer's first-ever sale sets their parrain, subsequent sales don't
--     overwrite it.
--   * Also heals the legacy clients.referred_by_client_id column when it is
--     still null, so downstream reports that read the legacy field stay
--     consistent with seller_relations.
--   * Wrapped in EXCEPTION WHEN undefined_table/undefined_column so the
--     trigger never blocks a sale insert if the schema drifts during a
--     migration — the upstream code path already runs its own linker.
-- ============================================================================
create or replace function public.trg_sales_auto_parrainage()
returns trigger
language plpgsql
security definer
set search_path = public
as $zit_auto_26$
declare
  v_buyer uuid;
  v_seller uuid;
begin
  v_buyer := NEW.client_id;
  v_seller := NEW.seller_client_id;

  if v_seller is null or v_seller = v_buyer or v_buyer is null then
    return NEW;
  end if;

  begin
    insert into public.seller_relations (
      child_client_id, parent_client_id, source_sale_id, linked_at
    ) values (
      v_buyer, v_seller, NEW.id, now()
    )
    on conflict (child_client_id) do nothing;

    update public.clients
       set referred_by_client_id = v_seller,
           updated_at = now()
     where id = v_buyer
       and referred_by_client_id is null;
  exception
    when undefined_table or undefined_column then
      -- Schema not yet fully applied; let the sale insert proceed without
      -- materializing the parrainage edge. backfill_parrainage_from_sales()
      -- will close the gap on the next apply.
      return NEW;
  end;

  return NEW;
end;
$zit_auto_26$;

drop trigger if exists zitouna_sales_auto_parrainage on public.sales;
create trigger zitouna_sales_auto_parrainage
  after insert on public.sales
  for each row execute function public.trg_sales_auto_parrainage();

-- ============================================================================
-- Historical backfill: materialize seller_relations from existing sales.
--
-- Re-applies the same buyer → seller edge logic as the INSERT trigger over
-- every pre-existing sale, oldest first so Option B "first sale wins"
-- actually reflects chronological order. Safe to re-run: the unique on
-- seller_relations.child_client_id guarantees idempotency.
-- ============================================================================
create or replace function public.backfill_parrainage_from_sales()
returns integer
language plpgsql
security definer
set search_path = public
as $zit_auto_27$
declare
  v_inserted integer := 0;
begin
  begin
    with ordered_sales as (
      select s.id, s.client_id, s.seller_client_id, s.created_at
      from public.sales s
      where s.client_id is not null
        and s.seller_client_id is not null
        and s.seller_client_id <> s.client_id
      order by s.created_at asc, s.id asc
    ),
    inserted as (
      insert into public.seller_relations (
        child_client_id, parent_client_id, source_sale_id, linked_at
      )
      select os.client_id, os.seller_client_id, os.id, now()
      from ordered_sales os
      on conflict (child_client_id) do nothing
      returning 1
    )
    select count(*) into v_inserted from inserted;

    -- Heal legacy clients.referred_by_client_id where still null, using the
    -- oldest sale per buyer to stay consistent with Option B.
    update public.clients c
       set referred_by_client_id = t.seller_client_id,
           updated_at = now()
      from (
        select distinct on (s.client_id)
               s.client_id, s.seller_client_id
        from public.sales s
        where s.client_id is not null
          and s.seller_client_id is not null
          and s.seller_client_id <> s.client_id
        order by s.client_id, s.created_at asc, s.id asc
      ) t
     where c.id = t.client_id
       and c.referred_by_client_id is null;
  exception
    when undefined_table or undefined_column then
      return 0;
  end;

  if v_inserted > 0 then
    insert into public.audit_logs (action, entity, entity_id, details, metadata, category, source)
    values (
      'seller_relations_backfilled_from_sales', 'seller_relations', null,
      'Backfilled ' || v_inserted || ' seller_relations row(s) from public.sales history.',
      jsonb_build_object('source', 'backfill_parrainage_from_sales', 'count', v_inserted),
      'business', 'database'
    );
  end if;

  return v_inserted;
end;
$zit_auto_27$;

-- ============================================================================
-- Default commission rules seed
--
-- Inserts a default L1/L2/L3 ladder (60 / 20 / 10 DT fixed) for every
-- project that has ZERO rows in public.project_commission_rules. Projects
-- that already configured their own rules are left untouched.
--
-- Schema note: project_commission_rules stores (rule_type, value) rather
-- than a single "amount" column. We insert rule_type='fixed' with
-- value=60/20/10 which is the semantic equivalent of the requested
-- (level, amount) seed. The unique(project_id, level) constraint on the
-- table keeps us idempotent via ON CONFLICT DO NOTHING.
-- ============================================================================
create or replace function public.seed_default_commission_rules()
returns integer
language plpgsql
security definer
set search_path = public
as $zit_auto_28$
declare
  v_inserted integer := 0;
begin
  begin
    with projects_needing_rules as (
      select p.id as project_id
      from public.projects p
      where not exists (
        select 1 from public.project_commission_rules pcr
        where pcr.project_id = p.id
      )
    ),
    defaults(level, value) as (
      values (1, 60::numeric(14,4)), (2, 20::numeric(14,4)), (3, 10::numeric(14,4))
    ),
    inserted as (
      insert into public.project_commission_rules (project_id, level, rule_type, value)
      select pnr.project_id, d.level, 'fixed', d.value
      from projects_needing_rules pnr cross join defaults d
      on conflict (project_id, level) do nothing
      returning 1
    )
    select count(*) into v_inserted from inserted;
  exception
    when undefined_table or undefined_column then
      return 0;
  end;

  if v_inserted > 0 then
    insert into public.audit_logs (action, entity, entity_id, details, metadata, category, source)
    values (
      'project_commission_rules_seeded', 'project_commission_rules', null,
      'Seeded ' || v_inserted || ' default commission rule(s) (L1=60/L2=20/L3=10).',
      jsonb_build_object('source', 'seed_default_commission_rules', 'count', v_inserted),
      'business', 'database'
    );
  end if;

  return v_inserted;
end;
$zit_auto_28$;

-- ============================================================================
-- Grants for RPCs added in this file.
-- ============================================================================
grant execute on function public.normalize_admin_page_path(text)                       to authenticated;
grant execute on function public.is_delegated_seller()                                 to authenticated;
grant execute on function public.current_delegated_seller_client_id()                  to authenticated;
grant execute on function public.create_buyer_stub_for_sale(text, text, text, text, text, text) to authenticated;
grant execute on function public.autolink_clients_for_auth_user(uuid)                  to authenticated;
grant execute on function public.autolink_client_to_auth_user(uuid)                    to authenticated;
grant execute on function public.heal_my_client_profile_now()                          to authenticated;

-- ============================================================================
-- Run the backfill on every fresh apply of this file so seller_relations is
-- always consistent with the legacy clients.referred_by_client_id column.
-- Safe to re-run: ON CONFLICT (child_client_id) DO NOTHING makes it idempotent.
-- ============================================================================
do $zit_backfill$
begin
  perform public.backfill_seller_relations_from_referred_by();
end;
$zit_backfill$;

-- ============================================================================
-- Re-apply historical parrainage from public.sales on every fresh apply so
-- the buyer upline is materialized even for legacy sales created before the
-- zitouna_sales_auto_parrainage trigger existed.
-- Safe to re-run: seller_relations has UNIQUE(child_client_id).
-- ============================================================================
do $zit_parrain$
begin
  perform public.backfill_parrainage_from_sales();
end;
$zit_parrain$;

-- ============================================================================
-- Seed default commission rules (L1=60 / L2=20 / L3=10 DT) for any project
-- that still has no commission rules. Idempotent via the unique index on
-- project_commission_rules(project_id, level).
-- ============================================================================
do $zit_seed_rules$
begin
  perform public.seed_default_commission_rules();
end;
$zit_seed_rules$;

-- ============================================================================
-- Commission integrity — prevent the "same person credited twice on one sale"
-- bug from ever happening again.
--
-- Rules we now enforce at the DB level:
--   1. A client can only receive ONE commission_events row per sale (unique
--      on (sale_id, beneficiary_client_id)).
--   2. Level 1 (direct) MUST equal sales.seller_client_id — no other row can
--      be L1 on that sale. Checked by a BEFORE INSERT trigger so the DB
--      refuses invalid inserts with a clear error.
--   3. The seller themselves can NEVER be credited at level >= 2 on their own
--      sale (enforced by the same trigger).
--
-- A cleanup function runs first to purge rows that violate these rules,
-- then re-generates commissions for affected sales via the existing
-- compute_and_insert_commissions_for_sale(). Safe to re-run.
-- ============================================================================

create or replace function public.cleanup_inconsistent_commission_events()
returns jsonb
language plpgsql
security definer
set search_path = public
as $zit_auto_29$
declare
  v_deleted_wrong_l1 int := 0;
  v_deleted_self_l2  int := 0;
  v_deleted_dupes    int := 0;
  v_regenerated      int := 0;
  v_affected uuid[];
  v_sid uuid;
begin
  -- A) L1 rows whose beneficiary is NOT the sale's actual seller.
  with bad as (
    select ce.id, ce.sale_id
    from public.commission_events ce
    join public.sales s on s.id = ce.sale_id
    where ce.level = 1
      and s.seller_client_id is not null
      and ce.beneficiary_client_id <> s.seller_client_id
  ), del as (
    delete from public.commission_events ce using bad where ce.id = bad.id returning bad.sale_id
  )
  select array_agg(distinct sale_id), count(*) into v_affected, v_deleted_wrong_l1 from del;

  -- B) Seller credited to themselves at L2+ (impossible).
  with bad as (
    select ce.id, ce.sale_id
    from public.commission_events ce
    join public.sales s on s.id = ce.sale_id
    where ce.level >= 2
      and s.seller_client_id is not null
      and ce.beneficiary_client_id = s.seller_client_id
  ), del as (
    delete from public.commission_events ce using bad where ce.id = bad.id returning bad.sale_id
  )
  select count(*) into v_deleted_self_l2 from del;

  -- C) Duplicate rows — same (sale, beneficiary) more than once. Keep the
  -- row with the LOWEST level (the one most likely to be the legitimate one
  -- if the trigger ever fired twice).
  with ranked as (
    select ce.id, ce.sale_id, ce.beneficiary_client_id, ce.level,
           row_number() over (
             partition by ce.sale_id, ce.beneficiary_client_id
             order by ce.level asc, ce.created_at asc, ce.id asc
           ) as rn
    from public.commission_events ce
  ), del as (
    delete from public.commission_events ce
    using ranked
    where ce.id = ranked.id and ranked.rn > 1
    returning ranked.sale_id
  )
  select count(*) into v_deleted_dupes from del;

  -- D) Regenerate commissions for every sale that lost at least one row.
  if v_affected is not null then
    foreach v_sid in array v_affected loop
      perform public.compute_and_insert_commissions_for_sale(v_sid);
      v_regenerated := v_regenerated + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'deleted_wrong_l1', v_deleted_wrong_l1,
    'deleted_self_l2',  v_deleted_self_l2,
    'deleted_duplicates', v_deleted_dupes,
    'regenerated_sales', v_regenerated
  );
end;
$zit_auto_29$;

grant execute on function public.cleanup_inconsistent_commission_events() to service_role;

-- One-shot cleanup on every apply (idempotent — returns zeros when clean).
do $zit_commission_cleanup$
declare
  r jsonb;
begin
  r := public.cleanup_inconsistent_commission_events();
  raise notice 'ZITOUNA commission cleanup: %', r::text;
end;
$zit_commission_cleanup$;

-- Structural constraint: one row per (sale, beneficiary). We add it AFTER the
-- cleanup DO block above so the ALTER never fails on historical duplicates.
do $zit_commission_unique$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ux_commission_events_sale_beneficiary'
      and conrelid = 'public.commission_events'::regclass
  ) then
    alter table public.commission_events
      add constraint ux_commission_events_sale_beneficiary
      unique (sale_id, beneficiary_client_id);
  end if;
end;
$zit_commission_unique$;

-- BEFORE INSERT validation — catches future bugs before data lands.
create or replace function public.trg_commission_events_validate()
returns trigger
language plpgsql
as $zit_auto_30$
declare
  v_seller uuid;
begin
  select seller_client_id into v_seller from public.sales where id = NEW.sale_id;

  if NEW.level = 1 then
    if v_seller is null then
      raise exception 'commission L1 refused: sales.seller_client_id is null (sale=%)', NEW.sale_id
        using errcode = '23514';
    end if;
    if NEW.beneficiary_client_id <> v_seller then
      raise exception 'commission L1 refused: beneficiary % is not the direct seller % (sale=%)',
        NEW.beneficiary_client_id, v_seller, NEW.sale_id using errcode = '23514';
    end if;
  elsif NEW.level >= 2 then
    if v_seller is not null and NEW.beneficiary_client_id = v_seller then
      raise exception 'commission L%+ refused: seller cannot be indirect on own sale (sale=%)',
        NEW.level, NEW.sale_id using errcode = '23514';
    end if;
  end if;

  return NEW;
end;
$zit_auto_30$;

drop trigger if exists zitouna_commission_events_validate on public.commission_events;
create trigger zitouna_commission_events_validate
  before insert on public.commission_events
  for each row execute function public.trg_commission_events_validate();

-- ============================================================================
-- TASK 1 — Commission notification trigger
--
-- After a commission_events row is inserted, drop a row into
-- public.user_notifications so the beneficiary sees the payout in their
-- investor notification tray. Schema adaptation: user_notifications does NOT
-- carry `title`/`body`/`kind`/`metadata` columns — it has
-- (user_id, role_scope, type, payload jsonb, read_at, dedupe_key). The
-- prescribed title/body/kind/metadata payload is therefore packed inside
-- `payload` and `type` is set to 'commission_earned'. `role_scope` is
-- 'investor' (the only scope that matches non-admin clients per the CHECK
-- constraint). `dedupe_key` prevents duplicates on re-emission.
--
-- No row is written when the beneficiary client has no auth_user_id yet (we
-- cannot target a notification). Wrapped in exception blocks so a NOTICE is
-- emitted and the original INSERT still succeeds.
-- ============================================================================

create or replace function public.trg_commission_events_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $zit_commission_notify$
declare
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
begin
  begin
    -- Look up beneficiary's auth.users id. Stub clients without an account
    -- cannot receive a notification, so we silently skip them.
    select c.auth_user_id into v_auth_user
    from public.clients c
    where c.id = NEW.beneficiary_client_id;

    if v_auth_user is null then
      return NEW;
    end if;

    -- Join the sale + buyer + project in one shot so the notification body
    -- reads naturally ("pour la vente de Ahmed B. sur Olivier — La Marsa,
    -- parcelle #12") instead of exposing a raw UUID.
    select
      s.code,
      coalesce(buyer.full_name, buyer.name),
      p.title,
      coalesce(s.parcel_ids, case when s.parcel_id is not null then array[s.parcel_id] else array[]::integer[] end)
    into v_sale_code, v_buyer_name, v_project_title, v_parcel_ids
    from public.sales s
    left join public.clients  buyer on buyer.id = s.client_id
    left join public.projects p     on p.id     = s.project_id
    where s.id = NEW.sale_id;

    -- Human-readable parcel label: "#12" for one, "#12, #13" for a few,
    -- "3 parcelles" once the list gets unwieldy. NULL when we have none.
    if v_parcel_ids is not null and array_length(v_parcel_ids, 1) is not null then
      if array_length(v_parcel_ids, 1) <= 3 then
        select string_agg('#' || x::text, ', ') into v_parcel_label
          from unnest(v_parcel_ids) as x;
      else
        v_parcel_label := array_length(v_parcel_ids, 1)::text || ' parcelles';
      end if;
    end if;

    -- Keep the amount short: "60" rather than "60.0000" when it's integral.
    v_amount_fmt := trim(trailing '.' from trim(trailing '0' from NEW.amount::text));
    if v_amount_fmt = '' then
      v_amount_fmt := NEW.amount::text;
    end if;

    -- Title stays compact for the notification tray header.
    v_title := 'Commission L' || NEW.level::text || ' — ' || v_amount_fmt || ' DT';

    -- Body: build context-rich French with graceful fallbacks for each piece.
    v_body := 'Commission niveau ' || NEW.level::text
              || ' de ' || v_amount_fmt || ' DT';
    if v_buyer_name is not null and length(trim(v_buyer_name)) > 0 then
      v_body := v_body || ' sur la vente de ' || v_buyer_name;
    end if;
    if v_project_title is not null and length(trim(v_project_title)) > 0 then
      v_body := v_body || ' — ' || v_project_title;
    end if;
    if v_parcel_label is not null then
      v_body := v_body || ' (' || v_parcel_label || ')';
    elsif v_sale_code is not null then
      v_body := v_body || ' [' || v_sale_code || ']';
    end if;
    v_body := v_body || '.';

    v_payload := jsonb_build_object(
      'kind',           'commission',
      'title',          v_title,
      'body',           v_body,
      'event_id',       NEW.id,
      'sale_id',        NEW.sale_id,
      'sale_code',      v_sale_code,
      'buyer_name',     v_buyer_name,
      'project_title',  v_project_title,
      'parcel_label',   v_parcel_label,
      'level',          NEW.level,
      'amount',         NEW.amount,
      'status',         NEW.status::text
    );

    -- One notification per commission_event row. dedupe_key is UNIQUE on
    -- user_notifications, so re-runs of the same event id cannot double-post.
    v_dedupe := 'commission_event:' || NEW.id::text;

    insert into public.user_notifications (user_id, role_scope, type, payload, dedupe_key)
    values (v_auth_user, 'investor', 'commission_earned', v_payload, v_dedupe)
    on conflict (dedupe_key) do nothing;
  exception when others then
    -- Never let a notification failure abort the commission insert.
    raise notice 'trg_commission_events_notify skipped for event %: %', NEW.id, sqlerrm;
  end;

  return NEW;
end;
$zit_commission_notify$;

do $zit_commission_notify_trg$
begin
  drop trigger if exists zitouna_commission_events_notify on public.commission_events;
  create trigger zitouna_commission_events_notify
    after insert on public.commission_events
    for each row execute function public.trg_commission_events_notify();
exception when others then
  raise notice 'zitouna_commission_events_notify trigger wiring failed: %', sqlerrm;
end;
$zit_commission_notify_trg$;

-- ============================================================================
-- TASK 2 — Fraud / cycle detection RPC
--
-- Returns a single jsonb blob summarizing five classes of parrainage
-- anomalies. Pure SQL aggregation (recursive CTE for cycles, simple joins
-- for the rest). SECURITY DEFINER because the report reads clients/sales
-- that an authenticated caller might not have direct SELECT on.
-- Each sub-query is defensive: wrapped in an exception block so a single
-- broken slice cannot wipe out the whole report.
-- ============================================================================

create or replace function public.detect_parrainage_anomalies()
returns jsonb
language plpgsql
security definer
set search_path = public
as $zit_detect_anomalies$
declare
  v_cycles jsonb := '[]'::jsonb;
  v_self jsonb := '[]'::jsonb;
  v_orphans jsonb := '[]'::jsonb;
  v_mismatched jsonb := '[]'::jsonb;
  v_dup jsonb := '[]'::jsonb;
  v_reverse jsonb := '[]'::jsonb;
begin
  -- 1) Cycles in the seller_relations graph. A cycle is detected when the
  --    DFS path revisits its own starting node. Depth capped at 40.
  begin
    with recursive walk(start_id, current_id, path, depth, closed) as (
      select sr.child_client_id, sr.parent_client_id,
             array[sr.child_client_id, sr.parent_client_id],
             1, false
      from public.seller_relations sr
      union all
      select w.start_id, sr.parent_client_id,
             w.path || sr.parent_client_id,
             w.depth + 1,
             (sr.parent_client_id = w.start_id)
      from walk w
      join public.seller_relations sr on sr.child_client_id = w.current_id
      where w.depth < 40
        and not w.closed
        and not (sr.parent_client_id = any(w.path) and sr.parent_client_id <> w.start_id)
    ),
    cycles_found as (
      select distinct on (array_sort_unique(path))
        path as client_ids,
        array_length(path, 1) as length
      from walk
      where closed
    )
    select coalesce(jsonb_agg(jsonb_build_object('client_ids', cf.client_ids, 'length', cf.length)), '[]'::jsonb)
      into v_cycles
    from cycles_found cf;
  exception when undefined_function then
    -- array_sort_unique doesn't exist by default; fall back to the raw path.
    begin
      with recursive walk(start_id, current_id, path, depth, closed) as (
        select sr.child_client_id, sr.parent_client_id,
               array[sr.child_client_id, sr.parent_client_id],
               1, false
        from public.seller_relations sr
        union all
        select w.start_id, sr.parent_client_id,
               w.path || sr.parent_client_id,
               w.depth + 1,
               (sr.parent_client_id = w.start_id)
        from walk w
        join public.seller_relations sr on sr.child_client_id = w.current_id
        where w.depth < 40
          and not w.closed
          and not (sr.parent_client_id = any(w.path) and sr.parent_client_id <> w.start_id)
      )
      select coalesce(jsonb_agg(jsonb_build_object('client_ids', w.path, 'length', array_length(w.path, 1))), '[]'::jsonb)
        into v_cycles
      from walk w
      where w.closed;
    exception when others then
      v_cycles := '[]'::jsonb;
      raise notice 'detect_parrainage_anomalies cycles slice failed: %', sqlerrm;
    end;
  when others then
    v_cycles := '[]'::jsonb;
    raise notice 'detect_parrainage_anomalies cycles slice failed: %', sqlerrm;
  end;

  -- 2) Self-referrals: clients.referred_by_client_id = id OR
  --    seller_relations.parent = self.
  begin
    with refs as (
      select c.id as client_id, 'clients.referred_by_client_id = id'::text as reason
      from public.clients c
      where c.referred_by_client_id = c.id
      union all
      select sr.child_client_id as client_id, 'seller_relations.parent = self'::text as reason
      from public.seller_relations sr
      where sr.parent_client_id = sr.child_client_id
    )
    select coalesce(jsonb_agg(jsonb_build_object('client_id', r.client_id, 'reason', r.reason)), '[]'::jsonb)
      into v_self
    from refs r;
  exception when others then
    v_self := '[]'::jsonb;
    raise notice 'detect_parrainage_anomalies self_referrals slice failed: %', sqlerrm;
  end;

  -- 3) Orphan commissions — beneficiary no longer exists in clients.
  begin
    select coalesce(jsonb_agg(ce.id), '[]'::jsonb)
      into v_orphans
    from public.commission_events ce
    where not exists (
      select 1 from public.clients c where c.id = ce.beneficiary_client_id
    );
  exception when others then
    v_orphans := '[]'::jsonb;
    raise notice 'detect_parrainage_anomalies orphan_commissions slice failed: %', sqlerrm;
  end;

  -- 4) Mismatched L1 events (historical rows where L1 beneficiary
  --    differs from sales.seller_client_id).
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
      'event_id',   ce.id,
      'sale_id',    ce.sale_id,
      'beneficiary', ce.beneficiary_client_id,
      'seller',      s.seller_client_id
    )), '[]'::jsonb)
      into v_mismatched
    from public.commission_events ce
    join public.sales s on s.id = ce.sale_id
    where ce.level = 1
      and (s.seller_client_id is null or ce.beneficiary_client_id <> s.seller_client_id);
  exception when others then
    v_mismatched := '[]'::jsonb;
    raise notice 'detect_parrainage_anomalies mismatched_l1 slice failed: %', sqlerrm;
  end;

  -- 5) Duplicate upline — same auth_user_id mapped to more than one
  --    clients row (only materialized auth ids, not nulls).
  begin
    with dup as (
      select auth_user_id, array_agg(id order by created_at) as client_ids
      from public.clients
      where auth_user_id is not null
      group by auth_user_id
      having count(*) > 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'auth_user_id', d.auth_user_id,
      'client_ids',   d.client_ids
    )), '[]'::jsonb)
      into v_dup
    from dup d;
  exception when others then
    v_dup := '[]'::jsonb;
    raise notice 'detect_parrainage_anomalies duplicate_upline slice failed: %', sqlerrm;
  end;

  -- 6) Reverse sales — completed sales where the buyer sits in the seller's
  --    upline chain. DB-truthful (walks seller_relations) so the admin UI
  --    stops relying on client-side derivation.
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
      'sale_id',   s.id,
      'sale_code', s.code,
      'seller',    s.seller_client_id,
      'buyer',     s.client_id,
      'notary_completed_at', s.notary_completed_at,
      'grant_id',  g.id
    )), '[]'::jsonb)
      into v_reverse
    from public.sales s
    left join public.commission_reverse_grants g
      on g.trigger_sale_id = s.id
    where s.notary_completed_at is not null
      and s.seller_client_id is not null
      and s.client_id is not null
      and s.seller_client_id <> s.client_id
      and public.is_ancestor_via_seller_relations(s.seller_client_id, s.client_id);
  exception when others then
    v_reverse := '[]'::jsonb;
    raise notice 'detect_parrainage_anomalies reverse_sales slice failed: %', sqlerrm;
  end;

  return jsonb_build_object(
    'cycles',               v_cycles,
    'self_referrals',       v_self,
    'orphan_commissions',   v_orphans,
    'mismatched_l1',        v_mismatched,
    'duplicate_upline',     v_dup,
    'reverse_sales',        v_reverse,
    'generated_at',         to_jsonb(now())
  );
end;
$zit_detect_anomalies$;

do $zit_detect_grant$
begin
  grant execute on function public.detect_parrainage_anomalies() to authenticated;
exception when others then
  raise notice 'detect_parrainage_anomalies grant failed: %', sqlerrm;
end;
$zit_detect_grant$;

do $zit_rg_grants$
begin
  grant execute on function public.backfill_reverse_grants() to authenticated;
  grant execute on function public.backfill_reverse_grant_commissions() to authenticated;
  grant execute on function public.revoke_reverse_grant(uuid, text) to authenticated;
  grant execute on function public.is_ancestor_via_seller_relations(uuid, uuid) to authenticated;
exception when others then
  raise notice 'reverse-grant function grants failed: %', sqlerrm;
end;
$zit_rg_grants$;

-- ============================================================================
-- TASK 3 — Per-project effective commission rules view
--
-- project_commission_rules already carries per-level rows (UNIQUE on
-- (project_id, level)). This view resolves the "effective" rule for a given
-- (project_id, level) pair with explicit provenance:
--   - source = 'project'  → row comes from project_commission_rules.
--   - source = 'default'  → project has NO rules for that level; we fall
--                           back to the L1=60 / L2=20 / L3=10 defaults seeded
--                           by seed_default_commission_rules().
--
-- Consumers can `select ... from v_effective_commission_rules where
-- project_id = 'proj-x'` and always get three rows.
-- ============================================================================

do $zit_view_effective$
begin
  create or replace view public.v_effective_commission_rules as
  with defaults(level, rule_type, value, max_cap_amount) as (
    values
      (1, 'fixed'::text, 60::numeric(14,4), null::numeric(14,2)),
      (2, 'fixed'::text, 20::numeric(14,4), null::numeric(14,2)),
      (3, 'fixed'::text, 10::numeric(14,4), null::numeric(14,2))
  ),
  project_levels as (
    select p.id as project_id, d.level, d.rule_type, d.value, d.max_cap_amount
    from public.projects p
    cross join defaults d
  )
  select
    pl.project_id::text                     as project_id,
    pl.level                                as level,
    coalesce(pcr.rule_type, pl.rule_type)   as rule_type,
    coalesce(pcr.value,     pl.value)       as value,
    coalesce(pcr.max_cap_amount, pl.max_cap_amount) as max_cap_amount,
    case when pcr.id is not null then 'project' else 'default' end as source
  from project_levels pl
  left join public.project_commission_rules pcr
    on pcr.project_id = pl.project_id
   and pcr.level = pl.level;
exception when others then
  raise notice 'v_effective_commission_rules create failed: %', sqlerrm;
end;
$zit_view_effective$;

do $zit_view_grant$
begin
  grant select on public.v_effective_commission_rules to authenticated;
exception when others then
  raise notice 'v_effective_commission_rules grant failed: %', sqlerrm;
end;
$zit_view_grant$;

-- ============================================================================
-- Folded from dev/phone_change_requests.sql — client-initiated phone change
-- workflow. Table lives in 02_schema.sql; RLS lives in 04_rls.sql.
-- ============================================================================
create or replace function public.submit_phone_change_request(
  p_new_phone text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid := public.current_client_id();
  v_client record;
  v_new_phone text;
  v_new_phone_norm text;
  v_request_id uuid;
  v_already uuid;
  v_taken_by uuid;
begin
  if v_client_id is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  v_new_phone := coalesce(trim(p_new_phone), '');
  if length(v_new_phone) < 6 or length(v_new_phone) > 32 then
    raise exception 'INVALID_PHONE' using errcode = '22023';
  end if;

  v_new_phone_norm := coalesce(public.normalize_phone_e164(v_new_phone), '');

  perform pg_advisory_xact_lock(hashtext('phone_change:' || v_client_id::text));

  select id, coalesce(email, '') as email, coalesce(full_name, '') as name,
         coalesce(phone, '') as phone,
         coalesce(phone_normalized::text, '') as phone_normalized
    into v_client
    from public.clients
   where id = v_client_id;

  if v_new_phone = coalesce(v_client.phone, '')
     or (v_new_phone_norm <> '' and v_new_phone_norm = coalesce(v_client.phone_normalized, ''))
  then
    raise exception 'PHONE_UNCHANGED' using errcode = 'P0001';
  end if;

  -- Reject if the number is already claimed by any account — clients OR
  -- admin/staff. Scans both tables and both raw + normalized columns so a
  -- whitespace/format difference can't let two users share the same number.
  select id into v_taken_by
    from public.clients
   where id <> v_client_id
     and (
       coalesce(phone, '') = v_new_phone
       or (v_new_phone_norm <> '' and coalesce(phone_normalized::text, '') = v_new_phone_norm)
     )
   limit 1;
  if v_taken_by is not null then
    raise exception 'PHONE_TAKEN' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.admin_users
    where coalesce(phone, '') = v_new_phone
       or (v_new_phone_norm <> '' and coalesce(phone_normalized, '') = v_new_phone_norm)
  ) then
    raise exception 'PHONE_TAKEN' using errcode = 'P0001';
  end if;

  select id into v_already
  from public.phone_change_requests
  where client_id = v_client_id and status = 'pending'
  limit 1;

  if v_already is not null then
    update public.phone_change_requests
       set requested_phone = v_new_phone,
           reason = coalesce(trim(p_reason), ''),
           created_at = now()
     where id = v_already;
    return jsonb_build_object('ok', true, 'requestId', v_already, 'idempotent', true);
  end if;

  insert into public.phone_change_requests (
    client_id, auth_user_id, user_email, user_name, current_phone,
    requested_phone, reason, status
  ) values (
    v_client_id, auth.uid(), v_client.email, v_client.name,
    v_client.phone, v_new_phone, coalesce(trim(p_reason), ''), 'pending'
  ) returning id into v_request_id;

  return jsonb_build_object('ok', true, 'requestId', v_request_id, 'idempotent', false);
end;
$$;

revoke all on function public.submit_phone_change_request(text, text) from public;
grant execute on function public.submit_phone_change_request(text, text) to authenticated;


create or replace function public.my_phone_change_request()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid := public.current_client_id();
  v_row record;
begin
  if v_client_id is null then
    return jsonb_build_object('ok', false, 'reason', 'NOT_AUTHENTICATED');
  end if;
  select id, status, requested_phone, current_phone, reason,
         created_at, reviewed_at, reviewer_note
    into v_row
    from public.phone_change_requests
   where client_id = v_client_id
   order by case when status = 'pending' then 0 else 1 end, created_at desc
   limit 1;
  if not found then
    return jsonb_build_object('ok', true, 'request', null);
  end if;
  return jsonb_build_object('ok', true, 'request', to_jsonb(v_row));
end;
$$;

revoke all on function public.my_phone_change_request() from public;
grant execute on function public.my_phone_change_request() to authenticated;


create or replace function public.admin_search_phone_change_requests(
  p_email_query text default null,
  p_status text default null,
  p_limit int default 50
)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_query text;
  v_status text;
begin
  if not public.is_super_admin() then
    raise exception 'NOT_SUPER_ADMIN' using errcode = '42501';
  end if;
  v_query := lower(coalesce(trim(p_email_query), ''));
  v_status := coalesce(trim(p_status), '');
  return query
  select to_jsonb(t) || jsonb_build_object(
           'client_email', c.email,
           'client_name',  coalesce(c.full_name, ''),
           'client_current_phone', c.phone
         )
  from public.phone_change_requests t
  join public.clients c on c.id = t.client_id
  where (v_query = '' or lower(coalesce(t.user_email, '')) like '%' || v_query || '%'
                     or lower(coalesce(c.email,       '')) like '%' || v_query || '%')
    and (v_status = '' or t.status = v_status)
  order by
    case when t.status = 'pending' then 0 else 1 end,
    t.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

revoke all on function public.admin_search_phone_change_requests(text, text, int) from public;
grant execute on function public.admin_search_phone_change_requests(text, text, int) to authenticated;


create or replace function public.admin_apply_phone_change(
  p_request_id uuid,
  p_approve boolean,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.phone_change_requests%rowtype;
  v_reviewer_admin_id uuid;
  v_old_phone text;
begin
  if not public.is_super_admin() then
    raise exception 'NOT_SUPER_ADMIN' using errcode = '42501';
  end if;

  select * into v_request
    from public.phone_change_requests
   where id = p_request_id
   for update;
  if not found then
    raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'ALREADY_REVIEWED'
      using errcode = 'P0001', hint = v_request.status;
  end if;

  select id into v_reviewer_admin_id
    from public.admin_users
   where (auth_user_id = auth.uid())
      or (auth_user_id is null
          and lower(trim(coalesce(email,''))) = lower(trim(coalesce(auth.email(),''))))
   limit 1;

  if p_approve then
    select coalesce(phone, '') into v_old_phone
      from public.clients
     where id = v_request.client_id;

    if exists (
      select 1 from public.clients
       where id <> v_request.client_id
         and (
           coalesce(phone, '') = v_request.requested_phone
           or coalesce(phone_normalized::text, '') = coalesce(public.normalize_phone_e164(v_request.requested_phone), '__none__')
         )
    ) then
      raise exception 'PHONE_TAKEN' using errcode = 'P0001';
    end if;

    if exists (
      select 1 from public.admin_users
       where coalesce(phone, '') = v_request.requested_phone
          or coalesce(phone_normalized, '') = coalesce(public.normalize_phone_e164(v_request.requested_phone), '__none__')
    ) then
      raise exception 'PHONE_TAKEN' using errcode = 'P0001';
    end if;

    update public.clients
       set phone = v_request.requested_phone,
           updated_at = now()
     where id = v_request.client_id;

    update public.phone_change_requests
       set status = 'approved',
           reviewer_id = v_reviewer_admin_id,
           reviewer_note = coalesce(trim(p_note), ''),
           reviewed_at = now(),
           applied_at = now()
     where id = p_request_id;

    insert into public.audit_logs (
      actor_user_id, action, entity, entity_id, details, metadata, category, source
    ) values (
      v_reviewer_admin_id, 'phone_change_approved', 'client', v_request.client_id::text,
      'Super admin a approuvé un changement de téléphone',
      jsonb_build_object(
        'request_id', p_request_id,
        'client_id', v_request.client_id,
        'old_phone', v_old_phone,
        'new_phone', v_request.requested_phone
      ),
      'security', 'database'
    );
  else
    update public.phone_change_requests
       set status = 'rejected',
           reviewer_id = v_reviewer_admin_id,
           reviewer_note = coalesce(trim(p_note), ''),
           reviewed_at = now()
     where id = p_request_id;

    insert into public.audit_logs (
      actor_user_id, action, entity, entity_id, details, metadata, category, source
    ) values (
      v_reviewer_admin_id, 'phone_change_rejected', 'client', v_request.client_id::text,
      'Super admin a rejeté un changement de téléphone',
      jsonb_build_object(
        'request_id', p_request_id,
        'client_id', v_request.client_id,
        'requested_phone', v_request.requested_phone,
        'note', p_note
      ),
      'security', 'database'
    );
  end if;

  return jsonb_build_object('ok', true, 'requestId', p_request_id, 'status', case when p_approve then 'approved' else 'rejected' end);
end;
$$;

revoke all on function public.admin_apply_phone_change(uuid, boolean, text) from public;
grant execute on function public.admin_apply_phone_change(uuid, boolean, text) to authenticated;


-- ============================================================================
-- Folded from dev/harvest_system.sql — distribution engine + preview.
-- Tables live in 02_schema.sql; RLS/views/grants in 04_rls.sql.
-- ============================================================================
create or replace function public.distribute_harvest(p_harvest_id uuid)
returns table (client_id uuid, owned_m2 numeric, amount_tnd numeric)
language plpgsql
security definer
set search_path = public
as $fn_distribute$
declare
  v_harvest        public.project_harvests%rowtype;
  v_project_area   numeric(14, 2);
  v_net            numeric(14, 2);
  v_admin_id       uuid;
  v_row            record;
begin
  if not public.is_active_staff() then
    raise exception 'distribute_harvest: staff role required';
  end if;

  select * into v_harvest
    from public.project_harvests
    where id = p_harvest_id
    for update;

  if not found then
    raise exception 'distribute_harvest: harvest % not found', p_harvest_id;
  end if;

  if v_harvest.status = 'distributed' then
    return query
      select hd.client_id, hd.owned_area_m2, hd.amount_tnd
        from public.harvest_distributions hd
        where hd.harvest_id = p_harvest_id;
    return;
  end if;

  if v_harvest.status = 'cancelled' then
    raise exception 'distribute_harvest: harvest % is cancelled', p_harvest_id;
  end if;

  v_net := greatest(coalesce(v_harvest.net_tnd, 0), 0);

  select coalesce(sum(p.area_m2), 0) into v_project_area
    from public.parcels p
    where p.project_id = v_harvest.project_id;

  if v_project_area <= 0 then
    raise exception 'distribute_harvest: project % has zero total area', v_harvest.project_id;
  end if;

  select id into v_admin_id
    from public.admin_users
    where auth_user_id = auth.uid()
    limit 1;

  for v_row in
    select s.client_id as cid,
           sum(coalesce(p.area_m2, 0)) as owned_m2
      from public.sales s
      join public.parcels p
        on p.id = any (case
                         when array_length(s.parcel_ids, 1) > 0 then s.parcel_ids
                         else array[s.parcel_id]
                       end)
      where s.project_id = v_harvest.project_id
        and s.status = 'completed'
        and s.notary_completed_at is not null
        and s.notary_completed_at <= coalesce(
              (v_harvest.harvest_date + interval '1 day')::timestamptz,
              now())
      group by s.client_id
      having sum(coalesce(p.area_m2, 0)) > 0
  loop
    insert into public.harvest_distributions (
      harvest_id, client_id,
      owned_area_m2, project_area_m2, share_pct, amount_tnd,
      credit_status, credited_at
    ) values (
      p_harvest_id, v_row.cid,
      v_row.owned_m2, v_project_area,
      round((v_row.owned_m2 / v_project_area) * 100, 6),
      round(v_net * (v_row.owned_m2 / v_project_area), 2),
      'credited', now()
    )
    on conflict (harvest_id, client_id) do nothing;

    insert into public.ambassador_wallets (client_id, balance)
      values (v_row.cid, round(v_net * (v_row.owned_m2 / v_project_area), 2))
    on conflict (client_id) do update
      set balance    = public.ambassador_wallets.balance
                     + round(v_net * (v_row.owned_m2 / v_project_area), 2),
          updated_at = now();
  end loop;

  update public.project_harvests
     set status         = 'distributed',
         distributed_at = now(),
         distributed_by = v_admin_id,
         updated_at     = now()
     where id = p_harvest_id;

  return query
    select hd.client_id, hd.owned_area_m2, hd.amount_tnd
      from public.harvest_distributions hd
      where hd.harvest_id = p_harvest_id;
end;
$fn_distribute$;

grant execute on function public.distribute_harvest(uuid) to authenticated;


create or replace function public.preview_harvest_distribution(p_harvest_id uuid)
returns table (
  client_id       uuid,
  client_name     text,
  owned_area_m2   numeric,
  share_pct       numeric,
  amount_tnd      numeric
)
language plpgsql
security definer
set search_path = public
as $fn_preview$
declare
  v_harvest      public.project_harvests%rowtype;
  v_project_area numeric(14, 2);
  v_net          numeric(14, 2);
begin
  if not public.is_active_staff() then
    raise exception 'preview_harvest_distribution: staff role required';
  end if;

  select * into v_harvest from public.project_harvests where id = p_harvest_id;
  if not found then return; end if;

  v_net := greatest(coalesce(v_harvest.net_tnd, 0), 0);

  select coalesce(sum(p.area_m2), 0) into v_project_area
    from public.parcels p where p.project_id = v_harvest.project_id;

  if v_project_area <= 0 then return; end if;

  return query
    select c.id,
           c.name,
           sum(coalesce(p.area_m2, 0))::numeric,
           round((sum(coalesce(p.area_m2, 0)) / v_project_area) * 100, 6),
           round(v_net * (sum(coalesce(p.area_m2, 0)) / v_project_area), 2)
      from public.sales s
      join public.clients c on c.id = s.client_id
      join public.parcels p
        on p.id = any (case
                         when array_length(s.parcel_ids, 1) > 0 then s.parcel_ids
                         else array[s.parcel_id]
                       end)
      where s.project_id = v_harvest.project_id
        and s.status = 'completed'
        and s.notary_completed_at is not null
        and s.notary_completed_at <= coalesce(
              (v_harvest.harvest_date + interval '1 day')::timestamptz,
              now())
      group by c.id, c.name
      having sum(coalesce(p.area_m2, 0)) > 0
      order by sum(coalesce(p.area_m2, 0)) desc;
end;
$fn_preview$;

grant execute on function public.preview_harvest_distribution(uuid) to authenticated;
