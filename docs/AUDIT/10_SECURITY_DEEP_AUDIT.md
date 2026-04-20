# 10 — Security Deep Audit (supplementary)

> Scope: what `01_SECURITY_FINDINGS.md` missed + a from-scratch security review of
> the brand-new `database/08_notifications.sql` (never reviewed).
> Severity: **Critical → High → Medium → Low**. Each finding: What · Attack ·
> Severity rationale · Fix. File refs are `path:line`.

## Remediation status (2026-04-19)

| ID | Severity | Status | Where the fix lives |
|---|---|---|---|
| S2-C1 | Critical | Fixed | `database/12_notifications_security_patch.sql` — adds `admin_users.auth_user_id` FK to `auth.users` (conservative backfill: requires email_confirmed_at + single match), rewrites `emit_admin_notification` to fan out via the FK only, NOTICE-logs unlinked admins. |
| S2-C2 | Critical | Fixed | `database/12_notifications_security_patch.sql` — drops the `OR is_active_staff()` branch on `user_prefs_self`, adds `created_by`/`updated_by` columns + BEFORE INSERT/UPDATE actor-stamp trigger, exposes audited SECURITY DEFINER `admin_reset_user_prefs(...)` for legitimate cross-user resets. |
| S2-H1 | High | Fixed | `database/12_notifications_security_patch.sql` — `mark_notifications_read`, `mark_all_notifications_read`, `archive_notification` now insert an `audit_logs` row (action `notification_marked_read` / `notification_archived`) for every admin-scope notification touched, including a payload snapshot in metadata. |
| S2-H2 | High | Fixed | `database/12_notifications_security_patch.sql` — replaces `notif_channels_staff_crud` with read-all-staff + write-only-`is_super_admin()` policies, adds `is_super_admin()` helper and `_notif_channels_audit` AFTER trigger logging every change to `audit_logs`. |
| S2-H3 | High | Fixed | `database/12_notifications_security_patch.sql` — `REVOKE ALL ON FUNCTION public._notif_auth_user_for_client(uuid) FROM PUBLIC` plus REVOKE FROM authenticated. The function is now reachable only by SECURITY DEFINER triggers. |
| S2-H4 | High | Documented | No-op today (tokens are in localStorage, not cookies). To be addressed when the cookie-proxy migration lands; tracked alongside `S-H1` in `01_SECURITY_FINDINGS.md`. |
| S2-M1 | Medium | Fixed | `database/12_notifications_security_patch.sql` — adds `purge_old_notifications(p_days int default 90, p_scope text default 'admin')` (refuses < 30 days), pg_cron-scheduled at 04:30 daily when the extension is present. Investor-scope rows are kept. |
| S2-M2 | Medium | Fixed | `database/12_notifications_security_patch.sql` — adds `archived_reason text` + `acknowledged_by uuid` columns; new `archive_notification(p_id, p_reason)` requires both; old 1-arg signature kept as a wrapper with `p_reason='unspecified'`. |
| S2-M3 | Medium | Documented | `database/12_notifications_security_patch.sql` (S2-M3 comment block) — Supabase platform privileges are needed to fully pin cron job ownership; mitigation lives in the Supabase dashboard. Operational guidance documented in-place. |
| S2-M4 | Medium | Mitigated | `database/12_notifications_security_patch.sql` — adds `notification_errors` table + `_notif_log_error(_source, _dedupe, _error)` helper (RLS: staff read). One example trigger (`trg_commission_events_notify` in `08_notifications.sql`) retrofitted to call the helper. Remaining triggers can be migrated incrementally without schema churn. |
| S2-M5 | Medium | Mitigated | `database/12_notifications_security_patch.sql` — adds `target_hash` + `target_purged_at` on `notification_outbox`; BEFORE UPDATE trigger clears cleartext `target` when status transitions to `'sent'`. Worker is responsible for populating `target_hash` before send (out of scope for SQL). |
| S2-L1 | Low | Fixed | `vite.config.js` — `server.host = 'localhost'`, `strictPort = true`. Already present after merge; verified. |
| S2-L2 | Low | Deferred | `lucide-react` major-version bump skipped pending compat verification (every `<Icon>` import surface needs a regression check). Tracked. |
| S2-L3 | Low | Deferred | `vite-plugin-sri` install skipped pending compatibility check with the current Rollup pipeline + Vercel asset pipeline. Tracked. |
| FE2-H6 | High (FE) | Fixed | `database/12_notifications_security_patch.sql` — new `mark_all_notifications_read_categories(p_scope text, p_categories text[])` RPC; the original single-category function is unchanged for backward compat. |

