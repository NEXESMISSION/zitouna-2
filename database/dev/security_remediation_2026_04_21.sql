-- ============================================================================
-- security_remediation_2026_04_21.sql
--
-- Paste into Supabase SQL Editor and run ONCE against the live DB.
-- Safe to re-run (all statements are idempotent via drop-if-exists /
-- create or replace).
--
-- Fixes findings from DEV_SECURITY_AUDIT.md:
--
--   C1 — installment_payments RLS let the client rewrite amount/due_date/
--        approved_at before submission. Pin every non-submission column.
--   H1 — request_ambassador_payout had a TOCTOU race between selecting
--        payable events and inserting the request. Serialize per client
--        with pg_advisory_xact_lock.
--   H2 — client could self-set status='rejected'. Drop from allow-list;
--        only 'pending' and 'submitted' are valid self-transitions.
--   M2 — installment_payment_receipts.receipt_url was untrusted free text.
--        Add a CHECK constraint: must be https:// or empty, max 1024 chars.
--
-- The base files (database/04_rls.sql and 03_functions.sql) are updated
-- in the same commit so future fresh deploys include these fixes.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- C1 + H2 — Harden installment_payments self-update policy.
-- ----------------------------------------------------------------------------
drop policy if exists client_update_own_payment_submit on public.installment_payments;

create policy client_update_own_payment_submit on public.installment_payments
  for update to authenticated
  using (
    exists (
      select 1 from public.installment_plans p
      where p.id = installment_payments.plan_id
        and p.client_id = public.current_client_id()
    )
  )
  with check (
    exists (
      select 1 from public.installment_plans p
      where p.id = installment_payments.plan_id
        and p.client_id = public.current_client_id()
    )
    -- Status self-transitions are limited to submission only. Approval and
    -- rejection are staff decisions — keep them out of the allow-list.
    and installment_payments.status in ('pending', 'submitted')
    -- Pin every column except receipt_url, status, and updated_at.
    -- The "row-id-scoped subselect" pattern mirrors client_update_safe_self
    -- (public.clients) — Postgres evaluates the subselect against the old
    -- row, so attempting to change any pinned column aborts the UPDATE.
    and installment_payments.amount                is not distinct from (select amount                from public.installment_payments where id = installment_payments.id)
    and installment_payments.due_date              is not distinct from (select due_date              from public.installment_payments where id = installment_payments.id)
    and installment_payments.month_no              is not distinct from (select month_no              from public.installment_payments where id = installment_payments.id)
    and installment_payments.plan_id               is not distinct from (select plan_id               from public.installment_payments where id = installment_payments.id)
    and installment_payments.approved_at           is not distinct from (select approved_at           from public.installment_payments where id = installment_payments.id)
    and installment_payments.rejected_note         is not distinct from (select rejected_note         from public.installment_payments where id = installment_payments.id)
    and installment_payments.auto_paid_from_wallet is not distinct from (select auto_paid_from_wallet from public.installment_payments where id = installment_payments.id)
    and installment_payments.created_at            is not distinct from (select created_at            from public.installment_payments where id = installment_payments.id)
  );


-- ----------------------------------------------------------------------------
-- M2 — Lock down installment_payment_receipts.receipt_url.
-- ----------------------------------------------------------------------------
-- Add a CHECK constraint: empty-string or https URL up to 1024 chars.
-- Drop first so re-runs are safe.
alter table public.installment_payment_receipts
  drop constraint if exists installment_payment_receipts_receipt_url_safe;

alter table public.installment_payment_receipts
  add constraint installment_payment_receipts_receipt_url_safe check (
    receipt_url = ''
    or (
      length(receipt_url) <= 1024
      and (
        receipt_url like 'https://%'
        or receipt_url like 'http://localhost%'  -- dev convenience only
      )
    )
  ) not valid;

-- Validate against existing rows. If this fails on prod, it means a legacy
-- row has a dangerous scheme (javascript:, data:, file:, etc.) — inspect
-- and clean up before re-running the VALIDATE step.
alter table public.installment_payment_receipts
  validate constraint installment_payment_receipts_receipt_url_safe;


-- ----------------------------------------------------------------------------
-- H1 — Serialize request_ambassador_payout per beneficiary.
-- ----------------------------------------------------------------------------
-- Function body is identical to the version in 03_functions.sql except for
-- the advisory lock on entry. The lock key is derived from the client id
-- via hashtext() so it fits in a bigint. pg_advisory_xact_lock releases
-- automatically at COMMIT/ROLLBACK, so we don't need matching unlock calls.
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

  -- H1 fix: serialize concurrent payout requests from the same beneficiary
  -- so the "events not yet claimed" select + insert-items INSERT cannot
  -- interleave with another transaction. Key format: 'payout:<uuid>'.
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

grant execute on function public.request_ambassador_payout(numeric, text) to authenticated;
