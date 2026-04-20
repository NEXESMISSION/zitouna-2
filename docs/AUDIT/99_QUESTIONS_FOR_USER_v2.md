# 99 — Questions for the User (v2)

> Generated 2026-04-18 after four parallel deep-audit passes over the repo.
> Source reports: `10_SECURITY_DEEP_AUDIT.md`, `11_DATABASE_DEEP_AUDIT.md`,
> `12_BUSINESS_LOGIC_DEEP_AUDIT.md`, `13_FRONTEND_DEEP_AUDIT.md`.
> Existing questions from `00_QUESTIONS_FOR_USER.md` are NOT repeated — check
> that file first, then this one.
>
> **How to use**: answer questions inline under each one. I read this file
> before taking any action on findings. For binary questions, a one-word
> answer is enough. Bold = I consider this a blocker before shipping.

---

## 0. Reading guide — what hurts the most right now

After four audit passes I'd rank the most damaging findings this way.
Confirm or reorder; everything below hinges on this priority list.

1. **Any authenticated user can forge admin phishing notifications**
   (`emit_notification` is `SECURITY DEFINER` with no identity check — DB11-C1).
   A buyer can drop a fake "Virement effectué — ref IBAN123" into every
   staff bell, deep-linked to a page they control.
2. **Blanket `GRANT EXECUTE TO anon` on all functions** (already flagged as
   S-C1) means even anonymous visitors can invoke those forgery helpers
   (DB11-C2). This compounds #1.
3. **Double-payout race** on commission payout requests — the same
   `commission_event` can land in two concurrent requests, both get paid
   (BL12-C2).
4. **Sale cancellation leaves commissions payable** — a cancelled sale
   does not reverse its commission events, so the beneficiary still
   withdraws (BL12-C3).
5. **Module-scope data stores leak PII across users** on user-switch in
   the same browser (FE2-C1).
6. **Notifications bell realtime churns on every re-render** — events
   can disappear during reconnect windows (FE2-C2).

Q0.1 Do you want me to fix items 1-6 in that order, or re-rank?
Q0.2 Any of these OK to defer past launch? Which?
Q0.3 **Is this app live with real users today, or still pre-launch?** The
     answer completely changes the rollout plan for every fix below.

---

## 1. Questions about the notification system I shipped today (08_notifications.sql)

The audit was brutal on my own work. Before I patch, I need these.

Q1.1 **emit_admin_notification joins `admin_users.email` → `auth.users.email`.**
     `auth.users.email` is not unique — email change / dual accounts will
     hijack admin notifications (S2-C1). Do you want me to add
     `admin_users.auth_user_id uuid` with a FK to `auth.users`, backfill
     it, and rewrite the fanout to use that column? The alternative is a
     uniqueness guard + lowercase normalisation, but the FK is cleaner.

Q1.2 **Any authenticated user can forge a notification to any other user**
     via `emit_notification` (DB11-C1). Should I (a) drop `authenticated`
     execute and keep it callable only from triggers, or (b) add an
     `auth.uid() = _invoker_or_trigger` guard? Option (a) is the right
     answer; just confirm.

Q1.3 **The retrofit UPDATE at 08_notifications.sql:90 re-runs every apply**
     and clobbers any category/severity an admin has manually fixed
     (DB11-C3). Want me to split it into a one-shot backfill block that
     only fires if a sentinel row is missing?

Q1.4 **`user_prefs_self` lets staff write prefs for any user** (S2-C2). A
     rogue staff member can mute payout alerts on the CEO/finance-chief
     account and then approve fraudulent payouts silently. Two options:
     (a) remove the `OR is_active_staff()` branch entirely — staff manage
     their own prefs only; (b) allow staff read-only and force writes
     through an audited RPC. Which?

Q1.5 **No actor column on user_notifications.** If a staff archives/reads
     a notification, there's no audit trail. Do you want an
     `actor_audit_log` table for mark_read and archive RPCs? (Probably
     yes — finance events need this.)

Q1.6 The `pg_cron` block in 08_notifications.sql silently no-ops if the
     extension is missing. **Is pg_cron installed in your Supabase
     project?** If not, how will `run_notification_scans()` get called —
     a Supabase Scheduled Function? A Vercel cron? Manual?

Q1.7 The outbox `target` column is cleartext phone/email/device-token.
     For SMS/email later, do you want encryption-at-rest via pgcrypto on
     write, or is plain text fine (Supabase storage is encrypted at the
     disk layer anyway)?

Q1.8 **How many active staff rows do you have today?** The admin fanout
     loops once per staff — at 5-20 it's fine, at 500 it needs batching.

---

## 2. Authentication & account linking

Q2.1 `01_SECURITY_FINDINGS.md:S-C2` already flagged auto-link-by-email
     hijack. **Is email confirmation enabled in your Supabase project?**
     (Authentication → Providers → Email → Confirm email.) If not, this
     is critical.