**Summary:** 11 fixed, 2 mitigated, 2 documented (S2-H4, S2-M3), 2 deferred (S2-L2, S2-L3).

---

## Summary

| Severity | New count | Short list |
|---|---:|---|
| Critical | 2 | `emit_admin_notification` email-join admin impersonation (08) · notification prefs policy lets staff forge other users' opt-outs and silence security alerts (08) |
| High | 4 | `mark_all_notifications_read`/`archive_notification` SECURITY DEFINER bypass staff RLS allowing staff to clear their own audit trail (08) · Catalog-wide staff `FOR ALL` on `notification_channels` lets any staff toggle email/SMS channels on globally (08) · `_notif_auth_user_for_client` exposes auth mapping to any authenticated caller (08) · No CSRF / SameSite protection on Supabase REST when session is cookie-proxied in future |
| Medium | 5 | Notification `payload jsonb` includes PII (buyer name, phone, CIN-equivalent) readable by admins forever (08) · `archive_notification` hides danger alerts silently, no audit trail (08) · pg_cron wiring runs with cron role, no job-owner pinning (08) · Trigger `EXCEPTION WHEN OTHERS` swallows all errors, hides integrity bugs (08) · `notification_outbox.target` will store phone/email cleartext when SMS/email is enabled (08) |
| Low | 3 | Vite 8 in devDependencies (new major, potential dev-server SSRF via host header) · `lucide-react ^1.8.0` is 4+ years stale (pinned to `^1` = never updates) · No subresource integrity on any asset |

---

## 🔴 Critical

### S2-C1 — Admin fanout joins `admin_users.email ↔ auth.users.email`, allowing admin impersonation by duplicate-email signup
- File: [database/08_notifications.sql:313-319](../../database/08_notifications.sql)
- What: `emit_admin_notification` resolves recipient auth users with
  `JOIN auth.users u ON lower(trim(u.email)) = lower(trim(au.email))`. Supabase
  `auth.users.email` is **not globally unique by default** when confirmation
  is off — and even when on, nothing prevents a non-staff user from owning
  an email that matches an `admin_users.email` row where the staff member
  never signed up (e.g. an admin seeded in `admin_users` who has not yet
  registered in auth). `admin_users.email` is UNIQUE ([02_schema.sql:54](../../database/02_schema.sql)),
  `auth.users.email` is not.
- Attack: Attacker signs up with `ceo@zitouna.tn`, which happens to match an
  `admin_users` row that belongs to a real-but-not-yet-registered executive.
  Every admin-scope notification (payouts, new sales, new clients, PII) is
  emitted to the attacker's `auth.uid()`. Because `role_scope='admin'`
  the UI will render those in the staff bell. Combined with the pre-existing
  auto-link RLS block ([S-C2 in 01](01_SECURITY_FINDINGS.md)), the attacker may
  also become the `clients` row owner for that email — full staff takeover of
  the notification stream.
- Severity rationale: critical because (a) it leaks every future admin
  notification (payout amounts, PII of every new client), (b) the join is the
  only link used for fanout — no verification that the `auth.users.id`
  actually corresponds to the staff identity, (c) the attack is one signup away.
