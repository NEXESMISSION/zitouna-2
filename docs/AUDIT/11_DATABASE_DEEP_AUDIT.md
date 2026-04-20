# 11 — Database Deep Audit (additive to 02)

> Severity ordering: **Critical → High → Medium → Low**.
> Focused on what [02_DATABASE_RLS_FINDINGS.md](02_DATABASE_RLS_FINDINGS.md) missed and on the brand-new [database/08_notifications.sql](../../database/08_notifications.sql).
> All findings here are *additive*. The "Already covered" section at the end maps issues that 02 has already raised.

## Summary

| Severity | Count | Short list |
|---|---:|---|
| Critical | 3 | `emit_notification` lets any caller forge notifications for any user · `emit_admin_notification` is callable by `anon` (notification spam to staff) · 08 mutation block (retrofit UPDATE) re-runs every apply and rewrites historical category/severity |
| High | 6 | `notification_outbox` has no concurrency-safe claim mechanism (double-send risk) · `dedupe_key` is GLOBALLY unique — admin fanout collisions across categories possible · `_notif_auth_user_for_client` returns oldest match, suffers same stub bug as DB-H5 · Sales notify trigger only fires on `status`, ignores `pipeline_status` transitions · N+1 channel-prefs lookup inside `emit_notification` loop · `trg_commission_events_notify` (08 version) drops the `kind` field that the legacy 03 payload carried — UI may break |
| Medium | 7 | `notification_outbox.user_id` / `user_notification_prefs.user_id` lack FK to `auth.users` · New 08 tables not in 04 baseline `GRANT` (rely on `DEFAULT PRIVILEGES`) · `mark_notifications_read` has no `auth.uid() IS NULL` guard (silently no-ops for anon, but exposes function existence) · pg_cron `unschedule(jobid)` returns `setof void` — `PERFORM ... FROM cron.job` is a misuse pattern · `notification_channels` row-update trigger missing — `updated_at` never refreshed · Outbox `payload_snapshot` duplicates `user_notifications.payload` (drift risk) · `category` CHECK list duplicated in two places (table + prefs) — drift hazard |
| Low | 4 | `to_char(NEW.date,'DD/MM')` strips year (ambiguous in cross-year reminders) · Body strings hardcoded in French (no i18n hook) · `idx_user_notifications_user_cat_created` overlaps existing `idx_user_notifications_unread` partial · Retrofit UPDATE rewrites `severity` for legitimately-customized rows |

---

## 🔴 Critical

### DB11-C1 — `public.emit_notification(...)` lets any caller forge notifications for any user
- File: [database/08_notifications.sql:209-293](../../database/08_notifications.sql)
- What: The function is `SECURITY DEFINER`, takes `p_user_id uuid` from the caller, and inserts directly into `user_notifications` after only checking that the caller hasn't been opted out for that category. There is **no check that `auth.uid() = p_user_id`** and no role check. Granted to `authenticated` at line 293.
- Impact: Any logged-in buyer can call `emit_notification('<staff-uuid>', 'admin', 'sale_cancelled', 'sale', 'danger', '{"title":"FAKE","body":"Click http://evil"}'::jsonb, 'attack:'||gen_random_uuid()::text)` and a notification appears in the staff bell with attacker-chosen text + link. Trivial phishing vector inside the app shell.
- Fix: Add `IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT public.is_active_staff()) THEN RAISE EXCEPTION 'forbidden'; END IF;` at the top. Better: split into `_emit_notification_internal` (no grant, only callable from trigger context) and a thin public wrapper that enforces the identity check.

