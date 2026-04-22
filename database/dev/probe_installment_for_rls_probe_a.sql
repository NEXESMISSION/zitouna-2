-- -----------------------------------------------------------------------------
-- One pending installment_payment for RLS probe user A (C1 / H2 table probes).
-- Run AFTER database/06_seed_dev.sql on the same database.
--
-- Idempotent: deletes prior probe sale/plan/payments for the same sale code.
-- -----------------------------------------------------------------------------

do $probe$
declare
  v_client uuid := (
    'd0000000-0000-4000-8000-' || substr(md5('rls_probe_a@zitouna.test'), 1, 12)
  )::uuid;
  v_parcel bigint;
  v_sale   uuid;
  v_plan   uuid;
  v_pay    uuid;
begin
  if not exists (select 1 from public.clients where id = v_client) then
    raise exception 'probe_installment_for_rls_probe_a: client PROBE-A missing — run 06_seed_dev.sql first';
  end if;

  select id into v_parcel
  from public.parcels
  where project_id = 'tunis' and status = 'available'
  order by parcel_number
  limit 1;

  if v_parcel is null then
    raise exception 'probe_installment_for_rls_probe_a: no available parcel in tunis';
  end if;

  delete from public.installment_payment_receipts
  where payment_id in (
    select ip.id from public.installment_payments ip
    join public.installment_plans pl on pl.id = ip.plan_id
    join public.sales s on s.id = pl.sale_id
    where s.code = 'PROBE-C1-SALE'
  );

  delete from public.installment_payments
  where plan_id in (
    select pl.id from public.installment_plans pl
    join public.sales s on s.id = pl.sale_id
    where s.code = 'PROBE-C1-SALE'
  );

  delete from public.installment_plans
  where sale_id in (select id from public.sales where code = 'PROBE-C1-SALE');

  delete from public.sales where code = 'PROBE-C1-SALE';

  insert into public.sales (
    code, project_id, parcel_id, parcel_ids,
    client_id, payment_type, agreed_price,
    status, pipeline_status
  )
  values (
    'PROBE-C1-SALE', 'tunis', v_parcel, array[v_parcel]::bigint[],
    v_client, 'full'::payment_type, 72000,
    'pending_finance', 'pending_finance'
  )
  returning id into v_sale;

  insert into public.installment_plans (
    code, sale_id, client_id, project_id, parcel_id,
    total_price, down_payment, monthly_amount, total_months, start_date, status
  )
  values (
    'PROBE-C1-PLAN', v_sale, v_client, 'tunis', v_parcel,
    72000, 14400, 2000, 24, current_date, 'active'
  )
  returning id into v_plan;

  insert into public.installment_payments (
    plan_id, month_no, due_date, amount, status
  )
  values (
    v_plan, 1, current_date + 30, 2000, 'pending'
  )
  returning id into v_pay;

  raise notice 'probe_installment_for_rls_probe_a: payment_id = %', v_pay;
end;
$probe$;