- Fix: Stop joining by email. Add `admin_users.auth_user_id uuid references
  auth.users(id)` (populated on first staff login after email confirmation)
  and fanout via that FK. Until that column exists, require
  `au.status='active' AND EXISTS (SELECT 1 FROM public.clients c WHERE
  c.auth_user_id = u.id)` is **insufficient** — use a dedicated staff linkage
  table with admin-gated inserts.

### S2-C2 — `user_prefs_self` policy lets staff write any user's notification opt-outs → silence fraud/payout alerts
- File: [database/08_notifications.sql:187-192](../../database/08_notifications.sql)
- What: `CREATE POLICY user_prefs_self ON public.user_notification_prefs FOR
  ALL TO authenticated USING (user_id = auth.uid() OR public.is_active_staff())
  WITH CHECK (user_id = auth.uid() OR public.is_active_staff());`. A compromised
  (or malicious) staff account can `INSERT` rows with `(user_id=<CEO>,
  category='payout', channel_key='in_app', enabled=false)`. The CEO will
  never again see a payout-approved or payout-rejected notification because
  `emit_notification` checks `enabled=false` and returns NULL
  ([08_notifications.sql:233-238](../../database/08_notifications.sql)).
- Attack: Staff-level insider colludes with an external beneficiary.
  (1) Write a pref row that mutes 'payout' for the CEO's auth uid and for
  every other staff member. (2) Approve fraudulent payouts.
  (3) No in-app alert fires, no audit trail shows the prefs row was written
  by the staff user (no `created_by` column).
  Because the same policy grants staff `SELECT`, the attacker can also
  enumerate every auth user's uid by reading the prefs table (or the users
  referenced from `user_notifications` — see 01 S-H6).
- Severity rationale: critical: bypasses the entire fraud-detection signal
  pipe, is silent, and is reachable by the standard staff JWT (no danger-zone
  role needed).
- Fix: (1) Drop the `OR public.is_active_staff()` branch — staff should **not**
  be able to write another user's prefs. (2) If a support workflow needs to
  reset a pref on behalf of a user, make a SECURITY DEFINER RPC
  `admin_reset_user_prefs(p_user_id)` that logs to `audit_logs`. (3) Add
  `created_by uuid`, `updated_by uuid` columns on `user_notification_prefs`
  populated by trigger with `auth.uid()`.

---

## 🟠 High

### S2-H1 — `mark_all_notifications_read` + `archive_notification` let staff hide admin-scope alerts from themselves without audit
- File: [database/08_notifications.sql:1102-1136](../../database/08_notifications.sql)
- What: Both RPCs run `SECURITY DEFINER`, filter only on `user_id = auth.uid()`,
  and accept NULL `p_scope` / NULL `p_category` (meaning "all"). A staff user
  who just received an admin payout alert can call
  `mark_all_notifications_read()` or `archive_notification(<id>)` and the
  alert disappears from their bell. There is no `audit_logs` entry, no
  moderation: the staff can now approve a fraudulent payout without their
  colleagues noticing that the alert was pre-read (alerts for the other
  admins fan out to their own rows, so this is limited — but combined with
  S2-C2 above, a single staff can silence all recipients).
- Attack: Combined with S2-C2: attacker mutes future alerts for everyone else,
  then self-archives any already-emitted alert. The evidence trail is
  `user_notifications.archived_at IS NOT NULL` but no "who archived" column
  exists ([02_schema.sql:622-631](../../database/02_schema.sql) plus the
  added `archived_at` is the only new column — no actor column). The
  severity of the underlying alert is kept, but nobody will see it.
- Severity rationale: High — prerequisite is an active staff JWT, but the
  payoff is the complete erasure of the fraud-detection trail for a targeted
  incident.
- Fix: (1) On archive/mark-read, insert an `audit_logs` row with
  `(actor=auth.uid(), action='notification_archived', target=p_id,
  before=notification_payload)`. (2) Forbid archiving admin-scope
  notifications older than N minutes to prevent retroactive suppression.
  (3) Keep an immutable shadow table `user_notifications_archive_events`.

