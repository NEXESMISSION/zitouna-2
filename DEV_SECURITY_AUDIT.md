# Zitouna Webapp — Security & Robustness Audit

**Date:** 2026-04-21
**Scope:** Source tree at repo root (`src/`, `database/`, `vercel.json`, built `dist/`), public production site, Supabase instance `ltouiyyuhwsvmuyqazwn`.
**Methodology:** Static review of RLS policies, RPC functions, schema constraints, frontend bundle, hosting headers. No active probing of prod.

**Status key:** ✅ patched in code · ⏳ DB migration pending apply · 🔲 not yet addressed.

---

## Executive summary

| Severity | Count | Headline | Status |
| --- | --- | --- | --- |
| 🔴 Critical | 1 | Clients can tamper with `installment_payments.amount` via RLS hole (C1) | ✅ + ⏳ |
| 🟠 High     | 3 | Payout race (H1); `status='rejected'` self-settable (H2); unfiltered realtime on `parcel_tree_batches` (H3) | ✅ / ⏳ |
| 🟡 Medium   | 5 | CSP gaps; receipt_url not validated (M2); phone_identities insert trusts caller; no rate limiting; PWA cache | M2 ✅ + ⏳ · rest 🔲 |
| 🟢 Low      | 4 | No CSP `report-uri`; log hygiene; no secret scan in CI; source maps in prod | 🔲 |

**Remediation applied in this commit:** C1, H1, H2, H3, M2. The SQL changes are in both the base files (`database/02_schema.sql`, `03_functions.sql`, `04_rls.sql`) **and** a ready-to-run migration at `database/dev/security_remediation_2026_04_21.sql`. **You still need to paste that migration into the Supabase SQL editor to patch the live DB** — code changes alone do not update production.

---

## 🔴 C1 — `installment_payments` RLS lets the client overwrite `amount` / `due_date` / `approved_at`

**Location:** `database/04_rls.sql:251-268`

```sql
create policy client_update_own_payment_submit on public.installment_payments
  for update to authenticated
  using (...plan belongs to current client...)
  with check (
    ...plan belongs to current client...
    and public.installment_payments.status in ('pending','submitted','rejected')
  );
```

**The hole:** the policy only checks ownership and the *final* `status` value. Every other column (`amount`, `due_date`, `month_no`, `approved_at`, `receipt_url`, `rejected_note`, `auto_paid_from_wallet`) is freely writable by the buyer.

**Attack:**
```js
// As an authenticated client:
await supabase
  .from('installment_payments')
  .update({ amount: 1, status: 'submitted' })
  .eq('id', myPaymentId)
```
Client pays 1 DT instead of the scheduled installment amount. If staff approves without re-checking against the plan, money is lost.

**Reference for the correct pattern:** the `clients` self-update policy at `database/04_rls.sql:157-174` uses `is not distinct from` to pin every sensitive column. Do the same here.

**Fix (drop-in):**
```sql
drop policy if exists client_update_own_payment_submit on public.installment_payments;
create policy client_update_own_payment_submit on public.installment_payments
  for update to authenticated
  using (
    exists (select 1 from public.installment_plans p
            where p.id = installment_payments.plan_id
              and p.client_id = public.current_client_id())
  )
  with check (
    exists (select 1 from public.installment_plans p
            where p.id = installment_payments.plan_id
              and p.client_id = public.current_client_id())
    and installment_payments.status in ('pending','submitted')  -- drop 'rejected' (see H2)
    and installment_payments.amount       is not distinct from (select amount        from public.installment_payments where id = installment_payments.id)
    and installment_payments.due_date     is not distinct from (select due_date      from public.installment_payments where id = installment_payments.id)
    and installment_payments.month_no     is not distinct from (select month_no      from public.installment_payments where id = installment_payments.id)
    and installment_payments.plan_id      is not distinct from (select plan_id       from public.installment_payments where id = installment_payments.id)
    and installment_payments.approved_at  is not distinct from (select approved_at   from public.installment_payments where id = installment_payments.id)
    and installment_payments.rejected_note is not distinct from (select rejected_note from public.installment_payments where id = installment_payments.id)
    and installment_payments.auto_paid_from_wallet is not distinct from (select auto_paid_from_wallet from public.installment_payments where id = installment_payments.id)
  );
```