### DB11-C2 — `emit_admin_notification` reachable by `anon` via default-privileges grant
- File: [database/08_notifications.sql:298-340](../../database/08_notifications.sql); root cause at [database/04_rls.sql:504-505](../../database/04_rls.sql)
- What: `REVOKE ALL ... FROM PUBLIC` at line 339 only removes the implicit PUBLIC grant. The 04 file installed `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon`, which **automatically grants EXECUTE on every future function in `public`** to the `anon` role. The `REVOKE FROM PUBLIC` does not affect explicit role grants.
- Impact: An unauthenticated client (anon key) can POST `rpc/emit_admin_notification` with arbitrary type/payload/dedupe and broadcast to every active staff user. With the dedupe controlled by the attacker, they can bypass the per-event dedupe entirely. Same issue applies to `emit_notification`, `scan_*`, `run_notification_scans`, `mark_*`, `archive_notification`.
- Fix: Either (a) drop the `ALTER DEFAULT PRIVILEGES ... TO anon` clause in 04 entirely (anon should opt in per function), or (b) explicitly `REVOKE EXECUTE ... FROM anon` after each function block in 08, or (c) add `IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;` to every SECURITY DEFINER function in 08. (c) is the minimum hot-fix.

### DB11-C3 — Retrofit UPDATE at apply time mutates production rows on every re-run
- File: [database/08_notifications.sql:90-108](../../database/08_notifications.sql)
- What: `UPDATE public.user_notifications SET category = CASE ... severity = CASE ... WHERE (category='system' OR severity='info')` runs unconditionally on every apply. The WHERE clause is broad: every notification whose `category` was *legitimately* set to `'system'` (e.g., `new_client_registered` emitted at line 886) re-matches and gets re-written every time the file is re-applied.
- Impact: (a) admin operations that bulk-corrected a notification's category get reverted on the next apply; (b) the file is no longer idempotent in the "no observable change" sense — every apply touches rows, dirties replication slots, and triggers `updated_at` (if any). Same issue class as the existing finding DB-H2 about RLS recovery.
- Fix: Wrap in `IF NOT EXISTS (SELECT 1 FROM public.user_notifications WHERE category='commission')` (sentinel guard) or move to a one-shot `09_one_time_notification_retrofit.sql` and leave 08 strictly DDL. Add an `audit_logs` row recording how many were touched.

---

## 🟠 High

### DB11-H1 — `notification_outbox` has no `claim_token` / `SKIP LOCKED` mechanism
- File: [database/08_notifications.sql:151-172](../../database/08_notifications.sql)
- What: Status is `pending → in_flight → sent`, but there is no `claimed_at`/`claimed_by`/`lease_until` column. Two parallel workers reading `WHERE status='pending' AND next_attempt_at <= now()` will both flip the row to `in_flight` and both call the upstream provider.
- Impact: Once the SMS/email worker is wired up, every outbox row is a double-send candidate. The vendor's idempotency key on `provider_msg_id` is not populated until *after* send, so it cannot dedupe.
- Fix: Use the canonical pattern: `WITH c AS (SELECT id FROM notification_outbox WHERE status='pending' AND next_attempt_at <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 50) UPDATE notification_outbox o SET status='in_flight', claimed_at=now(), claimed_by=:worker_id FROM c WHERE o.id = c.id RETURNING o.*;`. Add the columns now so the worker can be added without another migration.

### DB11-H2 — `dedupe_key` is GLOBALLY unique; admin fanout depends on per-uid suffix
- File: [database/02_schema.sql:630](../../database/02_schema.sql) (`dedupe_key text unique`); usage in [database/08_notifications.sql:328](../../database/08_notifications.sql)
- What: `user_notifications.dedupe_key` has a single global UNIQUE constraint. `emit_admin_notification` correctly suffixes `:auth_user_id`, but every callsite must remember to. Future authors who re-use a non-suffixed key (e.g., `'announcement:2026-04-18'`) for a multi-recipient broadcast will find only the first recipient gets the row; the rest silently `ON CONFLICT DO NOTHING`.
- Impact: Latent foot-gun. One admin gets the notification, the others don't, and there's no error.
- Fix: Either replace `unique(dedupe_key)` with `unique(user_id, dedupe_key)` (allowing same logical event for many users), OR document the invariant inline and add a regression test `SELECT count(*) = (SELECT count(*) FROM admin_users WHERE status='active') FROM user_notifications WHERE dedupe_key LIKE 'sale_created:<id>:%'` after the next admin emit.