### S2-H2 — `notif_channels_staff_crud` is `FOR ALL` → any staff can globally disable (or enable) SMS/email/push
- File: [database/08_notifications.sql:183-185](../../database/08_notifications.sql)
- What: `CREATE POLICY notif_channels_staff_crud ... FOR ALL TO authenticated
  USING (public.is_active_staff()) WITH CHECK (public.is_active_staff());`.
  Any STAFF-role user (not just super-admin) can `UPDATE
  notification_channels SET enabled=false WHERE channel_key='in_app'` and
  kill the in-app pipe for the entire organization. Or flip SMS to
  `enabled=true` before the outbox worker is hardened, causing uncontrolled
  SMS sends once a provider is configured.
- Attack: Low-privilege staff (e.g. a sales agent with `/admin/sell` access
  only) has `is_active_staff()=true` — the policy check does not distinguish
  roles ([03_functions.sql:26-39](../../database/03_functions.sql)). They can
  corrupt the notification system or weaponize it.
- Severity rationale: High — staff role is broadly granted, the policy is
  permissive on a global-config table, and there is no audit trigger.
- Fix: Replace with a narrower policy that checks `admin_users.role IN
  ('SUPER_ADMIN')` via a helper like `is_super_admin()`. Add an `audit_logs`
  trigger on `notification_channels`.

### S2-H3 — `_notif_auth_user_for_client` is SECURITY DEFINER + granted to authenticated → PII join oracle
- File: [database/08_notifications.sql:345-353](../../database/08_notifications.sql)
- What: `_notif_auth_user_for_client(p_client_id uuid)` returns
  `clients.auth_user_id` as SECURITY DEFINER. It is not explicitly revoked
  from PUBLIC or restricted. Because the RLS file grants EXECUTE on ALL
  FUNCTIONS ([04_rls.sql:481](../../database/04_rls.sql)), this function is
  callable by any authenticated user with any `client_id` (UUIDs are
  guessable if the attacker has seen any sale/commission payload).
- Attack: Authenticated attacker enumerates `client_id` UUIDs they've observed
  (from a shared referral tree, a delegated-seller view, etc.) and resolves
  them to `auth.users.id`. Combined with other oracle endpoints, this
  correlates client identity with auth identity and helps the auto-link
  hijack in [01 S-C2](01_SECURITY_FINDINGS.md).
- Severity rationale: High — it is an internal helper that bypasses RLS on
  `clients` (only `id` and `auth_user_id` leak, but that is enough for
  correlation) and is unnecessarily exposed.
- Fix: `REVOKE ALL ON FUNCTION public._notif_auth_user_for_client(uuid) FROM
  PUBLIC;` and do not grant it to `authenticated`. The function is only
  called from triggers (internal) — no need for client-side execute.

### S2-H4 — No CSRF / SameSite posture documented for the eventual cookie-backed session
- File: cross-cutting; specifically anticipates the S-H1 fix in [01 S-H1](01_SECURITY_FINDINGS.md)
- What: The mitigation path for localStorage tokens is to proxy Supabase via
  an HttpOnly cookie. When that lands, every mutating RPC (payouts,
  mark-read, `run_notification_scans`) becomes CSRF-reachable from any
  origin if the proxy does not set `SameSite=Lax` + a double-submit token.
  Nothing in the current repo plans for this.
- Attack: Future regression. An attacker hosts a page, user visits while
  logged in, attacker does `fetch('/api/proxy/rest/v1/rpc/archive_notification',
  {credentials:'include', method:'POST', body:...})`. Without SameSite the
  cookie is sent; the RPC runs.
- Severity rationale: High when the cookie migration happens; no impact today
  because tokens are in localStorage (not ambient).
- Fix: When adding the cookie proxy, mandate `Set-Cookie: ...; SameSite=Lax;
  HttpOnly; Secure` and add a CSRF token to every state-changing RPC.

---