Better still: remove self-update entirely and add a `submit_installment_payment(payment_id, receipt_url)` SECURITY DEFINER function that only touches `status`, `receipt_url`, `updated_at`.

**Verification after fix:** use the probe in Appendix A.

---

## 🟠 H1 — `request_ambassador_payout` has a TOCTOU race

**Location:** `database/03_functions.sql:997-1086`

The function selects "payable" commission events that aren't already claimed, then inserts a new payout request + items. There is no row-level lock between the read and the inserts, and no unique constraint stopping a commission event from appearing on two *pending* payout requests.

**Proof this is unguarded:** `commission_payout_request_items` (schema `02_schema.sql:497-501`) has PK `(request_id, commission_event_id)` — that prevents duplicates within one request, not across requests.

**Attack:**
Fire two parallel `rpc('request_ambassador_payout', { p_amount: X })` calls (no idempotency key, or different keys). Both read the same set of payable events (neither sees the other's not-yet-inserted rows), both create a request claiming the same events. The client now has ~2x the claim pending. Admin approves one → second one shows insufficient balance, but if approved manually → double payout.

**Fix options:**
1. Add a `FOR UPDATE` lock on the selected commission events, or
2. Add a partial unique index:
   ```sql
   create unique index ux_commission_payout_items_live
     on commission_payout_request_items (commission_event_id)
     where exists (
       select 1 from commission_payout_requests pr
       where pr.id = commission_payout_request_items.request_id
         and pr.status in ('pending_review','approved')
     );
   ```
   (Partial-index `WHERE` cannot reference a join — need a trigger-maintained `locked` boolean on the event, or an `advisory_xact_lock` on `beneficiary_client_id`.)
3. Simplest: `PERFORM pg_advisory_xact_lock(hashtext('payout:' || v_client_id::text));` at the start of the function.

Recommend **option 3** — one line, fixes it.

---

## 🟠 H2 — Client can self-set `status = 'rejected'`

**Location:** `database/04_rls.sql:267` — the `with check` allows `status in ('pending','submitted','rejected')`.

`rejected` is a staff decision. If a client sets their own pending payment to `rejected`, they can short-circuit auto-rejection workflows, hide evidence from admin queues, or trigger re-submission loops. Combined with C1 (amount tamper), this is worse.

**Fix:** drop `'rejected'` from the allow-list (see patched policy in C1 above).

---

## 🟠 H3 — Unfiltered realtime channel on `parcel_tree_batches`

**Location:** `src/lib/useSupabase.js:1078`

```js
.on('postgres_changes', { event: '*', schema: 'public', table: 'parcel_tree_batches' }, ...)
```

No `filter:` clause. Every `PlotPage` subscribes to *every* batch change across the whole DB. With N concurrent public viewers and M tree-batch writes, you get N×M realtime fanout.

- CPU on the client from constant refresh storms (partly mitigated by the 2s throttle at `:1080` — good, but it throttles the *refetch*, not the message ingest).
- Supabase realtime quota consumed unnecessarily.
- Information leak: every subscriber is notified about every parcel's batch changes.

**Fix:** drop the subscription for this table entirely (the `parcels` filtered subscription already triggers refresh when tree counts change through the join), or add `filter: "parcel_id=in.(...)"`.

---

## 🟡 M1 — CSP is missing `frame-src` for some embeds + no `report-uri`

**Location:** `vercel.json:39` (just patched for Google Maps in commit `57829ea`).

Current value:
```
default-src 'self'; ... frame-src https://www.google.com https://maps.google.com https://www.google.tn https://www.openstreetmap.org; ...
```

Gaps:
- No `report-uri` or `report-to` — violations are invisible in prod.
- `script-src 'self'` means any inline script or CDN will break silently. Sentry, analytics, or a future embed will require explicit additions.
- `connect-src` whitelist does not include the Supabase storage CDN if you use signed URLs from a different subdomain.

**Fix:** add `report-uri https://<sentry-project>.ingest.sentry.io/api/<id>/security/?sentry_key=...`, set up a Sentry project to collect CSP violations.

---

## 🟡 M2 — Receipt insert does not pin `receipt_url` content

**Location:** `database/04_rls.sql:291-301`

Client can insert an `installment_payment_receipts` row for any of their payments with any `receipt_url` string. If the frontend uses that value for display (and you already do), a malicious client can inject `javascript:` URLs, external tracker URLs, or oversized text that breaks admin views.

**Fix:** add a `CHECK` constraint on `receipt_url` to enforce `https://` prefix and length, or strip at insert time via a BEFORE INSERT trigger.

---

## 🟡 M3 — `client_phone_identities` insert uses `auth_user_id = auth.uid()` but does not validate the phone

**Location:** `database/04_rls.sql:191-194`

The policy trusts that the row's `phone_e164` field is the real OTP-verified phone. There's no check that the phone was verified, nor that it matches the JWT's phone claim. An authed user with a session can insert arbitrary phone rows linking themselves to any phone number.

**Fix:** route phone insertion through a SECURITY DEFINER function that validates the `auth.users` row's phone claim before inserting.

---

## 🟡 M4 — No app-layer rate limiting

No visible throttling on:
- OTP request flow (SMS cost + enumeration)
- `/browse` public fetch
- `request_ambassador_payout`
- `ensure_current_client_profile` (runs on every app boot)

Supabase has platform-level defaults but nothing per-user at the RPC layer.

**Fix:** add a lightweight `call_log` table + RPC-side check (`count(*) where created_at > now() - interval '1 min' and client_id = v_client_id`), or move rate-sensitive endpoints behind an Edge Function with Upstash ratelimit.

---

## 🟡 M5 — PWA service worker likely caches authed responses

**Location:** `public/sw.js`

Not yet audited in detail. Risk: if the service worker stores authenticated JSON (e.g. dashboard data, commission events) in CacheStorage without scoping to the user, next user on a shared device can read the previous user's data.

**Fix:** review `sw.js` for `cache.put` on any URL that carries an `Authorization` header; either never cache those or clear caches on sign-out (`caches.keys().then(keys => keys.forEach(caches.delete))`).

---

## 🟢 L1 — Source maps shipping to production

```
$ ls dist/assets/*.map | wc -l
```
(Check manually — Vite ships maps by default unless `build.sourcemap: false`.)

Impact: full unminified source is readable from prod. Not a vuln on its own, but it makes reverse-engineering the purchase/commission flows trivial and accelerates every other attack listed here.

**Fix:** `vite.config.js` → `build: { sourcemap: 'hidden' }` and upload maps to Sentry separately.

## 🟢 L2 — Anon key literal is in the bundle (expected, but note)

`dist/assets/supabase-ySp4Vhlo.js` contains the `VITE_SUPABASE_ANON_KEY`. This is **correct and intended** — the anon key is meant to be public, and Supabase security relies on RLS. Just flagging so no one panics.

Audit verified: **no `service_role` key appears in the bundle.** ✅

## 🟢 L3 — No CI secret scanning

No `.github/workflows/*.yml` runs gitleaks / trufflehog. A future service-role leak would go unnoticed until exploited.

**Fix:** add `.github/workflows/secret-scan.yml` running gitleaks on every push.

## 🟢 L4 — `audit_logs` is unbounded and PII-heavy

`database/02_schema.sql:518` — no retention policy, table grows forever, contains `client_id`, `metadata jsonb`, idempotency keys.

**Fix:** monthly job to archive rows older than 12 months to cold storage; scrub `metadata` of PII before archival.

---

## What I did NOT audit (follow-up work)

1. **Full read of `database/03_functions.sql` (2645 lines, 35 functions).** I spot-checked `request_ambassador_payout`; the remaining 34 need a pass for similar TOCTOU, missing auth, and SECURITY DEFINER pitfalls. Specifically target: `compute_and_insert_commissions_for_sale`, `assign_seller_parcel`, `create_buyer_stub_for_sale`, `heal_my_client_profile_now`, `emit_notification`.
2. **Full read of `database/07_hardening.sql` and `08_notifications.sql`** (1389 + 1925 lines).
3. **All 40+ RLS policies** — I reviewed the client-facing subset; staff-CRUD policies for admin tables (`admin_users`, `audit_logs`, `page_access_grants`) were skimmed.
4. **Frontend XSS / `dangerouslySetInnerHTML`** — not searched yet.
5. **File upload / storage policies** — receipts are uploaded somewhere; Supabase Storage RLS was not reviewed.
6. **Service worker (`public/sw.js`)** — see M5.

---

## Appendix A — Concrete test probes

### A.1 — Installment payment amount tamper (verifies C1)

```js
// scripts/probe_c1.mjs
import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

await sb.auth.signInWithPassword({ email: 'testbuyer@example.com', password: '...' })
const { data: payments } = await sb.from('installment_payments').select('*').limit(1)
const p = payments[0]
const { data, error } = await sb
  .from('installment_payments')
  .update({ amount: 1 })
  .eq('id', p.id)
  .select()
console.log('Tamper result:', { before: p.amount, after: data?.[0]?.amount, error })
// EXPECTED after fix: after === before, error non-null
```

### A.2 — Parallel payout race (verifies H1)

```js
// scripts/probe_h1.mjs
import { createClient } from '@supabase/supabase-js'
const sb = createClient(...) // authed as an ambassador with payable balance
const calls = Array.from({ length: 10 }, (_, i) =>
  sb.rpc('request_ambassador_payout', { p_amount: 1, p_idempotency_key: `race-${i}` })
)
const results = await Promise.all(calls)
const ok = results.filter(r => r.data?.ok)
console.log(`Successful concurrent claims: ${ok.length}`)
// EXPECTED after fix: exactly 1 succeeds (advisory lock serialises), others fail with NO_PAYABLE_EVENTS or INSUFFICIENT_BALANCE
```

### A.3 — Realtime fanout measurement (verifies H3)

Open 5 browser tabs on `/project/XXX/plot/YYY`. In a 6th tab (admin), update a tree batch on a completely unrelated plot. Observe all 5 public tabs hit the refresh in DevTools Network. After fix, none of them should.

### A.4 — RLS matrix probe (general hardening)

```js
// scripts/probe_rls.mjs — run as anon, then as non-staff authed, compare
const tables = [
  'clients', 'sales', 'installment_plans', 'installment_payments',
  'installment_payment_receipts', 'commission_events',
  'commission_payout_requests', 'commission_payout_request_items',
  'ambassador_wallets', 'audit_logs', 'admin_users', 'page_access_grants',
]
for (const t of tables) {
  const anon = await sbAnon.from(t).select('*').limit(1)
  const usr = await sbUser.from(t).select('*').limit(1)
  console.log(t, { anon: anon.data?.length, usr: usr.data?.length, anonErr: anon.error?.message, usrErr: usr.error?.message })
}
// EXPECTED: public projects/parcels readable, everything client-scoped returns only own rows, admin tables deny both
```

---

## Appendix B — Load / capacity baseline

Not yet measured. Suggested starter:

```bash
# Public-page capacity (safe on prod)
npx autocannon -c 100 -d 30 https://zitouna-2.vercel.app/

# Realistic flow (staging only)
# scripts/k6_flow.js: login → /browse → /project → /plot → RPC request_ambassador_payout(0.01 dry-run)
k6 run --vus 50 --duration 5m scripts/k6_flow.js
```

Acceptance targets (first draft, calibrate after first run):
- p95 < 800 ms on public browse at 50 rps
- p95 < 1500 ms on authed dashboard at 20 rps
- zero 5xx under 2x peak load
- Supabase CPU < 60% during soak

---

## Appendix C — Recommended remediation order

1. **Today** (30 min): apply the C1 policy patch, redeploy. Single highest-risk money bug.
2. **This week** (2 h): H1 advisory lock + H2 status drop + C1 staff-controlled RPC migration.
3. **This week** (1 h): H3 realtime filter.
4. **Next week** (4 h): M1 + M5 + L1 (CSP report, SW audit, source maps off).
5. **Next sprint**: finish the DB function audit (2645 lines), add rate limiting (M4), CI secret scan (L3).

---

## Appendix D — Files referenced

- `database/02_schema.sql` — table definitions
- `database/03_functions.sql` — 35 RPCs, 33 SECURITY DEFINER
- `database/04_rls.sql` — 40+ policies, the main target of this audit
- `database/07_hardening.sql` — 10 more RPCs, not audited
- `database/08_notifications.sql` — 31 more RPCs, not audited
- `src/lib/db.js` — client-side Supabase calls (mapping layer)
- `src/lib/useSupabase.js` — realtime subscriptions + hooks
- `vercel.json` — CSP + cache headers
- `dist/assets/*.js` — production bundle (anon key present, no service_role)

---

*Report generated by Claude (Opus 4.7) via static analysis. No active scanning was performed against production. All probe scripts in Appendix A are designed to be run in a staging environment with a disposable test account.*