### DB11-H3 — `_notif_auth_user_for_client` returns the first matching row without ordering
- File: [database/08_notifications.sql:345-353](../../database/08_notifications.sql)
- What: `SELECT auth_user_id FROM clients WHERE id = p_client_id LIMIT 1` — `id` is the PK so at most one row matches. **But** if the client was duplicated by the auto-heal flow (the stub bug from DB-H5 in 02), the *wrong* `client.id` is passed in by the caller, and this function happily returns the stub's `auth_user_id` (often NULL → drop notification).
- Impact: Notifications silently drop for users in the dual-row state described in DB-C4/DB-H5. A user expecting a "sale confirmed" notification after their first purchase never receives one.
- Fix: Resolve the canonical client first: `SELECT auth_user_id FROM clients WHERE id IN (SELECT id FROM clients WHERE phone = (SELECT phone FROM clients WHERE id = p_client_id) ORDER BY auth_user_id NULLS LAST, created_at DESC LIMIT 1) LIMIT 1`. Or call `current_client_id_v2()` from DB-H5's proposed fix. Cross-reference: this is the trigger-side manifestation of DB-H5.

### DB11-H4 — `trg_sales_notify` listens only on `status`, not `pipeline_status`
- File: [database/08_notifications.sql:577-579](../../database/08_notifications.sql) (`AFTER UPDATE OF status`)
- What: The trigger is column-restricted. The application's state machine also writes `pipeline_status` (notary, finance hand-offs); when only `pipeline_status` changes (e.g., signing done but `status` stays `active`) the trigger never runs.
- Impact: Several user-facing milestones ("dossier passé en notaire", "acte signé") will never produce a notification, even though the legacy ad-hoc UI banners surface them.
- Fix: Either listen on both columns (`AFTER UPDATE OF status, pipeline_status`) and switch the function on `NEW.pipeline_status IS DISTINCT FROM OLD.pipeline_status`, or add a sibling `trg_sales_pipeline_notify` so the two paths stay readable.

### DB11-H5 — N+1 inside `emit_notification` channel-fanout loop
- File: [database/08_notifications.sql:257-280](../../database/08_notifications.sql)
- What: For each enabled channel, the function executes a separate `SELECT enabled FROM user_notification_prefs WHERE user_id=... AND category=... AND channel_key=v_ch.channel_key`. The outer loop already iterated over channels — a single `SELECT channel_key, c.enabled, p.enabled AS opt_in FROM channels LEFT JOIN prefs ...` would resolve everything in one round-trip.
- Impact: With 4 channels × 1 emit, that's 5 queries instead of 1. `emit_admin_notification` with 20 staff users → 100 queries per admin event; per `INSERT INTO commission_events` of a 5-level chain → 500 queries. Trigger latency creeps up; lock contention on `commission_events` worsens during commission settlement.
- Fix: Hoist the channel lookup into a single `WITH ch AS (...)` CTE inside `emit_notification`. Cache the per-user prefs in a local `record[]` once.

### DB11-H6 — `trg_commission_events_notify` (08 version) drops `kind` from payload
- File: [database/08_notifications.sql:414-422](../../database/08_notifications.sql) vs legacy [database/03_functions.sql:2157-2170](../../database/03_functions.sql)
- What: The 03 version of the payload included `'kind','commission'` as the first key. The 08 replacement deletes `kind` and replaces it with an `entity` sub-object `{kind:'commission_event', id:NEW.id}`. Any client code reading `n.payload.kind === 'commission'` (the typical pattern) will now see `undefined`.
- Impact: Existing UI rendering paths that switch on `payload.kind` silently fall into the default branch. No SQL error — the bug only shows up at render time. Combined with the retrofit UPDATE (DB11-C3) that re-promotes legacy `category='commission'`, the inconsistency is hidden.
- Fix: Keep `'kind','commission'` for backward compatibility OR sweep the React code to read `payload.entity.kind`. Decide deliberately and document.

---

## 🟡 Medium

### DB11-M1 — `notification_outbox.user_id` and `user_notification_prefs.user_id` lack FK to `auth.users`
- Files: [database/08_notifications.sql:139](../../database/08_notifications.sql), [database/08_notifications.sql:154](../../database/08_notifications.sql)
- Same class of issue as DB-H1 in 02. When an auth user is deleted, prefs and outbox rows orphan silently.
- Fix: `REFERENCES auth.users(id) ON DELETE CASCADE` for both.