## 🟡 Medium

### S2-M1 — Notification payloads persist PII (buyer name, phone, project) indefinitely with no retention
- File: [database/08_notifications.sql:414-422,599-614,888-894](../../database/08_notifications.sql)
- What: Payloads store `buyer_name`, `phone` (payout admin fanout includes
  beneficiary name + gross amount; client-registered fanout includes
  `NEW.full_name` and `NEW.phone`). These rows are kept forever; admin staff
  have `FOR ALL` on `user_notifications`. A staff user browsing stale
  notifications in the bell sees historical PII they may no longer be
  authorized to see (e.g., a project they were unassigned from).
- Attack: An ambassador / delegated seller later promoted to staff can scroll
  back to read PII of clients from before they had access.
- Severity rationale: Medium — PII exposure is limited to staff, but it
  violates least-privilege over time.
- Fix: Scheduled purge (e.g. `DELETE FROM user_notifications WHERE
  created_at < now() - interval '90 days' AND role_scope='admin'`), or
  redact PII in payload after N days.

### S2-M2 — `archive_notification` returns boolean with no audit — silent loss of danger alerts
- File: [database/08_notifications.sql:1122-1136](../../database/08_notifications.sql)
- What: Archiving a `severity='danger'` notification (payout_rejected,
  installment_overdue, commission_reversed) is indistinguishable from
  reading it. Combined with S2-H1: no evidence a critical alert was seen.
- Fix: Add an `acknowledged_by uuid`, `archived_reason text` column on
  `user_notifications`. Require both on archive.

### S2-M3 — pg_cron wiring does not pin job owner / database
- File: [database/08_notifications.sql:1065-1078](../../database/08_notifications.sql)
- What: `cron.schedule('zitouna_notification_scans', '0 6 * * *',
  'SELECT public.run_notification_scans();')` runs as whichever role owns
  the job (typically `postgres` super). `run_notification_scans` is SECURITY
  DEFINER — fine — but if the cron extension is compromised or another role
  later reschedules the same job name, the SQL body can be mutated.
- Fix: Use `cron.schedule_in_database(..., database text)` and set explicit
  owner; store cron job config in a locked table with a trigger guard.

### S2-M4 — `EXCEPTION WHEN OTHERS ... RAISE NOTICE` pattern in every trigger hides integrity bugs
- File: [database/08_notifications.sql:432-434,516-518,561-563,619-620,660-662,742-744,783-785,849-851,896-898,962-964,983-985,1034-1036](../../database/08_notifications.sql)
- What: Every notification trigger catches ALL exceptions and logs a NOTICE.
  `RAISE NOTICE` is not visible to Supabase users by default — it lands in
  the Postgres log only. If `emit_notification` starts silently failing (e.g.
  unique-violation on `dedupe_key`, FK violation on outbox channel FK, type
  mismatch after a future schema change), no operator will know. The payout
  notification silently not firing is a direct fraud-detection failure mode.
- Severity rationale: Medium — design goal was "don't abort the business
  write", but the chosen mechanism is invisible.
- Fix: Catch into a persistent `notification_errors` table with `event_id,
  error_text, occurred_at`. Expose an admin dashboard for non-empty rows.
  Better: only catch specific exceptions (`unique_violation`) rather than
  blanket `WHEN OTHERS`.

### S2-M5 — `notification_outbox.target` will hold cleartext phone/email at rest
- File: [database/08_notifications.sql:160-167](../../database/08_notifications.sql)
- What: Column `target text` is documented as "resolved phone/email/device
  token". Once SMS/email channels are enabled this becomes a GDPR-relevant
  PII store with no encryption, no retention, and `FOR ALL` staff access.
- Fix: Before enabling non-inapp channels: (1) add `target_hash`, keep
  cleartext only until `sent_at` then purge; (2) encrypt with pgcrypto using
  a key from Supabase Vault; (3) add a retention cron.

---

## 🟢 Low

