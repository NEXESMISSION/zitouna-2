-- ============================================================================
-- phone_change_requests.sql
--
-- Client-initiated phone-number change workflow.
--   * Clients submit a request from the dashboard (new phone + reason).
--   * Super admins search accounts by email and approve / reject.
--   * On approval, the clients.phone column is updated atomically and the
--     action is recorded in audit_logs.
--
-- Paste into the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table
-- ----------------------------------------------------------------------------
create table if not exists public.phone_change_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  auth_user_id uuid,
  user_email text not null default '',
  user_name text not null default '',
  current_phone text not null default '',
  requested_phone text not null,
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewer_id uuid references public.admin_users(id) on delete set null,
  reviewer_note text not null default '',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  applied_at timestamptz,
  constraint phone_change_requests_new_phone_chk check (length(requested_phone) between 6 and 32)
);

create index if not exists idx_phone_change_requests_client on public.phone_change_requests(client_id);
create index if not exists idx_phone_change_requests_status on public.phone_change_requests(status);
create index if not exists idx_phone_change_requests_email  on public.phone_change_requests(lower(user_email));

-- At most one pending request per client at a time — keeps the admin queue tidy.
create unique index if not exists ux_phone_change_requests_one_pending
  on public.phone_change_requests(client_id)
  where status = 'pending';


-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
alter table public.phone_change_requests enable row level security;

drop policy if exists staff_phone_change_requests_crud on public.phone_change_requests;
create policy staff_phone_change_requests_crud on public.phone_change_requests
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

drop policy if exists client_select_own_phone_change on public.phone_change_requests;
create policy client_select_own_phone_change on public.phone_change_requests
  for select to authenticated
  using (client_id = public.current_client_id());

-- No direct client insert/update — the SECURITY DEFINER RPC below is the only
-- path, so we can enforce rate-limits and phone normalization in one place.


-- ----------------------------------------------------------------------------
-- RPC: submit_phone_change_request — called by the client dashboard.
-- ----------------------------------------------------------------------------
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
  v_request_id uuid;
  v_already uuid;
begin
  if v_client_id is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  v_new_phone := coalesce(trim(p_new_phone), '');
  if length(v_new_phone) < 6 or length(v_new_phone) > 32 then
    raise exception 'INVALID_PHONE' using errcode = '22023';
  end if;

  -- Serialize concurrent submissions from the same client — with the partial
  -- unique index on status='pending', two simultaneous calls could otherwise
  -- both see "no pending" and both try to insert.
  perform pg_advisory_xact_lock(hashtext('phone_change:' || v_client_id::text));

  -- One pending request at a time: if there's already a pending row, return
  -- it idempotently instead of raising a unique-violation.
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

  select id, coalesce(email, '') as email, coalesce(full_name, name, '') as name,
         coalesce(phone, '') as phone
    into v_client
    from public.clients
   where id = v_client_id;

  if v_new_phone = coalesce(v_client.phone, '') then
    raise exception 'PHONE_UNCHANGED' using errcode = 'P0001';
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


-- ----------------------------------------------------------------------------
-- RPC: my_phone_change_request — latest request for the caller (pending first).
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- RPC: admin_search_phone_change_requests — super-admin only.
-- ----------------------------------------------------------------------------
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
           'client_name',  coalesce(c.full_name, c.name, ''),
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


-- ----------------------------------------------------------------------------
-- RPC: admin_apply_phone_change — super-admin only. Approves or rejects.
-- ----------------------------------------------------------------------------
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
    raise exception 'ALREADY_REVIEWED' using errcode = 'P0001'
      using hint = v_request.status;
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