### DB11-M2 — New 08 tables not covered by 04's blanket `GRANT ON ALL TABLES`
- Files: [database/04_rls.sql:479](../../database/04_rls.sql) (one-time grant), [database/08_notifications.sql:119-167](../../database/08_notifications.sql) (new tables)
- What: `GRANT ... ON ALL TABLES IN SCHEMA public TO authenticated` at apply time of 04 cannot grant for tables that don't yet exist. The follow-on `ALTER DEFAULT PRIVILEGES` *only* covers tables created by the **same role that ran the ALTER DEFAULT**. If 08 is applied via a different connection/role than 04, the new tables have no grants and every authenticated query on them fails with "permission denied".
- Fix: Re-issue `GRANT SELECT,INSERT,UPDATE,DELETE ON public.notification_channels, public.user_notification_prefs, public.notification_outbox TO authenticated;` at the bottom of 08. Belt-and-suspenders. (Same fix should be added to 07 if it created tables — verify.)

### DB11-M3 — `mark_notifications_read` / `archive_notification` lack `auth.uid()` guard
- File: [database/08_notifications.sql:1085-1136](../../database/08_notifications.sql)
- What: They `WHERE user_id = auth.uid()`. When `auth.uid()` returns NULL (anon), the predicate is `user_id = NULL` which is always FALSE → 0 rows updated, no error. So function is callable by anon (per DB11-C2) but does nothing useful. Still, exposes function existence and lets anon enumerate the API.
- Fix: `IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;` at the top.

