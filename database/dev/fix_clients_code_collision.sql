-- ============================================================================
-- fix_clients_code_collision.sql
--
-- Paste into Supabase SQL Editor and run ONCE against the live DB.
--
-- Root cause:
--   `ensure_current_client_profile()` (03_functions.sql) inserted a new
--   `clients` row with `ON CONFLICT (email) DO UPDATE`. The `clients.code`
--   column also has a unique constraint (`clients_code_key`), and the code
--   is deterministic off `auth.uid()`. When a stub row with the same code
--   already exists but a different / null email, the INSERT raised
--   `duplicate key value violates unique constraint "clients_code_key"`.
--   The exception aborted the whole heal RPC, which in turn left the
--   frontend's `clientProfile` null, which in turn pinned every
--   scoped hook (useSalesScoped / useInstallmentsScoped / …) on a
--   stuck skeleton forever.
--
-- Fix:
--   Wrap the INSERT in BEGIN/EXCEPTION. On `unique_violation` (the code
--   case), first try to claim the orphan row (same code, no auth_user_id
--   yet, or already us). If the orphan belongs to a different authenticated
--   user, fall back to a code with a short random suffix so we can still
--   provision a profile for the current user.
--
-- Safe to run multiple times (CREATE OR REPLACE FUNCTION).
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

    -- Try the email-upsert INSERT first. If it trips the code unique
    -- constraint, fall through to claim-or-regenerate below.
    begin
      insert into public.clients (code, full_name, email, phone, auth_user_id, status)
      values (v_code, coalesce(v_full_name, 'Client'), v_email, v_phone, v_uid, 'active')
      on conflict (email) do update
        set auth_user_id = excluded.auth_user_id, updated_at = now()
      returning id into v_client_id;
    exception when unique_violation then
      -- Claim the orphan that owns our generated code.
      update public.clients c
      set auth_user_id = coalesce(c.auth_user_id, v_uid),
          email        = coalesce(c.email, v_email),
          full_name    = coalesce(nullif(c.full_name, ''), v_full_name, 'Client'),
          phone        = coalesce(nullif(c.phone, ''), v_phone),
          updated_at   = now()
      where c.code = v_code
        and (c.auth_user_id is null or c.auth_user_id = v_uid)
      returning c.id into v_client_id;

      -- Still null → that code belongs to a different authed user.
      -- Regenerate with a short random suffix and retry.
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

  v_ambiguous := (
    select count(*) > 1
    from public.clients c where c.auth_user_id = v_uid
  );

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

  update public.installment_plans p
  set client_id = v_client_id, updated_at = now()
  from public.sales s
  where p.sale_id = s.id
    and s.client_id = v_client_id
    and p.client_id is distinct from v_client_id;
  GET DIAGNOSTICS v_migrated_plans = ROW_COUNT;

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

-- Re-grant (idempotent).
GRANT EXECUTE ON FUNCTION public.ensure_current_client_profile() TO authenticated;

-- Verification: call it once as the affected user. Should return `ok: true`
-- (or `ambiguous_client_profile` / `phone_conflict` — NEVER an unhandled
-- unique-violation error).
--
--   select public.ensure_current_client_profile();
--
-- If the error persists: check for a row in `clients` with the exact
-- generated code:
--
--   select id, code, email, auth_user_id, full_name
--   from public.clients
--   where code like 'CL-%'
--   order by created_at;