Q2.2 **Is phone OTP required at signup, or is a client auto-linked to a
     `clients` row by phone as soon as it matches?** The audit read the
     code as "auto-link on first session resolve", which is the hijack
     vector for families sharing a phone.

Q2.3 Delegated sellers can `SELECT * FROM clients` (S-C3). **Do you want
     sellers to (a) only see clients they've worked with, (b) search by
     phone/email via a narrow RPC, or (c) keep today's behaviour?**

Q2.4 **Who's allowed to create a `clients` row without an `auth_user_id`?**
     (Staff during a call-center intake? Anyone on the public Sell page?)
     The audit shows stub clients can be silently attached to an attacker
     account.

Q2.5 Password policy mismatch between login/register/reset pages is
     flagged. **What's your intended minimum length and complexity?**
     The audit suggests ≥10 chars, no upper bound, zxcvbn score ≥3.

Q2.6 **Do you want 2FA on staff accounts?** Supabase supports TOTP
     enrolment via its Auth API — it's a 1-day lift for admin-only 2FA.

---

## 3. Database & RLS hardening

Q3.1 `04_rls.sql:479-511` opens every table/function to `authenticated`
     and `anon` by default (S-C1, DB11-C2). **Do you want me to replace
     the blanket grants with per-table grants + drop the
     `ALTER DEFAULT PRIVILEGES`?** This is a ~100-line diff and must be
     tested against every admin page.

Q3.2 `detect_parrainage_anomalies` and several SECURITY DEFINER RPCs are
     granted to `authenticated`. **Should they be staff-only?** (They
     read cross-client data.)

Q3.3 Missing unique constraints flagged by the DB audit: do you want me
     to add them all, or only the money-critical ones (payout items,
     commission event uniqueness per sale/level/beneficiary)?

Q3.4 **Do you rely on soft-deletion anywhere?** The audit shows some FKs
     use `ON DELETE CASCADE` (wallet will disappear with the client) and
     others `SET NULL`. I need to know which tables you expect to be
     tombstoned vs truly deleted.

Q3.5 The audit flagged `numeric(14,2)` on money columns but
     `numeric(14,4)` on commission rule `value`. **Is that intentional**
     (4 decimals for percents expressed like `0.0050`)? Commission math
     with mixed precision is a silent-rounding source.

Q3.6 **Who is allowed to delete rows from `audit_logs`?** Today it's any
     authenticated user via the blanket grant. This usually wants to be
     staff-only, insert-only, with manual retention.

---

## 4. Money flow & commissions

Q4.1 **Commission double-payout race (BL12-C2)** — the fix is either
     (a) add a unique index on `commission_payout_request_items(commission_event_id)`
     where the parent request is not rejected, or (b) wrap claim in an
     advisory lock + transaction. Which do you prefer? (a) is simpler.

Q4.2 **Cancelled sale still pays out (BL12-C3).** I can add a trigger
     that, on `sales.status='cancelled'`, sets every linked
     `commission_events.status='cancelled'`. Do you want me to also
     clawback already-paid commissions (negative ledger entry), or only
     stop the unpaid ones?

Q4.3 **What's the policy when a buyer requests a refund after the sale
     is `active` but before `completed`?** No path in the code today
     describes that — everything is "cancel or continue".

Q4.4 Self-referral check exists in code but only partially. **Can a
     buyer be their own ambassador if they enter their own referral
     code?** The audit found at least one code path that bypasses the
     check.

Q4.5 Parrainage cycle detection exists as a report
     (`detect_parrainage_anomalies`) but **nothing blocks the creation of
     a cycle at write time**. Should I add a DB trigger that raises on
     `seller_relations` insert if it would create a cycle?

Q4.6 `seller_parcel_quota` vs `seller_parcels_sold_count` — **is the
     count decremented on sale cancellation?** The audit says no. Fix?

Q4.7 `ambassador_wallets.balance` — **is this a cache/projection or
     source of truth?** If cache, who recomputes it? The audit found
     drift paths.

Q4.8 **Minimum payout threshold**: where is it enforced? The audit
     couldn't find a server-side check in `submitCommissionPayoutRequest`.

---

## 5. Installments

Q5.1 **Overdue definition**: today my new `08_notifications.sql` fires
     `installment_overdue` the day after `due_date`. Do you want a grace
     period (e.g., 3-day grace before flagging)?

Q5.2 `installment_payments.status` has values `pending/submitted/approved/rejected`.
     **Is there a "late_paid" or "partial" state you need and we don't
     model?**

Q5.3 **Auto-debit from wallet**: `auto_paid_from_wallet` is a boolean on
     the payment row, but I didn't see the actual debit logic. Does a
     cron job sweep wallets at due time? Or is it an admin button?

Q5.4 When a receipt is rejected, **does the payment go back to `pending`
     or stay `rejected`?** The trigger behaviour differs.

Q5.5 Late fees — **is there a fee model at all today, or is the app
     forgiving?**