### DB11-M4 — `pg_cron` unschedule pattern is fragile
- File: [database/08_notifications.sql:1067-1068](../../database/08_notifications.sql)
- What: `PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'zitouna_notification_scans';` — `cron.unschedule(bigint)` returns `boolean`, but using `PERFORM ... FROM cron.job` evaluates the function for each row. If the job exists in multiple cron databases (it shouldn't, but `cron.job` is a global view in pg_cron 1.5+) this loops; if the function signature isn't matched (older pg_cron versions only accept the job *name*, not id) it raises and the next `cron.schedule(...)` is skipped due to the outer `EXCEPTION WHEN OTHERS`.
- Fix: `PERFORM cron.unschedule('zitouna_notification_scans');` — pg_cron supports unschedule-by-name since 1.4. Wrap in `BEGIN ... EXCEPTION WHEN undefined_function THEN ... END` to fall back to id-based for older versions.

### DB11-M5 — `notification_channels.updated_at` never refreshed
- File: [database/08_notifications.sql:119-126](../../database/08_notifications.sql)
- No `touch_updated_at` trigger. If an admin enables the SMS channel, `updated_at` stays at insert time. Same class as DB-L1.
- Fix: `CREATE TRIGGER trg_notif_channels_touch BEFORE UPDATE ON notification_channels FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();`

### DB11-M6 — `payload_snapshot` duplicates `user_notifications.payload`
- File: [database/08_notifications.sql:163](../../database/08_notifications.sql), inserted at [database/08_notifications.sql:271-279](../../database/08_notifications.sql)
- What: `notification_outbox.payload_snapshot` is initialized to the same payload as `user_notifications.payload`. The notification's payload can be edited by an admin (e.g., correcting a typo), but the outbox snapshot diverges. There is no documented contract about which is the source of truth for a future SMS template.
- Fix: Either drop `payload_snapshot` and join `user_notifications.payload` at send time, OR mark the source row immutable (trigger that rejects UPDATE on `payload`).

### DB11-M7 — Category CHECK list duplicated in two places
- Files: [database/08_notifications.sql:60](../../database/08_notifications.sql) (user_notifications.category), [database/08_notifications.sql:140](../../database/08_notifications.sql) (user_notification_prefs.category)
- What: Both columns share the same 9-value CHECK list. Adding a new category requires editing two CHECK constraints. They will drift.
- Fix: Promote to an enum: `CREATE TYPE notification_category AS ENUM (...)` and reference from both columns. Same applies to `severity`.

---

## 🟢 Low

### DB11-L1 — `to_char(date, 'DD/MM')` drops the year
- Files: [database/08_notifications.sql:818, 952, 973](../../database/08_notifications.sql)
- Notification body says "à régler avant le 01/05". Year-end transitions look ambiguous ("01/01" might be next year's January or this year's). Use `'DD/MM/YYYY'` or include the day name.

### DB11-L2 — All notification copy hard-coded French
- Files: throughout [database/08_notifications.sql:405-545](../../database/08_notifications.sql)
- Adding Arabic/English requires rewriting every trigger. Move strings to a `notification_templates(category, type, locale, title_tpl, body_tpl)` table; render at read time.

### DB11-L3 — `idx_user_notifications_user_cat_created` overlaps `idx_user_notifications_unread`
- File: [database/08_notifications.sql:81-86](../../database/08_notifications.sql) vs [database/02_schema.sql:633](../../database/02_schema.sql)
- Both indexes lead with `user_id`. The new partial index `(user_id, role_scope, created_at DESC) WHERE read_at IS NULL AND archived_at IS NULL` can fully serve the existing "unread" use case. Drop the legacy `idx_user_notifications_unread` to save write-amp.

### DB11-L4 — Retrofit UPDATE rewrites severity for rows with custom values
- File: [database/08_notifications.sql:108](../../database/08_notifications.sql)
- The `WHERE (category='system' OR severity='info')` clause is overly broad. A row whose admin manually escalated to `severity='warning'` but kept `category='system'` will be reverted to `'info'` on next apply.
- Fix: Tighten to `WHERE category='system' AND severity='info' AND created_at < '2026-04-18'` (apply-date sentinel).

---

## Already covered (do not re-file)

- **Blanket `GRANT EXECUTE ON ALL FUNCTIONS TO anon`** — DB-M6 + DB-C1 in 02. DB11-C2 above is the *new-function* manifestation that makes 08 specifically dangerous.
- **`current_client_id()` / stub-vs-real ambiguity** — DB-H5 in 02. DB11-H3 is its trigger-time consequence.
- **Missing FKs to `auth.users`** — DB-H1, DB-M2, DB-M7 in 02. DB11-M1 extends the list to 08's two new tables.
- **No CHECK on monetary columns** — DB-H4 in 02. The 08 outbox and prefs tables don't add money columns, so no new instances.
- **Mutation block re-running on every apply** — DB-H2 in 02 (RLS recovery). DB11-C3 is the same anti-pattern in 08.
- **`updated_at` trigger missing** — DB-L1 in 02 listed five tables; DB11-M5 adds `notification_channels` to that list.
- **SECURITY DEFINER functions callable by anon** — DB-M6 in 02. DB11-C1 / DB11-C2 / DB11-M3 are concrete instances introduced by 08.

---

## Verified absent in 08 (good)

- All new tables have `ENABLE ROW LEVEL SECURITY` and at least one `WITH CHECK`-equipped policy.
- All new SECURITY DEFINER functions have `SET search_path = public` (no search_path hijack).
- Outbox FK `notification_id → user_notifications(id) ON DELETE CASCADE` correctly cleans up.
- `ON CONFLICT (dedupe_key) DO NOTHING` is used consistently (no race-y SELECT-then-INSERT).
- The 08 file's preflight guard at lines 22-33 correctly aborts if 03 hasn't been applied — no silent partial install.
- The cron schedule wrap in `EXCEPTION WHEN OTHERS` correctly degrades when pg_cron isn't installed (Supabase default).

---

## Recommended fix order

1. DB11-C1 + DB11-C2 in the same patch — both are exploitable from anon.
2. DB11-C3 — quarantine the retrofit UPDATE before it ships to staging.
3. DB11-H4 + DB11-H6 — user-facing breakage; fix before announcing the feature.
4. DB11-H1 + DB11-H5 — perf / future SMS launch blockers.
5. Everything Medium can ship in a follow-up `09_notifications_hardening.sql`.