### S2-L1 — Vite 8 just released; dev server host-header SSRF historically affected 4.x
- File: [package.json:28](../../package.json)
- What: `vite ^8.0.4`. The `^` allows 8.x updates. Vite has a history of
  dev-server host-header and file-serving issues (CVE-2023-34092, etc.).
  The prod build is unaffected, but any developer running `npm run dev`
  exposed on `0.0.0.0` is at risk until `server.host` allowlists are set.
- Fix: Add `server: { host: 'localhost', strictPort: true }` in
  `vite.config.js`. Run `npm audit` in CI.

### S2-L2 — `lucide-react ^1.8.0` is the legacy pre-fork version (4+ years old), will never update
- File: [package.json:14](../../package.json)
- What: `lucide-react@1.x` is the initial fork from `feathericons` (2020).
  Current is 0.4xx of the `lucide` namespace or `lucide-react@latest`. A `^1`
  range locks into an unmaintained lineage. Any bundled icon could ship
  stale SVG sanitization.
- Fix: Migrate to current `lucide-react@latest` (version range restarts at 0).

### S2-L3 — No Subresource Integrity (SRI) on inline bundle imports; no asset pinning
- File: [index.html:32](../../index.html)
- What: `<script type="module" src="/src/main.jsx">` — Vercel serves the
  built asset by hash, but without an SRI attribute a CDN compromise between
  Vercel and the user would go undetected. Vite's `build.rollupOptions` can
  emit SRI via a plugin.
- Fix: Install `vite-plugin-sri`, add to `vite.config.js`, confirm
  `integrity="sha384-..."` lands on build.

---

## Already covered in 01_SECURITY_FINDINGS.md (re-verified and still accurate)

- **S-C1 blanket grants** — confirmed [04_rls.sql:479-489](../../database/04_rls.sql).
  Relevant for 08: because `emit_notification`, `emit_admin_notification`,
  `mark_notifications_read`, etc. are explicitly `GRANT EXECUTE ... TO
  authenticated`, the blanket-grant risk is *partially* mitigated for these —
  but `_notif_auth_user_for_client` is **not** explicitly revoked (see S2-H3).
- **S-C2 auto-link hijack** — interacts with 08: a hijacked `clients.auth_user_id`
  immediately diverts every investor-scope notification to the attacker's
  auth uid via `_notif_auth_user_for_client`.
- **S-C3 delegated sellers can SELECT all clients** — confirmed
  [04_rls.sql:592-595](../../database/04_rls.sql). Still open.
- **S-C4 no CSP/headers on Vercel** — confirmed [vercel.json](../../vercel.json)
  has only `rewrites`.
- **S-C5 anon reads parcels / project_offers** — confirmed
  [04_rls.sql:41-77](../../database/04_rls.sql).
- **S-H1 localStorage tokens + no CSP** — confirmed
  [src/lib/supabase.js:18-25](../../src/lib/supabase.js).
- **S-H5 authLockSingleTab no-op** — confirmed
  [src/lib/supabase.js:16](../../src/lib/supabase.js).
- **S-L1 PII in console.warn** — confirmed via grep; still present.
- **No `dangerouslySetInnerHTML` / `innerHTML=` / `eval()` in `src/**`** —
  re-verified by grep; clean.

---

## Concrete next steps (new work only)

1. Ship **S2-C1** fix (admin linkage FK) + **S2-C2** fix (drop staff branch in
   prefs policy) this week — both are targeted SQL patches, low blast radius.
2. Add `audit_logs` rows from `emit_admin_notification`, `archive_notification`,
   `mark_all_notifications_read` (S2-H1).
3. Tighten `notif_channels_staff_crud` to a super-admin helper (S2-H2).
4. `REVOKE ALL ON FUNCTION public._notif_auth_user_for_client(uuid) FROM PUBLIC;`
   and remove the implicit `authenticated` grant (S2-H3).
5. Before enabling SMS/email channels, implement the outbox hardening in S2-M5.
