ZITOUNA — database (PostgreSQL / Supabase)

==============================================================================
NEW SIMPLIFIED FLOW (recommended)
==============================================================================

Initial setup (ONE TIME):
  1) SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
  2) database/dev/01_reset_full.sql
  3) database/02_schema.sql
  4) database/03_functions.sql
  5) database/04_rls.sql
  6) database/07_hardening.sql
  7) database/08_notifications.sql

Daily development reset (ONE FILE ONLY):
  1) SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
  2) database/06_seed_dev.sql

`06_seed_dev.sql` now does everything needed for daily dev:
  - wipes auth + business + catalog data
  - seeds 4 projects
  - seeds 20 parcels per project
  - seeds offers + slots
  - creates 4 login accounts

So for day-to-day work, you no longer need to paste many SQL files.

==============================================================================
File index
==============================================================================

  dev/01_reset_full.sql            DEV ONLY — full wipe, guard-gated
  dev/01b_reset_keep_accounts.sql  DEV ONLY — data wipe, keep accounts, guard-gated
  02_schema.sql                    REQUIRED — tables, enums, indexes, constraints, touch triggers
  03_functions.sql                 REQUIRED — helpers, RPCs, autolink + sale-invariant triggers
  04_rls.sql                       REQUIRED — RLS policies (staff + delegated seller)
  05_seed.sql                      legacy optional catalogue seed (kept for compatibility)
  06_seed_dev.sql                  PRIMARY DEV SCRIPT (reset + seed in one run)
  07_hardening.sql                 REQUIRED — consolidated hardening:
                                   (A) RLS perf patch
                                   (B) per-table grants, catalog views, lookup RPC, MFA
                                   (C) status/money CHECKs, FKs, commission audit,
                                       plan_status 'cancelled', audit retention
                                   (D) commission model v2: sale-based pyramid,
                                       link at notary completion, reverse-sale guard
                                   (E) parcels.label (text ID like "a1", "A-42") +
                                       project_offers.mode/cash_amount/price_per_sqm
  08_notifications.sql             REQUIRED — notifications infra: triggers, scans,
                                   channels catalog, prefs, outbox (SMS/email/push-ready)
  09_one_shot_recovery.sql         OPTIONAL — auth↔client recovery, guard-gated, one-shot

==============================================================================
Login credentials after running `06_seed_dev.sql`
==============================================================================

Password for ALL accounts: 123456

  saifelleuchi1@gmail.com   SUPER_ADMIN
  saifelleuchi2@gmail.com   STAFF
  saifelleuchi3@gmail.com   CLIENT
  saifelleuchi4@gmail.com   CLIENT

==============================================================================
Recovery (one-shot auto-link by phone/email, only if needed)
==============================================================================

  SET app.allow_one_shot_recovery = 'I_UNDERSTAND';
  -- paste: database/09_one_shot_recovery.sql

==============================================================================
Notification scans (pg_cron auto-wired when available)
==============================================================================

Fallback manual trigger:
  SELECT public.run_notification_scans();

Enabling a channel later (SMS / email / push):
  1. UPDATE public.notification_channels SET enabled=true WHERE channel_key='sms';
  2. Deploy a worker (edge function) that reads notification_outbox WHERE
     status='pending' AND channel_key='sms' AND next_attempt_at <= now().
  3. Worker resolves the target, calls the provider, UPDATEs status.
  No app or trigger changes needed.

==============================================================================
Notes
==============================================================================

- Scripts check prerequisites and refuse to run if the prior step is missing.
- Every function/policy uses CREATE OR REPLACE / DROP IF EXISTS — safe to re-run.
- Storage buckets are NOT touched by any script; clear them from the Supabase
  dashboard (Storage → bucket → delete files) if you want a truly fresh start.
- The destructive-reset safety token is session-scoped: it only holds for the
  current SQL editor tab. Closing the tab resets it — another layer of
  protection.
- Parcel labels + offer payment modes (Section E of 07_hardening.sql) are
  defensive at the app layer too: db.js retries on 42703 `undefined_column`
  errors, so the UI won't crash if 07_hardening is missed.