---

## 6. Sales pipeline

Q6.1 Reservation expiry relies on a missing RPC
     `expire_pending_sales_reservations` (BL12-C1). **Has expiry just
     been silently broken in production?** If yes, for how long?

Q6.2 Status transitions in `sales.status` are validated by a trigger
     on `completed` only. **Are there other invariants that should be
     enforced at the DB level** (e.g., `pending_legal` requires
     `legal_terms_signed_at`)?

Q6.3 `post_notary_destination` is nullable + CHECK. **What's the rule:
     when does it become non-null?** The audit couldn't find the
     state machine.

Q6.4 **If a sale is split across multiple parcels (`parcel_ids[]`) and
     one parcel gets revoked, what happens to the sale?** No handler
     today.

---

## 7. Frontend correctness

Q7.1 **Module-scope data cache (useSupabase.js)** leaks across users on
     switch. Fix: reset on `USER_UPDATED` and `TOKEN_REFRESHED` when
     `user.id` changes, not just `SIGNED_OUT`. Approve this approach?

Q7.2 **useNotifications re-subscribes every render** (FE2-C2). Fix is
     to move the realtime channel into a `useRef`-stabilised effect
     depending only on `userId` + `scope`. OK to ship this with the
     other notification fixes?

Q7.3 **Toast freshness uses local clock** (FE2-H3). Three options:
     (a) drop the freshness check entirely and rely on realtime's own
     dedup, (b) fetch the server's `now()` once at mount and use the
     offset, (c) keep client clock + widen window to 60s. Preference?

Q7.4 **PII in `sessionStorage`** on the Sell wizard (already flagged).
     Do you want me to switch to an in-memory state machine that's
     wiped on route change, or keep sessionStorage for UX reasons?

Q7.5 **Error tracker** (Sentry / Rollbar / self-hosted Glitchtip).
     Do you want me to wire one? The audit calls this out multiple
     times as "we're flying blind".

---

## 8. Privacy & compliance

Q8.1 **Tunisia — INPDP / data protection**: do you have a DPA /
     privacy policy I should cross-reference? The app stores CIN +
     phone + address; the audit didn't see any retention policy.

Q8.2 **Right-to-erasure**: if a buyer asks to be deleted, what's the
     procedure today? Cascading deletes will nuke their commission
     history — that's legal risk.

Q8.3 **Audit log retention** — how long do you keep `audit_logs`? No
     TTL today; the table will grow forever.

Q8.4 **Sensitive payloads in notifications**: amounts, IBAN refs, CIN
     fragments. Is there any data you explicitly do NOT want inside
     `user_notifications.payload`? (Relevant now that we're prepping
     SMS/email delivery which will forward the payload verbatim.)

---

## 9. Operations

Q9.1 **Deployment target** — Vercel only, or also Supabase Edge
     Functions? This changes how I wire future notification workers.

Q9.2 **Who manages the Supabase project settings** (extensions,
     scheduled functions, auth config)? I need to know if I can
     change those, or if I write SQL and you apply it.

Q9.3 **Environments**: is there a staging DB, or do changes go
     straight to prod?

Q9.4 **Backups**: do you rely on Supabase PITR, daily snapshot, or
     something custom? For the notification migration I'd want a
     snapshot before applying.

Q9.5 **SMS / email providers**: when you're ready, will it be
     Twilio / Resend, or Tunisian SMS aggregators (Infobip,
     Orange Tunisia API)? The outbox schema handles either, but
     target-resolution logic differs.

Q9.6 **Mobile native push**: React Native, Capacitor, Flutter, or
     wrapped PWA? The notification_outbox `push` channel is ready
     but device-token storage is not — I need to add a
     `user_push_tokens` table, and that schema differs per platform.

---

## 10. Questions I have for this audit itself

Q10.1 **Do you want me to act on findings as I read them**, or produce
      a patch plan first, wait for approval, and only then touch code?
      Given the criticality of some issues I lean towards patch-plan
      first, but it's your call.

Q10.2 **Should I re-run the auditors periodically** (e.g., on every
      major merge), or was this a one-shot?

Q10.3 The existing `docs/AUDIT/00_QUESTIONS_FOR_USER.md` is ~200
      lines. **Have those been answered anywhere I missed?** If yes,
      where — they will strongly influence the fixes.

---

## Quick-answer skeleton (copy/paste and fill in)

```
Q0.1: order is fine / re-rank as: ...
Q0.3: pre-launch | small pilot | live with N users
Q1.1: add auth_user_id FK | uniqueness guard | leave for later
Q1.2: drop authenticated grant
Q1.3: split into one-shot backfill
Q1.4: option a | option b
Q1.5: yes add audit table | no
Q1.6: pg_cron installed = yes|no; runner = supabase|vercel|manual
Q1.8: N staff = ?
Q2.1: email confirm = yes|no
Q2.2: phone OTP required = yes|no
...
```
